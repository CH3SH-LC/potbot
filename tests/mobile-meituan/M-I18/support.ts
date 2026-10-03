/**
 * M-I18 测试夹具（不是被收集的用例文件）。
 *
 * 本单元验证 M07 → M09 的落盘意图缝。所有场景都由显式 fixture 驱动：
 * 本地构造的提交记录 + 确定性查询端口；没有真实美团接口、没有网络、没有系统时间。
 */

import type { OrderSubmissionRecord } from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import type { OrderQueryResult } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';

/** 逻辑观测时刻（任意非零值，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 平台订单号（M07 providerOrderRef，即 M09 externalId）。 */
export const EXTERNAL_ID = 'MT-ORDER-I18-0001';

/** 账号引用（脱敏引用，不是凭据）。 */
export const ACCOUNT_REF = 'acct-ref-home';

/** 金额（整数最小单位：分）。 */
export const AMOUNT_MINOR = 4760;

/** 币种。 */
export const CURRENCY = 'CNY';

/** M07 幂等键（同时是落盘意图的 subjectRef 溯源）。 */
export const IDEMPOTENCY_KEY = 'idem-i18-0001';

/** M09 fixture 平台状态码：配送中。 */
export const DELIVERING_CODE = 'W_DELIVERING';

/**
 * 一条**已确认下单**的 M07 提交记录（全字段，冻结）。
 *
 * `state='confirmed'` 且 `providerOrderRef` 非空——这是派生可跟踪意图的前提。
 * 覆写任意字段即可造出负向场景（未确认 / 缺平台单号）。
 */
export function confirmedSubmissionRecord(
  overrides: Partial<OrderSubmissionRecord> = {},
): OrderSubmissionRecord {
  return Object.freeze({
    actionId: 'act-i18',
    merchantId: 'merchant-i18',
    accountRef: ACCOUNT_REF,
    taskRevision: 1,
    paramsDigest: 'v1-abcdef01',
    quoteRef: 'quote-i18',
    amount: AMOUNT_MINOR,
    currency: CURRENCY,
    scope: 'submit-order',
    grantId: 'grant-i18',
    idempotencyKey: IDEMPOTENCY_KEY,
    state: 'confirmed',
    attempt: 1,
    sendIntentAt: T0,
    respondedAt: T0 + 5,
    httpStatus: 200,
    businessCode: 'ok',
    outcomeKind: 'success',
    providerOrderRef: EXTERNAL_ID,
    receipt: Object.freeze({
      idempotencyKey: IDEMPOTENCY_KEY,
      providerOrderRef: EXTERNAL_ID,
      observedState: 'confirmed' as const,
      observedAt: T0 + 5,
      verificationMode: 'real' as const,
      detail: 'fixture 场景：由查原单取回的可信回执',
    }),
    failureReason: null,
    createdAt: T0,
    updatedAt: T0 + 5,
    ...overrides,
  });
}

/** 一份合法的意图构造输入（五字段 + 溯源引用）。 */
export function intentInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderIntentRef: 'oi:fixture-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    subjectRef: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

/** 造一个平台查询结果（默认：配送中、未发起退款）。 */
export function makeQueryResult(overrides: Partial<OrderQueryResult> = {}): OrderQueryResult {
  return Object.freeze({
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    rawStatusCode: DELIVERING_CODE,
    refundStatusCode: null,
    refundAmountMinor: null,
    observedAt: T0 + 5,
    evidenceRef: 'ev-ref-i18-query-1',
    ...overrides,
  });
}
