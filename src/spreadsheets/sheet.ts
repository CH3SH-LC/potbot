/**
 * 表格域：工作表状态与操作层（design-06-P8 / XLS-03、XLS-04、XLS-10）。
 *
 * ## 状态形状
 *
 * 一张表 = 名字 + 单元格字典（key 用 A1 地址）+ 尺寸 + 冻结/合并元数据。**不可变**：
 * 每个操作返回新的 `SheetState`，旧状态原样保留——这正是 XLS-17「失败保旧」与
 * XLS-13「保留历史版本」在模型层的前提：一次操作要么成功给出新状态，要么抛错，**绝不半改**。
 *
 * ## 行列增删：单元格键与公式文本一起迁移（XLS-04）
 *
 * 插入/删除行列时，**两件事必须同步发生**：单元格自己的地址要动，公式里指向别处的引用也要动。
 * 只做前者会让公式静默指错行；只做后者会留下孤儿单元格。
 *
 * ## 公式迁移受阻时：**保留原文 + 登记**，不伪造
 *
 * `LOG10(` 这类公式无法被安全改写（见 `formula.ts` 文件头）。此时本模块**逐字保留**原公式文本，
 * 把该单元格（迁移后的新地址）记进 {@link SheetState.migration_blocked}。
 * 这是 XLS-08「不支持的公式**保留**或阻塞」的"保留"分支：既没有编一个新引用，也没有把公式丢掉，
 * 而且受阻位置**可被调用方指认**。取巧地"猜一个新引用"才叫伪造。
 */

import { ValidationError } from '../protocol/index.js';
import { mapFormulaColumns, mapFormulaRows } from './formula.js';
import {
  formatCellAddress,
  formatCellReference,
  parseCellAddress,
  parseCellReference,
  parseRange,
  type CellAddress,
  type CellRange,
  type CellReference,
} from './reference.js';
import { blank, formulaValue, isFormula, type CellValue, valuesEqual } from './value.js';

/** Excel 工作表名长度上限（与 `xlsx.ts` 同口径）。 */
export const MAX_SHEET_NAME_LENGTH = 31;

/** Excel 工作表名禁用字符：`[ ] : * ? / \`。 */
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/;

/** 工作表状态（不可变）。 */
export interface SheetState {
  readonly name: string;
  readonly hidden: boolean;
  /** 单元格字典：key 为 A1 地址（如 `"B3"`）。 */
  readonly cells: ReadonlyMap<string, CellValue>;
  readonly row_count: number;
  readonly column_count: number;
  readonly frozen_rows: number;
  readonly frozen_columns: number;
  /** 合并区域（A1 记法，如 `"A1:C3"`），归一化后存储。 */
  readonly merged: readonly string[];
  /** 公式迁移受阻的单元格地址（迁移**后**的 A1 地址）；空数组表示无受阻。 */
  readonly migration_blocked: readonly string[];
}

/** 创建选项。 */
export interface SheetOptions {
  readonly row_count?: number;
  readonly column_count?: number;
  readonly hidden?: boolean;
  readonly frozen_rows?: number;
  readonly frozen_columns?: number;
  readonly merged?: readonly string[];
}

/** 工作表名合法性（非空、≤31 字符、不含 Excel 禁用字符）。 */
export function isValidSheetName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_SHEET_NAME_LENGTH &&
    !SHEET_NAME_FORBIDDEN.test(name)
  );
}

function requireSheetName(name: unknown, where: string): string {
  if (!isValidSheetName(name)) {
    throw new ValidationError(
      `${where} 的工作表名非法（须非空、≤${String(MAX_SHEET_NAME_LENGTH)} 字符、不含 [ ] : * ? / \\）：${JSON.stringify(name)}`,
    );
  }
  return name;
}

/** 地址输入：结构化地址或 A1 文本。 */
export type AddressInput = CellAddress | string;

/** 归一化地址为 A1 文本（顺带校验）。@throws {ValidationError} */
export function normalizeAddress(address: AddressInput): string {
  if (typeof address === 'string') {
    return formatCellAddress(parseCellAddress(address));
  }
  return formatCellAddress(address);
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} 必须是 ≥1 的整数，收到 ${String(value)}`);
  }
  return value;
}

/** 创建一个空工作表。@throws {ValidationError} 名字/尺寸/冻结/合并非法 */
export function createSheet(name: string, options: SheetOptions = {}): SheetState {
  const sheetName = requireSheetName(name, 'createSheet');
  const rowCount = requirePositiveInt(options.row_count ?? 1000, 'row_count');
  const columnCount = requirePositiveInt(options.column_count ?? 26, 'column_count');
  const frozenRows = options.frozen_rows ?? 0;
  const frozenColumns = options.frozen_columns ?? 0;
  if (!Number.isInteger(frozenRows) || frozenRows < 0) {
    throw new ValidationError(`frozen_rows 必须是非负整数，收到 ${String(frozenRows)}`);
  }
  if (!Number.isInteger(frozenColumns) || frozenColumns < 0) {
    throw new ValidationError(`frozen_columns 必须是非负整数，收到 ${String(frozenColumns)}`);
  }
  const merged = (options.merged ?? []).map((text) => {
    const range = parseRange(text);
    return formatRangeText(range);
  });
  return Object.freeze({
    name: sheetName,
    hidden: options.hidden ?? false,
    cells: new Map<string, CellValue>(),
    row_count: rowCount,
    column_count: columnCount,
    frozen_rows: frozenRows,
    frozen_columns: frozenColumns,
    merged: Object.freeze(merged),
    migration_blocked: Object.freeze([]) as readonly string[],
  });
}

function formatRangeText(range: CellRange): string {
  const start = formatCellAddress({ column: range.start.column, row: range.start.row });
  const end = formatCellAddress({ column: range.end.column, row: range.end.row });
  return start === end ? start : `${start}:${end}`;
}

/** 复制（浅）工作表但换名字与单元格字典。 */
function withSheet(sheet: SheetState, patch: Partial<SheetState>): SheetState {
  return Object.freeze({ ...sheet, ...patch });
}

/** 读单元格：未设置 ⇒ `blank`（**不是 0**，R248）。@throws {ValidationError} 地址非法 */
export function getCellValue(sheet: SheetState, address: AddressInput): CellValue {
  return sheet.cells.get(normalizeAddress(address)) ?? blank;
}

/** 是否已显式设置过该单元格（用于区分"显式空白"与"从未设置"）。@throws {ValidationError} */
export function hasCell(sheet: SheetState, address: AddressInput): boolean {
  return sheet.cells.has(normalizeAddress(address));
}

function validateCellValue(value: CellValue): CellValue {
  if (value === null || typeof value !== 'object' || typeof value.kind !== 'string') {
    throw new ValidationError('单元格取值必须是 CellValue（判别联合）');
  }
  return value;
}

/** 写单元格，返回新状态。@throws {ValidationError} 地址或取值非法 */
export function setCellValue(sheet: SheetState, address: AddressInput, value: CellValue): SheetState {
  const ref = normalizeAddress(address);
  const next = new Map(sheet.cells);
  next.set(ref, validateCellValue(value));
  return withSheet(sheet, { cells: next });
}

/** 清空单元格（删除条目，读回变 `blank`）。@throws {ValidationError} */
export function clearCell(sheet: SheetState, address: AddressInput): SheetState {
  const ref = normalizeAddress(address);
  if (!sheet.cells.has(ref)) {
    return sheet;
  }
  const next = new Map(sheet.cells);
  next.delete(ref);
  return withSheet(sheet, { cells: next });
}

/** 清空区域内全部单元格。@throws {ValidationError} */
export function clearRange(sheet: SheetState, range: CellRange | string): SheetState {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  const next = new Map(sheet.cells);
  for (const ref of sheet.cells.keys()) {
    const address = parseCellAddress(ref);
    if (
      address.column >= resolved.start.column &&
      address.column <= resolved.end.column &&
      address.row >= resolved.start.row &&
      address.row <= resolved.end.row
    ) {
      next.delete(ref);
    }
  }
  return withSheet(sheet, { cells: next });
}

/** 冻结窗格（0 表示不冻结）。@throws {ValidationError} */
export function setFrozenPanes(sheet: SheetState, rows: number, columns: number): SheetState {
  if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(columns) || columns < 0) {
    throw new ValidationError('冻结行列数必须是非负整数');
  }
  return withSheet(sheet, { frozen_rows: rows, frozen_columns: columns });
}

/** 单元格条目（按行、列排序的稳定顺序）。 */
export function sheetEntries(sheet: SheetState): readonly { ref: string; value: CellValue }[] {
  const entries = [...sheet.cells.entries()].map(([ref, value]) => {
    const address = parseCellAddress(ref);
    return { ref, value, sort: address.row * 1_000_000 + address.column };
  });
  entries.sort((a, b) => a.sort - b.sort);
  return Object.freeze(
    entries.map((entry) => Object.freeze({ ref: entry.ref, value: entry.value })),
  );
}

interface MigrationOutcome {
  readonly cells: ReadonlyMap<string, CellValue>;
  readonly blocked: readonly string[];
}

type AddressMapper = (address: CellAddress) => { ok: true; address: CellAddress } | { ok: false };
type FormulaMapper = (text: string) => { ok: true; text: string } | { ok: false; reason: string };

/**
 * 迁移全部单元格：地址按 `mapAddress` 动，公式文本按 `mapFormula` 动。
 * 公式**无法安全改写**时：原文逐字保留、地址照动、把新地址记进 `blocked`。
 */
function migrateCells(
  sheet: SheetState,
  mapAddress: AddressMapper,
  mapFormula: FormulaMapper,
): MigrationOutcome {
  const next = new Map<string, CellValue>();
  const blocked: string[] = [];
  for (const [ref, value] of sheet.cells) {
    const mapped = mapAddress(parseCellAddress(ref));
    if (!mapped.ok) {
      continue; // 该单元格落在被删区间内 ⇒ 随行列一起消失
    }
    const newRef = formatCellAddress(mapped.address);
    if (isFormula(value)) {
      const migrated = mapFormula(value.text);
      if (migrated.ok) {
        next.set(newRef, formulaValue(migrated.text));
      } else {
        next.set(newRef, value); // 保留原文，不伪造
        blocked.push(newRef);
      }
      continue;
    }
    next.set(newRef, value);
  }
  return { cells: next, blocked };
}

function finalize(
  sheet: SheetState,
  outcome: MigrationOutcome,
  patch: Partial<SheetState>,
): SheetState {
  return withSheet(sheet, {
    cells: outcome.cells,
    migration_blocked: Object.freeze(outcome.blocked),
    ...patch,
  });
}

/** 在第 `at` 行前插入 `count` 行。@throws {ValidationError} */
export function insertRows(sheet: SheetState, at: number, count: number): SheetState {
  assertMutation(at, count, 'insertRows');
  const mapAddress: AddressMapper = (address) =>
    address.row < at
      ? { ok: true, address }
      : { ok: true, address: { column: address.column, row: address.row + count } };
  const mapFormula: FormulaMapper = (text) => mapFormulaRows(text, at, count, 'insert');
  const outcome = migrateCells(sheet, mapAddress, mapFormula);
  const merged = sheet.merged.map((text) => shiftMergedOnInsert(text, at, count, 'row'));
  return finalize(sheet, outcome, {
    row_count: sheet.row_count + count,
    merged,
  });
}

/** 从第 `at` 行开始删除 `count` 行。@throws {ValidationError} */
export function deleteRows(sheet: SheetState, at: number, count: number): SheetState {
  assertMutation(at, count, 'deleteRows');
  const lastDeleted = at + count - 1;
  const mapAddress: AddressMapper = (address) => {
    if (address.row >= at && address.row <= lastDeleted) {
      return { ok: false };
    }
    if (address.row > lastDeleted) {
      return { ok: true, address: { column: address.column, row: address.row - count } };
    }
    return { ok: true, address };
  };
  const mapFormula: FormulaMapper = (text) => mapFormulaRows(text, at, count, 'delete');
  const outcome = migrateCells(sheet, mapAddress, mapFormula);
  const merged = sheet.merged.map((text) => shiftMergedOnDelete(text, at, count, 'row'));
  return finalize(sheet, outcome, {
    row_count: Math.max(1, sheet.row_count - count),
    merged,
  });
}

/** 在第 `at` 列前插入 `count` 列。@throws {ValidationError} */
export function insertColumns(sheet: SheetState, at: number, count: number): SheetState {
  assertMutation(at, count, 'insertColumns');
  const mapAddress: AddressMapper = (address) =>
    address.column < at
      ? { ok: true, address }
      : { ok: true, address: { column: address.column + count, row: address.row } };
  const mapFormula: FormulaMapper = (text) => mapFormulaColumns(text, at, count, 'insert');
  const outcome = migrateCells(sheet, mapAddress, mapFormula);
  const merged = sheet.merged.map((text) => shiftMergedOnInsert(text, at, count, 'column'));
  return finalize(sheet, outcome, {
    column_count: sheet.column_count + count,
    merged,
  });
}

/** 从第 `at` 列开始删除 `count` 列。@throws {ValidationError} */
export function deleteColumns(sheet: SheetState, at: number, count: number): SheetState {
  assertMutation(at, count, 'deleteColumns');
  const lastDeleted = at + count - 1;
  const mapAddress: AddressMapper = (address) => {
    if (address.column >= at && address.column <= lastDeleted) {
      return { ok: false };
    }
    if (address.column > lastDeleted) {
      return { ok: true, address: { column: address.column - count, row: address.row } };
    }
    return { ok: true, address };
  };
  const mapFormula: FormulaMapper = (text) => mapFormulaColumns(text, at, count, 'delete');
  const outcome = migrateCells(sheet, mapAddress, mapFormula);
  const merged = sheet.merged.map((text) => shiftMergedOnDelete(text, at, count, 'column'));
  return finalize(sheet, outcome, {
    column_count: Math.max(1, sheet.column_count - count),
    merged,
  });
}

function assertMutation(at: number, count: number, where: string): void {
  if (!Number.isInteger(at) || at < 1) {
    throw new ValidationError(`${where} 的 at 必须是 ≥1 的整数，收到 ${String(at)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${where} 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
}

function shiftMergedOnInsert(
  text: string,
  at: number,
  count: number,
  axis: 'row' | 'column',
): string {
  const range = parseRange(text);
  const start = axis === 'row' ? range.start.row : range.start.column;
  const end = axis === 'row' ? range.end.row : range.end.column;
  if (start >= at) {
    return formatRangeText(shiftRange(range, axis, count));
  }
  if (end >= at) {
    // 插入点落在合并区内 ⇒ 合并区被撑大
    return formatRangeText(extendRangeEnd(range, axis, count));
  }
  return formatRangeText(range);
}

function shiftRange(range: CellRange, axis: 'row' | 'column', delta: number): CellRange {
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

function extendRangeEnd(range: CellRange, axis: 'row' | 'column', delta: number): CellRange {
  if (axis === 'row') {
    return { start: range.start, end: { ...range.end, row: range.end.row + delta } };
  }
  return { start: range.start, end: { ...range.end, column: range.end.column + delta } };
}

function shiftMergedOnDelete(
  text: string,
  at: number,
  count: number,
  axis: 'row' | 'column',
): string {
  const range = parseRange(text);
  const start = axis === 'row' ? range.start.row : range.start.column;
  const end = axis === 'row' ? range.end.row : range.end.column;
  const lastDeleted = at + count - 1;
  if (start > lastDeleted) {
    return formatRangeText(shiftRange(range, axis, -count));
  }
  if (start >= at && end <= lastDeleted) {
    return ''; // 整个合并区被删光
  }
  if (end < at) {
    return formatRangeText(range);
  }
  throw new ValidationError(
    `删除行列与合并区 ${text} 部分重叠：骨架不猜测应如何拆分合并区，显式阻塞（XLS-10）`,
  );
}

/**
 * 迁移公式文本（供上层在结构变更时调用）。返回新文本，或因无法安全改写而 `null`。
 * 本函数把 `formula.ts` 的阻塞结论暴露给工作表调用方。
 */
export function migrateFormulaText(
  text: string,
  axis: 'row' | 'column',
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const result =
    axis === 'row'
      ? mapFormulaRows(text, at, count, mode)
      : mapFormulaColumns(text, at, count, mode);
  return result.ok ? { ok: true, text: result.text } : { ok: false, reason: result.reason };
}

/** 在同一工作表内，用引用迁移结果改写公式单元格（供上层组合使用）。@throws {ValidationError} */
export function rewriteFormula(
  sheet: SheetState,
  address: AddressInput,
  nextText: string,
): SheetState {
  const ref = normalizeAddress(address);
  return setCellValue(sheet, ref, formulaValue(nextText));
}

/** 两个单元格是否同值（类型严格；`blank` 只等于 `blank`）。@throws {ValidationError} */
export function cellsEqual(
  sheet: SheetState,
  left: AddressInput,
  right: AddressInput,
): boolean {
  return valuesEqual(getCellValue(sheet, left), getCellValue(sheet, right));
}

// ---------------------------------------------------------------------------
// 行列复制 / 移动（XLS-02–04；design-06-P8）
//
// `insertRows` / `deleteRows` 已覆盖"插删"；本段补上验收句里的"复制 / 移动"。
//
// ## 复制 vs 移动：两套**不同**的引用语义
//
// - **复制**：把源区间的内容抄一份到新位置，源区间**保留**。位置按"插入"语义迁移
//   （插入点及之后下移），而**被抄的公式**按 Excel 的复制语义**整体平移**相对引用
//   （`A3` 抄到第 10 行 ⇒ `A10`）——这正是 `$` 固定要挡住的那种位移。
// - **移动**：截取源区间放到目标位置，源区间**消失**。引用是**分段映射**：指向被移动
//   区间的引用**跟着新区间走**，指向两者之间的引用被压缩，其余不动。这与"复制 + 删除"
//   的复合**不等价**（那会把指向区间外的引用也一起平移），因此这里单独实现。
//
// ## 宁阻塞不伪造
//
// 公式改写沿既有 `formula.ts` 的保守口径（同一条 `\$?[A-Za-z]{1,3}\$?\d{1,7}` 扫描 +
// 同样的双引号 / 相邻标识符 / 函数名三条安全判定）：一旦拿不准，**逐字保留原文**并把
// 迁移后的地址记进 {@link SheetState.migration_blocked}，绝不猜一个新引用。
// ---------------------------------------------------------------------------

/** 轴（行 / 列）。 */
type Axis = 'row' | 'column';

function axisPosition(address: CellAddress, axis: Axis): number {
  return axis === 'row' ? address.row : address.column;
}

function withAxisPosition(address: CellAddress, axis: Axis, position: number): CellAddress {
  return axis === 'row'
    ? { column: address.column, row: position }
    : { column: position, row: address.row };
}

/** 与 {@link withAxisPosition} 同，但保留 `$` 绝对标记（用于合并区文本）。 */
function withAxisPositionOnReference(
  reference: CellReference,
  axis: Axis,
  position: number,
): CellReference {
  return axis === 'row'
    ? { column: reference.column, row: position, abs_column: reference.abs_column, abs_row: reference.abs_row }
    : { column: position, row: reference.row, abs_column: reference.abs_column, abs_row: reference.abs_row };
}

/** 位置映射结果：给出新位置，或说明为何无法安全改写。 */
type AxisPositionMapResult =
  | { readonly ok: true; readonly position: number }
  | { readonly ok: false; readonly reason: string };

type AxisPositionMap = (position: number) => AxisPositionMapResult;

/** 引号 / 相邻字符的保守判定与 `formula.ts` 完全同口径（那侧的扫描器未导出）。 */
const REFERENCE_TOKEN_PATTERN = /\$?[A-Za-z]{1,3}\$?\d{1,7}/g;

/**
 * 把公式文本里每个**可安全识别**的引用按 `axis` 轴的位置映射重写。
 *
 * 与 `formula.ts` 的 `mapFormulaRows` / `mapFormulaColumns` 同一套安全规则（那侧的扫描器
 * 是私有的，且本包不得改 `formula.ts`），因此：
 * - 公式含双引号字面量 ⇒ 阻塞；
 * - 候选 token 紧邻标识符字符 / 位于 `(` 之前（函数名形状）⇒ 阻塞；
 * - 候选不是合法引用 ⇒ 阻塞；
 * - 映射本身失败（越界 / 落到被删区间）⇒ 阻塞。
 *
 * 只识别 `A1` 形状的单元格引用，**不**识别整列 `A:A` / 整行 `1:1`（与 `formula.ts` 同）。
 */
function remapFormulaAxis(
  text: string,
  axis: Axis,
  map: AxisPositionMap,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  if (text.includes('"')) {
    return { ok: false, reason: '公式含双引号字符串字面量，无法安全区分引用与字面量内容，整体阻塞' };
  }
  const pattern = new RegExp(REFERENCE_TOKEN_PATTERN.source, 'g');
  let output = '';
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const before = start > 0 ? text.charAt(start - 1) : '';
    const after = end < text.length ? text.charAt(end) : '';
    if (before !== '' && /[A-Za-z0-9_.]/.test(before)) {
      return { ok: false, reason: `候选 ${token} 紧跟在标识符字符 ${JSON.stringify(before)} 之后，可能是更长名字的一部分` };
    }
    if (after !== '' && /[A-Za-z0-9_(]/.test(after)) {
      return { ok: false, reason: `候选 ${token} 紧跟 ${JSON.stringify(after)}，可能是函数名或更长名字的一部分` };
    }
    let reference: CellReference;
    try {
      reference = parseCellReference(token);
    } catch {
      return { ok: false, reason: `候选 ${token} 不是合法单元格引用` };
    }
    const mapped = map(axisPosition(reference, axis));
    if (!mapped.ok) {
      return { ok: false, reason: mapped.reason };
    }
    output += text.slice(last, start) + formatCellReference(withAxisPositionOnReference(reference, axis, mapped.position));
    last = end;
    match = pattern.exec(text);
  }
  output += text.slice(last);
  return { ok: true, text: output };
}

function axisLimit(sheet: SheetState, axis: Axis): number {
  return axis === 'row' ? sheet.row_count : sheet.column_count;
}

function assertAxisMutation(sheet: SheetState, axis: Axis, at: number, count: number, where: string): void {
  assertMutation(at, count, where);
  const limit = axisLimit(sheet, axis);
  if (at + count - 1 > limit) {
    throw new ValidationError(
      `${where} 的源区间 ${String(at)}…${String(at + count - 1)} 超出工作表${axis === 'row' ? '行' : '列'}数 ${String(limit)}`,
    );
  }
}

/**
 * "把 `[at, at+count-1]` 整体移到 row/column `to` 之前"的位置映射。
 *
 * 纯函数、与工作表无关；供公式迁移与外部几何迁移共用，保证二者永远同进同退。
 * 参数合法性由调用方（{@link moveRows} / {@link moveColumns}）先行校验。
 */
export function mapMovePosition(position: number, at: number, count: number, to: number): number {
  if (to > at) {
    const destination = to - count;
    if (position < at) return position;
    if (position <= at + count - 1) return position - at + destination;
    if (position < to) return position - count;
    return position;
  }
  if (position < to) return position;
  if (position < at) return position + count;
  if (position <= at + count - 1) return to + (position - at);
  return position;
}

function moveMappedText(text: string, axis: Axis, at: number, count: number, to: number): string {
  const range = parseRange(text);
  const startPosition = axisPosition(range.start, axis);
  const endPosition = axisPosition(range.end, axis);
  const newStart = mapMovePosition(startPosition, at, count, to);
  for (let position = startPosition; position <= endPosition; position += 1) {
    if (mapMovePosition(position, at, count, to) !== newStart + (position - startPosition)) {
      throw new ValidationError(
        `移动行列与合并区 ${text} 交叠：骨架不猜测应如何拆分合并区，显式阻塞（XLS-10）`,
      );
    }
  }
  const start = withAxisPositionOnReference(range.start, axis, newStart);
  const end = withAxisPositionOnReference(range.end, axis, newStart + (endPosition - startPosition));
  return formatRangeText({ start, end });
}

function dedupe(list: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(list)]);
}

/**
 * 复制 `[at, at+count-1]` 一段行 / 列到 `insertAt` 之前（值 / 公式 / 合并区一起复制）。
 *
 * 语义与 Excel「复制整行后插入复制单元格」一致：源区间**保留**，插入点及之后下移，
 * 副本里的公式按**复制语义**平移相对引用。`insertAt` 落在源区间**内部** ⇒ 显式阻塞
 * （会与自身部分重叠，语义不明确，不猜）。
 *
 * @throws {ValidationError}
 */
export function copyRows(sheet: SheetState, at: number, count: number, insertAt: number): SheetState {
  return copyAxis(sheet, 'row', at, count, insertAt, 'copyRows');
}

/** 复制一段列，语义同 {@link copyRows}。@throws {ValidationError} */
export function copyColumns(sheet: SheetState, at: number, count: number, insertAt: number): SheetState {
  return copyAxis(sheet, 'column', at, count, insertAt, 'copyColumns');
}

function copyAxis(
  sheet: SheetState,
  axis: Axis,
  at: number,
  count: number,
  insertAt: number,
  where: string,
): SheetState {
  assertAxisMutation(sheet, axis, at, count, where);
  const limit = axisLimit(sheet, axis);
  if (!Number.isInteger(insertAt) || insertAt < 1 || insertAt > limit + 1) {
    throw new ValidationError(`${where} 的插入点越界：${String(insertAt)}`);
  }
  if (insertAt > at && insertAt < at + count) {
    throw new ValidationError(`${where}：插入点落在被复制区间内部，会与自身部分重叠，语义不明确，显式阻塞`);
  }

  const last = at + count - 1;
  const snapshot: { readonly address: CellAddress; readonly value: CellValue }[] = [];
  for (const [ref, value] of sheet.cells) {
    const address = parseCellAddress(ref);
    const position = axisPosition(address, axis);
    if (position >= at && position <= last) snapshot.push({ address, value });
  }
  const sourceMerges = sheet.merged.filter((text) => {
    const range = parseRange(text);
    return axisPosition(range.start, axis) >= at && axisPosition(range.end, axis) <= last;
  });

  const shifted = axis === 'row' ? insertRows(sheet, insertAt, count) : insertColumns(sheet, insertAt, count);
  const delta = insertAt - at;
  const cells = new Map(shifted.cells);
  const blocked: string[] = [...shifted.migration_blocked];
  for (const entry of snapshot) {
    const position = axisPosition(entry.address, axis);
    const ref = formatCellAddress(withAxisPosition(entry.address, axis, insertAt + (position - at)));
    if (isFormula(entry.value)) {
      const copied = remapFormulaAxis(entry.value.text, axis, (value) => ({ ok: true, position: value + delta }));
      if (copied.ok) {
        cells.set(ref, formulaValue(copied.text));
      } else {
        cells.set(ref, entry.value); // 保留原文，不伪造
        blocked.push(ref);
      }
    } else {
      cells.set(ref, entry.value);
    }
  }

  const merged = new Set(shifted.merged);
  for (const text of sourceMerges) {
    const range = parseRange(text);
    const start = withAxisPositionOnReference(range.start, axis, axisPosition(range.start, axis) + delta);
    const end = withAxisPositionOnReference(range.end, axis, axisPosition(range.end, axis) + delta);
    merged.add(formatRangeText({ start, end }));
  }

  return Object.freeze({
    ...shifted,
    cells,
    merged: Object.freeze([...merged]),
    migration_blocked: dedupe(blocked),
  });
}

/**
 * 把 `[at, at+count-1]` 一段行移动到 row `to` **之前**（`to` 用**原始**行号表达）。
 *
 * - `to === at` 或 `to === at + count` ⇒ 恒等（原地不动）；
 * - `to` 落在源区间**内部**（`at < to < at+count`）⇒ 显式阻塞；
 * - 指向被移动区间的引用**跟着区间走**；区间与目标之间的引用被压缩；其余不动。
 *
 * @throws {ValidationError}
 */
export function moveRows(sheet: SheetState, at: number, count: number, to: number): SheetState {
  return moveAxis(sheet, 'row', at, count, to, 'moveRows');
}

/** 移动一段列，语义同 {@link moveRows}。@throws {ValidationError} */
export function moveColumns(sheet: SheetState, at: number, count: number, to: number): SheetState {
  return moveAxis(sheet, 'column', at, count, to, 'moveColumns');
}

function moveAxis(
  sheet: SheetState,
  axis: Axis,
  at: number,
  count: number,
  to: number,
  where: string,
): SheetState {
  assertAxisMutation(sheet, axis, at, count, where);
  const limit = axisLimit(sheet, axis);
  if (!Number.isInteger(to) || to < 1 || to > limit + 1) {
    throw new ValidationError(`${where} 的目标位置越界：${String(to)}`);
  }
  if (to > at && to < at + count) {
    throw new ValidationError(`${where}：目标位置落在被移动区间内部，会与自身重叠，显式阻塞`);
  }
  if (to === at || to === at + count) {
    return sheet; // 恒等
  }

  const map: AxisPositionMap = (position) => ({ ok: true, position: mapMovePosition(position, at, count, to) });
  const cells = new Map<string, CellValue>();
  const blocked: string[] = [];
  for (const [ref, value] of sheet.cells) {
    const address = parseCellAddress(ref);
    const newRef = formatCellAddress(withAxisPosition(address, axis, mapMovePosition(axisPosition(address, axis), at, count, to)));
    if (isFormula(value)) {
      const moved = remapFormulaAxis(value.text, axis, map);
      if (moved.ok) {
        cells.set(newRef, formulaValue(moved.text));
      } else {
        cells.set(newRef, value); // 保留原文，不伪造
        blocked.push(newRef);
      }
    } else {
      cells.set(newRef, value);
    }
  }

  const merged = sheet.merged.map((text) => moveMappedText(text, axis, at, count, to));
  return Object.freeze({ ...sheet, cells, merged: Object.freeze(merged), migration_blocked: dedupe(blocked) });
}

// ---------------------------------------------------------------------------
// 结构化操作 schema（XLS-02–04；供命令信封 payload 承载）
//
// 把"插 / 删 / 复制 / 移动行或列"收成一个**可 JSON 往返**的判别联合，外加
// `parseStructuralOperation`（校验外部 JSON）与 `applyStructuralOperation`（派发）。
// 这样一条命令（`README` §5 的 `operation + payload`）可以只带纯数据，而不必传函数。
// ---------------------------------------------------------------------------

/** 结构化操作（纯数据、可 JSON 往返）。 */
export type StructuralOperation =
  | { readonly op: 'insert_rows'; readonly at: number; readonly count: number }
  | { readonly op: 'delete_rows'; readonly at: number; readonly count: number }
  | { readonly op: 'copy_rows'; readonly at: number; readonly count: number; readonly insert_at: number }
  | { readonly op: 'move_rows'; readonly at: number; readonly count: number; readonly to: number }
  | { readonly op: 'insert_columns'; readonly at: number; readonly count: number }
  | { readonly op: 'delete_columns'; readonly at: number; readonly count: number }
  | { readonly op: 'copy_columns'; readonly at: number; readonly count: number; readonly insert_at: number }
  | { readonly op: 'move_columns'; readonly at: number; readonly count: number; readonly to: number };

/** 结构化操作名（封闭枚举）。 */
export type StructuralOperationKind = StructuralOperation['op'];

/** 全部结构化操作名（供校验与遍历，顺序即枚举顺序）。 */
export const STRUCTURAL_OPERATION_KINDS: readonly StructuralOperationKind[] = Object.freeze([
  'insert_rows',
  'delete_rows',
  'copy_rows',
  'move_rows',
  'insert_columns',
  'delete_columns',
  'copy_columns',
  'move_columns',
]);

function requireIntegerField(record: Record<string, unknown>, field: string, where: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${where} 的字段 ${field} 必须是整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 把一段外部 JSON 校验成 {@link StructuralOperation}。**未知 op / 缺字段 / 非整数一律抛。**
 * @throws {ValidationError}
 */
export function parseStructuralOperation(input: unknown): StructuralOperation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('结构化操作必须是一个对象');
  }
  const record = input as Record<string, unknown>;
  const op = record['op'];
  if (typeof op !== 'string' || !(STRUCTURAL_OPERATION_KINDS as readonly string[]).includes(op)) {
    throw new ValidationError(`未知的结构化操作 op：${JSON.stringify(op)}`);
  }
  const kind = op as StructuralOperationKind;
  const at = requireIntegerField(record, 'at', kind);
  const count = requireIntegerField(record, 'count', kind);
  switch (kind) {
    case 'insert_rows':
    case 'delete_rows':
    case 'insert_columns':
    case 'delete_columns':
      return Object.freeze({ op: kind, at, count });
    case 'copy_rows':
    case 'copy_columns':
      return Object.freeze({ op: kind, at, count, insert_at: requireIntegerField(record, 'insert_at', kind) });
    case 'move_rows':
    case 'move_columns':
      return Object.freeze({ op: kind, at, count, to: requireIntegerField(record, 'to', kind) });
    default: {
      const never: never = kind;
      throw new ValidationError(`parseStructuralOperation 未覆盖的 op：${JSON.stringify(never)}`);
    }
  }
}

/** 施加一个结构化操作，返回新的工作表状态。@throws {ValidationError} */
export function applyStructuralOperation(sheet: SheetState, operation: StructuralOperation): SheetState {
  switch (operation.op) {
    case 'insert_rows':
      return insertRows(sheet, operation.at, operation.count);
    case 'delete_rows':
      return deleteRows(sheet, operation.at, operation.count);
    case 'copy_rows':
      return copyRows(sheet, operation.at, operation.count, operation.insert_at);
    case 'move_rows':
      return moveRows(sheet, operation.at, operation.count, operation.to);
    case 'insert_columns':
      return insertColumns(sheet, operation.at, operation.count);
    case 'delete_columns':
      return deleteColumns(sheet, operation.at, operation.count);
    case 'copy_columns':
      return copyColumns(sheet, operation.at, operation.count, operation.insert_at);
    case 'move_columns':
      return moveColumns(sheet, operation.at, operation.count, operation.to);
    default: {
      const never: never = operation;
      throw new ValidationError(`applyStructuralOperation 未覆盖的操作：${JSON.stringify(never)}`);
    }
  }
}

