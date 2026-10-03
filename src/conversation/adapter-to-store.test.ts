/**
 * 适配层单测（FA-CONVERSATION-SCHEMA-UNIFY）。
 *
 * ## 这一组回答什么
 *
 * 产品会话存储（`potbot-conversation-store.v1`）与内核会话模型
 * （`potbot-conversation-sessions.v1`）**不是同一件事的两个模型**，但重叠的**会话头**
 * 被两套表示各写了一遍。本组用例钉住 `adapter-to-store.ts` 的那张映射表：
 *
 * - **正例（跨边界互通）**：产品 record → 内核 session，5 个会话头字段逐项对得上；
 *   内核 session → 产品会话头 / 完整 record，**逐字段回得来**（载荷由产品侧自带）。
 * - **往返**：ISO → 毫秒 → ISO **逐字符相等**（`toISOString()` 形态）。
 * - **反向对照（用例必须能变红）**：把映射**故意改错一项**，同一断言必须**失败**
 *   ——证明用例真的在盯那一项，而不是"怎么改都能过"。
 * - **反例**：坏时间戳 / 空 id ⇒ **整份拒绝**（`state_unreadable`），不静默补默认值。
 *
 * ## 诚实边界
 *
 * 这里只测**纯函数**。产品路径**尚未接线**（`conversation-host.ts` 仍只走产品 store），
 * 因此本组**不**声称"产品已收敛"；产品侧的真实串联见
 * `apps/demo/server/conversation-store.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';

import {
  CONVERSATION_SESSION_SCHEMA,
  asConversationId,
  conversationOk,
  type ConversationResult,
  type ConversationSession,
} from './session-model.js';
import {
  activeIdFromSnapshot,
  headerFromSession,
  isoToLogicalTime,
  logicalTimeToIso,
  payloadOf,
  recordFromSession,
  snapshotFromRecords,
  toConversationSession,
} from './adapter-to-store.js';

// 产品侧 record 的**结构**（类型专用：不把宿主拖进内核运行时；见适配层文件头的依赖方向）。
import type { ConversationRecord } from '../../apps/demo/server/conversation-store.js';

const CREATED = '2026-10-03T10:00:00.000Z';
const UPDATED = '2026-10-03T11:30:15.250Z';

function productRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversationId: 'sess-abc123',
    name: '报销单',
    createdAt: CREATED,
    updatedAt: UPDATED,
    archived: false,
    messages: [],
    events: [],
    nextMessageSeq: 1,
    nextEventSeq: 1,
    ...overrides,
  } as ConversationRecord;
}

/** 期望的内核会话记录（会话头 + 条数；不含正文）。 */
function expectedSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    schema: CONVERSATION_SESSION_SCHEMA,
    conversation_id: asConversationId('sess-abc123'),
    title: '报销单',
    created_at: asLogicalTime(Date.parse(CREATED)),
    updated_at: asLogicalTime(Date.parse(UPDATED)),
    archived: false,
    task_refs: [],
    memory_refs: [],
    message_count: 0,
    ...overrides,
  };
}

type SessionMapping = (record: ConversationRecord) => ConversationResult<ConversationSession>;

/**
 * 反向对照用的**故意改错一项**的映射：`title` 被改写（加了后缀）。
 * 它必须让 `assertMapping` 变红——否则说明用例根本没在盯 `name → title`。
 *
 * 注：这里**不能**用 `toUpperCase()` 当"改错"——中文标题没有大小写，那是**空操作**，
 * 用例会假绿（本文件第一版就踩了这个坑，被断言自己抓出来）。
 */
function toConversationSessionWithTitleMangled(record: ConversationRecord): ConversationResult<ConversationSession> {
  const good = toConversationSession(record);
  if (!good.ok) return good;
  return conversationOk({ ...good.value, title: `${good.value.title}（改）` });
}

/** 另一处反向对照：**忘记**把创建时间的 ISO 转成毫秒（直接把字符串塞进 LogicalTime 位）。 */
function toConversationSessionWithRawIsoTime(record: ConversationRecord): ConversationResult<ConversationSession> {
  const good = toConversationSession(record);
  if (!good.ok) return good;
  return conversationOk({
    ...good.value,
    created_at: record.createdAt as unknown as ConversationSession['created_at'],
  });
}

function assertMapping(mapping: SessionMapping, record: ConversationRecord, expected: ConversationSession): void {
  const result = mapping(record);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual(expected);
}

describe('适配层 · 产品 record → 内核 session（单向投影，有损已写明）', () => {
  it('会话头 5 项 + 消息条数逐项对得上；正文/事件不被搬进内核', () => {
    const record = productRecord({
      messages: [
        { messageId: 'm1' },
        { messageId: 'm2' },
        { messageId: 'm3' },
      ] as unknown as ConversationRecord['messages'],
      events: [{ seq: 1 }] as unknown as ConversationRecord['events'],
    });
    const converted = toConversationSession(record);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.value).toEqual(expectedSession({ message_count: 3 }));
    // 内核侧**根本**没有存放正文/事件的字段——这不是遗漏，是分工。
    expect(Object.keys(converted.value)).not.toContain('messages');
    expect(Object.keys(converted.value)).not.toContain('events');
  });

  it('归档位与标题原样带过去，不做二次裁剪/改名', () => {
    const converted = toConversationSession(productRecord({ archived: true, name: '  空格 名 ' }));
    expect(converted.ok && converted.value.archived).toBe(true);
    // 产品侧落盘时已裁剪过；适配层**不**再动它（多一次裁剪就是第三个真相源）。
    expect(converted.ok && converted.value.title).toBe('  空格 名 ');
  });

  it('反例：坏时间戳 / 空 id ⇒ 整份拒绝，不静默补默认时间', () => {
    const badTime = toConversationSession(
      productRecord({ createdAt: '2026/10/03 10:00' as unknown as string }),
    );
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) expect(badTime.code).toBe('state_unreadable');

    const badId = toConversationSession(productRecord({ conversationId: '   ' as unknown as string }));
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.code).toBe('state_unreadable');
  });

  it('时间表示转换：ISO ⇄ 毫秒 逐字符往返；只认产品侧 UTC+毫秒形态', () => {
    const ms = isoToLogicalTime(CREATED);
    expect(ms.ok && ms.value).toBe(Date.parse(CREATED));
    expect(logicalTimeToIso(asLogicalTime(Date.parse(UPDATED)))).toEqual({ ok: true, value: UPDATED });

    for (const bad of ['2026-10-03T10:00:00Z', '2026-10-03T10:00:00.000+08:00', '', 'not-a-date']) {
      expect(isoToLogicalTime(bad).ok).toBe(false);
    }
  });
});

describe('适配层 · 内核 session → 产品 record（反向：正文必须由产品侧自带）', () => {
  it('往返：产品 record → 内核 session → 产品 record 逐字段相等（载荷原样回流）', () => {
    const record = productRecord({
      messages: [{ messageId: 'm1' }] as unknown as ConversationRecord['messages'],
      events: [{ seq: 1 }, { seq: 2 }] as unknown as ConversationRecord['events'],
      nextMessageSeq: 2,
      nextEventSeq: 3,
    });
    const session = toConversationSession(record);
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    // 载荷**从产品侧自带**（内核不存正文——类型上就跑不通"只从内核还原"）。
    const back = recordFromSession(session.value, payloadOf(record));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual(record);
  });

  it('headerFromSession：title → name、毫秒 → ISO；archived 原样', () => {
    const header = headerFromSession(expectedSession({ archived: true }));
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value).toEqual({
      conversationId: 'sess-abc123',
      name: '报销单',
      createdAt: CREATED,
      updatedAt: UPDATED,
      archived: true,
    });
  });

  it('集合桥接：一批 record → 内核快照，激活位不在集合里则置 null（不猜替代品）', () => {
    const snapshot = snapshotFromRecords(
      [productRecord(), productRecord({ conversationId: 'sess-xyz', name: '周报' })],
      asConversationId('sess-abc123'),
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.schema).toBe(CONVERSATION_SESSION_SCHEMA);
    expect(snapshot.value.sessions.map((s) => s.title)).toEqual(['报销单', '周报']);
    expect(activeIdFromSnapshot(snapshot.value)).toBe('sess-abc123');

    const orphan = snapshotFromRecords([productRecord()], asConversationId('没有这个会话'));
    expect(orphan.ok && orphan.value.active_id).toBeNull();
  });
});

describe('适配层 · 反向对照（映射故意错一项，用例必须变红）', () => {
  it('正确映射通过同一断言，两处"故意改错"都让它失败——证明用例真在盯那些字段', () => {
    const record = productRecord();
    const expected = expectedSession();

    // 正：正确映射过得去。
    expect(() => assertMapping(toConversationSession, record, expected)).not.toThrow();

    // 反 1：title 被改写 ⇒ 必须红（钉住 `name → title` 这一项）。
    expect(() => assertMapping(toConversationSessionWithTitleMangled, record, expected)).toThrow();

    // 反 2：忘了 ISO → 毫秒 ⇒ 必须红（钉住时间表示转换这一项）。
    expect(() => assertMapping(toConversationSessionWithRawIsoTime, record, expected)).toThrow();
    // 被改错的那一项**确实**不同（不是"断言恰好不敏感"）。
    const mangled = toConversationSessionWithRawIsoTime(record);
    expect(mangled.ok).toBe(true);
    if (!mangled.ok) return;
    expect(mangled.value.created_at).not.toBe(expected.created_at);
    expect(typeof mangled.value.created_at).toBe('string');
  });

  it('schema 字符串不被适配层改写（仍是内核实名，产品侧 schema 另一套）', () => {
    const session = toConversationSession(productRecord());
    expect(session.ok && session.value.schema).toBe('potbot-conversation-sessions.v1');
    expect(CONVERSATION_SESSION_SCHEMA).not.toBe('potbot-conversation-store.v1');
  });
});
