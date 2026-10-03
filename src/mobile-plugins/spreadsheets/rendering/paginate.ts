/**
 * **X09 核心：大表真实分页**。
 *
 * 输入行/列几何 + 已解析打印设置，输出 {@link PagePlan}——**页数由几何算出**，
 * 不是"导出可见首屏"。判据（测试据此断言）：
 *
 * 1. 行按内容高切页、列按内容宽切页；`rowStrips.length × columnStrips.length` = 页数（在行主序下）。
 * 2. **重复标题行/列**（Print_Titles）出现在**每一页**，且被**从正文流中剔除**（不在页 1 重复出现）。
 * 3. **手工分页符**（rowBreaks/colBreaks，语义=“在行/列之后分页”）强制切断行/列带。
 * 4. **方向 / 纸张 / 边距**改变每页容量；**缩放**（百分比或适配页宽高）按比例改变容量。
 * 5. **超页上限**时截断并给诊断，不静默假装全部排完。
 *
 * 文档化近似（如实登记，不编造精度）：
 * - 列宽换算 `excelColumnWidthToTwips` 依赖默认字体 MDW；非默认字体下**未验证**。
 * - `fit_to_pages` 先按连续不等式给初值，再**有界迭代**缩小直到行列带数 ≤ 目标（见 `fitScale`）。
 *   最终带数**不会超过目标**；但"恰好等于最小页数"未证明最优（可能略多缩一点）。
 * - 真实 PDF 光栅化 / 打印机出纸属**未验证**（需真机 + 消费端）；本包只到"分页计划"。
 */

import { MAX_COLUMN_NUMBER, MAX_ROW_NUMBER, type CellRange } from '../../../spreadsheets/reference.js';
import { RenderingError } from './errors.js';
import type {
  ColumnSpan,
  PaginationDiagnostic,
  PaginationDiagnosticCode,
  PagePlan,
  PagePlanArea,
  PagePlanInput,
  PagePlanPage,
  ResolvedPrintSettings,
  RowSpan,
  SheetGridGeometry,
} from './types.js';
import type { Twips } from './units.js';
import { inchesToTwips, paperSizeTwips } from './units.js';

const DEFAULT_MAX_PAGES = 5000;
const FIT_ITERATION_LIMIT = 64;
const FIT_SHRINK_FACTOR = 0.95;

interface Span {
  readonly start: number;
  readonly end: number;
}

/** 一个打印区域求差（剔除重复标题带）后的正文流。 */
interface FlowRegion {
  readonly area: CellRange | null;
  readonly flowRowSpans: readonly RowSpan[];
  readonly flowColSpans: readonly ColumnSpan[];
  readonly naturalW: Twips;
  readonly naturalH: Twips;
  /** 该区域与标题带求差后没有正文（行或列被吃光）。 */
  readonly empty: boolean;
}

/** 一个区域在某缩放比例下的分带结果。 */
interface RegionStrips {
  readonly columnStrips: readonly ColumnSpan[];
  readonly rowStrips: readonly RowSpan[];
  readonly bandOverflow: boolean;
}

// ---------------------------------------------------------------------------
// 几何度量
// ---------------------------------------------------------------------------

function buildOverrideMap(pairs: readonly (readonly [number, Twips])[] | undefined): Map<number, Twips> {
  const map = new Map<number, Twips>();
  if (pairs === undefined) return map;
  for (const [index, value] of pairs) {
    map.set(index, value);
  }
  return map;
}

function columnWidth(grid: SheetGridGeometry, overrides: Map<number, Twips>, column: number): Twips {
  return overrides.get(column) ?? grid.defaultColumnWidthTwips;
}

function rowHeight(grid: SheetGridGeometry, overrides: Map<number, Twips>, row: number): Twips {
  return overrides.get(row) ?? grid.defaultRowHeightTwips;
}

function sumColumns(grid: SheetGridGeometry, overrides: Map<number, Twips>, spans: readonly ColumnSpan[]): Twips {
  let total = 0;
  for (const span of spans) {
    for (let column = span.start; column <= span.end; column += 1) {
      total += columnWidth(grid, overrides, column);
    }
  }
  return total;
}

function sumRows(grid: SheetGridGeometry, overrides: Map<number, Twips>, spans: readonly RowSpan[]): Twips {
  let total = 0;
  for (const span of spans) {
    for (let row = span.start; row <= span.end; row += 1) {
      total += rowHeight(grid, overrides, row);
    }
  }
  return total;
}

/** 从 `base` 中剔除 `remove` 覆盖到的行/列，返回剩余（最多两段）连续区间。 */
function subtractSpan(base: Span, remove: Span | null): Span[] {
  if (remove === null || remove.end < base.start || remove.start > base.end) {
    return [base];
  }
  const out: Span[] = [];
  if (remove.start > base.start) out.push({ start: base.start, end: remove.start - 1 });
  if (remove.end < base.end) out.push({ start: remove.end + 1, end: base.end });
  return out;
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

class Diagnostics {
  private readonly items: PaginationDiagnostic[] = [];
  private hasError = false;

  add(code: PaginationDiagnosticCode, severity: 'warning' | 'error', message: string, where: { row?: number; column?: number } = {}): void {
    if (severity === 'error') this.hasError = true;
    this.items.push(Object.freeze({ code, severity, message, ...where }));
  }

  get errored(): boolean {
    return this.hasError;
  }

  freeze(): readonly PaginationDiagnostic[] {
    return Object.freeze(this.items.slice());
  }
}

// ---------------------------------------------------------------------------
// 分带
// ---------------------------------------------------------------------------

function buildColumnStrips(
  grid: SheetGridGeometry,
  colOverrides: Map<number, Twips>,
  flowColSpans: readonly ColumnSpan[],
  manualBreaks: ReadonlySet<number>,
  capacity: Twips,
  scale: number,
  diagnostics: Diagnostics,
): { strips: ColumnSpan[]; bandOverflow: boolean } {
  if (capacity <= 0) return { strips: [], bandOverflow: true };
  const strips: ColumnSpan[] = [];
  let current: { start: number; end: number } | null = null;
  let currentWidth = 0;

  const close = (): void => {
    if (current !== null) {
      strips.push(Object.freeze({ start: current.start, end: current.end }));
      current = null;
      currentWidth = 0;
    }
  };

  for (const span of flowColSpans) {
    for (let column = span.start; column <= span.end; column += 1) {
      const width = columnWidth(grid, colOverrides, column) * scale;
      if (current !== null && currentWidth + width > capacity) {
        close();
      }
      if (current === null && width > capacity) {
        diagnostics.add(
          'column_wider_than_page',
          'warning',
          `第 ${String(column)} 列（缩放后 ${formatTwips(width)} twips）已超过整页内容宽 ${formatTwips(capacity)} twips，仍单独放置`,
          { column },
        );
      }
      if (current === null) current = { start: column, end: column };
      else current.end = column;
      currentWidth += width;
      if (manualBreaks.has(column)) {
        close();
      }
    }
    // 段落之间的空档（被剔掉的重复标题列）强制分带，保证 ColumnSpan 连续。
    close();
  }
  return { strips, bandOverflow: false };
}

function buildRowStrips(
  grid: SheetGridGeometry,
  rowOverrides: Map<number, Twips>,
  flowRowSpans: readonly RowSpan[],
  manualBreaks: ReadonlySet<number>,
  capacity: Twips,
  scale: number,
  diagnostics: Diagnostics,
): { strips: RowSpan[]; bandOverflow: boolean } {
  if (capacity <= 0) return { strips: [], bandOverflow: true };
  const strips: RowSpan[] = [];
  let current: { start: number; end: number } | null = null;
  let currentHeight = 0;

  const close = (): void => {
    if (current !== null) {
      strips.push(Object.freeze({ start: current.start, end: current.end }));
      current = null;
      currentHeight = 0;
    }
  };

  for (const span of flowRowSpans) {
    for (let row = span.start; row <= span.end; row += 1) {
      const height = rowHeight(grid, rowOverrides, row) * scale;
      if (current !== null && currentHeight + height > capacity) {
        close();
      }
      if (current === null && height > capacity) {
        diagnostics.add(
          'row_taller_than_page',
          'warning',
          `第 ${String(row)} 行（缩放后 ${formatTwips(height)} twips）已超过整页内容高 ${formatTwips(capacity)} twips，仍单独放置`,
          { row },
        );
      }
      if (current === null) current = { start: row, end: row };
      else current.end = row;
      currentHeight += height;
      if (manualBreaks.has(row)) {
        close();
      }
    }
    close();
  }
  return { strips, bandOverflow: false };
}

function formatTwips(value: Twips): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// ---------------------------------------------------------------------------
// 缩放
// ---------------------------------------------------------------------------

function fitScale(
  settings: ResolvedPrintSettings,
  geometry: {
    contentW: Twips;
    contentH: Twips;
    naturalFlowW: Twips;
    naturalFlowH: Twips;
    titleColW: Twips;
    titleRowH: Twips;
  },
  diagnostics: Diagnostics,
): number {
  const scaling = settings.scaling;
  if (scaling === null) return 1;
  if (scaling.kind === 'percent') return scaling.percent / 100;

  const fitW = scaling.width;
  const fitH = scaling.height;
  if (fitW === 0 && fitH === 0) {
    diagnostics.add('fit_axis_unbounded', 'warning', 'fit_to_pages 的宽高都为 0：按 100% 处理');
    return 1;
  }
  const { contentW, contentH, naturalFlowW, naturalFlowH, titleColW, titleRowH } = geometry;
  const colLimit = fitW > 0 ? (fitW * contentW) / (naturalFlowW + fitW * titleColW) : Number.POSITIVE_INFINITY;
  const rowLimit = fitH > 0 ? (fitH * contentH) / (naturalFlowH + fitH * titleRowH) : Number.POSITIVE_INFINITY;
  const raw = Math.min(colLimit, rowLimit);
  if (raw > 1) {
    diagnostics.add('scaling_clamped', 'warning', `适配页数算出的比例 ${(raw * 100).toFixed(1)}% > 100%，钳到 100%（只缩不放）`);
    return 1;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function validateGrid(grid: SheetGridGeometry): void {
  if (
    !Number.isInteger(grid.firstRow) ||
    !Number.isInteger(grid.firstColumn) ||
    !Number.isInteger(grid.lastRow) ||
    !Number.isInteger(grid.lastColumn) ||
    grid.firstRow < 1 ||
    grid.firstColumn < 1 ||
    grid.lastRow < grid.firstRow ||
    grid.lastColumn < grid.firstColumn ||
    grid.lastRow > MAX_ROW_NUMBER ||
    grid.lastColumn > MAX_COLUMN_NUMBER
  ) {
    throw new RenderingError('invalid_grid_geometry', { field: 'bounds' });
  }
  if (!(grid.defaultColumnWidthTwips > 0) || !(grid.defaultRowHeightTwips > 0)) {
    throw new RenderingError('invalid_grid_geometry', {
      field: 'defaultWidth/Height',
      value: [grid.defaultColumnWidthTwips, grid.defaultRowHeightTwips],
    });
  }
}

/** 计算分页计划。@throws {RenderingError} 结构性非法输入 */
export function computePagePlan(input: PagePlanInput): PagePlan {
  const { grid, settings } = input;
  validateGrid(grid);
  const diagnostics = new Diagnostics();

  const paper = paperSizeTwips(settings.paperSize, settings.orientation);
  const ml = inchesToTwips(settings.margins.left);
  const mr = inchesToTwips(settings.margins.right);
  const mt = inchesToTwips(settings.margins.top);
  const mb = inchesToTwips(settings.margins.bottom);
  const contentW = paper.widthTwips - ml - mr;
  const contentH = paper.heightTwips - mt - mb;
  if (!(contentW > 0) || !(contentH > 0)) {
    throw new RenderingError('invalid_content_box', { field: 'width/height', value: [contentW, contentH] });
  }

  const colOverrides = buildOverrideMap(grid.columnWidths);
  const rowOverrides = buildOverrideMap(grid.rowHeights);

  const titleRows = settings.repeatRows;
  const titleColumns = settings.repeatColumns;
  const titleColW = titleColumns === null ? 0 : sumColumns(grid, colOverrides, [titleColumns]);
  const titleRowH = titleRows === null ? 0 : sumRows(grid, rowOverrides, [titleRows]);

  // 打印区域：多区域（settings.printAreas）优先；否则退回单一 printArea（null = 整个已用区域）。
  const areaRanges: readonly (CellRange | null)[] =
    settings.printAreas !== undefined && settings.printAreas !== null && settings.printAreas.length > 0
      ? settings.printAreas
      : [settings.printArea];

  const buildRegion = (area: CellRange | null): FlowRegion => {
    const flowRows: Span = { start: area?.start.row ?? grid.firstRow, end: area?.end.row ?? grid.lastRow };
    const flowCols: Span = { start: area?.start.column ?? grid.firstColumn, end: area?.end.column ?? grid.lastColumn };
    const flowRowSpans = (titleRows === null ? [flowRows] : subtractSpan(flowRows, titleRows)).filter(
      (span) => span.start <= span.end,
    );
    const flowColSpans = (titleColumns === null ? [flowCols] : subtractSpan(flowCols, titleColumns)).filter(
      (span) => span.start <= span.end,
    );
    return {
      area,
      flowRowSpans,
      flowColSpans,
      naturalW: sumColumns(grid, colOverrides, flowColSpans),
      naturalH: sumRows(grid, rowOverrides, flowRowSpans),
      empty: flowRowSpans.length === 0 || flowColSpans.length === 0,
    };
  };

  const allRegions = areaRanges.map(buildRegion);
  const regions = allRegions.filter((region) => !region.empty);

  if (regions.length === 0) {
    diagnostics.add('empty_content', 'error', '打印区域与重复标题带求差后没有可打印正文单元');
    return freezePlan({
      pages: [],
      areas: [],
      scale: 1,
      paper,
      contentW,
      contentH,
      titleRows,
      titleColumns,
      diagnostics,
      truncated: false,
    });
  }
  for (const region of allRegions) {
    if (region.empty) {
      diagnostics.add('empty_print_area', 'warning', '某个打印区域与重复标题带求差后为空，已跳过该区域');
    }
  }

  // fit 目标页数：取所有区域里最"宽/高"的一个作种子（单区域时即原值）。
  let naturalFlowW = 0;
  let naturalFlowH = 0;
  for (const region of regions) {
    if (region.naturalW > naturalFlowW) naturalFlowW = region.naturalW;
    if (region.naturalH > naturalFlowH) naturalFlowH = region.naturalH;
  }

  const manualColBreaks = new Set(settings.manualColumnBreaks);
  const manualRowBreaks = new Set(settings.manualRowBreaks);

  const stripsFor = (scale: number): RegionStrips[] => {
    const colCap = contentW - titleColW * scale;
    const rowCap = contentH - titleRowH * scale;
    return regions.map((region) => {
      const col = buildColumnStrips(grid, colOverrides, region.flowColSpans, manualColBreaks, colCap, scale, diagnostics);
      const row = buildRowStrips(grid, rowOverrides, region.flowRowSpans, manualRowBreaks, rowCap, scale, diagnostics);
      return {
        columnStrips: Object.freeze(col.strips),
        rowStrips: Object.freeze(row.strips),
        bandOverflow: col.bandOverflow || row.bandOverflow,
      };
    });
  };

  let scale = fitScale(
    settings,
    { contentW, contentH, naturalFlowW, naturalFlowH, titleColW, titleRowH },
    diagnostics,
  );

  let built = stripsFor(scale);
  if (built.some((strips) => strips.bandOverflow)) {
    diagnostics.add('title_band_too_tall', 'error', '重复标题带（缩放后）已占满整页可用尺寸，无法排正文');
    return freezePlan({
      pages: [],
      areas: [],
      scale,
      paper,
      contentW,
      contentH,
      titleRows,
      titleColumns,
      diagnostics,
      truncated: false,
      forceNotOk: true,
    });
  }

  // fit_to_pages：有界迭代缩小，直到**每个**区域的行列带数都不超过目标（保证不超页）。
  if (settings.scaling !== null && settings.scaling.kind === 'fit_to_pages') {
    const fitW = settings.scaling.width;
    const fitH = settings.scaling.height;
    let iterations = 0;
    while (iterations < FIT_ITERATION_LIMIT) {
      const overCols = fitW > 0 && built.some((strips) => strips.columnStrips.length > fitW);
      const overRows = fitH > 0 && built.some((strips) => strips.rowStrips.length > fitH);
      if (!overCols && !overRows) break;
      scale *= FIT_SHRINK_FACTOR;
      built = stripsFor(scale);
      if (built.some((strips) => strips.bandOverflow)) {
        diagnostics.add('title_band_too_tall', 'error', '重复标题带（缩放后）已占满整页可用尺寸，无法排正文');
        return freezePlan({
          pages: [],
          areas: [],
          scale,
          paper,
          contentW,
          contentH,
          titleRows,
          titleColumns,
          diagnostics,
          truncated: false,
          forceNotOk: true,
        });
      }
      iterations += 1;
    }
  }

  const pageOrder = settings.pageOrder;
  const pages: PagePlanPage[] = [];
  const areas: PagePlanArea[] = [];
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  let truncated = false;

  // 截断诊断里报"未截断时本应有多少页"：仅需计数，不物化。
  let totalOrderLength = 0;
  for (const strips of built) {
    totalOrderLength += strips.rowStrips.length * strips.columnStrips.length;
  }

  // 逐区域排页：区域内部按 pageOrder；跨区域**连续编号**（页码不因换区域重新计数）。
  for (let areaIndex = 0; areaIndex < regions.length; areaIndex += 1) {
    const region = regions[areaIndex] as FlowRegion;
    const strips = built[areaIndex] as RegionStrips;
    const rowCount = strips.rowStrips.length;
    const colCount = strips.columnStrips.length;
    const order: { rowStripIndex: number; columnStripIndex: number }[] = [];
    if (pageOrder === 'over_then_down') {
      for (let r = 0; r < rowCount; r += 1) for (let c = 0; c < colCount; c += 1) order.push({ rowStripIndex: r, columnStripIndex: c });
    } else {
      for (let c = 0; c < colCount; c += 1) for (let r = 0; r < rowCount; r += 1) order.push({ rowStripIndex: r, columnStripIndex: c });
    }

    const pageStart = pages.length;
    for (const position of order) {
      if (pages.length >= maxPages) {
        truncated = true;
        break;
      }
      const rows = strips.rowStrips[position.rowStripIndex] as RowSpan;
      const columns = strips.columnStrips[position.columnStripIndex] as ColumnSpan;
      pages.push(
        Object.freeze({
          index: pages.length,
          pageNumber: pages.length + 1,
          areaIndex,
          rowStripIndex: position.rowStripIndex,
          columnStripIndex: position.columnStripIndex,
          rows,
          columns,
          titleRows,
          titleColumns,
        }),
      );
    }
    areas.push(
      Object.freeze({
        index: areaIndex,
        area: region.area,
        columnStrips: strips.columnStrips,
        rowStrips: strips.rowStrips,
        pageStart,
        pageEnd: pages.length,
      }),
    );
    if (truncated) break;
  }

  if (truncated) {
    diagnostics.add(
      'page_limit_exceeded',
      'error',
      `分页结果超过 ${String(maxPages)} 页上限，输出已截断（截断前计划共 ${String(totalOrderLength)} 页）`,
    );
  }

  return freezePlan({
    pages,
    areas,
    scale,
    paper,
    contentW,
    contentH,
    titleRows,
    titleColumns,
    diagnostics,
    truncated,
  });
}

const EMPTY_COLUMN_STRIPS: readonly ColumnSpan[] = Object.freeze([]);
const EMPTY_ROW_STRIPS: readonly RowSpan[] = Object.freeze([]);

interface FreezePlanArgs {
  pages: PagePlanPage[];
  areas: PagePlanArea[];
  scale: number;
  paper: { widthTwips: Twips; heightTwips: Twips };
  contentW: Twips;
  contentH: Twips;
  titleRows: RowSpan | null;
  titleColumns: ColumnSpan | null;
  diagnostics: Diagnostics;
  truncated: boolean;
  forceNotOk?: boolean;
}

function freezePlan(args: FreezePlanArgs): PagePlan {
  const ok = !args.diagnostics.errored && !args.truncated && args.forceNotOk !== true;
  const areas = Object.freeze(args.areas.slice());
  const pages = Object.freeze(args.pages.slice());
  const primary = areas[0];
  return Object.freeze({
    pages,
    totalPages: pages.length,
    scale: args.scale,
    paperBoxTwips: Object.freeze({ widthTwips: args.paper.widthTwips, heightTwips: args.paper.heightTwips }),
    contentBoxTwips: Object.freeze({ widthTwips: args.contentW, heightTwips: args.contentH }),
    areas,
    // 顶层分带 = 第一个区域的分带（单区域兼容；多区域请读 areas）。
    columnStrips: primary?.columnStrips ?? EMPTY_COLUMN_STRIPS,
    rowStrips: primary?.rowStrips ?? EMPTY_ROW_STRIPS,
    titleRows: args.titleRows,
    titleColumns: args.titleColumns,
    diagnostics: args.diagnostics.freeze(),
    ok,
    truncated: args.truncated,
  });
}
