/**
 * ROLE-03：**经验维护智能体**（能力目录 §3；design-06 P3）。
 *
 * > 经验维护智能体按**已封存证据**提出经验候选，**可得出"不新增"**；
 * > **不自动当所有业务的固定审核者**，**不改权限或工具地址**。
 *
 * ## 四条约束落到结构上
 *
 * 1. **只按已封存证据提候选**：`proposeExperienceCandidates` 只接受
 *    `sealed === true && readback_verified === true` 的证据；未封存 / 未读回的证据一律
 *    以 `evidence_not_sealed` 结构化拒绝（不产出候选，也不静默跳过）。
 * 2. **可得出"不新增"**：结论直接复用 `src/memory` 的 `evaluateExperienceCandidate`
 *    （**只读复用、不改它**），因此 `no_change` 是一等结论——候选与既有经验同文本时，
 *    正确动作是**不新增**，而不是为了有产出写一条同义经验。
 * 3. **不是固定审核者**：本角色**不在任何业务流的必经路径上**。业务流通过
 *    `flowProceedsWithoutExperienceReview` 自证：经验审核缺席时流程照常推进。
 * 4. **不改权限 / 工具地址**：`assertNoPrivilegeMutation` 挡下一切 `permission_grant` /
 *    `tool_address_change` 写入尝试——**大声抛错**，不静默忽略（静默忽略会让越界隐形）。
 *
 * ## 未接真实执行器（如实标注）
 *
 * 本模块**纯函数、零 IO**：不含墙钟、不含随机数、不写库。候选→决定是纯计算；
 * 真正落库由宿主把 `decision.entry` 交给 `MemoryRepository.remember`（**本层不 import 仓储**）。
 * "知识从哪来、模型怎么读证据"这一步**未接真实模型**。
 */

import type { LogicalTime, TemplateId } from '../protocol/index.js';
import {
  evaluateExperienceCandidate,
  type ExperienceCandidate,
  type ExperienceContext,
  type ExperienceDecision,
  type ExperienceEvidenceKind,
  type TemplateExperienceMemory,
} from '../memory/index.js';
import { RoleBoundaryError, type RoleKind } from './types.js';

// ---------------------------------------------------------------------------
// 角色能力面（白名单）
// ---------------------------------------------------------------------------

/**
 * 经验维护智能体**允许**产出的东西：只有经验候选。
 * 它没有"改权限"或"改工具地址"的出口——这是 ROLE-03 后半句的结构化形态。
 */
export const EXPERIENCE_AGENT_SURFACE = Object.freeze({
  may_emit: Object.freeze(['experience_candidate'] as const),
  may_not_modify: Object.freeze(['permission_grant', 'tool_address_change'] as const),
});

/** 特权写入的种类（本角色一律不得触碰）。 */
export const PRIVILEGE_MUTATIONS = ['permission_grant', 'tool_address_change'] as const;
export type PrivilegeMutation = (typeof PRIVILEGE_MUTATIONS)[number];

export interface PrivilegeMutationAttempt {
  readonly kind: string;
  readonly target: string;
  readonly detail: string;
}

/**
 * 挡下越界的特权写入。
 *
 * 用途：宿主在把经验维护的**任何**副产物落库前调用一次。命中 `PRIVILEGE_MUTATIONS` ⇒ 抛
 * `RoleBoundaryError`（不返回 `false` 让调用方自行选择忽略——那正是"静默越界"的温床）。
 */
export function assertNoPrivilegeMutation(attempt: PrivilegeMutationAttempt): void {
  if ((PRIVILEGE_MUTATIONS as readonly string[]).includes(attempt.kind)) {
    throw new RoleBoundaryError(
      'experience_agent',
      `经验维护智能体不得执行 ${attempt.kind}（目标 ${attempt.target}）：` +
        `不改权限或工具地址（ROLE-03）。${attempt.detail}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 已封存证据 → 经验候选
// ---------------------------------------------------------------------------

/** 已封存证据的种类（与 `src/memory` 的证据种类一一对应）。 */
export interface SealedEvidence {
  readonly evidence_ref: string;
  readonly template_id: TemplateId;
  /** 是否**已封存**（证据本身已经成为不可变记录）。 */
  readonly sealed: boolean;
  /** 是否**读回验证**（有回执 / 读回证据，而非"我以为成功了"）。 */
  readonly readback_verified: boolean;
  /** 外部结果三值：`unknown_external` 不得固化成经验（沿用 R239）。 */
  readonly outcome: 'success' | 'failure' | 'unknown_external';
  readonly lesson: string;
  readonly applies_to_version: string;
  /** 非空表示"本候选取代既有的某条同文本经验"。 */
  readonly supersedes_lesson?: string | null;
}

export const EVIDENCE_REJECTION_CODES = [
  'evidence_not_sealed', // 未封存 / 未读回：不得作为经验依据
  'empty_evidence_set', // 没有任何证据
] as const;
export type EvidenceRejectionCode = (typeof EVIDENCE_REJECTION_CODES)[number];

export interface EvidenceRejection {
  readonly code: EvidenceRejectionCode;
  readonly evidence_ref: string;
  readonly detail: string;
}

export interface CandidateProposal {
  readonly candidates: readonly ExperienceCandidate[];
  /** 被拒的证据（如实记录，不静默丢弃）。 */
  readonly rejections: readonly EvidenceRejection[];
}

function evidenceKindOf(evidence: SealedEvidence): ExperienceEvidenceKind {
  switch (evidence.outcome) {
    case 'success':
      return 'sealed_success';
    case 'failure':
      return 'sealed_failure';
    case 'unknown_external':
      return 'unknown_external';
  }
}

/**
 * 由已封存证据提出经验候选。
 *
 * - 证据**必须** `sealed && readback_verified`；否则 `evidence_not_sealed`（不产出候选）。
 * - 一条证据 → 一条候选，候选的 `template_id` / `lesson` / `applies_to_version` 原样取自证据，
 *   证据引用只有 `evidence_ref` 一项（**没有证据的经验是空口断言**，这里不给这种可能）。
 * - `unknown_external` 的证据**仍是"已封存证据"**，会生成候选，但随后必被
 *   `evaluateExperienceCandidate` 以 `unknown_external_result` 拒绝——本层不替它下结论，
 *   只如实把它送进同一条裁决链（单一裁决来源）。
 */
export function proposeExperienceCandidates(
  evidence: readonly SealedEvidence[],
): CandidateProposal {
  const candidates: ExperienceCandidate[] = [];
  const rejections: EvidenceRejection[] = [];

  if (evidence.length === 0) {
    rejections.push(
      Object.freeze({
        code: 'empty_evidence_set' as const,
        evidence_ref: '',
        detail: '没有任何证据：经验维护不产出空口候选（可以得出"不新增"）',
      }),
    );
  }

  for (const item of evidence) {
    if (!item.sealed || !item.readback_verified) {
      rejections.push(
        Object.freeze({
          code: 'evidence_not_sealed' as const,
          evidence_ref: item.evidence_ref,
          detail:
            `证据 ${item.evidence_ref} 未封存或未读回验证：经验必须建立在已封存证据上（ROLE-03），` +
            '不得用"中途观察"或"我以为成功了"当依据',
        }),
      );
      continue;
    }
    candidates.push(
      Object.freeze({
        template_id: item.template_id,
        lesson: item.lesson,
        evidence_refs: Object.freeze([item.evidence_ref]),
        evidence_kind: evidenceKindOf(item),
        applies_to_version: item.applies_to_version,
        supersedes_lesson: item.supersedes_lesson ?? null,
      }),
    );
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    rejections: Object.freeze(rejections),
  });
}

// ---------------------------------------------------------------------------
// 裁决（单一来源：`src/memory` 的经验生命周期）
// ---------------------------------------------------------------------------

/** 一次经验审核的完整结果（含"不新增"）。 */
export interface ExperienceReview {
  readonly decisions: readonly ExperienceDecision[];
  /** 本次审核里是否得出过 `no_change`（"不新增"可达的直接取证）。 */
  readonly has_no_change: boolean;
}

/**
 * 按候选逐个裁决。**判定逻辑不在本层**——它就是 `src/memory` 的
 * `evaluateExperienceCandidate`（构造顺序、拒因码、"不新增"全在那里），
 * 本层只负责把它包成一个"经验维护智能体的一次审核"形状并统计。
 */
export function reviewExperienceCandidates(
  candidates: readonly ExperienceCandidate[],
  context: ExperienceContext,
  at: LogicalTime,
): ExperienceReview {
  const decisions = candidates.map((candidate) => evaluateExperienceCandidate(candidate, context, at));
  return Object.freeze({
    decisions: Object.freeze(decisions),
    has_no_change: decisions.some((decision) => decision.decision === 'no_change'),
  });
}

/** 一次审核里允许写入的待写条目（交给宿主的 `MemoryRepository.remember`）。 */
export function acceptedEntries(review: ExperienceReview): readonly TemplateExperienceMemory[] {
  return Object.freeze(
    review.decisions.flatMap((decision) =>
      decision.decision === 'add' && decision.entry !== null ? [decision.entry] : [],
    ),
  );
}

// ---------------------------------------------------------------------------
// 不是固定审核者
// ---------------------------------------------------------------------------

/**
 * 一条业务流的角色编排形状（宿主声明）。`mandatory_roles` 是**在流内必经**的角色集合。
 */
export interface BusinessFlowShape {
  readonly flow_id: string;
  readonly mandatory_roles: readonly RoleKind[];
}

/**
 * 本角色是否被**钉死**成所有业务的固定审核者（= 被写进某条流的必经角色）。
 *
 * 判据刻意只看"必经集合"：把经验维护挂成**可选旁听**（不在 `mandatory_roles` 里）就返回
 * `false`——那正是允许的形态（按需触发，而不是事事过审）。
 */
export function isFixedReviewerOf(flow: BusinessFlowShape): boolean {
  return flow.mandatory_roles.includes('experience_agent');
}

/**
 * 业务流在**经验审核缺席**时是否照常推进（= 审核不是必经点）。
 * 与 `isFixedReviewerOf` 互补，供宿主在注册流程时自证。
 */
export function flowProceedsWithoutExperienceReview(flow: BusinessFlowShape): boolean {
  return !isFixedReviewerOf(flow);
}
