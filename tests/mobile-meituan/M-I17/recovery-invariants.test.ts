/**
 * M-I17 ② 提升后必须保留的四条不变量（提升不得改变行为）。
 *
 *  1. "可能已到达"的提交**只发一次**后返回 `query_first`，恢复计划
 *     `autoResendAllowed=false` 且 `mayCreateNewOrder` / `mayIssueNewAuthorization`
 *     **字面量 false**；
 *  2. **离线**时绝不调用传输端口；
 *  3. 退避等待期间**掉线**，下一次发送被拦下；
 *  4. `429` ⇒ `after_delay` 且**采纳 `Retry-After`**。
 */

import { describe, expect, it } from 'vitest';

import { classifyOutcome } from '../../../src/mobile-plugins/meituan/network-resilience/index.js';
import { planSubmitRecovery } from '../../../src/mobile-plugins/meituan/network-resilience/index.js';
import {
  businessFailureHttpOutcome,
  notSentOutcome,
  offlineOutcome,
  okHttpOutcome,
  rateLimitedOutcome,
  serverErrorOutcome,
} from '../../../src/mobile-plugins/meituan/network-resilience/index.js';
import type {
  NetworkSnapshot,
  TransportDisposition,
} from '../../../src/mobile-plugins/meituan/network-resilience/index.js';
import { createSenderScenario, T0 } from './support.js';

const ONLINE: NetworkSnapshot = Object.freeze({
  kind: 'wifi',
  online: true,
  metered: false,
  generation: 1,
  changedAt: T0,
});

function dispositionOf(outcome: Parameters<typeof classifyOutcome>[0]): TransportDisposition {
  return classifyOutcome(outcome, { nowMs: T0 });
}

function recover(
  outcome: Parameters<typeof classifyOutcome>[0],
  overrides: Partial<{ attemptsMade: number; maxAttempts: number; serverIdempotencyVerified: boolean }> = {},
) {
  return planSubmitRecovery({
    network: ONLINE,
    disposition: dispositionOf(outcome),
    attemptsMade: overrides.attemptsMade ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    serverIdempotencyVerified: overrides.serverIdempotencyVerified ?? false,
  });
}

describe('不变量 1：可能已到达的提交只发一次，随后 query_first', () => {
  it('超时：只发一次 ⇒ query_first；恢复计划禁止自动重放且不得新建订单/另发授权', async () => {
    const scenario = createSenderScenario({ script: [{ transport: 'timeout', detail: 'x' }] });
    const result = await scenario.sender.sendSubmit('submit-ref-1');

    expect(result.finalAction).toBe('query_first');
    expect(result.attempts).toBe(1);
    expect(result.transportCalls).toBe(1);
    expect(scenario.transport.calls.length).toBe(1);
    expect(result.mayAutoResend).toBe(false);

    const plan = recover(result.outcome!, { attemptsMade: result.attempts });
    expect(plan.action).toBe('query_original_order');
    expect(plan.autoResendAllowed).toBe(false);
    expect(plan.mayCreateNewOrder).toBe(false);
    expect(plan.mayIssueNewAuthorization).toBe(false);
  });

  it('503：只发一次 ⇒ query_first（绝不重放）', async () => {
    const scenario = createSenderScenario({ script: [serverErrorOutcome(503)] });
    const result = await scenario.sender.sendSubmit('submit-ref-2');
    expect(result.finalAction).toBe('query_first');
    expect(scenario.transport.calls.length).toBe(1);
  });

  it('429（幂等未核验）：只发一次 ⇒ query_first', async () => {
    const scenario = createSenderScenario({ script: [rateLimitedOutcome('30')] });
    const result = await scenario.sender.sendSubmit('submit-ref-3');
    expect(result.finalAction).toBe('query_first');
    expect(scenario.transport.calls.length).toBe(1);
  });

  it('字面量 false 覆盖所有恢复结果（含受理 / 离线 / 未到达 / 拒单）', () => {
    const outcomes = [
      offlineOutcome(),
      notSentOutcome('before_send'),
      serverErrorOutcome(503),
      rateLimitedOutcome('5'),
      okHttpOutcome('MT-1'),
      businessFailureHttpOutcome('sold_out'),
    ];
    for (const outcome of outcomes) {
      const plan = recover(outcome);
      expect(plan.mayCreateNewOrder).toBe(false);
      expect(plan.mayIssueNewAuthorization).toBe(false);
    }
  });
});

describe('不变量 2：离线绝不调用传输端口', () => {
  it('离线只读：attempts=0 且 transportCalls=0', async () => {
    const scenario = createSenderScenario({ initialNetwork: 'none', script: [okHttpOutcome()] });
    const result = await scenario.sender.sendRead('read-ref-1');
    expect(result.attempts).toBe(0);
    expect(result.transportCalls).toBe(0);
    expect(scenario.transport.calls.length).toBe(0);
    expect(result.outcome?.transport).toBe('offline');
    expect(result.disposition?.mayHaveReachedPlatform).toBe(false);
  });

  it('离线提交：finalAction=not_sent 且不调用端口（不凭空制造"可能已下单"）', async () => {
    const scenario = createSenderScenario({ initialNetwork: 'cellular', script: [okHttpOutcome()] });
    scenario.monitor.setKind('none');
    const result = await scenario.sender.sendSubmit('submit-ref-4');
    expect(result.finalAction).toBe('not_sent');
    expect(result.attempts).toBe(0);
    expect(result.transportCalls).toBe(0);
    expect(scenario.transport.calls.length).toBe(0);
    expect(result.mayAutoResend).toBe(false);
  });
});

describe('不变量 3：退避等待期间掉线，下一次发送被拦下', () => {
  it('只读：等待中掉线，第二次发送不发出（transportCalls 停在 1）', async () => {
    const scenario = createSenderScenario({
      initialNetwork: 'wifi',
      script: [serverErrorOutcome(503), okHttpOutcome()],
      sleeperHook: (_ms, _index, monitor) => monitor.setKind('none'),
    });
    const result = await scenario.sender.sendRead('read-ref-2');

    expect(result.attempts).toBe(1);
    expect(result.transportCalls).toBe(1);
    expect(scenario.transport.calls.length).toBe(1);
    expect(result.outcome?.transport).toBe('offline');
    expect(scenario.sleeper.waits).toEqual([250]);
  });

  it('提交：幂等已核验可续发，但退避等待中掉线后不再发出', async () => {
    const scenario = createSenderScenario({
      initialNetwork: 'wifi',
      // 429 走 after_delay（有等待）；幂等已核验 ⇒ 允许续发，于是会进入等待。
      script: [rateLimitedOutcome('1'), okHttpOutcome('MT-9')],
      sleeperHook: (_ms, _index, monitor) => monitor.setKind('none'),
    });
    const result = await scenario.sender.sendSubmit('submit-ref-5', { serverIdempotencyVerified: true });

    // 第一次发送后进入 1000ms 退避等待，等待中掉线 ⇒ 第二次发送被拦下。
    expect(scenario.transport.calls.length).toBe(1);
    expect(scenario.sleeper.waits).toEqual([1_000]);
    expect(result.outcome?.transport).toBe('offline');
    expect(result.finalAction).toBe('not_sent');
    expect(result.mayAutoResend).toBe(false);
  });
});

describe('不变量 4：429 ⇒ after_delay 且采纳 Retry-After', () => {
  it('分类层：429 带 Retry-After=30 ⇒ retryAfterMs=30000', () => {
    const disposition = dispositionOf(rateLimitedOutcome('30'));
    expect(disposition.kind).toBe('rate_limited');
    expect(disposition.retry).toBe('after_delay');
    expect(disposition.retryAfterMs).toBe(30_000);
  });

  it('只读执行层：等待 2000ms（采纳 Retry-After=2）后重试成功', async () => {
    const scenario = createSenderScenario({ script: [rateLimitedOutcome('2'), okHttpOutcome()] });
    const result = await scenario.sender.sendRead('read-ref-3');
    expect(result.attempts).toBe(2);
    expect(scenario.sleeper.waits).toEqual([2_000]);
  });

  it('提交执行层：幂等已核验时 429 退避续发，等待采纳 Retry-After', async () => {
    const scenario = createSenderScenario({
      script: [rateLimitedOutcome('1'), rateLimitedOutcome('1'), okHttpOutcome('MT-7')],
    });
    const result = await scenario.sender.sendSubmit('submit-ref-6', { serverIdempotencyVerified: true });
    expect(result.finalAction).toBe('accepted');
    expect(scenario.transport.calls.length).toBe(3);
    expect(scenario.sleeper.waits).toEqual([1_000, 1_000]);
  });
});
