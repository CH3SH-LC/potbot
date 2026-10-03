/**
 * 经验并发 / 回滚 / 失效 / 实例固定快照单测（design-06 P4 / MEM-07；合同 R230 / R239）。
 *
 * 正反例：
 * - **正例**：同模板并发追加**合并确定性**（换顺序结果一致）、重复去重为 `no_change`；
 * - **反例 1**：执行中途到达的新经验**不改变**已签发的实例经验快照（R230）；
 * - **反例 2**：失效后再评估可**重新新增**；回滚撤销一次取代且历史不删。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTemplateId, type TemplateId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  commitExperienceDecision,
  createMemoryRepository,
  evaluateExperienceCandidate,
  invalidateExperience,
  mergeExperienceCandidates,
  pinExperienceSnapshot,
  rollbackExperience,
  type ExperienceCandidate,
  type ExperienceContext,
  type OwnerId,
  type TemplateExperienceMemory,
} from './index.js';

const U1: OwnerId = asOwnerId('user-a');
const TPL: TemplateId = asTemplateId('template.document');
const AT = asLogicalTime(10);

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`exp-${String(counter)}`);
}

function cand(lesson: string, overrides: Partial<ExperienceCandidate> = {}): ExperienceCandidate {
  return {
    template_id: TPL,
    lesson,
    evidence_refs: [`evidence-${lesson}`],
    evidence_kind: 'sealed_success',
    applies_to_version: '0.9.0',
    supersedes_lesson: null,
    ...overrides,
  };
}

function context(existing: readonly TemplateExperienceMemory[]): ExperienceContext {
  return {
    owner_id: U1,
    existing,
    isSensitive: () => false,
    detectConflict: () => false,
    source: { kind: 'tool_result', detail: '已封存证据' },
    newMemoryId: nextId,
  };
}

const repoExperiences = (repo: ReturnType<typeof createMemoryRepository>): readonly TemplateExperienceMemory[] =>
  repo.listByKind('template_experience').filter((e): e is TemplateExperienceMemory => e.kind === 'template_experience');

/** 便捷：对当前库状态评估并落库一条经验。 */
function addExperience(
  repo: ReturnType<typeof createMemoryRepository>,
  lesson: string,
  supersedes: string | null = null,
): void {
  const decision = evaluateExperienceCandidate(cand(lesson, { supersedes_lesson: supersedes }), context(repoExperiences(repo)), AT);
  const commit = commitExperienceDecision({
    repository: repo,
    owner_id: U1,
    decision,
    supersedes_lesson: supersedes,
    at: AT,
  });
  if (commit.kind !== 'written') throw new Error(`落库失败：${commit.kind}`);
}

describe('MEM-07 并发追加与合并（确定性）', () => {
  it('一批候选合并**与输入顺序无关**：接受的 lesson 与版本分配一致', () => {
    const batch = [cand('经验 A'), cand('经验 B'), cand('经验 C')];

    const forward = mergeExperienceCandidates(batch, context([]), AT);
    const reversed = mergeExperienceCandidates([...batch].reverse(), context([]), AT);

    expect(forward.accepted.map((entry) => entry.lesson)).toEqual(reversed.accepted.map((entry) => entry.lesson));
    expect(forward.accepted.map((entry) => entry.version)).toEqual(reversed.accepted.map((entry) => entry.version));
    expect(forward.order).toEqual(reversed.order); // 确定性顺序
  });

  it('同批里的重复候选去重为 no_change（不写两条同义经验）', () => {
    const batch = [cand('经验 A'), cand('经验 A'), cand('经验 B')];
    const merged = mergeExperienceCandidates(batch, context([]), AT);
    expect(merged.accepted.map((entry) => entry.lesson).sort()).toEqual(['经验 A', '经验 B']);
    expect(merged.no_change_count).toBe(1);
    expect(merged.rejected_count).toBe(0);
  });

  it('与既有有效经验重复的候选 ⇒ no_change（R239"不新增"）', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '经验 A');
    const merged = mergeExperienceCandidates([cand('经验 A')], context(repoExperiences(repo)), AT);
    expect(merged.accepted).toHaveLength(0);
    expect(merged.no_change_count).toBe(1);
  });
});

describe('MEM-07 落库与取代（历史不删）', () => {
  it('取代：写入新版本并把被取代的旧经验置为失效（值保留可审计）', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '旧做法');
    const old = repoExperiences(repo)[0];
    if (old === undefined) throw new Error('应有旧经验');

    addExperience(repo, '更好的做法', '旧做法');

    const oldAfter = repo.get(old.memory_id) as TemplateExperienceMemory;
    expect(oldAfter.lesson).toBe('旧做法'); // 历史原文仍在
    expect(oldAfter.status).toBe('disabled');
    const active = repoExperiences(repo).filter((entry) => entry.status === 'active');
    expect(active.map((entry) => entry.lesson)).toEqual(['更好的做法']);
  });

  it('reject / no_change 结论 ⇒ 不写库', () => {
    const repo = createMemoryRepository();
    const rejected = evaluateExperienceCandidate(cand('x', { evidence_kind: 'unknown_external' }), context([]), AT);
    const committed = commitExperienceDecision({
      repository: repo,
      owner_id: U1,
      decision: rejected,
      supersedes_lesson: null,
      at: AT,
    });
    expect(committed.kind).toBe('skipped');
    expect(repoExperiences(repo)).toHaveLength(0);
  });

  it('写入失败 ⇒ 如实 failed，不宣称已写入', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          throw new Error('模拟写失败');
        },
      },
    });
    const decision = evaluateExperienceCandidate(cand('经验 A'), context([]), AT);
    const committed = commitExperienceDecision({
      repository: repo,
      owner_id: U1,
      decision,
      supersedes_lesson: null,
      at: AT,
    });
    expect(committed.kind).toBe('failed');
    if (committed.kind !== 'failed') return;
    expect(committed.reason).toBe('store_failed');
    expect(repoExperiences(repo)).toHaveLength(0);
  });
});

describe('MEM-07 失效与重新评估', () => {
  it('失效后同 lesson 的候选可被**重新新增**（去重只针对有效经验）', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '经验 A');
    const first = repoExperiences(repo)[0];
    if (first === undefined) throw new Error('应有经验');

    // 未失效时：重复 ⇒ no_change
    const before = mergeExperienceCandidates([cand('经验 A')], context(repoExperiences(repo)), AT);
    expect(before.no_change_count).toBe(1);

    // 失效后：可重新新增
    const invalidated = invalidateExperience({
      repository: repo,
      owner_id: U1,
      memory_id: first.memory_id,
      at: AT,
      reason: 'succeeded 经验已过时',
    });
    expect(invalidated.kind).toBe('invalidated');

    const after = mergeExperienceCandidates([cand('经验 A')], context(repoExperiences(repo)), AT);
    expect(after.accepted).toHaveLength(1);
    expect(after.no_change_count).toBe(0);
  });
});

describe('MEM-07 回滚', () => {
  it('回滚一次取代：新条失效，前驱恢复；历史条目均保留', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '旧做法');
    addExperience(repo, '更好的做法', '旧做法');

    const newer = repoExperiences(repo).find((entry) => entry.lesson === '更好的做法');
    const older = repoExperiences(repo).find((entry) => entry.lesson === '旧做法');
    if (newer === undefined || older === undefined) throw new Error('应有两条经验');

    const rolled = rollbackExperience({
      repository: repo,
      owner_id: U1,
      memory_id: newer.memory_id,
      at: AT,
      reason: '用户要求回滚',
    });
    expect(rolled.kind).toBe('rolled_back');
    if (rolled.kind !== 'rolled_back') return;
    expect(rolled.restored).toBe(older.memory_id);

    const activelessons = repoExperiences(repo)
      .filter((entry) => entry.status === 'active')
      .map((entry) => entry.lesson);
    expect(activelessons).toEqual(['旧做法']);
    expect(repoExperiences(repo)).toHaveLength(2); // 历史都还在
  });

  it('回滚别人的经验 ⇒ 失败 owner_mismatch（跨用户隔离，R237）', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '经验 A');
    const entry = repoExperiences(repo)[0];
    if (entry === undefined) throw new Error('应有经验');
    const rolled = rollbackExperience({
      repository: repo,
      owner_id: asOwnerId('user-b'),
      memory_id: entry.memory_id,
      at: AT,
      reason: '越权尝试',
    });
    expect(rolled.kind).toBe('failed');
    if (rolled.kind !== 'failed') return;
    expect(rolled.reason).toBe('owner_mismatch');
  });
});

describe('MEM-07 实例固定经验快照（新经验不改执行中途的规则）', () => {
  it('反例：签发快照后到达的新经验**不进入**快照', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '经验 A');
    addExperience(repo, '经验 B');

    const snapshot = pinExperienceSnapshot({ repository: repo, owner_id: U1, template_id: TPL, at: AT });
    expect(snapshot.lessons).toEqual(['经验 A', '经验 B']);

    addExperience(repo, '经验 C'); // 执行中途到达的新经验

    expect(snapshot.lessons).toEqual(['经验 A', '经验 B']); // 快照不变
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.experience_ids).toHaveLength(2);
  });

  it('正例：重新签发快照才吃到新经验', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '经验 A');
    const first = pinExperienceSnapshot({ repository: repo, owner_id: U1, template_id: TPL, at: AT });
    addExperience(repo, '经验 B');
    const second = pinExperienceSnapshot({ repository: repo, owner_id: U1, template_id: TPL, at: asLogicalTime(20) });
    expect(first.lessons).toEqual(['经验 A']);
    expect(second.lessons).toEqual(['经验 A', '经验 B']);
  });

  it('快照条目按版本升序、跨用户隔离（拿不到别人的经验）', () => {
    const repo = createMemoryRepository();
    addExperience(repo, '经验 A');
    addExperience(repo, '经验 B');
    const snapshot = pinExperienceSnapshot({ repository: repo, owner_id: U1, template_id: TPL, at: AT });
    const versions = snapshot.entries.map((entry) => entry.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);

    const otherUser = pinExperienceSnapshot({
      repository: repo,
      owner_id: asOwnerId('user-b'),
      template_id: TPL,
      at: AT,
    });
    expect(otherUser.entries).toHaveLength(0);
  });
});
