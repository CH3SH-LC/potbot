/**
 * **表格操作工具注册表**（XLS-01；X10 独占包）。
 *
 * ## 这个文件解决什么
 *
 * `src/session/adapters/xlsx.ts` 的编辑枚举只有 6 个 op（set_cell / clear_cell / add_sheet /
 * remove_sheet / rename_sheet / set_active_sheet），EXCEL.md 记这条缺口为"编辑操作枚举偏窄"。
 * 本文件把 `src/spreadsheets/**` 里**已经实现**的能力接成一个**完整操作工具面**：
 * 取值写入、区域读写、行列增删、行列复制移动、合并拆分、排序、筛选、去重、删空行、查找替换、
 * 整表增删改名移动。
 *
 * ## 纪律：只转发，不另造
 *
 * 每个 op 都**直接转调**既有模块，本文件**一行判定口径都不重写**：
 *
 * | op | 转调 |
 * |---|---|
 * | `set_cell` / `clear_cell` | `sheet.ts` 的 `setCellValue` / `clearCell` |
 * | `set_range` / `clear_range` | `cells.ts` 的 `writeRange` / `sheet.ts` 的 `clearRange` |
 * | `insert_rows` / `delete_rows` / `insert_columns` / `delete_columns` | `sheet.ts` 的同名函数（含引用与公式迁移） |
 * | `copy_rows` / `move_rows` / `copy_columns` / `move_columns` | `sheet.ts` 的同名函数（X02 结构操作；复制按复制语义平移相对引用，移动按 `mapMovePosition` 分段映射） |
 * | `merge_cells` / `unmerge_cells` | `ranges.ts` 的同名函数 |
 * | `sort_range` / `dedupe_rows` / `replace_in_range` | `sort-filter.ts` 的 `sortRange` / `dedupeRows` / `replaceInCells` |
 * | `filter` / `drop_blank_rows` | `sort-filter.ts` 的 `applyFilter` / `dropBlankRows`（X05 数据操作；`filter.group` 的形状复用 X05 的 `parseFilterGroup` 严格反序列化） |
 * | `add_sheet` / `remove_sheet` / `rename_sheet` / `set_active_sheet` / `move_sheet` | `workbook.ts` 的同名函数 |
 *
 * 这样 X05 记的五个数据操作（sort / filter / dedupe / dropBlankRows / findReplace）与 X02 的
 * 四个结构种类（copy_rows / move_rows / copy_columns / move_columns）都能从这一层命令面到达。
 *
 * ## `changed` 判据
 *
 * 与本仓"幂等空转不产生新版本"一致：**按最终工作簿取值比对**（单元格取值 + merged + 活跃表），
 * 相同即 `changed: false`。这比"设了就算改"更严格，能挡住"把 A1 设成它已有的值"这类空转。
 *
 * ## 边界（如实登记）
 *
 * - 本文件是**纯函数**：零 IO、零墙钟、零随机数。
 * - 样式 / 条件格式 / 数据验证 / 图表 / 透视的**产品 op** 不在本包写权内（分属 X03/X06/X07/X08），
 *   本文件只把 X10 写权内的操作面接全；这几类能力在各自模块已有模型层，不改。
 * - `ADAPTER_OPERATION_NAMES` 是**故意**比 {@link PHONE_OPERATION_NAMES} 窄的子集：
 *   `/api/deliverables/**`（demo 入口）仍由既有测试
 *   `apps/demo/server/format-structure-e2e.test.ts` 断言 merge / move / 行列尺寸等**未接线**；
 *   为避免破坏该断言，legacy 适配器只暴露子集。手机会话（{@link ./transaction.js}）走全集。
 */

import { ValidationError } from '../../../protocol/index.js';
import {
  SPREADSHEET_ERROR_CODES,
  valuesEqual,
  type CellValue,
  type SpreadsheetErrorCode,
} from '../../../spreadsheets/value.js';
import {
  addSheet,
  getSheet,
  moveSheet,
  removeSheet,
  renameSheet,
  setActiveSheet,
  type WorkbookState,
} from '../../../spreadsheets/workbook.js';
import {
  clearCell,
  clearRange,
  copyColumns,
  copyRows,
  deleteColumns,
  deleteRows,
  getCellValue,
  insertColumns,
  insertRows,
  moveColumns,
  moveRows,
  setCellValue,
  type SheetState,
} from '../../../spreadsheets/sheet.js';
import { createCellsState, writeRange } from '../../../spreadsheets/cells.js';
import { createSheetLayout, mergeCells, unmergeCells } from '../../../spreadsheets/ranges.js';
import {
  applyFilter,
  dedupeRows,
  dropBlankRows,
  replaceInCells,
  sortRange,
  type FilterGroup,
  type SortDirection,
  type SortKey,
} from '../../../spreadsheets/sort-filter.js';
import { parseFilterGroup } from '../../../spreadsheets/data-ops/operations.js';
import type { AdapterEditResult } from '../../../session/adapter.js';
import type { XlsxDeliverableSource } from '../../../session/adapters/xlsx.js';

// ---------------------------------------------------------------------------
// 操作词汇（封闭枚举）
// ---------------------------------------------------------------------------

/** 取值 / 内容的七类判别联合（与 `CellValue` 同一套，不另造第二套词汇）。 */
export type SheetValueInput = CellValue;

/** 表格操作的封闭枚举（手机会话全集）。 */
export type SpreadsheetOperation =
  | { readonly op: 'set_cell'; readonly sheet: string; readonly address: string; readonly value: SheetValueInput }
  | { readonly op: 'clear_cell'; readonly sheet: string; readonly address: string }
  | {
      readonly op: 'set_range';
      readonly sheet: string;
      readonly top_left: string;
      readonly rows: readonly (readonly SheetValueInput[])[];
    }
  | { readonly op: 'clear_range'; readonly sheet: string; readonly range: string }
  | { readonly op: 'insert_rows'; readonly sheet: string; readonly at: number; readonly count: number }
  | { readonly op: 'delete_rows'; readonly sheet: string; readonly at: number; readonly count: number }
  | { readonly op: 'insert_columns'; readonly sheet: string; readonly at: number; readonly count: number }
  | { readonly op: 'delete_columns'; readonly sheet: string; readonly at: number; readonly count: number }
  | {
      /** X02 结构操作：复制 `[at, at+count-1]` 行到 `insert_at` 之前（`sheet.ts` `copyRows`）。 */
      readonly op: 'copy_rows';
      readonly sheet: string;
      readonly at: number;
      readonly count: number;
      readonly insert_at: number;
    }
  | {
      /** X02 结构操作：把 `[at, at+count-1]` 行移动到 row `to` 之前（`sheet.ts` `moveRows`）。 */
      readonly op: 'move_rows';
      readonly sheet: string;
      readonly at: number;
      readonly count: number;
      readonly to: number;
    }
  | {
      /** X02 结构操作：列版复制（`sheet.ts` `copyColumns`）。 */
      readonly op: 'copy_columns';
      readonly sheet: string;
      readonly at: number;
      readonly count: number;
      readonly insert_at: number;
    }
  | {
      /** X02 结构操作：列版移动（`sheet.ts` `moveColumns`）。 */
      readonly op: 'move_columns';
      readonly sheet: string;
      readonly at: number;
      readonly count: number;
      readonly to: number;
    }
  | { readonly op: 'merge_cells'; readonly sheet: string; readonly range: string }
  | { readonly op: 'unmerge_cells'; readonly sheet: string; readonly range: string }
  | {
      readonly op: 'sort_range';
      readonly sheet: string;
      readonly range: string;
      readonly keys: readonly SortKey[];
      readonly header?: boolean;
      readonly blanks?: 'first' | 'last';
    }
  | {
      /** X05 数据操作 filter：不命中的数据行整行删除（`sort-filter.ts` `applyFilter`）。 */
      readonly op: 'filter';
      readonly sheet: string;
      readonly range: string;
      readonly group: FilterGroup;
      readonly header?: boolean;
    }
  | {
      readonly op: 'dedupe_rows';
      readonly sheet: string;
      readonly range: string;
      readonly header?: boolean;
      readonly key_columns?: readonly number[];
    }
  | {
      /** X05 数据操作 dropBlankRows：区域内整行全空的数据行删除（`sort-filter.ts` `dropBlankRows`）。 */
      readonly op: 'drop_blank_rows';
      readonly sheet: string;
      readonly range: string;
      readonly header?: boolean;
    }
  | {
      readonly op: 'replace_in_range';
      readonly sheet: string;
      readonly range: string;
      readonly find: string;
      readonly replacement: string;
      readonly match_case?: boolean;
    }
  | { readonly op: 'add_sheet'; readonly name: string; readonly at?: number }
  | { readonly op: 'remove_sheet'; readonly name: string }
  | { readonly op: 'rename_sheet'; readonly from: string; readonly to: string }
  | { readonly op: 'set_active_sheet'; readonly name: string }
  | { readonly op: 'move_sheet'; readonly name: string; readonly to_index: number };

/** 手机会话暴露的全部操作名（有序；用于 schema 文档与契约核对）。 */
export const PHONE_OPERATION_NAMES = Object.freeze([
  'set_cell',
  'clear_cell',
  'set_range',
  'clear_range',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'merge_cells',
  'unmerge_cells',
  'sort_range',
  'dedupe_rows',
  'replace_in_range',
  'add_sheet',
  'remove_sheet',
  'rename_sheet',
  'set_active_sheet',
  'move_sheet',
  // X05 数据操作（本批补齐 filter / dropBlankRows；sort / dedupe / findReplace 见上）。
  'filter',
  'drop_blank_rows',
  // X02 结构复制 / 移动（本批补齐）。
  'copy_rows',
  'move_rows',
  'copy_columns',
  'move_columns',
] as const);

export type SpreadsheetOperationName = (typeof PHONE_OPERATION_NAMES)[number];

/**
 * **legacy demo 适配器**（`/api/deliverables/**`）暴露的子集。
 *
 * 刻意不含 `merge_cells` / `unmerge_cells` / `move_sheet`：`apps/demo/server/format-structure-e2e.test.ts`
 * 断言这三个 op 在该入口**未接线**（422 `unsupported`）。手机会话走全集，不受此限。
 */
export const ADAPTER_OPERATION_NAMES = Object.freeze([
  'set_cell',
  'clear_cell',
  'set_range',
  'clear_range',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'sort_range',
  'dedupe_rows',
  'replace_in_range',
  'add_sheet',
  'remove_sheet',
  'rename_sheet',
  'set_active_sheet',
] as const);

const PHONE_OPERATION_SET: ReadonlySet<string> = new Set(PHONE_OPERATION_NAMES);
const ADAPTER_OPERATION_SET: ReadonlySet<string> = new Set(ADAPTER_OPERATION_NAMES);

/** 该 op 名是否属于手机全集。 */
export function isPhoneOperation(name: string): name is SpreadsheetOperationName {
  return PHONE_OPERATION_SET.has(name);
}

/** 该 op 名是否属于 legacy 适配器子集。 */
export function isAdapterOperation(name: string): boolean {
  return ADAPTER_OPERATION_SET.has(name);
}

// ---------------------------------------------------------------------------
// 取值读取（R248：不猜、不折算）
// ---------------------------------------------------------------------------

/** 把裸 JSON 读成 `CellValue`；形状不合法 ⇒ `null`（调用方结构化成 `invalid_value`）。 */
export function readCellValue(raw: unknown): CellValue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  switch (record['kind']) {
    case 'blank':
      return Object.freeze({ kind: 'blank' as const });
    case 'number': {
      const value = record['value'];
      return typeof value === 'number' && Number.isFinite(value)
        ? Object.freeze({ kind: 'number' as const, value })
        : null;
    }
    case 'text': {
      const value = record['value'];
      return typeof value === 'string' ? Object.freeze({ kind: 'text' as const, value }) : null;
    }
    case 'boolean': {
      const value = record['value'];
      return typeof value === 'boolean' ? Object.freeze({ kind: 'boolean' as const, value }) : null;
    }
    case 'date': {
      const epoch = record['epoch_ms'];
      return typeof epoch === 'number' && Number.isFinite(epoch)
        ? Object.freeze({ kind: 'date' as const, epoch_ms: epoch })
        : null;
    }
    case 'error': {
      const code = record['code'];
      return typeof code === 'string' && (SPREADSHEET_ERROR_CODES as readonly string[]).includes(code)
        ? Object.freeze({ kind: 'error' as const, code: code as SpreadsheetErrorCode })
        : null;
    }
    case 'formula': {
      const text = record['text'];
      return typeof text === 'string' && text.length > 0
        ? Object.freeze({ kind: 'formula' as const, text })
        : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function invalid(kind: string, detail: string): AdapterEditResult<XlsxDeliverableSource> {
  return { ok: false, kind, detail };
}

function unsupportedDetail(op: string): string {
  return (
    `不支持的表格操作 ${JSON.stringify(op)}（封闭枚举：` + `${PHONE_OPERATION_NAMES.join(' / ')}）`
  );
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`);
  }
  return raw;
}

function requireInteger(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new ValidationError(`${field} 必须是整数`);
  }
  return raw;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 按表名换掉一张工作表（保持其余表与顺序不变；活跃表下标无需动）。 */
function replaceSheet(workbook: WorkbookState, name: string, next: SheetState): WorkbookState {
  return {
    sheets: workbook.sheets.map((sheet) => (sheet.name === name ? next : sheet)),
    active_sheet: workbook.active_sheet,
  };
}

function withWorkbook(source: XlsxDeliverableSource, workbook: WorkbookState): XlsxDeliverableSource {
  return Object.freeze({ workbook, residual: source.residual });
}

/** 两张工作表取值是否一致（单元格 + merged + 维度；与"是否产生新版本"挂钩）。 */
function sheetsEquivalent(a: SheetState, b: SheetState): boolean {
  if (a.name !== b.name) return false;
  if (a.row_count !== b.row_count || a.column_count !== b.column_count) return false;
  if (a.merged.length !== b.merged.length) return false;
  for (let index = 0; index < a.merged.length; index += 1) {
    if (a.merged[index] !== b.merged[index]) return false;
  }
  if (a.cells.size !== b.cells.size) return false;
  for (const [ref, value] of a.cells) {
    const other = b.cells.get(ref);
    if (other === undefined || !valuesEqual(value, other)) return false;
  }
  return true;
}

/** 两个工作簿是否取值等价（不改动 ⇒ changed: false，不产生新版本）。 */
export function workbooksEquivalent(a: WorkbookState, b: WorkbookState): boolean {
  if (a.active_sheet !== b.active_sheet) return false;
  if (a.sheets.length !== b.sheets.length) return false;
  for (let index = 0; index < a.sheets.length; index += 1) {
    const left = a.sheets[index];
    const right = b.sheets[index];
    /* c8 ignore next -- 长度已核对 */
    if (left === undefined || right === undefined) return false;
    if (!sheetsEquivalent(left, right)) return false;
  }
  return true;
}

function sheetOf(workbook: WorkbookState, name: string): SheetState {
  const sheet = getSheet(workbook, name);
  if (sheet === undefined) {
    throw new ValidationError(`没有工作表 ${JSON.stringify(name)}`);
  }
  return sheet;
}

/** 列号越界 / 方向非法等由 `sort-filter.ts` 抛错；这里只把 keys 形状读出来。 */
function readSortKeys(raw: unknown): readonly SortKey[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('sort_range 的 keys 必须是非空数组');
  }
  return raw.map((entry): SortKey => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ValidationError('sort_range 的每个 key 必须是对象');
    }
    const record = entry as Record<string, unknown>;
    const column = requireInteger(record['column'], 'sort_range.key.column');
    const direction = record['direction'];
    if (direction !== 'asc' && direction !== 'desc') {
      throw new ValidationError('sort_range.key.direction 只能是 asc / desc');
    }
    return { column, direction: direction as SortDirection };
  });
}

/** 读一个可选布尔字段（缺省 ⇒ `undefined`；非布尔 ⇒ 抛，不静默折算）。 */
function readOptionalBoolean(raw: unknown, where: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw new ValidationError(`${where} 必须是布尔`);
  return raw;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把一个表格操作作用到源上（**不可变**：返回新源，绝不就地改旧源）。
 *
 * @throws 不抛错——所有失败都结构化成 `{ ok: false }`（与 `DeliverableAdapter.applyEdit` 同口径）。
 */
export function applySpreadsheetOperation(
  source: XlsxDeliverableSource,
  operation: unknown,
): AdapterEditResult<XlsxDeliverableSource> {
  if (typeof operation !== 'object' || operation === null) {
    return invalid('invalid_edit', '编辑必须是一个对象');
  }
  const record = operation as Record<string, unknown>;
  const op = record['op'];
  if (typeof op !== 'string' || !isPhoneOperation(op)) {
    return invalid('unsupported_op', unsupportedDetail(typeof op === 'string' ? op : String(op)));
  }
  const workbook = source.workbook;
  try {
    switch (op) {
      case 'set_cell': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const address = requireString(record['address'], 'address');
        const value = readCellValue(record['value']);
        if (value === null) return invalid('invalid_value', INVALID_VALUE_DETAIL);
        const next = setCellValue(sheetOf(workbook, sheetName), address, value);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${address} 设为 ${value.kind}`]);
      }
      case 'clear_cell': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const address = requireString(record['address'], 'address');
        const next = clearCell(sheetOf(workbook, sheetName), address);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${address} 清空`]);
      }
      case 'set_range': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const topLeft = requireString(record['top_left'], 'top_left');
        const rows = readValueMatrix(record['rows']);
        const next = writeRange(createCellsState(sheetOf(workbook, sheetName)), topLeft, rows).sheet;
        return done(source, replaceSheet(workbook, sheetName, next), [
          `${sheetName}!${topLeft} 起写入 ${String(rows.length)} 行`,
        ]);
      }
      case 'clear_range': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const next = clearRange(sheetOf(workbook, sheetName), range);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 清空`]);
      }
      case 'insert_rows': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const next = insertRows(sheetOf(workbook, sheetName), at, count);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName} 第 ${String(at)} 行起插入 ${String(count)} 行`]);
      }
      case 'delete_rows': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const next = deleteRows(sheetOf(workbook, sheetName), at, count);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName} 第 ${String(at)} 行起删除 ${String(count)} 行`]);
      }
      case 'insert_columns': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const next = insertColumns(sheetOf(workbook, sheetName), at, count);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName} 第 ${String(at)} 列起插入 ${String(count)} 列`]);
      }
      case 'delete_columns': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const next = deleteColumns(sheetOf(workbook, sheetName), at, count);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName} 第 ${String(at)} 列起删除 ${String(count)} 列`]);
      }
      case 'copy_rows': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const insertAt = requireInteger(record['insert_at'], 'insert_at');
        const next = copyRows(sheetOf(workbook, sheetName), at, count, insertAt);
        return done(source, replaceSheet(workbook, sheetName, next), [
          `${sheetName} 复制第 ${String(at)} 行起 ${String(count)} 行到第 ${String(insertAt)} 行前`,
        ]);
      }
      case 'move_rows': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const to = requireInteger(record['to'], 'to');
        const next = moveRows(sheetOf(workbook, sheetName), at, count, to);
        return done(source, replaceSheet(workbook, sheetName, next), [
          `${sheetName} 移动第 ${String(at)} 行起 ${String(count)} 行到第 ${String(to)} 行前`,
        ]);
      }
      case 'copy_columns': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const insertAt = requireInteger(record['insert_at'], 'insert_at');
        const next = copyColumns(sheetOf(workbook, sheetName), at, count, insertAt);
        return done(source, replaceSheet(workbook, sheetName, next), [
          `${sheetName} 复制第 ${String(at)} 列起 ${String(count)} 列到第 ${String(insertAt)} 列前`,
        ]);
      }
      case 'move_columns': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const at = requireInteger(record['at'], 'at');
        const count = requireInteger(record['count'], 'count');
        const to = requireInteger(record['to'], 'to');
        const next = moveColumns(sheetOf(workbook, sheetName), at, count, to);
        return done(source, replaceSheet(workbook, sheetName, next), [
          `${sheetName} 移动第 ${String(at)} 列起 ${String(count)} 列到第 ${String(to)} 列前`,
        ]);
      }
      case 'merge_cells': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const next = mergeCells(createSheetLayout(sheetOf(workbook, sheetName)), range).sheet;
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 合并`]);
      }
      case 'unmerge_cells': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const next = unmergeCells(createSheetLayout(sheetOf(workbook, sheetName)), range).sheet;
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 拆分`]);
      }
      case 'sort_range': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const keys = readSortKeys(record['keys']);
        const options: { header?: boolean; blanks?: 'first' | 'last' } = {};
        if (record['header'] !== undefined) {
          if (typeof record['header'] !== 'boolean') throw new ValidationError('sort_range 的 header 必须是布尔');
          options.header = record['header'];
        }
        if (record['blanks'] !== undefined) {
          const blanks = record['blanks'];
          if (blanks !== 'first' && blanks !== 'last') throw new ValidationError("sort_range 的 blanks 只能是 'first' / 'last'");
          options.blanks = blanks;
        }
        const next = sortRange(sheetOf(workbook, sheetName), range, keys, options);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 排序（${String(keys.length)} 键）`]);
      }
      case 'filter': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        // group 的形状复用 X05 的严格反序列化（未知算子 / 越界列 / 非法嵌套一律抛）。
        const group = parseFilterGroup(record['group'], 'filter.group');
        const header = readOptionalBoolean(record['header'], 'filter 的 header');
        const next = applyFilter(sheetOf(workbook, sheetName), range, group, { header: header === true });
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 筛选`]);
      }
      case 'drop_blank_rows': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const header = readOptionalBoolean(record['header'], 'drop_blank_rows 的 header');
        const next = dropBlankRows(sheetOf(workbook, sheetName), range, { header: header === true });
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 删除空行`]);
      }
      case 'dedupe_rows': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const options: { header?: boolean; key_columns?: readonly number[] } = {};
        if (record['header'] !== undefined) {
          if (typeof record['header'] !== 'boolean') throw new ValidationError('dedupe_rows 的 header 必须是布尔');
          options.header = record['header'];
        }
        if (record['key_columns'] !== undefined) {
          const columns = record['key_columns'];
          if (!Array.isArray(columns) || columns.some((item) => !Number.isInteger(item))) {
            throw new ValidationError('dedupe_rows 的 key_columns 必须是整数数组');
          }
          options.key_columns = columns as number[];
        }
        const next = dedupeRows(sheetOf(workbook, sheetName), range, options);
        return done(source, replaceSheet(workbook, sheetName, next), [`${sheetName}!${range} 去重`]);
      }
      case 'replace_in_range': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const range = requireString(record['range'], 'range');
        const find = requireString(record['find'], 'find');
        const replacement = record['replacement'];
        if (typeof replacement !== 'string') throw new ValidationError('replace_in_range 的 replacement 必须是字符串');
        const matchCase = record['match_case'];
        if (matchCase !== undefined && typeof matchCase !== 'boolean') {
          throw new ValidationError('replace_in_range 的 match_case 必须是布尔');
        }
        const result = replaceInCells(sheetOf(workbook, sheetName), range, find, replacement, {
          match_case: matchCase === true,
        });
        return done(source, replaceSheet(workbook, sheetName, result.sheet), [
          `${sheetName}!${range} 替换 ${String(result.refs.length)} 格`,
        ]);
      }
      case 'add_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) !== undefined) {
          return invalid('duplicate_sheet', `工作表 ${JSON.stringify(name)} 已存在`);
        }
        const at = record['at'];
        const next = at === undefined ? addSheet(workbook, name) : addSheet(workbook, name, requireInteger(at, 'at'));
        return done(source, next, [`新增工作表 ${name}`]);
      }
      case 'remove_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) === undefined) {
          return invalid('unknown_sheet', `没有工作表 ${JSON.stringify(name)}`);
        }
        if (workbook.sheets.length <= 1) {
          return invalid('last_sheet', LAST_SHEET_DETAIL);
        }
        return done(source, removeSheet(workbook, name), [`删除工作表 ${name}`]);
      }
      case 'rename_sheet': {
        const from = requireString(record['from'], 'from');
        const to = requireString(record['to'], 'to');
        if (getSheet(workbook, from) === undefined) {
          return invalid('unknown_sheet', `没有工作表 ${JSON.stringify(from)}`);
        }
        return done(source, renameSheet(workbook, from, to), [`工作表 ${from} 改名为 ${to}`]);
      }
      case 'set_active_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) === undefined) {
          return invalid('unknown_sheet', `没有工作表 ${JSON.stringify(name)}`);
        }
        return done(source, setActiveSheet(workbook, name), [`活跃表切到 ${name}`]);
      }
      case 'move_sheet': {
        const name = requireString(record['name'], 'name');
        const toIndex = requireInteger(record['to_index'], 'to_index');
        if (getSheet(workbook, name) === undefined) {
          return invalid('unknown_sheet', `没有工作表 ${JSON.stringify(name)}`);
        }
        return done(source, moveSheet(workbook, name, toIndex), [`工作表 ${name} 移到下标 ${String(toIndex)}`]);
      }
      /* c8 ignore next 2 -- op 已由 isPhoneOperation 收窄，default 仅为类型完备 */
      default:
        return invalid('unsupported_op', unsupportedDetail(op));
    }
  } catch (error) {
    // 底层纯函数以抛错表达形状问题（非法地址 / 非法表名 / 越界 / 悬空引用）：
    // **结构化成编辑失败**，而不是让异常穿出会话层（那会绕过"源零改动"的承诺）。
    return invalid('invalid_edit', describe(error));
  }
}

const INVALID_VALUE_DETAIL =
  'value 不是合法的单元格取值（只能是 blank / number / text / boolean / date / error / formula）';
const LAST_SHEET_DETAIL = '这是最后一张工作表：删除会让工作簿不合法（R250 要求至少一张真实表）';

/** 读二维取值矩阵（`set_range` 用）。 */
function readValueMatrix(raw: unknown): readonly (readonly CellValue[])[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('set_range 的 rows 至少需要一行取值');
  }
  return raw.map((line): readonly CellValue[] => {
    if (!Array.isArray(line)) {
      throw new ValidationError('set_range 的每一行都必须是取值数组');
    }
    return line.map((cell): CellValue => {
      const value = readCellValue(cell);
      if (value === null) throw new ValidationError(INVALID_VALUE_DETAIL);
      return value;
    });
  });
}

function done(
  source: XlsxDeliverableSource,
  workbook: WorkbookState,
  notes: readonly string[],
): AdapterEditResult<XlsxDeliverableSource> {
  return {
    ok: true,
    source: withWorkbook(source, workbook),
    changed: !workbooksEquivalent(source.workbook, workbook),
    notes: Object.freeze([...notes]),
  };
}

/** 便捷入口：从零建一份源（供手机会话 / 测试用；`residual` 为空）。 */
export function emptySource(
  workbook: WorkbookState,
  residual: XlsxDeliverableSource['residual'],
): XlsxDeliverableSource {
  return Object.freeze({ workbook, residual });
}
