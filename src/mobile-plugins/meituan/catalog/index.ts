/**
 * `src/mobile-plugins/meituan/catalog` 唯一公开出口（M03：商家/菜单目录）。
 *
 * ## 本包做了什么
 *
 * - 商家 / 菜单 / SKU / 规格的数据模型与运行时校验；
 * - **来源与时间**：每条数据带 `sourceRef`（provider/endpoint/取自注入时钟的时刻）；
 * - **未知不补造**：营业时间、库存、配送范围、声明总数一律 `MaybeKnown<T>`；
 * - **分页完整可判定**：游标回环 / 零进展 / 跨页重复报错，未翻完只给 `partial`；
 * - **文本只作数据**：店名/描述/规格名是 `UntrustedText`，注入片段只打标记不执行；
 * - 营业判定、配送范围/起送判定：未知一律不默认成「营业中 / 可配送 / 0 元起送」。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口**：真实平台能力尚未核实（未登录、无 token、无工具清单）；
 * - **不下单、不支付**：没有任何提交/支付入口；
 * - 报价/购物车归 M04，地址归 M05，确认归 M06。
 */

export * from './types.js';
export * from './errors.js';
export * from './known.js';
export * from './ids.js';
export * from './untrusted.js';
export * from './provenance.js';
export * from './validate.js';
export * from './pagination.js';
export * from './hours.js';
export * from './delivery.js';
export * from './catalog.js';
export * from './fixture.js';

/**
 * 购买边界常量（**结构性声明，不是开关**）。
 *
 * 把「目录不是购买通道」写死在类型/常量里，让后续接线者一眼可见。
 */
export const CATALOG_PURCHASE_BOUNDARY = Object.freeze({
  /** 本包**不**提交订单。 */
  canSubmitOrder: false,
  /** 本包**不**发起支付。 */
  canPay: false,
  /** 本包不接真实平台接口（真实能力待在后续包核实后接通）。 */
  connectsRealPlatform: false,
  /** 本包**不**凭空合成菜品/库存/价格——未知如实保留。 */
  synthesizesUnknowns: false,
  /** 商家文本**不**作为指令解释。 */
  treatMerchantTextAsInstruction: false,
  /** 商家文本**不**以裸字符串渲染进提示词：必须走 `DescriptionDataEnvelope` + 复核闸门。 */
  rendersMerchantTextRaw: false,
  note: 'M03 只做目录模型：数据来自注入端口、时间来自注入时钟，未知不补造，文本只作数据，无下单/支付入口。',
} as const);
