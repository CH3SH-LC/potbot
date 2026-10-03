/**
 * RES-05 收口 + RES-10 —— 把证据片段合成**最终正文**。
 *
 * 三条硬判据（各有断言，见同名 `.test.ts`）：
 *
 * 1. **四类不得互相冒充**：正文里每句话都带分类（fact / inference / advice / unknown）。
 *    `fact` 句**构造即校验**（复用 `answer.ts` 的 `assertClaimIntegrity`）：无引用的"事实"
 *    根本合不出来 —— 「不许无出处仍标事实」。
 * 2. **每句事实可回读**：`readbackComposedAnswer` 逐句回读，判据**直接复用**既有
 *    `citation-support.ts` 的 `verifyClaimSupport`（关联性 + 支持性 + 原始字节回读），
 *    **不另造一套口径**。因此「删掉来源」后，对应事实句必然变为"不可回读/失败"。
 * 3. **默认不加过程栏目**（能力目录 §2.6）：默认正文只含内容本身，不出现
 *    "已确认事实：""资料引用："这类过程栏目；但**必要来源数据**（`sources`）与
 *    **事实校验**（`readbackComposedAnswer` 报告）作为**结构化数据**保留，一个不少。
 *    只有**用户主动要求引用**时才附引用栏目；**来源原文**合法包含这些字样时一律原样
 *    保留、绝不机械删除 —— 机制上只丢弃本模块自己生成的 `origin: 'process'` 块。
 *
 * 本文件不含 `node:fs` / 墙钟 / 随机（确定性、可复现）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { assertClaimIntegrity } from './answer.js';
import { verifyClaimSupport, type ClaimVerifyOptions, type EvidenceSpan } from './citation-support.js';
import type { Claim, ClaimKind, Citation } from './types.js';

/**
 * 过程栏目标记：以这些字样**开头**的一行，形状上就是"过程栏目"。
 *
 * 注意：本模块**只**丢弃自己生成的 `origin: 'process'` 块；
 * `isProcessColumnLine` 只描述"形状"，绝不作为删除来源原文的依据
 * （来源原文合法包含这些词时不得机械删除）。
 */
export const PROCESS_COLUMN_MARKERS: readonly string[] = Object.freeze([
  '已确认事实：',
  '资料引用：',
  '引用来源：',
  '来源清单：',
  '证据列表：',
  '事实校验：',
  '引用：',
]);

/** 一行文本在**形状上**是否像过程栏目（仅形状判断，不用于删除来源原文）。 */
export function isProcessColumnLine(line: string): boolean {
  const trimmed = line.trimStart();
  return PROCESS_COLUMN_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/**
 * 正文块。
 * - `content`：正文句子 / 来源原文 —— **永不**被默认丢弃；
 * - `process`：本模块自己加的过程栏目 —— 默认丢弃，仅当用户主动要求引用时保留。
 */
export interface ProseBlock {
  readonly origin: 'content' | 'process';
  readonly text: string;
}

export interface RenderProseOptions {
  /** 用户是否**主动要求**引用/来源；false（默认）时丢弃 `process` 块。 */
  readonly userWantsCitations?: boolean;
}

/** 按块渲染最终正文：默认只留内容；用户主动要求引用时才保留过程栏目。 */
export function renderProse(
  blocks: readonly ProseBlock[],
  options: RenderProseOptions = {},
): string {
  const keepProcess = options.userWantsCitations ?? false;
  return blocks
    .filter((block) => block.origin === 'content' || keepProcess)
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** 一条最终正文里的句子。 */
export interface ComposedSentence {
  readonly index: number;
  readonly kind: ClaimKind;
  /** 句子文本 —— 与证据陈述**逐字一致**（不截断，截断会破坏可回读性）。 */
  readonly text: string;
  /** 该句依据的证据块 id（推断/建议必有；事实句亦给出）。 */
  readonly evidenceChunkIds: readonly string[];
  /** 事实句的可回读引用（构造时已校验非空）。 */
  readonly citations: readonly Citation[];
}

/** 正文里出现的来源（**必要来源数据**，结构化保留，不是过程栏目）。 */
export interface SourceAttribution {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly citationCount: number;
}

/** 合成后的最终正文。 */
export interface ComposedAnswer {
  readonly query: string;
  /** **最终正文**：默认不含任何过程栏目。 */
  readonly prose: string;
  readonly sentences: readonly ComposedSentence[];
  readonly isEmpty: boolean;
  /** 必要来源数据（去重计数）；默认正文里不展示，但数据保留。 */
  readonly sources: readonly SourceAttribution[];
}

export interface ComposeInput {
  readonly query: string;
  readonly claims: readonly Claim[];
  /** 空结果时为 true。 */
  readonly isEmpty?: boolean;
}

export interface ComposeOptions {
  /**
   * 用户是否**主动要求**引用/来源。
   * - false（默认）：正文只含内容，不出现"已确认事实：""资料引用："等过程栏目；
   * - true：在正文末尾附引用栏目（用户要求 ⇒ 不机械删除）。
   */
  readonly userWantsCitations?: boolean;
}

function collectSources(sentences: readonly ComposedSentence[]): SourceAttribution[] {
  const map = new Map<string, { sourceId: string; sourceName: string; citationCount: number }>();
  for (const sentence of sentences) {
    for (const citation of sentence.citations) {
      const existing = map.get(citation.sourceId);
      if (existing === undefined) {
        map.set(citation.sourceId, {
          sourceId: citation.sourceId,
          sourceName: citation.sourceName,
          citationCount: 1,
        });
      } else {
        existing.citationCount += 1;
      }
    }
  }
  return [...map.values()];
}

/** 生成引用栏目行（仅在用户主动要求引用时使用）。 */
function citationColumnLines(sentences: readonly ComposedSentence[]): ProseBlock[] {
  const blocks: ProseBlock[] = [{ origin: 'process', text: '引用：' }];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    for (const citation of sentence.citations) {
      for (const part of citation.parts) {
        const key = `${citation.sourceId}|${JSON.stringify(part.locator)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        blocks.push({ origin: 'process', text: `- ${citation.sourceName}：${part.quote}` });
      }
    }
  }
  return blocks;
}

/**
 * 把四类陈述合成**最终正文**。
 *
 * 构造即校验：任一条 `fact` 无引用、或 `inference`/`advice` 无依据、或 `unknown` 带引用，
 * 都**抛错**（四类不得互相冒充）。
 */
export function composeAnswer(input: ComposeInput, options: ComposeOptions = {}): ComposedAnswer {
  const userWantsCitations = options.userWantsCitations ?? false;

  const sentences: ComposedSentence[] = [];
  for (const claim of input.claims) {
    assertClaimIntegrity(claim);
    sentences.push({
      index: sentences.length,
      kind: claim.kind,
      text: claim.text,
      evidenceChunkIds: [...claim.derivedFrom],
      citations: [...claim.citations],
    });
  }

  const blocks: ProseBlock[] = sentences.map((sentence) => ({
    origin: 'content',
    text: sentence.text,
  }));
  if (userWantsCitations) {
    blocks.push(...citationColumnLines(sentences));
  }

  return {
    query: input.query,
    prose: renderProse(blocks, { userWantsCitations }),
    sentences,
    isEmpty: input.isEmpty ?? false,
    sources: collectSources(sentences),
  };
}

/** 单句回读结论。 */
export interface SentenceReadback {
  readonly index: number;
  readonly kind: ClaimKind;
  readonly ok: boolean;
  readonly verdict: string;
  readonly reason: string;
  /** 实际做回读核对的引用条数。 */
  readonly readbackChecked: number;
}

export interface ComposedReadbackReport {
  readonly ok: boolean;
  readonly sentences: readonly SentenceReadback[];
  readonly failures: readonly string[];
}

/**
 * 逐句回读合成后的正文。
 *
 * **判据来自 `citation-support.ts` 的 `verifyClaimSupport`，本函数不新造口径**：
 * - fact 句缺引用 / 引用出处与证据不关联 / 原始字节缺失 / 字节回读不符 / 来源不支持结论
 *   ⇒ 该句 `ok=false`；
 * - inference / advice 句无依据或依据块不在可核对集合 ⇒ `ok=false`；
 * - unknown 句带引用 ⇒ `ok=false`。
 *
 * 「删掉来源」有两种表现，都会被判失败：
 * (a) 证据块从 `evidenceByChunkId` 消失 ⇒ 理由含"不在可核对证据集中"；
 * (b) 只是取不到原始字节（`bytesBySourceId` 缺该来源）⇒ 理由含"无原始字节，无法回读核对"。
 */
export function readbackComposedAnswer(
  composed: ComposedAnswer,
  evidenceByChunkId: ReadonlyMap<string, EvidenceSpan>,
  options: ClaimVerifyOptions = {},
): ComposedReadbackReport {
  const sentences: SentenceReadback[] = [];
  const failures: string[] = [];

  for (const sentence of composed.sentences) {
    const claim: Claim = {
      kind: sentence.kind,
      text: sentence.text,
      citations: sentence.citations,
      derivedFrom: sentence.evidenceChunkIds,
    };
    const result = verifyClaimSupport(claim, evidenceByChunkId, options);
    sentences.push({
      index: sentence.index,
      kind: sentence.kind,
      ok: result.ok,
      verdict: result.verdict,
      reason: result.reason,
      readbackChecked: result.readbackChecked,
    });
    if (!result.ok) {
      failures.push(`第 ${sentence.index} 句（${sentence.kind}）：${result.reason}`);
    }
  }

  return { ok: failures.length === 0, sentences, failures };
}
