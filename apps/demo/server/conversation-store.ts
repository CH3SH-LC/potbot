/**
 * 连续对话的**持久状态机**（FA-N；合同 R207–R209 / R214–R216）。
 *
 * ## 这个模块回答什么
 *
 * `apps/demo/web/conversation-store.js`（FA-A 出品，**只读**）已经把**界面侧**的会话 /
 * 消息 / 状态 / 续取游标定义清楚了，并且诚实地留了一个空位：
 * 「`PotbotChatTransport` 由 B 流提供，当前无后端时消息如实标失败/未送达」。
 * 本文件 + `conversation-host.ts` 就是补上那个空位的**服务端**：
 *
 * ```text
 * 客户端（conversation-store.js）        服务端（本文件）
 *   sessionId                ←──────→    conversationId
 *   message.clientId         ←──────→    幂等键（同 clientId ⇒ 同一条消息，R207）
 *   message.seq（每会话单调）  ←──────→    message.seq（每会话单调，重启后继续）
 *   session.resumeCursor     ←──────→    事件日志游标（只增；since 严格大于，R208）
 *   state: sending/received/failed/cancelled
 *                            ←──────→    state + phase（R209 的五态，见下）
 * ```
 *
 * ## R209 的五态**必须分得开**，而界面侧的枚举装不下它
 *
 * 合同要的状态是「发送中 / 已接收 / 业务完成 / 失败 / 取消」。界面侧的消息 `state`
 * 只有 `sending/received/failed/cancelled/pending/streaming`（`conversation-store.js` 的
 * `SEND_STATES`，**不改它的既有语义**）。因此每条消息同时带：
 *
 * - `state`：**界面侧**字段，只用界面认识的枚举（`received` / `streaming` / `completed` /
 *   `failed` / `cancelled`）；
 * - `phase`：**业务侧**字段，用合同的五态（`accepted` / `running` / `completed` /
 *   `failed` / `cancelled`）。
 *
 * 「已接收 ≠ 业务完成」在数据里就是 `state='received' && phase='accepted'` 与
 * `state='completed' && phase='completed'` 两行**不同**的记录——不是靠一句文案区分。
 *
 * ## 崩溃 / 重启（R215/R216/R217）
 *
 * - 排序：消息与事件各自一条**单调 seq**，落盘的就是它；重启后从文件读回，**不重置**
 *   （R207 的"稳定 ID + 单调顺序"跨重启成立）。
 * - 在途消息（`phase='running'` 或 `phase='accepted'`）：重启时**不盲重放**（R217），
 *   而是标记为 `failed` + `code='server_restarted'` + `retryable:true`，并补一条
 *   `server_restarted` 事件。消息正文、attempts、clientId **一个字段都不丢**，
 *   用户可以「重试这条」——重试复用同一条消息与同一个 clientId，**不会重复建任务**。
 * - 读不回来的落盘文件 ⇒ **整份拒绝**（`decodeConversation` 返回失败），不静默按空状态起。
 *
 * ## 删除是**持久的**（CHAT-08；本批修复的缺陷）
 *
 * 缺陷（改前**实测**：真起 `main.js` + 真 HTTP，同运行目录重启）：
 *
 * ```text
 * A: create -> 201 ; A: delete -> 200 ; A: get -> 404
 * B(重启, 同运行目录): get -> 200 且 list 里仍在   ← 已删的会话复活了
 * ```
 *
 * 根因：`delete` 只把会话从**内存**摘除，落盘记录一个字节都没动。修法是**落墓碑**
 * （`CONVERSATION_TOMBSTONE_SCHEMA`，覆盖写同一个槽位）：重启恢复时认到墓碑 ⇒ 该会话
 * **不进内存** ⇒ `get` 404、`list()` 里不出现。二选一里为什么选墓碑不选"抹文件"，
 * 理由写在 `delete()` 的方法注释里（可审计 / 可解释 / 与"不假称撤销"口径一致 / 不需要
 * 宿主新开删文件的口）。
 *
 * 三条边界一并钉住：**没删的会话重启后必须还在**（墓碑只覆盖被删的那一个槽位）；
 * **删不存在的会话** ⇒ `conversation_not_found` 且**不写任何东西**；
 * **墓碑写不下去（落盘失败）就不摘内存** ⇒ `delete_not_persisted`，绝不把"删不掉"
 * 说成"已删除"。
 *
 * ## 不做的事
 *
 * - **不发请求、不调模型、不写盘**：执行在 `conversation-host.ts`，IO 由宿主注入的
 *   `ConversationPersistence` 承担。本文件是纯逻辑，可单进程直接跑。
 *
 * ## 与内核会话模型的分工（**已登记**：适配层是唯一映射）
 *
 * 内核侧另有一份**会话集合模型**（`conversation/session-model.ts`，落盘 schema
 * `potbot-conversation-sessions.v1`，CHAT-02）。两份 schema **不是同一件事的两个模型**：
 *
 * | 关注点 | 真相源 | 权威数据 |
 * |---|---|---|
 * | 一条会话里的**消息 / 事件流** | **本文件** | 正文、单调 `seq`、幂等键 `clientId`、续取游标、R209 五态、重启归位 |
 * | **有哪些会话 / 任务·记忆挂在谁身上** | 内核 `session-model.ts` | `active_id`、`task_refs`、`memory_refs`、分页 / 搜索 |
 *
 * 重叠的只有**会话头**（id / 名字 / 创建·更新时间 / 归档位），而它原先被两套表示各写了一遍
 * （`name` vs `title`、ISO 字符串 vs `LogicalTime` 毫秒、camelCase vs snake_case）。那一块的
 * **唯一映射**是 `conversation/adapter-to-store.ts`（方向与有损项写在它的文件头）：
 * **本文件是消息 / 事件载荷的真相源**，内核那份**不存正文**（只有 `message_count`）。
 * 于是**本文件不 import 内核会话包**——宿主对内核零依赖，也不会有运行时环；适配层由
 * 需要跨界的调用方显式引入。产品路径**尚未**消费内核会话模型，这一点如实记在适配层文件头。
 * 该分工由 `apps/demo/server/conversation-store.test.ts` 的跨边界用例钉住（含反向对照）。
 */

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 落盘格式版本。**只增不改**（语义变了就换字符串，让旧文件走"拒绝加载"）。 */
export const CONVERSATION_SCHEMA = 'potbot-conversation-store.v1';

/**
 * **删除墓碑**的落盘 schema（CHAT-08 的持久化）。
 *
 * 为什么删一个会话要留一条**可读的记录**、而不是把文件抹掉：
 *
 * - **可审计**：盘上留得下"这个 id 在某时刻被删过"这一条事实。文件被抹掉之后，
 *   "这个会话从来没存在过"与"它被删了"在盘上**无法区分**；
 * - **不假称撤销**：删会话**不**是撤销已经发生的外部副作用（`reverted` 是字面量 `false`），
 *   墓碑让盘上的状态与这句声明一致 —— 记录还在，只是被标记为"用户不要它了"；
 * - **删得掉就是删得掉**：重启恢复时读到墓碑 ⇒ 该会话**不**进内存 ⇒ `get` 404、
 *   列表里不出现。这正是本批修的缺陷（改前只从内存摘除，落盘记录原样带它复活）。
 *
 * 与记录 schema **不同字符串**：不认识墓碑的旧代码读它会走 `decodeConversation` 的
 * "拒绝加载"分支（如实报 `unreadable`），而不是把一条墓碑误读成一个空会话。
 */
export const CONVERSATION_TOMBSTONE_SCHEMA = 'potbot-conversation-tombstone.v1';

/** 界面侧认识的消息状态（`conversation-store.js` 的 `SEND_STATES` 的超集，多一个 `completed`）。 */
export type ConversationMessageState =
  | 'sending'
  | 'received'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** **合同 R209 的五态**（业务侧口径）。 */
export type ConversationPhase = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface ConversationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ConversationArtifactRef {
  readonly artifactId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly editRevision: number;
  readonly taskRevision: number;
  readonly artifactVersion: number;
  readonly downloadPath: string;
}

export interface ConversationMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly role: ConversationRole;
  readonly text: string;
  /** 界面侧状态。 */
  readonly state: ConversationMessageState;
  /** 业务侧状态（R209）。 */
  readonly phase: ConversationPhase;
  /** 本会话内单调递增（从 1 起）。重启后继续，不重置。 */
  readonly seq: number;
  /** 幂等键。**重试复用同一个值**（R207）。 */
  readonly clientId: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: ConversationFailure | null;
  readonly artifact: ConversationArtifactRef | null;
}

/**
 * 一条**增量事件**（R208）。
 *
 * `seq` 每会话单调递增、只增不改；游标就是这个 seq 的编码。客户端拿 `since` 取
 * **严格大于**游标的事件 ⇒ 已消费的内容**不会被重放**（不是靠客户端去重）。
 */
export interface ConversationEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly at: string;
  readonly kind: string;
  readonly messageId: string | null;
  readonly state: ConversationMessageState | null;
  readonly phase: ConversationPhase | null;
  readonly text: string | null;
  /** 结构化细节（工具名 / 参数摘要 / 产物身份…）。**只能是 JSON 可序列化的原语**。 */
  readonly detail: Readonly<Record<string, string | number | boolean | null>> | null;
}

export interface ConversationRecord {
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly messages: readonly ConversationMessage[];
  readonly events: readonly ConversationEvent[];
  readonly nextMessageSeq: number;
  readonly nextEventSeq: number;
}

export interface ConversationSummary {
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly messageCount: number;
  readonly lastEventSeq: number;
}

/** 结构化结果（**不抛异常**；失败一律带机器可判的 code）。 */
export type ConversationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function conversationOk<T>(value: T): ConversationResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function conversationFail<T>(code: string, message: string): ConversationResult<T> {
  return Object.freeze({ ok: false as const, code, message });
}

/** 游标上限（防止一个坏游标把响应撑爆；超过即结构化拒绝）。 */
export const CONVERSATION_LIMITS = Object.freeze({
  maxConversations: 64,
  maxMessagesPerConversation: 500,
  maxEventsPerConversation: 4000,
  /** 一次 `eventsSince` 最多返回多少条（翻页由客户端继续用新游标取）。 */
  maxEventsPerPage: 200,
  maxTextChars: 8000,
  maxIdentifierChars: 128,
  maxNameChars: 64,
});

// ---------------------------------------------------------------------------
// 游标
// ---------------------------------------------------------------------------

/**
 * 游标编码：`conv:<conversationId>:<seq>`。
 *
 * 为什么把会话 id 也编进去：游标是**不透明**的，但它必须是**会话内**概念。
 * 一个别的会话的游标若被静默接受，客户端就会以为"从这里继续"，而服务端实际
 * 会从 0 返回 —— 那正是 R208 要禁止的"重放已消费内容"。所以带 id 并校验。
 */
export function encodeCursor(conversationId: string, seq: number): string {
  return `conv:${conversationId}:${String(seq)}`;
}

export interface DecodedCursor {
  readonly conversationId: string;
  readonly seq: number;
}

/** 解码游标；形状不符或会话不符返回结构化失败（**不**回落到 0）。 */
export function decodeCursor(
  raw: string | null | undefined,
  conversationId: string,
): ConversationResult<DecodedCursor | null> {
  if (raw === null || raw === undefined || raw === '') {
    return conversationOk(null);
  }
  if (typeof raw !== 'string') {
    return conversationFail('invalid_cursor', '续取游标必须是字符串');
  }
  const prefix = 'conv:';
  if (!raw.startsWith(prefix)) {
    return conversationFail('invalid_cursor', `续取游标不是本服务签发的形状：${JSON.stringify(raw)}`);
  }
  const body = raw.slice(prefix.length);
  const split = body.lastIndexOf(':');
  if (split <= 0) {
    return conversationFail('invalid_cursor', `续取游标缺少序号段：${JSON.stringify(raw)}`);
  }
  const id = body.slice(0, split);
  const rawSeq = body.slice(split + 1);
  if (id !== conversationId) {
    return conversationFail(
      'cursor_conversation_mismatch',
      `续取游标属于会话 ${id}，而请求的是会话 ${conversationId}：不接受跨会话游标（那会让本会话从头重放）`,
    );
  }
  if (!/^\d+$/.test(rawSeq)) {
    return conversationFail('invalid_cursor', `续取游标的序号段不是非负整数：${JSON.stringify(rawSeq)}`);
  }
  return conversationOk({ conversationId: id, seq: Number.parseInt(rawSeq, 10) });
}

// ---------------------------------------------------------------------------
// 落盘编解码
// ---------------------------------------------------------------------------

export interface SerializedConversation {
  readonly schema: string;
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly messages: readonly ConversationMessage[];
  readonly events: readonly ConversationEvent[];
  readonly nextMessageSeq: number;
  readonly nextEventSeq: number;
}

export function encodeConversation(record: ConversationRecord): SerializedConversation {
  return {
    schema: CONVERSATION_SCHEMA,
    conversationId: record.conversationId,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived,
    messages: record.messages,
    events: record.events,
    nextMessageSeq: record.nextMessageSeq,
    nextEventSeq: record.nextEventSeq,
  };
}

/**
 * 一条**删除墓碑**的落盘形状（CHAT-08 持久化）。
 *
 * 它**不是**一个"空的会话记录"：`deleted: true` 是**字面量**，`messages` / `events`
 * 一个字段都没有 —— 读取方**不可能**把它当成"这个会话还在、只是没消息"。
 */
export interface SerializedTombstone {
  readonly schema: string;
  readonly conversationId: string;
  /** 字面量 `true`：墓碑的判据是**形状**，不是靠某个可选字段恰好为真。 */
  readonly deleted: true;
  readonly deletedAt: string;
}

export function encodeTombstone(conversationId: string, deletedAt: string): SerializedTombstone {
  return {
    schema: CONVERSATION_TOMBSTONE_SCHEMA,
    conversationId,
    deleted: true,
    deletedAt,
  };
}

/**
 * 识别墓碑。**三态**（与 `decodeCursor` 同一条纪律：不把"不是墓碑"与"墓碑坏了"压成同一个答案）：
 *
 * - `ok(null)` —— 这不是墓碑（schema 对不上）⇒ 调用方按普通记录走 `decodeConversation`；
 * - `ok(tombstone)` —— 形状完整的墓碑；
 * - `fail('unreadable')` —— **它自称是墓碑但字段不全**。这一条**不**回落成 `null`：
 *   回落会让它被 `decodeConversation` 拒绝、进而被报成 `conversation_unreadable`（503），
 *   而"墓碑坏了"与"会话读不回来"不是同一件事，必须能分开判。
 */
export function decodeTombstone(raw: unknown): ConversationResult<SerializedTombstone | null> {
  if (!isRecord(raw) || raw['schema'] !== CONVERSATION_TOMBSTONE_SCHEMA) {
    return conversationOk(null);
  }
  const conversationId = str(raw['conversationId']);
  const deletedAt = str(raw['deletedAt']);
  if (raw['deleted'] !== true || conversationId === null || conversationId === '' || deletedAt === null) {
    return conversationFail(
      'unreadable',
      '墓碑自称是本服务的删除标记，但字段不全（deleted / conversationId / deletedAt）',
    );
  }
  return conversationOk(Object.freeze({ schema: CONVERSATION_TOMBSTONE_SCHEMA, conversationId, deleted: true as const, deletedAt }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 严格解码：**任何一处不合规就整份拒绝**。
 *
 * 与 `src/storage/store-core.ts` 的 `decodeStoreState` 同一条纪律：静默丢掉坏条目
 * 会得到一份"看起来成功、实际缺件"的状态——比"读不回来"危险得多（R216/R220）。
 */
export function decodeConversation(raw: unknown): ConversationResult<ConversationRecord> {
  if (!isRecord(raw)) {
    return conversationFail('unreadable', '会话落盘状态不是对象');
  }
  if (raw['schema'] !== CONVERSATION_SCHEMA) {
    return conversationFail(
      'unreadable',
      `会话落盘 schema 不匹配：期望 ${CONVERSATION_SCHEMA}，实际 ${JSON.stringify(raw['schema'])}`,
    );
  }
  const conversationId = str(raw['conversationId']);
  if (conversationId === null || conversationId === '') {
    return conversationFail('unreadable', '会话落盘状态缺少 conversationId');
  }
  const name = str(raw['name']);
  const createdAt = str(raw['createdAt']);
  const updatedAt = str(raw['updatedAt']);
  if (name === null || createdAt === null || updatedAt === null) {
    return conversationFail('unreadable', `会话 ${conversationId} 落盘状态缺少 name / createdAt / updatedAt`);
  }
  const rawMessages = raw['messages'];
  const rawEvents = raw['events'];
  if (!Array.isArray(rawMessages) || !Array.isArray(rawEvents)) {
    return conversationFail('unreadable', `会话 ${conversationId} 落盘状态里 messages / events 不是数组`);
  }
  const nextMessageSeq = num(raw['nextMessageSeq']) ?? rawMessages.length + 1;
  const nextEventSeq = num(raw['nextEventSeq']) ?? rawEvents.length + 1;

  const messages: ConversationMessage[] = [];
  for (const item of rawMessages) {
    if (!isRecord(item)) {
      return conversationFail('unreadable', `会话 ${conversationId} 有一条消息不是对象`);
    }
    const messageId = str(item['messageId']);
    const role = str(item['role']);
    const state = str(item['state']);
    const phase = str(item['phase']);
    const seq = num(item['seq']);
    if (messageId === null || role === null || state === null || phase === null || seq === null) {
      return conversationFail('unreadable', `会话 ${conversationId} 的消息 ${String(messageId)} 字段不全`);
    }
    messages.push(
      Object.freeze({
        messageId,
        conversationId,
        role: role as ConversationRole,
        text: str(item['text']) ?? '',
        state: state as ConversationMessageState,
        phase: phase as ConversationPhase,
        seq,
        clientId: str(item['clientId']) ?? messageId,
        attempts: num(item['attempts']) ?? 0,
        createdAt: str(item['createdAt']) ?? createdAt,
        updatedAt: str(item['updatedAt']) ?? updatedAt,
        error: isRecord(item['error'])
          ? Object.freeze({
              code: str(item['error']['code']) ?? 'unknown',
              message: str(item['error']['message']) ?? '',
              retryable: item['error']['retryable'] === true,
            })
          : null,
        artifact: isRecord(item['artifact'])
          ? Object.freeze({
              artifactId: str(item['artifact']['artifactId']) ?? '',
              filename: str(item['artifact']['filename']) ?? '',
              sha256: str(item['artifact']['sha256']) ?? '',
              byteLength: num(item['artifact']['byteLength']) ?? 0,
              editRevision: num(item['artifact']['editRevision']) ?? 0,
              taskRevision: num(item['artifact']['taskRevision']) ?? 0,
              artifactVersion: num(item['artifact']['artifactVersion']) ?? 0,
              downloadPath: str(item['artifact']['downloadPath']) ?? '',
            })
          : null,
      }),
    );
  }

  const events: ConversationEvent[] = [];
  for (const item of rawEvents) {
    if (!isRecord(item)) {
      return conversationFail('unreadable', `会话 ${conversationId} 有一条事件不是对象`);
    }
    const seq = num(item['seq']);
    const eventId = str(item['eventId']);
    const kind = str(item['kind']);
    if (seq === null || eventId === null || kind === null) {
      return conversationFail('unreadable', `会话 ${conversationId} 的事件 ${String(eventId)} 字段不全`);
    }
    events.push(
      Object.freeze({
        seq,
        eventId,
        at: str(item['at']) ?? createdAt,
        kind,
        messageId: str(item['messageId']),
        state: str(item['state']) as ConversationMessageState | null,
        phase: str(item['phase']) as ConversationPhase | null,
        text: str(item['text']),
        detail: isRecord(item['detail']) ? Object.freeze({ ...item['detail'] }) as ConversationEvent['detail'] : null,
      }),
    );
  }

  return conversationOk(
    Object.freeze({
      conversationId,
      name,
      createdAt,
      updatedAt,
      archived: raw['archived'] === true,
      messages: Object.freeze(messages),
      events: Object.freeze(events),
      nextMessageSeq: Math.max(nextMessageSeq, ...messages.map((m) => m.seq + 1), 1),
      nextEventSeq: Math.max(nextEventSeq, ...events.map((e) => e.seq + 1), 1),
    }),
  );
}

// ---------------------------------------------------------------------------
// 持久化接缝
// ---------------------------------------------------------------------------

/**
 * 落盘上**一个会话槽位**里可能出现的两种形状。
 *
 * 同一 id 的落盘文件在生命周期里只会是二者之一：正常时的**会话记录**，
 * 或删除之后的**墓碑**（见 `delete`）。删除是**覆盖写同一个槽位**，因此不需要宿主
 * 多提供一个"删文件"的口 —— 落盘端口仍然是 `save` / `load` 两个方法就够。
 */
export type ConversationPersisted = SerializedConversation | SerializedTombstone;

/** 一个会话的落盘载体（按会话 id 分开；形状由本文件决定，介质由宿主决定）。 */
export interface ConversationPersistence {
  save(state: ConversationPersisted): void;
  load(): unknown;
}

/** 列出落盘上**存在**的会话 id（重启后重建内存态用）。 */
export interface ConversationDirectory {
  list(): readonly string[];
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------

export interface ConversationStoreOptions {
  readonly persistence: (conversationId: string) => ConversationPersistence;
  /** 落盘上有哪些会话（省略 = 不做启动恢复）。 */
  readonly directory?: ConversationDirectory;
  readonly now?: () => Date;
  readonly makeId?: (prefix: string) => string;
  readonly maxConversations?: number;
  readonly maxMessagesPerConversation?: number;
  readonly maxEventsPerConversation?: number;
}

export interface AcceptMessageInput {
  readonly conversationId: string;
  readonly clientId: string;
  readonly text: string;
}

export interface AcceptMessageOutcome {
  readonly message: ConversationMessage;
  /** `true` = 这个 clientId 之前就收过（**没有**新建消息、**没有**新建任务，R207）。 */
  readonly duplicate: boolean;
}

export interface EventsPage {
  readonly conversationId: string;
  readonly events: readonly ConversationEvent[];
  /** 本页最后一条事件的游标；没有新事件时就是**请求游标原值**（不前移）。 */
  readonly cursor: string;
  /** 是否还有更多（客户端可继续用新游标取）。 */
  readonly more: boolean;
  /** 仍未定局的消息（`phase` ∈ accepted/running）——续取时该被重放的对象。 */
  readonly pending: readonly ConversationMessage[];
}

interface LiveConversation {
  record: ConversationRecord;
}

export class ConversationStore {
  readonly #options: ConversationStoreOptions;
  readonly #now: () => Date;
  readonly #makeId: (prefix: string) => string;
  readonly #maxConversations: number;
  readonly #maxMessages: number;
  readonly #maxEvents: number;
  readonly #live = new Map<string, LiveConversation>();
  /** 启动恢复时读不回来的会话（**如实登记**，不是"没有"）。 */
  readonly #unreadable: { conversationId: string; reason: string }[] = [];
  /**
   * 落盘上有**删除墓碑**的会话（id → 删除时刻）。
   *
   * 为什么单独记一份而不是"看见墓碑就当没这回事"：`missingFromMemory()` 是启动自检的
   * 只读旁证，判据是"落盘上有、内存里没有" —— 墓碑**故意**不进内存，若不排除，
   * 每一次正常删除都会在启动自检里被报成一条恢复失败（把"删干净了"伪装成"出问题了"）。
   */
  readonly #tombstones = new Map<string, string>();

  constructor(options: ConversationStoreOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): Date => new Date());
    this.#makeId =
      options.makeId ??
      ((prefix: string): string => `${prefix}-${String(this.#live.size + 1)}-${this.#now().getTime().toString(36)}`);
    this.#maxConversations = options.maxConversations ?? CONVERSATION_LIMITS.maxConversations;
    this.#maxMessages = options.maxMessagesPerConversation ?? CONVERSATION_LIMITS.maxMessagesPerConversation;
    this.#maxEvents = options.maxEventsPerConversation ?? CONVERSATION_LIMITS.maxEventsPerConversation;
    this.#restoreFromDisk();
  }

  // --- 启动恢复（R216）----------------------------------------------------

  /**
   * 从落盘目录重建内存态。
   *
   * 读不回来的会话**不进内存**，但被记进 `unreadableConversations()` ——
   * 「这个会话存在但读不回来」与「没有这个会话」是两回事，不能混。
   */
  #restoreFromDisk(): void {
    const directory = this.#options.directory;
    if (directory === undefined) {
      return;
    }
    let ids: readonly string[];
    try {
      ids = directory.list();
    } catch (error) {
      this.#unreadable.push({ conversationId: '(目录)', reason: describe(error) });
      return;
    }
    for (const id of ids) {
      const loaded = this.#options.persistence(id).load();
      if (loaded === null || loaded === undefined) {
        this.#unreadable.push({ conversationId: id, reason: '落盘文件为空' });
        continue;
      }
      // **删除是持久的**：落盘上是墓碑 ⇒ 这个会话**不进内存** ⇒ `get` 404、列表里不出现。
      // 墓碑本身进 `#tombstones`（只读旁证用），**不**进 `#unreadable`：被删掉的会话
      // 不是"读不回来"，把它报成故障才是把删除伪装成数据丢失（R216/R240 的镜像陷阱）。
      const tombstone = decodeTombstone(loaded);
      if (!tombstone.ok) {
        this.#unreadable.push({ conversationId: id, reason: `${tombstone.code}: ${tombstone.message}` });
        continue;
      }
      if (tombstone.value !== null) {
        this.#tombstones.set(id, tombstone.value.deletedAt);
        continue;
      }
      const decoded = decodeConversation(loaded);
      if (!decoded.ok) {
        this.#unreadable.push({ conversationId: id, reason: `${decoded.code}: ${decoded.message}` });
        continue;
      }
      this.#live.set(id, { record: decoded.value });
    }
  }

  /** 启动时读不回来的会话（**只读旁证**；空数组 = 全部读回）。 */
  unreadableConversations(): readonly { readonly conversationId: string; readonly reason: string }[] {
    return Object.freeze([...this.#unreadable]);
  }

  /**
   * 落盘上有**删除墓碑**的会话（只读旁证；空数组 = 没有删除过的会话）。
   *
   * 「这个会话被删了」与「这个会话读不回来」是两件事，故各有各的读口：
   * 前者在这里，后者在 `unreadableConversations()`。
   */
  deletedConversations(): readonly { readonly conversationId: string; readonly deletedAt: string }[] {
    return Object.freeze(
      [...this.#tombstones].map(([conversationId, deletedAt]) => Object.freeze({ conversationId, deletedAt })),
    );
  }

  /**
   * 落盘上有、内存里没有的会话 id（恢复失败或超出上限的旁证）。
   *
   * **排除墓碑**：被删掉的会话本来就该不在内存里，把它列进来会把"删干净了"报成故障。
   */
  missingFromMemory(): readonly string[] {
    const directory = this.#options.directory;
    if (directory === undefined) {
      return Object.freeze([]);
    }
    return Object.freeze(directory.list().filter((id) => !this.#live.has(id) && !this.#tombstones.has(id)));
  }

  // --- 会话 ---------------------------------------------------------------

  createConversation(rawName?: string, explicitId?: string): ConversationResult<ConversationRecord> {
    if (this.#live.size >= this.#maxConversations) {
      return conversationFail(
        'conversation_limit_reached',
        `会话数已达上限 ${String(this.#maxConversations)}：请先删除不再使用的会话（不静默淘汰）`,
      );
    }
    const now = this.#now().toISOString();
    const fallback = `新会话 ${String(this.#live.size + 1)}`;
    const name = normalizeName(rawName, fallback);
    // **客户端可以指定会话 id**：网页侧的会话是 `conversation-store.js` 在本机建的
    // （`sess-xxxx`），服务端必须收下同一个 id，否则客户端的 message/cursor 无处归属。
    const conversationId = explicitId !== undefined ? explicitId : this.#makeId('conv');
    if (!isSafeIdentifier(conversationId)) {
      return conversationFail('invalid_conversation_id', `会话 id ${JSON.stringify(conversationId)} 不是合法标识符`);
    }
    const existing = this.#live.get(conversationId);
    if (existing !== undefined) {
      // 幂等：已经存在就原样返回（不覆盖名字、不清空消息）。
      return conversationOk(existing.record);
    }
    const record: ConversationRecord = Object.freeze({
      conversationId,
      name,
      createdAt: now,
      updatedAt: now,
      archived: false,
      messages: Object.freeze([]),
      events: Object.freeze([]),
      nextMessageSeq: 1,
      nextEventSeq: 1,
    });
    this.#live.set(conversationId, { record });
    // **显式重建一个曾删过的 id** ⇒ 墓碑被这次落盘覆盖、并从墓碑表里摘掉。
    // 口径：墓碑是"这个 id 现在是空的、别把它当会话带回来"，**不是**一枚永久毒丸
    // ——客户端重新开一个同 id 的会话是一次新的用户动作，服务端不该让它永远建不起来。
    this.#tombstones.delete(conversationId);
    this.#persist(conversationId);
    return conversationOk(record);
  }

  /** 重启后把某个落盘会话**拉回内存**（会话在盘上但内存里没有时）。 */
  rehydrate(conversationId: string): ConversationResult<ConversationRecord> {
    const live = this.#live.get(conversationId);
    if (live !== undefined) {
      return conversationOk(live.record);
    }
    if (this.#live.size >= this.#maxConversations) {
      return conversationFail('conversation_limit_reached', '会话数已达上限，无法再拉回一个会话');
    }
    const loaded = this.#options.persistence(conversationId).load();
    if (loaded === null || loaded === undefined) {
      return conversationFail('conversation_not_found', `运行目录里没有会话 ${conversationId} 的落盘状态`);
    }
    // 墓碑 ⇒ 这个会话是被**删掉**的，不是"可以被拉回来的"（否则删除又能被一次 rehydrate 撤销）。
    const tombstone = decodeTombstone(loaded);
    if (!tombstone.ok) {
      return conversationFail(tombstone.code, tombstone.message);
    }
    if (tombstone.value !== null) {
      this.#tombstones.set(conversationId, tombstone.value.deletedAt);
      return conversationFail(
        'conversation_not_found',
        `会话 ${conversationId} 在 ${tombstone.value.deletedAt} 被删除：不拉回已删除的会话`,
      );
    }
    const decoded = decodeConversation(loaded);
    if (!decoded.ok) {
      return conversationFail(decoded.code, decoded.message);
    }
    this.#live.set(conversationId, { record: decoded.value });
    return conversationOk(decoded.value);
  }

  list(): readonly ConversationSummary[] {
    const out = [...this.#live.values()].map((live) => summaryOf(live.record));
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return Object.freeze(out);
  }

  get(conversationId: string): ConversationRecord | undefined {
    return this.#live.get(conversationId)?.record;
  }

  has(conversationId: string): boolean {
    return this.#live.has(conversationId);
  }

  rename(conversationId: string, rawName: string): ConversationResult<ConversationRecord> {
    const name = rawName.trim();
    if (name === '') {
      return conversationFail('empty_name', '会话名不能为空');
    }
    return this.#patch(conversationId, (record) =>
      Object.freeze({ ...record, name: name.slice(0, CONVERSATION_LIMITS.maxNameChars) }),
    );
  }

  archive(conversationId: string, archived: boolean): ConversationResult<ConversationRecord> {
    return this.#patch(conversationId, (record) => Object.freeze({ ...record, archived }));
  }

  /**
   * **删除一个会话**（CHAT-08）：从内存摘除，并在落盘上留下一条**墓碑**。
   *
   * ## 为什么是墓碑而不是"把文件抹掉"（二选一里选了 (a)，理由）
   *
   * 1. **可审计**：盘上留得下"这个 id 在某时刻被删过"。文件抹掉之后，"从没存在过"
   *    与"被删了"在盘上**无法区分**，出了问题没人能复盘；
   * 2. **可解释**：墓碑是一份**有 schema 的、可读的**记录，用户/验证者能直接读懂
   *    "它被删了"，而"文件不见了"只能靠推断；
   * 3. **与"不假称撤销"的口径一致**：本服务的删除**不**撤销已发生的外部副作用
   *    （`ConversationDeleteOutcome.reverted` 是字面量 `false`）。墓碑把这条声明落到盘上：
   *    记录**还在**，只是被标记为"用户不要它了"——若把文件抹掉，反而会让盘上状态
   *    看起来像"这件事没发生过"；
   * 4. 落盘端口只需 `save` / `load` 两个方法（覆盖写同一个槽位），**不需要**宿主
   *    新开一个"删文件"的口。
   *
   * ## 不变量
   *
   * - **墓碑写不下去就不摘内存**：`save` 抛错 ⇒ 结构化 `delete_not_persisted`，内存原样保留。
   *   不这么做的后果是"内存里没了、盘上还在" —— 那正是本批要修的缺陷（重启后复活）。
   * - **删不存在的会话**：`conversation_not_found`，**不写任何东西**（无副作用）。
   * - 墓碑落盘后 ⇒ 本进程 `has`/`get` 都为假（HTTP 404）；**同运行目录重启后仍然 404**
   *   且不出现在 `list()` 里（`#restoreFromDisk` 认墓碑）。
   */
  delete(conversationId: string): ConversationResult<true> {
    if (!this.#live.has(conversationId)) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const deletedAt = this.#now().toISOString();
    try {
      this.#options.persistence(conversationId).save(encodeTombstone(conversationId, deletedAt));
    } catch (error) {
      return conversationFail(
        'delete_not_persisted',
        `会话 ${conversationId} 的删除墓碑写不下去（${describe(error)}）：` +
          '会话**没有**被删除（否则重启后它会带着已删的状态复活，或反过来留下一份读不回来的记录）',
      );
    }
    this.#live.delete(conversationId);
    this.#tombstones.set(conversationId, deletedAt);
    return conversationOk(true);
  }

  // --- 消息（R207 / R209）-------------------------------------------------

  /**
   * 收下一条用户消息。**幂等**：同一 `clientId` 第二次到达 ⇒ 返回既有那条（`duplicate: true`），
   * **不新建消息、不新建任务**（R207）。
   *
   * 同一 `clientId` 但正文不同 ⇒ 结构化 409（`idempotency_conflict`）——与
   * `POST /api/documents` 的同 ID 不同输入同一条纪律。
   */
  acceptMessage(input: AcceptMessageInput): ConversationResult<AcceptMessageOutcome> {
    const live = this.#live.get(input.conversationId);
    if (live === undefined) {
      return conversationFail('conversation_not_found', `没有会话 ${input.conversationId}`);
    }
    if (input.clientId.trim() === '') {
      return conversationFail('invalid_client_id', '缺少 clientId（幂等键）');
    }
    const text = input.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return conversationFail('empty_text', '消息正文不能为空');
    }
    if (text.length > CONVERSATION_LIMITS.maxTextChars) {
      return conversationFail(
        'text_too_long',
        `消息正文 ${String(text.length)} 字，超过上限 ${String(CONVERSATION_LIMITS.maxTextChars)} 字`,
      );
    }

    const existing = live.record.messages.find((message) => message.clientId === input.clientId);
    if (existing !== undefined) {
      if (existing.text !== text) {
        return conversationFail(
          'idempotency_conflict',
          '这个 clientId 已经用于另一条内容不同的消息：请换一个 clientId，或按原内容重发（重发不会新建任务）',
        );
      }
      return conversationOk(Object.freeze({ message: existing, duplicate: true }));
    }

    const now = this.#now().toISOString();
    // 消息 id **就是 clientId**（当它是合法标识符时）：客户端手里那条本地消息的 `id`
    // 与 `clientId` 在 `conversation-store.js` 里默认同值，服务器沿用同一个字符串，
    // 续取事件里带的 `messageId` 才能被客户端**原地更新**（否则它会以为在收新消息）。
    const messageId = isSafeIdentifier(input.clientId) ? input.clientId : this.#makeId('msg');
    const seq = live.record.nextMessageSeq;
    const message: ConversationMessage = Object.freeze({
      messageId,
      conversationId: input.conversationId,
      role: 'user',
      text,
      state: 'received',
      phase: 'accepted',
      seq,
      clientId: input.clientId,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
      artifact: null,
    });
    this.#write(live, {
      ...live.record,
      updatedAt: now,
      messages: trimMessages([...live.record.messages, message], this.#maxMessages),
      nextMessageSeq: seq + 1,
    });
    this.#appendEventInternal(live, {
      kind: 'message_accepted',
      messageId,
      state: 'received',
      phase: 'accepted',
      text: null,
      detail: { clientId: input.clientId, seq },
    });
    return conversationOk(Object.freeze({ message, duplicate: false }));
  }

  /** 追加一条助手消息（执行链产出；`phase` 由调用方按真实结局给）。 */
  appendAssistantMessage(
    conversationId: string,
    input: {
      readonly text: string;
      readonly state: ConversationMessageState;
      readonly phase: ConversationPhase;
      /** 显式 id（重试时**复用同一个助手消息**，不新建）；省略则自动生成。 */
      readonly messageId?: string;
      readonly error?: ConversationFailure | null;
      readonly artifact?: ConversationArtifactRef | null;
    },
  ): ConversationResult<ConversationMessage> {
    const live = this.#live.get(conversationId);
    if (live === undefined) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const now = this.#now().toISOString();
    const messageId = input.messageId ?? this.#makeId('amsg');
    const existing = live.record.messages.findIndex((m) => m.messageId === messageId);
    if (existing >= 0) {
      // 复用既有助手消息（重试路径）：原地更新，**不新增一条**。
      return this.updateMessage(conversationId, messageId, {
        text: input.text,
        state: input.state,
        phase: input.phase,
        error: input.error ?? null,
        artifact: input.artifact ?? null,
      });
    }
    const seq = live.record.nextMessageSeq;
    const message: ConversationMessage = Object.freeze({
      messageId,
      conversationId,
      role: 'assistant',
      text: input.text,
      state: input.state,
      phase: input.phase,
      seq,
      clientId: messageId,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      error: input.error ?? null,
      artifact: input.artifact ?? null,
    });
    this.#write(live, {
      ...live.record,
      updatedAt: now,
      messages: trimMessages([...live.record.messages, message], this.#maxMessages),
      nextMessageSeq: seq + 1,
    });
    return conversationOk(message);
  }

  /**
   * 就地更新一条消息（状态 / 正文 / 错误 / 产物）。
   *
   * **不改 messageId、不改 clientId、不改 seq**：这三条是幂等与顺序的锚点。
   */
  updateMessage(
    conversationId: string,
    messageId: string,
    patch: {
      readonly text?: string;
      readonly state?: ConversationMessageState;
      readonly phase?: ConversationPhase;
      readonly error?: ConversationFailure | null;
      readonly artifact?: ConversationArtifactRef | null;
      readonly bumpAttempts?: boolean;
    },
  ): ConversationResult<ConversationMessage> {
    const live = this.#live.get(conversationId);
    if (live === undefined) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const index = live.record.messages.findIndex((message) => message.messageId === messageId);
    if (index < 0) {
      return conversationFail('message_not_found', `会话 ${conversationId} 里没有消息 ${messageId}`);
    }
    const current = live.record.messages[index];
    if (current === undefined) {
      return conversationFail('message_not_found', `会话 ${conversationId} 里没有消息 ${messageId}`);
    }
    const now = this.#now().toISOString();
    const next: ConversationMessage = Object.freeze({
      ...current,
      text: patch.text ?? current.text,
      state: patch.state ?? current.state,
      phase: patch.phase ?? current.phase,
      attempts: patch.bumpAttempts === true ? current.attempts + 1 : current.attempts,
      error: patch.error === undefined ? current.error : patch.error,
      artifact: patch.artifact === undefined ? current.artifact : patch.artifact,
      updatedAt: now,
    });
    const messages = [...live.record.messages];
    messages[index] = next;
    this.#write(live, { ...live.record, updatedAt: now, messages: Object.freeze(messages) });
    return conversationOk(next);
  }

  message(conversationId: string, messageId: string): ConversationMessage | undefined {
    return this.#live
      .get(conversationId)
      ?.record.messages.find((message) => message.messageId === messageId);
  }

  /**
   * 重试一条**定局为失败或取消**的消息。
   *
   * 不变量（R207）：复用同一条消息、同一个 clientId；`attempts+1`；状态回 `received`/`accepted`。
   * **消息条数不变**——调用方可据此断言"重试没有新建任务"。
   */
  retryMessage(conversationId: string, messageId: string): ConversationResult<ConversationMessage> {
    const current = this.message(conversationId, messageId);
    if (current === undefined) {
      return conversationFail('message_not_found', `会话 ${conversationId} 里没有消息 ${messageId}`);
    }
    if (current.phase !== 'failed' && current.phase !== 'cancelled') {
      return conversationFail(
        'not_retryable',
        `消息 ${messageId} 当前是 ${current.phase}：只有失败或已取消的消息才能重试`,
      );
    }
    return this.updateMessage(conversationId, messageId, {
      state: 'received',
      phase: 'accepted',
      error: null,
      bumpAttempts: true,
    });
  }

  /** 取消一条尚未定局的消息。 */
  cancelMessage(conversationId: string, messageId: string): ConversationResult<ConversationMessage> {
    const current = this.message(conversationId, messageId);
    if (current === undefined) {
      return conversationFail('message_not_found', `会话 ${conversationId} 里没有消息 ${messageId}`);
    }
    if (current.phase === 'completed' || current.phase === 'cancelled') {
      return conversationFail('already_terminal', `消息 ${messageId} 已经是 ${current.phase}，无法再取消`);
    }
    return this.updateMessage(conversationId, messageId, { state: 'cancelled', phase: 'cancelled' });
  }

  // --- 事件与游标（R208）--------------------------------------------------

  /** 追加一条事件。`seq` 由本方法分配（**只增**）。 */
  appendEvent(
    conversationId: string,
    input: {
      readonly kind: string;
      readonly messageId?: string | null;
      readonly state?: ConversationMessageState | null;
      readonly phase?: ConversationPhase | null;
      readonly text?: string | null;
      readonly detail?: Readonly<Record<string, string | number | boolean | null>> | null;
    },
  ): ConversationResult<ConversationEvent> {
    const live = this.#live.get(conversationId);
    if (live === undefined) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    return conversationOk(this.#appendEventInternal(live, input));
  }

  /**
   * 取**严格大于**游标的事件（R208：不重放已消费内容）。
   *
   * 游标缺省（`null`）⇒ 从 0 起（客户端手里没有任何东西，第一次取全部是**正确**的，
   * 不是重放）。游标非法或跨会话 ⇒ 结构化拒绝，**不回落**。
   */
  eventsSince(conversationId: string, rawCursor: string | null | undefined): ConversationResult<EventsPage> {
    const live = this.#live.get(conversationId);
    if (live === undefined) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const cursor = decodeCursor(rawCursor, conversationId);
    if (!cursor.ok) {
      return cursor as ConversationResult<EventsPage>;
    }
    const from = cursor.value === null ? 0 : cursor.value.seq;
    const all = live.record.events.filter((event) => event.seq > from);
    const page = all.slice(0, CONVERSATION_LIMITS.maxEventsPerPage);
    const last = page.length > 0 ? page[page.length - 1] : undefined;
    return conversationOk(
      Object.freeze({
        conversationId,
        events: Object.freeze(page),
        // 没有新事件时**不前移**游标（前移会让客户端跳过一个尚未产生的事件区间）。
        cursor: last === undefined ? encodeCursor(conversationId, from) : encodeCursor(conversationId, last.seq),
        more: all.length > page.length,
        pending: Object.freeze(live.record.messages.filter((m) => m.phase === 'accepted' || m.phase === 'running')),
      }),
    );
  }

  /** 当前游标（会话末尾）。 */
  headCursor(conversationId: string): string {
    const live = this.#live.get(conversationId);
    const last = live?.record.events[live.record.events.length - 1];
    return encodeCursor(conversationId, last === undefined ? 0 : last.seq);
  }

  // --- 重启协调（R215/R216/R217）------------------------------------------

  /**
   * 启动时的诚实归位：把重启前**在途**的消息标成失败并说明原因。
   *
   * 为什么**不**自动重放（R217）：上一进程可能已经发出过模型请求、甚至已经写过盘——
   * 盲目重放会重复外部副作用。因此这里只做两件事：把状态如实改成
   * `failed`（`code='server_restarted'`, `retryable:true`），并补一条
   * `server_restarted` 事件；消息正文、clientId、attempts **一个都不丢**。
   *
   * @returns 被归位的消息（调用方据此在启动日志里如实报告"中断了几个"）。
   */
  reconcileAfterRestart(): readonly { readonly conversationId: string; readonly messageId: string }[] {
    const touched: { conversationId: string; messageId: string }[] = [];
    for (const [conversationId, live] of this.#live) {
      for (const message of live.record.messages) {
        if (message.phase !== 'accepted' && message.phase !== 'running') {
          continue;
        }
        this.updateMessage(conversationId, message.messageId, {
          state: 'failed',
          phase: 'failed',
          error: {
            code: 'server_restarted',
            message:
              '服务在本次执行完成前重启了：这条消息**没有被重放**（避免重复外部副作用），' +
              '它的正文与幂等键都还在，可以「重试这条」用同一条消息、同一个幂等键再跑一次。',
            retryable: true,
          },
        });
        this.appendEvent(conversationId, {
          kind: 'server_restarted',
          messageId: message.messageId,
          state: 'failed',
          phase: 'failed',
          detail: { attempts: message.attempts },
        });
        touched.push({ conversationId, messageId: message.messageId });
      }
    }
    return Object.freeze(touched);
  }

  // --- 内部 ---------------------------------------------------------------

  #patch(
    conversationId: string,
    mutate: (record: ConversationRecord) => ConversationRecord,
  ): ConversationResult<ConversationRecord> {
    const live = this.#live.get(conversationId);
    if (live === undefined) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const next = mutate(live.record);
    this.#write(live, { ...next, updatedAt: this.#now().toISOString() });
    return conversationOk(live.record);
  }

  #write(live: LiveConversation, record: ConversationRecord): void {
    live.record = record;
    this.#persist(record.conversationId);
  }

  #persist(conversationId: string): void {
    const live = this.#live.get(conversationId);
    if (live === undefined) {
      return;
    }
    try {
      this.#options.persistence(conversationId).save(encodeConversation(live.record));
    } catch {
      // 落盘失败**不改内存态**（与 conversation-store.js 同一条纪律）：
      // 内存里那份仍然可用，下一次写入会再试。失败会经 HTTP 层的读写核对暴露出来。
    }
  }

  #appendEventInternal(
    live: LiveConversation,
    input: {
      readonly kind: string;
      readonly messageId?: string | null;
      readonly state?: ConversationMessageState | null;
      readonly phase?: ConversationPhase | null;
      readonly text?: string | null;
      readonly detail?: Readonly<Record<string, string | number | boolean | null>> | null;
    },
  ): ConversationEvent {
    const seq = live.record.nextEventSeq;
    const event: ConversationEvent = Object.freeze({
      seq,
      eventId: `cevt-${live.record.conversationId}-${String(seq)}`,
      at: this.#now().toISOString(),
      kind: input.kind,
      messageId: input.messageId ?? null,
      state: input.state ?? null,
      phase: input.phase ?? null,
      text: input.text ?? null,
      detail: input.detail === undefined || input.detail === null ? null : Object.freeze({ ...input.detail }),
    });
    const events = [...live.record.events, event];
    const trimmed = events.length > this.#maxEvents ? events.slice(events.length - this.#maxEvents) : events;
    this.#write(live, { ...live.record, events: Object.freeze(trimmed), nextEventSeq: seq + 1 });
    return event;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function normalizeName(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? '').trim();
  const name = trimmed === '' ? fallback : trimmed;
  return name.slice(0, CONVERSATION_LIMITS.maxNameChars);
}

/** 消息上限：**从最旧开始截断**，但绝不截掉尚未定局的那几条（那会丢工作）。 */
function trimMessages(messages: readonly ConversationMessage[], limit: number): readonly ConversationMessage[] {
  if (messages.length <= limit) {
    return Object.freeze([...messages]);
  }
  const pending = messages.filter((m) => m.phase === 'accepted' || m.phase === 'running');
  const settled = messages.filter((m) => m.phase !== 'accepted' && m.phase !== 'running');
  const keepSettled = Math.max(0, limit - pending.length);
  const tail = settled.slice(Math.max(0, settled.length - keepSettled));
  return Object.freeze([...tail, ...pending]);
}

function summaryOf(record: ConversationRecord): ConversationSummary {
  const last = record.events[record.events.length - 1];
  return Object.freeze({
    conversationId: record.conversationId,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived,
    messageCount: record.messages.length,
    lastEventSeq: last === undefined ? 0 : last.seq,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 标识符形态（与 `http.ts` 的 `isIdentifier` 同一套字符集；用于安全地把 clientId 当消息 id）。 */
export function isSafeIdentifier(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CONVERSATION_LIMITS.maxIdentifierChars &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}
