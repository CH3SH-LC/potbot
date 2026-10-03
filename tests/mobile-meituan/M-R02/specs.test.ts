/**
 * M-R02 规格必选 / 多选校验（真实断言，无 mock）。
 */

import { describe, expect, it } from 'vitest';

import { validateSpecSelection } from './specs.js';
import { SKU_NOODLE_BASE, SKU_NOODLE_FULL } from './fixture.js';
import { codesOf, issueWithCode, sel } from './support.js';
import type { DishSku } from './types.js';

describe('M-R02 规格必选 / 单选', () => {
  it('必选单选组未选 ⇒ required_group_missing', () => {
    const result = validateSpecSelection(SKU_NOODLE_BASE, []);
    expect(result.ok).toBe(false);
    expect(codesOf(result.issues)).toEqual(['required_group_missing']);
    expect(issueWithCode(result.issues, 'required_group_missing').groupId).toBe('spicy');
  });

  it('单选组选 1 个且合法 ⇒ 通过，ok=true 且 issues 为空', () => {
    const result = validateSpecSelection(SKU_NOODLE_BASE, [sel('spicy', 'mild')]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('单选组选 2 个 ⇒ single_group_multi_selected（且 limit=1, actual=2）', () => {
    const result = validateSpecSelection(SKU_NOODLE_BASE, [sel('spicy', 'mild'), sel('spicy', 'hot')]);
    expect(result.ok).toBe(false);
    const issue = issueWithCode(result.issues, 'single_group_multi_selected');
    expect(issue.limit).toBe(1);
    expect(issue.actual).toBe(2);
  });
});

describe('M-R02 规格多选上下限', () => {
  it('多选组内数量在 [min,max] 内 ⇒ 通过（0 个也可，因为非必选 min=0）', () => {
    const result = validateSpecSelection(SKU_NOODLE_FULL, [sel('spicy', 'medium')]);
    expect(result.ok).toBe(true);
  });

  it('多选组恰好到 maxSelections ⇒ 通过（上限含等号）', () => {
    const result = validateSpecSelection(SKU_NOODLE_FULL, [
      sel('spicy', 'medium'),
      sel('addon', 'egg'),
      sel('addon', 'beef'),
    ]);
    expect(result.ok).toBe(true);
    expect(codesOf(result.issues)).toEqual([]);
  });

  it('多选组少于 minSelections ⇒ too_few_selections（本地构造 min=2 的 SKU）', () => {
    const sku: DishSku = {
      skuId: 'sku-local-min2',
      dishId: 'dish-local',
      merchantId: 'm-noodle',
      name: '本地构造：多选至少 2',
      stock: null,
      maxQuantity: null,
      minQuantity: 1,
      specGroups: [
        {
          groupId: 'topping',
          name: '配料',
          selectionMode: 'multi',
          required: false,
          minSelections: 2,
          maxSelections: 3,
          options: [
            { optionId: 'a', name: 'A', available: true, stock: null },
            { optionId: 'b', name: 'B', available: true, stock: null },
            { optionId: 'c', name: 'C', available: true, stock: null },
          ],
        },
      ],
    };
    const result = validateSpecSelection(sku, [sel('topping', 'a')]);
    expect(result.ok).toBe(false);
    const issue = issueWithCode(result.issues, 'too_few_selections');
    expect(issue.limit).toBe(2);
    expect(issue.actual).toBe(1);

    // 恰好 2 个 ⇒ 通过
    expect(validateSpecSelection(sku, [sel('topping', 'a'), sel('topping', 'b')]).ok).toBe(true);
    // 3 个 ⇒ 通过；4 个不可能（只有 3 个选项），改测 too_many 用下面 SKU
  });

  it('多选组超过 maxSelections ⇒ too_many_selections（min=1,max=2 的 SKU）', () => {
    const sku: DishSku = {
      skuId: 'sku-local-max2',
      dishId: 'dish-local',
      merchantId: 'm-noodle',
      name: '本地构造：多选最多 2',
      stock: null,
      maxQuantity: null,
      minQuantity: 1,
      specGroups: [
        {
          groupId: 'sauce',
          name: '酱料',
          selectionMode: 'multi',
          required: true,
          minSelections: 1,
          maxSelections: 2,
          options: [
            { optionId: 'x', name: 'X', available: true, stock: null },
            { optionId: 'y', name: 'Y', available: true, stock: null },
            { optionId: 'z', name: 'Z', available: true, stock: null },
          ],
        },
      ],
    };
    const result = validateSpecSelection(sku, [sel('sauce', 'x'), sel('sauce', 'y'), sel('sauce', 'z')]);
    expect(result.ok).toBe(false);
    const issue = issueWithCode(result.issues, 'too_many_selections');
    expect(issue.limit).toBe(2);
    expect(issue.actual).toBe(3);
  });

  it('必选多选组为空 ⇒ required_group_missing（不是 too_few）', () => {
    const sku: DishSku = {
      skuId: 'sku-local-reqmulti',
      dishId: 'dish-local',
      merchantId: 'm-noodle',
      name: '本地构造：必选多选 min=2',
      stock: null,
      maxQuantity: null,
      minQuantity: 1,
      specGroups: [
        {
          groupId: 'req',
          name: '必选多选',
          selectionMode: 'multi',
          required: true,
          minSelections: 2,
          maxSelections: 3,
          options: [
            { optionId: 'a', name: 'A', available: true, stock: null },
            { optionId: 'b', name: 'B', available: true, stock: null },
          ],
        },
      ],
    };
    const result = validateSpecSelection(sku, []);
    expect(codesOf(result.issues)).toEqual(['required_group_missing']);
  });
});

describe('M-R02 规格引用与重复', () => {
  it('引用不存在的规格组 ⇒ unknown_group', () => {
    const result = validateSpecSelection(SKU_NOODLE_BASE, [sel('spicy', 'mild'), sel('ghost', 'x')]);
    expect(result.ok).toBe(false);
    expect(issueWithCode(result.issues, 'unknown_group').groupId).toBe('ghost');
  });

  it('引用不存在的选项 ⇒ unknown_option（必选组因未成功选中也会同时报 required_group_missing）', () => {
    const result = validateSpecSelection(SKU_NOODLE_BASE, [sel('spicy', 'ghost-option')]);
    expect(codesOf(result.issues)).toContain('unknown_option');
    expect(codesOf(result.issues)).toContain('required_group_missing');
  });

  it('同组同选项重复 ⇒ duplicate_option（只报一次）', () => {
    const result = validateSpecSelection(SKU_NOODLE_FULL, [
      sel('spicy', 'mild'),
      sel('addon', 'egg'),
      sel('addon', 'egg'),
    ]);
    expect(codesOf(result.issues).filter((code) => code === 'duplicate_option')).toHaveLength(1);
  });

  it('空 groupId / optionId ⇒ invalid_id', () => {
    const result = validateSpecSelection(SKU_NOODLE_BASE, [sel('', ''), sel('spicy', 'mild')]);
    expect(codesOf(result.issues)).toContain('invalid_id');
  });

  it('选项下架 ⇒ option_unavailable（chili-oil）', () => {
    const result = validateSpecSelection(SKU_NOODLE_FULL, [sel('spicy', 'mild'), sel('addon', 'chili-oil')]);
    expect(result.ok).toBe(false);
    expect(issueWithCode(result.issues, 'option_unavailable').optionId).toBe('chili-oil');
  });
});

describe('M-R02 规格问题顺序稳定', () => {
  it('同一输入多次校验得到完全相同的顺序', () => {
    const selections = [sel('addon', 'chili-oil'), sel('spicy', 'mild'), sel('spicy', 'hot'), sel('ghost', 'x')];
    const first = validateSpecSelection(SKU_NOODLE_FULL, selections).issues.map((issue) => `${issue.groupId}:${issue.code}`);
    const second = validateSpecSelection(SKU_NOODLE_FULL, [...selections].reverse()).issues.map(
      (issue) => `${issue.groupId}:${issue.code}`,
    );
    expect(first).toEqual(second);
  });
});
