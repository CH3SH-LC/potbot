/**
 * M07 提交请求构造与一次性授权引用。
 *
 * 判据全部落在**真实语义**上：参数摘要用 M04 算出来的指纹、幂等键必须可复现、
 * 授权引用必须来自可信签发器。负例断言的是**具体拒因码**，不是"抛了个错"。
 */

import { describe, expect, it } from 'vitest';

import {
  buildOrderSubmitRequest,
  computeIdempotencyKey,
  createAuthorizationRef,
  isTrustedAuthorizationRef,
  OrderSubmitError,
  type OrderBinding,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import { AUTH_TTL_MS, DEFAULT_PARAMS_DIGEST, T0, baseBinding, createScenario } from './support.js';

const TTL_END = T0 + AUTH_TTL_MS;

function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`期望被拒（${code}），但调用成功了`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(OrderSubmitError);
      expect((error as OrderSubmitError).code).toBe(code);
    },
  );
}

describe('M07 提交请求构造', () => {
  it('请求必须同时携带幂等键、K07 语义的一次性授权引用与参数摘要', () => {
    const scenario = createScenario();
    const request = buildOrderSubmitRequest(scenario.ref, scenario.clock.now());

    expect(request.idempotencyKey).toBe(scenario.key);
    expect(request.authorizationRef).toBe(scenario.ref);
    expect(request.paramsDigest).toBe(DEFAULT_PARAMS_DIGEST);
    expect(request.grantId).toBe('grant-action-1');
    expect(request.scope).toBe('submit-order');
    expect(request.attempt).toBe(1);
    expect(Object.isFrozen(request)).toBe(true);
  });

  it('执行器真实收到的请求里带有授权引用与参数摘要（不是本地自说自话）', async () => {
    const scenario = createScenario();
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });

    const sent = scenario.executor?.calls[0];
    expect(sent).toBeDefined();
    expect(sent?.authorizationRef?.grantId).toBe('grant-action-1');
    expect(sent?.paramsDigest).toBe(DEFAULT_PARAMS_DIGEST);
    expect(sent?.idempotencyKey).toBe(scenario.key);
  });

  it('幂等键由绑定确定性导出：同绑定同键，绑定变则键变', () => {
    const base = baseBinding();
    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey({ ...base }));

    const changedAmount: OrderBinding = baseBinding({ amount: 8400 });
    expect(computeIdempotencyKey(changedAmount)).not.toBe(computeIdempotencyKey(base));

    const changedQuote = baseBinding({ quoteRef: 'quote-2' });
    expect(computeIdempotencyKey(changedQuote)).not.toBe(computeIdempotencyKey(base));
  });

  it('幂等键不含 issuedAt 等时间字段：两份同一绑定的授权得到同一个键', () => {
    const first = createScenario();
    const second = createScenario({ clock: new FixtureClock(T0 + 12_345) });
    expect(second.key).toBe(first.key);
    expect(second.ref.issuedAt).not.toBe(first.ref.issuedAt);
  });
});

describe('M07 没有可信授权引用时必须拒绝提交', () => {
  it('缺省授权引用 ⇒ missing_authorization_ref', async () => {
    const scenario = createScenario();
    await expectRejectCode(
      scenario.submitter.submit({ authorization: undefined as never, idempotencyKey: scenario.key }),
      'missing_authorization_ref',
    );
    expect(scenario.executor?.calls).toHaveLength(0);
  });

  it('形状相同的**拷贝**不是可信引用 ⇒ untrusted_authorization_ref', async () => {
    const scenario = createScenario();
    const copy = { ...scenario.ref };
    expect(isTrustedAuthorizationRef(copy)).toBe(false);
    await expectRejectCode(
      scenario.submitter.submit({ authorization: copy, idempotencyKey: scenario.key }),
      'untrusted_authorization_ref',
    );
    expect(scenario.executor?.calls).toHaveLength(0);
  });

  it('调用方自造的对象 ⇒ untrusted_authorization_ref', async () => {
    const scenario = createScenario();
    const forgedBinding = baseBinding({ actionId: 'forged', amount: 1 });
    await expectRejectCode(
      scenario.submitter.submit({
        authorization: forgedBinding as unknown as never,
        idempotencyKey: computeIdempotencyKey(forgedBinding),
      }),
      'untrusted_authorization_ref',
    );
    expect(scenario.executor?.calls).toHaveLength(0);
  });

  it('过期的可信授权 ⇒ authorization_expired（到点即失效）', async () => {
    const scenario = createScenario({ expiresAt: TTL_END });
    scenario.clock.advanceTo(TTL_END);
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'authorization_expired',
    );
    expect(scenario.executor?.calls).toHaveLength(0);
  });

  it('已占用的可信授权 ⇒ authorization_already_consumed', async () => {
    const scenario = createScenario();
    const consumedRef = createAuthorizationRef({
      grantId: 'grant-action-1',
      grantedBy: 'native-confirm-surface',
      issuedAt: T0,
      expiresAt: TTL_END,
      binding: baseBinding(),
      consumed: true,
      consumedAt: T0 + 1,
      consumedByKey: 'idem-v1-otherkey',
    });
    expect(isTrustedAuthorizationRef(consumedRef)).toBe(true);
    await expectRejectCode(
      scenario.submitter.submit({ authorization: consumedRef, idempotencyKey: scenario.key }),
      'authorization_already_consumed',
    );
    expect(scenario.executor?.calls).toHaveLength(0);
  });

  it('幂等键与授权绑定不符 ⇒ idempotency_key_mismatch', async () => {
    const scenario = createScenario();
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: 'idem-v1-deadbeef' }),
      'idempotency_key_mismatch',
    );
    expect(scenario.executor?.calls).toHaveLength(0);
  });

  it('scope 不是 submit-order ⇒ 造引用时即拒（payment 不得在本模块执行）', () => {
    expect(() =>
      createAuthorizationRef({
        grantId: 'g',
        grantedBy: 's',
        issuedAt: T0,
        expiresAt: TTL_END,
        binding: baseBinding({ scope: 'payment' as never }),
      }),
    ).toThrowError(OrderSubmitError);
  });
});
