/**
 * M-I04 共享夹具：一组规格组定义，覆盖必选 / 单选 / 多选 / 不可选 / 上下限。
 *
 * 目录（菜品 SKU 定义）本身不归 cart 包所有，由调用方注入——这里给出注入样例。
 */

import type { SpecGroupDef } from '../../../src/mobile-plugins/meituan/cart/index.js';

export const SPEC_GROUPS: readonly SpecGroupDef[] = [
  {
    groupId: 'spice',
    required: true,
    selectionMode: 'single',
    options: [{ optionId: 'mild' }, { optionId: 'hot' }],
  },
  {
    groupId: 'size',
    required: false,
    selectionMode: 'single',
    options: [{ optionId: 'regular' }, { optionId: 'large' }],
  },
  {
    // 多选：0..2（非必选），含一个当前不可选的选项。
    groupId: 'extra',
    selectionMode: 'multi',
    maxSelections: 2,
    options: [
      { optionId: 'egg' },
      { optionId: 'cheese' },
      { optionId: 'bacon' },
      { optionId: 'soldout', available: false },
    ],
  },
  {
    // 多选：至少 2（非必选，故 0 个不报错；选了但不够才 too_few）。
    groupId: 'garnish',
    selectionMode: 'multi',
    minSelections: 2,
    maxSelections: 3,
    options: [{ optionId: 'a' }, { optionId: 'b' }, { optionId: 'c' }],
  },
];
