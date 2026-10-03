/**
 * 表格域：XLS-09/10 数据操作的**可序列化操作模式**与统一执行入口（X05）。
 *
 * ## 为什么要有这一层
 *
 * `sort-filter.ts` 已经把排序 / 筛选 / 去重 / 查找替换 / 空值处理做成**强类型函数**，
 * `structured-table.ts` 已经给出结构化表格的迁移代数。但手机端要跑的是**命令**——
 * 命令从 UI / 模型 / 编排层过来，先是一坨 `unknown` JSON，再落成一次真实运算。
 * 中间缺的那一环是：**"这段未知 JSON 到底是不是一个合法操作？"** 以及
 * **"一次操作执行完，到底动了哪些对象、有什么已知局限？"**（OfficePlugin 契约里的
 * `changedObjects` / `warnings`）。
 *
 * 本模块只做这一环，不重写上面两个模块的任何运算：
 *
 * | 方向 | 函数 | 回答的问题 |
 * |---|---|---|
 * | 反序列化 | {@link parseCellValue} / {@link parseDataOperation} | 未知 JSON → 合法操作，非法则**显式失败** |
 * | 描述 | {@link describeDataOperation} | 这个操作在人话里是什么？ |
 * | 执行 | {@link applyDataOperation} | 跑一次，回报动了什么、局限是什么 |
 *
 * ## 不猜、不静默
 *
 * - `parse*` 对任何缺字段 / 类型错 / 越界的输入**抛 `ValidationError`**，绝不返回 `undefined`
 *   或半成品（"解析失败"和"没有这个操作"是两件事，混同会让调用方以为命令合法）。
 * - `kind` 是**封闭枚举**：未知 `kind` 直接报错并列出合法值，不做"尽力而为"的兜底。
 * - 执行结果里的 `warnings` **如实登记**排序不改写公式相对引用这类已知边界，
 *   而不是把它藏起来当没发生。
 *
 * ## 这一层**不**碰表格对象
 *
 * 结构化表格（表名 / 列定义 / 汇总行）是**有身份的运行时对象**，不是 JSON 里的一段数据；
 * 把它从 `unknown` 反序列化需要工作簿级的表注册表，那是别的包的范围。表操作在
 * `./table-compose.js` 里以**强类型函数**暴露（`sortTable` / `appendTableRow`）。
 */

import { formatRange } from '../reference.js';
import type { SheetState } from '../sheet.js';
import {
  applyFilter,
  dedupeRows,
  dropBlankRows,
  isFilterGroup,
  replaceInCells,
  resolveRangeInput,
  sortRange,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type SortDirection,
  type SortKey,
} from '../sort-filter.js';
import { SPREADSHEET_ERROR_CODES, blank, type CellValue, type SpreadsheetErrorCode } from '../value.js';
import { ValidationError } from '../../protocol/index.js';

// ---------------------------------------------------------------------------
// 单元格取值的反序列化（命令 payload 里 CellValue 也是 JSON）
// ---------------------------------------------------------------------------

function asRecord(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError(`${where} 必须是一个对象，收到 ${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

/**
 * 严格反序列化一个单元格取值。
 *
 * **类别必须显式给全**：`{kind:'number'}` 缺 `value`、`{kind:'error', code:'#XX!'}` 的假错误码
 * 都会抛错。这是"六类不互相冒充"在**反序列化边界**上的执行点——若在这里放水，
 * `number 1` 会被悄悄读成 `text "1"`，下游永远查不出来。
 *
 * @throws {ValidationError} 形状非法 / 数值非有限 / 错误码未知 / 公式文本为空
 */
export function parseCellValue(input: unknown): CellValue {
  const record = asRecord(input, 'parseCellValue 的输入');
  const kind = record['kind'];
  switch (kind) {
    case 'number': {
      const value = record['value'];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(`number 单元格的 value 必须是有限数，收到 ${JSON.stringify(value)}`);
      }
      return Object.freeze({ kind: 'number' as const, value });
    }
    case 'text': {
      const value = record['value'];
      if (typeof value !== 'string') {
        throw new ValidationError(`text 单元格的 value 必须是字符串，收到 ${JSON.stringify(value)}`);
      }
      return Object.freeze({ kind: 'text' as const, value });
    }
    case 'boolean': {
      const value = record['value'];
      if (typeof value !== 'boolean') {
        throw new ValidationError(`boolean 单元格的 value 必须是布尔值，收到 ${JSON.stringify(value)}`);
      }
      return Object.freeze({ kind: 'boolean' as const, value });
    }
    case 'date': {
      const epoch = record['epoch_ms'];
      if (typeof epoch !== 'number' || !Number.isFinite(epoch)) {
        throw new ValidationError(`date 单元格的 epoch_ms 必须是有限数，收到 ${JSON.stringify(epoch)}`);
      }
      return Object.freeze({ kind: 'date' as const, epoch_ms: epoch });
    }
    case 'blank':
      return blank;
    case 'error': {
      const code = record['code'];
      if (typeof code !== 'string' || !SPREADSHEET_ERROR_CODES.includes(code as SpreadsheetErrorCode)) {
        throw new ValidationError(
          `error 单元格的 code 必须是封闭错误码之一，收到 ${JSON.stringify(code)}`,
        );
      }
      return Object.freeze({ kind: 'error' as const, code: code as SpreadsheetErrorCode });
    }
    case 'formula': {
      const text = record['text'];
      if (typeof text !== 'string' || text.length === 0) {
        throw new ValidationError('formula 单元格的 text 必须是非空字符串');
      }
      return Object.freeze({ kind: 'formula' as const, text });
    }
    default:
      throw new ValidationError(
        `未知的单元格类别 kind：${JSON.stringify(kind)}（合法值：number/text/boolean/date/blank/error/formula）`,
      );
  }
}

// ---------------------------------------------------------------------------
// 操作模式（operation schemas）
// ---------------------------------------------------------------------------

/** 排序操作：区域内整行排序（XLS-09）。 */
export interface SortOperation {
  readonly kind: 'sort';
  readonly range: string;
  readonly keys: readonly SortKey[];
  readonly header?: boolean;
  readonly blanks?: 'first' | 'last';
}

/** 筛选操作：不命中的数据行整行删除（XLS-09）。 */
export interface FilterOperation {
  readonly kind: 'filter';
  readonly range: string;
  readonly group: FilterGroup;
  readonly header?: boolean;
}

/** 去重操作：按关键列判重，保留首次出现（XLS-09）。 */
export interface DedupeOperation {
  readonly kind: 'dedupe';
  readonly range: string;
  readonly header?: boolean;
  readonly key_columns?: readonly number[];
}

/** 删空行操作：整行全空的数据行删除（XLS-09）。 */
export interface DropBlankRowsOperation {
  readonly kind: 'dropBlankRows';
  readonly range: string;
  readonly header?: boolean;
}

/** 查找 / 替换操作：只作用于文本单元格（XLS-09）。 */
export interface FindReplaceOperation {
  readonly kind: 'findReplace';
  readonly range: string;
  readonly find: string;
  readonly replacement: string;
  readonly match_case?: boolean;
}

/** 本包支持的全部数据操作（**封闭枚举**，见 {@link DATA_OPERATION_KINDS}）。 */
export type DataOperation =
  | SortOperation
  | FilterOperation
  | DedupeOperation
  | DropBlankRowsOperation
  | FindReplaceOperation;

/** 全部合法 `kind`（顺序即枚举顺序，供报错与遍历）。 */
export const DATA_OPERATION_KINDS = Object.freeze([
  'sort',
  'filter',
  'dedupe',
  'dropBlankRows',
  'findReplace',
] as const);

const SORT_DIRECTIONS: readonly SortDirection[] = Object.freeze(['asc', 'desc'] as const);

const FILTER_OPERATORS: readonly FilterOperator[] = Object.freeze([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessOrEqual',
  'between',
  'isEmpty',
  'isNotEmpty',
] as const);

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new ValidationError(`${where} 的 ${key} 必须是字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${where} 的 ${key} 必须是布尔值，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireRangeText(record: Record<string, unknown>, where: string): string {
  const text = requireString(record, 'range', where);
  if (text.length === 0) {
    throw new ValidationError(`${where} 的 range 不能为空`);
  }
  return text;
}

/** 解析一个排序键数组（非空、方向合法、列号为 ≥1 整数）。 */
export function parseSortKeys(input: unknown, where: string): readonly SortKey[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${where} 的 keys 必须是数组，收到 ${JSON.stringify(input)}`);
  }
  if (input.length === 0) {
    throw new ValidationError(`${where} 的 keys 至少需要一个排序键`);
  }
  const keys: SortKey[] = input.map((entry, index) => {
    const record = asRecord(entry, `${where} 的第 ${String(index + 1)} 个排序键`);
    const column = record['column'];
    if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
      throw new ValidationError(`${where} 的第 ${String(index + 1)} 个排序键的 column 必须是 ≥1 的整数`);
    }
    const direction = record['direction'];
    if (typeof direction !== 'string' || !SORT_DIRECTIONS.includes(direction as SortDirection)) {
      throw new ValidationError(
        `${where} 的第 ${String(index + 1)} 个排序键的 direction 只能是 asc / desc，收到 ${JSON.stringify(direction)}`,
      );
    }
    return Object.freeze({ column, direction: direction as SortDirection });
  });
  return Object.freeze(keys);
}

/** 解析一条筛选条件。 */
export function parseFilterCondition(input: unknown, where: string): FilterCondition {
  const record = asRecord(input, where);
  const column = record['column'];
  if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
    throw new ValidationError(`${where} 的 column 必须是 ≥1 的整数`);
  }
  const operator = record['operator'];
  if (typeof operator !== 'string' || !FILTER_OPERATORS.includes(operator as FilterOperator)) {
    throw new ValidationError(
      `${where} 的 operator 未知：${JSON.stringify(operator)}（合法值：${FILTER_OPERATORS.join(', ')}）`,
    );
  }
  const condition: {
    column: number;
    operator: FilterOperator;
    value?: CellValue;
    text?: string;
    min?: number;
    max?: number;
    case_sensitive?: boolean;
  } = { column, operator: operator as FilterOperator };
  if (record['value'] !== undefined) condition.value = parseCellValue(record['value']);
  if (record['text'] !== undefined) {
    if (typeof record['text'] !== 'string') {
      throw new ValidationError(`${where} 的 text 必须是字符串`);
    }
    condition.text = record['text'];
  }
  for (const bound of ['min', 'max'] as const) {
    if (record[bound] !== undefined) {
      const value = record[bound];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(`${where} 的 ${bound} 必须是有限数`);
      }
      condition[bound] = value;
    }
  }
  const caseSensitive = optionalBoolean(record, 'case_sensitive', where);
  if (caseSensitive !== undefined) condition.case_sensitive = caseSensitive;
  return Object.freeze(condition);
}

/**
 * 解析一个筛选组（`and` / `or` 树；条件与子组可混排，递归）。
 * @throws {ValidationError} `op` 非 and/or 或 `conditions` 非数组
 */
export function parseFilterGroup(input: unknown, where: string): FilterGroup {
  const record = asRecord(input, where);
  const op = record['op'];
  if (op !== 'and' && op !== 'or') {
    throw new ValidationError(`${where} 的 op 只能是 and / or，收到 ${JSON.stringify(op)}`);
  }
  const conditions = record['conditions'];
  if (!Array.isArray(conditions)) {
    throw new ValidationError(`${where} 的 conditions 必须是数组`);
  }
  const nodes = conditions.map((node, index) => {
    const childWhere = `${where}.conditions[${String(index)}]`;
    const child = asRecord(node, childWhere);
    const childOp = child['op'];
    // 判别：有 and/or 就是子组；否则按单条件解析
    if (childOp === 'and' || childOp === 'or') return parseFilterGroup(child, childWhere);
    return parseFilterCondition(child, childWhere);
  });
  return Object.freeze({ op, conditions: Object.freeze(nodes) });
}

/**
 * 把一段未知 JSON 严格解析成一个数据操作。
 *
 * @throws {ValidationError} 非对象 / `kind` 缺失或未知 / 任意字段非法
 */
export function parseDataOperation(input: unknown): DataOperation {
  const record = asRecord(input, 'parseDataOperation 的输入');
  const kind = record['kind'];
  switch (kind) {
    case 'sort': {
      const range = requireRangeText(record, 'sort');
      const keys = parseSortKeys(record['keys'], 'sort');
      const operation: {
        kind: 'sort';
        range: string;
        keys: readonly SortKey[];
        header?: boolean;
        blanks?: 'first' | 'last';
      } = { kind: 'sort', range, keys };
      const header = optionalBoolean(record, 'header', 'sort');
      if (header !== undefined) operation.header = header;
      const blanks = record['blanks'];
      if (blanks !== undefined) {
        if (blanks !== 'first' && blanks !== 'last') {
          throw new ValidationError(`sort 的 blanks 只能是 first / last，收到 ${JSON.stringify(blanks)}`);
        }
        operation.blanks = blanks;
      }
      return Object.freeze(operation);
    }
    case 'filter': {
      const range = requireRangeText(record, 'filter');
      const group = parseFilterGroup(record['group'], 'filter.group');
      const operation: { kind: 'filter'; range: string; group: FilterGroup; header?: boolean } = {
        kind: 'filter',
        range,
        group,
      };
      const header = optionalBoolean(record, 'header', 'filter');
      if (header !== undefined) operation.header = header;
      return Object.freeze(operation);
    }
    case 'dedupe': {
      const range = requireRangeText(record, 'dedupe');
      const operation: {
        kind: 'dedupe';
        range: string;
        header?: boolean;
        key_columns?: readonly number[];
      } = { kind: 'dedupe', range };
      const header = optionalBoolean(record, 'header', 'dedupe');
      if (header !== undefined) operation.header = header;
      const keyColumns = record['key_columns'];
      if (keyColumns !== undefined) {
        if (!Array.isArray(keyColumns)) {
          throw new ValidationError('dedupe 的 key_columns 必须是数组');
        }
        if (keyColumns.length === 0) {
          throw new ValidationError('dedupe 的 key_columns 不能为空（空数组意为不按任何列判重，非法）');
        }
        operation.key_columns = Object.freeze(
          keyColumns.map((column, index) => {
            if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
              throw new ValidationError(`dedupe 的 key_columns[${String(index)}] 必须是 ≥1 的整数`);
            }
            return column;
          }),
        );
      }
      return Object.freeze(operation);
    }
    case 'dropBlankRows': {
      const range = requireRangeText(record, 'dropBlankRows');
      const operation: { kind: 'dropBlankRows'; range: string; header?: boolean } = {
        kind: 'dropBlankRows',
        range,
      };
      const header = optionalBoolean(record, 'header', 'dropBlankRows');
      if (header !== undefined) operation.header = header;
      return Object.freeze(operation);
    }
    case 'findReplace': {
      const range = requireRangeText(record, 'findReplace');
      const find = requireString(record, 'find', 'findReplace');
      if (find.length === 0) {
        throw new ValidationError('findReplace 的 find 不能为空');
      }
      const replacement = requireString(record, 'replacement', 'findReplace');
      const operation: {
        kind: 'findReplace';
        range: string;
        find: string;
        replacement: string;
        match_case?: boolean;
      } = { kind: 'findReplace', range, find, replacement };
      const matchCase = optionalBoolean(record, 'match_case', 'findReplace');
      if (matchCase !== undefined) operation.match_case = matchCase;
      return Object.freeze(operation);
    }
    default:
      throw new ValidationError(
        `未知的数据操作 kind：${JSON.stringify(kind)}（合法值：${DATA_OPERATION_KINDS.join(', ')}）`,
      );
  }
}

/** 操作的一句话描述（供回执 / 日志；不 SQL、不执行）。 */
export function describeDataOperation(operation: DataOperation): string {
  switch (operation.kind) {
    case 'sort': {
      const keys = operation.keys
        .map((key) => `第 ${String(key.column)} 列 ${key.direction === 'asc' ? '升序' : '降序'}`)
        .join('，');
      return `在 ${operation.range} 按 ${keys} 整行排序${operation.header === true ? '（含标题行）' : ''}`;
    }
    case 'filter':
      return `筛选 ${operation.range}：${describeFilterGroup(operation.group)}`;
    case 'dedupe':
      return `在 ${operation.range} 去重${
        operation.key_columns === undefined ? '（按全部列）' : `（按第 ${operation.key_columns.join(', ')} 列）`
      }`;
    case 'dropBlankRows':
      return `删除 ${operation.range} 内的整行空行`;
    case 'findReplace':
      return `在 ${operation.range} 把 ${JSON.stringify(operation.find)} 替换为 ${JSON.stringify(operation.replacement)}`;
    default: {
      const never: never = operation;
      throw new ValidationError(`describeDataOperation 未覆盖的操作：${JSON.stringify(never)}`);
    }
  }
}

function describeFilterGroup(group: FilterGroup): string {
  const parts = group.conditions.map((node) =>
    isFilterGroup(node)
      ? `(${describeFilterGroup(node)})`
      : `第 ${String(node.column)} 列 ${node.operator}`,
  );
  return parts.join(group.op === 'and' ? ' 且 ' : ' 或 ');
}

// ---------------------------------------------------------------------------
// 执行（apply）
// ---------------------------------------------------------------------------

/** 执行结果：新工作表 + 动过的对象 + 已知局限。 */
export interface DataOperationResult {
  readonly sheet: SheetState;
  readonly operation: DataOperation;
  /** 本次真实触及的对象（区域文本或单元格引用；**没动就是空数组**）。 */
  readonly changedObjects: readonly string[];
  /** 如实登记的已知边界（不是错误，是本模块刻意不猜的地方）。 */
  readonly warnings: readonly string[];
}

const SORT_WARNING =
  '排序按值搬运整行：公式单元格连同公式原文一起移动，不重写其中的相对引用（见 sort-filter.ts 已知边界）';

/**
 * 执行一个已解析的数据操作。
 *
 * 只做**派发**：每个分支复用 `sort-filter.ts` 里对应的既有函数，不重复实现运算。
 * @throws {ValidationError} 交给底层函数的参数在区域 / 列号层面非法
 */
export function applyDataOperation(sheet: SheetState, operation: DataOperation): DataOperationResult {
  switch (operation.kind) {
    case 'sort': {
      const range = resolveRangeInput(operation.range);
      const next = sortRange(sheet, range, operation.keys, {
        header: operation.header ?? false,
        blanks: operation.blanks ?? 'last',
      });
      return Object.freeze({
        sheet: next,
        operation,
        changedObjects: Object.freeze([formatRange(range)]),
        warnings: Object.freeze([SORT_WARNING]),
      });
    }
    case 'filter': {
      const range = resolveRangeInput(operation.range);
      const next = applyFilter(sheet, range, operation.group, { header: operation.header ?? false });
      return Object.freeze({
        sheet: next,
        operation,
        changedObjects: Object.freeze([formatRange(range)]),
        warnings: Object.freeze([]),
      });
    }
    case 'dedupe': {
      const range = resolveRangeInput(operation.range);
      const next = dedupeRows(sheet, range, {
        header: operation.header ?? false,
        ...(operation.key_columns === undefined ? {} : { key_columns: operation.key_columns }),
      });
      return Object.freeze({
        sheet: next,
        operation,
        changedObjects: Object.freeze([formatRange(range)]),
        warnings: Object.freeze([]),
      });
    }
    case 'dropBlankRows': {
      const range = resolveRangeInput(operation.range);
      const next = dropBlankRows(sheet, range, { header: operation.header ?? false });
      return Object.freeze({
        sheet: next,
        operation,
        changedObjects: Object.freeze([formatRange(range)]),
        warnings: Object.freeze([]),
      });
    }
    case 'findReplace': {
      const result = replaceInCells(sheet, operation.range, operation.find, operation.replacement, {
        match_case: operation.match_case ?? false,
      });
      return Object.freeze({
        sheet: result.sheet,
        operation,
        changedObjects: result.refs,
        warnings: Object.freeze([]),
      });
    }
    default: {
      const never: never = operation;
      throw new ValidationError(`applyDataOperation 未覆盖的操作：${JSON.stringify(never)}`);
    }
  }
}
