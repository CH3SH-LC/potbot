/**
 * M04 过期：报价是否过期**只由注入时钟**决定（不读系统时间）。
 *
 * 边界口径：`clock.now() >= quote.expiresAt` 即过期（到达即失效）。
 */

import { describe, expect, it } from 'vitest';

import { QuoteStaleError } from '../../../src/mobile-plugins/meituan/cart/index.js';
import { T0, TTL_MS, createScenario, fillStandardCart } from './support.js';

describe('M04 报价过期', () => {
  it('推进到 expiresAt 之前仍然可用', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.clock.advance(TTL_MS - 1);

    expect(scenario.clock.now()).toBe(quote.expiresAt - 1);
    expect(scenario.session.checkQuote(quote).usable).toBe(true);
  });

  it('推进到 expiresAt 即失效', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.clock.advanceTo(quote.expiresAt);

    const check = scenario.session.checkQuote(quote);
    expect(check.usable).toBe(false);
    expect(check.reasons).toEqual(['expired']);
    expect(() => scenario.session.requireUsableQuote(quote)).toThrow(QuoteStaleError);
  });

  it('越过 expiresAt 后仍然失效', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.clock.advance(TTL_MS * 10);

    expect(scenario.session.checkQuote(quote).reasons).toEqual(['expired']);
  });

  it('过期的报价不能生成确认草稿', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.clock.advance(TTL_MS);

    expect(() => scenario.session.createConfirmationDraft(quote)).toThrow(QuoteStaleError);
  });

  it('过期与参数变化可以同时成立，两个原因都给出', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.session.cart.setLineQuantity(scenario.session.cart.lines[0]?.lineId ?? '', 4);
    scenario.clock.advance(TTL_MS);

    expect(scenario.session.checkQuote(quote).reasons).toEqual(['params_changed', 'expired']);
  });

  it('重新取价得到新报价（新的过期时刻），旧报价仍过期', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const first = await scenario.session.requestQuote();

    scenario.clock.advance(TTL_MS);
    const second = await scenario.session.requestQuote();

    expect(second.quoteRef).not.toBe(first.quoteRef);
    expect(second.expiresAt).toBe(T0 + TTL_MS * 2);
    expect(scenario.session.checkQuote(second).usable).toBe(true);
    expect(scenario.session.checkQuote(first).usable).toBe(false);
    expect(scenario.session.checkQuote(first).reasons).toEqual(['not_current', 'expired']);
  });

  it('时钟只接受有限正数推进（0 / 负数 / NaN 都抛错）', () => {
    const scenario = createScenario();

    expect(() => scenario.clock.advance(0)).toThrow();
    expect(() => scenario.clock.advance(-1)).toThrow();
    expect(() => scenario.clock.advance(Number.NaN)).toThrow();
    expect(scenario.clock.advanceCount).toBe(0);
    expect(scenario.clock.now()).toBe(T0);
  });

  it('TTL 为 0 的报价立即过期', async () => {
    const scenario = createScenario({ ttlMs: 0 });
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    expect(quote.expiresAt).toBe(T0);
    expect(scenario.session.checkQuote(quote).reasons).toEqual(['expired']);
  });
});
