/**
 * **产品会话存储 ⇄ 内核会话模型 的显式适配层**（FA-CONVERSATION-SCHEMA-UNIFY）。
 *
 * ## 为什么需要它（判定：**不是**同一件事的两个模型）
 *
 * 仓库里有两套会话落盘 schema，原先互不 import：
 *
 * | 真相源 | 文件 | 落盘 schema | 回答什么 |
 * |---|---|---|---|
 * | **产品持久化** | `apps/demo/server/conversation-store.ts` | `potbot-conversation-store.v1` | **一条会话里的消息/事件日志**：正文、单调 `seq`、幂等键 `clientId`、续取游标、R209 五态、重启归位 |
 * | **内核会话语义** | `./session-model.ts`（CHAT-02） | `potbot-conversation-sessions.v1` | **一个用户有哪些会话、任务/记忆挂在谁身上**：`active_id`、分页/搜索、`task_refs` / `memory_refs` 的跨会话隔离 |
 *
 * 二者**不是同一件事的两个模型**，各自都持有对方**根本没有**的数据：
 * 前者有**消息正文与事件流**（后者只存 `message_count` 这一个数字）；
 * 后者有**任务/记忆归属与当前会话**（前者的 record 里没有这些字段）。
 * 因此**合并成一份会丢信息**——正确做法不是合并，而是把**重叠的那一小块**显式建模。
 *
 * 真正的缺陷只在那块重叠上：**会话头**（id / 标题 / 创建时间 / 更新时间 / 归档位）
 * 被两套互不相通的表示各写了一遍——`name` vs `title`、ISO 字符串 vs `LogicalTime`
 * 数字、camelCase vs snake_case、两个 schema 字符串。**本文件就是那一块的唯一映射**：
 * 它把"同一个会话头"的两种写法写成**有方向、可测**的转换，任何一侧漂移都会让单测变红。
 *
 * ## 分工与方向（两端文件头各自也指向本文件）
 *
 * ```text
 * 产品 ConversationRecord ──toConversationSession──▶ 内核 ConversationSession
 *   权威：messages / events / 游标 / phase        权威：active_id / task_refs / memory_refs / 分页搜索
 *   丢：messages 正文、events、游标  →  留：会话头 + message_count
 *
 * 内核 ConversationSession ──headerFromSession / recordFromSession──▶ 产品会话头
 *   内核**不存正文** ⇒ 反向只能还原 5 个会话语头字段；
 *   messages / events 必须由调用方从产品侧自带（见 {@link recordFromSession} 的 payload 参数）。
 * ```
 *
 * - **产品侧是消息/事件载荷的真相源**：本层**不**把正文搬进内核。
 * - **内核侧是会话集合与归属的真相源**：本层**不**把 `task_refs` / `memory_refs` 塞进产品落盘。
 * - **重叠的会话头**：双向投影，且"能往返的那 5 个字段"必须**逐字段相等**（单测断言）。
 *
 * ## 纪律
 *
 * - **零 IO、零墙钟、零随机数**：纯函数；时间只做表示转换（ISO ⇄ 毫秒），不读时钟。
 * - **有损就写明有损**：`toConversationSession` 的丢弃项写在类型与注释里，不假装能往返。
 * - **坏输入整份拒绝**：时间戳不是产品侧 ISO 形态 ⇒ 结构化失败（`state_unreadable`），
 *   不静默补默认时间（那会让一份坏记录"看起来成功"）。
 *
 * ## 依赖方向（如实登记）
 *
 * 对产品文件的引用是**类型专用**（`import type`，`verbatimModuleSyntax` 下运行时**完全擦除**）
 * ——内核包在运行时**不**依赖宿主，避免 `src → apps` 的运行时倒挂。代价：适配层必须由
 * 两端的调用方（或测试）显式引入；本层**不**改任何一方的落盘 schema。
 *
 * ⚠️ 本文件的可用性**已在单测中实测**（`adapter-to-store.test.ts` 与产品侧
 * `apps/demo/server/conversation-store.test.ts`）；但**产品路径尚未接线**（`conversation-host.ts`
 * 仍只走产品 store，`src/conversation/index.ts` 尚未 re-export 本文件）——见交付说明。
 * **未接线 = 未验证**，不在此声称"产品已收敛"。
 */

import type {
  ConversationMessage,
  ConversationEvent,
  ConversationRecord,
} from '../../apps/demo/server/conversation-store.js';

import {
  asLogicalTime,
  formatIsoTimestampUtc,
  parseIsoTimestampUtc,
  type LogicalTime,
} from '../protocol/index.js';

import {
  CONVERSATION_SESSION_SCHEMA,
  asConversationId,
  conversationFail,
  conversationOk,
  type ConversationId,
  type ConversationResult,
  type ConversationSession,
  type ConversationSnapshot,
} from './session-model.js';

// ---------------------------------------------------------------------------
// 表示转换：产品 ISO 字符串 ⇄ 内核 LogicalTime（毫秒）
// ---------------------------------------------------------------------------

/**
 * 产品侧写盘用的时间形态：`new Date().toISOString()` —— 恒为 UTC、恒带毫秒。
 *
 * 只接受这一种形态（而不是"任何能被 `Date.parse` 吃下的字符串"）：适配层的价值在于
 * **钉住**两种表示，宽松解析会把"上游换了时间格式"这件事悄悄吞掉。
 */
const PRODUCT_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 产品侧 ISO（UTC + 毫秒）→ 内核 `LogicalTime`（有限数毫秒）。 */
export function isoToLogicalTime(iso: string): ConversationResult<LogicalTime> {
  if (typeof iso !== 'string' || !PRODUCT_ISO_UTC.test(iso)) {
    return conversationFail(
      'state_unreadable',
      `会话时间戳不是产品侧 ISO（UTC + 毫秒）形态：${JSON.stringify(iso)}`,
    );
  }
  // 刻意不用 `Date.parse`：改用 `src/protocol/timestamps.ts` 的**纯整数**解析器（合同 R50.4
  // 的内核零墙钟纪律；`Date` 家族的解析同样带"日历不存在的日期会静默进位"的坑，
  // 例如 `2026-02-30` —— 本层要求**不猜**，这类日期一律结构化失败）。
  const ms = parseIsoTimestampUtc(iso);
  if (ms === null) {
    return conversationFail('state_unreadable', `会话时间戳无法解析：${JSON.stringify(iso)}`);
  }
  return conversationOk(asLogicalTime(ms));
}

/**
 * 内核 `LogicalTime`（毫秒）→ 产品侧 ISO（UTC + 毫秒）。
 *
 * 与 {@link isoToLogicalTime} 构成**逐字符往返**（产品写入形态就是 `toISOString()`）。
 */
export function logicalTimeToIso(value: LogicalTime): ConversationResult<string> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return conversationFail('state_unreadable', `LogicalTime 必须是有限数：${JSON.stringify(value)}`);
  }
  // 刻意不用 `new Date(value).toISOString()`：合同 R50.4 禁该 token。改用纯整数格式化器，
  // 并用**逐字符往返**自校验"这个值真的能被表示"——往返不上就如实失败，而不是给一个看似正常的串。
  const text = formatIsoTimestampUtc(value);
  if (parseIsoTimestampUtc(text) !== value) {
    return conversationFail('state_unreadable', `LogicalTime ${String(value)} 超出可表示的日期范围`);
  }
  return conversationOk(text);
}

// ---------------------------------------------------------------------------
// 产品 record → 内核 session（有损：只带会话头 + 消息条数）
// ---------------------------------------------------------------------------

/**
 * 把一个**产品会话 record**投影成**内核会话记录**。
 *
 * | 产品字段 | 内核字段 | 变换 | 说明 |
 * |---|---|---|---|
 * | `conversationId` | `conversation_id` | 同串 + 品牌化 | 空串 ⇒ 拒绝 |
 * | `name` | `title` | 原样（产品侧已裁剪到上限） | 不重命名 |
 * | `createdAt` | `created_at` | ISO → 毫秒 | 见 {@link isoToLogicalTime} |
 * | `updatedAt` | `updated_at` | ISO → 毫秒 | 同上 |
 * | `archived` | `archived` | 恒等 | —— |
 * | `messages.length` | `message_count` | 计数 | **正文不搬** |
 * | `messages` / `events` / 游标 | —— | **丢弃** | 内核不存正文与事件流 |
 * | ——（产品无此概念） | `task_refs` | `[]` | 归属是内核侧知识，不在这里编造 |
 * | ——（产品无此概念） | `memory_refs` | `[]` | 同上 |
 */
export function toConversationSession(record: ConversationRecord): ConversationResult<ConversationSession> {
  // 形状核对按 `unknown` 走：调用方可能递来的是**未解码**的落盘对象（TS 类型不保证运行时形状）。
  const raw = record as unknown as Record<string, unknown>;
  const rawId = raw['conversationId'];
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    return conversationFail('state_unreadable', `产品会话 record 的 conversationId 非法：${JSON.stringify(rawId)}`);
  }
  const rawName = raw['name'];
  if (typeof rawName !== 'string') {
    return conversationFail('state_unreadable', `产品会话 ${rawId} 的 name 不是字符串`);
  }
  const createdAt = isoToLogicalTime(raw['createdAt'] as string);
  if (!createdAt.ok) return createdAt as ConversationResult<ConversationSession>;
  const updatedAt = isoToLogicalTime(raw['updatedAt'] as string);
  if (!updatedAt.ok) return updatedAt as ConversationResult<ConversationSession>;
  const messages = raw['messages'];
  const messageCount = Array.isArray(messages) ? messages.length : 0;

  return conversationOk(
    Object.freeze({
      schema: CONVERSATION_SESSION_SCHEMA,
      conversation_id: asConversationId(rawId),
      title: rawName,
      created_at: createdAt.value,
      updated_at: updatedAt.value,
      archived: raw['archived'] === true,
      // 内核不存正文；任务/记忆归属是内核侧知识，产品 record 没有 ⇒ 如实给空列表（不编造）。
      task_refs: Object.freeze([]),
      memory_refs: Object.freeze([]),
      message_count: messageCount,
    }),
  );
}

// ---------------------------------------------------------------------------
// 内核 session → 产品会话语头（反向；正文无法还原）
// ---------------------------------------------------------------------------

/** 产品侧**会话头**（`ConversationRecord` 去掉 messages / events / 游标之后的 5 个字段）。 */
export interface ConversationHeader {
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

/** 内核会话记录 → 产品会话头（`title` → `name`、毫秒 → ISO）。 */
export function headerFromSession(session: ConversationSession): ConversationResult<ConversationHeader> {
  const createdAt = logicalTimeToIso(session.created_at);
  if (!createdAt.ok) return createdAt as ConversationResult<ConversationHeader>;
  const updatedAt = logicalTimeToIso(session.updated_at);
  if (!updatedAt.ok) return updatedAt as ConversationResult<ConversationHeader>;
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

/** 反向适配必须自带的产品侧载荷（内核**不存**这些：把"内核不存正文"写进类型）。 */
export interface ProductPayload {
  readonly messages: readonly ConversationMessage[];
  readonly events: readonly ConversationEvent[];
  readonly nextMessageSeq: number;
  readonly nextEventSeq: number;
}

/**
 * 内核会话记录 + 产品侧自带载荷 → 完整的产品 record。
 *
 * `payload` **不是可选**：内核只给得出会话头，消息与事件必须由产品侧提供——
 * 让这件事在类型里就说不通"从内核单独还原一份 record"，而不是靠注释约定。
 */
export function recordFromSession(
  session: ConversationSession,
  payload: ProductPayload,
): ConversationResult<ConversationRecord> {
  const header = headerFromSession(session);
  if (!header.ok) return header as ConversationResult<ConversationRecord>;
  return conversationOk(
    Object.freeze({
      conversationId: header.value.conversationId,
      name: header.value.name,
      createdAt: header.value.createdAt,
      updatedAt: header.value.updatedAt,
      archived: header.value.archived,
      messages: payload.messages,
      events: payload.events,
      nextMessageSeq: payload.nextMessageSeq,
      nextEventSeq: payload.nextEventSeq,
    }),
  );
}

/** 从产品 record 里取出反向适配所需的载荷（`recordFromSession` 的配套）。 */
export function payloadOf(record: ConversationRecord): ProductPayload {
  return Object.freeze({
    messages: record.messages,
    events: record.events,
    nextMessageSeq: record.nextMessageSeq,
    nextEventSeq: record.nextEventSeq,
  });
}

// ---------------------------------------------------------------------------
// 集合层桥接：产品 record 列表 → 内核快照（让内核的分页/搜索能跑在产品数据上）
// ---------------------------------------------------------------------------

/**
 * 一批产品 record + 当前会话 → 内核整份快照。
 *
 * `activeId` 若不在这一批里则**置 `null`**（与内核 `#restore` 同一条纪律：指向空会话的
 * 游标按"没有激活"处理，**不猜**一个替代品）。
 */
export function snapshotFromRecords(
  records: readonly ConversationRecord[],
  activeId: ConversationId | null,
): ConversationResult<ConversationSnapshot> {
  const sessions: ConversationSession[] = [];
  for (const record of records) {
    const converted = toConversationSession(record);
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

/** 内核快照里的当前会话（反向取用；不改内核的语义）。 */
export function activeIdFromSnapshot(snapshot: ConversationSnapshot): ConversationId | null {
  return snapshot.active_id;
}
