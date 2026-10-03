/**
 * 表格域：结构化表格 / 标题行 / 汇总行 / 区域扩展与样式（design-06-P8 / XLS-10）。
 *
 * ## 结构化表格与"一块死区域"的区别
 *
 * 普通区域只有坐标；结构化表格有**身份**：表名 + 列名 + 标题行 + （可选）汇总行。
 * 身份带来的直接后果是**范围必须随结构变更迁移**：在表里插一行，表要长大；
 * 在表前插一列，表要整体右移；把整张表删掉，就必须**显式失败**而不是留下一个空壳。
 * 这正是 XLS-10 的验收句「区域 / 引用在插入删除后保持正确」。
 *
 * ## 迁移规则与 `sheet.ts` 同口径（**不猜测**）
 *
 * - 变更**完全在表外** ⇒ 平移或不动；
 * - 变更**完全落在数据体（标题行与汇总行之间）** ⇒ 表尾伸缩，把变更吞进表内（区域扩展）；
 * - 变更**部分重叠**（碰到标题行或汇总行，或只切掉半个表） ⇒ 抛 `ValidationError`。
 *   与 `sheet.ts` 处理"删除行列与合并区部分重叠"是同一套态度：**骨架不猜，显式阻塞**。
 *
 * ## OOXML
 *
 * `buildTableDefinitionXml` 产出可写进 `xl/tables/tableN.xml` 的 `<table>` 片段
 * （`el` / `attr` / `serializeXmlNode`，本文件不自己拼 XML 字符串）。
 */

import {
  attr,
  el,
  serializeXmlNode,
  type XmlAttribute,
  type XmlElement,
} from '../artifacts/ooxml/index.js';
import { SPREADSHEETML_NAMESPACE } from '../artifacts/templates/xlsx.js';
import { ValidationError } from '../protocol/index.js';
import {
  columnNumberToLetters,
  formatCellAddress,
  parseCellReference,
  parseRange,
  type CellAddress,
  type CellRange,
} from './reference.js';
import { deleteColumns, deleteRows, insertColumns, insertRows, type SheetState } from './sheet.js';

/** 汇总行的聚合函数（对应 OOXML `totalsRowFunction`）。 */
export type TableTotalsFunction =
  | 'sum'
  | 'average'
  | 'count'
  | 'counta'
  | 'min'
  | 'max'
  | 'stdDev'
  | 'var';

/**
 * `SUBTOTAL` 的函数号（1xx 形式 = 忽略隐藏行）。
 *
 * 汇总行用 `SUBTOTAL` 而非裸 `SUM`，是因为 Excel 的汇总行本身就这么写；写裸 `SUM` 会让
 * "筛选后合计"这类行为与真实 Excel 分叉。
 */
export const SUBTOTAL_FUNCTION_NUMBER: Readonly<Record<TableTotalsFunction, number>> = Object.freeze({
  average: 101,
  count: 102,
  counta: 103,
  max: 104,
  min: 105,
  stdDev: 107,
  sum: 109,
  var: 110,
});

/** 一列的定义。 */
export interface TableColumn {
  readonly name: string;
  /** 仅当表有汇总行时有意义。 */
  readonly totals_function?: TableTotalsFunction;
  /** 汇总标签（缺省 = 该列名）。 */
  readonly totals_label?: string;
}

/** 表样式（映射到 OOXML `tableStyleInfo`）。 */
export interface TableStyle {
  readonly name: string;
  readonly show_first_column?: boolean;
  readonly show_last_column?: boolean;
  readonly show_row_stripes?: boolean;
  readonly show_column_stripes?: boolean;
}

/** 默认样式（Excel 的 `TableStyleMedium2`，蓝白相间）。 */
export const DEFAULT_TABLE_STYLE: TableStyle = Object.freeze({ name: 'TableStyleMedium2' });

/** 结构化表格（不可变）。 */
export interface StructuredTable {
  readonly name: string;
  readonly display_name: string;
  /** 含标题行与汇总行的**整块**区域（A1 记法）。 */
  readonly range: string;
  readonly columns: readonly TableColumn[];
  readonly header_row_count: 1;
  readonly totals_row_count: 0 | 1;
  readonly style: TableStyle;
}

/** 创建输入。 */
export interface StructuredTableSpec {
  readonly name: string;
  readonly display_name?: string;
  readonly range: string;
  readonly columns: readonly (string | TableColumn)[];
  readonly totals_row?: boolean;
  readonly style?: TableStyle;
}

const TABLE_NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

/** 表名合法性：非空、≤255、以字母 / 下划线 / 汉字起头、不含空白、**不得长得像单元格引用**。 */
export function isValidTableName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (!TABLE_NAME_PATTERN.test(name)) return false;
  try {
    parseCellReference(name); // `A1` 这类名字在 Excel 里是被禁止的（会与引用歧义）
    return false;
  } catch {
    return true;
  }
}

function requireTableName(name: unknown, where: string): string {
  if (!isValidTableName(name)) {
    throw new ValidationError(
      `${where} 的表名非法（须非空、≤255、以字母/下划线/汉字起头、不含空白、不得形如单元格引用）：${JSON.stringify(name)}`,
    );
  }
  return name;
}

function normalizeColumn(input: string | TableColumn, index: number): TableColumn {
  const column: TableColumn = typeof input === 'string' ? { name: input } : input;
  if (typeof column.name !== 'string' || column.name.length === 0) {
    throw new ValidationError(`第 ${String(index + 1)} 列的列名不能为空`);
  }
  if (column.totals_function !== undefined && SUBTOTAL_FUNCTION_NUMBER[column.totals_function] === undefined) {
    throw new ValidationError(`列 ${JSON.stringify(column.name)} 的汇总函数未知：${String(column.totals_function)}`);
  }
  return Object.freeze({
    name: column.name,
    ...(column.totals_function === undefined ? {} : { totals_function: column.totals_function }),
    ...(column.totals_label === undefined ? {} : { totals_label: column.totals_label }),
  });
}

/** 两个**普通地址**之间的区域文本（无 `$`，单格输出 `"A1"`）。 */
function addressRangeText(start: CellAddress, end: CellAddress): string {
  const first = formatCellAddress(start);
  const last = formatCellAddress(end);
  return first === last ? first : `${first}:${last}`;
}

function rangeWidth(range: CellRange): number {
  return range.end.column - range.start.column + 1;
}

function rangeHeight(range: CellRange): number {
  return range.end.row - range.start.row + 1;
}

/** 创建一个结构化表格。@throws {ValidationError} 表名 / 区域 / 列定义非法 */
export function createStructuredTable(spec: StructuredTableSpec): StructuredTable {
  const name = requireTableName(spec.name, 'createStructuredTable');
  const displayName =
    spec.display_name === undefined ? name : requireTableName(spec.display_name, 'createStructuredTable');
  const range = parseRange(spec.range);
  const totalsRowCount: 0 | 1 = spec.totals_row === true ? 1 : 0;
  if (rangeHeight(range) < 1 + totalsRowCount) {
    throw new ValidationError(
      `表 ${name} 区域 ${spec.range} 至少要放下 1 行标题行${totalsRowCount === 1 ? '与 1 行汇总行' : ''}`,
    );
  }
  if (spec.columns.length === 0) {
    throw new ValidationError(`表 ${name} 至少要有一列`);
  }
  if (spec.columns.length !== rangeWidth(range)) {
    throw new ValidationError(
      `表 ${name} 的列数（${String(spec.columns.length)}）与区域宽度（${String(rangeWidth(range))}）不一致`,
    );
  }
  const columns = spec.columns.map(normalizeColumn);
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) {
      throw new ValidationError(`表 ${name} 的列名重复：${JSON.stringify(column.name)}`);
    }
    seen.add(column.name);
  }
  return Object.freeze({
    name,
    display_name: displayName,
    range: addressRangeText(range.start, range.end),
    columns: Object.freeze(columns),
    header_row_count: 1,
    totals_row_count: totalsRowCount,
    style: Object.freeze({ ...DEFAULT_TABLE_STYLE, ...(spec.style ?? {}) }),
  });
}

function tableRange(table: StructuredTable): CellRange {
  return parseRange(table.range);
}

function withTable(table: StructuredTable, patch: Partial<StructuredTable>): StructuredTable {
  return Object.freeze({ ...table, ...patch });
}

/** 数据体的行区间（含两端；不含标题行与汇总行）。 */
function bodyBounds(range: CellRange, totalsRowCount: 0 | 1): { readonly start: number; readonly end: number } {
  return { start: range.start.row + 1, end: range.end.row - totalsRowCount };
}

/** 标题行区域。 */
export function tableHeaderRange(table: StructuredTable): string {
  const range = tableRange(table);
  return addressRangeText({ column: range.start.column, row: range.start.row }, { column: range.end.column, row: range.start.row });
}

/** 数据体区域（标题行与汇总行之间）。 */
export function tableDataRange(table: StructuredTable): string {
  const range = tableRange(table);
  const body = bodyBounds(range, table.totals_row_count);
  return addressRangeText({ column: range.start.column, row: body.start }, { column: range.end.column, row: body.end });
}

/** 汇总行区域；无汇总行时返回 `null`。 */
export function tableTotalsRange(table: StructuredTable): string | null {
  if (table.totals_row_count === 0) return null;
  const range = tableRange(table);
  return addressRangeText({ column: range.start.column, row: range.end.row }, { column: range.end.column, row: range.end.row });
}

/** 列名 → 列位置（1 起下标 + 绝对列号）；不存在返回 `undefined`。 */
export function tableColumnPosition(
  table: StructuredTable,
  columnName: string,
): { readonly index: number; readonly column: number } | undefined {
  const index = table.columns.findIndex((column) => column.name === columnName);
  if (index < 0) return undefined;
  const range = tableRange(table);
  return { index: index + 1, column: range.start.column + index };
}

/** 结构化引用文本：`表名[列名]`。@throws {ValidationError} 列不存在 */
export function structuredReference(table: StructuredTable, columnName: string): string {
  if (tableColumnPosition(table, columnName) === undefined) {
    throw new ValidationError(`表 ${table.name} 没有列 ${JSON.stringify(columnName)}`);
  }
  return `${table.name}[${columnName}]`;
}

/**
 * 汇总行的公式表（`SUBTOTAL` + 结构化引用）。
 *
 * 没有 `totals_function` 的列只返回标签（不编造一个聚合）。
 * @throws {ValidationError} 表没有汇总行
 */
export function buildTotalsFormulas(
  table: StructuredTable,
): readonly { readonly column: string; readonly label: string; readonly formula: string | null }[] {
  if (table.totals_row_count === 0) {
    throw new ValidationError(`表 ${table.name} 没有汇总行，无法生成汇总公式`);
  }
  return Object.freeze(
    table.columns.map((column) => {
      const label = column.totals_label ?? column.name;
      if (column.totals_function === undefined) {
        return Object.freeze({ column: column.name, label, formula: null });
      }
      const code = SUBTOTAL_FUNCTION_NUMBER[column.totals_function];
      return Object.freeze({
        column: column.name,
        label,
        formula: `SUBTOTAL(${String(code)},${table.name}[${column.name}])`,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// 区域迁移（XLS-10）
// ---------------------------------------------------------------------------

/** 轴与模式。 */
export type TableAxis = 'row' | 'column';
export type TableMutationMode = 'insert' | 'delete';

function assertMutation(at: number, count: number, where: string): void {
  if (!Number.isInteger(at) || at < 1) {
    throw new ValidationError(`${where} 的 at 必须是 ≥1 的整数，收到 ${String(at)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${where} 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
}

function shifted(range: CellRange, axis: TableAxis, delta: number): CellRange {
  if (axis === 'row') {
    return {
      start: { ...range.start, row: range.start.row + delta },
      end: { ...range.end, row: range.end.row + delta },
    };
  }
  return {
    start: { ...range.start, column: range.start.column + delta },
    end: { ...range.end, column: range.end.column + delta },
  };
}

function extended(range: CellRange, axis: TableAxis, delta: number): CellRange {
  if (axis === 'row') {
    return { start: range.start, end: { ...range.end, row: range.end.row + delta } };
  }
  return { start: range.start, end: { ...range.end, column: range.end.column + delta } };
}

/**
 * 按行列增删迁移表的范围。
 *
 * 列轴的增删若**落在表内** ⇒ 抛（调用方应走 {@link insertTableColumns} / {@link deleteTableColumns}
 * 以同时维护列定义，否则列定义与范围会错位）。
 * @throws {ValidationError} 参数非法 / 变更与表部分重叠
 */
export function migrateTableRange(
  table: StructuredTable,
  axis: TableAxis,
  at: number,
  count: number,
  mode: TableMutationMode,
): StructuredTable {
  assertMutation(at, count, 'migrateTableRange');
  const range = tableRange(table);
  const start = axis === 'row' ? range.start.row : range.start.column;
  const end = axis === 'row' ? range.end.row : range.end.column;
  const lastAffected = at + count - 1;

  if (mode === 'insert') {
    if (at <= start) {
      return withTable(table, { range: addressRangeText(...endpoints(shifted(range, axis, count))) });
    }
    if (axis === 'column') {
      if (at > end) {
        return table; // 插在表右侧 ⇒ 表不动
      }
      throw new ValidationError(
        `在表 ${table.name} 的列区间内插入列必须走 insertTableColumns（否则列定义与范围会错位）`,
      );
    }
    const body = bodyBounds(range, table.totals_row_count);
    if (at >= body.start && at <= body.end + 1) {
      // 插入点落在数据体内（或紧贴数据体末尾）⇒ 表向下长大，把新行吞进数据体
      return withTable(table, { range: addressRangeText(...endpoints(extended(range, axis, count))) });
    }
    return table; // 落在汇总行之后 / 表后 ⇒ 表不动
  }

  if (start > lastAffected) {
    return withTable(table, { range: addressRangeText(...endpoints(shifted(range, axis, -count))) });
  }
  if (end < at) {
    return table; // 完全在表上方 ⇒ 表不动
  }
  if (axis === 'column') {
    if (at > end) {
      return table; // 删表右侧的列 ⇒ 表不动
    }
    throw new ValidationError(
      `删除表 ${table.name} 的列必须走 deleteTableColumns（否则列定义与范围会错位）`,
    );
  }
  const body = bodyBounds(range, table.totals_row_count);
  if (at >= body.start && lastAffected <= body.end) {
    return withTable(table, { range: addressRangeText(...endpoints(extended(range, axis, -count))) });
  }
  throw new ValidationError(
    `删除行触及表 ${table.name} 的标题行 / 汇总行：骨架不猜测，显式阻塞（XLS-10）`,
  );
}

/** 区域 → 两端普通地址（供 {@link addressRangeText} 使用）。 */
function endpoints(range: CellRange): [CellAddress, CellAddress] {
  return [{ column: range.start.column, row: range.start.row }, { column: range.end.column, row: range.end.row }];
}

// ---------------------------------------------------------------------------
// 列定义的增删（XLS-10）
// ---------------------------------------------------------------------------

/** 在列位置 `at`（绝对列号）前插入 `newColumns`。@throws {ValidationError} */
export function insertTableColumns(
  table: StructuredTable,
  at: number,
  newColumns: readonly (string | TableColumn)[],
): StructuredTable {
  const range = tableRange(table);
  if (!Number.isInteger(at) || at < range.start.column || at > range.end.column + 1) {
    throw new ValidationError(
      `insertTableColumns 的列 ${String(at)} 必须落在 [${String(range.start.column)}, ${String(range.end.column + 1)}] 内`,
    );
  }
  if (newColumns.length === 0) {
    throw new ValidationError('insertTableColumns 至少需要一列新列');
  }
  const normalized = newColumns.map(normalizeColumn);
  const offset = at - range.start.column;
  const columns = [...table.columns];
  columns.splice(offset, 0, ...normalized);
  const names = new Set<string>();
  for (const column of columns) {
    if (names.has(column.name)) {
      throw new ValidationError(`插入后列名重复：${JSON.stringify(column.name)}`);
    }
    names.add(column.name);
  }
  return withTable(table, {
    columns: Object.freeze(columns),
    range: addressRangeText(...endpoints(extended(range, 'column', normalized.length))),
  });
}

/** 从列位置 `at`（绝对列号）起删除 `count` 列（表头宽度收缩，左端保持）。@throws {ValidationError} */
export function deleteTableColumns(table: StructuredTable, at: number, count: number): StructuredTable {
  const range = tableRange(table);
  if (!Number.isInteger(at) || at < range.start.column || at > range.end.column) {
    throw new ValidationError(`deleteTableColumns 的列 ${String(at)} 不在表内`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`deleteTableColumns 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
  if (count >= table.columns.length) {
    throw new ValidationError(`表 ${table.name} 至少要保留一列`);
  }
  const offset = at - range.start.column;
  const columns = [...table.columns];
  columns.splice(offset, count);
  return withTable(table, {
    columns: Object.freeze(columns),
    range: addressRangeText(...endpoints(extended(range, 'column', -count))),
  });
}

// ---------------------------------------------------------------------------
// 与工作表联动（XLS-10）
// ---------------------------------------------------------------------------

/** 表 + 工作表一起迁移的结果。 */
export interface TableMutationResult {
  readonly sheet: SheetState;
  readonly table: StructuredTable;
}

/** 在表内插入行（表范围同步扩展）。@throws {ValidationError} */
export function insertTableRows(
  sheet: SheetState,
  table: StructuredTable,
  at: number,
  count: number,
): TableMutationResult {
  const nextTable = migrateTableRange(table, 'row', at, count, 'insert');
  return Object.freeze({ sheet: insertRows(sheet, at, count), table: nextTable });
}

/** 删除表内行（表范围同步收缩）。@throws {ValidationError} */
export function deleteTableRows(
  sheet: SheetState,
  table: StructuredTable,
  at: number,
  count: number,
): TableMutationResult {
  const nextTable = migrateTableRange(table, 'row', at, count, 'delete');
  return Object.freeze({ sheet: deleteRows(sheet, at, count), table: nextTable });
}

/** 在表前插入列（表整体右移；表内插列请走 {@link insertTableColumns}）。@throws {ValidationError} */
export function shiftTableForColumnInsert(
  sheet: SheetState,
  table: StructuredTable,
  at: number,
  count: number,
): TableMutationResult {
  const nextTable = migrateTableRange(table, 'column', at, count, 'insert');
  return Object.freeze({ sheet: insertColumns(sheet, at, count), table: nextTable });
}

/** 删除表前的列（表整体左移）。@throws {ValidationError} */
export function shiftTableForColumnDelete(
  sheet: SheetState,
  table: StructuredTable,
  at: number,
  count: number,
): TableMutationResult {
  const nextTable = migrateTableRange(table, 'column', at, count, 'delete');
  return Object.freeze({ sheet: deleteColumns(sheet, at, count), table: nextTable });
}

// ---------------------------------------------------------------------------
// OOXML：`xl/tables/tableN.xml`
// ---------------------------------------------------------------------------

function boolAttr(name: string, value: boolean | undefined): readonly XmlAttribute[] {
  if (value === undefined) return [];
  return [attr(name, value ? '1' : '0')];
}

/**
 * 产出可写进 `xl/tables/tableN.xml` 的 `<table>` 片段。
 *
 * `autoFilter` 的 `ref` 覆盖**标题行到最后一个数据行**（不含汇总行）——这是 Excel 的实际写法：
 * 汇总行不属于筛选范围。
 */
export function buildTableDefinitionXml(table: StructuredTable, tableId = 1): string {
  if (!Number.isInteger(tableId) || tableId < 1) {
    throw new ValidationError(`表的 id 必须是 ≥1 的整数，收到 ${String(tableId)}`);
  }
  const range = tableRange(table);
  const body = bodyBounds(range, table.totals_row_count);

  const columnElements = table.columns.map((column, index) => {
    const attributes: XmlAttribute[] = [attr('id', String(index + 1)), attr('name', column.name)];
    if (column.totals_function !== undefined) {
      attributes.push(attr('totalsRowFunction', column.totals_function));
    }
    if (column.totals_label !== undefined) {
      attributes.push(attr('totalsRowLabel', column.totals_label));
    }
    return el('tableColumn', attributes);
  });

  const style = table.style;
  const children: XmlElement[] = [
    el('autoFilter', [
      attr(
        'ref',
        addressRangeText(
          { column: range.start.column, row: range.start.row },
          { column: range.end.column, row: Math.max(body.end, range.start.row) },
        ),
      ),
    ]),
    el('tableColumns', [attr('count', String(table.columns.length))], columnElements),
    el('tableStyleInfo', [
      attr('name', style.name),
      ...boolAttr('showFirstColumn', style.show_first_column),
      ...boolAttr('showLastColumn', style.show_last_column),
      ...boolAttr('showRowStripes', style.show_row_stripes),
      ...boolAttr('showColumnStripes', style.show_column_stripes),
    ]),
  ];

  const tableElement = el(
    'table',
    [
      attr('xmlns', SPREADSHEETML_NAMESPACE),
      attr('id', String(tableId)),
      attr('name', table.name),
      attr('displayName', table.display_name),
      attr('ref', table.range),
      attr('headerRowCount', String(table.header_row_count)),
      attr('totalsRowCount', String(table.totals_row_count)),
    ],
    children,
  );
  return serializeXmlNode(tableElement);
}

/** 列字母（诊断 / 用例断言用）。@throws {ValidationError} 列不存在 */
export function tableColumnLetter(table: StructuredTable, columnName: string): string {
  const position = tableColumnPosition(table, columnName);
  if (position === undefined) {
    throw new ValidationError(`表 ${table.name} 没有列 ${JSON.stringify(columnName)}`);
  }
  return columnNumberToLetters(position.column);
}
