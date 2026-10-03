/**
 * 节的两处接线（design-05-P4 的剩余项；合同 R108/R140/R151）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | **自定义栏宽**真的进文件（`w:cols` + `w:col`，不再只有 `w:num`） | ① |
 * | 等宽栏**不**被写坏（仍只有 `w:num`，没有 `w:col`） | ② |
 * | **分页符 ≠ 段前分页**：两者产出不同结构 | ③ |
 * | 分栏符（`w:br w:type="column"`）与分页符分开 | ④ |
 * | 栏宽值走 `units/**` 的 twips（不出现换算魔数） | ①（值逐点钉住） |
 * | **R151 不回归**：没有附加项时导出与从前一致 | ⑤ |
 * | **只改栏宽也要进文件**（正文一字未动时曾被 `collectParts()` 判据吞掉） | ⑥ |
 * | **只有节属性变化 ⇒ 正文区逐字节不变**（不做整篇重写） | ⑥ |
 * | 未改动 ⇒ 主部件与其余全部条目逐字节不变 | ⑦ |
 * | 只改栏宽 ⇒ 除主部件外每个条目逐字节不变（未改动部件不重写） | ⑧ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import {
  breakNode,
  defaultParagraphProperties,
  paragraphNode,
  runNode,
  type DraftBlockNode,
} from '../model/nodes.js';
import { TOGGLE_ON, type DocumentModel, type Length, type SectionProperties } from '../model/types.js';
import { columnWidthsInTwips, customColumns, setColumnLayout } from '../sections/columns.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';
import { parseXmlBytes, type ParsedXmlNode } from './xml-parse.js';

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

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 保留语料的包级事实（opaque_parts / 关系 / 内容类型），只换正文与节。 */
function modelFrom(
  drafts: readonly DraftBlockNode[],
  sections?: readonly SectionProperties[],
): DocumentModel {
  const created = createDocumentModel({ document_id: 'sec-doc', blocks: drafts });
  const base = corpusModel();
  return { ...base, blocks: created.blocks, sections: sections ?? created.sections };
}

function mainXml(model: DocumentModel): string {
  const archive = readZip(exportDocx(model));
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('导出里没有主部件');
  return new TextDecoder().decode(entry.data);
}

function mainBytesOf(bytes: Uint8Array): Uint8Array {
  const entry = readZip(bytes).by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('包里没有主部件');
  return entry.data;
}

function partBytesMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [path, entry] of readZip(bytes).by_path) out.set(path, entry.data);
  return out;
}

/**
 * **独立量尺**：把主部件解析成树、**挖掉每个 `w:sectPr`** 之后的结构。
 *
 * 刻意不复用导出器里那套"按文本找 `w:sectPr` 区间"的实现——量尺与被测对象共用一套
 * 扫描逻辑的话，"区间找错"这类缺陷会同时污染两边而互相掩护。这里走的是解析树，
 * 与导出侧的文本扫描是两条独立的路。
 */
function bodyWithoutSections(bytes: Uint8Array): string {
  const strip = (node: ParsedXmlNode): unknown => {
    if (node.kind === 'text') return node.value;
    if (node.localName === 'sectPr') return null;
    return {
      name: node.name,
      attrs: node.attributes.map((attribute) => `${attribute.name}=${attribute.value}`),
      children: node.children.map(strip).filter((child) => child !== null),
    };
  };
  return JSON.stringify(strip(parseXmlBytes(bytes)));
}

describe('节的两处剩余接线（WF-048 / WF-050）', () => {
  it('① 自定义栏宽 ⇒ w:cols 带 w:equalWidth="0" 与逐栏 w:col（twips 来自 units 层）', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [runNode({ text: '双栏正文', source: 'user_request' })],
    });

    const layout = customColumns([
      { width: PT(100), space: PT(10) },
      { width: PT(200), space: PT(20) },
    ]);
    const model = setColumnLayout(modelFrom([draft]), 0, layout);

    // 换算在 `sections/columns.ts`（内部经 units）；这里逐点钉住，防止"两处各算一份"。
    const expected = columnWidthsInTwips(layout);
    expect(expected).toEqual([
      { width: 2000, space: 200 },
      { width: 4000, space: 400 },
    ]);

    const xml = mainXml(model);
    expect(xml).toContain('<w:cols w:num="2" w:equalWidth="0">');
    expect(xml).toContain('<w:col w:w="2000" w:space="200"/>');
    expect(xml).toContain('<w:col w:w="4000" w:space="400"/>');
    // 自定义栏宽**取代**了"只有栏数"的写法：不写 `w:cols` 上那个"没有子元素"的形态。
    expect(xml).not.toContain('<w:cols w:num="2"/>');
  });

  it('② 等宽 N 栏仍只写 w:num（不被自定义通道带偏）', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [runNode({ text: '两栏', source: 'user_request' })],
    });
    const created = createDocumentModel({ document_id: 'equal-cols', blocks: [draft] });
    const sections: readonly SectionProperties[] = [
      { ...created.sections[0]!, columns: { state: 'set', value: 2 } },
    ];
    const xml = mainXml(modelFrom([draft], sections));

    expect(xml).toContain('<w:cols w:num="2"/>');
    expect(xml).not.toContain('w:equalWidth');
    expect(xml).not.toContain('<w:col ');
  });

  it('③ 分页符 ≠ 段前分页：两者产出不同结构，且互不冒充', () => {
    const pageBreakDraft = paragraphNode({
      source: 'user_request',
      inlines: [
        runNode({ text: '前', source: 'user_request' }),
        breakNode({ breakType: 'page', source: 'user_request' }),
        runNode({ text: '后', source: 'user_request' }),
      ],
    });
    const beforeDraft = paragraphNode({
      source: 'user_request',
      properties: { ...defaultParagraphProperties(), pageBreakBefore: TOGGLE_ON },
      inlines: [runNode({ text: '新页首段', source: 'user_request' })],
    });

    const pageBreakJson = mainXml(
      modelFrom([pageBreakDraft]),
    );
    const beforeJson = mainXml(
      modelFrom([beforeDraft]),
    );

    // 分页符：**段内**的行内节点 `w:br w:type="page"`。
    expect(pageBreakJson).toContain('<w:br w:type="page"/>');
    expect(pageBreakJson).not.toContain('<w:pageBreakBefore/>');

    // 段前分页：**段落属性**，不产生任何 `w:br`。
    expect(beforeJson).toContain('<w:pageBreakBefore/>');
    expect(beforeJson).not.toContain('<w:br');

    // 两种机制确实是**两套字节**（同一条判据不能让它们互相冒充）。
    expect(pageBreakJson).not.toBe(beforeJson);
  });

  it('④ 分栏符是 w:br w:type="column"，与分页符分得开', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [
        runNode({ text: '栏一', source: 'user_request' }),
        breakNode({ breakType: 'column', source: 'user_request' }),
        runNode({ text: '栏二', source: 'user_request' }),
      ],
    });
    const xml = mainXml(
      modelFrom([draft]),
    );
    expect(xml).toContain('<w:br w:type="column"/>');
    expect(xml).not.toContain('w:type="page"');
  });

  it('⑤ R151 不回归：没有节附加项时，导出与"只改正文"的基准一致（无 w:col）', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [runNode({ text: '普通段落', source: 'user_request' })],
    });
    const model = modelFrom([draft]);
    const xml = mainXml(model);
    expect(xml).not.toContain('<w:col ');
    expect(xml).not.toContain('w:equalWidth');
    expect(xml).toContain('普通段落');
  });

  it('⑥ 只改自定义栏宽（正文一字未动）⇒ w:cols 真的进文件，且正文区逐字节不变', () => {
    // 这条用例**修前是红的**：`collectParts()` 的"未改动 ⇒ 写原始字节"判据把
    // `section_columns` **同时**用在重建侧与"重解析原始字节"侧，两边同时变化、互相抵消
    // ⇒ `rebuilt === reimported` ⇒ 写回原始字节 ⇒ 设完栏宽导出 XML 里连 `w:cols` 都没有
    // （产品 HTTP 却返回 200 + `changed_sections:[0]`）。对照：正文也变时通道本来就正常（用例 ①）。
    const original = new Uint8Array(readFileSync(CORPUS_A));
    const layout = customColumns([
      { width: PT(100), space: PT(10) },
      { width: PT(200), space: PT(20) },
    ]);
    const edited = setColumnLayout(importDocx(original), 0, layout);

    const xml = mainXml(edited);
    expect(xml).toContain('<w:cols w:num="2" w:equalWidth="0">');
    expect(xml).toContain('<w:col w:w="2000" w:space="200"/>');
    expect(xml).toContain('<w:col w:w="4000" w:space="400"/>');
    expect(xml).not.toContain('<w:cols w:num="1"/>');

    // **反向对照**：正文一个字都没动 ⇒ 除了节属性，主部件必须原样保留。
    // 独立量尺（解析树挖掉 `w:sectPr`）比对"原始主部件"与"导出主部件"。
    const exported = exportDocx(edited);
    expect(bodyWithoutSections(mainBytesOf(exported))).toBe(
      bodyWithoutSections(mainBytesOf(original)),
    );
    // 确实变了（不是"没动过"蒙混过关）：差异只可能在节属性里。
    expect(new TextDecoder().decode(mainBytesOf(exported))).not.toBe(
      new TextDecoder().decode(mainBytesOf(original)),
    );
  });

  it('⑦ 未改动 ⇒ 主部件与**其余全部条目**逐字节不变（R151）', () => {
    const original = new Uint8Array(readFileSync(CORPUS_A));
    const exported = exportDocx(importDocx(original));

    expect([...mainBytesOf(exported)]).toEqual([...mainBytesOf(original)]);
    const before = partBytesMap(original);
    const after = partBytesMap(exported);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      expect([...after.get(path) as Uint8Array], `部件 ${path} 被无谓重写`).toEqual([...bytes]);
    }
  });

  it('⑧ 只改栏宽 ⇒ 除主部件外每个条目逐字节不变（未改动的部件不被重写）', () => {
    const original = new Uint8Array(readFileSync(CORPUS_A));
    const edited = setColumnLayout(
      importDocx(original),
      0,
      customColumns([
        { width: PT(100), space: PT(10) },
        { width: PT(200), space: PT(20) },
      ]),
    );
    const exported = exportDocx(edited);

    const before = partBytesMap(original);
    const after = partBytesMap(exported);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      if (path === MAIN_PART) continue; // 主部件本来就该变（栏宽写在这里）。
      expect([...after.get(path) as Uint8Array], `部件 ${path} 被无谓重写`).toEqual([...bytes]);
    }
  });
});
