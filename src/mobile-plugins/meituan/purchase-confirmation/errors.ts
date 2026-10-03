/**
 * M06 购买确认 —— 错误类型与拒因词表（零依赖）。
 *
 * ## 为什么拒因必须是可机读错误码
 *
 * 本包要关的洞是「**模型/JS 可以自称用户已确认**」。对策不是把「确认」退化成一个布尔值
 * （`confirmed: true` 谁都能写），而是让确认**只能由一个可信签发器产生**，并把每一次拒绝
 * 都变成**具名拒因**：
 * - 超过金额上限不是「返回 false」，而是 `amount_exceeds_ceiling`；
 * - 伪造的确认不是「当作没确认」，而是 `untrusted_native_confirmation`；
 * - 关键条件变化不是「继续用旧确认」，而是 `native_confirmation_binding_mismatch`（带 `field`）。
 *
 * 拒因退化会让上层把「没批准」和「批准了但被拦」混为一谈——那正是假成功的温床。
 */

/** 本包**全部**可机读拒因（新增必须在此登记）。 */
export const PURCHASE_CONFIRMATION_ERROR_CODES = [
  // --- 业务合同 ---
  /** 合同条目本身不合法（缺字段 / 迁移错误）。 */
  'invalid_purchase_contract',
  /** 动作不在本版美团业务合同里。 */
  'action_not_in_contract',
  /** 自主路径试图执行购买/支付类外部动作——**未被用户确认的自主购买在此当场拒绝**。 */
  'autonomous_purchase_forbidden',
  /** 动作声明的范围与实际给出的范围不符（如下单动作给了 payment）。 */
  'scope_not_permitted',

  // --- 确认 ViewModel 与订单参数 ---
  /** 构造 ViewModel 的入参不合法（空 id / 非整数金额 / 非法期限等）。 */
  'invalid_view_model_input',
  /** 订单参数不完整：商家 / 条目 / SKU-规格-数量 / 总费用 / 地址 / 时段 / 范围 缺一不可。 */
  'order_params_incomplete',
  /** 展示声明与本地重新核对的订单参数不符——展示数据不得来自模型字符串。 */
  'view_model_binding_mismatch',

  // --- 金额上限 ---
  /** 未配置金额上限：没有上限就**不得**购买（宁可不放行，不默认无限额）。 */
  'ceiling_not_configured',
  /** 总额超过金额上限。 */
  'amount_exceeds_ceiling',
  /** 金额上限的币种与订单币种不符。 */
  'ceiling_currency_mismatch',

  // --- 一次性原生确认（K07 语义） ---
  /** 未携带原生确认（缺省即拒——「没有用户确认不得购买」是硬判据）。 */
  'missing_native_confirmation',
  /** 确认不是由本模块可信签发器产生的（调用方自造 / 拷贝的确认对象）。 */
  'untrusted_native_confirmation',
  /** 该确认已被占用：一次性确认不得第二次使用（重复点击 / 重放）。 */
  'native_confirmation_already_consumed',
  /** 确认已过期（注入时钟已到 / 过 `expiresAt`）。 */
  'native_confirmation_expired',
  /** 确认绑定的某一项与当前订单参数不一致（关键条件变化即失效，拒因带 `field`）。 */
  'native_confirmation_binding_mismatch',
] as const;

export type PurchaseConfirmationErrorCode = (typeof PURCHASE_CONFIRMATION_ERROR_CODES)[number];

/**
 * 可逐项核对的**绑定字段**（与 K07 的八项绑定同形，另加 `expiresAt` 期限）。
 * 报错时带上它，验收才能断言「是哪一项变了」。
 */
export const PURCHASE_BINDING_FIELDS = [
  'actionId',
  'accountRef',
  'taskRevision',
  'paramsDigest',
  'quoteRef',
  'amount',
  'currency',
  'scope',
  'expiresAt',
] as const;

export type PurchaseBindingField = (typeof PURCHASE_BINDING_FIELDS)[number];

/** 订单参数的字段名（用于 `order_params_incomplete` / 展示核对定位）。 */
export const ORDER_PARAM_FIELDS = [
  'merchantId',
  'currency',
  'lines',
  'addressRef',
  'addressVersion',
  'timeSlotRef',
  'contactRef',
  'scope',
] as const;

export type OrderParamField = (typeof ORDER_PARAM_FIELDS)[number];

/** M06 链路唯一的错误类型。所有拒绝都抛它，验收按 `code` / `field` 断言。 */
export class PurchaseConfirmationError extends Error {
  readonly code: PurchaseConfirmationErrorCode;
  /** 逐项核对失败时指出是哪一项（非此类错误为 null）。 */
  readonly field: string | null;

  constructor(code: PurchaseConfirmationErrorCode, detail: string, field: string | null = null) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'PurchaseConfirmationError';
    this.code = code;
    this.field = field;
  }
}

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isPurchaseConfirmationError(value: unknown): value is PurchaseConfirmationError {
  return (
    value instanceof PurchaseConfirmationError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (PURCHASE_CONFIRMATION_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}
