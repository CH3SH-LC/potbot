/**
 * **X09 — 手机侧表格分页 / 打印预览（纯 TS）**公开出口。
 *
 * 只做计算：行/列几何 + 打印设置 → 真实分页计划 → 逐页预览模型（含页眉页脚展开）。
 * 不接 Android、不读文件系统、无第三方依赖。
 *
 * ## 给适配器（X-I19 等）的稳定面
 *
 * - `buildPrintPreview(input)` 是**首选入口**：一次算完分页 + 逐页页眉页脚，`totalPages`
 *   与 `pageNumber` 只来自 {@link PagePlan}（`&P`/`&N` 不重算）。
 * - `computePagePlan(input)` 只要计划时用它（含 `totalPages` / `areas` / 每页 `areaIndex`）。
 * - `headerFooterForPlanPage(headerFooter, plan, pageIndex)`：拿已有计划单独展开某页页眉页脚。
 * - `resolvePrintSettings(layout)` + `parsePrintAreaList(text)`：把 `PrintLayout`（含 X-R05
 *   读回的工作表前缀 / 多区域 `_xlnm.Print_Area`）解析成结构化设置。
 *
 * ```ts
 * import { resolvePrintSettings, buildPrintPreview } from './rendering/index.js';
 * const preview = buildPrintPreview({ grid, settings: resolvePrintSettings(layout) });
 * preview.totalPages;               // 由几何真实算出的页数
 * preview.pages[1].titleRows;       // 第 2 页的重复标题行带
 * ```
 */

export {
  computePagePlan,
} from './paginate.js';

export {
  buildPrintPreview,
} from './preview.js';

export {
  expandHeaderFooterCodes,
  headerFooterForPage,
  headerFooterForPlanPage,
  splitHeaderFooterSections,
} from './header-footer.js';
export type { PageHeaderFooterText } from './header-footer.js';

export { parsePrintAreaList, resolvePrintSettings } from './resolve.js';

export {
  RenderingError,
  describeRenderingError,
} from './errors.js';
export type { RenderingErrorCode, RenderingErrorDetail } from './errors.js';

export {
  DEFAULT_MAX_DIGIT_WIDTH_PX,
  POINTS_PER_INCH,
  TWIPS_PER_INCH,
  TWIPS_PER_POINT,
  excelColumnWidthToTwips,
  excelRowHeightToTwips,
  inchesToTwips,
  paperSizeTwips,
  pixelsToTwips,
  pointsToTwips,
  twipsToInches,
  twipsToPoints,
} from './units.js';
export type { Twips } from './units.js';

export type {
  ColumnSpan,
  ContentBoxTwips,
  DiagnosticSeverity,
  HeaderFooterSections,
  PagePlan,
  PagePlanArea,
  PagePlanInput,
  PagePlanPage,
  PaginationDiagnostic,
  PaginationDiagnosticCode,
  PreviewPage,
  PrintPreview,
  ResolvedPrintSettings,
  RowSpan,
  SheetGridGeometry,
} from './types.js';
