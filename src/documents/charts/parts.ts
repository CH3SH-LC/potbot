/**
 * 图表的**部件清单**与接线桥（WF-092"相关部件完整"；R106/R107）。
 *
 * ## 为什么"图形部件清单"必须是数据
 *
 * DOCX 里的图表**不是一个 inline 元素**：`w:drawing` 只是图形容器，真正的图形数据在
 * `word/charts/chartN.xml`（DrawingML Chart），由一条 `relationships` 指过去，
 * 并且要在 `[Content_Types].xml` 里声明。少任何一环，Word 打开时就是"图片无法显示"。
 * 既然本轮不接线到导出器，本包至少把**该有哪些部件**变成可断言的数据：
 * 清单完整 ⇒ 导出器照着写就行；缺件 ⇒ 现在就能报出来（`checkChartParts`）。
 *
 * ## 与文档模型的搭接
 *
 * 模型冻结骨架的 `DrawingNode.drawing_type` **已含 `'chart'`**，`relationship_id` 也已就位，
 * 所以"图表在段落里占一个对象位"这件事今天就能表达（`chartDrawingBinding`）。
 * 缺的是导出侧把 `chart.xml` 部件与关系写出来——这条缺口登记在交付说明里。
 */

import { drawingNode, type DraftDrawingNode } from '../model/nodes.js';
import type { Length, SourceKind } from '../model/types.js';
import { fail, succeed, type Result } from '../selection/types.js';
import type { ChartDefinition, ChartPartsManifest } from './types.js';

/** 图表部件的内容类型（DrawingML Chart，OOXML 规范值）。 */
export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
/** 图表关系类型（OOXML 规范值）。 */
export const CHART_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
/** 嵌入工作簿的内容类型（图表的数据缓存；可选件）。 */
export const EMBEDDED_WORKBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** 嵌入工作簿的关系类型。 */
export const EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package';

/**
 * 图表期望部件清单。
 *
 * @param partIndex 部件序号（1 起）——`word/charts/chart1.xml`。
 * @param options.embedded_workbook 是否同时写嵌入工作簿（Word 默认会写，用于"编辑数据"）。
 */
export function chartPartsManifest(
  chart: ChartDefinition,
  partIndex: number,
  options: { readonly extent?: { readonly width: Length; readonly height: Length } | null; readonly embedded_workbook?: boolean } = {},
): Result<ChartPartsManifest> {
  if (!Number.isInteger(partIndex) || partIndex < 1) {
    return fail('invalid_query', `chart 部件序号必须是 ≥1 的整数，收到 ${String(partIndex)}`, {
      extra: { partIndex },
    });
  }
  const embedded = options.embedded_workbook ?? true;
  return succeed({
    chart_part: `word/charts/chart${String(partIndex)}.xml`,
    chart_content_type: CHART_CONTENT_TYPE,
    relationship_type: CHART_RELATIONSHIP_TYPE,
    embedded_workbook_part: embedded ? `word/embeddings/Microsoft_Excel_Worksheet${String(partIndex)}.xlsx` : null,
    required_relationship_types: embedded
      ? [CHART_RELATIONSHIP_TYPE, EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE]
      : [CHART_RELATIONSHIP_TYPE],
    extent: options.extent ?? null,
  });
}

/**
 * 核对"清单里要的部件，实际都提供了"。
 *
 * 硬伤只有两类：**图表部件本身**缺失，或**图表关系**缺失。嵌入工作簿按 OOXML 是可选件
 * （图表轴标与数值由 `chart.xml` 自带缓存，缺它仍能显示），因此它只出现在
 * `required_relationship_types` 里由调用方按需声明，不在本函数里强制。
 *
 * @param provided 实际存在的关系类型（或部件路径）集合，调用方按自己那一层给。
 * @returns 齐全时给出清单；缺件时 `not_found` 并把**缺哪些**列出来（R112/R116 取向）。
 */
export function checkChartParts(
  manifest: ChartPartsManifest,
  provided: readonly string[],
): Result<ChartPartsManifest> {
  const have = new Set(provided);
  const missing: string[] = [];
  if (!have.has(manifest.chart_part)) missing.push(manifest.chart_part);
  for (const relationship of manifest.required_relationship_types) {
    if (!have.has(relationship)) missing.push(relationship);
  }
  if (missing.length > 0) {
    return fail('not_found', `图表部件清单不完整，缺少：${missing.join('、')}`, {
      extra: { missing: missing.join('、'), chartPart: manifest.chart_part },
    });
  }
  return succeed(manifest);
}

/**
 * 把图表落成文档模型里的图形节点（`DrawingNode.drawing_type === 'chart'`）。
 *
 * **必须给 `relationship_id`**：没有关系的图形是悬空引用（R106），
 * 消费者会拒收整个包。这里把它做成前置条件，而不是留给导出时才发现。
 */
export function chartDrawingBinding(
  chart: ChartDefinition,
  manifest: ChartPartsManifest,
  input: {
    readonly relationship_id: string;
    readonly source: SourceKind;
    readonly wrap?: DraftDrawingNode['wrap'];
    readonly alt_text?: string | null;
  },
): Result<DraftDrawingNode> {
  if (typeof input.relationship_id !== 'string' || input.relationship_id.length === 0) {
    return fail(
      'precondition',
      `图表 "${chart.title}" 没有关系 id：图形必须通过关系指向 ${manifest.chart_part}，否则是悬空引用（R106）。`,
      { extra: { chartId: chart.chart_id, chartPart: manifest.chart_part } },
    );
  }
  return succeed(
    drawingNode({
      drawing_type: 'chart',
      source: input.source,
      relationship_id: input.relationship_id,
      extent: manifest.extent,
      alt_text: input.alt_text ?? chart.title,
      ...(input.wrap === undefined ? {} : { wrap: input.wrap }),
    }),
  );
}
