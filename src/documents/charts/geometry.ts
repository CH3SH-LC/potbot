/**
 * 数据 → **图形描述**（WF-092 判据"数据与图形描述一致"）。
 *
 * ## 为什么把"图形"做成一个纯函数
 *
 * 设计点的判据是"**改数据 ⇒ 图形描述跟着变**"。要让这句话可判定，图形就必须是
 * **数据的函数**而不是另一份独立状态：`describeChart(chart)` 只读 `chart`，返回
 * 柱高比例 / 折线顶点 / 扇区角度。于是：
 *
 * - 改一个数据点 ⇒ 重新描述 ⇒ 描述必然不同（同一函数、不同输入）；
 * - `verifyChartGeometry(chart, geometry)` 反过来做同一件事：把一份**声称**的描述
 *   与"从数据重算的描述"逐字段比对，不一致即 `conflict` 式的拒绝——
 *   这正是"图形与数据脱节"（手工改过图形缓存、或缓存过期）能被抓住的地方。
 *
 * ## 数值约定（写死，避免各实现各算一套）
 *
 * - 比例一律 6 位小数四舍五入（`round6`），让浮点结果可复算、可比较；
 * - `axis.max = max(1, 全部数据点的最大值)`——全 0 的图不除以 0；
 * - 折线的 `x_ratio`：`index / (n - 1)`，`n === 1` 时为 0（单点折线退化为一个点）；
 * - 饼图角度：按份额累积，**最后一个扇区的终止角强制为 360**，消除累积误差；
 * - 负值以负比例表示（向下延伸）。本批**不做**双向轴刻度，这条限制如实写在这里。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import type { ChartDefinition } from './types.js';

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export interface ChartAxis {
  readonly min: 0;
  readonly max: number;
}

export interface ColumnBar {
  readonly series_index: number;
  readonly series_name: string;
  readonly value: number;
  /** `value / axis.max`（负值 ⇒ 负比例）。 */
  readonly height_ratio: number;
}

export type ChartGeometry =
  | {
      readonly kind: 'column' | 'bar';
      readonly axis: ChartAxis;
      readonly groups: readonly { readonly category: string; readonly bars: readonly ColumnBar[] }[];
    }
  | {
      readonly kind: 'line';
      readonly axis: ChartAxis;
      readonly series: readonly {
        readonly series_index: number;
        readonly series_name: string;
        readonly points: readonly {
          readonly category: string;
          readonly x_ratio: number;
          readonly y_ratio: number;
          readonly value: number;
        }[];
      }[];
    }
  | {
      readonly kind: 'pie';
      readonly total: number;
      readonly slices: readonly {
        readonly category: string;
        readonly value: number;
        readonly share: number;
        readonly start_angle_deg: number;
        readonly end_angle_deg: number;
      }[];
    };

function allValues(chart: ChartDefinition): readonly number[] {
  return chart.series.flatMap((series) => series.points.map((point) => point.value));
}

/** 轴上限：全 0 / 全负时取 1，避免除零，同时让"全 0 是平的"这一事实体现在比例里。 */
function axisOf(chart: ChartDefinition): ChartAxis {
  const values = allValues(chart);
  const max = values.length === 0 ? 0 : Math.max(...values);
  return { min: 0, max: max > 0 ? max : 1 };
}

/** 从数据算出图形描述（**纯函数**：同数据 ⇒ 同描述）。 */
export function describeChart(chart: ChartDefinition): ChartGeometry {
  switch (chart.chart_type) {
    case 'column':
    case 'bar': {
      const axis = axisOf(chart);
      const groups = chart.categories.map((category, pointIndex) => ({
        category,
        bars: chart.series.map((series, seriesIndex) => {
          const value = series.points[pointIndex]?.value ?? 0;
          return {
            series_index: seriesIndex,
            series_name: series.name,
            value,
            height_ratio: round6(value / axis.max),
          };
        }),
      }));
      return { kind: chart.chart_type, axis, groups };
    }

    case 'line': {
      const axis = axisOf(chart);
      const denominator = chart.categories.length > 1 ? chart.categories.length - 1 : 1;
      const series = chart.series.map((item, seriesIndex) => ({
        series_index: seriesIndex,
        series_name: item.name,
        points: item.points.map((point, pointIndex) => ({
          category: point.category,
          x_ratio: round6(pointIndex / denominator),
          y_ratio: round6(point.value / axis.max),
          value: point.value,
        })),
      }));
      return { kind: 'line', axis, series };
    }

    case 'pie': {
      const points = chart.series[0]?.points ?? [];
      const total = points.reduce((sum, point) => sum + point.value, 0);
      const slices: {
        category: string;
        value: number;
        share: number;
        start_angle_deg: number;
        end_angle_deg: number;
      }[] = [];
      let cursor = 0;
      for (const [index, point] of points.entries()) {
        const share = total === 0 ? 0 : point.value / total;
        const start = cursor;
        const isLast = index === points.length - 1;
        cursor = isLast ? 360 : round6(cursor + share * 360);
        slices.push({
          category: point.category,
          value: point.value,
          share: round6(share),
          start_angle_deg: round6(start),
          end_angle_deg: cursor,
        });
      }
      return { kind: 'pie', total: round6(total), slices };
    }
  }
}

/**
 * 核对一份**声称的**图形描述与数据是否一致。
 *
 * 不一致时 `precondition` 失败——图形与数据脱节属于"前置条件被破坏"，
 * 而不是"这次操作本身非法"。
 */
export function verifyChartGeometry(chart: ChartDefinition, geometry: ChartGeometry): Result<ChartGeometry> {
  const actual = describeChart(chart);
  const claimed = JSON.stringify(geometry);
  const expected = JSON.stringify(actual);
  if (claimed !== expected) {
    return fail(
      'precondition',
      `图形描述与图表数据不一致（图表 "${chart.title}"）：图形描述必须由数据算出，不得独立修改。`,
      {
        extra: {
          chartId: chart.chart_id,
          claimedKind: geometry.kind,
          expectedKind: actual.kind,
        },
      },
    );
  }
  return succeed(actual);
}

/** 图形描述的一行摘要（回执/日志用）。 */
export function describeChartGeometry(geometry: ChartGeometry): string {
  switch (geometry.kind) {
    case 'column':
    case 'bar':
      return `${geometry.kind}：${String(geometry.groups.length)} 个类别，轴上限 ${String(geometry.axis.max)}`;
    case 'line':
      return `line：${String(geometry.series.length)} 条折线，每条 ${String(geometry.series[0]?.points.length ?? 0)} 点`;
    case 'pie':
      return `pie：${String(geometry.slices.length)} 个扇区，总量 ${String(geometry.total)}，角度合计 ${String(
        round6(geometry.slices.reduce((sum, slice) => sum + (slice.end_angle_deg - slice.start_angle_deg), 0)),
      )}`;
  }
}
