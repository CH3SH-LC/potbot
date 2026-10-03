/**
 * 批注单测（WF-077）。
 *
 * 判据：**锚定正确**——同一段里两处相同文字，批注锚在**指定的那一处**。
 */

import { describe, expect, it } from 'vitest';

import { document, paragraphOfRuns } from '../selection/testing.js';
import { addComment, addReply, anchorByText, deleteComment, readComments, resolveComment } from './comments.js';
import { emptyReviewIndex } from './types.js';

const doc = document([paragraphOfRuns('p1', [['r1', 'ABABAB']]), paragraphOfRuns('p2', [['r2', '别处']])]);

describe('anchorByText —— 同名多处按序号锚定', () => {
  it('第 2 处 "AB" ⇒ 码位 [2,4)', () => {
    const range = anchorByText(doc, { paragraph_id: 'p1', text: 'AB', occurrence: 2 });
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(range.value).toEqual({ node_id: 'p1', start: 2, end: 4 });
  });

  it('默认取第 1 处', () => {
    const range = anchorByText(doc, { paragraph_id: 'p1', text: 'AB' });
    expect(range.ok && range.value).toEqual({ node_id: 'p1', start: 0, end: 2 });
  });

  it('超出命中数 ⇒ not_found 且带实际命中数', () => {
    const range = anchorByText(doc, { paragraph_id: 'p1', text: 'AB', occurrence: 4 });
    expect(range.ok).toBe(false);
    if (!range.ok) {
      expect(range.code).toBe('not_found');
      expect(range.detail.hitCount).toBe(3);
    }
  });

  it('段落不存在 ⇒ unknown_node', () => {
    const range = anchorByText(doc, { paragraph_id: 'ghost', text: 'AB' });
    expect(range.ok).toBe(false);
    if (!range.ok) expect(range.code).toBe('unknown_node');
  });
});

describe('addComment / readComments', () => {
  it('批注锚在指定那一处，读回文字正确', () => {
    const anchor = anchorByText(doc, { paragraph_id: 'p1', text: 'AB', occurrence: 2 });
    if (!anchor.ok) throw new Error('setup');

    const added = addComment(doc, { author: '诚哥', text: '这里要改', anchor: anchor.value });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const comment = added.value.comments[0];
    expect(comment?.anchor).toEqual({ node_id: 'p1', start: 2, end: 4 });

    const views = readComments(added.value);
    expect(views).toHaveLength(1);
    expect(views[0]?.anchored_text).toBe('AB');
    expect(views[0]?.anchor_valid).toBe(true);
  });

  it('锚点越界 ⇒ invalid_range（不落盘）', () => {
    const bad = addComment(doc, { author: 'a', text: 'x', anchor: { node_id: 'p1', start: 0, end: 99 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_range');
  });

  it('锚点段落不存在 ⇒ unknown_node', () => {
    const bad = addComment(doc, { author: 'a', text: 'x', anchor: { node_id: 'ghost', start: 0, end: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('unknown_node');
  });
});

describe('回复 / 解决 / 删除', () => {
  function withComment() {
    const anchor = anchorByText(doc, { paragraph_id: 'p1', text: 'AB' });
    if (!anchor.ok) throw new Error('setup');
    const added = addComment(doc, { author: '诚哥', text: '主批注', anchor: anchor.value });
    if (!added.ok) throw new Error('setup');
    const commentId = added.value.comments[0]?.id;
    if (commentId === undefined) throw new Error('setup');
    return { model: added.value, commentId };
  }

  it('回复归入同一线程', () => {
    const { commentId } = withComment();
    let index = emptyReviewIndex();
    const first = addReply(index, { comment_id: commentId, author: '浅雪', text: '我看看', date: '2026-10-03T00:00:00Z' });
    if (!first.ok) throw new Error('setup');
    index = first.value;
    const second = addReply(index, { comment_id: commentId, author: '诚哥', text: '好', date: '2026-10-03T00:01:00Z' });
    if (!second.ok) throw new Error('setup');
    expect(second.value.threads).toHaveLength(1);
    expect(second.value.threads[0]?.replies).toHaveLength(2);
  });

  it('解决 ≠ 删除：解决后批注仍在模型里', () => {
    const { model, commentId } = withComment();
    const resolved = resolveComment(emptyReviewIndex(), commentId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.threads[0]?.resolved).toBe(true);
    expect(model.comments).toHaveLength(1);
  });

  it('删除批注：模型与线程一并移除', () => {
    const { model, commentId } = withComment();
    let index = emptyReviewIndex();
    const replied = addReply(index, { comment_id: commentId, author: 'x', text: 'y', date: 'z' });
    if (!replied.ok) throw new Error('setup');
    index = replied.value;

    const deleted = deleteComment(model, index, commentId);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value.model.comments).toHaveLength(0);
    expect(deleted.value.index.threads).toHaveLength(0);
  });

  it('删除不存在的批注 ⇒ not_found', () => {
    const { model } = withComment();
    const deleted = deleteComment(model, emptyReviewIndex(), 'nope');
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.code).toBe('not_found');
  });
});
