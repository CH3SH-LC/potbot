/**
 * `start_run` / `finish_run` 事务（归属 D03；合同 §五 Q5-a、§六、§九-3/§九-9；P1/P3/P7）。
 *
 * ```text
 * start_run(instance):
 *     transaction:
 *         verify task and instance are runnable          → 无活动轮次 + 有可运行输入
 *         verify run budget not exhausted                 → R27.1：R_max 由内核强制（budget_exhausted）
 *         claim the queued item                          → 清除排队标记 + delegation_queue_cleared
 *         freeze actionable input snapshot                → D02 的 freezeInputSnapshot（读入 ≠ 完成）
 *         assign new run_id and finite lease              → createRunLease（逻辑时间，不续租）
 *         set instance active
 *         charge the run into the budget ledger           → R27.1：台账是唯一记账方
 *     run model/tools under current scopes and budgets
 *
 * finish_run(instance, run_id, result):
 *     transaction:
 *         verify run_id and lease ownership                → evaluateRunOwnership（P7）
 *         reject stale publication if task revision changed → stale_task_revision
 *         persist permitted results and update work ledger  → applyWorkItemTransition（D04）
 *         clear active run
 *         if new actionable input exists: enqueue at most one next run
 *         else: mark idle
 * ```
 *
 * **一致性（§九-3）**：抢占排队项、冻结快照、分配 run_id 与租约、置活动**全部在同一个
 * `store.transact()` 内**完成——本文件只提供事务内原语，`Scheduler` 门面把它们包在一个事务里。
 * 因此"先查后置"的竞态在结构上不存在（原子性来自写时复制事务的提交边界，不来自锁）。
 *
 * **所有权核验（§九-9 / R14-6）**：结果写入一律带 `origin: { kind: 'run', … }`，
 * 由 D04 的 `evaluateOrigin()` 复用 protocol 的 `evaluateRunOwnership()` 判定；
 * 工作项级再叠一层"轮次实例必须是工作项负责人"（`owner_mismatch`）——
 * A 拥有的工作项不会被 B 的轮次写进去。
 */

import {
  DEFAULT_LEASE_TTL,
  INITIAL_REVISION,
  PublicationError,
  type ArtifactRecord,
  createRunLease,
  createRunRecord,
  evaluateRunOwnership,
  isTaskCancelled,
  isTerminalStatus,
  type ArtifactRef,
  type BlockerReason,
  type DependencyRef,
  type GroupId,
  type IdSource,
  type InstanceId,
  type InstanceState,
  type KernelEvent,
  type KernelEventInput,
  type LogicalTime,
  type PendingEvent,
  type PublicationRejectionReason,
  type RequestId,
  type Revision,
  type RunId,
  type RunRecord,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import {
  computeFrozenInput,
  freezeInputSnapshot,
  hasRunnableInput,
  patchInstance,
  requireInstance,
  type FrozenInputSnapshot,
} from '../inbox/index.js';
import {
  applyWorkItemTransition,
  isWorkLedgerError,
  markWorkItemReadBySnapshot,
} from '../workledger/index.js';
import { planDependencyResolution, resolutionInputRefId, scopeWorkItems } from '../dependency/index.js';
import {
  resolveNextArtifactVersion,
  stageArtifactInTransaction,
  type ArtifactPublicationIntent,
  type ArtifactMaterializationRequest,
  type StagedArtifactFact,
} from '../artifacts/index.js';
import { SchedulerError, type FinishRunRejectionReason, type StartRunRejectionReason } from './errors.js';
import type { SchedulerDeps } from './deps.js';
import { wakeOnDependencyResolvedInTransaction } from './wakeup.js';
import { runStagnationCheckpoint, type StagnationCheckpointOutcome } from './stagnation.js';
import { runBudgetExhausted, runBudgetGateOf, type RunBudgetGate } from './stagnation.js';
import {
  appendKernelEvent,
  enqueueDeliveryEvent,
  publicationRejectedEvent,
  runFinishedEvent,
  runStartedEvent,
  workItemStatusChangedEvent,
} from './kernel-events.js';
import { clearQueueFlag, markQueueFlagged } from './queue.js';
import { ensureTaskLifecycle, declaredOutcomeOf, gateRunResultArrival } from './task-action-wiring.js';
import { resolveTaskActionPort, type TaskActionWiringState } from './task-action-store.js';
import type { LateResultReason } from './task-lifecycle.js';

/** 认领（`pending → processing`）时的阻塞原因占位：非终态必须有等待/阻塞原因。 */
const PROCESSING_BLOCKER: BlockerReason = Object.freeze({
  kind: 'other',
  detail: '处理中：已由运行轮次认领',
});

// ---------------------------------------------------------------------------
// start_run
// ---------------------------------------------------------------------------

export interface StartRunRequest {
  /** 要启动轮次的实例（必须已注册）。 */
  readonly instance_id: InstanceId;
  /** 显式指定 run_id（确定性场景）；省略时由 id 源生成。 */
  readonly run_id?: RunId;
  /** 显式指定任务身份（省略时按 `resolveTaskId()` 的优先级推断）。 */
  readonly task_id?: TaskId;
  /** 显式指定任务版本（任务未注册时的兜底）。 */
  readonly task_revision?: Revision;
  /** 租约时长覆盖（默认取调度器配置，再默认 `DEFAULT_LEASE_TTL`）。 */
  readonly lease_ttl?: number;
  /** 启动时刻（默认 `now()`）。 */
  readonly at?: LogicalTime;
}

export interface StartRunOutcome {
  readonly started: boolean;
  /** 未启动时的原因（正常路径：空推进）。 */
  readonly reason: StartRunRejectionReason | null;
  readonly run: RunRecord | null;
  readonly snapshot: FrozenInputSnapshot | null;
  /** 本次由 `pending → processing` 认领的工作项。 */
  readonly claimed_request_ids: readonly RequestId[];
  /** 本次是否清除了排队标记（抢占排队项）。 */
  readonly cleared_queued_flag: boolean;
  readonly observation_events: readonly KernelEvent[];
  readonly delivery_events: readonly PendingEvent[];
  readonly published_events: readonly PendingEvent[];
  /** 动作台账 / 任务生命周期本轮的接线状态（FA-S；**如实回报**，见 `task-action-store.ts`）。 */
  readonly task_wiring: TaskActionWiringState;
}

function notStarted(
  reason: StartRunRejectionReason,
  taskWiring: TaskActionWiringState,
  extras: {
    readonly observation_events?: readonly KernelEvent[];
    readonly cleared_queued_flag?: boolean;
  } = {},
): StartRunOutcome {
  return Object.freeze({
    started: false,
    reason,
    run: null,
    snapshot: null,
    claimed_request_ids: Object.freeze([]),
    cleared_queued_flag: extras.cleared_queued_flag ?? false,
    observation_events: Object.freeze(extras.observation_events ?? []),
    delivery_events: Object.freeze([]),
    published_events: Object.freeze([]),
    task_wiring: taskWiring,
  });
}

/**
 * 解析本次轮次所属的任务身份。
 *
 * 优先级（`InstanceState` 不含 `task_id`——附录 A3 的字段清单里没有它，故必须推断或显式给出）：
 * 1. 请求里显式给出的 `task_id`；
 * 2. 本轮快照里**第一条被冻结消息**携带的 `task_id`；
 * 3. 群组内唯一那个 `current_group_id` 相符的**已注册任务**（首版一任务一群组，任务书 §5）；
 * 4. 该实例**自己拥有过的工作项**所指向的唯一任务（含终态项——"这实例做的是哪个任务"
 *    不因工作完成而改变）。**这条兜底就是为依赖解除准备的**：此时快照里可能一条消息都没有；
 * 5. 该实例最近一条待投递调度事件携带的 `task_id`（内核自己记下的"这次唤醒属于哪个任务"，
 *    恰恰覆盖"唤醒端口刚登记、尚未起轮次"的窗口）；
 * 6. 调度器的兜底 `default_task_id`。
 *
 * 六者皆不可得 → `task_unresolved`（不抛错：这是"配置不完整"的**正常**拒绝，
 * 调用方补上 `task_id` 即可；抛错会让夹具分不清"空推进"与"配置错误"）。
 *
 * **给 D07/D09 的集成提示**：最稳的做法是把 `TaskRecord` 注册进存储（或给
 * `createScheduler` 传 `default_task_id`）。否则"既没有历史消息、也没有任何工作项"的实例
 * 无法被推断出任务身份，`start_run` 会一直返回 `task_unresolved`（表现为空推进）。
 */
export function resolveTaskId(
  tx: StorageTransaction,
  instance: InstanceState,
  snapshot: Pick<FrozenInputSnapshot, 'message_ids'>,
  request: { readonly task_id?: TaskId },
  deps: Pick<SchedulerDeps, 'default_task_id'>,
): TaskId | null {
  if (request.task_id !== undefined) {
    return request.task_id;
  }
  for (const messageId of snapshot.message_ids) {
    // **群作用域查询**（合同 v1.2 R37.1；修复 F04）：`message_id` 只在**群内**唯一，
    // 两个群复用同一个 id 是合法的。全局 `getMessage()` 遇到这种情形会抛歧义，
    // 于是"两群各投递同一 id"会让两边都起不了轮次。群身份从**实例**取（快照只有 id）。
    const message = tx.getMessageInGroup(instance.group_id, messageId);
    if (message !== undefined) {
      return message.task_id;
    }
  }
  const byGroup = tx.listTasks().filter((task) => task.current_group_id === instance.group_id);
  const firstTask = byGroup[0];
  if (byGroup.length === 1 && firstTask !== undefined) {
    return firstTask.task_id;
  }
  const owned = new Set<TaskId>();
  for (const item of tx.listWorkItems()) {
    if (item.owner_instance_id === instance.instance_id) {
      owned.add(item.task_id);
    }
  }
  const firstOwned = [...owned][0];
  if (owned.size === 1 && firstOwned !== undefined) {
    return firstOwned;
  }
  // 最近一条属于该实例的待投递调度事件（内核自己记下的唤醒归属）
  let latestTask: TaskId | null = null;
  for (const event of tx.listDeliveryEvents()) {
    if (event.instance_id === instance.instance_id) {
      latestTask = event.task_id;
    }
  }
  if (latestTask !== null) {
    return latestTask;
  }
  return deps.default_task_id;
}

/** 解析本轮冻结的任务版本：已注册任务取权威版本，否则退回显式值 / 消息声明。 */
function resolveTaskRevision(
  tx: StorageTransaction,
  taskId: TaskId,
  snapshot: FrozenInputSnapshot,
  groupId: GroupId,
  request: { readonly task_revision?: Revision },
): Revision {
  const task = tx.getTask(taskId);
  if (task !== undefined) {
    return task.revision;
  }
  if (request.task_revision !== undefined) {
    return request.task_revision;
  }
  let max: Revision = INITIAL_REVISION;
  for (const messageId of snapshot.message_ids) {
    // 群作用域查询（R37.1；修复 F04）——理由同 `resolveTaskId`。
    const message = tx.getMessageInGroup(groupId, messageId);
    if (message !== undefined && message.task_revision > max) {
      max = message.task_revision;
    }
  }
  return max;
}

/**
 * **事务内**启动一个运行轮次。
 *
 * 判定顺序（含"不启动"的正常出口）：
 * 1. 实例必须已注册（未注册抛 `SchedulerError` → 事务回滚，属调用方错误）；
 * 2. 已有活动轮次 → `already_active`（§9.1：同一实例最多一个正在运行的轮次）；
 * 3. 没有可运行输入 → `no_runnable_input`（§9.4：无有效工作不运行）；
 * 4. 任务身份不可推断 → `task_unresolved`（**在写任何记录之前**判出，避免留下"已读但没有轮次"）。
 *
 * 之后一次性完成（§九-3）：分配 run_id 与有限租约 → 冻结输入快照 → 写 `RunRecord` →
 * 抢占排队项并置活动 → 认领工作项（`pending → processing`）→ 登记"已读"。
 */
export function startRunInTransaction(
  tx: StorageTransaction,
  request: StartRunRequest,
  deps: SchedulerDeps,
): StartRunOutcome {
  const at = request.at ?? deps.now();
  const eventIds: IdSource = deps.idSource;
  const observationEvents: KernelEvent[] = [];

  // FA-S 接线：端口解析是纯探测（不写任何东西），放在最前面，
  // 好让**每一条**返回路径都能如实回报接线状态。
  const { port: taskActionPort, wiring: taskWiring } = resolveTaskActionPort(tx, deps.taskActions);

  const instance = requireInstance(tx, request.instance_id);
  if (instance.active_run_id !== null) {
    return notStarted('already_active', taskWiring);
  }
  if (!hasRunnableInput(tx, instance.instance_id)) {
    // 排队标记对应"一次运行机会"。既然没有可运行输入，就不该留下这个标记
    // （否则依赖解除通知的旧副本重放会积下永久残留的排队标记——F10 的收尾面）。
    // 只清标记，不启动轮次、不写已读、不认领工作。
    if (instance.queued_flag) {
      const clearedEmpty = clearQueueFlag(tx, instance, {
        at,
        reason: '无可运行输入：清除残留排队标记（不启动轮次）',
        event_ids: eventIds,
      });
      return notStarted('no_runnable_input', taskWiring, {
        observation_events: clearedEmpty.kernel_events,
        cleared_queued_flag: clearedEmpty.cleared,
      });
    }
    return notStarted('no_runnable_input', taskWiring);
  }

  // R27.1：**运行轮次上限由内核强制**。轮次预算已超限 ⇒ 停止放行新轮次
  // （而不是"先跑完再由诊断事后报告"——事后断言不构成上限）。
  // 受控缺陷 `ignore_budget` 时关闭**闸断**（与 D05 的判定口径一致：缺陷只关一半最危险），
  // 但**仍然记账**——台账要如实反映"实际跑了多少轮"，否则缺陷对照就失去了可比性。
  const runBudgetGate: RunBudgetGate | null = runBudgetGateOf(deps.stagnation);
  const enforceRunBudget = deps.stagnation?.defects?.ignore_budget !== true;
  if (runBudgetGate !== null && enforceRunBudget && runBudgetExhausted(runBudgetGate)) {
    return notStarted('budget_exhausted', taskWiring);
  }

  const runId: RunId = request.run_id ?? deps.idSource.newRunId();

  // 先**只读预览**快照，用于推断任务身份；确认可启动后才真正冻结（写已读记录）。
  const preview = computeFrozenInput(tx, { instance_id: instance.instance_id, run_id: runId, at });
  const taskId = resolveTaskId(tx, instance, preview, request, deps);
  if (taskId === null) {
    return notStarted('task_unresolved', taskWiring);
  }

  // **取消阻止启动**（合同 v1.2 R33.6；修复 F02 的"未开始"分支）：
  // 取消是**任务级**事实。已取消任务不得再产生有效业务执行——包括尚未开始的这一轮：
  // 不写已读、不认领工作、不消费可运行输入、不冻加快照。
  // 残留的排队标记在同一事务内清掉（"排队状态被正确收尾"，而不是"为了清标记而继续跑一轮"）。
  if (isTaskCancelled(tx.getTaskControlState(taskId))) {
    const cancelledEvents: KernelEvent[] = [];
    const beforeCancel = requireInstance(tx, instance.instance_id);
    const clearedOnCancel = clearQueueFlag(tx, beforeCancel, {
      at,
      reason: `任务 ${taskId} 已取消：清除残留排队标记（不启动轮次）`,
      event_ids: eventIds,
    });
    for (const event of clearedOnCancel.kernel_events) {
      cancelledEvents.push(event);
    }
    return notStarted('task_cancelled', taskWiring, {
      observation_events: cancelledEvents,
      cleared_queued_flag: clearedOnCancel.cleared,
    });
  }

  const taskRevision = resolveTaskRevision(tx, taskId, preview, instance.group_id, request);

  // **KRN-09 接线点**：任务级运行态与轮次在同一事务里建立。
  // 未接线（端口为 null）⇒ 此处一行不写，既有行为逐字不变；
  // 接线与否由返回值上的 `task_wiring` 如实回报——**不做静默降级**。
  if (taskActionPort !== null) {
    ensureTaskLifecycle(taskActionPort, {
      task_id: taskId,
      revision: taskRevision,
      at,
      reason: `轮次 ${runId} 启动：任务置运行中`,
    });
  }

  const ttl = request.lease_ttl ?? deps.lease_ttl;
  const lease = createRunLease(runId, instance.instance_id, at, ttl);

  // 冻结（与抢占、run_id、租约同一事务；Q5-a）。
  const snapshot = freezeInputSnapshot(tx, { instance_id: instance.instance_id, run_id: runId, at, event_ids: eventIds });
  if (
    snapshot.message_ids.length !== preview.message_ids.length ||
    snapshot.actionable_input_refs.length !== preview.actionable_input_refs.length
  ) {
    // 防御：同一事务内预览与冻结必须一致（不一致说明冻结实现被改动/回归）。
    throw new SchedulerError('冻结预览与冻结结果不一致：同一事务内的输入快照必须是同一份');
  }

  const run = createRunRecord({
    run_id: runId,
    task_id: taskId,
    group_id: instance.group_id,
    instance_id: instance.instance_id,
    task_revision: taskRevision,
    started_at: at,
    lease_deadline: lease.lease_deadline,
    frozen_at: at,
    frozen_input_message_ids: snapshot.message_ids,
    frozen_request_ids: snapshot.request_ids,
    frozen_actionable_input_refs: snapshot.actionable_input_refs,
  });
  tx.putRun(run);

  // 抢占排队项 + 置活动（同一事务）。
  const before = requireInstance(tx, instance.instance_id);
  const cleared = clearQueueFlag(tx, before, {
    at,
    reason: `轮次 ${runId} 抢占排队项`,
    event_ids: eventIds,
  });
  for (const event of cleared.kernel_events) {
    observationEvents.push(event);
  }
  const active = patchInstance(tx, cleared.instance, {
    activity: 'active',
    active_run_id: runId,
    lease_deadline: lease.lease_deadline,
    queued_flag: false,
    queued_since: null,
    updated_at: at,
  });
  void active;

  const claimed = claimWorkItems(tx, snapshot, runId, at, eventIds, observationEvents);

  observationEvents.push(appendKernelEvent(tx, runStartedEvent(run), eventIds));

  // **记账不在这里做**（合同 v1.2 R34.3；修复 F06）。
  // 旧实现在事务体的最后一行 `chargeStartedRun(...)`——那一行**早于提交**：
  // `transact()` 之后还要过 `beforeCommit` 接缝，接缝抛错时存储里一个 run 都没有，
  // 外部台账却已多记一笔（实测：runs=1 配两次提交前失败 ⇒ 存储 0 run / 台账 runs=2，
  // 移除故障后立刻 budget_exhausted，恢复路径被自己的账目堵死）。
  // 现在：`run_started` 事件随事务一同提交或回滚，记账由 `Scheduler` 在提交之后
  // 按事件身份**幂等投影**（见 `budget-projection.ts`）。

  return Object.freeze({
    started: true,
    reason: null,
    run,
    snapshot,
    claimed_request_ids: Object.freeze(claimed),
    cleared_queued_flag: cleared.cleared,
    observation_events: Object.freeze(observationEvents),
    delivery_events: Object.freeze([]),
    published_events: Object.freeze([]),
    task_wiring: taskWiring,
  });
}

/**
 * 认领本轮读到的工作项：`pending → processing`（**唯一**能走向 `completed` 的入口状态）。
 *
 * 只认领 `pending`：`processing` 已是本项在处理的形态；`waiting_dependency` 的重新可运行
 * 由 D05 的依赖解除负责（R14-3：正确路径是 `waiting_dependency → processing`）。
 * 终态项当然不动。
 *
 * 随后对快照内**全部**工作项登记"已读"（`included_in_snapshot` / `snapshot_run_ids`），
 * **绝不改变状态**——这正是"读完 ≠ 完成"（§九-5、P4-01）的可观测落点。
 */
function claimWorkItems(
  tx: StorageTransaction,
  snapshot: FrozenInputSnapshot,
  runId: RunId,
  at: LogicalTime,
  eventIds: IdSource,
  observationEvents: KernelEvent[],
): readonly RequestId[] {
  const claimed: RequestId[] = [];

  for (const requestId of snapshot.request_ids) {
    const item = tx.getWorkItem(requestId);
    if (item === undefined || item.status !== 'pending') {
      continue;
    }
    const next = applyWorkItemTransition({
      item,
      to: 'processing',
      at,
      origin: { kind: 'kernel', note: `轮次 ${runId} 认领` },
      blocker_reason: PROCESSING_BLOCKER,
      snapshot_run_id: runId,
    });
    tx.putWorkItem(next);
    observationEvents.push(appendKernelEvent(tx, workItemStatusChangedEvent(next, at), eventIds));
    claimed.push(requestId);
  }

  for (const requestId of snapshot.request_ids) {
    const item = tx.getWorkItem(requestId);
    if (item === undefined) {
      continue;
    }
    if (item.included_in_snapshot && item.snapshot_run_ids.includes(runId)) {
      continue;
    }
    const read = markWorkItemReadBySnapshot(item, runId, at);
    tx.putWorkItem(read);
    if (!claimed.includes(requestId)) {
      // 未认领（已处理中 / 等待依赖 / 终态）但本轮确实读入了：只登记读入，不改状态。
      observationEvents.push(appendKernelEvent(tx, workItemStatusChangedEvent(read, at), eventIds));
    }
  }

  return Object.freeze(claimed);
}

// ---------------------------------------------------------------------------
// finish_run
// ---------------------------------------------------------------------------

/**
 * 一轮结束时对**某一项工作**的结局声明（附录 B 的 `result` 的可执行形状）。
 *
 * 变体与工作项状态一一对应，便于 `finish_run` 直接映射到 D04 的转换（不另造一层语义）：
 * - `completed` 必须带结果引用（P4-10 / A03-10）；
 * - `failed` 必须带失败原因（P4-06）；
 * - `cancelled` 必须带取消原因（P4-09）；
 * - `waiting_dependency` 必须带**可指认**的依赖项与等待原因（P4-02：在等哪一项）；
 * - `pending` / `processing` 是"本轮未出结局"（读入 ≠ 完成，§九-5），只需等待原因。
 *   `pending` 的合法边只存在于 `processing → pending`（D04 的转换表），
 *   因此只有本轮认领过的项能退回待处理。
 */
export type RunPublication =
  | {
      readonly kind: 'completed';
      readonly request_id: RequestId;
      readonly result_refs: readonly ArtifactRef[];
      /**
       * **交付一份真实办公室文件**（design-02 A 批；合同 v1.4 R49.1）。
       *
       * Agent 只给"意图 + 用到哪些事实键"，**没有数字的参数位置**——数字一律由内核从
       * `SharedFactRecord` 取（R48.3：单一来源）。给了它，`result_refs` 会被**内核产出的
       * 产物 id 覆盖**（Agent 不能自称产出了什么）。
       *
       * 缺事实 ⇒ 该条发布被**结构化拒绝**（`missing_fact`），**不产零值产物**（R48.4）。
       */
      readonly artifact?: ArtifactPublicationIntent;
    }
  | {
      readonly kind: 'failed';
      readonly request_id: RequestId;
      readonly failure_reason: string;
      readonly blocker_reason?: BlockerReason;
    }
  | {
      readonly kind: 'cancelled';
      readonly request_id: RequestId;
      readonly cancellation_reason: string;
    }
  | {
      readonly kind: 'waiting_dependency';
      readonly request_id: RequestId;
      readonly dependency_refs: readonly DependencyRef[];
      readonly blocker_reason: BlockerReason;
    }
  | {
      readonly kind: 'pending' | 'processing';
      readonly request_id: RequestId;
      readonly blocker_reason: BlockerReason;
    };

/** 单条发布被拒的取证记录。 */
export interface RejectedPublication {
  readonly request_id: RequestId;
  /** D04 的工作项级拒因（如 `terminal_locked` / `owner_mismatch` / `illegal_transition`）。 */
  readonly ledger_reason: string;
  /** 归属/版本类拒因透出的 protocol 原因；其它为 null。 */
  readonly ownership_reason: PublicationRejectionReason | null;
  readonly message: string;
}

export interface FinishRunRequest {
  readonly run_id: RunId;
  /** 本轮对各项工作的结局声明（省略 = 本轮不产出任何结局）。 */
  readonly publications?: readonly RunPublication[];
  /** 结束时刻（默认 `now()`）。 */
  readonly at?: LogicalTime;
  /**
   * 显式覆盖"当前任务版本"（stale 判定的比较基准）。
   * 省略时取已注册任务的版本；任务未注册时退回本轮冻结的版本（即：**无法判 stale**）。
   */
  readonly current_task_revision?: Revision;
}

export interface FinishRunOutcome {
  /** 发布是否被接受（false = 被拒，未写入任何结果，合同 §九-9）。 */
  readonly accepted: boolean;
  readonly rejection_reason: FinishRunRejectionReason | null;
  /** 本轮冻结的完整记录（未知 run_id 时为 null）。 */
  readonly run: RunRecord | null;
  /** 被允许写入的发布（按声明顺序）。 */
  readonly applied_request_ids: readonly RequestId[];
  /** 被拒的单条发布（工作项级）。 */
  readonly rejected_publications: readonly RejectedPublication[];
  /** 结束轮次后是否入队了"至多一次"的后续运行机会。 */
  readonly queued_next_run: boolean;
  /**
   * 轮次收尾的停滞检查结果（R25.3）；调用方未登记预算时为 `null`。
   * 只有 `disposition === 'report'` 才会写 `diagnosis_performed` 事件与记台账（D05 的口径）。
   */
  readonly stagnation: StagnationCheckpointOutcome | null;
  /**
   * 本次收尾**已暂存**的产物事实（design-02 A 批）。
   *
   * 它们与工作项在**同一事务**里提交（R49.1 事务 1 / I-3），但**文件此刻还没被写**——
   * 落盘是提交之后由物化端口做的事，因此调用方必须在提交后把它们交给发布投影（`publish.ts`）。
   * "已提交但抛错"路径（`afterCommitBeforePublish`）下这些事实同样已提交，靠 `staged` 的
   * **可恢复性**（I-4）兜住，不会留下"声称交付、盘上没有"的记录。
   */
  readonly artifact_facts: readonly StagedArtifactFact[];
  readonly observation_events: readonly KernelEvent[];
  readonly delivery_events: readonly PendingEvent[];
  readonly published_events: readonly PendingEvent[];
  /** 动作台账 / 任务生命周期本轮的接线状态（FA-S；**如实回报**，见 `task-action-store.ts`）。 */
  readonly task_wiring: TaskActionWiringState;
  /**
   * 本轮被判为**迟到**的原因（KRN-09；正常路径为 `null`）。
   *
   * 迟到的含义：任务运行态已不接受"成功"，或本轮结果绑定的版本已过期。
   * 迟到结果**照实留痕**（`honored_as_success` 是字面量 `false`），任务状态不变。
   */
  readonly late_result_reason: LateResultReason | null;
}

function finishRejected(
  reason: FinishRunRejectionReason,
  run: RunRecord | null,
  extras: {
    readonly task_wiring?: TaskActionWiringState;
    readonly late_result_reason?: LateResultReason | null;
  } = {},
): FinishRunOutcome {
  return Object.freeze({
    accepted: false,
    rejection_reason: reason,
    run,
    applied_request_ids: Object.freeze([]),
    rejected_publications: Object.freeze([]),
    queued_next_run: false,
    stagnation: null,
    artifact_facts: Object.freeze([]) as readonly StagedArtifactFact[],
    observation_events: Object.freeze([]),
    delivery_events: Object.freeze([]),
    published_events: Object.freeze([]),
    task_wiring: extras.task_wiring ?? 'unwired',
    late_result_reason: extras.late_result_reason ?? null,
  });
}

/** 本轮结束时用于 stale 判定的"当前任务版本"。 */
function resolveCurrentRevision(
  tx: StorageTransaction,
  run: RunRecord,
  request: FinishRunRequest,
): Revision {
  if (request.current_task_revision !== undefined) {
    return request.current_task_revision;
  }
  const task = tx.getTask(run.task_id);
  return task === undefined ? run.task_revision : task.revision;
}

/**
 * **事务内**结束一个运行轮次。
 *
 * 判定顺序（P7 + 合同 v1.3 R43.2）：
 * 1. `unknown_run` → 找不到该 run_id（迟到的旧轮次可能已不在存储里）；
 * 2. `instance_not_registered` → 该轮次所属实例已不存在（防御性）；
 * 3. **权威取消事实**（`tx.getTaskControlState(run.task_id)`）→ `task_cancelled`：
 *    拒绝全部发布并**安全收尾本人仍持有的执行槽**。这一步**先于**所有权判定，
 *    因此"版本已过时 + 任务已取消"的交叉情形不会再跳过取消收尾（G02）；
 * 4. 其余四因交给 protocol 的 `evaluateRunOwnership()`：
 *    `not_run_owner` / `lease_expired` / `run_not_active` / `stale_task_revision`。
 *
 * 被拒时：**不写入任何结果**；第 3 步还会收尾轮次并释放**本人的**执行槽（槽位所有权必须复核），
 * 第 1/2/4 步**不改动实例活动态、不结束轮次**。两种情形都只记一条 `publication_rejected`
 * 观测事件（`rejected_publication_count` 的唯一来源，R11：5 个拒因 + G02 的交叉留痕在同一事件内）。
 */
export function finishRunInTransaction(
  tx: StorageTransaction,
  request: FinishRunRequest,
  deps: SchedulerDeps,
): FinishRunOutcome {
  const at = request.at ?? deps.now();
  const eventIds = deps.idSource;
  const observationEvents: KernelEvent[] = [];
  const deliveryEvents: PendingEvent[] = [];

  // FA-S 接线：纯探测（不写东西），让**每条**返回路径都能如实回报接线状态。
  const taskWiring: TaskActionWiringState = resolveTaskActionPort(tx, deps.taskActions).wiring;

  const run = tx.getRun(request.run_id);
  if (run === undefined) {
    observationEvents.push(
      appendKernelEvent(
        tx,
        publicationRejectedEvent({ at, run_id: request.run_id, rejection_reason: 'unknown_run' }),
        eventIds,
      ),
    );
    return Object.freeze({
      ...finishRejected('unknown_run', null, { task_wiring: taskWiring }),
      observation_events: Object.freeze(observationEvents),
    });
  }

  const instance = tx.getInstance(run.instance_id);
  if (instance === undefined) {
    observationEvents.push(
      appendKernelEvent(
        tx,
        publicationRejectedEvent({
          at,
          task_id: run.task_id,
          group_id: run.group_id,
          instance_id: run.instance_id,
          run_id: run.run_id,
          rejection_reason: null,
          data: { reason: 'instance_not_registered' },
        }),
        eventIds,
      ),
    );
    return Object.freeze({
      ...finishRejected('instance_not_registered', run, { task_wiring: taskWiring }),
      observation_events: Object.freeze(observationEvents),
    });
  }

  const currentRevision = resolveCurrentRevision(tx, run, request);
  const taskControl = tx.getTaskControlState(run.task_id);

  // -------------------------------------------------------------------------
  // **取消收尾独立于所有权判定**（合同 v1.3 R43.1/R43.2；修复 G02）
  //
  // 权威取消状态只从存储读（`TaskControlState`），调用方传入的 `current_task_revision`
  // 不能绕过它。旧实现根本不读取消状态：先启动工作、再投一条无 `reply_to` 的任务 cancel、
  // 然后提交 completed，实测 `taskCancelled = true` **同时** `finishAccepted = true`、
  // 工作项变成 completed —— 冻结 v1 的 Q4-c/Q6-c 明确不允许这一行为。
  //
  // **G02 的修正**：取消收尾曾经排在 `evaluateRunOwnership()` 早退**之后**，于是
  // "rev1 启动 → 登记 rev2 → 取消 rev2 → 原轮次 finish"这条交叉路径上，版本检查先以
  // `stale_task_revision` 早退，取消收尾整段被跳过：`run.status` 停在 `running`、
  // 实例仍是 `active`、`active_run_id` 仍指旧轮次——执行槽泄漏，而租约根本没到期。
  //
  // 现在把两件事分开（R43.1）：
  // - **是否允许发布结果** → 由所有权 / 版本判定回答；
  // - **是否仍拥有该执行槽** → 由 `run.status !== 'finished' && active_run_id === run.run_id`
  //   回答，与版本无关。
  //
  // 取消是**任务级**事实：一旦权威控制状态为 `cancelled`，无论本轮版本是否已过时，
  // 都拒绝全部发布（含 completed/failed/waiting_dependency/pending/processing）并安全收尾。
  // 但**收尾只在本人仍持有槽位时执行**——迟到轮次绝不能清掉**新轮次**的槽（R43.3）。
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // **KRN-09 迟到闸门**（FA-S 接线；R205 / R213 / R216）
  //
  // 在**任何发布落库之前**读任务级生命周期：任务运行态已不接受结果
  // （`paused` / `timed_out` / `failed` / `cancelled`），或本轮结果绑定的版本已过期
  // ⇒ 判迟到。迟到结果**照实留痕**（`honored_as_success` 恒 `false`），
  // **任务状态不变**，且**全部发布被拒**——这就是"取消/暂停后到达的迟到结果不得变成当前成功"。
  //
  // **这条闸门是承重的**：反向对照（把本段摘掉）下，`paused` 任务的在途轮次会照常发布，
  // 工作项会变成 `completed`（见 `task-action-wiring.test.ts` 的反例③）。
  // 轮次级（`TaskControlState.cancelled`）只能拦"取消"，表达不了暂停/超时/失败——
  // 那三种在协议层没有载体，只有任务生命周期有。
  // -------------------------------------------------------------------------
  const arrivalGate = gateRunResultArrival(
    tx,
    {
      task_id: run.task_id,
      run_id: run.run_id,
      result_task_revision: run.task_revision,
      outcome: declaredOutcomeOf(request.publications ?? []),
      at,
      note: `轮次 ${run.run_id} 的结果到达（任务版本 ${Number(run.task_revision)}）`,
    },
    deps,
  );

  if (arrivalGate.late) {
    const lateCancelled = arrivalGate.lifecycle?.status === 'cancelled';
    const stillOwnsSlotLate = run.status !== 'finished' && instance.active_run_id === run.run_id;
    observationEvents.push(
      appendKernelEvent(
        tx,
        publicationRejectedEvent({
          at,
          task_id: run.task_id,
          group_id: run.group_id,
          instance_id: run.instance_id,
          run_id: run.run_id,
          // 取消有协议层拒因；暂停/超时/失败在协议层没有对应取值，如实置 null 并在 data 里说明。
          rejection_reason: lateCancelled ? 'task_cancelled' : null,
          data: {
            late_result_reason: arrivalGate.late_reason,
            task_runtime_status: arrivalGate.lifecycle?.status ?? null,
            rejected_publications: (request.publications ?? []).length,
            current_task_revision: currentRevision,
            run_task_revision: run.task_revision,
            owns_execution_slot: stillOwnsSlotLate,
            note:
              '任务级生命周期不接受结果：迟到结果照实留痕（honored_as_success 恒 false），' +
              '任务状态不变，本轮全部发布被拒',
          },
        }),
        eventIds,
      ),
    );

    if (stillOwnsSlotLate) {
      tx.putRun(createRunRecord({ ...run, status: 'finished', finished_at: at }));
      const afterLate = requireInstance(tx, run.instance_id);
      const clearedLate = clearQueueFlag(tx, afterLate, {
        at,
        reason: `轮次 ${run.run_id} 为迟到结果收尾：清除排队标记（任务不接受结果，不继续执行）`,
        event_ids: eventIds,
      });
      for (const event of clearedLate.kernel_events) {
        observationEvents.push(event);
      }
      if (clearedLate.instance.active_run_id === run.run_id) {
        patchInstance(tx, clearedLate.instance, {
          activity: 'idle',
          active_run_id: null,
          lease_deadline: null,
          updated_at: at,
        });
      }
      observationEvents.push(
        appendKernelEvent(tx, runFinishedEvent({ ...run, status: 'finished' }, at), eventIds),
      );
    }

    return Object.freeze({
      ...finishRejected(lateCancelled ? 'task_cancelled' : 'task_not_accepting_result', run, {
        task_wiring: arrivalGate.wiring,
        late_result_reason: arrivalGate.late_reason,
      }),
      observation_events: Object.freeze(observationEvents),
    });
  }

  if (isTaskCancelled(taskControl)) {
    const stillOwnsSlot = run.status !== 'finished' && instance.active_run_id === run.run_id;
    observationEvents.push(
      appendKernelEvent(
        tx,
        publicationRejectedEvent({
          at,
          task_id: run.task_id,
          group_id: run.group_id,
          instance_id: run.instance_id,
          run_id: run.run_id,
          rejection_reason: 'task_cancelled',
          data: {
            cancel_reason: taskControl?.cancel_reason ?? null,
            cancelled_by_message_id: taskControl?.cancelled_by_message_id ?? null,
            rejected_publications: (request.publications ?? []).length,
            current_task_revision: currentRevision,
            run_task_revision: run.task_revision,
            // 交叉情形留痕：取消与版本升级同时发生时，如实记录版本已过时这一事实。
            stale_task_revision: currentRevision !== run.task_revision,
            owns_execution_slot: stillOwnsSlot,
            note: '任务级取消：在途轮次的新发布一律被拒，结果引用不写入；轮次仍收尾以释放执行槽',
          },
        }),
        eventIds,
      ),
    );

    if (stillOwnsSlot) {
      tx.putRun(createRunRecord({ ...run, status: 'finished', finished_at: at }));
      const afterCancel = requireInstance(tx, run.instance_id);
      const clearedOnCancel = clearQueueFlag(tx, afterCancel, {
        at,
        reason: `轮次 ${run.run_id} 因任务取消收尾：清除排队标记（取消任务不继续执行）`,
        event_ids: eventIds,
      });
      for (const event of clearedOnCancel.kernel_events) {
        observationEvents.push(event);
      }
      // 所有权复核：只有本轮的槽才置空闲，不能清掉属于其他 run 的槽。
      if (clearedOnCancel.instance.active_run_id === run.run_id) {
        patchInstance(tx, clearedOnCancel.instance, {
          activity: 'idle',
          active_run_id: null,
          lease_deadline: null,
          updated_at: at,
        });
      }
      observationEvents.push(
        appendKernelEvent(tx, runFinishedEvent({ ...run, status: 'finished' }, at), eventIds),
      );
    }
    return Object.freeze({
      ...finishRejected('task_cancelled', run, { task_wiring: taskWiring }),
      observation_events: Object.freeze(observationEvents),
    });
  }

  const validity = evaluateRunOwnership({
    run,
    instance,
    now: at,
    current_task_revision: currentRevision,
  });
  if (!validity.valid) {
    observationEvents.push(
      appendKernelEvent(
        tx,
        publicationRejectedEvent({
          at,
          task_id: run.task_id,
          group_id: run.group_id,
          instance_id: run.instance_id,
          run_id: run.run_id,
          rejection_reason: validity.reason,
          data: { current_task_revision: currentRevision, run_task_revision: run.task_revision },
        }),
        eventIds,
      ),
    );
    return Object.freeze({
      ...finishRejected(validity.reason ?? 'run_not_active', run, { task_wiring: taskWiring }),
      observation_events: Object.freeze(observationEvents),
    });
  }

  // 允许发布：逐条写入工作承诺表（工作项级拒因不阻断其它发布，与 D04 的策略层一致）。
  const applied: RequestId[] = [];
  const rejected: RejectedPublication[] = [];
  const artifactFacts: StagedArtifactFact[] = [];
  for (const publication of request.publications ?? []) {
    const item = tx.getWorkItem(publication.request_id);
    if (item === undefined) {
      rejected.push({
        request_id: publication.request_id,
        ledger_reason: 'unknown_work_item',
        ownership_reason: null,
        message: `工作承诺表里没有 request_id ${publication.request_id} 对应的工作项`,
      });
      continue;
    }

    // **产物暂存**（design-02 R49.1 事务 1）：与工作项状态在同一事务里提交。
    // 缺事实 ⇒ 这条发布被拒（不产零值产物），其余发布不受影响（逐条粒度）。
    let effective: RunPublication = publication;
    if (publication.kind === 'completed' && publication.artifact !== undefined) {
      const staged = stagePublicationArtifact(tx, run, publication, deps, at, eventIds, observationEvents);
      if (!staged.ok) {
        rejected.push({
          request_id: publication.request_id,
          ledger_reason: staged.reason,
          ownership_reason: null,
          message: staged.message,
        });
        continue;
      }
      artifactFacts.push(staged.fact);
      effective = { ...publication, result_refs: [staged.fact.record.artifact_id] };
    }

    try {
      const next = applyWorkItemTransition({
        item,
        to: effective.kind,
        at,
        origin: {
          kind: 'run',
          run,
          instance,
          current_task_revision: currentRevision,
          now: at,
        },
        ...publicationFields(effective),
      });
      tx.putWorkItem(next);
      observationEvents.push(appendKernelEvent(tx, workItemStatusChangedEvent(next, at), eventIds));
      applied.push(publication.request_id);
    } catch (error) {
      if (!isWorkLedgerError(error)) {
        throw error;
      }
      rejected.push({
        request_id: publication.request_id,
        ledger_reason: error.reason,
        ownership_reason: error.ownership_reason,
        message: error.message,
      });
      observationEvents.push(
        appendKernelEvent(
          tx,
          publicationRejectedEvent({
            at,
            task_id: item.task_id,
            instance_id: instance.instance_id,
            run_id: run.run_id,
            request_id: item.request_id,
            rejection_reason: error.ownership_reason,
            data: { ledger_reason: error.reason, message: error.message },
          }),
          eventIds,
        ),
      );
    }
  }

  // 结束轮次 + 清除活动轮次。
  tx.putRun(
    createRunRecord({
      ...run,
      status: 'finished',
      finished_at: at,
    }),
  );
  const afterPublications = requireInstance(tx, run.instance_id);
  const clearedQueue = clearQueueFlag(tx, afterPublications, {
    at,
    reason: `轮次 ${run.run_id} 结束：清除排队标记`,
    event_ids: eventIds,
  });
  for (const event of clearedQueue.kernel_events) {
    observationEvents.push(event);
  }
  const idle = patchInstance(tx, clearedQueue.instance, {
    activity: 'idle',
    active_run_id: null,
    lease_deadline: null,
    updated_at: at,
  });

  // 有新的可运行输入 → **至多一次**入队；否则置空闲（§六）。
  let queuedNext = false;
  if (hasRunnableInput(tx, run.instance_id)) {
    const result = markQueueFlagged(tx, {
      instance: idle,
      task_id: run.task_id,
      group_id: run.group_id,
      at,
      delivery_kind: 'run_requested',
      reason: `轮次 ${run.run_id} 结束后仍有可运行输入：至多一次后续运行机会`,
      payload: {
        after_run_id: run.run_id,
        frozen_input_message_ids: [...run.frozen_input_message_ids],
      },
      event_ids: eventIds,
    });
    queuedNext = result.queued;
    for (const event of result.kernel_events) {
      observationEvents.push(event);
    }
    if (result.pending_event !== null) {
      deliveryEvents.push(result.pending_event);
    }
  }

  observationEvents.push(appendKernelEvent(tx, runFinishedEvent({ ...run, status: 'finished' }, at), eventIds));

  // -------------------------------------------------------------------------
  // **正常链路的依赖解除**（合同 v1.2 R37.4；修复 F03）
  //
  // 旧实现只在停滞检查点里落地**循环停止**计划，正常解除根本没接线：
  // A 等 B、B 完成后诊断已返回 `progress_possible` 与可解除请求，A 却永远停在
  // `waiting_dependency`，下一次推进启动数为 0（A05-L 的夹具只好自己算计划、写库、唤醒，
  // 于是"内核自动衔接"从未被验证）。
  //
  // 现在：在**真实完成事务内**计算并应用当前 task/revision 的解除计划——
  // 工作项（`waiting_dependency → processing`）、可运行输入、排队标记与 outbox
  // **原子更新**。复用事务内入口，不调用会另开事务的 `Scheduler` 门面。
  //
  // 三条边界（都在通过标准里）：
  // - **与停滞诊断预算无关**：`deps.stagnation` 未登记时本段照样运行（正常解除 ≠ 有界诊断）；
  // - **不是自动故障恢复**：只处理依赖已全部满足的项；
  // - 循环上的项不在本段处理（交给 `planCycleStop`），不得被"假解除"。
  // -------------------------------------------------------------------------
  const scope = { task_id: run.task_id, task_revision: currentRevision };
  const resolution = planDependencyResolution(
    scopeWorkItems(tx.listWorkItems(), scope),
    { at, group_id: run.group_id, resolved_blocker_kind: 'waiting_dependency' },
  );
  for (const verdict of resolution.transitions) {
    if (!verdict.ok || verdict.next === null) {
      continue;
    }
    tx.putWorkItem(verdict.next);
    observationEvents.push(appendKernelEvent(tx, workItemStatusChangedEvent(verdict.next, at), eventIds));
  }
  for (const notice of resolution.notices) {
    // 依赖解除的输入身份（R37.3）**单一来源**：用 D05 的 `resolutionInputRefId`，
    // 与通知上的 `input_ref_id` 逐字一致；不在这里另拼一套编码。
    const refId = resolutionInputRefId({
      task_id: notice.task_id,
      task_revision: notice.task_revision,
      request_id: notice.request_id,
      resolved_dependency_ids: notice.resolved_dependency_ids,
    });
    const owner = tx.getInstance(notice.instance_id);
    if (owner === undefined) {
      // 负责人实例未注册：不能凭空唤醒一个不存在的实例（`requireInstance` 会抛错，
      // 让整个收尾事务回滚——那会把一次正常收尾变成失败）。如实跳过并留痕。
      observationEvents.push(
        appendKernelEvent(
          tx,
          publicationRejectedEvent({
            at,
            task_id: notice.task_id,
            group_id: run.group_id,
            instance_id: notice.instance_id,
            run_id: run.run_id,
            request_id: notice.request_id,
            data: { reason: 'dependency_wakeup_skipped_unregistered_owner', ref_id: refId },
          }),
          eventIds,
        ),
      );
      continue;
    }
    const wake = wakeOnDependencyResolvedInTransaction(
      tx,
      {
        task_id: notice.task_id,
        instance_id: notice.instance_id,
        ref_id: refId,
        task_revision: notice.task_revision,
        reason:
          `依赖已解除（${notice.resolved_dependency_ids.join(',')}）：` +
          `工作项 ${notice.request_id} 恢复可运行`,
        at,
      },
      { idSource: eventIds, at },
    );
    for (const event of wake.observation_events) {
      observationEvents.push(event);
    }
    for (const event of wake.delivery_events) {
      deliveryEvents.push(event);
    }
  }

  // 附录 B 的最后一行：`check task progress and waiting conditions`。
  // 只有调用方登记了预算才运行（D05 的判定在预算缺省时抛错，A05-01）。
  // **作用域限定**（R37.2；修复 F05）：只诊断当前任务当前版本，避免混版本触发
  // `FingerprintError` 把整个收尾事务回滚。历史项保留在存储里，只是不参与本次诊断。
  let stagnation: StagnationCheckpointOutcome | null = null;
  if (deps.stagnation !== undefined) {
    stagnation = runStagnationCheckpoint(tx, {
      at,
      event_ids: eventIds,
      options: deps.stagnation,
      task_id: run.task_id,
      task_revision: currentRevision,
      group_id: run.group_id,
      instance_id: run.instance_id,
    });
    for (const event of stagnation.kernel_events) {
      observationEvents.push(event);
    }
  }

  return Object.freeze({
    accepted: true,
    rejection_reason: null,
    run,
    applied_request_ids: Object.freeze(applied),
    rejected_publications: Object.freeze(rejected),
    queued_next_run: queuedNext,
    stagnation,
    artifact_facts: Object.freeze(artifactFacts),
    observation_events: Object.freeze(observationEvents),
    delivery_events: Object.freeze(deliveryEvents),
    published_events: Object.freeze([]),
    task_wiring: arrivalGate.wiring,
    late_result_reason: null,
  });
}

/**
 * **事务内**为一条完成发布暂存产物（design-02 R49.1 事务 1）。
 *
 * 成功：`staged` 记录已落库 + 返回待发布的 `StagedArtifactFact`（**文件此刻还没写**）。
 * 失败：返回结构化原因（`missing_fact` / `builder_failed` / `artifact_root_dir_unset`），
 * **不写任何记录**。失败时同时写一条 `publication_rejected` 观测——"报部分完成/未知"
 * 因此在内核事件流里可核验，而不是只靠调用方的说法。
 */
function stagePublicationArtifact(
  tx: StorageTransaction,
  run: RunRecord,
  publication: Extract<RunPublication, { kind: 'completed' }>,
  deps: SchedulerDeps,
  at: LogicalTime,
  eventIds: IdSource,
  observationEvents: KernelEvent[],
):
  | { readonly ok: true; readonly fact: StagedArtifactFact }
  | { readonly ok: false; readonly reason: string; readonly message: string } {
  const intent = publication.artifact;
  if (intent === undefined) {
    throw new SchedulerError('内部错误：stagePublicationArtifact 只能用于携带 artifact 的完成发布');
  }

  const reject = (reason: string, message: string): { ok: false; reason: string; message: string } => {
    observationEvents.push(
      appendKernelEvent(
        tx,
        publicationRejectedEvent({
          at,
          task_id: run.task_id,
          group_id: run.group_id,
          instance_id: run.instance_id,
          run_id: run.run_id,
          request_id: publication.request_id,
          data: { reason, message },
        }),
        eventIds,
      ),
    );
    return { ok: false, reason, message };
  };

  if (deps.artifact_root_dir === undefined || deps.artifact_root_dir === '') {
    // 不猜目录：产物落到哪里是**注入决定**的（同 `stagnation` 未登记即拒绝的纪律）。
    return reject(
      'artifact_root_dir_unset',
      '发布了产物意图但没有注入产物根目录（artifact_root_dir）：内核不猜落盘位置',
    );
  }

  const staged = stageArtifactInTransaction(tx, {
    intent: intent.intent,
    task_id: run.task_id,
    task_revision: currentRevisionOf(run),
    artifact_version: resolveNextArtifactVersion(tx, run.task_id, intent.intent.template_kind),
    fact_keys: intent.fact_keys,
    root_dir: deps.artifact_root_dir,
    created_by_instance_id: run.instance_id,
    at,
  });

  if (!staged.ok) {
    return reject(staged.kind, staged.detail);
  }

  observationEvents.push(
    appendKernelEvent(
      tx,
      artifactStagedEvent(staged.record, at),
      eventIds,
    ),
  );
  return {
    ok: true,
    fact: { record: staged.record, request: staged.request },
  };
}

/** 该轮次所绑定的任务版本（事务内只读；产物记录的 `task_revision` 必须与它一致）。 */
function currentRevisionOf(run: RunRecord): Revision {
  return run.task_revision;
}

/** 产物暂存观测事件（形状与既有的 `work_item_status_changed` 等一致）。 */
function artifactStagedEvent(record: ArtifactRecord, at: LogicalTime): KernelEventInput {
  return {
    kind: 'artifact_staged',
    at,
    task_id: record.task_id,
    instance_id: record.created_by_instance_id,
    data: {
      artifact_id: record.artifact_id,
      task_revision: record.task_revision,
      artifact_version: record.artifact_version,
      template_kind: record.template_kind,
      content_digest: record.content_digest,
      byte_length: record.byte_length,
      source_fact_refs: [...record.source_fact_refs],
      note: 'staged：记录已提交，文件尚未写出（I-4：不满足任何交付判据）',
    },
  };
}

/** 把一条结局声明映射为 D04 的转换字段（不含 `to`，它等于 `kind`）。 */
function publicationFields(publication: RunPublication): {
  readonly blocker_reason?: BlockerReason;
  readonly dependency_refs?: readonly DependencyRef[];
  readonly failure_reason?: string;
  readonly cancellation_reason?: string;
  readonly completion?: { readonly request_id: RequestId; readonly result_refs: readonly ArtifactRef[] };
} {
  switch (publication.kind) {
    case 'completed':
      return {
        completion: { request_id: publication.request_id, result_refs: publication.result_refs },
      };
    case 'failed':
      return {
        failure_reason: publication.failure_reason,
        ...(publication.blocker_reason === undefined ? {} : { blocker_reason: publication.blocker_reason }),
      };
    case 'cancelled':
      return { cancellation_reason: publication.cancellation_reason };
    case 'waiting_dependency':
      return {
        blocker_reason: publication.blocker_reason,
        dependency_refs: publication.dependency_refs,
      };
    case 'pending':
    case 'processing':
      return { blocker_reason: publication.blocker_reason };
  }
}

/** 对外暴露默认租约时长的引用点，避免下游从 protocol 之外再造一个默认值。 */
export const SCHEDULER_DEFAULT_LEASE_TTL = DEFAULT_LEASE_TTL;

/** 只读查询：该实例是否已有活动轮次（D05/D07 的断言辅助）。 */
export function activeRunOf(tx: StorageTransaction, instanceId: InstanceId): RunRecord | undefined {
  return tx.getActiveRun(instanceId);
}

/** 防御性导出：终态判定（供 D05/D09 在同一判据上工作，不重写）。 */
export { isTerminalStatus };

/** 发布被拒的出口也复用 D01 的 `PublicationError` 语义（此处仅显式引用，便于阅读依赖图）。 */
export const FINISH_RUN_USES_PUBLICATION_ERROR = PublicationError;
