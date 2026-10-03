/**
 * **W02 — 剪贴板独立验证**（`tests/mobile-office/word/W02/`）。
 *
 * 对 `src/documents/selection/clipboard.ts`（WF-088 复制 / 剪切 / 粘贴 + 纯文本粘贴）做独立取证。
 * 与同目录 `character-selection-verification.test.ts`（字符格式施加）不重叠：本文件只测剪贴板。
 *
 * ## 覆盖与反向对照
 *
 * | 行为面 | 独立判据 |
 * |---|---|
 * | 复制（中英跨 run / emoji） | 富内容保 run 属性；纯文本投影逐码位正确；无孤立代理项 |
 * | 剪切 | 只删被选、段外不变、原子性（第二范围坏 ⇒ 一个都不删） |
 * | 粘贴三模式 | keep-source / merge / plain-text 产出**不同**属性，逐字段钉住 |
 * | plain-text 丢非文本 | 域被丢弃且 `droppedNonText` 如实报出（不假装没丢） |
 * | 目标精度 | 跨 run 替换后**范围外文本逐码位不变**、未触及块按引用保留 |
 * | fail-closed | 空选区 / 空剪贴板 / 反转 / 越界 / 域内边界，一律显式失败且源文档零改动 |
 * | 跨段（W-I12） | 多段剪贴板 / 多行纯文本改为**块级插入**（独立取证见 `clipboard-crosspara.test.ts`）；本文件只钉住单段路径不被回归 |
 * | 反向对照 | 邻位目标 [4,6) 与 [5,7) 必须产出不同文本；粘贴不改 revision / document_id |
 *
 * 断言追溯到合同语义（R102 码位偏移、R109 source、R136 原子性、R147/R151 范围外不变、
 * R138/R141 revision 由 W10 收口、WF-088 明确模式与不假报成功），不照抄实现内部量。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel, InlineNode, RunNode } from '../../../../src/documents/model/types.js';
import {
  copySelection,
  cutSelection,
  pasteClipboard,
  pastePlainText,
  type ClipboardPayload,
} from '../../../../src/documents/selection/clipboard.js';
import { inlineText } from '../../../../src/documents/selection/inline-map.js';
import { collectParagraphs, paragraphText, requireParagraph } from '../../../../src/documents/selection/structure.js';
import {
  boldOff,
  boldOn,
  document,
  field,
  paragraph,
  paragraphOfRuns,
  run,
  runProperties,
} from '../../../../src/documents/selection/testing.js';

// ---------------------------------------------------------------------------
// 独立工具（不 import 生产实现的判定逻辑，避免自证）
// ---------------------------------------------------------------------------

const GRIN = '\u{1F600}';

function points(text: string): string[] {
  return Array.from(text);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

function runsOf(inlines: readonly InlineNode[]): RunNode[] {
  return inlines.filter((node): node is RunNode => node.kind === 'run');
}

function boldTexts(inlines: readonly InlineNode[]): string[] {
  return runsOf(inlines).filter((node) => node.properties.bold.state === 'on').map((node) => node.text);
}

function textOf(model: DocumentModel): string[] {
  return collectParagraphs(model.blocks).map(paragraphText);
}

function paragraphById(model: DocumentModel, id: string) {
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

/** 手工构造单段剪贴板载荷（用于钉住三种粘贴模式，不经过 copy）。 */
function payloadOf(inlines: readonly InlineNode[]): ClipboardPayload {
  return {
    document_id: 'doc-1',
    paragraphs: [{ inlines, whole_paragraph: false }],
    text: inlineText(inlines),
    contains_non_text: inlines.some((node) => node.kind !== 'run'),
  };
}

// ---------------------------------------------------------------------------
// §A 复制
// ---------------------------------------------------------------------------

describe('§A 复制：中英跨 run、emoji、空选区显式失败', () => {
  it('跨 run 复制 [6,8) ⇒ 富内容保 run 属性，纯文本投影 "界w"（跨 r1/r2 边界）', () => {
    // 'Hello世界' 占 0..6（界=6），'wide中' 从 w=7 开始 ⇒ [6,8) 恰好横跨 run 边界。
    const doc = document([
      paragraphOfRuns('p1', [
        ['r1', 'Hello世界'],
        ['r2', 'wide中'],
      ]),
    ]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 6, end: 8 }]));
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    expect(copied.value.text).toBe('界w');
    expect(copied.value.contains_non_text).toBe(false);
    expect(copied.value.paragraphs.length).toBe(1);
    // 被选片段是"切出来的"run（id 派生），文本逐码位正确
    expect(inlineText(copied.value.paragraphs[0]!.inlines)).toBe('界w');
  });

  it('反向对照：邻位 [4,6) 与 [3,5) 复制出不同文本（"o世" ≠ "lo"）——边界算错即红', () => {
    const doc = document([
      paragraphOfRuns('p1', [
        ['r1', 'Hello世界'],
        ['r2', 'wide中'],
      ]),
    ]);
    const a = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 4, end: 6 }]));
    const b = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 3, end: 5 }]));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.text).toBe('o世');
    expect(b.value.text).toBe('lo');
    expect(a.value.text).not.toBe(b.value.text);
  });

  it('emoji：复制 [1,2) ⇒ 文本就是那个 emoji，无孤立代理项', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', `甲${GRIN}乙`]])]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 1, end: 2 }]));
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.text).toBe(GRIN);
    expect(points(copied.value.text).length).toBe(1);
    expect(hasLoneSurrogate(copied.value.text)).toBe(false);
  });

  it('整段复制 ⇒ whole_paragraph=true，文本逐码位等于整段', () => {
    const doc = document([
      paragraphOfRuns('p1', [
        ['r1', 'Hello世界'],
        ['r2', 'wide中'],
      ]),
    ]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 0, end: 12 }]));
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.paragraphs[0]!.whole_paragraph).toBe(true);
    expect(copied.value.text).toBe('Hello世界wide中');
  });

  it('多范围复制 ⇒ 各范围用 "\\n" 连接（与 extractSelectionText 口径一致）', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙丙']]),
      paragraphOfRuns('p2', [['r2', '丁戊己']]),
    ]);
    const copied = copySelection(
      doc,
      selection(doc, [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p2', start: 0, end: 1 },
      ]),
    );
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.text).toBe('甲乙\n丁');
  });

  it('零宽选区（光标）⇒ empty_range，不返回空载荷假装成功（WF-088 不假报）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 2, end: 2 }]));
    expect(copied.ok).toBe(false);
    if (copied.ok) return;
    expect(copied.code).toBe('empty_range');
  });

  it('过期选区 ⇒ stale_revision（带当前 revision），且不复制', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const copied = copySelection(doc, { document_id: 'doc-1', base_revision: 0, ranges: [{ node_id: 'p1', start: 0, end: 2 }] });
    expect(copied.ok).toBe(false);
    if (copied.ok) return;
    expect(copied.code).toBe('stale_revision');
    expect(copied.detail.currentRevision).toBe(1);
  });

  it('文档身份不符 ⇒ mismatched_document', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const copied = copySelection(doc, { document_id: 'other', base_revision: 1, ranges: [{ node_id: 'p1', start: 0, end: 2 }] });
    expect(copied.ok).toBe(false);
    if (copied.ok) return;
    expect(copied.code).toBe('mismatched_document');
  });

  it('范围越界 ⇒ invalid_range', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 0, end: 99 }]));
    expect(copied.ok).toBe(false);
    if (copied.ok) return;
    expect(copied.code).toBe('invalid_range');
  });

  it('复制含非文本节点 ⇒ contains_non_text=true（软换行/域被如实标记）', () => {
    const doc = document([paragraph('p1', [run('r1', 'abc'), field('f1', 'PAGE', '12345')])]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 0, end: 8 }]));
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.contains_non_text).toBe(true);
    expect(copied.value.text).toBe('abc12345');
  });
});

// ---------------------------------------------------------------------------
// §B 剪切
// ---------------------------------------------------------------------------

describe('§B 剪切：只删被选、段外不变、原子性', () => {
  it('剪 [1,3) ⇒ 正文变 "甲丁"，剪贴板文本 "乙丙"', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const cut = cutSelection(doc, selection(doc, [{ node_id: 'p1', start: 1, end: 3 }]));
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(textOf(cut.value.model)).toEqual(['甲丁']);
    expect(cut.value.clipboard.text).toBe('乙丙');
    expect(cut.value.appliedRanges).toEqual([{ node_id: 'p1', start: 1, end: 3 }]);
  });

  it('剪切只动被剪段：其它段落整块对象是同一引用', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙丙丁']]),
      paragraphOfRuns('p2', [['r2', '戊己庚辛']]),
    ]);
    const cut = cutSelection(doc, selection(doc, [{ node_id: 'p1', start: 1, end: 3 }]));
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.value.model.blocks[1]).toBe(doc.blocks[1]);
    expect(paragraphById(cut.value.model, 'p2').inlines).toBe(paragraphById(doc, 'p2').inlines);
  });

  it('原子性：第二个范围越界 ⇒ 第一个范围也不删（源文档零改动）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const cut = cutSelection(
      doc,
      selection(doc, [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p1', start: 0, end: 99 },
      ]),
    );
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('范围含域（不可切分）⇒ unsupported，源文档零改动', () => {
    const doc = document([paragraph('p1', [run('r1', 'abc'), field('f1', 'PAGE', '12345'), run('r3', 'xyz')])]);
    const cut = cutSelection(doc, selection(doc, [{ node_id: 'p1', start: 3, end: 8 }]));
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.code).toBe('unsupported');
    expect(textOf(doc)).toEqual(['abc12345xyz']);
  });

  it('多范围剪切：两处各自删除、文本正确', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', 'ABCDEF']])]);
    const cut = cutSelection(
      doc,
      selection(doc, [
        { node_id: 'p1', start: 0, end: 1 },
        { node_id: 'p1', start: 4, end: 6 },
      ]),
    );
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // 'ABCDEF'：删掉 A(0) 与 E(4),F(5) ⇒ 剩 B,C,D
    expect(textOf(cut.value.model)).toEqual(['BCD']);
  });

  it('零宽剪切 ⇒ empty_range（没有可剪的内容）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const cut = cutSelection(doc, selection(doc, [{ node_id: 'p1', start: 2, end: 2 }]));
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.code).toBe('empty_range');
  });
});

// ---------------------------------------------------------------------------
// §C 粘贴三模式
// ---------------------------------------------------------------------------

describe('§C 粘贴模式：keep-source / merge / plain-text 产出不同属性', () => {
  it('keep-source：粘贴内容保留源 run 属性（源 bold=on ⇒ 落地 bold=on）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const payload = payloadOf([run('s1', '乙丙', boldOn())]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'p1', start: 2, end: 2 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲乙乙丙丙丁']);
    expect(runWithText(pasted.value.model, 'p1', '乙丙')?.properties.bold.state).toBe('on');
  });

  it('merge：目标处显式 bold=off 覆盖源，源里目标未指定的 italic=on 保留', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙丙丁', runProperties({ bold: { state: 'off' } })]]),
    ]);
    const payload = payloadOf([run('s1', '乙丙', runProperties({ italic: { state: 'on' } }))]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'p1', start: 2, end: 2 }, 'merge-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    const inserted = runWithText(pasted.value.model, 'p1', '乙丙');
    expect(inserted?.properties.bold).toEqual({ state: 'off' });
    expect(inserted?.properties.italic).toEqual({ state: 'on' });
  });

  it('plain-text：丢弃域（droppedNonText=1），只留 run 文本且取目标格式', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙丙丁', runProperties({ bold: { state: 'off' } })]]),
    ]);
    const payload = payloadOf([run('s1', '乙丙', boldOn()), field('f1', 'PAGE', '12')]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'p1', start: 2, end: 2 }, 'plain-text');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.droppedNonText).toBe(1);
    expect(pasted.value.plainText).toBe('乙丙');
    const inserted = runWithText(pasted.value.model, 'p1', '乙丙');
    // 源是 bold=on，但纯文本取目标格式 ⇒ bold=off
    expect(inserted?.properties.bold).toEqual({ state: 'off' });
  });

  it('模式差异对照：同一源与目标，keep-source 与 plain-text 的加粗结果相反', () => {
    const dest = () =>
      document([paragraphOfRuns('p1', [['r1', '甲乙丙丁', boldOff()]])]);
    const payload = payloadOf([run('s1', '乙丙', boldOn())]);
    const kept = pasteClipboard(dest(), payload, { node_id: 'p1', start: 2, end: 2 }, 'keep-source-formatting');
    const plain = pasteClipboard(dest(), payload, { node_id: 'p1', start: 2, end: 2 }, 'plain-text');
    expect(kept.ok && plain.ok).toBe(true);
    if (!kept.ok || !plain.ok) return;
    expect(boldTexts(kept.value.model.blocks.flatMap((b) => (b.kind === 'paragraph' ? b.inlines : [])))).toContain('乙丙');
    expect(runWithText(plain.value.model, 'p1', '乙丙')?.properties.bold.state).toBe('off');
  });

  it('纯文本模式下全部为非文本节点 ⇒ empty_range（不写空内容假装成功）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const payload = payloadOf([field('f1', 'PAGE', '12')]);
    const pasted = pasteClipboard(doc, payload, { node_id: 'p1', start: 2, end: 2 }, 'plain-text');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('empty_range');
  });
});

// ---------------------------------------------------------------------------
// §D 粘贴目标精度与 fail-closed
// ---------------------------------------------------------------------------

describe('§D 粘贴：跨 run 精确替换、范围外不变', () => {
  it('替换 [2,6)（跨两个 run）⇒ 文本 "ABXGH"，范围外逐码位不变', () => {
    const doc = document([
      paragraphOfRuns('p1', [
        ['r1', 'ABCD'],
        ['r2', 'EFGH'],
      ]),
      paragraphOfRuns('p2', [['r9', '别动']]),
    ]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 2, end: 6 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('ABXGH');
    expect(pasted.value.replaced).toEqual({ node_id: 'p1', start: 2, end: 6 });
    expect(pasted.value.insertedRange).toEqual({ node_id: 'p1', start: 2, end: 3 });
    // 未触及的段落按引用保留
    expect(pasted.value.model.blocks[1]).toBe(doc.blocks[1]);
  });

  it('零宽插入 ⇒ replaced=null，insertedRange 长度=插入文本码位数', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'WXY')]), { node_id: 'p1', start: 2, end: 2 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.replaced).toBeNull();
    expect(pasted.value.insertedRange).toEqual({ node_id: 'p1', start: 2, end: 5 });
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('甲乙WXY丙丁');
  });

  it('反转目标 [3,1) ⇒ invalid_range，源文档零改动', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 3, end: 1 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('invalid_range');
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('目标越界 ⇒ invalid_range', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 0, end: 99 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('invalid_range');
  });

  it('目标段落不存在 ⇒ unknown_node', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'X')]), { node_id: 'nope', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('unknown_node');
  });

  it('空剪贴板（无段）⇒ empty_range', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(
      doc,
      { document_id: 'doc-1', paragraphs: [], text: '', contains_non_text: false },
      { node_id: 'p1', start: 0, end: 0 },
      'keep-source-formatting',
    );
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('empty_range');
  });

  it('空段剪贴板 ⇒ empty_range', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(
      doc,
      { document_id: 'doc-1', paragraphs: [{ inlines: [], whole_paragraph: false }], text: '', contains_non_text: false },
      { node_id: 'p1', start: 0, end: 0 },
      'keep-source-formatting',
    );
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('empty_range');
  });

  it('多段剪贴板 ⇒ 块级插入（W-I12）：首段并进头段、末段并进尾段，源文档零改动', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const before = paragraphText(paragraphById(doc, 'p1'));
    const multi: ClipboardPayload = {
      document_id: 'doc-1',
      paragraphs: [
        { inlines: [run('s1', '甲')], whole_paragraph: true },
        { inlines: [run('s2', '乙')], whole_paragraph: true },
      ],
      text: '甲\n乙',
      contains_non_text: false,
    };
    const pasted = pasteClipboard(doc, multi, { node_id: 'p1', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    // 目标段被拆成 头段（保留 id）/ 尾段（派生 id）：'甲' 并进头段、'乙' 并进尾段。
    expect(textOf(pasted.value.model)).toEqual(['甲', '乙甲乙丙丁']);
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('甲');
    expect(paragraphText(paragraphById(pasted.value.model, 'p1~b1'))).toBe('乙甲乙丙丁');
    // 无回归：源文档文本逐段不变（范围外的 '甲乙丙丁' 一字未改）。
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
    expect(paragraphText(paragraphById(doc, 'p1'))).toBe(before);
  });

  it('目标边界落在多码位域内部 ⇒ unsupported，源文档零改动', () => {
    const doc = document([paragraph('p1', [run('r1', 'abc'), field('f1', 'PAGE', '12345'), run('r3', 'xyz')])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 4, end: 6 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('unsupported');
    expect(textOf(doc)).toEqual(['abc12345xyz']);
  });

  it('plain-text / merge 粘进无 run 的空段 ⇒ unsupported（无目标格式基准）', () => {
    const doc = document([paragraph('p1', [])]);
    const src = payloadOf([run('s1', '甲')]);
    const plain = pasteClipboard(doc, src, { node_id: 'p1', start: 0, end: 0 }, 'plain-text');
    const merge = pasteClipboard(doc, src, { node_id: 'p1', start: 0, end: 0 }, 'merge-formatting');
    expect(plain.ok).toBe(false);
    expect(merge.ok).toBe(false);
    if (plain.ok || merge.ok) return;
    expect(plain.code).toBe('unsupported');
    expect(merge.code).toBe('unsupported');
  });

  it('keep-source 粘进无 run 的空段仍可（不需要目标格式）', () => {
    const doc = document([paragraph('p1', [])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', '甲', boldOn())]), { node_id: 'p1', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('甲');
    expect(runWithText(pasted.value.model, 'p1', '甲')?.properties.bold.state).toBe('on');
  });
});

// ---------------------------------------------------------------------------
// §E 反向对照与不变量
// ---------------------------------------------------------------------------

describe('§E 反向对照：邻位目标产出不同、粘贴不动 revision', () => {
  const base = () =>
    document([
      paragraphOfRuns('p1', [
        ['r1', 'Hello世界'],
        ['r2', 'wide中'],
      ]),
    ]);

  it('邻位目标 [4,6) 与 [5,7) 产出不同文本——偏移算错即红', () => {
    const a = pasteClipboard(base(), payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 4, end: 6 }, 'keep-source-formatting');
    const b = pasteClipboard(base(), payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 5, end: 7 }, 'keep-source-formatting');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(paragraphText(paragraphById(a.value.model, 'p1'))).toBe('HellX界wide中');
    expect(paragraphText(paragraphById(b.value.model, 'p1'))).toBe('HelloXwide中');
  });

  it('粘贴不递增 revision、不改 document_id（事务收口归 W10）', () => {
    const doc = base();
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'X')]), { node_id: 'p1', start: 0, end: 0 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.value.model.revision).toBe(doc.revision);
    expect(pasted.value.model.document_id).toBe(doc.document_id);
  });

  it('emoji 粘贴：文本可逐码位还原，无孤立代理项', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', `${GRIN}A${GRIN}B`)]), { node_id: 'p1', start: 2, end: 2 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    const inlines = paragraphById(pasted.value.model, 'p1').inlines;
    expect(inlines.every((node) => node.kind !== 'run' || !hasLoneSurrogate(node.text))).toBe(true);
    expect(points(paragraphText(paragraphById(pasted.value.model, 'p1'))).join('')).toBe(`甲乙${GRIN}A${GRIN}B丙丁`);
  });
});

// ---------------------------------------------------------------------------
// §F 纯文本粘贴
// ---------------------------------------------------------------------------

describe('§F pastePlainText', () => {
  it('单行纯文本 ⇒ 插入 run、取目标格式', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁', boldOff()]])]);
    const pasted = pastePlainText(doc, '文', { node_id: 'p1', start: 2, end: 2 });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('甲乙文丙丁');
    expect(runWithText(pasted.value.model, 'p1', '文')?.properties.bold).toEqual({ state: 'off' });
  });

  it('多行纯文本 ⇒ 块级插入（W-I12）：每行一段，源文档零改动', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pastePlainText(doc, '甲\n乙', { node_id: 'p1', start: 0, end: 0 });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    // '甲' 并进头段（保留 id），'乙' 并进尾段（派生 id 并接上范围外的 '甲乙丙丁'）。
    expect(textOf(pasted.value.model)).toEqual(['甲', '乙甲乙丙丁']);
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('甲');
    // 无回归：源文档文本逐段不变（范围外的 '甲乙丙丁' 未被改写）。
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('空文本 ⇒ empty_range', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pastePlainText(doc, '', { node_id: 'p1', start: 0, end: 0 });
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('empty_range');
  });

  it('粘进无 run 的空段 ⇒ unsupported', () => {
    const doc = document([paragraph('p1', [])]);
    const pasted = pastePlainText(doc, '甲', { node_id: 'p1', start: 0, end: 0 });
    expect(pasted.ok).toBe(false);
    if (pasted.ok) return;
    expect(pasted.code).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// §G 复制→粘贴 往返
// ---------------------------------------------------------------------------

describe('§G 复制/剪切 → 粘贴往返', () => {
  it('复制 [1,3) 再粘到别处 ⇒ 目标文本含被复制片段，源段不变', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙丙丁']]),
      paragraphOfRuns('p2', [['r2', '戊己庚辛']]),
    ]);
    const copied = copySelection(doc, selection(doc, [{ node_id: 'p1', start: 1, end: 3 }]));
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const pasted = pasteClipboard(doc, copied.value, { node_id: 'p2', start: 4, end: 4 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(paragraphText(paragraphById(pasted.value.model, 'p2'))).toBe('戊己庚辛乙丙');
    expect(paragraphText(paragraphById(pasted.value.model, 'p1'))).toBe('甲乙丙丁');
  });

  it('剪切 → 粘回原位 ⇒ 文本还原（cut+paste 往返恒等）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const cut = cutSelection(doc, selection(doc, [{ node_id: 'p1', start: 1, end: 3 }]));
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(textOf(cut.value.model)).toEqual(['甲丁']);
    const pasted = pasteClipboard(cut.value.model, cut.value.clipboard, { node_id: 'p1', start: 1, end: 1 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(textOf(pasted.value.model)).toEqual(['甲乙丙丁']);
  });

  it('剪切回执带 replacedFragment：粘贴替换后被替换的原片段可读出（撤销用）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const pasted = pasteClipboard(doc, payloadOf([run('s1', 'XY')]), { node_id: 'p1', start: 1, end: 3 }, 'keep-source-formatting');
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(inlineText(pasted.value.replacedFragment)).toBe('乙丙');
  });
});
