/**
 * RES-03 —— 用户私有资料语料（TXT / Markdown / PDF / DOCX 的解析与检索）。
 *
 * 本文件是**新增**的落地文件：它**只读复用**本目录既有解析能力
 * （`parse/registry.ts` 的 `parseSource`、`chunk.ts`、`search.ts`、`privacy.ts`），
 * 不修改其中任何一行。它补上 RES-03 尚未单独落地的两条判据：
 *
 * 1. **扫描件/图片的 OCR 单独接通**：本文件定义 `OcrPort` 注入边界。
 *    **无端口 ⇒ 结构化"未就绪 + 原因 + 解锁条件"**，`ocrReadiness()` 可被能力发现读取；
 *    即使**装配了**端口，`verified_supported` 仍恒为 `false`——本仓**未对真实 OCR 引擎
 *    做端到端实测**，不得因为"接口写好了"就宣称 OCR 已接通。
 * 2. **不把文件名当内容**：`add()` 只按**解析出的正文**建块。文件名 / 扩展名 / 媒体类型
 *    只用于**选择解析器**，绝不进入可检索文本。因此：
 *    - 空正文（如空 txt、只有图片的 docx）⇒ 报"无内容"，不建块；
 *    - 只有文件名与查询词匹配、正文为空时，检索**必然不命中**，并由
 *      `CorpusSearchResult.emptyReason` 如实说明"不以文件名代替内容"。
 *
 * 三条纪律沿袭本目录既有口径：任务隔离（只检索同 taskId）、内容即数据（注入只上报）、
 * 本模块不出站。本文件不含 `node:fs` / 墙钟 / 随机。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { chunkDocument, DEFAULT_MAX_CHARS } from './chunk.js';
import { digestBytes } from './digest.js';
import { detectKind, parseSource } from './parse/registry.js';
import { scanForInjection, type InjectionFinding } from './privacy.js';
import { searchChunks, type DuplicateNote, type SearchOptions } from './search.js';
import type { Chunk, NormalizedDoc, ParseOutcome, Segment, SupportedKind } from './types.js';

// ---------------------------------------------------------------------------
// OCR 端口（扫描件 / 图片）
// ---------------------------------------------------------------------------

/** OCR 输入：原始字节 + 名字（仅用于诊断，不作为内容）。 */
export interface OcrInput {
  readonly sourceId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** OCR 结果：按页给出识别文本；失败给原因（不抛错、不留空当成功）。 */
export type OcrResult =
  | { readonly ok: true; readonly engine: string; readonly pages: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** 真实 OCR 端口 —— 由宿主实现（安卓可基于平台/本地引擎）。本模块不自行识别。 */
export interface OcrPort {
  readonly id: string;
  recognize(input: OcrInput): Promise<OcrResult>;
}

/** OCR 未就绪时的**固定原因**——措辞与 `not-ready.ts` 的 `research_ocr` 对齐。 */
export const NO_OCR_REASON =
  '未装配 OCR 端口（OcrPort）：本机无 OCR 引擎（tesseract / ocrmypdf 均不在 PATH）。' +
  '扫描件/图片一律登记为「未就绪」，绝不以文件名或模型知识编造内容。';

/** OCR 未就绪时的解锁条件（可核对、可执行）。 */
export const NO_OCR_UNLOCK: readonly string[] = Object.freeze([
  '由宿主实现 OcrPort 并注入 PrivateCorpus 构造函数',
  '在宿主中提供真实 OCR 引擎（本地优先，避免把用户资料外传）',
  '对一份真实扫描件做端到端实测（识别文本 + 页数），取得回执后再把该能力标为"已验证"',
]);

/** 能力发现用的 OCR 就绪摘要（五态，与 R231 同维度）。 */
export interface OcrReadiness {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly deps_ready: boolean;
  /** **恒为 false**：本仓未对真实 OCR 引擎做过端到端实测。 */
  readonly verified_supported: boolean;
  readonly portId: string | null;
  readonly reason: string | null;
  readonly unlock: readonly string[];
}

// ---------------------------------------------------------------------------
// 语料条目与检索结果
// ---------------------------------------------------------------------------

/** 证据来源类别：正文文本层 vs OCR 识别（识别文本不在原文文本层里，须可分辨）。 */
export type EvidenceKind = 'text-layer' | 'ocr-derived';

export type CorpusStatus = 'indexed' | 'ocr-required' | 'unsupported';

/** 一份资料纳入语料的结果（成功与失败都如实给）。 */
export interface CorpusEntryReport {
  readonly sourceId: string;
  readonly taskId: string;
  readonly name: string;
  readonly mediaType: string;
  /** 检测到的格式（`null` = 未识别）。仅用于诊断/分派，**不是内容**。 */
  readonly kind: SupportedKind | 'image' | 'xlsx' | 'pptx' | null;
  readonly status: CorpusStatus;
  readonly outcome: ParseOutcome;
  readonly textLength: number;
  readonly chunkCount: number;
  readonly evidenceKind: EvidenceKind;
  readonly reason: string | null;
  /** OCR 未就绪时的"原因 + 解锁条件"；其余情况为 null。 */
  readonly notReady: { readonly reason: string; readonly unlock: readonly string[] } | null;
  readonly injections: readonly InjectionFinding[];
  /** **恒为 false**：文件名/扩展名永不构成内容，故永不成为命中理由。 */
  readonly matchedByFileNameOnly: false;
}

/** 命中 —— 在既有 `Hit` 上补"证据来源类别"。 */
export interface CorpusHit {
  readonly chunk: Chunk;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly evidenceKind: EvidenceKind;
}

/** 空结果的**显式**原因（绝不返回"看起来有结果其实没有"）。 */
export interface CorpusEmptyReason {
  readonly code: 'no-sources' | 'no-readable-content' | 'no-match';
  readonly message: string;
}

export interface CorpusSearchResult {
  readonly hits: readonly CorpusHit[];
  readonly duplicates: readonly DuplicateNote[];
  readonly candidates: number;
  readonly filteredOut: number;
  /** 该任务下登记的资料份数（含未建块的）。 */
  readonly sourcesInScope: number;
  /** 该任务下真正建了块的资料份数。 */
  readonly indexedSources: number;
  /** `hits` 为空时必填。 */
  readonly emptyReason: CorpusEmptyReason | null;
}

export interface CorpusStats {
  readonly sources: number;
  readonly chunks: number;
  readonly indexed: number;
  readonly ocrRequired: number;
  readonly unsupported: number;
}

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

/** 由 OCR 页文本构造归一化文档（每页一个 `page` 定位器）。空识别结果返回 null。 */
function buildOcrDoc(
  sourceId: string,
  docKind: SupportedKind,
  pages: readonly string[],
): NormalizedDoc | null {
  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  pages.forEach((raw, index) => {
    const text = raw.trim();
    if (parts.length > 0) {
      cursor += 1; // 连接用 '\n' 计入偏移，与 text.ts / docx.ts 同口径
    }
    parts.push(text);
    segments.push({ start: cursor, end: cursor + text.length, locator: { kind: 'page', page: index + 1 } });
    cursor += text.length;
  });
  const text = parts.join('\n').trim();
  if (text.length === 0) {
    return null;
  }
  return { sourceId, kind: docKind, text, segments };
}

/**
 * 私有资料语料 —— 解析 → 建块 → 检索，全部只在同任务内。
 * 宿主只需注入（可选的）`OcrPort` 即可获得"图片/扫描件要么真识别、要么明说未就绪"的行为。
 */
export class PrivateCorpus {
  private chunks: Chunk[] = [];
  private readonly docs = new Map<string, NormalizedDoc>();
  private readonly entries = new Map<string, CorpusEntryReport>();
  /** chunkId → 证据来源类别（OCR 文本须可分辨）。 */
  private readonly evidenceKindOfChunk = new Map<string, EvidenceKind>();

  constructor(
    private readonly ocr: OcrPort | null = null,
    private readonly maxChars: number = DEFAULT_MAX_CHARS,
  ) {}

  /** 能力发现读取的 OCR 就绪摘要。 */
  ocrReadiness(): OcrReadiness {
    const port = this.ocr;
    const base = {
      installed: port !== null,
      enabled: port !== null,
      authorized: port !== null,
      deps_ready: port !== null,
      verified_supported: false as const,
      portId: port === null ? null : port.id,
    };
    return port === null
      ? { ...base, reason: NO_OCR_REASON, unlock: NO_OCR_UNLOCK }
      : {
          ...base,
          reason:
            'OCR 端口已装配，但本仓未对真实 OCR 引擎做过端到端实测（识别文本与页数未取得回执），' +
            '故 verified_supported 保持 false，不宣称 OCR 已接通。',
          unlock: NO_OCR_UNLOCK,
        };
  }

  /** 纳入一份资料。解析失败与 OCR 未就绪都**如实上报**，且**绝不**建空块。 */
  async add(
    taskId: string,
    name: string,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<CorpusEntryReport> {
    const sourceId = digestBytes(bytes);
    const kind = detectKind(name, mediaType);
    const parsed = parseSource(name, mediaType, bytes, sourceId);

    if (parsed.outcome === 'parsed') {
      const report = this.indexParsed(taskId, name, mediaType, kind, parsed.doc, 'text-layer');
      return report;
    }

    if (parsed.outcome === 'ocr-required') {
      const ocrReport = await this.tryOcr(taskId, name, mediaType, bytes, sourceId, kind);
      if (ocrReport !== null) {
        return ocrReport;
      }
      return this.recordNonIndexed(taskId, name, mediaType, kind, sourceId, 'ocr-required', null);
    }

    return this.recordNonIndexed(taskId, name, mediaType, kind, sourceId, 'unsupported', parsed.reason);
  }

  /** OCR 路径：无端口 ⇒ 未就绪；有端口 ⇒ 真识别，识别为空也当"无内容"。 */
  private async tryOcr(
    taskId: string,
    name: string,
    mediaType: string,
    bytes: Uint8Array,
    sourceId: string,
    kind: SupportedKind | 'image' | 'xlsx' | 'pptx' | null,
  ): Promise<CorpusEntryReport | null> {
    const port = this.ocr;
    if (port === null) {
      return this.recordNonIndexed(taskId, name, mediaType, kind, sourceId, 'ocr-required', null);
    }

    let result: OcrResult;
    try {
      result = await port.recognize({ sourceId, name, mediaType, bytes });
    } catch (error) {
      return this.recordNonIndexed(
        taskId,
        name,
        mediaType,
        kind,
        sourceId,
        'ocr-required',
        `OCR 端口调用失败：${(error as Error).message}`,
      );
    }

    if (!result.ok) {
      return this.recordNonIndexed(
        taskId,
        name,
        mediaType,
        kind,
        sourceId,
        'ocr-required',
        `OCR 未识别出内容：${result.reason}`,
      );
    }

    // 扫描 PDF 仍归 pdf；图片识别出的文本无原生格式，归 txt（kind 只在报告里保留原始检测结果）。
    const docKind: SupportedKind = kind === 'pdf' ? 'pdf' : 'txt';
    const doc = buildOcrDoc(sourceId, docKind, result.pages);
    if (doc === null) {
      return this.recordNonIndexed(
        taskId,
        name,
        mediaType,
        kind,
        sourceId,
        'ocr-required',
        `OCR 引擎（${result.engine}）未返回任何文本，按"无内容"处理`,
      );
    }
    return this.indexParsed(taskId, name, mediaType, kind, doc, 'ocr-derived');
  }

  private indexParsed(
    taskId: string,
    name: string,
    mediaType: string,
    kind: SupportedKind | 'image' | 'xlsx' | 'pptx' | null,
    doc: NormalizedDoc,
    evidenceKind: EvidenceKind,
  ): CorpusEntryReport {
    const drafts = chunkDocument(doc, { maxChars: this.maxChars });
    const chunks: Chunk[] = drafts.map((d) => ({ ...d, sourceName: name, taskId }));

    this.docs.set(doc.sourceId, doc);
    this.chunks = this.chunks.filter((c) => c.sourceId !== doc.sourceId).concat(chunks);
    for (const c of chunks) {
      this.evidenceKindOfChunk.set(c.chunkId, evidenceKind);
    }

    const report: CorpusEntryReport = {
      sourceId: doc.sourceId,
      taskId,
      name,
      mediaType,
      kind,
      status: 'indexed',
      outcome: 'parsed',
      textLength: doc.text.length,
      chunkCount: chunks.length,
      evidenceKind,
      reason: null,
      notReady: null,
      injections: scanForInjection(doc.text),
      matchedByFileNameOnly: false,
    };
    this.entries.set(doc.sourceId, report);
    return report;
  }

  private recordNonIndexed(
    taskId: string,
    name: string,
    mediaType: string,
    kind: SupportedKind | 'image' | 'xlsx' | 'pptx' | null,
    sourceId: string,
    outcome: 'ocr-required' | 'unsupported',
    detail: string | null,
  ): CorpusEntryReport {
    const reason =
      detail ??
      (outcome === 'ocr-required'
        ? NO_OCR_REASON
        : '解析失败：该资料没有可读正文（空正文不算「读到」，更不以文件名冒充内容）');
    const report: CorpusEntryReport = {
      sourceId,
      taskId,
      name,
      mediaType,
      kind,
      status: outcome,
      outcome,
      textLength: 0,
      chunkCount: 0,
      evidenceKind: 'text-layer',
      reason,
      notReady: outcome === 'ocr-required' ? { reason, unlock: NO_OCR_UNLOCK } : null,
      injections: [],
      matchedByFileNameOnly: false,
    };
    this.entries.set(sourceId, report);
    return report;
  }

  /** 检索：只在该任务的块内；空结果给**显式**原因。 */
  search(taskId: string, query: string, options: SearchOptions = {}): CorpusSearchResult {
    const scoped = this.chunks.filter((c) => c.taskId === taskId);
    const scopedEntries = [...this.entries.values()].filter((e) => e.taskId === taskId);
    const search = searchChunks(scoped, query, options);

    const hits: CorpusHit[] = search.hits.map((h) => ({
      chunk: h.chunk,
      score: h.score,
      matchedTerms: h.matchedTerms,
      evidenceKind: this.evidenceKindOfChunk.get(h.chunk.chunkId) ?? 'text-layer',
    }));

    let emptyReason: CorpusEmptyReason | null = null;
    if (hits.length === 0) {
      if (scopedEntries.length === 0) {
        emptyReason = { code: 'no-sources', message: '该任务下没有任何已登记资料。' };
      } else if (scoped.length === 0) {
        emptyReason = {
          code: 'no-readable-content',
          message:
            `已登记 ${scopedEntries.length} 份资料，但没有一份有可检索的正文` +
            '（格式不支持，或扫描件/图片的 OCR 未就绪）。**文件名不构成内容**，故不命中。',
        };
      } else {
        emptyReason = {
          code: 'no-match',
          message: `已有 ${scoped.length} 个正文块参与检索，但没有与查询相关的内容。`,
        };
      }
    }

    return {
      hits,
      duplicates: search.duplicates,
      candidates: search.candidates,
      filteredOut: search.filteredOut,
      sourcesInScope: scopedEntries.length,
      indexedSources: scopedEntries.filter((e) => e.status === 'indexed').length,
      emptyReason,
    };
  }

  /** 列出某任务下的全部资料（含未建块的），供诊断"为什么这份资料查不到"。 */
  listSources(taskId: string): readonly CorpusEntryReport[] {
    return [...this.entries.values()].filter((e) => e.taskId === taskId);
  }

  stats(): CorpusStats {
    const all = [...this.entries.values()];
    return {
      sources: all.length,
      chunks: this.chunks.length,
      indexed: all.filter((e) => e.status === 'indexed').length,
      ocrRequired: all.filter((e) => e.status === 'ocr-required').length,
      unsupported: all.filter((e) => e.status === 'unsupported').length,
    };
  }
}
