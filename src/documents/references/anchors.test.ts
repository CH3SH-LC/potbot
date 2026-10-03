/**
 * 锚点偏移传播单测（判据：**书签范围不漂移**）。
 *
 * 核心断言：在书签**之前**插入文字后，书签仍指向**原来那段文字**（不是原偏移）。
 * 这既测纯函数 `shiftAnchor`，也测端到端 `insertText`（改正文 + 同步平移一次完成）。
 */

import { describe, expect, it } from 'vitest';

import { document, paragraphOfRuns } from '../selection/testing.js';
import { insertText, deleteText, shiftAnchor, shiftReferenceIndex } from './anchors.js';
import { addBookmark, bookmarkText, locateBookmark } from './bookmarks.js';
import { emptyReferenceIndex } from './types.js';

const doc = document([paragraphOfRuns('p1', [['r1', 'ABCDEF']])]);

describe('shiftAnchor —— 纯偏移平移', () => {
  it('在书签前插入 ⇒ 整段右移，仍覆盖原文字', () => {
    const shifted = shiftAnchor({ node_id: 'p1', start: 2, end: 5 }, { node_id: 'p1', at: 0, inserted: 2, removed: 0 });
    expect(shifted).toEqual({ range: { node_id: 'p1', start: 4, end: 7 }, intact: true });
  });

  it('在书签后插入 ⇒ 不动', () => {
    const shifted = shiftAnchor({ node_id: 'p1', start: 2, end: 5 }, { node_id: 'p1', at: 6, inserted: 3, removed: 0 });
    expect(shifted.range).toEqual({ node_id: 'p1', start: 2, end: 5 });
  });

  it('在书签内部插入 ⇒ 书签变长（包含新字）', () => {
    const shifted = shiftAnchor({ node_id: 'p1', start: 2, end: 5 }, { node_id: 'p1', at: 3, inserted: 2, removed: 0 });
    expect(shifted.range).toEqual({ node_id: 'p1', start: 2, end: 7 });
  });

  it('删除书签前的文字 ⇒ 左移', () => {
    const shifted = shiftAnchor({ node_id: 'p1', start: 3, end: 5 }, { node_id: 'p1', at: 0, inserted: 0, removed: 2 });
    expect(shifted.range).toEqual({ node_id: 'p1', start: 1, end: 3 });
  });

  it('整段被删 ⇒ intact:false 且收拢为零长度（不静默丢弃）', () => {
    const shifted = shiftAnchor({ node_id: 'p1', start: 2, end: 5 }, { node_id: 'p1', at: 1, inserted: 0, removed: 5 });
    expect(shifted.intact).toBe(false);
    expect(shifted.range).toEqual({ node_id: 'p1', start: 1, end: 1 });
  });

  it('零长度锚点（脚注标记）在插入点上 ⇒ 整体平移', () => {
    const shifted = shiftAnchor({ node_id: 'p1', start: 4, end: 4 }, { node_id: 'p1', at: 4, inserted: 1, removed: 0 });
    expect(shifted.range).toEqual({ node_id: 'p1', start: 5, end: 5 });
  });
});

describe('insertText —— 改正文 + 同步平移（判据）', () => {
  it('书签前插字后，书签仍指向原来那段文字（不是原偏移）', () => {
    const withBookmark = addBookmark(emptyReferenceIndex(), {
      id: 'bm1',
      name: '要点',
      range: { node_id: 'p1', start: 2, end: 5 },
    });
    expect(withBookmark.ok).toBe(true);
    if (!withBookmark.ok) return;

    const result = insertText(withBookmark.value, doc, { node_id: 'p1', offset: 0, text: 'XY' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 正文确实变了
    const paragraph = result.value.model.blocks[0];
    if (paragraph?.kind !== 'paragraph') throw new Error('setup');
    const newText = paragraph.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '')).join('');
    expect(newText).toBe('XYABCDEF');

    // 书签平移到了 [4,7)——原偏移仍是 [2,5)，但 4..7 才是 'CDE'
    const bookmark = locateBookmark(result.value.index, '要点');
    expect(bookmark.ok).toBe(true);
    if (!bookmark.ok) return;
    expect(bookmark.value.range).toEqual({ node_id: 'p1', start: 4, end: 7 });

    const text = bookmarkText(result.value.model, bookmark.value);
    expect(text.ok && text.value).toBe('CDE');
  });
});

describe('shiftReferenceIndex —— 跨段落不误伤', () => {
  it('只平移同段落锚点', () => {
    let index = addBookmark(emptyReferenceIndex(), { id: 'a', name: 'a', range: { node_id: 'p1', start: 0, end: 2 } });
    if (!index.ok) throw new Error('setup');
    const withOther = addBookmark(index.value, { id: 'b', name: 'b', range: { node_id: 'p2', start: 0, end: 2 } });
    if (!withOther.ok) throw new Error('setup');

    const shifted = shiftReferenceIndex(withOther.value, { node_id: 'p1', at: 0, inserted: 1, removed: 0 });
    expect(shifted.bookmarks.find((b) => b.id === 'a')?.range.start).toBe(1);
    expect(shifted.bookmarks.find((b) => b.id === 'b')?.range.start).toBe(0);
  });
});

describe('deleteText —— 被删的书签标记为失效', () => {
  it('删掉书签文字 ⇒ 记录仍在但 intact:false，定位返回 not_found', () => {
    const added = addBookmark(emptyReferenceIndex(), { id: 'bm', name: '没了', range: { node_id: 'p1', start: 2, end: 5 } });
    if (!added.ok) throw new Error('setup');

    const result = deleteText(added.value, doc, { node_id: 'p1', start: 0, end: 6 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bookmark = result.value.index.bookmarks[0];
    expect(bookmark?.intact).toBe(false);

    const located = locateBookmark(result.value.index, '没了');
    expect(located.ok).toBe(false);
    if (!located.ok) expect(located.code).toBe('not_found');
  });
});
