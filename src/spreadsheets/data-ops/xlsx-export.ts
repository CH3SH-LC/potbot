/**
 * 表格域：把 X05 的**排序 / 扩表结果落到真实 .xlsx 字节**（XLS-09 × XLS-10 的文件边界）。
 *
 * ## 为什么还要这一层
 *
 * `operations.ts` / `table-compose.ts` 把"排序、扩表"做成了**强类型内存运算**，但它们
 * 只改 `SheetState`——"表范围长了一行"这件事停留在内存里，**没有任何字节**证明它进了文件。
 * 把这份内存状态写进 .xlsx 要靠 `xlsx-write.ts` 的 `writeWorkbookXlsx`（它已经会把
 * `StructuredTable` 写成 `xl/tables/tableN.xml` 并挂 `<tableParts>`），但调用方必须自己
 * 拼一个单表工作簿、把表挂到正确的表名上——那几行样板正是本层收敛掉的。
 *
 * 本层**不做**任何运算，也**不做**任何读回自校验（"自己证明自己"不算证据）：
 *
 * - 写：委托 `writeWorkbookXlsx`（外层写入器），只负责把"一张表 + 一个结构化表格"
 *   组装成一次调用；
 * - 读：**不在这里**。独立读回由验收用例用**另一个读回器**（`xlsx-read.ts` 的
 *   `readWorkbookXlsx`）与**原始容器**（`readZip`）完成——那是"独立消费者"的定义。
 *
 * ## 一条容易被忽略的接线
 *
 * 结构化表格是**工作表级附加内容**（`XlsxWriteExtras.sheets[sheetName].tables`），
 * 表名必须是工作簿里真实存在的工作表名，否则 `writeWorkbookXlsx` 会**显式失败**而不是
 * 静默丢弃。本层因此始终用 `sheet.name` 作键，不新增任何"猜表名"的路径。
 */

import { createWorkbook } from '../workbook.js';
import type { SheetState } from '../sheet.js';
import type { SortKey } from '../sort-filter.js';
import type { StructuredTable } from '../structured-table.js';
import type { CellValue } from '../value.js';
import {
  EMPTY_RESIDUAL,
  writeWorkbookXlsx,
  type XlsxWriteResult,
} from '../xlsx-write.js';
import { appendTableRow, sortTable } from './table-compose.js';

/** 一次写盘的结果：真实字节 + 外层写入器的完整回执（含 `table_part_paths`）。 */
export interface SheetXlsxWrite {
  /** 真实容器字节（可写盘的 .xlsx）。 */
  readonly bytes: Buffer;
  /** 外层写入器回执：`table_part_paths` 是"表真的落了盘"的正向证据。 */
  readonly write: XlsxWriteResult;
}

/**
 * 把一张工作表写成**真实 .xlsx 字节**；给了 `table` 就把该结构化表格一并挂上。
 *
 * 单表工作簿：`createWorkbook([sheet])`。表挂在工作表自身的名字下，因此
 * `write.table_part_paths` 非空当且仅当 `table !== undefined`。
 *
 * @throws {ValidationError} 工作表名 / 表定义非法（由底层写入器抛出）
 */
export function writeSheetXlsx(sheet: SheetState, table?: StructuredTable): SheetXlsxWrite {
  const workbook = createWorkbook([sheet]);
  const write = writeWorkbookXlsx(
    workbook,
    EMPTY_RESIDUAL,
    table === undefined ? {} : { sheets: { [sheet.name]: { tables: [table] } } },
  );
  return Object.freeze({ bytes: write.bytes, write });
}

/** `sortExpandTableXlsx` 的结果：内存状态 + 运算回执 + 真实字节。 */
export interface SortExpandTableFile {
  /** 排序并（可选）扩表后的工作表。 */
  readonly sheet: SheetState;
  /** 排序并扩表后的**表定义**（`range` 已随扩表增长）。 */
  readonly table: StructuredTable;
  /** 排序实际重排的数据行数（标题行 / 汇总行不计入）。 */
  readonly moved_rows: number;
  /** 排序的已知边界（如"公式原文随行搬运但相对引用不改写"）。 */
  readonly warnings: readonly string[];
  /** 追加的数据行落在哪一行；未追加时为 `null`。 */
  readonly appended_row: number | null;
  /** 落盘结果（真实字节 + 外层写入器回执）。 */
  readonly file: SheetXlsxWrite;
}

/**
 * 一次完成 XLS-09/10 的验收动作：**排序数据体 + （可选）扩表一行，再写成真实 .xlsx**。
 *
 * 步骤与 `table-compose.ts` 一一对应，本层只做**编排**：
 * 1. {@link sortTable} —— 只排数据体（标题行 / 汇总行钉住），返回 `moved_rows` / `warnings`；
 * 2. `appended !== null` 时 {@link appendTableRow} —— 在数据体下一行写值并让表长大一行；
 * 3. {@link writeSheetXlsx} —— 把最终 `(sheet, table)` 写进容器。
 *
 * `options.blanks` 透传给 `sortTable`：`'first'` 是**结果语义**（恒为结果最前），
 * **不随排序方向翻转**——这条语义由 `sort-filter.ts` 保证，本层不重解释。
 *
 * @throws {ValidationError} 排序键不在表内 / 追加值个数与列数不符
 */
export function sortExpandTableXlsx(
  sheet: SheetState,
  table: StructuredTable,
  keys: readonly SortKey[],
  appended: readonly CellValue[] | null,
  options: { readonly blanks?: 'first' | 'last' } = {},
): SortExpandTableFile {
  const sorted = sortTable(sheet, table, keys, options);
  const expanded =
    appended === null ? { sheet: sorted.sheet, table: sorted.table, row: null } : appendTableRow(sorted.sheet, sorted.table, appended);
  return Object.freeze({
    sheet: expanded.sheet,
    table: expanded.table,
    moved_rows: sorted.movedRows,
    warnings: sorted.warnings,
    appended_row: expanded.row,
    file: writeSheetXlsx(expanded.sheet, expanded.table),
  });
}
