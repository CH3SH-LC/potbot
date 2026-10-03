/**
 * 表格域：排序 / 筛选 / 去重 / 查找替换 / 空值处理（design-06-P8 / XLS-09）。
 *
 * ## 这个文件要守住的那条线
 *
 * XLS-09 的验收句里有一句是**硬要求**：「**整行记录保持对应**，绝不只移动一列导致数据错配」。
 * 因此本文件的每一个会"动行"的操作（排序、筛选、去重、删空行）都是**按行整体搬运**：
 * 先把一行在范围内**全部列**的值读成一个不可变元组，搬动元组，再整行写回。
 * 代码里**不存在**按单列读写路径——"只移动一列"这件事在本模块里**写不出来**。
 *
 * ## 存取方式：复用 `sheet.ts`，不自己碰 `cells`
 *
 * 读值走 {@link getCellValue}（未设置 ⇒ `blank`，R248）；写值走 `setCellValue` / `clearCell`；
 * 删行走 {@link deleteRows}（它顺带把公式引用与合并区一起迁移——那是它已经在做的事，
 * 本模块不重复实现）。因此"整行保持对应"与"公式随行迁移"是同一条既有代码路径的两个后果。
 *
 * ## 排序顺序是**仓内自定**的，不冒充 Excel
 *
 * 类别次序：数值 / 日期（同一数值序）< 文本 < 布尔 < 错误值 < 公式 < 空白。
 * 文本比较用**码元序**（`<` / `>`），**刻意不用 `localeCompare`**——locale 相关会破坏
 * "同一输入必得同一结果"的内核纪律。空白的位置由 `blanks` 选项决定（默认排最后）。
 *
 * ## 已知边界（如实登记，不夸大）
 *
 * - 排序 / 筛选是**按值搬运**：公式单元格连同**公式原文**一起移动，**不**改写其中的相对引用。
 *   在一个"整体重排"的语义下，引用应当指向哪是**有歧义**的，本模块**不猜**（与 `reference.ts`
 *   对删除命中返回 `deleted` 而不伪造新行号同口径）。需要引用改写的调用方应走 `sheet.ts`。
 * - 文本类筛选算子（`contains` / `startsWith` / …）**只对 `text` 单元格成立**，数值 / 布尔
 *   **不做隐式字符串化**——这是 XLS-03「六类不互相冒充」的直接推论。
 */

import { ValidationError } from '../protocol/index.js';
import {
  parseCellAddress,
  parseRange,
  rangeContainsAddress,
  type CellRange,
} from './reference.js';
import {
  clearCell,
  deleteRows,
  getCellValue,
  setCellValue,
  sheetEntries,
  type SheetState,
} from './sheet.js';
import { textValue, valuesEqual, type CellValue } from './value.js';

/** 区域输入：结构化区域或 A1 文本。 */
export type RangeInput = CellRange | string;

/** 解析区域输入。@throws {ValidationError} 文本非法 */
export function resolveRangeInput(range: RangeInput): CellRange {
  return typeof range === 'string' ? parseRange(range) : range;
}

function requireColumnInRange(range: CellRange, column: number, where: string): void {
  if (!Number.isInteger(column) || column < range.start.column || column > range.end.column) {
    throw new ValidationError(
      `${where} 的列 ${String(column)} 不在区域 [${String(range.start.column)}, ${String(range.end.column)}] 内`,
    );
  }
}

/** 读区域内某一行的**全部列**取值（行的整体快照——"整行保持对应"的读侧）。 */
function readRow(sheet: SheetState, range: CellRange, row: number): readonly CellValue[] {
  const values: CellValue[] = [];
  for (let column = range.start.column; column <= range.end.column; column += 1) {
    values.push(getCellValue(sheet, { column, row }));
  }
  return Object.freeze(values);
}

/** 把一行**全部列**写回（行的整体落盘——"整行保持对应"的写侧；`blank` 落成"未设置"）。 */
function writeRow(
  sheet: SheetState,
  range: CellRange,
  row: number,
  values: readonly CellValue[],
): SheetState {
  let next = sheet;
  for (let offset = 0; offset < values.length; offset += 1) {
    const column = range.start.column + offset;
    const value = values[offset];
    /* c8 ignore next -- offset 由 values.length 约束，索引必然存在 */
    if (value === undefined) continue;
    next = value.kind === 'blank' ? clearCell(next, { column, row }) : setCellValue(next, { column, row }, value);
  }
  return next;
}

/** 数值序比较（`-0` 与 `0` 视为相等；非有限数不可能存在，构造期已拒）。 */
function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 文本比较：**码元序**（确定性；刻意不用 locale 相关 API）。 */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 数值轴：数值与日期共用数值序（Excel 里日期本就是数）。其余类别返回 `null`。 */
function numericAxis(value: CellValue): number | null {
  if (value.kind === 'number') return value.value;
  if (value.kind === 'date') return value.epoch_ms;
  return null;
}

/** 类别次序（**仓内自定**，见文件头）。空白单独处理。 */
function sortRank(value: CellValue): number {
  switch (value.kind) {
    case 'number':
    case 'date':
      return 0;
    case 'text':
      return 1;
    case 'boolean':
      return 2;
    case 'error':
      return 3;
    case 'formula':
      return 4;
    case 'blank':
      return 5;
    default: {
      const never: never = value;
      throw new ValidationError(`compareCellValues 未覆盖的类别：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 单元格排序比较：`<0` 在前、`0` 相等、`>0` 在后。
 *
 * `blanksFirst` 为真时空白排最前（Excel 里两种口径都存在，故选显式参数而非默认猜测）。
 */
export function compareCellValues(a: CellValue, b: CellValue, blanksFirst = false): number {
  if (a.kind === 'blank' || b.kind === 'blank') {
    if (a.kind === 'blank' && b.kind === 'blank') return 0;
    if (a.kind === 'blank') return blanksFirst ? -1 : 1;
    return blanksFirst ? 1 : -1;
  }
  if (a.kind !== b.kind) {
    const na = numericAxis(a);
    const nb = numericAxis(b);
    if (na !== null && nb !== null) return compareNumbers(na, nb);
    return sortRank(a) - sortRank(b);
  }
  switch (a.kind) {
    case 'number':
      return compareNumbers(a.value, (b as typeof a).value);
    case 'date':
      return compareNumbers(a.epoch_ms, (b as typeof a).epoch_ms);
    case 'text':
      return compareText(a.value, (b as typeof a).value);
    case 'boolean':
      return compareNumbers(a.value ? 1 : 0, (b as typeof a).value ? 1 : 0);
    case 'error':
      return compareText(a.code, (b as typeof a).code);
    case 'formula':
      // 公式无缓存值（XLS-08 未建模），按**公式原文**比较并如实登记为受限口径。
      return compareText(a.text, (b as typeof a).text);
    /* c8 ignore next 2 -- blank 已在函数开头处理 */
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// 排序（XLS-09）
// ---------------------------------------------------------------------------

/** 排序方向。 */
export type SortDirection = 'asc' | 'desc';

/** 一个排序键（列号为**绝对列号**，须落在区域内）。 */
export interface SortKey {
  readonly column: number;
  readonly direction: SortDirection;
}

/** 排序选项。 */
export interface SortOptions {
  /** 首行是标题行，不参与排序（默认 `false`）。 */
  readonly header?: boolean;
  /** 空白值位置（默认 `'last'`）。**不随 `desc` 翻转**：`'first'` 恒为结果最前。 */
  readonly blanks?: 'first' | 'last';
}

/**
 * 在区域内**整行**排序（多键，键序即优先级）。
 *
 * 每行连同**全部列**一起搬运，因此"姓名"与"分数"绝不会错配。返回新 `SheetState`，原件不变。
 * @throws {ValidationError} `keys` 为空、列号越界、方向非法
 */
export function sortRange(
  sheet: SheetState,
  range: RangeInput,
  keys: readonly SortKey[],
  options: SortOptions = {},
): SheetState {
  const resolved = resolveRangeInput(range);
  if (keys.length === 0) {
    throw new ValidationError('sortRange 至少需要一个排序键（多键排序不接受空键表）');
  }
  for (const key of keys) {
    requireColumnInRange(resolved, key.column, 'sortRange');
    if (key.direction !== 'asc' && key.direction !== 'desc') {
      throw new ValidationError(`sortRange 的方向只能是 asc / desc，收到 ${JSON.stringify(key.direction)}`);
    }
  }
  const header = options.header ?? false;
  const blanksFirst = (options.blanks ?? 'last') === 'first';
  const firstDataRow = header ? resolved.start.row + 1 : resolved.start.row;

  const rows: { readonly source: number; readonly values: readonly CellValue[] }[] = [];
  for (let row = firstDataRow; row <= resolved.end.row; row += 1) {
    rows.push({ source: row, values: readRow(sheet, resolved, row) });
  }
  rows.sort((left, right) => {
    for (const key of keys) {
      const offset = key.column - resolved.start.column;
      const a = left.values[offset];
      const b = right.values[offset];
      /* c8 ignore next -- offset 由 requireColumnInRange 约束 */
      if (a === undefined || b === undefined) continue;
      // 空白的位置是**结果语义**（"排最前 / 排最后"），不随 asc/desc 翻转：
      // 否则 `blanks: 'first'` 配 desc 会变成"空白排最后"，与选项名直接矛盾。
      if (a.kind === 'blank' || b.kind === 'blank') {
        const blankCmp = compareCellValues(a, b, blanksFirst);
        if (blankCmp !== 0) return blankCmp;
        continue; // 两侧都是空白 ⇒ 本键相等，看下一个键
      }
      const cmp = compareCellValues(a, b, blanksFirst);
      if (cmp !== 0) return key.direction === 'desc' ? -cmp : cmp;
    }
    return left.source - right.source; // 稳定：相等时保原相对次序
  });

  let next = sheet;
  for (let index = 0; index < rows.length; index += 1) {
    const entry = rows[index];
    /* c8 ignore next -- index 由 rows.length 约束 */
    if (entry === undefined) continue;
    next = writeRow(next, resolved, firstDataRow + index, entry.values);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 筛选与条件组合（XLS-09）
// ---------------------------------------------------------------------------

/** 筛选算子。 */
export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessOrEqual'
  | 'between'
  | 'isEmpty'
  | 'isNotEmpty';

/** 单条筛选条件。`value` 用于等值类；`min`/`max` 用于 `between`；`text` 用于文本类。 */
export interface FilterCondition {
  readonly column: number;
  readonly operator: FilterOperator;
  readonly value?: CellValue;
  readonly text?: string;
  readonly min?: number;
  readonly max?: number;
  /** 文本类算子是否区分大小写（默认 `false`）。 */
  readonly case_sensitive?: boolean;
}

/** 条件的组合（可递归嵌套：`and` / `or` 树）。 */
export interface FilterGroup {
  readonly op: 'and' | 'or';
  readonly conditions: readonly (FilterCondition | FilterGroup)[];
}

/** 判别：是组合还是单条件。 */
export function isFilterGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return (node as FilterGroup).op === 'and' || (node as FilterGroup).op === 'or';
}

/** 筛选选项。 */
export interface FilterOptions {
  /** 首行是标题行，不参与筛选（默认 `false`）。 */
  readonly header?: boolean;
}

const TEXT_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
]);

const NUMERIC_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessOrEqual',
  'between',
]);

/** 文本类算子核心：两串按 `caseSensitive` 归一后判断。 */
function matchText(operator: FilterOperator, haystack: string, needle: string, caseSensitive: boolean): boolean {
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  switch (operator) {
    case 'contains':
      return h.includes(n);
    case 'notContains':
      return !h.includes(n);
    case 'startsWith':
      return h.startsWith(n);
    case 'endsWith':
      return h.endsWith(n);
    /* c8 ignore next 2 -- 调用方已限定文本算子 */
    default:
      return false;
  }
}

function matchesCondition(sheet: SheetState, range: CellRange, row: number, condition: FilterCondition): boolean {
  requireColumnInRange(range, condition.column, '筛选条件');
  const value = getCellValue(sheet, { column: condition.column, row });
  const operator = condition.operator;
  if (operator === 'isEmpty') return value.kind === 'blank';
  if (operator === 'isNotEmpty') return value.kind !== 'blank';
  if (operator === 'equals') {
    if (condition.value === undefined) {
      throw new ValidationError('筛选算子 equals 需要 value');
    }
    return valuesEqual(value, condition.value);
  }
  if (operator === 'notEquals') {
    if (condition.value === undefined) {
      throw new ValidationError('筛选算子 notEquals 需要 value');
    }
    return !valuesEqual(value, condition.value);
  }
  if (TEXT_OPERATORS.has(operator)) {
    if (condition.text === undefined) {
      throw new ValidationError(`筛选算子 ${operator} 需要 text`);
    }
    // 类别不互相冒充：非文本单元格一律不匹配文本算子
    if (value.kind !== 'text') return false;
    return matchText(operator, value.value, condition.text, condition.case_sensitive ?? false);
  }
  if (NUMERIC_OPERATORS.has(operator)) {
    const actual = numericAxis(value);
    if (actual === null) return false; // 非数值 / 空白不参与数值比较，不隐式取 0（R248）
    if (operator === 'between') {
      if (condition.min === undefined || condition.max === undefined) {
        throw new ValidationError('筛选算子 between 需要 min 与 max');
      }
      const lower = Math.min(condition.min, condition.max);
      const upper = Math.max(condition.min, condition.max);
      return actual >= lower && actual <= upper;
    }
    if (condition.value === undefined || numericAxis(condition.value) === null) {
      throw new ValidationError(`筛选算子 ${operator} 需要数值型 value`);
    }
    const bound = numericAxis(condition.value) as number;
    switch (operator) {
      case 'greaterThan':
        return actual > bound;
      case 'greaterThanOrEqual':
        return actual >= bound;
      case 'lessThan':
        return actual < bound;
      case 'lessOrEqual':
        return actual <= bound;
      /* c8 ignore next 2 -- 上面的 if 已排除 between */
      default:
        return false;
    }
  }
  /* c8 ignore next -- 算子已穷尽 */
  throw new ValidationError(`未知筛选算子：${JSON.stringify(operator)}`);
}

/**
 * 一组条件是否命中某行。空 `and` 组恒真（不筛掉任何行）、空 `or` 组恒假。
 * @throws {ValidationError} 条件形状非法
 */
export function matchesFilterGroup(sheet: SheetState, range: RangeInput, row: number, group: FilterGroup): boolean {
  const resolved = resolveRangeInput(range);
  if (group.op !== 'and' && group.op !== 'or') {
    throw new ValidationError(`筛选组的 op 只能是 and / or，收到 ${JSON.stringify(group.op)}`);
  }
  const results = group.conditions.map((node) =>
    isFilterGroup(node) ? matchesFilterGroup(sheet, resolved, row, node) : matchesCondition(sheet, resolved, row, node),
  );
  return group.op === 'and' ? results.every(Boolean) : results.some(Boolean);
}

/** 命中的数据行（绝对行号，升序）。@throws {ValidationError} */
export function filterRowIndices(
  sheet: SheetState,
  range: RangeInput,
  group: FilterGroup,
  options: FilterOptions = {},
): readonly number[] {
  const resolved = resolveRangeInput(range);
  const header = options.header ?? false;
  const first = header ? resolved.start.row + 1 : resolved.start.row;
  const matched: number[] = [];
  for (let row = first; row <= resolved.end.row; row += 1) {
    if (matchesFilterGroup(sheet, resolved, row, group)) matched.push(row);
  }
  return Object.freeze(matched);
}

/**
 * 应用筛选：**不命中的数据行整行删除**（下方各行上移），复用 `deleteRows` 一并迁移公式引用。
 * 返回新 `SheetState`，原件不变。@throws {ValidationError}
 */
export function applyFilter(
  sheet: SheetState,
  range: RangeInput,
  group: FilterGroup,
  options: FilterOptions = {},
): SheetState {
  const resolved = resolveRangeInput(range);
  const keep = new Set(filterRowIndices(sheet, resolved, group, options));
  const header = options.header ?? false;
  const first = header ? resolved.start.row + 1 : resolved.start.row;
  // 自下而上删：索引不会因删除而失效；同时"整行"而非"单列"被删除。
  let next = sheet;
  for (let row = resolved.end.row; row >= first; row -= 1) {
    if (!keep.has(row)) next = deleteRows(next, row, 1);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 去重（XLS-09）
// ---------------------------------------------------------------------------

/** 去重选项。 */
export interface DedupeOptions {
  readonly header?: boolean;
  /** 参与判重的列（绝对列号，默认 = 区域内全部列）。 */
  readonly key_columns?: readonly number[];
}

/** 单元格的**类型感知**判重签名（`number 1` 与 `text "1"` 不同键，与 `valuesEqual` 同口径）。 */
export function cellSignature(value: CellValue): string {
  switch (value.kind) {
    case 'number':
      return `n:${String(value.value)}`;
    case 'text':
      return `t:${value.value}`;
    case 'boolean':
      return `b:${value.value ? '1' : '0'}`;
    case 'date':
      return `d:${String(value.epoch_ms)}`;
    case 'error':
      return `e:${value.code}`;
    case 'formula':
      return `f:${value.text}`;
    case 'blank':
      return 'z:';
    /* c8 ignore next 2 -- 类别已穷尽 */
    default:
      return '?';
  }
}

/**
 * 去重：按 `key_columns`（默认全列）判重，**保留首次出现**，整行删除其后重复行。
 * 返回新 `SheetState`，原件不变。@throws {ValidationError}
 */
export function dedupeRows(sheet: SheetState, range: RangeInput, options: DedupeOptions = {}): SheetState {
  const resolved = resolveRangeInput(range);
  const header = options.header ?? false;
  const keyColumns =
    options.key_columns === undefined
      ? allColumns(resolved)
      : options.key_columns.map((column) => {
          requireColumnInRange(resolved, column, 'dedupeRows 的 key_columns');
          return column;
        });
  if (keyColumns.length === 0) {
    throw new ValidationError('dedupeRows 的 key_columns 不能为空');
  }
  const first = header ? resolved.start.row + 1 : resolved.start.row;
  const seen = new Set<string>();
  const duplicates: number[] = [];
  for (let row = first; row <= resolved.end.row; row += 1) {
    const signature = keyColumns
      .map((column) => cellSignature(getCellValue(sheet, { column, row })))
      .join('\u0001');
    if (seen.has(signature)) duplicates.push(row);
    else seen.add(signature);
  }
  let next = sheet;
  for (let index = duplicates.length - 1; index >= 0; index -= 1) {
    const row = duplicates[index];
    /* c8 ignore next -- index 由 duplicates.length 约束 */
    if (row === undefined) continue;
    next = deleteRows(next, row, 1);
  }
  return next;
}

function allColumns(range: CellRange): number[] {
  const columns: number[] = [];
  for (let column = range.start.column; column <= range.end.column; column += 1) columns.push(column);
  return columns;
}

// ---------------------------------------------------------------------------
// 查找 / 替换（XLS-09）
// ---------------------------------------------------------------------------

/** 查找选项。 */
export interface FindOptions {
  /** 是否区分大小写（默认 `false`）。 */
  readonly match_case?: boolean;
}

/** 命中单元格。 */
export interface FoundCell {
  readonly ref: string;
  readonly value: CellValue;
}

/**
 * 在区域内查找**文本**单元格。非文本单元格**不参与**（不做隐式字符串化，XLS-03）。
 * @throws {ValidationError} 区域非法
 */
export function findCells(sheet: SheetState, range: RangeInput, query: string, options: FindOptions = {}): readonly FoundCell[] {
  if (typeof query !== 'string' || query.length === 0) {
    throw new ValidationError('findCells 的查找串不能为空');
  }
  const resolved = resolveRangeInput(range);
  const caseSensitive = options.match_case ?? false;
  const needle = caseSensitive ? query : query.toLowerCase();
  const found: FoundCell[] = [];
  for (const entry of sheetEntries(sheet)) {
    const address = parseCellAddress(entry.ref);
    if (!rangeContainsAddress(resolved, address)) continue;
    if (entry.value.kind !== 'text') continue;
    const haystack = caseSensitive ? entry.value.value : entry.value.value.toLowerCase();
    if (haystack.includes(needle)) found.push(Object.freeze({ ref: entry.ref, value: entry.value }));
  }
  return Object.freeze(found);
}

/** 替换结果。 */
export interface ReplaceResult {
  readonly sheet: SheetState;
  readonly refs: readonly string[];
}

/**
 * 在区域内替换**文本**单元格中的子串（全部出现处）。非文本单元格不动。
 * 返回新 `SheetState` 与**实际改动**的单元格地址（可审计：没改就是没改）。
 * @throws {ValidationError} 查找串为空
 */
export function replaceInCells(
  sheet: SheetState,
  range: RangeInput,
  find: string,
  replacement: string,
  options: FindOptions = {},
): ReplaceResult {
  if (typeof find !== 'string' || find.length === 0) {
    throw new ValidationError('replaceInCells 的查找串不能为空');
  }
  if (typeof replacement !== 'string') {
    throw new ValidationError('replaceInCells 的替换串必须是字符串');
  }
  const resolved = resolveRangeInput(range);
  const caseSensitive = options.match_case ?? false;
  const refs: string[] = [];
  let next = sheet;
  for (const entry of sheetEntries(sheet)) {
    const address = parseCellAddress(entry.ref);
    if (!rangeContainsAddress(resolved, address)) continue;
    if (entry.value.kind !== 'text') continue;
    const original = entry.value.value;
    const updated = caseSensitive
      ? original.split(find).join(replacement)
      : replaceCaseInsensitive(original, find, replacement);
    if (updated === original) continue;
    next = setCellValue(next, entry.ref, textValue(updated));
    refs.push(entry.ref);
  }
  return Object.freeze({ sheet: next, refs: Object.freeze(refs) });
}

/** 大小写不敏感的全量替换（按小写定位、按原串长度切回，避免正则元字符问题）。 */
function replaceCaseInsensitive(text: string, find: string, replacement: string): string {
  const haystack = text.toLowerCase();
  const needle = find.toLowerCase();
  let out = '';
  let cursor = 0;
  let at = haystack.indexOf(needle, cursor);
  while (at !== -1) {
    out += text.slice(cursor, at) + replacement;
    cursor = at + find.length;
    at = haystack.indexOf(needle, cursor);
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// 空值处理（XLS-09）
// ---------------------------------------------------------------------------

/** 区域内空白单元格数量（未设置与显式空白都算空白；R248 下空白不是 0）。 */
export function countBlankCells(sheet: SheetState, range: RangeInput): number {
  const resolved = resolveRangeInput(range);
  let blanks = 0;
  for (let row = resolved.start.row; row <= resolved.end.row; row += 1) {
    for (let column = resolved.start.column; column <= resolved.end.column; column += 1) {
      if (getCellValue(sheet, { column, row }).kind === 'blank') blanks += 1;
    }
  }
  return blanks;
}

/** 某行在区域内是否全为空白。@throws {ValidationError} 行越界 */
export function isBlankRow(sheet: SheetState, range: RangeInput, row: number): boolean {
  const resolved = resolveRangeInput(range);
  if (!Number.isInteger(row) || row < resolved.start.row || row > resolved.end.row) {
    throw new ValidationError(`isBlankRow 的行 ${String(row)} 不在区域内`);
  }
  return readRow(sheet, resolved, row).every((value) => value.kind === 'blank');
}

/**
 * 删除区域内**整行全空**的数据行（下方各行上移）。返回新 `SheetState`，原件不变。
 * @throws {ValidationError}
 */
export function dropBlankRows(sheet: SheetState, range: RangeInput, options: FilterOptions = {}): SheetState {
  const resolved = resolveRangeInput(range);
  const header = options.header ?? false;
  const first = header ? resolved.start.row + 1 : resolved.start.row;
  let next = sheet;
  for (let row = resolved.end.row; row >= first; row -= 1) {
    if (isBlankRow(next, resolved, row)) next = deleteRows(next, row, 1);
  }
  return next;
}
