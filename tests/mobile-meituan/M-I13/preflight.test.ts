/**
 * M-I13 —— 生产模块单条预检（规格 + 数量合成）。**import 生产路径**。
 */

import { describe, expect, it } from 'vitest';

import {
  canAddLine,
  preflightLine,
} from '../../../src/mobile-plugins/meituan/spec-preflight/index.js';
import { SKU_NOODLE_BASE, SKU_NOODLE_FULL } from './fixture.js';
import { codesOf, sel } from './support.js';

describe('M-I13 生产单条预检', () => {
  it('规格与数量都合法 ⇒ ok=true', () => {
    const result = preflightLine({
      sku: SKU_NOODLE_BASE,
      selections: [sel('spicy', 'mild')],
      quantity: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(canAddLine({ sku: SKU_NOODLE_BASE, selections: [sel('spicy', 'mild')], quantity: 2 })).toBe(true);
  });

  it('缺必选规格 ⇒ 规格问题报告，ok=false', () => {
    const result = preflightLine({ sku: SKU_NOODLE_BASE, selections: [], quantity: 1 });
    expect(result.ok).toBe(false);
    expect(codesOf(result.issues)).toContain('required_group_missing');
  });

  it('数量超库存且规格也错 ⇒ 两类问题一起报告（一次看到全部要改的）', () => {
    const result = preflightLine({
      sku: SKU_NOODLE_FULL,
      selections: [sel('portion', 'large'), sel('addon', 'chili-oil')],
      quantity: 99,
    });
    expect(result.ok).toBe(false);
    const codes = codesOf(result.issues);
    expect(codes).toContain('required_group_missing');
    expect(codes).toContain('option_unavailable');
    expect(codes).toContain('insufficient_stock');
  });

  it('返回可用库存与最多可加数量', () => {
    const result = preflightLine({
      sku: SKU_NOODLE_FULL,
      selections: [sel('spicy', 'mild'), sel('portion', 'large')],
      quantity: 1,
    });
    expect(result.availableQuantity).toBe(3);
    expect(result.maxAddableQuantity).toBe(3);
  });

  it('不限量 SKU 的 availableQuantity=null', () => {
    const result = preflightLine({
      sku: { ...SKU_NOODLE_BASE, stock: null, maxQuantity: null },
      selections: [sel('spicy', 'mild')],
      quantity: 1,
    });
    expect(result.availableQuantity).toBeNull();
    expect(result.maxAddableQuantity).toBeNull();
  });
});
