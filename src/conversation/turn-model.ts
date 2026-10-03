/**
 * 会话轮次模型（能力 **CHAT-03**）—— 增量回复 / 发送状态 / 重试幂等 / 断线续取 / 停止。
 *
 * ## 这个模块回答什么
 *
 * 完整对话的**消息与轮次生命周期**（服务端口径，纯逻辑、不 I/O、不调模型）：
 *
 * | CHAT-03 子项 | 本模块的落点 |
 * |---|---|
 * | 消息有**稳定 ID / 顺序** | `TurnMessage.message_id` 一旦分配**永不变**（重试复用同一条）；`seq` 每会话单调递增、只增不改 |
 * | **增量回复** | `beginReply` → `appendReplyChunk*` → `completeReply`；片段按顺序累加，`message_id` / `seq` 全程不变 |
 * | **发送中 / 已接收** | `submitUserMessage({ delivery })` + `acknowledgeDelivery()`；`sending → received` 是两条**不同**记录 |
 * | **失败 / 重试** | `failReply()` 后消息 `state='failed'`（`retryable`）；`retryMessage()` 复用同一条消息、同一个 `client_id`、**同一个任务** |
 * | **断线续取** | `resume(sinceSeq)`：事件 `seq` **严格大于**游标才返回（已消费内容不重放）；`pending` 给出仍未定局的消息 |
 * | **停止** | `abortReply()`（中止回复）与 `cancelTask()`（取消任务）—— **两种语义、两套状态** |
 *
 * ## 两条硬语义（本模块存在的理由）
 *
 * 1. **重试不重复建任务**。任务只在 `submitUserMessage` 里创建一次，并记在 `task_id` 上；
 *    `retryMessage` **绝不**创建任务、**绝不**改 `message_id`。断言见
 *    `turn-model.test.ts` 的「同一条消息重试两次只产生一个任务」。
 * 2. **中止回复 ≠ 取消任务**。这是两个**独立轴**上的状态：
 *    - `abortReply(turnId)` 只停这一轮的回复生成：消息 `reply='aborted'`、`state='cancelled'`，
 *      但**任务状态一动不动**（仍是 `running`），用户可 `retryMessage` 重新生成；
 *    - `cancelTask(taskId)` 取消整个任务：任务状态变 `cancelled`，其下所有消息 `reply='cancelled'`，
 *      且**不可重试**（任务已终态）。
 *    两者的返回值用 `kind` 判别（`'reply_aborted'` / `'task_cancelled'`），不是靠文案区分。
 *
 * ## 不做什么
 *
 * - 不做文本相似度、不做意图猜测：归属一律走显式绑定（CHAT-04 的活，见 `run-constraints.ts`）。
 * - 不落盘、不发请求、不调模型：执行与持久化由调用方（宿主 / 执行器）注入。
 * - 不实现会话本身的增删改（那是 `fa/chat-session` 的 `session-model.ts` 的范围）。
 *
 * ## 确定性
 *
 * id 由注入的 `IdSource` 生成（固定种子 → 同一调用顺序产生同一串 id），
 * **不使用 `Math.random()` / `Date.now()`**，因此整个模型可复现。
 */

import {
  asMessageId,
  asRevision,
  asTaskId,
  createIdSource,
  type IdSource,
  type MessageId,
  type Revision,
  type TaskId,
} from '../protocol/ids.js';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

export type TurnRole = 'user' | 'assistant' | 'system';

/**
 * 消息状态。两种角色用**同一个枚举的不同子集**（不是两套类型，便于渲染层统一遍历）：
 *
 * - 用户消息：`sending`（客户端已发、服务端未确认）→ `received`（服务端已收下）；
 *   失败 `failed`；被停 / 被取消 `cancelled`。
 * - 助手消息：`sending` → `streaming`（增量产出中）→ `completed`；`failed`；`cancelled`。
 */
export type TurnMessageState =
  | 'sending'
  | 'received'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 一轮回复的**独立状态轴**（与任务状态无关）。
 *
 * - `aborted`：用户按了"停止生成"——**任务还在跑**，可重试；
 * - `cancelled`：整个任务被取消——**不可重试**（与 `aborted` 严格区分）。
 */
export type ReplyStatus = 'idle' | 'streaming' | 'completed' | 'failed' | 'aborted' | 'cancelled';

/** 任务状态（任务自己的轴，独立于消息与回复）。 */
export type TurnTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 结构化失败（可判、可重试）。 */
export interface TurnError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** 一条落定消息（冻结）。`message_id` 与 `seq` 一旦分配**永不改变**。 */
export interface TurnMessage {
  readonly message_id: MessageId;
  /** 本会话内单调递增（从 1 起）、只增不改；断线续取凭它排序。 */
  readonly seq: number;
  readonly role: TurnRole;
  readonly text: string;
  /** 幂等键（仅用户消息）。**重试复用同一个值**。 */
  readonly client_id?: string;
  /** 绑定的任务（用户消息恒有；助手消息继承其轮次的任务）。 */
  readonly task_id?: TaskId;
  /** 助手消息指向它所属的用户消息。 */
  readonly reply_to?: MessageId;
  readonly state: TurnMessageState;
  /** 回复轴状态（用户消息上表示"这一轮的回复"；助手消息上与 `state` 同步）。 */
  readonly reply: ReplyStatus;
  /** 增量回复片段（按到达顺序）。 */
  readonly chunks: readonly string[];
  /** 该轮已尝试次数（重试 +1；**不含**首次）。 */
  readonly attempts: number;
  readonly error?: TurnError;
}

/** 任务记录（承载"重试不重复建任务"的判据：`task_id` 由谁创建）。 */
export interface TurnTask {
  readonly task_id: TaskId;
  readonly status: TurnTaskStatus;
  readonly revision: Revision;
  /** 由哪条消息创建（复核归属用）。 */
  readonly created_from: MessageId;
}

export type TurnEventKind =
  | 'task_created'
  | 'message_accepted'
  | 'message_retried'
  | 'reply_started'
  | 'reply_chunk'
  | 'reply_completed'
  | 'reply_failed'
  | 'reply_aborted'
  | 'task_cancelled';

/** 一条增量事件；`seq` 每会话单调递增，游标即此 seq。 */
export interface TurnEvent {
  readonly seq: number;
  readonly kind: TurnEventKind;
  readonly message_id?: MessageId;
  readonly task_id?: TaskId;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// 入参 / 结果
// ---------------------------------------------------------------------------

export interface SubmitUserMessageInput {
  readonly text: string;
  /** 幂等键。同一 `client_id` 同文本 ⇒ 同一条消息（不新建、不重复建任务）。 */
  readonly client_id: string;
  /** 显式续接到已有任务；省略时新建一个任务。 */
  readonly task_id?: TaskId;
  /** 初始投递状态；默认 `received`（服务端入口）。客户端本地先建时给 `sending`。 */
  readonly delivery?: 'sending' | 'received';
}

export type SubmitUserMessageResult =
  | {
      readonly ok: true;
      readonly message: TurnMessage;
      /** `true` = 这个 `client_id` 之前就收过，**没有**新建消息、**没有**新建任务。 */
      readonly duplicate: boolean;
      /** 本次调用**是否新建了任务**（重试永远为 `false`）。 */
      readonly task_created: boolean;
      readonly task: TurnTask;
    }
  | { readonly ok: false; readonly code: TurnFailureCode; readonly message: string };

export type TurnFailureCode =
  | 'empty_text'
  | 'empty_client_id'
  | 'idempotency_conflict'
  | 'unknown_message'
  | 'not_a_user_message'
  | 'not_replyable'
  | 'not_streaming'
  | 'not_retryable'
  | 'not_pending_delivery'
  | 'no_active_reply'
  | 'unknown_task'
  | 'already_terminal'
  | 'task_cancelled';

export interface TurnOk<T> {
  readonly ok: true;
  readonly value: T;
}

/** `resume` 的返回：**严格大于**游标的事件 + 需要就地更新的消息。 */
export interface TurnResumeResult {
  readonly events: readonly TurnEvent[];
  /** 新建的（`seq > sinceSeq`）**或**仍未定局的（在途）消息——客户端用它原地更新。 */
  readonly messages: readonly TurnMessage[];
  /** 仍未定局的消息（`sending` / `received` / `streaming`）。 */
  readonly pending: readonly TurnMessage[];
  /** 下一次续取应带的游标。 */
  readonly cursor: number;
  /** 是否还有更多（本实现一次性给全，恒为 `false`；保留给分页实现）。 */
  readonly more: boolean;
}

export interface TurnModelOptions {
  /** 固定种子（可复现 id）。省略时 id 不含种子段。 */
  readonly seed?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 与服务端同一套字符集：`client_id` 是合法标识符时直接复用为 `message_id`。 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;

const TERMINAL_STATES: readonly TurnMessageState[] = ['completed', 'failed', 'cancelled'];

const isTerminal = (state: TurnMessageState): boolean => TERMINAL_STATES.includes(state);

const rejected = (code: TurnFailureCode, message: string): { ok: false; code: TurnFailureCode; message: string } =>
  Object.freeze({ ok: false as const, code, message });

// ---------------------------------------------------------------------------
// 轮次模型
// ---------------------------------------------------------------------------

/**
 * 纯逻辑的会话轮次状态机。**所有变更都经方法入口**，对象一律冻结后落表。
 */
export class TurnModel {
  readonly #ids: IdSource;
  readonly #messages = new Map<MessageId, TurnMessage>();
  readonly #messageOrder: MessageId[] = [];
  readonly #tasks = new Map<TaskId, TurnTask>();
  readonly #events: TurnEvent[] = [];
  #nextMessageSeq = 1;
  #nextEventSeq = 1;

  constructor(options: TurnModelOptions = {}) {
    this.#ids = createIdSource(options.seed === undefined ? {} : { seed: options.seed });
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /** 全部消息，按 `seq` 升序（稳定顺序）。 */
  listMessages(): readonly TurnMessage[] {
    return Object.freeze(
      this.#messageOrder
        .map((id) => this.#messages.get(id))
        .filter((m): m is TurnMessage => m !== undefined),
    );
  }

  getMessage(messageId: MessageId): TurnMessage | undefined {
    return this.#messages.get(messageId);
  }

  /** 全部任务（用于核对"重试没有多出任务"）。 */
  listTasks(): readonly TurnTask[] {
    return Object.freeze([...this.#tasks.values()]);
  }

  taskCount(): number {
    return this.#tasks.size;
  }

  getTask(taskId: TaskId): TurnTask | undefined {
    return this.#tasks.get(taskId);
  }

  /** 助手消息的稳定 id 派生规则：`<用户消息 id>-assistant`。 */
  assistantMessageIdFor(turnId: MessageId): MessageId {
    return asMessageId(`${turnId}-assistant`);
  }

  /** 当前游标（= 已发出的最大事件 seq）。 */
  cursor(): number {
    return this.#nextEventSeq - 1;
  }

  /**
   * 断线续取：返回 `seq` **严格大于** `sinceSeq` 的事件（不重放已消费内容），
   * 外加需要就地更新的消息（新建的或在途的）。非法游标（负 / 非有限）抛 `RangeError`。
   */
  resume(sinceSeq: number): TurnResumeResult {
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
      throw new RangeError(`游标必须是非负整数，收到 ${String(sinceSeq)}`);
    }
    const events = this.#events.filter((event) => event.seq > sinceSeq);
    const pending = this.listMessages().filter((message) => !isTerminal(message.state));
    const changed = this.listMessages().filter(
      (message) => message.seq > sinceSeq || !isTerminal(message.state),
    );
    // 去重（在途消息可能同时满足两个条件），保持 seq 升序。
    const seen = new Set<MessageId>();
    const messages = Object.freeze(
      changed.filter((message) => {
        if (seen.has(message.message_id)) return false;
        seen.add(message.message_id);
        return true;
      }),
    );
    return Object.freeze({
      events: Object.freeze(events),
      messages,
      pending: Object.freeze(pending),
      cursor: this.cursor(),
      more: false,
    });
  }

  // -------------------------------------------------------------------------
  // 写：接收用户消息（幂等）
  // -------------------------------------------------------------------------

  /**
   * 收下一条用户消息。
   *
   * - 同一 `client_id` + 同一正文 ⇒ 返回既有那条，`duplicate: true`，**不新建消息、不新建任务**；
   * - 同一 `client_id` + 不同正文 ⇒ `idempotency_conflict`（**不覆盖**既有消息）；
   * - 任务在**这里**创建（`task_id` 省略时新开一个；给出已知 `task_id` 时复用它）。
   */
  submitUserMessage(input: SubmitUserMessageInput): SubmitUserMessageResult {
    if (typeof input.client_id !== 'string' || input.client_id.length === 0) {
      return rejected('empty_client_id', '缺少 client_id（幂等键）：没有它就无法保证重试不重复建任务');
    }
    if (typeof input.text !== 'string' || input.text.length === 0) {
      return rejected('empty_text', '消息正文不能为空');
    }

    const messageId: MessageId = SAFE_IDENTIFIER.test(input.client_id)
      ? asMessageId(input.client_id)
      : this.#ids.newMessageId();

    const existing = this.#messages.get(messageId);
    if (existing !== undefined) {
      if (existing.text !== input.text) {
        return rejected(
          'idempotency_conflict',
          '这个 client_id 已用于另一条内容不同的消息：请换一个 client_id，或按原内容重发（重发不会新建任务）',
        );
      }
      return Object.freeze({
        ok: true as const,
        message: existing,
        duplicate: true,
        task_created: false,
        task: this.#taskOf(existing),
      });
    }

    const seq = this.#nextMessageSeq;
    this.#nextMessageSeq += 1;

    let task: TurnTask;
    let taskCreated = false;
    if (input.task_id !== undefined) {
      const known = this.#tasks.get(input.task_id);
      if (known === undefined) {
        task = Object.freeze({
          task_id: input.task_id,
          status: 'running' as TurnTaskStatus,
          revision: asRevision(0),
          created_from: messageId,
        });
        this.#tasks.set(input.task_id, task);
        taskCreated = true;
        this.#emit({ kind: 'task_created', task_id: input.task_id, message_id: messageId });
      } else {
        task = known;
      }
    } else {
      const taskId = asTaskId(this.#ids.next('task'));
      task = Object.freeze({
        task_id: taskId,
        status: 'running' as TurnTaskStatus,
        revision: asRevision(0),
        created_from: messageId,
      });
      this.#tasks.set(taskId, task);
      taskCreated = true;
      this.#emit({ kind: 'task_created', task_id: taskId, message_id: messageId });
    }

    const message = this.#put({
      message_id: messageId,
      seq,
      role: 'user',
      text: input.text,
      client_id: input.client_id,
      task_id: task.task_id,
      state: input.delivery ?? 'received',
      reply: 'idle',
      chunks: Object.freeze([]),
      attempts: 0,
    });
    this.#emit({ kind: 'message_accepted', message_id: messageId, task_id: task.task_id });
    return Object.freeze({ ok: true as const, message, duplicate: false, task_created: taskCreated, task });
  }

  /**
   * 投递确认：`sending → received`（重复调用幂等）。
   * 非 `sending` 状态（已 `received` 之外的终态）拒绝，避免把失败/取消悄悄"重开"。
   */
  acknowledgeDelivery(turnId: MessageId): TurnOk<TurnMessage> | { ok: false; code: TurnFailureCode; message: string } {
    const message = this.#messages.get(turnId);
    if (message === undefined) return rejected('unknown_message', `未知消息 ${turnId}`);
    if (message.role !== 'user') return rejected('not_a_user_message', '投递确认只适用于用户消息');
    if (message.state === 'received') return Object.freeze({ ok: true as const, value: message });
    if (message.state !== 'sending') {
      return rejected('not_pending_delivery', `消息处于 ${message.state}，不是待确认的 sending`);
    }
    return Object.freeze({ ok: true as const, value: this.#patch(turnId, { state: 'received' }) });
  }

  // -------------------------------------------------------------------------
  // 写：增量回复
  // -------------------------------------------------------------------------

  /**
   * 开始（或继续）一轮回复。幂等：已在 `streaming` 时返回既有助手消息。
   * 仅当该轮 `reply ∈ {idle}` 或已在 `streaming` 时可调用；已完成/失败/中止需先 `retryMessage`。
   */
  beginReply(turnId: MessageId): TurnOk<TurnMessage> | { ok: false; code: TurnFailureCode; message: string } {
    const turn = this.#messages.get(turnId);
    if (turn === undefined) return rejected('unknown_message', `未知消息 ${turnId}`);
    if (turn.role !== 'user') return rejected('not_a_user_message', '回复只能挂在用户消息上');

    const assistantId = this.assistantMessageIdFor(turnId);
    const existingAssistant = this.#messages.get(assistantId);
    if (existingAssistant !== undefined && existingAssistant.state === 'streaming') {
      return Object.freeze({ ok: true as const, value: existingAssistant });
    }
    if (turn.reply !== 'idle') {
      return rejected(
        'not_replyable',
        `该轮回复处于 ${turn.reply}：请先 retryMessage，再开始新的回复`,
      );
    }

    // 助手消息可能已经存在（失败 / 中止后重试再开始）：**复用它的 seq**，
    // 保证「同一 message_id ⇒ 同一 seq」这条稳定顺序不被重试打破。
    const seq = existingAssistant === undefined ? this.#nextMessageSeq : existingAssistant.seq;
    if (existingAssistant === undefined) this.#nextMessageSeq += 1;
    const assistant = this.#put({
      message_id: assistantId,
      seq,
      role: 'assistant',
      text: '',
      ...(turn.task_id === undefined ? {} : { task_id: turn.task_id }),
      reply_to: turnId,
      state: 'streaming',
      reply: 'streaming',
      chunks: Object.freeze([]),
      attempts: 0,
    });
    this.#patch(turnId, { reply: 'streaming' });
    this.#emit({ kind: 'reply_started', message_id: turnId, ...(turn.task_id === undefined ? {} : { task_id: turn.task_id }) });
    return Object.freeze({ ok: true as const, value: assistant });
  }

  /**
   * 追加一段增量回复。**`message_id` 与 `seq` 全程不变**，只有 `chunks` / `text` 增长。
   */
  appendReplyChunk(
    turnId: MessageId,
    chunk: string,
  ): TurnOk<TurnMessage> | { ok: false; code: TurnFailureCode; message: string } {
    if (typeof chunk !== 'string' || chunk.length === 0) {
      return rejected('empty_text', '回复片段不能为空');
    }
    const assistantId = this.assistantMessageIdFor(turnId);
    const assistant = this.#messages.get(assistantId);
    if (assistant === undefined) return rejected('unknown_message', `这一轮还没有开始回复（${turnId}）`);
    if (assistant.state !== 'streaming') {
      return rejected('not_streaming', `回复已处于 ${assistant.state}，不能再追加片段`);
    }
    const chunks = Object.freeze([...assistant.chunks, chunk]);
    const updated = this.#patch(assistantId, { chunks, text: chunks.join('') });
    this.#emit({ kind: 'reply_chunk', message_id: assistantId, ...(assistant.task_id === undefined ? {} : { task_id: assistant.task_id }) });
    return Object.freeze({ ok: true as const, value: updated });
  }

  /** 回复完成。任务随之 `completed`（若任务已被取消则**拒绝**，不把取消洗成完成）。 */
  completeReply(turnId: MessageId): TurnOk<TurnMessage> | { ok: false; code: TurnFailureCode; message: string } {
    const assistantId = this.assistantMessageIdFor(turnId);
    const assistant = this.#messages.get(assistantId);
    if (assistant === undefined) return rejected('unknown_message', `这一轮还没有开始回复（${turnId}）`);
    // 先看任务是否已被取消：取消是"终态"，不能因为助手消息恰好也已 cancelled 就被判成普通状态错。
    if (assistant.task_id !== undefined && this.#tasks.get(assistant.task_id)?.status === 'cancelled') {
      return rejected('task_cancelled', '任务已取消：不能把取消中的回复标成完成');
    }
    if (assistant.state !== 'streaming') {
      return rejected('not_streaming', `回复已处于 ${assistant.state}，不能重复完成`);
    }
    const updated = this.#patch(assistantId, { state: 'completed', reply: 'completed' });
    this.#patch(turnId, { reply: 'completed' });
    if (assistant.task_id !== undefined) this.#setTaskStatus(assistant.task_id, 'completed');
    this.#emit({ kind: 'reply_completed', message_id: assistantId, ...(assistant.task_id === undefined ? {} : { task_id: assistant.task_id }) });
    return Object.freeze({ ok: true as const, value: updated });
  }

  /** 回复失败（可重试）。任务随之 `failed`。 */
  failReply(
    turnId: MessageId,
    error: TurnError,
  ): TurnOk<TurnMessage> | { ok: false; code: TurnFailureCode; message: string } {
    const assistantId = this.assistantMessageIdFor(turnId);
    const assistant = this.#messages.get(assistantId);
    if (assistant === undefined) return rejected('unknown_message', `这一轮还没有开始回复（${turnId}）`);
    if (assistant.state !== 'streaming') {
      return rejected('not_streaming', `回复已处于 ${assistant.state}，不能再判失败`);
    }
    const updated = this.#patch(assistantId, { state: 'failed', reply: 'failed', error });
    this.#patch(turnId, { state: 'failed', reply: 'failed', error });
    if (assistant.task_id !== undefined) this.#setTaskStatus(assistant.task_id, 'failed');
    this.#emit({
      kind: 'reply_failed',
      message_id: assistantId,
      ...(assistant.task_id === undefined ? {} : { task_id: assistant.task_id }),
      detail: error.code,
    });
    return Object.freeze({ ok: true as const, value: updated });
  }

  // -------------------------------------------------------------------------
  // 写：重试（**不重复建任务**）
  // -------------------------------------------------------------------------

  /**
   * 重试一轮。**复用同一条用户消息**（同 `message_id`、同 `seq`、同 `client_id`、同 `task_id`），
   * **绝不新建任务**；`attempts` +1，助手消息重置后重新开始。
   *
   * 仅 `reply ∈ {failed, aborted}` 可重试；在途（`streaming`）与已完成、以及任务已取消的
   * （`reply='cancelled'`）一律拒绝。
   */
  retryMessage(turnId: MessageId): TurnOk<TurnMessage> | { ok: false; code: TurnFailureCode; message: string } {
    const turn = this.#messages.get(turnId);
    if (turn === undefined) return rejected('unknown_message', `未知消息 ${turnId}`);
    if (turn.role !== 'user') return rejected('not_a_user_message', '重试以用户消息为单位');
    if (turn.reply === 'cancelled') {
      return rejected('task_cancelled', '任务已取消：这条轮次不可重试');
    }
    if (turn.reply !== 'failed' && turn.reply !== 'aborted') {
      return rejected('not_retryable', `只有失败或已中止的轮次可重试，当前为 ${turn.reply}`);
    }

    const assistantId = this.assistantMessageIdFor(turnId);
    const assistant = this.#messages.get(assistantId);
    if (assistant !== undefined) {
      this.#patch(assistantId, {
        state: 'sending',
        reply: 'idle',
        text: '',
        chunks: Object.freeze([]),
      });
    }
    const updated = this.#patch(turnId, {
      state: 'received',
      reply: 'idle',
      attempts: turn.attempts + 1,
    });
    if (turn.task_id !== undefined) this.#setTaskStatus(turn.task_id, 'running');
    this.#emit({
      kind: 'message_retried',
      message_id: turnId,
      ...(turn.task_id === undefined ? {} : { task_id: turn.task_id }),
      detail: `attempt=${String(updated.attempts)}`,
    });
    return Object.freeze({ ok: true as const, value: updated });
  }

  // -------------------------------------------------------------------------
  // 写：停止 —— 两种语义，各自有状态
  // -------------------------------------------------------------------------

  /**
   * **中止回复**（用户按"停止"）：只停这一轮的生成。
   * 消息 `reply='aborted'`、`state='cancelled'`，**任务状态不变**（仍 `running`），之后可重试。
   */
  abortReply(
    turnId: MessageId,
  ): TurnOk<{ readonly kind: 'reply_aborted'; readonly message: TurnMessage; readonly task_status: TurnTaskStatus }> | {
    ok: false;
    code: TurnFailureCode;
    message: string;
  } {
    const turn = this.#messages.get(turnId);
    if (turn === undefined || turn.role !== 'user') {
      return rejected('unknown_message', `未知的用户消息 ${turnId}`);
    }
    const assistantId = this.assistantMessageIdFor(turnId);
    const assistant = this.#messages.get(assistantId);
    if (assistant === undefined || (assistant.state !== 'streaming' && assistant.state !== 'sending')) {
      return rejected('no_active_reply', '这一轮没有正在生成的回复可中止');
    }
    this.#patch(assistantId, { state: 'cancelled', reply: 'aborted' });
    const updated = this.#patch(turnId, { state: 'cancelled', reply: 'aborted' });
    // 任务状态**不动**——这正是"中止回复 ≠ 取消任务"的落点。
    const taskStatus = turn.task_id === undefined ? 'running' : (this.#tasks.get(turn.task_id)?.status ?? 'running');
    this.#emit({
      kind: 'reply_aborted',
      message_id: turnId,
      ...(turn.task_id === undefined ? {} : { task_id: turn.task_id }),
    });
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({ kind: 'reply_aborted' as const, message: updated, task_status: taskStatus }),
    });
  }

  /**
   * **取消任务**：任务变 `cancelled`，其下所有消息 `reply='cancelled'`、`state='cancelled'`，
   * 且**不可重试**。与 `abortReply` 是两套语义（返回值 `kind` 不同）。
   */
  cancelTask(
    taskId: TaskId,
  ): TurnOk<{ readonly kind: 'task_cancelled'; readonly task: TurnTask; readonly aborted_replies: number }> | {
    ok: false;
    code: TurnFailureCode;
    message: string;
  } {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return rejected('unknown_task', `未知任务 ${taskId}`);
    if (task.status === 'cancelled' || task.status === 'completed') {
      return rejected('already_terminal', `任务已处于 ${task.status}，不能取消`);
    }
    const cancelled = this.#setTaskStatus(taskId, 'cancelled');
    let aborted = 0;
    for (const message of this.listMessages()) {
      if (message.task_id !== taskId) continue;
      if (message.role === 'user') {
        this.#patch(message.message_id, { state: 'cancelled', reply: 'cancelled' });
        aborted += 1;
      } else {
        this.#patch(message.message_id, { state: 'cancelled', reply: 'cancelled' });
      }
    }
    this.#emit({ kind: 'task_cancelled', task_id: taskId });
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({ kind: 'task_cancelled' as const, task: cancelled, aborted_replies: aborted }),
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #put(message: TurnMessage): TurnMessage {
    const frozen = Object.freeze({ ...message, chunks: Object.freeze([...message.chunks]) });
    if (!this.#messages.has(message.message_id)) this.#messageOrder.push(message.message_id);
    this.#messages.set(message.message_id, frozen);
    return frozen;
  }

  #patch(messageId: MessageId, patch: Partial<TurnMessage>): TurnMessage {
    const current = this.#messages.get(messageId);
    if (current === undefined) {
      throw new Error(`内部不一致：对不存在的消息打补丁 ${messageId}`);
    }
    return this.#put({ ...current, ...patch, message_id: current.message_id, seq: current.seq });
  }

  #taskOf(message: TurnMessage): TurnTask {
    const taskId = message.task_id;
    if (taskId === undefined) {
      throw new Error('内部不一致：已接受的消息缺少任务绑定');
    }
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new Error('内部不一致：消息绑定的任务不存在');
    }
    return task;
  }

  #setTaskStatus(taskId: TaskId, status: TurnTaskStatus): TurnTask {
    const current = this.#tasks.get(taskId);
    if (current === undefined) {
      throw new Error(`内部不一致：对不存在的任务改状态 ${taskId}`);
    }
    const updated = Object.freeze({ ...current, status });
    this.#tasks.set(taskId, updated);
    return updated;
  }

  #emit(event: Omit<TurnEvent, 'seq'>): TurnEvent {
    const seq = this.#nextEventSeq;
    this.#nextEventSeq += 1;
    const full: TurnEvent = Object.freeze({ seq, ...event });
    this.#events.push(full);
    return full;
  }
}
