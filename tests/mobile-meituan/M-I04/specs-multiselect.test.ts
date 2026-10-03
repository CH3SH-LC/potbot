/**
 * M-I04 —— 规格必选 / 单选 / 多选校验（M-R02 请求 #3 的落地）。
 *
 * 修复的真实缺陷：旧 `normalizeSpecs` 对任何重复 `groupId` 一律抛错
 * （`同一组只能选一个选项`），无法表达多选规格组。
 */

import { describe, expect, it } from 'vitest';

import {
  CartState,
  CartValidationError,
  normalizeSpecs,
  specsKey,
  validateSpecSelection,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { SPEC_GROUPS } from './support.js';

function codes(selections: readonly { groupId: string; optionId: string }[]): readonly string[] {
  return validateSpecSelection(selections, SPEC_GROUPS).issues.map((entry) => entry.code);
}

describe('validateSpecSelection：问题码', () => {
  it('合法的多选组通过（同组多个不同选项）', () => {
    const result = validateSpecSelection(
      [
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'egg' },
        { groupId: 'extra', optionId: 'bacon' },
      ],
      SPEC_GROUPS,
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('必选组未选 ⇒ required_group_missing', () => {
    const result = validateSpecSelection([], SPEC_GROUPS);
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(['required_group_missing']);
    expect(result.issues[0]?.groupId).toBe('spice');
  });

  it('单选组选了两个 ⇒ single_group_multi_selected（limit=1, actual=2）', () => {
    const result = validateSpecSelection(
      [
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'spice', optionId: 'hot' },
      ],
      SPEC_GROUPS,
    );
    const entry = result.issues.find((item) => item.code === 'single_group_multi_selected');
    expect(entry).toBeDefined();
    expect(entry?.groupId).toBe('spice');
    expect(entry?.limit).toBe(1);
    expect(entry?.actual).toBe(2);
  });

  it('多选组少于下限 ⇒ too_few_selections', () => {
    const result = validateSpecSelection(
      [
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'garnish', optionId: 'a' },
      ],
      SPEC_GROUPS,
    );
    const entry = result.issues.find((item) => item.code === 'too_few_selections');
    expect(entry).toBeDefined();
    expect(entry?.groupId).toBe('garnish');
    expect(entry?.limit).toBe(2);
    expect(entry?.actual).toBe(1);
  });

  it('多选组多于上限 ⇒ too_many_selections', () => {
    const result = validateSpecSelection(
      [
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'extra', optionId: 'egg' },
        { groupId: 'extra', optionId: 'cheese' },
        { groupId: 'extra', optionId: 'bacon' },
      ],
      SPEC_GROUPS,
    );
    const entry = result.issues.find((item) => item.code === 'too_many_selections');
    expect(entry).toBeDefined();
    expect(entry?.limit).toBe(2);
    expect(entry?.actual).toBe(3);
  });

  it('同组同选项选两次 ⇒ duplicate_option（只报一次、计数只算一次）', () => {
    const result = validateSpecSelection(
      [
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'extra', optionId: 'egg' },
        { groupId: 'extra', optionId: 'egg' },
      ],
      SPEC_GROUPS,
    );
    expect(result.issues.filter((item) => item.code === 'duplicate_option')).toHaveLength(1);
    // 计一次，故不会因 2 个而触发 too_many。
    expect(result.issues.some((item) => item.code === 'too_many_selections')).toBe(false);
  });

  it('未知组 / 未知选项 ⇒ unknown_group / unknown_option', () => {
    expect(codes([{ groupId: 'spice', optionId: 'mild' }, { groupId: 'ghost', optionId: 'x' }])).toContain(
      'unknown_group',
    );
    expect(codes([{ groupId: 'spice', optionId: 'sweet' }])).toContain('unknown_option');
  });

  it('空 id ⇒ invalid_id；不可选项 ⇒ option_unavailable', () => {
    expect(codes([{ groupId: '', optionId: 'x' }])).toContain('invalid_id');
    const result = validateSpecSelection(
      [
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'extra', optionId: 'soldout' },
      ],
      SPEC_GROUPS,
    );
    expect(result.issues.map((item) => item.code)).toContain('option_unavailable');
  });
});

describe('validateSpecSelection：稳定排序与可重现', () => {
  it('问题按 groupId → code → optionId 固定排序', () => {
    const selections = [
      { groupId: 'spice', optionId: 'mild' },
      { groupId: 'spice', optionId: 'hot' },
      { groupId: 'ghost', optionId: 'x' },
      { groupId: 'extra', optionId: 'soldout' },
    ];
    const result = validateSpecSelection(selections, SPEC_GROUPS);
    expect(result.issues.map((item) => item.groupId)).toEqual(['extra', 'ghost', 'spice']);
    expect(result.issues.map((item) => item.code)).toEqual([
      'option_unavailable',
      'unknown_group',
      'single_group_multi_selected',
    ]);
  });

  it('同一输入两次得到完全相同的结果', () => {
    const selections = [
      { groupId: 'spice', optionId: 'mild' },
      { groupId: 'spice', optionId: 'hot' },
      { groupId: 'ghost', optionId: 'x' },
    ];
    const first = validateSpecSelection(selections, SPEC_GROUPS);
    const second = validateSpecSelection(selections, SPEC_GROUPS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('问题数组被冻结（调用方不能就地改）', () => {
    const result = validateSpecSelection([], SPEC_GROUPS);
    expect(Object.isFrozen(result.issues)).toBe(true);
  });
});

describe('normalizeSpecs：多选可表达、顺序无关', () => {
  it('提供规格组定义时，多选组合法且按 (groupId, optionId) 排序', () => {
    const normalized = normalizeSpecs(
      [
        { groupId: 'extra', optionId: 'bacon' },
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'egg' },
      ],
      SPEC_GROUPS,
    );
    expect(normalized).toEqual([
      { groupId: 'extra', optionId: 'bacon' },
      { groupId: 'extra', optionId: 'egg' },
      { groupId: 'spice', optionId: 'hot' },
    ]);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('书写顺序不同的同一份规格，规范字符串相同', () => {
    const a = normalizeSpecs(
      [
        { groupId: 'extra', optionId: 'egg' },
        { groupId: 'spice', optionId: 'hot' },
      ],
      SPEC_GROUPS,
    );
    const b = normalizeSpecs(
      [
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'egg' },
      ],
      SPEC_GROUPS,
    );
    expect(specsKey(a)).toBe(specsKey(b));
  });

  it('提供定义但选择不合法 ⇒ 抛 CartValidationError（不静默修正）', () => {
    expect(() =>
      normalizeSpecs(
        [
          { groupId: 'spice', optionId: 'mild' },
          { groupId: 'spice', optionId: 'hot' },
        ],
        SPEC_GROUPS,
      ),
    ).toThrow(CartValidationError);
  });

  it('不提供定义时保留单选默认：同组重复被拒（向后兼容旧用例）', () => {
    expect(() =>
      normalizeSpecs([
        { groupId: 'spice', optionId: 'mild' },
        { groupId: 'spice', optionId: 'hot' },
      ]),
    ).toThrow(CartValidationError);
  });

  it('空 id 在两条路径下都抛错', () => {
    expect(() => normalizeSpecs([{ groupId: '', optionId: 'x' }])).toThrow(CartValidationError);
    expect(() => normalizeSpecs([{ groupId: '', optionId: 'x' }], SPEC_GROUPS)).toThrow(CartValidationError);
  });
});

describe('CartState：多选规格可入车并按内容合并', () => {
  function newCart(): CartState {
    return new CartState({ merchantId: 'm1', currency: 'CNY' });
  }

  it('addLine 携带 specGroups 时可表达多选组', () => {
    const cart = newCart();
    const line = cart.addLine({
      dishId: 'd-noodle',
      skuId: 'sku-noodle',
      specs: [
        { groupId: 'extra', optionId: 'bacon' },
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'egg' },
      ],
      specGroups: SPEC_GROUPS,
    });
    expect(line.specs).toEqual([
      { groupId: 'extra', optionId: 'bacon' },
      { groupId: 'extra', optionId: 'egg' },
      { groupId: 'spice', optionId: 'hot' },
    ]);
  });

  it('同内容（含多选）重复加入合并数量、保留先到 lineId', () => {
    const cart = newCart();
    const specs = [
      { groupId: 'spice', optionId: 'hot' },
      { groupId: 'extra', optionId: 'egg' },
      { groupId: 'extra', optionId: 'bacon' },
    ];
    const first = cart.addLine({ dishId: 'd', skuId: 's', specs, specGroups: SPEC_GROUPS });
    const second = cart.addLine({ dishId: 'd', skuId: 's', specs, specGroups: SPEC_GROUPS });
    expect(second.lineId).toBe(first.lineId);
    expect(second.quantity).toBe(2);
    expect(cart.lines).toHaveLength(1);
  });

  it('不同多选组合是两个条目', () => {
    const cart = newCart();
    cart.addLine({
      dishId: 'd',
      skuId: 's',
      specs: [
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'egg' },
      ],
      specGroups: SPEC_GROUPS,
    });
    cart.addLine({
      dishId: 'd',
      skuId: 's',
      specs: [
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'bacon' },
      ],
      specGroups: SPEC_GROUPS,
    });
    expect(cart.lines).toHaveLength(2);
  });

  it('不传 specGroups 时仍按单选默认拒绝同组重复（旧行为不变）', () => {
    const cart = newCart();
    expect(() =>
      cart.addLine({
        dishId: 'd',
        skuId: 's',
        specs: [
          { groupId: 'spice', optionId: 'mild' },
          { groupId: 'spice', optionId: 'hot' },
        ],
      }),
    ).toThrow(CartValidationError);
  });

  it('setLineSpecs 携带 specGroups 时可改成多选组合', () => {
    const cart = newCart();
    const line = cart.addLine({ dishId: 'd', skuId: 's', quantity: 1 });
    const updated = cart.setLineSpecs(
      line.lineId,
      [
        { groupId: 'spice', optionId: 'hot' },
        { groupId: 'extra', optionId: 'egg' },
        { groupId: 'extra', optionId: 'cheese' },
      ],
      SPEC_GROUPS,
    );
    expect(updated.specs).toEqual([
      { groupId: 'extra', optionId: 'cheese' },
      { groupId: 'extra', optionId: 'egg' },
      { groupId: 'spice', optionId: 'hot' },
    ]);
  });
});
