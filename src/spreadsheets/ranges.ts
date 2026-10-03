/**
 * 表格域：行列增删、宽高、隐藏、自动调整、冻结窗格、合并 / 拆分
 * （design-06-P8 / XLS-04；合同 R250）。
 *
 * ## 本模块补的是"工作表几何"，不是"工作表内容"
 *
 * `sheet.ts` 已有 `SheetState`（值 + 尺寸 + 冻结 + 合并），但没有**行高 / 列宽 / 隐藏行列**这些
 * "几何"信息。于是本模块引入 {@link SheetLayoutState}：在 `SheetState` **之外**再挂三张
 * 尺寸表。值、公式、合并区仍住在 `SheetState` 里——本模块**不复制它们**，只在结构变更时**委托**
 * `sheet.ts` 去迁移。
 *
 * ## 最硬的那条判据：行列增删后"单元格和公式引用正确迁移"
 *
 * 本模块的 {@link insertSheetRows} / {@link deleteSheetRows} / {@link insertSheetColumns} /
 * {@link deleteSheetColumns} 是**一层薄薄的组合**：
 *
 * 1. **单元格与公式** —— 直接调用 `sheet.ts` 的 `insertRows` / `deleteRows` / …。因此
 *    "哪些格移动、公式里的 `A1` 怎么变、`LOG10(` 这种不能安全改写时怎么阻塞"，全部由
 *    `sheet.ts → formula.ts → reference.ts` 那条既有链路决定；本模块**不重写一行引用算术**。
 * 2. **几何（行高 / 列宽 / 隐藏）** —— 用 `reference.ts` 的 `mapReferenceOn*` **同一对**映射
 *    函数把 key 搬过去，因此几何与值**永远同进同退**。被删中的行 / 列，其几何随之消失（`ok:false`）。
 *
 * 这条"委托而非重造"不是风格洁癖：两套行号算术迟早会漂移，而漂移的表现是"改完行之后某格样式
 * 在错行"——一类极难被肉眼发现的静默错误。
 */

import { ValidationError } from '../protocol/index.js';
import {
  MAX_COLUMN_NUMBER,
  MAX_ROW_NUMBER,
  formatCellAddress,
  mapReferenceOnColumnDelete,
  mapReferenceOnColumnInsert,
  mapReferenceOnRowDelete,
  mapReferenceOnRowInsert,
  parseCellAddress,
  parseRange,
  type CellAddress,
  type CellRange,
  type ReferenceMapResult,
} from './reference.js';
import { styleKey } from './style-parts/descriptor.js';
import type { CellStyle, CellStyles } from './styles.js';
import {
  copyColumns,
  copyRows,
  deleteColumns,
  deleteRows,
  insertColumns,
  insertRows,
  mapMovePosition,
  moveColumns,
  moveRows,
  setFrozenPanes,
  type SheetState,
} from './sheet.js';
import type { CellValue } from './value.js';

/** Excel 默认行高（磅）。 */
export const DEFAULT_ROW_HEIGHT = 15;

/** Excel 默认列宽（字符数）。 */
export const DEFAULT_COLUMN_WIDTH = 8.43;

/** 自动调整时的额外留白（字符数）。 */
export const AUTO_FIT_PADDING = 2;

/** 列宽上限（Excel 的 255 字符）。 */
const MAX_COLUMN_WIDTH = 255;

/**
 * 工作表几何状态（不可变）：在 `SheetState` 之上补行高 / 列宽 / 隐藏行列。
 *
 * `row_heights` / `column_widths` 的 key 都是**1 起**的行号 / 列号；缺省即 {@link DEFAULT_ROW_HEIGHT}
 * 或 {@link DEFAULT_COLUMN_WIDTH}（**不给未设置的行硬塞一个值**，否则改不了"用默认"这件事）。
 */
export interface SheetLayoutState {
  readonly sheet: SheetState;
  readonly row_heights: ReadonlyMap<number, number>;
  readonly column_widths: ReadonlyMap<number, number>;
  /** 隐藏行（升序、去重）。 */
  readonly hidden_rows: readonly number[];
  /** 隐藏列（升序、去重）。 */
  readonly hidden_columns: readonly number[];
}

/** 用一张空几何包住一张工作表。 */
export function createSheetLayout(sheet: SheetState): SheetLayoutState {
  return Object.freeze({
    sheet,
    row_heights: new Map<number, number>(),
    column_widths: new Map<number, number>(),
    hidden_rows: Object.freeze([]) as readonly number[],
    hidden_columns: Object.freeze([]) as readonly number[],
  });
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function requireRow(row: number, where: string): number {
  if (!Number.isInteger(row) || row < 1 || row > MAX_ROW_NUMBER) {
    throw new ValidationError(`${where} 的行号须是 1…${String(MAX_ROW_NUMBER)} 的整数，收到 ${String(row)}`);
  }
  return row;
}

function requireColumn(column: number, where: string): number {
  if (!Number.isInteger(column) || column < 1 || column > MAX_COLUMN_NUMBER) {
    throw new ValidationError(
      `${where} 的列号须是 1…${String(MAX_COLUMN_NUMBER)} 的整数，收到 ${String(column)}`,
    );
  }
  return column;
}

function requireSpan(start: number, count: number, limit: number, where: string): void {
  if (!Number.isInteger(start) || start < 1 || start > limit) {
    throw new ValidationError(`${where} 的起点越界：${String(start)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${where} 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
  if (start + count - 1 > limit) {
    throw new ValidationError(`${where} 的范围越界：${String(start)}…${String(start + count - 1)}`);
  }
}

function requirePositiveSize(size: number, where: string): number {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new ValidationError(`${where} 必须是正有限数，收到 ${String(size)}`);
  }
  return size;
}

/** 组一个新的 `SheetState`（单点封装；不改 `sheet.ts`）。 */
function withSheet(sheet: SheetState, patch: Partial<SheetState>): SheetState {
  return Object.freeze({ ...sheet, ...patch }) as SheetState;
}

// ---------------------------------------------------------------------------
// 尺寸：行高 / 列宽
// ---------------------------------------------------------------------------

/** 读行高（未设置 ⇒ {@link DEFAULT_ROW_HEIGHT}）。@throws {ValidationError} */
export function getRowHeight(layout: SheetLayoutState, row: number): number {
  return layout.row_heights.get(requireRow(row, 'getRowHeight')) ?? DEFAULT_ROW_HEIGHT;
}

/** 读列宽（未设置 ⇒ {@link DEFAULT_COLUMN_WIDTH}）。@throws {ValidationError} */
export function getColumnWidth(layout: SheetLayoutState, column: number): number {
  return layout.column_widths.get(requireColumn(column, 'getColumnWidth')) ?? DEFAULT_COLUMN_WIDTH;
}

/** 设置行高（磅）。@throws {ValidationError} */
export function setRowHeight(layout: SheetLayoutState, row: number, height: number): SheetLayoutState {
  const index = requireRow(row, 'setRowHeight');
  const next = new Map(layout.row_heights);
  next.set(index, requirePositiveSize(height, '行高'));
  return Object.freeze({ ...layout, row_heights: next });
}

/** 清除行高（回到默认）。@throws {ValidationError} */
export function clearRowHeight(layout: SheetLayoutState, row: number): SheetLayoutState {
  const index = requireRow(row, 'clearRowHeight');
  const next = new Map(layout.row_heights);
  next.delete(index);
  return Object.freeze({ ...layout, row_heights: next });
}

/** 设置列宽（字符数）。@throws {ValidationError} */
export function setColumnWidth(layout: SheetLayoutState, column: number, width: number): SheetLayoutState {
  const index = requireColumn(column, 'setColumnWidth');
  const next = new Map(layout.column_widths);
  next.set(index, requirePositiveSize(width, '列宽'));
  return Object.freeze({ ...layout, column_widths: next });
}

/** 清除列宽（回到默认）。@throws {ValidationError} */
export function clearColumnWidth(layout: SheetLayoutState, column: number): SheetLayoutState {
  const index = requireColumn(column, 'clearColumnWidth');
  const next = new Map(layout.column_widths);
  next.delete(index);
  return Object.freeze({ ...layout, column_widths: next });
}

// ---------------------------------------------------------------------------
// 隐藏
// ---------------------------------------------------------------------------

function withHidden(list: readonly number[], start: number, count: number, hidden: boolean): readonly number[] {
  const set = new Set(list);
  for (let index = start; index < start + count; index += 1) {
    if (hidden) {
      set.add(index);
    } else {
      set.delete(index);
    }
  }
  return Object.freeze([...set].sort((a, b) => a - b));
}

/** 隐藏 / 取消隐藏一段行。@throws {ValidationError} */
export function setRowsHidden(
  layout: SheetLayoutState,
  start: number,
  count: number,
  hidden: boolean,
): SheetLayoutState {
  requireSpan(start, count, MAX_ROW_NUMBER, 'setRowsHidden');
  return Object.freeze({ ...layout, hidden_rows: withHidden(layout.hidden_rows, start, count, hidden) });
}

/** 隐藏 / 取消隐藏一段列。@throws {ValidationError} */
export function setColumnsHidden(
  layout: SheetLayoutState,
  start: number,
  count: number,
  hidden: boolean,
): SheetLayoutState {
  requireSpan(start, count, MAX_COLUMN_NUMBER, 'setColumnsHidden');
  return Object.freeze({
    ...layout,
    hidden_columns: withHidden(layout.hidden_columns, start, count, hidden),
  });
}

/** 隐藏一段行。@throws {ValidationError} */
export function hideRows(layout: SheetLayoutState, start: number, count: number): SheetLayoutState {
  return setRowsHidden(layout, start, count, true);
}

/** 取消隐藏一段行。@throws {ValidationError} */
export function unhideRows(layout: SheetLayoutState, start: number, count: number): SheetLayoutState {
  return setRowsHidden(layout, start, count, false);
}

/** 隐藏一段列。@throws {ValidationError} */
export function hideColumns(layout: SheetLayoutState, start: number, count: number): SheetLayoutState {
  return setColumnsHidden(layout, start, count, true);
}

/** 取消隐藏一段列。@throws {ValidationError} */
export function unhideColumns(layout: SheetLayoutState, start: number, count: number): SheetLayoutState {
  return setColumnsHidden(layout, start, count, false);
}

/** 该行是否隐藏。@throws {ValidationError} */
export function isRowHidden(layout: SheetLayoutState, row: number): boolean {
  return layout.hidden_rows.includes(requireRow(row, 'isRowHidden'));
}

/** 该列是否隐藏。@throws {ValidationError} */
export function isColumnHidden(layout: SheetLayoutState, column: number): boolean {
  return layout.hidden_columns.includes(requireColumn(column, 'isColumnHidden'));
}

// ---------------------------------------------------------------------------
// 自动调整
// ---------------------------------------------------------------------------

/**
 * 按**本列已有单元格的文本长度**自动调整列宽（XLS-04「自动调整」）。
 *
 * 这是**启发式**，不是真正的字体度量：列宽 = 该列最长显示文本长度 + {@link AUTO_FIT_PADDING}，
 * 下不封顶于默认列宽、上封顶于 255 字符。空列 ⇒ 默认列宽。数字 / 布尔 / 日期 / 错误值 / 公式
 * 按其**文本形态**计长（与在单元格里见到的一致）。
 *
 * @throws {ValidationError}
 */
export function autoFitColumn(layout: SheetLayoutState, column: number): SheetLayoutState {
  const index = requireColumn(column, 'autoFitColumn');
  let longest = 0;
  for (const [ref, value] of layout.sheet.cells) {
    const address = parseCellAddress(ref);
    if (address.column !== index) {
      continue;
    }
    longest = Math.max(longest, cellTextLength(value));
  }
  if (longest === 0) {
    return clearColumnWidth(layout, index);
  }
  const width = Math.min(MAX_COLUMN_WIDTH, Math.max(DEFAULT_COLUMN_WIDTH, longest + AUTO_FIT_PADDING));
  return setColumnWidth(layout, index, Math.round(width * 100) / 100);
}

function cellTextLength(value: CellValue): number {
  switch (value.kind) {
    case 'blank':
      return 0;
    case 'text':
      return value.value.length;
    case 'number':
      return String(value.value).length;
    case 'boolean':
      return value.value ? 4 : 5; // TRUE / FALSE
    case 'date':
      return 10; // yyyy-mm-dd
    case 'error':
      return value.code.length;
    case 'formula':
      return value.text.length + 1; // 含前导 =
  }
}

// ---------------------------------------------------------------------------
// 冻结窗格
// ---------------------------------------------------------------------------

/**
 * 冻结窗格（0 表示该方向不冻结）。
 *
 * **委托** `sheet.ts` 的 `setFrozenPanes`——冻结状态是 `SheetState` 的一等字段，本模块不另存一份。
 * @throws {ValidationError}
 */
export function freezePanes(layout: SheetLayoutState, rows: number, columns: number): SheetLayoutState {
  return Object.freeze({ ...layout, sheet: setFrozenPanes(layout.sheet, rows, columns) });
}

// ---------------------------------------------------------------------------
// 合并 / 拆分
// ---------------------------------------------------------------------------

/** 区域的规范文本（与 `sheet.ts` 存储 `merged` 的口径一致：不带 `$`、单格无冒号）。 */
function rangeText(range: CellRange): string {
  const start = formatCellAddress({ column: range.start.column, row: range.start.row });
  const end = formatCellAddress({ column: range.end.column, row: range.end.row });
  return start === end ? start : `${start}:${end}`;
}

function rangesOverlap(a: CellRange, b: CellRange): boolean {
  return (
    a.start.column <= b.end.column &&
    a.end.column >= b.start.column &&
    a.start.row <= b.end.row &&
    a.end.row >= b.start.row
  );
}

/**
 * 合并一个区域（至少两格）。
 *
 * 语义照 Excel：**保留左上角取值，清掉区域内其余格**；与已有合并区**重叠即抛**（不悄悄改写
 * 既有合并结构）。合并文本按 `sheet.ts` 的规范化口径写入 `merged`。
 *
 * @throws {ValidationError}
 */
export function mergeCells(layout: SheetLayoutState, range: CellRange | string): SheetLayoutState {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  if (resolved.start.column === resolved.end.column && resolved.start.row === resolved.end.row) {
    throw new ValidationError('mergeCells：合并区域至少需要两格');
  }
  const text = rangeText(resolved);
  if (layout.sheet.merged.includes(text)) {
    throw new ValidationError(`mergeCells：区域 ${text} 已经合并过`);
  }
  for (const existing of layout.sheet.merged) {
    if (rangesOverlap(resolved, parseRange(existing))) {
      throw new ValidationError(`mergeCells：新合并区 ${text} 与已有合并区 ${existing} 重叠`);
    }
  }

  const topLeft = formatCellAddress({ column: resolved.start.column, row: resolved.start.row });
  const cells = new Map(layout.sheet.cells);
  for (const ref of [...cells.keys()]) {
    if (ref === topLeft) {
      continue;
    }
    const address = parseCellAddress(ref);
    if (
      address.column >= resolved.start.column &&
      address.column <= resolved.end.column &&
      address.row >= resolved.start.row &&
      address.row <= resolved.end.row
    ) {
      cells.delete(ref);
    }
  }
  return Object.freeze({
    ...layout,
    sheet: withSheet(layout.sheet, {
      cells,
      merged: Object.freeze([...layout.sheet.merged, text]),
    }),
  });
}

/** 拆散一个**恰好等于已有合并区**的区域；找不到 ⇒ 抛。@throws {ValidationError} */
export function unmergeCells(layout: SheetLayoutState, range: CellRange | string): SheetLayoutState {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  const text = rangeText(resolved);
  const index = layout.sheet.merged.indexOf(text);
  if (index < 0) {
    throw new ValidationError(`unmergeCells：区域 ${text} 不是已合并区`);
  }
  const merged = layout.sheet.merged.filter((_, position) => position !== index);
  return Object.freeze({
    ...layout,
    sheet: withSheet(layout.sheet, { merged: Object.freeze(merged) }),
  });
}

// ---------------------------------------------------------------------------
// 行列增删（值 / 公式委托 sheet.ts；几何用 reference.ts 的同款映射迁移）
// ---------------------------------------------------------------------------

/** 把一个轴上的位置交给 `reference.ts` 的映射；返回新位置，被删中则 `null`。 */
function mapPosition(
  position: number,
  axis: 'row' | 'column',
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): number | null {
  const reference = {
    column: axis === 'column' ? position : 1,
    row: axis === 'row' ? position : 1,
    abs_column: false,
    abs_row: false,
  };
  const mapped: ReferenceMapResult =
    axis === 'row'
      ? mode === 'insert'
        ? mapReferenceOnRowInsert(reference, at, count)
        : mapReferenceOnRowDelete(reference, at, count)
      : mode === 'insert'
        ? mapReferenceOnColumnInsert(reference, at, count)
        : mapReferenceOnColumnDelete(reference, at, count);
  if (!mapped.ok) {
    return null;
  }
  return axis === 'row' ? mapped.reference.row : mapped.reference.column;
}

function migrateSizes(
  sizes: ReadonlyMap<number, number>,
  axis: 'row' | 'column',
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): ReadonlyMap<number, number> {
  const next = new Map<number, number>();
  for (const [position, size] of sizes) {
    const mapped = mapPosition(position, axis, at, count, mode);
    if (mapped !== null) {
      next.set(mapped, size);
    }
  }
  return next;
}

function migrateHidden(
  list: readonly number[],
  axis: 'row' | 'column',
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): readonly number[] {
  const next: number[] = [];
  for (const position of list) {
    const mapped = mapPosition(position, axis, at, count, mode);
    if (mapped !== null) {
      next.push(mapped);
    }
  }
  return Object.freeze(next.sort((a, b) => a - b));
}

/** 在第 `at` 行前插入 `count` 行（值 / 公式 / 合并由 `sheet.ts` 迁移；几何同步迁移）。@throws {ValidationError} */
export function insertSheetRows(layout: SheetLayoutState, at: number, count: number): SheetLayoutState {
  const sheet = insertRows(layout.sheet, at, count);
  return Object.freeze({
    sheet,
    row_heights: migrateSizes(layout.row_heights, 'row', at, count, 'insert'),
    column_widths: layout.column_widths,
    hidden_rows: migrateHidden(layout.hidden_rows, 'row', at, count, 'insert'),
    hidden_columns: layout.hidden_columns,
  });
}

/** 从第 `at` 行起删除 `count` 行。@throws {ValidationError} */
export function deleteSheetRows(layout: SheetLayoutState, at: number, count: number): SheetLayoutState {
  const sheet = deleteRows(layout.sheet, at, count);
  return Object.freeze({
    sheet,
    row_heights: migrateSizes(layout.row_heights, 'row', at, count, 'delete'),
    column_widths: layout.column_widths,
    hidden_rows: migrateHidden(layout.hidden_rows, 'row', at, count, 'delete'),
    hidden_columns: layout.hidden_columns,
  });
}

/** 在第 `at` 列前插入 `count` 列。@throws {ValidationError} */
export function insertSheetColumns(layout: SheetLayoutState, at: number, count: number): SheetLayoutState {
  const sheet = insertColumns(layout.sheet, at, count);
  return Object.freeze({
    sheet,
    row_heights: layout.row_heights,
    column_widths: migrateSizes(layout.column_widths, 'column', at, count, 'insert'),
    hidden_rows: layout.hidden_rows,
    hidden_columns: migrateHidden(layout.hidden_columns, 'column', at, count, 'insert'),
  });
}

/** 从第 `at` 列起删除 `count` 列。@throws {ValidationError} */
export function deleteSheetColumns(layout: SheetLayoutState, at: number, count: number): SheetLayoutState {
  const sheet = deleteColumns(layout.sheet, at, count);
  return Object.freeze({
    sheet,
    row_heights: layout.row_heights,
    column_widths: migrateSizes(layout.column_widths, 'column', at, count, 'delete'),
    hidden_rows: layout.hidden_rows,
    hidden_columns: migrateHidden(layout.hidden_columns, 'column', at, count, 'delete'),
  });
}

// ---------------------------------------------------------------------------
// 行列复制 / 移动的几何版（值 / 公式由 sheet.ts 迁移；几何用**同一映射**迁移）
//
// 与上面的插删一致：几何跟着值走。复制同时把源区间的行高 / 列宽 / 隐藏状态抄一份到新位置；
// 移动则用 `sheet.ts` 导出的 {@link mapMovePosition} —— **同一个**位置映射，保证"值移了、
// 几何没移"这类静默错位不可能发生。
// ---------------------------------------------------------------------------

type PositionMapper = (position: number) => number | null;

function migrateSizesWith(sizes: ReadonlyMap<number, number>, mapper: PositionMapper): ReadonlyMap<number, number> {
  const next = new Map<number, number>();
  for (const [position, size] of sizes) {
    const mapped = mapper(position);
    if (mapped !== null) {
      next.set(mapped, size);
    }
  }
  return next;
}

function migrateHiddenWith(list: readonly number[], mapper: PositionMapper): readonly number[] {
  const next: number[] = [];
  for (const position of list) {
    const mapped = mapper(position);
    if (mapped !== null) {
      next.push(mapped);
    }
  }
  return Object.freeze(next.sort((a, b) => a - b));
}

function sortedNumbers(values: Iterable<number>): readonly number[] {
  return Object.freeze([...values].sort((a, b) => a - b));
}

/**
 * 复制一段行到 `insertAt` 之前（几何版）。源区间的行高 / 隐藏状态一并复制到新位置。
 * @throws {ValidationError}
 */
export function copySheetRows(
  layout: SheetLayoutState,
  at: number,
  count: number,
  insertAt: number,
): SheetLayoutState {
  const sheet = copyRows(layout.sheet, at, count, insertAt);
  // 与 copyRows 一致：插入点及之后的几何下移（用 insertAt，而非源起点 at）
  const insertMapper: PositionMapper = (position) => mapPosition(position, 'row', insertAt, count, 'insert');
  const rowHeights = new Map(migrateSizesWith(layout.row_heights, insertMapper));
  const hidden = new Set(migrateHiddenWith(layout.hidden_rows, insertMapper));
  for (let position = at; position <= at + count - 1; position += 1) {
    const height = layout.row_heights.get(position);
    if (height !== undefined) rowHeights.set(insertAt + (position - at), height);
    if (layout.hidden_rows.includes(position)) hidden.add(insertAt + (position - at));
  }
  return Object.freeze({
    sheet,
    row_heights: rowHeights,
    column_widths: layout.column_widths,
    hidden_rows: sortedNumbers(hidden),
    hidden_columns: layout.hidden_columns,
  });
}

/**
 * 复制一段列到 `insertAt` 之前（几何版）。源区间的列宽 / 隐藏状态一并复制到新位置。
 * @throws {ValidationError}
 */
export function copySheetColumns(
  layout: SheetLayoutState,
  at: number,
  count: number,
  insertAt: number,
): SheetLayoutState {
  const sheet = copyColumns(layout.sheet, at, count, insertAt);
  // 与 copyColumns 一致：插入点及之后的几何右移（用 insertAt，而非源起点 at）
  const insertMapper: PositionMapper = (position) => mapPosition(position, 'column', insertAt, count, 'insert');
  const columnWidths = new Map(migrateSizesWith(layout.column_widths, insertMapper));
  const hidden = new Set(migrateHiddenWith(layout.hidden_columns, insertMapper));
  for (let position = at; position <= at + count - 1; position += 1) {
    const width = layout.column_widths.get(position);
    if (width !== undefined) columnWidths.set(insertAt + (position - at), width);
    if (layout.hidden_columns.includes(position)) hidden.add(insertAt + (position - at));
  }
  return Object.freeze({
    sheet,
    row_heights: layout.row_heights,
    column_widths: columnWidths,
    hidden_rows: layout.hidden_rows,
    hidden_columns: sortedNumbers(hidden),
  });
}

/** 移动一段行到 row `to` 之前（几何版，几何用与值相同的映射迁移）。@throws {ValidationError} */
export function moveSheetRows(
  layout: SheetLayoutState,
  at: number,
  count: number,
  to: number,
): SheetLayoutState {
  const sheet = moveRows(layout.sheet, at, count, to);
  const mapper: PositionMapper = (position) => mapMovePosition(position, at, count, to);
  return Object.freeze({
    sheet,
    row_heights: migrateSizesWith(layout.row_heights, mapper),
    column_widths: layout.column_widths,
    hidden_rows: migrateHiddenWith(layout.hidden_rows, mapper),
    hidden_columns: layout.hidden_columns,
  });
}

/** 移动一段列到 column `to` 之前（几何版）。@throws {ValidationError} */
export function moveSheetColumns(
  layout: SheetLayoutState,
  at: number,
  count: number,
  to: number,
): SheetLayoutState {
  const sheet = moveColumns(layout.sheet, at, count, to);
  const mapper: PositionMapper = (position) => mapMovePosition(position, at, count, to);
  return Object.freeze({
    sheet,
    row_heights: layout.row_heights,
    column_widths: migrateSizesWith(layout.column_widths, mapper),
    hidden_rows: layout.hidden_rows,
    hidden_columns: migrateHiddenWith(layout.hidden_columns, mapper),
  });
}

// ---------------------------------------------------------------------------
// 单元格样式（CellStyles）随行列复制 / 移动迁移（X02 遗留项）
//
// `copyRows` / `moveRows` / `copyColumns` / `moveColumns` 迁移了值 / 公式 / 合并区，
// 上面的几何版又迁了行高 / 列宽 / 隐藏，但**逐格样式**（`styles.ts` 的 `CellStyles`：
// A1 地址 → `CellStyle`）此前只支持"插 / 删"（`styles.ts` 的 `migrateCellStyles`），
// 复制 / 移动会静默把样式留在原地——用户会看到"值到了第 4 行、加粗还留在第 2 行"。
//
// ## 复用同一套位置映射，不新造行号算术
//
// 本段把与 `copySheetRows` / `moveSheetRows` **完全相同**的映射作用在样式的 A1 地址上：
// - 复制：值 / 几何走 `insertAt` 的**插入语义**（插入点及之后下移），源区间的样式**再抄一份**
//   到 `insertAt + (position - at)`；本段用同一 `mapPosition(..., 'insert')` + 同一副本落点。
// - 移动：值 / 几何走 `sheet.ts` 导出的 {@link mapMovePosition}；本段用**同一个**纯函数。
//
// 因为三条路（值 / 几何 / 样式）共享同一映射，"值移了样式没移"这类静默错位在结构上不可能发生。
//
// ## 与 `style-parts/descriptor.ts` 的关系（只读）
//
// 样式判等的规范口径来自 `style-parts/descriptor.ts` 的 {@link styleKey}（对规范化描述符做
// 键序无关序列化）。本段**只读引用**它——{@link cellStyleKeys} 把一份样式表映射成
// "地址 → 描述符键"，供调用方按**渲染等价**（而不是对象同一性）比较两份样式表；
// 迁移本身逐字保留原样式对象，不做任何改写。
// ---------------------------------------------------------------------------

/** 样式地址映射：给出新 A1 地址，或 `null`（该样式随被删行列消失）。 */
type StyleAddressMapper = (address: CellAddress) => CellAddress | null;

function styleAxisPosition(address: CellAddress, axis: 'row' | 'column'): number {
  return axis === 'row' ? address.row : address.column;
}

function withStyleAxisPosition(address: CellAddress, axis: 'row' | 'column', position: number): CellAddress {
  return axis === 'row'
    ? { column: address.column, row: position }
    : { column: position, row: address.row };
}

/** 让每个样式地址经 `mapAddress` 迁移；映射返回 `null` 的样式被丢弃（对应格随行列消失）。 */
function migrateStyles(styles: CellStyles, mapAddress: StyleAddressMapper): Map<string, CellStyle> {
  const next = new Map<string, CellStyle>();
  for (const [ref, style] of styles) {
    const mapped = mapAddress(parseCellAddress(ref));
    if (mapped !== null) {
      next.set(formatCellAddress(mapped), style);
    }
  }
  return next;
}

function requireStyleCoords(at: number, count: number, where: string): void {
  if (!Number.isInteger(at) || at < 1) {
    throw new ValidationError(`${where} 的 at 必须是 ≥1 的整数，收到 ${String(at)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${where} 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
}

function copyStylesAxis(
  styles: CellStyles,
  axis: 'row' | 'column',
  at: number,
  count: number,
  insertAt: number,
  where: string,
): CellStyles {
  requireStyleCoords(at, count, where);
  if (!Number.isInteger(insertAt) || insertAt < 1) {
    throw new ValidationError(`${where} 的插入点必须是 ≥1 的整数，收到 ${String(insertAt)}`);
  }
  if (insertAt > at && insertAt < at + count) {
    throw new ValidationError(`${where}：插入点落在被复制区间内部，会与自身部分重叠，语义不明确，显式阻塞`);
  }
  // 搬移既有的样式：插入点及之后下移 / 右移（与 copySheetRows 的 insertMapper 同一映射）。
  const insertMapper: StyleAddressMapper = (address) => {
    const position = styleAxisPosition(address, axis);
    const mapped = mapPosition(position, axis, insertAt, count, 'insert');
    return mapped === null ? null : withStyleAxisPosition(address, axis, mapped);
  };
  const next = migrateStyles(styles, insertMapper);
  // 源区间的样式再抄一份到插入点（与 copySheetRows 的副本落点同一算式）。
  const last = at + count - 1;
  for (const [ref, style] of styles) {
    const address = parseCellAddress(ref);
    const position = styleAxisPosition(address, axis);
    if (position >= at && position <= last) {
      const copyRef = formatCellAddress(withStyleAxisPosition(address, axis, insertAt + (position - at)));
      next.set(copyRef, style);
    }
  }
  return next;
}

function moveStylesAxis(
  styles: CellStyles,
  axis: 'row' | 'column',
  at: number,
  count: number,
  to: number,
  where: string,
): CellStyles {
  requireStyleCoords(at, count, where);
  if (!Number.isInteger(to) || to < 1) {
    throw new ValidationError(`${where} 的目标位置必须是 ≥1 的整数，收到 ${String(to)}`);
  }
  if (to > at && to < at + count) {
    throw new ValidationError(`${where}：目标位置落在被移动区间内部，会与自身重叠，显式阻塞`);
  }
  // 与 moveSheetRows 的 mapper **同一个** `mapMovePosition`：样式跟着值分段迁移。
  const mapper: StyleAddressMapper = (address) =>
    withStyleAxisPosition(address, axis, mapMovePosition(styleAxisPosition(address, axis), at, count, to));
  return migrateStyles(styles, mapper);
}

/**
 * 复制 `[at, at+count-1]` 一段行的**样式**到 `insertAt` 之前（与 `copyRows` / `copySheetRows`
 * 共用同一映射：源保留、插入点及之后下移、副本落在 `insertAt`）。
 *
 * @throws {ValidationError} 坐标非法 / 插入点落在被复制区间内部
 */
export function copyCellStylesRows(
  styles: CellStyles,
  at: number,
  count: number,
  insertAt: number,
): CellStyles {
  return copyStylesAxis(styles, 'row', at, count, insertAt, 'copyCellStylesRows');
}

/** 复制一段列的样式，语义同 {@link copyCellStylesRows}。@throws {ValidationError} */
export function copyCellStylesColumns(
  styles: CellStyles,
  at: number,
  count: number,
  insertAt: number,
): CellStyles {
  return copyStylesAxis(styles, 'column', at, count, insertAt, 'copyCellStylesColumns');
}

/**
 * 把 `[at, at+count-1]` 一段行的**样式**移动到 row `to` 之前（与 `moveRows` / `moveSheetRows`
 * 共用同一 {@link mapMovePosition}：样式跟着值走，不会留在原地）。
 *
 * @throws {ValidationError} 坐标非法 / 目标落在被移动区间内部
 */
export function moveCellStylesRows(
  styles: CellStyles,
  at: number,
  count: number,
  to: number,
): CellStyles {
  return moveStylesAxis(styles, 'row', at, count, to, 'moveCellStylesRows');
}

/** 移动一段列的样式，语义同 {@link moveCellStylesRows}。@throws {ValidationError} */
export function moveCellStylesColumns(
  styles: CellStyles,
  at: number,
  count: number,
  to: number,
): CellStyles {
  return moveStylesAxis(styles, 'column', at, count, to, 'moveCellStylesColumns');
}

/**
 * 把一份样式表映射成「地址 → 描述符键」（只读引用 `style-parts/descriptor.ts` 的 {@link styleKey}）。
 *
 * 供调用方按**渲染等价**比较两份样式表：同一个视觉样式（哪怕字段书写顺序不同）得到同一个键，
 * 两个不同样式必然得到不同键。本函数不改样式、不产生副作用。
 */
export function cellStyleKeys(styles: CellStyles): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  for (const [ref, style] of styles) {
    keys.set(ref, styleKey(style));
  }
  return keys;
}
