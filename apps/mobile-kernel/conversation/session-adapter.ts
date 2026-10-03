/**
 * K04 连续对话 —— **手机会话记录 ⇄ 内核会话语义 的显式适配层**（schema adapter）。
 *
 * ## 为什么需要它
 *
 * 手机侧新 schema `potbot-mobile-conversation.v1`（本目录 {@link ./transcript.js}）管的是
 * **一条会话里的消息 / 事件流**；内核侧 `src/conversation/session-model.ts`（`potbot-conversation-sessions.v1`，
 * CHAT-02）管的是**一个用户有哪些会话 + 任务 / 记忆挂在谁身上 + 分页 / 搜索**。二者**不是同一件事**：
 *
 * | 关注点 | 真相源 | 权威数据 |
 * |---|---|---|
 * | 消息 / 事件流 | 手机记录（本目录） | 正文、单调 `seq`、幂等键 `clientId`、游标、五态 |
 * | 会话集合与归属 | 内核 `session-model.ts` | `active_id`、`task_refs` / `memory_refs`、分页 / 搜索 |
 *
 * 重叠的只有**会话头**（id / 标题 / 创建·更新时间 / 归档位）。本文件就是那一块的**唯一映射**：
 * **手机记录 → 内核 session** 是有损投影（丢正文 / 事件，留会话头 + 消息条数），反向只能还原
 * 5 个会话头字段，正文与事件必须由手机侧自带（见 {@link headerFromSession} 的类型约束）。
 *
 * ## 与 `src/conversation/adapter-to-store.ts` 的关系
 *
 * 那份适配的是**桌面宿主的** `conversation-store.ts`（`potbot-conversation-store.v1`）；
 * 本文件适配的是**手机内核的** `potbot-mobile-conversation.v1`。两者是**不同的落盘 schema**，
 * 因此是**两个适配层**，不重复：共同的上游（内核 `ConversationSession` 类型与
 * `decodeConversationSnapshot`）被两边**复用**，没有第二套会话语义。
 *
 * 依赖方向：对 `src/conversation/session-model.js` 与 `src/protocol` 是**类型 + 纯函数**引用
 * （同仓库内核侧，无 `apps → apps` 倒挂）；本文件不 import 任何宿主运行时。
 */

import {
  asLogicalTime,
  formatIsoTimestampUtc,
  parseIsoTimestampUtc,
  type LogicalTime,
} from '../../../src/protocol/index.js';

import {
  CONVERSATION_SESSION_SCHEMA,
  asConversationId,
  conversationFail,
  conversationOk,
  type ConversationId,
  type ConversationResult,
  type ConversationSession,
  type ConversationSnapshot,
} from '../../../src/conversation/session-model.js';

import type { MobileConversationRecord } from './types.js';

/** 内核会话头（与内核 `ConversationSession` 的头 5 个字段一一对应）。 */
export interface KernelConversationHeader {
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

/**
 * 手机会话记录 → 内核会话记录（**有损投影**）。
 *
 * | 手机字段 | 内核字段 | 变换 |
 * |---|---|---|
 * | `conversationId` | `conversation_id` | 同串 + 品牌化 |
 * | `title` | `title` | 原样 |
 * | `createdAt` / `updatedAt` | `created_at` / `updated_at` | ISO(UTC+毫秒) → 毫秒（纯整数解析，不读时钟） |
 * | `archived` | `archived` | 恒等 |
 * | `messages.length` | `message_count` | 计数（**正文不搬**） |
 * | `messages` / `events` / 游标 | —— | **丢弃** |
 * | ——（手机无此概念） | `task_refs` / `memory_refs` | `[]`（归属是内核侧知识，不在这里编造） |
 *
 * 时间戳不是产品侧 ISO（UTC + 毫秒）形态 ⇒ 结构化失败（`state_unreadable`），不静默猜默认时间。
 */
export function toKernelSession(record: MobileConversationRecord): ConversationResult<ConversationSession> {
  const raw = record as unknown as Record<string, unknown>;
  const rawId = raw['conversationId'];
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    return conversationFail('state_unreadable', `手机会话记录的 conversationId 非法：${JSON.stringify(rawId)}`);
  }
  const title = raw['title'];
  if (typeof title !== 'string') {
    return conversationFail('state_unreadable', `手机会话 ${rawId} 的 title 不是字符串`);
  }
  const createdAt = isoToLogicalTime(raw['createdAt']);
  if (!createdAt.ok) return createdAt as ConversationResult<ConversationSession>;
  const updatedAt = isoToLogicalTime(raw['updatedAt']);
  if (!updatedAt.ok) return updatedAt as ConversationResult<ConversationSession>;
  const messages = raw['messages'];
  const messageCount = Array.isArray(messages) ? messages.length : 0;

  return conversationOk(
    Object.freeze({
      schema: CONVERSATION_SESSION_SCHEMA,
      conversation_id: asConversationId(rawId),
      title,
      created_at: createdAt.value,
      updated_at: updatedAt.value,
      archived: raw['archived'] === true,
      task_refs: Object.freeze([]),
      memory_refs: Object.freeze([]),
      message_count: messageCount,
    }),
  );
}

/** 内核会话记录 → 手机会话头（反向；正文无法还原）。 */
export function headerFromSession(session: ConversationSession): ConversationResult<KernelConversationHeader> {
  const createdAt = logicalTimeToIso(session.created_at);
  if (!createdAt.ok) return createdAt as ConversationResult<KernelConversationHeader>;
  const updatedAt = logicalTimeToIso(session.updated_at);
  if (!updatedAt.ok) return updatedAt as ConversationResult<KernelConversationHeader>;
  return conversationOk(
    Object.freeze({
      conversationId: session.conversation_id,
      name: session.title,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      archived: session.archived,
    }),
  );
}

/**
 * 一批手机会话记录 + 当前会话 → 内核整份快照（让内核的分页 / 搜索能跑在手机数据上）。
 *
 * `activeId` 不在这一批里则置 `null`（与内核 `#restore` 同一条纪律：指向空会话的游标按
 * "没有激活"处理，不猜替代品）。
 */
export function snapshotFromRecords(
  records: readonly MobileConversationRecord[],
  activeId: ConversationId | null,
): ConversationResult<ConversationSnapshot> {
  const sessions: ConversationSession[] = [];
  for (const record of records) {
    const converted = toKernelSession(record);
    if (!converted.ok) return converted as ConversationResult<ConversationSnapshot>;
    sessions.push(converted.value);
  }
  const known = new Set(sessions.map((session) => session.conversation_id));
  const active = activeId !== null && known.has(activeId) ? activeId : null;
  return conversationOk(
    Object.freeze({
      schema: CONVERSATION_SESSION_SCHEMA,
      active_id: active,
      sessions: Object.freeze(sessions),
    }),
  );
}

// ---------------------------------------------------------------------------
// 表示转换：手机 ISO（UTC + 毫秒） ⇄ 内核 LogicalTime（毫秒）
// ---------------------------------------------------------------------------

const PRODUCT_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 手机侧 ISO（UTC + 毫秒）→ 内核 `LogicalTime`（有限数毫秒）。 */
export function isoToLogicalTime(iso: unknown): ConversationResult<LogicalTime> {
  if (typeof iso !== 'string' || !PRODUCT_ISO_UTC.test(iso)) {
    return conversationFail('state_unreadable', `会话时间戳不是 UTC+毫秒 ISO 形态：${JSON.stringify(iso)}`);
  }
  // 不用 `Date.parse`：用纯整数解析器（内核零墙钟纪律；`2026-02-30` 这类不存在的日期一律失败）。
  const ms = parseIsoTimestampUtc(iso);
  if (ms === null) {
    return conversationFail('state_unreadable', `会话时间戳无法解析：${JSON.stringify(iso)}`);
  }
  return conversationOk(asLogicalTime(ms));
}

/** 内核 `LogicalTime` → 手机侧 ISO（UTC + 毫秒），逐字符往返自校验。 */
export function logicalTimeToIso(value: LogicalTime): ConversationResult<string> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return conversationFail('state_unreadable', `LogicalTime 必须是有限数：${JSON.stringify(value)}`);
  }
  // 复用内核的纯整数格式化器（与内核同一格式化口径）；逐字符往返不上就如实失败。
  const text = formatIsoTimestampUtc(value);
  if (parseIsoTimestampUtc(text) !== value) {
    return conversationFail('state_unreadable', `LogicalTime ${String(value)} 超出可表示范围`);
  }
  return conversationOk(text);
}
