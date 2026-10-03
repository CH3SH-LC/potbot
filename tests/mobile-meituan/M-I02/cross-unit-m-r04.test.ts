/**
 * M-I02 ④：**跨单元**——把本包产出的 `NetworkOutcome` 真的喂给 M-R04 的
 * `classifyOutcome`，证明"结构对齐 M-R04"不是注释里的声明，而是可执行的事实。
 *
 * 唯一被点名的诉求（M-R04 integration request #3）：
 * > 没有阶段时，一次 DNS / 连接建立失败会被保守当作 during_send（mayHaveReached=true），
 * > 从而即便一个字节都没发出去也要被迫"先查原单"。
 *
 * 因此关键断言是：**发出前失败 ⇒ `mayHaveReachedPlatform === false` 且可立即重试**；
 * 而超时 / 在途失败仍为 `true`（不得放松）。429 的 `Retry-After` 原文被 M-R04 解析成毫秒。
 *
 * 这里**只读 import** M-R04 的公开出口（不修改它），既有的 M-R04 测试不因此改变。
 */

import { describe, expect, it } from 'vitest';

import type { NetworkOutcome } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import { classifyOutcome, parseRetryAfter } from '../M-R04/index.js';

import {
  T0,
  UNAUTHORIZED_HOST,
  buildClient,
  createCapturingTransport,
  descriptor,
  jsonStep,
  openSession,
  textStep,
} from './support.js';

const CTX = { nowMs: T0 } as const;

describe('M-I02 → M-R04：阶段正确性（M-R04 request #3）', () => {
  it('发出前失败（before_send）⇒ not_sent，M-R04 判 mayHaveReachedPlatform=false 且可立即重试', async () => {
    const transport = createCapturingTransport([{ kind: 'fault', fault: 'network_error', phase: 'before_send' }]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    const disposition = classifyOutcome(outcome.network, CTX);
    expect(outcome.network.transport).toBe('not_sent');
    expect(disposition.mayHaveReachedPlatform).toBe(false);
    expect(disposition.retry).toBe('immediate');
  });

  it('在途失败（during_send）⇒ network_error，M-R04 仍判 mayHaveReachedPlatform=true（不放松）', async () => {
    const transport = createCapturingTransport([{ kind: 'fault', fault: 'network_error', phase: 'during_send' }]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    const disposition = classifyOutcome(outcome.network, CTX);
    expect(outcome.network.transport).toBe('network_error');
    expect(disposition.mayHaveReachedPlatform).toBe(true);
    expect(disposition.retry).toBe('after_delay');
  });

  it('离线 / 超时 ⇒ M-R04 分别判 offline（未到达）与 timeout（可能已到达）', async () => {
    for (const [plan, expectedTransport, reached] of [
      [{ kind: 'fault', fault: 'offline' } as const, 'offline', false],
      [{ kind: 'fault', fault: 'timeout' } as const, 'timeout', true],
    ] as const) {
      const transport = createCapturingTransport([plan]);
      const { client, session } = buildClient({ transport });
      await openSession(session);
      const outcome = await client.invoke(descriptor(), T0);
      expect(outcome.network.transport).toBe(expectedTransport);
      const disposition = classifyOutcome(outcome.network, CTX);
      expect(disposition.mayHaveReachedPlatform).toBe(reached);
    }
  });

  it('策略拒绝（非授权 host）⇒ not_sent，M-R04 判未到达', async () => {
    const transport = createCapturingTransport([]);
    const { client } = buildClient({ transport });
    const outcome = await client.invoke(descriptor({ host: UNAUTHORIZED_HOST }), T0);
    expect(outcome.network.transport).toBe('not_sent');
    const disposition = classifyOutcome(outcome.network, CTX);
    expect(disposition.mayHaveReachedPlatform).toBe(false);
    expect(disposition.retry).toBe('immediate');
  });
});

describe('M-I02 → M-R04：响应码与 Retry-After', () => {
  it('429 + Retry-After 原文 "3" ⇒ M-R04 解析为 3000ms 且判 rate_limited（非拒单）', async () => {
    const transport = createCapturingTransport([textStep(429, '{"code":"rate"}', { 'retry-after': '3' })]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.network.transport).toBe('response');
    if (outcome.network.transport === 'response') {
      expect(outcome.network.retryAfterHeader).toBe('3');
    }
    const disposition = classifyOutcome(outcome.network, CTX);
    expect(disposition.kind).toBe('rate_limited');
    expect(disposition.retryAfterMs).toBe(3000);
  });

  it('2xx + 业务码 ok ⇒ M-R04 判 success；500 ⇒ server_error', async () => {
    const transport = createCapturingTransport([
      jsonStep(200, { code: 'ok' }),
      textStep(500, '{"code":"boom"}'),
    ]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const first = await client.invoke(descriptor(), T0);
    expect(classifyOutcome(first.network, CTX).kind).toBe('success');

    const second = await client.invoke(descriptor(), T0);
    expect(classifyOutcome(second.network, CTX).kind).toBe('server_error');
  });

  it('parseRetryAfter 对本包透传的原文可解析（秒 / HTTP-date / 空）', () => {
    expect(parseRetryAfter('3', T0)).toBe(3000);
    expect(parseRetryAfter(null, T0)).toBeNull();
    expect(parseRetryAfter('', T0)).toBeNull();
    const httpDate = new Date(T0 + 5000).toUTCString();
    expect(parseRetryAfter(httpDate, T0)).toBeGreaterThan(0);
  });

  it('契约一致：本包 NetworkOutcome 可直接赋给 M-R04 的 NetworkOutcome', () => {
    const sample: NetworkOutcome = Object.freeze({ transport: 'not_sent', phase: 'before_send', detail: 'x' });
    const disposition = classifyOutcome(sample, CTX);
    expect(disposition.mayHaveReachedPlatform).toBe(false);
  });
});
