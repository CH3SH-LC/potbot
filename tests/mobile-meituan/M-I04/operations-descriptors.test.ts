/**
 * M-I04 —— 声明式操作描述符（M04 nextIncrement #1）。
 *
 * 断言七个购物车操作的 payload 字段规格存在、结构自洽、可被结构校验器执行，
 * 且描述符里不存在下单 / 支付类字段。
 */

import { describe, expect, it } from 'vitest';

import {
  CART_OPERATION_IDS,
  CART_OPERATIONS,
  findCartOperation,
  validateCartOperationPayload,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

const EXPECTED_IDS = [
  'cart.add_line',
  'cart.set_quantity',
  'cart.set_specs',
  'cart.set_delivery_address',
  'cart.set_pricing_inputs',
  'cart.request_quote',
  'cart.check_quote',
] as const;

describe('CART_OPERATIONS：形状', () => {
  it('恰好覆盖七个操作，顺序稳定', () => {
    expect([...CART_OPERATION_IDS]).toEqual([...EXPECTED_IDS]);
    expect(CART_OPERATIONS.map((entry) => entry.operation)).toEqual([...EXPECTED_IDS]);
  });

  it('每个描述符的 schemaVersion 为 1、input 为 object、不接受未声明字段', () => {
    for (const descriptor of CART_OPERATIONS) {
      expect(descriptor.schemaVersion).toBe('1');
      expect(descriptor.input.type).toBe('object');
      expect(descriptor.input.additionalProperties).toBe(false);
      expect(Array.isArray(descriptor.input.required)).toBe(true);
    }
  });

  it('关键必填字段齐全', () => {
    expect(findCartOperation('cart.add_line')?.input.required).toEqual(['dishId', 'skuId']);
    expect(findCartOperation('cart.set_quantity')?.input.required).toEqual(['lineId', 'quantity']);
    expect(findCartOperation('cart.set_specs')?.input.required).toEqual(['lineId', 'specs']);
    expect(findCartOperation('cart.check_quote')?.input.required).toEqual(['quoteRef']);
  });

  it('数量字段带下限 1 与上限 999', () => {
    const quantity = findCartOperation('cart.add_line')?.input.properties.quantity;
    expect(quantity?.type).toBe('integer');
    expect(quantity?.minimum).toBe(1);
    expect(quantity?.maximum).toBe(999);
  });

  it('规格字段是 {groupId, optionId} 数组', () => {
    const specs = findCartOperation('cart.set_specs')?.input.properties.specs;
    expect(specs?.type).toBe('array');
    expect(specs?.items?.type).toBe('object');
  });

  it('quote 时间/金额字段以最小单位与逻辑毫秒出现，且 isOrderTotal 恒 false', () => {
    const output = findCartOperation('cart.request_quote')?.output;
    expect(output?.properties.amountMinor?.type).toBe('integer');
    expect(output?.properties.expiresAt?.type).toBe('integer');
    expect(output?.required).toContain('isOrderTotal');
  });

  it('check_quote 的 reasons 枚举与报价失效原因一致', () => {
    const reasons = findCartOperation('cart.check_quote')?.output.properties.reasons;
    expect(reasons?.enum).toEqual(['not_current', 'invalidated', 'params_changed', 'expired']);
  });

  it('描述符里不存在下单 / 支付类字段', () => {
    const forbidden = /^(submit|pay|payment|checkout|buy|purchase)/i;
    for (const descriptor of CART_OPERATIONS) {
      for (const key of Object.keys(descriptor.input.properties)) {
        expect(forbidden.test(key), `${descriptor.operation} 的字段 ${key} 像下单/支付`).toBe(false);
      }
      expect(forbidden.test(descriptor.operation)).toBe(false);
    }
  });
});

describe('validateCartOperationPayload：结构校验', () => {
  it('合法 add_line payload 通过', () => {
    const result = validateCartOperationPayload('cart.add_line', {
      dishId: 'd-1',
      skuId: 's-1',
      quantity: 2,
      specs: [{ groupId: 'spice', optionId: 'hot' }],
    });
    expect(result.ok).toBe(true);
    expect(result.operation).toBe('cart.add_line');
    expect(result.violations).toEqual([]);
  });

  it('未知操作被拒', () => {
    const result = validateCartOperationPayload('cart.do_something_else', {});
    expect(result.ok).toBe(false);
    expect(result.operation).toBeNull();
  });

  it('缺少必填字段被拒', () => {
    const result = validateCartOperationPayload('cart.set_quantity', { lineId: 'l-1' });
    expect(result.ok).toBe(false);
    expect(result.violations.map((entry) => entry.path)).toContain('quantity');
  });

  it('未声明字段被拒', () => {
    const result = validateCartOperationPayload('cart.add_line', {
      dishId: 'd',
      skuId: 's',
      priceMinor: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.message.includes('priceMinor'))).toBe(true);
  });

  it('类型不符被拒', () => {
    const result = validateCartOperationPayload('cart.add_line', { dishId: 'd', skuId: 3 });
    expect(result.ok).toBe(false);
    expect(result.violations.map((entry) => entry.path)).toContain('skuId');
  });

  it('数值越界被拒（0 与 1000）', () => {
    expect(validateCartOperationPayload('cart.add_line', { dishId: 'd', skuId: 's', quantity: 0 }).ok).toBe(
      false,
    );
    expect(validateCartOperationPayload('cart.add_line', { dishId: 'd', skuId: 's', quantity: 1000 }).ok).toBe(
      false,
    );
  });

  it('数组元素类型不符被拒', () => {
    const result = validateCartOperationPayload('cart.set_specs', {
      lineId: 'l-1',
      specs: ['not-an-object'],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.path.startsWith('specs['))).toBe(true);
  });

  it('地址可传 null 表示清除', () => {
    const result = validateCartOperationPayload('cart.set_delivery_address', { addressRef: null });
    expect(result.ok).toBe(true);
  });

  it('payload 非对象被拒', () => {
    expect(validateCartOperationPayload('cart.add_line', 'nope').ok).toBe(false);
    expect(validateCartOperationPayload('cart.add_line', []).ok).toBe(false);
  });
});
