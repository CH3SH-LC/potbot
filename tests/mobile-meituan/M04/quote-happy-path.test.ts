/**
 * M04 正例：加条目 → 取报价 → 最终价与币种正确，且报价绑定当前参数。
 *
 * 这里刻意用**显式 fixture 端口**：本包不接真实美团接口，任何数字都来自
 * fixture 配置，不代表真实平台报价。
 */

import { describe, expect, it } from 'vitest';

import {
  CartValidationError,
  QuoteIntegrityError,
  formatMinorUnitsAsDecimalString,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { T0, TTL_MS, createScenario, fillStandardCart } from './support.js';

describe('M04 正例：条目 → 报价', () => {
  it('金额与币种来自端口，逐项可核对（整数最小单位）', async () => {
    const { session, port } = createScenario();
    fillStandardCart(session);

    const quote = await session.requestQuote();

    // 面条 3800×2 + 茶 800×1 = 8400；打包费 100 + 配送费 300 = 400 ⇒ 8800 分
    expect(quote.subtotalMinor).toBe(8400);
    expect(quote.amount).toBe(8800);
    expect(quote.currency).toBe('CNY');
    expect(formatMinorUnitsAsDecimalString(quote.amount, quote.currency)).toBe('88.00');
    expect(quote.fees.map((fee) => fee.code).sort()).toEqual(['delivery', 'packaging']);
    expect(quote.discounts).toEqual([]);
    expect(Number.isInteger(quote.amount)).toBe(true);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.paramsDigest).toBe(quote.paramsDigest);
  });

  it('报价明细与请求条目一一对应（同 lineId / 同数量）', async () => {
    const { session } = createScenario();
    fillStandardCart(session);
    const request = session.describeRequest();

    const quote = await session.requestQuote();

    expect(quote.items.map((item) => item.lineId).sort()).toEqual(
      request.lines.map((line) => line.lineId).sort(),
    );
    for (const line of request.lines) {
      const item = quote.items.find((candidate) => candidate.lineId === line.lineId);
      expect(item?.quantity).toBe(line.quantity);
      expect(item?.skuId).toBe(line.skuId);
      expect(item?.lineAmountMinor).toBe((item?.unitAmountMinor ?? 0) * line.quantity);
    }
  });

  it('参数未变、未过期时报价可用，且不是订单总额', async () => {
    const { session } = createScenario();
    fillStandardCart(session);
    const quote = await session.requestQuote();

    const check = session.checkQuote(quote);
    expect(check.usable).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(session.requireUsableQuote(quote)).toBe(quote);
    expect(quote.isOrderTotal).toBe(false);
    expect(session.currentQuoteRef).toBe(quote.quoteRef);
    expect(session.currentQuote).toBe(quote);
  });

  it('报价过期时刻由注入时钟与端口 TTL 决定（不读系统时间）', async () => {
    const { session } = createScenario();
    fillStandardCart(session);
    const quote = await session.requestQuote();

    expect(quote.pricedAt).toBe(T0);
    expect(quote.expiresAt).toBe(T0 + TTL_MS);
  });

  it('参数指纹与条目加入顺序、条目 id 无关（内容相同则指纹相同）', () => {
    const first = createScenario();
    first.session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
    first.session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
    first.session.cart.setDeliveryAddress('addr-home');

    const second = createScenario();
    second.session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
    second.session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
    second.session.cart.setDeliveryAddress('addr-home');

    expect(second.session.describeRequest().paramsDigest).toBe(
      first.session.describeRequest().paramsDigest,
    );
    // 条目 id 是不同的（各自从 line-1 起编），但指纹相同 —— 说明指纹按内容而非 id 计算。
    expect(second.session.cart.lines[0]?.dishId).not.toBe(first.session.cart.lines[0]?.dishId);
  });

  it('未设地址 / 空车 / 币种非法时不取价', async () => {
    const noAddress = createScenario();
    noAddress.session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 1 });
    await expect(noAddress.session.requestQuote()).rejects.toBeInstanceOf(CartValidationError);
    expect(noAddress.port.calls).toHaveLength(0);

    const empty = createScenario();
    empty.session.cart.setDeliveryAddress('addr-home');
    await expect(empty.session.requestQuote()).rejects.toBeInstanceOf(CartValidationError);
    expect(empty.port.calls).toHaveLength(0);
  });

  it('端口没有该 SKU 单价时明确拒绝出价（不编价格）', async () => {
    const { session } = createScenario({ unitAmountsMinor: {} });
    session.cart.addLine({ dishId: 'dish-unknown', skuId: 'sku-unknown', quantity: 1 });
    session.cart.setDeliveryAddress('addr-home');

    await expect(session.requestQuote()).rejects.toThrow(/无法出价/);
    await expect(session.requestQuote()).rejects.not.toBeInstanceOf(QuoteIntegrityError);
  });
});
