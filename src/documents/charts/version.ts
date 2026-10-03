/**
 * 图表与**事实版本**的一致性核对（WF-092 判据尾句："图形、数值与事实版本一致，非截图"）。
 *
 * ## 判据拆成三件，本文件把它们收束到一个可断言的报告里
 *
 * | 判据 | 本文件的落点 |
 * |---|---|
 * | **事实版本一致** | `assertChartFactVersion`：图的 `fact_version` 必须等于快照的 `(task_id, task_revision)` |
 * | **数值与事实一致** | `verifyChartNumbersAgainstSnapshot`：逐点核对 `fact_ref` 与 `amount` |
 * | **图形与数值一致** | 报告里的 `geometry_signature`（`describeChart` 的确定性签名） |
 *
 * `verifyChartFactAgreement` 是单一入口，产出一份 `ChartFactAgreementReport`——它同时钉住
 * 事实版本、每个数据点的来源与数值、图形描述签名、嵌入数据表签名。四者若要同时成立，
 * 就只能来自**同一份图表数据**；任何一个被人为改过，报告里的对应字段立即对不上。
 *
 * ## 为什么"补一条 fact_ref 就完事"不够
 *
 * `assertChartTraceable`（`build.ts`）只要求每个点**带** `fact_ref`/`fact_key`，**不比对数值**：
 * 一次 `{...point, value: 999}` 抄改能带着原 `fact_ref` 蒙混过关。本文件把数值**逐点回算**
 * 到快照条目，正是堵住这个口子——数值与它声称的来源必须是同一条事实的 amount。
 *
 * 纯函数、零 IO。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import type { FactSnapshot } from '../../facts/index.js';
import { chartDataTableSignature, chartEmbeddedTable } from './datatable.js';
import { describeChart, type ChartGeometry } from './geometry.js';
import type { ChartDefinition, ChartFactVersion } from './types.js';

/** 读取图表记录的事实版本；未绑定（字面量/导入图）返回 `null`。 */
export function chartFactVersionOf(chart: ChartDefinition): ChartFactVersion | null {
  return chart.fact_version ?? null;
}

/**
 * 要求图表记录的事实版本等于 `expected`。
 *
 * - 图未绑定版本（`null`/`undefined`）⇒ `precondition`：无从核对，**不得**默认通过；
 * - 版本不一致 ⇒ `stale_revision`：任务版本变了，这张图的数字整体过期（R114/R143 取向）。
 */
export function assertChartFactVersion(chart: ChartDefinition, expected: ChartFactVersion): Result<ChartFactVersion> {
  const recorded = chartFactVersionOf(chart);
  if (recorded === null) {
    return fail(
      'precondition',
      `图表 "${chart.title}" 未绑定事实版本：无法声称'数值与事实版本一致'。` +
        '请用 bindChartFromFacts 从事实快照装配，而不是给字面量图补一个版本号。',
      { extra: { chartId: chart.chart_id } },
    );
  }
  if (recorded.task_id !== expected.task_id || recorded.task_revision !== expected.task_revision) {
    return fail(
      'stale_revision',
      `图表 "${chart.title}" 绑定的事实版本已过期：图为 ` +
        `${recorded.task_id}@r${String(recorded.task_revision)}，当前为 ` +
        `${expected.task_id}@r${String(expected.task_revision)}。旧版本的数值不得冒充当前版本。`,
      {
        currentRevision: expected.task_revision,
        requestedRevision: recorded.task_revision,
        extra: {
          chartId: chart.chart_id,
          chartTaskId: recorded.task_id,
          snapshotTaskId: expected.task_id,
        },
      },
    );
  }
  return succeed(recorded);
}

/** 单个数据点与事实的对照结果。 */
export interface ChartPointAgreement {
  readonly series_index: number;
  readonly series_name: string;
  readonly point_index: number;
  readonly category: string;
  readonly fact_ref: string;
  readonly fact_key: string;
  readonly value: number;
  readonly unit: string;
  readonly currency: string | null;
}

/**
 * 逐点核对图表数值与其事实来源（快照的可用表）。
 *
 * 拒绝清单：
 * - 点没有 `fact_ref`/`fact_key` ⇒ `precondition`（无来源的点无法核对，不得跳过）；
 * - 快照里找不到该键 ⇒ `not_found`（缺失不得当零）；
 * - 该条事实非数值 ⇒ `unsupported`；
 * - `fact_ref` 与快照条目不匹配 ⇒ `precondition`（引用的不是这条事实）；
 * - `amount` 与图表数值不等 ⇒ `precondition`（**数值被抄改**，判据核心）。
 */
export function verifyChartNumbersAgainstSnapshot(
  chart: ChartDefinition,
  snapshot: FactSnapshot,
): Result<readonly ChartPointAgreement[]> {
  const agreements: ChartPointAgreement[] = [];
  for (const [seriesIndex, series] of chart.series.entries()) {
    for (const [pointIndex, point] of series.points.entries()) {
      if (point.fact_ref === null || point.fact_key === null) {
        return fail(
          'precondition',
          `图表 "${chart.title}" 系列 "${series.name}" 第 ${String(pointIndex + 1)} 个数据点（${point.category}）` +
            '没有事实来源：无来源的点无法与事实版本核对，不得跳过。',
          { extra: { seriesIndex, pointIndex, category: point.category } },
        );
      }
      const entry = snapshot.usable.find((candidate) => candidate.fact_key === point.fact_key) ?? null;
      if (entry === null) {
        return fail(
          'not_found',
          `图表里引用的键 "${point.fact_key}" 在快照（${snapshot.task_id}@r${String(snapshot.task_revision)}）里` +
            '没有可用事实：可能是版本不符或事实缺失，缺失不得当零。',
          {
            expression: point.fact_key,
            extra: { seriesIndex, pointIndex, factKey: point.fact_key },
          },
        );
      }
      if (entry.value.type !== 'number') {
        return fail(
          'unsupported',
          `图表引用的键 "${point.fact_key}" 是 ${entry.value.type} 类型，数值轴只接受数值事实。`,
          { expression: point.fact_key, extra: { factKey: point.fact_key, valueType: entry.value.type } },
        );
      }
      if (entry.fact_ref !== point.fact_ref) {
        return fail(
          'precondition',
          `图表数据点（${point.category}）引用的 fact_ref "${point.fact_ref}" 与快照里键 "${point.fact_key}" 的` +
            `条目 "${entry.fact_ref}" 不一致：引用的不是这条事实。`,
          {
            extra: {
              seriesIndex,
              pointIndex,
              factKey: point.fact_key,
              pointFactRef: point.fact_ref,
              snapshotFactRef: entry.fact_ref,
            },
          },
        );
      }
      if (entry.value.amount !== point.value) {
        return fail(
          'precondition',
          `图表数据点（${point.category}）数值为 ${String(point.value)}，而事实 "${point.fact_key}" 的 amount 为 ` +
            `${String(entry.value.amount)}：数值与它声称的来源不是同一条事实。`,
          {
            extra: {
              seriesIndex,
              pointIndex,
              factKey: point.fact_key,
              pointValue: point.value,
              factAmount: entry.value.amount,
            },
          },
        );
      }
      agreements.push({
        series_index: seriesIndex,
        series_name: series.name,
        point_index: pointIndex,
        category: point.category,
        fact_ref: point.fact_ref,
        fact_key: point.fact_key,
        value: point.value,
        unit: entry.value.unit,
        currency: entry.value.currency,
      });
    }
  }
  return succeed(agreements);
}

/** 图形描述的确定性签名（`describeChart` 产物的 JSON）。同图必同串，可用于"图形确实源自这组数"的断言。 */
export function chartGeometrySignature(geometry: ChartGeometry): string {
  return JSON.stringify(geometry);
}

/** "图形 / 数值 / 事实版本"三者一致的完整报告。 */
export interface ChartFactAgreementReport {
  readonly chart_id: string;
  readonly fact_version: ChartFactVersion;
  readonly geometry_kind: ChartGeometry['kind'];
  readonly geometry_signature: string;
  readonly table_signature: string;
  readonly points: readonly ChartPointAgreement[];
}

/**
 * 单一入口：核对"图形、数值与事实版本一致"。
 *
 * 任一项不满足即返回对应失败，**不产出半份报告**。全部通过时给出报告，
 * 其中 `geometry_signature` 与 `table_signature` 覆盖图形与嵌入数据表两处载体。
 */
export function verifyChartFactAgreement(
  chart: ChartDefinition,
  snapshot: FactSnapshot,
): Result<ChartFactAgreementReport> {
  const version = assertChartFactVersion(chart, {
    task_id: snapshot.task_id,
    task_revision: snapshot.task_revision,
  });
  if (!version.ok) return version;

  const points = verifyChartNumbersAgainstSnapshot(chart, snapshot);
  if (!points.ok) return points;

  const table = chartEmbeddedTable(chart);
  if (!table.ok) return table;

  const geometry = describeChart(chart);
  return succeed({
    chart_id: chart.chart_id,
    fact_version: version.value,
    geometry_kind: geometry.kind,
    geometry_signature: chartGeometrySignature(geometry),
    table_signature: chartDataTableSignature(table.value),
    points: points.value,
  });
}
