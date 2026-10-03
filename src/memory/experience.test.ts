/**
 * 经验生命周期单测（design-06 P4 / MEM-06 / MEM-07；合同 R239）。
 *
 * 核心断言：**可以得出"不新增"**（`no_change` 是一等结论），
 * **未知外部结果不固化成经验**，**敏感 / 冲突被拒**，允许时**版本化写入**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTemplateId, type TemplateId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  evaluateExperienceCandidate,
  type ExperienceCandidate,
  type ExperienceContext,
  type OwnerId,
  type TemplateExperienceMemory,
} from './index.js';

const U1: OwnerId = asOwnerId('user-a');
const TPL: TemplateId = asTemplateId('template.document');
/** 评估发生时刻（逻辑时间需品牌化）。 */
const AT = asLogicalTime(10);

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`exp-${String(counter)}`);
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
  existing: readonly TemplateExperienceMemory[],
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

describe('R239：经验候选 → 允许 / 拒绝 / 不新增', () => {
  it('无既有经验 ⇒ 允许版本化写入（版本 0）', () => {
    const decision = evaluateExperienceCandidate(candidate(), context([]), AT);
    expect(decision.decision).toBe('add');
    expect(decision.entry?.version).toBe(0);
    expect(decision.entry?.kind).toBe('template_experience');
    expect(decision.reasons.join(' ')).toContain('版本化写入');
  });

  it('**可以得出"不新增"**：与既有有效经验同文本 ⇒ no_change（不写新条目）', () => {
    const existing = [existingExperience('图表与表格用同一套配色')];
    const decision = evaluateExperienceCandidate(candidate(), context(existing), AT);
    expect(decision.decision).toBe('no_change');
    expect(decision.entry).toBeNull();
    expect(decision.reasons.join(' ')).toContain('不新增');
  });

  it('未知外部结果 ⇒ 拒绝固化（不写成经验）', () => {
    const decision = evaluateExperienceCandidate(
      candidate({ evidence_kind: 'unknown_external' }),
      context([]),
      AT,
    );
    expect(decision.decision).toBe('reject');
    expect(decision.entry).toBeNull();
    expect(decision.reasons.join(' ')).toContain('unknown_external_result');
  });

  it('敏感信息 ⇒ 拒绝', () => {
    const decision = evaluateExperienceCandidate(
      candidate({ lesson: '用户的手机号是 138xxxx' }),
      context([], { isSensitive: () => true }),
      AT,
    );
    expect(decision.decision).toBe('reject');
    expect(decision.reasons.join(' ')).toContain('sensitive');
  });

  it('冲突 ⇒ 拒绝', () => {
    const decision = evaluateExperienceCandidate(
      candidate(),
      context([existingExperience('另一条经验')], { detectConflict: () => true }),
      AT,
    );
    expect(decision.decision).toBe('reject');
    expect(decision.reasons.join(' ')).toContain('conflict');
  });

  it('缺少经验文本或证据引用 ⇒ 拒绝（没有证据的经验不得写入）', () => {
    expect(evaluateExperienceCandidate(candidate({ evidence_refs: [] }), context([]), AT).decision).toBe('reject');
    expect(evaluateExperienceCandidate(candidate({ lesson: '' }), context([]), AT).decision).toBe('reject');
  });

  it('声明取代但找不到目标 ⇒ 拒绝', () => {
    const decision = evaluateExperienceCandidate(
      candidate({ supersedes_lesson: '并不存在的旧经验' }),
      context([]),
      AT,
    );
    expect(decision.decision).toBe('reject');
    expect(decision.reasons.join(' ')).toContain('missing_supersede_target');
  });

  it('版本化写入：新经验版本 = 既有同模板最大版本 + 1', () => {
    const existing = [existingExperience('旧经验 A', 0), existingExperience('旧经验 B', 2)];
    const decision = evaluateExperienceCandidate(
      candidate({ lesson: '全新的经验 C' }),
      context(existing),
      AT,
    );
    expect(decision.decision).toBe('add');
    expect(decision.entry?.version).toBe(3);
  });

  it('取代既有经验时也递增版本', () => {
    const existing = [existingExperience('要被取代的经验', 4)];
    const decision = evaluateExperienceCandidate(
      candidate({ lesson: '更好的做法', supersedes_lesson: '要被取代的经验' }),
      context(existing),
      AT,
    );
    expect(decision.decision).toBe('add');
    expect(decision.entry?.version).toBe(5);
  });
});

describe('R239 × R240：允许写入后仍可能存储失败，必须如实失败', () => {
  it('评估通过但写入失败 ⇒ 返回失败，不宣称已新增', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          throw new Error('模拟写失败');
        },
      },
    });
    const decision = evaluateExperienceCandidate(candidate(), context([]), AT);
    expect(decision.decision).toBe('add');
    if (decision.entry === null) throw new Error('应给出待写条目');

    const written = repo.remember(decision.entry);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.reason).toBe('store_failed');
    expect(repo.get(decision.entry.memory_id)).toBeUndefined();
  });

  it('评估通过且写入成功 ⇒ 经验进入模板经验存储', () => {
    const repo = createMemoryRepository();
    const decision = evaluateExperienceCandidate(candidate(), context([]), AT);
    if (decision.entry === null) throw new Error('应给出待写条目');
    expect(repo.remember(decision.entry).ok).toBe(true);
    expect(repo.listByKind('template_experience')).toHaveLength(1);
  });
});
