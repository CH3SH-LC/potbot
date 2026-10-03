/**
 * M-R04 重试策略 —— **有界退避 + `Retry-After` 解析**（零依赖、纯函数）。
 *
 * ## 为什么把"等多久"做成纯函数
 *
 * 重试时长若掺进随机数或墙钟，就无法回归。这里把三件事拆开：
 * 1. {@link parseRetryAfter}：只解释服务端给的 `Retry-After`（秒 / HTTP 日期）；
 * 2. {@link computeBackoffDelay}：确定性指数退避 + 上限；
 * 3. {@link planRetry}：把处置结论翻成动作。抖动**只在注入 `jitterFn` 时**生效。
 *
 * ## `Retry-After` 必须被采纳（429 的关键）
 *
 * 429 常带 `Retry-After`。忽略它会让客户端把限流打成雪崩；采纳它（取"至少等这么久"）
 * 是 429 与普通 5xx 在策略上的唯一区别。**注意**：采纳 `Retry-After` 只是"等多久"，
 * "能不能重放"另有判据（提交侧见 `recovery.ts`）。
 */

import type { RetryAction, RetryPlan, RetryPolicy, TransportDisposition } from './types.js';

/** 只读路径的默认策略（可自由重试）。 */
export const DEFAULT_READ_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 4_000,
  honorRetryAfter: true,
  jitterRatio: 0,
});

/** 提交路径的默认策略（重放纪律更严，见 `recovery.ts`）。 */
export const DEFAULT_SUBMIT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8_000,
  honorRetryAfter: true,
  jitterRatio: 0,
});

/**
 * 解析 `Retry-After`。接受：
 * - 非负整数字符串（秒）⇒ 秒 × 1000；
 * - HTTP 日期（`Date.parse` 可解析）⇒ 与 `nowMs` 之差（负数夹到 0）；
 * - 其它（空 / 负 / 不可解析）⇒ `null`（**不猜**，退回普通退避）。
 */
export function parseRetryAfter(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) {
      return null;
    }
    return seconds * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, parsed - nowMs);
}

/** 确定性指数退避（不含抖动）。`attemptIndex` 从 0 起（第一次失败）。 */
export function computeBackoffDelay(
  policy: RetryPolicy,
  attemptIndex: number,
  retryAfterMs: number | null = null,
): number {
  const index = Math.max(0, Math.floor(attemptIndex));
  const raw = policy.baseDelayMs * Math.pow(policy.factor, index);
  let delay = Math.min(policy.maxDelayMs, Math.max(0, Math.floor(raw)));
  if (policy.honorRetryAfter && retryAfterMs !== null && Number.isFinite(retryAfterMs)) {
    delay = Math.min(policy.maxDelayMs, Math.max(delay, Math.floor(retryAfterMs)));
  }
  return delay;
}

/** 应用抖动。`jitterFn` 必须返回 `[0,1)`；缺省或非正比例 ⇒ 原样返回（确定性）。 */
export function applyJitter(
  delayMs: number,
  ratio: number,
  jitterFn: (() => number) | null | undefined,
): number {
  if (jitterFn === undefined || jitterFn === null || ratio <= 0) {
    return delayMs;
  }
  const sample = jitterFn();
  const bounded = Math.min(0.999_999, Math.max(0, sample));
  return Math.floor(delayMs + bounded * ratio * delayMs);
}

export interface PlanRetryInput {
  readonly disposition: TransportDisposition;
  /** 已完成的传输尝试次数（首次失败后为 1）。 */
  readonly attemptsMade: number;
  readonly policy: RetryPolicy;
  readonly jitterFn?: (() => number) | null;
}

/** 依据处置结论产出重试动作。**纯函数**（抖动可选且注入）。 */
export function planRetry(input: PlanRetryInput): RetryPlan {
  const { disposition, policy } = input;
  const attemptsMade = Math.max(0, Math.floor(input.attemptsMade));

  if (disposition.kind === 'success') {
    return Object.freeze({ action: 'stop' as RetryAction, delayMs: 0, attemptsMade, reason: '已受理：无需重试' });
  }
  if (disposition.retry === 'no') {
    return Object.freeze({ action: 'give_up' as RetryAction, delayMs: 0, attemptsMade, reason: disposition.reason });
  }
  if (disposition.retry === 'wait_for_network') {
    return Object.freeze({ action: 'wait_for_network' as RetryAction, delayMs: 0, attemptsMade, reason: disposition.reason });
  }

  // immediate / after_delay
  if (attemptsMade >= policy.maxAttempts) {
    return Object.freeze({
      action: 'give_up' as RetryAction,
      delayMs: 0,
      attemptsMade,
      reason: `已达尝试上限 ${policy.maxAttempts}：${disposition.reason}`,
    });
  }
  if (disposition.retry === 'immediate') {
    return Object.freeze({
      action: 'retry_immediate' as RetryAction,
      delayMs: 0,
      attemptsMade,
      reason: `可立即重试（未到达平台）：${disposition.reason}`,
    });
  }
  const base = computeBackoffDelay(policy, attemptsMade - 1, disposition.retryAfterMs);
  const delay = applyJitter(base, policy.jitterRatio, input.jitterFn);
  return Object.freeze({
    action: 'retry_after_delay' as RetryAction,
    delayMs: delay,
    attemptsMade,
    reason: `等待 ${delay}ms 后重试：${disposition.reason}`,
  });
}
