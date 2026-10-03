/**
 * M-I08 边界三：**跨包接线不得放松 M08 的三条不变量**。
 *
 * 1. 回跳/回调**不是**付款证据；spread-copy 的交接 / 回调 / 读回一律被拒；
 * 2. 只有受控签发的可信读回（`paidState='paid'`）才能确认已付款；fixture 读回不得报 paid；
 * 3. **不收集任何支付凭据**：桥自己构造并下发的订单查询 / 支付读回请求，均不含
 *    cardNumber / cvv / otp / pin 等字段（用 M08 的凭据扫描器复核）。
 */

import { describe, expect, it } from 'vitest';

import {
  PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY,
  assertNoCredentialFields,
  containsCredentialField,
  createPaymentReadback,
  resumeOrderAfterPaymentReturn,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import type {
  PaymentQueryPort,
  PaymentQueryRequest,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import type { OrderQueryRequest } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import {
  codeOfError,
  makeCallback,
  makeHandoff,
  makeLifecycle,
  makeOrderPort,
  makeOrderResult,
  makePaymentTracker,
  makeReadback,
} from './support.js';

async function run(
  input: Partial<Parameters<typeof resumeOrderAfterPaymentReturn>[0]> = {},
): Promise<{ ok: boolean; code: string | null; value?: Awaited<ReturnType<typeof resumeOrderAfterPaymentReturn>> }> {
  try {
    const value = await resumeOrderAfterPaymentReturn({
      payment: makePaymentTracker(),
      handoff: makeHandoff(),
      callback: makeCallback(),
      orderLifecycle: makeLifecycle(),
      orderPort: makeOrderPort(),
      ...input,
    });
    return { ok: true, code: null, value };
  } catch (error) {
    return { ok: false, code: codeOfError(error) };
  }
}

describe('M-I08 跨包不变量', () => {
  it('spread-copy 的支付读回被拒：untrusted_payment_readback', async () => {
    const genuine = makeReadback();
    const forged = { ...genuine };
    const result = await run({
      paymentPort: { identity: 'forged', async query() { return forged; } },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('untrusted_payment_readback');
  });

  it('spread-copy 的支付交接被拒：untrusted_payment_handoff', async () => {
    const forgedHandoff = { ...makeHandoff() };
    const result = await run({ handoff: forgedHandoff });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('untrusted_payment_handoff');
  });

  it('spread-copy 的支付回跳被拒：untrusted_payment_callback', async () => {
    const forgedCallback = { ...makeCallback() };
    const result = await run({ handoff: undefined, callback: forgedCallback });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('untrusted_payment_callback');
  });

  it('fixture 读回不得报 paid：fixture_readback_cannot_confirm', () => {
    const genuine = makeReadback({ paidState: 'unpaid' });
    let code = 'no-error';
    try {
      createPaymentReadback({ ...genuine, verificationMode: 'fixture', paidState: 'paid' });
    } catch (error) {
      code = codeOfError(error);
    }
    expect(code).toBe('fixture_readback_cannot_confirm');
  });

  it('桥构造并下发的订单查询 / 支付读回请求不含任何支付凭据字段', async () => {
    let orderRequest: OrderQueryRequest | null = null;
    let paymentRequest: PaymentQueryRequest | null = null;

    const paymentPort: PaymentQueryPort = {
      identity: 'capture',
      async query(request: PaymentQueryRequest) {
        paymentRequest = request;
        return makeReadback({ paidState: 'unpaid' });
      },
    };

    const result = await run({
      orderPort: {
        async query(request: OrderQueryRequest) {
          orderRequest = request;
          return makeOrderResult();
        },
      },
      paymentPort,
    });

    expect(result.ok).toBe(true);
    expect(orderRequest).not.toBeNull();
    expect(paymentRequest).not.toBeNull();
    // 两个请求都是桥在真实调用链上下发的。
    expect(containsCredentialField(orderRequest)).toBe(false);
    expect(containsCredentialField(paymentRequest)).toBe(false);
    expect(() => assertNoCredentialFields(orderRequest)).not.toThrow();
    expect(() => assertNoCredentialFields(paymentRequest)).not.toThrow();
    // 结果树整体也不含凭据字段。
    expect(containsCredentialField(result.value)).toBe(false);
    expect(containsCredentialField(result.value?.paidStage)).toBe(false);
  });

  it('桥不放松凭据闸门：含 cardNumber 的载荷仍被拒', () => {
    let code = 'no-error';
    try {
      assertNoCredentialFields({ paymentIntentRef: 'pi-1', cardNumber: '0000' });
    } catch (error) {
      code = codeOfError(error);
    }
    expect(code).toBe('forbidden_payment_credential_input');
  });

  it('支付意图与订单意图不一致时拒绝桥接：invalid_payment_request', async () => {
    const result = await run({
      orderLifecycle: makeLifecycle({ amountMinor: 1 }),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_payment_request');
  });

  it('桥边界常量：不把回跳当已付款、paid 必须有读回、query-first 只查原单、零凭据零网络', () => {
    expect(PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY.assumesPaidFromReturn).toBe(false);
    expect(PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY.requiresTrustedReadbackForPaid).toBe(true);
    expect(PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY.queriesOriginalOrderOnly).toBe(true);
    expect(PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY.collectsPaymentCredentials).toBe(false);
    expect(PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY.hasRealNetworkCall).toBe(false);
  });
});
