/**
 * K04 连续对话 —— **消息 / 事件流的状态机**（幂等发送、重试、分页 / 搜索、跨进程恢复）。
 *
 * ## 这个模块回答什么
 *
 * 一条会话里发生过什么：用户发了什么、助手回到哪一步、业务侧跑到哪一态。
 * 三条纪律：
 *
 * 1. **幂等发送**：同一 `clientId` 重发 ⇒ 返回**原消息**、`duplicate:true`、**不再起一次执行**。
 *    重试复用**同一条消息与同一个 `clientId`**，因此"重试不重复建任务"在数据里成立
 *    （不是靠调用方自觉）。
 * 2. **游标只增**：消息与事件各一条单调 `seq`；`eventsSince` 取**严格大于**游标的项，
 *    已消费内容不被重放。
 * 3. **读不回来不算空**：落盘快照形状不符 ⇒ **整份拒绝**并登记原因，内存保持空
 *    （绝不把坏快照的一半塞进来）。
 *
 * ## 零 IO / 零墙钟 / 零随机
 *
 * 时间由注入的 `now()` 提供（默认是一支**确定性逻辑钟**，起点 1970、每次 +1s——
 * **绝不读系统时间**）；id 由注入的 `makeId` 或计数生成。落盘由 {@link MobileConversationPersistencePort}
 * 承担，本文件不认识文件系统。
 *
 * ## 跨进程续聊（P0 的接口面）
 *
 * 重启后的正确用法是：`new MobileConversationStore({ persistence })` —— 构造即从持久端口
 * 读回全部会话，**不需要先 GET**。之后直接 `send(conversationId, ...)` 就落在正确的会话上。
 * "当前文档版本"由 {@link ./resume.js} 的 `ConversationResumeLedger` 承接（版本字段来自产物
 * 登记处，不来自进程内缓存）。本文件只保证**消息 / 事件流**跨进程连续。
 */

import {
  continuityFail,
  continuityOk,
  describeContinuityError,
  type ContinuityResult,
} from './errors.js';

import {
  MOBILE_CONVERSATION_SCHEMA,
  MOBILE_MESSAGE_PAGE_SIZE,
  RETRYABLE_PHASES,
  type MobileConversationEvent,
  type MobileConversationMessage,
  type MobileConversationPersistencePort,
  type MobileConversationRecord,
  type MobileConversationSummary,
  type MobileMessageHit,
  type MobileMessageListQuery,
  type MobileMessagePage,
  type MobileMessagePhase,
  type MobileMessageRole,
  type MobileMessageSearchQuery,
  type MobileMessageState,
  type MobileSendOutcome,
} from './types.js';

// ---------------------------------------------------------------------------
// 确定性逻辑钟（默认；**不读墙钟**）
// ---------------------------------------------------------------------------

/**
 * 一支确定性的逻辑钟：从 `1970-01-01T00:00:00.000Z` 起，每次调用推进 `stepMs`。
 * 存在的意义是让"没有注入时钟"的装配也能跑，且**逐次可复现**——产品路径应注入真实时钟
 * （由 K01 的运行时端口提供），本默认值只为测试 / 沙箱服务。
 */
export function createLogicalIsoClock(stepMs = 1000, startMs = 0): () => string {
  let current = startMs;
  return (): string => {
    const value = current;
    current += stepMs;
    return new Date(value).toISOString();
  };
}

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

export interface MobileConversationStoreOptions {
  /** 持久端口。不传 ⇒ 内存态（可跑，但**刷新后不保证还在**）。 */
  readonly persistence?: MobileConversationPersistencePort | null;
  /** 注入时钟（返回产品侧 ISO，UTC + 毫秒）。缺省用确定性逻辑钟。 */
  readonly now?: () => string;
  /** 默认消息 / 事件 id 生成器（测试可注入确定值）。 */
  readonly makeId?: (kind: 'message' | 'event', sequence: number) => string;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export class MobileConversationStore {
  readonly #persistence: MobileConversationPersistencePort | null;
  readonly #now: () => string;
  readonly #makeId: (kind: 'message' | 'event', sequence: number) => string;
  readonly #records = new Map<string, MobileConversationRecord>();
  #sequence = 0;
  /** 读不回来的原因（`null` = 干净启动；非空 = 如实登记，**不当作"没有"**）。 */
  #unreadable: string | null = null;

  constructor(options: MobileConversationStoreOptions = {}) {
    this.#persistence = options.persistence ?? null;
    this.#now = options.now ?? createLogicalIsoClock();
    this.#makeId =
      options.makeId ??
      ((kind, sequence) => `${kind === 'message' ? 'm' : 'e'}-${String(sequence)}`);
    this.#restore();
  }

  // --- 就绪与恢复 ---------------------------------------------------------

  /** 读回快照非法时的原因（`null` = 干净启动或端口未注入）。 */
  unreadableReason(): string | null {
    return this.#unreadable;
  }

  /** 从持久端口恢复（**全量**）。形状不符 ⇒ 整份拒绝，内存保持空。 */
  #restore(): void {
    const port = this.#persistence;
    if (port === null) {
      return;
    }
    let raw: unknown;
    try {
      raw = port.loadAll();
    } catch (error) {
      this.#unreadable = `端口 loadAll() 抛错：${describeContinuityError(error)}`;
      return;
    }
    if (raw === null || raw === undefined) {
      return; // 首次运行：没有快照 = 干净启动，不是"读不回来"
    }
    const decoded = decodeConversationRecords(raw);
    if (!decoded.ok) {
      this.#unreadable = `${decoded.error.code}: ${decoded.error.message}`;
      return;
    }
    for (const record of decoded.value) {
      this.#records.set(record.conversationId, record);
    }
    // 序号接着已用最大值走，避免重开后新建 id 与旧 id 相撞。
    let maxSeq = 0;
    for (const record of this.#records.values()) {
      maxSeq = Math.max(maxSeq, record.nextMessageSeq - 1, record.nextEventSeq - 1);
    }
    this.#sequence = maxSeq;
  }

  // --- 会话生命周期 -------------------------------------------------------

  createConversation(input: {
    readonly conversationId: string;
    readonly title?: string;
    readonly at?: string;
  }): ContinuityResult<MobileConversationRecord> {
    const id = input.conversationId;
    if (typeof id !== 'string' || id.trim().length === 0) {
      return continuityFail('invalid_input', '会话 id 不能为空');
    }
    if (this.#records.has(id)) {
      return continuityFail('invalid_input', `会话 ${id} 已存在（不覆盖、不清空）`);
    }
    const at = input.at ?? this.#now();
    const record: MobileConversationRecord = Object.freeze({
      schema: MOBILE_CONVERSATION_SCHEMA,
      conversationId: id,
      title: (input.title ?? `会话 ${String(this.#records.size + 1)}`).trim() || `会话 ${String(this.#records.size + 1)}`,
      createdAt: at,
      updatedAt: at,
      archived: false,
      messages: Object.freeze([]),
      events: Object.freeze([]),
      nextMessageSeq: 1,
      nextEventSeq: 1,
    });
    this.#records.set(id, record);
    this.#persist(record);
    return continuityOk(record);
  }

  has(conversationId: string): boolean {
    return this.#records.has(conversationId);
  }

  getConversation(conversationId: string): MobileConversationRecord | null {
    return this.#records.get(conversationId) ?? null;
  }

  listConversations(): readonly MobileConversationSummary[] {
    return Object.freeze(
      [...this.#records.values()]
        .sort((a, b) => (a.updatedAt === b.updatedAt ? compareIds(a.conversationId, b.conversationId) : a.updatedAt < b.updatedAt ? 1 : -1))
        .map((record) => summarize(record)),
    );
  }

  archiveConversation(conversationId: string, archived: boolean, at?: string): ContinuityResult<MobileConversationRecord> {
    const record = this.#records.get(conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const next = Object.freeze({ ...record, archived, updatedAt: at ?? this.#now() });
    this.#records.set(conversationId, next);
    this.#persist(next);
    return continuityOk(next);
  }

  // --- 幂等发送 -----------------------------------------------------------

  /**
   * 收下一条用户消息。
   *
   * 幂等口径同 R207：同一 `clientId` 重发 ⇒ **返回既有消息、`duplicate:true`、`started:false`**，
   * 消息条数与事件均**不**增长（重复命令返回原结果，不是"再记一次"）。
   */
  send(input: {
    readonly conversationId: string;
    readonly clientId: string;
    readonly text: string;
    readonly at?: string;
  }): ContinuityResult<MobileSendOutcome> {
    const record = this.#records.get(input.conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${input.conversationId}`);
    }
    if (typeof input.clientId !== 'string' || input.clientId.trim().length === 0) {
      return continuityFail('invalid_input', 'clientId 不能为空（幂等键缺失会让重发变成重复消息）');
    }
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      return continuityFail('invalid_input', '消息正文不能为空');
    }
    const existing = record.messages.find((message) => message.clientId === input.clientId);
    if (existing !== undefined) {
      return continuityOk(Object.freeze({ message: existing, duplicate: true, started: false }));
    }
    const at = input.at ?? this.#now();
    const sequence = record.nextMessageSeq;
    const messageId = this.#makeId('message', this.#bump());
    const message: MobileConversationMessage = Object.freeze({
      messageId,
      conversationId: record.conversationId,
      role: 'user',
      text: input.text,
      state: 'received',
      phase: 'accepted',
      seq: sequence,
      clientId: input.clientId,
      attempts: 1,
      createdAt: at,
      updatedAt: at,
      error: null,
    });
    const event = this.#makeEvent(record.nextEventSeq, at, 'run_requested', messageId, 'received', 'accepted', {
      attempts: 1,
    });
    const next: MobileConversationRecord = Object.freeze({
      ...record,
      updatedAt: at,
      messages: Object.freeze([...record.messages, message]),
      events: Object.freeze([...record.events, event]),
      nextMessageSeq: sequence + 1,
      nextEventSeq: record.nextEventSeq + 1,
    });
    this.#records.set(record.conversationId, next);
    this.#persist(next);
    return continuityOk(Object.freeze({ message, duplicate: false, started: true }));
  }

  /**
   * 重试一条失败 / 取消的消息。
   *
   * **复用同一条消息与同一个 `clientId`**（`attempts + 1`），因此不会重复建任务；
   * 非 `failed` / `cancelled` 阶段 ⇒ `not_retryable`（把在跑的再跑一遍会造成重复副作用）。
   */
  retry(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly at?: string;
  }): ContinuityResult<MobileConversationMessage> {
    const record = this.#records.get(input.conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${input.conversationId}`);
    }
    const index = record.messages.findIndex((message) => message.messageId === input.messageId);
    if (index === -1) {
      return continuityFail('message_not_found', `会话 ${input.conversationId} 里没有消息 ${input.messageId}`);
    }
    const message = record.messages[index] as MobileConversationMessage;
    if (!RETRYABLE_PHASES.includes(message.phase)) {
      return continuityFail(
        'not_retryable',
        `消息 ${message.messageId} 当前阶段是 ${message.phase}：只有 failed / cancelled 可以重试`,
      );
    }
    const at = input.at ?? this.#now();
    const updated: MobileConversationMessage = Object.freeze({
      ...message,
      state: 'received',
      phase: 'accepted',
      attempts: message.attempts + 1,
      updatedAt: at,
      error: null,
    });
    const messages = [...record.messages];
    messages[index] = updated;
    const event = this.#makeEvent(record.nextEventSeq, at, 'run_retried', message.messageId, 'received', 'accepted', {
      attempts: updated.attempts,
    });
    const next: MobileConversationRecord = Object.freeze({
      ...record,
      updatedAt: at,
      messages: Object.freeze(messages),
      events: Object.freeze([...record.events, event]),
      nextEventSeq: record.nextEventSeq + 1,
    });
    this.#records.set(record.conversationId, next);
    this.#persist(next);
    return continuityOk(updated);
  }

  /** 把某条消息标为失败（消息自身状态推进；用于真实执行链回报）。 */
  failMessage(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly code: string;
    readonly message: string;
    readonly at?: string;
  }): ContinuityResult<MobileConversationMessage> {
    const at = input.at ?? this.#now();
    return this.#mutateMessage(input.conversationId, input.messageId, (message) =>
      Object.freeze({
        ...message,
        state: 'failed' as MobileMessageState,
        phase: 'failed' as MobileMessagePhase,
        updatedAt: at,
        error: Object.freeze({ code: input.code, message: input.message }),
      }),
    );
  }

  /** 助手消息完成。 */
  completeMessage(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly text: string;
    readonly at?: string;
  }): ContinuityResult<MobileConversationMessage> {
    const at = input.at ?? this.#now();
    return this.#mutateMessage(input.conversationId, input.messageId, (message) =>
      Object.freeze({
        ...message,
        text: input.text,
        state: 'completed' as MobileMessageState,
        phase: 'completed' as MobileMessagePhase,
        updatedAt: at,
      }),
    );
  }

  /** 追加一条助手消息（`role=assistant`，初始 `running`）。id 由用户消息 id 派生。 */
  appendAssistant(input: {
    readonly conversationId: string;
    readonly userMessageId: string;
    readonly at?: string;
  }): ContinuityResult<MobileConversationMessage> {
    const record = this.#records.get(input.conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${input.conversationId}`);
    }
    const at = input.at ?? this.#now();
    const sequence = record.nextMessageSeq;
    const message: MobileConversationMessage = Object.freeze({
      messageId: `${input.userMessageId}-assistant`,
      conversationId: record.conversationId,
      role: 'assistant',
      text: '',
      state: 'streaming',
      phase: 'running',
      seq: sequence,
      clientId: `${input.userMessageId}-assistant`,
      attempts: 1,
      createdAt: at,
      updatedAt: at,
      error: null,
    });
    const next: MobileConversationRecord = Object.freeze({
      ...record,
      updatedAt: at,
      messages: Object.freeze([...record.messages, message]),
      nextMessageSeq: sequence + 1,
    });
    this.#records.set(record.conversationId, next);
    this.#persist(next);
    return continuityOk(message);
  }

  // --- 查询 / 分页 / 搜索 -------------------------------------------------

  /** 按 `seq` **升序**分页取消息。 */
  listMessages(conversationId: string, query: MobileMessageListQuery = {}): ContinuityResult<MobileMessagePage> {
    const record = this.#records.get(conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    return continuityOk(paginate(record.messages, query));
  }

  /** 跨会话搜索消息正文（大小写不敏感），可限定会话。命中按会话 `updatedAt` 降序、再按 `seq` 升序。 */
  searchMessages(query: MobileMessageSearchQuery = {}): readonly MobileMessageHit[] {
    const needle = (query.query ?? '').trim().toLowerCase();
    const hits: MobileMessageHit[] = [];
    const records = [...this.#records.values()].sort((a, b) =>
      a.updatedAt === b.updatedAt ? compareIds(a.conversationId, b.conversationId) : a.updatedAt < b.updatedAt ? 1 : -1,
    );
    for (const record of records) {
      if (query.conversationId !== undefined && query.conversationId !== record.conversationId) {
        continue;
      }
      for (const message of record.messages) {
        if (needle !== '' && !message.text.toLowerCase().includes(needle)) {
          continue;
        }
        hits.push(
          Object.freeze({
            conversationId: record.conversationId,
            messageId: message.messageId,
            seq: message.seq,
            role: message.role,
            text: message.text,
          }),
        );
      }
    }
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize, hits.length || MOBILE_MESSAGE_PAGE_SIZE);
    const start = (page - 1) * pageSize;
    return Object.freeze(hits.slice(start, start + pageSize));
  }

  /** 续取事件：**严格大于** `since` 的项（已消费内容不重放）。 */
  eventsSince(conversationId: string, since: number): ContinuityResult<readonly MobileConversationEvent[]> {
    const record = this.#records.get(conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const cursor = Number.isFinite(since) ? since : 0;
    return continuityOk(Object.freeze(record.events.filter((event) => event.seq > cursor)));
  }

  /** 全部已加载会话的 id（恢复后即为持久里的会话）。 */
  conversationIds(): readonly string[] {
    return Object.freeze([...this.#records.keys()]);
  }

  // --- 内部 ---------------------------------------------------------------

  #mutateMessage(
    conversationId: string,
    messageId: string,
    mutate: (message: MobileConversationMessage) => MobileConversationMessage,
  ): ContinuityResult<MobileConversationMessage> {
    const record = this.#records.get(conversationId);
    if (record === undefined) {
      return continuityFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    const index = record.messages.findIndex((message) => message.messageId === messageId);
    if (index === -1) {
      return continuityFail('message_not_found', `会话 ${conversationId} 里没有消息 ${messageId}`);
    }
    const updated = mutate(record.messages[index] as MobileConversationMessage);
    const messages = [...record.messages];
    messages[index] = updated;
    const next: MobileConversationRecord = Object.freeze({
      ...record,
      updatedAt: updated.updatedAt,
      messages: Object.freeze(messages),
    });
    this.#records.set(conversationId, next);
    this.#persist(next);
    return continuityOk(updated);
  }

  #makeEvent(
    seq: number,
    at: string,
    kind: string,
    messageId: string | null,
    state: MobileMessageState | null,
    phase: MobileMessagePhase | null,
    detail: Readonly<Record<string, string | number | boolean | null>> | null,
  ): MobileConversationEvent {
    return Object.freeze({
      seq,
      eventId: this.#makeId('event', this.#bump()),
      at,
      kind,
      messageId,
      state,
      phase,
      detail: detail === null ? null : Object.freeze({ ...detail }),
    });
  }

  #bump(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #persist(record: MobileConversationRecord): void {
    if (this.#persistence !== null) {
      this.#persistence.save(record);
    }
  }
}

// ---------------------------------------------------------------------------
// 形状核对（读回侧；端口不负责验证）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MESSAGE_STATES: readonly string[] = ['sending', 'received', 'streaming', 'completed', 'failed', 'cancelled'];
const MESSAGE_PHASES: readonly string[] = ['accepted', 'running', 'completed', 'failed', 'cancelled'];
const MESSAGE_ROLES: readonly string[] = ['user', 'assistant', 'system'];

/**
 * 核对一批会话记录。**任一字段不符即整份拒绝**（返回失败，调用方不得半数采用）。
 * 不做"猜测性修补"（缺字段补默认值会让坏快照看起来合法）。
 */
export function decodeConversationRecords(raw: unknown): ContinuityResult<readonly MobileConversationRecord[]> {
  if (!Array.isArray(raw)) {
    return continuityFail('state_unreadable', '落盘快照不是数组（expected MobileConversationRecord[]）');
  }
  const records: MobileConversationRecord[] = [];
  for (const entry of raw) {
    const decoded = decodeConversationRecord(entry);
    if (!decoded.ok) {
      return decoded as ContinuityResult<readonly MobileConversationRecord[]>;
    }
    records.push(decoded.value);
  }
  return continuityOk(Object.freeze(records));
}

/** 核对一条会话记录。 */
export function decodeConversationRecord(raw: unknown): ContinuityResult<MobileConversationRecord> {
  if (!isPlainObject(raw)) {
    return continuityFail('state_unreadable', '会话记录不是对象');
  }
  if (raw['schema'] !== MOBILE_CONVERSATION_SCHEMA) {
    return continuityFail(
      'state_unreadable',
      `会话记录 schema 不符（期望 ${MOBILE_CONVERSATION_SCHEMA}，收到 ${JSON.stringify(raw['schema'])}）`,
    );
  }
  const conversationId = raw['conversationId'];
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    return continuityFail('state_unreadable', 'conversationId 非法');
  }
  for (const field of ['title', 'createdAt', 'updatedAt'] as const) {
    if (typeof raw[field] !== 'string') {
      return continuityFail('state_unreadable', `会话 ${conversationId} 的 ${field} 不是字符串`);
    }
  }
  if (typeof raw['archived'] !== 'boolean') {
    return continuityFail('state_unreadable', `会话 ${conversationId} 的 archived 不是布尔`);
  }
  if (!isPositiveInteger(raw['nextMessageSeq']) || !isPositiveInteger(raw['nextEventSeq'])) {
    return continuityFail('state_unreadable', `会话 ${conversationId} 的下一个序号非法`);
  }
  const rawMessages = raw['messages'];
  const rawEvents = raw['events'];
  if (!Array.isArray(rawMessages) || !Array.isArray(rawEvents)) {
    return continuityFail('state_unreadable', `会话 ${conversationId} 的 messages / events 不是数组`);
  }
  const messages: MobileConversationMessage[] = [];
  for (const entry of rawMessages) {
    const decoded = decodeMessage(entry, conversationId);
    if (!decoded.ok) return decoded as ContinuityResult<MobileConversationRecord>;
    messages.push(decoded.value);
  }
  const events: MobileConversationEvent[] = [];
  for (const entry of rawEvents) {
    const decoded = decodeEvent(entry, conversationId);
    if (!decoded.ok) return decoded as ContinuityResult<MobileConversationRecord>;
    events.push(decoded.value);
  }
  return continuityOk(
    Object.freeze({
      schema: MOBILE_CONVERSATION_SCHEMA,
      conversationId,
      title: raw['title'] as string,
      createdAt: raw['createdAt'] as string,
      updatedAt: raw['updatedAt'] as string,
      archived: raw['archived'],
      messages: Object.freeze(messages),
      events: Object.freeze(events),
      nextMessageSeq: raw['nextMessageSeq'] as number,
      nextEventSeq: raw['nextEventSeq'] as number,
    }),
  );
}

function decodeMessage(raw: unknown, conversationId: string): ContinuityResult<MobileConversationMessage> {
  if (!isPlainObject(raw)) {
    return continuityFail('state_unreadable', `会话 ${conversationId} 的消息不是对象`);
  }
  const messageId = raw['messageId'];
  const role = raw['role'];
  const text = raw['text'];
  const state = raw['state'];
  const phase = raw['phase'];
  const clientId = raw['clientId'];
  if (typeof messageId !== 'string' || messageId === '') {
    return continuityFail('state_unreadable', `会话 ${conversationId} 有消息缺 messageId`);
  }
  if (typeof role !== 'string' || !MESSAGE_ROLES.includes(role)) {
    return continuityFail('state_unreadable', `消息 ${messageId} 的 role 非法`);
  }
  if (typeof text !== 'string') {
    return continuityFail('state_unreadable', `消息 ${messageId} 的 text 不是字符串`);
  }
  if (typeof state !== 'string' || !MESSAGE_STATES.includes(state)) {
    return continuityFail('state_unreadable', `消息 ${messageId} 的 state 非法`);
  }
  if (typeof phase !== 'string' || !MESSAGE_PHASES.includes(phase)) {
    return continuityFail('state_unreadable', `消息 ${messageId} 的 phase 非法`);
  }
  if (typeof clientId !== 'string' || clientId === '') {
    return continuityFail('state_unreadable', `消息 ${messageId} 的 clientId（幂等键）非法`);
  }
  if (!isPositiveInteger(raw['seq']) || !isPositiveInteger(raw['attempts'])) {
    return continuityFail('state_unreadable', `消息 ${messageId} 的 seq / attempts 非法`);
  }
  if (typeof raw['createdAt'] !== 'string' || typeof raw['updatedAt'] !== 'string') {
    return continuityFail('state_unreadable', `消息 ${messageId} 的时间戳非法`);
  }
  const rawError = raw['error'];
  let error: { readonly code: string; readonly message: string } | null = null;
  if (rawError !== null && rawError !== undefined) {
    if (!isPlainObject(rawError) || typeof rawError['code'] !== 'string' || typeof rawError['message'] !== 'string') {
      return continuityFail('state_unreadable', `消息 ${messageId} 的 error 形状非法`);
    }
    error = Object.freeze({ code: rawError['code'], message: rawError['message'] });
  }
  return continuityOk(
    Object.freeze({
      messageId,
      conversationId,
      role: role as MobileMessageRole,
      text,
      state: state as MobileMessageState,
      phase: phase as MobileMessagePhase,
      seq: raw['seq'] as number,
      clientId,
      attempts: raw['attempts'] as number,
      createdAt: raw['createdAt'] as string,
      updatedAt: raw['updatedAt'] as string,
      error,
    }),
  );
}

function decodeEvent(raw: unknown, conversationId: string): ContinuityResult<MobileConversationEvent> {
  if (!isPlainObject(raw)) {
    return continuityFail('state_unreadable', `会话 ${conversationId} 的事件不是对象`);
  }
  if (!isPositiveInteger(raw['seq']) || typeof raw['eventId'] !== 'string' || raw['eventId'] === '') {
    return continuityFail('state_unreadable', `会话 ${conversationId} 有事件缺 seq / eventId`);
  }
  if (typeof raw['at'] !== 'string' || typeof raw['kind'] !== 'string') {
    return continuityFail('state_unreadable', `事件 ${String(raw['eventId'])} 的 at / kind 非法`);
  }
  const messageId = raw['messageId'];
  if (messageId !== null && typeof messageId !== 'string') {
    return continuityFail('state_unreadable', `事件 ${String(raw['eventId'])} 的 messageId 非法`);
  }
  const state = raw['state'];
  const phase = raw['phase'];
  if (state !== null && (typeof state !== 'string' || !MESSAGE_STATES.includes(state))) {
    return continuityFail('state_unreadable', `事件 ${String(raw['eventId'])} 的 state 非法`);
  }
  if (phase !== null && (typeof phase !== 'string' || !MESSAGE_PHASES.includes(phase))) {
    return continuityFail('state_unreadable', `事件 ${String(raw['eventId'])} 的 phase 非法`);
  }
  const detail = raw['detail'];
  if (detail !== null && detail !== undefined && !isPlainObject(detail)) {
    return continuityFail('state_unreadable', `事件 ${String(raw['eventId'])} 的 detail 不是对象`);
  }
  return continuityOk(
    Object.freeze({
      seq: raw['seq'] as number,
      eventId: raw['eventId'] as string,
      at: raw['at'] as string,
      kind: raw['kind'] as string,
      messageId: (messageId ?? null) as string | null,
      state: (state ?? null) as MobileMessageState | null,
      phase: (phase ?? null) as MobileMessagePhase | null,
      detail: detail === null || detail === undefined ? null : Object.freeze({ ...(detail as Record<string, string | number | boolean | null>) }),
    }),
  );
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function summarize(record: MobileConversationRecord): MobileConversationSummary {
  return Object.freeze({
    conversationId: record.conversationId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived,
    messageCount: record.messages.length,
  });
}

function paginate(messages: readonly MobileConversationMessage[], query: MobileMessageListQuery): MobileMessagePage {
  const all = [...messages].sort((a, b) => a.seq - b.seq);
  const pageSize = normalizePageSize(query.pageSize, MOBILE_MESSAGE_PAGE_SIZE);
  const total = all.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(normalizePage(query.page), maxPage);
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return Object.freeze({
    items: Object.freeze(items),
    page,
    page_size: pageSize,
    total,
    has_more: start + items.length < total,
  });
}

function normalizePage(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) {
    return 1;
  }
  return Math.floor(raw);
}

function normalizePageSize(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) {
    return fallback;
  }
  return Math.floor(raw);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 助手消息 id 由用户消息 id 派生：重试复用同一条助手消息，不会越积越多。 */
export function assistantIdOf(userMessageId: string): string {
  return `${userMessageId}-assistant`;
}
