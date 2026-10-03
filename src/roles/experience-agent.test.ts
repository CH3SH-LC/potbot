/**
 * ROLE-03 经验维护智能体单测（design-06 P3；能力目录 §3，并复用 MEM-06 / R239 的裁决链）。
 *
 * 核心断言：只按**已封存证据**提候选、**可得出"不新增"**、
 * **不是所有业务的固定审核者**、**不改权限或工具地址**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTemplateId, type TemplateId } from '../protocol/index.js';
import { RoleBoundaryError } from './types.js';
import {
  acceptedEntries,
  assertNoPrivilegeMutation,
  flowProceedsWithoutExperienceReview,
  isFixedReviewerOf,
  proposeExperienceCandidates,
  reviewExperienceCandidates,
  type BusinessFlowShape,
  type SealedEvidence,
} from './index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type ExperienceContext,
  type TemplateExperienceMemory,
} from '../memory/index.js';

const TPL: TemplateId = asTemplateId('template.document');
const OWNER = asOwnerId('user-a');
const AT = asLogicalTime(7);

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`exp-${String(counter)}`);
}

function context(
  existing: readonly TemplateExperienceMemory[] = [],
  overrides: Partial<ExperienceContext> = {},
): ExperienceContext {
  return {
    owner_id: OWNER,
    existing,
    isSensitive: () => false,
    detectConflict: () => false,
    source: { kind: 'tool_result', detail: '已封存证据' },
    newMemoryId: nextId,
    ...overrides,
  };
}

function existingExperience(lesson: string): TemplateExperienceMemory {
  return createMemoryEntry({
    kind: 'template_experience',
    memory_id: `existing-${lesson}`,
    owner_id: OWNER,
    scope: { kind: 'template', task_id: null, template_id: TPL },
    source: { kind: 'tool_result', detail: '既有' },
    confirmation: 'confirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    template_id: TPL,
    lesson,
    applies_to_version: '0.9.0',
  }) as TemplateExperienceMemory;
}

function evidence(overrides: Partial<SealedEvidence> = {}): SealedEvidence {
  return {
    evidence_ref: 'ev-1',
    template_id: TPL,
    sealed: true,
    readback_verified: true,
    outcome: 'success',
    lesson: '图表与表格用同一套配色',
    applies_to_version: '0.9.0',
    ...overrides,
  };
}

describe('ROLE-03：只按已封存证据提候选', () => {
  it('已封存 + 已读回 ⇒ 产出候选', () => {
    const proposal = proposeExperienceCandidates([evidence()]);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.rejections).toEqual([]);
    expect(proposal.candidates[0]?.evidence_refs).toEqual(['ev-1']);
    expect(proposal.candidates[0]?.evidence_kind).toBe('sealed_success');
  });

  it('【反向对照】未封存 / 未读回的证据一律拒，不产出候选', () => {
    const proposal = proposeExperienceCandidates([
      evidence({ evidence_ref: 'ev-unsealed', sealed: false }),
      evidence({ evidence_ref: 'ev-no-readback', readback_verified: false }),
    ]);
    expect(proposal.candidates).toEqual([]);
    expect(proposal.rejections.map((r) => r.code)).toEqual(['evidence_not_sealed', 'evidence_not_sealed']);
    expect(proposal.rejections.map((r) => r.evidence_ref)).toEqual(['ev-unsealed', 'ev-no-readback']);
  });

  it('【反向对照】空证据集 ⇒ 也如实记一条拒因（不产出空口候选）', () => {
    const proposal = proposeExperienceCandidates([]);
    expect(proposal.candidates).toEqual([]);
    expect(proposal.rejections[0]?.code).toBe('empty_evidence_set');
  });
});

describe('ROLE-03：可得出"不新增"（no_change 是一等结论）', () => {
  it('既有经验已有同文本 ⇒ no_change，且在"不新增"时不写任何条目', () => {
    const lesson = '图表与表格用同一套配色';
    const proposal = proposeExperienceCandidates([evidence({ lesson })]);
    const review = reviewExperienceCandidates(proposal.candidates, context([existingExperience(lesson)]), AT);
    expect(review.has_no_change).toBe(true);
    expect(review.decisions[0]?.decision).toBe('no_change');
    expect(review.decisions[0]?.entry).toBeNull();
    expect(acceptedEntries(review)).toEqual([]);
  });

  it('没有既有经验 ⇒ add，且给出待写条目', () => {
    const proposal = proposeExperienceCandidates([evidence()]);
    const review = reviewExperienceCandidates(proposal.candidates, context(), AT);
    expect(review.has_no_change).toBe(false);
    expect(review.decisions[0]?.decision).toBe('add');
    expect(acceptedEntries(review)).toHaveLength(1);
  });

  it('【反向对照】unknown_external 证据生成的候选被拒（未知不得固化成经验）', () => {
    const proposal = proposeExperienceCandidates([evidence({ outcome: 'unknown_external' })]);
    // 它**仍是**已封存证据 ⇒ 会生成候选（本层不替它下结论）……
    expect(proposal.candidates).toHaveLength(1);
    // ……但走同一条裁决链后必被拒。
    const review = reviewExperienceCandidates(proposal.candidates, context(), AT);
    expect(review.decisions[0]?.decision).toBe('reject');
    expect(review.decisions[0]?.reasons.join('')).toContain('unknown_external_result');
  });

  it('【反向对照】敏感 / 冲突仍然走既有策略（本层不硬编码，也不放行）', () => {
    const proposal = proposeExperienceCandidates([evidence()]);
    const sensitive = reviewExperienceCandidates(proposal.candidates, context([], { isSensitive: () => true }), AT);
    const conflict = reviewExperienceCandidates(proposal.candidates, context([existingExperience('别的经验')], { detectConflict: () => true }), AT);
    expect(sensitive.decisions[0]?.decision).toBe('reject');
    expect(conflict.decisions[0]?.decision).toBe('reject');
  });
});

describe('ROLE-03：不是所有业务的固定审核者', () => {
  const normalFlow: BusinessFlowShape = {
    flow_id: 'flow.document',
    mandatory_roles: ['main_agent', 'group_fork'],
  };
  const badFlow: BusinessFlowShape = {
    flow_id: 'flow.everything',
    mandatory_roles: ['main_agent', 'experience_agent'],
  };

  it('经验维护不在必经角色里 ⇒ 不是固定审核者，流程不依赖它', () => {
    expect(isFixedReviewerOf(normalFlow)).toBe(false);
    expect(flowProceedsWithoutExperienceReview(normalFlow)).toBe(true);
  });

  it('【反向对照】被钉进必经角色 ⇒ 判据如实报 true（谓词不是恒假）', () => {
    expect(isFixedReviewerOf(badFlow)).toBe(true);
    expect(flowProceedsWithoutExperienceReview(badFlow)).toBe(false);
  });
});

describe('ROLE-03：不改权限或工具地址', () => {
  it('【反向对照】权限授予 / 工具地址变更 ⇒ 抛 RoleBoundaryError', () => {
    expect(() => assertNoPrivilegeMutation({ kind: 'permission_grant', target: 'calendar.write', detail: '' })).toThrow(
      RoleBoundaryError,
    );
    expect(() => assertNoPrivilegeMutation({ kind: 'tool_address_change', target: 'meituan.mcp', detail: '' })).toThrow(
      RoleBoundaryError,
    );
  });

  it('非特权写入（如经验候选）放行，不误伤', () => {
    expect(() =>
      assertNoPrivilegeMutation({ kind: 'experience_candidate', target: 'template.document', detail: '' }),
    ).not.toThrow();
  });
});
