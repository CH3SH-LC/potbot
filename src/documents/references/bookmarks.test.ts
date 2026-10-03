/**
 * 书签单测（WF-071）：添加 / 定位 / 重命名 / 删除 / 取文。
 */

import { describe, expect, it } from 'vitest';

import { document, paragraphOfRuns } from '../selection/testing.js';
import {
  addBookmark,
  bookmarkText,
  locateBookmark,
  removeBookmark,
  renameBookmark,
} from './bookmarks.js';
import { emptyReferenceIndex } from './types.js';

const doc = document([paragraphOfRuns('p1', [['r1', '第一章 总则']]), paragraphOfRuns('p2', [['r2', '正文']])]);

function withOne() {
  const added = addBookmark(emptyReferenceIndex(), {
    id: 'bm1',
    name: '总则',
    range: { node_id: 'p1', start: 4, end: 6 },
  });
  if (!added.ok) throw new Error('setup failed');
  return added.value;
}

describe('书签（WF-071）', () => {
  it('添加后可按名定位，取出正确文字', () => {
    const index = withOne();
    const located = locateBookmark(index, '总则');
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    expect(located.value.range).toEqual({ node_id: 'p1', start: 4, end: 6 });

    const text = bookmarkText(doc, located.value);
    expect(text.ok && text.value).toBe('总则');
  });

  it('重名书签被拒绝（引用会指错）', () => {
    const index = withOne();
    const again = addBookmark(index, { id: 'bm2', name: '总则', range: { node_id: 'p2', start: 0, end: 1 } });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('precondition');
  });

  it('空名字被拒绝', () => {
    const bad = addBookmark(emptyReferenceIndex(), { id: 'x', name: '   ', range: { node_id: 'p1', start: 0, end: 1 } });
    expect(bad.ok).toBe(false);
  });

  it('定位不存在的书签 ⇒ not_found', () => {
    const missing = locateBookmark(withOne(), '不存在');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
  });

  it('重命名（新名唯一）后按新名可定位、旧名失效', () => {
    const renamed = renameBookmark(withOne(), 'bm1', '通则');
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(locateBookmark(renamed.value, '通则').ok).toBe(true);
    expect(locateBookmark(renamed.value, '总则').ok).toBe(false);
  });

  it('重命名撞到已有名字 ⇒ 拒绝', () => {
    let index = withOne();
    const second = addBookmark(index, { id: 'bm2', name: '正文', range: { node_id: 'p2', start: 0, end: 2 } });
    if (!second.ok) throw new Error('setup');
    index = second.value;
    const clash = renameBookmark(index, 'bm1', '正文');
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe('precondition');
  });

  it('删除后定位 ⇒ not_found', () => {
    const removed = removeBookmark(withOne(), 'bm1');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(locateBookmark(removed.value, '总则').ok).toBe(false);
  });
});
