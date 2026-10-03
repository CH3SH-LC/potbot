/**
 * M-R03 核心：**参数相同、服务端改价** ⇒ 旧确认失效，必须重新确认。
 *
 * 每个用例都先确认旧报价并断言「此前不需要重新确认」——否则「永远要求重新确认」
 * 的空壳实现也能通过，测试就没有意义。
 */

import { describe, expect, it } from 'vitest';

import { PriceDiffError, diffQuotes } from './index.js';
import { createScenario, fillStandardCart, makeQuote, selectCoupon } from './support.js';

describe('M-R03 服务端改价：配送费变化', () => {
  it('参数不变但配送费上调 ⇒ 检测到 fee_changed/amount_changed 并要求重新确认', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    // 确认之后、参数未动的前提下，服务端把配送费 300 → 500。
    server.deliveryFeeMinor = 500;
    const q2 = await session.requestQuote();

    // 关键前提：这是同一份参数，M04 的指纹判定看不出区别。
    expect(q2.paramsDigest).toBe(q1.paramsDigest);
    expect(q2.amount).toBe(q1.amount + 200);

    const request = guard.assess(q2);
    expect(request.needed).toBe(true);
    expect(request.reasons).toContain('price_changed');
    expect(request.amountDeltaMinor).toBe(200);
    expect(request.priceDiff?.sameParamsDigest).toBe(true);
    expect(request.priceDiff?.changedKinds).toContain('fee_changed');
    expect(request.priceDiff?.changedKinds).toContain('amount_changed');
    expect(request.priceDiff?.fees.find((fee) => fee.code === 'delivery')?.deltaMinor).toBe(200);
  });

  it('服务端免去配送费 ⇒ fee_changed 且金额下降可被读回（负 delta）', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.deliveryFeeMinor = 0;
    const q2 = await session.requestQuote();

    const request = guard.assess(q2);
    expect(request.needed).toBe(true);
    expect(request.amountDeltaMinor).toBe(-300);
    expect(request.priceDiff?.changedKinds).toContain('fee_changed');
  });
});

describe('M-R03 服务端改价：单价变化', () => {
  it('单价上调 ⇒ unit_price_changed，金额差 = 单价差 × 数量', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.unitAmountsMinor['sku-noodle'] = 4200; // 3800 → 4200，数量 2
    const q2 = await session.requestQuote();

    const request = guard.assess(q2);
    expect(request.needed).toBe(true);
    expect(request.priceDiff?.changedKinds).toContain('unit_price_changed');
    expect(request.amountDeltaMinor).toBe(800);
    const noodle = request.priceDiff?.items.find((item) => item.skuId === 'sku-noodle');
    expect(noodle?.previousUnitAmountMinor).toBe(3800);
    expect(noodle?.nextUnitAmountMinor).toBe(4200);
    expect(noodle?.deltaMinor).toBe(800);
  });
});

describe('M-R03 服务端改价：优惠变化', () => {
  it('优惠额度缩水 ⇒ discount_changed，总价随之上升', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    selectCoupon(session, 'COUPON-5');
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.couponDiscountsMinor['COUPON-5'] = 300; // 500 → 300
    const q2 = await session.requestQuote();

    const request = guard.assess(q2);
    expect(request.needed).toBe(true);
    expect(request.priceDiff?.changedKinds).toContain('discount_changed');
    expect(request.priceDiff?.discounts.find((discount) => discount.code === 'COUPON-5')?.deltaMinor).toBe(-200);
    expect(request.amountDeltaMinor).toBe(200);
  });
});

describe('M-R03 反空壳：条款一致时不得要求重新确认', () => {
  it('重新取价但条款完全一致 ⇒ 不需要重新确认', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');
    expect(guard.requiresReconfirmation(q1)).toBe(false);

    const q2 = await session.requestQuote(); // 新引用、同条款
    expect(q2.quoteRef).not.toBe(q1.quoteRef);

    const request = guard.assess(q2);
    expect(request.needed).toBe(false);
    expect(request.reasons).toEqual([]);
    expect(request.priceDiff?.changed).toBe(false);
    expect(request.amountDeltaMinor).toBe(0);
  });

  it('没有确认基线时一律要求先确认（no_confirmation）', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const quote = await session.requestQuote();

    const request = guard.assess(quote);
    expect(request.needed).toBe(true);
    expect(request.reasons).toEqual(['no_confirmation']);
    expect(request.baseline).toBeNull();
    expect(request.priceDiff).toBeNull();
  });
});

describe('M-R03 参数变化与服务端改价的区分', () => {
  it('用户改车 ⇒ params_changed（且金额差也可见）', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    session.cart.addLine({ dishId: 'dish-congee', skuId: 'sku-congee', quantity: 1 });
    const q2 = await session.requestQuote();

    const request = guard.assess(q2);
    expect(request.needed).toBe(true);
    expect(request.reasons).toContain('params_changed');
    expect(request.priceDiff?.sameParamsDigest).toBe(false);
    expect(request.priceDiff?.changedKinds).toContain('item_set_changed');
  });
});

describe('M-R03 diffQuotes 纯函数语义', () => {
  it('币种变化被显式标注', () => {
    const prev = makeQuote({ quoteRef: 'q-cny', currency: 'CNY' });
    const next = makeQuote({ quoteRef: 'q-usd', currency: 'USD' });
    const diff = diffQuotes(prev, next);
    expect(diff.changedKinds).toContain('currency_changed');
    expect(diff.currency).toBe('USD');
    expect(diff.changed).toBe(true);
  });

  it('同码多条费用先求和再比较（不按出现顺序漏判）', () => {
    const prev = makeQuote({
      fees: [
        { code: 'packaging', label: '打包费', amountMinor: 100 },
        { code: 'packaging', label: '打包费', amountMinor: 50 },
      ],
    });
    const next = makeQuote({
      fees: [{ code: 'packaging', label: '打包费', amountMinor: 150 }],
    });
    const diff = diffQuotes(prev, next);
    const packaging = diff.fees.find((fee) => fee.code === 'packaging');
    expect(packaging?.previousAmountMinor).toBe(150);
    expect(packaging?.nextAmountMinor).toBe(150);
    expect(diff.changedKinds).not.toContain('fee_changed');
  });

  it('金额不是整数最小单位时抛 PriceDiffError（不四舍五入、不替端口修正）', () => {
    const prev = makeQuote({ amount: 1000 });
    const next = makeQuote({ quoteRef: 'q-2', amount: 1000.5 });
    expect(() => diffQuotes(prev, next)).toThrow(PriceDiffError);
  });

  it('差异结果被冻结（不可被下游就地改写）', () => {
    const diff = diffQuotes(makeQuote(), makeQuote({ quoteRef: 'q-2' }));
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.changedKinds)).toBe(true);
  });
});
