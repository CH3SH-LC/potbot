/**
 * 有界重试策略（K-I26：由 K-R03 测试区提升为**产品模块**）——
 * **只重试可重试的失败，且重试不重复工具动作**。
 *
 * ## 这个模块补的是什么缺口
 *
 * K02 `model/port.ts` 里 `run()` 是**单次**运行，没有重试循环；`model/errors.ts` 导出了
 * `RETRYABLE_ERROR_CODES`（`rate_limited / timeout / stream_truncated / stream_failed /
 * upstream_error`）却没有任何调用方。真实产品需要一个重试层——本模块就是它：
 *
 * 1. `429`、断流可重试；`401`、预算不足/超支、参数非法、工具执行失败**一律不重试**；
 *    `cancelled`（用户主动取消）**绝不重试**——重试一个取消等于违背用户意图。
 * 2. 重试次数**有界**：脚本耗尽即停，绝不无限循环。
 * 3. **重试不重复工具动作**：把 `ToolIdempotencyLedger` 接进 `onToolCall`，
 *    同一个逻辑工具动作跨重试只执行一次（见 `idempotency.ts`）。
 *
 * ## 诚实标注
 *
 * - **不做退避等待**：`backoffMs` 只作为计划值记入日志，本模块**不 sleep**。测试因此确定性、快。
 *   真实退避（抖动、指数）留给接线到真机网络层的包。
 */

import { RETRYABLE_ERROR_CODES } from '../model/errors.js';
import {
  mayClaimModelSuccess,
  type ModelPort,
  type ModelRunOutcome,
} from '../model/port.js';
import type { CancellationSource } from '../model/cancellation.js';
import type { ModelPortRequest, ToolCall } from '../model/types.js';
import { ToolIdempotencyLedger, deriveToolKey } from './idempotency.js';

/** 重试策略（运行时形态）。`retryableCodes` 缺省 = 内核 `RETRYABLE_ERROR_CODES`。 */
export interface RetryPolicy {
  /** 总尝试次数（含首次），1..10。 */
  readonly maxAttempts: number;
  /** 允许触发重试的内核错误码（小写）。缺省取内核词表。 */
  readonly retryableCodes?: readonly string[];
  /** 计划退避（毫秒），只记日志不等待。长度可短于 maxAttempts，取不到记 0。 */
  readonly backoffMs?: readonly number[];
}

/** 默认策略：3 次尝试，重试集 = 内核 `RETRYABLE_ERROR_CODES`，无退避等待。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({ maxAttempts: 3 });

/** 一次尝试的**可机读**记录。 */
export interface RetryAttemptRecord {
  readonly attempt: number;
  readonly status: ModelRunOutcome['status'];
  /** 内核错误码（小写），成功或无错为 `null`。 */
  readonly errorCode: string | null;
  /** 流上错误码（大写），成功或无错为 `null`。 */
  readonly streamErrorCode: string | null;
  readonly success: boolean;
  /** 该次失败是否属于可重试集合。 */
  readonly retryable: boolean;
  /** 是否**真的**会发起下一次重试（受 `maxAttempts` 上界约束）。 */
  readonly willRetry: boolean;
  /** 计划退避（毫秒）。**不等待**，仅记录。 */
  readonly plannedDelayMs: number;
  readonly toolCalls: readonly ToolCall[];
}

export interface RetryRunOutcome {
  readonly final: ModelRunOutcome;
  readonly attempts: number;
  readonly log: readonly RetryAttemptRecord[];
  readonly retried: boolean;
}

/** 工具执行接线：账本 + 执行器表 + 作用域/显式幂等键。 */
export interface ToolRuntime {
  readonly ledger: ToolIdempotencyLedger;
  readonly executors: Readonly<
    Record<string, (args: Readonly<Record<string, unknown>>, call: ToolCall) => unknown | Promise<unknown>>
  >;
  /** 作用域（如 taskId），用于派生幂等键，隔离不同任务里的同名动作。 */
  readonly scope?: string;
  /** 按 `toolCallId` 指定的显式幂等键（优先于派生键）。 */
  readonly idempotencyKeys?: Readonly<Record<string, string>>;
}

export interface RetryRunOptions {
  readonly policy?: RetryPolicy;
  readonly tools?: ToolRuntime;
  readonly cancellation?: CancellationSource;
  /** 每次重试前的观察钩子（可用于指标/日志；不含密钥）。 */
  readonly onRetry?: (record: RetryAttemptRecord) => void | Promise<void>;
}

const MAX_ATTEMPTS_CEILING = 10;

function normalizePolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  const source = policy ?? DEFAULT_RETRY_POLICY;
  const maxAttempts = source.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS_CEILING) {
    throw new RangeError(`maxAttempts 必须是 1..${MAX_ATTEMPTS_CEILING} 的整数，收到 ${String(maxAttempts)}`);
  }
  const retryableCodes = source.retryableCodes ?? RETRYABLE_ERROR_CODES;
  if (!Array.isArray(retryableCodes) || retryableCodes.length === 0) {
    throw new TypeError('retryableCodes 必须是非空数组（空集合等于"永不重试"，请显式用 maxAttempts:1 表达）');
  }
  return {
    maxAttempts,
    retryableCodes: Object.freeze([...retryableCodes]),
    backoffMs: Object.freeze([...(source.backoffMs ?? [])]),
  };
}

/** 内核流错误码（大写）→ 内核内部码（小写），供重试集比对。 */
function lowerCode(code: string | null | undefined): string | null {
  return typeof code === 'string' && code.length > 0 ? code.toLowerCase() : null;
}

/**
 * 包一层**有界**重试。
 *
 * 关键判据（每条都有对应反例测试）：
 * - 只有 `status === 'failed'` 且错误码落在 `retryableCodes` 才重试；
 * - `status === 'cancelled'` **永不**重试；
 * - `mayClaimModelSuccess` 为真立即返回，不触发下一次尝试；
 * - 尝试数封顶 `maxAttempts`，退尽后如实返回最后一次失败（**绝不**在失败上伪造成功）。
 */
export async function runWithRetry(
  port: ModelPort,
  request: ModelPortRequest,
  options: RetryRunOptions = {},
): Promise<RetryRunOutcome> {
  const policy = normalizePolicy(options.policy);
  const log: RetryAttemptRecord[] = [];

  // onToolCall 在**整个重试周期内共享**：账本跨尝试累积，才能挡住重复执行。
  const tools = options.tools;
  const onToolCall =
    tools === undefined
      ? undefined
      : async (call: ToolCall): Promise<unknown> => {
          const executor = tools.executors[call.toolName];
          if (executor === undefined) {
            throw new Error(`未注册工具执行器：${call.toolName}（缺执行器不得假装动作已完成）`);
          }
          const key = tools.idempotencyKeys?.[call.toolCallId] ?? deriveToolKey(tools.scope, call);
          const record = await tools.ledger.execute(
            key,
            { toolName: call.toolName, toolCallId: call.toolCallId },
            () => executor(call.arguments, call),
          );
          return record.value;
        };

  let outcome: ModelRunOutcome | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    outcome = await port.run(request, {
      ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
      ...(onToolCall === undefined ? {} : { onToolCall }),
    });

    const success = mayClaimModelSuccess(outcome);
    const errorCode = lowerCode(outcome.error?.code ?? null);
    const retryable = !success && outcome.status === 'failed' && errorCode !== null && policy.retryableCodes.includes(errorCode);
    const willRetry = retryable && attempt < policy.maxAttempts;

    const record: RetryAttemptRecord = Object.freeze({
      attempt,
      status: outcome.status,
      errorCode,
      streamErrorCode: outcome.error?.code ?? null,
      success,
      retryable,
      willRetry,
      plannedDelayMs: policy.backoffMs[attempt - 1] ?? 0,
      toolCalls: outcome.toolCalls,
    });
    log.push(record);

    if (success || !willRetry) {
      break;
    }
    if (options.onRetry !== undefined) {
      await options.onRetry(record);
    }
  }

  // outcome 至少被赋值一次（maxAttempts >= 1）。
  const final = outcome as ModelRunOutcome;
  return Object.freeze({
    final,
    attempts: log.length,
    log: Object.freeze(log),
    retried: log.length > 1,
  });
}
