/**
 * `src/mobile-plugins/meituan/spec-preflight` 唯一公开出口
 * （M-R02 备用包 M-I13 生产化落地；不要与 M03 的 `catalog/` 混用）。
 *
 * 范围：**SKU 必选/多选、库存、起送金额、配送范围边界**。
 *
 * 本包只做「点餐前校验」的纯本地模型：规格规则、有效库存、数量上下限、起送金额、
 * 配送范围开闭区间。它**不接真实平台、不持有价格、不下单、不支付**。
 *
 * ## 生产化说明（相对 M-R02 测试树）
 *
 * M-R02 的源码原本落在 `tests/mobile-meituan/M-R02/`（备用包，写权只覆盖测试目录）。
 * 本目录把它提升为生产源码：`types/errors/specs/stock/fulfillment/preflight/schemas`
 * 与 M-R02 **逐字节一致**（同一实现，非并行重写），本出口把同一 API 原样再导出。
 *
 * **唯一差异**：不导出 M-R02 的 `fixture.ts`。fixture 是本地测试数据、
 * 「不得被当成生产开关」（M-R02 README / 工作书 §2），故只留在测试树
 * `tests/mobile-meituan/M-I13/fixture.ts`，生产出口刻意不含它。
 */

export * from './types.js';
export * from './errors.js';
export * from './specs.js';
export * from './stock.js';
export * from './fulfillment.js';
export * from './preflight.js';
export * from './schemas.js';

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
