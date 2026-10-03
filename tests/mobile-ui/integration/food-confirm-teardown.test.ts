/**
 * 跨模块集成（F10 food ↔ F05 decisions）：报价喂给确认卡，报价到期即拆卡并重新取价。
 *
 * 这是 wave-1 的 F10 integrationRequest 里点名的接缝：「报价卡 → F05 公共确认卡」当时只到
 * 单元层。本文件用**真实的 M04 计价会话**（CartSession + FixtureClock + FixtureQuotePort）喂
 * **真实的 F05 确认卡构造 / 闸门**，机器化锁住：
 *   I-1 同源：可用报价产出的 F05 卡，其金额 / 期限 / 报价引用与 M04 报价**逐字一致**；
 *   I-2 拆卡：报价到期（`now >= expiresAt`）后，**同一张** F05 卡在闸门上判 `expired`——
 *       报价一次性授权窗口与确认卡窗口同生共死，不会出现「F10 说过期、F05 说还能确认」；
 *   I-3 重取：过期报价**再也产不出**确认卡（`quote_expired` + `requiresReconfirmation`），
 *       必须重新取价；重新取价后新报价绑成新卡，旧卡引用作废；
 *   I-4 边界：F10 接线层**不自签授权、不下单**（`FOOD_ADAPTER_BOUNDARY`），未注入原生信任
 *       端口即拒（`native-trust-unavailable`），绝不本地自签冒充「用户已批准」。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/integration/food-confirm-teardown.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  buildQuoteCard,
  buildQuoteConfirmCard,
  confirmQuote,
  evaluateQuoteConfirmation,
  FOOD_ADAPTER_BOUNDARY,
  requiresReconfirmation,
  type QuoteConfirmCardResult,
} from '../../../apps/mobile-ui/src/food/index.js';
import {
  assessVisibility,
  evaluateConfirmGate,
  isCardActionable,
} from '../../../apps/mobile-ui/src/decisions/index.js';
import {
  CartSession,
  DEFAULT_QUOTE_TTL_MS,
  FixtureClock,
  createFixtureQuotePort,
  epochToIso8601,
  minorUnitsToWireAmount,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

const MERCHANT = 'store-1';
const CURRENCY = 'CNY';
const ADDRESS_REF = 'addr-1#v1';
const T0 = 1000;
const DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
const CARD_ID = 'card-quote-1';
const ACTION_ID = 'act-quote-1';

/** 真实的 M04 会话：一条菜品 ×2 + 配送费 3.00。 */
function makeSession(): { session: CartSession; clock: FixtureClock } {
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
  return { session, clock };
}

function bindCard(quoteCard: ReturnType<typeof buildQuoteCard>): QuoteConfirmCardResult {
  return buildQuoteConfirmCard({
    quoteCard,
    cardId: CARD_ID,
    actionId: ACTION_ID,
    accountRef: 'acct:food',
    paramsDigest: DIGEST,
    objectLabel: 'fixture 火锅店',
  });
}

// ===========================================================================
// I-1 同源：报价 → F05 卡
// ===========================================================================

describe('集成 F10↔F05 · 可用报价喂给确认卡', () => {
  it('可用报价 ⇒ 产卡；金额 / 期限 / 报价引用与 M04 报价逐字一致、三项可见', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const quoteCard = buildQuoteCard(session, quote);
    expect(quoteCard.confirmable).toBe(true);

    const built = bindCard(quoteCard);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(`预期产卡，实际拒绝：${built.rejection}`);

    expect(built.card.quoteRef).toBe(quote.quoteRef);
    expect(built.card.price?.amount).toBe(minorUnitsToWireAmount(quote.amount, CURRENCY));
    expect(built.card.price?.amount).toBe('53.00');
    expect(built.card.price?.currency).toBe(CURRENCY);
    expect(built.card.subject.objectRef).toBe(MERCHANT);
    expect(built.card.scope).toBe('submit-order');
    expect(built.card.expiresAt).toBe(epochToIso8601(quote.expiresAt));
    expect(assessVisibility(built.card).visible).toBe(true);

    // F05 闸门在报价有效期内通过（请求引用卡的 revision）。
    const gate = evaluateConfirmGate(built.card, {
      actionId: ACTION_ID,
      taskRevision: built.card.taskRevision,
      now: epochToIso8601(quote.pricedAt),
    });
    expect(gate.ok).toBe(true);
  });
});

// ===========================================================================
// I-2 拆卡：报价到期，同一张 F05 卡在闸门上到期
// ===========================================================================

describe('集成 F10↔F05 · 报价到期即拆卡（同生共死）', () => {
  it('时钟越过报价 TTL ⇒ 已建的 F05 卡在到点判 expired、不可提交', async () => {
    const { session, clock } = makeSession();
    const quote = await session.requestQuote();
    const built = bindCard(buildQuoteCard(session, quote));
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('预期产卡');

    // 到期前可提交。
    expect(isCardActionable(built.card, epochToIso8601(quote.pricedAt))).toBe(true);

    // 报价 TTL 到期（now == expiresAt，M04 口径「到点即失效」）。
    clock.advance(DEFAULT_QUOTE_TTL_MS);
    expect(clock.now()).toBe(quote.expiresAt);

    expect(isCardActionable(built.card, epochToIso8601(quote.expiresAt))).toBe(false);
    const gate = evaluateConfirmGate(built.card, {
      actionId: ACTION_ID,
      taskRevision: built.card.taskRevision,
      now: epochToIso8601(quote.expiresAt),
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('expired');
  });
});

// ===========================================================================
// I-3 重取：过期报价产不出卡，必须重新取价
// ===========================================================================

describe('集成 F10↔F05 · 过期报价强制重新取价', () => {
  it('过期报价 ⇒ 拒绝且产不出确认卡（quote_expired + requiresReconfirmation）', async () => {
    const { session, clock } = makeSession();
    const quote = await session.requestQuote();
    clock.advance(DEFAULT_QUOTE_TTL_MS);

    const expiredCard = buildQuoteCard(session, quote);
    expect(expiredCard.state).toBe('expired');
    expect(requiresReconfirmation(expiredCard)).toBe(true);

    const built = bindCard(expiredCard);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.rejection).toBe('quote_expired');
      expect(built.requiresReconfirmation).toBe(true);
      expect(built.message).toContain('重新');
    }
    expect('card' in built).toBe(false);
    expect(evaluateQuoteConfirmation(expiredCard, quote.quoteRef).ok).toBe(false);
  });

  it('重新取价 ⇒ 新报价绑成新卡，旧报价引用作废、旧卡不可复用', async () => {
    const { session, clock } = makeSession();
    const first = await session.requestQuote();
    const firstCard = bindCard(buildQuoteCard(session, first));
    expect(firstCard.ok).toBe(true);
    if (!firstCard.ok) throw new Error('预期首卡产卡');

    // 越过 TTL 后重新取价：旧报价同时过期且被取代，新报价可用。
    clock.advance(DEFAULT_QUOTE_TTL_MS + 1);
    const second = await session.requestQuote();
    expect(second.quoteRef).not.toBe(first.quoteRef);

    const oldQuoteCard = buildQuoteCard(session, first);
    expect(oldQuoteCard.confirmable).toBe(false);
    expect(oldQuoteCard.state).toBe('expired');
    expect(oldQuoteCard.staleReasons).toContain('not_current');

    // 旧报价引用再也产不出卡。
    const rebuiltOld = bindCard(oldQuoteCard);
    expect(rebuiltOld.ok).toBe(false);
    if (!rebuiltOld.ok) expect(rebuiltOld.rejection).toBe('quote_expired');

    // 新报价产新卡：引用与期限都更新。
    const newCard = bindCard(buildQuoteCard(session, second));
    expect(newCard.ok).toBe(true);
    if (!newCard.ok) throw new Error('预期新卡产卡');
    expect(newCard.card.quoteRef).toBe(second.quoteRef);
    expect(newCard.card.quoteRef).not.toBe(firstCard.card.quoteRef);
    expect(newCard.card.expiresAt).toBe(epochToIso8601(second.expiresAt));
    expect(newCard.card.expiresAt > firstCard.card.expiresAt).toBe(true);

    // 新卡在新报价有效期内可提交。
    const gate = evaluateConfirmGate(newCard.card, {
      actionId: ACTION_ID,
      taskRevision: newCard.card.taskRevision,
      now: epochToIso8601(second.pricedAt),
    });
    expect(gate.ok).toBe(true);
  });
});

// ===========================================================================
// I-4 边界：不自签、不下单
// ===========================================================================

describe('集成 F10↔F05 · 信任边界', () => {
  it('接线层声明不自签授权、不下单、不接真实平台', () => {
    expect(FOOD_ADAPTER_BOUNDARY.selfSignsAuthorization).toBe(false);
    expect(FOOD_ADAPTER_BOUNDARY.submitsOrder).toBe(false);
    expect(FOOD_ADAPTER_BOUNDARY.connectsRealPlatform).toBe(false);
  });

  it('未注入原生信任端口 ⇒ native-trust-unavailable（绝不本地自签）', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const res = confirmQuote({
      quoteCard: buildQuoteCard(session, quote),
      cardId: CARD_ID,
      actionId: ACTION_ID,
      accountRef: 'acct:food',
      paramsDigest: DIGEST,
      objectLabel: 'fixture 火锅店',
      nativeTrust: null,
      now: epochToIso8601(quote.pricedAt),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('native-trust-unavailable');
  });
});
