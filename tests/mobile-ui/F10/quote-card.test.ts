/**
 * F10 验收：报价卡「过期 ⇒ 强制重新确认」。
 *
 * 用**真实的 M04 会话**（`CartSession` + `FixtureClock` + `FixtureQuotePort`）驱动，
 * 不是自造 mock：
 *   - 报价卡的可确认性必须与 `CartSession.checkQuote()` 的判定**逐字一致**；
 *   - 过期后 `evaluateQuoteConfirmation()` 必须拒绝并置 `requiresReconfirmation`；
 *   - 重新取价得到新报价后，旧报价卡必须变为 `superseded` 且不可确认；
 *   - 观测量：过期状态下底层 `requireUsableQuote` 必须抛 `QuoteStaleError`
 *     （F10 卡与 M04 闸门不得互相矛盾）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildQuoteCard,
  evaluateQuoteConfirmation,
  requiresReconfirmation,
} from '../../../apps/mobile-ui/src/food/index.js';
import {
  CartSession,
  DEFAULT_QUOTE_TTL_MS,
  FixtureClock,
  QuoteStaleError,
  createFixtureQuotePort,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

const MERCHANT = 'store-1';
const CURRENCY = 'CNY';
const ADDRESS_REF = 'addr-1#v1';
const T0 = 1000;

function makeSession() {
  const clock = new FixtureClock(T0);
  const port = createFixtureQuotePort({
    unitAmountsMinor: { 'sku-a': 2500 },
    deliveryFeeMinor: 300,
  });
  const session = new CartSession({ merchantId: MERCHANT, currency: CURRENCY, port, clock });
  session.cart.addLine({
    dishId: 'dish-a',
    skuId: 'sku-a',
    specs: [{ groupId: 'spiciness', optionId: 'mild' }],
    quantity: 2,
  });
  session.cart.setDeliveryAddress(ADDRESS_REF);
  return { session, clock, port };
}

describe('F10 报价卡 · 可用报价', () => {
  it('金额只来自端口，展示为十进制字符串（2500 分 × 2 + 300 分配送费 = 53.00）', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const card = buildQuoteCard(session, quote);

    expect(quote.amount).toBe(5300);
    expect(card.total.amountMinor).toBe(5300);
    expect(card.total.display).toBe('53.00');
    expect(card.subtotal.display).toBe('50.00');
    expect(card.items).toHaveLength(1);
    expect(card.items[0]?.unitPrice.display).toBe('25.00');
    expect(card.items[0]?.lineTotal.display).toBe('50.00');
    expect(card.fees.map((fee) => `${fee.code}:${fee.amount.display}`)).toEqual(['delivery:3.00']);
    expect(card.isOrderTotal).toBe(false);
  });

  it('可用报价：confirmable 为真、要求动作为 confirm、确认成立', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const card = buildQuoteCard(session, quote);

    expect(card.state).toBe('usable');
    expect(card.confirmable).toBe(true);
    expect(card.requiredUserAction).toBe('confirm');
    expect(requiresReconfirmation(card)).toBe(false);

    const outcome = evaluateQuoteConfirmation(card, quote.quoteRef);
    expect(outcome.ok).toBe(true);
    expect(outcome.requiresReconfirmation).toBe(false);
    expect(outcome.rejection).toBeNull();
  });
});

describe('F10 报价卡 · 过期强制重新确认', () => {
  it('时钟越过 expiresAt ⇒ 卡转 expired、不可确认、要求 re-quote，确认被拒', async () => {
    const { session, clock } = makeSession();
    const quote = await session.requestQuote();

    clock.advance(DEFAULT_QUOTE_TTL_MS); // now == expiresAt ⇒ 按 M04 口径已过期
    expect(clock.now()).toBe(quote.expiresAt);

    const card = buildQuoteCard(session, quote);
    expect(card.state).toBe('expired');
    expect(card.staleReasons).toContain('expired');
    expect(card.confirmable).toBe(false);
    expect(card.requiredUserAction).toBe('re-quote');
    expect(requiresReconfirmation(card)).toBe(true);

    const outcome = evaluateQuoteConfirmation(card, quote.quoteRef);
    expect(outcome.ok).toBe(false);
    expect(outcome.rejection).toBe('quote_expired');
    expect(outcome.requiresReconfirmation).toBe(true);
    expect(outcome.message).toContain('重新');
  });

  it('过期状态下 M04 闸门同样抛 QuoteStaleError（F10 卡与 M04 判定一致）', async () => {
    const { session, clock } = makeSession();
    const quote = await session.requestQuote();
    clock.advance(DEFAULT_QUOTE_TTL_MS + 1);

    expect(() => session.requireUsableQuote(quote)).toThrow(QuoteStaleError);
    expect(buildQuoteCard(session, quote).confirmable).toBe(false);
  });

  it('重新取价得到新报价后，旧报价卡变为 superseded 且不可确认（时钟未推进，故只有被取代）', async () => {
    const { session } = makeSession();
    const first = await session.requestQuote();
    // 不推进时钟：旧报价只是被取代，并未过期——用来单独验证 superseded 路径。
    const second = await session.requestQuote();
    expect(second.quoteRef).not.toBe(first.quoteRef);

    const oldCard = buildQuoteCard(session, first);
    expect(oldCard.state).toBe('superseded');
    expect(oldCard.staleReasons).toContain('not_current');
    expect(oldCard.staleReasons).not.toContain('expired');
    expect(oldCard.confirmable).toBe(false);

    const oldOutcome = evaluateQuoteConfirmation(oldCard, first.quoteRef);
    expect(oldOutcome.ok).toBe(false);
    expect(oldOutcome.rejection).toBe('quote_superseded');

    const newCard = buildQuoteCard(session, second);
    expect(newCard.state).toBe('usable');
    expect(evaluateQuoteConfirmation(newCard, second.quoteRef).ok).toBe(true);
  });

  it('同时过期且被取代 ⇒ 状态优先显示 expired（过期优先于被取代）', async () => {
    const { session, clock } = makeSession();
    const first = await session.requestQuote();
    clock.advance(DEFAULT_QUOTE_TTL_MS + 1);
    const second = await session.requestQuote();

    const oldCard = buildQuoteCard(session, first);
    expect(oldCard.staleReasons).toContain('not_current');
    expect(oldCard.staleReasons).toContain('expired');
    expect(oldCard.state).toBe('expired');
    expect(oldCard.requiredUserAction).toBe('re-quote');
  });
});

describe('F10 报价卡 · 参数变化与旧引用', () => {
  it('购物车参数变化（加一条）⇒ 报价转 stale、不可确认', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();

    session.cart.addLine({ dishId: 'dish-b', skuId: 'sku-a', quantity: 1 });

    const card = buildQuoteCard(session, quote);
    expect(card.state).toBe('stale');
    expect(card.staleReasons).toContain('params_changed');
    expect(card.confirmable).toBe(false);
    expect(evaluateQuoteConfirmation(card, quote.quoteRef).rejection).toBe('quote_params_changed');
  });

  it('确认引用的 quoteRef 与卡不一致 ⇒ stale_quote_ref、必须重新确认', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const card = buildQuoteCard(session, quote);

    const outcome = evaluateQuoteConfirmation(card, 'some-old-quote-ref');
    expect(outcome.ok).toBe(false);
    expect(outcome.rejection).toBe('stale_quote_ref');
    expect(outcome.requiresReconfirmation).toBe(true);
  });

  it('显式作废当前报价 ⇒ 卡转 invalidated、不可确认', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    session.invalidateCurrentQuote('fixture：服务端配送费调整');

    const card = buildQuoteCard(session, quote);
    expect(card.state).toBe('invalidated');
    expect(card.confirmable).toBe(false);
    expect(evaluateQuoteConfirmation(card, quote.quoteRef).rejection).toBe('quote_invalidated');
  });
});
