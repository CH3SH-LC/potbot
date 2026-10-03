/**
 * **回归矩阵**：把"每个模板的成功 / 更新 / 失败或未知 / 权限撤销 / 重启"排成一张
 * **可扩展、可核对形状**的表（design-06 P6 / PLG-08；合同 R228 / R230 / R231 / R233 / R240）。
 *
 * ## 与 `regression.ts` 的分工
 *
 * `regression.ts` 给出**单插件**与**内置目录**的回归执行（`runPluginRegression` /
 * `runCatalogRegression`）。本文件在其上加**矩阵视角**，补上 PLG-08 里"**受控模板目录可扩展**"
 * 这半句：
 *
 * - 矩阵的行 = 一份**调用方给定的受控目录**（默认仍是内置目录），不是写死的七个模板；
 * - 矩阵的列 = 五个场景（`success` / `update` / `failure_unknown` / `permission_revoked` /
 *   `restart`），每格带**回归判据**与**观测值**，可机械核对；
 * - `extendControlledCatalog()` 是"可扩展"的唯一入口：**受控**扩展（追加受控清单），
 *   但**拒绝**任何会造成重复行的追加（同一插件两行 ⇒ 矩阵产生歧义 ⇒ 结构化抛错）。
 *
 * **开放交易市场不作为本轮前置**：矩阵只需要一份受控目录；没有任何"必须联网拉取市场清单"
 * 的路径——本层零 IO。
 *
 * ## 判据**不抄自己**（FA-VERIFY-WAVE I-3）
 *
 * 每格 `criterion` 是**人读文本**，从 `REGRESSION_CRITERIA` 抄来；若拿它去和同一张表比对，
 * 对自产矩阵**恒真**、毫无判别力。故 `assertMatrixShape` 的承重判据改为
 * `verifyRegressionCriterion(scenario, status, observed)` —— 输入**只有观测值**，检查的是
 * "这一格的观测值是否**真的**满足它自称的结论"，与判据文本、定义表相互独立。详见 `regression.ts` 文件头。
 *
 * ## 诚实口径（连着 `regression.ts` 一起读）
 *
 * 本层**不运行真实执行器**：`stub` 插件的 `success` / `update` / `permission_revoked`
 * 照旧如实记为 `not_ready`，**不**宣称通过；矩阵只是把这些结论排成表，不改变结论本身。
 *
 * 纯函数 + 注入探针与时钟：零 IO、不含墙钟与随机数。
 */

import { ValidationError } from '../protocol/index.js';
import { PLUGIN_CATALOG } from './catalog.js';
import type { PluginId, PluginManifest } from './manifest.js';
import {
  REGRESSION_CRITERIA,
  REGRESSION_SCENARIOS,
  runPluginRegression,
  verifyRegressionCriterion,
  type PluginRegressionReport,
  type RegressionClock,
  type RegressionObservation,
  type RegressionScenario,
  type RegressionStatus,
} from './regression.js';
import { createPluginRegistry, type DiscoveryProbes } from './registry.js';

// ---------------------------------------------------------------------------
// 矩阵形状
// ---------------------------------------------------------------------------

/** 矩阵的一格（= 一个插件 × 一个场景）。 */
export interface MatrixCell {
  readonly plugin_id: PluginId;
  readonly scenario: RegressionScenario;
  readonly status: RegressionStatus;
  /**
   * 本场景**人读**的判据文本（`REGRESSION_CRITERIA` 的副本，恒等于 `REGRESSION_CRITERIA[scenario]`）。
   * **它不是判据本身**：承重的机械判据是 `verifyRegressionCriterion(scenario, status, observed)`
   * —— 只看 `observed` 观测值，与这段文本无关（详见 `regression.ts` 文件头 I-3 说明）。
   */
  readonly criterion: string;
  readonly detail: string;
  readonly observed: RegressionObservation;
}

/** 矩阵的一行（= 一个插件的完整回归报告）。 */
export interface RegressionMatrixRow {
  readonly plugin_id: PluginId;
  readonly kind: 'business_template' | 'base_role';
  readonly implementation: 'real' | 'stub';
  readonly ready: boolean;
  readonly cells: readonly MatrixCell[];
}

/** 回归矩阵：列固定为五场景，行由受控目录决定。 */
export interface RegressionMatrix {
  /** 列头（封闭枚举，顺序即展示顺序）。 */
  readonly scenarios: readonly RegressionScenario[];
  readonly rows: readonly RegressionMatrixRow[];
}

export interface RegressionMatrixOptions {
  /** 受控模板目录（默认内置目录）。**先经 `assertCatalogUnique` 去重**才允许建矩阵。 */
  readonly catalog?: readonly PluginManifest[];
  readonly probes: DiscoveryProbes;
  readonly clock: RegressionClock;
}

// ---------------------------------------------------------------------------
// 受控目录扩展
// ---------------------------------------------------------------------------

/**
 * 断言一份受控目录里每个 `plugin_id` 只出现一次。
 * 同一插件出现两行，矩阵就无法回答"这一格是谁的结论"——因此**结构化抛错**，不静默取一。
 */
export function assertCatalogUnique(catalog: readonly PluginManifest[]): void {
  const seen = new Set<string>();
  for (const manifest of catalog) {
    if (seen.has(manifest.plugin_id)) {
      throw new ValidationError(
        `受控目录里插件 ${manifest.plugin_id} 出现了两次：回归矩阵会因此产生歧义（同一格两份结论）`,
      );
    }
    seen.add(manifest.plugin_id);
  }
}

/**
 * **受控扩展**：在基础目录上追加受控清单，返回冻结后的新目录。
 *
 * 只接受**追加**（不改已有行），且**拒绝重复 id**——这正是"可扩展"与"不产生歧义"之间的
 * 边界。追加空数组是合法的（恒等扩展）。
 *
 * @throws {ValidationError} 基础目录自身有重复，或追加项与基础/彼此 id 冲突。
 */
export function extendControlledCatalog(
  base: readonly PluginManifest[],
  additions: readonly PluginManifest[],
): readonly PluginManifest[] {
  assertCatalogUnique(base);
  const seen = new Set(base.map((manifest) => manifest.plugin_id));
  const result: PluginManifest[] = [...base];
  for (const addition of additions) {
    if (seen.has(addition.plugin_id)) {
      throw new ValidationError(
        `受控目录扩展拒绝重复 id ${addition.plugin_id}：扩展只允许**追加**受控清单，` +
          '不允许与既有行重名（矩阵同一插件只能有一行）',
      );
    }
    seen.add(addition.plugin_id);
    result.push(addition);
  }
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// 建矩阵
// ---------------------------------------------------------------------------

/**
 * 用一份受控目录跑出回归矩阵。
 *
 * 行序 = 目录顺序；列序 = `REGRESSION_SCENARIOS`。每格都带判据与观测值，
 * 因此"说不通过"时**说得清凭什么**。
 *
 * @throws {ValidationError} 目录有重复 id，或目录里某个插件跑不出回归（如不在注册表内）。
 */
export function buildRegressionMatrix(options: RegressionMatrixOptions): RegressionMatrix {
  const catalog = options.catalog ?? PLUGIN_CATALOG;
  assertCatalogUnique(catalog);
  const registry = createPluginRegistry({ manifests: catalog });
  const rows = catalog.map((manifest) => {
    const report = runPluginRegression(registry, manifest.plugin_id, options.probes, options.clock);
    return rowOf(report);
  });
  return Object.freeze({ scenarios: Object.freeze([...REGRESSION_SCENARIOS]), rows: Object.freeze(rows) });
}

function rowOf(report: PluginRegressionReport): RegressionMatrixRow {
  const cells = report.results.map((result) =>
    Object.freeze({
      plugin_id: result.plugin_id,
      scenario: result.scenario,
      status: result.status,
      criterion: result.criterion,
      detail: result.detail,
      observed: result.observed,
    }),
  );
  return Object.freeze({
    plugin_id: report.plugin_id,
    kind: report.kind,
    implementation: report.implementation,
    ready: report.ready,
    cells: Object.freeze(cells),
  });
}

// ---------------------------------------------------------------------------
// 形状核对（矩阵自身的完整性）
// ---------------------------------------------------------------------------

/**
 * 断言矩阵**形状完整 + 结论属实**：
 *
 * 1. 每行**恰好**五格、每场景**恰好一次**（缺列 / 重列 ⇒ 结构化抛错，不能让缺列的矩阵冒充全量回归）；
 * 2. 每格 `criterion` 文本未被人手改漂移 —— **此条对自产矩阵恒真、只防手改，属次要**；
 * 3. **承重判据**：`verifyRegressionCriterion(scenario, status, observed)` —— **只拿该格的观测值**去核验
 *    结论是否属实，与 `criterion` 文本和 `REGRESSION_CRITERIA` 表都无关。这正是消除 I-3 "自证式断言"
 *    的落点：把一格标成 `success` 但观测值没成功、或把未就绪的观测记成 `passed`，会在这里被拒。
 *
 * 返回格数（= 行数 × 场景数），便于调用方核对。
 *
 * @throws {ValidationError} 任意一行缺场景 / 重复场景 / 判据文本漂移 / **结论与观测值不符**。
 */
export function assertMatrixShape(matrix: RegressionMatrix): number {
  let cells = 0;
  for (const row of matrix.rows) {
    const seen = new Set<RegressionScenario>();
    for (const cell of row.cells) {
      if (seen.has(cell.scenario)) {
        throw new ValidationError(`回归矩阵里插件 ${row.plugin_id} 的场景 ${cell.scenario} 出现了两次`);
      }
      seen.add(cell.scenario);
      // (2) 人读判据文本不得被手改漂移（次要：对自产矩阵恒真，仅防手改）。
      if (cell.criterion !== REGRESSION_CRITERIA[cell.scenario]) {
        throw new ValidationError(
          `回归矩阵里插件 ${row.plugin_id} 的场景 ${cell.scenario} 判据与标准判据不一致（被判据漂移）`,
        );
      }
      // (3) 承重：独立于判据文本，只依据观测值核验结论属实。
      const verdict = verifyRegressionCriterion(cell.scenario, cell.status, cell.observed);
      if (!verdict.ok) {
        throw new ValidationError(
          `回归矩阵里插件 ${row.plugin_id} 的场景 ${cell.scenario} 结论 ${cell.status} 与其观测值不符：` +
            `${verdict.reason}`,
        );
      }
      cells += 1;
    }
    for (const scenario of REGRESSION_SCENARIOS) {
      if (!seen.has(scenario)) {
        throw new ValidationError(`回归矩阵里插件 ${row.plugin_id} 缺少场景 ${scenario}：缺列的矩阵不得冒充全量回归`);
      }
    }
  }
  return cells;
}

/** 矩阵概览计数（供回归看板 / 测试核对）。 */
export interface MatrixSummary {
  readonly row_count: number;
  readonly scenario_count: number;
  readonly cell_count: number;
  /** 每场景的结论计数（`passed` / `failed` / `not_ready`）。 */
  readonly status_counts: Readonly<Record<RegressionScenario, Readonly<Record<RegressionStatus, number>>>>;
}

/** 汇总矩阵（先 `assertMatrixShape` 保证形状完整，再计数）。 */
export function summarizeMatrix(matrix: RegressionMatrix): MatrixSummary {
  const cellCount = assertMatrixShape(matrix);
  const counts = {} as Record<RegressionScenario, Record<RegressionStatus, number>>;
  for (const scenario of REGRESSION_SCENARIOS) {
    counts[scenario] = { passed: 0, failed: 0, not_ready: 0 };
  }
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      counts[cell.scenario][cell.status] += 1;
    }
  }
  const frozen = {} as Record<RegressionScenario, Readonly<Record<RegressionStatus, number>>>;
  for (const scenario of REGRESSION_SCENARIOS) {
    frozen[scenario] = Object.freeze({ ...counts[scenario] });
  }
  return Object.freeze({
    row_count: matrix.rows.length,
    scenario_count: matrix.scenarios.length,
    cell_count: cellCount,
    status_counts: Object.freeze(frozen),
  });
}
