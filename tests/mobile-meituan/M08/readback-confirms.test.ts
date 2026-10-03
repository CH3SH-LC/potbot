/**
 * M08 边界三：**只有平台读回才能确认已付款**。
 *
 * 反向对照（本文件的要害）：
 * - `verificationMode: 'fixture'` + `paid` 的读回**构造即抛**（假端口不得签发已付款）；
 * - 自造/拷贝的读回被拒（`untrusted_payment_readback`）；
 * - 端口返回 `null` ⇒ `missing_payment_readback`，**不得**当已付款；
 * - 读回任一项与本地意图不符 ⇒ `payment_intent_mismatch` 并**阻断**跟踪。
 */

import { describe, expect, it } from 'vitest';

import {
  PaymentError,
  PaymentTracker,
  createPaymentReadback,
  isTrustedPaymentReadback,
  paymentStateForReadback,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import { AMOUNT_MINOR, createClock, fixturePolicy, makeHandoff, makeIntent, makeReadback } from './support.js';

function tracker(overrides: Parameters<typeof makeIntent>[0] = {}): PaymentTracker {
  return new PaymentTracker({ intent: makeIntent(overrides), clock: createClock(), linkPolicy: fixturePolicy() });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PaymentError ? error.code : 'not-a-payment-error';
  }
}

describe('M08 可信读回才确认已付款', () => {
  it('fixture 模式读回不得回报 paid（构造即抛）', () => {
    expect(
      codeOf(() =>
        createPaymentReadback({
          paymentIntentRef: 'pi-1',
          externalId: 'MT-1',
          accountRef: 'acct:meituan:demo-0001',
          amountMinor: AMOUNT_MINOR,
          currency: 'CNY',
          providerPaymentRef: 'pp-1',
          paidState: 'paid',
          observedAt: 1,
          evidenceRef: 'ev-1',
          verificationMode: 'fixture',
        }),
      ),
    ).toBe('fixture_readback_cannot_confirm');
  });

  it('fixture 模式读回可以回报 unpaid / failed / unknown', () => {
    for (const paidState of ['unpaid', 'failed', 'unknown'] as const) {
      const rb = createPaymentReadback({
        paymentIntentRef: 'pi-1',
        externalId: 'MT-1',
        accountRef: 'acct:meituan:demo-0001',
        amountMinor: AMOUNT_MINOR,
        currency: 'CNY',
        providerPaymentRef: 'pp-1',
        paidState,
        observedAt: 1,
        evidenceRef: 'ev-1',
        verificationMode: 'fixture',
      });
      expect(isTrustedPaymentReadback(rb)).toBe(true);
    }
  });

  it('读回状态 → 追踪状态：paid 是唯一通向 confirmed_paid 的输入', () => {
    expect(paymentStateForReadback('paid')).toBe('confirmed_paid');
    expect(paymentStateForReadback('unpaid')).toBe('awaiting_user');
    expect(paymentStateForReadback('failed')).toBe('failed');
    expect(paymentStateForReadback('unknown')).toBe('unknown');
  });

  it('自造（拷贝）读回被拒：untrusted_payment_readback', async () => {
    const t = tracker();
    const genuine = makeReadback();
    const forged = { ...genuine };
    const code = await t
      .refresh({ identity: 'fixture', query: async () => forged as unknown as typeof genuine })
      .then(() => null)
      .catch((error: unknown) => (error instanceof PaymentError ? error.code : 'not-a-payment-error'));
    expect(code).toBe('untrusted_payment_readback');
  });

  it('端口返回 null ⇒ missing_payment_readback，不推断已付款', async () => {
    const t = tracker();
    const code = await t
      .refresh({ identity: 'fixture', query: async () => null })
      .then(() => null)
      .catch((error: unknown) => (error instanceof PaymentError ? error.code : 'not-a-payment-error'));
    expect(code).toBe('missing_payment_readback');
    expect(t.state).toBe('not_started');
  });

  it('没有 externalId 的意图不得读回（不猜单）', async () => {
    const t = tracker({ externalId: null });
    const code = await t
      .refresh({ identity: 'fixture', query: async () => makeReadback() })
      .then(() => null)
      .catch((error: unknown) => (error instanceof PaymentError ? error.code : 'not-a-payment-error'));
    expect(code).toBe('invalid_payment_request');
  });

  it('缺端口 ⇒ missing_payment_query_port', async () => {
    const t = tracker();
    const code = await t
      .refresh(undefined as unknown as { identity: string; query: () => never })
      .then(() => null)
      .catch((error: unknown) => (error instanceof PaymentError ? error.code : 'not-a-payment-error'));
    expect(code).toBe('missing_payment_query_port');
  });

  it('金额不符 ⇒ payment_intent_mismatch 并阻断；acknowledge 后恢复', async () => {
    const t = tracker();
    const bad = makeReadback({ amountMinor: AMOUNT_MINOR + 1 });
    await expect(t.refresh({ identity: 'fixture', query: async () => bad })).rejects.toMatchObject({
      code: 'payment_intent_mismatch',
    });
    expect(t.trackable).toBe(false);
    expect(t.blockedReason).toContain('amount');
    // 阻断期间任何推进都被拒
    await expect(t.refresh({ identity: 'fixture', query: async () => makeReadback() })).rejects.toMatchObject({
      code: 'payment_tracking_blocked',
    });
    expect(codeOf(() => t.cancel())).toBe('payment_tracking_blocked');
    t.acknowledge();
    expect(t.trackable).toBe(true);
  });

  it('externalId 不符同样阻断', async () => {
    const t = tracker();
    const bad = makeReadback({ externalId: 'MT-OTHER' });
    await expect(t.refresh({ identity: 'fixture', query: async () => bad })).rejects.toMatchObject({
      code: 'payment_intent_mismatch',
    });
    expect(t.blockedReason).toContain('external_id');
  });

  it('币种不符同样阻断', async () => {
    const t = tracker();
    const bad = makeReadback({ currency: 'USD' });
    await expect(t.refresh({ identity: 'fixture', query: async () => bad })).rejects.toMatchObject({
      code: 'payment_intent_mismatch',
    });
    expect(t.blockedReason).toContain('currency');
  });

  it('未 begin 也能靠读回确认（恢复语义），且经同一匹配闸门', async () => {
    const t = tracker();
    t.begin(makeHandoff());
    const view = await t.refresh({ identity: 'fixture', query: async () => makeReadback() });
    expect(view.state).toBe('confirmed_paid');
    expect(t.requirePaidView().state).toBe('confirmed_paid');
  });
});
