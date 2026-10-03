/**
 * F05 验收：多方案比较。
 *
 * 反向对照：币种/范围不一致时必须**拒绝比价**（`comparable === false` 且 cheapest 为 null），
 * 不得给出一个看似合理的「最便宜」。
 */

import { describe, expect, it } from 'vitest';

import {
  amountToScaledUnits,
  compareOptions,
  type ConfirmScope,
  type OptionView,
} from '../../../apps/mobile-ui/src/decisions/index.js';

function option(
  optionId: string,
  amount: string,
  currency = 'CNY',
  scope: ConfirmScope = 'purchase',
): OptionView {
  return {
    optionId,
    label: optionId,
    price: { amount, currency },
    subject: { objectRef: `sku:${optionId}`, objectLabel: optionId },
    scope,
  };
}

describe('F05 / 金额定标（避免浮点）', () => {
  it('十进制字符串转定标整数，位数不同但同值相等', () => {
    expect(amountToScaledUnits('29.9')).toBe(299000);
    expect(amountToScaledUnits('29.9000')).toBe(299000);
    expect(amountToScaledUnits('0')).toBe(0);
    expect(amountToScaledUnits('100')).toBe(1000000);
    expect(amountToScaledUnits('29.9')).toBe(amountToScaledUnits('29.9000'));
  });

  it('非法金额返回 null', () => {
    expect(amountToScaledUnits('29.99999')).toBeNull();
    expect(amountToScaledUnits('29.9.9')).toBeNull();
    expect(amountToScaledUnits('-1')).toBeNull();
    expect(amountToScaledUnits('')).toBeNull();
  });
});

describe('F05 / 方案比较', () => {
  it('同币种同范围：可比，最便宜取金额最小者，按升序排名', () => {
    const comparison = compareOptions([option('a', '29.90'), option('b', '22.00'), option('c', '35.00')]);
    expect(comparison.comparable).toBe(true);
    expect(comparison.cheapestOptionId).toBe('b');
    expect(comparison.cheapestIsTied).toBe(false);
    expect(comparison.rankedOptionIds).toEqual(['b', 'a', 'c']);
  });

  it('同额并列：cheapestIsTied 为真，仍给出确定的最便宜 id', () => {
    const comparison = compareOptions([option('a', '20.00'), option('b', '20.00')]);
    expect(comparison.cheapestOptionId).toBe('a');
    expect(comparison.cheapestIsTied).toBe(true);
    expect(comparison.rankedOptionIds).toEqual(['a', 'b']);
  });

  it('反向对照：币种不一致时拒绝比价（cheapest 恒为 null）', () => {
    const comparison = compareOptions([option('a', '29.90', 'CNY'), option('b', '5.00', 'USD')]);
    expect(comparison.comparable).toBe(false);
    expect(comparison.cheapestOptionId).toBeNull();
    expect(comparison.note).toContain('币种');
    // 不可比时保持原序并列展示，不做任何排序暗示。
    expect(comparison.rankedOptionIds).toEqual(['a', 'b']);
  });

  it('反向对照：范围不一致时拒绝比价', () => {
    const comparison = compareOptions([option('a', '29.90', 'CNY', 'purchase'), option('b', '10.00', 'CNY', 'payment')]);
    expect(comparison.comparable).toBe(false);
    expect(comparison.cheapestOptionId).toBeNull();
    expect(comparison.note).toContain('范围');
  });

  it('金额不可解析时可比但不排序（cheapest 为 null）', () => {
    const comparison = compareOptions([option('a', '29.90'), option('b', 'oops')]);
    expect(comparison.comparable).toBe(true);
    expect(comparison.cheapestOptionId).toBeNull();
    expect(comparison.note).toContain('无法解析');
  });

  it('空方案集：不可比且无最便宜', () => {
    const comparison = compareOptions([]);
    expect(comparison.comparable).toBe(false);
    expect(comparison.cheapestOptionId).toBeNull();
    expect(comparison.rankedOptionIds).toEqual([]);
  });

  it('选中项不在候选内时被规范化为 null（不编造选中）', () => {
    const comparison = compareOptions([option('a', '29.90'), option('b', '22.00')], 'zzz');
    expect(comparison.selectedOptionId).toBeNull();
    const ok = compareOptions([option('a', '29.90'), option('b', '22.00')], 'b');
    expect(ok.selectedOptionId).toBe('b');
  });

  it('单个方案：可比，其自身即最便宜', () => {
    const comparison = compareOptions([option('a', '29.90')]);
    expect(comparison.comparable).toBe(true);
    expect(comparison.cheapestOptionId).toBe('a');
    expect(comparison.cheapestIsTied).toBe(false);
  });
});
