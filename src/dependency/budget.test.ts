/**
 * 诊断预算判定单测（D05；Q9-a / §九-8）。
 *
 * 锁定 A05-01 的纪律：**上限必须在场景执行前给出**；缺登记、形状非法、超限都必须
 * **报错或明确报告**，绝不静默通过、绝不"失败后调大"。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIAGNOSIS_BUDGET,
  DEFAULT_RUN_LIMIT,
  DEFAULT_TIME_BUDGET,
} from '../protocol/index.js';
import {
  addBudgetUsage,
  assertWithinBudget,
  DEFAULT_SCENARIO_LIMITS,
  diagnosisUsage,
  DiagnosisBudgetError,
  DiagnosisBudgetExceededError,
  evaluateBudget,
  normalizeBudgetLimits,
  ZERO_BUDGET_USAGE,
} from './index.js';

describe('默认上限（组装自 protocol 常量，不另起一套）', () => {
  it('D=4 / R=6 / T=10000', () => {
    expect(DEFAULT_SCENARIO_LIMITS).toEqual({
      runs: DEFAULT_RUN_LIMIT,
      diagnoses: DEFAULT_DIAGNOSIS_BUDGET,
      time: DEFAULT_TIME_BUDGET,
    });
    expect(DEFAULT_SCENARIO_LIMITS).toEqual({ runs: 6, diagnoses: 4, time: 10000 });
  });
});

describe('未登记上限 ⇒ 拒绝判定（A05-01）', () => {
  it('undefined / null 都抛 DiagnosisBudgetError，而不是取默认值', () => {
    expect(() => evaluateBudget(undefined)).toThrow(DiagnosisBudgetError);
    expect(() => evaluateBudget(null)).toThrow(DiagnosisBudgetError);
    expect(() => assertWithinBudget(undefined)).toThrow(/必须在场景执行前由调用方给出/);
  });

  it('形状非法（负数 / NaN / 字符串）⇒ 抛错', () => {
    expect(() => normalizeBudgetLimits({ runs: -1, diagnoses: 1, time: 1 })).toThrow(
      DiagnosisBudgetError,
    );
    expect(() => normalizeBudgetLimits({ runs: Number.NaN, diagnoses: 1, time: 1 })).toThrow(
      DiagnosisBudgetError,
    );
    expect(() =>
      normalizeBudgetLimits({ runs: 'x' as unknown as number, diagnoses: 1, time: 1 }),
    ).toThrow(DiagnosisBudgetError);
  });

  it('用量非法（负数 / NaN）⇒ 抛错', () => {
    expect(() => evaluateBudget(DEFAULT_SCENARIO_LIMITS, { runs: -1 })).toThrow(DiagnosisBudgetError);
    expect(() => evaluateBudget(DEFAULT_SCENARIO_LIMITS, { diagnoses: Number.NaN })).toThrow(
      DiagnosisBudgetError,
    );
  });
});

describe('在预算内 / 恰在预算点 / 超限', () => {
  it('未超限 ⇒ ok、exceeded 为空', () => {
    const evaluation = evaluateBudget({ runs: 6, diagnoses: 4, time: 100 }, { runs: 2, diagnoses: 3, time: 50 });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.exceeded).toEqual([]);
    expect(evaluation.exhausted).toEqual([]);
  });

  it('**恰在预算点**（用量 == 上限）不算超限（A05-05 允许恰在预算点收敛）', () => {
    const evaluation = evaluateBudget({ runs: 6, diagnoses: 4, time: 100 }, { runs: 6, diagnoses: 4, time: 100 });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.exceeded).toEqual([]);
    expect(evaluation.exhausted).toEqual(['runs', 'diagnoses', 'time']);
  });

  it('超限 ⇒ exceeded 列出维度，assertWithinBudget 抛 DiagnosisBudgetExceededError', () => {
    const limits = { runs: 6, diagnoses: 4, time: 100 };
    const usage = { runs: 7, diagnoses: 4, time: 101 };
    const evaluation = evaluateBudget(limits, usage);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.exceeded).toEqual(['runs', 'time']);

    let caught: unknown;
    try {
      assertWithinBudget(limits, usage);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiagnosisBudgetExceededError);
    expect((caught as DiagnosisBudgetExceededError).exceeded).toEqual(['runs', 'time']);
    expect((caught as DiagnosisBudgetExceededError).usage.runs).toBe(7);
    expect((caught as DiagnosisBudgetExceededError).limits.runs).toBe(6);
    expect((caught as Error).message).toContain('禁止失败后调大');
  });
});

describe('用量算术', () => {
  it('addBudgetUsage / diagnosisUsage 不修改入参', () => {
    const base = { runs: 1, diagnoses: 2, time: 3 };
    const next = addBudgetUsage(base, diagnosisUsage(1));
    expect(next).toEqual({ runs: 1, diagnoses: 3, time: 3 });
    expect(base).toEqual({ runs: 1, diagnoses: 2, time: 3 });
    expect(ZERO_BUDGET_USAGE).toEqual({ runs: 0, diagnoses: 0, time: 0 });
    expect(() => diagnosisUsage(-1)).toThrow(DiagnosisBudgetError);
    expect(() => diagnosisUsage(1.5)).toThrow(DiagnosisBudgetError);
  });
});
