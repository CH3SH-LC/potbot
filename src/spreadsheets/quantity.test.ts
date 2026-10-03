import { describe, expect, it } from 'vitest';

import {
  addQuantities,
  averageQuantities,
  compareQuantities,
  divideQuantity,
  formatQuantity,
  maxQuantities,
  minQuantities,
  negateQuantity,
  parseQuantity,
  roundQuantity,
  scaleQuantity,
  subtractQuantities,
  sumQuantities,
} from './quantity.js';

describe('XLS-17：金额精度——加减不经浮点', () => {
  it('0.1 + 0.2 精确等于 0.30（浮点会给出 0.30000000000000004）', () => {
    const sum = addQuantities(parseQuantity('0.1', 2, '元', 'CNY'), parseQuantity('0.2', 2, '元', 'CNY'));
    expect(formatQuantity(sum)).toBe('0.30');
    expect(sum.amount_minor).toBe(30n);
  });

  it('对照：把浮点求和的**结果**喂进来会被显式拒绝，而不是静默吞掉误差', () => {
    expect(() => parseQuantity(0.1 + 0.2, 2, '元', 'CNY')).toThrow(/小数位超出精度/);
  });

  it('小数位多于 scale ⇒ 拒绝静默四舍五入', () => {
    expect(() => parseQuantity('1.005', 2, '元')).toThrow(/拒绝静默四舍五入/);
    expect(parseQuantity('1.00', 2, '元').amount_minor).toBe(100n);
  });

  it('十次 0.1 求和精确等于 1.00', () => {
    const rows = Array.from({ length: 10 }, () => parseQuantity('0.1', 2, '元', 'CNY'));
    const result = sumQuantities(rows);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(formatQuantity(result.quantity)).toBe('1.00');
    }
  });

  it('定点格式化：正负、scale=0、补零', () => {
    expect(formatQuantity(parseQuantity('19.99', 2, '元', 'CNY'))).toBe('19.99');
    expect(formatQuantity(parseQuantity('-19.99', 2, '元', 'CNY'))).toBe('-19.99');
    expect(formatQuantity(parseQuantity('-0.05', 2, '元', 'CNY'))).toBe('-0.05');
    expect(formatQuantity(parseQuantity('5', 0, '件'))).toBe('5');
    expect(formatQuantity(parseQuantity('0', 2, '元'))).toBe('0.00');
  });
});

describe('XLS-17：单位与币种——不同类不得相加', () => {
  it('跨单位相加显式抛', () => {
    expect(() => addQuantities(parseQuantity('1', 2, '元'), parseQuantity('1', 2, '美元'))).toThrow(
      /跨单位相加/,
    );
  });

  it('跨币种相加显式抛', () => {
    expect(() =>
      addQuantities(parseQuantity('1', 2, '元', 'CNY'), parseQuantity('1', 2, '元', 'USD')),
    ).toThrow(/跨币种相加/);
  });

  it('不同 scale 的同类量可相加（对齐到较大精度，不丢精度）', () => {
    const sum = addQuantities(parseQuantity('1', 0, '元'), parseQuantity('0.25', 2, '元'));
    expect(formatQuantity(sum)).toBe('1.25');
  });

  it('比较按最小单位进行，不受 scale 影响', () => {
    expect(compareQuantities(parseQuantity('1.5', 1, '元'), parseQuantity('1.50', 2, '元'))).toBe(0);
    expect(compareQuantities(parseQuantity('1.4', 1, '元'), parseQuantity('1.50', 2, '元'))).toBe(-1);
    expect(compareQuantities(parseQuantity('1.6', 1, '元'), parseQuantity('1.50', 2, '元'))).toBe(1);
    expect(() => compareQuantities(parseQuantity('1', 0, '元'), parseQuantity('1', 0, '件'))).toThrow(
      /跨单位/,
    );
  });
});

describe('R248：缺失不当零——空求和不是 0', () => {
  it('空列表求和 ⇒ empty，绝不返回 0', () => {
    const result = sumQuantities([]);
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(result.ok).toBe(false);
  });

  it('混合单位 ⇒ unit_mismatch（不挑一个单位硬算）', () => {
    expect(sumQuantities([parseQuantity('1', 0, '元'), parseQuantity('1', 0, '件')])).toEqual({
      ok: false,
      reason: 'unit_mismatch',
    });
  });

  it('混合币种同样拒绝', () => {
    expect(
      sumQuantities([parseQuantity('1', 0, '元', 'CNY'), parseQuantity('1', 0, '元', 'USD')]),
    ).toEqual({ ok: false, reason: 'unit_mismatch' });
  });

  it('对照：单元素求和给出该元素本身（证明 empty 不是恒假）', () => {
    const result = sumQuantities([parseQuantity('7.77', 2, '元', 'CNY')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(formatQuantity(result.quantity)).toBe('7.77');
    }
  });
});

describe('XLS-17 增量：聚合原语（减法 / 舍入 / 除法 / 极值 / 平均，全程不经浮点）', () => {
  const 元 = (amount: string, scale = 2): ReturnType<typeof parseQuantity> =>
    parseQuantity(amount, scale, '元', 'CNY');

  it('减法精确：1.00 - 0.30 = 0.70；与"加上取反"一致', () => {
    expect(formatQuantity(subtractQuantities(元('1.00'), 元('0.30')))).toBe('0.70');
    expect(
      formatQuantity(addQuantities(元('1.00'), negateQuantity(元('0.30')))),
    ).toBe('0.70');
  });

  it('取反：值取负、scale / 单位 / 币种不变', () => {
    const negated = negateQuantity(元('-0.05'));
    expect(formatQuantity(negated)).toBe('0.05');
    expect(negated.scale).toBe(2);
    expect(negated.unit).toBe('元');
    expect(negated.currency).toBe('CNY');
  });

  it('降精度必须显式舍入：half_away 2.5 → 3，half_even 2.5 → 2', () => {
    const two_half = parseQuantity('2.5', 1, '元', 'CNY');
    expect(formatQuantity(roundQuantity(two_half, 0, 'half_away_from_zero'))).toBe('3');
    expect(formatQuantity(roundQuantity(two_half, 0, 'half_even'))).toBe('2');
  });

  it('负数舍入按模式正确：-1.5 → floor -2 / ceil -1 / truncate -1', () => {
    const negative = parseQuantity('-1.5', 1, '元', 'CNY');
    expect(formatQuantity(roundQuantity(negative, 0, 'floor'))).toBe('-2');
    expect(formatQuantity(roundQuantity(negative, 0, 'ceil'))).toBe('-1');
    expect(formatQuantity(roundQuantity(negative, 0, 'truncate'))).toBe('-1');
  });

  it('升精度无损：scaleQuantity / roundQuantity 到更高精度只补零', () => {
    expect(formatQuantity(scaleQuantity(元('1.5', 1), 3))).toBe('1.500');
    expect(formatQuantity(roundQuantity(元('1.5', 1), 3, 'half_away_from_zero'))).toBe('1.500');
  });

  it('降精度不得静默：scaleQuantity 直接降到更低精度 ⇒ 抛（须走 roundQuantity）', () => {
    expect(() => scaleQuantity(元('1.50'), 1)).toThrow(/会丢精度/);
    expect(() => roundQuantity(元('1.50'), 3, 'half_away_from_zero')).not.toThrow();
  });

  it('除法：10.00 ÷ 3 到 4 位 = 3.3333；除数非正 ⇒ 抛', () => {
    expect(formatQuantity(divideQuantity(元('10.00'), 3n, 4, 'half_away_from_zero'))).toBe('3.3333');
    expect(() => divideQuantity(元('10.00'), 0n, 4, 'half_away_from_zero')).toThrow(/正整数/);
    // 目标 scale 低于被除量精度 ⇒ 拒绝（先显式舍入）
    expect(() => divideQuantity(元('10.00'), 3n, 1, 'half_away_from_zero')).toThrow(/先显式舍入/);
  });

  it('平均 = 精确求和 ÷ 个数再显式舍入：[1,2,2] 到 0 位 half_away = 2', () => {
    const average = averageQuantities([元('1', 0), 元('2', 0), 元('2', 0)], 0, 'half_away_from_zero');
    expect(average.ok).toBe(true);
    if (average.ok) {
      expect(formatQuantity(average.quantity)).toBe('2');
    }
  });

  it('极值返回**原元素**（保留自身 scale），比较按最小单位进行', () => {
    const list = [元('1.5', 1), 元('1.50'), 元('2', 0)];
    const min = minQuantities(list);
    const max = maxQuantities(list);
    expect(min.ok && formatQuantity(min.quantity)).toBe('1.5'); // 原元素，不是 1.50
    expect(max.ok && formatQuantity(max.quantity)).toBe('2');
    expect(min.ok && compareQuantities(min.quantity, 元('1.50'))).toBe(0);
  });

  it('R248：空集合对 min / max / average 都是 empty（不是 0）', () => {
    expect(minQuantities([])).toEqual({ ok: false, reason: 'empty' });
    expect(maxQuantities([])).toEqual({ ok: false, reason: 'empty' });
    expect(averageQuantities([], 2, 'half_away_from_zero')).toEqual({ ok: false, reason: 'empty' });
  });

  it('R248：混合单位对 min / max 也拒绝（不挑一个单位硬算）', () => {
    expect(minQuantities([元('1', 0), parseQuantity('1', 0, '件')])).toEqual({
      ok: false,
      reason: 'unit_mismatch',
    });
    expect(maxQuantities([元('1', 0), parseQuantity('1', 0, '件')])).toEqual({
      ok: false,
      reason: 'unit_mismatch',
    });
  });
});
