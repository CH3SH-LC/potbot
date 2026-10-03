/**
 * `src/workledger` 唯一公开出口（D04；合同 §八：模块归属 `src/workledger/` = 工作承诺表 P4）。
 *
 * 下游用法：
 * - **D03（调度器）**：轮次结束发布结果时用 `applyWorkItemTransition()` / `evaluateWorkItemTransition()`，
 *   发起方传 `{ kind: 'run', run, instance, current_task_revision, now }`；
 *   轮次读入输入时用 `markWorkItemsReadBySnapshot()` 登记"已读"（**不改变状态**）。
 * - **D05（依赖解除与诊断）**：依赖解除时把工作项从 `waiting_dependency` 转回 `processing`/`pending`
 *   （`origin: { kind: 'kernel' }` 或该实例自己的轮次）；循环报告用 `{ kind: 'failed' }` +
 *   `failure_reason`，等待态用 `blocker_reason.kind = 'cycle_detected'` / `'waiting_dependency'`。
 * - **D09（验收）**：断言用 `summarizeWorkLedger()` / `findRequestsWithoutOutcome()` /
 *   `findReadButNotCompleted()` / `findRequestsMissingWorkItem()`。
 *
 * 本模块**只做策略与转换**（纯函数、无状态、无 I/O）；持久化走 `src/storage` 的
 * `tx.putWorkItem()`，由调用方与消息写入放在同一事务内（合同 §九-1）。
 */

export * from './rejections.js';
export * from './transitions.js';
export * from './origin.js';
export * from './outcome.js';
export * from './ledger.js';
// 动作台账（KRN-07；R241–R246、R213）：动作绑参数摘要/任务版本/授权/幂等键，七态严格区分。
export * from './action-ledger.js';
// 跨包动作状态对齐（FA-UNIFY-ACTION-STATES；I-4/I-5）：clock ↔ workledger 七态权威映射 +
// 一致性判据（新增即失败）+ 幂等键收口（deriveClockLedgerKey，复用 workledger 权威算法）。
export {
  ACTION_STATE_ALIGNMENT,
  ACTION_STATE_DIFFERENCES,
  assertActionStateAlignment,
  assertEquivalentActionStates,
  checkActionStateAlignment,
  computeActionStateStructuralEquivalence,
  deriveClockLedgerKey,
  translateClockStateToWorkledger,
  translateWorkledgerStateToClock,
  versionAwareClockLedgerOptions,
} from './action-state-alignment.js';
export type {
  ActionStateAlignmentEntry,
  ActionStateDifference,
  ActionStateDifferenceKind,
  ActionStateTranslation,
  ClockActionStateName,
  RegisteredActionStateDifference,
  StructuralEquivalence,
  WorkledgerActionStateName,
} from './action-state-alignment.js';
export { CLOCK_ACTION_STATES, WORKLEDGER_ACTION_STATES } from './action-state-alignment.js';

/**
 * 本模块**不**转发 `src/protocol` 的导出。
 * 共享类型与语义常量（`WorkItem` / `BlockerReason` / `asRequestId` / `WORK_ITEM_STATUSES` …）
 * 一律从 `../protocol/index.js` 导入——单一定义来源，避免此处再开一个转发面而与上游漂移。
 */
