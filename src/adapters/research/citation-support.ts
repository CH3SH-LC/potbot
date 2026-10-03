/**
 * RES-05（补充落点）—— **回答与证据片段/出处的准确关联与支持性裁定**。
 *
 * 为什么是**新文件**而不是改 `citation.ts`：`citation.ts` 已是 RES-05 的"引用可回读"落点
 * （定位器 → 原文逐字回读），按本轮纪律「不改该目录既有文件」予以保留。本文件补上 RES-05
 * 尚未覆盖的另一半判据：
 *
 * 1. **关联性**：事实性陈述的引用必须指向**它自己依据的证据块**所在的来源；引用与证据对不上
 *    即判失败（"有引用"不等于"引用支持结论"）；
 * 2. **支持性**：证据**存在**但**不支持**结论时——这是最容易被糊弄过去的情形——必须判**失败**，
 *    而不是因为"有来源"就放行；
 * 3. **四类不得互相冒充**：fact 必须有可回读且被支持的引用；inference/advice 必须给出依据
 *    （derivedFrom 且可核对）；unknown 不得携带引用。
 *
 * 支持性用**词面覆盖 + 极性一致**判定（本地、确定性、可解释）。它是启发式而非语义证明：
 * 词面覆盖高但极性相反（"支持" vs "不支持"）判为 `contradicted`；覆盖不足判为 `unsupported`。
 * 本文件不含 `node:fs` / 墙钟 / 随机。
 */
import { verifyCitation } from './citation.js';
import { uniqueTerms } from './tokenize.js';
import type { Answer, Claim, ClaimKind, Citation } from './types.js';

/** 支持性裁定。 */
export type SupportVerdict =
  | 'supported'
  | 'unsupported'
  | 'contradicted'
  | 'insufficient-evidence'
  | 'derived'
  | 'not-applicable';

/** 一条可核对的证据片段。 */
export interface EvidenceSpan {
  /** 证据块 ID（与 `Chunk.chunkId` 同一命名口径）。 */
  readonly chunkId: string;
  /** 该证据所属来源。 */
  readonly sourceId: string;
  /** 证据**原文**（不是模型改写）。 */
  readonly text: string;
  /** 可选：指向原始文件的引用（用于可回读核对）。 */
  readonly citation?: Citation | null;
}

export interface SupportCheck {
  readonly verdict: SupportVerdict;
  /** 仅当 `verdict === 'supported'` 为 true。 */
  readonly ok: boolean;
  readonly reason: string;
  readonly checkedEvidence: number;
  readonly matchedTerms: readonly string[];
  /** 词面覆盖率（匹配词数 / 结论词数）。 */
  readonly coverage: number;
}

export interface SupportOptions {
  /** 判为"支持"所需的最低词面覆盖率，默认 0.5。 */
  readonly minCoverage?: number;
}

const NEGATION_MARKERS: readonly RegExp[] = Object.freeze([
  /不/,
  /无/,
  /非/,
  /未/,
  /没有/,
  /从未/,
  /绝不/,
  /\bnot\b/i,
  /\bno\b/i,
  /\bnever\b/i,
  /\bwithout\b/i,
  /\bcannot\b/i,
  /\bdoesn't\b/i,
  /\bisn't\b/i,
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 找出**被否定词直接限定**的词（如证据里的"不支持"之于词"支持"）。
 *
 * 为什么不用"文本里出现过任何否定词"这种粗粒度判据：`无需网络` 里的 `无` 并不否定
 * 结论中的任何词，用它判"极性相反"会把**支持**误判成**矛盾**。故只在否定标记**紧邻**
 * 某个共同证据词时才认定该词被否定。
 */
function negatedTerms(text: string, terms: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const term of terms) {
    const escaped = escapeRegExp(term);
    for (const marker of NEGATION_MARKERS) {
      if (new RegExp(`${marker.source}\\s*${escaped}`).test(text)) {
        out.add(term);
        break;
      }
    }
  }
  return out;
}

/** 抽取文本中的阿拉伯数字串（含小数），用于"数值是否被证据支持"的核对。 */
function numbersIn(text: string): string[] {
  return text.match(/[0-9]+(?:\.[0-9]+)?/g) ?? [];
}

/**
 * 裁定一段结论文本是否被给定证据**支持**。
 *
 * - 无证据 ⇒ `insufficient-evidence`（ok=false）；
 * - 有证据但**零共同词** ⇒ `unsupported`（ok=false）——「有来源但来源不支持结论仍判失败」；
 * - 覆盖率高但**极性相反** ⇒ `contradicted`（ok=false）；
 * - 覆盖率不足 ⇒ `unsupported`（ok=false）；
 * - 否则 `supported`（ok=true）。
 */
export function assessSupport(
  claimText: string,
  evidence: readonly EvidenceSpan[],
  options: SupportOptions = {},
): SupportCheck {
  const minCoverage = options.minCoverage ?? 0.5;
  const claimTerms = uniqueTerms(claimText);

  if (evidence.length === 0) {
    return {
      verdict: 'insufficient-evidence',
      ok: false,
      reason: '没有任何证据片段可供核对',
      checkedEvidence: 0,
      matchedTerms: [],
      coverage: 0,
    };
  }

  if (claimTerms.length === 0) {
    return {
      verdict: 'insufficient-evidence',
      ok: false,
      reason: '结论文本无可比对词',
      checkedEvidence: evidence.length,
      matchedTerms: [],
      coverage: 0,
    };
  }

  const evidenceTerms = new Set<string>();
  for (const span of evidence) {
    for (const term of uniqueTerms(span.text)) {
      evidenceTerms.add(term);
    }
  }

  const matched = claimTerms.filter((term) => evidenceTerms.has(term));
  const coverage = matched.length / claimTerms.length;

  if (matched.length === 0) {
    return {
      verdict: 'unsupported',
      ok: false,
      reason: '有来源，但来源内容与结论无任何共同证据词 —— 来源不支持该结论',
      checkedEvidence: evidence.length,
      matchedTerms: [],
      coverage: 0,
    };
  }

  // 数值核对：证据陈述了数字，但结论里的数字不在证据中 ⇒ 证据不支持该数值结论。
  const evidenceNumbers = new Set<string>();
  for (const span of evidence) {
    for (const n of numbersIn(span.text)) {
      evidenceNumbers.add(n);
    }
  }
  if (evidenceNumbers.size > 0) {
    const missingNumbers = numbersIn(claimText).filter((n) => !evidenceNumbers.has(n));
    if (missingNumbers.length > 0) {
      return {
        verdict: 'contradicted',
        ok: false,
        reason: `结论中的数值 ${missingNumbers.join('、')} 在证据中不存在（证据另有其数值），来源不支持该结论`,
        checkedEvidence: evidence.length,
        matchedTerms: matched,
        coverage,
      };
    }
  }

  // 极性核对：只在**共同证据词**被否定时才判矛盾（避免把"无需网络"误判成否定了结论）。
  const evidenceText = evidence.map((span) => span.text).join('\n');
  const claimNegated = negatedTerms(claimText, matched);
  const evidenceNegated = negatedTerms(evidenceText, matched);
  const polarityConflict = matched.some(
    (term) => claimNegated.has(term) !== evidenceNegated.has(term),
  );
  if (coverage >= minCoverage && polarityConflict) {
    return {
      verdict: 'contradicted',
      ok: false,
      reason: '证据与结论词面高度重合但极性相反（同一证据词一方否定、一方肯定），判为矛盾',
      checkedEvidence: evidence.length,
      matchedTerms: matched,
      coverage,
    };
  }

  if (coverage < minCoverage) {
    return {
      verdict: 'unsupported',
      ok: false,
      reason: `证据仅覆盖结论 ${(coverage * 100).toFixed(0)}% 的词（低于 ${(minCoverage * 100).toFixed(0)}% 门槛）`,
      checkedEvidence: evidence.length,
      matchedTerms: matched,
      coverage,
    };
  }

  return {
    verdict: 'supported',
    ok: true,
    reason: `证据覆盖结论 ${(coverage * 100).toFixed(0)}% 的词且极性一致`,
    checkedEvidence: evidence.length,
    matchedTerms: matched,
    coverage,
  };
}

/** 单条陈述的关联 + 支持性裁定。 */
export interface ClaimSupportResult {
  readonly kind: ClaimKind;
  readonly ok: boolean;
  readonly verdict: SupportVerdict;
  readonly reason: string;
  /** 仅 fact 会做词面支持裁定；其它类型为 null。 */
  readonly check: SupportCheck | null;
  /** 实际做回读核对的引用条数。 */
  readonly readbackChecked: number;
}

export interface ClaimVerifyOptions extends SupportOptions {
  /** 若提供：对引用做**可回读**核对（原始字节）。 */
  readonly bytesBySourceId?: ReadonlyMap<string, Uint8Array>;
}

function spanFor(
  chunkId: string,
  evidenceByChunkId: ReadonlyMap<string, EvidenceSpan>,
): EvidenceSpan | undefined {
  return evidenceByChunkId.get(chunkId);
}

/** 核对一条陈述：关联性 + 支持性 + 四类结构。 */
export function verifyClaimSupport(
  claim: Claim,
  evidenceByChunkId: ReadonlyMap<string, EvidenceSpan>,
  options: ClaimVerifyOptions = {},
): ClaimSupportResult {
  if (claim.kind === 'unknown') {
    if (claim.citations.length > 0) {
      return {
        kind: claim.kind,
        ok: false,
        verdict: 'not-applicable',
        reason: '未知项不得携带引用（引用意味着"查到了"）',
        check: null,
        readbackChecked: 0,
      };
    }
    return {
      kind: claim.kind,
      ok: true,
      verdict: 'not-applicable',
      reason: '未知项：正确地未携带引用，也未以模型知识填充',
      check: null,
      readbackChecked: 0,
    };
  }

  if (claim.kind === 'inference' || claim.kind === 'advice') {
    if (claim.derivedFrom.length === 0) {
      return {
        kind: claim.kind,
        ok: false,
        verdict: 'insufficient-evidence',
        reason: `${claim.kind} 陈述必须给出依据（derivedFrom）`,
        check: null,
        readbackChecked: 0,
      };
    }
    for (const chunkId of claim.derivedFrom) {
      if (spanFor(chunkId, evidenceByChunkId) === undefined) {
        return {
          kind: claim.kind,
          ok: false,
          verdict: 'insufficient-evidence',
          reason: `依据块 ${chunkId} 不在可核对证据集中`,
          check: null,
          readbackChecked: 0,
        };
      }
    }
    return {
      kind: claim.kind,
      ok: true,
      verdict: 'derived',
      reason: `${claim.kind} 陈述：依据 ${claim.derivedFrom.length} 个可核对证据块（推断/建议不要求词面全覆盖）`,
      check: null,
      readbackChecked: 0,
    };
  }

  // fact
  if (claim.citations.length === 0) {
    return {
      kind: claim.kind,
      ok: false,
      verdict: 'insufficient-evidence',
      reason: '事实性陈述必须带可回读引用（否则不得称为事实）',
      check: null,
      readbackChecked: 0,
    };
  }

  const evidence: EvidenceSpan[] = [];
  for (const chunkId of claim.derivedFrom) {
    const span = spanFor(chunkId, evidenceByChunkId);
    if (span === undefined) {
      return {
        kind: claim.kind,
        ok: false,
        verdict: 'insufficient-evidence',
        reason: `证据块 ${chunkId} 不在可核对证据集中`,
        check: null,
        readbackChecked: 0,
      };
    }
    evidence.push(span);
  }
  if (evidence.length === 0) {
    return {
      kind: claim.kind,
      ok: false,
      verdict: 'insufficient-evidence',
      reason: '事实性陈述未给出任何证据块（derivedFrom 为空）',
      check: null,
      readbackChecked: 0,
    };
  }

  // 关联性：引用必须指向证据来源之一，且部件非空。
  const evidenceSourceIds = new Set(evidence.map((span) => span.sourceId));
  for (const citation of claim.citations) {
    if (citation.parts.length === 0) {
      return {
        kind: claim.kind,
        ok: false,
        verdict: 'unsupported',
        reason: `引用（来源 ${citation.sourceId}）没有任何部件`,
        check: null,
        readbackChecked: 0,
      };
    }
    if (!evidenceSourceIds.has(citation.sourceId)) {
      return {
        kind: claim.kind,
        ok: false,
        verdict: 'unsupported',
        reason: `引用来源 ${citation.sourceId} 不属于该结论的证据片段（出处与证据不关联）`,
        check: null,
        readbackChecked: 0,
      };
    }
  }

  // 可回读：提供字节时才核对（否则如实标记未验证，不假装已核对）。
  let readbackChecked = 0;
  const bytesBySourceId = options.bytesBySourceId;
  if (bytesBySourceId !== undefined) {
    for (const citation of claim.citations) {
      const bytes = bytesBySourceId.get(citation.sourceId);
      if (bytes === undefined) {
        return {
          kind: claim.kind,
          ok: false,
          verdict: 'unsupported',
          reason: `引用来源 ${citation.sourceId} 无原始字节，无法回读核对`,
          check: null,
          readbackChecked,
        };
      }
      readbackChecked += 1;
      const verified = verifyCitation(citation, bytes);
      if (!verified.ok) {
        return {
          kind: claim.kind,
          ok: false,
          verdict: 'unsupported',
          reason: `引用回读失败：${verified.reason}`,
          check: null,
          readbackChecked,
        };
      }
    }
  }

  const check = assessSupport(claim.text, evidence, options);
  return {
    kind: claim.kind,
    ok: check.ok,
    verdict: check.verdict,
    reason: check.reason,
    check,
    readbackChecked,
  };
}

/** 整份回答的支持性报告。 */
export interface AnswerSupportReport {
  readonly ok: boolean;
  readonly claims: readonly ClaimSupportResult[];
  readonly failures: readonly string[];
}

/** 核对整份回答：逐条陈述做关联 + 支持性裁定，并核对空回答的形状。 */
export function verifyAnswerSupport(
  answer: Answer,
  evidenceByChunkId: ReadonlyMap<string, EvidenceSpan>,
  options: ClaimVerifyOptions = {},
): AnswerSupportReport {
  const claims: ClaimSupportResult[] = [];
  const failures: string[] = [];

  if (answer.isEmpty) {
    const only = answer.claims[0];
    if (answer.claims.length !== 1 || only === undefined || only.kind !== 'unknown') {
      failures.push('空回答必须恰为一条 kind="unknown" 的陈述');
    } else if (only.citations.length > 0) {
      failures.push('空回答的未知项不得携带引用');
    }
  }

  for (const [index, claim] of answer.claims.entries()) {
    const result = verifyClaimSupport(claim, evidenceByChunkId, options);
    claims.push(result);
    if (!result.ok) {
      failures.push(`第 ${index} 条（${claim.kind}）：${result.reason}`);
    }
  }

  return { ok: failures.length === 0, claims, failures };
}
