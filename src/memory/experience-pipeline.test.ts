/**
 * 经验流水线单测（design-06 P4 / MEM-06；合同 R239 / R240）。
 *
 * 核心断言：候选 → 检查 → 允许 / 拒绝 → **版本化写入**；
 * **未知外部结果不固化成成功经验**；顺序无关；写库失败如实报告。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTemplateId, type TemplateId } from '../protocol/index.js';
import {
  isExperiencePipelineClean,
  synthesizeExperiences,
  type ExperiencePipelineReport,
} from './experience-pipeline.js';
import type { ExperienceCandidate, ExperienceContext } from './experience.js';
import { createMemoryRepository } from './repository.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type OwnerId,
  type TemplateExperienceMemory,
} from './types.js';

const U1: OwnerId = asOwnerId('user-a');
const TPL: TemplateId = asTemplateId('template.document');
const AT = asLogicalTime(10);

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`pipe-${String(counter)}`);
}

function candidate(overrides: Partial<ExperienceCandidate> = {}): ExperienceCandidate {
  return {
    template_id: TPL,
    lesson: '图表与表格用同一套配色',
    evidence_refs: ['evidence-1'],
    evidence_kind: 'sealed_success',
    applies_to_version: '0.9.0',
    supersedes_lesson: null,
    ...overrides,
  };
}

function context(
  existing: readonly TemplateExperienceMemory[] = [],
  overrides: Partial<ExperienceContext> = {},
): ExperienceContext {
  return {
    owner_id: U1,
    existing,
    isSensitive: () => false,
    detectConflict: () => false,
    source: { kind: 'tool_result', detail: '已封存证据' },
    newMemoryId: nextId,
    ...overrides,
  };
}

function existingExperience(lesson: string, version = 0): TemplateExperienceMemory {
  return createMemoryEntry({
    kind: 'template_experience',
    memory_id: `existing-${lesson}-${String(version)}`,
    owner_id: U1,
    scope: { kind: 'template', task_id: null, template_id: TPL },
    source: { kind: 'tool_result', detail: '既有' },
    confirmation: 'confirmed',
    created_at: 1,
    updated_at: 1,
    version,
    status: 'active',
    template_id: TPL,
    lesson,
    applies_to_version: '0.9.0',
  }) as TemplateExperienceMemory;
}

describe('MEM-06：候选 → 允许 / 拒绝 / 不新增 → 版本化写入', () => {
  it('合格候选 ⇒ 允许并版本化写入（版本 0），且留下证据与适用条件', () => {
    const repo = createMemoryRepository();
    const report = synthesizeExperiences({
      candidates: [candidate()],
      context: context(),
      at: AT,
      repository: repo,
    });

    expect(report.accepted_lessons).toEqual(['图表与表格用同一套配色']);
    expect(report.written).toHaveLength(1);
    expect(report.written[0]?.version).toBe(0);
    expect(report.commits_failed).toHaveLength(0);
    expect(repo.listByKind('template_experience')).toHaveLength(1);

    const evidence = report.evidence_records[0];
    expect(evidence?.evidence_kind).toBe('sealed_success');
    expect(evidence?.evidence_refs).toEqual(['evidence-1']);
    expect(evidence?.applies_to_version).toBe('0.9.0');
    expect(evidence?.template_id).toBe(TPL);
  });

  it('**未知外部结果** ⇒ 拒绝固化，不写入库', () => {
    const repo = createMemoryRepository();
    const report = synthesizeExperiences({
      candidates: [candidate({ evidence_kind: 'unknown_external' })],
      context: context(),
      at: AT,
      repository: repo,
    });

    expect(report.accepted_lessons).toHaveLength(0);
    expect(report.blocked_unknown_external).toContain('图表与表格用同一套配色');
    expect(report.rejected[0]?.reason_codes).toContain('unknown_external_result');
    expect(report.written).toHaveLength(0);
    expect(repo.listByKind('template_experience')).toHaveLength(0);
    expect(isExperiencePipelineClean(report)).toBe(true);
  });

  it('**反向对照**：同 lesson 但证据已封存（sealed_success）⇒ 正常写入（阻塞只针对未知外部）', () => {
    const repo = createMemoryRepository();
    const report = synthesizeExperiences({
      candidates: [candidate({ evidence_kind: 'sealed_success' })],
      context: context(),
      at: AT,
      repository: repo,
    });
    expect(report.accepted_lessons).toHaveLength(1);
    expect(report.blocked_unknown_external).toHaveLength(0);
    expect(repo.listByKind('template_experience')).toHaveLength(1);
  });

  it('**反向对照**：敏感信息 ⇒ 拒绝，不写入', () => {
    const repo = createMemoryRepository();
    const report = synthesizeExperiences({
      candidates: [candidate({ lesson: '用户的手机号是 138xxxx' })],
      context: context([], { isSensitive: (c) => c.lesson.includes('手机号') }),
      at: AT,
      repository: repo,
    });
    expect(report.accepted_lessons).toHaveLength(0);
    expect(report.rejected[0]?.reason_codes).toContain('sensitive');
    expect(repo.listByKind('template_experience')).toHaveLength(0);
  });

  it('**反向对照**：与既有经验冲突 ⇒ 拒绝，不写入', () => {
    const repo = createMemoryRepository();
    const report = synthesizeExperiences({
      candidates: [candidate()],
      context: context([existingExperience('另一条经验')], { detectConflict: () => true }),
      at: AT,
      repository: repo,
    });
    expect(report.rejected[0]?.reason_codes).toContain('conflict');
    expect(repo.listByKind('template_experience')).toHaveLength(0);
  });

  it('**可以得出"不新增"**：同批重复候选去重为 no_change，库里只多一条', () => {
    const repo = createMemoryRepository();
    const report = synthesizeExperiences({
      candidates: [candidate(), candidate()],
      context: context(),
      at: AT,
      repository: repo,
    });
    expect(report.accepted_lessons).toHaveLength(1);
    expect(report.no_change_lessons).toHaveLength(1);
    expect(repo.listByKind('template_experience')).toHaveLength(1);
  });
});

describe('MEM-06：并发合并顺序无关 + 版本递增', () => {
  it('同一组候选换顺序 ⇒ 接受的 lesson 集合与版本分配一致', () => {
    const a = candidate({ lesson: 'A 经验', evidence_refs: ['e-a'] });
    const b = candidate({ lesson: 'B 经验', evidence_refs: ['e-b'] });
    const aDup = candidate({ lesson: 'A 经验', evidence_refs: ['e-a'] });

    const forward = synthesizeExperiences({
      candidates: [a, b, aDup],
      context: context(),
      at: AT,
      repository: createMemoryRepository(),
    });
    const reversed = synthesizeExperiences({
      candidates: [aDup, b, a],
      context: context(),
      at: AT,
      repository: createMemoryRepository(),
    });

    expect(forward.accepted_lessons).toEqual(['A 经验', 'B 经验']);
    expect(reversed.accepted_lessons).toEqual(forward.accepted_lessons);
    expect(forward.stable_order).toEqual(reversed.stable_order);
    expect(forward.written.map((w) => w.version)).toEqual([0, 1]);
    expect(reversed.written.map((w) => w.version)).toEqual([0, 1]);
  });

  it('版本化写入：新经验版本 = 既有同模板最大版本 + 1', () => {
    const repo = createMemoryRepository();
    const existing = [existingExperience('旧经验 A', 0), existingExperience('旧经验 B', 2)];
    const report = synthesizeExperiences({
      candidates: [candidate({ lesson: '全新的经验 C' })],
      context: context(existing),
      at: AT,
      repository: repo,
    });
    expect(report.written[0]?.version).toBe(3);
  });

  it('取代既有经验 ⇒ 新条写入，旧条失效但**历史不删**', () => {
    const repo = createMemoryRepository();
    const old = existingExperience('要被取代的经验', 0);
    expect(repo.remember(old).ok).toBe(true);

    const report = synthesizeExperiences({
      candidates: [candidate({ lesson: '更好的做法', supersedes_lesson: '要被取代的经验' })],
      context: context([old]),
      at: AT,
      repository: repo,
    });

    expect(report.written[0]?.superseded_invalidated).toBe(old.memory_id);
    const stored = repo.listByKind('template_experience');
    expect(stored).toHaveLength(2); // 旧条仍在（只是 disabled）
    const oldAfter = stored.find((entry) => entry.memory_id === old.memory_id);
    expect(oldAfter?.status).toBe('disabled');
    if (oldAfter?.kind !== 'template_experience') throw new Error('旧条应仍为模板经验');
    expect(oldAfter.lesson).toBe('要被取代的经验');
  });
});

describe('R240：写库失败如实报告', () => {
  it('落库失败 ⇒ written 为空、commits_failed 非空、pipeline 不干净', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          throw new Error('模拟写失败');
        },
      },
    });
    const report: ExperiencePipelineReport = synthesizeExperiences({
      candidates: [candidate()],
      context: context(),
      at: AT,
      repository: repo,
    });

    expect(report.accepted_lessons).toHaveLength(1);
    expect(report.written).toHaveLength(0);
    expect(report.commits_failed).toHaveLength(1);
    expect(repo.listByKind('template_experience')).toHaveLength(0);
    expect(isExperiencePipelineClean(report)).toBe(false);
  });

  it('纯评估模式（不给仓库）⇒ 不写库，也不报失败', () => {
    const report = synthesizeExperiences({
      candidates: [candidate()],
      context: context(),
      at: AT,
    });
    expect(report.accepted_lessons).toHaveLength(1);
    expect(report.written).toHaveLength(0);
    expect(report.commits_failed).toHaveLength(0);
    expect(isExperiencePipelineClean(report)).toBe(true);
  });

  it('无候选 ⇒ 全部为空，pipeline 干净', () => {
    const report = synthesizeExperiences({
      candidates: [],
      context: context(),
      at: AT,
      repository: createMemoryRepository(),
    });
    expect(report.accepted_lessons).toHaveLength(0);
    expect(report.no_change_lessons).toHaveLength(0);
    expect(report.rejected).toHaveLength(0);
    expect(isExperiencePipelineClean(report)).toBe(true);
  });
});
