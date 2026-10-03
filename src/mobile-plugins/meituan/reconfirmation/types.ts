/**
 * M-R03 报价变更与重新确认 —— 类型定义（纯数据、零行为）。
 *
 * ## 本包相对 M04（`src/mobile-plugins/meituan/cart/`）补的是什么
 *
 * M04 已经能判定**本地参数变化**（条目/数量/规格/地址/优惠勾选）与**过期**，
 * 并给出 `QuoteStaleReason`。它没有覆盖一类真实场景：
 *
 * > 购物车参数一模一样（`paramsDigest` 相同），但**服务端报价变了**：
 * > 单价调整、配送费/打包费变化、优惠额度缩水。此时 M04 的 `checkQuote`
 * > 仍可能说「可用」（指纹一致、未过期），而用户此前确认的是**旧金额**。
 *
 * 本包正是在这条缝上补洞：给出「两份报价的差异」结构（{@link QuotePriceDiff}）
 * 与「是否需要重新确认」的结构（{@link ReconfirmationRequest}），
 * 让「价格变了 ⇒ 旧确认作废、必须重新确认」成为可断言的行为，而不是约定。
 *
 * ## 纪律（沿用 M04，且不放松）
 *
 * - 金额一律**整数最小单位**（人民币为「分」），本包只比对、绝不重算或改写；
 * - 时间只来自**注入时钟**，不读系统时间；
 * - 本包**不**提交订单、**不**支付、**不**签发 K07 授权，只做本地判定与证据。
 */

import type { CartSession, Quote, QuoteClock } from '../cart/index.js';

/**
 * 一份报价相对另一份报价发生变化的具体种类。顺序固定见 {@link QUOTE_CHANGE_KIND_ORDER}。
 *
 * - `item_set_changed`：条目集合变化（某 `lineId` 只在一侧出现）；
 * - `quantity_changed`：同一 `lineId` 的数量变化；
 * - `unit_price_changed`：同一 `lineId` 的单价变化（**服务端单价调整**）；
 * - `fee_changed`：按费用码聚合的金额变化（含配送费 `delivery`）；
 * - `discount_changed`：按优惠码聚合的抵扣变化；
 * - `amount_changed`：最终总价变化（由端口给出，本包只读）；
 * - `currency_changed`：币种变化（正常不应发生；发生必须显式可见）。
 */
export type QuoteChangeKind =
  | 'item_set_changed'
  | 'quantity_changed'
  | 'unit_price_changed'
  | 'fee_changed'
  | 'discount_changed'
  | 'amount_changed'
  | 'currency_changed';

/** 变化种类的固定枚举顺序（便于验收逐条比对，避免对象键序影响）。 */
export const QUOTE_CHANGE_KIND_ORDER: readonly QuoteChangeKind[] = Object.freeze([
  'item_set_changed',
  'quantity_changed',
  'unit_price_changed',
  'fee_changed',
  'discount_changed',
  'amount_changed',
  'currency_changed',
]);

/** 单条目的差异。缺失一侧的字段用 `null` 表示（不补 0，避免把「不存在」伪装成「零价」）。 */
export interface ItemPriceDelta {
  readonly lineId: string;
  /** 两侧取其一（存在者）的展示字段；都不存在时为 `null`（理论上不会）。 */
  readonly dishId: string | null;
  readonly skuId: string | null;
  readonly previousQuantity: number | null;
  readonly nextQuantity: number | null;
  readonly previousUnitAmountMinor: number | null;
  readonly nextUnitAmountMinor: number | null;
  /** 缺失侧按 0 计入行金额差（0 仅用于求差，不代表「该侧单价为 0」）。 */
  readonly previousLineAmountMinor: number;
  readonly nextLineAmountMinor: number;
  /** `next - previous`（整数最小单位）。 */
  readonly deltaMinor: number;
}

/** 按「费用码」聚合后的费用差异。同码多条会先求和再比较。 */
export interface FeeDelta {
  readonly code: string;
  readonly label: string;
  readonly previousAmountMinor: number | null;
  readonly nextAmountMinor: number | null;
  readonly deltaMinor: number;
}

/** 按「优惠码」聚合后的优惠差异。`amountMinor` 是正的抵扣幅度。 */
export interface DiscountDelta {
  readonly code: string;
  readonly label: string;
  readonly previousAmountMinor: number | null;
  readonly nextAmountMinor: number | null;
  readonly deltaMinor: number;
}

/**
 * 两份报价的结构化差异。由 {@link diffQuotes} 产出，纯函数、可重现。
 *
 * 注意 `changed` 与 `sameParamsDigest` 是**正交**的：
 * 同参数下服务端改价时 `sameParamsDigest === true` 而 `changed === true`——
 * 这正是 M04 无法单靠 `checkQuote` 发现、本包要补的场景。
 */
export interface QuotePriceDiff {
  readonly previousQuoteRef: string;
  readonly nextQuoteRef: string;
  /** 两份报价的参数指纹是否相同（相同 ⇒ 不是「用户改了车」，而是「服务端变了」）。 */
  readonly sameParamsDigest: boolean;
  readonly sameMerchant: boolean;
  /** 以 `next` 为准的币种（差异本身由 `currency_changed` 标注）。 */
  readonly currency: string;
  readonly changed: boolean;
  /** 已按 {@link QUOTE_CHANGE_KIND_ORDER} 排序、去重。 */
  readonly changedKinds: readonly QuoteChangeKind[];
  readonly previousAmountMinor: number;
  readonly nextAmountMinor: number;
  readonly amountDeltaMinor: number;
  readonly subtotalDeltaMinor: number;
  readonly items: readonly ItemPriceDelta[];
  readonly fees: readonly FeeDelta[];
  readonly discounts: readonly DiscountDelta[];
}

/** 需要重新确认的原因。顺序固定见 {@link RECONFIRM_REASON_ORDER}。 */
export type ReconfirmReason =
  /** 尚无用户确认（第一次必须先确认）。 */
  | 'no_confirmation'
  /** 购物车参数已变（指纹不同）——用户改过车，旧确认不再对应当前内容。 */
  | 'params_changed'
  /** 参数相同但报价金额/费用/优惠/单价变化——服务端改价，旧确认金额不再成立。 */
  | 'price_changed'
  /** 已确认的报价（或待评估的报价）已过期——期限一过，确认随之失效。 */
  | 'expired';

/** 需要重新确认原因的固定枚举顺序。 */
export const RECONFIRM_REASON_ORDER: readonly ReconfirmReason[] = Object.freeze([
  'no_confirmation',
  'params_changed',
  'price_changed',
  'expired',
]);

/**
 * 用户确认基线（**本地记录，不是权威授权**）。
 *
 * 真正的用户确认与一次性 `AuthorizationGrant` 由 K07 独占；M06 消费。本结构只
 * 用于本地判定「基于这份报价的确认是否还站得住」，`authoritative` 概念上恒为假
 * （由 {@link RECONFIRMATION_BOUNDARY} 的 `issuesAuthorizationGrant: false` 声明）。
 */
export interface ConfirmedBaseline {
  /** 调用方给定的确认引用（或本模块生成的 `local-confirm-N`）。 */
  readonly confirmationRef: string;
  readonly confirmedQuoteRef: string;
  readonly merchantId: string;
  readonly paramsDigest: string;
  /** 确认时点的最终价（整数最小单位）。**本模块只读它，绝不改写**。 */
  readonly amount: number;
  readonly currency: string;
  /** 确认时刻（注入时钟域）。 */
  readonly confirmedAt: number;
  /** 被确认报价的失效时刻（注入时钟域）。 */
  readonly expiresAt: number;
}

/**
 * 「是否需要重新确认」的评估结果。`needed === false` 时 `reasons` 必为空数组。
 * 永远**显式给出原因**，不静默沿用旧确认。
 */
export interface ReconfirmationRequest {
  readonly needed: boolean;
  /** 被评估的报价引用。 */
  readonly quoteRef: string;
  /** 已按 {@link RECONFIRM_REASON_ORDER} 排序；为空表示确认仍然有效。 */
  readonly reasons: readonly ReconfirmReason[];
  /** 当前确认基线；从未确认过为 `null`。 */
  readonly baseline: ConfirmedBaseline | null;
  /** 与基线的报价差异（无基线时为 `null`）。 */
  readonly priceDiff: QuotePriceDiff | null;
  /** `评估报价金额 - 基线金额`（整数最小单位；无基线时为 0）。 */
  readonly amountDeltaMinor: number;
  readonly detail: string;
}

/** 构造确认守卫的依赖。时间必须来自与购物车会话同源的注入时钟。 */
export interface ReconfirmationGuardOptions {
  readonly session: CartSession;
  readonly clock: QuoteClock;
}

/** 供证据记录：一次评估结果中仍需保留的最小快照。 */
export interface ReconfirmationEvidence {
  readonly quoteRef: string;
  readonly needed: boolean;
  readonly reasons: readonly ReconfirmReason[];
  readonly amountDeltaMinor: number;
  readonly sameParamsDigest: boolean | null;
  readonly changedKinds: readonly QuoteChangeKind[];
}
