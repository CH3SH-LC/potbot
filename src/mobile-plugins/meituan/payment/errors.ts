/**
 * M08 支付 —— **错误类型与可机读拒因词表**（零依赖）。
 *
 * ## 为什么支付链路的拒因必须可机读
 *
 * 支付里最危险的一类 bug 是把「用户点了支付」或「回跳 URL 里写着 success」当成
 * 「已付款」。那不是一个布尔判据写错，而是**判据对象选错了**：本地事件（点击、回跳）
 * 永远不能替代平台读回。所以本模块把「拿回跳当已付款」「拿自造读回当已付款」
 * 「拿形状相同的读回当已付款」全部变成**独立的拒因码**，验收按 `code` 断言，
 * 而不是靠 reviewer 肉眼发现。
 */

import type { PaymentMismatchField, TransitionKind } from './types.js';

/** 支付链路上**全部**可机读拒因（新增必须在此登记）。 */
export const PAYMENT_ERROR_CODES = [
  // --- 入参与绑定 ---
  /** 入参形状不合法（空引用 / 非整数金额 / 非法币种 / 非法期限）。 */
  'invalid_payment_request',
  /** 本地支付意图本身不合法。 */
  'invalid_payment_intent',

  // --- 可信来源 ---
  /** 支付交接（官方支付页/SDK 入口）不是由可信签发器产生的。 */
  'untrusted_payment_handoff',
  /** 支付回跳凭据不是由可信签发器产生的（调用方自造的「平台说成功了」）。 */
  'untrusted_payment_callback',
  /** 支付读回不是由可信签发器产生的（客户端自造 `{ paidState: 'paid' }` 无效）。 */
  'untrusted_payment_readback',
  /** 官方支付链接未通过可信域名白名单（非 https / 域名不在白名单 / 内嵌凭据）。 */
  'untrusted_payment_url',
  /** 交接已过期：不得据过期的官方支付入口宣称可支付。 */
  'payment_handoff_expired',

  // --- 不代填支付凭据（本包最要害的边界） ---
  /** 载荷里出现银行卡号 / CVV / 验证码 / PIN 等支付凭据字段：本模块**拒绝**处理。 */
  'forbidden_payment_credential_input',

  // --- 读回与匹配 ---
  /** `verificationMode: 'fixture'` 的读回不得回报 `paid`（契约不变量）。 */
  'fixture_readback_cannot_confirm',
  /** 读回与本地支付意图在某一项上不一致。 */
  'payment_intent_mismatch',
  /** 没有装配支付查询端口：无法读回时不得猜已付款。 */
  'missing_payment_query_port',
  /** 读了但端口没给出可解释的读回（结论未知，不得当已付款）。 */
  'missing_payment_readback',

  // --- 状态与结论 ---
  /** 非法的支付状态转换。 */
  'illegal_payment_transition',
  /** 本地不匹配/异常流转尚未处置：拒绝继续跟踪。 */
  'payment_tracking_blocked',
  /** 该状态**不得**声称已付款（只有 `confirmed_paid` 可以）。 */
  'payment_not_paid',
] as const;

export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[number];

/**
 * 支付链路唯一的错误类型。所有拒绝都抛它，验收按 `code` 断言。
 */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  /** 逐项核对失败时指出首个不符项（非此类错误为 null）。 */
  readonly field: string | null;
  /** 不匹配类错误的**全部**不符字段（顺序固定）；非此类为空数组。 */
  readonly mismatchFields: readonly PaymentMismatchField[];

  constructor(
    code: PaymentErrorCode,
    detail: string,
    field: string | null = null,
    mismatchFields: readonly PaymentMismatchField[] = [],
  ) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'PaymentError';
    this.code = code;
    this.field = field;
    this.mismatchFields = Object.freeze([...mismatchFields]);
  }
}

/** 便于测试识别的守卫（`instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isPaymentError(value: unknown): value is PaymentError {
  return (
    value instanceof PaymentError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (PAYMENT_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

/**
 * 不匹配类错误的补充说明：哪种流转被拒（供拒因日志定位）。
 * 保留 `TransitionKind` 引用，避免类型与词表漂移。
 */
export type PaymentTransitionRejection = TransitionKind;
