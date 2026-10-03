/**
 * **表格图形排版**（W09，WF-056–070 的手机侧几何层）。
 *
 * ## 这一层干什么
 *
 * 给定一个**列宽已定**的表格模型（行 / 单元格 / 合并跨度）与一个可注入的字体度量端口，
 * 算出**真实**的表格几何（全部 twips，坐标相对表格左上角）：
 *
 * - 列边界 `columnEdgesTwips`（长度 = 列数 + 1）；
 * - 每行的高度与顶边（由**真实测量的单元格内容高**驱动，不是猜的）；
 * - 每个单元格的盒子 + 其内部**真实排版出的行盒**（复用 `line-break.ts` / `paginate.ts`
 *   的同一套摆放判据，绝不另立一套对齐语义）；
 * - 图形线段 `borders`：每条行边界一条横线、每条列边界一条竖线（供 PDF/打印矢量绘制）。
 *
 * 以及**行级分页** `paginateTable`：把表格按行切成跨页切片，表头行在续页**重复**。
 *
 * ## 明确不做的（如实标出，不假装）
 *
 * - **不是**完整 Word 表格约束求解：`rowSpan>1` 的单元格内容高若超过其跨行之和，
 *   本实现把差额在跨行上**均摊**并产 `table_rowspan_distributed` 诊断——这与 Word 的
 *   迭代收敛结果可能在个别文档上不同。我们不把"近似"说成"一致"。
 * - **不做**单元格底纹 / 边框粗细样式 / 斜线 / 嵌套表：只算几何线位，不做视觉样式。
 * - **不做**表格与段落流的统一分页——**本模块不做**；统一分页在 `paginate.ts` 的
 *   `paginateBlocks`（段落块 + 表格块共享一条 y 游标，表格行级切片 + 续页表头重复）。
 *   本模块的 `paginateTable` 仍是**单表、相对其自身内容区**的切片助手；把它嵌进文档流时
 *   请改用 `paginateBlocks`，不要在调用方自行拼接两套分页结果。
 *
 * ## rowSpan 跨页边界
 *
 * `paginateTable` 与 `paginateBlocks` 都只在**整行边界**切页：`rowSpan>1` 的单元格若正好
 * 横跨切片边界，不会被拆行、也不会在续页重排该跨行单元格。要在跨行处切页时由调用方负责。
 *
 * ## 网格校验是 fail-closed
 *
 * 列宽为空、无行、某行跨度和 ≠ 列数、跨度越界或与既有单元格重叠——都抛
 * {@link LayoutError}（有界错误码），**绝不**静默丢单元格或错列对齐。
 */

import { LayoutError } from './errors.js';
import { FontResolver } from './fonts.js';
import { measureParagraph, type MeasureContext, type MeasuredParagraph } from './line-break.js';
import { placeLine } from './paginate.js';
import type {
  FontMetricsPort,
  LayoutDiagnostic,
  LineBox,
  ParagraphSpec,
  Twips,
} from './types.js';

// ---------------------------------------------------------------------------
// 输入模型
// ---------------------------------------------------------------------------

/** 单元格内部的文本块（段落）。 */
export interface TableCellSpec {
  /** 单元格内容；空数组表示空单元格（仍占位，高由 padding / 同高行决定）。 */
  readonly blocks: readonly ParagraphSpec[];
  /** 横向合并列数，≥1，默认 1。 */
  readonly colSpan?: number;
  /** 纵向合并行数，≥1，默认 1。 */
  readonly rowSpan?: number;
}

/** 一行。 */
export interface TableRowSpec {
  readonly cells: readonly TableCellSpec[];
  /** 表头行：分页续页时在最前重复（仅**前导**连续表头行参与重复）。 */
  readonly header?: boolean;
  /** 本行最小高度（twips）；0 表示纯按内容。 */
  readonly minHeightTwips?: Twips;
}

/** 单元格内边距（twips）。 */
export interface CellPaddingTwips {
  readonly top: Twips;
  readonly bottom: Twips;
  readonly left: Twips;
  readonly right: Twips;
}

/** 一份待排版的表格。 */
export interface TableSpec {
  readonly rows: readonly TableRowSpec[];
  /** 列宽（twips）；长度即列数。合并列宽 = 各列宽之和。 */
  readonly columnWidthsTwips: readonly Twips[];
  /** 单元格内边距；缺省四边 0。 */
  readonly cellPaddingTwips?: Partial<CellPaddingTwips>;
  /** 所有行的默认最小高度（twips）；缺省 0。 */
  readonly defaultRowHeightTwips?: Twips;
}

// ---------------------------------------------------------------------------
// 输出模型
// ---------------------------------------------------------------------------

/** 单元格盒（坐标相对**表格**左上角）。 */
export interface TableCellBox {
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly leftTwips: Twips;
  readonly widthTwips: Twips;
  readonly topTwips: Twips;
  readonly heightTwips: Twips;
  /** 文本区左边界（含 padding），相对表格左边。 */
  readonly textLeftTwips: Twips;
  /** 文本区宽度（去 padding）。 */
  readonly textWidthTwips: Twips;
  /** 内容（含 padding）自然高；行高不足时由行高撑开。 */
  readonly contentHeightTwips: Twips;
  /** 单元格内**真实排版出的行**（坐标相对表格左上角）。 */
  readonly lines: readonly LineBox[];
}

/** 一行盒（坐标相对**表格**左上角）。 */
export interface TableRowBox {
  readonly rowIndex: number;
  readonly header: boolean;
  readonly topTwips: Twips;
  readonly heightTwips: Twips;
  readonly cells: readonly TableCellBox[];
}

/** 一条图形线段（表格局部坐标；用于 PDF / 打印矢量绘制）。 */
export interface TableBorderSegment {
  readonly x1Twips: Twips;
  readonly y1Twips: Twips;
  readonly x2Twips: Twips;
  readonly y2Twips: Twips;
  readonly orientation: 'horizontal' | 'vertical';
}

/** 排版结果（坐标相对表格左上角）。 */
export interface TableBox {
  readonly widthTwips: Twips;
  readonly heightTwips: Twips;
  /** 列边界（长度 = 列数 + 1），从 0 到 widthTwips。 */
  readonly columnEdgesTwips: readonly Twips[];
  readonly rows: readonly TableRowBox[];
  readonly borders: readonly TableBorderSegment[];
  /** 前导表头行数（用于续页重复）。 */
  readonly headerRowCount: number;
  readonly diagnostics: readonly LayoutDiagnostic[];
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_PADDING: CellPaddingTwips = { top: 0, bottom: 0, left: 0, right: 0 };

// ---------------------------------------------------------------------------
// 内部：网格
// ---------------------------------------------------------------------------

interface GridCell {
  readonly spec: TableCellSpec;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly textLeftTwips: Twips;
  readonly textWidthTwips: Twips;
  /** 内容自然高（含 padding）。 */
  readonly contentHeightTwips: Twips;
  readonly measured: readonly MeasuredParagraph[];
}

function resolvePadding(spec: TableSpec): CellPaddingTwips {
  const p = spec.cellPaddingTwips;
  return {
    top: p?.top ?? DEFAULT_PADDING.top,
    bottom: p?.bottom ?? DEFAULT_PADDING.bottom,
    left: p?.left ?? DEFAULT_PADDING.left,
    right: p?.right ?? DEFAULT_PADDING.right,
  };
}

/** 校验并建立占用矩阵，返回每行的候选单元格（含列/行跨度与文本宽度）。 */
function buildGrid(spec: TableSpec): { grid: (GridCell | null)[][]; colCount: number } {
  const colCount = spec.columnWidthsTwips.length;
  if (colCount === 0) throw new LayoutError('table_no_columns', {});
  if (spec.rows.length === 0) throw new LayoutError('table_empty', {});

  const occupied: boolean[][] = [];
  const grid: (GridCell | null)[][] = [];

  for (let r = 0; r < spec.rows.length; r += 1) {
    occupied[r] = new Array<boolean>(colCount).fill(false);
    grid[r] = new Array<GridCell | null>(colCount).fill(null);
  }

  for (let r = 0; r < spec.rows.length; r += 1) {
    const row = spec.rows[r] as TableRowSpec;
    // 本行开始前仍**空闲**的列数：上一行 rowSpan 覆盖过来的列不算在本行要填的跨度里。
    const freeAtStart = (occupied[r] as boolean[]).filter((x) => !x).length;
    let cursor = 0;
    let spanSum = 0;
    for (const cell of row.cells) {
      const colSpan = cell.colSpan ?? 1;
      const rowSpan = cell.rowSpan ?? 1;
      if (!Number.isInteger(colSpan) || colSpan < 1 || !Number.isInteger(rowSpan) || rowSpan < 1) {
        throw new LayoutError('table_span_out_of_range', { rowIndex: r });
      }
      spanSum += colSpan;
      // 找到下一个未占用列。
      while (cursor < colCount && (occupied[r] as boolean[])[cursor]) cursor += 1;
      if (cursor + colSpan > colCount || r + rowSpan > spec.rows.length) {
        throw new LayoutError('table_span_out_of_range', {
          rowIndex: r,
          columnIndex: cursor,
          columnCount: colCount,
        });
      }
      for (let rr = r; rr < r + rowSpan; rr += 1) {
        for (let cc = cursor; cc < cursor + colSpan; cc += 1) {
          if ((occupied[rr] as boolean[])[cc]) {
            throw new LayoutError('table_span_out_of_range', {
              rowIndex: r,
              columnIndex: cc,
              columnCount: colCount,
            });
          }
          (occupied[rr] as boolean[])[cc] = true;
        }
      }
      // 记录一个**占位**（文本宽度稍后算），其余网格位留 null（表示被合并覆盖）。
      const placeholder: GridCell = {
        spec: cell,
        rowIndex: r,
        colIndex: cursor,
        colSpan,
        rowSpan,
        textLeftTwips: 0,
        textWidthTwips: 0,
        contentHeightTwips: 0,
        measured: [],
      };
      (grid[r] as (GridCell | null)[])[cursor] = placeholder;
      cursor += colSpan;
    }
    if (spanSum !== freeAtStart) {
      throw new LayoutError('table_column_mismatch', {
        rowIndex: r,
        columnCount: colCount,
      });
    }
  }

  return { grid, colCount };
}

/** 单元格自然宽（含 padding 扣除外的文本宽）与文本左边界。 */
function spanWidth(edges: readonly Twips[], colIndex: number, colSpan: number): Twips {
  const left = edges[colIndex] ?? 0;
  const right = edges[colIndex + colSpan] ?? left;
  return right - left;
}

// ---------------------------------------------------------------------------
// 入口：layoutTable
// ---------------------------------------------------------------------------

/**
 * 排版一个表格（不做跨页拆分；跨页用 {@link paginateTable}）。
 *
 * 坐标一律相对表格左上角。字体缺失 / 端口缺失的失败由 `measureParagraph` 与
 * `FontResolver` 抛出（与段落路径同一套 fail-closed 语义）。
 */
export function layoutTable(
  spec: TableSpec,
  port: FontMetricsPort,
  options: { readonly substituteFont?: (requested: string) => string | null } = {},
): TableBox {
  const diagnostics: LayoutDiagnostic[] = [];
  const resolver = new FontResolver(port, options.substituteFont, diagnostics);
  const padding = resolvePadding(spec);
  const colCount = spec.columnWidthsTwips.length;

  const edges: Twips[] = [0];
  for (const w of spec.columnWidthsTwips) edges.push((edges[edges.length - 1] as number) + Math.max(0, w));
  const widthTwips = edges[edges.length - 1] as number;

  const { grid } = buildGrid(spec);

  // 1) 度量每个单元格内容（用其跨列后的文本宽）。
  const measuredGrid: (GridCell | null)[][] = grid.map((row) =>
    row.map((cell) => {
      if (cell === null) return null;
      const cellWidth = spanWidth(edges, cell.colIndex, cell.colSpan);
      const textWidth = Math.max(0, cellWidth - padding.left - padding.right);
      const ctx: MeasureContext = {
        port,
        resolver,
        diagnostics,
        contentWidthTwips: textWidth,
      };
      const measured = cell.spec.blocks.map((block, bi) => measureParagraph(block, bi, ctx));
      let content = padding.top + padding.bottom;
      for (const mp of measured) {
        content += mp.spaceBeforeTwips + mp.spaceAfterTwips;
        for (const line of mp.lines) content += line.heightTwips;
      }
      const filled: GridCell = {
        ...cell,
        textLeftTwips: (edges[cell.colIndex] ?? 0) + padding.left,
        textWidthTwips: textWidth,
        contentHeightTwips: content,
        measured,
      };
      return filled;
    }),
  );

  // 2) 行高：先取单跨行单元格的自然高，再把多跨行差额均摊。
  const defaultRowHeight = spec.defaultRowHeightTwips ?? 0;
  const rowHeights: number[] = [];
  for (let r = 0; r < spec.rows.length; r += 1) {
    let h = Math.max(defaultRowHeight, (spec.rows[r] as TableRowSpec).minHeightTwips ?? 0);
    for (const cell of measuredGrid[r] as (GridCell | null)[]) {
      if (cell !== null && cell.rowSpan === 1) h = Math.max(h, cell.contentHeightTwips);
    }
    rowHeights[r] = h;
  }
  let distributed = false;
  for (let r = 0; r < measuredGrid.length; r += 1) {
    for (const cell of measuredGrid[r] as (GridCell | null)[]) {
      if (cell === null || cell.rowSpan <= 1) continue;
      let spanned = 0;
      for (let rr = r; rr < r + cell.rowSpan; rr += 1) spanned += rowHeights[rr] as number;
      if (cell.contentHeightTwips > spanned) {
        const deficit = cell.contentHeightTwips - spanned;
        const per = Math.ceil(deficit / cell.rowSpan);
        for (let rr = r; rr < r + cell.rowSpan; rr += 1) {
          rowHeights[rr] = (rowHeights[rr] as number) + per;
        }
        distributed = true;
      }
    }
  }
  if (distributed) {
    diagnostics.push({
      code: 'table_rowspan_distributed',
      severity: 'warning',
      message: 'rowSpan>1 的行高按跨行均摊（非完整 Word 约束求解，结果可能与 Word 有差异）',
    });
  }

  // 3) 行顶边。
  const rowTops: number[] = [];
  let y = 0;
  for (let r = 0; r < rowHeights.length; r += 1) {
    rowTops[r] = y;
    y += rowHeights[r] as number;
  }
  const heightTwips = y;

  // 4) 组装行盒 + 单元格行盒。
  const rows: TableRowBox[] = [];
  for (let r = 0; r < measuredGrid.length; r += 1) {
    const cells: TableCellBox[] = [];
    const top = rowTops[r] as number;
    const height = rowHeights[r] as number;
    for (const cell of measuredGrid[r] as (GridCell | null)[]) {
      if (cell === null) continue;
      const cellTop = top;
      let cellHeight = 0;
      for (let rr = r; rr < r + cell.rowSpan; rr += 1) cellHeight += rowHeights[rr] as number;
      // 内容自上而下摆放（Word 默认顶对齐）。
      const content: { leftTwips: Twips; topTwips: Twips; widthTwips: Twips; heightTwips: Twips } = {
        leftTwips: cell.textLeftTwips,
        topTwips: cellTop,
        widthTwips: cell.textWidthTwips,
        heightTwips: cellHeight,
      };
      const lines: LineBox[] = [];
      let cursor = cellTop + padding.top;
      for (const mp of cell.measured) {
        cursor += mp.spaceBeforeTwips;
        mp.lines.forEach((line, li) => {
          lines.push(placeLine(line, mp, li, content, 0, cursor));
          cursor += line.heightTwips;
        });
        cursor += mp.spaceAfterTwips;
      }
      const cellWidth = spanWidth(edges, cell.colIndex, cell.colSpan);
      cells.push({
        rowIndex: r,
        colIndex: cell.colIndex,
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        leftTwips: edges[cell.colIndex] as number,
        widthTwips: cellWidth,
        topTwips: cellTop,
        heightTwips: cellHeight,
        textLeftTwips: cell.textLeftTwips,
        textWidthTwips: cell.textWidthTwips,
        contentHeightTwips: cell.contentHeightTwips,
        lines,
      });
    }
    rows.push({
      rowIndex: r,
      header: (spec.rows[r] as TableRowSpec).header === true,
      topTwips: top,
      heightTwips: height,
      cells,
    });
  }

  // 5) 图形线段：每条行边界一条横线、每条列边界一条竖线。
  const borders: TableBorderSegment[] = [];
  const rowEdges: number[] = [...rowTops, heightTwips];
  for (const ey of rowEdges) {
    borders.push({ x1Twips: 0, y1Twips: ey, x2Twips: widthTwips, y2Twips: ey, orientation: 'horizontal' });
  }
  for (const ex of edges) {
    borders.push({ x1Twips: ex, y1Twips: 0, x2Twips: ex, y2Twips: heightTwips, orientation: 'vertical' });
  }

  let headerRowCount = 0;
  while (
    headerRowCount < spec.rows.length &&
    (spec.rows[headerRowCount] as TableRowSpec).header === true
  ) {
    headerRowCount += 1;
  }

  return {
    widthTwips,
    heightTwips,
    columnEdgesTwips: edges,
    rows,
    borders,
    headerRowCount,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// 分页：行级拆分 + 表头重复
// ---------------------------------------------------------------------------

/** 一页表格切片（坐标相对切片左上角）。 */
export interface TablePageSlice {
  readonly pageIndex: number;
  readonly rows: readonly TableRowBox[];
  readonly borders: readonly TableBorderSegment[];
  readonly heightTwips: Twips;
  readonly widthTwips: Twips;
  /** 本切片顶部重复的表头行数。 */
  readonly repeatedHeaderRowCount: number;
}

export interface PaginateTableOptions {
  /** 每页内容区高（twips）。 */
  readonly contentHeightTwips: Twips;
  /** 续页是否重复前导表头行；默认 true。 */
  readonly repeatHeaderRows?: boolean;
  /** 诊断输出数组（与 `LayoutResult.diagnostics` 同一口径）。 */
  readonly diagnostics?: LayoutDiagnostic[];
}

/** 把一行（及其单元格、行盒）整体平移到切片局部坐标。 */
function shiftRow(row: TableRowBox, delta: Twips): TableRowBox {
  return {
    rowIndex: row.rowIndex,
    header: row.header,
    topTwips: row.topTwips + delta,
    heightTwips: row.heightTwips,
    cells: row.cells.map((cell) => ({
      ...cell,
      topTwips: cell.topTwips + delta,
      lines: cell.lines.map((line) => ({
        ...line,
        topTwips: line.topTwips + delta,
        baselineTwips: line.baselineTwips + delta,
      })),
    })),
  };
}

function bordersFor(rows: readonly TableRowBox[], widthTwips: Twips, columnEdges: readonly Twips[]): TableBorderSegment[] {
  const out: TableBorderSegment[] = [];
  const top = rows.length > 0 ? (rows[0] as TableRowBox).topTwips : 0;
  const bottom = rows.length > 0 ? (rows[rows.length - 1] as TableRowBox).topTwips + (rows[rows.length - 1] as TableRowBox).heightTwips : 0;
  for (const row of rows) {
    out.push({ x1Twips: 0, y1Twips: row.topTwips, x2Twips: widthTwips, y2Twips: row.topTwips, orientation: 'horizontal' });
  }
  out.push({ x1Twips: 0, y1Twips: bottom, x2Twips: widthTwips, y2Twips: bottom, orientation: 'horizontal' });
  for (const ex of columnEdges) {
    out.push({ x1Twips: ex, y1Twips: top, x2Twips: ex, y2Twips: bottom, orientation: 'vertical' });
  }
  return out;
}

/**
 * 把表格按行切成跨页切片。
 *
 * - 行在边界处整行搬迁，**不拆行**（一行内容不跨页截断）。
 * - 前导表头行在续页最前重复（`repeatHeaderRows`，默认 true）。
 * - 单行高 > 每页内容高：如实发 `table_row_overflow` 并把该行独占一页（不裁切、不死循环）。
 * - 发生拆分即发 `table_split` 诊断。
 */
export function paginateTable(table: TableBox, options: PaginateTableOptions): TablePageSlice[] {
  const { contentHeightTwips, repeatHeaderRows = true, diagnostics = [] } = options;
  if (contentHeightTwips <= 0) throw new LayoutError('invalid_page_geometry', {});

  const headerRows = table.rows.slice(0, table.headerRowCount);
  const bodyRows = table.rows.slice(table.headerRowCount);
  const headerHeight = headerRows.reduce((s, r) => s + r.heightTwips, 0);

  const slices: TablePageSlice[] = [];
  let current: TableRowBox[] = [];
  let y = 0;
  let bodyInSlice = 0;

  const placeHeader = (): void => {
    for (const h of headerRows) {
      current.push(shiftRow(h, y - h.topTwips));
      y += h.heightTwips;
    }
  };
  const finishSlice = (): void => {
    if (current.length === 0) return;
    const repeated = slices.length > 0 ? headerRows.length : 0;
    slices.push({
      pageIndex: slices.length,
      rows: current,
      borders: bordersFor(current, table.widthTwips, table.columnEdgesTwips),
      heightTwips: current.reduce((s, r) => s + r.heightTwips, 0),
      widthTwips: table.widthTwips,
      repeatedHeaderRowCount: repeated,
    });
    current = [];
    y = 0;
    bodyInSlice = 0;
  };

  placeHeader();

  for (const row of bodyRows) {
    if (row.heightTwips > contentHeightTwips) {
      diagnostics.push({
        code: 'table_row_overflow',
        severity: 'warning',
        message: `表格第 ${row.rowIndex} 行高 ${row.heightTwips} twips 超过整页内容区 ${contentHeightTwips} twips，独占一页（不裁切）`,
      });
    }
    // 只有在**本切片已放过正文行**时才断页，保证必然推进（表头单独放不下时不空转）。
    if (bodyInSlice > 0 && y + row.heightTwips > contentHeightTwips) {
      finishSlice();
      if (repeatHeaderRows) placeHeader();
    }
    current.push(shiftRow(row, y - row.topTwips));
    y += row.heightTwips;
    bodyInSlice += 1;
  }
  finishSlice();

  if (slices.length > 1) {
    diagnostics.push({
      code: 'table_split',
      severity: 'warning',
      message: `表格跨 ${slices.length} 页（在行边界拆分${repeatHeaderRows && table.headerRowCount > 0 ? '，续页重复表头' : ''}）`,
    });
  }

  return slices;
}
