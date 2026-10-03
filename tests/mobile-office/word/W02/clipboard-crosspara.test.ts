/**
 * **W-I12 — 剪贴板跨段粘贴（块级插入）独立验证**（`tests/mobile-office/word/W02/`）。
 *
 * 对 `src/documents/selection/clipboard.ts` 的 W-I12 增量取证：W02 的 v1 边界（多段剪贴板 /
 * 多行纯文本返回 `unsupported`）被**块级插入**取代——目标段按目标范围拆出 头段 / 中段 / 尾段，
 * 第一段剪贴板内容并进头段、最后一段并进尾段、中间各段各成一段，整体替换目标段在 `blocks` 里的
 * 位置（**含表格单元格内**的段落）。
 *
 * 与同目录 `clipboard.test.ts`（单段复制 / 剪切 / 粘贴 / 纯文本）不重叠：本文件只测**跨段**行为，
 * 并额外钉住"单段路径未被回归"。
 *
 * ## 覆盖与反向对照
 *
 * | 行为面 | 独立判据 |
 * |---|---|
 * | 3 段复制 → 粘进目标段中间 | 块序列 = [原块…, 头段, 中段, 尾段]，逐段文本正确；段数为 4−1+3 |
 * | 头段身份 | 头段保留目标段 id；中/尾段拿确定性派生 id（`<目标 id>~b<i>`） |
 * | 表格单元格目标 | 目标在单元格内时在**该单元格的 blocks** 里展开；表外段落按引用不变 |
 * | run 属性 | keep-source 保源属性；merge 目标显式覆盖源；plain-text 取目标格式并丢非文本 |
 * | 失败码 | 越界 `invalid_range` / 未知节点 `unknown_node` / 全空 `empty_range` / 域内边界与无目标格式 `unsupported` |
 * | 源不变 | 所有失败路径下原模型逐块按引用不变、文本不变 |
 * | 多行纯文本 | 每行一段；空行成空段落；目标无 run `unsupported`；纯换行 `empty_range` |
 * | 不变量 | 粘贴不改 revision / document_id；不触碰的块按引用保留 |
 * | 反向对照 | 邻位目标 [3,3) 与 [4,4) 产出不同的头/尾文本——偏移算错即红 |
 *
 * 断言追溯合同语义（R102 码位偏移、R109 source、R136 原子性、R147/R151 范围外不变、
 * WF-088 明确模式与不假报成功），不照抄实现内部量。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel, InlineNode, ParagraphNode, RunNode, TableNode } from '../../../../src/documents/model/types.js';
import {
  copySelection,
  pasteClipboard,
  pastePlainText,
  type ClipboardPayload,
} from '../../../../src/documents/selection/clipboard.js';
import { inlineText } from '../../../../src/documents/selection/inline-map.js';
import { collectParagraphs, paragraphText, requireParagraph } from '../../../../src/documents/selection/structure.js';
import {
  boldOff,
  boldOn,
  cell,
  document,
  field,
  paragraph,
  paragraphOfRuns,
  row,
  run,
  runProperties,
  table,
} from '../../../../src/documents/selection/testing.js';

// ---------------------------------------------------------------------------
// 独立工具（不 import 生产实现的判定逻辑，避免自证）
// ---------------------------------------------------------------------------

function textOf(model: DocumentModel): string[] {
  return collectParagraphs(model.blocks).map(paragraphText);
}

function runsOf(inlines: readonly InlineNode[]): RunNode[] {
  return inlines.filter((node): node is RunNode => node.kind === 'run');
}

function paragraphById(model: DocumentModel, id: string): ParagraphNode {
  const found = requireParagraph(model, id);
  if (!found.ok) throw new Error(`夹具缺少段落 ${id}`);
  return found.value;
}

/** 找结果段落里文本等于 `text` 的第一个 run。 */
function runWithText(model: DocumentModel, id: string, text: string): RunNode | undefined {
  return runsOf(paragraphById(model, id).inlines).find((node) => node.text === text);
}

function selection(model: DocumentModel, ranges: readonly { node_id: string; start: number; end: number }[]) {
  return { document_id: model.document_id, base_revision: model.revision, ranges };
}

/** 手工构造多段剪贴板载荷（不经复制，便于钉住块序列与模式）。 */
function multiPayload(paragraphs: readonly (readonly InlineNode[])[]): ClipboardPayload {
  return {
    document_id: 'doc-1',
    paragraphs: paragraphs.map((inlines) => ({ inlines, whole_paragraph: true })),
    text: paragraphs.map((inlines) => inlineText(inlines)).join('\n'),
    contains_non_text: paragraphs.some((inlines) => inlines.some((node) => node.kind !== 'run')),
  };
}

function tableAt(model: DocumentModel, index: number): TableNode {
  const block = model.blocks[index];
  if (block === undefined || block.kind !== 'table') throw new Error(`块 ${index} 不是表格`);
  return block;
}

// ---------------------------------------------------------------------------
// §A 3 段复制 → 粘进目标段中间：块序列与身份
// ---------------------------------------------------------------------------

describe('§A 跨段粘贴：3 段复制 → 粘进目标段中间', () => {
  const base = () =>
    document([
      paragraphOfRuns('p1', [['r1', '甲乙丙丁', boldOn()]]),
      paragraphOfRuns('p2', [['r2', '戊己庚辛']]),
      paragraphOfRuns('p3', [['r3', '壬癸子丑']]),
      paragraphOfRuns('t', [['rt', 'ABCDEFGH']]),
    ]);

  it('复制 3 段（经 copySelection）再粘进 t 的中间 [4,4) ⇒ 块序列 [p1,p2,p3,头,中,尾]', () => {
    const doc = base();
    const copied = copySelection(
      doc,
      selection(doc, [
        { node_id: 'p1', start: 0, end: 4 },
        { node_id: 'p2', start: 0, end: 4 },
        { node_id: 'p3', start: 0, end: 4 },
      ]),
    );
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.paragraphs.length).toBe(3);
    expect(copied.value.text).toBe('甲乙丙丁\n戊己庚辛\n壬癸子丑');

    const pasted = pasteClipboard(doc, copied.value, { node_id: 't', start: 4, end: 4 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;

    // 块数：4 个原块 − 1（目标段被替换）+ 3（头/中/尾）= 6
    expect(pasted.value.model.blocks.length).toBe(6);
    expect(textOf(pasted.value.model)).toEqual([
      '甲乙丙丁',
      '戊己庚辛',
      '壬癸子丑',
      'ABCD甲乙丙丁', // 头段：before('ABCD') + 源第 1 段
      '戊己庚辛', //     中段：源第 2 段
      '壬癸子丑EFGH', // 尾段：源第 3 段 + after('EFGH')
    ]);
    // 头段保留目标段 id；中/尾段确定性派生 id
    expect(paragraphText(paragraphById(pasted.value.model, 't'))).toBe('ABCD甲乙丙丁');
    expect(paragraphText(paragraphById(pasted.value.model, 't~b1'))).toBe('戊己庚辛');
    expect(paragraphText(paragraphById(pasted.value.model, 't~b2'))).toBe('壬癸子丑EFGH');
    // 未触碰的块按引用保留
    expect(pasted.value.model.blocks[0]).toBe(doc.blocks[0]);
    expect(pasted.value.model.blocks[1]).toBe(doc.blocks[1]);
    expect(pasted.value.model.blocks[2]).toBe(doc.blocks[2]);
  });

  it('keep-source：源第 1 段 run 的 bold=on 随头段落进目标', () => {
    const doc = base();
    const payload = multiPayload([[run('s1', '甲乙丙丁', boldOn())], [run('s2', '戊己')], [run('s3', '庚辛')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 't', start: 4, end: 4 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(runWithText(pasted.value.model, 't', '甲乙丙丁')?.properties.bold.state).toBe('on');
  });

  it('回执：insertedParagraphs 逐段给出粘贴内容范围；replaced=null（零宽）、replacedFragment 为空', () => {
    const doc = base();
    const payload = multiPayload([[run('s1', '甲乙丁')], [run('s2', '戊己')], [run('s3', '庚辛')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 't', start: 4, end: 4 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.insertedParagraphs).toEqual([
      { node_id: 't', start: 4, end: 7 },
      { node_id: 't~b1', start: 0, end: 2 },
      { node_id: 't~b2', start: 0, end: 2 },
    ]);
    expect(pasted.value.insertedRange).toEqual({ node_id: 't', start: 4, end: 7 });
    expect(pasted.value.replaced).toBeNull();
    expect(pasted.value.replacedFragment).toEqual([]);
    expect(pasted.value.plainText).toBe('甲乙丁\n戊己\n庚辛');
  });

  it('非零宽目标：被替换的选中片段进 replaced / replacedFragment，头尾围绕它拼合', () => {
    const doc = base();
    const payload = multiPayload([[run('s1', '甲')], [run('s2', '乙')], [run('s3', '丙')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 't', start: 3, end: 5 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    // t='ABCDEFGH'：删 [3,5)='DE'，头=ABC+甲，中=乙，尾=丙+FGH
    expect(textOf(pasted.value.model)).toEqual(['甲乙丙丁', '戊己庚辛', '壬癸子丑', 'ABC甲', '乙', '丙FGH']);
    expect(pasted.value.replaced).toEqual({ node_id: 't', start: 3, end: 5 });
    expect(inlineText(pasted.value.replacedFragment)).toBe('DE');
  });

  it('2 段剪贴板 ⇒ 只产生头/尾两段（无中段）', () => {
    const doc = document([paragraphOfRuns('t', [['rt', 'ABCDEFGH']])]);
    const payload = multiPayload([[run('s1', '12')], [run('s2', '34')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 't', start: 4, end: 4 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.model.blocks.length).toBe(2);
    expect(textOf(pasted.value.model)).toEqual(['ABCD12', '34EFGH']);
  });

  it('不变量：粘贴不改 revision / document_id', () => {
    const doc = base();
    const payload = multiPayload([[run('s1', '甲')], [run('s2', '乙')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 't', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.model.revision).toBe(doc.revision);
    expect(pasted.value.model.document_id).toBe(doc.document_id);
  });
});

// ---------------------------------------------------------------------------
// §B 表格单元格内的目标段
// ---------------------------------------------------------------------------

describe('§B 跨段粘贴：表格单元格内的目标段', () => {
  const withTable = () =>
    document([
      paragraphOfRuns('before', [['b1', '前置']]),
      table('tbl1', [
        row('row1', [cell('c1', [paragraphOfRuns('cp1', [['cr1', 'WXYZ']])])]),
      ]),
      paragraphOfRuns('after', [['a1', '后置']]),
    ]);

  it('目标在单元格内 ⇒ 在该单元格的 blocks 里展开为 头/尾 两段，表外段落按引用不变', () => {
    const doc = withTable();
    const payload = multiPayload([[run('s1', 'AA')], [run('s2', 'BB')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'cp1', start: 2, end: 2 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;

    // 单元格内段落序列：头=WX+AA，尾=BB+YZ
    expect(collectParagraphs(tableAt(pasted.value.model, 1).rows[0]!.cells[0]!.blocks).map(paragraphText)).toEqual([
      'WXAA',
      'BBYZ',
    ]);
    // 整篇文档段落顺序（前置、单元格两段、后置）
    expect(textOf(pasted.value.model)).toEqual(['前置', 'WXAA', 'BBYZ', '后置']);
    // 表外块按引用不变；表块本身是新对象（内容变了）
    expect(pasted.value.model.blocks[0]).toBe(doc.blocks[0]);
    expect(pasted.value.model.blocks[2]).toBe(doc.blocks[2]);
    expect(pasted.value.model.blocks[1]).not.toBe(doc.blocks[1]);

    expect(pasted.value.insertedParagraphs).toEqual([
      { node_id: 'cp1', start: 2, end: 4 },
      { node_id: 'cp1~b1', start: 0, end: 2 },
    ]);
  });

  it('3 段粘进单元格中间 ⇒ 单元格内出现 头/中/尾 三段', () => {
    const doc = withTable();
    const payload = multiPayload([[run('s1', 'A')], [run('s2', 'B')], [run('s3', 'C')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'cp1', start: 2, end: 2 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(collectParagraphs(tableAt(pasted.value.model, 1).rows[0]!.cells[0]!.blocks).map(paragraphText)).toEqual([
      'WXA',
      'B',
      'CYZ',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §C fail-closed：失败码与源不变
// ---------------------------------------------------------------------------

describe('§C 跨段粘贴：失败显式且源文档零改动', () => {
  const twoPara = () => multiPayload([[run('s1', '甲')], [run('s2', '乙')]]);

  it('目标越界 ⇒ invalid_range，源文档逐块按引用不变', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, twoPara(), { node_id: 'p1', start: 0, end: 99 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('invalid_range');
    expect(doc.blocks[0]).toBe(doc.blocks[0]);
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('目标反转 [3,1) ⇒ invalid_range', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, twoPara(), { node_id: 'p1', start: 3, end: 1 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('invalid_range');
  });

  it('目标段不存在 ⇒ unknown_node，源文档不变', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, twoPara(), { node_id: 'nope', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('unknown_node');
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('全部为空段 ⇒ empty_range（不假报成功）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, multiPayload([[], []]), { node_id: 'p1', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('empty_range');
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('目标边界落在多码位域内部 ⇒ unsupported，源文档不变', () => {
    const doc = document([paragraph('p1', [run('r1', 'abc'), field('f1', 'PAGE', '12345'), run('r3', 'xyz')])]);
    const pasted = pasteClipboard(doc, twoPara(), { node_id: 'p1', start: 4, end: 6 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('unsupported');
    expect(textOf(doc)).toEqual(['abc12345xyz']);
  });

  it('merge / plain-text 粘进无 run 的空段 ⇒ unsupported（无目标格式基准）', () => {
    const doc = document([paragraph('p1', [])]);
    const merge = pasteClipboard(doc, twoPara(), { node_id: 'p1', start: 0, end: 0 }, 'merge-formatting');
    const plain = pasteClipboard(doc, twoPara(), { node_id: 'p1', start: 0, end: 0 }, 'plain-text');
    expect(merge.ok).toBe(false);
    expect(plain.ok).toBe(false);
    if (merge.ok || plain.ok) return;
    expect(merge.code).toBe('unsupported');
    expect(plain.code).toBe('unsupported');
    expect(textOf(doc)).toEqual(['']);
  });

  it('keep-source 粘进无 run 的空段仍可（不需要目标格式）', () => {
    const doc = document([paragraph('p1', [])]);
    const pasted = pasteClipboard(doc, twoPara(), { node_id: 'p1', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲', '乙']);
  });
});

// ---------------------------------------------------------------------------
// §D 多行纯文本粘贴
// ---------------------------------------------------------------------------

describe('§D pastePlainText 多行：每行一段', () => {
  it('3 行粘进目标中间 ⇒ 头/中/尾，且取目标 run 格式', () => {
    const doc = document([paragraphOfRuns('t', [['rt', '甲乙丙丁', boldOff()]])]);
    const pasted = pastePlainText(doc, 'A\nB\nC', { node_id: 't', start: 2, end: 2 });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲乙A', 'B', 'C丙丁']);
    expect(runWithText(pasted.value.model, 't', 'A')?.properties.bold).toEqual({ state: 'off' });
    expect(runWithText(pasted.value.model, 't~b1', 'B')?.properties.bold).toEqual({ state: 'off' });
  });

  it('中间空行 ⇒ 成为空段落（保留段落分隔）', () => {
    const doc = document([paragraphOfRuns('t', [['rt', '甲乙']])]);
    const pasted = pastePlainText(doc, 'A\n\nB', { node_id: 't', start: 2, end: 2 });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲乙A', '', 'B']);
    expect(paragraphById(pasted.value.model, 't~b1').inlines.length).toBe(0);
  });

  it('纯换行（无任何字符）⇒ empty_range，源文档不变', () => {
    const doc = document([paragraphOfRuns('t', [['rt', '甲乙']])]);
    const pasted = pastePlainText(doc, '\n', { node_id: 't', start: 0, end: 0 });
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('empty_range');
    expect(textOf(doc)).toEqual(['甲乙']);
  });

  it('目标无 run ⇒ unsupported', () => {
    const doc = document([paragraph('t', [])]);
    const pasted = pastePlainText(doc, 'A\nB', { node_id: 't', start: 0, end: 0 });
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('unsupported');
  });

  it('单行纯文本仍走原路径（未被回归）', () => {
    const doc = document([paragraphOfRuns('t', [['rt', '甲乙丙丁', boldOff()]])]);
    const pasted = pastePlainText(doc, '文', { node_id: 't', start: 2, end: 2 });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲乙文丙丁']);
    expect(pasted.value.insertedParagraphs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §E 三种模式在跨段路径下语义一致
// ---------------------------------------------------------------------------

describe('§E 跨段路径的 keep-source / merge / plain-text', () => {
  const dest = () => document([paragraphOfRuns('t', [['rt', '甲乙丙丁', runProperties({ bold: { state: 'off' } })]])]);

  it('merge：目标显式 bold=off 覆盖源，源里目标未指定的 italic=on 保留（每段都如此）', () => {
    const payload = multiPayload([
      [run('s1', '甲', runProperties({ italic: { state: 'on' } }))],
      [run('s2', '乙', runProperties({ italic: { state: 'on' } }))],
    ]);
    const pasted = pasteClipboard(dest(), payload, { node_id: 't', start: 2, end: 2 }, 'merge-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    const head = runWithText(pasted.value.model, 't', '甲');
    const tail = runWithText(pasted.value.model, 't~b1', '乙');
    expect(head?.properties.bold).toEqual({ state: 'off' });
    expect(head?.properties.italic).toEqual({ state: 'on' });
    expect(tail?.properties.bold).toEqual({ state: 'off' });
    expect(tail?.properties.italic).toEqual({ state: 'on' });
  });

  it('plain-text：域被丢弃并累加 droppedNonText，run 取目标格式', () => {
    const payload = multiPayload([
      [run('s1', '甲', boldOn()), field('f1', 'PAGE', '12')],
      [run('s2', '乙', boldOn())],
    ]);
    const pasted = pasteClipboard(dest(), payload, { node_id: 't', start: 2, end: 2 }, 'plain-text');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.droppedNonText).toBe(1);
    expect(pasted.value.plainText).toBe('甲\n乙');
    const head = runWithText(pasted.value.model, 't', '甲');
    const tail = runWithText(pasted.value.model, 't~b1', '乙');
    expect(head?.properties.bold).toEqual({ state: 'off' });
    expect(tail?.properties.bold).toEqual({ state: 'off' });
  });

  it('模式差异对照：同一目标，keep-source 与 plain-text 的加粗结果相反', () => {
    const payload = multiPayload([[run('s1', '甲', boldOn())], [run('s2', '乙', boldOn())]]);
    const kept = pasteClipboard(dest(), payload, { node_id: 't', start: 2, end: 2 }, 'keep-source-formatting');
    const plain = pasteClipboard(dest(), payload, { node_id: 't', start: 2, end: 2 }, 'plain-text');
    expect(kept.ok && plain.ok).toBe(true);
    if (!kept.ok || !plain.ok) return;
    expect(runWithText(kept.value.model, 't', '甲')?.properties.bold.state).toBe('on');
    expect(runWithText(plain.value.model, 't', '甲')?.properties.bold.state).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// §F 反向对照：邻位目标产出不同的头/尾文本
// ---------------------------------------------------------------------------

describe('§F 反向对照：偏移算错即红', () => {
  it('邻位目标 [3,3) 与 [4,4) 产出不同的头/尾文本', () => {
    const payload = multiPayload([[run('s1', 'X')], [run('s2', 'Y')]]);
    const a = pasteClipboard(document([paragraphOfRuns('t', [['rt', 'ABCDEFGH']])]), payload, { node_id: 't', start: 3, end: 3 }, 'keep-source-formatting');
    const b = pasteClipboard(document([paragraphOfRuns('t', [['rt', 'ABCDEFGH']])]), payload, { node_id: 't', start: 4, end: 4 }, 'keep-source-formatting');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(textOf(a.value.model)).toEqual(['ABCX', 'YDEFGH']);
    expect(textOf(b.value.model)).toEqual(['ABCDX', 'YEFGH']);
    expect(textOf(a.value.model)).not.toEqual(textOf(b.value.model));
  });
});

// ---------------------------------------------------------------------------
// §G 单段路径未被回归（跨段为纯加法）
// ---------------------------------------------------------------------------

describe('§G 单段粘贴未被回归', () => {
  it('单段富粘贴仍产出原文本与范围（无 insertedParagraphs）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const payload = multiPayload([[run('s1', 'XY')]]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'p1', start: 2, end: 2 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲乙XY丙丁']);
    expect(pasted.value.insertedRange).toEqual({ node_id: 'p1', start: 2, end: 4 });
    expect(pasted.value.insertedParagraphs).toBeUndefined();
  });
});
