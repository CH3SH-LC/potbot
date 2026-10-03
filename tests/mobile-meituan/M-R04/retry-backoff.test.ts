/**
 * M-R04 重试策略：`Retry-After` 解析、确定性指数退避、抖动、动作计划。
 *
 * 全是纯函数用例：不读时钟、不等待、可重现。抖动只在**注入**函数时生效。
 */

import { describe, expect, it } from 'vitest';

import { classifyOutcome } from './disposition.js';
import {
  applyJitter,
  computeBackoffDelay,
  parseRetryAfter,
  planRetry,
} from './retry-policy.js';
import {
  businessFailureHttpOutcome,
  networkErrorOutcome,
  notSentOutcome,
  offlineOutcome,
  okHttpOutcome,
  rateLimitedOutcome,
  serverErrorOutcome,
} from './outcomes.js';
import type { RetryPolicy } from './types.js';

const T0 = 1_700_000_000_000;

const POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 4_000,
  honorRetryAfter: true,
  jitterRatio: 0,
});

describe('M-R04 parseRetryAfter', () => {
  it('秒数字符串 ⇒ 秒 × 1000', () => {
    expect(parseRetryAfter('120', T0)).toBe(120_000);
    expect(parseRetryAfter('0', T0)).toBe(0);
  });

  it('带空白 ⇒ 先 trim 再解析', () => {
    expect(parseRetryAfter('  90 ', T0)).toBe(90_000);
  });

  it('HTTP 日期 ⇒ 与 nowMs 之差', () => {
    const now = 1_000_000;
    const header = new Date(now + 5_000).toUTCString();
    expect(parseRetryAfter(header, now)).toBe(5_000);
  });

  it('过去的 HTTP 日期 ⇒ 夹到 0', () => {
    const now = 2_000_000;
    const header = new Date(now - 5_000).toUTCString();
    expect(parseRetryAfter(header, now)).toBe(0);
  });

  it('空 / null / 不可解析 ⇒ null（不猜）', () => {
    expect(parseRetryAfter('', T0)).toBeNull();
    expect(parseRetryAfter('   ', T0)).toBeNull();
    expect(parseRetryAfter(null, T0)).toBeNull();
    expect(parseRetryAfter(undefined, T0)).toBeNull();
    expect(parseRetryAfter('not-a-date', T0)).toBeNull();
    expect(parseRetryAfter(120 as unknown, T0)).toBeNull();
  });
});

describe('M-R04 computeBackoffDelay：确定性指数退避 + 上限', () => {
  it('base*factor^index，超过上限则夹住', () => {
    expect(computeBackoffDelay(POLICY, 0)).toBe(250);
    expect(computeBackoffDelay(POLICY, 1)).toBe(500);
    expect(computeBackoffDelay(POLICY, 2)).toBe(1_000);
    expect(computeBackoffDelay(POLICY, 3)).toBe(2_000);
    expect(computeBackoffDelay(POLICY, 4)).toBe(4_000);
    expect(computeBackoffDelay(POLICY, 10)).toBe(4_000); // 上限
  });

  it('采纳 Retry-After：取"至少等这么久"', () => {
    expect(computeBackoffDelay(POLICY, 0, 900)).toBe(900);
    expect(computeBackoffDelay(POLICY, 3, 900)).toBe(2_000); // 退避更长，取退避
  });

  it('Retry-After 大于上限 ⇒ 夹到 maxDelayMs', () => {
    expect(computeBackoffDelay(POLICY, 0, 999_999)).toBe(4_000);
  });

  it('honorRetryAfter=false 时忽略 Retry-After', () => {
    const policy: RetryPolicy = { ...POLICY, honorRetryAfter: false };
    expect(computeBackoffDelay(policy, 0, 900)).toBe(250);
  });

  it('负数 index 夹到 0', () => {
    expect(computeBackoffDelay(POLICY, -5)).toBe(250);
  });
});

describe('M-R04 applyJitter', () => {
  it('无抖动函数 / 比例 0 ⇒ 原样返回（确定性）', () => {
    expect(applyJitter(1_000, 0.5, null)).toBe(1_000);
    expect(applyJitter(1_000, 0.5, undefined)).toBe(1_000);
    expect(applyJitter(1_000, 0, () => 0.5)).toBe(1_000);
  });

  it('注入抖动函数 ⇒ delay + jitter*sample*delay', () => {
    // 1000 + 0.5 * 0.5 * 1000 = 1250
    expect(applyJitter(1_000, 0.5, () => 0.5)).toBe(1_250);
  });

  it('样本越界被夹到 [0,1)', () => {
    expect(applyJitter(1_000, 1, () => -1)).toBe(1_000);
    expect(applyJitter(1_000, 1, () => 5)).toBe(1_999); // 0.999999 → floor(1999.999)
  });
});

describe('M-R04 planRetry：处置 ⇒ 动作', () => {
  it('成功 ⇒ stop', () => {
    const d = classifyOutcome(okHttpOutcome(), { nowMs: T0 });
    expect(planRetry({ disposition: d, attemptsMade: 1, policy: POLICY }).action).toBe('stop');
  });

  it('业务拒单 ⇒ give_up', () => {
    const d = classifyOutcome(businessFailureHttpOutcome('sold_out'), { nowMs: T0 });
    expect(planRetry({ disposition: d, attemptsMade: 1, policy: POLICY }).action).toBe('give_up');
  });

  it('离线 ⇒ wait_for_network', () => {
    const d = classifyOutcome(offlineOutcome(), { nowMs: T0 });
    expect(planRetry({ disposition: d, attemptsMade: 1, policy: POLICY }).action).toBe('wait_for_network');
  });

  it('未到达的可立即重试 ⇒ retry_immediate，delay 0', () => {
    const d = classifyOutcome(notSentOutcome('before_send'), { nowMs: T0 });
    const plan = planRetry({ disposition: d, attemptsMade: 1, policy: POLICY });
    expect(plan.action).toBe('retry_immediate');
    expect(plan.delayMs).toBe(0);
  });

  it('429 ⇒ retry_after_delay，采纳 Retry-After', () => {
    const d = classifyOutcome(rateLimitedOutcome('120'), { nowMs: T0 });
    const plan = planRetry({ disposition: d, attemptsMade: 1, policy: POLICY });
    expect(plan.action).toBe('retry_after_delay');
    expect(plan.delayMs).toBe(4_000); // 120000 被夹到 maxDelay 4000
  });

  it('5xx ⇒ retry_after_delay（退避 250）', () => {
    const d = classifyOutcome(serverErrorOutcome(503), { nowMs: T0 });
    const plan = planRetry({ disposition: d, attemptsMade: 1, policy: POLICY });
    expect(plan.action).toBe('retry_after_delay');
    expect(plan.delayMs).toBe(250);
  });

  it('在途网络错误 ⇒ retry_after_delay', () => {
    const d = classifyOutcome(networkErrorOutcome('during_send'), { nowMs: T0 });
    expect(planRetry({ disposition: d, attemptsMade: 1, policy: POLICY }).action).toBe('retry_after_delay');
  });

  it('已达尝试上限 ⇒ give_up（即使可重试）', () => {
    const d = classifyOutcome(serverErrorOutcome(503), { nowMs: T0 });
    const plan = planRetry({ disposition: d, attemptsMade: 4, policy: POLICY });
    expect(plan.action).toBe('give_up');
    expect(plan.reason).toContain('上限');
  });

  it('抖动在注入时生效：429/5xx 的等待被放大', () => {
    const d = classifyOutcome(serverErrorOutcome(503), { nowMs: T0 });
    const plan = planRetry({
      disposition: d,
      attemptsMade: 1,
      policy: { ...POLICY, jitterRatio: 0.5 },
      jitterFn: () => 0.5,
    });
    expect(plan.delayMs).toBe(312); // floor(250 + 0.5*0.5*250) = floor(312.5)
  });
});
