/**
 * 每模板回归单测（design-06 P6 / PLG-08；合同 R228 / R230 / R231 / R232 / R233 / R240）。
 *
 * 覆盖 **七模板 × 三角色 × 五场景**；对**每个**（插件 × 场景）都断言：
 * - 回归判据**已写出**且可判别（`criterion` 非空、等于 `REGRESSION_CRITERIA`）；
 * - 结论**如实**：`real` 模板的成功 / 更新 / 撤权场景 `passed`；`stub` 与三角色**如实 `not_ready`**；
 *   `failure_unknown` 与 `restart` 对全部插件可评估且 `passed`。
 *
 * 另含 **R232** 分隔建模断言：文件类型枚举里**不得**混入美团 / 时钟 / 日历 / 检索。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import {
  BUSINESS_TEMPLATES,
  FILE_FORMAT_KINDS,
  PLUGIN_CATALOG,
  REGRESSION_CRITERIA,
  REGRESSION_SCENARIOS,
  createPluginRegistry,
  runCatalogRegression,
  runPluginRegression,
  verifyRegressionCriterion,
  type DiscoveryProbes,
  type RegressionScenario,
  type RegressionStatus,
} from './index.js';

/** 确定性时钟：从 1 起逐次 +1。 */
function makeClock(): () => ReturnType<typeof asLogicalTime> {
  let tick = 0;
  return () => {
    tick += 1;
    return asLogicalTime(tick);
  };
}

/** 探针：所有适配器就绪、所有能力实测支持（构造"真正就绪"的正例）。 */
const allReady: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};

const REAL_ROLE_IDS = new Set(['template.document', 'template.spreadsheet', 'template.presentation']);

function statusFor(
  report: ReturnType<typeof runPluginRegression>,
  scenario: RegressionScenario,
): RegressionStatus | undefined {
  return report.results.find((result) => result.scenario === scenario)?.status;
}

describe('PLG-08：七模板 × 三角色 × 五场景 回归覆盖', () => {
  const reports = runCatalogRegression(createPluginRegistry(), allReady, makeClock());

  it('目录中每个插件（十项）都有五场景回归，且结论被观测值支持（独立判据）', () => {
    expect(reports).toHaveLength(PLUGIN_CATALOG.length);
    expect(reports).toHaveLength(10);
    for (const report of reports) {
      expect(report.results).toHaveLength(REGRESSION_SCENARIOS.length);
      for (const scenario of REGRESSION_SCENARIOS) {
        const result = report.results.find((candidate) => candidate.scenario === scenario);
        expect(result).toBeDefined();
        expect((result?.criterion ?? '').length).toBeGreaterThan(10); // 人读判据不是空话
        expect(result?.status).not.toBe('failed');
        // 判据有关键取值，可机械核对
        expect(Object.keys(result?.observed ?? {}).length).toBeGreaterThan(0);
        // **承重**：独立判据只看观测值，核验结论属实（不是"判据文本 === 定义表"那种恒真比对）
        const verdict = verifyRegressionCriterion(result!.scenario, result!.status, result!.observed);
        expect(verdict).toEqual({ ok: true, reason: '' });
      }
    }
  });

  it('三个办公模板（real）的成功 / 更新 / 撤权场景 passed', () => {
    const realReports = reports.filter((report) => report.implementation === 'real');
    expect(realReports.map((report) => report.plugin_id).sort()).toEqual([...REAL_ROLE_IDS].sort());
    for (const report of realReports) {
      expect(report.ready).toBe(true);
      for (const scenario of ['success', 'update', 'permission_revoked'] as const) {
        expect(statusFor(report, scenario)).toBe('passed');
      }
    }
  });

  it('update 判据证据来自**独立再读**（重新签发后比对），不是旧冻结对象自比', () => {
    const document = reports.find((report) => report.plugin_id === 'template.document');
    const update = document?.results.find((result) => result.scenario === 'update');
    expect(update?.status).toBe('passed');
    // 这三项是注册表**当前**现读出来的，任何一项为假都会让本格 failed
    expect(update?.observed.new_instance_blocked).toBe(true);
    expect(update?.observed.rebind_version_matches).toBe(true);
    expect(update?.observed.rebind_capabilities_match).toBe(true);
  });

  it('未接通（stub）模板与全部基础角色**如实** not_ready，不宣称通过', () => {
    const notReady = reports.filter((report) => report.implementation === 'stub');
    expect(notReady).toHaveLength(7); // 四个适配器模板 + 三个基础角色
    for (const report of notReady) {
      expect(report.ready).toBe(false);
      for (const scenario of ['success', 'update', 'permission_revoked'] as const) {
        expect(statusFor(report, scenario)).toBe('not_ready');
      }
      const success = report.results.find((result) => result.scenario === 'success');
      expect(success?.detail).toContain('stub');
    }
  });

  it('failure_unknown 与 restart 对**每个**插件都 passed（注册表层可评估）', () => {
    for (const report of reports) {
      expect(statusFor(report, 'failure_unknown')).toBe('passed');
      expect(statusFor(report, 'restart')).toBe('passed');
    }
  });

  it('回归**有判别力**：success 场景在目录内同时出现 passed 与 not_ready 两种结论', () => {
    const statuses = new Set(reports.map((report) => statusFor(report, 'success')));
    expect(statuses.has('passed')).toBe(true);
    expect(statuses.has('not_ready')).toBe(true);
  });

  it('未就绪原因可指认：stub 的失败与撤权场景给得出"为什么"', () => {
    const meituan = reports.find((report) => report.plugin_id === 'template.meituan');
    const update = meituan?.results.find((result) => result.scenario === 'update');
    expect(update?.status).toBe('not_ready');
    expect((update?.detail ?? '').length).toBeGreaterThan(0);
  });

  it('为不存在的插件跑回归 ⇒ 抛错（不编造回归结论）', () => {
    expect(() => runPluginRegression(createPluginRegistry(), 'template.nope', allReady, makeClock())).toThrow(
      /没有插件/,
    );
  });
});

describe('R232：模板 / 工具 / 文件格式**分开建模**', () => {
  it('文件类型枚举只有 docx / xlsx / pptx，不含美团 / 时钟 / 日历 / 检索', () => {
    expect([...FILE_FORMAT_KINDS].sort()).toEqual(['docx', 'pptx', 'xlsx']);
    for (const forbidden of ['meituan', 'clock', 'calendar', 'research', '美团', '时钟', '日历', '检索']) {
      expect(FILE_FORMAT_KINDS).not.toContain(forbidden);
    }
  });

  it('四个非办公模板的 produces_file_formats 为空（它们是工具，不产出 OOXML）', () => {
    for (const template of BUSINESS_TEMPLATES) {
      if (['template.document', 'template.spreadsheet', 'template.presentation'].includes(template.plugin_id)) {
        continue;
      }
      expect(template.produces_file_formats).toEqual([]);
    }
  });

  it('检索模板"读 PDF"是 consumes_formats（输入），与产出格式语义分开', () => {
    const research = BUSINESS_TEMPLATES.find((template) => template.plugin_id === 'template.research');
    expect(research?.consumes_formats).toContain('pdf');
    expect(research?.produces_file_formats).toEqual([]);
  });
});

describe('I-3：回归判据**独立于产出的矩阵**（不再自证式比对）', () => {
  /**
   * 这组用例证明 `verifyRegressionCriterion` 的输入是"场景 + 结论 + 观测值"，
   * **不含**判据文本、也不查 `REGRESSION_CRITERIA` 表；因此对"观测值不满足其自称判据"
   * 的格子它**必须报错**（原来自证式的 `criterion === 定义表` 比对对这些格恒不报错）。
   */
  it('判据表对每个场景都有非空人读文本（覆盖完整；该文本非承重）', () => {
    expect(Object.keys(REGRESSION_CRITERIA).sort()).toEqual([...REGRESSION_SCENARIOS].sort());
    for (const scenario of REGRESSION_SCENARIOS) {
      expect(REGRESSION_CRITERIA[scenario].length).toBeGreaterThan(10);
    }
  });

  it('正例：观测值真实满足各判据 ⇒ 通过', () => {
    expect(
      verifyRegressionCriterion('success', 'passed', {
        installed: true,
        enabled: true,
        authorized: true,
        dependencies_ready: true,
        actually_supported: true,
        ready: true,
        gate_ok: true,
      }).ok,
    ).toBe(true);
    expect(
      verifyRegressionCriterion('failure_unknown', 'passed', {
        install_ok: false,
        install_reason: 'unknown_plugin',
        discover_is_undefined: true,
      }).ok,
    ).toBe(true);
    expect(
      verifyRegressionCriterion('permission_revoked', 'passed', {
        initial_gate_ok: true,
        revoked_gate_ok: false,
        revoked_reason_has_unauthorized: true,
        restored_gate_ok: true,
      }).ok,
    ).toBe(true);
    expect(
      verifyRegressionCriterion('restart', 'passed', {
        state_preserved_after_restore: true,
        uninstall_not_resurrected: true,
      }).ok,
    ).toBe(true);
    expect(
      verifyRegressionCriterion('update', 'passed', {
        new_instance_blocked: true,
        rebind_version_matches: true,
        rebind_capabilities_match: true,
      }).ok,
    ).toBe(true);
  });

  it('反向对照：标 success/passed 但五态没全真（observed 未成功）⇒ **必须报错**', () => {
    const contradicted = verifyRegressionCriterion('success', 'passed', {
      installed: true,
      enabled: true,
      authorized: true,
      dependencies_ready: true,
      actually_supported: false, // 未接通，却声称成功
      ready: false,
      gate_ok: false,
    });
    expect(contradicted.ok).toBe(false);
    expect(contradicted.reason).toContain('passed');
  });

  it('反向对照：failure_unknown 观测值其实成功了 ⇒ 不得记 passed', () => {
    expect(
      verifyRegressionCriterion('failure_unknown', 'passed', {
        install_ok: true,
        install_reason: 'ok',
        discover_is_undefined: false,
      }).ok,
    ).toBe(false);
  });

  it('反向对照：撤权未即时生效却记 passed ⇒ 报错', () => {
    expect(
      verifyRegressionCriterion('permission_revoked', 'passed', {
        initial_gate_ok: true,
        revoked_gate_ok: true,
        revoked_reason_has_unauthorized: false,
        restored_gate_ok: true,
      }).ok,
    ).toBe(false);
  });

  it('反向对照：卸载被旧快照复活却记 passed ⇒ 报错', () => {
    expect(
      verifyRegressionCriterion('restart', 'passed', {
        state_preserved_after_restore: true,
        uninstall_not_resurrected: false,
      }).ok,
    ).toBe(false);
  });

  it('反向对照：停用/撤权没阻止新实例却记 passed ⇒ 报错', () => {
    expect(
      verifyRegressionCriterion('update', 'passed', {
        new_instance_blocked: false,
        rebind_version_matches: true,
        rebind_capabilities_match: true,
      }).ok,
    ).toBe(false);
  });

  it('反向对照：观测值没展现"无法评估"却记 not_ready ⇒ 报错（failure_unknown 对任何插件均可评估）', () => {
    expect(
      verifyRegressionCriterion('failure_unknown', 'not_ready', {
        install_ok: false,
        install_reason: 'unknown_plugin',
        discover_is_undefined: true,
      }).ok,
    ).toBe(false);
  });
});
