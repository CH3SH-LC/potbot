import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIAGNOSIS_BUDGET,
  DEFAULT_RUN_LIMIT,
  DEFAULT_TIME_BUDGET,
  asLogicalTime,
} from '../protocol/index.js';
import { BudgetExceededError, BudgetLedger, DEFAULT_SCENARIO_BUDGET, LogicalClock } from './index.js';

const t = (value: number) => asLogicalTime(value);

describe('预算上限：引用 protocol 默认值，执行前登记，登记后不可调大', () => {
  it('默认预算就是 protocol 的 R=6 / D=4 / T=10000（合同 Q9-a）', () => {
    expect(DEFAULT_SCENARIO_BUDGET).toEqual({
      runs: DEFAULT_RUN_LIMIT,
      diagnoses: DEFAULT_DIAGNOSIS_BUDGET,
      time: DEFAULT_TIME_BUDGET,
    });
    expect(DEFAULT_SCENARIO_BUDGET).toEqual({ runs: 6, diagnoses: 4, time: 10000 });
  });

  it('上限对象被冻结：没有 setter，改不动（结构上堵住「失败后调大」）', () => {
    const budget = new BudgetLedger({ runs: 2, diagnoses: 1, time: 20 });
    expect(Object.isFrozen(budget.limits)).toBe(true);
    expect(() => {
      (budget.limits as { runs: number }).runs = 99;
    }).toThrow(TypeError);
    expect(budget.limits.runs).toBe(2);
  });

  it('登记时刻可显式给出（A05-01：登记必须早于运行）', () => {
    const clock = new LogicalClock();
    const before = clock.now();
    const budget = new BudgetLedger(DEFAULT_SCENARIO_BUDGET, { registeredAt: before });
    clock.advance(1, '运行开始');
    expect(budget.registeredAt).toBeLessThan(clock.now());
  });

  it('非法上限显式抛错', () => {
    expect(() => new BudgetLedger({ runs: -1, diagnoses: 1, time: 1 })).toThrow(RangeError);
    expect(() => new BudgetLedger({ runs: 1, diagnoses: Number.NaN, time: 1 })).toThrow(RangeError);
  });
});

describe('预算记账', () => {
  it('逐笔累加并留痕，超限时抛 BudgetExceededError 且列出超限项', () => {
    const budget = new BudgetLedger({ runs: 2, diagnoses: 1, time: 20 }, { registeredAt: t(0) });
    budget.charge('runs', 1, { at: t(1), label: 'run-1' });
    budget.charge('runs', 1, { at: t(2), label: 'run-2' });
    expect(budget.used('runs')).toBe(2);
    expect(budget.remaining('runs')).toBe(0);
    expect(budget.isExhausted('runs')).toBe(true);
    budget.assertWithinBudget(); // 恰好用满不算超

    budget.charge('diagnoses', 2, { at: t(3), label: '超一次' });
    expect(budget.exceededKinds()).toEqual(['diagnoses']);
    expect(() => budget.assertWithinBudget()).toThrow(BudgetExceededError);
    try {
      budget.assertWithinBudget();
    } catch (error) {
      expect((error as BudgetExceededError).exceeded).toEqual(['diagnoses']);
      expect((error as BudgetExceededError).message).toMatch(/禁止失败后调大/);
    }
    expect(budget.snapshot().charges).toHaveLength(3);
  });

  it('按逻辑时钟累计推进量同步时间用量（A05-04 的判据原料）', () => {
    const clock = new LogicalClock();
    const budget = new BudgetLedger({ runs: 1, diagnoses: 1, time: 10 });
    clock.advance(3, 'a');
    clock.advance(4, 'b');
    budget.chargeTimeFrom(clock, clock.now());
    expect(budget.used('time')).toBe(7);
    expect(budget.remaining('time')).toBe(3);

    // 时钟继续走 → 再同步只记增量
    clock.advance(5, 'c');
    budget.chargeTimeFrom(clock, clock.now());
    expect(budget.used('time')).toBe(12);
    expect(budget.exceededKinds()).toEqual(['time']);
  });

  it('时间不可倒流：时钟累计量小于已记账量时显式抛错', () => {
    const clock = new LogicalClock();
    const budget = new BudgetLedger({ runs: 1, diagnoses: 1, time: 10 });
    budget.charge('time', 5);
    expect(() => budget.chargeTimeFrom(clock)).toThrow(RangeError);
  });

  it('非法记账量显式抛错', () => {
    const budget = new BudgetLedger({ runs: 1, diagnoses: 1, time: 1 });
    expect(() => budget.charge('runs', -1)).toThrow(RangeError);
    expect(() => budget.charge('runs', Number.NaN)).toThrow(RangeError);
  });

  it('snapshot 是完整证据：上限 / 用量 / 剩余 / 登记时刻 / 逐笔记录', () => {
    const budget = new BudgetLedger({ runs: 2, diagnoses: 1, time: 20 }, { registeredAt: t(0) });
    budget.charge('runs', 1, { at: t(1), label: 'run-1' });
    expect(budget.snapshot()).toEqual({
      limits: { runs: 2, diagnoses: 1, time: 20 },
      usage: { runs: 1, diagnoses: 0, time: 0 },
      remaining: { runs: 1, diagnoses: 1, time: 20 },
      registered_at: 0,
      charges: [{ index: 1, kind: 'runs', amount: 1, total: 1, at: 1, label: 'run-1' }],
    });
  });
});
