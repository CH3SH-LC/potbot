/**
 * 表格域：结构化表格 × 数据操作的**组合层**（X05 / XLS-09 × XLS-10）。
 *
 * ## 这一层补的洞
 *
 * `sort-filter.ts` 会动行，`structured-table.ts` 会迁移表范围，但二者**各自都不知道对方**：
 *
 * 1. **有汇总行的表不能直接套 `sortRange`**。`sortRange(sheet, table.range, …, {header:true})`
 *    会把数据体**加上汇总行**一起排序——汇总行会被当成"一个值恰好较大/较小的数据行"卷进中间。
 *    {@link sortTable} 只排**数据体**（标题行与汇总行都钉住不动）。
 * 2. **Excel 的表会"长大"**：在数据体紧接着的下一行写数据，表范围自动 +1 行。
 *    {@link appendTableRow} 用 `insertTableRows` 把新行吞进数据体（**顺带**让
 *    `sheet.ts` 迁移公式引用与合并区），再把值写进去，一次动作完成"扩表 + 引用更新"。
 *
 * 两条路径都**复用**既有函数，不重写排序比较器，也不重写范围迁移代数。
 *
 * ## 如实登记
 *
 * - `sortTable` 与 `sortRange` 同口径：按值搬运整行，**不重写**公式里的相对引用
 *   （结果对象里带 `warnings`）。
 * - `appendTableRow` 只处理**按列顺序的一行值**；公式型值原样写入（不重算，XLS-08 未接线）。
 */

import {
  insertTableRows,
  tableDataRange,
  type StructuredTable,
} from '../structured-table.js';
import { clearCell, getCellValue, setCellValue, type SheetState } from '../sheet.js';
import { filterRowIndices, sortRange, type FilterGroup, type SortKey } from '../sort-filter.js';
import { formatCellAddress, parseRange, type CellRange } from '../reference.js';
import type { CellValue } from '../value.js';
import { ValidationError } from '../../protocol/index.js';

/** 数据体的行区间（含两端；不含标题行与汇总行）。 */
interface BodyBounds {
  readonly start: number;
  readonly end: number;
  readonly empty: boolean;
}

function bodyBounds(table: StructuredTable): BodyBounds {
  const range = parseRange(table.range);
  const start = range.start.row + table.header_row_count;
  const end = range.end.row - table.totals_row_count;
  return { start, end, empty: end < start };
}

/** `sortTable` 结果。 */
export interface TableSortResult {
  readonly sheet: SheetState;
  readonly table: StructuredTable;
  /** 被重排的数据行数（标题行 / 汇总行不计入）。 */
  readonly movedRows: number;
  readonly warnings: readonly string[];
}

const TABLE_SORT_WARNING =
  '排序只作用于数据体（标题行与汇总行不动）；整行按值搬运，公式原文随之移动但不重写相对引用';

/**
 * 只对结构化表格的**数据体**整行排序。
 *
 * 标题行与汇总行**位置不动**，表范围不变；多键排序口径与 `sortRange` 完全一致
 * （复用同一比较器），因此不会出现"表内排序和普通区域排序规则不同"的分裂。
 *
 * @throws {ValidationError} 排序键的列不在表内 / 键表为空（由 `sortRange` 抛出）
 */
export function sortTable(
  sheet: SheetState,
  table: StructuredTable,
  keys: readonly SortKey[],
  options: { readonly blanks?: 'first' | 'last' } = {},
): TableSortResult {
  const bounds = bodyBounds(table);
  if (bounds.empty) {
    return Object.freeze({ sheet, table, movedRows: 0, warnings: Object.freeze([TABLE_SORT_WARNING]) });
  }
  const bodyColumns: CellRange = parseRange(tableDataRange(table));
  for (const key of keys) {
    if (key.column < bodyColumns.start.column || key.column > bodyColumns.end.column) {
      throw new ValidationError(
        `sortTable 的排序列 ${String(key.column)} 不在表 ${table.name} 的数据列 [${String(bodyColumns.start.column)}, ${String(bodyColumns.end.column)}] 内`,
      );
    }
  }
  const next = sortRange(sheet, bodyColumns, keys, {
    header: false,
    blanks: options.blanks ?? 'last',
  });
  return Object.freeze({
    sheet: next,
    table,
    movedRows: bounds.end - bounds.start + 1,
    warnings: Object.freeze([TABLE_SORT_WARNING]),
  });
}

/** `appendTableRow` 结果。 */
export interface AppendTableRowResult {
  readonly sheet: SheetState;
  readonly table: StructuredTable;
  /** 新数据行的绝对行号。 */
  readonly row: number;
}

/**
 * 在表的数据体**紧接着的下一行**写入一行值，并把表范围扩张一行（Excel 的"表会自动长大"）。
 *
 * 值按**表列顺序**给出，长度必须等于表列数（少一列或多一列都显式失败，不截断不补空）。
 * `blank` 值不落成显式条目（与 `clearCell` 同口径，读回仍是空白）。
 *
 * 内部走 `insertTableRows` ⇒ `sheet.ts` 的 `insertRows`，因此
 * **表内 / 表外公式的行引用与合并区随新行一起迁移**（XLS-10「引用更新正确」）。
 *
 * @throws {ValidationError} 值个数与列数不符 / 表列定义为空
 */
export function appendTableRow(
  sheet: SheetState,
  table: StructuredTable,
  values: readonly CellValue[],
): AppendTableRowResult {
  if (table.columns.length === 0) {
    throw new ValidationError(`表 ${table.name} 没有列，无法追加数据行`);
  }
  if (values.length !== table.columns.length) {
    throw new ValidationError(
      `appendTableRow 需要 ${String(table.columns.length)} 个值（= 表列数），收到 ${String(values.length)} 个`,
    );
  }
  const bounds = bodyBounds(table);
  const insertAt = bounds.end + 1; // 数据体紧接着的下一行（有汇总行时即汇总行位置）
  const { sheet: grownSheet, table: grownTable } = insertTableRows(sheet, table, insertAt, 1);
  const range = parseRange(grownTable.range);
  let next = grownSheet;
  for (let offset = 0; offset < values.length; offset += 1) {
    const value = values[offset];
    /* c8 ignore next -- offset 由 values.length === columns.length 约束 */
    if (value === undefined) continue;
    const address = { column: range.start.column + offset, row: insertAt };
    next = value.kind === 'blank' ? clearCell(next, address) : setCellValue(next, address, value);
  }
  return Object.freeze({ sheet: next, table: grownTable, row: insertAt });
}

/** 表数据体的匹配行（绝对行号，升序）。空表返回空数组。 */
export function tableBodyMatches(
  sheet: SheetState,
  table: StructuredTable,
  group: FilterGroup,
): readonly number[] {
  const bounds = bodyBounds(table);
  if (bounds.empty) return Object.freeze([]);
  return filterRowIndices(sheet, tableDataRange(table), group, { header: false });
}

/** 表数据体里**已设置且非空**的单元格地址（升序；供诊断 / 断言）。空表返回空数组。 */
export function tableBodyRefs(sheet: SheetState, table: StructuredTable): readonly string[] {
  const bounds = bodyBounds(table);
  if (bounds.empty) return Object.freeze([]);
  const range = parseRange(tableDataRange(table));
  const refs: string[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    for (let column = range.start.column; column <= range.end.column; column += 1) {
      if (getCellValue(sheet, { column, row }).kind !== 'blank') {
        refs.push(formatCellAddress({ column, row }));
      }
    }
  }
  return Object.freeze(refs);
}
