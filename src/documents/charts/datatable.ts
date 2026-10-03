/**
 * 图表的**嵌入数据表**模型（WF-092"图表和嵌入数据表"；判据"图形、数值与事实版本一致，非截图"）。
 *
 * ## 这张表是什么，为什么必须有它
 *
 * OOXML 里图表的数字存在于**两处**：`chart.xml` 的图形缓存（`c:numLit`，决定柱子多高）、
 * 以及可选的嵌入工作簿（`word/embeddings/…xlsx`，供 Word 的"编辑数据"打开）。判据要求
 * "图形、数值……一致"——两处数字若各写各的，就会出现"柱子高 8，双击编辑数据看到 3"
 * 这种**结构层就对不上**的产物，而**截图**恰恰掩盖这种不一致（图上看着对，数据源是错的）。
 *
 * 本文件把"这张表的内容"做成 `ChartDefinition` 的**纯函数**：`chartEmbeddedTable(chart)`
 * 只读图表数据点，逐格抄数值。于是
 *
 * - 表格数值 ≡ 图形数值（同一函数、同一输入，无第二处可写）；
 * - `verifyChartDataTable` 反过来核对一份**声称的**表，能抓住"表被单独改过"。
 *
 * ## 本文件**不**产出 XLSX 字节
 *
 * 真正把表写成 `.xlsx` 部件是导出器（`src/documents/docx/**`）的事。本层只给**内容**，
 * 并把"内容与图形一致"这条不变式**钉在纯函数与测试里**，让导出器拿到的一致内容。
 * 纯函数、零 IO、零外部依赖。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import type { ChartDataRow, ChartDataTable, ChartDefinition } from './types.js';

/** 类别列默认表头。不臆造品牌词，用中性中文。 */
export const DEFAULT_CATEGORY_HEADER = '类别';

export interface ChartEmbeddedTableOptions {
  /** 首列表头（类别列列名）；省略用 `DEFAULT_CATEGORY_HEADER`。 */
  readonly category_header?: string;
}

/**
 * 从图表**算出**嵌入数据表（纯函数：同图 ⇒ 同表）。
 *
 * 列顺序 = `chart.series` 顺序，行顺序 = `chart.categories` 顺序；
 * `row.values[i]` 恒等于 `series[i].points[行].value`——图形与表格数值同源。
 *
 * @returns 系列名重复 ⇒ `precondition`（同名列无法唯一指认，"编辑数据"里会歧义）；
 *          某系列缺该行数据点 ⇒ `precondition`（缺格不得当 0）。
 */
export function chartEmbeddedTable(
  chart: ChartDefinition,
  options: ChartEmbeddedTableOptions = {},
): Result<ChartDataTable> {
  const categoryHeader = options.category_header ?? DEFAULT_CATEGORY_HEADER;
  if (typeof categoryHeader !== 'string' || categoryHeader.length === 0) {
    return fail('invalid_query', '嵌入数据表的类别列头必须是非空字符串。', {
      extra: { header: String(categoryHeader) },
    });
  }

  const seen = new Set<string>();
  for (const [index, series] of chart.series.entries()) {
    if (typeof series.name !== 'string' || series.name.length === 0) {
      return fail('precondition', `第 ${String(index)} 条系列没有名称，嵌入表列头无法指认。`, {
        extra: { seriesIndex: index },
      });
    }
    if (seen.has(series.name)) {
      return fail(
        'precondition',
        `系列名 "${series.name}" 重复：嵌入数据表里两列同名会让"某根柱子来自哪一列"无唯一答案。`,
        { extra: { seriesName: series.name, seriesIndex: index } },
      );
    }
    seen.add(series.name);
  }

  const rows: ChartDataRow[] = [];
  for (const [pointIndex, category] of chart.categories.entries()) {
    const values: number[] = [];
    for (const [seriesIndex, series] of chart.series.entries()) {
      const point = series.points[pointIndex];
      if (point === undefined) {
        return fail(
          'precondition',
          `系列 "${series.name}" 缺少类别 "${category}" 对应的数据点（第 ${String(pointIndex + 1)} 行）：` +
            '嵌入表不得留空格，也不得用 0 顶替。',
          { extra: { seriesIndex, pointIndex, category } },
        );
      }
      values.push(point.value);
    }
    rows.push({ category, values });
  }

  return succeed({ category_header: categoryHeader, series_names: chart.series.map((s) => s.name), rows });
}

/**
 * 核对一份**声称的**嵌入数据表与图表是否一致。
 *
 * 不一致时 `precondition` 失败（表格与图形脱节属于"前置条件被破坏"）。
 * 比对用确定性签名（`chartDataTableSignature`），逐字段语义比对而非引用相等。
 */
export function verifyChartDataTable(chart: ChartDefinition, table: ChartDataTable): Result<ChartDataTable> {
  const actual = chartEmbeddedTable(chart);
  if (!actual.ok) return actual;
  const claimed = chartDataTableSignature(table);
  const expected = chartDataTableSignature(actual.value);
  if (claimed !== expected) {
    return fail(
      'precondition',
      `嵌入数据表与图表数据不一致（图表 "${chart.title}"）：表格必须由图表数据算出，不得独立修改`,
      { extra: { chartId: chart.chart_id, claimed, expected } },
    );
  }
  return succeed(actual.value);
}

/**
 * 表的确定性签名——同内容必得同串，供核对与证据摘要用。
 *
 * **刻意不是加密摘要**（本层零 IO、不引入 crypto）：它只回答"两份表内容是否相同"，
 * 不承担防篡改。需要密码学摘要时由导出层对**字节**计算 SHA-256。
 */
export function chartDataTableSignature(table: ChartDataTable): string {
  return JSON.stringify({
    h: table.category_header,
    s: table.series_names,
    r: table.rows.map((row) => [row.category, row.values]),
  });
}

/**
 * 把表摊成**行 × 列**的字符串矩阵（首行表头，首列类别），供嵌入工作簿写出器消费。
 * 数值转字符串用 `String(value)`——与 `chart-render` 的 `numberText` 同一约定（有限数已在构造期保证）。
 */
export function chartDataTableMatrix(table: ChartDataTable): readonly (readonly string[])[] {
  return [
    [table.category_header, ...table.series_names],
    ...table.rows.map((row) => [row.category, ...row.values.map((value) => String(value))]),
  ];
}

/** 表的单元格总数（含表头行与类别列）——容量评估用。 */
export function chartDataTableCellCount(table: ChartDataTable): number {
  const columns = 1 + table.series_names.length;
  const rows = 1 + table.rows.length;
  return columns * rows;
}

/** 表的一行摘要（回执/日志用）。 */
export function describeChartDataTable(table: ChartDataTable): string {
  return (
    `嵌入数据表：${String(table.rows.length)} 行 × ${String(1 + table.series_names.length)} 列，` +
    `系列 [${table.series_names.join('、')}]`
  );
}
