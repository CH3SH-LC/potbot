/**
 * M-I09 测试夹具（不是被收集的用例文件）。
 *
 * 本单元（集成波次）验证两条落地缝：
 * 1. **已落地的下单意图** → 快照 → 恢复（重启后仍能跟踪原单、不重下）；
 * 2. **可注入的状态码注册表**（登记缝）→ 已知码覆盖一致性。
 *
 * 所有场景都由显式 fixture 驱动：本地构造结果 + 确定性查询端口。
 * 没有真实美团接口、没有网络、没有系统时间。
 */

import type { OrderIntent, OrderQueryResult } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';

/** 逻辑观测时刻（任意非零值，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 原单 externalId（本地已核验的那一单）。 */
export const EXTERNAL_ID = 'MT-DEMO-20261003-I09-0001';

/** 账号引用（脱敏引用，不是凭据）。 */
export const ACCOUNT_REF = 'acct-ref-home';

/** 本地下单意图金额（整数最小单位：分）。 */
export const AMOUNT_MINOR = 4760;

/** 币种。 */
export const CURRENCY = 'CNY';

/** 平台状态码：fixture 本地词汇（未经平台核验）。 */
export const CODE = Object.freeze({
  created: 'W_CREATED',
  paidWaitAccept: 'W_PAID_WAIT_ACCEPT',
  merchantAccepted: 'W_MERCHANT_ACCEPTED',
  delivering: 'W_DELIVERING',
  completed: 'W_COMPLETED',
  cancelledAfterPay: 'W_CANCELLED_AFTER_PAY',
  refundApplied: 'R_APPLIED',
  refundSettled: 'R_SETTLED',
  refundNone: 'R_NONE',
  unknownOrderCode: 'W_PLATFORM_NEW_STATE_2099',
});

/**
 * 一份**已落地**的下单意图（扮演从持久化介质读回来的纯数据；此处先经 JSON 往返，
 * 以暴露任何对「对象实例同一性」的隐式依赖）。
 */
export function persistedIntent(overrides: Record<string, unknown> = {}): unknown {
  return JSON.parse(
    JSON.stringify({
      orderIntentRef: 'intent-i09-1',
      externalId: EXTERNAL_ID,
      accountRef: ACCOUNT_REF,
      amountMinor: AMOUNT_MINOR,
      currency: CURRENCY,
      ...overrides,
    }),
  );
}

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
    evidenceRef: 'ev-ref-i09-query-1',
    ...overrides,
  });
}

/** 造一个本地下单意图（默认：与原单逐项相符）。 */
export function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return Object.freeze({
    orderIntentRef: 'intent-i09-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    ...overrides,
  });
}
