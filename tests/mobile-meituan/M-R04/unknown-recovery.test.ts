/**
 * M-R04 提交结果未知恢复：**未知不得盲目重放，只能查原单**。
 *
 * 判据（`planSubmitRecovery`）与执行（`sendSubmit`）两侧都断言：
 * - 只有"请求可判定未到达平台"或"服务端幂等已核验"才允许续发同一请求；
 * - 其余任何"可能已到达"的结果（超时 / 5xx / 429 / 409 / 未登记码）一律 `query_original_order`；
 * - `mayCreateNewOrder` / `mayIssueNewAuthorization` 恒为 `false`。
 */

import { describe, expect, it } from 'vitest';

import { classifyOutcome } from './disposition.js';
import { planSubmitRecovery } from './recovery.js';
import {
  businessFailureHttpOutcome,
  httpOutcome,
  notSentOutcome,
  offlineOutcome,
  okHttpOutcome,
  rateLimitedOutcome,
  serverErrorOutcome,
} from './outcomes.js';
import { createSenderScenario, T0 } from './support.js';
import type { NetworkSnapshot, TransportDisposition } from './types.js';

const ONLINE: NetworkSnapshot = Object.freeze({
  kind: 'wifi',
  online: true,
  metered: false,
  generation: 1,
  changedAt: T0,
});

const OFFLINE: NetworkSnapshot = Object.freeze({
  kind: 'none',
  online: false,
  metered: false,
  generation: 2,
  changedAt: T0,
});

function dispositionOf(outcome: Parameters<typeof classifyOutcome>[0]): TransportDisposition {
  return classifyOutcome(outcome, { nowMs: T0 });
}

function recover(
  outcome: Parameters<typeof classifyOutcome>[0],
  overrides: Partial<{ attemptsMade: number; maxAttempts: number; serverIdempotencyVerified: boolean; network: NetworkSnapshot }> = {},
) {
  return planSubmitRecovery({
    network: overrides.network ?? ONLINE,
    disposition: dispositionOf(outcome),
    attemptsMade: overrides.attemptsMade ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    serverIdempotencyVerified: overrides.serverIdempotencyVerified ?? false,
  });
}

describe('M-R04 恢复判据：唯一合法动作', () => {
  it('离线 ⇒ wait_for_network（没发出，不查原单、不重发）', () => {
    const plan = recover(offlineOutcome(), { network: OFFLINE, attemptsMade: 0 });
    expect(plan.action).toBe('wait_for_network');
    expect(plan.requiresOriginalOrderQuery).toBe(false);
    expect(plan.autoResendAllowed).toBe(false);
  });

  it('超时（可能已到达，幂等未核验）⇒ query_original_order，禁止自动重放', () => {
    const plan = recover({ transport: 'timeout', detail: 'x' });
    expect(plan.action).toBe('query_original_order');
    expect(plan.requiresOriginalOrderQuery).toBe(true);
    expect(plan.autoResendAllowed).toBe(false);
    expect(plan.mayCreateNewOrder).toBe(false);
    expect(plan.mayIssueNewAuthorization).toBe(false);
  });

  it('503 ⇒ query_original_order', () => {
    expect(recover(serverErrorOutcome(503)).action).toBe('query_original_order');
  });

  it('429 ⇒ query_original_order（可能已到达，幂等未核验时不得盲目重放）', () => {
    expect(recover(rateLimitedOutcome('5')).action).toBe('query_original_order');
  });

  it('409 ⇒ query_original_order', () => {
    expect(recover(httpOutcome({ httpStatus: 409 })).action).toBe('query_original_order');
  });

  it('2xx 未登记业务码 ⇒ query_original_order', () => {
    expect(recover(httpOutcome({ httpStatus: 200, businessCode: 'mystery_code' })).action).toBe('query_original_order');
  });

  it('业务受理（ok）⇒ query_original_order（受理仍需查原单收口，不能凭业务码声称已下单）', () => {
    const plan = recover(okHttpOutcome('MT-1'));
    expect(plan.action).toBe('query_original_order');
    expect(plan.requiresOriginalOrderQuery).toBe(true);
  });

  it('确定性拒单 ⇒ stop_settled（终态，不重试）', () => {
    const plan = recover(businessFailureHttpOutcome('sold_out'));
    expect(plan.action).toBe('stop_settled');
    expect(plan.autoResendAllowed).toBe(false);
  });

  it('未到达且未达上限 ⇒ resume_same_request（可自动续发同一请求）', () => {
    const plan = recover(notSentOutcome('before_send'), { attemptsMade: 1, maxAttempts: 3 });
    expect(plan.action).toBe('resume_same_request');
    expect(plan.autoResendAllowed).toBe(true);
    expect(plan.requiresOriginalOrderQuery).toBe(false);
    expect(plan.mayCreateNewOrder).toBe(false);
  });

  it('未到达但已达上限 ⇒ give_up_no_retry（如实例放弃，不伪造成功）', () => {
    const plan = recover(notSentOutcome('before_send'), { attemptsMade: 3, maxAttempts: 3 });
    expect(plan.action).toBe('give_up_no_retry');
  });

  it('可能已到达 + 服务端幂等已核验且未达上限 ⇒ resume_same_request', () => {
    const plan = recover({ transport: 'timeout', detail: 'x' }, {
      serverIdempotencyVerified: true,
      attemptsMade: 1,
      maxAttempts: 3,
    });
    expect(plan.action).toBe('resume_same_request');
    expect(plan.autoResendAllowed).toBe(true);
  });

  it('可能已到达 + 幂等已核验但已达上限 ⇒ 仍转 query_original_order', () => {
    const plan = recover({ transport: 'timeout', detail: 'x' }, {
      serverIdempotencyVerified: true,
      attemptsMade: 3,
      maxAttempts: 3,
    });
    expect(plan.action).toBe('query_original_order');
    expect(plan.requiresOriginalOrderQuery).toBe(true);
  });

  it('任何计划都不允许新建订单 / 另发授权（字面量 false）', () => {
    const outcomes = [offlineOutcome(), notSentOutcome(), serverErrorOutcome(), rateLimitedOutcome('5'), okHttpOutcome()];
    for (const outcome of outcomes) {
      const plan = recover(outcome);
      expect(plan.mayCreateNewOrder).toBe(false);
      expect(plan.mayIssueNewAuthorization).toBe(false);
    }
  });
});

describe('M-R04 韧性发送器：提交的终局动作', () => {
  it('超时 ⇒ query_first，只发一次（绝不重放）', async () => {
    const scenario = createSenderScenario({ script: [{ transport: 'timeout', detail: 'x' }] });
    const result = await scenario.sender.sendSubmit('submit-ref-1');

    expect(result.finalAction).toBe('query_first');
    expect(result.attempts).toBe(1);
    expect(result.transportCalls).toBe(1);
    expect(scenario.transport.calls.length).toBe(1);
    expect(result.mayAutoResend).toBe(false);

    // 与恢复判据串起来：下一步就是查原单。
    expect(result.disposition).not.toBeNull();
    const plan = planSubmitRecovery({
      network: scenario.monitor.snapshot,
      disposition: result.disposition!,
      attemptsMade: result.attempts,
      maxAttempts: 3,
      serverIdempotencyVerified: false,
    });
    expect(plan.action).toBe('query_original_order');
  });

  it('429 ⇒ query_first，只发一次', async () => {
    const scenario = createSenderScenario({ script: [rateLimitedOutcome('30')] });
    const result = await scenario.sender.sendSubmit('submit-ref-2');
    expect(result.finalAction).toBe('query_first');
    expect(scenario.transport.calls.length).toBe(1);
  });

  it('503 ⇒ query_first，只发一次', async () => {
    const scenario = createSenderScenario({ script: [serverErrorOutcome(503)] });
    const result = await scenario.sender.sendSubmit('submit-ref-3');
    expect(result.finalAction).toBe('query_first');
    expect(scenario.transport.calls.length).toBe(1);
  });

  it('未到达（连接失败）⇒ 允许续发，重试到成功', async () => {
    const scenario = createSenderScenario({
      script: [notSentOutcome('before_send'), notSentOutcome('before_send'), okHttpOutcome('MT-9')],
    });
    const result = await scenario.sender.sendSubmit('submit-ref-4');

    expect(result.finalAction).toBe('accepted');
    expect(result.attempts).toBe(3);
    expect(result.transportCalls).toBe(3);
    expect(scenario.transport.calls.length).toBe(3);
  });

  it('未到达且尝试耗尽 ⇒ exhausted（不伪造成功）', async () => {
    const scenario = createSenderScenario({
      script: [notSentOutcome('before_send')],
      submitPolicy: { maxAttempts: 3, baseDelayMs: 500, factor: 2, maxDelayMs: 8_000, honorRetryAfter: true, jitterRatio: 0 },
    });
    const result = await scenario.sender.sendSubmit('submit-ref-5');
    expect(result.finalAction).toBe('exhausted');
    expect(result.attempts).toBe(3);
    expect(scenario.transport.calls.length).toBe(3);
  });

  it('业务拒单 ⇒ rejected（终态，不重试）', async () => {
    const scenario = createSenderScenario({ script: [businessFailureHttpOutcome('sold_out')] });
    const result = await scenario.sender.sendSubmit('submit-ref-6');
    expect(result.finalAction).toBe('rejected');
    expect(scenario.transport.calls.length).toBe(1);
  });

  it('幂等已核验时，429 可退避续发到成功', async () => {
    const scenario = createSenderScenario({
      script: [rateLimitedOutcome('1'), rateLimitedOutcome('1'), okHttpOutcome('MT-7')],
    });
    const result = await scenario.sender.sendSubmit('submit-ref-7', { serverIdempotencyVerified: true });

    expect(result.finalAction).toBe('accepted');
    expect(scenario.transport.calls.length).toBe(3);
    // 采纳 Retry-After(1s) 的等待。
    expect(scenario.sleeper.waits).toEqual([1_000, 1_000]);
  });

  it('幂等已核验但尝试耗尽 ⇒ exhausted', async () => {
    const scenario = createSenderScenario({ script: [serverErrorOutcome(503)] });
    const result = await scenario.sender.sendSubmit('submit-ref-8', { serverIdempotencyVerified: true });
    expect(result.finalAction).toBe('exhausted');
    expect(scenario.transport.calls.length).toBe(3);
  });
});

describe('M-R04 只读路径：可自由重试（与提交纪律不同）', () => {
  it('只读遇到 503 会退避重试到成功', async () => {
    const scenario = createSenderScenario({
      script: [serverErrorOutcome(503), serverErrorOutcome(500), okHttpOutcome()],
    });
    const result = await scenario.sender.sendRead('read-ref-1');

    expect(result.attempts).toBe(3);
    expect(scenario.transport.calls.length).toBe(3);
    expect(result.disposition?.kind).toBe('success');
    expect(result.retried).toBe(true);
    expect(scenario.sleeper.waits).toEqual([250, 500]); // 指数退避
  });

  it('只读遇到 429 采纳 Retry-After 后重试', async () => {
    const scenario = createSenderScenario({ script: [rateLimitedOutcome('2'), okHttpOutcome()] });
    const result = await scenario.sender.sendRead('read-ref-2');
    expect(result.attempts).toBe(2);
    expect(scenario.sleeper.waits).toEqual([2_000]);
  });

  it('只读遇到 4xx 不重试', async () => {
    const scenario = createSenderScenario({ script: [httpOutcome({ httpStatus: 403 })] });
    const result = await scenario.sender.sendRead('read-ref-3');
    expect(result.attempts).toBe(1);
    expect(result.disposition?.kind).toBe('client_error');
  });
});
