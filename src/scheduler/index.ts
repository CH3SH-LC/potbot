/**
 * `src/scheduler` 唯一公开出口（归属 D03；合同 §八 模块归属表）。
 *
 * 职责：**消息入口事务编排、轮次（run_id + 有限租约）、合并唤醒、所有权核验**
 * （对应 `design-01-P1` / `P3` / `P7`）。依赖方向：
 *
 * ```text
 * src/scheduler → src/protocol（类型/常量/纯判定）
 *               → src/storage（仅经 Store 接口）
 *               → src/inbox（收件箱、去重、快照冻结、已读）
 *               → src/workledger（工作承诺表转换与所有权）
 * ```
 *
 * **本模块刻意不转发 `src/protocol` / `src/inbox` / `src/workledger` 的导出**：
 * 共享类型仍从各自模块导入（单一定义来源），避免此处再开一个转发面而与上游漂移。
 *
 * 面向下游的三条接缝：
 * 1. **D07/D06 的调度推进**：`AdvanceStep` 与 D06 的 `AdvanceOutcome` 结构兼容，
 *    `seam.bind(() => scheduler.advanceOnce())` 即可挂接；投递登记走
 *    `SchedulerOptions.onDeliveryCommitted`（D07 转给 `seam.noteDeliveryCommit`）。
 * 2. **D05 的唤醒端口**：`SchedulerWakeupPort`（见 `wakeup.ts` 的签名说明）——
 *    D05 **不需要** import 本模块，声明一份结构相同的 interface 即可。
 * 3. **D09 的只读观测**：`Scheduler.snapshot()` / `kernelEvents()` / `eventCounters()` /
 *    `summarize()`（后者委托 protocol 的合并实现，R4/R19 不另算一套）。
 *
 * 依赖方向补一条：`src/scheduler → src/dependency`（用 D05 的 `diagnoseStagnation` /
 * `recordDiagnosis` / `planCycleStop` 做停滞检查点，R25.3）。**反向不成立**——
 * D05 用注入端口（`SchedulerWakeupPort`）请求唤醒，不 import 本模块。
 */

export {
  RunBudgetConfigError,
  SchedulerError,
  START_RUN_REJECTION_REASONS,
  START_RUN_REJECTION_LABELS,
  describeStartRunRejection,
  runBudgetConfigMessage,
  type FinishRunRejectionReason,
  type StartRunRejectionReason,
} from './errors.js';

export type { SchedulerDeps } from './deps.js';

export {
  appendKernelEvent,
  enqueueDeliveryEvent,
  publicationRejectedEvent,
  queueClearedEvent,
  queueEnqueuedEvent,
  runFinishedEvent,
  runStartedEvent,
  staleMessageEvent,
  taskControlStateUpdatedEvent,
  workItemCreatedEvent,
  workItemEventData,
  workItemStatusChangedEvent,
  type DeliveryEventReason,
} from './kernel-events.js';

export {
  clearQueueFlag,
  markQueueFlagged,
  type QueueFlagRequest,
  type QueueFlagResult,
} from './queue.js';

export {
  currentTaskRevision,
  describeEntryFailure,
  kernelSenderAuthenticator,
  onMessageInTransaction,
  rejectedOutcome,
  rejectingSenderAuthenticator,
  validateCancelTarget,
  validateRouting,
  type CancelTargetValidation,
  type OnMessageOptions,
  type OnMessageOutcome,
  type RouteValidation,
  type SenderAuthenticator,
} from './on-message.js';

export {
  activeRunOf,
  resolveTaskId,
  startRunInTransaction,
  finishRunInTransaction,
  SCHEDULER_DEFAULT_LEASE_TTL,
  type FinishRunOutcome,
  type FinishRunRequest,
  type RejectedPublication,
  type RunPublication,
  type StartRunOutcome,
  type StartRunRequest,
} from './runs.js';

export {
  runBudgetExhausted,
  runBudgetGateOf,
  runStagnationCheckpoint,
  type RunBudgetGate,
  type StagnationBudgetLedger,
  type StagnationCheckpointInput,
  type StagnationCheckpointOutcome,
  type StagnationOptions,
} from './stagnation.js';

export {
  CommittedBudgetProjection,
  committedBudgetFactsOf,
  committedRunCount,
  createBudgetProjection,
  latestRunIdOf,
  // 重启恢复的折算入口（C2；R225 预算不清零）。
  recoverBudgetFromCommittedFacts,
  type BudgetProjectionSnapshot,
  type BudgetRestoreReport,
  type CommittedBudgetFact,
} from './budget-projection.js';

export {
  isWakeupMergedIntoActiveRun,
  pendingActionableInputRefs,
  queuedFlagOf,
  requestWakeupInTransaction,
  wakeOnDependencyResolvedInTransaction,
  type DependencyWakeupRequest,
  type SchedulerWakeupPort,
  type WakeupOutcome,
  type WakeupRequest,
} from './wakeup.js';

export {
  createScheduler,
  Scheduler,
  type AdvanceStep,
  type DeliveryCommitObservation,
  type DeliveryCommitObserver,
  type SchedulerOptions,
} from './scheduler.js';

// 重启恢复（C2；R203 / R218 / R225）：租约跨重启连续 + 预算不归零。
export {
  budgetAvailable,
  budgetRecoverySummary,
  reconcileLeasesAfterRestart,
  recoverAfterRestart,
  type LeaseReconciliation,
  type RestartRecoveryReport,
} from './restart.js';

// 任务生命周期与迟到结果（KRN-09；R205 / R213 / R216 / R226）：
// 暂停/继续/取消/超时/失败恢复；取消后迟到结果不得变成当前成功；已发生副作用如实保留。
export * from './task-lifecycle.js';

// 动作台账 / 任务生命周期的**持久接缝**（FA-S）：三段式解析（store → injected → unwired），
// **不静默用内存兜底**（R220）。
export {
  TaskActionSeamMissingError,
  hasTaskActionSeam,
  resolveTaskActionPort,
  taskActionPortOf,
  type TaskActionStorePort,
  type TaskActionWiringState,
} from './task-action-store.js';

// 把 KRN-07 / KRN-09 接到真实入口的**接线策略**（FA-S）：接线层不重写语义，
// 七态/六态/迟到判定/幂等键的唯一定义仍在 `src/workledger` 与 `./task-lifecycle.js`。
export {
  actionRecordsOf,
  cancelTaskLifecycle,
  clickActionInTransaction,
  declaredOutcomeOf,
  ensureTaskLifecycle,
  failTaskLifecycle,
  gateRunResultArrival,
  invalidateStaleActionsForTask,
  isActionRecordExecutable,
  isTaskAcceptingResults,
  observeTaskActions,
  pauseTaskLifecycle,
  unpauseTaskLifecycle,
  taskLifecycleOf,
  taskLifecycleSummaryOf,
  timeoutTaskLifecycle,
  type ActionAuthorizationInput,
  type ActionClickRejection,
  type ActionClickRequest,
  type ActionClickResult,
  type CancelLifecycleInput,
  type EnsureLifecycleInput,
  type InvalidateStaleActionsInput,
  type InvalidateStaleActionsResult,
  type ResultArrivalGateInput,
  type ResultArrivalGateVerdict,
  type TaskActionObservation,
  type TaskLifecycleControlInput,
} from './task-action-wiring.js';

export * from './work-queue.js';
export * from './progress-monitor.js';
export * from './budgets.js';

export * from './task-group-isolation.js';
export * from './message-inbox.js';
export * from './fair-scheduler.js';
export * from './late-result-gate.js';

export * from './context-assembly.js';
export * from './fact-version-gate.js';

// `permission-check.ts` 与 `tool-loop.ts` 各有一个 `ToolCallRequest`（前者是"权限校验的调用描述"，
// 后者是"工具循环的调用描述"），`export *` 会二义（TS2308）。用具名再导出消歧：桶里的
// `ToolCallRequest` 取**工具循环**那一份；权限校验那一份请直接从 `./permission-check.js` 具名导入。
export { type ToolCallRequest } from './tool-loop.js';
export * from './permission-check.js';
export * from './revocation.js';
export * from './authorization-provenance.js';

export * from './constrained-response.js';
export * from './tool-loop.js';
export * from './member-collab.js';
export * from './loop-limits.js';
export * from './event-log.js';
export * from './checkpoint.js';
export * from './id-clock-continuity.js';

export * from './capability-registry.js';

export * from './worker-loop.js';
