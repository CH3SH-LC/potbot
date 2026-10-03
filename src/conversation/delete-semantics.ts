/**
 * **四类删除语义**（CHAT-08；完整能力目录 2026-10-03）。
 *
 * ## 四件事**必须分得开**
 *
 * | 动作 | 删掉什么 | **不**删什么 |
 * |---|---|---|
 * | 删除会话 | 会话本身（连同它的任务/记忆**引用**） | 任务卡不自动取消、别的会话、已发生副作用 |
 * | 取消任务 | 把某个任务置为 `cancelled` | 会话、别的任务、文件、记忆、已发生副作用 |
 * | 删除文件 | 从任务卡上摘掉一个文件引用 | 会话、任务、记忆、已发生副作用 |
 * | 忘记记忆 | 从会话上摘掉一条记忆引用 | 会话、任务、文件、已发生副作用 |
 *
 * 四条路径各有**自己的**结果的形状与副作用面，互不冒充。把它们塞进一个
 * `deleteEverything()` 是这类系统最常见的错误。
 *
 * ## 两条硬纪律（本文件的**存在理由**）
 *
 * ### ① 删了聊天，**不得**继续执行未获准动作
 *
 * 一个外部动作在"等用户授权"（{@link ActionGate} 的 `awaiting_authorization`）时是**没有**
 * 副作用的。若用户此时删掉整个会话，那条动作**必须**被作废——{@link ConversationDeletion.deleteSession}
 * 会把该会话所有**未执行**的动作（含已授权但尚未执行的）置为 `denied`，
 * 之后 `execute()` 一律返回 `session_deleted` 且**不产生**任何副作用记录。
 * 反向对照：会话若**没有**被删，同一条已授权动作会正常执行并留下副作用记录——
 * 证明"不执行"是删除导致的，而不是阀门本来就不通。
 *
 * ### ② 不假称撤销已发生副作用
 *
 * 外部世界的动作（发过一封邮件、写过一份盘上的文件）**撤销不了**。本层因此：
 * - 所有 `DeletionOutcome.reverted` 是**字面量 `false`**（不是 `boolean`，调用方**无法**
 *   把它当成"已撤销"来用）；
 * - 每条 {@link SideEffectRecord} 的 `reversible` / `reverted` 均为**字面量 `false`**，
 *   且删除后**仍然保留**在账本里（`retained_side_effects`）；
 * - 想"撤回删除"的调用会拿到 `irreversible_side_effect`（{@link ConversationDeletion.attemptUndoDeletion}），
 *   本层**没有**任何接口能返回 `reverted: true`。
 *
 * ## 纪律
 *
 * 纯逻辑 + 注入依赖（会话模型 / 任务板）；零 IO；时间由调用方传入。
 */

import { asLogicalTime, type LogicalTime, type TaskId } from '../protocol/index.js';
import {
  ConversationSessions,
  type ConversationFailureCode,
  type ConversationId,
  type ConversationMemoryRef,
} from './session-model.js';
import { ConversationTaskBoard, type TaskFailureCode } from './session-tasks.js';

// ---------------------------------------------------------------------------
// 四类动作（封闭枚举）
// ---------------------------------------------------------------------------

export const DELETE_ACTIONS = ['delete_session', 'cancel_task', 'delete_file', 'forget_memory'] as const;
export type DeleteActionKind = (typeof DELETE_ACTIONS)[number];

export type DeletionFailureCode =
  | 'session_not_found'
  | 'task_not_found'
  | 'task_not_in_session'
  | 'file_not_found'
  | 'memory_not_found'
  | 'action_not_found'
  | 'action_not_authorized'
  | 'action_already_settled'
  | 'session_deleted'
  | 'task_cancelled'
  /** 想撤销一个已经发生的外部副作用——本层**没有**这种能力。 */
  | 'irreversible_side_effect';

/**
 * `DeletionOutcome.code` 的取值：本层自己的码，**或**上游层（会话模型 / 任务板）的码。
 *
 * 刻意**不**把上游码改写成"大概对应"的本层码：`task_not_in_session` 与 `task_not_found`
 * 是两个不同的事实，改写会让调用方分不清"跨会话访问被拒"和"真的没有这个任务"。
 * 上游失败一律**原样透传**（信息不丢）。
 */
export type DeletionOutcomeCode = DeletionFailureCode | ConversationFailureCode | TaskFailureCode;

// ---------------------------------------------------------------------------
// 副作用账本
// ---------------------------------------------------------------------------

/**
 * 一条**外部副作用**的真实记录。
 *
 * `reverted` 与 `reversible` 都是**字面量 `false`**：本层不假装能撤销外部世界。
 */
export interface SideEffectRecord {
  readonly effect_id: string;
  readonly kind: 'external_side_effect';
  readonly conversation_id: ConversationId;
  readonly task_id: TaskId | null;
  readonly file_id: string | null;
  readonly description: string;
  readonly occurred_at: LogicalTime;
  readonly reversible: false;
  readonly reverted: false;
}

/** 账本：副作用**只增不减**（删除动作不会抹掉它）。 */
export class SideEffectLedger {
  readonly #records: SideEffectRecord[] = [];

  record(input: {
    readonly effect_id: string;
    readonly conversation_id: ConversationId;
    readonly task_id?: TaskId | null;
    readonly file_id?: string | null;
    readonly description: string;
    readonly at: LogicalTime;
  }): SideEffectRecord {
    const record: SideEffectRecord = Object.freeze({
      effect_id: input.effect_id,
      kind: 'external_side_effect' as const,
      conversation_id: input.conversation_id,
      task_id: input.task_id ?? null,
      file_id: input.file_id ?? null,
      description: input.description,
      occurred_at: asLogicalTime(input.at),
      reversible: false as const,
      reverted: false as const,
    });
    this.#records.push(record);
    return record;
  }

  all(): readonly SideEffectRecord[] {
    return Object.freeze([...this.#records]);
  }

  /** 与会话相关的副作用记录（删除该会话后**仍在**）。 */
  forConversation(conversation_id: ConversationId): readonly SideEffectRecord[] {
    return Object.freeze(this.#records.filter((item) => item.conversation_id === conversation_id));
  }

  forTask(task_id: TaskId): readonly SideEffectRecord[] {
    return Object.freeze(this.#records.filter((item) => item.task_id === task_id));
  }
}

// ---------------------------------------------------------------------------
// 动作阀门（未获准动作不得执行的落点）
// ---------------------------------------------------------------------------

export type PendingActionState = 'awaiting_authorization' | 'authorized' | 'denied' | 'executed';

/** 一条**等待授权**的外部动作。它**尚未**产生副作用。 */
export interface PendingAction {
  readonly action_id: string;
  readonly conversation_id: ConversationId;
  readonly task_id: TaskId | null;
  readonly description: string;
  readonly state: PendingActionState;
  /** 被拒绝的原因（`denied` 时非空；否则 `null`）。 */
  readonly denied_reason: 'session_deleted' | 'task_cancelled' | null;
  /** 已执行时对应的副作用记录 id。 */
  readonly effect_id: string | null;
  readonly raised_at: LogicalTime;
  readonly resolved_at: LogicalTime | null;
}

export type SemanticsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: DeletionFailureCode; readonly message: string };

function semanticsOk<T>(value: T): SemanticsResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function semanticsFail<T>(code: DeletionFailureCode, message: string): SemanticsResult<T> {
  return Object.freeze({ ok: false as const, code, message });
}

/**
 * 动作阀门。`raise` 只**登记**一个尚未授权的动作（零副作用）；
 * `authorize` 才算用户拍板；`execute` 是**唯一**产生副作用的出口。
 */
export class ActionGate {
  readonly #sessions: ConversationSessions;
  readonly #ledger: SideEffectLedger;
  readonly #actions = new Map<string, PendingAction>();

  constructor(deps: { readonly sessions: ConversationSessions; readonly ledger: SideEffectLedger }) {
    this.#sessions = deps.sessions;
    this.#ledger = deps.ledger;
  }

  raise(input: {
    readonly action_id: string;
    readonly conversation_id: ConversationId;
    readonly task_id?: TaskId | null;
    readonly description: string;
    readonly at: LogicalTime;
  }): SemanticsResult<PendingAction> {
    if (input.action_id.trim().length === 0) {
      return semanticsFail('action_not_found', 'action_id 不能为空');
    }
    if (this.#sessions.getSession(input.conversation_id) === null) {
      // 会话都不在，就没有"等待授权"可言（不会给已删会话重新挂动作）。
      return semanticsFail('session_not_found', `没有会话 ${input.conversation_id}`);
    }
    const action: PendingAction = Object.freeze({
      action_id: input.action_id,
      conversation_id: input.conversation_id,
      task_id: input.task_id ?? null,
      description: input.description,
      state: 'awaiting_authorization' as const,
      denied_reason: null,
      effect_id: null,
      raised_at: asLogicalTime(input.at),
      resolved_at: null,
    });
    this.#actions.set(input.action_id, action);
    return semanticsOk(action);
  }

  authorize(action_id: string, at: LogicalTime): SemanticsResult<PendingAction> {
    return this.#settleAuth(action_id, at, 'authorized');
  }

  /** 用户拒绝（或系统作废）。 */
  deny(action_id: string, at: LogicalTime): SemanticsResult<PendingAction> {
    return this.#settleAuth(action_id, at, 'denied');
  }

  #settleAuth(
    action_id: string,
    at: LogicalTime,
    next: 'authorized' | 'denied',
  ): SemanticsResult<PendingAction> {
    const action = this.#actions.get(action_id);
    if (action === undefined) {
      return semanticsFail('action_not_found', `没有动作 ${action_id}`);
    }
    if (action.state === next) {
      return semanticsOk(action); // 幂等
    }
    if (action.state !== 'awaiting_authorization') {
      return semanticsFail('action_already_settled', `动作 ${action_id} 已是 ${action.state}，不能再改为 ${next}`);
    }
    const updated: PendingAction = Object.freeze({
      ...action,
      state: next,
      denied_reason: next === 'denied' ? null : action.denied_reason,
      resolved_at: asLogicalTime(at),
    });
    this.#actions.set(action_id, updated);
    return semanticsOk(updated);
  }

  /**
   * **唯一**产生副作用的出口。
   *
   * 三道门：① 动作存在；② 已 `authorized`（`awaiting_authorization` ⇒ `action_not_authorized`，
   * **零副作用**）；③ 会话仍存在（被删 ⇒ `session_deleted`，**零副作用**）。
   */
  execute(
    action_id: string,
    at: LogicalTime,
  ): SemanticsResult<{ readonly action: PendingAction; readonly side_effect: SideEffectRecord }> {
    const action = this.#actions.get(action_id);
    if (action === undefined) {
      return semanticsFail('action_not_found', `没有动作 ${action_id}`);
    }
    if (action.state === 'executed') {
      // 幂等：同一动作重复执行不再产生第二条副作用。
      const effect = this.#ledger.all().find((item) => item.effect_id === action.effect_id);
      if (effect === undefined) {
        return semanticsFail('action_already_settled', `动作 ${action_id} 已执行但账本里找不到对应副作用`);
      }
      return semanticsOk(Object.freeze({ action, side_effect: effect }));
    }
    if (action.state === 'denied') {
      const code: DeletionFailureCode = action.denied_reason === 'task_cancelled' ? 'task_cancelled' : 'session_deleted';
      return semanticsFail(code, `动作 ${action_id} 已被作废（${action.denied_reason ?? 'denied'}），不执行`);
    }
    if (action.state === 'awaiting_authorization') {
      return semanticsFail('action_not_authorized', `动作 ${action_id} 尚未获准，不执行（零副作用）`);
    }
    // 纵深防御：即便状态是 authorized，会话没了也绝不动手。
    if (this.#sessions.getSession(action.conversation_id) === null) {
      const denied: PendingAction = Object.freeze({
        ...action,
        state: 'denied' as const,
        denied_reason: 'session_deleted' as const,
        resolved_at: asLogicalTime(at),
      });
      this.#actions.set(action_id, denied);
      return semanticsFail('session_deleted', `会话 ${action.conversation_id} 已删除，动作 ${action_id} 不执行`);
    }
    const effect = this.#ledger.record({
      effect_id: `effect-${action.action_id}`,
      conversation_id: action.conversation_id,
      task_id: action.task_id,
      description: action.description,
      at,
    });
    const executed: PendingAction = Object.freeze({
      ...action,
      state: 'executed' as const,
      effect_id: effect.effect_id,
      resolved_at: asLogicalTime(at),
    });
    this.#actions.set(action_id, executed);
    return semanticsOk(Object.freeze({ action: executed, side_effect: effect }));
  }

  get(action_id: string): PendingAction | null {
    return this.#actions.get(action_id) ?? null;
  }

  /** 某会话下所有动作（只读旁证）。 */
  actionsOf(conversation_id: ConversationId): readonly PendingAction[] {
    return Object.freeze([...this.#actions.values()].filter((item) => item.conversation_id === conversation_id));
  }

  /** 把尚未执行的动作作废（删除会话 / 取消任务时调用）。返回被作废的动作 id。 */
  revokeAll(
    filter: (action: PendingAction) => boolean,
    reason: 'session_deleted' | 'task_cancelled',
    at: LogicalTime,
  ): readonly string[] {
    const revoked: string[] = [];
    for (const [id, action] of this.#actions) {
      if (action.state !== 'authorized' && action.state !== 'awaiting_authorization') {
        continue;
      }
      if (!filter(action)) {
        continue;
      }
      this.#actions.set(
        id,
        Object.freeze({
          ...action,
          state: 'denied' as const,
          denied_reason: reason,
          resolved_at: asLogicalTime(at),
        }),
      );
      revoked.push(id);
    }
    return Object.freeze(revoked);
  }
}

// ---------------------------------------------------------------------------
// 删除结果
// ---------------------------------------------------------------------------

/**
 * 一次删除动作的结果。
 *
 * `reverted` 是**字面量 `false`**：无论删的是会话、任务、文件还是记忆，
 * 已发生的外部副作用都**没有**被（也不可能被）撤销。
 */
export interface DeletionOutcome {
  readonly action: DeleteActionKind;
  readonly ok: boolean;
  readonly code: DeletionOutcomeCode | null;
  readonly message: string;
  /** 本次真正移除的实体（会话 id / 任务 id / 文件 id / 记忆引用）。 */
  readonly removed: readonly string[];
  /** 删除会话后**脱离**该会话、但仍存在的任务（不静默取消；取消请用 `cancelTask`）。 */
  readonly detached_tasks: readonly TaskId[];
  /** 本次被作废的未获准/未执行动作 id。 */
  readonly denied_actions: readonly string[];
  /** 被保留的真实副作用记录——删除**不会**抹掉它们。 */
  readonly retained_side_effects: readonly SideEffectRecord[];
  /** **字面量 `false`**。 */
  readonly reverted: false;
  readonly at: LogicalTime;
}

// ---------------------------------------------------------------------------
// 删除语义
// ---------------------------------------------------------------------------

export class ConversationDeletion {
  readonly #sessions: ConversationSessions;
  readonly #board: ConversationTaskBoard;
  readonly #gate: ActionGate;
  readonly #ledger: SideEffectLedger;

  constructor(deps: {
    readonly sessions: ConversationSessions;
    readonly board: ConversationTaskBoard;
    readonly gate: ActionGate;
    readonly ledger: SideEffectLedger;
  }) {
    this.#sessions = deps.sessions;
    this.#board = deps.board;
    this.#gate = deps.gate;
    this.#ledger = deps.ledger;
  }

  /**
   * **删除会话**：拿掉会话本身。任务**不自动取消**（那是另一种语义），
   * 但该会话下**所有未执行的动作一律作废**（纪律 ①）。
   */
  deleteSession(conversation_id: ConversationId, at: LogicalTime): DeletionOutcome {
    const session = this.#sessions.getSession(conversation_id);
    if (session === null) {
      return this.#fail('delete_session', 'session_not_found', `没有会话 ${conversation_id}`, at);
    }
    const detached = session.task_refs;
    const denied = this.#gate.revokeAll(
      (action) => action.conversation_id === conversation_id,
      'session_deleted',
      at,
    );
    const removed = this.#sessions.deleteSession(conversation_id);
    if (!removed.ok) {
      return this.#fail('delete_session', removed.code, removed.message, at);
    }
    return this.#ok('delete_session', [conversation_id], denied, this.#ledger.forConversation(conversation_id), detached, at);
  }

  /** **取消任务**：会话仍在、别的任务不受影响；该任务的未执行动作作废。 */
  cancelTask(conversation_id: ConversationId, task_id: TaskId, at: LogicalTime): DeletionOutcome {
    const card = this.#board.taskCard(conversation_id, task_id);
    if (!card.ok) {
      return this.#fail('cancel_task', card.code, card.message, at);
    }
    const cancelled = this.#board.cancelTask(conversation_id, task_id, at);
    if (!cancelled.ok) {
      return this.#fail('cancel_task', cancelled.code, cancelled.message, at);
    }
    const denied = this.#gate.revokeAll((action) => action.task_id === task_id, 'task_cancelled', at);
    // 解绑会话上的任务引用（任务卡保留在板上，便于查看终态）。
    this.#sessions.detachTask(conversation_id, task_id, at);
    return this.#ok('cancel_task', [task_id], denied, this.#ledger.forTask(task_id), [], at);
  }

  /** **删除文件**：只摘掉一个文件引用；会话、任务、记忆都不动。 */
  deleteFile(conversation_id: ConversationId, task_id: TaskId, file_id: string, at: LogicalTime): DeletionOutcome {
    const removed = this.#board.removeFile(conversation_id, task_id, file_id, at);
    if (!removed.ok) {
      const code: DeletionFailureCode =
        removed.code === 'task_not_in_session' ? 'task_not_in_session' : removed.code === 'task_not_found' ? 'task_not_found' : 'file_not_found';
      return this.#fail('delete_file', code, removed.message, at);
    }
    const retained = Object.freeze(this.#ledger.forTask(task_id).filter((item) => item.file_id === file_id));
    return this.#ok('delete_file', [file_id], [], retained, [], at);
  }

  /** **忘记记忆**：只摘掉会话上的一条记忆引用；会话与任务都不动。 */
  forgetMemory(conversation_id: ConversationId, memoryRef: ConversationMemoryRef, at: LogicalTime): DeletionOutcome {
    const session = this.#sessions.getSession(conversation_id);
    if (session === null) {
      return this.#fail('forget_memory', 'session_not_found', `没有会话 ${conversation_id}`, at);
    }
    if (!session.memory_refs.includes(memoryRef)) {
      return this.#fail('forget_memory', 'memory_not_found', `会话 ${conversation_id} 上没有记忆 ${memoryRef}`, at);
    }
    const result = this.#sessions.detachMemory(conversation_id, memoryRef, at);
    if (!result.ok) {
      return this.#fail('forget_memory', result.code, result.message, at);
    }
    return this.#ok('forget_memory', [memoryRef], [], [], [], at);
  }

  /**
   * **反向对照**：想"撤销"一次删除。本层**没有**这种能力——外部副作用撤销不了，
   * 因此这里恒返回 `irreversible_side_effect`，且**不**改动任何状态。
   */
  attemptUndoDeletion(outcome: DeletionOutcome): SemanticsResult<never> {
    return semanticsFail(
      'irreversible_side_effect',
      `${outcome.action} 已生效：外部副作用（${String(outcome.retained_side_effects.length)} 条）撤销不了，本层不提供"已撤销"的假象`,
    );
  }

  // --- 构造结果 -----------------------------------------------------------

  #ok(
    action: DeleteActionKind,
    removed: readonly string[],
    denied_actions: readonly string[],
    retained: readonly SideEffectRecord[],
    detached_tasks: readonly TaskId[],
    at: LogicalTime,
  ): DeletionOutcome {
    return Object.freeze({
      action,
      ok: true as const,
      code: null,
      message: '',
      removed: Object.freeze([...removed]),
      detached_tasks: Object.freeze([...detached_tasks]),
      denied_actions: Object.freeze([...denied_actions]),
      retained_side_effects: Object.freeze([...retained]),
      reverted: false as const,
      at: asLogicalTime(at),
    });
  }

  #fail(action: DeleteActionKind, code: DeletionOutcomeCode, message: string, at: LogicalTime): DeletionOutcome {
    return Object.freeze({
      action,
      ok: false as const,
      code,
      message,
      removed: Object.freeze([]),
      detached_tasks: Object.freeze([]),
      denied_actions: Object.freeze([]),
      retained_side_effects: Object.freeze([]),
      reverted: false as const,
      at: asLogicalTime(at),
    });
  }
}

/** 一次性装配四类语义（会话模型 / 任务板 / 阀门 / 账本 + 删除器）。 */
export function createConversationDeletion(deps: {
  readonly sessions: ConversationSessions;
  readonly board: ConversationTaskBoard;
  readonly ledger?: SideEffectLedger;
  readonly gate?: ActionGate;
}): { readonly deletion: ConversationDeletion; readonly gate: ActionGate; readonly ledger: SideEffectLedger } {
  const ledger = deps.ledger ?? new SideEffectLedger();
  const gate = deps.gate ?? new ActionGate({ sessions: deps.sessions, ledger });
  const deletion = new ConversationDeletion({ sessions: deps.sessions, board: deps.board, gate, ledger });
  return Object.freeze({ deletion, gate, ledger });
}
