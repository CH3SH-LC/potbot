/**
 * M08 可信支付读回签发（零依赖）。
 *
 * ## 为什么读回必须受控签发
 *
 * 「已付款」这个结论的唯一合法来源是平台读回。若读回只是一个普通对象，
 * 任何调用方（或模型）都能构造 `{ paidState: 'paid', amountMinor: 1 }` 冒充平台 —
 * 那「回跳只触发查询、读回才能确认」这条纪律就退化成一个可被绕过的约定。
 * 因此与 K07 / M07 一致，读回**只能**由本模块的受控签发器产生（模块私有 `WeakSet`）：
 * 形状相同的自造 / 拷贝对象一律 `untrusted_payment_readback`。
 *
 * ## 契约不变量
 *
 * `verificationMode: 'fixture'` 的读回**不得**回报 `paid`（`fixture_readback_cannot_confirm`）：
 * 假端口不得签发「真实支付完成」。本包内的 `real` 模式仅用于在判定链路上验证
 * 「可信读回可确认已付款」这一分支，**不代表**任何真实平台已接通。
 */

import { PaymentError } from './errors.js';
import { asMinorUnits, asCurrencyCode, asNonEmptyString, asSafeInteger } from './money.js';
import { PAYMENT_READBACK_STATES } from './types.js';
import type { PaymentReadback, PaymentReadbackState } from './types.js';

/** 受控签发的读回登记表。私有、不导出 ⇒ 调用方无法枚举、无法伪造。 */
const TRUSTED_PAYMENT_READBACKS = new WeakSet<object>();

/** 读回签发入参。 */
export interface CreatePaymentReadbackInput {
  readonly paymentIntentRef: string;
  readonly externalId: string;
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly providerPaymentRef: string;
  readonly paidState: PaymentReadbackState;
  readonly observedAt: number;
  readonly evidenceRef: string;
  readonly verificationMode: 'fixture' | 'real';
  readonly detail?: string;
}

/**
 * 受控签发一张支付读回。**可信的唯一入口**。
 *
 * @throws {PaymentError} `untrusted_payment_readback` / `fixture_readback_cannot_confirm` /
 *   `invalid_payment_request`。
 */
export function createPaymentReadback(input: CreatePaymentReadbackInput): PaymentReadback {
  if (input === null || typeof input !== 'object') {
    throw new PaymentError('untrusted_payment_readback', '读回必须是对象');
  }
  if (!(PAYMENT_READBACK_STATES as readonly string[]).includes(input.paidState)) {
    throw new PaymentError(
      'untrusted_payment_readback',
      `读回状态必须是 ${PAYMENT_READBACK_STATES.join(' / ')} 之一，收到 ${String(input.paidState)}`,
      'paidState',
    );
  }
  if (input.verificationMode !== 'fixture' && input.verificationMode !== 'real') {
    throw new PaymentError(
      'untrusted_payment_readback',
      `读回必须标明 verificationMode（fixture / real），收到 ${String(input.verificationMode)}`,
      'verificationMode',
    );
  }
  if (input.verificationMode === 'fixture' && input.paidState === 'paid') {
    throw new PaymentError(
      'fixture_readback_cannot_confirm',
      'verificationMode=fixture 的读回不得回报 paid：假端口不得签发「真实支付已付款」' +
        '（契约外部回执不变量）',
      'paidState',
    );
  }
  const readback: PaymentReadback = Object.freeze({
    paymentIntentRef: asNonEmptyString(input.paymentIntentRef, 'paymentIntentRef'),
    externalId: asNonEmptyString(input.externalId, 'externalId'),
    accountRef: asNonEmptyString(input.accountRef, 'accountRef'),
    amountMinor: asMinorUnits(input.amountMinor, 'amountMinor'),
    currency: asCurrencyCode(input.currency),
    providerPaymentRef: asNonEmptyString(input.providerPaymentRef, 'providerPaymentRef'),
    paidState: input.paidState,
    observedAt: asSafeInteger(input.observedAt, 'observedAt'),
    evidenceRef: asNonEmptyString(input.evidenceRef, 'evidenceRef'),
    verificationMode: input.verificationMode,
    detail: input.detail ?? '',
  });
  TRUSTED_PAYMENT_READBACKS.add(readback);
  return readback;
}

/** 该读回是否由受控签发器产生。 */
export function isTrustedPaymentReadback(value: unknown): value is PaymentReadback {
  return typeof value === 'object' && value !== null && TRUSTED_PAYMENT_READBACKS.has(value);
}

/**
 * **硬判据**：读回必须由受控签发器产生，且对象非空。
 *
 * 端口返回 `null`（读了但无结论）⇒ `missing_payment_readback`，**不得**当已付款。
 */
export function assertTrustedPaymentReadback(value: unknown): PaymentReadback {
  if (value === undefined || value === null) {
    throw new PaymentError(
      'missing_payment_readback',
      '查询端口没有给出支付读回（读了但无结论）：不得据此推断已付款',
    );
  }
  if (typeof value !== 'object' || !TRUSTED_PAYMENT_READBACKS.has(value)) {
    throw new PaymentError(
      'untrusted_payment_readback',
      '该读回不是本模块可信签发器产生的：已付款只能来自平台读回，不得由调用方或模型自造',
    );
  }
  return value as PaymentReadback;
}
