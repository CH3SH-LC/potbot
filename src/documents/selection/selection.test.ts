/**
 * 选区生命周期与取文单测（R103/R114/R143；WF-088）。
 *
 * R114 的判据在这里落成硬断言：**选区随 revision 失效**，且反馈里必须带上当前 revision——
 * "把旧偏移硬套到新文本上"这条路径要在测试里被堵死。
 */

import { describe, expect, it } from 'vitest';

import {
  expandToParagraph,
  expandToSentence,
  expandToWord,
  paragraphSpanSelection,
  tableCellSelection,
  wholeDocumentSelection,
} from './expand.js';
import {
  createSelection,
  extractSelectionText,
  isSelectionCurrent,
  requireCurrentSelection,
  validateRanges,
} from './selection.js';
import {
  cell,
  document,
  paragraphOfRuns,
  row,
  table,
} from './testing.js';

const doc = document([
  paragraphOfRuns('p1', [['r1', '今天天气很好。明天也不错。']]),
  paragraphOfRuns('p2', [['r2', '第二段']]),
  table('t1', [row('row1', [cell('c1', [paragraphOfRuns('p3', [['r3', '格子里']])])])]),
]);

describe('选区与 revision（R114/R143）', () => {
  it('同版本 ⇒ 当前有效', () => {
    const selection = createSelection('doc-1', 1, [{ node_id: 'p1', start: 0, end: 2 }]);
    expect(isSelectionCurrent(selection, doc)).toBe(true);
    expect(requireCurrentSelection(selection, doc).ok).toBe(true);
  });

  it('revision 变了 ⇒ stale_revision，反馈带当前与请求版本', () => {
    const selection = createSelection('doc-1', 1, [{ node_id: 'p1', start: 0, end: 2 }]);
    const newer = { ...doc, revision: 2 };
    expect(isSelectionCurrent(selection, newer)).toBe(false);

    const checked = requireCurrentSelection(selection, newer);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe('stale_revision');
    expect(checked.detail.currentRevision).toBe(2);
    expect(checked.detail.requestedRevision).toBe(1);
  });

  it('文档不符 ⇒ mismatched_document', () => {
    const selection = createSelection('other-doc', 1, [{ node_id: 'p1', start: 0, end: 2 }]);
    const checked = requireCurrentSelection(selection, doc);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe('mismatched_document');
  });

  it('范围内校验：越界与未知节点都要报出来', () => {
    const bad = validateRanges(doc, [{ node_id: 'p1', start: 0, end: 99 }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_range');

    const unknown = validateRanges(doc, [{ node_id: 'nope', start: 0, end: 1 }]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('unknown_node');
  });

  it('失效选区不得取文（先过 R114 闸门）', () => {
    const stale = createSelection('doc-1', 0, [{ node_id: 'p1', start: 0, end: 2 }]);
    const text = extractSelectionText(doc, stale);
    expect(text.ok).toBe(false);
    if (text.ok) return;
    expect(text.code).toBe('stale_revision');
  });
});

describe('extractSelectionText —— WF-088 复制', () => {
  it('单段取文不折叠空白', () => {
    const selection = createSelection('doc-1', 1, [{ node_id: 'p1', start: 2, end: 6 }]);
    const text = extractSelectionText(doc, selection);
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.value).toBe('天气很好');
  });

  it('多段之间用换行连接', () => {
    const selection = createSelection('doc-1', 1, [
      { node_id: 'p1', start: 0, end: 2 },
      { node_id: 'p2', start: 0, end: 3 },
    ]);
    const text = extractSelectionText(doc, selection);
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.value).toBe('今天\n第二段');
  });
});

describe('选区扩展（WF-088：字词 / 句 / 段 / 多段 / 全文 / 单元格）', () => {
  it('扩到词：汉字取单字，ASCII 连成一词', () => {
    const word = expandToWord(doc, { node_id: 'p1', start: 2, end: 3 });
    expect(word.ok && word.value).toEqual({ node_id: 'p1', start: 2, end: 3 });
  });

  it('扩到词：英文单词整段选中', () => {
    const latin = document([paragraphOfRuns('q1', [['x', 'a concatenate b']])]);
    const word = expandToWord(latin, { node_id: 'q1', start: 5, end: 6 });
    expect(word.ok && word.value).toEqual({ node_id: 'q1', start: 2, end: 13 });
  });

  it('扩到句：包含句末标点', () => {
    const sentence = expandToSentence(doc, { node_id: 'p1', start: 3, end: 4 });
    expect(sentence.ok && sentence.value).toEqual({ node_id: 'p1', start: 0, end: 7 });
  });

  it('扩到段：整段范围', () => {
    const paragraph = expandToParagraph(doc, { node_id: 'p1', start: 3, end: 4 });
    // '今天天气很好。明天也不错。' = 13 个码位
    expect(paragraph.ok && paragraph.value).toEqual({ node_id: 'p1', start: 0, end: 13 });
  });

  it('全文与多段选区', () => {
    const all = wholeDocumentSelection(doc);
    expect(all.base_revision).toBe(doc.revision);
    expect(all.ranges.map((range) => range.node_id)).toEqual(['p1', 'p2', 'p3']);

    const span = paragraphSpanSelection(doc, 1, 2);
    expect(span.ok).toBe(true);
    if (!span.ok) return;
    expect(span.value.ranges.map((range) => range.node_id)).toEqual(['p1', 'p2']);

    const outOfRange = paragraphSpanSelection(doc, 1, 99);
    expect(outOfRange.ok).toBe(false);
  });

  it('表格单元格选区', () => {
    const chosen = tableCellSelection(doc, 1, 1, 1);
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.value.ranges).toEqual([{ node_id: 'p3', start: 0, end: 3 }]);
  });
});
