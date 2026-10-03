/**
 * toolguard 模块入口（K-I26：K-R03 测试区提升而来的产品模块）——
 * 模型/工具失败面（429 / 断流 / 预算拒绝）的**有界重试**与**幂等**。
 *
 * - `idempotency.ts` —— 工具动作幂等账本（重试不重复执行）；`model/tools.ts` 的
 *   `runToolLoop` 以 `ToolLoopOptions.guard` 消费它作为**执行器侧护栏**。
 * - `retry.ts` —— 只重试可重试失败的有界重试壳；`cancelled` 绝不重试。
 * - `schemas.ts` —— 重试策略与执行记录的 schema + 校验器。
 */

export {
  ToolIdempotencyError,
  ToolIdempotencyLedger,
  TOOL_IDEMPOTENCY_ERROR_CODES,
  deriveToolKey,
  stableStringify,
  type ToolExecutionRecord,
  type ToolExecutionState,
  type ToolIdempotencyErrorCode,
  type ToolIdempotencyLedgerOptions,
} from './idempotency.js';

export {
  DEFAULT_RETRY_POLICY,
  runWithRetry,
  type RetryAttemptRecord,
  type RetryPolicy,
  type RetryRunOptions,
  type RetryRunOutcome,
  type ToolRuntime,
} from './retry.js';

export {
  RETRY_POLICY_SCHEMA,
  TOOL_EXECUTION_RECORD_SCHEMA,
  schemaRequiredIsSubsetOfProperties,
  validateRetryPolicy,
  validateToolExecutionRecord,
} from './schemas.js';
