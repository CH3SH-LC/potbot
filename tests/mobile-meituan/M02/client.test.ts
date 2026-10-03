/**
 * M02 ⑤：端到端调用链（假端口驱动）。
 *
 * 覆盖：成功 / 业务失败 / 未登记码 / 协议错误 / HTTP 错误 / 网络故障 / 401 刷新重试 /
 * 会话撤销 / 非法 keyRef / 凭证解析失败。每一类都验证判别联合的落点，尤其确认
 * **任何协议或传输失败都不会变成 `businessSuccess:true`**。
 */

import { describe, expect, it } from 'vitest';

import {
  assertEvidenceClean,
  SessionUnavailableError,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type { TransportOutcome } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  OFFICIAL_HOST,
  TEST_ACCOUNT_REF,
  TEST_KEY_REF,
  T0,
  buildClient,
  createFakeTransport,
  emptyResponse,
  jsonResponse,
  networkFault,
  standardMintSteps,
  textResponse,
  timeoutFault,
} from './support.js';

const CREDENTIAL = Object.freeze({ keyRef: TEST_KEY_REF, material: 'test-material' });

function descriptor(overrides: Record<string, unknown> = {}) {
  return { keyRef: TEST_KEY_REF, method: 'POST' as const, host: OFFICIAL_HOST, path: '/v1/x', body: {}, ...overrides };
}

/** 会话拒绝必须不能变成成功。 */
function expectNotSuccess(outcome: TransportOutcome): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.delivered).toBe(false);
  }
}

describe('M02 成功与业务失败', () => {
  it('2xx + 登记成功码 ⇒ delivered 且 businessSuccess:true', async () => {
    const transport = createFakeTransport([jsonResponse(200, { code: 'ok', data: { id: 'x' } })]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.delivered).toBe(true);
      expect(outcome.businessKind).toBe('success');
      expect(outcome.businessSuccess).toBe(true);
      expect(outcome.businessCode).toBe('ok');
      expect(assertEvidenceClean(outcome.evidence)).toBeUndefined();
    }
  });

  it('2xx + 登记业务失败码 ⇒ delivered 但 businessSuccess:false', async () => {
    const transport = createFakeTransport([jsonResponse(200, { code: 'sold_out', message: '售罄' })]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.businessKind).toBe('business_failure');
      expect(outcome.businessSuccess).toBe(false);
    }
  });

  it('2xx + 未登记业务码 ⇒ delivered 但 businessKind unknown、businessSuccess:false', async () => {
    const transport = createFakeTransport([jsonResponse(200, { code: 'totally_new_code' })]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.businessKind).toBe('unknown');
      expect(outcome.businessSuccess).toBe(false);
    }
  });
});

describe('M02 协议错误绝不变成业务成功', () => {
  const cases: readonly { readonly name: string; readonly step: ReturnType<typeof emptyResponse>; readonly kind: string }[] = [
    { name: '空 body', step: emptyResponse(200), kind: 'empty_body' },
    { name: '非 JSON', step: textResponse(200, '<html>oops</html>'), kind: 'malformed_json' },
    { name: '缺 code', step: textResponse(200, '{"message":"x"}'), kind: 'invalid_envelope' },
  ];

  for (const c of cases) {
    it(`2xx + ${c.name} ⇒ protocol_error（delivered:false）`, async () => {
      const transport = createFakeTransport([c.step]);
      const { client, session } = buildClient({ transport });
      await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

      const outcome = await client.invoke(descriptor(), T0);
      expectNotSuccess(outcome);
      if (!outcome.ok) {
        expect(outcome.failureKind).toBe('protocol_error');
        expect(outcome.protocolErrorKind).toBe(c.kind);
      }
    });
  }
});

describe('M02 HTTP / 传输故障', () => {
  it('500 + 合法成功信封 ⇒ 仍是 http_error，绝不是成功', async () => {
    const transport = createFakeTransport([textResponse(500, '{"code":"ok"}')]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('http_error');
      expect(outcome.status).toBe(500);
    }
  });

  it('404 ⇒ http_error', async () => {
    const transport = createFakeTransport([textResponse(404, 'not found')]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });
    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('http_error');
    }
  });

  it('403 ⇒ auth_failed', async () => {
    const transport = createFakeTransport([textResponse(403, 'forbidden')]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });
    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('auth_failed');
    }
  });

  it('网络故障 ⇒ network_error；超时 ⇒ timeout（结果未知，绝不成功）', async () => {
    for (const [step, kind] of [
      [networkFault(), 'network_error'],
      [timeoutFault(), 'timeout'],
    ] as const) {
      const transport = createFakeTransport([step]);
      const { client, session } = buildClient({ transport });
      await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });
      const outcome = await client.invoke(descriptor(), T0);
      expectNotSuccess(outcome);
      if (!outcome.ok) {
        expect(outcome.failureKind).toBe(kind);
        expect(outcome.status).toBeNull();
      }
    }
  });
});

describe('M02 401 刷新重试', () => {
  it('401 ⇒ 刷新一次 ⇒ 200 成功（令牌轮换，调用两次）', async () => {
    const transport = createFakeTransport([textResponse(401, ''), jsonResponse(200, { code: 'ok' })]);
    const { client, session, resolver } = buildClient({ transport, mintSteps: standardMintSteps() });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.businessSuccess).toBe(true);
    }
    expect(transport.callCount()).toBe(2);
    expect(session.snapshot().refreshCount).toBe(1);
    // 凭证每次 invoke 只解析一次（刷新复用同一份已解析凭证，不重复向 K03 要）
    expect(resolver.resolveCount()).toBe(1);
    // 第二次调用用的是轮换后的新令牌
    expect(session.snapshot().tokenRef).toBe('sessref:s2-t2');
  });

  it('401 ⇒ 刷新 ⇒ 仍 401 ⇒ auth_failed（不无限重试）', async () => {
    const transport = createFakeTransport([textResponse(401, ''), textResponse(401, '')]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('auth_failed');
    }
    expect(transport.callCount()).toBe(2);
  });

  it('关闭 refreshOnAuthFailure ⇒ 401 直接 auth_failed，只调用一次', async () => {
    const transport = createFakeTransport([textResponse(401, '')]);
    const { client, session } = buildClient({ transport, refreshOnAuthFailure: false });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('auth_failed');
    }
    expect(transport.callCount()).toBe(1);
  });

  it('401 后刷新失败 ⇒ auth_failed（不视为成功）', async () => {
    const transport = createFakeTransport([textResponse(401, '')]);
    const { client, session } = buildClient({
      transport,
      mintSteps: [
        { kind: 'mint', scopes: ['meituan.query'], ttlMs: 60_000, refreshable: true },
        { kind: 'fail', reason: 'refresh boom' },
      ],
    });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });

    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('auth_failed');
    }
  });
});

describe('M02 前置失败：会话 / keyRef / 凭证', () => {
  it('会话已撤销 ⇒ session_unavailable，零网络调用', async () => {
    const transport = createFakeTransport([]);
    const { client, session } = buildClient({ transport });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });
    session.revoke(T0 + 1);

    const outcome = await client.invoke(descriptor(), T0 + 2);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('session_unavailable');
      expect(outcome.reason).toContain('revoked');
    }
    expect(transport.callCount()).toBe(0);
  });

  it('会话未建立 ⇒ session_unavailable', async () => {
    const transport = createFakeTransport([]);
    const { client } = buildClient({ transport });
    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('session_unavailable');
    }
    expect(transport.callCount()).toBe(0);
  });

  it('非法 keyRef（疑似明文）⇒ credential_missing，占位符，零网络调用、零凭证解析', async () => {
    const transport = createFakeTransport([]);
    const { client, resolver } = buildClient({ transport });
    const outcome = await client.invoke(descriptor({ keyRef: 'sk-0123456789abcdef' }), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('credential_missing');
      expect(outcome.keyRef).toBe('«invalid-key-ref»');
      expect(JSON.stringify(outcome)).not.toContain('sk-0123456789abcdef');
    }
    expect(transport.callCount()).toBe(0);
    expect(resolver.resolveCount()).toBe(0);
  });

  it('凭证解析失败 ⇒ credential_missing，零网络调用', async () => {
    const transport = createFakeTransport([]);
    const { client, session } = buildClient({ transport, resolverFail: true });
    await session.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });
    const outcome = await client.invoke(descriptor(), T0);
    expectNotSuccess(outcome);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe('credential_missing');
    }
    expect(transport.callCount()).toBe(0);
  });
});

describe('M02 SessionUnavailableError 可被收窄', () => {
  it('ensureActive 抛出的错误可 instanceof（同步抛）', () => {
    const { client, session } = buildClient({ transport: createFakeTransport([]) });
    void client;
    expect(() => session.ensureActive(T0)).toThrow(SessionUnavailableError);
  });
});
