/**
 * **会话模型**（CHAT-02；完整能力目录 2026-10-03）。
 *
 * ## 这个模块回答什么
 *
 * 一个自然语言入口下会有**许多会话**。用户要能：**新建 / 切换 / 重命名 / 归档 / 删除**，
 * 历史要**持久化**（重开 App 后还在），列表要能**分页与搜索**。最重要的一条纪律是：
 *
 * > **会话之间不串任务、不串记忆**——A 会话的任务引用与记忆引用**只**归 A。
 *
 * ## 纪律（与仓库其余部分一致）
 *
 * - **零 IO、零墙钟、零随机数**：时间由调用方经 `LogicalTime` 传入；落盘由**注入的
 *   持久端口**承担（{@link ConversationPersistencePort}）。本文件不认识文件系统。
 * - **产品路径无端口即未就绪**：`createConversationSessions({ persistence: null })`
 *   仍然可以跑（内存态），但 {@link ConversationSessions.readiness} 会**如实**返回
 *   `ready: false / reason: 'no_persistence_port'`——**不假装**刷新后还在。
 * - **失败不编造**：每个动作返回结构化结果（`ok: false` 带机器可判的 `code`），
 *   失败分支**不携带半成品值**（`ConversationResult<T>` 的两个分支互斥）。
 * - **读不回来不算空**：落盘形状不符 schema / 非法时，`unreadableReason()` 会**如实**记录，
 *   而不是静默按"一个会话都没有"启动（"读不回来"与"没有"是两回事）。
 *
 * ## 与产品会话存储的分工（**已登记**：适配层是唯一映射）
 *
 * 宿主侧 `apps/demo/server/conversation-store.ts`（落盘 schema `potbot-conversation-store.v1`，
 * FA-N）与本模型是**两个不同的关注点**，不是同一个模型的两种实现：
 *
 * - **它**管一条会话里的**消息 / 事件流**：正文、单调 `seq`、幂等键 `clientId`、续取游标、
 *   R209 五态、重启归位；
 * - **本模型**管**会话集合与任务 / 记忆归属**：`active_id`、分页 / 搜索、`task_refs` /
 *   `memory_refs` 的跨会话隔离。本层**不存正文**（只有 `message_count`）。
 *
 * 重叠的只有**会话头**（id / 名字 / 创建·更新时间 / 归档位），原先两套表示互不相通。
 * 那一块的**唯一映射**是 {@link ./adapter-to-store.js}：产品 record → 本模型 session 是
 * **有损投影**（丢正文与事件，留会话头 + 条数），反向只能还原 5 个会话头字段——正文与事件
 * 必须由产品侧自带。任一方向漂移都会被 `adapter-to-store.test.ts` 与宿主侧
 * `conversation-store.test.ts` 钉住（含"映射故意错一项必须变红"的反向对照）。
 *
 * ⚠️ **产品路径尚未接线**：`conversation-host.ts` 仍只走产品 store，本文件在**产品上的可达性
 * 目前为零**（只有测试与适配层引用它）。适配层证明的是"两端**能**互通"，**不**等于
 * "产品已经在用本模型"——后者的接线方案记在交付说明里，**未接线 = 未验证**。
 *
 * ## 不做的事
 *
 * 不执行任务、不产文件、不发请求（那些在 {@link ./session-tasks.js} 与既有内核里）；
 * 不做 HTTP / 界面。本层只回答"会话有哪些、当前是哪个、每个会话挂了什么"。
 */

import { asLogicalTime, asTaskId, type LogicalTime, type TaskId } from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 标识
// ---------------------------------------------------------------------------

declare const conversationBrand: unique symbol;

/** 品牌化包装：只在类型层区分，运行时就是原始值（与 `src/protocol/ids.ts` 同一手法）。 */
type Brand<T, B extends string> = T & { readonly [conversationBrand]: B };

/** 会话身份。**客户端生成、刷新保留**；不同会话的 id 不得复用。 */
export type ConversationId = Brand<string, 'ConversationId'>;

/** 会话引用的记忆条目（不透明字符串；本层不解释记忆的内容）。 */
export type ConversationMemoryRef = Brand<string, 'ConversationMemoryRef'>;

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new RangeError(`${label} 不能为空`);
  }
  return value;
}

export const asConversationId = (value: string): ConversationId =>
  requireNonEmpty(value, 'ConversationId') as ConversationId;

export const asConversationMemoryRef = (value: string): ConversationMemoryRef =>
  requireNonEmpty(value, 'ConversationMemoryRef') as ConversationMemoryRef;

// ---------------------------------------------------------------------------
// 落盘 schema
// ---------------------------------------------------------------------------

/** 落盘格式版本。**只增不改**（语义变了就换字符串，让旧快照走"拒绝加载"）。 */
export const CONVERSATION_SESSION_SCHEMA = 'potbot-conversation-sessions.v1';

/** 一条会话记录（可序列化 = 可持久化 = 重开后仍在）。 */
export interface ConversationSession {
  readonly schema: typeof CONVERSATION_SESSION_SCHEMA;
  readonly conversation_id: ConversationId;
  readonly title: string;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
  readonly archived: boolean;
  /**
   * 本会话挂的**任务引用**。归位纪律：这份列表只回答"属于本会话的任务"，
   * 别的会话的任务**不会**出现在这里（{@link ConversationSessions.taskRefsOf} 的断言）。
   */
  readonly task_refs: readonly TaskId[];
  /** 本会话挂的**记忆引用**。同样只归本会话。 */
  readonly memory_refs: readonly ConversationMemoryRef[];
  /** 本会话已落盘的消息条数（历史规模的旁证；本层不存正文）。 */
  readonly message_count: number;
}

/** 整份可序列化快照（端口存取的单位）。 */
export interface ConversationSnapshot {
  readonly schema: typeof CONVERSATION_SESSION_SCHEMA;
  /** 当前激活的会话（刷新后恢复；无会话时为 `null`）。 */
  readonly active_id: ConversationId | null;
  readonly sessions: readonly ConversationSession[];
}

// ---------------------------------------------------------------------------
// 持久端口（注入；本层不做文件 IO）
// ---------------------------------------------------------------------------

/**
 * 持久端口。实现方负责真正落盘 / 读回；本层只交快照、只收 `unknown` 并自己核对形状。
 *
 * **产品路径必须注入**；不注入时 {@link ConversationSessions.readiness} 报未就绪。
 */
export interface ConversationPersistencePort {
  save(snapshot: ConversationSnapshot): void;
  /** 读回；返回 `unknown`（形状核对在本层做，端口不负责验证）。 */
  load(): unknown;
}

/**
 * **内存持久端口**（测试 / 沙箱用）。
 *
 * 刻意导出：测试需要一个"跨实例存活"的端口来模拟**重开恢复**（`load → 新实例`）。
 * **产品路径不得**用它——`readiness()` 只认"端口是否存在"，认不出端口是不是假的，
 * 因此交付说明里如实标注：本实现的可用性**未经真机验证**。
 */
export function createMemoryConversationPersistence(
  initial: unknown = null,
): ConversationPersistencePort {
  let stored: unknown = initial === null ? null : structuredClone(initial);
  return Object.freeze({
    save(snapshot: ConversationSnapshot): void {
      stored = structuredClone(snapshot);
    },
    load(): unknown {
      return stored === null ? null : structuredClone(stored);
    },
  });
}

// ---------------------------------------------------------------------------
// 结果类型与失败码
// ---------------------------------------------------------------------------

/** 本层的失败码（封闭枚举；每个码一个含义）。 */
export type ConversationFailureCode =
  /** 会话不存在。 */
  | 'session_not_found'
  /** 会话 id 已被占用。 */
  | 'session_already_exists'
  /** 会话名（标题）为空。 */
  | 'empty_title'
  /** 会话 id 非法（空 / 不是合法标识）。 */
  | 'invalid_conversation_id'
  /** 会话数达上限（不静默淘汰）。 */
  | 'session_limit_reached'
  /** 读回的快照形状非法（`state_unreadable`）。 */
  | 'state_unreadable'
  /** 该任务引用挂在**别的**会话上（跨会话归位被拒，不静默搬家）。 */
  | 'task_owned_by_other_session';

export interface ConversationOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ConversationFailure {
  readonly ok: false;
  readonly code: ConversationFailureCode;
  readonly message: string;
}

/**
 * 会话层结果。**失败绝不携带"半成品值"**：失败分支里根本没有会话可被误用。
 */
export type ConversationResult<T> = ConversationOk<T> | ConversationFailure;

export function conversationOk<T>(value: T): ConversationOk<T> {
  return Object.freeze({ ok: true as const, value });
}

export function conversationFail<T>(code: ConversationFailureCode, message: string): ConversationFailure {
  return Object.freeze({ ok: false as const, code, message });
}

// ---------------------------------------------------------------------------
// 分页与搜索
// ---------------------------------------------------------------------------

export interface ConversationListQuery {
  /** 名字子串搜索（大小写不敏感的朴素匹配；空串 = 不过滤）。 */
  readonly search?: string;
  /** 是否包含已归档会话（默认 `false`：归档的意义就是默认不出现）。 */
  readonly includeArchived?: boolean;
  /** 页码，从 1 起。 */
  readonly page?: number;
  /** 每页条数（默认 {@link CONVERSATION_PAGE_SIZE}）。 */
  readonly pageSize?: number;
}

export interface ConversationPage {
  readonly items: readonly ConversationSession[];
  /** 实际使用的页码（从 1 起）。 */
  readonly page: number;
  readonly page_size: number;
  /** **过滤后**的命中总数（分页前）。 */
  readonly total: number;
  /** 是否还有下一页。 */
  readonly has_more: boolean;
}

export const CONVERSATION_PAGE_SIZE = 20;

/** 会话数上限（达到即结构化拒绝，不静默淘汰旧会话）。 */
export const CONVERSATION_SESSION_LIMIT = 256;

// ---------------------------------------------------------------------------
// 就绪状态
// ---------------------------------------------------------------------------

export interface ConversationReadiness {
  readonly ready: boolean;
  readonly reason: 'persistence_port_injected' | 'no_persistence_port';
}

// ---------------------------------------------------------------------------
// 会话模型
// ---------------------------------------------------------------------------

export interface ConversationSessionsOptions {
  /**
   * 持久端口。**不传 / 传 `null` ⇒ 产品路径未就绪**（内存态仍可用，但刷新后不保证还在）。
   */
  readonly persistence?: ConversationPersistencePort | null;
  /** id 生成器（默认 `conv-<n>`；测试可注入确定值）。 */
  readonly makeId?: (sequence: number) => ConversationId;
  readonly limit?: number;
}

export class ConversationSessions {
  readonly #persistence: ConversationPersistencePort | null;
  readonly #makeId: (sequence: number) => ConversationId;
  readonly #limit: number;
  readonly #sessions = new Map<ConversationId, ConversationSession>();
  #active: ConversationId | null = null;
  #sequence = 0;
  /** 读不回来的原因（`null` = 启动干净；非空 = **如实**登记，不当作"没有"）。 */
  #unreadable: string | null = null;

  constructor(options: ConversationSessionsOptions = {}) {
    this.#persistence = options.persistence ?? null;
    this.#makeId = options.makeId ?? ((sequence: number): ConversationId => asConversationId(`conv-${String(sequence)}`));
    this.#limit = options.limit ?? CONVERSATION_SESSION_LIMIT;
    this.#restore();
  }

  // --- 就绪与恢复 ---------------------------------------------------------

  /** 产品路径是否就绪（唯一判据：有没有注入持久端口）。 */
  readiness(): ConversationReadiness {
    return this.#persistence === null
      ? Object.freeze({ ready: false, reason: 'no_persistence_port' as const })
      : Object.freeze({ ready: true, reason: 'persistence_port_injected' as const });
  }

  /** 启动时读回来的快照非法时的原因（`null` = 干净启动或端口未注入）。 */
  unreadableReason(): string | null {
    return this.#unreadable;
  }

  /** 把内存态写成快照（**不**含读回核对；核对在 {@link #restore}）。 */
  snapshot(): ConversationSnapshot {
    return Object.freeze({
      schema: CONVERSATION_SESSION_SCHEMA,
      active_id: this.#active,
      sessions: Object.freeze([...this.#sessions.values()]),
    });
  }

  /**
   * 启动恢复（**重开恢复**的落点）。形状不符 ⇒ **整份拒绝**并登记原因，
   * 内存保持空（绝不把坏快照的一半塞进来）。
   */
  #restore(): void {
    const port = this.#persistence;
    if (port === null) {
      return;
    }
    let raw: unknown;
    try {
      raw = port.load();
    } catch (error) {
      this.#unreadable = `端口 load() 抛错：${describeError(error)}`;
      return;
    }
    if (raw === null || raw === undefined) {
      return; // 首次运行：没有快照 = 干净启动，不是"读不回来"
    }
    const decoded = decodeConversationSnapshot(raw);
    if (!decoded.ok) {
      this.#unreadable = `${decoded.code}: ${decoded.message}`;
      return;
    }
    for (const session of decoded.value.sessions) {
      this.#sessions.set(session.conversation_id, session);
    }
    // 激活会话必须真的存在；指向空会话的游标按"没有激活"处理（不猜一个替代品）。
    const active = decoded.value.active_id;
    this.#active = active !== null && this.#sessions.has(active) ? active : null;
    // 序号接着最大已用序号走，避免重开后新建会话与旧 id 相撞。
    this.#sequence = this.#sessions.size;
  }

  // --- 新建 / 切换 / 重命名 / 归档 / 删除 ---------------------------------

  createSession(input: {
    readonly title?: string;
    readonly id?: ConversationId;
    readonly at: LogicalTime;
  }): ConversationResult<ConversationSession> {
    if (this.#sessions.size >= this.#limit) {
      return conversationFail(
        'session_limit_reached',
        `会话数已达上限 ${String(this.#limit)}：请先删除不再使用的会话（不静默淘汰）`,
      );
    }
    const at = asLogicalTime(input.at);
    const id = input.id ?? this.#makeId((this.#sequence += 1));
    if (id.trim().length === 0) {
      return conversationFail('invalid_conversation_id', '会话 id 不能为空');
    }
    if (this.#sessions.has(id)) {
      return conversationFail('session_already_exists', `会话 ${id} 已存在（不覆盖、不清空）`);
    }
    const title = (input.title ?? `新会话 ${String(this.#sessions.size + 1)}`).trim();
    if (title.length === 0) {
      return conversationFail('empty_title', '会话标题不能为空');
    }
    const session: ConversationSession = Object.freeze({
      schema: CONVERSATION_SESSION_SCHEMA,
      conversation_id: id,
      title,
      created_at: at,
      updated_at: at,
      archived: false,
      task_refs: Object.freeze([]),
      memory_refs: Object.freeze([]),
      message_count: 0,
    });
    this.#sessions.set(id, session);
    this.#active = id; // 新建即切换为当前会话（与"打开新会话"一致）
    this.#persist();
    return conversationOk(session);
  }

  /** 切换当前会话。**归档会话也可切回**（归档只影响默认列表，不等于不可用）。 */
  switchSession(id: ConversationId, at: LogicalTime): ConversationResult<ConversationSession> {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return conversationFail('session_not_found', `没有会话 ${id}`);
    }
    const updated = this.#touch(session, asLogicalTime(at));
    this.#active = id;
    this.#persist();
    return conversationOk(updated);
  }

  activeSession(): ConversationSession | null {
    return this.#active === null ? null : (this.#sessions.get(this.#active) ?? null);
  }

  renameSession(id: ConversationId, title: string, at: LogicalTime): ConversationResult<ConversationSession> {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return conversationFail('empty_title', '会话标题不能为空');
    }
    return this.#patch(id, at, (session) => Object.freeze({ ...session, title: trimmed }));
  }

  archiveSession(id: ConversationId, archived: boolean, at: LogicalTime): ConversationResult<ConversationSession> {
    return this.#patch(id, at, (session) => Object.freeze({ ...session, archived }));
  }

  /**
   * 删除会话（**只删这条会话本身**）。
   *
   * 与 CHAT-08 的四类删除语义分工见 {@link ./delete-semantics.js}：这里只做"把会话从模型里拿掉"，
   * **不**替调用方决定任务/记忆的去留——因此返回被拿掉的引用清单，交由上层按语义处置。
   * 副作用**不会被**这里撤销（本层根本不知道有没有副作用）。
   */
  deleteSession(id: ConversationId): ConversationResult<{ readonly removed: ConversationSession }> {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return conversationFail('session_not_found', `没有会话 ${id}`);
    }
    this.#sessions.delete(id);
    if (this.#active === id) {
      this.#active = null;
    }
    this.#persist();
    return conversationOk(Object.freeze({ removed: session }));
  }

  // --- 查询 / 分页 / 搜索 -------------------------------------------------

  getSession(id: ConversationId): ConversationSession | null {
    return this.#sessions.get(id) ?? null;
  }

  sessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * 列表（分页 + 搜索），按 `updated_at` **降序**（最近用过的在前；同刻按 id 稳定排序）。
   */
  listSessions(query: ConversationListQuery = {}): ConversationPage {
    const includeArchived = query.includeArchived ?? false;
    const needle = (query.search ?? '').trim().toLowerCase();
    const pageSize = normalizePageSize(query.pageSize);
    const all = [...this.#sessions.values()]
      .filter((session) => (includeArchived ? true : !session.archived))
      .filter((session) => (needle === '' ? true : session.title.toLowerCase().includes(needle)))
      .sort(compareSessions);
    const total = all.length;
    const page = normalizePage(query.page, total, pageSize);
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

  /** 搜索的便利入口（返回命中项，不分页；分页用 {@link listSessions}）。 */
  searchSessions(search: string, includeArchived = false): readonly ConversationSession[] {
    return this.listSessions({ search, includeArchived, page: 1, pageSize: this.#limit }).items;
  }

  // --- 任务 / 记忆归位（跨会话隔离的落点）--------------------------------

  /**
   * 把一个任务引用挂到会话上。
   *
   * **跨会话隔离**：同一任务 id 已经挂在**别的**会话上时**拒绝**（`task_owned_by_other_session`），
   * 不静默搬家——"同一个任务同时属于两个会话"是身份违规。
   */
  attachTask(id: ConversationId, taskId: TaskId, at: LogicalTime): ConversationResult<ConversationSession> {
    const owner = this.ownerOfTask(taskId);
    if (owner !== null && owner !== id) {
      return conversationFail(
        'task_owned_by_other_session',
        `任务 ${taskId} 已归属会话 ${owner}：不接受跨会话搬家（先解绑）`,
      );
    }
    return this.#patch(id, at, (session) => {
      if (session.task_refs.includes(taskId)) {
        return null;
      }
      return Object.freeze({ ...session, task_refs: Object.freeze([...session.task_refs, taskId]) });
    });
  }

  detachTask(id: ConversationId, taskId: TaskId, at: LogicalTime): ConversationResult<ConversationSession> {
    return this.#patch(id, at, (session) =>
      Object.freeze({ ...session, task_refs: Object.freeze(session.task_refs.filter((item) => item !== taskId)) }),
    );
  }

  attachMemory(
    id: ConversationId,
    memoryRef: ConversationMemoryRef,
    at: LogicalTime,
  ): ConversationResult<ConversationSession> {
    return this.#patch(id, at, (session) => {
      if (session.memory_refs.includes(memoryRef)) {
        return null;
      }
      return Object.freeze({ ...session, memory_refs: Object.freeze([...session.memory_refs, memoryRef]) });
    });
  }

  detachMemory(
    id: ConversationId,
    memoryRef: ConversationMemoryRef,
    at: LogicalTime,
  ): ConversationResult<ConversationSession> {
    return this.#patch(id, at, (session) =>
      Object.freeze({
        ...session,
        memory_refs: Object.freeze(session.memory_refs.filter((item) => item !== memoryRef)),
      }),
    );
  }

  /** **只**返回本会话的任务引用（跨会话隔离的断言面）。 */
  taskRefsOf(id: ConversationId): readonly TaskId[] {
    return this.#sessions.get(id)?.task_refs ?? Object.freeze([]);
  }

  /** **只**返回本会话的记忆引用（跨会话隔离的断言面）。 */
  memoryRefsOf(id: ConversationId): readonly ConversationMemoryRef[] {
    return this.#sessions.get(id)?.memory_refs ?? Object.freeze([]);
  }

  /** 某任务当前归属哪个会话（无归属 = `null`）。 */
  ownerOfTask(taskId: TaskId): ConversationId | null {
    for (const session of this.#sessions.values()) {
      if (session.task_refs.includes(taskId)) {
        return session.conversation_id;
      }
    }
    return null;
  }

  /** 消息计数（历史规模的旁证；正文由别的层承担）。 */
  noteMessage(id: ConversationId, at: LogicalTime): ConversationResult<ConversationSession> {
    return this.#patch(id, at, (session) =>
      Object.freeze({ ...session, message_count: session.message_count + 1 }),
    );
  }

  // --- 内部 ---------------------------------------------------------------

  #touch(session: ConversationSession, at: LogicalTime): ConversationSession {
    const updated = Object.freeze({ ...session, updated_at: at });
    this.#sessions.set(session.conversation_id, updated);
    return updated;
  }

  /**
   * 通用补丁：`mutate` 返回 `null` 表示"无改动"（幂等重复），原样返回不刷新时间。
   */
  #patch(
    id: ConversationId,
    at: LogicalTime,
    mutate: (session: ConversationSession) => ConversationSession | null,
  ): ConversationResult<ConversationSession> {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return conversationFail('session_not_found', `没有会话 ${id}`);
    }
    const next = mutate(session);
    const result = next === null ? this.#touch(session, asLogicalTime(at)) : this.#touch(next, asLogicalTime(at));
    this.#persist();
    return conversationOk(result);
  }

  #persist(): void {
    if (this.#persistence !== null) {
      this.#persistence.save(this.snapshot());
    }
  }
}

// ---------------------------------------------------------------------------
// 形状核对（读回侧；端口不负责验证）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 快照形状核对。**任一字段不符即整份拒绝**（返回失败，调用方不得半数采用）。
 * 不对字段做"猜测性修补"（缺字段就补默认值会让坏快照看起来合法）。
 */
export function decodeConversationSnapshot(raw: unknown): ConversationResult<ConversationSnapshot> {
  if (!isPlainObject(raw)) {
    return conversationFail('state_unreadable', '快照不是对象');
  }
  if (raw['schema'] !== CONVERSATION_SESSION_SCHEMA) {
    return conversationFail(
      'state_unreadable',
      `快照 schema 不符（期望 ${CONVERSATION_SESSION_SCHEMA}，收到 ${JSON.stringify(raw['schema'])}）`,
    );
  }
  const rawSessions = raw['sessions'];
  if (!Array.isArray(rawSessions)) {
    return conversationFail('state_unreadable', 'sessions 不是数组');
  }
  const sessions: ConversationSession[] = [];
  for (const entry of rawSessions) {
    const decoded = decodeConversationSession(entry);
    if (!decoded.ok) {
      return decoded;
    }
    sessions.push(decoded.value);
  }
  const rawActive = raw['active_id'];
  let active: ConversationId | null = null;
  if (rawActive !== null && rawActive !== undefined) {
    if (typeof rawActive !== 'string' || rawActive.trim().length === 0) {
      return conversationFail('state_unreadable', 'active_id 既不是 null 也不是非空字符串');
    }
    active = asConversationId(rawActive);
  }
  return conversationOk(Object.freeze({ schema: CONVERSATION_SESSION_SCHEMA, active_id: active, sessions: Object.freeze(sessions) }));
}

function decodeConversationSession(raw: unknown): ConversationResult<ConversationSession> {
  if (!isPlainObject(raw)) {
    return conversationFail('state_unreadable', '会话记录不是对象');
  }
  const id = raw['conversation_id'];
  const title = raw['title'];
  const createdAt = raw['created_at'];
  const updatedAt = raw['updated_at'];
  const archived = raw['archived'];
  const messageCount = raw['message_count'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return conversationFail('state_unreadable', 'conversation_id 非法');
  }
  if (typeof title !== 'string') {
    return conversationFail('state_unreadable', `会话 ${id} 的 title 不是字符串`);
  }
  if (!isFiniteNumber(createdAt) || !isFiniteNumber(updatedAt)) {
    return conversationFail('state_unreadable', `会话 ${id} 的时间戳非法`);
  }
  if (typeof archived !== 'boolean') {
    return conversationFail('state_unreadable', `会话 ${id} 的 archived 不是布尔`);
  }
  if (!isFiniteNumber(messageCount)) {
    return conversationFail('state_unreadable', `会话 ${id} 的 message_count 非法`);
  }
  const taskRefs = raw['task_refs'];
  const memoryRefs = raw['memory_refs'];
  if (!Array.isArray(taskRefs) || !Array.isArray(memoryRefs)) {
    return conversationFail('state_unreadable', `会话 ${id} 的引用列表不是数组`);
  }
  const tasks: TaskId[] = [];
  for (const ref of taskRefs) {
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      return conversationFail('state_unreadable', `会话 ${id} 的 task_refs 含非字符串项`);
    }
    tasks.push(asTaskId(ref));
  }
  const memories: ConversationMemoryRef[] = [];
  for (const ref of memoryRefs) {
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      return conversationFail('state_unreadable', `会话 ${id} 的 memory_refs 含非字符串项`);
    }
    memories.push(asConversationMemoryRef(ref));
  }
  return conversationOk(
    Object.freeze({
      schema: CONVERSATION_SESSION_SCHEMA,
      conversation_id: asConversationId(id),
      title,
      created_at: asLogicalTime(createdAt),
      updated_at: asLogicalTime(updatedAt),
      archived,
      task_refs: Object.freeze(tasks),
      memory_refs: Object.freeze(memories),
      message_count: messageCount,
    }),
  );
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function compareSessions(a: ConversationSession, b: ConversationSession): number {
  if (a.updated_at !== b.updated_at) {
    return b.updated_at - a.updated_at; // 降序：最近更新的在前
  }
  return a.conversation_id < b.conversation_id ? -1 : a.conversation_id > b.conversation_id ? 1 : 0;
}

function normalizePageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) {
    return CONVERSATION_PAGE_SIZE;
  }
  return Math.floor(raw);
}

function normalizePage(raw: number | undefined, total: number, pageSize: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) {
    return 1;
  }
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.floor(raw), maxPage);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
