/**
 * 组装回答并**强制四类不得互相冒充**（RES-05）。
 *
 * 硬约束（构造即校验，违反抛错）：
 * - `fact` 必须带 ≥1 条可回读引用（无引用的"事实"根本不构造出来）；
 * - `inference` / `advice` 必须带 `derivedFrom`（说明依据哪些证据块）；
 * - `unknown` **不得**携带引用，也不得由模型已有知识填充——查不到就只会是
 *   "未找到"，并且回答里显式声明未使用模型既有知识（RES-01 的核心）。
 */
import { partsForRange } from './citation.js';
import type { Answer, Claim, ConflictLike, Citation, NormalizedDoc } from './types.js';
import type { Conflict } from './extract.js';
import type { SearchResult } from './search.js';

export interface AnswerOptions {
  /** 最多输出多少条事实性证据。 */
  readonly maxFacts?: number;
  /** 回答里展示的片段最长字符数（只是展示裁剪，引用里仍是完整单元原文）。 */
  readonly displayChars?: number;
}

/** 断言单条陈述的分类与结构相符。 */
export function assertClaimIntegrity(claim: Claim): void {
  switch (claim.kind) {
    case 'fact':
      if (claim.citations.length === 0) {
        throw new Error(`事实性陈述必须带可回读引用（否则不得称为事实）：${claim.text}`);
      }
      for (const c of claim.citations) {
        if (c.parts.length === 0) {
          throw new Error(`事实性陈述的引用为空部件：${claim.text}`);
        }
      }
      break;
    case 'inference':
    case 'advice':
      if (claim.derivedFrom.length === 0) {
        throw new Error(`${claim.kind} 陈述必须给出依据（derivedFrom）：${claim.text}`);
      }
      break;
    case 'unknown':
      if (claim.citations.length > 0) {
        throw new Error(`未知项不得携带引用（引用意味着"查到了"）：${claim.text}`);
      }
      break;
    default:
      break;
  }
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/**
 * 由检索结果构造回答。
 * @param docsBySourceId 用于把块区间映射成可回读引用。
 */
export function buildAnswer(
  query: string,
  result: SearchResult,
  docsBySourceId: ReadonlyMap<string, NormalizedDoc>,
  nameOfSource: (sourceId: string) => string,
  conflicts: readonly Conflict[],
  options: AnswerOptions = {},
): Answer {
  const maxFacts = options.maxFacts ?? 6;
  const displayChars = options.displayChars ?? 300;

  if (result.hits.length === 0) {
    const unknownClaim: Claim = {
      kind: 'unknown',
      text:
        '未找到与该查询相关的资料。本次只用用户资料检索，**不使用模型已有知识**作答；' +
        '如需联网检索，该能力当前未接通（见 not-ready 清单）。',
      citations: [],
      derivedFrom: [],
    };
    assertClaimIntegrity(unknownClaim);
    return { query, claims: [unknownClaim], isEmpty: true };
  }

  const claims: Claim[] = [];
  const usedChunks: string[] = [];
  for (const hit of result.hits.slice(0, maxFacts)) {
    const doc = docsBySourceId.get(hit.chunk.sourceId);
    if (!doc) {
      continue;
    }
    const parts = partsForRange(doc, hit.chunk.start, hit.chunk.end);
    const citation: Citation = {
      sourceId: hit.chunk.sourceId,
      sourceName: nameOfSource(hit.chunk.sourceId),
      parts,
    };
    const claim: Claim = {
      kind: 'fact',
      text: truncate(hit.chunk.text, displayChars),
      citations: [citation],
      derivedFrom: [hit.chunk.chunkId],
    };
    assertClaimIntegrity(claim);
    claims.push(claim);
    usedChunks.push(hit.chunk.chunkId);
  }

  if (claims.length === 0) {
    const unknownClaim: Claim = {
      kind: 'unknown',
      text: '命中的证据无法映射回来源文档（索引与来源不一致），因此不作答。',
      citations: [],
      derivedFrom: [],
    };
    assertClaimIntegrity(unknownClaim);
    return { query, claims: [unknownClaim], isEmpty: true };
  }

  const distinctSources = new Set(result.hits.map((h) => h.chunk.sourceId));
  const inference: Claim = {
    kind: 'inference',
    text:
      `以上 ${claims.length} 条证据来自 ${distinctSources.size} 个来源；` +
      (result.duplicates.length > 0
        ? `另有 ${result.duplicates.length} 条内容与其他来源近似重复，已标注去重（未重复计入）。`
        : '未发现跨来源的近似重复内容。'),
    citations: [],
    derivedFrom: usedChunks,
  };
  assertClaimIntegrity(inference);
  claims.push(inference);

  if (conflicts.length > 0) {
    const advice: Claim = {
      kind: 'advice',
      text:
        `检测到 ${conflicts.length} 处来源冲突（同一标签下不同来源数值不一致）；` +
        '建议向用户确认以哪个为准——本适配器不替用户裁决。',
      citations: [],
      derivedFrom: [...new Set(conflicts.flatMap((c) => c.entries.map((e) => e.chunkId)))],
    };
    assertClaimIntegrity(advice);
    claims.push(advice);
  }

  return { query, claims, isEmpty: false };
}

/** 把 Conflict 映射到统一形状（供展示层使用；不改变裁决口径）。 */
export function conflictLike(c: Conflict): ConflictLike {
  return {
    label: c.label,
    entries: c.entries.map((e) => ({ sourceId: e.sourceId, value: e.value })),
  };
}
