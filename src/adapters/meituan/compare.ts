/**
 * MT-05：**可解释**的筛选 / 比较 / 排序 / 硬条件冲突 / 缺资料处理。
 *
 * ## 可解释 = 每条候选都能回答"你凭什么这么排"
 *
 * 结果里的 {@link CandidateExplanation} 对每条候选逐项列出**排序键的取值**：
 * 用哪条软规则、取到什么值（未知就是 `null`，**不**当作 0）、以及被哪条硬条件、
 * 以什么理由淘汰。展示层据此能把"为什么这家排第一"讲清楚。
 *
 * ## 缺资料**不当零**（与 MT-03 同口径）
 *
 * 价格 / 距离未知的候选：硬条件**不会**让它蒙混过关（如实判"无法判断"），
 * 排序时排到最后但**保留**（不丢、不按 0 参与比较）。未知项在
 * `unknownFields` 里显式罗列。
 *
 * ## 宣传话术**结构上无法**影响规则
 *
 * 排序键只读候选的**结构化已知值**（价格 / 距离）。宣传话术本身是
 * `RawCandidate.promotionalText` 的**兄弟**属性，{@link normalizeCandidate} 归一时
 * 已把它丢弃；本模块的 {@link attachPromotionalNote} / {@link withStructuredNoise}
 * 是给测试用的**显式注入**通道，用来当场证明：注入"限时特惠！""全网最低价"
 * 之后，排序键与顺序**逐项不变**。
 *
 * ## 改条件可**重算**
 *
 * {@link recomputeComparison} 用同一个快照 + 新规则算出新版本结果（revision+1），
 * 不重新拉取数据，也不"记住"上一次的结论来复用。
 */

import {
  applyRules,
  type Candidate,
  type CandidateSourceKind,
  type HardRule,
  type Rejection,
  type SoftRule,
  type UserRules,
} from './candidates.js';

/** 参与比较的一次快照（同源数据；改条件只换规则，不换数据）。 */
export interface ComparisonSnapshot {
  readonly label: string;
  readonly candidates: readonly Candidate[];
  readonly capturedAtMs: number;
  /**
   * 随候选一并进来的**宣传话术**（来自分享 / 抓取的原文）。
   * 它**只**用于展示来源原文，**不**参与任何规则计算。
   */
  readonly promotionalNotes: readonly string[];
}

/** 单个排序维度的取值（`value === null` 表示该维度资料缺失）。 */
export interface SortKeyEntry {
  readonly rule: SoftRule;
  readonly value: number | null;
  readonly note: string;
}

export interface CandidateExplanation {
  readonly candidateId: string;
  readonly title: string;
  readonly sourceKind: CandidateSourceKind;
  readonly kept: boolean;
  readonly sortKeys: readonly SortKeyEntry[];
  readonly rejections: readonly string[];
  readonly unknownFields: readonly string[];
}

export interface ComparisonConflict {
  readonly rule: HardRule;
  readonly reason: string;
}

export interface ComparisonResult {
  /** 规则版本：改动条件即递增（可复算、可审计）。 */
  readonly revision: number;
  readonly rules: UserRules;
  readonly kept: readonly Candidate[];
  readonly rejected: readonly Rejection[];
  readonly conflicts: readonly ComparisonConflict[];
  readonly explanations: readonly CandidateExplanation[];
  /** 缺资料（未知值）的候选 id 清单（缺资料处理**可见**）。 */
  readonly missingDataCandidateIds: readonly string[];
  /**
   * **恒为 true**：宣传话术被**结构性地**排除在规则之外。
   * 写成字面量，使"话术影响排序"在类型层面不成立。
   */
  readonly promotionalTextIgnored: true;
  readonly note: string;
}

/** 计算一条候选在各软规则维度上的取值（未知 ⇒ null，**不**是 0）。 */
export function sortKeysFor(candidate: Candidate, soft: readonly SoftRule[]): readonly SortKeyEntry[] {
  return soft.map((rule) => {
    switch (rule.kind) {
      case 'preferCheaper':
        return candidate.price.known
          ? { rule, value: candidate.price.value.amountYuan, note: '标价（非最终价）' }
          : { rule, value: null, note: `价格未知（${candidate.price.reason}）⇒ 排到最后，不按 0 处理` };
      case 'preferCloser':
        return candidate.distanceKm.known
          ? { rule, value: candidate.distanceKm.value, note: '距离（km）' }
          : { rule, value: null, note: `距离未知（${candidate.distanceKm.reason}）⇒ 排到最后，不按 0 处理` };
    }
  });
}

/** 一条候选的未知项清单。 */
export function unknownFieldsFor(candidate: Candidate): readonly string[] {
  const unknowns: string[] = [];
  if (!candidate.price.known) unknowns.push(`价格：${candidate.price.reason}`);
  if (!candidate.stock.known) unknowns.push(`库存：${candidate.stock.reason}`);
  if (!candidate.businessHours.known) unknowns.push(`营业：${candidate.businessHours.reason}`);
  if (!candidate.route.known) unknowns.push(`路线：${candidate.route.reason}`);
  if (!candidate.distanceKm.known) unknowns.push(`距离：${candidate.distanceKm.reason}`);
  return unknowns;
}

/** 用给定规则对快照做一次完整比较（纯函数：同输入同输出）。 */
export function compareCandidates(
  snapshot: ComparisonSnapshot,
  rules: UserRules,
  revision: number,
): ComparisonResult {
  const outcome = applyRules(snapshot.candidates, rules);
  const keptIds = new Set(outcome.kept.map((candidate) => candidate.id));

  const explanations: CandidateExplanation[] = outcome.kept
    .map((candidate) => explain(candidate, true, rules, outcome.rejected))
    .concat(
      outcome.rejected
        .filter((entry) => !keptIds.has(entry.candidateId))
        .map((entry) => {
          const candidate = snapshot.candidates.find((item) => item.id === entry.candidateId);
          return candidate === undefined
            ? {
                candidateId: entry.candidateId,
                title: '(已不在快照中)',
                sourceKind: 'authorized_interface' as const,
                kept: false,
                sortKeys: sortKeysFor(placeholderCandidate(entry.candidateId), rules.soft),
                rejections: [entry.reason],
                unknownFields: [],
              }
            : explain(candidate, false, rules, outcome.rejected);
        }),
    );

  const missingDataCandidateIds = snapshot.candidates
    .filter((candidate) => unknownFieldsFor(candidate).length > 0)
    .map((candidate) => candidate.id);

  return {
    revision,
    rules,
    kept: outcome.kept,
    rejected: outcome.rejected,
    conflicts: outcome.conflicts,
    explanations,
    missingDataCandidateIds,
    promotionalTextIgnored: true,
    note:
      outcome.conflicts.length > 0
        ? '硬条件把候选筛空了：冲突已列出，请放宽条件后**重算**（不会把资料缺失的候选蒙混放行）。'
        : `按 ${String(rules.hard.length)} 条硬条件、${String(rules.soft.length)} 条软规则计算结果；` +
          '宣传话术（如"限时特惠！"）**未**参与任何排序键。',
  };
}

/** 用户改了条件 ⇒ **重算**（同一快照，规则版本 +1）。 */
export function recomputeComparison(
  snapshot: ComparisonSnapshot,
  previousRevision: number,
  rules: UserRules,
): ComparisonResult {
  return compareCandidates(snapshot, rules, previousRevision + 1);
}

function explain(
  candidate: Candidate,
  kept: boolean,
  rules: UserRules,
  rejected: readonly Rejection[],
): CandidateExplanation {
  return {
    candidateId: candidate.id,
    title: candidate.title,
    sourceKind: candidate.provenance.sourceKind,
    kept,
    sortKeys: sortKeysFor(candidate, rules.soft),
    rejections: rejected.filter((entry) => entry.candidateId === candidate.id).map((entry) => entry.reason),
    unknownFields: unknownFieldsFor(candidate),
  };
}

function placeholderCandidate(id: string): Candidate {
  return {
    id,
    title: id,
    provenance: { sourceKind: 'authorized_interface', sourceRef: '(snapshot)', fetchedAtMs: 0 },
    price: { known: false, reason: '不在快照中' },
    stock: { known: false, reason: '不在快照中' },
    businessHours: { known: false, reason: '不在快照中' },
    route: { known: false, reason: '不在快照中' },
    distanceKm: { known: false, reason: '不在快照中' },
    structured: {},
  };
}

/** 把一段宣传话术**并进快照的展示字段**（不触碰候选的结构化字段）。 */
export function attachPromotionalNote(snapshot: ComparisonSnapshot, note: string): ComparisonSnapshot {
  return { ...snapshot, promotionalNotes: [...snapshot.promotionalNotes, note] };
}

/**
 * 反向对照用的**显式注入**通道：把话术硬塞进候选的 `structured`。
 * 即使这样，排序键**只读价格 / 距离的已知值**，顺序依然不变——
 * 这正是"宣传话术不改变用户规则"的机器化证据。
 */
export function withStructuredNoise(candidate: Candidate, noise: string): Candidate {
  return { ...candidate, structured: { ...candidate.structured, promo: noise } };
}
