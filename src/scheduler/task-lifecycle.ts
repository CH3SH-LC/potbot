/**
 * 任务生命周期与迟到结果（KRN-09；合同 `full-app-contract-v1` **R205 / R213 / R216 / R226**）。
 *
 * ## 现状与缺口
 *
 * 取消在此之前只以 `TaskControlState.cancelled`（协议层、单调不可撤）与
 * `finishRunInTransaction()` 的"任务级取消"分支存在——那是**轮次级**的拒绝发布，
 * 结构上回答的是"这一轮能不能交结果"。**没有**任务级的
 * 暂停 / 继续 / 超时 / 失败恢复状态机，也**没有**"取消后迟到结果"的独立分类与留痕。
 *
 * ## 本模块冻结的三条语义（对应任务给出的判据）
 *
 * 1. **迟到结果不得变成当前成功**：`classifyResultArrival()` 在任务处于
 *    `cancelled` / `timed_out` / `failed` / `paused` 或结果版本落后时，
 *    一律判为"迟到"（`honored_as_success: false`），**不改变任务状态**。
 * 2. **已发生副作用保留真实记录**：迟到结果携带的副作用照实收进 `side_effects`
 *    （`reverted` 恒为 `false`，复用 `src/workledger` 的 `ActionSideEffect`）——
 *    **不假称撤销**（R205）。
 * 3. **取消不可复活**：`cancelled` 是终态，唯一出口是新建任务，不是回退
 *    （与协议 `TaskControlState` 的单调性一致）。
 *
 * ## 纪律
 *
 * - 纯函数 + 不可变记录，**无 I/O**；时间一律以 `LogicalTime` 传入（无墙钟/随机）。
 * - 依赖方向：`src/scheduler → src/protocol` + `src/scheduler → src/workledger`（既有方向，未新增）。
 */

import {
  type LogicalTime,
  type MessageId,
  type Revision,
  type RunId,
  type TaskId,
} from '../protocol/index.js';
import { type ActionSideEffect } from '../workledger/index.js';

// ---------------------------------------------------------------------------
// 任务运行态
// ---------------------------------------------------------------------------

/** 任务运行态。`cancelled` 与 `completed` 是**终态**；`failed` / `timed_out` 可经显式恢复到 `running`。 */
export const TASK_RUNTIME_STATUSES = [
  'running',
  'paused',
  'cancelled',
  'timed_out',
  'failed',
  'completed',
] as const;

export type TaskRuntimeStatus = (typeof TASK_RUNTIME_STATUSES)[number];

export const TASK_RUNTIME_STATUS_LABELS: Readonly<Record<TaskRuntimeStatus, string>> = Object.freeze({
  running: '进行中',
  paused: '已暂停',
  cancelled: '已取消',
  timed_out: '已超时',
  failed: '已失败',
  completed: '已完成',
});

/** 终态：不再接受任何状态转换。 */
export const TASK_TERMINAL_STATUSES = ['cancelled', 'completed'] as const;

/** 可以经"失败恢复"回到 `running` 的状态。 */
export const TASK_RECOVERABLE_STATUSES = ['failed', 'timed_out'] as const;

export function isTaskRuntimeStatus(value: unknown): value is TaskRuntimeStatus {
  return typeof value === 'string' && (TASK_RUNTIME_STATUSES as readonly string[]).includes(value);
}

export function isTerminalTaskStatus(status: TaskRuntimeStatus): boolean {
  return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isRecoverableTaskStatus(status: TaskRuntimeStatus): boolean {
  return (TASK_RECOVERABLE_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const TASK_LIFECYCLE_REJECTION_REASONS = [
  'unknown_task_status',
  'illegal_task_transition',
  'terminal_locked',
  'missing_reason',
  'not_recoverable',
  'stale_task_revision',
] as const;

export type TaskLifecycleRejectionReason = (typeof TASK_LIFECYCLE_REJECTION_REASONS)[number];

export class TaskLifecycleError extends Error {
  readonly reason: TaskLifecycleRejectionReason;

  constructor(reason: TaskLifecycleRejectionReason, message: string) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 迟到结果留痕
// ---------------------------------------------------------------------------

/** 迟到原因：任务已经不接受"成功"这件事，或结果绑定的版本已过期。 */
export const LATE_RESULT_REASONS = [
  'task_cancelled',
  'task_timed_out',
  'task_failed',
  'task_paused',
  'stale_task_revision',
] as const;

export type LateResultReason = (typeof LATE_RESULT_REASONS)[number];

/** 结果自报的结局（迟到与否都由内核判定，**不自报成功**）。 */
export type ResultOutcome = 'completed' | 'failed' | 'unknown';

/**
 * 一条**迟到结果**的留痕。
 *
 * `honored_as_success` 是**字面量 `false`**：本模块不提供"把迟到结果当成功"的表达能力
 * （对应判据：取消后迟到结果不得变成当前成功）。
 *
 * **V-3 口径统一**：这是全仓**唯一**的 `honored_as_success`。它表达的是"这条**记录**的类型
 * 不允许是成功"（一个**类型级拒绝标记**），不是"本次到达的发布决定"——后者由
 * `LateResultGateVerdict.publish` 表达。此前 `LateResultGateVerdict` 另设了一个同名的
 * `boolean` 字段（与 `publish` 取值恒等），已删除，不再同名不同型。
 * 因此本字段的检查（`summarizeTaskLifecycle` 的 `any_late_honored`、`late-result-gate` 的
 * `invariantViolations`）在类型系统内**不可达**，只是防御性输入校验。
 */
export interface LateResultRecord {
  readonly run_id: RunId;
  readonly result_task_revision: Revision;
  readonly outcome: ResultOutcome;
  readonly arrived_at: LogicalTime;
  readonly reason: LateResultReason;
  /** 字面量 false：迟到结果绝不被当成当前成功（类型级拒绝标记）。 */
  readonly honored_as_success: false;
  readonly note: string;
}

/** 结果未知的留痕（R246：未知结果不盲目重试）。 */
export interface UnknownResultRecord {
  readonly run_id: RunId;
  readonly result_task_revision: Revision;
  readonly arrived_at: LogicalTime;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// 生命周期记录
// ---------------------------------------------------------------------------

export interface TaskLifecycleState {
  readonly task_id: TaskId;
  /** 任务版本（与动作/工作项绑定的版本同一口径）。 */
  readonly revision: Revision;
  readonly status: TaskRuntimeStatus;
  /** 进入当前状态的原因（暂停/取消/超时/失败必有；running/completed 可为 null）。 */
  readonly reason: string | null;
  readonly paused_at: LogicalTime | null;
  readonly cancelled_at: LogicalTime | null;
  readonly timed_out_at: LogicalTime | null;
  readonly failed_at: LogicalTime | null;
  readonly completed_at: LogicalTime | null;
  /** 置取消的那条消息（可追踪）。 */
  readonly cancelled_by_message_id: MessageId | null;
  readonly pause_count: number;
  readonly timeout_count: number;
  /** 失败/超时后经显式恢复回到 running 的次数。 */
  readonly recovery_count: number;
  /** **已发生**的副作用记录（`reverted` 恒 false）。 */
  readonly side_effects: readonly ActionSideEffect[];
  /** 迟到结果留痕（照实记录，绝不当成功）。 */
  readonly late_results: readonly LateResultRecord[];
  /** 结果未知留痕（不得盲目重试）。 */
  readonly unknown_results: readonly UnknownResultRecord[];
  readonly updated_at: LogicalTime;
}

export interface CreateTaskLifecycleInput {
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly at: LogicalTime;
  readonly status?: TaskRuntimeStatus;
  readonly reason?: string | null;
}

/** 新建生命周期：默认 `running`。 */
export function createTaskLifecycle(input: CreateTaskLifecycleInput): TaskLifecycleState {
  const status = input.status ?? 'running';
  return Object.freeze({
    task_id: input.task_id,
    revision: input.revision,
    status,
    reason: input.reason ?? null,
    paused_at: null,
    cancelled_at: null,
    timed_out_at: null,
    failed_at: null,
    completed_at: null,
    cancelled_by_message_id: null,
    pause_count: 0,
    timeout_count: 0,
    recovery_count: 0,
    side_effects: Object.freeze([]),
    late_results: Object.freeze([]),
    unknown_results: Object.freeze([]),
    updated_at: input.at,
  });
}

// ---------------------------------------------------------------------------
// 状态转换（暂停 / 继续 / 取消 / 超时 / 失败 / 恢复 / 完成）
// ---------------------------------------------------------------------------

const TASK_TRANSITIONS: Readonly<Record<TaskRuntimeStatus, readonly TaskRuntimeStatus[]>> = Object.freeze({
  running: ['paused', 'cancelled', 'timed_out', 'failed', 'completed'],
  paused: ['running', 'cancelled', 'timed_out', 'failed'],
  // 失败 / 超时：只能显式恢复为 running，或直接取消（不得"自己变成完成"）。
  failed: ['running', 'cancelled'],
  timed_out: ['running', 'cancelled'],
  cancelled: [],
  completed: [],
});

export function canTransitionTask(from: TaskRuntimeStatus, to: TaskRuntimeStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export interface TaskLifecycleTransitionRequest {
  readonly state: TaskLifecycleState;
  readonly to: TaskRuntimeStatus;
  readonly at: LogicalTime;
  /** 暂停/取消/超时/失败/恢复 的原因（除 `completed` 外**必须**非空）。 */
  readonly reason?: string;
  readonly cancelled_by_message_id?: MessageId;
  /** 本次转换一并落下的、实际已发生的副作用。 */
  readonly side_effects?: readonly ActionSideEffect[];
  /** 当前任务版本（给出时用于过期判定）。 */
  readonly current_task_revision?: Revision;
}

export interface TaskLifecycleVerdict {
  readonly ok: boolean;
  readonly from: TaskRuntimeStatus;
  readonly to: TaskRuntimeStatus;
  readonly reason: TaskLifecycleRejectionReason | null;
  readonly message: string;
  readonly next: TaskLifecycleState | null;
}

function taskReject(
  state: TaskLifecycleState,
  to: TaskRuntimeStatus,
  reason: TaskLifecycleRejectionReason,
  message: string,
): TaskLifecycleVerdict {
  return { ok: false, from: state.status, to, reason, message, next: null };
}

/**
 * 判定一次任务生命周期转换（**纯函数**，不抛错）。
 *
 * 顺序：目标合法 → 终态冻结 → 版本过期 → 转换表 → 原因必填。
 */
export function evaluateTaskLifecycleTransition(request: TaskLifecycleTransitionRequest): TaskLifecycleVerdict {
  const { state, to } = request;

  if (!isTaskRuntimeStatus(to)) {
    return taskReject(state, to, 'unknown_task_status', `任务运行态取值非法：${String(to)}`);
  }
  if (isTerminalTaskStatus(state.status)) {
    return taskReject(
      state,
      to,
      'terminal_locked',
      `任务 ${state.task_id} 已是终态 ${state.status}：不得回退或复活（取消不可撤销，R205）`,
    );
  }
  if (request.current_task_revision !== undefined && request.current_task_revision !== state.revision) {
    return taskReject(
      state,
      to,
      'stale_task_revision',
      `任务版本已由 ${Number(state.revision)} 推进到 ${Number(request.current_task_revision)}：` +
        `旧版本的生命周期转换被拒（R213）`,
    );
  }
  if (!canTransitionTask(state.status, to)) {
    return taskReject(state, to, 'illegal_task_transition', `非法的任务状态转换：${state.status} → ${to}`);
  }
  if (to !== 'completed' && (request.reason === undefined || request.reason.trim().length === 0)) {
    return taskReject(state, to, 'missing_reason', `转到 ${to} 必须给出非空原因`);
  }

  const mergedSideEffects: readonly ActionSideEffect[] =
    request.side_effects === undefined
      ? state.side_effects
      : Object.freeze([...state.side_effects, ...request.side_effects]);

  const next: TaskLifecycleState = Object.freeze({
    ...state,
    status: to,
    reason: to === 'completed' ? null : (request.reason ?? null),
    paused_at: to === 'paused' ? request.at : state.paused_at,
    cancelled_at: to === 'cancelled' ? request.at : state.cancelled_at,
    timed_out_at: to === 'timed_out' ? request.at : state.timed_out_at,
    failed_at: to === 'failed' ? request.at : state.failed_at,
    completed_at: to === 'completed' ? request.at : state.completed_at,
    cancelled_by_message_id:
      to === 'cancelled' ? (request.cancelled_by_message_id ?? null) : state.cancelled_by_message_id,
    pause_count: to === 'paused' ? state.pause_count + 1 : state.pause_count,
    timeout_count: to === 'timed_out' ? state.timeout_count + 1 : state.timeout_count,
    recovery_count:
      isRecoverableTaskStatus(state.status) && to === 'running' ? state.recovery_count + 1 : state.recovery_count,
    side_effects: mergedSideEffects,
    updated_at: request.at,
  });

  return { ok: true, from: state.status, to, reason: null, message: '', next };
}

/** 应用一次生命周期转换：允许则返回新状态，拒绝则抛 `TaskLifecycleError`。 */
export function applyTaskLifecycleTransition(request: TaskLifecycleTransitionRequest): TaskLifecycleState {
  const verdict = evaluateTaskLifecycleTransition(request);
  if (!verdict.ok || verdict.next === null) {
    throw new TaskLifecycleError(verdict.reason ?? 'illegal_task_transition', verdict.message);
  }
  return verdict.next;
}

/** 便捷：暂停。 */
export function pauseTask(state: TaskLifecycleState, at: LogicalTime, reason: string): TaskLifecycleState {
  return applyTaskLifecycleTransition({ state, to: 'paused', at, reason });
}

/** 便捷：继续（从暂停恢复）。 */
export function resumeTask(state: TaskLifecycleState, at: LogicalTime, reason: string): TaskLifecycleState {
  return applyTaskLifecycleTransition({ state, to: 'running', at, reason });
}

/** 便捷：失败/超时后的**显式恢复**（不是自动的，也不算成功）。 */
export function recoverTask(state: TaskLifecycleState, at: LogicalTime, reason: string): TaskLifecycleState {
  if (!isRecoverableTaskStatus(state.status)) {
    throw new TaskLifecycleError(
      'not_recoverable',
      `只有 failed / timed_out 可以恢复，当前状态是 ${state.status}`,
    );
  }
  return applyTaskLifecycleTransition({ state, to: 'running', at, reason });
}

/**
 * 便捷：取消。
 * `side_effects` 传入在途动作**已发生**的副作用；它们如实收进记录，**不假称撤销**（R205）。
 */
export function cancelTask(
  state: TaskLifecycleState,
  at: LogicalTime,
  reason: string,
  options: { readonly cancelled_by_message_id?: MessageId; readonly side_effects?: readonly ActionSideEffect[] } = {},
): TaskLifecycleState {
  return applyTaskLifecycleTransition({
    state,
    to: 'cancelled',
    at,
    reason,
    cancelled_by_message_id: options.cancelled_by_message_id,
    side_effects: options.side_effects,
  });
}

/** 逻辑时间超时判定：`now >= deadline` 即超时（与租约同一区间语义 `[start, deadline)`）。 */
export function isTaskTimedOut(deadline: LogicalTime, now: LogicalTime): boolean {
  return now >= deadline;
}

// ---------------------------------------------------------------------------
// 迟到结果分类（KRN-09 的核心判据）
// ---------------------------------------------------------------------------

export interface ResultArrivalInput {
  readonly state: TaskLifecycleState;
  readonly run_id: RunId;
  readonly result_task_revision: Revision;
  readonly outcome: ResultOutcome;
  readonly at: LogicalTime;
  /** 本次到达所携带的、**实际已发生**的副作用（如实保留）。 */
  readonly side_effects?: readonly ActionSideEffect[];
  /** 可读备注。 */
  readonly note?: string;
}

export interface ResultArrivalVerdict {
  /** 该结果是否迟到（任务已不接受"成功"）。 */
  readonly late: boolean;
  readonly late_reason: LateResultReason | null;
  /** 是否改变了任务状态。 */
  readonly applied: boolean;
  readonly next: TaskLifecycleState;
  readonly message: string;
}

function lateReasonOf(state: TaskLifecycleState, resultRevision: Revision): LateResultReason | null {
  switch (state.status) {
    case 'cancelled':
      return 'task_cancelled';
    case 'timed_out':
      return 'task_timed_out';
    case 'failed':
      return 'task_failed';
    case 'paused':
      return 'task_paused';
    default:
      break;
  }
  if (resultRevision !== state.revision) {
    return 'stale_task_revision';
  }
  return null;
}

function appendSideEffects(
  state: TaskLifecycleState,
  _at: LogicalTime,
  sideEffects: readonly ActionSideEffect[] | undefined,
): readonly ActionSideEffect[] {
  if (sideEffects === undefined || sideEffects.length === 0) {
    return state.side_effects;
  }
  // 副作用**照实收录**（`reverted` 恒 false）：已发生就是已发生，不因任务取消而改写历史。
  return Object.freeze([...state.side_effects, ...sideEffects]);
}

/**
 * 判定一个到达的轮次结果是否"迟到"，以及它是否被应用。
 *
 * 判据（按序）：
 * 1. 任务 `cancelled` / `timed_out` / `failed` / `paused` ⇒ 迟到，**状态不变**；
 * 2. 结果版本 ≠ 当前版本 ⇒ 迟到（`stale_task_revision`），**状态不变**；
 * 3. 否则按下发结局应用：`completed` → `completed`；`failed` → `failed`；
 *    `unknown` → **不应用**（R246：未知结果不盲目重试），只留痕。
 *
 * **迟到结果自带的副作用仍如实收进记录**——已发生就是已发生，不能因为任务取消就假装没发生。
 */
export function classifyResultArrival(input: ResultArrivalInput): ResultArrivalVerdict {
  const { state, at } = input;
  const lateReason = lateReasonOf(state, input.result_task_revision);
  const note = input.note ?? '';

  if (lateReason !== null) {
    const record: LateResultRecord = Object.freeze({
      run_id: input.run_id,
      result_task_revision: input.result_task_revision,
      outcome: input.outcome,
      arrived_at: at,
      reason: lateReason,
      honored_as_success: false,
      note:
        note.length > 0
          ? note
          : `轮次 ${input.run_id} 的结果在任务 ${state.status} 之后到达：保留真实记录，不作为当前成功`,
    });
    const next = Object.freeze({
      ...state,
      side_effects: appendSideEffects(state, at, input.side_effects),
      late_results: Object.freeze([...state.late_results, record]),
      updated_at: at,
    });
    return {
      late: true,
      late_reason: lateReason,
      applied: false,
      next,
      message: `迟到结果（${lateReason}）：任务保持 ${state.status}，不得变成当前成功（KRN-09）`,
    };
  }

  if (input.outcome === 'unknown') {
    const unknown: UnknownResultRecord = Object.freeze({
      run_id: input.run_id,
      result_task_revision: input.result_task_revision,
      arrived_at: at,
      note: note.length > 0 ? note : `轮次 ${input.run_id} 结果未知：不盲目重试（R246）`,
    });
    const next = Object.freeze({
      ...state,
      side_effects: appendSideEffects(state, at, input.side_effects),
      unknown_results: Object.freeze([...state.unknown_results, unknown]),
      updated_at: at,
    });
    return {
      late: false,
      late_reason: null,
      applied: false,
      next,
      message: `结果未知：只留痕、不改变任务状态，不盲目重试（R246）`,
    };
  }

  if (input.outcome === 'completed') {
    const next = applyTaskLifecycleTransition({
      state: { ...state, side_effects: appendSideEffects(state, at, input.side_effects) },
      to: 'completed',
      at,
    });
    return { late: false, late_reason: null, applied: true, next, message: `轮次 ${input.run_id} 完成，任务置已完成` };
  }

  // outcome === 'failed'
  const withEffects = { ...state, side_effects: appendSideEffects(state, at, input.side_effects) };
  const next = applyTaskLifecycleTransition({
    state: withEffects,
    to: 'failed',
    at,
    reason: note.length > 0 ? note : `轮次 ${input.run_id} 汇报失败`,
  });
  return { late: false, late_reason: null, applied: true, next, message: `轮次 ${input.run_id} 失败，任务置已失败` };
}

// ---------------------------------------------------------------------------
// 观测汇总
// ---------------------------------------------------------------------------

export interface TaskLifecycleSummary {
  readonly task_id: TaskId;
  readonly status: TaskRuntimeStatus;
  readonly status_label: string;
  readonly terminal: boolean;
  readonly recoverable: boolean;
  readonly pause_count: number;
  readonly timeout_count: number;
  readonly recovery_count: number;
  /** 已发生副作用条数（`reverted` 恒 false）。 */
  readonly side_effect_count: number;
  readonly late_result_count: number;
  readonly unknown_result_count: number;
  /**
   * 迟到结果是否曾被当作成功。
   *
   * **类型系统内恒 false**：`LateResultRecord.honored_as_success` 是字面量 `false`，故
   * `some(r => r.honored_as_success)` 对所有经类型检查的状态恒 `false`。这是**防御性输入校验**
   * （只在绕过类型系统的反序列化输入上可能变真），不是运行期检测器——不要把它读成
   * "运行期实测证明没有迟到结果被当成功"。
   */
  readonly any_late_honored: boolean;
}

export function summarizeTaskLifecycle(state: TaskLifecycleState): TaskLifecycleSummary {
  return Object.freeze({
    task_id: state.task_id,
    status: state.status,
    status_label: TASK_RUNTIME_STATUS_LABELS[state.status],
    terminal: isTerminalTaskStatus(state.status),
    recoverable: isRecoverableTaskStatus(state.status),
    pause_count: state.pause_count,
    timeout_count: state.timeout_count,
    recovery_count: state.recovery_count,
    side_effect_count: state.side_effects.length,
    late_result_count: state.late_results.length,
    unknown_result_count: state.unknown_results.length,
    any_late_honored: state.late_results.some((record) => record.honored_as_success),
  });
}
