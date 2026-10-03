/**
 * M-I08 测试夹具（不是被收集的用例文件）。
 *
 * 全部场景由**显式 fixture** 驱动：合成可信域名（`.test`，非官方）、脚本化支付读回、
 * M09 确定性订单查询端口、确定性时钟。这里没有真实美团接口、没有网络、没有系统时间，
 * 也**没有任何真实银行卡 / 验证码 / PIN**（凭据用例只用明显伪造的占位键名）。
 */

import {
  PaymentTracker,
  createFixtureLinkPolicy,
  createPaymentCallback,
  createPaymentHandoff,
  createPaymentReadback,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import type {
  PaymentCallback,
  PaymentClock,
  PaymentHandoff,
  PaymentIntent,
  PaymentReadback,
  TrustedLinkPolicy,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import {
  OrderLifecycleTracker,
  createFixtureOrderQueryPort,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import type {
  OrderIntent,
  OrderQueryResult,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';

/** 逻辑时刻基准（非零，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 交接期限（T0 + 15 分钟）。 */
export const EXPIRES_AT = T0 + 15 * 60 * 1000;

/** 原单 externalId（本地已核验的那一单）。 */
export const EXTERNAL_ID = 'MT-DEMO-20261003-0001';

/** 付款账号引用（脱敏引用，不是凭据、不是卡号）。 */
export const ACCOUNT_REF = 'acct:meituan:demo-0001';

/** 本地金额（整数最小单位：分）。 */
export const AMOUNT_MINOR = 4760;

/** 币种。 */
export const CURRENCY = 'CNY';

/** 支付提供方标识（非凭据）。 */
export const PROVIDER = 'meituan_cashier';

/** 合成可信域名（RFC 2606 `.test`，**不是**官方域名）。 */
export const HANDOFF_URL = `https://${'pay.meituan.test'}/cashier?pi=pi-demo-1`;
export const RETURN_URL = `https://${'pay.meituan.test'}/return?pi=pi-demo-1&result=success`;

/** fixture 专用可信域名策略。 */
export function fixturePolicy(): TrustedLinkPolicy {
  return createFixtureLinkPolicy();
}

/** 确定性时钟：可读可写。 */
export interface FakeClock extends PaymentClock {
  now(): number;
  set(t: number): void;
}

/** 造一个从 T0 开始的确定性时钟。 */
export function createClock(start = T0): FakeClock {
  let current = start;
  return {
    now: () => current,
    set: (t: number): void => {
      current = t;
    },
  };
}

/** 造一个本地支付意图（默认与读回/订单逐项相符）。 */
export function makePaymentIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return Object.freeze({
    paymentIntentRef: 'pi-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    provider: PROVIDER,
    ...overrides,
  });
}

/** 造一个本地下单意图（与支付意图共享 externalId / 账号 / 金额 / 币种）。 */
export function makeOrderIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return Object.freeze({
    orderIntentRef: 'oi-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    ...overrides,
  });
}

/** 造一个 M08 支付跟踪器。 */
export function makePaymentTracker(overrides: Partial<PaymentIntent> = {}): PaymentTracker {
  return new PaymentTracker({
    intent: makePaymentIntent(overrides),
    clock: createClock(),
    linkPolicy: fixturePolicy(),
  });
}

/** 造一个 M09 订单生命周期跟踪器（只读使用）。 */
export function makeLifecycle(overrides: Partial<OrderIntent> = {}): OrderLifecycleTracker {
  return new OrderLifecycleTracker({ intent: makeOrderIntent(overrides) });
}

/** 造一张**可信**官方支付交接（受控签发、过 fixture 域名单）。 */
export function makeHandoff(overrides: Partial<Parameters<typeof createPaymentHandoff>[0]> = {}): PaymentHandoff {
  return createPaymentHandoff({
    handoffRef: 'ho-1',
    paymentIntentRef: 'pi-1',
    mode: 'official_page',
    url: HANDOFF_URL,
    issuedAt: T0,
    expiresAt: EXPIRES_AT,
    instructionForUser: '请在官方支付页完成支付',
    linkPolicy: fixturePolicy(),
    ...overrides,
  });
}

/** 造一份**可信来源**的支付回跳（默认 rawOutcome='success'）。 */
export function makeCallback(overrides: Partial<Parameters<typeof createPaymentCallback>[0]> = {}): PaymentCallback {
  return createPaymentCallback({
    callbackRef: 'cb-1',
    paymentIntentRef: 'pi-1',
    returnUrl: RETURN_URL,
    receivedAt: T0 + 60_000,
    rawOutcome: 'success',
    linkPolicy: fixturePolicy(),
    ...overrides,
  });
}

/** 造一张**受控签发**的支付读回（默认 `real` + `paid`）。 */
export function makeReadback(overrides: Partial<Parameters<typeof createPaymentReadback>[0]> = {}): PaymentReadback {
  return createPaymentReadback({
    paymentIntentRef: 'pi-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    providerPaymentRef: 'pp-demo-1',
    paidState: 'paid',
    observedAt: T0 + 120_000,
    evidenceRef: 'ev-ref-pay-1',
    verificationMode: 'real',
    detail: 'fixture 读回',
    ...overrides,
  });
}

/**
 * 造一份 M09 订单查询结果。
 *
 * 默认 `W_PAID_WAIT_ACCEPT`（fixture 本地词汇，**不是**已核验的美团真实状态码），
 * 即「订单侧报告已支付」——正因为订单侧也说已支付，才更能证明「本桥的 paid 阶段
 * 不会因订单状态而绕过支付读回」。
 */
export function makeOrderResult(overrides: Partial<OrderQueryResult> = {}): OrderQueryResult {
  return Object.freeze({
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    rawStatusCode: 'W_PAID_WAIT_ACCEPT',
    refundStatusCode: null,
    refundAmountMinor: null,
    observedAt: T0 + 90_000,
    evidenceRef: 'ev-order-1',
    ...overrides,
  });
}

/** 造一个回放固定结果的 M09 订单查询端口。 */
export function makeOrderPort(results: readonly OrderQueryResult[] = [makeOrderResult()]) {
  return createFixtureOrderQueryPort({ results });
}

/** 从任意错误里取出可机读 code（M08 PaymentError 有 code；M09 错误无 code）。 */
export function codeOfError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { readonly code: unknown }).code);
  }
  return 'not-a-payment-error';
}
