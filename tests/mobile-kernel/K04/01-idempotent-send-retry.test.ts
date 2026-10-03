/**
 * K04 独立验证 ①：**幂等发送**与**重试不重复建任务**。
 *
 * 判据（不靠实现自证）：同一 `clientId` 重发后，消息**条数**与事件**条数**都不得增长，
 * 返回的必须是**同一条**消息对象；重试必须复用同一条消息与同一个 `clientId`，
 * 只把 `attempts` 增一，且**不**新建消息。
 */

import { describe, expect, it } from 'vitest';

import { MobileConversationStore } from '../../../apps/mobile-kernel/conversation/index.js';

import { CONV_A, fixedClock, seqIds } from './fixtures.js';

function newStore(): MobileConversationStore {
  return new MobileConversationStore({
    now: fixedClock('2026-10-03T00:00:00.000Z'),
    makeId: seqIds(),
  });
}

describe('K04-① 幂等发送', () => {
  it('同一 clientId 重发返回原消息且不起第二次执行，消息/事件条数不增长', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A, title: '甲' });

    const first = store.send({ conversationId: CONV_A, clientId: 'c-1', text: '你好', at: '2026-10-03T00:00:01.000Z' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.duplicate).toBe(false);
    expect(first.value.started).toBe(true);

    const before = store.getConversation(CONV_A);
    expect(before?.messages.length).toBe(1);
    expect(before?.events.length).toBe(1);

    const second = store.send({ conversationId: CONV_A, clientId: 'c-1', text: '你好（重发）', at: '2026-10-03T00:00:02.000Z' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.duplicate).toBe(true);
    expect(second.value.started).toBe(false);
    // 必须是**同一条**消息（含同 messageId 与同 seq），而不是"又记了一条"。
    expect(second.value.message.messageId).toBe(first.value.message.messageId);
    expect(second.value.message.seq).toBe(first.value.message.seq);
    // 重发不再吸收正文（原消息的正文保持不变）。
    expect(second.value.message.text).toBe('你好');

    const after = store.getConversation(CONV_A);
    expect(after?.messages.length).toBe(1);
    expect(after?.events.length).toBe(1);
  });

  it('不同 clientId 是两条不同消息，seq 单调递增', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A });
    store.send({ conversationId: CONV_A, clientId: 'c-1', text: '一' });
    store.send({ conversationId: CONV_A, clientId: 'c-2', text: '二' });
    const record = store.getConversation(CONV_A);
    expect(record?.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('空正文 / 空幂等键被拒，且不落任何消息', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A });
    const emptyText = store.send({ conversationId: CONV_A, clientId: 'c-1', text: '   ' });
    expect(emptyText.ok).toBe(false);
    if (!emptyText.ok) expect(emptyText.error.code).toBe('invalid_input');
    const emptyKey = store.send({ conversationId: CONV_A, clientId: '', text: '嗨' });
    expect(emptyKey.ok).toBe(false);
    if (!emptyKey.ok) expect(emptyKey.error.code).toBe('invalid_input');
    expect(store.getConversation(CONV_A)?.messages.length).toBe(0);
  });

  it('发给不存在的会话 ⇒ conversation_not_found（不静默建会话）', () => {
    const store = newStore();
    const result = store.send({ conversationId: 'conv-x', clientId: 'c-1', text: '嗨' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conversation_not_found');
  });
});

describe('K04-① 重试', () => {
  it('失败的 user 消息可重试：复用同一条消息与同一 clientId，attempts+1，不新增消息', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A });
    const sent = store.send({ conversationId: CONV_A, clientId: 'c-1', text: '写一份报告' });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const messageId = sent.value.message.messageId;

    store.failMessage({ conversationId: CONV_A, messageId, code: 'model_unavailable', message: '断流', at: '2026-10-03T00:00:05.000Z' });
    const failed = store.getConversation(CONV_A)?.messages.find((m) => m.messageId === messageId);
    expect(failed?.phase).toBe('failed');

    const retried = store.retry({ conversationId: CONV_A, messageId, at: '2026-10-03T00:00:06.000Z' });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.messageId).toBe(messageId);
    expect(retried.value.clientId).toBe('c-1');
    expect(retried.value.attempts).toBe(2);
    expect(retried.value.phase).toBe('accepted');
    expect(retried.value.error).toBeNull();

    const record = store.getConversation(CONV_A);
    expect(record?.messages.length).toBe(1); // 没有新建第二条
    // 重试补了一条 run_retried 事件（run_requested + run_retried）。
    expect(record?.events.map((e) => e.kind)).toEqual(['run_requested', 'run_retried']);
  });

  it('重复重试同一失败消息不会重复建任务（幂等由复用消息与 clientId 保证）', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A });
    const sent = store.send({ conversationId: CONV_A, clientId: 'c-1', text: 'x' });
    if (!sent.ok) return;
    const messageId = sent.value.message.messageId;
    store.failMessage({ conversationId: CONV_A, messageId, code: 'e', message: 'm' });
    const first = store.retry({ conversationId: CONV_A, messageId });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.attempts).toBe(2);
    // 第二次重试时消息已在 accepted（非 failed/cancelled）⇒ 明确拒绝，而不是再跑一次。
    const second = store.retry({ conversationId: CONV_A, messageId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('not_retryable');
    expect(store.getConversation(CONV_A)?.messages.length).toBe(1);
  });

  it('正在跑（running）的消息不可重试 ⇒ not_retryable', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A });
    const sent = store.send({ conversationId: CONV_A, clientId: 'c-1', text: 'x' });
    if (!sent.ok) return;
    // 初始就是 accepted（非 failed/cancelled）。
    const result = store.retry({ conversationId: CONV_A, messageId: sent.value.message.messageId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_retryable');
  });

  it('不存在的消息 ⇒ message_not_found', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A });
    const result = store.retry({ conversationId: CONV_A, messageId: 'm-999' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('message_not_found');
  });
});
