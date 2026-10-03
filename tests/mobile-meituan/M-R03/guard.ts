/**
 * M-R03 重新确认守卫：把「报价变了/过期了 ⇒ 旧确认作废，必须重新确认」写成状态机。
 *
 * ## 它解决的问题
 *
 * 用户对报价 Q1（金额 A1）点头后，发生了下面任一件事：
 * 1. 用户改了车（参数变化，指纹不同）——M04 已能发现；
 * 2. **服务端改价**（参数相同、指纹相同，但单价/配送费/优惠变了）；
 * 3. Q1 过期。
 *
 * 情形 2、3 下 M04 的 `checkQuote` 可能仍说「可用」或只说「过期」。本守卫把
 * 「此前确认的**条款**是否还成立」单独建模：只有参数、金额、费用、优惠、期限**全都没变**
 * 才允许顺延旧确认，否则显式给出原因并要求重新确认。
 *
 * ## 它不是授权
 *
 * `confirm()` 只记录**本地基线**，不签发任何可执行的授权；一次性
 * `AuthorizationGrant` 归 K07 独占，M06 消费。本类没有任何 submit/pay 方法
 * （`boundary.test.ts` 对导出面做静态断言）。
 *
 * 时间一律来自注入时钟，不读系统时间。
 */

import type { CartSession, Quote, QuoteClock } from '../../../src/mobile-plugins/meituan/cart/index.js';
import { ReconfirmationError } from './errors.js';
import { diffQuotes } from './price-diff.js';
import { RECONFIRM_REASON_ORDER } from './types.js';
import type {
  ConfirmedBaseline,
  QuoteChangeKind,
  QuotePriceDiff,
  ReconfirmReason,
  ReconfirmationEvidence,
  ReconfirmationGuardOptions,
  ReconfirmationRequest,
} from './types.js';

/** 这些变化种类意味着「价格/条款」变了，需要重新确认。 */
const PRICE_KINDS: ReadonlySet<QuoteChangeKind> = new Set<QuoteChangeKind>([
  'unit_price_changed',
  'fee_changed',
  'discount_changed',
  'amount_changed',
  'currency_changed',
]);

const REASON_DETAIL: Readonly<Record<ReconfirmReason, string>> = Object.freeze({
  no_confirmation: '尚无用户确认，必须先确认当前报价',
  params_changed: '购物车参数已变化（条目/数量/规格/地址/费用优惠），旧确认不对应当前内容',
  price_changed: '报价条款已变化（单价/配送费/打包费/优惠/总价）——服务端可能已调整，旧确认金额不再成立',
  expired: '已确认的报价或待评估的报价已过期，确认随之失效',
});

/** 报价是否已过期（`now >= expiresAt` 即过期；与 M04 口径一致）。 */
export function isQuoteExpired(quote: Quote, now: number): boolean {
  return now >= quote.expiresAt;
}

/** 距过期的剩余毫秒（可为负；仅用于展示与断言，不参与判定）。 */
export function quoteExpiresInMs(quote: Quote, now: number): number {
  return quote.expiresAt - now;
}

/**
 * 重新确认守卫。组合（不继承）一个 `CartSession`：报价的取用/过期/指纹判定仍由
 * M04 负责，本类只在其上叠加「条款是否仍与已确认基线一致」。
 */
export class ReconfirmationGuard {
  readonly #session: CartSession;
  readonly #clock: QuoteClock;
  #baseline: ConfirmedBaseline | null = null;
  #baselineQuote: Quote | null = null;
  #sequence = 0;

  constructor(options: ReconfirmationGuardOptions) {
    this.#session = options.session;
    this.#clock = options.clock;
  }

  /** 当前确认基线；从未确认过为 `null`。 */
  get baseline(): ConfirmedBaseline | null {
    return this.#baseline;
  }

  /** 已发生的确认次数（用于断言重复确认确实发生了）。 */
  get confirmationCount(): number {
    return this.#sequence;
  }

  /**
   * 记录一次用户确认。
   *
   * 前置条件：`quote` 必须是本会话**当前可用**的报价——
   * 已改车、已过期、或已被更新报价取代的报价**不允许**被确认（关卡前移，
   * 复用 M04 的 `requireUsableQuote`）。
   *
   * @param confirmationRef 调用方给定的确认引用；省略时生成本地确定性引用 `local-confirm-N`。
   * @throws {ReconfirmationError} 显式给了空白引用时。
   * @throws {import('.../cart/index.js').QuoteStaleError} 报价不可用时（来自 M04）。
   */
  confirm(quote: Quote, confirmationRef?: string): ConfirmedBaseline {
    this.#session.requireUsableQuote(quote);
    let ref: string;
    if (confirmationRef === undefined) {
      this.#sequence += 1;
      ref = `local-confirm-${this.#sequence}`;
    } else if (confirmationRef.trim().length === 0) {
      throw new ReconfirmationError('确认引用不能为空（确认必须可追溯）');
    } else {
      this.#sequence += 1;
      ref = confirmationRef;
    }
    const baseline: ConfirmedBaseline = Object.freeze({
      confirmationRef: ref,
      confirmedQuoteRef: quote.quoteRef,
      merchantId: quote.merchantId,
      paramsDigest: quote.paramsDigest,
      amount: quote.amount,
      currency: quote.currency,
      confirmedAt: this.#clock.now(),
      expiresAt: quote.expiresAt,
    });
    this.#baseline = baseline;
    this.#baselineQuote = quote;
    return baseline;
  }

  /** 清除确认基线（例如用户主动取消）。 */
  clear(): void {
    this.#baseline = null;
    this.#baselineQuote = null;
  }

  /**
   * 评估一份报价能否沿用现有确认。只有**全部条款一致**且**均未过期**时才 `needed: false`。
   *
   * 顺序固定：no_confirmation → params_changed → price_changed → expired。
   */
  assess(next: Quote): ReconfirmationRequest {
    const baseline = this.#baseline;
    const baselineQuote = this.#baselineQuote;
    if (baseline === null || baselineQuote === null) {
      return Object.freeze({
        needed: true,
        quoteRef: next.quoteRef,
        reasons: Object.freeze(['no_confirmation'] as ReconfirmReason[]),
        baseline: null,
        priceDiff: null,
        amountDeltaMinor: 0,
        detail: REASON_DETAIL.no_confirmation,
      });
    }

    const priceDiff = diffQuotes(baselineQuote, next);
    const rawReasons: ReconfirmReason[] = [];

    if (baseline.paramsDigest !== next.paramsDigest) rawReasons.push('params_changed');
    if (priceDiff.changedKinds.some((kind) => PRICE_KINDS.has(kind))) rawReasons.push('price_changed');

    const now = this.#clock.now();
    if (now >= baselineQuote.expiresAt || now >= next.expiresAt) rawReasons.push('expired');

    const reasons = RECONFIRM_REASON_ORDER.filter((reason) => rawReasons.includes(reason));
    const detail =
      reasons.length === 0
        ? '确认仍然有效：参数、价格与期限均未变化'
        : reasons.map((reason) => REASON_DETAIL[reason]).join('；');

    return Object.freeze({
      needed: reasons.length > 0,
      quoteRef: next.quoteRef,
      reasons: Object.freeze(reasons),
      baseline,
      priceDiff,
      amountDeltaMinor: next.amount - baselineQuote.amount,
      detail,
    });
  }

  /** 便捷方法：是否需要重新确认。 */
  requiresReconfirmation(next: Quote): boolean {
    return this.assess(next).needed;
  }

  /** 产出可存档的精简证据（不含地址/账号等敏感字段）。 */
  evidenceFor(next: Quote): ReconfirmationEvidence {
    const request = this.assess(next);
    return Object.freeze({
      quoteRef: request.quoteRef,
      needed: request.needed,
      reasons: request.reasons,
      amountDeltaMinor: request.amountDeltaMinor,
      sameParamsDigest: request.priceDiff === null ? null : request.priceDiff.sameParamsDigest,
      changedKinds: request.priceDiff === null ? Object.freeze([]) : request.priceDiff.changedKinds,
    });
  }
}
