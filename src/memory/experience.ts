/**
 * 经验生命周期：候选 → 敏感 / 冲突 / 去重检查 → 允许或拒绝 → **版本化写入**
 * （design-06 P4 / MEM-06；合同 R239）。
 *
 * ## **可以得出"不新增"**
 *
 * 这是 R239 里最容易被忽略、也最有价值的一条：经验维护不是"每次都要写点什么"。
 * 三值结论里 `no_change` 是一等结果——**候选与既有经验重复时，正确的动作是不新增**，
 * 而不是为了"有产出"而写一条同义的经验把库撑大。测试直接断言 `no_change` 可达。
 *
 * ## 未知外部结果**不固化成成功经验**
 *
 * `evidence_kind === 'unknown_external'` 的候选一律**拒绝**：外部结果未知（下单未知、
 * 回执未读回…）时把它写成"成功经验"，等于把未知固化成事实——这正是 R239 明令禁止的。
 *
 * ## 策略**可注入**（本层不硬编码）
 *
 * "什么算敏感"、"什么算冲突"由调用方注入（`isSensitive` / `detectConflict`），
 * 与 `src/facts/proposal.ts` 的 `isAuthorizedSource` 同风格：本层只负责**顺序**与
 * **结论的形状**，不替调用方决定策略。
 *
 * 纯函数：不含 IO、不含墙钟、不写库（写入由调用方把结果条目交给 `MemoryRepository.remember`）。
 */

import type { LogicalTime, Revision, TemplateId } from '../protocol/index.js';
import {
  createMemoryEntry,
  type MemoryId,
  type MemorySource,
  type OwnerId,
  type TemplateExperienceMemory,
} from './types.js';

/** 候选所依据的证据种类（封闭枚举）。 */
export const EXPERIENCE_EVIDENCE_KINDS = [
  'sealed_success', // 已封存且读回验证过的成功证据
  'sealed_failure', // 已封存的失败证据（可提炼"别再这么做"的经验）
  'unknown_external', // 外部结果**未知**（未读回 / 回执缺失）——不得固化成经验
] as const;
export type ExperienceEvidenceKind = (typeof EXPERIENCE_EVIDENCE_KINDS)[number];

/** 经验候选（由经验维护角色按已封存证据提出）。 */
export interface ExperienceCandidate {
  readonly template_id: TemplateId;
  readonly lesson: string;
  /** 依据的证据引用（**必须非空**——没有证据的经验是空口断言）。 */
  readonly evidence_refs: readonly string[];
  readonly evidence_kind: ExperienceEvidenceKind;
  readonly applies_to_version: string;
  /** 非空表示"本候选取代既有的某条同文本经验"（版本化更新的入口）。 */
  readonly supersedes_lesson: string | null;
}

/** 三值结论。`no_change` = **不新增**（R239）。 */
export const EXPERIENCE_DECISIONS = ['add', 'reject', 'no_change'] as const;
export type ExperienceDecisionKind = (typeof EXPERIENCE_DECISIONS)[number];

/** 结构化拒因码（封闭枚举）。 */
export const EXPERIENCE_REJECTION_REASONS = [
  'invalid_candidate', // 候选本身不成形（空经验 / 无证据）
  'unknown_external_result', // 外部结果未知（R239）
  'sensitive', // 含敏感信息
  'conflict', // 与既有经验冲突
  'missing_supersede_target', // 声明取代但找不到目标
] as const;
export type ExperienceRejectionReason = (typeof EXPERIENCE_REJECTION_REASONS)[number];

export interface ExperienceDecision {
  readonly decision: ExperienceDecisionKind;
  /** 结论的原因（`add` 时说明版本；`reject` / `no_change` 时说明判据）。**不得为空**。 */
  readonly reasons: readonly string[];
  /** 允许写入时给出的**待写条目**（由调用方交给 `MemoryRepository.remember`）；否则为 `null`。 */
  readonly entry: TemplateExperienceMemory | null;
}

export interface ExperienceContext {
  readonly owner_id: OwnerId;
  /** 同模板的既有经验（用于冲突 / 去重 / 版本号计算）。 */
  readonly existing: readonly TemplateExperienceMemory[];
  /** 敏感信息判定（调用方注入的策略）。 */
  readonly isSensitive: (candidate: ExperienceCandidate) => boolean;
  /** 冲突判定（调用方注入的策略）。 */
  readonly detectConflict: (
    candidate: ExperienceCandidate,
    existing: readonly TemplateExperienceMemory[],
  ) => boolean;
  /** 写入来源（保留来源是 R235 的硬要求）。 */
  readonly source: MemorySource;
  /** 生成新条目 id 的接缝（确定性）。 */
  readonly newMemoryId: () => MemoryId;
}

/**
 * 评估一个经验候选。检查顺序（沿用 R239 的列举）：
 *
 * 1. **成形**：经验文本非空、证据引用非空；
 * 2. **未知外部结果** ⇒ 拒绝（不固化成经验）；
 * 3. **敏感信息** ⇒ 拒绝；
 * 4. **冲突** ⇒ 拒绝；
 * 5. **去重**：既有有效经验里已有同文本 ⇒ **不新增**（`no_change`）；
 * 6. 否则 ⇒ `add`，并给出**版本化**的待写条目（版本 = 既有同模板最大版本 + 1）。
 */
export function evaluateExperienceCandidate(
  candidate: ExperienceCandidate,
  context: ExperienceContext,
  at: LogicalTime,
): ExperienceDecision {
  const active = context.existing.filter(
    (entry) => entry.template_id === candidate.template_id && entry.status === 'active',
  );

  if (
    typeof candidate.lesson !== 'string' ||
    candidate.lesson.length === 0 ||
    !Array.isArray(candidate.evidence_refs) ||
    candidate.evidence_refs.length === 0
  ) {
    return reject('invalid_candidate', '候选缺少经验文本或证据引用：没有证据的经验不得写入（R239）');
  }

  if (candidate.evidence_kind === 'unknown_external') {
    return reject(
      'unknown_external_result',
      '外部结果未知：不得把未知固化成成功经验（R239）——请等回执 / 读回证据后再提候选',
    );
  }

  if (context.isSensitive(candidate)) {
    return reject('sensitive', '候选含敏感信息：经验是通用模板经验，不得携带用户私有内容（MEM-06）');
  }

  if (candidate.supersedes_lesson !== null) {
    const target = active.find((entry) => entry.lesson === candidate.supersedes_lesson);
    if (target === undefined) {
      return reject(
        'missing_supersede_target',
        `候选声明取代经验 ${JSON.stringify(candidate.supersedes_lesson)}，但既有有效经验里找不到它`,
      );
    }
  }

  if (context.detectConflict(candidate, active)) {
    return reject('conflict', '候选与既有经验冲突：需先明确取代关系，不得两条并存的矛盾经验（R239）');
  }

  if (active.some((entry) => entry.lesson === candidate.lesson)) {
    return Object.freeze({
      decision: 'no_change',
      reasons: Object.freeze([
        '既有有效经验已包含同文本经验：正确动作是**不新增**，而不是写一条同义经验（R239）',
      ]),
      entry: null,
    });
  }

  const maxVersion = active.reduce((max, entry) => Math.max(max, entry.version), -1);
  const version = (maxVersion + 1) as Revision;

  const entry = createMemoryEntry({
    kind: 'template_experience',
    memory_id: context.newMemoryId(),
    owner_id: context.owner_id,
    scope: { kind: 'template', task_id: null, template_id: candidate.template_id },
    source: context.source,
    confirmation: 'unconfirmed', // 版本化写入后仍需确认（R235 的确认状态）
    created_at: at,
    updated_at: at,
    version,
    status: 'active',
    template_id: candidate.template_id,
    lesson: candidate.lesson,
    applies_to_version: candidate.applies_to_version,
  }) as TemplateExperienceMemory;

  return Object.freeze({
    decision: 'add',
    reasons: Object.freeze([
      candidate.supersedes_lesson === null
        ? `允许版本化写入：新经验版本 r${String(version)}`
        : `允许版本化写入：取代 ${JSON.stringify(candidate.supersedes_lesson)}，新版本 r${String(version)}`,
    ]),
    entry,
  });
}

function reject(reason: ExperienceRejectionReason, detail: string): ExperienceDecision {
  return Object.freeze({
    decision: 'reject',
    reasons: Object.freeze([`[${reason}] ${detail}`]),
    entry: null,
  });
}
