/**
 * 缺口 **GAP-WF050-IMPORT-COL-WIDTH** 的闭合证明（WF-050，合同 R105/R140/R151）。
 *
 * ## 缺口是什么
 *
 * 导出侧**能**写 `w:cols@w:equalWidth="0"` + 逐栏 `w:col`（`d0dc47a` 修好了"只改栏宽写不进
 * 文件"，见 `section-extras-export.test.ts` ⑥）。但导入侧 `parseSectionProperties()` 只读
 * `w:cols/@w:num`（栏数），**不读 `w:col` 子元素**，而冻结骨架 `SectionProperties` 也**没有**
 * 承载逐栏宽度的字段 ⇒ **导出 → 重新导入丢栏宽（只剩栏数）**。
 *
 * ## 闭合后
 *
 * - `parseSectionProperties` 把逐栏 `w:col@w:w/@w:space`（twips）解成 `SectionProperties.columnWidths`
 *   （**纯加法**新增可选字段，不破坏既有往返）；
 * - `serializeSectionProperties` 在没有 `columnsOverride`（附加项通道）时，从该字段写回
 *   `w:cols` + `w:col` ⇒ **导出 → 导入 → 再导出**逐项相等。
 *
 * ## 判据（每一格都有正例 / 反例）
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 导出 → 重新导入，逐栏宽与间距读得回（**改前红**） | ① |
 * | 导出 → 导入 → 再导出，`w:num` / `w:equalWidth` / 逐 `w:col@w:w/@w:space` 逐项相等 | ② |
 * | twips 精确：60mm/5mm 不因往返换算漂移 | ②③ |
 * | 反向对照：不设栏宽 ⇒ 不凭空出现 `w:cols` / `w:col` | ④ |
 * | 反向对照：等宽 N 栏 ⇒ 只有 `w:num`，没有 `w:col` | ⑤ |
 * | 非法栏宽被拒：导入含 `w:w="0"` 的 `w:col` 抛错（不静默吞） | ⑥ |
 * | 非法栏宽被拒：`customColumns` 宽度 / 间距非法抛错 | ⑦ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { writeZip } from '../../artifacts/ooxml/zip.js';
import { serializeXmlNode } from '../../artifacts/ooxml/xml.js';
import { createDocumentModel } from '../model/document.js';
import { paragraphNode, runNode } from '../model/nodes.js';
import type { DocumentModel, Length, SectionProperties } from '../model/types.js';
import { columnLayoutOf, columnWidthsInTwips, customColumns, setColumnLayout } from '../sections/columns.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';
import { W_NS, serializeSectionProperties } from './word-xml.js';
import {
  attributeValue,
  childElements,
  findChildren,
  parseXmlBytes,
  type ParsedXmlElement,
  type ParsedXmlNode,
} from './xml-parse.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MAIN_PART = 'word/document.xml';
const PT = (value: number): Length => ({ unit: 'pt', value });
const MM = (value: number): Length => ({ unit: 'mm', value });

function corpusBytes(): Uint8Array {
  return new Uint8Array(readFileSync(CORPUS_A));
}

function mainTextOf(bytes: Uint8Array): string {
  const entry = readZip(bytes).by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('包里没有主部件');
  return new TextDecoder().decode(entry.data);
}

/** 主部件里第一个 `w:cols`（按命名空间找，不按前缀）。 */
function firstCols(bytes: Uint8Array): ParsedXmlElement | null {
  const root = parseXmlBytes(new TextEncoder().encode(mainTextOf(bytes)));
  const walk = (node: ParsedXmlNode): ParsedXmlElement | null => {
    if (node.kind === 'text') return null;
    if (node.namespace === W_NS && node.localName === 'cols') return node;
    for (const child of childElements(node)) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(root);
}

/** `w:cols` 的读数：`w:num` / `w:equalWidth` / 逐 `w:col@w:w/@w:space`（原样字符串）。 */
function colsReading(bytes: Uint8Array): {
  readonly num: string | null;
  readonly equalWidth: string | null;
  readonly cols: readonly { readonly w: string | null; readonly space: string | null }[];
} | null {
  const cols = firstCols(bytes);
  if (cols === null) return null;
  return {
    num: attributeValue(cols, W_NS, 'num'),
    equalWidth: attributeValue(cols, W_NS, 'equalWidth'),
    cols: findChildren(cols, W_NS, 'col').map((column) => ({
      w: attributeValue(column, W_NS, 'w'),
      space: attributeValue(column, W_NS, 'space'),
    })),
  };
}

/** 保留语料的包级事实，只换 `word/document.xml` —— 造"非法栏宽"包用。 */
function withDocumentXml(documentXml: string): Uint8Array {
  const entries = [...readZip(corpusBytes()).by_path.entries()].map(([path, entry]) => ({
    path,
    data: entry.data,
  }));
  const target = entries.find((entry) => entry.path === MAIN_PART);
  if (target === undefined) throw new Error('语料里没有主部件');
  const replaced = entries.map((entry) =>
    entry.path === MAIN_PART
      ? { path: MAIN_PART, data: new Uint8Array(new TextEncoder().encode(documentXml)) }
      : entry,
  );
  return new Uint8Array(writeZip(replaced));
}

/** 语料的文档 XML，把第一个 `w:cols …` 换成给定片段（其余正文原样）。 */
function documentXmlWithCols(colsXml: string): string {
  const xml = mainTextOf(corpusBytes());
  return xml.replace(/<w:cols\b[^>]*\/>|<w:cols\b[^>]*>[\s\S]*?<\/w:cols>/, colsXml);
}

/** 一个"设了自定义栏宽"的模型：两栏各 60mm、间距 5mm。 */
function modelWithCustomColumns(): DocumentModel {
  return setColumnLayout(
    importDocx(corpusBytes()),
    0,
    customColumns([{ width: MM(60), space: MM(5) }, { width: MM(60), space: MM(5) }]),
  );
}

describe('GAP-WF050-IMPORT-COL-WIDTH 闭合：导入侧解出逐栏宽度', () => {
  it('① 导出 → 重新导入：逐栏宽与间距读得回（改前红）', () => {
    const layout = customColumns([
      { width: MM(60), space: MM(5) },
      { width: MM(60), space: MM(5) },
    ]);
    const exported = exportDocx(modelWithCustomColumns());
    const reimported = importDocx(exported);

    // 60mm = 3402 twips、5mm = 284 twips（换算只走 units/**；这里只钉结果）。
    expect(columnWidthsInTwips(layout)).toEqual([
      { width: 3402, space: 284 },
      { width: 3402, space: 284 },
    ]);

    // **改前**：columnLayoutOf 退回 `{ kind:'equal', count:2 }`（逐栏宽丢失）。
    // 改后：同样的逐栏宽 / 间距读得回（twips 逐位相等）。
    const reimportedLayout = columnLayoutOf(reimported, 0);
    expect(reimportedLayout?.kind).toBe('custom');
    expect(columnWidthsInTwips(reimportedLayout!)).toEqual(columnWidthsInTwips(layout));
    // 导入产物里也应有承载逐栏宽度的模型字段（纯加法新增）。
    const section = reimported.sections[0] as SectionProperties;
    expect(section.columnWidths).toEqual([
      { width: { unit: 'twips', value: 3402 }, space: { unit: 'twips', value: 284 } },
      { width: { unit: 'twips', value: 3402 }, space: { unit: 'twips', value: 284 } },
    ]);
  });

  it('② 导出 → 导入 → 再导出：w:num / w:equalWidth / 逐 w:col 逐项相等', () => {
    const first = exportDocx(modelWithCustomColumns());
    const reimported = importDocx(first);

    const a = colsReading(first);
    expect(a).toEqual({
      num: '2',
      equalWidth: '0',
      cols: [
        { w: '3402', space: '284' },
        { w: '3402', space: '284' },
      ],
    });

    // (a) **模型 → XML** 的直接判据（绕开导出器的"未改动 ⇒ 原字节"快路径，
    //     否则"再导出"可能只是把原始字节原样写回，证明不了模型真的承载了栏宽）。
    const section = reimported.sections[0] as SectionProperties;
    const fragment = serializeXmlNode(serializeSectionProperties(section, {}));
    expect(fragment).toContain('<w:cols w:num="2" w:equalWidth="0">');
    expect(fragment).toContain('<w:col w:w="3402" w:space="284"/>');

    // (b) 端到端：再导出的主部件里逐项与首次相等。
    expect(colsReading(exportDocx(reimported))).toEqual(a);
  });

  it('③ twips 精确：换另一组 mm 值，导出 → 导入 → 再导出仍逐项相等', () => {
    const model = setColumnLayout(
      importDocx(corpusBytes()),
      0,
      customColumns([{ width: MM(30), space: MM(7) }, { width: MM(45), space: MM(3) }]),
    );
    const first = exportDocx(model);
    const second = exportDocx(importDocx(first));
    const a = colsReading(first);
    expect(a).toEqual({
      num: '2',
      equalWidth: '0',
      cols: [
        { w: '1701', space: '397' }, // 30mm = 1701；7mm = 396.9 → 397
        { w: '2552', space: '170' }, // 45mm = 2551.5 → 2552（四舍五入）；3mm = 170.1 → 170
      ],
    });
    expect(colsReading(second)).toEqual(a);
  });

  it('④ 反向对照：不设栏宽 ⇒ 不凭空出现 w:cols / w:col', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [runNode({ text: '无分栏', source: 'user_request' })],
    });
    const created = createDocumentModel({ document_id: 'no-cols', blocks: [draft] });
    const base = importDocx(corpusBytes());
    const model: DocumentModel = { ...base, blocks: created.blocks, sections: created.sections };

    const xml = mainTextOf(exportDocx(model));
    expect(xml).not.toContain('w:cols');
    expect(xml).not.toContain('<w:col ');
    expect(xml).not.toContain('w:equalWidth');
  });

  it('⑤ 反向对照：等宽 N 栏 ⇒ 只有 w:num，没有 w:col', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [runNode({ text: '两栏', source: 'user_request' })],
    });
    const created = createDocumentModel({ document_id: 'equal-cols', blocks: [draft] });
    const sections: readonly SectionProperties[] = [
      { ...(created.sections[0] as SectionProperties), columns: { state: 'set', value: 2 } },
    ];
    const base = importDocx(corpusBytes());
    const model: DocumentModel = { ...base, blocks: created.blocks, sections };

    const reading = colsReading(exportDocx(model));
    expect(reading).toEqual({ num: '2', equalWidth: null, cols: [] });
  });

  it('⑥ 非法栏宽被拒：导入含 w:w="0" 的 w:col 抛错（不静默吞）', () => {
    const xml = documentXmlWithCols(
      '<w:cols w:num="2" w:equalWidth="0"><w:col w:w="0" w:space="200"/><w:col w:w="2000" w:space="200"/></w:cols>',
    );
    expect(xml).toContain('w:w="0"');
    expect(() => importDocx(withDocumentXml(xml))).toThrow(DocxError);

    // 负宽也应被拒。
    const negative = documentXmlWithCols(
      '<w:cols w:num="2" w:equalWidth="0"><w:col w:w="-100" w:space="200"/><w:col w:w="2000" w:space="200"/></w:cols>',
    );
    expect(() => importDocx(withDocumentXml(negative))).toThrow(DocxError);
  });

  it('⑦ 非法栏宽被拒：customColumns 的宽度 / 间距非法抛错', () => {
    expect(() => customColumns([{ width: PT(0), space: PT(10) }, { width: PT(100), space: PT(10) }])).toThrow();
    expect(() => customColumns([{ width: PT(-5), space: PT(10) }, { width: PT(100), space: PT(10) }])).toThrow();
    expect(() =>
      customColumns([
        { width: PT(100), space: { unit: 'pt', value: Number.NaN } },
        { width: PT(100), space: PT(10) },
      ]),
    ).toThrow();
  });
});
