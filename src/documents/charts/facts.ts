/**
 * 图表数据 ← 事实快照（WF-092；沿用 design-02 P3 的**单一来源**纪律，R48.3/R148）。
 *
 * ## 为什么图表必须从事实快照取数，而不是"接收一列数字"
 *
 * 一个"接收一列数字"的图表 API 会立刻造出第二个数据源：同一次任务里，
 * 正文里的"8 人"来自事实、图表里的柱子来自调用方现算的 8——两者将来一旦不一致，
 * 没有任何机制能发现。所以本文件的入口**只有事实键**（`fact_keys`），
 * 数值与 `fact_ref` 都从快照里取；"没有事实"不是 0，而是 `missing_fact` 式的拒绝
 * （值层已在 `src/facts/snapshot.ts` 把它挡在可用表之外，本层只负责**如实上报**）。
 *
 * ## 单位一致性
 *
 * 同一张图里混装"元"和"人"是图形语言上的错误（同一根轴无法解释两种量纲）。
 * 本层因此要求**一张图里的全部数值事实单位一致**（数值单位 + 币种），否则拒绝。
 */

import type { FactSnapshot, UnusableFactEntry } from '../../facts/index.js';
import type { KnownFactSnapshotEntry } from '../../artifacts/ports.js';
import { fail, succeed, type Result } from '../selection/types.js';
import { assertChartTraceable, buildChart } from './build.js';
import type { ChartDefinition, ChartPoint, ChartSeries, ChartStyle, ChartType } from './types.js';

/** 一条系列的**声明**：名称 + 每个类别对应的**事实键**（不是数值）。 */
export interface ChartFactSeriesInput {
  readonly name: string;
  readonly fact_keys: readonly string[];
}

export interface BindChartFromFactsInput {
  readonly chart_id: string;
  readonly chart_type: ChartType;
  readonly title: string;
  readonly categories: readonly string[];
  readonly series: readonly ChartFactSeriesInput[];
  readonly snapshot: FactSnapshot;
  readonly style?: Partial<ChartStyle>;
}

function findUnusable(snapshot: FactSnapshot, factKey: string): UnusableFactEntry | null {
  return snapshot.unusable.find((entry) => entry.fact_key === factKey) ?? null;
}

/** 快照里某键的**可用**条目；不可用（缺失/未知/不适用）返回 `null`。 */
export function usableFactEntry(snapshot: FactSnapshot, factKey: string): KnownFactSnapshotEntry | null {
  return snapshot.usable.find((entry) => entry.fact_key === factKey) ?? null;
}

/**
 * 从事实快照装配图表。
 *
 * 逐键取数；缺失/未知/不适用 → `not_found`（**带上原因，不当作 0**）；
 * 非数值事实 → `unsupported`；单位不一致 → `precondition`。
 */
export function bindChartFromFacts(input: BindChartFromFactsInput): Result<ChartDefinition> {
  const units = new Set<string>();
  const series: ChartSeries[] = [];

  for (const seriesInput of input.series) {
    const points: ChartPoint[] = [];
    for (const [pointIndex, factKey] of seriesInput.fact_keys.entries()) {
      const entry = usableFactEntry(input.snapshot, factKey);
      if (entry === null) {
        const unusable = findUnusable(input.snapshot, factKey);
        return fail(
          'not_found',
          `图表系列 "${seriesInput.name}" 的第 ${String(pointIndex + 1)} 个数据点找不到可用事实 "${factKey}"：` +
            `${unusable?.kind ?? 'missing'}${unusable === null ? '' : `（${unusable.reason}）`}。` +
            '缺失不得当零，也不得改用无来源字面量。',
          {
            expression: factKey,
            extra: {
              seriesIndex: series.length,
              pointIndex,
              factKey,
              unusableKind: unusable?.kind ?? 'missing',
              reason: unusable?.reason ?? '快照里没有这个键',
            },
          },
        );
      }

      if (entry.value.type !== 'number') {
        return fail(
          'unsupported',
          `事实 "${factKey}" 是 ${entry.value.type} 类型，图表数值轴只接受数值事实。`,
          { expression: factKey, extra: { factKey, valueType: entry.value.type } },
        );
      }

      const unitKey = `${entry.value.unit}|${entry.value.currency ?? ''}`;
      units.add(unitKey);

      const category = input.categories[pointIndex];
      if (category === undefined) {
        return fail(
          'precondition',
          `系列 "${seriesInput.name}" 声明了 ${String(seriesInput.fact_keys.length)} 个事实键，` +
            `类别轴只有 ${String(input.categories.length)} 个类别（必须一一对应）。`,
          { extra: { seriesIndex: series.length, factKeys: seriesInput.fact_keys.length, categories: input.categories.length } },
        );
      }

      points.push({
        category,
        value: entry.value.amount,
        fact_ref: entry.fact_ref,
        fact_key: factKey,
      });
    }
    series.push({ name: seriesInput.name, points });
  }

  if (units.size > 1) {
    return fail(
      'precondition',
      `同一张图里出现了 ${String(units.size)} 种不同的数值单位/币种（${[...units].join('、')}）；` +
        '同一坐标轴无法解释不同量纲，拒绝装配。',
      { extra: { units: [...units].join('、') } },
    );
  }

  const built = buildChart({
    chart_id: input.chart_id,
    chart_type: input.chart_type,
    title: input.title,
    categories: input.categories,
    series,
    source: 'user_request',
    // 记录快照的事实版本："数值与事实版本一致"要能回答"这图是哪一版的数"。
    fact_version: { task_id: input.snapshot.task_id, task_revision: input.snapshot.task_revision },
    ...(input.style === undefined ? {} : { style: input.style }),
  });
  if (!built.ok) return built;

  // 从快照装配出来的图表**必然**可追溯；这里再跑一遍闸门，让它同时成为回归护栏。
  return assertChartTraceable(built.value);
}
