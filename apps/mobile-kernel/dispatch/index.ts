/**
 * K05（手机内核 · 主智能体派发）对外出口。零依赖纯 TS，不 import `node:*`，不 import `src/**`。
 *
 * 覆盖：能力发现、拆任务、临时群组、依赖调度、并发、取消、晚到结果；
 * 无固定规划/审核角色（`FORBIDDEN_FIXED_ROLES`），不得调未授权模板（`capability_not_authorized`）。
 *
 * 用法与验收命令见同目录 `README.md`；独立测试见 `tests/mobile-kernel/K05/`。
 */

export {
  DISPATCH_ERROR_CODES,
  SUBTASK_BLOCK_LABELS,
  SUBTASK_BLOCK_REASONS,
  DispatchError,
  isDispatchError,
  requireConcurrency,
  requireNonEmptyString,
  type DispatchErrorCode,
  type DispatchErrorField,
  type SubtaskBlockReason,
} from './errors.js';

export { structuralDigest } from './digest.js';

export {
  EXECUTOR_ROLE,
  FORBIDDEN_FIXED_ROLES,
  RESULT_VERDICTS,
  SUBTASK_STATES,
  SUBTASK_STATE_LABELS,
  TERMINAL_SUBTASK_STATES,
  createManualClock,
  createStaticDiscovery,
  isForbiddenFixedRole,
  isTerminalSubtaskState,
  type BlockedSubtaskPlan,
  type CancelReport,
  type CapabilityDiscoveryPort,
  type CapabilityId,
  type Clock,
  type DiscoveredCapability,
  type DispatchPlan,
  type DispatchRuntimeSnapshot,
  type DispatchSchedule,
  type ExecutorRole,
  type ForbiddenFixedRole,
  type GroupId,
  type GroupMember,
  type GroupReleaseReport,
  type InstanceId,
  type LateResultRecord,
  type ManualClock,
  type ResultDecision,
  type ResultVerdict,
  type ScheduleWave,
  type SubtaskId,
  type SubtaskPlan,
  type SubtaskRuntime,
  type SubtaskSpec,
  type SubtaskState,
  type TaskId,
  type TaskSplit,
  type TemporaryGroup,
} from './types.js';

export {
  identityInstanceId,
  planDispatch,
  validateSplit,
  type PlanDispatchInput,
} from './plan.js';

export {
  assertConcurrency,
  createDispatchRuntime,
  isAccepted,
  type DispatchRuntime,
  type DispatchRuntimeDeps,
} from './runtime.js';

export {
  COMMAND_ISSUE_CODES,
  COMMAND_ROOT_ALLOWED,
  COMMAND_ROOT_REQUIRED,
  COMMAND_SCHEMA_VERSION,
  CONTRACT_OPERATION_HINT,
  DISPATCH_OPERATIONS,
  RESULT_OUTCOMES,
  assertDispatchCommand,
  validateDispatchCommand,
  type CommandIssue,
  type CommandIssueCode,
  type CommandValidation,
  type DispatchOperation,
  type ResultOutcome,
} from './schema.js';
