/**
 * K-I12 任务↔外部分副作用桥 —— **错误词表**（零依赖）。
 *
 * 桥的拒因**必须机读可辨**，不得退化成 `false` / `null`：
 * "任务不在台账里"与"这条外部意图引用解析不出提交"是两码事，上层要能分别处理。
 * 桥只负责**它自己**的边界校验；K10 / K07 各自域内的拒因（`unknown_task` 生命期版、
 * `illegal_transition`、`missing_order_query_port`…）原样上抛，不在此重包——
 * 重新包一层会把"谁拒的"这件事抹掉。
 */

/** 桥自身的全部可机读拒因（新增必须在此登记）。 */
export const TASK_EXTERNAL_BRIDGE_ERROR_CODES = [
  /** K10 任务台账里没有这个任务。 */
  'unknown_task',
  /** 该任务没有已发起、待结清的外部意图，无从结清。 */
  'no_pending_external_intent',
  /** `externalIntentRef` 约定为 K07 submissionId，但提交账本里查不到这条提交（引用约定被破坏）。 */
  'unknown_submission',
  /** 提交记录属于**另一个**任务：跨任务引用不得被当成同一任务的外部意图。 */
  'submission_task_mismatch',
] as const;

export type TaskExternalBridgeErrorCode = (typeof TASK_EXTERNAL_BRIDGE_ERROR_CODES)[number];

export class TaskExternalBridgeError extends Error {
  readonly code: TaskExternalBridgeErrorCode;

  constructor(code: TaskExternalBridgeErrorCode, message: string) {
    super(message);
    this.name = 'TaskExternalBridgeError';
    this.code = code;
  }
}

export function isTaskExternalBridgeError(value: unknown): value is TaskExternalBridgeError {
  return value instanceof TaskExternalBridgeError;
}
