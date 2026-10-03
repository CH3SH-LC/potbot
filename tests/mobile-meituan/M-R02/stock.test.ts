/**
 * M-R02 库存与数量校验（真实断言）。
 */

import { describe, expect, it } from 'vitest';

import { CatalogValidationError } from './errors.js';
import { checkLineQuantity, effectiveStock, maxAddableQuantity } from './stock.js';
import { SKU_DRINK, SKU_NOODLE_BASE, SKU_NOODLE_FULL } from './fixture.js';
import { codesOf, issueWithCode, sel } from './support.js';

describe('M-R02 有效库存', () => {
  it('无规格限制时等于 SKU 总库存', () => {
    expect(effectiveStock(SKU_NOODLE_BASE, [sel('spicy', 'mild')])).toBe(50);
  });

  it('选项库存比 SKU 总库存更紧时取较小者（大份库存 3）', () => {
    expect(effectiveStock(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('portion', 'large')])).toBe(3);
  });

  it('skus 总库存为 null 且各选项库存为 null ⇒ 不限量（null）', () => {
    expect(effectiveStock(SKU_DRINK, [sel('sugar', 'half')])).toBeNull();
  });

  it('选择下架选项 ⇒ 有效库存为 0', () => {
    expect(effectiveStock(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('addon', 'chili-oil')])).toBe(0);
  });

  it('引用不存在的规格 ⇒ 抛 CatalogValidationError（调用方错误）', () => {
    expect(() => effectiveStock(SKU_NOODLE_BASE, [sel('ghost', 'x')])).toThrow(CatalogValidationError);
  });
});

describe('M-R02 数量校验', () => {
  it('正整数且在库存内 ⇒ 无问题', () => {
    expect(checkLineQuantity(SKU_NOODLE_BASE, [sel('spicy', 'mild')], 2)).toEqual([]);
  });

  it('0 / 负数 / 小数 ⇒ not_positive_integer（只报这一条）', () => {
    for (const bad of [0, -1, 1.5]) {
      const issues = checkLineQuantity(SKU_NOODLE_BASE, [sel('spicy', 'mild')], bad);
      expect(codesOf(issues)).toEqual(['not_positive_integer']);
    }
  });

  it('超过有效库存（大份 3）⇒ insufficient_stock 且 limit=3', () => {
    const issues = checkLineQuantity(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('portion', 'large')], 4);
    const issue = issueWithCode(issues, 'insufficient_stock');
    expect(issue.limit).toBe(3);
    expect(issue.actual).toBe(4);
  });

  it('数量等于有效库存（边界）⇒ 通过', () => {
    expect(checkLineQuantity(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('portion', 'large')], 3)).toEqual([]);
  });

  it('超过单条上限（SKU_NOODLE_BASE max=10）⇒ above_max_quantity', () => {
    const issues = checkLineQuantity(SKU_NOODLE_BASE, [sel('spicy', 'mild')], 11);
    expect(issueWithCode(issues, 'above_max_quantity').limit).toBe(10);
  });

  it('低于 minQuantity ⇒ below_min_quantity', () => {
    const sku = { ...SKU_NOODLE_BASE, minQuantity: 3 };
    const issues = checkLineQuantity(sku, [sel('spicy', 'mild')], 2);
    expect(issueWithCode(issues, 'below_min_quantity').limit).toBe(3);
  });
});

describe('M-R02 最多可加数量', () => {
  it('受限 SKU ⇒ 总库存与单条上限取较小者', () => {
    expect(maxAddableQuantity(SKU_NOODLE_BASE, [sel('spicy', 'mild')])).toBe(10);
  });

  it('选项库存更紧 ⇒ 取选项库存', () => {
    expect(maxAddableQuantity(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('portion', 'large')])).toBe(3);
  });

  it('不限量且无单条上限 ⇒ null', () => {
    const sku = { ...SKU_DRINK, maxQuantity: null };
    expect(maxAddableQuantity(sku, [sel('sugar', 'half')])).toBeNull();
  });

  it('下架选项 ⇒ 0', () => {
    expect(maxAddableQuantity(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('addon', 'chili-oil')])).toBe(0);
  });

  it('库存小于 minQuantity ⇒ 0（无法满足最小起订量）', () => {
    const sku = { ...SKU_NOODLE_BASE, stock: 2, minQuantity: 3, maxQuantity: null };
    expect(maxAddableQuantity(sku, [sel('spicy', 'mild')])).toBe(0);
  });
});
