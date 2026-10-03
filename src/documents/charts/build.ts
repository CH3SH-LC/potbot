/**
 * 图表构造与校验（WF-092）。
 *
 * 校验的核心是"**图形描述的唯一定义域**"：类别轴与每个系列的取值必须一一对应。
 * 若允许"某条系列少一个点"，那么"第 2 根柱子代表哪一类"就没有唯一答案，
 * `geometry.ts` 的图形描述也就失去意义（更别说导出时 Word 会自己补零）。
 *
 * 与公式包同纪律：构造期就把退化形态挡掉，不留给导出器。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import type { SourceKind } from '../model/types.js';
import {
  CHART_TYPES,
  LEGEND_POSITIONS,
  type ChartDefinition,
  type ChartFactVersion,
  type ChartPoint,
  type ChartPointProvenance,
  type ChartSeries,
  type ChartStyle,
  type ChartType,
} from './types.js';

/** 默认样式：**不臆造品牌色**，用一组中性灰阶；字体大小如实给常用值。 */
export function defaultChartStyle(): ChartStyle {
  return {
    legend: 'right',
    palette: ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'],
    data_labels: false,
    gridlines: true,
    title_font_size_pt: 14,
    axis_font_size_pt: 10,
  };
}

/** 无来源的字面量数据点（**不可通过可追溯性检查**，仅用于表示既有/外部图表）。 */
export function literalPoint(category: string, value: number): ChartPoint {
  return { category, value, fact_ref: null, fact_key: null };
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

/** 校验并合并样式补丁。 */
export function mergeChartStyle(base: ChartStyle, patch: Partial<ChartStyle>): Result<ChartStyle> {
  const merged: ChartStyle = { ...base, ...patch };

  if (!LEGEND_POSITIONS.includes(merged.legend)) {
    return fail('invalid_query', `未知的图例位置：${String(merged.legend)}`, { extra: { legend: String(merged.legend) } });
  }
  if (!Array.isArray(merged.palette) || merged.palette.length === 0) {
    return fail('invalid_query', '调色板至少要有一个颜色。', { extra: { palette: merged.palette.length } });
  }
  for (const [index, hex] of merged.palette.entries()) {
    if (typeof hex !== 'string' || !HEX6.test(hex)) {
      return fail('invalid_query', `调色板第 ${String(index)} 个颜色必须是 6 位十六进制（不带 #），收到 ${String(hex)}`, {
        extra: { index, hex: String(hex) },
      });
    }
  }
  for (const [slot, size] of [
    ['标题', merged.title_font_size_pt],
    ['坐标轴', merged.axis_font_size_pt],
  ] as const) {
    if (!Number.isFinite(size) || size <= 0) {
      return fail('invalid_query', `${slot}字号必须是正数（pt），收到 ${String(size)}`, { extra: { slot, size } });
    }
  }
  if (typeof merged.data_labels !== 'boolean' || typeof merged.gridlines !== 'boolean') {
    return fail('invalid_query', 'data_labels / gridlines 必须是布尔值。');
  }
  return succeed(merged);
}

export interface BuildChartInput {
  readonly chart_id: string;
  readonly chart_type: ChartType;
  readonly title: string;
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly style?: Partial<ChartStyle>;
  readonly source: SourceKind;
  /**
   * 绑定的**事实版本**（可选）。从事实快照装配（`bindChartFromFacts`）时传入。
   * 省略时**不写该字段**——字面量/导入图不得冒充某个版本。
   */
  readonly fact_version?: ChartFactVersion | null;
}

/** 构造并校验一张图表。任一项不合法即 `Failure`，**不产出半成品**。 */
export function buildChart(input: BuildChartInput): Result<ChartDefinition> {
  if (typeof input.chart_id !== 'string' || input.chart_id.length === 0) {
    return fail('invalid_query', 'chart_id 必须是非空字符串。', { extra: { chartId: String(input.chart_id) } });
  }
  if (!CHART_TYPES.includes(input.chart_type)) {
    return fail('invalid_query', `未知的图表类型：${String(input.chart_type)}`, {
      extra: { chartType: String(input.chart_type) },
    });
  }
  if (typeof input.title !== 'string' || input.title.length === 0) {
    return fail('invalid_query', '图表标题必须是非空字符串（空标题会让图表无法被指认）。');
  }
  if (!Array.isArray(input.categories) || input.categories.length === 0) {
    return fail('invalid_query', '类别轴至少要有一个类别。', {
      extra: { categories: Array.isArray(input.categories) ? input.categories.length : -1 },
    });
  }
  const seen = new Set<string>();
  for (const [index, category] of input.categories.entries()) {
    if (typeof category !== 'string' || category.length === 0) {
      return fail('invalid_query', `第 ${String(index)} 个类别必须是非空字符串。`);
    }
    if (seen.has(category)) {
      return fail('invalid_query', `类别 "${category}" 重复出现：类别轴必须唯一，否则"第几个数据点属于哪一类"无唯一答案。`, {
        extra: { category, index },
      });
    }
    seen.add(category);
  }
  if (!Array.isArray(input.series) || input.series.length === 0) {
    return fail('invalid_query', '图表至少要有一条数据系列。', {
      extra: { series: Array.isArray(input.series) ? input.series.length : -1 },
    });
  }

  for (const [seriesIndex, series] of input.series.entries()) {
    if (typeof series.name !== 'string' || series.name.length === 0) {
      return fail('invalid_query', `第 ${String(seriesIndex)} 条系列的名称必须是非空字符串。`);
    }
    if (!Array.isArray(series.points) || series.points.length !== input.categories.length) {
      return fail(
        'precondition',
        `系列 "${series.name}" 有 ${String(series.points?.length ?? -1)} 个数据点，与类别轴长度 ${String(input.categories.length)} 不一致（一一对应是图形描述的唯一定义域）。`,
        { extra: { seriesIndex, points: series.points?.length ?? -1, categories: input.categories.length } },
      );
    }
    for (const [pointIndex, point] of series.points.entries()) {
      const expected = input.categories[pointIndex]!;
      if (point.category !== expected) {
        return fail(
          'precondition',
          `系列 "${series.name}" 第 ${String(pointIndex)} 个数据点的类别是 "${point.category}"，类别轴对应位置是 "${expected}"（顺序必须一致）。`,
          { extra: { seriesIndex, pointIndex, expected, actual: point.category } },
        );
      }
      if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
        return fail('invalid_query', `数据点 ${point.category} 的数值必须是有限数，收到 ${String(point.value)}`, {
          extra: { seriesIndex, pointIndex, category: point.category },
        });
      }
    }
  }

  if (input.chart_type === 'pie') {
    if (input.series.length !== 1) {
      return fail('unsupported', '饼图只支持单条系列（多系列饼图没有公认的图形语义）。', {
        extra: { series: input.series.length },
      });
    }
    const points = input.series[0]!.points;
    for (const point of points) {
      if (point.value < 0) {
        return fail('unsupported', `饼图不接受负值（${point.category} = ${String(point.value)}）：扇区角度无法表达负数。`, {
          extra: { category: point.category, value: point.value },
        });
      }
    }
    let total = 0;
    for (const point of points) total += point.value;
    if (total <= 0) {
      return fail('unsupported', '饼图所有数据点的和为 0，无法切分扇区。', { extra: { total } });
    }
  }

  const style = mergeChartStyle(defaultChartStyle(), input.style ?? {});
  if (!style.ok) return style;

  return succeed({
    chart_id: input.chart_id,
    chart_type: input.chart_type,
    title: input.title,
    categories: [...input.categories],
    series: input.series.map((series) => ({ name: series.name, points: [...series.points] })),
    style: style.value,
    source: input.source,
    // `fact_version` 只在**确实提供**时写入：省略时字段不存在，避免字面量图冒充某个版本。
    ...(input.fact_version === undefined ? {} : { fact_version: input.fact_version }),
  });
}

/** 全部数据点的来源清单（可审计）。 */
export function chartDataProvenance(chart: ChartDefinition): Result<readonly ChartPointProvenance[]> {
  const out: ChartPointProvenance[] = [];
  for (const [seriesIndex, series] of chart.series.entries()) {
    for (const [pointIndex, point] of series.points.entries()) {
      out.push({
        series_index: seriesIndex,
        series_name: series.name,
        point_index: pointIndex,
        category: point.category,
        value: point.value,
        fact_ref: point.fact_ref,
        fact_key: point.fact_key,
        traceable: point.fact_ref !== null && point.fact_key !== null,
      });
    }
  }
  return succeed(out);
}

/**
 * 可追溯性闸门：每个数据点都必须指认得事实来源。
 *
 * 为什么不是简单布尔：`traceable: false` 的**具体是哪一个点**必须能报出来（R112/R116 的取向），
 * 否则用户拿到"不可追溯"四个字也不知道该补哪一条事实。
 */
export function assertChartTraceable(chart: ChartDefinition): Result<ChartDefinition> {
  if (chart.series.length === 0) {
    return fail('empty_range', '图表没有任何数据系列，无可追溯的数据点。', { extra: { chartId: chart.chart_id } });
  }
  for (const [seriesIndex, series] of chart.series.entries()) {
    for (const [pointIndex, point] of series.points.entries()) {
      if (point.fact_ref === null || point.fact_key === null) {
        return fail(
          'precondition',
          `图表 "${chart.title}" 系列 "${series.name}" 第 ${String(pointIndex + 1)} 个数据点（${point.category}）没有事实来源；` +
            '图表数据必须绑定事实（单一来源纪律），不得使用无来源字面量。',
          { extra: { seriesIndex, pointIndex, category: point.category, value: point.value } },
        );
      }
    }
  }
  return succeed(chart);
}
