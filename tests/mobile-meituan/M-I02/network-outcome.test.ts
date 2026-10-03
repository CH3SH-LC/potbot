/**
 * M-I02 ①：`TransportOutcome.network`（M-R04 消费的 `NetworkOutcome`）。
 *
 * 直觉陷阱：把一次 DNS / 连接建立失败当成"发出后未知"。那样 M-R04 只能保守地
 * 走"先查原单"，即便一个字节都没发出去。本文件把阶段判断钉死：
 *
 * - `network_error` + `before_send` ⇒ **`not_sent`**（可判定未到达平台）；
 * - `network_error` + `during_send` ⇒ `network_error`（可能已到达）；
 * - `timeout` ⇒ `timeout`（可能已到达）；`offline` ⇒ `offline`（从未发出）；
 * - 收到响应 ⇒ `response`，并**原样**带上 `Retry-After`。
 */

import { describe, expect, it } from 'vitest';

import { projectNetworkOutcome, readRetryAfter } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  OFFICIAL_HOST,
  SUFFIX_ATTACK_HOST,
  T0,
  UNAUTHORIZED_HOST,
  buildClient,
  createCapturingTransport,
  descriptor,
  jsonStep,
  openSession,
  textStep,
} from './support.js';

describe('M-I02 NetworkOutcome —— 故障阶段', () => {
  it('before_send 网络错误 ⇒ not_sent（definitely-not-sent，不是 mayHaveReached）', async () => {
    const transport = createCapturingTransport([{ kind: 'fault', fault: 'network_error', phase: 'before_send' }]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.failureKind).toBe('not_sent');
    expect(outcome.network.transport).toBe('not_sent');
    if (outcome.network.transport === 'not_sent') {
      expect(outcome.network.phase).toBe('before_send');
    }
    expect(outcome.status).toBeNull();
  });

  it('during_send 网络错误 ⇒ network_error（可能已到达）', async () => {
    const transport = createCapturingTransport([{ kind: 'fault', fault: 'network_error', phase: 'during_send' }]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.failureKind).toBe('network_error');
    expect(outcome.network.transport).toBe('network_error');
    if (outcome.network.transport === 'network_error') {
      expect(outcome.network.phase).toBe('during_send');
    }
  });

  it('超时 ⇒ timeout；离线 ⇒ offline', async () => {
    for (const [plan, expected] of [
      [{ kind: 'fault', fault: 'timeout' } as const, 'timeout'],
      [{ kind: 'fault', fault: 'offline' } as const, 'offline'],
    ] as const) {
      const transport = createCapturingTransport([plan]);
      const { client, session } = buildClient({ transport });
      await openSession(session);
      const outcome = await client.invoke(descriptor(), T0);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.network.transport).toBe(expected);
      }
    }
  });

  it('同类故障仅 phase 不同 ⇒ 结论必须不同（before_send≠during_send）', async () => {
    const before = createCapturingTransport([{ kind: 'fault', fault: 'network_error', phase: 'before_send' }]);
    const during = createCapturingTransport([{ kind: 'fault', fault: 'network_error', phase: 'during_send' }]);
    const a = buildClient({ transport: before });
    const b = buildClient({ transport: during });
    await openSession(a.session);
    await openSession(b.session);
    const oa = await a.client.invoke(descriptor(), T0);
    const ob = await b.client.invoke(descriptor(), T0);
    expect(oa.network.transport).toBe('not_sent');
    expect(ob.network.transport).toBe('network_error');
  });
});

describe('M-I02 NetworkOutcome —— 响应与 Retry-After 原文透传', () => {
  it('2xx + 合法信封 ⇒ response，带 httpStatus 与业务码', async () => {
    const transport = createCapturingTransport([jsonStep(200, { code: 'ok', data: { id: 'x' } })]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(true);
    expect(outcome.network.transport).toBe('response');
    if (outcome.network.transport === 'response') {
      expect(outcome.network.httpStatus).toBe(200);
      expect(outcome.network.businessCode).toBe('ok');
      expect(outcome.network.retryAfterHeader).toBeNull();
    }
  });

  it('429 + Retry-After: 3 ⇒ response 原文 "3"（不解析、不折算）', async () => {
    const transport = createCapturingTransport([textStep(429, '{"code":"rate"}', { 'retry-after': '3' })]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(false);
    expect(outcome.network.transport).toBe('response');
    if (outcome.network.transport === 'response') {
      expect(outcome.network.httpStatus).toBe(429);
      expect(outcome.network.retryAfterHeader).toBe('3');
    }
  });

  it('HTTP-date 形式的 Retry-After 原样保留；头名大小写不敏感', async () => {
    const transport = createCapturingTransport([
      textStep(503, '{}', { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
    ]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.network.transport).toBe('response');
    if (outcome.network.transport === 'response') {
      expect(outcome.network.httpStatus).toBe(503);
      expect(outcome.network.retryAfterHeader).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    }
  });

  it('无 Retry-After 时为 null', () => {
    expect(readRetryAfter({ 'content-type': 'application/json' })).toBeNull();
    expect(readRetryAfter(undefined)).toBeNull();
    expect(readRetryAfter(null)).toBeNull();
    expect(readRetryAfter({ 'X-Retry-After': '5' })).toBeNull();
  });

  it('response 变体的键集与 M-R04 契约一致', () => {
    const transport = createCapturingTransport([jsonStep(200, { code: 'ok' })]);
    const built = buildClient({ transport });
    return openSession(built.session).then(async () => {
      const outcome = await built.client.invoke(descriptor(), T0);
      expect(outcome.network.transport).toBe('response');
      expect(Object.keys(outcome.network).sort()).toEqual(
        ['businessCode', 'httpStatus', 'providerOrderRef', 'retryAfterHeader', 'transport'].sort(),
      );
    });
  });
});

describe('M-I02 NetworkOutcome —— 发出前失败一律 not_sent', () => {
  it('非授权 host ⇒ endpoint_not_allowed，network=not_sent/before_send，零端口调用', async () => {
    const transport = createCapturingTransport([]);
    const { client, resolver } = buildClient({ transport });
    const outcome = await client.invoke(descriptor({ host: UNAUTHORIZED_HOST }), T0);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('endpoint_not_allowed');
      expect(outcome.network.transport).toBe('not_sent');
      if (outcome.network.transport === 'not_sent') {
        expect(outcome.network.phase).toBe('before_send');
      }
    }
    expect(transport.callCount()).toBe(0);
    expect(resolver.resolveCount()).toBe(0);
  });

  it('未建立会话 ⇒ session_unavailable，network=not_sent/before_send', async () => {
    const transport = createCapturingTransport([]);
    const { client } = buildClient({ transport });
    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('session_unavailable');
      expect(outcome.network.transport).toBe('not_sent');
    }
    expect(transport.callCount()).toBe(0);
  });

  it('projectNetworkOutcome / invokeNetwork 与 outcome.network 一致', async () => {
    const transport = createCapturingTransport([
      jsonStep(200, { code: 'ok' }),
      jsonStep(200, { code: 'ok' }),
    ]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(projectNetworkOutcome(outcome)).toEqual(outcome.network);

    const second = await client.invokeNetwork(descriptor(), T0);
    expect(second).toEqual(outcome.network);
    expect(transport.callCount()).toBe(2);
    expect(OFFICIAL_HOST.length).toBeGreaterThan(0);
    expect(SUFFIX_ATTACK_HOST.startsWith('evil.')).toBe(true);
  });
});
