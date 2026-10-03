/**
 * M04 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景都由**显式 fixture** 驱动：可控时钟 + 确定性计价端口。
 * 这里没有任何真实美团接口、没有网络、没有系统时间。
 */

import {
  CartSession,
  FixtureClock,
  createFixtureQuotePort,
  type FixtureQuotePort,
  type FixtureQuotePortConfig,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 1_000_000;

/** 默认报价有效期。 */
export const TTL_MS = 300_000;

/** 默认菜单单价（整数最小单位：分）。 */
export const DEFAULT_UNIT_AMOUNTS: Readonly<Record<string, number>> = Object.freeze({
  'sku-noodle': 3800,
  'sku-congee': 2200,
  'sku-tea': 800,
});

export interface Scenario {
  readonly session: CartSession;
  readonly clock: FixtureClock;
  readonly port: FixtureQuotePort;
}

/** 造一个完整场景（商家 / 币种 / 端口 / 时钟都可替换）。 */
export function createScenario(overrides: Partial<FixtureQuotePortConfig> = {}): Scenario {
  const clock = new FixtureClock(T0);
  const port = createFixtureQuotePort({
    unitAmountsMinor: DEFAULT_UNIT_AMOUNTS,
    fees: [{ code: 'packaging', label: '打包费', amountMinor: 100 }],
    deliveryFeeMinor: 300,
    couponDiscountsMinor: { 'COUPON-5': 500 },
    ttlMs: TTL_MS,
    ...overrides,
  });
  const session = new CartSession({
    merchantId: 'merchant-1',
    currency: 'CNY',
    port,
    clock,
  });
  return { session, clock, port };
}

/** 加一份最常见的两菜车（面条 ×2 + 茶 ×1）并设好地址。 */
export function fillStandardCart(session: CartSession): void {
  session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
  session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
  session.cart.setDeliveryAddress('addr-home');
}
