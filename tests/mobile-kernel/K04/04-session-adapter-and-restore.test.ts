/**
 * K04 独立验证 ④：**schema adapter（手机记录 ⇄ 内核会话语义）**与**跨进程消息流恢复**。
 *
 * 判据：
 *
 * - adapter 是**有损投影**：手机正文 / 事件**不**进内核（内核只留会话头 + 消息条数）；
 *   反向只能还原 5 个会话头字段；时间戳逐字段往返相等。
 * - 时间戳不是 UTC+毫秒 ISO ⇒ 结构化失败（不静默补默认时间）。
 * - 新进程用同一持久端口构造 store 后**不需要 GET** 就能在正确会话上续发；
 *   坏快照必须整份拒绝（`unreadableReason` 非空、内存保持空）。
 */

import { describe, expect, it } from 'vitest';

import {
  MobileConversationStore,
  createMemoryConversationPersistence,
  headerFromSession,
  snapshotFromRecords,
  toKernelSession,
} from '../../../apps/mobile-kernel/conversation/index.js';

import { CONV_A, fixedClock, seqIds, tickingClock } from './fixtures.js';

function newStore(): MobileConversationStore {
  return new MobileConversationStore({ now: fixedClock('2026-10-03T00:00:00.000Z'), makeId: seqIds() });
}

describe('K04-④ 手机记录 → 内核会话（有损投影）', () => {
  it('会话头字段一一对应，正文不进内核，只留 message_count', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A, title: '季度报告', at: '2026-10-03T00:00:00.000Z' });
    store.send({ conversationId: CONV_A, clientId: 'c-1', text: '秘密正文', at: '2026-10-03T00:00:01.000Z' });
    const record = store.getConversation(CONV_A);
    expect(record).not.toBeNull();
    if (record === null) return;

    const session = toKernelSession(record);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(session.value.conversation_id).toBe(CONV_A);
    expect(session.value.title).toBe('季度报告');
    expect(session.value.archived).toBe(false);
    expect(session.value.message_count).toBe(1);
    // 归属是内核侧知识，适配层不编造。
    expect(session.value.task_refs).toEqual([]);
    expect(session.value.memory_refs).toEqual([]);
    // 内核不存正文：序列化后的记录里不得出现正文串。
    expect(JSON.stringify(session.value)).not.toContain('秘密正文');
  });

  it('反向还原 5 个会话头字段，时间戳逐字段往返相等', () => {
    const store = newStore();
    const createdAt = '2026-10-03T08:30:15.250Z';
    store.createConversation({ conversationId: CONV_A, title: '甲', at: createdAt });
    const record = store.getConversation(CONV_A);
    if (record === null) return;
    const session = toKernelSession(record);
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const header = headerFromSession(session.value);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value).toEqual({
      conversationId: CONV_A,
      name: '甲',
      createdAt,
      updatedAt: createdAt,
      archived: false,
    });
  });

  it('时间戳不是 UTC+毫秒 ISO ⇒ 结构化失败，不静默补默认时间', () => {
    const bad = {
      schema: 'potbot-mobile-conversation.v1',
      conversationId: CONV_A,
      title: '甲',
      createdAt: '2026/10/03 08:30', // 非产品侧形态
      updatedAt: '2026-10-03T08:30:15.250Z',
      archived: false,
      messages: [],
      events: [],
      nextMessageSeq: 1,
      nextEventSeq: 1,
    };
    const result = toKernelSession(bad as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('state_unreadable');
  });

  it('snapshotFromRecords：activeId 不在批里 ⇒ 置 null（不猜替代品）', () => {
    const store = newStore();
    store.createConversation({ conversationId: CONV_A, title: '甲' });
    const record = store.getConversation(CONV_A);
    if (record === null) return;

    const ok = snapshotFromRecords([record], 'conv-a' as never);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.active_id).toBe(CONV_A);

    const dangling = snapshotFromRecords([record], 'conv-missing' as never);
    expect(dangling.ok).toBe(true);
    if (dangling.ok) expect(dangling.value.active_id).toBeNull();
  });
});

describe('K04-④ 跨进程消息流恢复（不需要先 GET）', () => {
  it('新 store 用同一持久端口构造后，直接续发落在正确会话、seq 接着走', () => {
    const persistence = createMemoryConversationPersistence();

    const process1 = new MobileConversationStore({
      persistence,
      now: tickingClock(1_700_000_000_000),
      makeId: seqIds(),
    });
    process1.createConversation({ conversationId: CONV_A, title: '甲' });
    process1.createConversation({ conversationId: 'conv-b', title: '乙' });
    process1.send({ conversationId: CONV_A, clientId: 'c-1', text: '第一句' });
    process1.send({ conversationId: CONV_A, clientId: 'c-2', text: '第二句' });

    // 进程 2：不调用任何 GET，构造即从持久恢复。
    const process2 = new MobileConversationStore({
      persistence,
      now: tickingClock(1_700_000_100_000),
      makeId: seqIds(),
    });
    expect([...process2.conversationIds()].sort()).toEqual(['conv-a', 'conv-b']);
    expect(process2.unreadableReason()).toBeNull();

    const continued = process2.send({ conversationId: CONV_A, clientId: 'c-3', text: '第三句' });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    // seq 接着旧记录走（3），不是从 1 重来。
    expect(continued.value.message.seq).toBe(3);

    // 幂等键跨进程仍认：重发 c-1 返回原消息。
    const replay = process2.send({ conversationId: CONV_A, clientId: 'c-1', text: '重发' });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.duplicate).toBe(true);
      expect(replay.value.message.text).toBe('第一句');
    }
    // 另一条会话不受影响（不串任务 / 不串消息）。
    expect(process2.getConversation('conv-b')?.messages.length).toBe(0);
  });

  it('坏快照整份拒绝：unreadableReason 非空且内存保持空', () => {
    const persistence = createMemoryConversationPersistence();
    // 盘上放一条 schema 不符的记录。
    (persistence as unknown as { save: (v: unknown) => void }).save({
      schema: 'potbot-conversation-store.v1', // 别家 schema
      conversationId: CONV_A,
    });
    const store = new MobileConversationStore({ persistence, now: fixedClock('2026-10-03T00:00:00.000Z') });
    expect(store.unreadableReason()).not.toBeNull();
    expect(store.conversationIds().length).toBe(0);
    // 读不回来不等于"可以覆盖"：此时仍可新建，但旧数据没被当成合法数据吃进来。
  });
});
