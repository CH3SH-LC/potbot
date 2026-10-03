/**
 * 图表样式的**基本修改**（WF-092）。
 *
 * 样式只改"怎么画"，**不碰数据**——因此 `setChartStyle` 前后
 * `describeChart` 的结果必须完全一致（这条不变式写进了测试）：
 * 换配色、关图例、开数据标签都不该让柱子变高。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import { mergeChartStyle } from './build.js';
import type { ChartDefinition, ChartStyle } from './types.js';

/**
 * 修改样式：返回**新图表**（数据与 `chart_id` 原样保留）。
 * 非法样式（未知图例位置 / 非 6 位十六进制颜色 / 非正字号）返回 `Failure`，不改原对象。
 */
export function setChartStyle(chart: ChartDefinition, patch: Partial<ChartStyle>): Result<ChartDefinition> {
  const merged = mergeChartStyle(chart.style, patch);
  if (!merged.ok) return merged;
  // 幂等（R137）：补丁没有实际变化时返回**同一个**图表对象，让上层能判"没改过"。
  if (JSON.stringify(merged.value) === JSON.stringify(chart.style)) {
    return succeed(chart);
  }
  return succeed({ ...chart, style: merged.value });
}

/** 样式的可读摘要（回执用）。 */
export function describeChartStyle(style: ChartStyle): string {
  return (
    `图例=${style.legend}｜数据标签=${style.data_labels ? '开' : '关'}｜网格线=${style.gridlines ? '开' : '关'}｜` +
    `配色 ${String(style.palette.length)} 色｜标题 ${String(style.title_font_size_pt)}pt｜轴 ${String(style.axis_font_size_pt)}pt`
  );
}

/** 显式拒绝：把"样式修改"误当成"数据修改"的调用（保留给上层的语义守卫用）。 */
export function assertStyleOnlyChange(before: ChartDefinition, after: ChartDefinition): Result<ChartDefinition> {
  if (before.chart_id !== after.chart_id) {
    return fail('precondition', '样式修改不得改变 chart_id。', { extra: { before: before.chart_id, after: after.chart_id } });
  }
  const sameData = JSON.stringify(before.categories) === JSON.stringify(after.categories)
    && JSON.stringify(before.series) === JSON.stringify(after.series);
  if (!sameData) {
    return fail('precondition', '本操作只改样式；数据（类别轴与系列）不得随之改变。', { extra: { chartId: before.chart_id } });
  }
  return succeed(after);
}
