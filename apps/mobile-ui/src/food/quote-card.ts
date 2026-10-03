/**
 * F10 food / 报价卡 —— **过期报价强制重新确认**（本包的核心不变量）。
 *
 * ## 报价从哪来、能不能信
 *
 * 报价（`Quote`）在 M04 里只能由注入的 `QuotePort` 产生；本卡**不重算**任何金额，
 * 只把端口给的整数最小单位渲染出来。报价**是否还能用**由 M04 的
 * `CartSession.checkQuote()` 判定（它同时看参数指纹、取代关系、作废与过期）。
 *
 * ## 核心不变量：报价不可用 ⇒ 确认一定被拒，且要求重新确认
 *
 * - `QuoteCardView.confirmable === check.usable`：报价一旦不可用，卡就**不可确认**；
 * - `evaluateQuoteConfirmation()` 是确认闸门：报价不可用、或用户确认的 `quoteRef`
 *   与当前卡不一致（旧报价），一律**拒绝**并置 `requiresReconfirmation = true`；
 * - `requiredUserAction` 明确区分「可以确认」与「必须重新取价」——过期/被取代/参数变化
 *   都落在 `'re-quote'`，不允许把旧报价沿用下去。
 *
 * 这一层不签发任何授权、不提交订单：真正的一次性授权与下单归 K07 / M07。
 */

import type {
  CartSession,
  Quote,
  QuoteCheck,
  QuoteStaleReason,
} from '../../../../src/mobile-plugins/meituan/cart/index.js';

import { toFoodMoneyView, type FoodMoneyView } from './money.js';
import type { FoodCardBase } from './types.js';

/** 报价卡状态。`usable` 是唯一可确认的态。 */
export type QuoteCardState =
  /** 参数未变且未过期，可确认。 */
  | 'usable'
  /** 已过期（时钟已到或已过 `expiresAt`）。 */
  | 'expired'
  /** 已被更新的报价取代（不是当前持有的报价）。 */
  | 'superseded'
  /** 被显式作废。 */
  | 'invalidated'
  /** 购物车参数已变（条目/数量/规格/地址/费用优惠）。 */
  | 'stale';

/** 卡面要求用户做的下一步。 */
export type QuoteRequiredAction = 'confirm' | 're-quote' | 'none';

export interface QuoteLineView {
  readonly lineId: string;
  readonly dishId: string;
  readonly skuId: string;
  readonly quantity: number;
  readonly unitPrice: FoodMoneyView;
  readonly lineTotal: FoodMoneyView;
}

export interface QuoteFeeView {
  readonly code: string;
  readonly label: string;
  readonly amount: FoodMoneyView;
}

export interface QuoteDiscountView {
  readonly code: string;
  readonly label: string;
  readonly amount: FoodMoneyView;
}

export interface QuoteCardView extends FoodCardBase {
  readonly kind: 'quote';
  readonly quoteRef: string;
  readonly merchantId: string;
  readonly currency: string;
  readonly total: FoodMoneyView;
  readonly subtotal: FoodMoneyView;
  readonly items: readonly QuoteLineView[];
  readonly fees: readonly QuoteFeeView[];
  readonly discounts: readonly QuoteDiscountView[];
  readonly expiresAt: number;
  readonly pricedAt: number;
  /** M04 的原始判定结果（含全部原因），原样透出便于验收与调试。 */
  readonly check: QuoteCheck;
  readonly state: QuoteCardState;
  readonly staleReasons: readonly QuoteStaleReason[];
  /** 是否可确认：**恒等于** `check.usable`。 */
  readonly confirmable: boolean;
  readonly requiredUserAction: QuoteRequiredAction;
  readonly detail: string;
  /** 恒为 `false`：报价不是订单总额，也不构成下单授权（与 M04 `Quote.isOrderTotal` 同源）。 */
  readonly isOrderTotal: false;
}

function deriveQuoteState(check: QuoteCheck): QuoteCardState {
  if (check.usable) return 'usable';
  // 过期优先级最高：过期是「重新确认」最典型的触发条件。
  if (check.reasons.includes('expired')) return 'expired';
  if (check.reasons.includes('not_current')) return 'superseded';
  if (check.reasons.includes('invalidated')) return 'invalidated';
  if (check.reasons.includes('params_changed')) return 'stale';
  return 'stale';
}

const STATE_LABEL: Readonly<Record<QuoteCardState, string>> = Object.freeze({
  usable: '报价可用',
  expired: '报价已过期',
  superseded: '报价已被取代',
  invalidated: '报价已作废',
  stale: '报价已失效',
});

/**
 * 由 **M04 会话**构造报价卡：`session.checkQuote(quote)` 是唯一的可用性判据。
 *
 * 传入一个**不是**该会话当前持有的报价（例如上一轮遗留的 `Quote`）也可以——
 * `checkQuote` 会把它判为 `not_current`，卡随之变为 `superseded` 且不可确认。
 */
export function buildQuoteCard(session: CartSession, quote: Quote): QuoteCardView {
  const check = session.checkQuote(quote);
  const state = deriveQuoteState(check);
  const currency = quote.currency;

  return Object.freeze({
    kind: 'quote',
    title: STATE_LABEL[state],
    quoteRef: quote.quoteRef,
    merchantId: quote.merchantId,
    currency,
    total: toFoodMoneyView(quote.amount, currency),
    subtotal: toFoodMoneyView(quote.subtotalMinor, currency),
    items: Object.freeze(
      quote.items.map((item) =>
        Object.freeze({
          lineId: item.lineId,
          dishId: item.dishId,
          skuId: item.skuId,
          quantity: item.quantity,
          unitPrice: toFoodMoneyView(item.unitAmountMinor, currency),
          lineTotal: toFoodMoneyView(item.lineAmountMinor, currency),
        }),
      ),
    ),
    fees: Object.freeze(
      quote.fees.map((fee) =>
        Object.freeze({ code: fee.code, label: fee.label, amount: toFoodMoneyView(fee.amountMinor, currency) }),
      ),
    ),
    discounts: Object.freeze(
      quote.discounts.map((discount) =>
        Object.freeze({
          code: discount.code,
          label: discount.label,
          amount: toFoodMoneyView(discount.amountMinor, currency),
        }),
      ),
    ),
    expiresAt: quote.expiresAt,
    pricedAt: quote.pricedAt,
    check,
    state,
    staleReasons: check.reasons,
    confirmable: check.usable,
    requiredUserAction: check.usable ? 'confirm' : 're-quote',
    detail: check.detail,
    isOrderTotal: false,
  });
}

// ---------------------------------------------------------------------------
// 确认闸门：过期/失效报价强制重新确认
// ---------------------------------------------------------------------------

export type QuoteConfirmRejection =
  /** 用户确认引用的 `quoteRef` 不是当前卡的报价（旧报价被重复提交）。 */
  | 'stale_quote_ref'
  /** 报价已过期。 */
  | 'quote_expired'
  /** 报价已被取代。 */
  | 'quote_superseded'
  /** 报价已作废。 */
  | 'quote_invalidated'
  /** 购物车参数已变。 */
  | 'quote_params_changed'
  /** 其它不可用原因。 */
  | 'quote_not_usable';

export interface QuoteConfirmOutcome {
  readonly ok: boolean;
  readonly rejection: QuoteConfirmRejection | null;
  /** 被拒时**恒为 true**：必须先重新确认（重新取价），旧报价不得沿用。 */
  readonly requiresReconfirmation: boolean;
  readonly message: string;
}

const STATE_REJECTION: Readonly<Record<Exclude<QuoteCardState, 'usable'>, QuoteConfirmRejection>> =
  Object.freeze({
    expired: 'quote_expired',
    superseded: 'quote_superseded',
    invalidated: 'quote_invalidated',
    stale: 'quote_params_changed',
  });

const REJECTION_MESSAGE: Readonly<Record<QuoteConfirmRejection, string>> = Object.freeze({
  stale_quote_ref: '确认引用的报价不是当前报价：旧报价不得再确认，请重新取价后确认。',
  quote_expired: '报价已过期：不能沿用，必须重新取价并获得新的报价后再确认。',
  quote_superseded: '报价已被更新的报价取代：请基于最新报价重新确认。',
  quote_invalidated: '报价已被作废：必须重新取价后再确认。',
  quote_params_changed: '购物车参数已变化，报价不再适用：请重新取价后再确认。',
  quote_not_usable: '报价当前不可用：请重新取价后再确认。',
});

/**
 * 评估一次「用户确认报价」是否成立。
 *
 * 闸门顺序：
 *   1. `confirmedQuoteRef` 必须等于卡上的 `quoteRef`   → 否则 `stale_quote_ref`；
 *   2. 卡必须可确认（`check.usable`）                   → 否则按状态给出具体拒绝码。
 *
 * **任何拒绝都返回 `requiresReconfirmation: true`**——这正是「过期报价强制重新确认」
 * 的机器化判据：确认不会带着一个过期报价穿过这道闸门。
 */
export function evaluateQuoteConfirmation(card: QuoteCardView, confirmedQuoteRef: string): QuoteConfirmOutcome {
  if (confirmedQuoteRef !== card.quoteRef) {
    return Object.freeze({
      ok: false,
      rejection: 'stale_quote_ref',
      requiresReconfirmation: true,
      message: REJECTION_MESSAGE.stale_quote_ref,
    });
  }
  if (!card.confirmable) {
    const rejection: QuoteConfirmRejection =
      card.state === 'usable' ? 'quote_not_usable' : STATE_REJECTION[card.state];
    return Object.freeze({
      ok: false,
      rejection,
      requiresReconfirmation: true,
      message: REJECTION_MESSAGE[rejection],
    });
  }
  return Object.freeze({
    ok: true,
    rejection: null,
    requiresReconfirmation: false,
    message: '报价可用，确认成立（真正的下单授权由 K07/M07 处理）。',
  });
}

/** 便捷判据：该报价卡是否要求先重新取价。 */
export function requiresReconfirmation(card: QuoteCardView): boolean {
  return !card.confirmable;
}
