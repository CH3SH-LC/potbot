/**
 * M-R02（美团团备用包）唯一出口。
 *
 * 范围：**SKU 必选/多选、库存、起送金额、配送范围边界**。
 *
 * 本包只做「点餐前校验」的纯本地模型：规格规则、有效库存、数量上下限、起送金额、
 * 配送范围开闭区间。它**不接真实平台、不持有价格、不下单、不支付**。
 */

export * from './types.js';
export * from './errors.js';
export * from './specs.js';
export * from './stock.js';
export * from './fulfillment.js';
export * from './preflight.js';
export * from './schemas.js';
export * from './fixture.js';

/**
 * 购买边界常量（**结构性声明，不是开关**）。
 * 与 M04 的 `CART_PURCHASE_BOUNDARY` 同一思路：把「本包不是下单通道」写进可断言的数据。
 */
export const CATALOG_PREFLIGHT_BOUNDARY = Object.freeze({
  canSubmitOrder: false,
  canPay: false,
  connectsRealPlatform: false,
  holdsPrices: false,
  mode: 'fixture',
  note: 'M-R02 只做 SKU 规格/库存/起送/配送范围校验；无价格、无下单、无支付入口，真实目录归 M03、报价归 M04。',
} as const);
