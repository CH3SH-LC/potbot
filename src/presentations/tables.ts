/**
 * 演示域**表格**（design-06 P9 / PPT-08）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 的 `TableShape` 已能表达网格与 `col_span`/`row_span`，`render.ts` 的 `tableXml`
 * **拒绝**渲染任何合并单元格（`unsupported_merge_span`，它的显式边界）。本模块补上：
 *
 * 1. **结构操作**：增删行列（不可变）、合并 / 拆分、单元格文本；
 * 2. **单元格排版**：底纹、四周边框、字体（粗斜体 / 字号 / 颜色）、对齐；
 * 3. **合并格的真实 XML**：`a:gridSpan` / `a:rowSpan` / `hMerge` / `vMerge` —— 由
 *    `renderTableFrameXml` 产出 `p:graphicFrame`，用例用**真 XML 解析器**读回校验；
 * 4. **数据来源与共享事实一致**：单元格文本里的 `fact` 引用与文本框走**同一个**
 *    `resolveRunText`（`model.ts` 的唯一口径）——同一份快照 ⇒ 同一串文本；查不到 ⇒
 *    占位文本（R248「缺失不当零」），**不是** `0`、也不是空串。
 *
 * ## 为什么单元格格式单列一张表
 *
 * `model.ts` 的 `TableCell` 只有 `text` 与两个 span（本项目不得改既有文件），所以底纹 / 边框 /
 * 字体 / 对齐放在**模块自有的** `TableCellFormats`（`shape_id:row:col` → 格式）。增删行列时
 * 这张表**跟着重映射**（`remapFormats`），否则"插一行之后格式跑到别的格子"这种错位会静默发生。
 *
 * ## 边界（**未**做的事）
 *
 * - 行高没有模型字段（`TableShape` 只有列宽）：渲染时用统一行高，可用
 *   `renderTableFrameXml(shape, { row_height_emu })` 指定；
 * - 单元格**斜线**（`lnTlToBr`/`lnBlToTr`）、`cell3D`、文字方向未做；
 * - 合并格的 `a:tblPr` 尺寸（`a:table` 的 `a:table` 定位）沿用与 `render.ts` 同口径的写法，
 *   **未**在真机 PowerPoint 里打开验证（本工作包只做字节级与解析级校验）。
 */

import { ValidationError } from '../protocol/index.js';

import {
  resolveRunText,
  transform as makeTransform,
  type FactSnapshot,
  type Paragraph,
  type Presentation,
  type RunStyle,
  type Shape,
  type TableCell,
  type TableRow,
  type TableShape,
  type TextBody,
  type Transform,
} from './model.js';
import { addShape, nextAvailableShapeId } from './operations.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 表格层错误原因（供用例断言与上层分类处理）。 */
export type PresentationTableErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'not_a_table'
  | 'duplicate_shape_id'
  | 'out_of_bounds'
  | 'grid_mismatch'
  | 'grid_overflow'
  | 'merge_conflict'
  | 'empty_table'
  | 'invalid_table_frame'
  | 'merge_readback_mismatch';

/** 表格层在语义不成立时抛出的错误（**不静默**）。 */
export class PresentationTableError extends ValidationError {
  readonly reason: PresentationTableErrorReason;

  constructor(reason: PresentationTableErrorReason, message: string) {
    super(message);
    this.name = 'PresentationTableError';
    this.reason = reason;
  }
}

const DEFAULT_COLUMN_WIDTH_EMU = 1828800;
/** 与 `render.ts` 的行高默认值一致（`a:tr@h`）。 */
export const DEFAULT_ROW_HEIGHT_EMU = 457200;

// ---------------------------------------------------------------------------
// 单元格格式（模块自有）
// ---------------------------------------------------------------------------

/** 单元格边框颜色（`RRGGBB`）或 `null`（不画该边）。 */
export interface CellBorders {
  readonly top: string | null;
  readonly bottom: string | null;
  readonly left: string | null;
  readonly right: string | null;
}

/** 单元格格式（PPT-08「单元格排版 / 边框底纹」）。 */
export interface TableCellFormat {
  /** 底纹（`RRGGBB`）或 `null`（不填充）。 */
  readonly fill: string | null;
  readonly borders: CellBorders;
  /** 字符样式（字号 / 粗斜体 / 颜色 / 字体）。 */
  readonly font: RunStyle | null;
  /** 段落对齐；`null` = 不写对齐属性（继承）。 */
  readonly alignment: Paragraph['alignment'] | null;
}

/** 格式表的键：`shape_id:row:col`。 */
export function cellKey(shapeId: number, row: number, col: number): string {
  return `${String(shapeId)}:${String(row)}:${String(col)}`;
}

/** 单元格格式表（跨表格共用一张，按 `shape_id` 前缀区分）。 */
export type TableCellFormats = ReadonlyMap<string, TableCellFormat>;

/** 空格式表。 */
export const NO_CELL_FORMATS: TableCellFormats = new Map<string, TableCellFormat>();

/** 默认格式（无底纹、无边框、不覆盖字体与对齐）。 */
export const DEFAULT_CELL_FORMAT: TableCellFormat = Object.freeze({
  fill: null,
  borders: { top: null, bottom: null, left: null, right: null },
  font: null,
  alignment: null,
});

/** 取某格的格式（未设置 ⇒ 默认格式）。 */
export function cellFormat(formats: TableCellFormats, shapeId: number, row: number, col: number): TableCellFormat {
  return formats.get(cellKey(shapeId, row, col)) ?? DEFAULT_CELL_FORMAT;
}

/** 设置某格格式（局部覆盖：未给的字段沿用默认）。 */
export function setCellFormat(
  formats: TableCellFormats,
  shapeId: number,
  row: number,
  col: number,
  patch: Partial<TableCellFormat>,
): TableCellFormats {
  const next = new Map(formats);
  const current = cellFormat(formats, shapeId, row, col);
  next.set(cellKey(shapeId, row, col), {
    fill: patch.fill === undefined ? current.fill : patch.fill,
    borders: patch.borders ?? current.borders,
    font: patch.font === undefined ? current.font : patch.font,
    alignment: patch.alignment === undefined ? current.alignment : patch.alignment,
  });
  return next;
}

/** 清除某格格式（回到默认）。 */
export function clearCellFormat(
  formats: TableCellFormats,
  shapeId: number,
  row: number,
  col: number,
): TableCellFormats {
  const next = new Map(formats);
  next.delete(cellKey(shapeId, row, col));
  return next;
}

/** 结构变化后重映射格式表：`rowShift`/`colShift` 是"旧索引 → 新索引"的函数（返回 `null` 表示该格没了）。 */
function remapFormats(
  formats: TableCellFormats,
  shapeId: number,
  rowShift: (row: number) => number | null,
  colShift: (col: number) => number | null,
): TableCellFormats {
  const next = new Map<string, TableCellFormat>();
  for (const [key, format] of formats) {
    const parts = key.split(':');
    if (parts.length !== 3) continue;
    const [owner, rowText, colText] = parts as [string, string, string];
    if (owner !== String(shapeId)) {
      next.set(key, format);
      continue;
    }
    const mappedRow = rowShift(Number(rowText));
    const mappedCol = colShift(Number(colText));
    if (mappedRow === null || mappedCol === null) continue;
    next.set(cellKey(shapeId, mappedRow, mappedCol), format);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 建表 / 取表
// ---------------------------------------------------------------------------

function emptyCell(text: TextBody | null = null): TableCell {
  return { text, col_span: 1, row_span: 1 };
}

function literalCell(text: string): TextBody {
  return {
    paragraphs: [{ runs: [{ source: { kind: 'literal', text } }], level: 0, alignment: 'left', bullet: false }],
  };
}

/** 建表参数。 */
export interface AddTableSpec {
  readonly shape_id?: number;
  readonly name?: string;
  readonly transform: Transform;
  readonly rows: number;
  readonly columns: number;
  /** 列宽（单值=统一列宽；数组=逐列，长度必须等于 `columns`）。 */
  readonly column_width_emu?: number | readonly number[];
  /** 预填文本（`texts[row][col]`，缺省为空）。 */
  readonly texts?: readonly (readonly string[])[];
}

/** 在指定页插入一个表格（PPT-08）。 */
export function addTable(
  presentation: Presentation,
  slideId: number,
  spec: AddTableSpec,
): { readonly presentation: Presentation; readonly shape_id: number } {
  if (!Number.isSafeInteger(spec.rows) || spec.rows < 1 || !Number.isSafeInteger(spec.columns) || spec.columns < 1) {
    throw new PresentationTableError('empty_table', `表格至少 1 行 1 列，收到 ${String(spec.rows)}×${String(spec.columns)}`);
  }
  const shapeId = spec.shape_id ?? nextAvailableShapeId(presentation, slideId);
  const widths = columnWidths(spec.columns, spec.column_width_emu);
  const rows: TableRow[] = Array.from({ length: spec.rows }, (_unused, row) => ({
    cells: Array.from({ length: spec.columns }, (_unused2, col) => {
      const text = spec.texts?.[row]?.[col];
      return emptyCell(text === undefined ? null : literalCell(text));
    }),
  }));
  const shape: TableShape = {
    kind: 'table',
    shape_id: shapeId,
    name: spec.name ?? `Table ${String(shapeId)}`,
    transform: spec.transform,
    rows,
    column_widths_emu: widths,
  };
  return { presentation: addShape(presentation, slideId, shape), shape_id: shapeId };
}

function columnWidths(columns: number, spec: number | readonly number[] | undefined): readonly number[] {
  if (spec === undefined) {
    return Array.from({ length: columns }, () => DEFAULT_COLUMN_WIDTH_EMU);
  }
  if (typeof spec === 'number') {
    return Array.from({ length: columns }, () => spec);
  }
  if (spec.length !== columns) {
    throw new PresentationTableError(
      'grid_mismatch',
      `给了 ${String(spec.length)} 个列宽，但表格有 ${String(columns)} 列`,
    );
  }
  return [...spec];
}

/** 取某页上的表格形状（不是表格 ⇒ 报错）。 */
export function requireTable(presentation: Presentation, slideId: number, shapeId: number): TableShape {
  const slide = presentation.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PresentationTableError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  const collect: Shape[] = [];
  const visit = (shapes: readonly Shape[]): void => {
    for (const shape of shapes) {
      collect.push(shape);
      if (shape.kind === 'group') visit(shape.children);
    }
  };
  visit(slide.shapes);
  const found = collect.find((shape) => shape.shape_id === shapeId);
  if (found === undefined) {
    throw new PresentationTableError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  if (found.kind !== 'table') {
    throw new PresentationTableError('not_a_table', `对象 shape_id=${String(shapeId)} 是 ${found.kind}，不是表格`);
  }
  return found;
}

/** 新表格放到该页后的完整模型（`update` 只收到表格本身，返回新表格）。 */
function updateTable(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  update: (table: TableShape) => TableShape,
): Presentation {
  const slide = presentation.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PresentationTableError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  requireTable(presentation, slideId, shapeId);
  let found = false;
  const walk = (shapes: readonly Shape[]): readonly Shape[] =>
    shapes.map((shape) => {
      if (shape.shape_id === shapeId) {
        found = true;
        return update(shape as TableShape);
      }
      if (shape.kind === 'group') {
        return { ...shape, children: walk(shape.children) };
      }
      return shape;
    });
  const shapes = walk(slide.shapes);
  if (!found) {
    throw new PresentationTableError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  return {
    ...presentation,
    slides: presentation.slides.map((current) =>
      current.slide_id === slideId ? { ...current, shapes } : current,
    ),
  };
}

// ---------------------------------------------------------------------------
// 网格规划：合并的**唯一**表示 → 每格该带什么属性
// ---------------------------------------------------------------------------

/** 规划出来的一格（渲染与校验共用）。 */
export interface PlannedCell {
  /** 该格在**模型行**里的下标（占位格也会有一项）。 */
  readonly cell_index: number;
  /** `gridSpan`（1 = 不写）。 */
  readonly grid_span: number;
  /** `rowSpan`（1 = 不写）。 */
  readonly row_span: number;
  /** 横向合并的延续格 ⇒ `hMerge="1"`。 */
  readonly h_merge: boolean;
  /** 纵向合并的延续格 ⇒ `vMerge="1"`。 */
  readonly v_merge: boolean;
  /** 该格承载的文本（延续格的文本被忽略，渲染为空体）。 */
  readonly text: TextBody | null;
}

/**
 * 把模型的合并表示（源格带 `col_span`/`row_span`，被覆盖格是占位格）规划成逐格属性。
 *
 * 规则（与 OOXML 的 `gridSpan`/`rowSpan`/`hMerge`/`vMerge` 一一对应）：
 * - 每行按**网格列**逐格推进，占位格也占一格（与 `a:tr` 里每个网格列一格一致）；
 * - 源格 `col_span > 1` ⇒ `gridSpan`，其右侧同行的 `col_span-1` 格是 `hMerge` 延续格；
 * - 源格 `row_span > 1` ⇒ `rowSpan`，其下方 `row_span-1` 行同列的格是 `vMerge` 延续格；
 * - 同属一次横向+纵向合并的持续格同时带 `hMerge` 与 `vMerge`；
 * - 结构对不上（某行格数与列数不符、跨出网格、延续格又带 span）⇒ 具名报错，不产出半张表。
 */
export function planTableGrid(table: TableShape): readonly (readonly PlannedCell[])[] {
  const rows = table.rows;
  const columnCount = table.column_widths_emu.length;
  if (rows.length === 0 || columnCount === 0) {
    throw new PresentationTableError('empty_table', '表格没有行或列');
  }
  const hMerge: boolean[][] = rows.map(() => new Array<boolean>(columnCount).fill(false));
  const vMerge: boolean[][] = rows.map(() => new Array<boolean>(columnCount).fill(false));
  const plan: PlannedCell[][] = [];

  rows.forEach((row, rowIndex) => {
    const plannedRow: PlannedCell[] = [];
    let col = 0;
    row.cells.forEach((cell, cellIndex) => {
      if (col >= columnCount) {
        throw new PresentationTableError(
          'grid_overflow',
          `第 ${String(rowIndex)} 行的格数超过列数 ${String(columnCount)}（合并表示与网格不一致）`,
        );
      }
      const hContinuation = hMerge[rowIndex]?.[col] ?? false;
      const vContinuation = vMerge[rowIndex]?.[col] ?? false;
      if (hContinuation || vContinuation) {
        if (cell.col_span > 1 || cell.row_span > 1) {
          throw new PresentationTableError(
            'merge_conflict',
            `第 ${String(rowIndex)} 行第 ${String(col)} 列是合并延续格，却又声明了 span=${String(cell.col_span)}×${String(cell.row_span)}`,
          );
        }
        plannedRow.push({
          cell_index: cellIndex,
          grid_span: 1,
          row_span: 1,
          h_merge: hContinuation,
          v_merge: vContinuation,
          text: null,
        });
        col += 1;
        return;
      }
      if (!Number.isSafeInteger(cell.col_span) || cell.col_span < 1 || !Number.isSafeInteger(cell.row_span) || cell.row_span < 1) {
        throw new PresentationTableError(
          'grid_mismatch',
          `第 ${String(rowIndex)} 行第 ${String(col)} 列的 span 非法：${String(cell.col_span)}×${String(cell.row_span)}`,
        );
      }
      if (col + cell.col_span > columnCount) {
        throw new PresentationTableError(
          'grid_overflow',
          `第 ${String(rowIndex)} 行第 ${String(col)} 列起的合并跨出网格（${String(cell.col_span)} 列 > 余下 ${String(columnCount - col)} 列）`,
        );
      }
      if (rowIndex + cell.row_span > rows.length) {
        throw new PresentationTableError(
          'grid_overflow',
          `第 ${String(rowIndex)} 行的纵向合并跨出行数 ${String(rows.length)}`,
        );
      }
      plannedRow.push({
        cell_index: cellIndex,
        grid_span: cell.col_span,
        row_span: cell.row_span,
        h_merge: false,
        v_merge: false,
        text: cell.text,
      });
      for (let k = 1; k < cell.col_span; k += 1) {
        const target = hMerge[rowIndex];
        if (target !== undefined) target[col + k] = true;
      }
      for (let r = rowIndex + 1; r < rowIndex + cell.row_span; r += 1) {
        for (let k = 0; k < cell.col_span; k += 1) {
          const vRow = vMerge[r];
          if (vRow !== undefined) vRow[col + k] = true;
          if (k > 0) {
            const hRow = hMerge[r];
            if (hRow !== undefined) hRow[col + k] = true;
          }
        }
      }
      col += 1;
    });
    if (col !== columnCount) {
      throw new PresentationTableError(
        'grid_mismatch',
        `第 ${String(rowIndex)} 行有 ${String(col)} 个网格列，表格声明了 ${String(columnCount)} 列`,
      );
    }
    plan.push(plannedRow);
  });
  return plan.map((row) => Object.freeze(row));
}

// ---------------------------------------------------------------------------
// 结构操作（增删行列 / 合并 / 拆分）
// ---------------------------------------------------------------------------

function assertRowIndex(table: TableShape, at: number, allowEnd = false): void {
  const max = allowEnd ? table.rows.length : table.rows.length - 1;
  if (!Number.isSafeInteger(at) || at < 0 || at > max) {
    throw new PresentationTableError(
      'out_of_bounds',
      `行下标 ${String(at)} 越界（表格 ${String(table.rows.length)} 行${allowEnd ? '，可在末尾' : ''}）`,
    );
  }
}

function assertColumnIndex(table: TableShape, at: number, allowEnd = false): void {
  const columns = table.column_widths_emu.length;
  const max = allowEnd ? columns : columns - 1;
  if (!Number.isSafeInteger(at) || at < 0 || at > max) {
    throw new PresentationTableError(
      'out_of_bounds',
      `列下标 ${String(at)} 越界（表格 ${String(columns)} 列${allowEnd ? '，可在末尾' : ''}）`,
    );
  }
}

/** 某行某列是否落在某个合并区域内（含作为源格或延续格）。 */
function insideMerge(plan: readonly (readonly PlannedCell[])[], row: number, col: number): boolean {
  const cell = plan[row]?.[col];
  if (cell === undefined) return false;
  return cell.grid_span > 1 || cell.row_span > 1 || cell.h_merge || cell.v_merge;
}

/** 插入一行（PPT-08）。落进某个纵向合并内部 ⇒ 报错，不静默把合并切开。 */
export function insertRow(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  at: number,
  formats: TableCellFormats = NO_CELL_FORMATS,
): { readonly presentation: Presentation; readonly formats: TableCellFormats } {
  const table = requireTable(presentation, slideId, shapeId);
  const plan = planTableGrid(table);
  assertRowIndex(table, at, true);
  if (at > 0 && at < table.rows.length) {
    // 插在中间时，若上一行的某格纵向跨过插入点 ⇒ 与合并冲突。
    for (let col = 0; col < table.column_widths_emu.length; col += 1) {
      const above = plan[at - 1]?.[col];
      if (above !== undefined && above.row_span + (at - 1) > at) {
        throw new PresentationTableError(
          'merge_conflict',
          `在第 ${String(at)} 行插入会切开第 ${String(col)} 列的纵向合并（rowSpan=${String(above.row_span)}）`,
        );
      }
    }
  }
  const columns = table.column_widths_emu.length;
  const newRow: TableRow = { cells: Array.from({ length: columns }, () => emptyCell()) };
  const rows = [...table.rows.slice(0, at), newRow, ...table.rows.slice(at)];
  const next = updateTable(presentation, slideId, shapeId, (current) => ({ ...current, rows }));
  const nextFormats = remapFormats(formats, shapeId, (row) => row + (row >= at ? 1 : 0), (col) => col);
  return { presentation: next, formats: nextFormats };
}

/** 删除一行（PPT-08）。该行涉及任何合并 ⇒ 报错（不静默拆掉合并）。 */
export function removeRow(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  at: number,
  formats: TableCellFormats = NO_CELL_FORMATS,
): { readonly presentation: Presentation; readonly formats: TableCellFormats } {
  const table = requireTable(presentation, slideId, shapeId);
  assertRowIndex(table, at);
  if (table.rows.length === 1) {
    throw new PresentationTableError('empty_table', '表格只剩一行，删掉就没有表了');
  }
  const plan = planTableGrid(table);
  for (let col = 0; col < table.column_widths_emu.length; col += 1) {
    if (insideMerge(plan, at, col)) {
      throw new PresentationTableError(
        'merge_conflict',
        `第 ${String(at)} 行第 ${String(col)} 列属于合并区域，删除该行会破坏合并`,
      );
    }
  }
  const rows = table.rows.filter((_row, index) => index !== at);
  const next = updateTable(presentation, slideId, shapeId, (current) => ({ ...current, rows }));
  const nextFormats = remapFormats(formats, shapeId, (row) => (row === at ? null : row > at ? row - 1 : row), (col) => col);
  return { presentation: next, formats: nextFormats };
}

/** 插入一列（PPT-08）；列宽取 `width_emu`（缺省与最左列同宽）。 */
export function insertColumn(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  at: number,
  options?: { readonly width_emu?: number; readonly formats?: TableCellFormats },
): { readonly presentation: Presentation; readonly formats: TableCellFormats } {
  const table = requireTable(presentation, slideId, shapeId);
  const plan = planTableGrid(table);
  assertColumnIndex(table, at, true);
  if (at > 0 && at < table.column_widths_emu.length) {
    for (let row = 0; row < table.rows.length; row += 1) {
      const left = plan[row]?.[at - 1];
      if (left !== undefined && left.grid_span + (at - 1) > at) {
        throw new PresentationTableError(
          'merge_conflict',
          `在第 ${String(at)} 列插入会切开第 ${String(row)} 行的横向合并（gridSpan=${String(left.grid_span)}）`,
        );
      }
    }
  }
  const width = options?.width_emu ?? table.column_widths_emu[at] ?? table.column_widths_emu[0] ?? DEFAULT_COLUMN_WIDTH_EMU;
  const rows = table.rows.map((row) => ({
    cells: [...row.cells.slice(0, at), emptyCell(), ...row.cells.slice(at)],
  }));
  const next = updateTable(presentation, slideId, shapeId, (current) => ({
    ...current,
    rows,
    column_widths_emu: [...current.column_widths_emu.slice(0, at), width, ...current.column_widths_emu.slice(at)],
  }));
  const nextFormats = remapFormats(options?.formats ?? NO_CELL_FORMATS, shapeId, (row) => row, (col) =>
    col >= at ? col + 1 : col,
  );
  return { presentation: next, formats: nextFormats };
}

/** 删除一列（PPT-08）。该列涉及任何合并 ⇒ 报错。 */
export function removeColumn(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  at: number,
  formats: TableCellFormats = NO_CELL_FORMATS,
): { readonly presentation: Presentation; readonly formats: TableCellFormats } {
  const table = requireTable(presentation, slideId, shapeId);
  assertColumnIndex(table, at);
  if (table.column_widths_emu.length === 1) {
    throw new PresentationTableError('empty_table', '表格只剩一列，删掉就没有表了');
  }
  const plan = planTableGrid(table);
  for (let row = 0; row < table.rows.length; row += 1) {
    if (insideMerge(plan, row, at)) {
      throw new PresentationTableError(
        'merge_conflict',
        `第 ${String(row)} 行第 ${String(at)} 列属于合并区域，删除该列会破坏合并`,
      );
    }
  }
  const rows = table.rows.map((row) => ({ cells: row.cells.filter((_cell, index) => index !== at) }));
  const next = updateTable(presentation, slideId, shapeId, (current) => ({
    ...current,
    rows,
    column_widths_emu: current.column_widths_emu.filter((_width, index) => index !== at),
  }));
  const nextFormats = remapFormats(formats, shapeId, (row) => row, (col) => (col === at ? null : col > at ? col - 1 : col));
  return { presentation: next, formats: nextFormats };
}

/** 合并区域（源格 + 跨越的行列数）。 */
export interface MergeRegion {
  readonly row: number;
  readonly col: number;
  readonly row_span: number;
  readonly col_span: number;
}

/**
 * 合并一块矩形区域（PPT-08）。源格保留文本，被覆盖格变占位格。
 *
 * 与已有合并**重叠** ⇒ `merge_conflict`（不静默叠加）。
 */
export function mergeCells(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  region: MergeRegion,
): Presentation {
  const table = requireTable(presentation, slideId, shapeId);
  const columns = table.column_widths_emu.length;
  if (
    region.row_span < 1 ||
    region.col_span < 1 ||
    region.row < 0 ||
    region.col < 0 ||
    region.row + region.row_span > table.rows.length ||
    region.col + region.col_span > columns
  ) {
    throw new PresentationTableError(
      'out_of_bounds',
      `合并区域 (${String(region.row)},${String(region.col)}) ${String(region.row_span)}×${String(region.col_span)} 越界`,
    );
  }
  if (region.row_span === 1 && region.col_span === 1) {
    throw new PresentationTableError('merge_conflict', '合并区域至少要跨 2 格');
  }
  const plan = planTableGrid(table);
  for (let row = region.row; row < region.row + region.row_span; row += 1) {
    for (let col = region.col; col < region.col + region.col_span; col += 1) {
      if (insideMerge(plan, row, col)) {
        throw new PresentationTableError(
          'merge_conflict',
          `合并区域与已有合并重叠：第 ${String(row)} 行第 ${String(col)} 列已在合并区域内`,
        );
      }
    }
  }
  const rows = table.rows.map((row, rowIndex) => {
    if (rowIndex < region.row || rowIndex >= region.row + region.row_span) return row;
    return {
      cells: row.cells.map((cell, colIndex) => {
        const isOrigin = rowIndex === region.row && colIndex === region.col;
        if (isOrigin) {
          return { text: cell.text, col_span: region.col_span, row_span: region.row_span };
        }
        if (colIndex >= region.col && colIndex < region.col + region.col_span) {
          return emptyCell();
        }
        return cell;
      }),
    };
  });
  return updateTable(presentation, slideId, shapeId, (current) => ({ ...current, rows }));
}

/** 拆分某格（PPT-08）：源格回到 1×1，其覆盖的格保持占位（各自独立成格）。 */
export function splitCell(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  row: number,
  col: number,
): Presentation {
  const table = requireTable(presentation, slideId, shapeId);
  const plan = planTableGrid(table);
  const cell = plan[row]?.[col];
  if (cell === undefined) {
    throw new PresentationTableError('out_of_bounds', `第 ${String(row)} 行第 ${String(col)} 列越界`);
  }
  if (cell.h_merge || cell.v_merge) {
    throw new PresentationTableError(
      'merge_conflict',
      `第 ${String(row)} 行第 ${String(col)} 列是合并延续格，要拆分请对合并的源格操作`,
    );
  }
  if (cell.grid_span === 1 && cell.row_span === 1) {
    throw new PresentationTableError('merge_conflict', `第 ${String(row)} 行第 ${String(col)} 列本来就没有合并`);
  }
  const rows = table.rows.map((current, rowIndex) =>
    rowIndex === row
      ? {
          cells: current.cells.map((existing, colIndex) =>
            colIndex === col ? { text: existing.text, col_span: 1, row_span: 1 } : existing,
          ),
        }
      : current,
  );
  return updateTable(presentation, slideId, shapeId, (current) => ({ ...current, rows }));
}

/** 设置某格文本（`null` 清空）。 */
export function setCellText(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  row: number,
  col: number,
  text: TextBody | null,
): Presentation {
  const table = requireTable(presentation, slideId, shapeId);
  const plan = planTableGrid(table);
  const cell = plan[row]?.[col];
  if (cell === undefined) {
    throw new PresentationTableError('out_of_bounds', `第 ${String(row)} 行第 ${String(col)} 列越界`);
  }
  if (cell.h_merge || cell.v_merge) {
    throw new PresentationTableError(
      'merge_conflict',
      `第 ${String(row)} 行第 ${String(col)} 列是合并延续格，文本请写在该合并的源格上`,
    );
  }
  const rows = table.rows.map((current, rowIndex) =>
    rowIndex === row
      ? {
          cells: current.cells.map((existing, colIndex) =>
            colIndex === col ? { text, col_span: cell.grid_span, row_span: cell.row_span } : existing,
          ),
        }
      : current,
  );
  return updateTable(presentation, slideId, shapeId, (current) => ({ ...current, rows }));
}

// ---------------------------------------------------------------------------
// 数据来源：与共享事实**同一口径**
// ---------------------------------------------------------------------------

/** 某格文本解析成字符串：与文本框**同一个** `resolveRunText`（R248：缺失不当零）。 */
export function resolveCellText(text: TextBody | null, snapshot: FactSnapshot): string {
  if (text === null) return '';
  return text.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => resolveRunText(run.source, snapshot)).join(''))
    .join('\n');
}

/**
 * 整张表的文本网格（合并的延续格为空串）。**同一份事实快照** ⇒ 与文本框里同样的引用
 * 解析出同样的字符串；快照里查不到 ⇒ `（未提供）` 占位，不是 `0`。
 */
export function resolveTableText(
  table: TableShape,
  snapshot: FactSnapshot = [],
): readonly (readonly string[])[] {
  const plan = planTableGrid(table);
  return plan.map((row) =>
    Object.freeze(
      row.map((cell) => (cell.h_merge || cell.v_merge || cell.text === null ? '' : resolveCellText(cell.text, snapshot))),
    ),
  );
}

// ---------------------------------------------------------------------------
// 渲染：p:graphicFrame + a:tbl（含合并 / 底纹 / 边框 / 字体 / 对齐）
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(name: string, value: string): string {
  return ` ${name}="${esc(value)}"`;
}

function cellBodyXml(text: TextBody, snapshot: FactSnapshot, format: TableCellFormat): string {
  const paragraphs = text.paragraphs.map((paragraph) => {
    const alignment = format.alignment ?? paragraph.alignment;
    const alignAttr = alignment === 'left' ? '' : attr('algn', alignment === 'center' ? 'ctr' : alignment === 'right' ? 'r' : 'just');
    const levelAttr = paragraph.level > 0 ? attr('lvl', String(paragraph.level)) : '';
    const runs = paragraph.runs.map((run) => {
      const style: RunStyle | undefined = run.style;
      const merged: RunStyle | null = format.font === null ? (style ?? null) : { ...format.font, ...style };
      const rPrAttrs =
        (merged?.bold === true ? attr('b', '1') : '') +
        (merged?.italic === true ? attr('i', '1') : '') +
        (merged?.size_pt === undefined ? '' : attr('sz', String(Math.round(merged.size_pt * 100))));
      const color = merged?.color === undefined ? '' : `<a:solidFill><a:srgbClr${attr('val', merged.color)}/></a:solidFill>`;
      const font = merged?.font === undefined ? '' : `<a:latin${attr('typeface', merged.font)}/>`;
      const text2 = resolveRunText(run.source, snapshot);
      return `<a:r><a:rPr${attr('lang', 'zh-CN')}${rPrAttrs}${attr('dirty', '0')}>${color}${font}</a:rPr><a:t>${esc(text2)}</a:t></a:r>`;
    });
    return `<a:p><a:pPr${alignAttr}${levelAttr}><a:buNone/></a:pPr>${runs.join('')}</a:p>`;
  });
  return `<a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</a:txBody>`;
}

function borderXml(tag: string, color: string | null): string {
  return color === null ? '' : `<a:${tag}${attr('w', '12700')}><a:solidFill><a:srgbClr${attr('val', color)}/></a:solidFill></a:${tag}>`;
}

function cellPropertiesXml(format: TableCellFormat): string {
  const borders =
    borderXml('lnL', format.borders.left) +
    borderXml('lnR', format.borders.right) +
    borderXml('lnT', format.borders.top) +
    borderXml('lnB', format.borders.bottom);
  const fill = format.fill === null ? '' : `<a:solidFill><a:srgbClr${attr('val', format.fill)}/></a:solidFill>`;
  return borders === '' && fill === '' ? '<a:tcPr/>' : `<a:tcPr>${borders}${fill}</a:tcPr>`;
}

/**
 * 渲染表格为 `p:graphicFrame` 片段（PPT-08，含合并单元格）。
 *
 * `render.ts` 的 `tableXml` 遇到 `span>1` 直接报 `unsupported_merge_span`（它的显式边界），
 * 本函数是**带合并**的那条路径：`gridSpan`/`rowSpan`/`hMerge`/`vMerge` + 底纹 + 边框 + 字体 + 对齐。
 *
 * 只产出片段（不含幻灯片外壳）；整份渲染仍走 `renderPresentation`（无合并的口径）。
 */
export function renderTableFrameXml(
  table: TableShape,
  options?: {
    readonly snapshot?: FactSnapshot;
    readonly formats?: TableCellFormats;
    readonly row_height_emu?: number;
  },
): string {
  const snapshot = options?.snapshot ?? [];
  const formats = options?.formats ?? NO_CELL_FORMATS;
  const rowHeight = options?.row_height_emu ?? DEFAULT_ROW_HEIGHT_EMU;
  const plan = planTableGrid(table);

  const grid = table.column_widths_emu.map((width) => `<a:gridCol${attr('w', String(width))}/>`).join('');
  const rows = table.rows
    .map((row, rowIndex) => {
      const planned = plan[rowIndex] ?? [];
      const cells = planned
        .map((cell, gridColumn) => {
          const attrs =
            (cell.grid_span > 1 ? attr('gridSpan', String(cell.grid_span)) : '') +
            (cell.row_span > 1 ? attr('rowSpan', String(cell.row_span)) : '') +
            (cell.h_merge ? attr('hMerge', '1') : '') +
            (cell.v_merge ? attr('vMerge', '1') : '');
          const format = cellFormat(formats, table.shape_id, rowIndex, gridColumn);
          const body =
            cell.h_merge || cell.v_merge || cell.text === null
              ? '<a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>'
              : cellBodyXml(cell.text, snapshot, format);
          return `<a:tc${attrs}>${body}${cellPropertiesXml(format)}</a:tc>`;
        })
        .join('');
      return `<a:tr${attr('h', String(rowHeight))}>${cells}</a:tr>`;
    })
    .join('');

  const t = table.transform;
  return (
    `<p:graphicFrame>` +
    `<p:nvGraphicFramePr><p:cNvPr${attr('id', String(table.shape_id))}${attr('name', table.name)}/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off${attr('x', String(t.x_emu))}${attr('y', String(t.y_emu))}/><a:ext${attr('cx', String(t.cx_emu))}${attr('cy', String(t.cy_emu))}/></p:xfrm>` +
    `<a:graphic><a:graphicData${attr('uri', 'http://schemas.openxmlformats.org/drawingml/2006/table')}>` +
    `<a:tbl><a:tblPr/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl>` +
    `</a:graphicData></a:graphic>` +
    `</p:graphicFrame>`
  );
}

/** 把表格片段包进一份可解析的最小幻灯片文档（供校验 / 接线自测）。 */
export function wrapTableInSlideDocument(frameXml: string): string {
  return (
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    frameXml +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/** 造一个 `Transform` 的便捷入口（与 `model.transform` 同参数，便于接线方少导一个模块）。 */
export const tableTransform = makeTransform;

// ---------------------------------------------------------------------------
// P-I17 · 合并表的 render → import 往返（span 真读回，不看字符串判据）
// ---------------------------------------------------------------------------
//
// 本模块此前只有**单向**：模型/规划 → `renderTableFrameXml` 出真 XML。缺的是**读回**：
// 把渲染出的 `p:graphicFrame` 里的 `gridSpan`/`rowSpan`/`hMerge`/`vMerge` **解析回**网格，
// 与模型的 `planTableGrid` 逐格比对。没有这条读回，"合并能往返"只能靠字符串里"看着有"，
// 而字符串里有 `gridSpan="2"` 不等于下一格真的被吞掉、也不等于跨行没越界。
//
// 读回与规划是**两条独立路径**：`planTableGrid` 从模型推 XML 该长什么样；`readTableFrameSpans`
// 从**真 XML** 反推网格。两者逐格相等才算往返成立（不等 ⇒ `merge_readback_mismatch`）。

/** 从渲染后的表格 XML 读回的一格（网格属性，与 `planTableGrid` 的 `PlannedCell` 同口径）。 */
export interface ImportedTableCellSpan {
  /** 模型行下标（所有 `a:tr` 顺序计数，含被吞的延续行）。 */
  readonly row: number;
  /** **网格列**下标（每格占 1，合并源格与延续格各占 1）。 */
  readonly col: number;
  /** 该 `a:tr` 内该格的元素序号。 */
  readonly cell_index: number;
  readonly grid_span: number;
  readonly row_span: number;
  readonly h_merge: boolean;
  readonly v_merge: boolean;
}

/** 从表格 XML 读回的一张网格。 */
export interface ImportedTableGrid {
  readonly row_count: number;
  readonly column_count: number;
  readonly cells: readonly (readonly ImportedTableCellSpan[])[];
  /** 从 span 读回重建的合并区（源格 + 跨行跨列），顺序 = 行优先。 */
  readonly merges: readonly MergeRegion[];
}

function collectNodes(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) collectNodes(child, name, out);
  return out;
}

function readSpanAttr(cell: XmlElementNode, name: string): number {
  const raw = attributeOf(cell, name);
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PresentationTableError('invalid_table_frame', `a:tc@${name}=${raw} 不是合法正整数`);
  }
  return value;
}

function readMergeFlag(cell: XmlElementNode, name: string): boolean {
  const raw = attributeOf(cell, name);
  return raw === '1' || raw === 'true';
}

/**
 * 从渲染出的表格 XML（`p:graphicFrame` 片段或整份幻灯片文档）**读回**每格的 span 与合并区。
 *
 * 结构不符（没有 `a:tbl` / 行列对不上网格 / 延续格又带 span / 合并越界）⇒ 具名报错，
 * 不返回半张网格。
 */
export function readTableFrameSpans(frameXml: string): ImportedTableGrid {
  let root: XmlElementNode;
  try {
    root = parseXmlDocument(wrapTableInSlideDocument(frameXml));
  } catch (error) {
    throw new PresentationTableError(
      'invalid_table_frame',
      `表格片段无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tables = collectNodes(root, 'a:tbl');
  const table = tables[0];
  if (table === undefined) {
    throw new PresentationTableError('invalid_table_frame', '表格片段里没有 a:tbl');
  }
  const columnCount = collectNodes(table, 'a:gridCol').length;
  if (columnCount === 0) {
    throw new PresentationTableError('invalid_table_frame', '表格片段里没有 a:gridCol 列');
  }
  const rows = collectNodes(table, 'a:tr');
  if (rows.length === 0) {
    throw new PresentationTableError('invalid_table_frame', '表格片段里没有 a:tr 行');
  }

  const cells: ImportedTableCellSpan[][] = [];
  const merges: MergeRegion[] = [];
  rows.forEach((row, rowIndex) => {
    const tcs = childElements(row, 'a:tc');
    if (tcs.length !== columnCount) {
      throw new PresentationTableError(
        'grid_mismatch',
        `第 ${String(rowIndex)} 行读回 ${String(tcs.length)} 格，网格声明 ${String(columnCount)} 列`,
      );
    }
    const plannedRow: ImportedTableCellSpan[] = [];
    tcs.forEach((cell, cellIndex) => {
      const gridSpan = readSpanAttr(cell, 'gridSpan');
      const rowSpan = readSpanAttr(cell, 'rowSpan');
      const hMerge = readMergeFlag(cell, 'hMerge');
      const vMerge = readMergeFlag(cell, 'vMerge');
      const col = plannedRow.length;
      if ((hMerge || vMerge) && (gridSpan > 1 || rowSpan > 1)) {
        throw new PresentationTableError(
          'merge_readback_mismatch',
          `第 ${String(rowIndex)} 行第 ${String(col)} 列既是合并延续格又声明了 span`,
        );
      }
      if ((gridSpan > 1 || rowSpan > 1) && !hMerge && !vMerge) {
        if (col + gridSpan > columnCount || rowIndex + rowSpan > rows.length) {
          throw new PresentationTableError(
            'grid_overflow',
            `读回的合并 (${String(rowIndex)},${String(col)}) ${String(rowSpan)}×${String(gridSpan)} 越出网格 ${String(rows.length)}×${String(columnCount)}`,
          );
        }
        merges.push(Object.freeze({ row: rowIndex, col, row_span: rowSpan, col_span: gridSpan }));
      }
      plannedRow.push(
        Object.freeze({ row: rowIndex, col, cell_index: cellIndex, grid_span: gridSpan, row_span: rowSpan, h_merge: hMerge, v_merge: vMerge }),
      );
    });
    cells.push(plannedRow);
  });

  return Object.freeze({
    row_count: rows.length,
    column_count: columnCount,
    cells: Object.freeze(cells.map((row) => Object.freeze(row))),
    merges: Object.freeze(merges),
  });
}

/** 从**模型**读出合并区列表（源格 + 跨行跨列），顺序与 `readTableFrameSpans` 一致（行优先）。 */
export function tableMergeRegions(table: TableShape): readonly MergeRegion[] {
  const plan = planTableGrid(table);
  const merges: MergeRegion[] = [];
  plan.forEach((row, rowIndex) => {
    row.forEach((cell, col) => {
      if ((cell.grid_span > 1 || cell.row_span > 1) && !cell.h_merge && !cell.v_merge) {
        merges.push(Object.freeze({ row: rowIndex, col, row_span: cell.row_span, col_span: cell.grid_span }));
      }
    });
  });
  return Object.freeze(merges);
}

/** 合并表 render → import 往返的报告。 */
export interface TableMergeRoundTripReport {
  readonly row_count: number;
  readonly column_count: number;
  readonly merge_count: number;
  readonly merges: readonly MergeRegion[];
}

function sameRegion(left: MergeRegion, right: MergeRegion): boolean {
  return (
    left.row === right.row &&
    left.col === right.col &&
    left.row_span === right.row_span &&
    left.col_span === right.col_span
  );
}

/**
 * **合并表 render → import 往返**：渲染表为 `p:graphicFrame`，独立读回 span 与合并区，
 * 与模型的 `planTableGrid` / `tableMergeRegions` 逐格、逐区比对。
 *
 * 可传 `options.frame_xml` 用**外部渲染**的 XML 复核（反向对照：篡改 span 后必须具名红
 * `merge_readback_mismatch`，证明读回不是回显输入）；不传则用本模块渲染。
 */
export function verifyTableMergeRoundTrip(
  table: TableShape,
  options?: Parameters<typeof renderTableFrameXml>[1] & { readonly frame_xml?: string },
): TableMergeRoundTripReport {
  const frame = options?.frame_xml ?? renderTableFrameXml(table, options);
  const imported = readTableFrameSpans(frame);
  const plan = planTableGrid(table);

  if (imported.row_count !== plan.length || imported.column_count !== table.column_widths_emu.length) {
    throw new PresentationTableError(
      'merge_readback_mismatch',
      `读回的网格 ${String(imported.row_count)}×${String(imported.column_count)} 与模型 ${String(plan.length)}×${String(table.column_widths_emu.length)} 不符`,
    );
  }
  plan.forEach((plannedRow, rowIndex) => {
    const importedRow = imported.cells[rowIndex] ?? [];
    plannedRow.forEach((planned, col) => {
      const read = importedRow[col];
      if (
        read === undefined ||
        read.grid_span !== planned.grid_span ||
        read.row_span !== planned.row_span ||
        read.h_merge !== planned.h_merge ||
        read.v_merge !== planned.v_merge
      ) {
        throw new PresentationTableError(
          'merge_readback_mismatch',
          `第 ${String(rowIndex)} 行第 ${String(col)} 列的 span 读回不一致：模型 ${String(planned.grid_span)}列×${String(planned.row_span)}行 h=${String(planned.h_merge)} v=${String(planned.v_merge)}，读回 ${read === undefined ? '缺格' : `${String(read.grid_span)}列×${String(read.row_span)}行 h=${String(read.h_merge)} v=${String(read.v_merge)}`}`,
        );
      }
    });
  });

  const modelMerges = tableMergeRegions(table);
  if (modelMerges.length !== imported.merges.length || modelMerges.some((merge, index) => {
    const read = imported.merges[index];
    return read === undefined || !sameRegion(merge, read);
  })) {
    throw new PresentationTableError(
      'merge_readback_mismatch',
      `合并区读回不一致：模型 ${JSON.stringify(modelMerges)}，读回 ${JSON.stringify(imported.merges)}`,
    );
  }

  return Object.freeze({
    row_count: imported.row_count,
    column_count: imported.column_count,
    merge_count: imported.merges.length,
    merges: imported.merges,
  });
}
