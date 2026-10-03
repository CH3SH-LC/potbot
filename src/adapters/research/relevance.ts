/**
 * RES-04 —— 多来源去重、相关性筛选、事实抽取（单位/日期识别）、
 * **来源冲突可见**与**覆盖不足可见**。
 *
 * 本文件是**新增**的落地文件：它把本目录既有的三块能力**组合**成一次"多来源相关性分析"
 * （`search.ts` 的去重 + 相关性筛选、`extract.ts` 的抽取 + 冲突检测、`tokenize.ts` 的切词），
 * 不修改其中任何一行。
 *
 * 它补上 RES-04 尚未单独落地的两条判据：
 *
 * 1. **来源冲突可见（且不裁决）**：两来源对同一标签给出不一致的量值时，必须**列出冲突**，
 *    而不是"取第一条"当作结论。故 `RelevanceResult.resolvedValue` **恒为 `null`**——
 *    这是机器化判据："有没有偷偷替用户裁决"看它就是。
 * 2. **覆盖不足可见**：把"查询词里哪些在资料中根本没有证据"与"结论是否只由单一来源支撑"
 *    显式列出来，避免"看起来有结果，其实覆盖不全"。
 *
 * 本文件不含 `node:fs` / 墙钟 / 随机。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { conflictLike } from './answer.js';
import { chunkDocument, DEFAULT_MAX_CHARS } from './chunk.js';
import { detectConflicts, extractFromChunk, type Conflict } from './extract.js';
import { searchChunks, type DuplicateNote, type SearchOptions } from './search.js';
import { uniqueTerms } from './tokenize.js';
import type { Chunk, ConflictLike, ExtractedValue, Hit, NormalizedDoc } from './types.js';

/** 参与分析的一份来源（调用方已解析完毕）。 */
export interface RelevanceSource {
  readonly doc: NormalizedDoc;
  readonly name: string;
  readonly taskId: string;
}

export interface RelevanceOptions extends SearchOptions {
  /** 判为"覆盖充分"所需的最低查询词覆盖率（默认 1，即每个查询词都要有证据）。 */
  readonly minCoverage?: number;
  readonly maxChars?: number;
}

/** 一组近似重复：保留者 + 被判为重复者 + 涉及来源。 */
export interface DedupeGroup {
  readonly keptChunkId: string;
  readonly duplicateChunkIds: readonly string[];
  readonly sourceIds: readonly string[];
}

/** 覆盖度报告（"覆盖不足"在此可见）。 */
export interface CoverageReport {
  readonly queryTerms: readonly string[];
  readonly coveredTerms: readonly string[];
  readonly uncoveredTerms: readonly string[];
  /** 命中词 / 查询词。查询词为空时为 0。 */
  readonly coverage: number;
  /** 命中涉及的**不同来源**数。 */
  readonly sourceCount: number;
  /** 有命中但只来自单一来源 ⇒ 缺少独立来源交叉验证。 */
  readonly singleSourceOnly: boolean;
  readonly insufficient: boolean;
  readonly reasons: readonly string[];
}

export interface RelevanceResult {
  readonly query: string;
  readonly hits: readonly Hit[];
  readonly duplicates: readonly DuplicateNote[];
  readonly dedupeGroups: readonly DedupeGroup[];
  /** 参与打分的候选块数。 */
  readonly candidates: number;
  /** 因相关性下限被剔除的命中数（相关性筛选发生了多少）。 */
  readonly filteredOut: number;
  /** 抽取出的事实（日期 / 带单位的量）。 */
  readonly extracted: readonly ExtractedValue[];
  readonly conflicts: readonly Conflict[];
  /** 冲突的统一展示形状（不裁决谁对）。 */
  readonly conflictViews: readonly ConflictLike[];
  /** **恒为 null**：本模块绝不替用户在冲突中选定一个值。 */
  readonly resolvedValue: null;
  readonly coverage: CoverageReport;
}

/** 把来源解析结果切成带归属的块。 */
function chunksOf(sources: readonly RelevanceSource[], maxChars: number): Chunk[] {
  const out: Chunk[] = [];
  for (const source of sources) {
    for (const draft of chunkDocument(source.doc, { maxChars })) {
      out.push({ ...draft, sourceName: source.name, taskId: source.taskId });
    }
  }
  return out;
}

function dedupeGroupsOf(duplicates: readonly DuplicateNote[]): DedupeGroup[] {
  const byKept = new Map<string, DuplicateNote[]>();
  for (const note of duplicates) {
    const list = byKept.get(note.duplicateOfChunkId) ?? [];
    list.push(note);
    byKept.set(note.duplicateOfChunkId, list);
  }
  return [...byKept.entries()].map(([keptChunkId, notes]) => ({
    keptChunkId,
    duplicateChunkIds: notes.map((n) => n.chunkId),
    sourceIds: [...new Set(notes.map((n) => n.sourceId))],
  }));
}

/**
 * 多来源相关性分析。
 *
 * @param sources 已解析的来源；调用方负责保证它们属于同一任务（本函数不做隔离判定，
 *                任务隔离由 `private-index.ts` / `private-corpus.ts` 在更外层的入口保证）。
 */
export function analyzeRelevance(
  sources: readonly RelevanceSource[],
  query: string,
  options: RelevanceOptions = {},
): RelevanceResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const minCoverage = options.minCoverage ?? 1;
  const chunks = chunksOf(sources, maxChars);
  const search = searchChunks(chunks, query, options);

  const byChunkId = new Map(chunks.map((c) => [c.chunkId, c]));
  const docOfSource = new Map(sources.map((s) => [s.doc.sourceId, s.doc]));

  // 抽取与冲突只在**命中的块**上做（与 index-store 同口径，避免全库噪声）。
  const hitChunks = search.hits.map((h) => h.chunk);
  const extracted = hitChunks.flatMap((chunk) => {
    const doc = docOfSource.get(chunk.sourceId);
    return doc ? extractFromChunk(doc, chunk) : [];
  });
  const textOfChunk = (chunkId: string): string => byChunkId.get(chunkId)?.text ?? '';
  const conflicts = detectConflicts(extracted, textOfChunk);

  // 覆盖度：查询词逐词核对是否有命中证据。
  const queryTerms = uniqueTerms(query);
  const coveredSet = new Set(search.hits.flatMap((h) => [...h.matchedTerms]));
  const coveredTerms = queryTerms.filter((t) => coveredSet.has(t));
  const uncoveredTerms = queryTerms.filter((t) => !coveredSet.has(t));
  const coverage = queryTerms.length === 0 ? 0 : coveredTerms.length / queryTerms.length;
  const sourceCount = new Set(search.hits.map((h) => h.chunk.sourceId)).size;
  const singleSourceOnly = search.hits.length > 0 && sourceCount <= 1;

  const reasons: string[] = [];
  if (uncoveredTerms.length > 0) {
    reasons.push(`以下查询词在资料中没有任何证据：${uncoveredTerms.join('、')}`);
  }
  if (singleSourceOnly) {
    reasons.push(`结论仅由单一来源支撑（来源数=${sourceCount}），缺少独立来源交叉验证`);
  }
  if (search.hits.length === 0) {
    reasons.push('没有任何命中证据（覆盖为空）');
  }
  const insufficient = search.hits.length === 0 || uncoveredTerms.length > 0 || singleSourceOnly || coverage < minCoverage;

  return {
    query,
    hits: search.hits,
    duplicates: search.duplicates,
    dedupeGroups: dedupeGroupsOf(search.duplicates),
    candidates: search.candidates,
    filteredOut: search.filteredOut,
    extracted,
    conflicts,
    conflictViews: conflicts.map(conflictLike),
    resolvedValue: null,
    coverage: {
      queryTerms,
      coveredTerms,
      uncoveredTerms,
      coverage,
      sourceCount,
      singleSourceOnly,
      insufficient,
      reasons,
    },
  };
}
