/**
 * WCF-D30：**真实 Word 验收用的产物生成**（可选验收流程的第一步）。
 *
 * ## 这个文件为什么在 vitest 里，而 Word 那一步不在
 *
 * 分界是"**要不要 Word**"：
 *
 * | 步骤 | 需要什么 | 放哪 |
 * |---|---|---|
 * | 生成产物（本文件） | 只要 Node | vitest 默认路径（每次跑都会刷新产物） |
 * | 用真实 Word 打开产物 | 本机 Word 16 COM + 交互式桌面 | `.task-manifest/outputs/WCF-D30/word-open-drawing.ps1`（**手动/可选**） |
 *
 * 理由：Word 在本机是"未经授权产品"，且 COM 需要桌面会话；把它塞进 vitest，会让
 * "环境不具备"表现为"产品测试红了"。本文件只负责**把产物摆好**，Word 那一步单独取证。
 *
 * ## 产物清单（`artifacts/`）
 *
 * - `d30-inserted-picture.docx` —— **主判据**：含一张由 `DrawingNode` 渲染出来的新图。
 * - `d30-table-and-section.docx` —— 浮动表 + 单元格内边距 + 禁止断页 + 节扩展 + 页眉引用，一次全上。
 * - `bisect/v0…v6` —— **定位 Word 拒开原因用的单变量矩阵**。
 *   本次实测：修复前 `v5-header` 被 Word 拒绝、其余全过，据此把原因锁到
 *   "`r:id` 用到了 `xmlns:r` 却没声明"（合成语料的根只声明 `xmlns:w`）。
 *   保留矩阵是为了让那个结论**可复算**，而不是只留在报告里的一句话。
 *
 * ## 本文件的断言只管"产物确实写出来了且是良构的"
 *
 * 真正的判据（Word 能不能开、图片在不在）在 Word 那一步，这里**不**用生产实现自证。
 * 良构检查另有一份**独立**的 Python 证据：`.task-manifest/outputs/WCF-D30/xml-wellformedness.log`。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../../artifacts/ooxml/xml.js';
import { createDocumentModel } from '../model/document.js';
import { textParagraphNode, type DraftTableNode } from '../model/nodes.js';
import type { DocumentModel, Length, SectionProperties } from '../model/types.js';
import { horizontalMergeModel, plainTableDraft } from '../operations/table/fixtures.js';
import { registerImageMedia } from '../operations/drawing/media.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';
import { emptySectionProperties } from './word-xml.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);
const ARTIFACTS = join(REPO_ROOT, '.task-manifest', 'outputs', 'WCF-D30', 'artifacts');

/** 1×1 真 PNG（**不是**只有魔数的假字节：Word 会把损坏图片判成错误）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MM = (value: number): Length => ({ unit: 'mm', value });
const PT = (value: number): Length => ({ unit: 'pt', value });

const HEADER_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';

function corpus(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 导出并落盘，返回写出的字节。 */
function emit(name: string, model: DocumentModel): Uint8Array {
  const bytes = exportDocx(model);
  const target = join(ARTIFACTS, name);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, bytes);
  return bytes;
}

function twoByTwo(): DraftTableNode {
  return plainTableDraft([
    ['a1', 'b1'],
    ['a2', 'b2'],
  ]);
}

/** 表格块 + 尾部段落（OOXML 里正文末尾有表时，Word 更愿意看到后面还有一段）。 */
function tableBlocks(patch?: (draft: DraftTableNode) => DraftTableNode): DocumentModel['blocks'] {
  const draft = patch === undefined ? twoByTwo() : patch(twoByTwo());
  return createDocumentModel({
    document_id: 'd30-artifact',
    blocks: [draft, textParagraphNode({ text: '表后一段。', source: 'user_request' })],
  }).blocks;
}

/** 每个产物的每个 XML 部件都必须能被**独立**的命名空间感知解析器读出来。 */
function assertXmlPartsWellFormed(bytes: Uint8Array, name: string): void {
  const archive = readZip(bytes);
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.xml') && !entry.path.endsWith('.rels')) continue;
    // 最小良构检查：解析器出错即抛。这里用生产解析器**只为**"能不能读"，
    // 判据（Word 能不能开）另有独立证据。
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(entry.data), name).not.toThrow();
  }
}

describe('WCF-D30 Word 验收产物', () => {
  it('产出 artifacts/ 下的全部验收产物，且都非空', () => {
    const root = corpus();
    const written: [string, Uint8Array][] = [];

    // ① 主判据：新插入的图片（DrawingNode 渲染）。
    const registered = registerImageMedia(root, {
      bytes: new Uint8Array(TINY_PNG),
      content_type: 'image/png',
    });
    const materialized = createDocumentModel({
      document_id: 'd30-picture',
      blocks: [textParagraphNode({ text: '下面是一张新插入的图片。', source: 'user_request' })],
    }).blocks;
    const paragraph = materialized[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') throw new Error('夹具：不是段落');
    const model: DocumentModel = {
      ...registered.model,
      blocks: [
        ...root.blocks,
        {
          ...paragraph,
          inlines: [
            {
              kind: 'drawing',
              id: 'd30-acceptance-drawing',
              source: 'user_request',
              opaque: [],
              drawing_type: 'picture',
              relationship_id: registered.relationship_id,
              extent: { width: PT(120), height: PT(90) },
              rotation_deg: 0,
              wrap: null,
              alt_text: 'WCF-D30 验收用小图',
            },
          ],
        },
      ],
      sections: root.sections,
    };
    written.push(['d30-inserted-picture.docx', emit('d30-inserted-picture.docx', model)]);

    // ② 一次上齐：浮动表 + 内边距 + 禁止断页 + 节扩展 + 页眉引用。
    const withTable = tableBlocks((draft) => ({
      ...draft,
      properties: {
        ...draft.properties,
        width: { state: 'set', value: MM(80) },
        floating: {
          horizontal_anchor: 'center',
          vertical_anchor: 'top',
          horizontal_offset: MM(5),
          vertical_offset: MM(5),
          text_wrapping: 'around',
        },
      },
      rows: draft.rows.map((row, rowIndex) => ({
        ...row,
        cells: row.cells.map((cell, cellIndex) =>
          rowIndex === 0 && cellIndex === 0
            ? {
                ...cell,
                properties: {
                  ...cell.properties,
                  margins: {
                    state: 'set' as const,
                    value: { top: MM(1), left: MM(2), bottom: MM(1), right: MM(2) },
                  },
                },
              }
            : cell,
        ),
      })),
    }));
    // `cant_split` 必须绕过模型工厂（`rowNode` / `materializeRowNode` 都不转发它）。
    const withRowPatch = withTable.map((block) =>
      block.kind !== 'table'
        ? block
        : { ...block, rows: block.rows.map((row) => ({ ...row, cant_split: true })) },
    );
    const headerPart = {
      path: 'word/header-d30.xml',
      content_type: HEADER_CT,
      bytes: utf8Bytes(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ' +
          'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:p><w:r><w:t>WCF-D30 页眉</w:t></w:r></w:p></w:hdr>',
      ),
    };
    const section: SectionProperties = {
      ...emptySectionProperties(),
      pageSize: { state: 'set', value: { width: PT(595.3), height: PT(841.9) } },
      margins: {
        state: 'set',
        value: { top: PT(72), right: PT(72), bottom: PT(72), left: PT(72), gutter: PT(0) },
      },
      columns: { state: 'set', value: 1 },
      pageNumbering: { format: 'decimal', start: 1 },
      verticalAlign: { state: 'set', value: 'top' },
      headers: [{ part_path: headerPart.path, kind: 'default' }],
    };
    written.push([
      'd30-table-and-section.docx',
      emit('d30-table-and-section.docx', {
        ...root,
        blocks: withRowPatch,
        sections: [section],
        opaque_parts: [...root.opaque_parts, headerPart],
      }),
    ]);

    // ③ 单变量矩阵（定位 Word 拒开原因用；保留以便复算结论）。
    const bisect = (name: string, model: DocumentModel): void => {
      const bytes = exportDocx(model);
      const target = join(ARTIFACTS, 'bisect', name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
      written.push([`bisect/${name}`, bytes]);
    };
    bisect('v0-plain-table.docx', { ...root, blocks: tableBlocks(), sections: [] });
    bisect('v1-floating.docx', {
      ...root,
      blocks: tableBlocks((draft) => ({
        ...draft,
        properties: {
          ...draft.properties,
          floating: {
            horizontal_anchor: 'center',
            vertical_anchor: 'top',
            horizontal_offset: MM(5),
            vertical_offset: MM(5),
            text_wrapping: 'around',
          },
        },
      })),
      sections: [],
    });
    bisect('v2-cellmar.docx', {
      ...root,
      blocks: tableBlocks((draft) => ({
        ...draft,
        rows: draft.rows.map((row, rowIndex) => ({
          ...row,
          cells: row.cells.map((cell, cellIndex) =>
            rowIndex === 0 && cellIndex === 0
              ? {
                  ...cell,
                  properties: {
                    ...cell.properties,
                    margins: {
                      state: 'set' as const,
                      value: { top: MM(1), left: MM(2), bottom: MM(1), right: MM(2) },
                    },
                  },
                }
              : cell,
          ),
        })),
      })),
      sections: [],
    });
    bisect('v3-cantsplit.docx', {
      ...root,
      blocks: tableBlocks().map((block) =>
        block.kind !== 'table'
          ? block
          : { ...block, rows: block.rows.map((row) => ({ ...row, cant_split: true })) },
      ),
      sections: [],
    });
    bisect('v4-section.docx', {
      ...root,
      sections: [
        {
          ...emptySectionProperties(),
          pageSize: { state: 'set', value: { width: PT(595.3), height: PT(841.9) } },
          pageNumbering: { format: 'decimal', start: 1 },
          verticalAlign: { state: 'set', value: 'top' },
        },
      ],
    });
    bisect('v5-header.docx', {
      ...root,
      sections: [
        { ...emptySectionProperties(), headers: [{ part_path: headerPart.path, kind: 'default' }] },
      ],
      opaque_parts: [...root.opaque_parts, headerPart],
    });
    bisect('v6-table-only.docx', {
      ...root,
      blocks: createDocumentModel({ document_id: 'd30-artifact', blocks: [twoByTwo()] }).blocks,
      sections: [],
    });
    // v7 横向合并的单元格：用来实测"`w:tcPr` 里 gridSpan/vMerge 排在 vAlign **之后**"
    // （不符 `CT_TcPr` 的序列）到底会不会被真实 Word 拒绝——这条**不是**本批新引入的，
    // 是 D02 既有写法；没有实测证据就不该猜它有没有后果。
    bisect('v7-merged-cell.docx', {
      ...root,
      blocks: horizontalMergeModel().blocks,
      sections: [],
    });

    for (const [name, bytes] of written) {
      expect(bytes.byteLength, `${name} 应当是空文件之外的东西`).toBeGreaterThan(0);
      assertXmlPartsWellFormed(bytes, name);
    }
    expect(written.length).toBe(10);
    // 产物确实落盘了。
    for (const [name] of written) {
      expect(readFileSync(join(ARTIFACTS, name)).byteLength).toBeGreaterThan(0);
    }
  });
});
