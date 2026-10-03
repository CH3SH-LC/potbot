/**
 * M04 购物车状态：条目增删改、规格、同规格合并、地址与计价选择。
 *
 * 这些用例**不触碰任何价格**：购物车条目里根本没有价格字段（同文件最后一条用例
 * 用 `Object.keys` 把这条结构性保证钉住）。
 */

import { describe, expect, it } from 'vitest';

import { CartState, CartValidationError, MAX_LINE_QUANTITY } from '../../../src/mobile-plugins/meituan/cart/index.js';

function newCart(): CartState {
  return new CartState({ merchantId: 'merchant-1', currency: 'CNY' });
}

describe('M04 购物车状态', () => {
  it('同规格重复加入会合并数量，并保留先到条目的 lineId', () => {
    const cart = newCart();
    const first = cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', quantity: 1 });
    const second = cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', quantity: 2 });

    expect(cart.lines).toHaveLength(1);
    expect(second.lineId).toBe(first.lineId);
    expect(cart.lines[0]?.quantity).toBe(3);
  });

  it('规格不同的同款菜品是两个条目', () => {
    const cart = newCart();
    cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', specs: [{ groupId: 'spice', optionId: 'mild' }] });
    cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', specs: [{ groupId: 'spice', optionId: 'hot' }] });

    expect(cart.lines).toHaveLength(2);
    expect(cart.lines.map((line) => line.quantity)).toEqual([1, 1]);
  });

  it('规格书写顺序不影响「同规格」判定（先规范化再比较）', () => {
    const cart = newCart();
    cart.addLine({
      dishId: 'd-noodle',
      skuId: 'sku-noodle',
      specs: [
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'size', optionId: 'large' },
      ],
    });
    cart.addLine({
      dishId: 'd-noodle',
      skuId: 'sku-noodle',
      specs: [
        { groupId: 'size', optionId: 'large' },
        { groupId: 'spice', optionId: 'mild' },
      ],
    });

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.quantity).toBe(2);
  });

  it('改规格若与已有条目相同则合并，数量并入且目标条目 id 不变', () => {
    const cart = newCart();
    const mild = cart.addLine({
      dishId: 'd-noodle',
      skuId: 'sku-noodle',
      specs: [{ groupId: 'spice', optionId: 'mild' }],
      quantity: 2,
    });
    const hot = cart.addLine({
      dishId: 'd-noodle',
      skuId: 'sku-noodle',
      specs: [{ groupId: 'spice', optionId: 'hot' }],
      quantity: 3,
    });

    const merged = cart.setLineSpecs(hot.lineId, [{ groupId: 'spice', optionId: 'mild' }]);

    expect(merged.lineId).toBe(mild.lineId);
    expect(merged.quantity).toBe(5);
    expect(cart.lines).toHaveLength(1);
  });

  it('改规格不冲突时原地更新并保留 lineId', () => {
    const cart = newCart();
    const line = cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', quantity: 1 });
    const updated = cart.setLineSpecs(line.lineId, [{ groupId: 'spice', optionId: 'hot' }]);

    expect(updated.lineId).toBe(line.lineId);
    expect(updated.specs).toEqual([{ groupId: 'spice', optionId: 'hot' }]);
  });

  it('数量必须是正整数且不超过上限', () => {
    const cart = newCart();
    const line = cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle' });

    expect(() => cart.setLineQuantity(line.lineId, 0)).toThrow(CartValidationError);
    expect(() => cart.setLineQuantity(line.lineId, -1)).toThrow(CartValidationError);
    expect(() => cart.setLineQuantity(line.lineId, 1.5)).toThrow(CartValidationError);
    expect(() => cart.setLineQuantity(line.lineId, MAX_LINE_QUANTITY + 1)).toThrow(CartValidationError);
    expect(() => cart.addLine({ dishId: 'd-x', skuId: 'sku-x', quantity: Number.NaN })).toThrow(CartValidationError);
  });

  it('重复的规格组会被拒绝（一组只能选一个选项）', () => {
    const cart = newCart();
    expect(() =>
      cart.addLine({
        dishId: 'd-noodle',
        skuId: 'sku-noodle',
        specs: [
          { groupId: 'spice', optionId: 'mild' },
          { groupId: 'spice', optionId: 'hot' },
        ],
      }),
    ).toThrow(CartValidationError);
  });

  it('删除不存在的条目会抛错', () => {
    const cart = newCart();
    expect(() => cart.removeLine('line-404')).toThrow(CartValidationError);
    expect(() => cart.setLineQuantity('line-404', 1)).toThrow(CartValidationError);
  });

  it('revision 只在实质变化时递增（无操作不计）', () => {
    const cart = newCart();
    const line = cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', quantity: 2 });
    const afterAdd = cart.revision;

    cart.setLineQuantity(line.lineId, 2);
    expect(cart.revision).toBe(afterAdd);

    cart.setLineSpecs(line.lineId, []);
    expect(cart.revision).toBe(afterAdd);

    cart.setDeliveryAddress('addr-home');
    const afterAddress = cart.revision;
    cart.setDeliveryAddress('addr-home');
    expect(cart.revision).toBe(afterAddress);

    cart.setPricingInputs({ couponCodes: ['COUPON-5'] });
    const afterCoupon = cart.revision;
    cart.setPricingInputs({ couponCodes: ['COUPON-5'] });
    expect(cart.revision).toBe(afterCoupon);

    cart.setLineQuantity(line.lineId, 3);
    expect(cart.revision).toBeGreaterThan(afterCoupon);
  });

  it('地址与计价选择：保存引用、去重排序，且可清除', () => {
    const cart = newCart();
    cart.setDeliveryAddress('addr-home');
    expect(cart.delivery).toEqual({ addressRef: 'addr-home' });

    cart.setPricingInputs({ couponCodes: ['B', 'A', 'B'] });
    expect(cart.pricing.couponCodes).toEqual(['A', 'B']);

    cart.setPricingInputs({ serviceOptions: ['cutlery'] });
    expect(cart.pricing.couponCodes).toEqual(['A', 'B']);
    expect(cart.pricing.serviceOptions).toEqual(['cutlery']);

    cart.setDeliveryAddress(null);
    expect(cart.delivery).toBeNull();

    expect(() => cart.setDeliveryAddress('')).toThrow(CartValidationError);
    expect(() => cart.setPricingInputs({ couponCodes: [''] })).toThrow(CartValidationError);
  });

  it('条目上不存在任何价格/金额字段（本地不持有价格，这是结构性保证）', () => {
    const cart = newCart();
    const line = cart.addLine({ dishId: 'd-noodle', skuId: 'sku-noodle', quantity: 2 });

    const keys = Object.keys(line);
    for (const key of keys) {
      expect(key).not.toMatch(/amount|price|total|fee|discount/i);
    }
    expect(keys.sort()).toEqual(
      ['dishId', 'lineId', 'merchantId', 'quantity', 'skuId', 'specs'].sort(),
    );
    expect(Object.isFrozen(line)).toBe(true);
    expect(Object.isFrozen(line.specs)).toBe(true);
  });

  it('币种必填且必须是三字母代码', () => {
    expect(() => new CartState({ merchantId: 'merchant-1', currency: 'cny' })).toThrow(CartValidationError);
    expect(() => new CartState({ merchantId: '', currency: 'CNY' })).toThrow(CartValidationError);
    expect(new CartState({ merchantId: 'merchant-1', currency: 'CNY' }).currency).toBe('CNY');
  });
});
