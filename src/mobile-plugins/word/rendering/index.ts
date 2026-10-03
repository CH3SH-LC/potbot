/**
 * **W09 — 手机侧 Word 排版计算（纯 TS）**公开出口。
 *
 * 只做计算：段落 → 行盒 → 页盒 + 页眉页脚占位；字体度量从 `FontMetricsPort` 注入。
 * 不接 Android、不调用 Windows Office、不读文件系统、无第三方依赖。
 *
 * 使用：
 * ```ts
 * import { layoutDocument } from './rendering/index.js';
 * const result = layoutDocument(spec, metricsPort, { substituteFont });
 * result.pages.length; // 真页数（由真实布局算出）
 * ```
 */

export {
  layoutDocument,
} from './layout.js';

export { LayoutError, assertMetricsPort, REQUIRED_METRICS_METHODS } from './errors.js';
export type { LayoutErrorCode, LayoutErrorDetail } from './errors.js';

export { FontResolver } from './fonts.js';
export type { FontResolution } from './fonts.js';

export { measureParagraph } from './line-break.js';
export type { MeasuredLine, MeasuredParagraph, MeasureContext, LineBreakReason } from './line-break.js';

export { paginate, placeLine } from './paginate.js';
export type { ContentBox, PaginateInput, PaginateOutput } from './paginate.js';

// ---- 表格图形排版（WF-056–070 手机侧几何层） ----
export { layoutTable, paginateTable } from './tables.js';
export type {
  TableSpec,
  TableRowSpec,
  TableCellSpec,
  CellPaddingTwips,
  TableBox,
  TableRowBox,
  TableCellBox,
  TableBorderSegment,
  TablePageSlice,
  PaginateTableOptions,
} from './tables.js';

// ---- WF-089/090 操作契约 ----
export {
  WORD_RENDERING_SCHEMA_VERSION,
  WORD_RENDER_OPERATIONS,
  EXTERNAL_RECEIPT_STATES,
  PRINT_HANDOFF_ALLOWED_STATES,
  findHostPathLeak,
  validateRenderPdfCommand,
  validatePrintHandoffCommand,
  validateWordRenderCommand,
  isPrintStateAllowed,
} from './operations.js';
export type {
  WordRenderOperation,
  OperationEnvelope,
  RenderPdfPayload,
  PrintHandoffPayload,
  RenderPdfCommand,
  PrintHandoffCommand,
  WordRenderCommand,
  OperationStatus,
  ExternalReceiptState,
  OperationIssue,
  ValidationResult,
  OperationResult,
} from './operations.js';

// ---- PDF 结构读回（纯 TS，第二份独立实现） ----
export { inspectPdf, readbackPdf } from './pdf-structure.js';
export type {
  PdfReadbackFailureKind,
  PdfReadbackFailure,
  PdfStructureFacts,
  PdfInspection,
  PdfReadbackOutcome,
} from './pdf-structure.js';

// ---- 打印交接裁决（打印交接 ≠ 打印） ----
export {
  PRINT_HANDOFF_STATES,
  PRINT_BOUNDARIES,
  evaluatePrintHandoff,
  canClaimPrinted,
} from './print-state.js';
export type {
  PrintHandoffState,
  PrintHandoffFailureKind,
  PrintHandoffFacts,
  PrintHandoffVerdict,
  ExternalPrintReceipt,
} from './print-state.js';

export { isCjkCodePoint, isSpaceCodePoint, codePointsOf, atomsOf } from './text.js';
export type { Atom, CharMetric } from './text.js';

export type {
  DiagnosticSeverity,
  FontMetricsPort,
  HeaderFooterBox,
  HeaderFooterSpec,
  LayoutDiagnostic,
  LayoutDiagnosticCode,
  LayoutDocumentSpec,
  LayoutOptions,
  LayoutResult,
  LineBox,
  LineBoxRun,
  PageBox,
  PageGeometry,
  ParagraphSpec,
  RunSpec,
  Twips,
} from './types.js';
