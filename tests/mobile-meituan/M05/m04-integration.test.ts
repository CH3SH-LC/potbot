/**
 * M05 × M04 集成：地址版本变化使绑定的报价与本地确认一并失效。
 *
 * 这里**只读复用** M04（`../cart`）——不改它一行代码。要点：
 * - M05 的 `ref` 含版本，喂给 M04 的 `delivery.addressRef`；
 * - 地址一改，引用变 ⇒ M04 的 `paramsDigest` 变 ⇒ 旧报价 `params_changed`、
 *   旧确认草稿同步失效；
 * - 即使调用方还没把新引用同步进购物车，M05 自己的绑定检查也已判失效。
 */

import { describe, expect, it } from 'vitest';

import {
  CartSession,
  FixtureClock,
  QuoteStaleError,
  createFixtureQuotePort,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  bindingOf,
  checkAddressBinding,
  requireAddressBinding,
  toQuoteRequestDelivery,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { T0, makeBook } from './support.js';

function setup() {
  const clock = new FixtureClock(T0);
  const port = createFixtureQuotePort({
    unitAmountsMinor: { 'sku-noodle': 3800 },
    deliveryFeeMinor: 300,
    ttlMs: 300_000,
  });
  const session = new CartSession({ merchantId: 'merchant-1', currency: 'CNY', port, clock });
  const book = makeBook();
  session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
  session.cart.setDeliveryAddress(toQuoteRequestDelivery(book.require('addr-home')).addressRef);
  return { session, book, clock };
}

describe('M05 × M04：地址引用桥接', () => {
  it('toQuoteRequestDelivery 只带引用，不带明文', () => {
    const book = makeBook();
    const delivery = toQuoteRequestDelivery(book.require('addr-home'));
    expect(delivery).toEqual({ addressRef: 'addr-home#v1' });
    expect(JSON.stringify(delivery)).not.toContain('13800008000');
  });

  it('地址修改让 ref 变化，进而让 M04 的参数指纹变化', async () => {
    const { session, book } = setup();
    const quote = await session.requestQuote();
    const digestBefore = quote.paramsDigest;

    const updated = book.update('addr-home', { phone: '13800008001' });
    expect(updated.ref).not.toBe('addr-home#v1');

    session.cart.setDeliveryAddress(updated.ref);
    const digestAfter = session.describeRequest().paramsDigest;

    expect(digestAfter).not.toBe(digestBefore);
  });
});

describe('M05 × M04：地址修改 ⇒ 报价与确认失效', () => {
  it('修改地址后，旧报价 params_changed、旧确认草稿同步失效', async () => {
    const { session, book } = setup();
    const quote = await session.requestQuote();
    const draft = session.createConfirmationDraft(quote);

    // 修改之前：报价与确认都可用（防止「恒失效」空壳）。
    expect(session.checkQuote(quote).usable).toBe(true);
    expect(session.checkConfirmationDraft(draft).usable).toBe(true);

    const updated = book.update('addr-home', { detail: '换了门牌 202 室' });
    session.cart.setDeliveryAddress(updated.ref);

    const quoteCheck = session.checkQuote(quote);
    expect(quoteCheck.usable).toBe(false);
    expect(quoteCheck.reasons).toContain('params_changed');

    const draftCheck = session.checkConfirmationDraft(draft);
    expect(draftCheck.usable).toBe(false);
    expect(draftCheck.reasons).toContain('params_changed');

    expect(() => session.requireUsableQuote(quote)).toThrow(QuoteStaleError);
    expect(() => session.createConfirmationDraft(quote)).toThrow(QuoteStaleError);
  });

  it('**M05 自判**：即使还没把新引用同步进购物车，绑定检查也已判失效', async () => {
    const { book } = setup();
    const binding = bindingOf(book.require('addr-home'));
    expect(checkAddressBinding(binding, book).usable).toBe(true);

    book.update('addr-home', { phone: '13800008002' });

    const check = checkAddressBinding(binding, book);
    expect(check.usable).toBe(false);
    expect(check.reasons).toContain('version_changed');
    expect(() => requireAddressBinding(binding, book)).toThrow();
  });

  it('**反向对照**：不改地址则报价与确认保持可用', async () => {
    const { session } = setup();
    const quote = await session.requestQuote();
    const draft = session.createConfirmationDraft(quote);

    expect(session.checkQuote(quote).usable).toBe(true);
    expect(session.checkConfirmationDraft(draft).usable).toBe(true);
    expect(session.checkConfirmationDraft(draft).reasons).toEqual([]);
  });

  it('换用地址簿里的**另一条**地址同样使旧报价失效', async () => {
    const { session, book } = setup();
    const quote = await session.requestQuote();

    session.cart.setDeliveryAddress(toQuoteRequestDelivery(book.require('addr-office')).addressRef);

    expect(session.checkQuote(quote).usable).toBe(false);
    expect(session.checkQuote(quote).reasons).toContain('params_changed');
  });
});
