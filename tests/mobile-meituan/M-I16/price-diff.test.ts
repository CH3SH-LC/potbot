/**
 * M-I16（M-R03 提升）—— `diffQuotes` 纯函数语义，全部打在**生产源码**上。
 *
 * 保留 M-R03 的判据：金额只以整数最小单位出现（非整数抛 `PriceDiffError`，不四舍五入）；
 * 费用/优惠按码聚合并显式标注变化；结果冻结不可被下游就地改写。
 */

import { describe, expect, it } from 'vitest';

import { CartError } from '../../../src/mobile-plugins/meituan/cart/index.js';
import { PriceDiffError, diffQuotes } from '../../../src/mobile-plugins/meituan/reconfirmation/index.js';
import { makeQuote } from './support.js';

describe('M-I16 diffQuotes：整数最小单位纪律', () => {
  it('两侧总价不是整数最小单位时抛 PriceDiffError（不四舍五入、不替端口修正）', () => {
    const prev = makeQuote({ amount: 1000 });
    const next = makeQuote({ quoteRef: 'q-2', amount: 1000.5 });
    expect(() => diffQuotes(prev, next)).toThrow(PriceDiffError);
    // 价格差异错误复用 M04 的 CartError 基类，调用方只需捕获一个根类型。
    expect(() => diffQuotes(prev, next)).toThrow(CartError);
  });

  it('小计不是整数最小单位时同样抛 PriceDiffError', () => {
    const prev = makeQuote({ subtotalMinor: 1000 });
    const next = makeQuote({ quoteRef: 'q-2', subtotalMinor: 1000.25 });
    expect(() => diffQuotes(prev, next)).toThrow(PriceDiffError);
  });

  it('费用金额不是整数最小单位时抛 PriceDiffError（聚合前先校验）', () => {
    const prev = makeQuote({ fees: [{ code: 'packaging', label: '打包费', amountMinor: 100.5 }] });
    const next = makeQuote({ quoteRef: 'q-2' });
    expect(() => diffQuotes(prev, next)).toThrow(PriceDiffError);
  });
});

describe('M-I16 diffQuotes：语义聚合', () => {
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

  it('只在单侧出现的费用码用 null 标记（不补 0 伪装成零价）', () => {
    const prev = makeQuote({ fees: [] });
    const next = makeQuote({
      quoteRef: 'q-2',
      fees: [{ code: 'delivery', label: '配送费', amountMinor: 300 }],
    });
    const diff = diffQuotes(prev, next);
    const delivery = diff.fees.find((fee) => fee.code === 'delivery');
    expect(delivery?.previousAmountMinor).toBeNull();
    expect(delivery?.nextAmountMinor).toBe(300);
    expect(diff.changedKinds).toContain('fee_changed');
  });

  it('差异结果被冻结（不可被下游就地改写）', () => {
    const diff = diffQuotes(makeQuote(), makeQuote({ quoteRef: 'q-2' }));
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.changedKinds)).toBe(true);
    expect(Object.isFrozen(diff.fees)).toBe(true);
    expect(Object.isFrozen(diff.discounts)).toBe(true);
  });

  it('sameParamsDigest 与 changed 正交：同指纹仍可 changed', () => {
    const prev = makeQuote({ paramsDigest: 'v1-identical', amount: 1000 });
    const next = makeQuote({ quoteRef: 'q-2', paramsDigest: 'v1-identical', amount: 1200 });
    const diff = diffQuotes(prev, next);
    expect(diff.sameParamsDigest).toBe(true);
    expect(diff.changed).toBe(true);
    expect(diff.amountDeltaMinor).toBe(200);
  });
});
