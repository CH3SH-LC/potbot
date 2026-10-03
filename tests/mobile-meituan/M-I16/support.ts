/**
 * M-I16 测试夹具（不是被收集的用例文件）。
 *
 * 与 M-R03 的 `support.ts` 等价，但把被提升的 `ReconfirmationGuard` 指向**生产源码**
 * `src/mobile-plugins/meituan/reconfirmation/`（而不是测试树里的副本）——集成验收
 * 必须打在真正的交付物上。
 *
 * 所有场景由**显式 fixture** 驱动：可控时钟 + 确定性计价端口。
 * 没有任何真实美团接口、没有网络、没有系统时间。
 *
 * 关键夹具能力：**可变的服务端计价配置**。同一份 `paramsDigest` 下，测试可以
 * 直接改动 `unitAmountsMinor` / `deliveryFeeMinor` / `couponDiscountsMinor`，
 * 再取一次价，就得到「参数不变、金额变了」的新报价——这正是本层要覆盖的
 * 服务端改价场景。fixture 端口每次调用都读同一个可变配置对象，因此改动立即生效。
 */

import {
  CartSession,
  FixtureClock,
  createFixtureQuotePort,
  type FixtureQuotePort,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { ReconfirmationGuard } from '../../../src/mobile-plugins/meituan/reconfirmation/index.js';
import type { Quote } from '../../../src/mobile-plugins/meituan/cart/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 1_000_000;

/** 默认报价有效期。 */
export const TTL_MS = 300_000;

interface CodeEntry {
  code: string;
  label: string;
  amountMinor: number;
}

/**
 * 可变的服务端计价配置。传给 `createFixtureQuotePort` 后，测试可原地修改其字段，
 * 模拟服务端调整单价/配送费/优惠。
 */
export interface MutableServerPricing {
  unitAmountsMinor: Record<string, number>;
  fees: CodeEntry[];
  deliveryFeeMinor: number;
  couponDiscountsMinor: Record<string, number>;
  ttlMs: number;
}

export interface Scenario {
  readonly session: CartSession;
  readonly clock: FixtureClock;
  readonly port: FixtureQuotePort;
  readonly guard: ReconfirmationGuard;
  /** 可原地修改的服务端计价配置。 */
  readonly server: MutableServerPricing;
}

/** 造一个完整场景。`T0` 起始时钟，`CNY`，默认两菜一茶价目表。 */
export function createScenario(): Scenario {
  const clock = new FixtureClock(T0);
  const server: MutableServerPricing = {
    unitAmountsMinor: { 'sku-noodle': 3800, 'sku-congee': 2200, 'sku-tea': 800 },
    fees: [{ code: 'packaging', label: '打包费', amountMinor: 100 }],
    deliveryFeeMinor: 300,
    couponDiscountsMinor: { 'COUPON-5': 500 },
    ttlMs: TTL_MS,
  };
  // 直接把**可变对象本身**交给端口：端口每次调用都从同一个对象读取
  // `unitAmountsMinor`/`deliveryFeeMinor`/`couponDiscountsMinor`，
  // 因此测试对这些字段的原地修改会立即反映到下一次出价。
  // （若传字面量拷贝，`deliveryFeeMinor` 这类标量会被按值复制，后续修改无效。）
  const port = createFixtureQuotePort(server);
  const session = new CartSession({ merchantId: 'merchant-1', currency: 'CNY', port, clock });
  const guard = new ReconfirmationGuard({ session, clock });
  return { session, clock, port, guard, server };
}

/** 加一份最常见的两菜车（面条 ×2 + 茶 ×1）并设好地址。 */
export function fillStandardCart(session: CartSession): void {
  session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
  session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
  session.cart.setDeliveryAddress('addr-home');
}

/** 勾选优惠码（会改变参数指纹，用于「用户改优惠」与「服务端改优惠额度」两类场景）。 */
export function selectCoupon(session: CartSession, code: string): void {
  session.cart.setPricingInputs({ couponCodes: [code] });
}

/**
 * 手工构造一份报价（**仅供 diffQuotes 的纯函数单测**，如币种变化、重复费用码聚合）。
 * 不走端口、不校验一致性——这里刻意允许制造端口不会产出的组合来单独测 diff 逻辑。
 */
export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return Object.freeze({
    quoteRef: 'q-1',
    merchantId: 'merchant-1',
    amount: 1000,
    currency: 'CNY',
    subtotalMinor: 1000,
    items: [],
    fees: [],
    discounts: [],
    expiresAt: T0 + TTL_MS,
    paramsDigest: 'v1-aaaaaaaa',
    pricedAt: T0,
    isOrderTotal: false,
    ...overrides,
  });
}
