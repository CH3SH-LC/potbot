/**
 * 产品会话存储单测 + **与会话内核模型的跨边界互通用例**（FA-CONVERSATION-SCHEMA-UNIFY）。
 *
 * ## 为什么这个文件里会有"内核"的用例
 *
 * 产品 store（本目录 `conversation-store.ts`，schema `potbot-conversation-store.v1`）与
 * 内核会话模型（`conversation/session-model.ts`，schema `potbot-conversation-sessions.v1`）
 * 是**两个不同的关注点**：前者管**消息/事件流**，后者管**会话集合与任务/记忆归属**。
 * 重叠的**会话头**原先有两套互不相通的写法。`conversation/adapter-to-store.ts` 是那一块的
 * 唯一映射；本文件证明**产品真实产出的数据能被内核侧读进去**，而不是只在小夹具上自说自话。
 *
 * ## 判据
 *
 * | 判据 | 正例 | 反向对照 |
 * |---|---|---|
 * | **产品 store 本身** | 幂等收消息（同 clientId 不新建）、游标只增不重放、重启归位 | 同 clientId 不同正文 ⇒ `idempotency_conflict` |
 * | **删除是持久的**（CHAT-08） | 删除落**墓碑** ⇒ 同一份落盘起新实例后仍取不到、列表里也没有 | 未删的会话**仍在**；删不存在的**无副作用**；墓碑写不下去 ⇒ 不摘内存（`delete_not_persisted`） |
 * | **跨边界互通** | 产品 record → 内核 session（会话头逐项相等）；内核快照能被 `ConversationSessions` 读回并分页/搜索 | 映射**故意错一项** ⇒ 同一断言必须变红 |
 * | **分工是真分工** | 内核挂上的 `task_refs` **不**回流产品 record（产品里根本没这字段） | —— |
 *
 * ## 诚实边界
 *
 * 产品路径**尚未**把适配层接进 `conversation-host.ts`（本轮写权不含该文件），因此这组证明的是
 * "两端**能**互通"，**不是**"产品已在用内核会话模型"。后者的接线方案见交付说明。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationStore,
  type ConversationPersistence,
  type ConversationRecord,
  type SerializedConversation,
} from './conversation-store.js';
import {
  activeIdFromSnapshot,
  headerFromSession,
  payloadOf,
  recordFromSession,
  snapshotFromRecords,
  toConversationSession,
} from '../../../src/conversation/adapter-to-store.js';
import {
  ConversationSessions,
  asConversationId,
  createMemoryConversationPersistence,
  type ConversationSession,
} from '../../../src/conversation/session-model.js';
import { asLogicalTime, asTaskId } from '../../../src/protocol/index.js';

// ---------------------------------------------------------------------------
// 夹具：内存落盘（本文件只测逻辑，不碰真实文件系统）
// ---------------------------------------------------------------------------

function inMemoryDisk(): {
  persistence: (id: string) => ConversationPersistence;
  directory: { list(): readonly string[] };
  raw: Map<string, unknown>;
} {
  const raw = new Map<string, unknown>();
  return {
    raw,
    persistence: (id: string): ConversationPersistence => ({
      save(record: SerializedConversation): void {
        raw.set(id, structuredClone(record));
      },
      load(): unknown {
        return raw.get(id) ?? null;
      },
    }),
    directory: { list: (): readonly string[] => [...raw.keys()] },
  };
}

const T0 = new Date('2026-10-03T10:00:00.000Z');
const T1 = new Date('2026-10-03T10:05:00.000Z');

function freshStore(): { store: ConversationStore; disk: ReturnType<typeof inMemoryDisk> } {
  const disk = inMemoryDisk();
  const now = T0;
  const store = new ConversationStore({
    persistence: disk.persistence,
    directory: disk.directory,
    now: () => now,
    makeId: (prefix) => `${prefix}-fixed`,
  });
  return { store, disk };
}

// ---------------------------------------------------------------------------
// A. 产品 store 本身（正向 + 反向）
// ---------------------------------------------------------------------------

describe('产品会话存储（potbot-conversation-store.v1）', () => {
  it('收消息是幂等的：同 clientId 第二次到达不新建（R207）', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');

    const first = store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '帮我做报销单' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.duplicate).toBe(false);
    expect(first.value.message.seq).toBe(1);
    expect(first.value.message.phase).toBe('accepted');

    const again = store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '帮我做报销单' });
    expect(again.ok && again.value.duplicate).toBe(true);
    expect(store.get('sess-1')?.messages.length).toBe(1);
  });

  it('反向对照：同 clientId 但正文不同 ⇒ 结构化拒绝（不静默覆盖、不新建）', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '原文' });
    const conflict = store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '改了内容' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict');
    expect(store.get('sess-1')?.messages[0]?.text).toBe('原文');
  });

  it('游标只增：eventsSince 严格大于游标，已消费的事件不重放（R208）', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '第一条' });
    const head = store.headCursor('sess-1');

    // 无新事件时游标**不前移**。
    const empty = store.eventsSince('sess-1', head);
    expect(empty.ok && empty.value.events.length).toBe(0);
    expect(empty.ok && empty.value.cursor).toBe(head);

    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-2', text: '第二条' });
    const page = store.eventsSince('sess-1', head);
    expect(page.ok && page.value.events.length).toBe(1);
    expect(page.ok && page.value.events[0]?.kind).toBe('message_accepted');
  });

  it('重启归位：在途消息标 failed/server_restarted，正文与 clientId 一个不丢（R215–R217）', () => {
    const { store, disk } = freshStore();
    store.createConversation('报销单', 'sess-1');
    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '在途的消息' });

    // 用**同一份落盘**起一个新实例 = 同进程内的重启模拟。
    const revived = new ConversationStore({
      persistence: disk.persistence,
      directory: disk.directory,
      now: () => T1,
      makeId: (prefix) => `${prefix}-fixed`,
    });
    expect(revived.unreadableConversations().length).toBe(0);
    const touched = revived.reconcileAfterRestart();
    expect(touched.length).toBe(1);

    const message = revived.get('sess-1')?.messages[0];
    expect(message?.phase).toBe('failed');
    expect(message?.error?.code).toBe('server_restarted');
    expect(message?.error?.retryable).toBe(true);
    expect(message?.text).toBe('在途的消息'); // 正文不丢
    expect(message?.clientId).toBe('c-1'); // 幂等键不丢
    expect(revived.get('sess-1')?.messages.length).toBe(1); // 没有凭空多出一条
  });

  it('删除**落墓碑**：同一份落盘起新实例后仍取不到、列表里也没有（CHAT-08 持久化）', () => {
    const { store, disk } = freshStore();
    store.createConversation('要删的', 'sess-del');
    store.createConversation('要留的', 'sess-keep');

    const removed = store.delete('sess-del');
    expect(removed.ok).toBe(true);
    expect(store.has('sess-del')).toBe(false);
    expect(store.get('sess-del')).toBeUndefined();

    // 落盘证据：槽位里是一条**墓碑**（不是被抹掉 —— 抹掉就不可审计了）。
    const raw = disk.raw.get('sess-del') as Record<string, unknown>;
    expect(raw['deleted']).toBe(true);
    expect(raw['conversationId']).toBe('sess-del');

    // 换实例、同一份落盘 = 重启。
    const revived = new ConversationStore({
      persistence: disk.persistence,
      directory: disk.directory,
      now: () => T1,
      makeId: (prefix) => `${prefix}-fixed`,
    });
    expect(revived.has('sess-del'), '已删的会话不得被落盘带回内存').toBe(false);
    expect(revived.get('sess-del')).toBeUndefined();
    expect(revived.list().map((item) => item.conversationId)).toEqual(['sess-keep']);

    // **反向对照**：没删的那个**必须还在**（不是"重启即清空"）。
    expect(revived.has('sess-keep')).toBe(true);
    expect(revived.get('sess-keep')?.name).toBe('要留的');

    // 墓碑**不是**"读不回来"，也不是"落盘上有却没进内存"的故障 —— 两件事必须分得开。
    expect(revived.unreadableConversations()).toEqual([]);
    expect(revived.missingFromMemory()).toEqual([]);
    expect(revived.deletedConversations().map((item) => item.conversationId)).toEqual(['sess-del']);

    // 已删的会话**不**能被 rehydrate 撤销（删除不是"可以随手拉回来的"）。
    const pulled = revived.rehydrate('sess-del');
    expect(pulled.ok).toBe(false);
    if (!pulled.ok) expect(pulled.code).toBe('conversation_not_found');

    // 显式重建同 id ⇒ 墓碑被覆盖，会话以**新的空记录**回来（不是旧内容复活）。
    const recreated = revived.createConversation('重新开的', 'sess-del');
    expect(recreated.ok).toBe(true);
    expect(revived.get('sess-del')?.messages.length).toBe(0);
    expect(revived.deletedConversations()).toEqual([]);
  });

  it('反向对照：删**不存在**的会话 ⇒ conversation_not_found 且**不写任何东西**', () => {
    const { store, disk } = freshStore();
    store.createConversation('在的', 'sess-a');
    const before = disk.raw.size;

    const missing = store.delete('sess-absent');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('conversation_not_found');

    // 无副作用：磁盘条目数不变、没多出一条墓碑、也没动别的会话。
    expect(disk.raw.size).toBe(before);
    expect(disk.raw.has('sess-absent')).toBe(false);
    expect(store.deletedConversations()).toEqual([]);
    expect(store.has('sess-a')).toBe(true);
  });

  it('墓碑写不下去 ⇒ 结构化拒绝且**内存不摘除**（不把"删不掉"说成"已删除"）', () => {
    const disk = inMemoryDisk();
    // 先用一份**能写**的端口把会话落盘（否则下面那个实例根本恢复不出这个会话）。
    const seed = new ConversationStore({ persistence: disk.persistence, directory: disk.directory });
    seed.createConversation('删不掉', 'sess-stuck');
    // 换一个**写就抛**的端口（模拟磁盘满 / 权限），起新实例：读用原盘，写一律失败。
    const failing = new ConversationStore({
      persistence: (id): ConversationPersistence => ({
        save(): void {
          throw new Error('磁盘满（测试注入）');
        },
        load: () => disk.persistence(id).load(),
      }),
      directory: disk.directory,
    });
    expect(failing.has('sess-stuck')).toBe(true); // 恢复出来了，删除才有意义

    const refused = failing.delete('sess-stuck');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('delete_not_persisted');
    // 会话**还在**内存里：调用方拿到的失败与"还能继续用它"是一致的。
    expect(failing.has('sess-stuck')).toBe(true);
    expect(failing.list().map((item) => item.conversationId)).toEqual(['sess-stuck']);
    expect(failing.deletedConversations()).toEqual([]);
  });

  it('读不回来 ≠ 不存在：落盘被改坏则整份拒绝并如实登记', () => {
    const disk = inMemoryDisk();
    disk.raw.set('sess-broken', { schema: 'potbot-conversation-store.v1', conversationId: 'sess-broken' });
    const store = new ConversationStore({ persistence: disk.persistence, directory: disk.directory });
    expect(store.has('sess-broken')).toBe(false);
    expect(store.unreadableConversations().map((item) => item.conversationId)).toEqual(['sess-broken']);
    expect(store.missingFromMemory()).toEqual(['sess-broken']);
  });
});

// ---------------------------------------------------------------------------
// B. 跨边界互通：产品产出的 record → 内核会话模型能读、能转、能搜
// ---------------------------------------------------------------------------

describe('跨边界 · 产品 store 的真实产出能被内核会话模型读进去', () => {
  it('产品 record → 内核 session：会话头逐项相等，消息正文不越界（只留条数）', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '帮我做报销单' });
    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-2', text: '金额 128 元' });
    // 第二条序号推进（消费掉，保证 nextMessageSeq 不是 1）。
    const record = store.get('sess-1');
    expect(record).toBeDefined();
    if (record === undefined) return;

    const session = toConversationSession(record);
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    expect(headerFromSession(session.value)).toEqual({
      ok: true,
      value: {
        conversationId: 'sess-1',
        name: '报销单',
        createdAt: T0.toISOString(),
        updatedAt: T0.toISOString(),
        archived: false,
      },
    });
    // 内核只拿到**条数**（2 条），拿不到正文。
    expect(session.value.message_count).toBe(2);
    expect(JSON.stringify(session.value)).not.toContain('帮我做报销单');
  });

  it('单向读：内核会话模型能吃下适配层产出的快照，并分页 / 搜索到产品数据', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    store.createConversation('周报', 'sess-2');

    const snapshot = snapshotFromRecords(
      [store.get('sess-1') as ConversationRecord, store.get('sess-2') as ConversationRecord],
      asConversationId('sess-1'),
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(activeIdFromSnapshot(snapshot.value)).toBe('sess-1');

    // 内核实例读回这份快照——**它不知道**数据其实是产品 store 产出的。
    const kernel = new ConversationSessions({
      persistence: createMemoryConversationPersistence(snapshot.value),
    });
    expect(kernel.readiness().ready).toBe(true);
    expect(kernel.unreadableReason()).toBeNull();
    expect(kernel.sessionCount()).toBe(2);
    expect(kernel.activeSession()?.title).toBe('报销单');
    expect(kernel.listSessions().items.map((s) => s.title).sort()).toEqual(['周报', '报销单']);
    expect(kernel.searchSessions('报销').map((s) => s.conversation_id)).toEqual(['sess-1']);
    expect(kernel.listSessions({ includeArchived: true }).total).toBe(2);
  });

  it('双向往返：产品 record → 内核 session → 产品 record 逐字段相等（载荷由产品侧自带）', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    store.acceptMessage({ conversationId: 'sess-1', clientId: 'c-1', text: '正文' });
    const record = store.get('sess-1') as ConversationRecord;

    const session = toConversationSession(record);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const back = recordFromSession(session.value, payloadOf(record));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual(record);
  });

  it('分工是真分工：内核挂上的 task_refs **不**回流产品 record（产品里没这字段）', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    const record = store.get('sess-1') as ConversationRecord;

    const kernel = new ConversationSessions({ persistence: createMemoryConversationPersistence() });
    kernel.createSession({ id: asConversationId('sess-1'), title: '报销单', at: asLogicalTime(1) });
    const attached = kernel.attachTask(asConversationId('sess-1'), asTaskId('task-1'), asLogicalTime(2));
    expect(attached.ok).toBe(true);
    expect(kernel.taskRefsOf(asConversationId('sess-1'))).toEqual(['task-1']);

    // 产品侧那份 record **没有** task_refs 这个字段，也不会凭空长出来。
    const session = toConversationSession(record);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(kernel.taskRefsOf(asConversationId('sess-1'))).toEqual(['task-1']);
    expect(Object.keys(record)).not.toContain('task_refs');
    // 适配层不会替内核把归属"顺手"写进产品侧（那会是第三个真相源）。
    expect(recordFromSession(session.value, payloadOf(record))).toEqual({ ok: true, value: record });
  });
});

// ---------------------------------------------------------------------------
// C. 反向对照：映射故意错一项 ⇒ 同一断言必须变红
// ---------------------------------------------------------------------------

describe('跨边界 · 反向对照（改错一项必须变红，否则用例不敏感）', () => {
  /** 正确映射（把结构化结果拆成值，供同一断言使用）。 */
  function goodSession(record: ConversationRecord): ConversationSession {
    const result = toConversationSession(record);
    if (!result.ok) throw new Error(`正确映射竟然失败了：${result.code}`);
    return result.value;
  }

  /**
   * 故意错一项：标题被**改写**（加后缀）。
   *
   * 注：不能用 `toUpperCase()` 当"改错"——中文标题没有大小写，那是**空操作**，
   * 用例会假绿。这一点本身就是"反向对照要真的改变值"的教训。
   */
  function mangledSession(record: ConversationRecord): ConversationSession {
    return { ...goodSession(record), title: `${goodSession(record).title}（改）` };
  }

  const assertCrossBoundary = (
    mapping: (record: ConversationRecord) => ConversationSession,
    record: ConversationRecord,
  ): void => {
    const session = mapping(record);
    // 跨边界断言：内核侧的标题必须原样等于产品侧的名字。
    expect(session.title).toBe(record.name);
    // 且反向还原必须回到同一个名字。
    expect(headerFromSession(session)).toEqual({
      ok: true,
      value: {
        conversationId: record.conversationId,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        archived: record.archived,
      },
    });
  };

  it('正确映射通过；改错 title 的映射必须让**同一断言**失败', () => {
    const { store } = freshStore();
    store.createConversation('报销单', 'sess-1');
    const record = store.get('sess-1') as ConversationRecord;

    expect(() => assertCrossBoundary(goodSession, record)).not.toThrow();
    expect(() => assertCrossBoundary(mangledSession, record)).toThrow();
    // 不是"断言恰好不敏感"：改错后的值确实与产品侧不同。
    expect(mangledSession(record).title).not.toBe(record.name);
  });
});
