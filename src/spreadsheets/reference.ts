/**
 * 表格域：A1 地址、引用与区域，以及行列增删后的**引用迁移**（design-06-P8 / XLS-04）。
 *
 * ## 为什么单列一个文件
 *
 * XLS-04 的验收句是「变更后**单元格和公式引用正确迁移**」。迁移是一条**纯函数**：
 * 给定一个引用和一次结构变更（在某行插入 N 行 / 删除 N 行），算出这个引用变成什么。
 * 把它与工作表状态解耦，才能对迁移规则本身写用例，而不是只能透过整表快照间接观察。
 *
 * ## 一个容易搞错的语义：绝对引用也会随插入/删除移动
 *
 * `$` 固定的是**填充/复制**时的相对位移，**不**固定行的插入与删除。在 Excel 里于第 2 行前插入
 * 一行，`$A$5` 同样变成 `$A$6`。本模块照此实现——`abs_row` / `abs_column` **不参与**
 * 行列增删迁移，只参与 {@link shiftReference}（复制/填充语义）。
 *
 * ## 删除命中：不伪造
 *
 * 删掉某行后，原本指向**被删行**的引用在 Excel 里变成 `#REF!`。本模块**不替调用方做这个决定**，
 * 而是返回 `{ ok: false, reason: 'deleted' }`，由调用方决定写成 `#REF!` 还是阻塞整次操作
 * （合同 R250 / XLS-08「不返回伪造结果」）。返回一个"看似合理"的新行号才是伪造。
 */

import { ValidationError } from '../protocol/index.js';

/** 单元格地址（1 起的列号与行号，不含 `$`）。 */
export interface CellAddress {
  readonly column: number;
  readonly row: number;
}

/** 单元格引用（地址 + 两个轴的绝对标记）。 */
export interface CellReference extends CellAddress {
  readonly abs_column: boolean;
  readonly abs_row: boolean;
}

/** 矩形区域（含两端）。 */
export interface CellRange {
  readonly start: CellReference;
  readonly end: CellReference;
}

/**
 * 引用迁移结果。`ok: false` 只表示**这次迁移把引用删掉了**，不表示输入非法
 * （非法输入一律抛 `ValidationError`）。
 */
export type ReferenceMapResult =
  | { readonly ok: true; readonly reference: CellReference }
  | { readonly ok: false; readonly reason: 'deleted' };

/** Excel 的列上限（`XFD`）。 */
export const MAX_COLUMN_NUMBER = 16384;

/** Excel 的行上限。 */
export const MAX_ROW_NUMBER = 1048576;

/** 位移量（复制 / 填充语义）。 */
export interface ReferenceDelta {
  readonly column: number;
  readonly row: number;
}

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 列号（1 起）→ 列字母：`1 → A`、`27 → AA`、`16384 → XFD`。@throws {ValidationError} */
export function columnNumberToLetters(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > MAX_COLUMN_NUMBER) {
    throw new ValidationError(`列号必须是 1…${String(MAX_COLUMN_NUMBER)} 的整数，收到 ${String(column)}`);
  }
  let remaining = column;
  let letters = '';
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    letters = COLUMN_LETTERS.charAt(offset) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/** 列字母 → 列号（大小写不敏感）。@throws {ValidationError} */
export function columnLettersToNumber(letters: string): number {
  if (typeof letters !== 'string' || !/^[A-Za-z]{1,3}$/.test(letters)) {
    throw new ValidationError(`列字母必须由 1–3 个字母组成，收到 ${JSON.stringify(letters)}`);
  }
  let column = 0;
  for (const ch of letters.toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 0x40);
  }
  if (column < 1 || column > MAX_COLUMN_NUMBER) {
    throw new ValidationError(`列字母 ${letters} 超出 Excel 列上限（${String(MAX_COLUMN_NUMBER)}）`);
  }
  return column;
}

function assertAddress(address: CellAddress, where: string): void {
  if (!Number.isInteger(address.column) || address.column < 1 || address.column > MAX_COLUMN_NUMBER) {
    throw new ValidationError(`${where} 的 column 越界：${String(address.column)}`);
  }
  if (!Number.isInteger(address.row) || address.row < 1 || address.row > MAX_ROW_NUMBER) {
    throw new ValidationError(`${where} 的 row 越界：${String(address.row)}`);
  }
}

/** 格式化地址：`{column:2,row:3}` → `"B3"`。@throws {ValidationError} */
export function formatCellAddress(address: CellAddress): string {
  assertAddress(address, 'formatCellAddress');
  return `${columnNumberToLetters(address.column)}${String(address.row)}`;
}

/** 格式化引用：保留 `$` → `"$B$3"`。@throws {ValidationError} */
export function formatCellReference(reference: CellReference): string {
  assertAddress(reference, 'formatCellReference');
  const letters = columnNumberToLetters(reference.column);
  return `${reference.abs_column ? '$' : ''}${letters}${reference.abs_row ? '$' : ''}${String(reference.row)}`;
}

const REFERENCE_PATTERN = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;

/** 解析地址文本（**不接受** `$`）。@throws {ValidationError} */
export function parseCellAddress(text: string): CellAddress {
  const reference = parseCellReference(text);
  if (reference.abs_column || reference.abs_row) {
    throw new ValidationError(`parseCellAddress 不接受绝对引用标记：${JSON.stringify(text)}`);
  }
  return { column: reference.column, row: reference.row };
}

/** 解析引用文本（`B3` / `$B3` / `B$3` / `$B$3`）。@throws {ValidationError} */
export function parseCellReference(text: string): CellReference {
  const match = typeof text === 'string' ? REFERENCE_PATTERN.exec(text.trim()) : null;
  if (match === null) {
    throw new ValidationError(`无法解析单元格引用：${JSON.stringify(text)}`);
  }
  const absColumn = match[1] === '$';
  const letters = match[2];
  const absRow = match[3] === '$';
  const digits = match[4];
  /* c8 ignore next 3 -- 正则已保证三个捕获组存在；此处仅为 noUncheckedIndexedAccess 收窄 */
  if (letters === undefined || digits === undefined) {
    throw new ValidationError(`无法解析单元格引用：${JSON.stringify(text)}`);
  }
  const column = columnLettersToNumber(letters);
  const row = Number.parseInt(digits, 10);
  assertAddress({ column, row }, 'parseCellReference');
  return { column, row, abs_column: absColumn, abs_row: absRow };
}

function comparePosition(a: CellAddress, b: CellAddress): number {
  if (a.row !== b.row) {
    return a.row - b.row;
  }
  return a.column - b.column;
}

/** 解析区域文本（`A1:C3`；单个 `A1` 视为 `A1:A1`）。两端会归一化为左上 / 右下。@throws {ValidationError} */
export function parseRange(text: string): CellRange {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ValidationError('parseRange 需要非空字符串');
  }
  const parts = text.trim().split(':');
  if (parts.length === 1) {
    const only = parseCellReference(parts[0] ?? '');
    return { start: only, end: only };
  }
  if (parts.length !== 2) {
    throw new ValidationError(`无法解析区域：${JSON.stringify(text)}`);
  }
  const a = parseCellReference(parts[0] ?? '');
  const b = parseCellReference(parts[1] ?? '');
  const start = comparePosition(a, b) <= 0 ? a : b;
  const end = comparePosition(a, b) <= 0 ? b : a;
  return { start, end };
}

/** 格式化区域：`"A1:C3"`（单格区域输出 `"A1"`）。@throws {ValidationError} */
export function formatRange(range: CellRange): string {
  const start = formatCellReference(range.start);
  const end = formatCellReference(range.end);
  const same = range.start.column === range.end.column && range.start.row === range.end.row;
  return same ? start : `${start}:${end}`;
}

/**
 * 按**复制 / 填充**语义位移引用：只有**非绝对**的轴跟着动。
 * @throws {ValidationError} 位移结果越界
 */
export function shiftReference(reference: CellReference, delta: ReferenceDelta): CellReference {
  const column = reference.abs_column ? reference.column : reference.column + delta.column;
  const row = reference.abs_row ? reference.row : reference.row + delta.row;
  assertAddress({ column, row }, 'shiftReference');
  return { column, row, abs_column: reference.abs_column, abs_row: reference.abs_row };
}

/** 按**复制 / 填充**语义位移地址（无 `$`，两轴都动）。@throws {ValidationError} */
export function shiftAddress(address: CellAddress, delta: ReferenceDelta): CellAddress {
  const column = address.column + delta.column;
  const row = address.row + delta.row;
  assertAddress({ column, row }, 'shiftAddress');
  return { column, row };
}

function assertMutation(at: number, count: number, where: string): void {
  if (!Number.isInteger(at) || at < 1) {
    throw new ValidationError(`${where} 的 at 必须是 ≥1 的整数，收到 ${String(at)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${where} 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
}

function assertAxialBounds(reference: CellReference): void {
  assertAddress(reference, 'mapReference');
}

/**
 * 在第 `at` 行前插入 `count` 行后的引用迁移。
 *
 * 规则：原行号 **≥ `at`** 的引用下移 `count`；否则不动。**绝对标记不影响本迁移**（见文件头）。
 * @throws {ValidationError} 参数非法
 */
export function mapReferenceOnRowInsert(
  reference: CellReference,
  at: number,
  count: number,
): ReferenceMapResult {
  assertMutation(at, count, 'mapReferenceOnRowInsert');
  assertAxialBounds(reference);
  const row = reference.row >= at ? reference.row + count : reference.row;
  if (row > MAX_ROW_NUMBER) {
    throw new ValidationError(
      `插入后行号 ${String(row)} 超过 Excel 上限（${String(MAX_ROW_NUMBER)}）`,
    );
  }
  return {
    ok: true,
    reference: { column: reference.column, row, abs_column: reference.abs_column, abs_row: reference.abs_row },
  };
}

/**
 * 删除从第 `at` 行开始的 `count` 行后的引用迁移。
 *
 * - 引用落在**被删区间** `[at, at+count-1]` ⇒ `{ ok: false, reason: 'deleted' }`（调用方写 `#REF!` 或阻塞）；
 * - 引用在区间**之后** ⇒ 上移 `count`；
 * - 引用在区间**之前** ⇒ 不动。
 * @throws {ValidationError} 参数非法
 */
export function mapReferenceOnRowDelete(
  reference: CellReference,
  at: number,
  count: number,
): ReferenceMapResult {
  assertMutation(at, count, 'mapReferenceOnRowDelete');
  assertAxialBounds(reference);
  const lastDeleted = at + count - 1;
  if (reference.row >= at && reference.row <= lastDeleted) {
    return { ok: false, reason: 'deleted' };
  }
  const row = reference.row > lastDeleted ? reference.row - count : reference.row;
  return {
    ok: true,
    reference: { column: reference.column, row, abs_column: reference.abs_column, abs_row: reference.abs_row },
  };
}

/** 在第 `at` 列前插入 `count` 列后的引用迁移（列轴，语义同 {@link mapReferenceOnRowInsert}）。@throws {ValidationError} */
export function mapReferenceOnColumnInsert(
  reference: CellReference,
  at: number,
  count: number,
): ReferenceMapResult {
  assertMutation(at, count, 'mapReferenceOnColumnInsert');
  assertAxialBounds(reference);
  const column = reference.column >= at ? reference.column + count : reference.column;
  if (column > MAX_COLUMN_NUMBER) {
    throw new ValidationError(
      `插入后列号 ${String(column)} 超过 Excel 上限（${String(MAX_COLUMN_NUMBER)}）`,
    );
  }
  return {
    ok: true,
    reference: { column, row: reference.row, abs_column: reference.abs_column, abs_row: reference.abs_row },
  };
}

/** 删除从第 `at` 列开始的 `count` 列后的引用迁移（列轴）。@throws {ValidationError} */
export function mapReferenceOnColumnDelete(
  reference: CellReference,
  at: number,
  count: number,
): ReferenceMapResult {
  assertMutation(at, count, 'mapReferenceOnColumnDelete');
  assertAxialBounds(reference);
  const lastDeleted = at + count - 1;
  if (reference.column >= at && reference.column <= lastDeleted) {
    return { ok: false, reason: 'deleted' };
  }
  const column = reference.column > lastDeleted ? reference.column - count : reference.column;
  return {
    ok: true,
    reference: { column, row: reference.row, abs_column: reference.abs_column, abs_row: reference.abs_row },
  };
}

/** 地址是否落在区域内（含边界）。@throws {ValidationError} */
export function rangeContainsAddress(range: CellRange, address: CellAddress): boolean {
  assertAddress(address, 'rangeContainsAddress');
  const { start, end } = range;
  return (
    address.column >= start.column &&
    address.column <= end.column &&
    address.row >= start.row &&
    address.row <= end.row
  );
}

// ---------------------------------------------------------------------------
// 跨表引用：工作表名的规范化（X-I20）
// ---------------------------------------------------------------------------

/**
 * 跨表引用：可选的**解码后**工作表名 + 单元格引用。
 *
 * `sheet === null` 表示"本表"（无 `!` 前缀）。`sheet` 是**解码**结果：`'预算 表'` 与裸名
 * 都会被还原成裸表名——引号只是书写层。
 */
export interface SheetQualifiedReference {
  readonly sheet: string | null;
  readonly reference: CellReference;
}

/**
 * 把工作表限定的**书写 token**解码成裸表名。
 *
 * 与 `formula-parse.ts` / `formula-model.ts` 的口径一致（X-I06）：引号只是书写层，
 * `'明细'!A1` 与 `明细!A1` 指向**同一个**表名 `明细`。带引号时内部的 `''` 还原为单个 `'`。
 *
 * @throws {ValidationError} 空 token / 引号不成对
 */
export function normalizeSheetName(token: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new ValidationError(`工作表名不能为空：${JSON.stringify(token)}`);
  }
  if (!token.startsWith("'")) {
    return token;
  }
  if (token.length < 2 || !token.endsWith("'")) {
    throw new ValidationError(`工作表名的引号不成对：${JSON.stringify(token)}`);
  }
  return token.slice(1, -1).replace(/''/g, "'");
}

/**
 * 表名的**比较键**：Excel 工作表名不区分大小写，因此 `Sheet1` 与 `sheet1` 是同一张表。
 *
 * 与 `workbook.ts` 的 `formulaReferencesSheet` / `quotedSheetPrefix` 同口径：解析 / 匹配表名时
 * 先解码再大小写归一，才能让 `'明细'!A1`、`明细!A1`、大小写变体落到同一个键上。
 */
export function sheetNameKey(name: string): string {
  return normalizeSheetName(name).toLowerCase();
}

/** 在文本里找"限定前缀与引用之间的 `!`"的下标；找不到返回 -1。带引号时按引号配对扫描。 */
function findQualifierSeparator(text: string): number {
  if (!text.startsWith("'")) {
    return text.indexOf('!');
  }
  let index = 1;
  while (index < text.length) {
    if (text.charAt(index) === "'") {
      if (text.charAt(index + 1) === "'") {
        index += 2; // 转义的单引号：'' ⇒ 跳过
        continue;
      }
      // 收尾引号：其后必须紧跟 '!' 才是限定分隔符
      return text.charAt(index + 1) === '!' ? index + 1 : -1;
    }
    index += 1;
  }
  return -1; // 引号未闭合
}

/**
 * 解析**跨表单元格引用**：`明细!$A$1`、`'预算 表'!B2`，或本表引用 `A1`（`sheet === null`）。
 *
 * 本函数只处理**单格**（区域 / 三维引用见 `formula-parse.ts`，本仓显式不支持，不在此猜测）。
 * 解析结果是"解析一致"在引用模型里的落点：带引号与裸名解出**同一个** `sheet`。
 *
 * @throws {ValidationError} 表单引用非法 / 引号未闭合
 */
export function parseSheetQualifiedReference(text: string): SheetQualifiedReference {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ValidationError(`无法解析跨表引用：${JSON.stringify(text)}`);
  }
  const trimmed = text.trim();
  const separator = findQualifierSeparator(trimmed);
  if (separator < 0) {
    return { sheet: null, reference: parseCellReference(trimmed) };
  }
  const token = trimmed.slice(0, separator);
  const body = trimmed.slice(separator + 1);
  if (body.length === 0) {
    throw new ValidationError(`跨表引用 ${JSON.stringify(text)} 的 '!' 之后没有单元格引用`);
  }
  return { sheet: normalizeSheetName(token), reference: parseCellReference(body) };
}
