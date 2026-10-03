/**
 * 图表的**嵌入工作簿**（`word/embeddings/`；design-05-P9 / WF-092；R106 / R140 / R151）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 部件 + **图表部件自己的**关系 + 内容类型声明 三件齐备且互指 | ①② |
 * | 全包**无悬空内部关系**（"关系与部件成对"的可判定形式） | ③ |
 * | **不给**嵌入件 ⇒ 部件、关系、`c:externalData` **一件都不出现**（反向对照） | ④ |
 * | 嵌入件的关系挂在**图表部件**上，不是主部件（挂错持有者要能被抓出） | ⑤ |
 * | 空的 rId / 0 字节 ⇒ 先拒绝，不产出半成品 | ⑥⑦ |
 * | 既有 rId 编号与顺序一个不动；新 `.rels` 只出现在新建部件下（R106） | ⑧ |
 * | **R151 不回归**：不传 `charts` ⇒ 包里没有 `word/charts` / `word/embeddings` | ⑨ |
 *
 * ## 未做消费端验证（如实标注）
 *
 * 本用例证明的是**包内自洽**（部件、关系、内容类型三件成对、无悬空引用），
 * **不是**"Word 能打开并显示图表数据"。真实 Word 需要一份真正的 `.xlsx` 工作簿，
 * 本用例给的是最小可辨识字节（`PK\x03\x04` 开头）——**未做 Word 打开核对**（无设备/无授权）。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { asFactRef } from '../../protocol/index.js';
import {
  CHART_CONTENT_TYPE,
  CHART_RELATIONSHIP_TYPE,
  EMBEDDED_WORKBOOK_CONTENT_TYPE,
  EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE,
} from '../charts/parts.js';
import { buildChart } from '../charts/build.js';
import type { ChartDefinition } from '../charts/types.js';
import { createDocumentModel } from '../model/document.js';
import { drawingNode, paragraphNode, runNode } from '../model/nodes.js';
import { resolveRelationshipTarget } from '../model/preservation.js';
import type { DocumentModel, Length } from '../model/types.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';
import { parseRelationships, relsOwnerOf } from './package-parts.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MAIN_PART = 'word/document.xml';
const MAIN_RELS = 'word/_rels/document.xml.rels';
const CHART_PART = 'word/charts/chart1.xml';
const CHART_RELS = 'word/charts/_rels/chart1.xml.rels';
const WORKBOOK_PART = 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx';
const CHART_RID = 'rId900';
const WORKBOOK_RID = 'rId1';

const PT = (value: number): Length => ({ unit: 'pt', value });

/** 最小可辨识的 `.xlsx` 字节（ZIP 魔数 + 少量填充）。**不是**一个真正的工作簿。 */
function fakeWorkbookBytes(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
}

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

const CATEGORIES = ['一月', '二月', '三月'];

function traceableChart(): ChartDefinition {
  const built = buildChart({
    chart_id: 'chart-1',
    chart_type: 'column',
    title: '人数',
    categories: CATEGORIES,
    series: [
      {
        name: '人数',
        points: CATEGORIES.map((category, index) => ({
          category,
          value: (index + 1) * 3,
          fact_ref: asFactRef(`fact-${String(index)}`),
          fact_key: `headcount.${String(index)}`,
        })),
      },
    ],
    source: 'user_request',
  });
  if (!built.ok) throw new Error(built.message);
  return built.value;
}

function chartModel(): DocumentModel {
  const draft = paragraphNode({
    source: 'user_request',
    inlines: [
      runNode({ text: '前', source: 'user_request' }),
      drawingNode({
        drawing_type: 'chart',
        source: 'model_generated',
        relationship_id: CHART_RID,
        extent: { width: PT(120), height: PT(90) },
        alt_text: '人数图',
      }),
      runNode({ text: '后', source: 'user_request' }),
    ],
  });
  const blocks = createDocumentModel({ document_id: 'chart-embed-doc', blocks: [draft] }).blocks;
  return { ...corpusModel(), blocks, sections: [] };
}

type Archive = ReturnType<typeof readZip>;

function text(archive: Archive, path: string): string | null {
  const entry = archive.by_path.get(path);
  return entry === undefined ? null : new TextDecoder().decode(entry.data);
}

function exportWithWorkbook(archiveOf: (options: Parameters<typeof exportDocx>[1]) => Archive) {
  return archiveOf({
    charts: [
      {
        part_index: 1,
        definition: traceableChart(),
        relationship_id: CHART_RID,
        embedded_workbook: { relationship_id: WORKBOOK_RID, bytes: fakeWorkbookBytes() },
      },
    ],
  });
}

/**
 * 全包**悬空内部关系**扫描（"关系与部件成对"的可判定形式）。
 *
 * 判据与导出器同源：相对目标一律走 `resolveRelationshipTarget`（`../` 会被正确解析），
 * 再核对目标部件是否真的在包里。返回空数组 = 没有一条关系指向不存在的部件。
 */
function danglingRelationships(archive: Archive): readonly string[] {
  const out: string[] = [];
  for (const entry of archive.entries) {
    const owner = relsOwnerOf(entry.path);
    if (owner === null) continue;
    const ownerPath = owner.kind === 'root' ? null : owner.owner;
    for (const record of parseRelationships(entry.data, ownerPath, entry.path)) {
      if (record.target_mode === 'External') continue;
      const target = resolveRelationshipTarget(ownerPath, record.target);
      if (!archive.by_path.has(target)) out.push(`${entry.path}#${record.id} → ${target}`);
    }
  }
  return out;
}

describe('图表嵌入工作簿（WF-092 的 word/embeddings）', () => {
  it('① 部件 + 图表部件自己的关系 + 内容类型 三件齐备且互指', () => {
    const archive = exportWithWorkbook((options) => readZip(exportDocx(chartModel(), options)));

    // 1) 部件本身在包里，字节与调用方给的**逐字节相同**（导出器不加工数据源）。
    const workbook = archive.by_path.get(WORKBOOK_PART);
    expect(workbook).toBeDefined();
    expect(Array.from(workbook!.data)).toEqual(Array.from(fakeWorkbookBytes()));

    // 2) 关系：挂在**图表部件**上，目标是相对路径 `../embeddings/…`。
    const chartRels = text(archive, CHART_RELS);
    expect(chartRels).not.toBeNull();
    expect(chartRels).toContain(`Id="${WORKBOOK_RID}"`);
    expect(chartRels).toContain(`Type="${EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE}"`);
    expect(chartRels).toContain('Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"');
    // 相对路径**不是**从包根起的完整路径（那会解析成 word/word/embeddings/…）。
    expect(chartRels).not.toContain('word/embeddings/Microsoft_Excel_Worksheet1.xlsx');

    // 3) 内容类型声明（xlsx 走 Default 扩展名，符合 OOXML 惯例）。
    const contentTypes = text(archive, '[Content_Types].xml') ?? '';
    expect(contentTypes).toContain(EMBEDDED_WORKBOOK_CONTENT_TYPE);

    // 4) 图表本体**真的引用**它：`c:externalData@r:id` 指的就是那条关系。
    const chartXml = text(archive, CHART_PART) ?? '';
    expect(chartXml).toContain(`<c:externalData r:id="${WORKBOOK_RID}">`);
    expect(chartXml).toContain('<c:autoUpdate val="0"/>');
    // 字面量缓存**仍在**（数据不因加了嵌入件而变成"只依赖外部工作簿"）。
    expect(chartXml).toContain('>一月<');
  });

  it('② 关系与部件成对：全包没有一条悬空内部关系', () => {
    const archive = exportWithWorkbook((options) => readZip(exportDocx(chartModel(), options)));
    expect(danglingRelationships(archive)).toEqual([]);
  });

  it('③ 反向对照：悬空关系**必须被这套扫描抓到**（否则②是空断言）', () => {
    const archive = exportWithWorkbook((options) => readZip(exportDocx(chartModel(), options)));
    // 人为把嵌入件从包里拿掉，只留关系——这正是"有部件没关系/有关系没部件"里坏的那半边。
    const byPath = new Map(archive.by_path);
    byPath.delete(WORKBOOK_PART);
    const broken: Archive = {
      ...archive,
      entries: archive.entries.filter((entry) => entry.path !== WORKBOOK_PART),
      by_path: byPath,
    };
    const dangling = danglingRelationships(broken);
    expect(dangling.length).toBe(1);
    expect(dangling[0]).toContain(CHART_RELS);
    expect(dangling[0]).toContain(WORKBOOK_PART);
  });

  it('④ 不给嵌入工作簿 ⇒ 部件 / 关系 / c:externalData **一件都不出现**', () => {
    const archive = readZip(
      exportDocx(chartModel(), {
        charts: [{ part_index: 1, definition: traceableChart(), relationship_id: CHART_RID }],
      }),
    );
    // 部件不在，图表部件自己的 `.rels` 也不在（不为空关系凭空造一份）。
    expect(archive.by_path.has(WORKBOOK_PART)).toBe(false);
    expect(archive.by_path.has(CHART_RELS)).toBe(false);
    expect(text(archive, '[Content_Types].xml') ?? '').not.toContain(EMBEDDED_WORKBOOK_CONTENT_TYPE);
    const chartXml = text(archive, CHART_PART) ?? '';
    expect(chartXml).not.toContain('c:externalData');
    // 图表本体、主部件关系、内容类型**一个不少**——不写嵌入件不等于图表缺件。
    expect(chartXml).toContain('<c:barChart>');
    expect(text(archive, MAIN_RELS) ?? '').toContain(`Id="${CHART_RID}"`);
    expect(text(archive, '[Content_Types].xml') ?? '').toContain(CHART_CONTENT_TYPE);
    expect(danglingRelationships(archive)).toEqual([]);
  });

  it('⑤ 嵌入件的关系**不在主部件的关系表里**（挂错持有者会被抓出）', () => {
    const archive = exportWithWorkbook((options) => readZip(exportDocx(chartModel(), options)));
    const mainRels = text(archive, MAIN_RELS) ?? '';
    expect(mainRels).not.toContain(EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE);
    expect(mainRels).not.toContain(WORKBOOK_PART);
    // 主部件里只有指向图表的那一条。
    expect(mainRels).toContain(`Type="${CHART_RELATIONSHIP_TYPE}"`);
  });

  it('⑥ 关系 id 是空串 ⇒ 拒绝（悬空 r:id），且不产出任何字节', () => {
    let thrown: unknown = null;
    try {
      exportDocx(chartModel(), {
        charts: [
          {
            part_index: 1,
            definition: traceableChart(),
            relationship_id: CHART_RID,
            embedded_workbook: { relationship_id: '', bytes: fakeWorkbookBytes() },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_chart_part');
  });

  it('⑦ 声明了嵌入件却给 0 字节 ⇒ 拒绝（比不声明更坏）', () => {
    let thrown: unknown = null;
    try {
      exportDocx(chartModel(), {
        charts: [
          {
            part_index: 1,
            definition: traceableChart(),
            relationship_id: CHART_RID,
            embedded_workbook: { relationship_id: WORKBOOK_RID, bytes: new Uint8Array(0) },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_chart_part');
  });

  it('⑧ 主部件既有 rId 的编号与顺序一个不动；新 `.rels` 只出现在新建部件下（R106）', () => {
    const base = corpusModel();
    const existingIds = base.relationships
      .filter((record) => record.owner_part_path === MAIN_PART)
      .map((record) => record.id);

    const archive = exportWithWorkbook((options) => readZip(exportDocx(chartModel(), options)));
    const mainRecords = parseRelationships(
      archive.by_path.get(MAIN_RELS)!.data,
      MAIN_PART,
      MAIN_RELS,
    );
    expect(mainRecords.slice(0, existingIds.length).map((record) => record.id)).toEqual(existingIds);

    // 新增的 `.rels` 挂在**新建的**图表部件下：原包里没有这个持有者，不会顶掉任何既有 `.rels`。
    expect(base.opaque_parts.some((part) => part.path === CHART_RELS)).toBe(false);
    expect(archive.by_path.has(CHART_RELS)).toBe(true);
  });

  it('⑨ R151 不回归：不传 charts ⇒ 包里没有 word/charts 与 word/embeddings', () => {
    const plain = createDocumentModel({
      document_id: 'chart-embed-noop',
      blocks: [paragraphNode({ source: 'user_request', inlines: [runNode({ text: '正文', source: 'user_request' })] })],
    });
    const model: DocumentModel = { ...corpusModel(), blocks: plain.blocks, sections: [] };
    const without = exportDocx(model);
    expect(Array.from(exportDocx(model, { charts: [] }))).toEqual(Array.from(without));
    const archive = readZip(without);
    expect(archive.entries.some((entry) => entry.path.startsWith('word/charts/'))).toBe(false);
    expect(archive.entries.some((entry) => entry.path.startsWith('word/embeddings/'))).toBe(false);
  });
});
