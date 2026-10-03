/**
 * FA-VERIFY-WAVE-4 · I-3 闭环复核：`src/plugins/{regression,matrix-regression}.ts` 的
 * 回归判据**是否真的独立于产出的矩阵**。
 *
 * 原缺陷：每格 `criterion` 从 `REGRESSION_CRITERIA` 抄来，"核对"又拿同一张表比 ⇒ 对自产矩阵恒真。
 * 修复声明：承重判据改为 `verifyRegressionCriterion(scenario, status, observed)`，只看观测值。
 *
 * 验证方独立构造下列矩阵（**不引用实现者用例**）：
 * 1. 真矩阵整表 ⇒ `assertMatrixShape` 通过（正向）。
 * 2. 把**未就绪**观测的那一格改标 `passed` ⇒ **必抛**（反向对照 1）。
 * 3. 把**已通过**的那一格改标 `failed` ⇒ **必抛**（反向对照 2）。
 * 4. 保留 `passed` 结论，但把观测值改成"未成功" ⇒ **必抛**（反向对照 3）。
 * 5. 只改 `criterion` 文本（观测值/结论不动）⇒ 仍抛（次要的人读文本漂移检查仍在）。
 * 6. `verifyRegressionCriterion` 的签名里**没有** `criterion` 入参——判据函数结构上读不到判据文本。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import { PLUGIN_CATALOG } from '../../../src/plugins/catalog.js';
import {
  assertMatrixShape,
  buildRegressionMatrix,
  type RegressionMatrix,
} from '../../../src/plugins/matrix-regression.js';
import { REGRESSION_SCENARIOS, verifyRegressionCriterion } from '../../../src/plugins/regression.js';
import type { DiscoveryProbes } from '../../../src/plugins/registry.js';

const L = asLogicalTime;

function makeClock(): () => ReturnType<typeof asLogicalTime> {
  let tick = 0;
  return () => {
    tick += 1;
    return L(tick);
  };
}

/** 验证方自造探针：全部就绪 / 全部实测支持（构造"真正就绪"的输入，与实现者用例独立）。 */
const readyProbes: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};

function realMatrix(): RegressionMatrix {
  return buildRegressionMatrix({ probes: readyProbes, clock: makeClock() });
}

/** 深拷贝成可变对象（矩阵本身被冻结，故走 JSON 往返；观测值全是标量，往返无损）。 */
function mutableCopy(matrix: RegressionMatrix): RegressionMatrix {
  return JSON.parse(JSON.stringify(matrix)) as unknown as RegressionMatrix;
}

function cellOf(matrix: RegressionMatrix, rowIndex: number, scenario: string) {
  const row = matrix.rows[rowIndex];
  if (row === undefined) throw new Error('row 缺失');
  const cell = row.cells.find((candidate) => candidate.scenario === scenario);
  if (cell === undefined) throw new Error('cell 缺失');
  return { row, cell };
}

describe('V4-I-3 · 真矩阵正向', () => {
  it('自产矩阵整表通过 assertMatrixShape，格数 = 行数 × 场景数', () => {
    const matrix = realMatrix();
    const cells = assertMatrixShape(matrix);
    expect(cells).toBe(matrix.rows.length * REGRESSION_SCENARIOS.length);
    expect(matrix.rows).toHaveLength(PLUGIN_CATALOG.length);
  });

  it('每一格的结论都被**其自身观测值**支持（承重判据的机器化对账）', () => {
    const matrix = realMatrix();
    for (const row of matrix.rows) {
      for (const cell of row.cells) {
        const verdict = verifyRegressionCriterion(cell.scenario, cell.status, cell.observed);
        expect(verdict.ok, `${row.plugin_id}/${cell.scenario} 结论 ${cell.status} 未被观测值支持：${verdict.reason}`).toBe(
          true,
        );
      }
    }
  });
});

describe('V4-I-3 · 反向对照：结论与观测值不符必须报错', () => {
  /** 找一格"结论不是 passed"的（stub 模板的 success 场景恒 not_ready）。 */
  function findNonPassedCell(matrix: RegressionMatrix): { rowIndex: number; scenario: string } {
    for (let r = 0; r < matrix.rows.length; r += 1) {
      const row = matrix.rows[r];
      if (row === undefined) continue;
      for (const cell of row.cells) {
        if (cell.status !== 'passed') return { rowIndex: r, scenario: cell.scenario };
      }
    }
    throw new Error('找不到非 passed 的格子：无法构造反向对照');
  }

  it('把"未通过"的格子改标 passed ⇒ 抛（观测值不支持该结论）', () => {
    const matrix = mutableCopy(realMatrix());
    const { rowIndex, scenario } = findNonPassedCell(matrix);
    const { row, cell } = cellOf(matrix, rowIndex, scenario);
    // 该格原本不是 passed（not_ready / failed），强行标 passed。
    (cell as { status: string }).status = 'passed';
    expect(() => assertMatrixShape(matrix)).toThrow(/观测值|结论/);
    expect(row.plugin_id.length).toBeGreaterThan(0);
  });

  it('把"已通过"的格子改标 failed ⇒ 抛', () => {
    const matrix = mutableCopy(realMatrix());
    let target: { rowIndex: number; scenario: string } | null = null;
    for (let r = 0; r < matrix.rows.length && target === null; r += 1) {
      const row = matrix.rows[r];
      if (row === undefined) continue;
      for (const cell of row.cells) {
        if (cell.status === 'passed') {
          target = { rowIndex: r, scenario: cell.scenario };
          break;
        }
      }
    }
    expect(target).not.toBeNull();
    if (target === null) return;
    const { cell } = cellOf(matrix, target.rowIndex, target.scenario);
    (cell as { status: string }).status = 'failed';
    expect(() => assertMatrixShape(matrix)).toThrow(/观测值|结论/);
  });

  it('保留 passed 结论但篡改观测值 ⇒ 抛（判据真的在看观测值）', () => {
    const matrix = mutableCopy(realMatrix());
    // 找一格 scenario=success 且 status=passed 的（真模板）。
    let target: { rowIndex: number; scenario: string } | null = null;
    for (let r = 0; r < matrix.rows.length && target === null; r += 1) {
      const row = matrix.rows[r];
      if (row === undefined) continue;
      for (const cell of row.cells) {
        if (cell.scenario === 'success' && cell.status === 'passed') {
          target = { rowIndex: r, scenario: 'success' };
          break;
        }
      }
    }
    expect(target).not.toBeNull();
    if (target === null) return;
    const { cell } = cellOf(matrix, target.rowIndex, target.scenario);
    const observed = cell.observed as Record<string, string | number | boolean>;
    expect(observed['installed']).toBe(true);
    observed['installed'] = false; // 观测值改成"未装机"，结论仍是 passed
    expect(() => assertMatrixShape(matrix)).toThrow(/观测值|结论/);
  });

  it('只改 criterion 文本（次要检查）⇒ 仍抛', () => {
    const matrix = mutableCopy(realMatrix());
    const { cell } = cellOf(matrix, 0, 'success');
    (cell as { criterion: string }).criterion = '验证方自拟的假判据文本';
    expect(() => assertMatrixShape(matrix)).toThrow(/判据/);
  });
});

describe('V4-I-3 · 判据函数的独立性（结构性）', () => {
  it('verifyRegressionCriterion 的入参不含 criterion 文本（只吃 scenario/status/observed）', () => {
    expect(verifyRegressionCriterion.length).toBe(3);
  });

  it('同一观测值+结论下，判据结果与"人读判据文本"无关（函数拿不到它）', () => {
    const matrix = realMatrix();
    const { cell } = cellOf(matrix, 0, 'success');
    const a = verifyRegressionCriterion(cell.scenario, cell.status, cell.observed);
    const b = verifyRegressionCriterion(cell.scenario, cell.status, { ...cell.observed });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it('空观测值 + passed ⇒ 判据拒绝（不是"没证据也算过"）', () => {
    const verdict = verifyRegressionCriterion('success', 'passed', {});
    expect(verdict.ok).toBe(false);
  });

  it('空观测值 + failed ⇒ 判据拒绝（没有"被违反"的证据）', () => {
    const verdict = verifyRegressionCriterion('failure_unknown', 'failed', {});
    expect(verdict.ok).toBe(false);
  });

  it('failure_unknown：结构化失败证据齐全才放行 passed', () => {
    const good = verifyRegressionCriterion('failure_unknown', 'passed', {
      install_ok: false,
      install_reason: 'unknown_plugin',
      discover_is_undefined: true,
    });
    expect(good.ok).toBe(true);
    const bad = verifyRegressionCriterion('failure_unknown', 'passed', {
      install_ok: true,
      install_reason: 'ok',
      discover_is_undefined: true,
    });
    expect(bad.ok).toBe(false);
  });
});
