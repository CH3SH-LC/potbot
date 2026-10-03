/**
 * `apps/demo/rendering/**` —— design-05 **WF-089（PDF 导出）/ WF-090（打印交接）** 的宿主侧实现。
 *
 * ## 这个包在整条链里的位置
 *
 * 内核（`src/documents/**`）产出**真实 DOCX 字节**；本包把 DOCX 交给**真实排版引擎**（本机实测
 * 唯一可用的是 Microsoft Word 16.0.20430 的 COM `ExportAsFixedFormat`）导出 PDF，
 * **独立读回**核对后，再把 PDF 交给系统打印通路——并**只承认"已交接"**。
 *
 * ## 两层边界（**不得省略**）
 *
 * 1. **平台**：真实引擎是 **Windows 桌面专属**；目标平台是 **Android**。本包只覆盖电脑侧。
 *    **手机端 PDF 导出与打印完全未实现、未验证**（`MainActivity` 无 `PrintManager`，
 *    下载路径被 `setDownloadListener` 显式拒绝）。
 * 2. **声明**：只记「Microsoft Word 16.0.20430 通过」。**不得**据此外推成
 *    "安卓办公软件通过"（R156/R65）。
 *
 * ## 日常测试不碰 Word
 *
 * 真实引擎是**显式 opt-in**（环境变量 `POTBOT_PDF_REAL_ENGINE=1`，走 `scripts/demo/pdf-export.cmd`）。
 * 单测一律注入假端口，**不启动 Word**。
 */

export {
  PDF_ENGINE_FAILURE_KINDS,
  PDF_ENGINE_FAILURE_MEANINGS,
  engineFailure,
  isPdfEngineFailureKind,
} from './pdf-engine.js';
export type {
  PdfEngine,
  PdfEngineArtifact,
  PdfEngineFailure,
  PdfEngineFailureKind,
  PdfEngineIdentity,
  PdfEngineLicense,
  PdfEngineOutcome,
  PdfEngineRequest,
} from './pdf-engine.js';

export { PDF_READBACK_FAILURE_KINDS, readbackFailure } from './pdf-readback.js';
export type {
  PdfPageText,
  PdfReadback,
  PdfReadbackFailure,
  PdfReadbackFailureKind,
  PdfReadbackOutcome,
  PdfReadbackResult,
} from './pdf-readback.js';

export { currentByteLength, exportPdf, verifyFooterConsistency } from './pdf-export.js';
export type {
  FooterConsistency,
  PdfCheck,
  PdfExportDeps,
  PdfExportFailure,
  PdfExportOutcome,
  PdfExportRequest,
  PdfExportSuccess,
  PdfFooterHit,
} from './pdf-export.js';

export {
  EXTERNAL_ACTION_STATE_MEANINGS,
  PRINT_HANDOFF_BOUNDARIES,
  handOffPath,
  handOffToPrint,
} from './print-handoff.js';
export type {
  ExternalActionState,
  PrintHandoffHandedOff,
  PrintHandoffNotHandedOff,
  PrintHandoffOpenResult,
  PrintHandoffOutcome,
  PrintHandoffPlatform,
  PrintHandoffPort,
  PrintHandoffRequest,
} from './print-handoff.js';

export { createWindowsShellPrintHandoff, createUnsupportedPrintHandoff } from './print-handoff-windows.js';
export type { WindowsShellHandoffOptions } from './print-handoff-windows.js';

export { createWordComPdfEngine, pythonExecutable } from './word-com-engine.js';
export type { WordComEngineOptions } from './word-com-engine.js';

export { createPythonPdfReadback } from './python-readback.js';
export type { PythonReadbackOptions } from './python-readback.js';
