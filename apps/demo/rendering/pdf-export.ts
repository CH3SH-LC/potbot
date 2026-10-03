/**
 * design-05 **WF-089** 的**导出编排器**：引擎导出 → **独立读回** → 判据 → 结论。
 *
 * ## 一句话纪律
 *
 * **没有读回证据就不许说导出成功。** 引擎自报 `ok:true` 只是**必要条件**：
 * 真正的 `status:'exported_verified'` 要求独立读回器确认「存在、非空、**是 PDF 魔数**、
 * 页数 > 0（给定期望页数时还要相等）、给定期望页脚时**每一页都命中**」。
 *
 * ## 阶段化的结构化失败
 *
 * {@link PdfExportFailure.phase} 把失败钉在**发生的那一段**：
 * `engine`（引擎没导出）/ `readback`（读不回来）/ `verification`（读回了但判据不过）。
 * 三段互不冒充——"引擎说成功但产物是 HTML" 会落在 `verification`，不会被算成成功。
 *
 * ## 边界声明（必须随结论一起带出）
 *
 * 真实引擎是 **Microsoft Word 的 COM**，**Windows 桌面专属**；目标平台是 **Android**。
 * 本编排器做出的任何 `exported_verified` 结论，**只覆盖电脑侧**，
 * **不构成**手机端 PDF 能力的证据。
 */

import { existsSync, statSync } from 'node:fs';

import type { PdfEngine, PdfEngineIdentity, PdfEngineLicense, PdfEngineRequest } from './pdf-engine.js';
import type { PdfPageText, PdfReadback } from './pdf-readback.js';

// ---------------------------------------------------------------------------
// 请求 / 结果
// ---------------------------------------------------------------------------

export interface PdfExportRequest {
  readonly sourceDocxPath: string;
  readonly targetPdfPath: string;
  /** 引擎超时（毫秒）。默认 120000。 */
  readonly timeoutMs?: number;
  /** 期望页数；给定时必须与读回一致，否则判失败。 */
  readonly expectedPageCount?: number;
  /**
   * 期望**每一页**都命中的页脚正则。
   *
   * 约定：若正则含 **≥2 个捕获组**，则第 1 组当页码、第 2 组当总页数——
   * 会额外核对「页码逐页递增」与「总页数 == 读回页数」。
   */
  readonly expectedFooterPattern?: RegExp;
}

export interface PdfExportDeps {
  readonly engine: PdfEngine;
  readonly readback: PdfReadback;
}

/** 单条判据。**全部**为必需项：任一不过即失败（没有"可选判据"。 */
export interface PdfCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** 一条页脚命中（页号 + 原文 + 解析出的数字）。 */
export interface PdfFooterHit {
  readonly page: number;
  readonly text: string;
  readonly pageNumber: number | null;
  readonly ofPages: number | null;
}

export interface PdfExportSuccess {
  readonly status: 'exported_verified';
  readonly engine: PdfEngineIdentity;
  /** 授权提示原样带出——「未授权但可用」**必须**显式标出（R156/R158）。 */
  readonly license: PdfEngineLicense;
  readonly pdfPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly pageCount: number;
  readonly footerHits: readonly PdfFooterHit[];
  readonly checks: readonly PdfCheck[];
  readonly durationMs: number;
  /** 报告里可逐字粘贴的原始载荷（引擎报告 + 读回器 JSON）。 */
  readonly raw: { readonly engine: string; readonly readback: string };
}

export interface PdfExportFailure {
  readonly status: 'failed';
  readonly phase: 'engine' | 'readback' | 'verification';
  readonly kind: string;
  readonly message: string;
  readonly detail?: string;
  readonly checks: readonly PdfCheck[];
  readonly durationMs: number;
  readonly raw: { readonly engine: string; readonly readback: string };
}

export type PdfExportOutcome = PdfExportSuccess | PdfExportFailure;

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export async function exportPdf(
  deps: PdfExportDeps,
  request: PdfExportRequest,
): Promise<PdfExportOutcome> {
  const started = Date.now();
  const empty: PdfCheck[] = [];
  const noRaw = { engine: '', readback: '' };

  // 阶段 0：源文件在不在（还没轮到引擎）。
  if (!existsSync(request.sourceDocxPath)) {
    return {
      status: 'failed',
      phase: 'engine',
      kind: 'source_missing',
      message: `源 DOCX 不存在：${request.sourceDocxPath}`,
      checks: empty,
      durationMs: Date.now() - started,
      raw: noRaw,
    };
  }

  const engineRequest: PdfEngineRequest = {
    sourceDocxPath: request.sourceDocxPath,
    targetPdfPath: request.targetPdfPath,
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  // 阶段 1：引擎导出。
  const engineOutcome = await deps.engine.export(engineRequest);
  if (!engineOutcome.ok) {
    return {
      status: 'failed',
      phase: 'engine',
      kind: engineOutcome.failure.kind,
      message: engineOutcome.failure.message,
      ...(engineOutcome.failure.detail === undefined ? {} : { detail: engineOutcome.failure.detail }),
      checks: empty,
      durationMs: Date.now() - started,
      raw: { engine: engineOutcome.raw, readback: '' },
    };
  }
  const engineRaw = engineOutcome.raw;

  // 阶段 2：**独立**读回（不信任引擎自报）。
  const readbackOutcome = await deps.readback.inspect(request.targetPdfPath);
  if (!readbackOutcome.ok) {
    return {
      status: 'failed',
      phase: 'readback',
      kind: readbackOutcome.failure.kind,
      message: readbackOutcome.failure.message,
      ...(readbackOutcome.failure.detail === undefined ? {} : { detail: readbackOutcome.failure.detail }),
      checks: empty,
      durationMs: Date.now() - started,
      raw: { engine: engineRaw, readback: readbackOutcome.failure.detail ?? '' },
    };
  }
  const read = readbackOutcome.result;
  const readbackRaw = JSON.stringify(read);

  // 阶段 3：判据。
  const checks: PdfCheck[] = [];
  checks.push({
    name: 'file_non_empty',
    passed: read.byteLength > 0,
    detail: `读回字节数 = ${read.byteLength}`,
  });
  checks.push({
    name: 'pdf_magic',
    passed: read.magicOk,
    detail: `文件头 = ${JSON.stringify(read.magic)}（要求以 %PDF- 开头，防止改扩展名伪造）`,
  });
  checks.push({
    name: 'page_count_positive',
    passed: read.pageCount > 0,
    detail: `读回页数 = ${read.pageCount}`,
  });
  if (request.expectedPageCount !== undefined) {
    checks.push({
      name: 'expected_page_count',
      passed: read.pageCount === request.expectedPageCount,
      detail: `期望 ${request.expectedPageCount} 页，读回 ${read.pageCount} 页`,
    });
  }

  let footerHits: readonly PdfFooterHit[] = [];
  if (request.expectedFooterPattern !== undefined) {
    const footer = verifyFooterConsistency(read.pages, request.expectedFooterPattern, read.pageCount);
    footerHits = footer.hits;
    checks.push(...footer.checks);
  }

  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    return {
      status: 'failed',
      phase: 'verification',
      kind: 'verification_failed',
      message: `读回核对未通过 ${failed.length} 项：${failed.map((check) => check.name).join(', ')}`,
      detail: failed.map((check) => `${check.name}: ${check.detail}`).join(' | '),
      checks,
      durationMs: Date.now() - started,
      raw: { engine: engineRaw, readback: readbackRaw },
    };
  }

  return {
    status: 'exported_verified',
    engine: engineOutcome.identity,
    license: engineOutcome.identity.license,
    pdfPath: request.targetPdfPath,
    byteLength: read.byteLength,
    sha256: read.sha256,
    pageCount: read.pageCount,
    footerHits,
    checks,
    durationMs: Date.now() - started,
    raw: { engine: engineRaw, readback: readbackRaw },
  };
}

// ---------------------------------------------------------------------------
// 页脚一致性（独立可用，供脚本 / 测试复用）
// ---------------------------------------------------------------------------

export interface FooterConsistency {
  readonly hits: readonly PdfFooterHit[];
  readonly checks: readonly PdfCheck[];
}

/**
 * 核对"页脚文本与文档一致"。
 *
 * 判据（都在返回的 `checks` 里）：
 * 1. `footer_on_every_page` —— 给的正则在**每一页**都命中；
 * 2. `footer_page_numbers_ascending` —— 第 1 捕获组（页码）逐页递增（仅当有两个捕获组）；
 * 3. `footer_total_equals_page_count` —— 第 2 捕获组（总页数）等于读回页数（同上）。
 *
 * 正则里的 `g` / `y` 标志会被剥掉——带状态的 `lastIndex` 会让"同一页有时命中有时不命中"，
 * 这类抖动在验收里不可接受。
 */
export function verifyFooterConsistency(
  pages: readonly PdfPageText[],
  pattern: RegExp,
  pageCount: number,
): FooterConsistency {
  const flags = pattern.flags.replace(/[gy]/g, '');
  const stateless = new RegExp(pattern.source, flags);
  const hits: PdfFooterHit[] = [];

  for (const page of pages) {
    const found = stateless.exec(page.text);
    if (found !== null) {
      hits.push({
        page: page.page,
        text: found[0],
        pageNumber: found[1] === undefined ? null : Number.parseInt(found[1], 10),
        ofPages: found[2] === undefined ? null : Number.parseInt(found[2], 10),
      });
    }
  }

  const isMissing = (hit: PdfFooterHit): boolean => hit.pageNumber === null;
  const numbered = hits.filter((hit) => !isMissing(hit));
  const hasTwoGroups = numbered.length === hits.length && numbered.length > 0;

  const checks: PdfCheck[] = [
    {
      name: 'footer_on_every_page',
      passed: hits.length === pages.length && pages.length > 0,
      detail: `命中页数 ${hits.length} / 读回页数 ${pages.length}`,
    },
  ];

  if (hasTwoGroups) {
    const ascending = numbered.every(
      (hit, index) => index === 0 || (numbered[index - 1]?.pageNumber ?? -1) < (hit.pageNumber ?? -1),
    );
    checks.push({
      name: 'footer_page_numbers_ascending',
      passed: ascending,
      detail: `页码序列 = ${numbered.map((hit) => hit.pageNumber).join(',')}`,
    });
    checks.push({
      name: 'footer_total_equals_page_count',
      passed: numbered.every((hit) => hit.ofPages === pageCount),
      detail: `页脚总页数 = ${[...new Set(numbered.map((hit) => hit.ofPages))].join(',')}，读回页数 = ${pageCount}`,
    });
  }

  return { hits, checks };
}

// ---------------------------------------------------------------------------
// 落盘再核对的小工具（供调用方在交付前复查"盘上还是那份字节"）
// ---------------------------------------------------------------------------

/** 目标文件当前字节数；不存在返回 `null`。 */
export function currentByteLength(path: string): number | null {
  return existsSync(path) ? statSync(path).size : null;
}
