/**
 * M04 的 **fixture 实现**：可控时钟 + 确定性计价端口。
 *
 * ## 这不是真实美团能力
 *
 * 美团真实平台能力尚未核实（未登录、无 token、无工具清单），本包**不接真实接口**。
 * 这里的 `FixtureQuotePort` 只按本地配置表算价，用于**独立驱动与验证**模型本身；
 * 任何「成功」都来自显式 fixture 配置，**不构成**真实报价、订单或支付回执。
 * 真实实现由后续包提供（实现同一个 `QuotePort` 接口即可替换）。
 *
 * 两个 fixture 都是纯函数式的：不读系统时间、不读随机数、不读环境。
 */

import { QuotePortError } from './errors.js';
import { asMinorUnits, isValidMinorUnits } from './money.js';
import type {
  Quote,
  QuoteClock,
  QuoteDiscount,
  QuoteFee,
  QuoteItem,
  QuotePort,
  QuoteRequest,
} from './types.js';

/** 默认报价有效期（注入时钟域的逻辑毫秒）。 */
export const DEFAULT_QUOTE_TTL_MS = 5 * 60 * 1000;

/**
 * 可控时钟：时间只能被显式推进（与 `src/clock` 的 `LogicalClock` 同一纪律，
 * 但本包不依赖那个模块，保持零依赖）。
 */
export class FixtureClock implements QuoteClock {
  #now: number;
  #advances = 0;

  constructor(start = 0) {
    if (!Number.isFinite(start) || start < 0) {
      throw new QuotePortError(`fixture 时钟初值必须是非负有限数，收到 ${String(start)}`);
    }
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** 已发生的推进次数（可观测量）。 */
  get advanceCount(): number {
    return this.#advances;
  }

  /** 显式推进（只接受有限正数；0 步或倒流一律抛错，不静默）。 */
  advance(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      throw new QuotePortError(`时钟推进必须是有限正数，收到 ${String(deltaMs)}`);
    }
    this.#now += deltaMs;
    this.#advances += 1;
    return this.#now;
  }

  /** 推进到某一绝对时刻（目标必须晚于当前）。 */
  advanceTo(target: number): number {
    if (!Number.isFinite(target)) {
      throw new QuotePortError(`时钟目标必须是有限数，收到 ${String(target)}`);
    }
    return this.advance(target - this.#now);
  }
}

/** 计价端口 fixture 的配置。所有金额一律**整数最小单位**。 */
export interface FixtureQuotePortConfig {
  /** `skuId` → 单价（整数最小单位）。未知 SKU 会让端口拒绝出价。 */
  readonly unitAmountsMinor: Readonly<Record<string, number>>;
  /** `dishId` → 展示名（可选，仅用于报价明细）。 */
  readonly dishNames?: Readonly<Record<string, string>>;
  /** 每单固定费用（如打包费）。 */
  readonly fees?: readonly QuoteFee[];
  /** 配送费（整数最小单位）；给了就作为一条 `delivery` 费用。 */
  readonly deliveryFeeMinor?: number;
  /** 优惠码 → 抵扣金额（整数最小单位）；只有请求里勾选了的码才生效。 */
  readonly couponDiscountsMinor?: Readonly<Record<string, number>>;
  /** 每单固定优惠。 */
  readonly discounts?: readonly QuoteDiscount[];
  /** 报价有效期；默认 {@link DEFAULT_QUOTE_TTL_MS}。 */
  readonly ttlMs?: number;
  /** 报价引用前缀，默认 `fixture-quote`。 */
  readonly quoteRefPrefix?: string;
  /**
   * **故障注入（仅供负向对照）**：对刚生成的真报价做篡改，用来验证
   * 「端口返回与条目不符时本地必须报错，而不是替它修正」。
   */
  readonly tamper?: (quote: Quote, request: QuoteRequest) => Quote;
}

/** fixture 端口额外暴露的观测量。 */
export interface FixtureQuotePort extends QuotePort {
  /** 已收到的请求（按顺序），用于断言端口确实被调用、调用了几次。 */
  readonly calls: readonly QuoteRequest[];
}

/**
 * 确定性计价端口 fixture。
 *
 * 计算方式（全部整数运算）：`amount = subtotal - Σ折扣 + Σ费用`，
 * 并回显请求的 `paramsDigest`。
 */
export function createFixtureQuotePort(config: FixtureQuotePortConfig): FixtureQuotePort {
  const quoteRefPrefix = config.quoteRefPrefix ?? 'fixture-quote';
  const ttlMs = config.ttlMs ?? DEFAULT_QUOTE_TTL_MS;
  const calls: QuoteRequest[] = [];
  let sequence = 0;

  const buildItems = (request: QuoteRequest): QuoteItem[] =>
    request.lines.map((line) => {
      const unit = config.unitAmountsMinor[line.skuId];
      if (unit === undefined) {
        throw new QuotePortError(`fixture 端口没有 ${line.skuId} 的单价，无法出价`);
      }
      const unitAmountMinor = asMinorUnits(unit, `unitAmountsMinor[${line.skuId}]`);
      return Object.freeze({
        lineId: line.lineId,
        dishId: line.dishId,
        skuId: line.skuId,
        specs: line.specs,
        quantity: line.quantity,
        unitAmountMinor,
        lineAmountMinor: unitAmountMinor * line.quantity,
      });
    });

  const buildFees = (): QuoteFee[] => {
    const fees: QuoteFee[] = [...(config.fees ?? [])];
    if (config.deliveryFeeMinor !== undefined) {
      fees.push({
        code: 'delivery',
        label: '配送费',
        amountMinor: asMinorUnits(config.deliveryFeeMinor, 'deliveryFeeMinor'),
      });
    }
    return fees.map((fee) => Object.freeze({ ...fee }));
  };

  const buildDiscounts = (request: QuoteRequest): QuoteDiscount[] => {
    const discounts: QuoteDiscount[] = [...(config.discounts ?? [])];
    for (const code of request.pricing.couponCodes) {
      const amount = config.couponDiscountsMinor?.[code];
      if (amount === undefined) {
        throw new QuotePortError(`fixture 端口不认识优惠码 ${code}`);
      }
      discounts.push({ code, label: `优惠 ${code}`, amountMinor: asMinorUnits(amount, `coupon ${code}`) });
    }
    return discounts.map((discount) => Object.freeze({ ...discount }));
  };

  return {
    get calls(): readonly QuoteRequest[] {
      return Object.freeze([...calls]);
    },
    async price(request: QuoteRequest): Promise<Quote> {
      calls.push(request);
      sequence += 1;
      const items = buildItems(request);
      const fees = buildFees();
      const discounts = buildDiscounts(request);
      const subtotalMinor = items.reduce((total, item) => total + item.lineAmountMinor, 0);
      const feeTotal = fees.reduce((total, fee) => total + fee.amountMinor, 0);
      const discountTotal = discounts.reduce((total, discount) => total + discount.amountMinor, 0);
      const amount = subtotalMinor + feeTotal - discountTotal;
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new QuotePortError(`fixture 端口算出的总价非法：${String(amount)}（fixture 配置有误）`);
      }
      const quote: Quote = Object.freeze({
        quoteRef: `${quoteRefPrefix}-${sequence}`,
        merchantId: request.merchantId,
        amount,
        currency: request.currency,
        subtotalMinor,
        items: Object.freeze(items),
        fees: Object.freeze(fees),
        discounts: Object.freeze(discounts),
        expiresAt: request.requestedAt + ttlMs,
        paramsDigest: request.paramsDigest,
        pricedAt: request.requestedAt,
        isOrderTotal: false,
      });
      if (config.tamper !== undefined) {
        return config.tamper(quote, request);
      }
      return quote;
    },
  };
}

/** 断言金额口径的小工具（fixture/测试共用）：非整数最小单位即抛错。 */
export function assertIntegerMinorUnits(value: number, label: string): number {
  if (!isValidMinorUnits(value)) {
    throw new QuotePortError(`${label} 必须是整数最小单位，收到 ${String(value)}`);
  }
  return value;
}
