/**
 * F03 验收：列表筛选、搜索、按最近活跃排序。
 *
 * 每条断言都追溯到真实语义：归档只影响「是否出现在主列表」，不改变集合成员；
 * 排序是纯比较、确定性三级 tie-break；搜索命中的是**标题或内容片段**。
 */

import { describe, expect, it } from 'vitest';

import {
  createConversation,
  listConversations,
  searchConversations,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { IDS, seed } from './fixtures.js';

function idsOf(views: readonly { id: string }[]): string[] {
  return views.map((view) => view.id);
}

describe('F03 / 列表筛选（默认 active，归档不混入主列表）', () => {
  it('默认只列 active，归档项不在其中', () => {
    const state = seed();
    const listed = idsOf(listConversations(state));
    expect(listed).toEqual([IDS.expense, IDS.weekly, IDS.pitch]);
    expect(listed).not.toContain(IDS.archived);
  });

  it("status='archived' 只列归档项；status='all' 列全部（归档仍在，I1）", () => {
    const state = seed();
    expect(idsOf(listConversations(state, { status: 'archived' }))).toEqual([IDS.archived]);
    expect(idsOf(listConversations(state, { status: 'all' }))).toEqual([
      IDS.expense,
      IDS.weekly,
      IDS.pitch,
      IDS.archived,
    ]);
  });
});

describe('F03 / 排序（最近活跃降序）', () => {
  it('按 lastActiveAt 降序', () => {
    const state = seed();
    expect(idsOf(listConversations(state, { status: 'all' }))).toEqual([
      IDS.expense,
      IDS.weekly,
      IDS.pitch,
      IDS.archived,
    ]);
  });

  it('时间相同时按创建序号降序（后建者在前），保证顺序确定', () => {
    let state = seed();
    state = createConversation(state, {
      id: 'conv-tie-old',
      title: '同刻甲',
      lastActiveAt: '2026-10-03T12:00:00Z',
      select: false,
    });
    state = createConversation(state, {
      id: 'conv-tie-new',
      title: '同刻乙',
      lastActiveAt: '2026-10-03T12:00:00Z',
      select: false,
    });
    const listed = idsOf(listConversations(state));
    // 两者时间相同，seq 更大（后创建）的 conv-tie-new 应在前。
    expect(listed.slice(0, 2)).toEqual(['conv-tie-new', 'conv-tie-old']);
  });
});

describe('F03 / 搜索（标题或内容片段）', () => {
  it('命中标题', () => {
    const state = seed();
    expect(idsOf(searchConversations(state, '报销'))).toEqual([IDS.expense]);
  });

  it('命中内容片段（snippet）', () => {
    const state = seed();
    // '路演' 只出现在 pitch 的 snippet 里，不在标题「PPT 路演」之外的其他项。
    expect(idsOf(searchConversations(state, '大纲'))).toEqual([IDS.pitch]);
  });

  it('忽略大小写与首尾空白', () => {
    const state = seed();
    expect(idsOf(searchConversations(state, '  excel  '))).toEqual([IDS.expense]);
  });

  it('空白查询不过滤（等同于列表）', () => {
    const state = seed();
    expect(idsOf(searchConversations(state, '   '))).toEqual(idsOf(listConversations(state)));
  });

  it('无命中返回空数组（不编造结果）', () => {
    const state = seed();
    expect(searchConversations(state, '不存在的关键字')).toEqual([]);
  });

  it("搜索默认不含归档；status='all' 时才含（归档≠删除）", () => {
    const state = seed();
    expect(searchConversations(state, '季度')).toEqual([]);
    expect(idsOf(searchConversations(state, '季度', { status: 'all' }))).toEqual([IDS.archived]);
  });
});
