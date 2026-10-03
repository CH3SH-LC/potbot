/**
 * `tests/mobile-meituan/M-R03` 唯一公开出口（M-R03：价格/配送费/优惠变更、
 * 报价过期与重新确认）。
 *
 * ## 本包做了什么
 *
 * - {@link diffQuotes}：两份报价的结构化差异（单价/数量/费用/优惠/总价/币种，
 *   条目按 `lineId`、费用优惠按 `code` 聚合）；
 * - {@link ReconfirmationGuard}：记录用户确认基线，并判定「参数相同但服务端改价」
 *   「已过期」「参数变化」时**必须重新确认**，显式给出原因；
 * - {@link isQuoteExpired}/{@link quoteExpiresInMs}：过期口径（`now >= expiresAt`）；
 * - {@link validateOperationEnvelope}：三个操作的信封形状校验（对齐 v1 契约）。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - 不接真实美团接口（真实能力待 M01 核实）；不提交订单、不支付；
 * - 不签发一次性授权（`AuthorizationGrant` 归 K07 独占）；
 * - 不读系统时间、不读随机/环境（时间只来自注入时钟）；
 * - 不重算金额：`diffQuotes` 只报告差异，从不改写端口给出的总价。
 *
 * 它构建在 M04（`src/mobile-plugins/meituan/cart/`）之上，只消费其公开 API，
 * 不复制其实现。
 */

export * from './types.js';
export * from './errors.js';
export * from './price-diff.js';
export * from './guard.js';
export * from './operations.js';

/**
 * 购买/授权边界常量（**结构性声明，不是开关**）。
 *
 * 本包只做变更检测与重新确认判定，绝不成为下单或授权通道。
 */
export const RECONFIRMATION_BOUNDARY = Object.freeze({
  /** 本包**不**提交订单。 */
  canSubmitOrder: false,
  /** 本包**不**发起支付。 */
  canPay: false,
  /** 本包**不**签发 K07 一次性授权（只记录本地确认基线）。 */
  issuesAuthorizationGrant: false,
  /** 本包不做权威确认（本地基线不等于用户确认）。 */
  authoritative: false,
  /** 本包不接真实平台接口。 */
  connectsRealPlatform: false,
  note: 'M-R03 只做报价变更检测与重新确认判定：金额只比对不重算，不下单、不支付、不签发授权。',
} as const);
