/**
 * `src/mobile-plugins/meituan/cart` 唯一公开出口（M04：购物车与报价模型）。
 *
 * ## 本包做了什么
 *
 * - 购物车状态：条目增删改（数量/规格）、同规格合并、地址引用、计价选择；
 * - 报价：只能由注入的 `QuotePort` 产生（fixture 实现随包提供）；
 * - 失效规则：条目/数量/规格/地址/费用优惠任一变化、或被取代/作废、或过期 ⇒
 *   既有报价判定失效并**显式给出原因**；
 * - 金额纪律：一切金额是**整数最小单位**，币种必填，本地只核对不重算；
 * - 边界换算：`minorUnitsToWireAmount` / `wireAmountToMinorUnits` 在 wire 十进制
 *   字符串与领域整数最小单位之间**精确**换算（位数由币种决定，见 mobile-v1 金额裁决）；
 * - 规格校验：`validateSpecSelection` 做必选 / 单选 / 多选校验（不再把重复 `groupId`
 *   一律拒绝），`normalizeSpecs` 支持按规格组定义规范化并保留单选默认；
 * - 操作描述符：`CART_OPERATIONS` 给出七个购物车操作的 payload 字段规格；
 * - wire 时间戳：`epochToIso8601` / `iso8601ToEpoch` 只在**注入的** epoch 与
 *   ISO-8601 字符串间互转，绝不读墙钟（见 `contract/` 子目录）。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口**：真实平台能力尚未核实（未登录、无 token、无工具清单）；
 * - **不下单、不支付**：本包不提供任何提交/支付能力，且 `Quote.isOrderTotal`
 *   恒为 `false`、`CartConfirmationDraft.authoritative` 恒为 `false`；
 * - 地址实体与授权归 M05，用户确认与原生确认归 M06。
 */

export * from './types.js';
export * from './errors.js';
export * from './money.js';
export * from './specs.js';
export * from './digest.js';
export * from './cart.js';
export * from './session.js';
export * from './contract/operations.js';
export * from './contract/timestamp.js';
export * from './fixture.js';

/**
 * 购买边界常量（**结构性声明，不是开关**）。
 *
 * 工作书与既有合同都要求「不直接购买/支付」。本包把这条边界写成常量，
 * 让后续接线者一眼看到：购物车/报价模型本身**不是**下单通道。
 */
export const CART_PURCHASE_BOUNDARY = Object.freeze({
  /** 本包**不**提交订单。 */
  canSubmitOrder: false,
  /** 本包**不**发起支付。 */
  canPay: false,
  /** 本包不接真实平台接口（真实能力待在后续包核实后接通）。 */
  connectsRealPlatform: false,
  note: 'M04 只做本地购物车与报价模型：报价来自注入端口，本地不重算价格，也没有下单/支付入口。',
} as const);
