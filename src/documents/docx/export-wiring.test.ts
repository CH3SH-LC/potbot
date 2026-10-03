/**
 * WCF-D30：**表格三处接线 + 节四项扩展 + R151 不回归**（design-05-P5/P4 的导出侧）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | `TableProperties.floating` → `w:tblpPr`（位置在 `w:tblW` **之前**） | ① |
 * | 非法定位取值**先拒绝**（R140），不把枚举外的值写进文件 | ② |
 * | `CellProperties.margins` → `w:tcMar`（位置在 `w:shd` 之后、`w:vAlign` 之前） | ③ |
 * | `RowNode.cant_split` → `w:cantSplit`（位置在 `w:trHeight` / `w:tblHeader` **之前**） | ④ |
 * | `SectionProperties.headers/footers` → `w:headerReference`/`w:footerReference` + **新关系分配** | ⑤ |
 * | 引用一个包里没有的部件 → 明确拒绝（不写悬空 `r:id`） | ⑥ |
 * | `pageNumbering` / `verticalAlign` 的写出与顺序 | ⑦ |
 * | **R151 不回归**：只改一段 ⇒ 除主部件外**逐字节不变** | ⑧ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { serializeXmlNode, utf8Bytes, type XmlElement } from '../../artifacts/ooxml/xml.js';
import { createDocumentModel } from '../model/document.js';
import { textParagraphNode, type DraftTableNode } from '../model/nodes.js';
import type { DocumentModel, Length, SectionProperties } from '../model/types.js';
import { plainTableDraft } from '../operations/table/fixtures.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';
import { cellMarginsElement, emptyCellProperties, emptySectionProperties, tableFloatingPositionElement } from './word-xml.js';

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

const MM = (value: number): Length => ({ unit: 'mm', value });
const PT = (value: number): Length => ({ unit: 'pt', value });

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 保留语料的包级事实，只换正文 / 节。 */
function modelWith(
  packageBase: DocumentModel,
  changes: {
    readonly blocks?: DocumentModel['blocks'];
    readonly sections?: readonly SectionProperties[];
    readonly opaque_parts?: DocumentModel['opaque_parts'];
  },
): DocumentModel {
  return {
    ...packageBase,
    blocks: changes.blocks ?? packageBase.blocks,
    sections: changes.sections ?? packageBase.sections,
    opaque_parts: changes.opaque_parts ?? packageBase.opaque_parts,
  };
}

/** 导出 → 按路径取部件文本。 */
function exportedParts(model: DocumentModel): {
  readonly text: (path: string) => string | null;
  readonly paths: readonly string[];
} {
  const archive = readZip(exportDocx(model));
  return {
    text: (path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : new TextDecoder().decode(entry.data);
    },
    paths: archive.entries.map((entry) => entry.path),
  };
}

/** 取某个标签在文本里的下标（不存在返回 -1）。 */
function indexOfTag(xml: string, tag: string): number {
  return xml.indexOf(`<${tag}`);
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

/** 一张 2×2 的表草稿；`patch` 用来注入 `floating` / `margins` / `cant_split`。 */
function twoByTwoTable(patch?: (draft: DraftTableNode) => DraftTableNode): DraftTableNode {
  const base = plainTableDraft([
    ['a1', 'b1'],
    ['a2', 'b2'],
  ]);
  return patch === undefined ? base : patch(base);
}

function modelWithTable(table: DraftTableNode): DocumentModel {
  const blocks = createDocumentModel({ document_id: 'wiring-table', blocks: [table] }).blocks;
  return modelWith(corpusModel(), { blocks, sections: [] });
}

describe('表格三处接线（WF-060/061/063）', () => {
  it('① TableProperties.floating → w:tblpPr，且排在 w:tblW 之前', () => {
    const table = twoByTwoTable((draft) => ({
      ...draft,
      properties: {
        ...draft.properties,
        width: { state: 'set', value: MM(80) },
        floating: {
          horizontal_anchor: 'center',
          vertical_anchor: 'top',
          horizontal_offset: MM(10),
          vertical_offset: MM(2),
          text_wrapping: 'around',
        },
      },
    }));
    const main = exportedParts(modelWithTable(table)).text(MAIN_PART) ?? '';

    expect(main).toContain('<w:tblpPr');
    // 位置值走 w:tblpXSpec / w:tblpYSpec（模型字段的值域正是 ST_XAlign / ST_YAlign）。
    expect(main).toContain('w:tblpXSpec="center"');
    expect(main).toContain('w:tblpYSpec="top"');
    // 锚点模型未建模 ⇒ 显式写 Word 的默认（horzAnchor=margin / vertAnchor=text），
    // 这也避开了 Word "tblpX=0 且 tblpY=0 且 horzAnchor=text" 时**整条忽略** tblpPr 的行为。
    expect(main).toContain('w:horzAnchor="margin"');
    expect(main).toContain('w:vertAnchor="text"');
    // 偏移植走 twips（10mm = 567 twips，2mm = 113 twips）。
    expect(main).toContain('w:tblpX="567"');
    expect(main).toContain('w:tblpY="113"');
    // `around` ⇒ 左右各留 Word 默认的 0.125"（180 twips）。
    expect(main).toContain('w:leftFromText="180"');
    expect(main).toContain('w:rightFromText="180"');

    const tblPr = indexOfTag(main, 'w:tblPr');
    expect(tblPr).toBeGreaterThanOrEqual(0);
    expect(indexOfTag(main, 'w:tblpPr')).toBeGreaterThan(tblPr);
    expect(indexOfTag(main, 'w:tblpPr')).toBeLessThan(indexOfTag(main, 'w:tblW'));
  });

  it('② 定位取值非法（枚举外的 token）⇒ unsupported_table_position，不写半成品', () => {
    const table = twoByTwoTable((draft) => ({
      ...draft,
      properties: {
        ...draft.properties,
        floating: {
          horizontal_anchor: 'middle',
          vertical_anchor: 'top',
          horizontal_offset: MM(1),
          vertical_offset: MM(1),
          text_wrapping: 'around',
        },
      },
    }));
    let thrown: unknown = null;
    try {
      exportDocx(modelWithTable(table));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_table_position');
  });

  it('③ CellProperties.margins → w:tcMar（在 w:tcBorders/w:shd 之后、w:vAlign 之前）', () => {
    const table = twoByTwoTable((draft) => ({
      ...draft,
      rows: draft.rows.map((row, rowIndex) => ({
        ...row,
        cells: row.cells.map((cell, cellIndex) =>
          rowIndex === 0 && cellIndex === 0
            ? {
                ...cell,
                properties: {
                  ...cell.properties,
                  verticalAlign: { state: 'set', value: 'center' },
                  margins: {
                    state: 'set',
                    value: { top: MM(1), left: MM(2), bottom: null, right: null },
                  },
                },
              }
            : cell,
        ),
      })),
    }));
    const main = exportedParts(modelWithTable(table)).text(MAIN_PART) ?? '';

    expect(main).toContain('<w:tcMar>');
    // 只写了明确给值的两条边（没给的边**不写**：不写=继承表格级 w:tblCellMar）。
    expect(main).toContain('<w:top w:w="57" w:type="dxa"/>');
    expect(main).toContain('<w:left w:w="113" w:type="dxa"/>');
    expect(main).not.toContain('<w:bottom w:w=');
    expect(main).not.toContain('<w:right w:w=');
    // 顺序：`w:tcMar` 夹在 `w:shd`（此处未设）与 `w:vAlign` 之间。
    expect(indexOfTag(main, 'w:tcMar')).toBeLessThan(indexOfTag(main, 'w:vAlign'));
    expect(indexOfTag(main, 'w:tcW')).toBeLessThan(indexOfTag(main, 'w:tcMar'));
  });

  /**
   * ④ 的夹具**必须绕过模型工厂**：`rowNode()` 与 `materializeRowNode()` 都**不转发**
   * `cant_split`（D01 的 `model/nodes.ts`），所以任何经 `createDocumentModel()` 造出来的行
   * 都不带这个字段。用例 ⑨ 把这条缺陷单独立证。
   */
  it('④ RowNode.cant_split → w:cantSplit，且排在 w:trHeight / w:tblHeader 之前', () => {
    const materialized = createDocumentModel({
      document_id: 'wiring-cant-split',
      blocks: [twoByTwoTable()],
    }).blocks;
    const blocks = materialized.map((block) =>
      block.kind !== 'table'
        ? block
        : {
            ...block,
            rows: block.rows.map((row, index) => ({
              ...row,
              cant_split: index === 0, // 第 0 行禁止断页；第 1 行保持 undefined（不写元素）
              header: index === 0,
              height: { state: 'set' as const, value: { value: PT(20), rule: 'atLeast' as const } },
            })),
          },
    );
    const main = exportedParts(modelWith(corpusModel(), { blocks, sections: [] })).text(MAIN_PART) ?? '';

    expect(indexOfTag(main, 'w:cantSplit')).toBeGreaterThanOrEqual(0);
    expect(indexOfTag(main, 'w:cantSplit')).toBeLessThan(indexOfTag(main, 'w:trHeight'));
    expect(indexOfTag(main, 'w:trHeight')).toBeLessThan(indexOfTag(main, 'w:tblHeader'));
    // 只有第 0 行写：整篇里恰好一个 cantSplit。
    expect(main.match(/<w:cantSplit\/>/g)?.length).toBe(1);
  });

  it('序列化函数本身就是那三处接线的**单元**（直接调用可证形状与属性顺序）', () => {
    const floating = tableFloatingPositionElement({
      horizontal_anchor: 'right',
      vertical_anchor: 'bottom',
      horizontal_offset: PT(36),
      vertical_offset: PT(18),
      text_wrapping: 'none',
    });
    const xml = serializeXmlNode(floating);
    // `none`（上下型）⇒ 左右间距归零；`around` 才留 180 twips。
    expect(xml).toContain('w:leftFromText="0"');
    expect(xml).toContain('w:tblpX="720"');
    expect(xml).toContain('w:tblpY="360"');
    expect(xml.startsWith('<w:tblpPr ')).toBe(true);

    const mar = cellMarginsElement({
      ...emptyCellProperties(),
      margins: { state: 'set', value: { top: null, left: MM(3), bottom: null, right: null } },
    });
    expect(mar).not.toBeNull();
    expect(serializeXmlNode(mar as XmlElement)).toBe('<w:tcMar><w:left w:w="170" w:type="dxa"/></w:tcMar>');

    // 四边全 null ⇒ 连空壳都不写。
    expect(
      cellMarginsElement({
        ...emptyCellProperties(),
        margins: { state: 'set', value: { top: null, left: null, bottom: null, right: null } },
      }),
    ).toBeNull();
  });

  it('未设这三样时**一个都不写**（不凭空造元素）', () => {
    const main = exportedParts(modelWithTable(twoByTwoTable())).text(MAIN_PART) ?? '';
    expect(main).not.toContain('w:tblpPr');
    expect(main).not.toContain('w:tcMar');
    expect(main).not.toContain('w:cantSplit');
  });
});

// ---------------------------------------------------------------------------
// 节
// ---------------------------------------------------------------------------

const HEADER_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const FOOTER_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

function referencePart(path: string, contentType: string, root: 'w:hdr' | 'w:ftr') {
  return {
    path,
    content_type: contentType,
    bytes: utf8Bytes(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${root} ` +
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    ),
  };
}

/** 一份带页眉 / 页脚引用的节属性（两者引用**不同**部件：页眉与页脚是两种关系类型）。 */
function sectionWithReferences(headerPath: string, footerPath: string): SectionProperties {
  return {
    ...emptySectionProperties(),
    headers: [{ part_path: headerPath, kind: 'default' }],
    footers: [{ part_path: footerPath, kind: 'default' }],
    pageNumbering: { format: 'upperRoman', start: 3 },
    verticalAlign: { state: 'set', value: 'center' },
    columns: { state: 'set', value: 2 },
  };
}

describe('节的四项扩展（WF-051–055）', () => {
  it('⑤ w:headerReference / w:footerReference 用**新分配的关系 id**，既有 rId 不动', () => {
    const base = corpusModel();
    const beforeRels = exportedParts(base).text(RELS_PART) ?? '';
    expect([...beforeRels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'rId10',
      'rId11',
      'rId12',
    ]);

    const model = modelWith(base, {
      sections: [sectionWithReferences('word/header1.xml', 'word/footer1.xml')],
      opaque_parts: [
        ...base.opaque_parts,
        referencePart('word/header1.xml', HEADER_CT, 'w:hdr'),
        referencePart('word/footer1.xml', FOOTER_CT, 'w:ftr'),
      ],
    });
    const parts = exportedParts(model);
    const main = parts.text(MAIN_PART) ?? '';
    const rels = parts.text(RELS_PART) ?? '';

    // 页眉与页脚各自一条关系（`…/header` 与 `…/footer`），id 依次分配。
    expect(main).toContain('<w:headerReference w:type="default" r:id="rId13"/>');
    // **前缀必须有绑定**：`corpus-a` 的根只声明了 `xmlns:w`，而这里写出了 `r:id`。
    // 不补 `xmlns:r` 就是一份 XML 层面不合法的文档——真实 Word 会拒开整个包（已实测）。
    expect(main).toMatch(/^<\?xml[^>]*\?>\n<w:document [^>]*xmlns:r="/);
    expect(main).toContain('<w:footerReference w:type="default" r:id="rId14"/>');
    // 新关系追加在末尾，老的三条编号与顺序不变。
    expect([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'rId10',
      'rId11',
      'rId12',
      'rId13',
      'rId14',
    ]);
    expect(rels).toContain('/relationships/header" Target="header1.xml"');
    expect(rels).toContain('/relationships/footer" Target="footer1.xml"');
    // 被引用部件本身写进了包，且内容类型没有漏。
    expect(parts.paths).toContain('word/header1.xml');
    expect(parts.paths).toContain('word/footer1.xml');
    const contentTypes = parts.text('[Content_Types].xml') ?? '';
    expect(contentTypes).toContain('header1.xml');
    expect(contentTypes).toContain('footer1.xml');
  });

  it('⑥ 引用的部件不在包里 ⇒ missing_section_reference_part（不写悬空 r:id）', () => {
    const base = corpusModel();
    const model = modelWith(base, {
      sections: [sectionWithReferences('word/header-missing.xml', 'word/footer-missing.xml')],
    });
    let thrown: unknown = null;
    try {
      exportDocx(model);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('missing_section_reference_part');
  });

  it('⑦ w:pgNumType 排在 w:cols 之前、w:vAlign 排在 w:cols 之后', () => {
    const base = corpusModel();
    // 不引用任何部件的节，避免依赖 ⑤ 的夹具。
    const model = modelWith(base, {
      sections: [
        {
          ...emptySectionProperties(),
          pageSize: { state: 'set', value: { width: PT(595.3), height: PT(841.9) } },
          columns: { state: 'set', value: 3 },
          pageNumbering: { format: 'upperRoman', start: 3 },
          verticalAlign: { state: 'set', value: 'both' },
        },
      ],
    });
    const main = exportedParts(model).text(MAIN_PART) ?? '';

    expect(main).toContain('<w:pgNumType w:fmt="upperRoman" w:start="3"/>');
    expect(main).toContain('<w:vAlign w:val="both"/>');
    expect(indexOfTag(main, 'w:pgSz')).toBeLessThan(indexOfTag(main, 'w:pgNumType'));
    expect(indexOfTag(main, 'w:pgNumType')).toBeLessThan(indexOfTag(main, 'w:cols'));
    expect(indexOfTag(main, 'w:cols')).toBeLessThan(indexOfTag(main, 'w:vAlign'));
  });

  /**
   * ⑨ **D01 缺陷留证**：模型的两条 `cant_split` 通路都断。
   *
   * `rowNode()` 没有 `cant_split` 入参、也不转发它；`materializeRowNode()` / 表格分支
   * 构造 RowNode 时也不带它。因此**任何**经 `createDocumentModel()` 造出来的行都不带该字段，
   * 表格操作即使想设"禁止跨页断行"也无处可放。
   *
   * 修复需一行（两处各补一个字段转发），但 `src/documents/model/**` 不在本任务写权内。
   */
  it('⑨ 模型工厂**保留** RowNode.cant_split（D01 缺陷已修复——由协调者补 `rowNode`/物化两处搬运）', () => {
    const draft = twoByTwoTable();
    const patched = {
      ...draft,
      rows: draft.rows.map((row) => ({ ...row, cant_split: true })),
    };
    const materialized = createDocumentModel({
      document_id: 'd01-cant-split-ok',
      blocks: [patched],
    }).blocks;
    const block = materialized[0];
    if (block === undefined || block.kind !== 'table') throw new Error('夹具：第一块不是表');
    const row = block.rows[0];
    expect(row).toBeDefined();
    // 此前传 true 物化出来是 `undefined`（字段被静默丢掉）；现在必须原样保留。
    expect(row?.cant_split).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R151
// ---------------------------------------------------------------------------

describe('R151 不回归', () => {
  it('⑧ 只往正文加一段 ⇒ 除主部件外**逐字节不变**', () => {
    const original = new Uint8Array(readFileSync(CORPUS_A));
    const archiveBefore = readZip(original);
    const base = importDocx(original);

    const extra = createDocumentModel({
      document_id: 'r151',
      blocks: [textParagraphNode({ text: '新加的一段。', source: 'user_request' })],
    }).blocks;
    const edited = modelWith(base, { blocks: [...base.blocks, ...extra] });

    const archiveAfter = readZip(exportDocx(edited));

    for (const entry of archiveBefore.entries) {
      const after = archiveAfter.by_path.get(entry.path);
      expect(after, `导出后缺部件 ${entry.path}`).toBeDefined();
      if (entry.path === MAIN_PART) {
        expect(
          Buffer.from((after as { data: Uint8Array }).data).equals(Buffer.from(entry.data)),
          '主部件应当变了',
        ).toBe(false);
        continue;
      }
      expect(
        Buffer.from((after as { data: Uint8Array }).data).equals(Buffer.from(entry.data)),
        `部件 ${entry.path} 不应当变`,
      ).toBe(true);
    }
  });

  it('未改动的语料原样导出 ⇒ 每个部件逐字节不变（含主部件）', () => {
    const original = new Uint8Array(readFileSync(CORPUS_A));
    const archiveBefore = readZip(original);
    const archiveAfter = readZip(exportDocx(importDocx(original)));
    expect(archiveAfter.entries.length).toBe(archiveBefore.entries.length);
    for (const entry of archiveBefore.entries) {
      const after = archiveAfter.by_path.get(entry.path);
      expect(after, entry.path).toBeDefined();
      expect(
        Buffer.from((after as { data: Uint8Array }).data).equals(Buffer.from(entry.data)),
        `部件 ${entry.path} 不应当变`,
      ).toBe(true);
    }
  });
});
