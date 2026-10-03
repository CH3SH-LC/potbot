/**
 * K04 独立验证 ②：**分页 / 搜索 / 事件续取游标**。
 *
 * 判据：分页按 `seq` 升序、`total` 是过滤后命中数、`has_more` 与页边界一致；
 * 搜索大小写不敏感、可跨会话、可限定会话；`eventsSince` **严格大于**游标（不重放已消费项）。
 */

import { describe, expect, it } from 'vitest';

import { MobileConversationStore } from '../../../apps/mobile-kernel/conversation/index.js';

import { CONV_A, CONV_B, fixedClock, seqIds } from './fixtures.js';

function newStore(): MobileConversationStore {
  return new MobileConversationStore({
    now: fixedClock('2026-10-03T00:00:00.000Z'),
    makeId: seqIds(),
  });
}

function seed(store: MobileConversationStore, conversationId: string, texts: readonly string[]): void {
  store.createConversation({ conversationId });
  texts.forEach((text, index) => {
    store.send({ conversationId, clientId: `${conversationId}-c-${String(index)}`, text });
  });
}

describe('K04-② 消息分页', () => {
  it('按 seq 升序分页，total/has_more 正确', () => {
    const store = newStore();
    seed(store, CONV_A, ['一', '二', '三', '四', '五']);

    const page1 = store.listMessages(CONV_A, { page: 1, pageSize: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items.map((m) => m.seq)).toEqual([1, 2]);
    expect(page1.value.total).toBe(5);
    expect(page1.value.has_more).toBe(true);

    const page3 = store.listMessages(CONV_A, { page: 3, pageSize: 2 });
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.value.items.map((m) => m.seq)).toEqual([5]);
    expect(page3.value.has_more).toBe(false);
  });

  it('超出末页的页码被夹到末页（不返回空页当"没有"）', () => {
    const store = newStore();
    seed(store, CONV_A, ['一', '二', '三']);
    const page = store.listMessages(CONV_A, { page: 99, pageSize: 2 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.page).toBe(2);
    expect(page.value.items.map((m) => m.seq)).toEqual([3]);
  });

  it('不存在的会话 ⇒ conversation_not_found', () => {
    const store = newStore();
    const page = store.listMessages('conv-x');
    expect(page.ok).toBe(false);
    if (!page.ok) expect(page.error.code).toBe('conversation_not_found');
  });
});

describe('K04-② 消息搜索', () => {
  it('大小写不敏感，可跨会话', () => {
    const store = newStore();
    seed(store, CONV_A, ['Hello World', '再见']);
    seed(store, CONV_B, ['say hello now']);

    const hits = store.searchMessages({ query: 'hello' });
    expect(hits.length).toBe(2);
    expect(hits.every((hit) => hit.text.toLowerCase().includes('hello'))).toBe(true);
    expect(new Set(hits.map((hit) => hit.conversationId))).toEqual(new Set([CONV_A, CONV_B]));
  });

  it('限定会话时只搜该会话', () => {
    const store = newStore();
    seed(store, CONV_A, ['a-keyword']);
    seed(store, CONV_B, ['b-keyword']);
    const hits = store.searchMessages({ query: 'keyword', conversationId: CONV_B });
    expect(hits.map((hit) => hit.conversationId)).toEqual([CONV_B]);
  });

  it('空查询 = 不过滤（返回全部命中，受分页约束）', () => {
    const store = newStore();
    seed(store, CONV_A, ['一', '二', '三']);
    const hits = store.searchMessages({ query: '', page: 1, pageSize: 2 });
    expect(hits.length).toBe(2);
  });
});

describe('K04-② 事件续取游标', () => {
  it('eventsSince 严格大于游标，不重放已消费项', () => {
    const store = newStore();
    seed(store, CONV_A, ['一', '二']);
    const all = store.eventsSince(CONV_A, 0);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.map((e) => e.seq)).toEqual([1, 2]);

    const rest = store.eventsSince(CONV_A, 1);
    expect(rest.ok).toBe(true);
    if (!rest.ok) return;
    expect(rest.value.map((e) => e.seq)).toEqual([2]);

    const none = store.eventsSince(CONV_A, 2);
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.value.length).toBe(0);
  });
});
