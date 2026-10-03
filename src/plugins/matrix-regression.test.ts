/**
 * 回归矩阵单测（design-06 P6 / PLG-08；合同 R228 / R230 / R231 / R233 / R240）。
 *
 * 覆盖：
 * - **正例**：五场景 × 受控目录（默认内置十项）成表，每格判据可判别、观测值可机械核对；
 * - **可扩展**：矩阵行数由**传入的受控目录**决定（7 模板 → 扩展三角色 = 10 行）；
 * - **反例 1**：受控目录扩展**拒绝重复 id**（同一插件两行会让矩阵产生歧义）；
 * - **反例 2**：形状破损（缺列 / 判据漂移）的矩阵**不得**冒充全量回归，一律抛错；
 * - **反例 3/4（I-3 反向对照）**：结论与观测值不符（标 `passed` 却没成功 / 撤权没生效）的矩阵抛错
 *   —— 证明判据**独立于产出的矩阵**，不是"判据字段 === 定义表"那种恒真比对；
 * - **诚实口径**：stub / 未接通照旧 `not_ready`，矩阵不改写结论。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import { BASE_ROLES, BUSINESS_TEMPLATES, PLUGIN_CATALOG } from './catalog.js';
import {
  assertMatrixShape,
  buildRegressionMatrix,
  extendControlledCatalog,
  summarizeMatrix,
  type RegressionMatrix,
} from './matrix-regression.js';
import { REGRESSION_SCENARIOS, verifyRegressionCriterion } from './regression.js';
import type { DiscoveryProbes } from './registry.js';

const L = asLogicalTime;

function makeClock(): () => ReturnType<typeof asLogicalTime> {
  let tick = 0;
  return () => {
    tick += 1;
    return L(tick);
  };
}

/** 探针：所有适配器就绪、所有能力实测支持（构造"真正就绪"的正例）。 */
const allReady: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};

describe('PLG-08 回归矩阵：五场景 × 受控目录', () => {
  const matrix = buildRegressionMatrix({ probes: allReady, clock: makeClock() });

  it('默认目录 = 十项 × 五场景，格数 = 行数 × 场景数', () => {
    expect(matrix.rows).toHaveLength(PLUGIN_CATALOG.length);
    expect(matrix.rows).toHaveLength(10);
    expect([...matrix.scenarios]).toEqual([...REGRESSION_SCENARIOS]);
    for (const row of matrix.rows) {
      expect(row.cells).toHaveLength(REGRESSION_SCENARIOS.length);
      for (const cell of row.cells) {
        expect(Object.keys(cell.observed).length).toBeGreaterThan(0);
        // 承重：只看观测值核验结论属实（独立判据，不是"判据文本 === 定义表"的恒真比对）
        expect(verifyRegressionCriterion(cell.scenario, cell.status, cell.observed).ok).toBe(true);
      }
    }
    const summary = summarizeMatrix(matrix);
    expect(summary.cell_count).toBe(50);
    for (const scenario of REGRESSION_SCENARIOS) {
      const counts = summary.status_counts[scenario];
      expect(counts.passed + counts.failed + counts.not_ready).toBe(matrix.rows.length);
    }
  });

  it('诚实口径：real 模板的成功场景 passed，stub 模板的成功场景如实 not_ready', () => {
    const document = matrix.rows.find((row) => row.plugin_id === 'template.document');
    expect(document?.cells.find((cell) => cell.scenario === 'success')?.status).toBe('passed');
    const meituan = matrix.rows.find((row) => row.plugin_id === 'template.meituan');
    expect(meituan?.cells.find((cell) => cell.scenario === 'success')?.status).toBe('not_ready');
    expect(meituan?.implementation).toBe('stub');
  });
});

describe('PLG-08 受控模板目录：可扩展，但扩展只允许追加', () => {
  it('矩阵行数由传入目录决定：7 模板 vs 扩展三角色后的 10 项', () => {
    const templatesOnly = buildRegressionMatrix({ catalog: BUSINESS_TEMPLATES, probes: allReady, clock: makeClock() });
    expect(templatesOnly.rows).toHaveLength(BUSINESS_TEMPLATES.length);
    expect(templatesOnly.rows).toHaveLength(7);

    const extended = extendControlledCatalog(BUSINESS_TEMPLATES, BASE_ROLES);
    expect(extended).toHaveLength(PLUGIN_CATALOG.length);
    expect(extended).toHaveLength(10);
    const matrix = buildRegressionMatrix({ catalog: extended, probes: allReady, clock: makeClock() });
    expect(matrix.rows).toHaveLength(10);
    expect(summarizeMatrix(matrix).cell_count).toBe(50);
  });

  it('恒等扩展（追加空数组）合法', () => {
    expect(extendControlledCatalog(BUSINESS_TEMPLATES, [])).toHaveLength(BUSINESS_TEMPLATES.length);
  });

  it('反例：追加重复 id ⇒ 结构化抛错（矩阵同一插件只能有一行）', () => {
    const duplicate = BUSINESS_TEMPLATES[0]!;
    expect(() => extendControlledCatalog(BUSINESS_TEMPLATES, [duplicate])).toThrow(/重复 id/);
  });
});

describe('PLG-08 反例：形状破损的矩阵不得冒充全量回归', () => {
  const matrix = buildRegressionMatrix({ probes: allReady, clock: makeClock() });

  it('缺一个场景列 ⇒ 抛错', () => {
    const row = matrix.rows[0]!;
    const broken: RegressionMatrix = {
      scenarios: matrix.scenarios,
      rows: [{ ...row, cells: row.cells.filter((cell) => cell.scenario !== 'restart') }],
    };
    expect(() => assertMatrixShape(broken)).toThrow(/缺少场景/);
    expect(() => summarizeMatrix(broken)).toThrow(/缺少场景/);
  });

  it('判据漂移（与标准判据不一致）⇒ 抛错', () => {
    const row = matrix.rows[0]!;
    const firstCell = row.cells[0]!;
    const drifted: RegressionMatrix = {
      scenarios: matrix.scenarios,
      rows: [{ ...row, cells: [{ ...firstCell, criterion: '一句自拟的宽松判据' }, ...row.cells.slice(1)] }],
    };
    expect(() => assertMatrixShape(drifted)).toThrow(/判据/);
  });

  it('反例 3（I-3 反向对照）：某格标 passed 但观测值不满足其自称判据 ⇒ 抛错', () => {
    const row = matrix.rows.find((candidate) =>
      candidate.cells.some((cell) => cell.scenario === 'success' && cell.status === 'passed'),
    )!;
    const original = row.cells.find((cell) => cell.scenario === 'success')!;
    // 保留原判据文本与 passed 结论，只把观测值改成"五态没全真"（= 观测值不再满足它自称的判据）
    const cells = row.cells.map((cell) =>
      cell.scenario === 'success'
        ? {
            ...cell,
            observed: {
              installed: true,
              enabled: true,
              authorized: true,
              dependencies_ready: true,
              actually_supported: false,
              ready: false,
              gate_ok: false,
            },
          }
        : cell,
    );
    const contradicted: RegressionMatrix = { scenarios: matrix.scenarios, rows: [{ ...row, cells }] };
    // 判据文本未改（这正是原自证式比对**抓不到**的情形），新判据据观测值把它揪出来
    expect(cells.find((cell) => cell.scenario === 'success')!.criterion).toBe(original.criterion);
    expect(() => assertMatrixShape(contradicted)).toThrow(/观测值不符/);
    expect(() => summarizeMatrix(contradicted)).toThrow(/观测值不符/);
  });

  it('反例 4（I-3 反向对照）：某格标 passed 但"撤权未生效"⇒ 抛错', () => {
    const row = matrix.rows.find((candidate) =>
      candidate.cells.some((cell) => cell.scenario === 'permission_revoked' && cell.status === 'passed'),
    )!;
    const cells = row.cells.map((cell) =>
      cell.scenario === 'permission_revoked'
        ? {
            ...cell,
            observed: {
              initial_gate_ok: true,
              revoked_gate_ok: true, // 撤权后仍能建实例 ⇒ 与 passed 矛盾
              revoked_reason_has_unauthorized: false,
              restored_gate_ok: true,
            },
          }
        : cell,
    );
    const contradicted: RegressionMatrix = { scenarios: matrix.scenarios, rows: [{ ...row, cells }] };
    expect(() => assertMatrixShape(contradicted)).toThrow(/观测值不符/);
  });
});
