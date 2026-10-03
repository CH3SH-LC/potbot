/**
 * 表格网格列算术（WF-057/058 的结构前置条件）。
 *
 * ## 为什么要单独一层
 *
 * "第 3 列"在**合并单元格**存在时不是一个显然的概念：一行的第 3 列可能落在某个
 * `grid_span = 3` 的单元格内部。列操作（插入/删除/移动）必须先回答"这一列被谁占着"，
 * 否则就会出现"前半段成功、后半段悄悄失败"（R136 明令禁止）。
 *
 * 本模块只做**纯算术**，不做任何拒绝决策——拒绝由 `structure.ts` 按 R136 原子地做。
 * 这里的返回值带上 `straddles`（该列是否落在跨列单元格内部），供上层判定。
 */

import type { CellNode, Length, RowNode, TableNode } from './types.js';

/** 一行内某个单元格占据的列区间（`[start, start + span)`，列号从 0 起）。 */
export interface CellSpan {
  readonly cell_index: number;
  readonly cell: CellNode;
  readonly start: number;
  readonly span: number;
}

/** 逐单元格算出它占据的列区间（按 `grid_span` 累加）。 */
export function rowCellSpans(row: RowNode): readonly CellSpan[] {
  const spans: CellSpan[] = [];
  let start = 0;
  row.cells.forEach((cell, cellIndex) => {
    const span = Number.isInteger(cell.grid_span) && cell.grid_span >= 1 ? cell.grid_span : 1;
    spans.push({ cell_index: cellIndex, cell, start, span });
    start += span;
  });
  return spans;
}

/** 该行的总列数（= 各单元格 `grid_span` 之和）。 */
export function rowColumnCount(row: RowNode): number {
  return rowCellSpans(row).reduce((total, span) => total + span.span, 0);
}

/**
 * 表格的列数。
 *
 * 有网格定义（`grid.length > 0`）时以网格为准；否则取各行列数的**最大值**
 * （行长短不齐时"列数"取并集，具体是否合法由 `structure.ts` 判定）。
 */
export function tableColumnCount(table: TableNode): number {
  if (table.grid.length > 0) {
    return table.grid.length;
  }
  return table.rows.reduce((max, row) => Math.max(max, rowColumnCount(row)), 0);
}

/** 覆盖 `column` 这一列、且跨列数 > 1 的单元格；没有则返回 `null`。 */
export function straddlingSpan(row: RowNode, column: number): CellSpan | null {
  for (const span of rowCellSpans(row)) {
    if (span.span > 1 && column > span.start && column < span.start + span.span) {
      return span;
    }
  }
  return null;
}

/** 落在 `column` 这一列上的单元格（`start === column`）；跨列单元格也算命中。 */
export function spanAtColumn(row: RowNode, column: number): CellSpan | null {
  for (const span of rowCellSpans(row)) {
    if (column >= span.start && column < span.start + span.span) {
      return span;
    }
  }
  return null;
}

/** 该行列数与 `columnCount` 是否一致。 */
export function rowMatchesColumnCount(row: RowNode, columnCount: number): boolean {
  return rowColumnCount(row) === columnCount;
}

/** 表格所有行的列数是否都等于 `columnCount`。 */
export function tableHasUniformColumns(table: TableNode, columnCount: number): boolean {
  return table.rows.every((row) => rowMatchesColumnCount(row, columnCount));
}

/** 表格里是否存在网格定义给出的列宽数组。 */
export function gridWidths(table: TableNode): readonly Length[] {
  return table.grid;
}

/** 找出列上是否有纵向合并链（`restart` / `continue`），列操作需要把它们整列拒绝。 */
export function columnHasVerticalMerge(row: RowNode, column: number): boolean {
  const span = spanAtColumn(row, column);
  return span !== null && span.cell.vertical_merge !== null;
}
