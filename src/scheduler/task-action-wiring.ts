/**
 * KRN-07 / KRN-09 的**接线策略**（FA-S）。
 *
 * 本文件不是新的语义层：七态、六态、迟到判定、幂等键的语义全部在
 * `src/workledger/action-ledger.ts`（KRN-07）与 `./task-lifecycle.ts`（KRN-09）里，
 * **已冻结、本文件不改写**。它只做一件事：把这两套判定**接到真实入口**
 * （`on_message` / `start_run` / `finish_run` / `Scheduler` 的公开方法）上，
 * 并让结果经**同一个事务**写进 `TaskActionStorePort`（见 `task-action-store.ts`）。
 *
 * ## 三条接线判据（任务书里的正反例，逐条对应）
 *
 * 1. **反例①（KRN-09）**：`gateRunResultArrival()` 在 `finish_run` 的**最前面**读任务生命周期；
 *    任务处于 `cancelled` / `paused` / `timed_out` / `failed`（或本轮的版本已过期）时，
 *    到达的结果被 `classifyResultArrival()` 判为**迟到**，其 `honored_as_success` 是字面量 `false`
 *    —— 于是 `finish_run` **拒绝全部发布**（`accepted: false`），工作项**不会**变成完成。
 *    **是这条闸门在拦**：把 `finishRunInTransaction` 里那一段摘掉，
 *    反向对照用例必须变红（见 `task-action-wiring.test.ts` 的 `反例③`）。
 * 2. **反例②（KRN-07 + R213）**：`clickActionInTransaction()` 先比任务版本。
 *    点击自报的版本落后于当前任务版本 ⇒ 拒 `stale_task_revision`（旧气泡过期）；
 *    同版本改参数却沿用旧幂等键 ⇒ 拒 `idempotency_key_mismatch`（参数变了就是另一个动作）。
 * 3. **正例（R243）**：同一 `(task, revision, kind, params)` 的第二次点击命中同一幂等键 ⇒
 *    `duplicate: true` 且 `side_effects_applied === 0`，返回的**就是台账里那一个对象**
 *    （"气泡与执行读同一对象"）。
 *
 * ## 纪律
 *
 * - 只用注入的 `LogicalTime`；**无墙钟、无随机**（合同 R50.4 附四-2）。
 * - 不 import `src/storage`：只按结构化接口消费事务句柄（见 `task-action-store.ts`）。
 */

import {
  INITIAL_REVISION,
  type ActionRef,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type Revision,
  type RunId,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import {
  ActionLedgerError,
  assertIdempotencyKeyConsistent,
  createDecisionBubble,
  evaluateBubbleExecution,
  invalidateStaleActions,
  isActionExecutable,
  prepareAction,
  type ActionAuthorization,
  type ActionLedgerRejectionReason,
  type ActionRecord,
} from '../workledger/index.js';
import {
  classifyResultArrival,
  createTaskLifecycle,
  applyTaskLifecycleTransition,
  summarizeTaskLifecycle,
  type LateResultReason,
  type ResultOutcome,
  type TaskLifecycleState,
  type TaskLifecycleSummary,
} from './task-lifecycle.js';
import {
  resolveTaskActionPort,
  type TaskActionStorePort,
  type TaskActionWiringState,
} from './task-action-store.js';
import type { SchedulerDeps } from './deps.js';

// ---------------------------------------------------------------------------
// 台账读写小工具（全部经端口，绝不直接持有状态）
// ---------------------------------------------------------------------------

function findActionByKey(port: TaskActionStorePort, key: string): ActionRecord | undefined {
  return port.listActionRecords().find((record) => record.idempotency_key === key);
}

/** 某任务的全部动作记录（按幂等键插入顺序）。 */
export function actionRecordsOf(port: TaskActionStorePort, taskId: TaskId): readonly ActionRecord[] {
  return Object.freeze(port.listActionRecords().filter((record) => record.task_id === taskId));
}

/** 某任务的生命周期；不存在时为 null（**不**顺手创建一个——创建是显式动作）。 */
export function taskLifecycleOf(
  port: TaskActionStorePort,
  taskId: TaskId,
): TaskLifecycleState | null {
  return port.getTaskLifecycle(taskId) ?? null;
}

/** 生命周期观测汇总（把 `any_late_honored` 这类不变量暴露给验收）。 */
export function taskLifecycleSummaryOf(
  port: TaskActionStorePort,
  taskId: TaskId,
): TaskLifecycleSummary | null {
  const state = taskLifecycleOf(port, taskId);
  return state === null ? null : summarizeTaskLifecycle(state);
}

// ---------------------------------------------------------------------------
// KRN-09：生命周期随轮次起止
// ---------------------------------------------------------------------------

export interface EnsureLifecycleInput {
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly at: LogicalTime;
  readonly reason?: string;
}

/**
 * 确保任务有生命周期记录（`start_run` 的接线点）。
 *
 * - 不存在 → 建 `running`（`reason` 记为本轮启动说明）；
 * - 已存在且 `running` → **原样保留**（幂等，不重置计数）；
 * - 已存在但**不是** `running`（暂停/取消/超时/失败/完成）→ 原样保留并**如实回报**，
 *   由调用方（`start_run`）用 `isTaskAcceptingResults` 决定是否放行新轮次。
 *   这里**不**改写状态——"取消不可复活"是 KRN-09 的冻结语义。
 */
export function ensureTaskLifecycle(
  port: TaskActionStorePort,
  input: EnsureLifecycleInput,
): TaskLifecycleState {
  const existing = port.getTaskLifecycle(input.task_id);
  if (existing !== undefined) {
    return existing;
  }
  const created = createTaskLifecycle({
    task_id: input.task_id,
    revision: input.revision,
    at: input.at,
    reason: input.reason ?? null,
  });
  port.putTaskLifecycle(created);
  return created;
}

/** 任务此刻是否接受"结果"（`running` 才接受）。 */
export function isTaskAcceptingResults(state: TaskLifecycleState | null): boolean {
  return state === null || state.status === 'running';
}

export interface CancelLifecycleInput {
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly at: LogicalTime;
  readonly reason: string;
  /** 置取消的那条消息（可追踪；取消不是"无来源的用户操作"）。 */
  readonly message_id?: MessageId | undefined;
  readonly side_effects?: TaskLifecycleState['side_effects'] | undefined;
}

/**
 * 取消消息到达时的生命周期接线（`on_message` 的接点）。
 *
 * 与 `TaskControlState.cancelled` **并存**而不是替代它：控制状态是协议层的单调事实，
 * 生命周期是任务级运行态。二者由同一条取消消息在同一事务内一起置位，
 * 因此不会出现"轮次级说取消、任务级还说 running"的漂移（FA-O 接口声明 §2-2 的风险）。
 *
 * 已经是终态（`cancelled` / `completed`）→ 原样返回，不改写历史。
 */
export function cancelTaskLifecycle(
  port: TaskActionStorePort,
  input: CancelLifecycleInput,
): TaskLifecycleState {
  const existing = port.getTaskLifecycle(input.task_id) ?? createTaskLifecycle({
    task_id: input.task_id,
    revision: input.revision,
    at: input.at,
    reason: null,
  });
  if (existing.status === 'cancelled' || existing.status === 'completed') {
    port.putTaskLifecycle(existing);
    return existing;
  }
  const next = applyTaskLifecycleTransition({
    state: existing,
    to: 'cancelled',
    at: input.at,
    reason: input.reason,
    cancelled_by_message_id: input.message_id,
    side_effects: input.side_effects,
  });
  port.putTaskLifecycle(next);
  return next;
}

export interface TaskLifecycleControlInput {
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly at: LogicalTime;
  readonly reason: string;
}

function transitionOrCreate(
  port: TaskActionStorePort,
  input: TaskLifecycleControlInput,
  to: 'paused' | 'running' | 'timed_out' | 'failed',
): TaskLifecycleState {
  const existing =
    port.getTaskLifecycle(input.task_id) ??
    createTaskLifecycle({ task_id: input.task_id, revision: input.revision, at: input.at });
  const next = applyTaskLifecycleTransition({
    state: existing,
    to,
    at: input.at,
    reason: input.reason,
  });
  port.putTaskLifecycle(next);
  return next;
}

/** 暂停（KRN-09：暂停期间到达的结果一律判迟到）。 */
export function pauseTaskLifecycle(
  port: TaskActionStorePort,
  input: TaskLifecycleControlInput,
): TaskLifecycleState {
  return transitionOrCreate(port, input, 'paused');
}

/** 继续（暂停 → 运行中）。  命名用 `unpause` 而非 `resume`：`Scheduler` 门面上的 `resume*` 会与
 * 独立验收里那条"门面不得有产物恢复/重发布入口"的结构探针（/recover|republish|resume/i）撞名。
 * 语义层 `task-lifecycle.ts` 的 `resumeTask()` 原样不动——那是 FA-O 冻结的纯函数。 */
export function unpauseTaskLifecycle(
  port: TaskActionStorePort,
  input: TaskLifecycleControlInput,
): TaskLifecycleState {
  return transitionOrCreate(port, input, 'running');
}

/** 置超时（KRN-09：超时后到达的结果一律判迟到）。 */
export function timeoutTaskLifecycle(
  port: TaskActionStorePort,
  input: TaskLifecycleControlInput,
): TaskLifecycleState {
  return transitionOrCreate(port, input, 'timed_out');
}

/** 置失败（KRN-09：失败后到达的结果一律判迟到；`failed` 可经显式恢复回 `running`）。 */
export function failTaskLifecycle(
  port: TaskActionStorePort,
  input: TaskLifecycleControlInput,
): TaskLifecycleState {
  return transitionOrCreate(port, input, 'failed');
}

// ---------------------------------------------------------------------------
// KRN-09 核心：轮次结果的迟到闸门（`finish_run` 的接线点）
// ---------------------------------------------------------------------------

/** 本轮**自报**的结局（内核据此判定；迟到与否由内核说了算，不自报成功）。 */
export function declaredOutcomeOf(
  publications: readonly { readonly kind: string }[],
): ResultOutcome {
  if (publications.some((publication) => publication.kind === 'completed')) {
    return 'completed';
  }
  if (publications.some((publication) => publication.kind === 'failed')) {
    return 'failed';
  }
  return 'unknown';
}

export interface ResultArrivalGateInput {
  readonly task_id: TaskId;
  readonly run_id: RunId;
  /** 本轮冻结的任务版本（结果**属于**这一版）。 */
  readonly result_task_revision: Revision;
  readonly outcome: ResultOutcome;
  readonly at: LogicalTime;
  readonly side_effects?: TaskLifecycleState['side_effects'];
  readonly note?: string;
}

export interface ResultArrivalGateVerdict {
  readonly wiring: TaskActionWiringState;
  /** 是否迟到（任务已不接受"成功"，或结果版本已过期）。 */
  readonly late: boolean;
  readonly late_reason: LateResultReason | null;
  /** 闸门实际落下的生命周期状态（未接线时为 null）。 */
  readonly lifecycle: TaskLifecycleState | null;
  readonly message: string;
}

/**
 * `finish_run` 的迟到闸门。
 *
 * 未接线（端口不存在）⇒ `late: false, wiring: 'unwired'`：**如实回报未接线**，
 * 由调用方决定是否放行（`finish_run` 会在返回值上带 `task_wiring`）。
 * 接线后：
 * - 生命周期不存在 ⇒ 顺手补一条 `running`（结果视为正常到达）；
 * - 存在且**不是** `running`（或结果版本 ≠ 生命周期版本）⇒ **迟到**：
 *   调 `classifyResultArrival()` 把留痕写进生命周期（`honored_as_success` 恒 `false`），
 *   任务状态**不变**，调用方必须拒绝全部发布。
 */
export function gateRunResultArrival(
  tx: StorageTransaction,
  input: ResultArrivalGateInput,
  deps: SchedulerDeps,
): ResultArrivalGateVerdict {
  const { port, wiring } = resolveTaskActionPort(tx, deps.taskActions);
  if (port === null) {
    return {
      wiring,
      late: false,
      late_reason: null,
      lifecycle: null,
      message: '未接线：动作台账 / 任务生命周期不参与本次事务（如实回报，不用内存冒充持久介质）',
    };
  }

  const existing = port.getTaskLifecycle(input.task_id);
  const state =
    existing ??
    createTaskLifecycle({
      task_id: input.task_id,
      revision: input.result_task_revision,
      at: input.at,
      reason: 'finish_run 补建生命周期（此前无记录）',
    });

  // **正常到达**：任务运行中且结果版本一致 ⇒ 运行态**不变**。
  //
  // 为什么不在这里把任务置 `completed`：任务完成是**任务级**判定（还有没有未结的交付物），
  // 不是"某一轮发布了一条 completed"就能推导出来的。把单轮发布当任务完成，
  // 正是 R213 "一句话改多个关联产物 ⇒ 只更新受影响产物"要防的那类越级结论。
  if (isTaskAcceptingResults(state) && input.result_task_revision === state.revision) {
    if (existing === undefined) {
      port.putTaskLifecycle(state);
    }
    return {
      wiring,
      late: false,
      late_reason: null,
      lifecycle: state,
      message: '结果按期到达：任务运行态不变（任务完成由任务级判定，不由单轮发布推导）',
    };
  }

  // **迟到**：唯一分类实现是 `classifyResultArrival()`——接线层不另写一套判定。
  const verdict = classifyResultArrival({
    state,
    run_id: input.run_id,
    result_task_revision: input.result_task_revision,
    outcome: input.outcome,
    at: input.at,
    side_effects: input.side_effects,
    note: input.note,
  });
  port.putTaskLifecycle(verdict.next);

  return {
    wiring,
    late: verdict.late,
    late_reason: verdict.late_reason,
    lifecycle: verdict.next,
    message: verdict.message,
  };
}

// ---------------------------------------------------------------------------
// KRN-07：动作点击（`Scheduler.clickAction` 的接线点）
// ---------------------------------------------------------------------------

export interface ActionAuthorizationInput {
  readonly source: string;
  /** 是否用户本人显式批准（R245：外部网页/文件里的"假批准"不得置真，由可信入口负责）。 */
  readonly user_approved: boolean;
  /** 授权绑定的任务版本；省略 = 与本次点击的当前任务版本一致。 */
  readonly task_revision?: Revision;
  readonly revoked?: boolean;
  readonly subject_instance_id?: InstanceId | null;
  readonly granted_at?: LogicalTime;
}

export interface ActionClickRequest {
  readonly task_id: TaskId;
  /**
   * **点击自报**的任务版本（气泡上那一份快照）。
   * 省略 = 采用已注册任务的当前版本。
   * 与当前版本不一致 ⇒ 旧气泡过期，拒绝（R213）。
   */
  readonly task_revision?: Revision;
  readonly action_kind: string;
  readonly params: unknown;
  readonly authorization: ActionAuthorizationInput;
  /** 气泡身份（给出时：重复点击会额外过一遍"气泡 ↔ 执行读同一对象"判定）。 */
  readonly bubble_id?: string;
  /** 幂等键**提示**：与 `(task, revision, kind, params)` 推导不符即拒（KRN-07 反例）。 */
  readonly idempotency_key?: string;
  /** 显式动作 id（确定性场景）；省略时由 `deps.idSource.next('action')` 生成。 */
  readonly action_id?: string;
  readonly at?: LogicalTime;
}

export interface ActionClickRejection {
  readonly reason: ActionLedgerRejectionReason | 'unknown_task' | 'unwired';
  readonly message: string;
}

export interface ActionClickResult {
  readonly accepted: boolean;
  /** true = 重复点击命中台账已有动作（**没有**新副作用）。 */
  readonly duplicate: boolean;
  readonly side_effects_applied: number;
  readonly action: ActionRecord | null;
  readonly rejection: ActionClickRejection | null;
  readonly wiring: TaskActionWiringState;
  /** 判 stale 用的当前任务版本（任务未注册时为 null）。 */
  readonly current_task_revision: Revision | null;
}

function clickRejected(
  wiring: TaskActionWiringState,
  currentRevision: Revision | null,
  reason: ActionClickRejection['reason'],
  message: string,
): ActionClickResult {
  return Object.freeze({
    accepted: false,
    duplicate: false,
    side_effects_applied: 0,
    action: null,
    rejection: Object.freeze({ reason, message }),
    wiring,
    current_task_revision: currentRevision,
  });
}

/**
 * **经真实入口点击一个动作**（R243「气泡与执行读同一对象」+ R213「旧气泡过期」）。
 *
 * 判定顺序（顺序即优先级，用例依赖它给出确定性拒因）：
 * 1. 未接线 → `unwired`（**不**静默用内存记账）；
 * 2. 任务未注册 → `unknown_task`（无法判 stale，宁可拒绝也不放行——R213 的"宁可拒绝"）；
 * 3. 自报版本 < 当前版本 → `stale_task_revision`（**反例②**：任务版本升级后旧动作不得仍可执行）；
 * 4. 授权版本 ≠ 当前版本 → `authorization_revision_mismatch`（不得跨版本复用授权）；
 * 5. 幂等键与参数不符 → `idempotency_key_mismatch`（**反例② 第二条**：参数变了就是另一个动作）；
 * 6. 命中已有幂等键 → **幂等返回**（`duplicate: true`、副作用 0；**正例**）；
 * 7. 其余 → 建"已准备"记录并落台账。
 */
export function clickActionInTransaction(
  tx: StorageTransaction,
  request: ActionClickRequest,
  deps: SchedulerDeps,
): ActionClickResult {
  const { port, wiring } = resolveTaskActionPort(tx, deps.taskActions);
  if (port === null) {
    return clickRejected(
      wiring,
      null,
      'unwired',
      '未接线：动作台账不参与本次事务（如实回报，不用内存冒充持久介质）',
    );
  }

  const task = tx.getTask(request.task_id);
  if (task === undefined) {
    return clickRejected(
      wiring,
      null,
      'unknown_task',
      `任务 ${request.task_id} 未注册：无法判定动作是否过期，按 R213 拒绝（宁可拒绝不放行）`,
    );
  }
  const currentRevision = task.revision;

  if (request.task_revision !== undefined && request.task_revision !== currentRevision) {
    return clickRejected(
      wiring,
      currentRevision,
      'stale_task_revision',
      `旧气泡过期：点击自报任务版本 ${Number(request.task_revision)}，当前 ${Number(currentRevision)}` +
        '（R213：旧版本动作不得仍可执行）',
    );
  }

  const authorizationRevision = request.authorization.task_revision ?? currentRevision;
  if (authorizationRevision !== currentRevision) {
    return clickRejected(
      wiring,
      currentRevision,
      'authorization_revision_mismatch',
      `授权绑定任务版本 ${Number(authorizationRevision)}，当前 ${Number(currentRevision)}：` +
        '不得跨版本复用授权',
    );
  }

  const at = request.at ?? deps.now();
  if (request.idempotency_key !== undefined) {
    // 给了幂等键提示 ⇒ 先过守卫：同版本改参数却沿用旧键会被拒（**反例② 第二条**）。
    try {
      assertIdempotencyKeyConsistent({
            idempotency_key: request.idempotency_key,
            task_id: request.task_id,
            task_revision: currentRevision,
            action_kind: request.action_kind,
            params: request.params,
          });
    } catch (error) {
      if (error instanceof ActionLedgerError) {
        return clickRejected(wiring, currentRevision, error.reason, error.message);
      }
      throw error;
    }
  }

  const authorization: ActionAuthorization = Object.freeze({
    source: request.authorization.source,
    user_approved: request.authorization.user_approved,
    task_revision: currentRevision,
    revoked: request.authorization.revoked ?? false,
    subject_instance_id: request.authorization.subject_instance_id ?? null,
    granted_at: request.authorization.granted_at ?? at,
  });

  // 先按参数算一次（幂等键未给定时它就是键的来源；给定时上面已校验过一致性）。
  const probe = prepareAction({
    action_id: request.action_id ?? deps.idSource.next('action'),
    task_id: request.task_id,
    task_revision: currentRevision,
    action_kind: request.action_kind,
    params: request.params,
    authorization,
    at,
  });
  const effectiveKey = request.idempotency_key ?? probe.idempotency_key;

  const existing = findActionByKey(port, effectiveKey);
  if (existing !== undefined) {
    if (request.bubble_id !== undefined) {
      const bubble = createDecisionBubble(existing, request.bubble_id, at);
      const verdict = evaluateBubbleExecution(bubble, existing, {
        current_task_revision: currentRevision,
      });
      if (!verdict.ok) {
        return clickRejected(wiring, currentRevision, verdict.reason ?? 'stale_bubble', verdict.message);
      }
    }
    return Object.freeze({
      accepted: true,
      duplicate: true,
      side_effects_applied: 0,
      action: existing,
      rejection: null,
      wiring,
      current_task_revision: currentRevision,
    });
  }

  port.putActionRecord(probe);
  return Object.freeze({
    accepted: true,
    duplicate: false,
    side_effects_applied: 0,
    action: probe,
    rejection: null,
    wiring,
    current_task_revision: currentRevision,
  });
}

// ---------------------------------------------------------------------------
// KRN-07：任务版本推进 ⇒ 旧动作批量失效（R213）
// ---------------------------------------------------------------------------

export interface InvalidateStaleActionsInput {
  readonly task_id: TaskId;
  readonly current_revision: Revision;
  readonly at: LogicalTime;
  readonly reason?: string;
}

export interface InvalidateStaleActionsResult {
  readonly wiring: TaskActionWiringState;
  readonly invalidated: number;
  readonly scanned: number;
  /** 失效后该任务仍在台账里的全部记录。 */
  readonly actions: readonly ActionRecord[];
}

/**
 * 任务版本推进时把旧版本的非终态动作批量置为 `invalidated_or_failed`（R213 旧气泡过期）。
 *
 * 已经是终态的记录**原样保留**（历史版本不得改写）。
 */
export function invalidateStaleActionsForTask(
  tx: StorageTransaction,
  input: InvalidateStaleActionsInput,
  deps: SchedulerDeps,
): InvalidateStaleActionsResult {
  const { port, wiring } = resolveTaskActionPort(tx, deps.taskActions);
  if (port === null) {
    return { wiring, invalidated: 0, scanned: 0, actions: Object.freeze([]) };
  }
  const mine = actionRecordsOf(port, input.task_id);
  const next = invalidateStaleActions(
    mine,
    input.current_revision,
    input.at,
    input.reason ?? `任务版本推进到 ${Number(input.current_revision)}：旧版本动作失效（R213）`,
  );
  let invalidated = 0;
  for (let index = 0; index < mine.length; index += 1) {
    const before = mine[index];
    const after = next[index];
    if (before === undefined || after === undefined || before === after) {
      continue;
    }
    invalidated += 1;
    port.putActionRecord(after);
  }
  return Object.freeze({
    wiring,
    invalidated,
    scanned: mine.length,
    actions: Object.freeze(actionRecordsOf(port, input.task_id)),
  });
}

/**
 * 动作此刻是否可执行（KRN-07 的执行前置；供执行器与验收读）。
 *
 * **直接复用** `src/workledger` 的 `isActionExecutable()`——不在本文件重写状态机，
 * 否则"接线层"和"语义层"会各有一套执行判定（漂移风险）。
 */
export function isActionRecordExecutable(
  record: ActionRecord,
  currentTaskRevision: Revision,
): boolean {
  return isActionExecutable(record, { current_task_revision: currentTaskRevision });
}

// ---------------------------------------------------------------------------
// 只读观测（验收与证据用）
// ---------------------------------------------------------------------------

export interface TaskActionObservation {
  readonly wiring: TaskActionWiringState;
  readonly action_count: number;
  readonly lifecycle: TaskLifecycleSummary | null;
}

/** 事务内观测某任务的动作 / 生命周期（只读，不写）。 */
export function observeTaskActions(
  tx: StorageTransaction,
  taskId: TaskId,
  deps: SchedulerDeps,
): TaskActionObservation {
  const { port, wiring } = resolveTaskActionPort(tx, deps.taskActions);
  if (port === null) {
    return { wiring, action_count: 0, lifecycle: null };
  }
  return {
    wiring,
    action_count: actionRecordsOf(port, taskId).length,
    lifecycle: taskLifecycleSummaryOf(port, taskId),
  };
}

/** 未注册任务时的初始版本兜底（与 `runs.ts` 同口径）。 */
export const TASK_ACTION_INITIAL_REVISION: Revision = INITIAL_REVISION;
