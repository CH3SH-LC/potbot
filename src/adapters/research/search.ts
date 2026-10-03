/**
 * 检索：打分、去重、相关性筛选（RES-04）。
 *
 * - 打分用 BM25（k1=1.2, b=0.75）——纯本地、确定性、不需要任何模型；
 * - **去重**：跨来源的近似重复块（bigram Jaccard ≥ 阈值）只保留最高分的那条，
 *   其余记为 `duplicateOf`，并把来源列出（"同一份资料的两个副本"可见）；
 * - **相关性筛选**：低于 `max(绝对下限, 相对下限 × 最高分)` 的命中被剔除，
 *   并在结果里**记录被剔除的数量**，避免"看起来有结果其实都不相关"。
 */
import { normalizeForMatch, termFrequencies, tokenize, uniqueTerms } from './tokenize.js';
import type { Chunk, Hit } from './types.js';

export interface SearchOptions {
  /** 最多返回多少条命中。 */
  readonly limit?: number;
  /** 相对下限：低于 最高分 × 该值 的命中剔除。 */
  readonly relativeFloor?: number;
  /** 绝对下限：低于该分的命中剔除。 */
  readonly absoluteFloor?: number;
  /** 去重阈值：bigram Jaccard ≥ 该值视为重复。 */
  readonly dedupeThreshold?: number;
}

export interface DuplicateNote {
  readonly chunkId: string;
  readonly duplicateOfChunkId: string;
  readonly sourceId: string;
  readonly similarity: number;
}

export interface SearchResult {
  readonly hits: readonly Hit[];
  readonly duplicates: readonly DuplicateNote[];
  /** 参与打分的候选块数。 */
  readonly candidates: number;
  /** 因相关性下限被剔除的命中数。 */
  readonly filteredOut: number;
}

function bigramSet(text: string): Set<string> {
  const normalized = normalizeForMatch(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    out.add(normalized.slice(i, i + 2));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter += 1;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 对给定块集合执行检索。 */
export function searchChunks(
  chunks: readonly Chunk[],
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const limit = options.limit ?? 8;
  const relativeFloor = options.relativeFloor ?? 0.15;
  const absoluteFloor = options.absoluteFloor ?? 0;
  const dedupeThreshold = options.dedupeThreshold ?? 0.85;

  const queryTerms = uniqueTerms(query);
  if (queryTerms.length === 0 || chunks.length === 0) {
    return { hits: [], duplicates: [], candidates: chunks.length, filteredOut: 0 };
  }

  // 预计算每个块的分词与词频。
  const prepared = chunks.map((chunk) => {
    const terms = tokenize(chunk.text);
    return { chunk, tf: termFrequencies(terms), length: terms.length };
  });

  const df = new Map<string, number>();
  for (const p of prepared) {
    for (const term of new Set(p.tf.keys())) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const n = prepared.length;
  const avgLength = prepared.reduce((sum, p) => sum + p.length, 0) / Math.max(1, n);
  const k1 = 1.2;
  const b = 0.75;

  const scored: Hit[] = [];
  for (const p of prepared) {
    const matched: string[] = [];
    let score = 0;
    for (const term of queryTerms) {
      const tf = p.tf.get(term);
      if (tf === undefined) {
        continue;
      }
      matched.push(term);
      const docFreq = df.get(term) ?? 1;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      const norm = 1 - b + (b * p.length) / Math.max(1, avgLength);
      score += ((tf * (k1 + 1)) / (tf + k1 * norm)) * idf;
    }
    if (matched.length > 0 && score > 0) {
      scored.push({ chunk: p.chunk, score, matchedTerms: matched });
    }
  }

  scored.sort((a, b2) => {
    if (b2.score !== a.score) {
      return b2.score - a.score;
    }
    return a.chunk.chunkId < b2.chunk.chunkId ? -1 : a.chunk.chunkId > b2.chunk.chunkId ? 1 : 0;
  });

  // 跨来源去重：近似重复只留最高分。
  const duplicates: DuplicateNote[] = [];
  const kept: Hit[] = [];
  const keptBigrams: { hit: Hit; grams: Set<string>; normalized: string }[] = [];
  for (const hit of scored) {
    const grams = bigramSet(hit.chunk.text);
    const normalized = normalizeForMatch(hit.chunk.text);
    const dupOf = keptBigrams.find(
      (k) => k.normalized === normalized || jaccard(k.grams, grams) >= dedupeThreshold,
    );
    if (dupOf) {
      duplicates.push({
        chunkId: hit.chunk.chunkId,
        duplicateOfChunkId: dupOf.hit.chunk.chunkId,
        sourceId: hit.chunk.sourceId,
        similarity: Math.round(jaccard(dupOf.grams, grams) * 1000) / 1000,
      });
      continue;
    }
    kept.push(hit);
    keptBigrams.push({ hit, grams, normalized });
  }

  const topScore = kept[0]?.score ?? 0;
  const threshold = Math.max(absoluteFloor, relativeFloor * topScore);
  const beforeFilter = kept.length;
  const filtered = kept.filter((h) => h.score >= threshold);

  return {
    hits: filtered.slice(0, limit),
    duplicates,
    candidates: n,
    filteredOut: beforeFilter - filtered.length,
  };
}
