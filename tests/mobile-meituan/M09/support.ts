/**
 * M09 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景都由**显式 fixture** 驱动：本地结果构造 + 确定性查询端口。
 * 这里没有真实美团接口、没有网络、没有系统时间。
 */

import type { OrderIntent, OrderQueryResult } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';

/** 逻辑观测时刻（任意非零值，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 原单 externalId（本地已核验的那一单）。 */
export const EXTERNAL_ID = 'MT-DEMO-20261003-0001';

/** 账号引用（脱敏引用，不是凭据）。 */
export const ACCOUNT_REF = 'acct-ref-home';

/** 本地下单意图金额（整数最小单位：分）。 */
export const AMOUNT_MINOR = 4760;

/** 币种。 */
export const CURRENCY = 'CNY';

/** 平台状态码：fixture 本地词汇（未经平台核验）。 */
export const CODE = Object.freeze({
  created: 'W_CREATED',
  payFailed: 'W_PAY_FAILED',
  paidWaitAccept: 'W_PAID_WAIT_ACCEPT',
  merchantAccepted: 'W_MERCHANT_ACCEPTED',
  delivering: 'W_DELIVERING',
  completed: 'W_COMPLETED',
  cancelledBeforePay: 'W_CANCELLED_BEFORE_PAY',
  cancelledAfterPay: 'W_CANCELLED_AFTER_PAY',
  refundApplied: 'R_APPLIED',
  refundSettled: 'R_SETTLED',
  refundRejected: 'R_REJECTED',
  refundNone: 'R_NONE',
  unknownOrderCode: 'W_PLATFORM_NEW_STATE_2099',
  unknownRefundCode: 'R_PLATFORM_NEW_STATE_2099',
});

/** 造一个平台查询结果（默认：配送中、未发起退款）。 */
export function makeResult(overrides: Partial<OrderQueryResult> = {}): OrderQueryResult {
  return Object.freeze({
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    rawStatusCode: CODE.delivering,
    refundStatusCode: null,
    refundAmountMinor: null,
    observedAt: T0,
    evidenceRef: 'ev-ref-query-1',
    ...overrides,
  });
}

/** 造一个本地下单意图（默认：与原单逐项相符）。 */
export function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return Object.freeze({
    orderIntentRef: 'intent-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    ...overrides,
  });
}
