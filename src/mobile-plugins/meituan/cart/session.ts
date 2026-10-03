/**
 * M04 报价生命周期：取价、校验、失效判定。
 *
 * ## 报价从哪来
 *
 * **只能**由注入的 `QuotePort` 产生。本地没有任何价格来源，因此也不存在
 * 「本地算一个价去下单」这条路——这是结构性保证，不是纪律约定。
 *
 * ## 本地能做什么、不能做什么
 *
 * 本地只做**一致性核对**（`verifyQuoteAgainstRequest`）：
 * 币种、条目一一对应、整数最小单位、`amount = subtotal - Σ折扣 + Σ费用`、
 * 参数指纹回显。任何一条对不上就**报错**（`QuoteIntegrityError`），
 * 绝不替端口「修正」金额——修正金额等于本地算价。
 *
 * ## 失效规则（本包核心）
 *
 * 以下任一变化 ⇒ 既有报价**判定失效**（返回显式原因，不静默沿用）：
 * 1. 条目增删改（含数量、规格）——改变参数指纹；
 * 2. 配送地址变化——改变参数指纹；
 * 3. 费用/优惠选择变化（优惠码、附加服务）——改变参数指纹；
 * 4. 报价过期——`clock.now() >= quote.expiresAt`（**注入时钟**，不读系统时间）；
 * 5. 被更新的报价取代，或被显式作废（如端口报告服务端费用变更）。
 */

import { CartState } from './cart.js';
import { computeParamsDigest } from './digest.js';
import { CartValidationError, QuoteIntegrityError, QuoteStaleError } from './errors.js';
import { isValidMinorUnits } from './money.js';
import { specsKey } from './specs.js';
import type {
  CartConfirmationDraft,
  Quote,
  QuoteCheck,
  QuoteClock,
  QuotePort,
  QuoteRequest,
  QuoteStaleReason,
} from './types.js';

/** 判定原因的固定顺序（便于验收逐条比对）。 */
export const QUOTE_STALE_REASON_ORDER: readonly QuoteStaleReason[] = Object.freeze([
  'not_current',
  'invalidated',
  'params_changed',
  'expired',
]);

const REASON_DETAIL: Readonly<Record<QuoteStaleReason, string>> = Object.freeze({
  not_current: '该报价不是本会话当前持有的报价（可能已被更新的报价取代）',
  invalidated: '该报价已被显式作废',
  params_changed: '购物车参数已变化（条目/数量/规格/地址/费用优惠），旧报价不再适用',
  expired: '报价已过期（注入时钟已到或已过 expiresAt）',
});

function sameSpecs(left: readonly { groupId: string; optionId: string }[], right: readonly { groupId: string; optionId: string }[]): boolean {
  return specsKey(left) === specsKey(right);
}

/**
 * 校验端口返回的报价与请求是否一致。**只核对，不修正**。
 *
 * @throws {QuoteIntegrityError} 任一条不一致时（含全部违规说明）。
 */
export function verifyQuoteAgainstRequest(quote: Quote, request: QuoteRequest): void {
  const violations: string[] = [];

  if (quote.paramsDigest !== request.paramsDigest) {
    violations.push(
      `paramsDigest 未回显：请求 ${request.paramsDigest}，报价 ${quote.paramsDigest}`,
    );
  }
  if (quote.merchantId !== request.merchantId) {
    violations.push(`merchantId 不符：请求 ${request.merchantId}，报价 ${quote.merchantId}`);
  }
  if (quote.currency !== request.currency) {
    violations.push(`currency 不符：请求 ${request.currency}，报价 ${quote.currency}`);
  }
  if (quote.isOrderTotal !== false) {
    violations.push('报价自称为订单总额（isOrderTotal 必须为 false）');
  }
  if (quote.items.length !== request.lines.length) {
    violations.push(`条目数不符：请求 ${request.lines.length} 条，报价 ${quote.items.length} 条`);
  }

  const itemsByLine = new Map(quote.items.map((item) => [item.lineId, item]));
  for (const line of request.lines) {
    const item = itemsByLine.get(line.lineId);
    if (item === undefined) {
      violations.push(`报价缺少条目 ${line.lineId}`);
      continue;
    }
    if (item.skuId !== line.skuId || item.dishId !== line.dishId) {
      violations.push(`条目 ${line.lineId} 的菜品/SKU 不符`);
    }
    if (!sameSpecs(item.specs, line.specs)) {
      violations.push(`条目 ${line.lineId} 的规格不符`);
    }
    if (item.quantity !== line.quantity) {
      violations.push(`条目 ${line.lineId} 的数量不符：请求 ${line.quantity}，报价 ${item.quantity}`);
    }
    if (!isValidMinorUnits(item.unitAmountMinor)) {
      violations.push(`条目 ${line.lineId} 的单价不是整数最小单位：${String(item.unitAmountMinor)}`);
      continue;
    }
    if (!isValidMinorUnits(item.lineAmountMinor)) {
      violations.push(`条目 ${line.lineId} 的小计不是整数最小单位：${String(item.lineAmountMinor)}`);
      continue;
    }
    const expected = item.unitAmountMinor * item.quantity;
    if (!Number.isSafeInteger(expected) || item.lineAmountMinor !== expected) {
      violations.push(
        `条目 ${line.lineId} 小计与单价×数量不符：${item.lineAmountMinor} ≠ ${item.unitAmountMinor}×${item.quantity}`,
      );
    }
  }

  collectAmountViolations(quote.items.map((item) => item.lineAmountMinor), '条目小计', violations, (total) => {
    if (total !== quote.subtotalMinor) {
      violations.push(`subtotalMinor 与条目小计之和不符：${quote.subtotalMinor} ≠ ${total}`);
    }
  });

  const feeAmounts = quote.fees.map((fee) => fee.amountMinor);
  const discountAmounts = quote.discounts.map((discount) => discount.amountMinor);
  for (let index = 0; index < quote.fees.length; index += 1) {
    const fee = quote.fees[index];
    if (fee !== undefined && !isValidMinorUnits(fee.amountMinor)) {
      violations.push(`费用 ${fee.code} 不是整数最小单位：${String(fee.amountMinor)}`);
    }
  }
  for (let index = 0; index < quote.discounts.length; index += 1) {
    const discount = quote.discounts[index];
    if (discount !== undefined && !isValidMinorUnits(discount.amountMinor)) {
      violations.push(`优惠 ${discount.code} 不是整数最小单位：${String(discount.amountMinor)}`);
    }
  }

  const feeTotal = sumOrNull(feeAmounts);
  const discountTotal = sumOrNull(discountAmounts);
  if (feeTotal !== null && discountTotal !== null && isValidMinorUnits(quote.subtotalMinor)) {
    if (!isValidMinorUnits(quote.amount)) {
      violations.push(`amount 不是整数最小单位：${String(quote.amount)}`);
    } else {
      const expected = quote.subtotalMinor + feeTotal - discountTotal;
      if (quote.amount !== expected) {
        violations.push(
          `amount 与 subtotal-折扣+费用 不符：${quote.amount} ≠ ${quote.subtotalMinor}+${feeTotal}-${discountTotal}=${expected}`,
        );
      }
    }
  }

  if (!Number.isFinite(quote.expiresAt) || quote.expiresAt <= 0) {
    violations.push(`expiresAt 非法：${String(quote.expiresAt)}`);
  }
  if (typeof quote.quoteRef !== 'string' || quote.quoteRef.length === 0) {
    violations.push('quoteRef 为空');
  }

  if (violations.length > 0) {
    throw new QuoteIntegrityError(violations);
  }
}

function sumOrNull(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!isValidMinorUnits(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function collectAmountViolations(
  values: readonly number[],
  label: string,
  violations: string[],
  check: (total: number) => void,
): void {
  const total = sumOrNull(values);
  if (total === null) {
    violations.push(`${label} 含非整数最小单位金额`);
    return;
  }
  check(total);
}

/** 会话构造参数：三个端口/状态之外没有别的输入，便于 fixture 独立驱动。 */
export interface CartSessionOptions {
  readonly merchantId: string;
  readonly currency: string;
  /** 报价的**唯一**来源。 */
  readonly port: QuotePort;
  /** 判过期用的**注入**时钟（不得读系统时间）。 */
  readonly clock: QuoteClock;
}

/**
 * 购物车会话：把「购物车状态」与「报价生命周期」绑在一起。
 *
 * 本类**没有**任何下单/支付方法（也不会有）；`boundary.test.ts` 会断言
 * 本包导出的符号里不存在这类能力。
 */
export class CartSession {
  readonly #cart: CartState;
  readonly #port: QuotePort;
  readonly #clock: QuoteClock;
  readonly #quotes = new Map<string, Quote>();
  readonly #invalidationReasons = new Map<string, string>();
  #currentQuoteRef: string | null = null;
  #draftSequence = 0;

  constructor(options: CartSessionOptions) {
    this.#cart = new CartState({ merchantId: options.merchantId, currency: options.currency });
    this.#port = options.port;
    this.#clock = options.clock;
  }

  /** 底层购物车状态（条目/地址/计价选择）。 */
  get cart(): CartState {
    return this.#cart;
  }

  get currency(): string {
    return this.#cart.currency;
  }

  get merchantId(): string {
    return this.#cart.merchantId;
  }

  /** 本会话当前持有的报价引用；从未取过价为 `null`。 */
  get currentQuoteRef(): string | null {
    return this.#currentQuoteRef;
  }

  /** 当前持有的报价对象；从未取过价为 `null`。 */
  get currentQuote(): Quote | null {
    if (this.#currentQuoteRef === null) return null;
    return this.#quotes.get(this.#currentQuoteRef) ?? null;
  }

  /**
   * 向注入的计价端口要一份报价。
   *
   * 流程：组装请求（含本地指纹）→ 端口取价 → **一致性校验** → 记为当前报价。
   * 端口返回值对不上时抛 `QuoteIntegrityError`，当前报价**不更新**。
   *
   * @throws {CartValidationError} 未设置配送地址时（计价需要地址参数）。
   * @throws {QuoteIntegrityError} 端口返回值与请求不一致时。
   */
  async requestQuote(): Promise<Quote> {
    if (this.#cart.lines.length === 0) {
      throw new CartValidationError('购物车为空，无法取价');
    }
    const request = this.#cart.buildRequest(this.#clock.now());
    if (request.delivery === null) {
      throw new CartValidationError('未设置配送地址，无法取价（地址变化同样会使报价失效）');
    }
    const quote = await this.#port.price(request);
    verifyQuoteAgainstRequest(quote, request);
    this.#quotes.set(quote.quoteRef, quote);
    this.#currentQuoteRef = quote.quoteRef;
    return quote;
  }

  /**
   * 判定一份报价现在还能不能用。**显式给出全部原因**，不静默沿用。
   *
   * 顺序固定：not_current → invalidated → params_changed → expired。
   */
  checkQuote(quote: Quote): QuoteCheck {
    const reasons: QuoteStaleReason[] = [];
    if (this.#currentQuoteRef !== quote.quoteRef) {
      reasons.push('not_current');
    }
    if (this.#invalidationReasons.has(quote.quoteRef)) {
      reasons.push('invalidated');
    }
    const liveDigest = computeParamsDigest(this.#cart.snapshot());
    if (liveDigest !== quote.paramsDigest) {
      reasons.push('params_changed');
    }
    if (this.#clock.now() >= quote.expiresAt) {
      reasons.push('expired');
    }
    const ordered = QUOTE_STALE_REASON_ORDER.filter((reason) => reasons.includes(reason));
    const detail =
      ordered.length === 0
        ? '报价可用：参数未变且未过期'
        : ordered
            .map((reason) => {
              if (reason === 'invalidated') {
                return `${REASON_DETAIL.invalidated}（${this.#invalidationReasons.get(quote.quoteRef) ?? '未注明原因'}）`;
              }
              return REASON_DETAIL[reason];
            })
            .join('；');
    return Object.freeze({
      usable: ordered.length === 0,
      quoteRef: quote.quoteRef,
      reasons: Object.freeze(ordered),
      detail,
    });
  }

  /**
   * 同上，但要求可用：不可用则抛 `QuoteStaleError`。
   * 这是「旧报价不能继续往下走」的关卡。
   */
  requireUsableQuote(quote: Quote): Quote {
    const check = this.checkQuote(quote);
    if (!check.usable) {
      throw new QuoteStaleError(quote.quoteRef, check.reasons, check.detail);
    }
    return quote;
  }

  /**
   * 显式作废当前报价。
   * 用于本地无法感知的变化（例如端口主动报告服务端配送费调整）。
   */
  invalidateCurrentQuote(reason: string): void {
    if (this.#currentQuoteRef === null) {
      throw new CartValidationError('当前没有可用报价，无法作废');
    }
    if (reason.trim().length === 0) {
      throw new CartValidationError('作废原因不能为空（失效必须看得见原因）');
    }
    this.#invalidationReasons.set(this.#currentQuoteRef, reason);
  }

  /**
   * 基于一份**可用**报价生成本地确认草稿。
   *
   * 草稿**不是**用户确认、**不是**下单授权（`authoritative: false`）；
   * 它只是把「报价失效 ⇒ 基于它的确认也失效」这条规则显式化，
   * 供 M06 的确认流程使用。报价不可用时直接抛 `QuoteStaleError`。
   */
  createConfirmationDraft(quote: Quote): CartConfirmationDraft {
    this.requireUsableQuote(quote);
    this.#draftSequence += 1;
    return Object.freeze({
      kind: 'local_draft_only',
      draftRef: `draft-${this.#draftSequence}`,
      quoteRef: quote.quoteRef,
      paramsDigest: quote.paramsDigest,
      merchantId: quote.merchantId,
      currency: quote.currency,
      amount: quote.amount,
      createdAt: this.#clock.now(),
      authoritative: false,
    });
  }

  /** 判定一份确认草稿是否仍然有效（其绑定的报价是否可用）。 */
  checkConfirmationDraft(draft: CartConfirmationDraft): QuoteCheck {
    const quote = this.#quotes.get(draft.quoteRef);
    if (quote === undefined) {
      return Object.freeze({
        usable: false,
        quoteRef: draft.quoteRef,
        reasons: Object.freeze(['not_current'] as QuoteStaleReason[]),
        detail: '草稿引用的报价不在本会话记录中，无法沿用',
      });
    }
    return this.checkQuote(quote);
  }

  /** 当前参数下的报价请求体（只读快照，用于证据/断言；不会触发端口调用）。 */
  describeRequest(): QuoteRequest {
    return this.#cart.buildRequest(this.#clock.now());
  }
}
