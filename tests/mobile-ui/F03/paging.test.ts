/**
 * F03 验收：历史分页与定位。
 *
 * 反向对照（负例）：
 *   - offset 超过总条数 ⇒ `page-out-of-range`（不是静默返回空页）；
 *   - offset/limit 非法（负数、非整数、limit<1）⇒ `invalid-page-request`。
 * offset === total 是**合法边界**（返回空页），与越界区分开——这正是判据不是在空转的证据。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationError,
  locateConversation,
  pageConversations,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { IDS, seed } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  throw new Error('预期抛 ConversationError，但没有抛');
}

describe('F03 / 分页', () => {
  it('首页：offset 0 / limit 2 取最近两条，hasMore 正确', () => {
    const state = seed();
    const page = pageConversations(state, { offset: 0, limit: 2 });
    expect(page.items.map((v) => v.id)).toEqual([IDS.expense, IDS.weekly]);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(2);
  });

  it('末页：剩下不足一页时 hasMore=false', () => {
    const state = seed();
    const page = pageConversations(state, { offset: 2, limit: 2 });
    expect(page.items.map((v) => v.id)).toEqual([IDS.pitch]);
    expect(page.hasMore).toBe(false);
  });

  it('offset===total 是合法边界：返回空页而非报错', () => {
    const state = seed();
    const page = pageConversations(state, { offset: 3, limit: 2 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  it('空列表 offset 0 合法', () => {
    const empty = { conversations: [], indexById: {}, selectedId: null, counter: 0 };
    const page = pageConversations(empty, { offset: 0, limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('分页遵循筛选：归档页单独分页', () => {
    const state = seed();
    const page = pageConversations(state, { offset: 0, limit: 10 }, { status: 'archived' });
    expect(page.items.map((v) => v.id)).toEqual([IDS.archived]);
    expect(page.total).toBe(1);
  });
});

describe('F03 / 分页反向对照（负例必须报错）', () => {
  it('offset 超过总条数 ⇒ page-out-of-range', () => {
    const state = seed();
    expect(codeOf(() => pageConversations(state, { offset: 4, limit: 2 }))).toBe('page-out-of-range');
  });

  it('空列表 offset 1 ⇒ page-out-of-range（0 合法、1 越界）', () => {
    const empty = { conversations: [], indexById: {}, selectedId: null, counter: 0 };
    expect(codeOf(() => pageConversations(empty, { offset: 1, limit: 10 }))).toBe('page-out-of-range');
  });

  it('offset 负数 / 非整数 ⇒ invalid-page-request', () => {
    const state = seed();
    expect(codeOf(() => pageConversations(state, { offset: -1, limit: 2 }))).toBe('invalid-page-request');
    expect(codeOf(() => pageConversations(state, { offset: 1.5, limit: 2 }))).toBe('invalid-page-request');
  });

  it('limit < 1 或非整数 ⇒ invalid-page-request', () => {
    const state = seed();
    expect(codeOf(() => pageConversations(state, { offset: 0, limit: 0 }))).toBe('invalid-page-request');
    expect(codeOf(() => pageConversations(state, { offset: 0, limit: -3 }))).toBe('invalid-page-request');
    expect(codeOf(() => pageConversations(state, { offset: 0, limit: 2.25 }))).toBe('invalid-page-request');
  });
});

describe('F03 / 定位（返回列表恢复滚动位置）', () => {
  it('返回所在页与页内锚点', () => {
    const state = seed();
    // 排序后序列：expense(0) weekly(1) pitch(2)；limit 2 ⇒ weekly 在第 0 页。
    const loc = locateConversation(state, IDS.weekly, { offset: 0, limit: 2 });
    expect(loc).toEqual({
      conversationId: IDS.weekly,
      index: 1,
      pageIndex: 0,
      offset: 0,
      limit: 2,
    });
  });

  it('第三项在第二页', () => {
    const state = seed();
    const loc = locateConversation(state, IDS.pitch, { offset: 0, limit: 2 });
    expect(loc?.pageIndex).toBe(1);
    expect(loc?.offset).toBe(2);
  });

  it('不在当前筛选范围内（归档项/已删除/不存在）⇒ null，不编造位置', () => {
    const state = seed();
    expect(locateConversation(state, IDS.archived, { offset: 0, limit: 2 })).toBeNull();
    expect(locateConversation(state, 'conv-missing', { offset: 0, limit: 2 })).toBeNull();
  });
});
