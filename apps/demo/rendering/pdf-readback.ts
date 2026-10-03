/**
 * design-05 **WF-089** 的 **PDF 读回端口**。
 *
 * ## 这个端口是干什么的
 *
 * 判据要求："导出产物必须**读回并核对**（存在、非空、页数、是 PDF 魔数）"。
 * 读回必须由**独立工具**完成（合同 R167：不得 import 生产实现当预期值、
 * 不得读生成器自报的 `ok=true` 当结论）。真实实现调 Python `pypdf`
 * （见 {@link import('./python-readback.js').createPythonPdfReadback}），
 * 与 TS 侧**没有任何共享代码**。
 *
 * ## 缺工具必须显式失败
 *
 * 没装 `pypdf` 时**不是** skip、也不是"降级为通过"，而是
 * {@link PdfReadbackFailureKind} 的 `tool_missing`——调用方据此判失败。
 */

/** 读回失败分类（封闭枚举）。 */
export type PdfReadbackFailureKind =
  /** 读回工具本身缺失（例如没装 pypdf）——**显式失败，绝不计通过**。 */
  | 'tool_missing'
  /** 目标文件不存在。 */
  | 'file_missing'
  /** 文件存在但读回器解析失败（损坏 / 加密不可读）。 */
  | 'read_error'
  /** 读回器超时或进程异常退出。 */
  | 'tool_crashed';

export const PDF_READBACK_FAILURE_KINDS = [
  'tool_missing',
  'file_missing',
  'read_error',
  'tool_crashed',
] as const satisfies readonly PdfReadbackFailureKind[];

export interface PdfReadbackFailure {
  readonly kind: PdfReadbackFailureKind;
  readonly message: string;
  readonly detail?: string;
}

/** 单页文本。`text` 可能被读回器截断（见 {@link PdfReadbackResult.textTruncated}）。 */
export interface PdfPageText {
  readonly page: number;
  readonly text: string;
}

/** 读回到的**事实**（不含结论）。判定由 {@link import('./pdf-export.js').exportPdf} 的判据做。 */
export interface PdfReadbackResult {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  /** 文件头的原始字节（应形如 `%PDF-1.7`）。 */
  readonly magic: string;
  /** 文件头是不是 PDF 魔数 `%PDF-`。**这是"没有改扩展名伪造"的第一道判据。** */
  readonly magicOk: boolean;
  readonly pdfVersion: string | null;
  readonly pageCount: number;
  readonly encrypted: boolean;
  readonly pages: readonly PdfPageText[];
  readonly textTruncated: boolean;
  /** 读回器自报身份（例如 `pypdf 6.14.2`），用于在报告里点名工具版本。 */
  readonly tool: string;
}

export type PdfReadbackOutcome =
  | { readonly ok: true; readonly result: PdfReadbackResult }
  | { readonly ok: false; readonly failure: PdfReadbackFailure };

/** PDF 读回端口。 */
export interface PdfReadback {
  inspect(path: string): Promise<PdfReadbackOutcome>;
}

export function readbackFailure(
  kind: PdfReadbackFailureKind,
  message: string,
  detail?: string,
): PdfReadbackFailure {
  return detail === undefined ? { kind, message } : { kind, message, detail };
}
