/**
 * M04 金额纪律：
 * 1. 一切金额是**整数最小单位**，本地不做浮点累加；
 * 2. 端口返回的数字与条目对不上时，本地**报错**，绝不替它「修正」。
 */

import { describe, expect, it } from 'vitest';

import {
  CartValidationError,
  QuoteIntegrityError,
  asMinorUnits,
  formatMinorUnitsAsDecimalString,
  multiplyMinorUnits,
  sumMinorUnits,
  verifyQuoteAgainstRequest,
  type Quote,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { createScenario, fillStandardCart } from './support.js';

/** 0.1 元 = 10 分；0.2 元 = 20 分。 */
const TEN_FEN = 10;
const TWENTY_FEN = 20;

describe('M04 金额纪律：整数最小单位', () => {
  it('0.1 + 0.2 的场景：本地整数运算得到精确的 0.30 元', () => {
    // 先说清楚浮点世界里的样子（这就是本地绝不允许进入的世界）。
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(0.1 + 0.2).toBe(0.30000000000000004);

    // 本地口径：整数分累加，再按字符串位移渲染。
    const subtotal = sumMinorUnits([TEN_FEN, TWENTY_FEN], 'subtotal');
    expect(subtotal).toBe(30);
    expect(Number.isInteger(subtotal)).toBe(true);
    expect(formatMinorUnitsAsDecimalString(subtotal, 'CNY')).toBe('0.30');

    // 单价 × 数量同样是整数乘法。
    expect(multiplyMinorUnits(TEN_FEN, 3, 'line')).toBe(30);
    expect(formatMinorUnitsAsDecimalString(multiplyMinorUnits(TEN_FEN, 3, 'line'), 'CNY')).toBe('0.30');
  });

  it('非整数 / 负数 / NaN / Infinity 一律拒绝（不取整、不四舍五入）', () => {
    expect(() => asMinorUnits(0.1, 'amount')).toThrow(CartValidationError);
    expect(() => asMinorUnits(30.000000000000004, 'amount')).toThrow(CartValidationError);
    expect(() => asMinorUnits(-1, 'amount')).toThrow(CartValidationError);
    expect(() => asMinorUnits(Number.NaN, 'amount')).toThrow(CartValidationError);
    expect(() => asMinorUnits(Number.POSITIVE_INFINITY, 'amount')).toThrow(CartValidationError);
    expect(() => sumMinorUnits([10, 0.5], 'subtotal')).toThrow(CartValidationError);
    expect(() => multiplyMinorUnits(10.5, 2, 'line')).toThrow(CartValidationError);
    expect(() => formatMinorUnitsAsDecimalString(12.34, 'CNY')).toThrow(CartValidationError);
  });

  it('fixture 端口用整数分算价，浮点误差进不来', async () => {
    // 10 分 + 20 分的一单（0.10 元 + 0.20 元），无费用无优惠。
    const scenario = createScenario({
      unitAmountsMinor: { 'sku-cheap-a': TEN_FEN, 'sku-cheap-b': TWENTY_FEN },
      fees: [],
      deliveryFeeMinor: undefined,
    });
    scenario.session.cart.addLine({ dishId: 'dish-a', skuId: 'sku-cheap-a', quantity: 1 });
    scenario.session.cart.addLine({ dishId: 'dish-b', skuId: 'sku-cheap-b', quantity: 1 });
    scenario.session.cart.setDeliveryAddress('addr-home');

    const quote = await scenario.session.requestQuote();

    expect(quote.subtotalMinor).toBe(30);
    expect(quote.amount).toBe(30);
    expect(formatMinorUnitsAsDecimalString(quote.amount, quote.currency)).toBe('0.30');
  });
});

describe('M04 金额纪律：端口返回值不符 ⇒ 报错（本地不修正）', () => {
  it('端口返回浮点污染的总价 ⇒ 拒绝，而不是四舍五入', async () => {
    const scenario = createScenario({
      fees: [],
      deliveryFeeMinor: undefined,
      tamper: (quote: Quote) => ({ ...quote, amount: quote.amount + (0.1 + 0.2) }),
    });
    fillStandardCart(scenario.session);

    const failure = await scenario.session.requestQuote().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QuoteIntegrityError);
    expect((failure as QuoteIntegrityError).violations.join('|')).toMatch(/整数最小单位/);
  });

  it('端口算出的总价与「小计 - 折扣 + 费用」不符 ⇒ 报错', async () => {
    const scenario = createScenario({
      tamper: (quote: Quote) => ({ ...quote, amount: quote.amount - 1 }),
    });
    fillStandardCart(scenario.session);

    await expect(scenario.session.requestQuote()).rejects.toThrow(QuoteIntegrityError);
    await expect(scenario.session.requestQuote()).rejects.toThrow(/amount 与 subtotal/);
  });

  it('端口返回的小计与条目之和不符 ⇒ 报错', async () => {
    const scenario = createScenario({
      tamper: (quote: Quote) => ({ ...quote, subtotalMinor: quote.subtotalMinor + 100 }),
    });
    fillStandardCart(scenario.session);

    await expect(scenario.session.requestQuote()).rejects.toThrow(/subtotalMinor 与条目小计之和不符/);
  });

  it('端口未回显参数指纹 ⇒ 报错（报价无法绑定当前参数）', async () => {
    const scenario = createScenario({
      tamper: (quote: Quote) => ({ ...quote, paramsDigest: 'v1-deadbeef' }),
    });
    fillStandardCart(scenario.session);

    await expect(scenario.session.requestQuote()).rejects.toThrow(/paramsDigest 未回显/);
  });

  it('端口改换币种 ⇒ 报错', async () => {
    const scenario = createScenario({
      tamper: (quote: Quote) => ({ ...quote, currency: 'USD' }),
    });
    fillStandardCart(scenario.session);

    await expect(scenario.session.requestQuote()).rejects.toThrow(/currency 不符/);
  });

  it('端口漏条目 / 改数量 ⇒ 报错', async () => {
    const missing = createScenario({
      tamper: (quote: Quote) => ({ ...quote, items: quote.items.slice(0, 1) }),
    });
    fillStandardCart(missing.session);
    await expect(missing.session.requestQuote()).rejects.toThrow(/条目数不符/);

    const wrongQuantity = createScenario({
      tamper: (quote: Quote) => ({
        ...quote,
        items: quote.items.map((item, index) => (index === 0 ? { ...item, quantity: item.quantity + 1 } : item)),
      }),
    });
    fillStandardCart(wrongQuantity.session);
    await expect(wrongQuantity.session.requestQuote()).rejects.toThrow(/数量不符/);
  });

  it('校验失败时不会更新当前报价（坏报价进不来）', async () => {
    const scenario = createScenario({
      tamper: (quote: Quote) => ({ ...quote, amount: quote.amount + 1 }),
    });
    fillStandardCart(scenario.session);

    await expect(scenario.session.requestQuote()).rejects.toThrow(QuoteIntegrityError);
    expect(scenario.session.currentQuoteRef).toBeNull();
    expect(scenario.session.currentQuote).toBeNull();
  });

  it('校验函数可独立调用（不依赖会话）', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const request = scenario.session.describeRequest();
    const quote = await scenario.session.requestQuote();

    expect(() => verifyQuoteAgainstRequest(quote, request)).not.toThrow();
    expect(() =>
      verifyQuoteAgainstRequest({ ...quote, isOrderTotal: true } as unknown as Quote, request),
    ).toThrow(/isOrderTotal/);
  });
});
