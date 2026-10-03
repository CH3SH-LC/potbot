/**
 * 图表导出接线（design-05-P9 / WF-092；合同 R106/R107/R140/R151）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | **部件 + 关系 + 内容类型完整、无悬空** | ① `word/charts/chart1.xml` + `…/chart` 关系 + `Override` 齐备 |
 * | **正文里真的引用它**（不是孤儿部件） | ② `w:drawing` → `a:graphicData@uri=…/chart` → `c:chart@r:id` |
 * | **既有 rId 编号与顺序一个不动**（R106） | ③ 新关系追加在末尾 |
 * | **数据可追溯**：无来源字面量不写出 | ④ 拒绝并给原因 |
 * | **改数据 ⇒ 导出内容跟着变** | ⑤ |
 * | 关系被占用 / 图形引用不到图表 ⇒ 先拒绝 | ⑥⑦ |
 * | **R151 不回归**：不传 `charts` ⇒ 导出逐字节不变 | ⑧ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { asFactRef } from '../../protocol/index.js';
import { CHART_CONTENT_TYPE, CHART_RELATIONSHIP_TYPE } from '../charts/parts.js';
import { buildChart, literalPoint } from '../charts/build.js';
import type { ChartDefinition } from '../charts/types.js';
import { createDocumentModel } from '../model/document.js';
import { drawingNode, paragraphNode, runNode } from '../model/nodes.js';
import type { DocumentModel, Length } from '../model/types.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';
import { parseRelationships } from './package-parts.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MAIN_PART = 'word/document.xml';
const RELS_PART = 'word/_rels/document.xml.rels';
const CHART_PART = 'word/charts/chart1.xml';
const CHART_RID = 'rId900';

const PT = (value: number): Length => ({ unit: 'pt', value });

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

const CATEGORIES = ['一月', '二月', '三月'];

/** 一个**可追溯**的柱形图：每个数据点都指认得一条事实。 */
function traceableChart(values: readonly number[], title = '人数'): ChartDefinition {
  const built = buildChart({
    chart_id: 'chart-1',
    chart_type: 'column',
    title,
    categories: CATEGORIES,
    series: [
      {
        name: '人数',
        points: CATEGORIES.map((category, index) => ({
          category,
          value: values[index] as number,
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

/** 一个有"图表图形节点"的文档（该节点引用 `CHART_RID`）。 */
function chartModel(relationshipId: string = CHART_RID): DocumentModel {
  const draft = paragraphNode({
    source: 'user_request',
    inlines: [
      runNode({ text: '前', source: 'user_request' }),
      drawingNode({
        drawing_type: 'chart',
        source: 'model_generated',
        relationship_id: relationshipId,
        extent: { width: PT(120), height: PT(90) },
        alt_text: '人数图',
      }),
      runNode({ text: '后', source: 'user_request' }),
    ],
  });
  const blocks = createDocumentModel({ document_id: 'chart-doc', blocks: [draft] }).blocks;
  return { ...corpusModel(), blocks, sections: [] };
}

function exported(archive: ReturnType<typeof readZip>, path: string): string | null {
  const entry = archive.by_path.get(path);
  return entry === undefined ? null : new TextDecoder().decode(entry.data);
}

describe('图表 → chartN.xml + 关系 + 内容类型（WF-092）', () => {
  it('① 图表部件、关系、内容类型声明三件齐备（无悬空、无孤儿）', () => {
    const model = chartModel();
    const archive = readZip(
      exportDocx(model, {
        charts: [{ part_index: 1, definition: traceableChart([8, 12, 5]), relationship_id: CHART_RID }],
      }),
    );

    const chartXml = exported(archive, CHART_PART);
    expect(chartXml).not.toBeNull();
    expect(chartXml).toContain('<c:chartSpace');
    expect(chartXml).toContain('xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"');
    expect(chartXml).toContain('<c:barChart>');
    expect(chartXml).toContain('<c:barDir val="col"/>');
    // 数据就在部件里（字面量缓存），改数据必然改字节。
    expect(chartXml).toContain('>8<');
    expect(chartXml).toContain('>12<');
    expect(chartXml).toContain('>一月<');

    const rels = exported(archive, RELS_PART) ?? '';
    expect(rels).toContain(`Id="${CHART_RID}"`);
    expect(rels).toContain(`Type="${CHART_RELATIONSHIP_TYPE}"`);
    expect(rels).toContain('Target="charts/chart1.xml"');

    const contentTypes = exported(archive, '[Content_Types].xml') ?? '';
    expect(contentTypes).toContain('PartName="/word/charts/chart1.xml"');
    expect(contentTypes).toContain(CHART_CONTENT_TYPE);
  });

  it('② 正文里真的引用它：w:drawing → a:graphicData@uri=…/chart → c:chart@r:id', () => {
    const model = chartModel();
    const archive = readZip(
      exportDocx(model, {
        charts: [{ part_index: 1, definition: traceableChart([8, 12, 5]), relationship_id: CHART_RID }],
      }),
    );
    const main = exported(archive, MAIN_PART) ?? '';

    expect(main).toContain('<w:drawing');
    expect(main).toContain(
      'a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"',
    );
    expect(main).toContain(`<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"`);
    expect(main).toContain(`r:id="${CHART_RID}"`);
    // 前后文字仍在该段里（图表是**行内对象**，不吞掉邻居）。
    expect(main).toContain('>前<');
    expect(main).toContain('>后<');
  });

  it('③ 既有 rId 的编号与相对顺序一个不动，新关系追加在末尾（R106）', () => {
    const base = corpusModel();
    const mainPath = 'word/document.xml';
    const existing = base.relationships.filter((record) => record.owner_part_path === mainPath);
    const model = chartModel();
    const archive = readZip(
      exportDocx(model, {
        charts: [{ part_index: 1, definition: traceableChart([1, 2, 3]), relationship_id: 'rId900' }],
      }),
    );
    const relsEntry = archive.by_path.get(RELS_PART);
    expect(relsEntry).toBeDefined();
    const parsed = parseRelationships(relsEntry!.data, mainPath, RELS_PART);

    // 前 N 条与模型里既有的**逐条同 id、同顺序**。
    expect(parsed.slice(0, existing.length).map((record) => record.id)).toEqual(
      existing.map((record) => record.id),
    );
    // 新关系**在末尾**，不在中间插队。
    expect(parsed[parsed.length - 1]!.id).toBe('rId900');
  });

  it('④ 数据不可追溯（无来源字面量）⇒ 拒绝，不写出没有来源的图', () => {
    const literal = buildChart({
      chart_id: 'chart-literal',
      chart_type: 'column',
      title: '无来源',
      categories: ['甲', '乙'],
      series: [
        {
          name: '系列',
          points: [literalPoint('甲', 1), literalPoint('乙', 2)],
        },
      ],
      source: 'imported',
    });
    if (!literal.ok) throw new Error(literal.message);

    let thrown: unknown = null;
    try {
      exportDocx(chartModel(), {
        charts: [{ part_index: 1, definition: literal.value, relationship_id: CHART_RID }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_chart_data');
  });

  it('⑤ 改数据 ⇒ 导出内容跟着变', () => {
    const render = (values: readonly number[]): string => {
      const archive = readZip(
        exportDocx(chartModel(), {
          charts: [{ part_index: 1, definition: traceableChart(values), relationship_id: CHART_RID }],
        }),
      );
      return exported(archive, CHART_PART) ?? '';
    };
    const first = render([8, 12, 5]);
    const second = render([8, 12, 99]);
    expect(first).not.toBe(second);
    expect(second).toContain('>99<');
    expect(first).not.toContain('>99<');
  });

  it('⑥ 关系 id 已被占用 ⇒ 拒绝（覆盖既有关系是坏包，R106）', () => {
    const base = corpusModel();
    const mainPath = 'word/document.xml';
    const occupied = base.relationships.find((record) => record.owner_part_path === mainPath);
    expect(occupied).toBeDefined();

    let thrown: unknown = null;
    try {
      exportDocx(chartModel(occupied!.id), {
        charts: [{ part_index: 1, definition: traceableChart([1, 2, 3]), relationship_id: occupied!.id }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_chart_part');
  });

  it('⑦ 图形引用一个不是图表关系 / 不存在的关系 ⇒ 拒绝（悬空引用）', () => {
    // 不传 `charts`：那条 rId 根本没写进关系表。
    let thrown: unknown = null;
    try {
      exportDocx(chartModel('rId901'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_chart_part');
  });

  it('⑧ R151 不回归：不传 charts ⇒ 导出逐字节不变', () => {
    const plain = (() => {
      const draft = paragraphNode({
        source: 'user_request',
        inlines: [runNode({ text: '正文', source: 'user_request' })],
      });
      const blocks = createDocumentModel({ document_id: 'chart-noop', blocks: [draft] }).blocks;
      return { ...corpusModel(), blocks, sections: [] };
    })();

    const without = exportDocx(plain);
    expect(Array.from(exportDocx(plain, { charts: [] }))).toEqual(Array.from(without));
    const archive = readZip(without);
    expect(archive.entries.some((entry) => entry.path.startsWith('word/charts/'))).toBe(false);
  });
});
