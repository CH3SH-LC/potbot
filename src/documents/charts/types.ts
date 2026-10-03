/**
 * 图表的**数据与样式模型**（WF-092）。
 *
 * ## 图表的三条判据，与本文件的对应关系
 *
 * | 判据 | 载体 |
 * |---|---|
 * | **数据来源可追溯** | `ChartPoint.fact_ref` / `.fact_key`（绑定事实来源，R48.3 单一来源） |
 * | **数据与图形一致** | `geometry.ts` 从数据**算出**图形描述，改数据必然改描述 |
 * | **相关部件清单完整** | `parts.ts` 的部件/关系/内容类型清单 + 缺件检查 |
 *
 * ## 为什么每个数据点都要带事实引用
 *
 * design-02 P3 把"关键数据单一来源"钉成了结构性纪律：三类产物构建器的输入契约里
 * **没有原始数字的参数位置**，只有事实键与事实快照（R48.3）。图表是最容易破坏这条纪律的
 * 地方——"顺手把 12 写进柱子里"会立刻造出第二个数据源。所以本模型里数值**必须**能指认
 * 到一条事实（`fact_ref`），"没有来源的点"在类型上被单独标出来，由 `facts.ts` 拒绝。
 */

import type { FactRef, Revision, TaskId } from '../../protocol/index.js';
import type { Length, SourceKind } from '../model/types.js';

/** 支持的图表类型（WF-092：柱形 / 折线 / 饼图；`bar` 为条形，与柱形同族）。 */
export const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** 图例位置（样式层的封闭枚举，避免"自由字符串"）。 */
export const LEGEND_POSITIONS = ['none', 'right', 'top', 'bottom', 'left'] as const;
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];

/**
 * 一个数据点。
 *
 * `fact_ref`/`fact_key` 为 `null` 表示**这是个无来源的字面量**——本模型允许它存在
 * （导入既有图表时总得能表示），但 `assertChartTraceable` 会把它挡住，
 * 于是"可表示"与"可通过"被分开，不会靠一支笔悄悄绕过来源纪律。
 */
export interface ChartPoint {
  readonly category: string;
  readonly value: number;
  readonly fact_ref: FactRef | null;
  readonly fact_key: string | null;
}

/** 一条数据系列。 */
export interface ChartSeries {
  readonly name: string;
  readonly points: readonly ChartPoint[];
}

/** 图表样式（WF-092 的"基本样式修改"）。颜色为 6 位十六进制（**不带 `#`**，与 `ColorValue` 同约定）。 */
export interface ChartStyle {
  readonly legend: LegendPosition;
  readonly palette: readonly string[];
  readonly data_labels: boolean;
  readonly gridlines: boolean;
  readonly title_font_size_pt: number;
  readonly axis_font_size_pt: number;
}

/**
 * 图表绑定的**事实版本**（WF-092"图形、数值与事实版本一致"）。
 *
 * 图表从事实快照装配时，把快照的 `(task_id, task_revision)` 记下来——它回答的是
 * "这张图里的数字是**哪一个版本**的事实"。没有它，`verifyChartNumbersAgainstSnapshot`
 * 只能比对单点数值，无法回答"整张图是不是还在同一个版本上"：
 * 任务版本一升，旧图里的 `fact_ref` 与数值就**整体过期**，必须显式失效而不是继续通过。
 */
export interface ChartFactVersion {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
}

/**
 * 图表定义。
 *
 * `categories` 与各系列的 `points` **一一对应**（同长度、同顺序），由 `buildChart` 强制：
 * 类别轴不共享的话，"第 2 根柱子属于哪一类"就没有唯一答案，图形描述也就无从谈起。
 *
 * `fact_version` **可选**：从事实快照装配的图（`bindChartFromFacts`）会带上它；
 * 由字面量/导入构造的图没有它（`undefined`）——"未声明版本"与"版本=r0"必须区分，
 * 因此不写默认值，缺省即 `undefined`。
 */
export interface ChartDefinition {
  readonly chart_id: string;
  readonly chart_type: ChartType;
  readonly title: string;
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly style: ChartStyle;
  readonly source: SourceKind;
  /** 绑定的**事实版本**；字面量/导入图缺省为 `undefined`（不冒充某个版本）。 */
  readonly fact_version?: ChartFactVersion | null;
}

// ---------------------------------------------------------------------------
// 嵌入数据表（图表的数据缓存模型；WF-092"图表和嵌入数据表"）
// ---------------------------------------------------------------------------

/**
 * 嵌入数据表的一行：一个类别 + 各系列在该类别下的取值。
 * `values[i]` 对应 `series[i]`（顺序即列顺序）。
 */
export interface ChartDataRow {
  readonly category: string;
  readonly values: readonly number[];
}

/**
 * 图表的**嵌入数据表**——Word 里"编辑数据"看到的那张表的内容。
 *
 * 它**不是**第二份数据源：本模型由 `chartEmbeddedTable(chart)` 从 `ChartDefinition`
 * **算出**（唯一来源仍是图表的数据点），所以"图形的高度 / 缓存里的数值 / 表格里的数值"
 * 天然是同一组数。`verifyChartDataTable` 反过来核对一份**声称的**表是否与图表一致——
 * 用来抓住"表被单独改过"（图形与表格脱节）的情况。
 */
export interface ChartDataTable {
  /** 首列表头（类别列的列名）。 */
  readonly category_header: string;
  /** 各系列名（表头行的其余列，顺序即 `series` 顺序）。 */
  readonly series_names: readonly string[];
  /** 数据行，顺序即 `categories` 顺序。 */
  readonly rows: readonly ChartDataRow[];
}

/**
 * 数据点的来源说明（"每个数据点能指认到来源"的可审计形式）。
 * `fact_ref === null` 时 `fact_key` 也是 `null`，且 `traceable` 为 `false`。
 */
export interface ChartPointProvenance {
  readonly series_index: number;
  readonly series_name: string;
  readonly point_index: number;
  readonly category: string;
  readonly value: number;
  readonly fact_ref: FactRef | null;
  readonly fact_key: string | null;
  readonly traceable: boolean;
}

/** 图表部件的**期望清单**（WF-092"相关部件完整"）。 */
export interface ChartPartsManifest {
  readonly chart_part: string;
  readonly chart_content_type: string;
  readonly relationship_type: string;
  /** 图表 XML 内的数据缓存部件（嵌入工作簿）；`null` = 不写嵌入件（图表仍可用）。 */
  readonly embedded_workbook_part: string | null;
  /** 必需的关系类型（缺一即为悬空引用）。 */
  readonly required_relationship_types: readonly string[];
  /** 与图表尺寸有关的说明（EMU 由换算层处理；此处只带 `Length`）。 */
  readonly extent: { readonly width: Length; readonly height: Length } | null;
}
