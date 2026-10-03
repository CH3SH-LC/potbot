/**
 * M-I16（M-R03 提升）—— 报价过期与重新确认（打在**生产源码**上）。
 *
 * 过期口径与 M04 一致：`clock.now() >= quote.expiresAt` 即过期（**到达即失效**，
 * 边界闭合）。本层补的是：过期同样使旧确认作废、必须重新确认——即使价格一分未变。
 * 时间只由注入时钟推进，不读系统时间。
 */

import { describe, expect, it } from 'vitest';

import { QuoteStaleError } from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  isQuoteExpired,
  quoteExpiresInMs,
} from '../../../src/mobile-plugins/meituan/reconfirmation/index.js';
import { TTL_MS, createScenario, fillStandardCart } from './support.js';

describe('M-I16 过期口径：expiresAt 边界闭合', () => {
  it('expiresAt 之前未过期，到达即过期', () => {
    const quote = Object.freeze({
      quoteRef: 'q',
      merchantId: 'm',
      amount: 1,
      currency: 'CNY',
      subtotalMinor: 1,
      items: Object.freeze([]),
      fees: Object.freeze([]),
      discounts: Object.freeze([]),
      expiresAt: 100,
      paramsDigest: 'v1-x',
      pricedAt: 0,
      isOrderTotal: false as const,
    });
    expect(isQuoteExpired(quote, 99)).toBe(false);
    expect(isQuoteExpired(quote, 100)).toBe(true);
    expect(isQuoteExpired(quote, 101)).toBe(true);
    expect(quoteExpiresInMs(quote, 99)).toBe(1);
    expect(quoteExpiresInMs(quote, 130)).toBe(-30);
  });
});

describe('M-I16 过期 ⇒ 重新确认', () => {
  it('报价过期后重新取价（条款不变）⇒ 仍要求重新确认，原因为 expired', async () => {
    const { session, clock, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    clock.advance(TTL_MS); // 恰好到达 q1.expiresAt
    const q2 = await session.requestQuote();

    expect(q2.amount).toBe(q1.amount); // 价格分毫未变
    expect(q2.paramsDigest).toBe(q1.paramsDigest);

    const request = guard.assess(q2);
    expect(request.needed).toBe(true);
    expect(request.reasons).toEqual(['expired']);
    expect(request.priceDiff?.changed).toBe(false); // 价格没变
  });

  it('重新确认后旧确认被取代，且不再要求重新确认', async () => {
    const { session, clock, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    clock.advance(TTL_MS);
    const q2 = await session.requestQuote();
    expect(guard.requiresReconfirmation(q2)).toBe(true);

    const baseline = guard.confirm(q2, 'confirm-2');
    expect(baseline.confirmationRef).toBe('confirm-2');
    expect(baseline.confirmedQuoteRef).toBe(q2.quoteRef);
    expect(guard.confirmationCount).toBe(2);
    expect(guard.requiresReconfirmation(q2)).toBe(false);
  });

  it('已过期的报价不允许被确认（关卡前移，抛 M04 QuoteStaleError）', async () => {
    const { session, clock, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    clock.advance(TTL_MS);
    expect(() => guard.confirm(q1, 'confirm-too-late')).toThrow(QuoteStaleError);
  });

  it('过期与服务端改价同时成立 ⇒ 两个原因都给出（顺序固定 price_changed→expired）', async () => {
    const { session, clock, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.deliveryFeeMinor = 500;
    clock.advance(TTL_MS);
    const q2 = await session.requestQuote();

    const request = guard.assess(q2);
    expect(request.reasons).toEqual(['price_changed', 'expired']);
    expect(request.needed).toBe(true);
  });

  it('参数变化与服务端改价同时成立 ⇒ 原因顺序固定 params_changed→price_changed', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.deliveryFeeMinor = 500;
    session.cart.addLine({ dishId: 'dish-congee', skuId: 'sku-congee', quantity: 1 });
    const q2 = await session.requestQuote();

    expect(guard.assess(q2).reasons).toEqual(['params_changed', 'price_changed']);
  });

  it('清除基线后回到「必须先确认」状态', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');
    expect(guard.requiresReconfirmation(q1)).toBe(false);

    guard.clear();
    expect(guard.baseline).toBeNull();
    expect(guard.assess(q1).reasons).toEqual(['no_confirmation']);
  });

  it('省略确认引用时生成本地确定性引用（可追溯、不依赖随机数）', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    const baseline = guard.confirm(q1); // 不传 ref
    expect(baseline.confirmationRef).toBe('local-confirm-1');
  });

  it('空白确认引用被拒绝（不静默接受）', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    expect(() => guard.confirm(q1, '   ')).toThrow();
    expect(guard.baseline).toBeNull();
  });
});

describe('M-I16 evidenceFor：可存档的精简证据', () => {
  it('记录原因、金额差与变化种类，且不含地址等敏感字段', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');
    server.deliveryFeeMinor = 500;
    const q2 = await session.requestQuote();

    const evidence = guard.evidenceFor(q2);
    expect(evidence.needed).toBe(true);
    expect(evidence.reasons).toContain('price_changed');
    expect(evidence.amountDeltaMinor).toBe(200);
    expect(evidence.sameParamsDigest).toBe(true);
    expect(evidence.changedKinds).toContain('fee_changed');
    // 证据里不得出现地址明文（敏感性由 M05 口径约束）。
    expect(JSON.stringify(evidence)).not.toContain('addr-home');
  });

  it('无基线时证据不伪造差异（sameParamsDigest=null、changedKinds 为空）', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const quote = await session.requestQuote();
    const evidence = guard.evidenceFor(quote);
    expect(evidence.needed).toBe(true);
    expect(evidence.reasons).toEqual(['no_confirmation']);
    expect(evidence.sameParamsDigest).toBeNull();
    expect(evidence.changedKinds).toEqual([]);
  });
});
