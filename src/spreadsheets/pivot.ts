/**
 * 表格域：数据透视 / 分组汇总（XLS-13；FA-XLS-OBJECTS 工作包）。
 *
 * ## 这个文件要证明的事
 *
 * XLS-13 的验收句是「数据透视/分组汇总的创建与更新、行列/值/筛选配置；
 * **读回真实结构与汇总值，不用普通静态表冒充可刷新的透视表**」。
 * 因此本模块**不往工作表里写一张算好的静态表**——那正是验收句禁止的做法。
 * 它产出的是 ECMA-376 里真正构成透视表的三个部件：
 *
 * | 部件 | 内容 | 读回证据 |
 * |---|---|---|
 * | `xl/pivotCache/pivotCacheDefinitionN.xml` | 缓存定义：来源工作表 + 区域、字段清单、共享项 | {@link readPivotTables} 读出 `source` / `cache_fields` |
 * | `xl/pivotCache/pivotCacheRecordsN.xml` | 缓存的**逐行记录**（从工作簿真实取值） | 读出 `record_count` |
 * | `xl/pivotTables/pivotTableN.xml` | 透视表本体：行/列/值/筛选字段、目标区域 | 读出 `row_fields` / `column_fields` / `data_fields` / `filter_fields` |
 *
 * 加上 `xl/workbook.xml` 的 `<pivotCaches>`（`cacheId` ↔ `r:id`）与三处关系，
 * 这个包里的透视表是**可刷新的**：Excel 打开后按缓存重算并渲染透视区，
 * 而不是显示一份写死的数字。
 *
 * ## 汇总值是**算出来的**，不是抄来的
 *
 * {@link computePivotAggregate} 在**工作簿模型**上真做分组聚合（按行字段 × 列字段组合分组，
 * 对值字段求 sum / count / average / min / max）。测试里会独立复算，因此
 * "值字段配的是什么口径、算出来是多少"是可审计的。
 * **缺失不当零**：某组里一个数值都没有时，该组的这个值字段**整体缺席**（不是 0）——
 * 唯一的例外是 `count`，它的定义就是"有几个非空数值"，所以 0 是一个真实结果。
 *
 * ## 未验证 / 边界（如实登记）
 *
 * - **透视区的单元格内容本模块不预填**：真实 Excel 打开时按缓存刷新生成透视区，
 *   `location/@ref` 给的是初始范围估计（由缓存字段的基数推出），Excel 刷新时会改写它。
 *   因此"真实 Excel 打开后透视区渲染正确"这一条**未验证**（本工作树无 Office / 无设备）。
 * - 每张透视表各带一份缓存（不复用同一份缓存给多张表）；共享缓存不在本增量范围内。
 */

import { ValidationError } from '../protocol/index.js';
import {
  attr,
  el,
  formatDecimal,
  serializeXmlDocument,
  serializeXmlNode,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
} from '../artifacts/ooxml/index.js';
import { readZip, type ReadZipArchive } from '../artifacts/ooxml/zip-read.js';
import {
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
} from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import {
  composeWorkbookPackage,
  workbookRelationshipId,
  type SpreadsheetPackageExtension,
  type SpreadsheetPackageResult,
} from './charts.js';
import { formatCellAddress, parseCellAddress, parseRange, type CellRange } from './reference.js';
import { setCellValue, type SheetState } from './sheet.js';
import { blank, isBlank, isNumericCell, numberValue, textValue, type CellValue } from './value.js';
import { getSheet, type WorkbookState } from './workbook.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 透视表部件内容类型。 */
export const XLSX_PIVOT_TABLE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml';

/** 透视缓存定义部件内容类型。 */
export const XLSX_PIVOT_CACHE_DEFINITION_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml';

/** 透视缓存记录部件内容类型。 */
export const XLSX_PIVOT_CACHE_RECORDS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml';

/** 关系类型：workbook → pivotCacheDefinition，以及 pivotTable → pivotCacheDefinition。 */
export const PIVOT_CACHE_DEFINITION_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition';

/** 关系类型：worksheet → pivotTable。 */
export const PIVOT_TABLE_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable';

/** 第 `index`（0 起）个透视表部件路径。 */
export function pivotTablePartPath(index: number): string {
  return `xl/pivotTables/pivotTable${String(index + 1)}.xml`;
}

/** 第 `index`（0 起）个缓存定义部件路径。 */
export function pivotCacheDefinitionPartPath(index: number): string {
  return `xl/pivotCache/pivotCacheDefinition${String(index + 1)}.xml`;
}

/** 第 `index`（0 起）个缓存记录部件路径。 */
export function pivotCacheRecordsPartPath(index: number): string {
  return `xl/pivotCache/pivotCacheRecords${String(index + 1)}.xml`;
}

/** 支持的汇总口径。 */
export type PivotSummary = 'sum' | 'count' | 'average' | 'min' | 'max';

const PIVOT_SUMMARIES: readonly PivotSummary[] = Object.freeze([
  'sum',
  'count',
  'average',
  'min',
  'max',
]);

/** 汇总口径的 `subtotal` 属性值（`sum` 是缺省，Excel 不写它）。 */
const SUBTOTAL_CODE: Readonly<Record<PivotSummary, string>> = Object.freeze({
  sum: 'sum',
  count: 'count',
  average: 'average',
  min: 'min',
  max: 'max',
});

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 透视来源：一张表的区域（**首行是标题行**）。 */
export interface PivotSource {
  readonly sheet: string;
  readonly range: string;
}

/** 值字段配置。 */
export interface PivotValueField {
  /** 来源标题行里的字段名。 */
  readonly field: string;
  readonly summarize_by: PivotSummary;
  /** 显示名；缺省 = `求和项:字段` 这种 Excel 惯例。 */
  readonly caption?: string;
}

/** 筛选（页）字段配置。 */
export interface PivotFilterField {
  readonly field: string;
  /** 允许保留的取值（按标题行文本比较）；缺省 = 该字段做成页字段但不过滤。 */
  readonly values?: readonly string[];
}

/** 透视表的落点（左上角单元格）。 */
export interface PivotDestination {
  readonly sheet: string;
  readonly cell: string;
}

/** 创建参数。 */
export interface PivotTableSpec {
  readonly name: string;
  readonly source: PivotSource;
  readonly destination: PivotDestination;
  readonly rows: readonly string[];
  readonly columns?: readonly string[];
  readonly values: readonly PivotValueField[];
  readonly filters?: readonly PivotFilterField[];
}

/** 透视表状态（不可变）。 */
export interface PivotState {
  readonly name: string;
  readonly source: PivotSource;
  readonly destination: PivotDestination;
  readonly rows: readonly string[];
  readonly columns: readonly string[];
  readonly values: readonly PivotValueField[];
  readonly filters: readonly PivotFilterField[];
}

/** 透视表集合（不可变）。 */
export interface PivotCollection {
  readonly pivots: readonly PivotState[];
}

/** 空集合。 */
export const EMPTY_PIVOT_COLLECTION: PivotCollection = Object.freeze({
  pivots: Object.freeze([] as PivotState[]),
});

/** 汇总结果的一格：行键 + 列键 + 各值字段的汇总结果。 */
export interface PivotSummaryCell {
  readonly row_key: readonly string[];
  readonly column_key: readonly string[];
  /** 值字段 caption（或字段名）→ 汇总值；**某组算不出结果时该键整体缺席，不是 0**。 */
  readonly values: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// 取值辅助
// ---------------------------------------------------------------------------

/** 单元格 → 显示文本（标题比较、行键、筛选都用它）。空值 → `''`。 */
function cellText(value: CellValue): string {
  switch (value.kind) {
    case 'text':
      return value.value;
    case 'number':
      return numberText(value.value);
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE';
    case 'date':
      return String(value.epoch_ms);
    case 'error':
      return value.code;
    case 'formula':
      return value.text;
    case 'blank':
      return '';
    default: {
      const never: never = value;
      throw new ValidationError(`未覆盖的取值：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 数值 → XML 文本（与 `xlsx-write.ts` 的 `numberToXmlText` 同口径）。
 * 该函数未导出，本工作包又不许改既有文件，故此处重复一份**行为相同**的实现：
 * `String()` 给最短可往返十进制；指数记法交给 `formatDecimal`（BigInt 进位）展开。
 */
function numberText(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) {
    return text;
  }
  const expanded = formatDecimal(value, 20);
  const dot = expanded.indexOf('.');
  if (dot === -1) {
    return expanded;
  }
  const trimmed = expanded.slice(0, dot) + expanded.slice(dot).replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/** 单元格数值（非数值 / 空白 → `null`，**绝不返回 0**）。 */
function cellNumber(value: CellValue): number | null {
  return isNumericCell(value) ? value.value : null;
}

function requireNonEmpty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${where} 不能是空字符串`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 来源解析（从工作簿里真读标题行与逐行记录）
// ---------------------------------------------------------------------------

interface SourceTable {
  readonly range: CellRange;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

function cellAt(sheet: SheetState, column: number, row: number): CellValue {
  return sheet.cells.get(formatCellAddress({ column, row })) ?? blank;
}

/** 解析来源区域：首行当标题、其余当记录。表必须存在、区域在范围内、至少有标题 + 1 行数据。 */
function parseSourceTable(workbook: WorkbookState, source: PivotSource, where: string): SourceTable {
  const sheetName = requireNonEmpty(source.sheet, `${where}.sheet`);
  const sheet = getSheet(workbook, sheetName);
  if (sheet === undefined) {
    throw new ValidationError(`${where} 引用了工作簿里不存在的工作表 ${JSON.stringify(sheetName)}`);
  }
  const range = parseRange(requireNonEmpty(source.range, `${where}.range`));
  if (range.end.row > sheet.row_count || range.end.column > sheet.column_count) {
    throw new ValidationError(
      `${where} 的区域 ${JSON.stringify(source.range)} 超出工作表 ${JSON.stringify(sheetName)} 的声明范围`,
    );
  }
  if (range.start.row === range.end.row) {
    throw new ValidationError(
      `${where} 的区域只有一行：透视来源需要**标题行 + 至少一行数据**，否则没有可汇总的记录`,
    );
  }

  const headers: string[] = [];
  for (let column = range.start.column; column <= range.end.column; column += 1) {
    const text = cellText(cellAt(sheet, column, range.start.row));
    headers.push(text.length === 0 ? `列${String(column - range.start.column + 1)}` : text);
  }
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) {
      throw new ValidationError(
        `${where} 的标题行有重复字段名 ${JSON.stringify(header)}：字段名是透视配置的身份，必须唯一`,
      );
    }
    seen.add(header);
  }

  const rows: CellValue[][] = [];
  for (let row = range.start.row + 1; row <= range.end.row; row += 1) {
    const values: CellValue[] = [];
    for (let column = range.start.column; column <= range.end.column; column += 1) {
      values.push(cellAt(sheet, column, row));
    }
    rows.push(values);
  }
  return Object.freeze({
    range,
    headers: Object.freeze(headers),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

function fieldIndex(headers: readonly string[], field: string, where: string): number {
  const index = headers.indexOf(field);
  if (index < 0) {
    throw new ValidationError(
      `${where} 的字段 ${JSON.stringify(field)} 不在来源标题行里（可用字段：${headers.join(' / ')}）`,
    );
  }
  return index;
}

// ---------------------------------------------------------------------------
// 校验 / 归一化
// ---------------------------------------------------------------------------

function normalizeSource(workbook: WorkbookState, source: PivotSource, where: string): PivotSource {
  const table = parseSourceTable(workbook, source, where);
  const start = formatCellAddress({ column: table.range.start.column, row: table.range.start.row });
  const end = formatCellAddress({ column: table.range.end.column, row: table.range.end.row });
  return Object.freeze({ sheet: source.sheet, range: `${start}:${end}` });
}

function normalizeDestination(
  workbook: WorkbookState,
  destination: PivotDestination,
  where: string,
): PivotDestination {
  const sheetName = requireNonEmpty(destination.sheet, `${where}.sheet`);
  const sheet = getSheet(workbook, sheetName);
  if (sheet === undefined) {
    throw new ValidationError(`${where} 指向的工作表 ${JSON.stringify(sheetName)} 不存在`);
  }
  const address = parseCellAddress(requireNonEmpty(destination.cell, `${where}.cell`));
  if (address.column > sheet.column_count || address.row > sheet.row_count) {
    throw new ValidationError(
      `${where} 的落点 ${JSON.stringify(destination.cell)} 超出工作表 ${JSON.stringify(sheetName)} 的声明范围`,
    );
  }
  return Object.freeze({ sheet: sheetName, cell: formatCellAddress(address) });
}

function normalizeValues(
  headers: readonly string[],
  values: readonly PivotValueField[],
  where: string,
): readonly PivotValueField[] {
  if (values.length === 0) {
    throw new ValidationError(`${where}.values 不能为空：透视表至少需要一个值字段`);
  }
  return Object.freeze(
    values.map((value, index) => {
      const at = `${where}.values[${String(index)}]`;
      fieldIndex(headers, requireNonEmpty(value.field, `${at}.field`), where);
      if (!PIVOT_SUMMARIES.includes(value.summarize_by)) {
        throw new ValidationError(
          `${at}.summarize_by 未知：${JSON.stringify(value.summarize_by)}（支持 ${PIVOT_SUMMARIES.join(' / ')}）`,
        );
      }
      if (value.caption !== undefined) {
        requireNonEmpty(value.caption, `${at}.caption`);
      }
      return Object.freeze({
        field: value.field,
        summarize_by: value.summarize_by,
        ...(value.caption === undefined ? {} : { caption: value.caption }),
      });
    }),
  );
}

function normalizeFieldList(
  headers: readonly string[],
  fields: readonly string[],
  where: string,
): readonly string[] {
  const seen = new Set<string>();
  return Object.freeze(
    fields.map((field, index) => {
      fieldIndex(headers, requireNonEmpty(field, `${where}[${String(index)}]`), where);
      if (seen.has(field)) {
        throw new ValidationError(`${where} 里字段 ${JSON.stringify(field)} 出现了两次`);
      }
      seen.add(field);
      return field;
    }),
  );
}

function normalizeFilters(
  headers: readonly string[],
  filters: readonly PivotFilterField[],
  where: string,
  used: ReadonlySet<string>,
): readonly PivotFilterField[] {
  const taken = new Set(used);
  return Object.freeze(
    filters.map((filter, index) => {
      const at = `${where}[${String(index)}]`;
      const field = requireNonEmpty(filter.field, `${at}.field`);
      fieldIndex(headers, field, where);
      if (taken.has(field)) {
        throw new ValidationError(
          `${at} 的字段 ${JSON.stringify(field)} 已经用作行/列字段：一个字段不能同时出现在两个维度`,
        );
      }
      taken.add(field);
      return Object.freeze({
        field,
        ...(filter.values === undefined ? {} : { values: Object.freeze([...filter.values]) }),
      });
    }),
  );
}

/** 一次性校验并归一化整张透视表。@throws {ValidationError} */
function normalizePivot(workbook: WorkbookState, spec: PivotTableSpec): PivotState {
  const name = requireNonEmpty(spec.name, 'pivot.name');
  const source = normalizeSource(workbook, spec.source, 'pivot.source');
  const table = parseSourceTable(workbook, source, 'pivot.source');
  const destination = normalizeDestination(workbook, spec.destination, 'pivot.destination');
  const rows = normalizeFieldList(table.headers, spec.rows, 'pivot.rows');
  const columns = normalizeFieldList(table.headers, spec.columns ?? [], 'pivot.columns');
  const overlap = rows.filter((field) => columns.includes(field));
  if (overlap.length > 0) {
    throw new ValidationError(
      `字段 ${overlap.join(' / ')} 同时做了行字段与列字段：一个字段只能占一个维度`,
    );
  }
  const values = normalizeValues(table.headers, spec.values, 'pivot');
  const filters = normalizeFilters(
    table.headers,
    spec.filters ?? [],
    'pivot.filters',
    new Set([...rows, ...columns]),
  );
  return Object.freeze({ name, source, destination, rows, columns, values, filters });
}

// ---------------------------------------------------------------------------
// 操作（全部不可变）
// ---------------------------------------------------------------------------

/** 创建一张透视表；配置当场校验。@throws {ValidationError} */
export function createPivotTable(workbook: WorkbookState, spec: PivotTableSpec): PivotState {
  return normalizePivot(workbook, spec);
}

/** 重命名。@throws {ValidationError} */
export function renamePivotTable(pivot: PivotState, name: string): PivotState {
  return Object.freeze({ ...pivot, name: requireNonEmpty(name, 'pivot.name') });
}

/** 换来源（字段配置按新来源重新校验）。@throws {ValidationError} */
export function setPivotSource(
  workbook: WorkbookState,
  pivot: PivotState,
  source: PivotSource,
): PivotState {
  return normalizePivot(workbook, { ...pivot, source });
}

/** 改落点。@throws {ValidationError} */
export function setPivotDestination(
  workbook: WorkbookState,
  pivot: PivotState,
  destination: PivotDestination,
): PivotState {
  return Object.freeze({
    ...pivot,
    destination: normalizeDestination(workbook, destination, 'pivot.destination'),
  });
}

/** 改行列值筛选配置（局部更新：未给的维度保持原样）。@throws {ValidationError} */
export function setPivotLayout(
  workbook: WorkbookState,
  pivot: PivotState,
  patch: {
    readonly rows?: readonly string[];
    readonly columns?: readonly string[];
    readonly values?: readonly PivotValueField[];
    readonly filters?: readonly PivotFilterField[];
  },
): PivotState {
  return normalizePivot(workbook, {
    name: pivot.name,
    source: pivot.source,
    destination: pivot.destination,
    rows: patch.rows ?? pivot.rows,
    columns: patch.columns ?? pivot.columns,
    values: patch.values ?? pivot.values,
    filters: patch.filters ?? pivot.filters,
  });
}

/** 查透视表；不存在返回 `undefined`。 */
export function findPivotTable(collection: PivotCollection, name: string): PivotState | undefined {
  return collection.pivots.find((pivot) => pivot.name === name);
}

/** 追加（重名 ⇒ 抛）。@throws {ValidationError} */
export function addPivotTable(collection: PivotCollection, pivot: PivotState): PivotCollection {
  if (findPivotTable(collection, pivot.name) !== undefined) {
    throw new ValidationError(`addPivotTable 拒绝重名：已有透视表 ${JSON.stringify(pivot.name)}`);
  }
  return Object.freeze({ pivots: Object.freeze([...collection.pivots, pivot]) });
}

/** 替换同名透视表；不存在 ⇒ 抛。@throws {ValidationError} */
export function replacePivotTable(collection: PivotCollection, pivot: PivotState): PivotCollection {
  if (findPivotTable(collection, pivot.name) === undefined) {
    throw new ValidationError(`replacePivotTable：没有透视表 ${JSON.stringify(pivot.name)}`);
  }
  return Object.freeze({
    pivots: Object.freeze(collection.pivots.map((item) => (item.name === pivot.name ? pivot : item))),
  });
}

/** 删除；不存在 ⇒ 抛（不静默成功）。@throws {ValidationError} */
export function deletePivotTable(collection: PivotCollection, name: string): PivotCollection {
  if (findPivotTable(collection, name) === undefined) {
    throw new ValidationError(`deletePivotTable：没有透视表 ${JSON.stringify(name)}`);
  }
  return Object.freeze({
    pivots: Object.freeze(collection.pivots.filter((pivot) => pivot.name !== name)),
  });
}

// ---------------------------------------------------------------------------
// 汇总（在**工作簿模型**上真算）
// ---------------------------------------------------------------------------

function summarize(summary: PivotSummary, numbers: readonly number[]): number | null {
  if (summary === 'count') {
    return numbers.length;
  }
  if (numbers.length === 0) {
    return null; // 一个数都没有 ⇒ 这组没有结果（**不是 0**）
  }
  const first = numbers[0] as number;
  switch (summary) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0);
    case 'average':
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case 'min':
      return numbers.reduce((lowest, value) => Math.min(lowest, value), first);
    case 'max':
      return numbers.reduce((highest, value) => Math.max(highest, value), first);
    default: {
      const never: never = summary;
      throw new ValidationError(`未覆盖的汇总口径：${String(never)}`);
    }
  }
}

interface Bucket {
  readonly row_key: readonly string[];
  readonly column_key: readonly string[];
  readonly numbers: number[][];
}

/**
 * 按行字段 × 列字段分组，对每个值字段求指定口径的汇总。
 *
 * 顺序 = 首次出现的顺序（先按行键、再按列键），因此结果确定、可独立复算。
 * **缺失不当零**：某组用于该口径的数值集合为空时（`sum` 也如此），该组该字段**不在结果里**；
 * `count` 例外——它的定义就是"有几个非空数值"。
 *
 * @throws {ValidationError} 来源解析不了（表 / 区域 / 标题重复 / 字段不存在）
 */
export function computePivotAggregate(
  workbook: WorkbookState,
  pivot: PivotState,
): readonly PivotSummaryCell[] {
  const table = parseSourceTable(workbook, pivot.source, 'pivot.source');
  const rowIndexes = pivot.rows.map((field) => fieldIndex(table.headers, field, 'pivot.rows'));
  const columnIndexes = pivot.columns.map((field) =>
    fieldIndex(table.headers, field, 'pivot.columns'),
  );
  const valueIndexes = pivot.values.map((value) =>
    fieldIndex(table.headers, value.field, 'pivot.values'),
  );
  const filterIndexes = pivot.filters.map((filter) => ({
    index: fieldIndex(table.headers, filter.field, 'pivot.filters'),
    allowed: filter.values === undefined ? null : new Set(filter.values),
  }));

  const order: string[] = [];
  const buckets = new Map<string, Bucket>();
  const keyOf = (rowKey: readonly string[], columnKey: readonly string[]): string =>
    `${rowKey.join('\u0000')}\u0001${columnKey.join('\u0000')}`;

  for (const row of table.rows) {
    if (
      filterIndexes.some(
        (filter) =>
          filter.allowed !== null && !filter.allowed.has(cellText(row[filter.index] ?? blank)),
      )
    ) {
      continue;
    }
    const rowKey = rowIndexes.map((index) => cellText(row[index] ?? blank));
    const columnKey = columnIndexes.map((index) => cellText(row[index] ?? blank));
    const key = keyOf(rowKey, columnKey);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = Object.freeze({ row_key: rowKey, column_key: columnKey, numbers: valueIndexes.map(() => []) });
      buckets.set(key, bucket);
      order.push(key);
    }
    valueIndexes.forEach((index, position) => {
      const number = cellNumber(row[index] ?? blank);
      if (number !== null) {
        bucket.numbers[position]?.push(number);
      }
    });
  }

  return Object.freeze(
    order.map((key) => {
      const bucket = buckets.get(key) as Bucket;
      const values: Record<string, number> = {};
      pivot.values.forEach((value, position) => {
        const result = summarize(value.summarize_by, bucket.numbers[position] ?? []);
        if (result !== null) {
          // 键用**写进文件的显示名**（`求和项:金额`），这样聚合结果与部件里的 dataField 一一对得上
          values[pivotValueCaption(value)] = result;
        }
      });
      return Object.freeze({
        row_key: Object.freeze([...bucket.row_key]),
        column_key: Object.freeze([...bucket.column_key]),
        values: Object.freeze(values),
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// XML：缓存定义 / 缓存记录 / 透视表本体
// ---------------------------------------------------------------------------

interface CacheField {
  readonly name: string;
  /** 是否走共享项（含非数值 ⇒ 共享）。 */
  readonly shared: boolean;
  readonly shared_values: readonly string[];
  readonly contains_blank: boolean;
  readonly min: number | null;
  readonly max: number | null;
}

function buildCacheFields(table: SourceTable): readonly CacheField[] {
  return Object.freeze(
    table.headers.map((name, index) => {
      const values = table.rows.map((row) => row[index] ?? blank);
      const numbers = values
        .map(cellNumber)
        .filter((value): value is number => value !== null);
      const nonBlank = values.filter((value) => !isBlank(value)).length;
      const shared = numbers.length < nonBlank;
      const sharedValues: string[] = [];
      if (shared) {
        for (const value of values) {
          if (isBlank(value)) continue;
          const text = cellText(value);
          if (!sharedValues.includes(text)) sharedValues.push(text);
        }
      }
      return Object.freeze({
        name,
        shared,
        shared_values: Object.freeze(sharedValues),
        contains_blank: values.some((value) => isBlank(value)),
        min: numbers.length === 0 ? null : Math.min(...numbers),
        max: numbers.length === 0 ? null : Math.max(...numbers),
      });
    }),
  );
}

function sharedItemsElement(field: CacheField): XmlElement {
  if (!field.shared) {
    const attributes: XmlAttribute[] = [
      attr('containsSemiMixedTypes', '0'),
      attr('containsString', '0'),
      attr('containsNumber', '1'),
      attr(
        'containsInteger',
        field.min !== null && Number.isInteger(field.min) && Number.isInteger(field.max) ? '1' : '0',
      ),
    ];
    if (field.min !== null) attributes.push(attr('minValue', numberText(field.min)));
    if (field.max !== null) attributes.push(attr('maxValue', numberText(field.max)));
    if (field.contains_blank) attributes.push(attr('containsBlank', '1'));
    return el('sharedItems', attributes);
  }
  const attributes: XmlAttribute[] = [attr('count', String(field.shared_values.length))];
  if (field.contains_blank) attributes.push(attr('containsBlank', '1'));
  return el(
    'sharedItems',
    attributes,
    field.shared_values.map((value) => el('s', [attr('v', value)])),
  );
}

function rangeTextOf(range: CellRange): string {
  return `${formatCellAddress({ column: range.start.column, row: range.start.row })}:${formatCellAddress({ column: range.end.column, row: range.end.row })}`;
}

/** 生成 `xl/pivotCache/pivotCacheDefinitionN.xml`。 */
export function buildPivotCacheDefinitionXml(pivot: PivotState, table: SourceTable): string {
  const fields = buildCacheFields(table);
  const definition = el(
    'pivotCacheDefinition',
    [
      attr('xmlns', SPREADSHEETML_NAMESPACE),
      attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE),
      // 指向自己的缓存记录部件：该部件自己的关系只有这一条 ⇒ rId1
      attr('r:id', 'rId1'),
      attr('refreshOnLoad', '1'),
      attr('recordCount', String(table.rows.length)),
      attr('createdVersion', '8'),
      attr('refreshedVersion', '8'),
      attr('minRefreshableVersion', '3'),
    ],
    [
      el('cacheSource', [attr('type', 'worksheet')], [
        el('worksheetSource', [
          attr('ref', rangeTextOf(table.range)),
          attr('sheet', pivot.source.sheet),
        ]),
      ]),
      el(
        'cacheFields',
        [attr('count', String(fields.length))],
        fields.map((field) =>
          el('cacheField', [attr('name', field.name), attr('numFmtId', '0')], [sharedItemsElement(field)]),
        ),
      ),
    ],
  );
  return serializeXmlDocument(definition);
}

/** 生成 `xl/pivotCache/pivotCacheRecordsN.xml`（逐行真实记录）。 */
export function buildPivotCacheRecordsXml(table: SourceTable): string {
  const fields = buildCacheFields(table);
  const records = table.rows.map((row) =>
    el(
      'r',
      [],
      fields.map((field, index) => {
        const value = row[index] ?? blank;
        if (isBlank(value)) {
          return el('m', []); // 缺失 ⇒ `<m/>`，**不是 0**
        }
        if (!field.shared) {
          const number = cellNumber(value);
          return number === null ? el('m', []) : el('n', [attr('v', numberText(number))]);
        }
        return el('x', [attr('v', String(field.shared_values.indexOf(cellText(value))))]);
      }),
    ),
  );
  return serializeXmlDocument(
    el(
      'pivotCacheRecords',
      [
        attr('xmlns', SPREADSHEETML_NAMESPACE),
        attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE),
        attr('count', String(records.length)),
      ],
      records,
    ),
  );
}

/** 值字段的显示名（Excel 惯例：`求和项:金额`）。 */
export function pivotValueCaption(value: PivotValueField): string {
  if (value.caption !== undefined) return value.caption;
  const prefix: Readonly<Record<PivotSummary, string>> = {
    sum: '求和项',
    count: '计数项',
    average: '平均值项',
    min: '最小值项',
    max: '最大值项',
  };
  return `${prefix[value.summarize_by]}:${value.field}`;
}

/**
 * 生成 `xl/pivotTables/pivotTableN.xml`。
 *
 * `cacheId` 与工作簿 `<pivotCaches>` 里的 id 一致。`location/@ref` 是**初始范围的估计**
 * （由行字段的取值基数推出），真实 Excel 刷新时会改写它——这一点在文件头已登记。
 */
export function buildPivotTableXml(pivot: PivotState, table: SourceTable, cacheId: number): string {
  const headers = table.headers;
  const rowIndexes = pivot.rows.map((field) => fieldIndex(headers, field, 'pivot.rows'));
  const columnIndexes = pivot.columns.map((field) => fieldIndex(headers, field, 'pivot.columns'));
  const valueIndexes = pivot.values.map((value) => fieldIndex(headers, value.field, 'pivot.values'));
  const filterIndexes = pivot.filters.map((filter) => fieldIndex(headers, filter.field, 'pivot.filters'));

  const distinct = (index: number): readonly string[] => {
    const values: string[] = [];
    for (const row of table.rows) {
      const text = cellText(row[index] ?? blank);
      if (!values.includes(text)) values.push(text);
    }
    return values;
  };

  const pivotFields = headers.map((_name, index) => {
    const attributes: XmlAttribute[] = [];
    let items: XmlNode[] = [];
    if (rowIndexes.includes(index)) {
      attributes.push(attr('axis', 'axisRow'), attr('showAll', '0'));
    } else if (columnIndexes.includes(index)) {
      attributes.push(attr('axis', 'axisCol'), attr('showAll', '0'));
    } else if (filterIndexes.includes(index)) {
      attributes.push(attr('axis', 'axisPage'), attr('showAll', '0'));
    } else if (valueIndexes.includes(index)) {
      attributes.push(attr('dataField', '1'), attr('showAll', '0'));
    } else {
      attributes.push(attr('showAll', '0'));
    }
    if (rowIndexes.includes(index) || columnIndexes.includes(index) || filterIndexes.includes(index)) {
      const values = distinct(index);
      attributes.push(attr('compact', '0'), attr('outline', '0'), attr('subtotalTop', '1'));
      items = [
        el(
          'items',
          [attr('count', String(values.length))],
          values.map((_value, at) => el('item', [attr('x', String(at))])),
        ),
      ];
    }
    return el('pivotField', attributes, items);
  });

  const destination = parseCellAddress(pivot.destination.cell);
  const rowCardinality = rowIndexes.length === 0 ? 0 : distinct(rowIndexes[0] as number).length;
  const locationEnd = formatCellAddress({
    column: destination.column + Math.max(1, pivot.rows.length + pivot.values.length),
    row: destination.row + Math.max(1, rowCardinality + 2),
  });

  const children: XmlNode[] = [
    el('location', [
      attr('ref', `${pivot.destination.cell}:${locationEnd}`),
      attr('firstHeaderRow', '1'),
      attr('firstDataRow', '1'),
      attr('firstDataCol', String(Math.max(1, pivot.rows.length))),
    ]),
    el('pivotFields', [attr('count', String(pivotFields.length))], pivotFields),
  ];
  if (pivot.rows.length > 0) {
    children.push(
      el(
        'rowFields',
        [attr('count', String(rowIndexes.length))],
        rowIndexes.map((index) => el('field', [attr('x', String(index))])),
      ),
      el('rowItems', [attr('count', '1')], [el('i', [], [el('x', [])])]),
    );
  }
  if (pivot.columns.length > 0) {
    children.push(
      el(
        'colFields',
        [attr('count', String(columnIndexes.length))],
        columnIndexes.map((index) => el('field', [attr('x', String(index))])),
      ),
      el('colItems', [attr('count', '1')], [el('i', [], [el('x', [])])]),
    );
  }
  if (pivot.filters.length > 0) {
    children.push(
      el(
        'pageFields',
        [attr('count', String(filterIndexes.length))],
        filterIndexes.map((index) => el('pageField', [attr('fld', String(index)), attr('hier', '-1')])),
      ),
    );
  }
  children.push(
    el(
      'dataFields',
      [attr('count', String(pivot.values.length))],
      pivot.values.map((value, at) => {
        const attributes: XmlAttribute[] = [
          attr('name', pivotValueCaption(value)),
          attr('fld', String(valueIndexes[at] ?? 0)),
          attr('baseField', '0'),
          attr('baseItem', '0'),
        ];
        if (value.summarize_by !== 'sum') {
          attributes.push(attr('subtotal', SUBTOTAL_CODE[value.summarize_by]));
        }
        return el('dataField', attributes);
      }),
    ),
    el('pivotTableStyleInfo', [
      attr('name', 'PivotStyleLight16'),
      attr('showRowHeaders', '1'),
      attr('showColHeaders', '1'),
      attr('showRowStripes', '0'),
      attr('showColStripes', '0'),
      attr('showLastColumn', '1'),
    ]),
  );

  const definition = el(
    'pivotTableDefinition',
    [
      attr('xmlns', SPREADSHEETML_NAMESPACE),
      attr('name', pivot.name),
      attr('cacheId', String(cacheId)),
      attr('dataCaption', '值'),
      attr('applyNumberFormats', '0'),
      attr('applyBorderFormats', '0'),
      attr('applyFontFormats', '0'),
      attr('applyPatternFormats', '0'),
      attr('applyAlignmentFormats', '0'),
      attr('applyWidthHeightFormats', '1'),
      attr('updatedVersion', '8'),
      attr('minRefreshableVersion', '3'),
      attr('useAutoFormatting', '1'),
      attr('itemPrintTitles', '1'),
      attr('createdVersion', '8'),
      attr('indent', '0'),
      attr('outline', '1'),
      attr('outlineData', '1'),
      attr('multipleFieldFilters', '0'),
    ],
    children,
  );
  return serializeXmlDocument(definition);
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function worksheetPathOf(workbook: WorkbookState, sheetName: string): string {
  const index = workbook.sheets.findIndex((sheet) => sheet.name === sheetName);
  /* c8 ignore next -- normalizePivot 已保证表存在 */
  if (index < 0) {
    throw new ValidationError(`工作簿里没有工作表 ${JSON.stringify(sheetName)}`);
  }
  return `xl/worksheets/sheet${String(index + 1)}.xml`;
}

/** 透视集合 → 包扩展（部件 + 三处关系 + 工作簿 `<pivotCaches>` 追加）。 */
function pivotExtension(
  workbook: WorkbookState,
  collection: PivotCollection,
): SpreadsheetPackageExtension {
  const parts: OpcPart[] = [];
  const relationships: RelationshipGroup[] = [];
  const workbookDeclarations: RelationshipDeclaration[] = [];
  const workbookChildren: XmlElement[] = [];
  const sheetDeclarations = new Map<string, RelationshipDeclaration[]>();

  collection.pivots.forEach((pivot, index) => {
    const table = parseSourceTable(workbook, pivot.source, 'pivot.source');
    const cacheId = index + 1;

    parts.push({
      path: pivotCacheDefinitionPartPath(index),
      content_type: XLSX_PIVOT_CACHE_DEFINITION_CONTENT_TYPE,
      data: buildPivotCacheDefinitionXml(pivot, table),
    });
    parts.push({
      path: pivotCacheRecordsPartPath(index),
      content_type: XLSX_PIVOT_CACHE_RECORDS_CONTENT_TYPE,
      data: buildPivotCacheRecordsXml(table),
    });
    parts.push({
      path: pivotTablePartPath(index),
      content_type: XLSX_PIVOT_TABLE_CONTENT_TYPE,
      data: buildPivotTableXml(pivot, table, cacheId),
    });

    // pivotTable → pivotCacheDefinition（该部件自己的关系只有这一条 ⇒ rId1）
    relationships.push({
      owner_part_path: pivotTablePartPath(index),
      declarations: [
        {
          type: PIVOT_CACHE_DEFINITION_RELATIONSHIP_TYPE,
          target: `../pivotCache/pivotCacheDefinition${String(cacheId)}.xml`,
        },
      ],
    });

    // workbook → pivotCacheDefinition：r:id 必须在造 <pivotCaches> 之前按声明位置算出来
    const relationshipId = workbookRelationshipId(workbook, workbookDeclarations.length);
    workbookDeclarations.push({
      type: PIVOT_CACHE_DEFINITION_RELATIONSHIP_TYPE,
      target: `pivotCache/pivotCacheDefinition${String(cacheId)}.xml`,
    });
    workbookChildren.push(
      el('pivotCache', [attr('cacheId', String(cacheId)), attr('r:id', relationshipId)]),
    );

    // worksheet → pivotTable（按工作表分组，id 从该表的第 0 条声明起算）
    const owner = worksheetPathOf(workbook, pivot.destination.sheet);
    const declarations = sheetDeclarations.get(owner) ?? [];
    declarations.push({
      type: PIVOT_TABLE_RELATIONSHIP_TYPE,
      target: `../pivotTables/pivotTable${String(index + 1)}.xml`,
    });
    sheetDeclarations.set(owner, declarations);
  });

  if (workbookChildren.length === 0) {
    return { parts, relationships };
  }
  return {
    parts,
    relationships: [
      ...relationships,
      { owner_part_path: XLSX_WORKBOOK_PART_PATH, declarations: workbookDeclarations },
      ...[...sheetDeclarations.entries()].map(([owner, declarations]) => ({
        owner_part_path: owner,
        declarations,
      })),
    ],
    transforms: [
      { part_path: XLSX_WORKBOOK_PART_PATH, children: [serializeXmlNode(el('pivotCaches', [], workbookChildren))] },
    ],
  };
}

/**
 * 写出**带透视表**的真实 .xlsx。
 *
 * 工作簿本体仍由既有写入器生成；本函数追加透视缓存（定义 + 记录）、透视表本体、
 * 三处关系与 `<pivotCaches>`。同一 `(workbook, collection)` ⇒ 同一字节。
 *
 * @throws {ValidationError} 透视配置非法
 */
export function writePivotWorkbookXlsx(
  workbook: WorkbookState,
  collection: PivotCollection,
): SpreadsheetPackageResult {
  return composeWorkbookPackage(workbook, pivotExtension(workbook, collection));
}

// ---------------------------------------------------------------------------
// 读回真实结构（XLS-13 的"读回证据"）
// ---------------------------------------------------------------------------

/** 读回的一张透视表（全部字段都从**部件字节**解析，不是模型回显）。 */
export interface ReadPivotTable {
  readonly name: string;
  readonly cache_id: number;
  readonly source: { readonly sheet: string; readonly range: string };
  readonly cache_fields: readonly string[];
  readonly record_count: number;
  readonly row_fields: readonly string[];
  readonly column_fields: readonly string[];
  readonly data_fields: readonly {
    readonly field: string;
    readonly caption: string;
    readonly summarize_by: PivotSummary;
  }[];
  readonly filter_fields: readonly string[];
  readonly location: {
    readonly ref: string;
    readonly first_data_col: number;
    readonly first_data_row: number;
  };
}

/** 空安全的子元素列表。 */
function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

/** 按本地名取子元素（读 `.rels` 时不看命名空间：属性无前缀 ⇒ 属性命名空间是空串）。 */
function elementsNamed(element: ParsedXmlElement | null, localName: string): readonly ParsedXmlElement[] {
  return childrenOf(element).filter((child) => child.localName === localName);
}

/** 相对目标解析（读回时用；处理 `../` 与同目录两种形态）。 */
function resolveRelative(ownerPath: string, target: string): string {
  const base = ownerPath.slice(0, ownerPath.lastIndexOf('/') + 1);
  const stack: string[] = [];
  for (const segment of `${base}${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function requiredPart(archive: ReadZipArchive, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new ValidationError(`xlsx 缺少部件 ${path}`);
  }
  return entry.data;
}

function subtotalOf(dataField: ParsedXmlElement): PivotSummary {
  const raw = attributeValue(dataField, '', 'subtotal') ?? 'sum';
  return (PIVOT_SUMMARIES as readonly string[]).includes(raw) ? (raw as PivotSummary) : 'sum';
}

function readCacheDefinition(root: ParsedXmlElement): {
  readonly cache_fields: readonly string[];
  readonly source: { sheet: string; range: string };
  readonly record_count: number;
} {
  const cacheFields = findChild(root, SPREADSHEETML_NAMESPACE, 'cacheFields');
  const fields: string[] = [];
  for (const field of elementsNamed(cacheFields, 'cacheField')) {
    fields.push(attributeValue(field, '', 'name') ?? '');
  }
  const worksheetSource = findChild(
    findChild(root, SPREADSHEETML_NAMESPACE, 'cacheSource'),
    SPREADSHEETML_NAMESPACE,
    'worksheetSource',
  );
  return {
    cache_fields: Object.freeze(fields),
    source: Object.freeze({
      sheet: worksheetSource === null ? '' : (attributeValue(worksheetSource, '', 'sheet') ?? ''),
      range: worksheetSource === null ? '' : (attributeValue(worksheetSource, '', 'ref') ?? ''),
    }),
    record_count: Number(attributeValue(root, '', 'recordCount') ?? '0'),
  };
}

function readFieldList(
  container: ParsedXmlElement | null,
  cacheFields: readonly string[],
): readonly string[] {
  const names: string[] = [];
  for (const field of elementsNamed(container, 'field')) {
    const at = Number(attributeValue(field, '', 'x') ?? '-1');
    const name = cacheFields[at];
    if (name !== undefined) names.push(name);
  }
  return Object.freeze(names);
}

function readPivotTableDefinition(
  root: ParsedXmlElement,
  cacheFields: readonly string[],
): Pick<
  ReadPivotTable,
  'name' | 'row_fields' | 'column_fields' | 'data_fields' | 'filter_fields' | 'location'
> {
  const data: { field: string; caption: string; summarize_by: PivotSummary }[] = [];
  for (const dataField of elementsNamed(findChild(root, SPREADSHEETML_NAMESPACE, 'dataFields'), 'dataField')) {
    const at = Number(attributeValue(dataField, '', 'fld') ?? '-1');
    data.push({
      field: cacheFields[at] ?? '',
      caption: attributeValue(dataField, '', 'name') ?? '',
      summarize_by: subtotalOf(dataField),
    });
  }
  const filters: string[] = [];
  for (const pageField of elementsNamed(findChild(root, SPREADSHEETML_NAMESPACE, 'pageFields'), 'pageField')) {
    const at = Number(attributeValue(pageField, '', 'fld') ?? '-1');
    const name = cacheFields[at];
    if (name !== undefined) filters.push(name);
  }
  const location = findChild(root, SPREADSHEETML_NAMESPACE, 'location');
  if (location === null) {
    throw new ValidationError('pivotTableDefinition 缺少 <location>：无法确定透视区落点');
  }
  return {
    name: attributeValue(root, '', 'name') ?? '',
    row_fields: readFieldList(findChild(root, SPREADSHEETML_NAMESPACE, 'rowFields'), cacheFields),
    column_fields: readFieldList(findChild(root, SPREADSHEETML_NAMESPACE, 'colFields'), cacheFields),
    data_fields: Object.freeze(data.map((entry) => Object.freeze(entry))),
    filter_fields: Object.freeze(filters),
    location: Object.freeze({
      ref: attributeValue(location, '', 'ref') ?? '',
      first_data_col: Number(attributeValue(location, '', 'firstDataCol') ?? '0'),
      first_data_row: Number(attributeValue(location, '', 'firstDataRow') ?? '0'),
    }),
  };
}

/**
 * 读回一份 .xlsx 里的**全部透视表**（真实结构，不从模型回显）。
 *
 * 走法：各 `xl/worksheets/_rels/sheetN.xml.rels` 找 pivotTable 关系 → 读透视表本体，
 * 用它的 `cacheId` 找到 `xl/pivotCache/pivotCacheDefinitionN.xml` → 读缓存字段与来源。
 *
 * @throws {ValidationError} 包结构不合法（缺部件）
 */
export function readPivotTables(bytes: Uint8Array): readonly ReadPivotTable[] {
  const archive = readZip(bytes);
  const results: ReadPivotTable[] = [];
  for (const entry of archive.entries) {
    const match = /^xl\/worksheets\/_rels\/(sheet\d+)\.xml\.rels$/.exec(entry.path);
    if (match === null) continue;
    const rels = parseXmlBytes(entry.data);
    for (const relationship of elementsNamed(rels, 'Relationship')) {
      if (attributeValue(relationship, '', 'Type') !== PIVOT_TABLE_RELATIONSHIP_TYPE) continue;
      const target = attributeValue(relationship, '', 'Target') ?? '';
      const owner = `xl/worksheets/${match[1] as string}.xml`;
      const definition = parseXmlBytes(requiredPart(archive, resolveRelative(owner, target)));
      const cacheId = Number(attributeValue(definition, '', 'cacheId') ?? '0');
      const cacheRoot = parseXmlBytes(
        requiredPart(archive, `xl/pivotCache/pivotCacheDefinition${String(cacheId)}.xml`),
      );
      const cache = readCacheDefinition(cacheRoot);
      results.push(
        Object.freeze({
          cache_id: cacheId,
          cache_fields: cache.cache_fields,
          source: cache.source,
          record_count: cache.record_count,
          ...readPivotTableDefinition(definition, cache.cache_fields),
        }),
      );
    }
  }
  return Object.freeze(results);
}

// ---------------------------------------------------------------------------
// 手机端**本机刷新**：把汇总结果落到工作表（XLS-13「手机刷新结果」）
// ---------------------------------------------------------------------------

/**
 * {@link refreshPivotTable} 的选项。
 */
export interface PivotRefreshOptions {
  /** 是否写出表头行（行字段名 + `列键 显示名`）。默认 `true`。 */
  readonly headers?: boolean;
  /**
   * 缺席格（该组一个数值都没有）的处理。默认 `true` = **清空**该格
   * （既不写 0，也不留上一次刷新的旧值）。`false` = 不碰该格。
   */
  readonly clear_absent?: boolean;
}

/** {@link refreshPivotTable} 的结果。 */
export interface PivotRefreshResult {
  /** 刷新后的新工作簿（工作表不可变，返回新对象）。 */
  readonly workbook: WorkbookState;
  /** 写出的落点区域（A1 记法，含表头行）；无数据时等于单行表头区。 */
  readonly range: string;
  /** 实际写入**数值**的格数。 */
  readonly cells_written: number;
  /** 因"该组没有数值"而**留空 / 清空**的格数（**不是 0**，R248）。 */
  readonly absent_cells: number;
  /** 行键集合（首次出现顺序）。 */
  readonly row_keys: readonly (readonly string[])[];
  /** 列键集合（首次出现顺序）。 */
  readonly column_keys: readonly (readonly string[])[];
}

/** 组合键的无歧义 id（`JSON.stringify` 避免分隔符撞车，且不引入控制字符）。 */
function keyId(key: readonly string[]): string {
  return JSON.stringify(key);
}

function distinctKeys(
  cells: readonly PivotSummaryCell[],
  pick: (cell: PivotSummaryCell) => readonly string[],
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const cell of cells) {
    const key = pick(cell);
    const id = keyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

/** 表头文本：列键 + 值字段显示名（无列字段时只有显示名）。 */
function refreshHeaderText(columnKey: readonly string[], caption: string): string {
  return [...columnKey, caption].filter((part) => part.length > 0).join(' / ');
}

/**
 * **在手机端本机刷新透视结果**：由 `computePivotAggregate` 真算一遍，并把结果写入
 * `pivot.destination` 起始的单元格区。**不依赖桌面 Excel**——这正是 EXCEL.md 对 XLS-13 的
 * 手机侧要求（"手机刷新结果，不能要求用户打开桌面 Excel 才完成运算"）。
 *
 * 布局（表格化，确定、可复算）：
 * - 首行：行字段名（各占一列）+ 每个列键 × 每个值字段一列；
 * - 其后每个行键一行：行键单元格 + 各列的汇总数值。
 *
 * **缺失不当零**：某组该值字段没有结果时，对应格**不写 0**——按 `options.clear_absent`
 * （默认）清空该格，并计入 `absent_cells`。
 *
 * @throws {ValidationError} 来源 / 配置不合法（同 {@link computePivotAggregate}）
 */
export function refreshPivotTable(
  workbook: WorkbookState,
  pivot: PivotState,
  options: PivotRefreshOptions = {},
): PivotRefreshResult {
  const writeHeaders = options.headers ?? true;
  const clearAbsent = options.clear_absent ?? true;

  const aggregate = computePivotAggregate(workbook, pivot);
  const rowKeys = distinctKeys(aggregate, (cell) => cell.row_key);
  const columnKeys = distinctKeys(aggregate, (cell) => cell.column_key);

  const byKey = new Map<string, PivotSummaryCell>();
  for (const cell of aggregate) {
    byKey.set(`${keyId(cell.row_key)}|${keyId(cell.column_key)}`, cell);
  }

  const destination = getSheet(workbook, pivot.destination.sheet);
  if (destination === undefined) {
    throw new ValidationError(
      `pivot.destination 引用了工作簿里不存在的工作表 ${JSON.stringify(pivot.destination.sheet)}`,
    );
  }
  const origin = parseCellAddress(pivot.destination.cell);

  const rowFieldCount = pivot.rows.length;
  const valueCount = pivot.values.length;
  const dataColumnCount = columnKeys.length * valueCount;
  const lastColumn = origin.column + rowFieldCount + dataColumnCount - 1;
  const headerOffset = writeHeaders ? 1 : 0;
  const lastRow = origin.row + headerOffset + Math.max(rowKeys.length, 1) - 1;

  let sheet = destination;
  if (lastRow > sheet.row_count || lastColumn > sheet.column_count) {
    sheet = Object.freeze({
      ...sheet,
      row_count: Math.max(sheet.row_count, lastRow),
      column_count: Math.max(sheet.column_count, lastColumn),
    });
  }

  let cellsWritten = 0;
  let absentCells = 0;

  if (writeHeaders) {
    pivot.rows.forEach((field, index) => {
      sheet = setCellValue(sheet, formatCellAddress({ column: origin.column + index, row: origin.row }), textValue(field));
    });
    columnKeys.forEach((columnKey, columnIndex) => {
      pivot.values.forEach((value, valueIndex) => {
        const at = origin.column + rowFieldCount + columnIndex * valueCount + valueIndex;
        sheet = setCellValue(
          sheet,
          formatCellAddress({ column: at, row: origin.row }),
          textValue(refreshHeaderText(columnKey, pivotValueCaption(value))),
        );
      });
    });
  }

  rowKeys.forEach((rowKey, rowIndex) => {
    const atRow = origin.row + headerOffset + rowIndex;
    rowKey.forEach((part, columnIndex) => {
      sheet = setCellValue(
        sheet,
        formatCellAddress({ column: origin.column + columnIndex, row: atRow }),
        textValue(part),
      );
    });
    columnKeys.forEach((columnKey, columnIndex) => {
      const cell = byKey.get(`${keyId(rowKey)}|${keyId(columnKey)}`);
      pivot.values.forEach((value, valueIndex) => {
        const atColumn = origin.column + rowFieldCount + columnIndex * valueCount + valueIndex;
        const address = formatCellAddress({ column: atColumn, row: atRow });
        const result = cell?.values[pivotValueCaption(value)];
        if (result === undefined) {
          // 该组没有数值 ⇒ **不是 0**：清空（或不动），并计一次缺席
          absentCells += 1;
          if (clearAbsent) {
            const next = new Map(sheet.cells);
            next.delete(address);
            sheet = Object.freeze({ ...sheet, cells: next });
          }
          return;
        }
        sheet = setCellValue(sheet, address, numberValue(result));
        cellsWritten += 1;
      });
    });
  });

  const nextSheets = workbook.sheets.map((candidate) => (candidate.name === sheet.name ? sheet : candidate));
  return Object.freeze({
    workbook: Object.freeze({ sheets: Object.freeze(nextSheets), active_sheet: workbook.active_sheet }),
    range: formatCellAddress({ column: origin.column, row: origin.row }) === formatCellAddress({ column: lastColumn, row: lastRow })
      ? formatCellAddress({ column: origin.column, row: origin.row })
      : `${formatCellAddress({ column: origin.column, row: origin.row })}:${formatCellAddress({ column: lastColumn, row: lastRow })}`,
    cells_written: cellsWritten,
    absent_cells: absentCells,
    row_keys: Object.freeze(rowKeys.map((key) => Object.freeze([...key]))),
    column_keys: Object.freeze(columnKeys.map((key) => Object.freeze([...key]))),
  });
}
