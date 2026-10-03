/**
 * M-I17 ① 提升面 + 与 M-I02 传输的**形状互操作**。
 *
 * 断言两件事：
 *  1. 生产源码 `src/mobile-plugins/meituan/network-resilience/` 公开导出
 *     `NetworkMonitor` / `planSubmitRecovery` / `NetworkOutcome` 消费面；
 *  2. **M-I02（M02 `mobile-transport`）实际发出的 `NetworkOutcome`** 可被提升后的
 *     `classifyOutcome` / `planSubmitRecovery` 直接消费——既有构造器层面的结构一致，
 *     也有走完 `TransportClient` 真实调用链后的端到端一致。
 */

import { describe, expect, it } from 'vitest';

import {
  makeNetworkErrorOutcome,
  makeNotSentOutcome,
  makeOfflineOutcome,
  makeResponseOutcome,
  makeTimeoutOutcome,
  projectNetworkOutcome,
  readRetryAfter,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import {
  classifyOutcome,
  createNetworkMonitor,
  createResilientSender,
  NETWORK_RESILIENCE_BOUNDARY,
  NetworkMonitor,
  planSubmitRecovery,
  ResilientSender,
} from '../../../src/mobile-plugins/meituan/network-resilience/index.js';
import {
  createTransportScenario,
  descriptor,
  openTransportSession,
  T0,
} from './support.js';

describe('M-I17 提升面：生产源码公开出口', () => {
  it('NetworkMonitor / planSubmitRecovery / NetworkOutcome 消费面已导出', () => {
    expect(typeof NetworkMonitor).toBe('function');
    expect(typeof createNetworkMonitor).toBe('function');
    expect(typeof ResilientSender).toBe('function');
    expect(typeof createResilientSender).toBe('function');
    expect(typeof planSubmitRecovery).toBe('function');
    expect(typeof classifyOutcome).toBe('function');
  });

  it('边界常量如实声明：不触网、不接真实平台、不产生真实订单', () => {
    expect(NETWORK_RESILIENCE_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(NETWORK_RESILIENCE_BOUNDARY.transportMustBeInjected).toBe(true);
    expect(NETWORK_RESILIENCE_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(NETWORK_RESILIENCE_BOUNDARY.producesRealOrder).toBe(false);
    expect(Object.isFrozen(NETWORK_RESILIENCE_BOUNDARY)).toBe(true);
  });
});

describe('M-I17 互操作：M-I02 构造器产出的 NetworkOutcome 可被提升层消费', () => {
  it('before_send 未发出 ⇒ 可判定未到达平台（不是"发出后未知"）', () => {
    const disposition = classifyOutcome(makeNotSentOutcome('DNS 失败', 'before_send'), { nowMs: T0 });
    expect(disposition.kind).toBe('network_error');
    expect(disposition.mayHaveReachedPlatform).toBe(false);
    expect(disposition.retry).toBe('immediate');
  });

  it('during_send 网络错误 ⇒ 可能已到达平台', () => {
    const disposition = classifyOutcome(makeNetworkErrorOutcome('连接中断', 'during_send'), { nowMs: T0 });
    expect(disposition.mayHaveReachedPlatform).toBe(true);
    expect(disposition.retry).toBe('after_delay');
  });

  it('超时 / 离线分别映射为 timeout / offline', () => {
    expect(classifyOutcome(makeTimeoutOutcome('超时'), { nowMs: T0 }).kind).toBe('timeout');
    expect(classifyOutcome(makeOfflineOutcome('离线'), { nowMs: T0 }).kind).toBe('offline');
  });

  it('response + Retry-After 原文 ⇒ rate_limited 并采纳 Retry-After', () => {
    const disposition = classifyOutcome(
      makeResponseOutcome({ httpStatus: 429, retryAfterHeader: '30' }),
      { nowMs: T0 },
    );
    expect(disposition.kind).toBe('rate_limited');
    expect(disposition.retry).toBe('after_delay');
    expect(disposition.retryAfterMs).toBe(30_000);
  });
});

describe('M-I17 互操作：真实走完 M-I02 TransportClient 调用链', () => {
  it('2xx 业务受理 ⇒ response(ok) ⇒ success，且仍需查原单收口', async () => {
    const scenario = createTransportScenario([
      { kind: 'respond', status: 200, body: { code: 'ok', data: {} } },
    ]);
    await openTransportSession(scenario.session, T0);

    const outcome = await scenario.client.invokeNetwork(descriptor(), T0);
    expect(outcome.transport).toBe('response');
    if (outcome.transport !== 'response') throw new Error('unreachable');

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.businessCode).toBe('ok');

    const disposition = classifyOutcome(outcome, { nowMs: T0 });
    expect(disposition.kind).toBe('success');

    const plan = planSubmitRecovery({
      network: { kind: 'wifi', online: true, metered: false, generation: 1, changedAt: T0 },
      disposition,
      attemptsMade: 1,
      maxAttempts: 3,
      serverIdempotencyVerified: false,
    });
    expect(plan.action).toBe('query_original_order');
    expect(plan.mayCreateNewOrder).toBe(false);
    expect(plan.mayIssueNewAuthorization).toBe(false);
  });

  it('429 响应原样透传 Retry-After，提升层采纳为 after_delay', async () => {
    const scenario = createTransportScenario([
      {
        kind: 'respond',
        status: 429,
        body: { code: 'rate_limited', data: {} },
        headers: { 'Retry-After': '30' },
      },
    ]);
    await openTransportSession(scenario.session, T0);

    const outcome = await scenario.client.invokeNetwork(descriptor(), T0);
    expect(outcome.transport).toBe('response');
    if (outcome.transport !== 'response') throw new Error('unreachable');

    expect(outcome.httpStatus).toBe(429);
    expect(readRetryAfter({ 'Retry-After': '30' })).toBe('30');

    const disposition = classifyOutcome(outcome, { nowMs: T0 });
    expect(disposition.kind).toBe('rate_limited');
    expect(disposition.retry).toBe('after_delay');
    expect(disposition.retryAfterMs).toBe(30_000);
  });

  it('发出前原生故障 ⇒ not_sent/before_send ⇒ 提升层判未到达平台', async () => {
    const scenario = createTransportScenario([
      { kind: 'fault', fault: 'network_error', phase: 'before_send' },
    ]);
    await openTransportSession(scenario.session, T0);

    const outcome = await scenario.client.invokeNetwork(descriptor(), T0);
    expect(outcome.transport).toBe('not_sent');
    if (outcome.transport !== 'not_sent') throw new Error('unreachable');
    expect(outcome.phase).toBe('before_send');

    const disposition = classifyOutcome(outcome, { nowMs: T0 });
    expect(disposition.mayHaveReachedPlatform).toBe(false);
    expect(disposition.retry).toBe('immediate');
  });

  it('原生离线 / 超时故障 ⇒ offline / timeout', async () => {
    const offline = createTransportScenario([{ kind: 'fault', fault: 'offline' }]);
    await openTransportSession(offline.session, T0);
    const offlineOutcome = await offline.client.invokeNetwork(descriptor(), T0);
    expect(offlineOutcome.transport).toBe('offline');
    expect(classifyOutcome(offlineOutcome, { nowMs: T0 }).kind).toBe('offline');

    const timeout = createTransportScenario([{ kind: 'fault', fault: 'timeout' }]);
    await openTransportSession(timeout.session, T0);
    const timeoutOutcome = await timeout.client.invokeNetwork(descriptor(), T0);
    expect(timeoutOutcome.transport).toBe('timeout');
    expect(classifyOutcome(timeoutOutcome, { nowMs: T0 }).mayHaveReachedPlatform).toBe(true);
  });

  it('projectNetworkOutcome(完整结果) 与结果的 network 字段一致', async () => {
    const scenario = createTransportScenario([
      { kind: 'respond', status: 200, body: { code: 'sold_out', data: {} } },
    ]);
    await openTransportSession(scenario.session, T0);

    const full = await scenario.client.invoke(descriptor(), T0);
    expect(projectNetworkOutcome(full)).toEqual(full.network);
  });
});
