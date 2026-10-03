/**
 * M08 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景都由**显式 fixture** 驱动：合成可信域名（`.test`，非官方）、
 * 脚本化读回端口、确定性时钟。这里没有真实美团支付接口、没有网络、没有系统时间、
 * 也**没有任何真实银行卡/验证码/PIN**（凭据隔离用例只使用明显伪造的占位串）。
 */

import {
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

/** 逻辑时刻基准（任意非零值，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 交接期限（T0 + 15 分钟）。 */
export const EXPIRES_AT = T0 + 15 * 60 * 1000;

/** 原单 externalId（本地已核验的那一单）。 */
export const EXTERNAL_ID = 'MT-DEMO-20261003-0001';

/** 付款账号引用（脱敏引用，不是凭据、不是卡号）。 */
export const ACCOUNT_REF = 'acct:meituan:demo-0001';

/** 本地支付意图金额（整数最小单位：分）。 */
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

/** 造一个本地支付意图（默认与读回逐项相符）。 */
export function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
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

/** 造一份**可信来源**的支付回跳。 */
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
