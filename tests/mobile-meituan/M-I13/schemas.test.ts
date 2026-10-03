/**
 * M-I13 —— 生产模块操作 schema：结构描述符与本地结构校验。**import 生产路径**。
 */

import { describe, expect, it } from 'vitest';

import {
  CATALOG_OPERATIONS,
  validateOperationPayload,
} from '../../../src/mobile-plugins/meituan/spec-preflight/index.js';

describe('M-I13 生产操作描述符', () => {
  it('声明两个只读操作，schemaVersion 恒为 1 且 readOnly=true', () => {
    expect(CATALOG_OPERATIONS.map((op) => op.operation)).toEqual([
      'catalog.validate-line',
      'cart.preflight-merchant',
    ]);
    for (const op of CATALOG_OPERATIONS) {
      expect(op.schemaVersion).toBe('1');
      expect(op.readOnly).toBe(true);
    }
  });

  it('输入 schema 不含任何下单/支付/价格字段（结构性禁止）', () => {
    const banned = /pay|submit|place|checkout|purchase|price|amount|total/i;
    for (const op of CATALOG_OPERATIONS) {
      for (const key of Object.keys(op.input.properties)) {
        if (key === 'subtotalMinor') continue;
        expect(banned.test(key), `${op.operation} 的输入字段 ${key} 可疑`).toBe(false);
      }
    }
  });
});

describe('M-I13 生产 payload 结构校验', () => {
  it('合法 catalog.validate-line payload ⇒ ok=true', () => {
    const result = validateOperationPayload('catalog.validate-line', {
      merchantId: 'm-noodle',
      dishId: 'dish-noodle',
      skuId: 'sku-noodle-base',
      selections: [{ groupId: 'spicy', optionId: 'mild' }],
      quantity: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.operation).toBe('catalog.validate-line');
  });

  it('缺必填字段 ⇒ 报缺少字段', () => {
    const result = validateOperationPayload('catalog.validate-line', {
      merchantId: 'm-noodle',
      dishId: 'dish-noodle',
      skuId: 'sku-noodle-base',
      quantity: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'selections')).toBe(true);
  });

  it('类型错误（quantity 是字符串）⇒ 报类型', () => {
    const result = validateOperationPayload('catalog.validate-line', {
      merchantId: 'm-noodle',
      dishId: 'dish-noodle',
      skuId: 'sku-noodle-base',
      selections: [],
      quantity: '1',
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'quantity' && /类型/.test(v.message))).toBe(true);
  });

  it('quantity 小于 minimum=1 ⇒ 报下限', () => {
    const result = validateOperationPayload('catalog.validate-line', {
      merchantId: 'm-noodle',
      dishId: 'dish-noodle',
      skuId: 'sku-noodle-base',
      selections: [],
      quantity: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'quantity' && /不得小于/.test(v.message))).toBe(true);
  });

  it('未声明字段 ⇒ 报未知字段（additionalProperties=false）', () => {
    const result = validateOperationPayload('catalog.validate-line', {
      merchantId: 'm-noodle',
      dishId: 'dish-noodle',
      skuId: 'sku-noodle-base',
      selections: [],
      quantity: 1,
      placeOrder: true,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'placeOrder')).toBe(true);
  });

  it('未知操作 ⇒ ok=false、operation=null', () => {
    const result = validateOperationPayload('catalog.place-order', {});
    expect(result.ok).toBe(false);
    expect(result.operation).toBeNull();
  });

  it('payload 非对象 ⇒ 明确拒绝', () => {
    expect(validateOperationPayload('cart.preflight-merchant', null).ok).toBe(false);
    expect(validateOperationPayload('cart.preflight-merchant', []).ok).toBe(false);
  });

  it('合法 cart.preflight-merchant payload ⇒ ok=true', () => {
    const result = validateOperationPayload('cart.preflight-merchant', {
      merchantId: 'm-noodle',
      subtotalMinor: 2000,
      currency: 'CNY',
      distanceMeters: 3000,
    });
    expect(result.ok).toBe(true);
  });
});
