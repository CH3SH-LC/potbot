/**
 * 表格域：单元格 / 区域读取与修改、清空、复制剪切粘贴、选择性粘贴、批量填充
 * （design-06-P8 / XLS-03）。
 *
 * ## 本模块守的那条线：**类型不冒充**
 *
 * XLS-03 的验收句是「数值 / 文本 / 日期 / 布尔 / 空值 / 错误值**区分**」。这条线由 `value.ts`
 * 用判别联合守住，本模块**不绕过它**：所有读写都过 `CellValue`，**没有任何"取值 → 字符串 →
 * 取值"的往返**——那正是把文本 `"120"` 悄悄变成数值 `120` 的路径。
 *
 * ## 三个"状态"名字的来历
 *
 * - {@link CellsState} —— 本模块的工作对象：`SheetState`（值）+ `CellStyles`（样式）。
 *   样式与值**分开存**（XLS-05），本模块只是在复制 / 粘贴时让它们**一起动**。
 * - {@link CellsClipboard} —— 一次复制的快照：值与样式各一份二维表，外加**源原点**。
 * - {@link RangeValues} —— 一次区域读取：带两端地址的二维 `CellValue` 表。
 *
 * ## 选择性粘贴（XLS-03「值 / 公式 / 格式」）
 *
 * {@link PasteMode} 有四种，语义彼此**可被用例分开断言**：
 *
 * | 模式 | 值 | 公式 | 样式 |
 * |---|---|---|---|
 * | `all` | 照搬 | **仍是公式**（不固化为结果） | 照搬 |
 * | `values` | 照搬 | 求值成标量（`evaluate.ts`） | 不动 |
 * | `formulas` | 置空 | 只搬公式，常量不搬 | 不动 |
 * | `formats` | 不动 | 不动 | 只搬样式 |
 *
 * `values` 模式的公式求值走**真实求值器** `evaluateWorkbookCell`（XLS-08）；算不出来
 * （成环 / 空白操作数 / 越界）时**显式抛**，绝不编一个"看起来对"的数——这是 XLS-08
 * 「不返回伪造结果」在粘贴路径上的落点。
 */

import { ValidationError } from '../protocol/index.js';
import { evaluateWorkbookCell } from './evaluate.js';
import {
  formatCellAddress,
  parseCellAddress,
  parseRange,
  type CellAddress,
  type CellRange,
} from './reference.js';
import {
  clearRange,
  getCellValue,
  normalizeAddress,
  setCellValue,
  type AddressInput,
  type SheetState,
} from './sheet.js';
import {
  clearRangeStyle,
  emptyCellStyles,
  getCellStyle,
  normalizeCellStyle,
  type CellStyle,
  type CellStyles,
} from './styles.js';
import { blank, isFormula, type CellValue } from './value.js';
import { createWorkbook } from './workbook.js';

// ---------------------------------------------------------------------------
// 状态与快照形状
// ---------------------------------------------------------------------------

/** 本模块的工作对象：值 + 样式（样式与值分开存，XLS-05）。 */
export interface CellsState {
  readonly sheet: SheetState;
  readonly styles: CellStyles;
}

/** 建立工作状态（样式缺省为空表）。 */
export function createCellsState(sheet: SheetState, styles: CellStyles = emptyCellStyles): CellsState {
  return Object.freeze({ sheet, styles });
}

/** 区域读取结果：两端地址 + 按 `rows[row][column]` 排布的**原始取值**（含 `blank`）。 */
export interface RangeValues {
  readonly start: CellAddress;
  readonly end: CellAddress;
  readonly rows: readonly (readonly CellValue[])[];
}

/** 复制快照。值与样式**逐格对齐**（同一 `(row, column)` 下标），并记住**源原点**。 */
export interface CellsClipboard {
  readonly origin: CellAddress;
  readonly height: number;
  readonly width: number;
  readonly values: readonly (readonly CellValue[])[];
  readonly styles: readonly (readonly (CellStyle | undefined)[])[];
}

/** 选择性粘贴模式（XLS-03）。 */
export type PasteMode = 'all' | 'values' | 'formulas' | 'formats';

/** 批量填充模式：`repeat` = 原样平铺；`series` = 沿轴续等差数列。 */
export type FillMode = 'repeat' | 'series';

/** 冻结一份工作表状态为新的 `SheetState`（单点封装；不改 `sheet.ts`）。 */
function freezeSheet(sheet: SheetState, cells: Map<string, CellValue>): SheetState {
  return Object.freeze({ ...sheet, cells }) as SheetState;
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 读单个单元格（未设置 ⇒ `blank`，不是 0）。@throws {ValidationError} */
export function readCell(state: CellsState, address: AddressInput): CellValue {
  return getCellValue(state.sheet, address);
}

/** 读整块区域为二维取值表（含空白格，**不跳过**——跳过会让行列错位）。@throws {ValidationError} */
export function readRange(state: CellsState, range: CellRange | string): RangeValues {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  const rows: CellValue[][] = [];
  for (let row = resolved.start.row; row <= resolved.end.row; row += 1) {
    const line: CellValue[] = [];
    for (let column = resolved.start.column; column <= resolved.end.column; column += 1) {
      line.push(getCellValue(state.sheet, { column, row }));
    }
    rows.push(line);
  }
  return Object.freeze({
    start: { column: resolved.start.column, row: resolved.start.row },
    end: { column: resolved.end.column, row: resolved.end.row },
    rows: Object.freeze(rows.map((line) => Object.freeze(line))),
  });
}

// ---------------------------------------------------------------------------
// 写 / 清空
// ---------------------------------------------------------------------------

/** 写单个单元格（值过 `sheet.ts` 的校验）。@throws {ValidationError} */
export function writeCell(state: CellsState, address: AddressInput, value: CellValue): CellsState {
  return Object.freeze({ sheet: setCellValue(state.sheet, address, value), styles: state.styles });
}

/**
 * 从 `top_left` 起写入一块二维取值表（右 / 下扩展）。
 *
 * 未提供的格子**不动**（不是清空）——"只覆盖给定范围"语义，与 `paste` 的整块覆盖不同。
 * @throws {ValidationError}
 */
export function writeRange(
  state: CellsState,
  topLeft: AddressInput,
  rows: readonly (readonly CellValue[])[],
): CellsState {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError('writeRange 需要至少一行取值');
  }
  const origin = parseCellAddress(normalizeAddress(topLeft));
  let sheet = state.sheet;
  rows.forEach((line, rowOffset) => {
    if (!Array.isArray(line)) {
      throw new ValidationError('writeRange 的每一行都必须是 CellValue 数组');
    }
    line.forEach((value, columnOffset) => {
      const address = formatCellAddress({
        column: origin.column + columnOffset,
        row: origin.row + rowOffset,
      });
      sheet = setCellValue(sheet, address, value);
    });
  });
  return Object.freeze({ sheet, styles: state.styles });
}

/** 清空区域内全部单元格与样式（区域外的原样保留）。@throws {ValidationError} */
export function clearCells(state: CellsState, range: CellRange | string): CellsState {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  return Object.freeze({
    sheet: clearRange(state.sheet, resolved),
    styles: clearRangeStyle(state.styles, resolved),
  });
}

// ---------------------------------------------------------------------------
// 复制 / 剪切
// ---------------------------------------------------------------------------

/** 复制一块区域为快照（值 + 样式 + 源原点）。**不改状态**。@throws {ValidationError} */
export function copyCells(state: CellsState, range: CellRange | string): CellsClipboard {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  const values: CellValue[][] = [];
  const styles: (CellStyle | undefined)[][] = [];
  for (let row = resolved.start.row; row <= resolved.end.row; row += 1) {
    const lineValues: CellValue[] = [];
    const lineStyles: (CellStyle | undefined)[] = [];
    for (let column = resolved.start.column; column <= resolved.end.column; column += 1) {
      const ref = formatCellAddress({ column, row });
      lineValues.push(getCellValue(state.sheet, ref));
      lineStyles.push(getCellStyle(state.styles, ref));
    }
    values.push(lineValues);
    styles.push(lineStyles);
  }
  return Object.freeze({
    origin: { column: resolved.start.column, row: resolved.start.row },
    height: values.length,
    width: values.length === 0 ? 0 : values[0]?.length ?? 0,
    values: Object.freeze(values.map((line) => Object.freeze(line))),
    styles: Object.freeze(styles.map((line) => Object.freeze(line))),
  });
}

/**
 * 剪切一块区域：先取快照，再清空源区域。
 *
 * 返回 `{ state, clipboard }`——调用方拿 clipboard 去 {@link pasteCells} 落点。
 * @throws {ValidationError}
 */
export function cutCells(
  state: CellsState,
  range: CellRange | string,
): { readonly state: CellsState; readonly clipboard: CellsClipboard } {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  const clipboard = copyCells(state, resolved);
  return Object.freeze({ state: clearCells(state, resolved), clipboard });
}

// ---------------------------------------------------------------------------
// 粘贴（含选择性粘贴）
// ---------------------------------------------------------------------------

function assertClipboard(clipboard: CellsClipboard): void {
  if (
    clipboard === null ||
    typeof clipboard !== 'object' ||
    !Number.isInteger(clipboard.height) ||
    !Number.isInteger(clipboard.width) ||
    clipboard.height < 0 ||
    clipboard.width < 0 ||
    !Array.isArray(clipboard.values) ||
    !Array.isArray(clipboard.styles) ||
    clipboard.values.length !== clipboard.height ||
    clipboard.styles.length !== clipboard.height
  ) {
    throw new ValidationError('pasteCells 收到形状非法的剪贴板快照');
  }
}

/**
 * 把快照粘贴到以 `target` 为左上角的区域。
 *
 * 语义见文件头表格。`values` 模式下公式经**真实求值器**求值；求值受阻 ⇒ 抛，不伪造。
 *
 * @throws {ValidationError} 目标越界 / 求值受阻
 */
export function pasteCells(
  state: CellsState,
  target: AddressInput,
  clipboard: CellsClipboard,
  mode: PasteMode = 'all',
): CellsState {
  assertClipboard(clipboard);
  const origin = parseCellAddress(normalizeAddress(target));
  const values = mode === 'values' ? resolveValues(state.sheet, clipboard) : clipboard.values;

  const cells = new Map(state.sheet.cells);
  const styles = new Map(state.styles);

  for (let rowOffset = 0; rowOffset < clipboard.height; rowOffset += 1) {
    const valueLine = values[rowOffset] ?? [];
    const styleLine = clipboard.styles[rowOffset] ?? [];
    for (let columnOffset = 0; columnOffset < clipboard.width; columnOffset += 1) {
      const ref = formatCellAddress({
        column: origin.column + columnOffset,
        row: origin.row + rowOffset,
      });
      const source = valueLine[columnOffset] ?? blank;

      if (mode !== 'formats') {
        const nextValue = valueForMode(source, mode);
        if (nextValue === null) {
          cells.delete(ref); // 该模式下本格不搬值 ⇒ 落点置空（读回为 blank）
        } else {
          cells.set(ref, nextValue);
        }
      }

      if (mode === 'all' || mode === 'formats') {
        const sourceStyle = styleLine[columnOffset];
        if (sourceStyle === undefined) {
          styles.delete(ref);
        } else {
          styles.set(ref, normalizeCellStyle(sourceStyle, `pasteCells(${ref})`));
        }
      }
    }
  }

  return Object.freeze({ sheet: freezeSheet(state.sheet, cells), styles });
}

/** 某一模式下，落点应写入的值；`null` 表示"置空"。 */
function valueForMode(source: CellValue, mode: PasteMode): CellValue | null {
  switch (mode) {
    case 'all':
      // 公式**原样搬**，绝不固化成值。
      return source;
    case 'values':
      return source; // 公式已在 resolveValues 里换成了求值结果
    case 'formulas':
      return isFormula(source) ? source : null; // 只搬公式，常量不搬
    case 'formats':
      return null; // 值不动（外层已跳过本分支）
  }
}

/**
 * `values` 模式：把快照里的公式格逐格**在其源地址上**求值（真实求值器），受阻即抛。
 *
 * 在本仓里公式文本自带 A1 引用（`SUM(A1:A3)`），意义与所在格无关；仍回到源地址求值，
 * 是为了让环检测与错误信息落到真实坐标上。
 */
function resolveValues(sheet: SheetState, clipboard: CellsClipboard): readonly (readonly CellValue[])[] {
  const workbook = createWorkbook([sheet]);
  const out: CellValue[][] = [];
  for (let row = 0; row < clipboard.height; row += 1) {
    const line = clipboard.values[row] ?? [];
    const resolvedLine: CellValue[] = [];
    for (let column = 0; column < clipboard.width; column += 1) {
      const source = line[column] ?? blank;
      if (!isFormula(source)) {
        resolvedLine.push(source);
        continue;
      }
      const address = {
        column: clipboard.origin.column + column,
        row: clipboard.origin.row + row,
      };
      const outcome = evaluateWorkbookCell(workbook, sheet.name, address);
      if (!outcome.ok) {
        throw new ValidationError(
          `选择性粘贴为「值」时公式 ${JSON.stringify(source.text)} 无法求值（${outcome.reason}）：${outcome.detail}；不伪造结果`,
        );
      }
      resolvedLine.push(outcome.value);
    }
    out.push(resolvedLine);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 批量填充
// ---------------------------------------------------------------------------

/**
 * 从种子区域 `source` 向 `target` 批量填充。`target` 必须**以 `source` 为左上角并包含它**。
 *
 * - `repeat`：把种子原样平铺（可同时向下、向右扩展）。**公式逐字照搬**——相对引用的
 *   自动平移属 XLS-06 的公式改写增量，本模块不猜（照搬是明确行为，不是伪造）。
 * - `series`：种子须是同一行或同一列的 **≥2 个数值**，沿该轴续等差（步长取最后一个差）。
 *   种子含非数值 ⇒ 抛（**不编造序列**）。
 *
 * @throws {ValidationError}
 */
export function fillRange(
  state: CellsState,
  source: CellRange | string,
  target: CellRange | string,
  mode: FillMode = 'repeat',
): CellsState {
  const seed = typeof source === 'string' ? parseRange(source) : source;
  const area = typeof target === 'string' ? parseRange(target) : target;
  if (area.start.column !== seed.start.column || area.start.row !== seed.start.row) {
    throw new ValidationError('fillRange：填充区必须以种子区域为左上角（起点必须一致）');
  }
  if (area.end.column < seed.end.column || area.end.row < seed.end.row) {
    throw new ValidationError('fillRange：填充区必须包含种子区域');
  }
  return mode === 'series' ? fillSeries(state, seed, area) : fillRepeat(state, seed, area);
}

function fillRepeat(state: CellsState, seed: CellRange, area: CellRange): CellsState {
  const seedHeight = seed.end.row - seed.start.row + 1;
  const seedWidth = seed.end.column - seed.start.column + 1;
  const clipboard = copyCells(state, seed);
  const cells = new Map(state.sheet.cells);
  const styles = new Map(state.styles);
  for (let row = area.start.row; row <= area.end.row; row += 1) {
    for (let column = area.start.column; column <= area.end.column; column += 1) {
      const sourceRow = (row - area.start.row) % seedHeight;
      const sourceColumn = (column - area.start.column) % seedWidth;
      const value = clipboard.values[sourceRow]?.[sourceColumn] ?? blank;
      const style = clipboard.styles[sourceRow]?.[sourceColumn];
      const ref = formatCellAddress({ column, row });
      if (value.kind === 'blank') {
        cells.delete(ref);
      } else {
        cells.set(ref, value);
      }
      if (style === undefined) {
        styles.delete(ref);
      } else {
        styles.set(ref, style);
      }
    }
  }
  return Object.freeze({ sheet: freezeSheet(state.sheet, cells), styles });
}

function fillSeries(state: CellsState, seed: CellRange, area: CellRange): CellsState {
  // 单格种子两轴都成立 ⇒ 默认按纵向处理，随后会因"种子不足两个"被显式拒绝。
  const vertical = seed.start.column === seed.end.column;
  const horizontal = seed.start.row === seed.end.row;
  if (!vertical && !horizontal) {
    throw new ValidationError('fillRange(series)：种子必须是单行或单列');
  }

  const seedValues: number[] = [];
  if (vertical) {
    for (let row = seed.start.row; row <= seed.end.row; row += 1) {
      seedValues.push(requireSeriesNumber(getCellValue(state.sheet, { column: seed.start.column, row })));
    }
  } else {
    for (let column = seed.start.column; column <= seed.end.column; column += 1) {
      seedValues.push(requireSeriesNumber(getCellValue(state.sheet, { column, row: seed.start.row })));
    }
  }
  if (seedValues.length < 2) {
    throw new ValidationError('fillRange(series)：至少需要两个数值才能推出步长（单个值请用 repeat）');
  }

  // 已知轴向后再约束填充区：纵向种子只能向下、横向种子只能向右。
  if (vertical && area.start.column !== area.end.column) {
    throw new ValidationError('fillRange(series)：纵向种子只能向下填充');
  }
  if (!vertical && area.start.row !== area.end.row) {
    throw new ValidationError('fillRange(series)：横向种子只能向右填充');
  }

  const last = seedValues[seedValues.length - 1] as number;
  const previous = seedValues[seedValues.length - 2] as number;
  const step = last - previous;
  const seedLength = seedValues.length;

  const cells = new Map(state.sheet.cells);
  const styles = new Map(state.styles);
  if (vertical) {
    let filled = 1;
    for (let row = seed.start.row + seedLength; row <= area.end.row; row += 1) {
      const ref = formatCellAddress({ column: seed.start.column, row });
      cells.set(ref, { kind: 'number', value: last + step * filled });
      filled += 1;
    }
  } else {
    let filled = 1;
    for (let column = seed.start.column + seedLength; column <= area.end.column; column += 1) {
      const ref = formatCellAddress({ column, row: seed.start.row });
      cells.set(ref, { kind: 'number', value: last + step * filled });
      filled += 1;
    }
  }
  return Object.freeze({ sheet: freezeSheet(state.sheet, cells), styles });
}

function requireSeriesNumber(value: CellValue): number {
  if (value.kind !== 'number') {
    throw new ValidationError(`fillRange(series) 只支持数值序列，遇到 ${value.kind} 值：不编造序列`);
  }
  return value.value;
}
