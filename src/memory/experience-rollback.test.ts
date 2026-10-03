/**
 * 经验回滚 / 失效 / 重新评估 与 实例固定经验快照隔离 单测
 * （design-06 P4 / MEM-07；合同 R230 / R239 / R240）。
 *
 * 每条子项都配**反向对照**：
 * - 回滚：回滚**未写入**的版本 / 版本不匹配 / 跨用户 ⇒ 失败，且库不被改动；
 * - 失效：**无依据**（缺原因 / 缺依据 / 缺证据引用）⇒ 失败，条目保持有效；
 * - 重新评估：**无证据**（缺理由 / 缺证据引用）⇒ 失败（`reactivated` 与 `stays_invalid` 都要求证据）；
 * - 实例隔离：**旧实例不得被新规则改写**——回滚 / 失效后 `frozen_rules` 不变，
 *   而 `instanceRuleDiff().removed_since_binding` 如实暴露差；
 * - 并发：批次回滚**与输入顺序无关**；含不合规目标 ⇒ **整批不执行（无半状态）**；
 *   并发追加部分失败 ⇒ 已写入部分被回滚，有效集合**回到追加前**。
 *
 * 边界：单进程内顺序执行；**未做真实跨进程 / 多线程并发**（见模块头注）。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asRevision, asTemplateId, type TemplateId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  type MemoryId,
  type MemorySource,
  type OwnerId,
  type TemplateExperienceMemory,
} from './types.js';
import { createMemoryRepository, type MemoryRepository } from './repository.js';
import type { ExperienceCandidate } from './experience.js';
import {
  appendExperiencesConcurrently,
  bindInstanceExperience,
  instanceRules,
  rebindInstance,
  resolveInstanceRule,
} from './experience-concurrency.js';
import {
  concurrentAppendThenRollback,
  injectableExperienceLessons,
  instanceRuleDiff,
  invalidateExperienceVersion,
  isExperienceInjectable,
  reevaluateExperience,
  rollbackExperienceBatch,
  rollbackExperienceWrite,
  type ExperienceInvalidationRecord,
} from './experience-rollback.js';

const U1: OwnerId = asOwnerId('user-a');
const TPL: TemplateId = asTemplateId('template.document');
const AT = asLogicalTime(10);
const AT2 = asLogicalTime(20);
const SOURCE: MemorySource = { kind: 'tool_result', detail: '已封存证据' };

/** 每个仓库用一份独立、确定性的 id 工厂（便于跨仓库逐字段比对）。 */
function idFactory(): () => MemoryId {
  let n = 0;
  return () => {
    n += 1;
    return asMemoryId(`exp-${String(n)}`);
  };
}

function cand(lesson: string, supersedes: string | null = null): ExperienceCandidate {
  return {
    template_id: TPL,
    lesson,
    evidence_refs: [`evidence-${lesson}`],
    evidence_kind: 'sealed_success',
    applies_to_version: '0.9.0',
    supersedes_lesson: supersedes,
  };
}

function append(
  repo: MemoryRepository,
  candidates: readonly ExperienceCandidate[],
  newMemoryId: () => MemoryId,
  at = AT,
): ReturnType<typeof appendExperiencesConcurrently> {
  return appendExperiencesConcurrently({
    repository: repo,
    owner_id: U1,
    candidates,
    at,
    isSensitive: () => false,
    detectConflict: () => false,
    source: SOURCE,
    newMemoryId,
  });
}

function allEntries(repo: MemoryRepository): TemplateExperienceMemory[] {
  return repo
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience');
}

const activeLessons = (repo: MemoryRepository): string[] =>
  allEntries(repo)
    .filter((entry) => entry.status === 'active')
    .map((entry) => entry.lesson)
    .sort();

function findByLesson(repo: MemoryRepository, lesson: string): TemplateExperienceMemory {
  const found = allEntries(repo).find((entry) => entry.lesson === lesson);
  if (found === undefined) throw new Error(`应有经验「${lesson}」`);
  return found;
}

// ---------------------------------------------------------------------------
// 回滚：保留历史 + 检索不再命中 + 未写入必须失败
// ---------------------------------------------------------------------------

describe('MEM-07 回滚（针对一次具体写入；保留历史）', () => {
  it('正例：回滚已写入的版本 ⇒ 停用、历史保留、检索/注入不再命中', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(true);
    expect(injectableExperienceLessons(repo, U1, TPL)).toEqual(['经验 A']);

    const rolled = rollbackExperienceWrite({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      expected_version: entry.version,
      at: AT2,
      reason: '用户要求回滚这次写入',
    });

    expect(rolled.kind).toBe('rolled_back');
    if (rolled.kind !== 'rolled_back') return;
    expect(rolled.record.history_preserved).toBe(true);
    expect(rolled.record.injectable_after).toBe(false);
    expect(rolled.record.rolled_back_version).toBe(entry.version);

    // 历史不删：条目仍在库里（只是 disabled）
    expect(allEntries(repo)).toHaveLength(1);
    expect(allEntries(repo)[0]?.status).toBe('disabled');
    // 检索 / 注入不再命中
    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(false);
    expect(injectableExperienceLessons(repo, U1, TPL)).toEqual([]);
  });

  it('反例：回滚**从未写入**的版本 ⇒ 失败 not_written，且库无改动', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);

    const rolled = rollbackExperienceWrite({
      repository: repo,
      owner_id: U1,
      memory_id: asMemoryId('never-written'),
      expected_version: asRevision(0),
      at: AT2,
      reason: '回滚一个不存在的版本',
    });

    expect(rolled.kind).toBe('failed');
    if (rolled.kind !== 'failed') return;
    expect(rolled.reason).toBe('not_written');
    expect(activeLessons(repo)).toEqual(['经验 A']); // 无改动
  });

  it('反例：版本不匹配（回滚的不是那一版）⇒ 失败 version_mismatch，条目仍有效', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const rolled = rollbackExperienceWrite({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      expected_version: asRevision(99),
      at: AT2,
      reason: '版本对不上',
    });

    expect(rolled.kind).toBe('failed');
    if (rolled.kind !== 'failed') return;
    expect(rolled.reason).toBe('version_mismatch');
    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(true);
  });

  it('反例：跨用户回滚 ⇒ 失败 owner_mismatch（R237 隔离），条目仍有效', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const rolled = rollbackExperienceWrite({
      repository: repo,
      owner_id: asOwnerId('user-b'),
      memory_id: entry.memory_id,
      expected_version: entry.version,
      at: AT2,
      reason: '越权回滚',
    });

    expect(rolled.kind).toBe('failed');
    if (rolled.kind !== 'failed') return;
    expect(rolled.reason).toBe('owner_mismatch');
    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(true);
  });

  it('反例：回滚缺原因 ⇒ 失败 missing_reason（不得凭空宣称回滚）', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const rolled = rollbackExperienceWrite({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      expected_version: entry.version,
      at: AT2,
      reason: '',
    });
    expect(rolled.kind).toBe('failed');
    if (rolled.kind !== 'failed') return;
    expect(rolled.reason).toBe('missing_reason');
  });
});

// ---------------------------------------------------------------------------
// 失效：带原因与依据、版本化；无依据必须失败
// ---------------------------------------------------------------------------

describe('MEM-07 失效（带原因与依据；版本化）', () => {
  it('正例：有依据失效 ⇒ invalidated，记录写死 invalidated_version，检索不再命中', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const result = invalidateExperienceVersion({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      at: AT2,
      reason: '该做法已过时',
      basis: '模板 v0.10 起改用新流程',
      evidence_refs: ['doc:release-notes-0.10'],
    });

    expect(result.kind).toBe('invalidated');
    if (result.kind !== 'invalidated') return;
    expect(result.record.invalidated_version).toBe(entry.version);
    expect(result.record.state).toBe('invalid');
    expect(result.record.reevaluations).toHaveLength(0);
    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(false);
  });

  it('反例：无依据失效（缺依据）⇒ 失败 missing_basis，条目保持有效', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const result = invalidateExperienceVersion({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      at: AT2,
      reason: '随便失效一下',
      basis: '',
      evidence_refs: ['e'],
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('missing_basis');
    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(true);
  });

  it('反例：无证据引用失效 ⇒ 失败 missing_basis，条目保持有效', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const result = invalidateExperienceVersion({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      at: AT2,
      reason: '过时',
      basis: '据经验判断',
      evidence_refs: [],
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('missing_basis');
    expect(isExperienceInjectable(repo, U1, entry.memory_id)).toBe(true);
  });

  it('反例：重复失效已失效的经验 ⇒ 失败 already_invalid（确定性）', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const entry = findByLesson(repo, '经验 A');

    const first = invalidateExperienceVersion({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      at: AT2,
      reason: '过时',
      basis: '证据',
      evidence_refs: ['e1'],
    });
    expect(first.kind).toBe('invalidated');

    const second = invalidateExperienceVersion({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      at: AT2,
      reason: '再过时',
      basis: '证据',
      evidence_refs: ['e2'],
    });
    expect(second.kind).toBe('failed');
    if (second.kind !== 'failed') return;
    expect(second.reason).toBe('already_invalid');
  });
});

// ---------------------------------------------------------------------------
// 重新评估：reactivated / stays_invalid，两者都要求证据
// ---------------------------------------------------------------------------

function invalidateOne(repo: MemoryRepository, lesson: string): ExperienceInvalidationRecord {
  const entry = findByLesson(repo, lesson);
  const result = invalidateExperienceVersion({
    repository: repo,
    owner_id: U1,
    memory_id: entry.memory_id,
    at: AT2,
    reason: '过时',
    basis: '模板已升级',
    evidence_refs: ['doc:release-notes'],
  });
  if (result.kind !== 'invalidated') throw new Error('前置失效应成功');
  return result.record;
}

describe('MEM-07 重新评估（reactivated / stays_invalid 都带证据）', () => {
  it('正例 reactivated：带证据 ⇒ 条目重新启用，记录追加 reevaluation', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const record = invalidateOne(repo, '经验 A');
    expect(isExperienceInjectable(repo, U1, record.memory_id)).toBe(false);

    const result = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record,
      verdict: 'reactivate',
      rationale: '新证据表明该做法在 v0.11 仍然成立',
      evidence_refs: ['doc:release-notes-0.11'],
      at: AT2,
    });

    expect(result.kind).toBe('reactivated');
    if (result.kind !== 'reactivated') return;
    expect(result.record.state).toBe('reactivated');
    expect(result.record.reevaluations).toHaveLength(1);
    expect(result.reevaluation.seq).toBe(1);
    expect(result.reevaluation.outcome).toBe('reactivated');
    expect(isExperienceInjectable(repo, U1, record.memory_id)).toBe(true);
    expect(injectableExperienceLessons(repo, U1, TPL)).toEqual(['经验 A']);
  });

  it('正例 stays_invalid：带证据但维持失效 ⇒ 仍不可命中，记录仍追加', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const record = invalidateOne(repo, '经验 A');

    const result = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record,
      verdict: 'keep_invalid',
      rationale: '新证据不足以推翻原判',
      evidence_refs: ['doc:retest-failure'],
      at: AT2,
    });

    expect(result.kind).toBe('stays_invalid');
    if (result.kind !== 'stays_invalid') return;
    expect(result.record.state).toBe('invalid');
    expect(result.record.reevaluations).toHaveLength(1);
    expect(result.reevaluation.outcome).toBe('stays_invalid');
    expect(isExperienceInjectable(repo, U1, record.memory_id)).toBe(false);
  });

  it('反例：无证据重新评估（两种结论都试）⇒ 失败 missing_evidence，记录不变', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const record = invalidateOne(repo, '经验 A');

    const noEvidence = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record,
      verdict: 'reactivate',
      rationale: '我说可以就可以',
      evidence_refs: [],
      at: AT2,
    });
    expect(noEvidence.kind).toBe('failed');
    if (noEvidence.kind !== 'failed') return;
    expect(noEvidence.reason).toBe('missing_evidence');

    const noRationale = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record,
      verdict: 'keep_invalid',
      rationale: '',
      evidence_refs: ['doc:x'],
      at: AT2,
    });
    expect(noRationale.kind).toBe('failed');
    if (noRationale.kind !== 'failed') return;
    expect(noRationale.reason).toBe('missing_evidence');

    expect(isExperienceInjectable(repo, U1, record.memory_id)).toBe(false); // 未恢复
    expect(record.reevaluations).toHaveLength(0); // 原记录不变
  });

  it('反例：对已恢复的记录再次重新评估 ⇒ 失败 not_invalid（历史链不重放）', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const record = invalidateOne(repo, '经验 A');

    const reactivated = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record,
      verdict: 'reactivate',
      rationale: '恢复',
      evidence_refs: ['doc:ok'],
      at: AT2,
    });
    expect(reactivated.kind).toBe('reactivated');
    if (reactivated.kind !== 'reactivated') return;

    const again = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record: reactivated.record,
      verdict: 'keep_invalid',
      rationale: '再来一次',
      evidence_refs: ['doc:again'],
      at: AT2,
    });
    expect(again.kind).toBe('failed');
    if (again.kind !== 'failed') return;
    expect(again.reason).toBe('not_invalid');
  });

  it('正例：重新评估是**追加**——原失效记录（原因 / 依据 / 证据）不被删除', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const record = invalidateOne(repo, '经验 A');

    const reactivated = reevaluateExperience({
      repository: repo,
      owner_id: U1,
      record,
      verdict: 'reactivate',
      rationale: '再次生效',
      evidence_refs: ['doc:ok'],
      at: AT2,
    });
    if (reactivated.kind !== 'reactivated') throw new Error('应恢复');

    expect(reactivated.record.reason).toBe(record.reason);
    expect(reactivated.record.basis).toBe(record.basis);
    expect(reactivated.record.evidence_refs).toEqual(record.evidence_refs);
    expect(reactivated.record.invalidated_version).toBe(record.invalidated_version);
    expect(reactivated.record.reevaluations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 实例固定快照隔离：旧实例规则不变，新实例拿新规则
// ---------------------------------------------------------------------------

describe('MEM-07 实例固定经验快照隔离（回滚/失效不影响在跑实例）', () => {
  it('反例（核心）：绑定后**回滚**其规则 ⇒ 旧实例不变、新实例不再持有该规则', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('规则甲')], ids);

    const inst = bindInstanceExperience(repo, { instance_id: 'inst-1', owner_id: U1, template_id: TPL, at: AT });
    expect(instanceRules(inst)).toEqual(['规则甲']);
    expect(resolveInstanceRule(inst, '规则甲').allowed).toBe(true);

    const entry = findByLesson(repo, '规则甲');
    const rolled = rollbackExperienceWrite({
      repository: repo,
      owner_id: U1,
      memory_id: entry.memory_id,
      expected_version: entry.version,
      at: AT2,
      reason: '回滚规则甲',
    });
    expect(rolled.kind).toBe('rolled_back');

    // 旧实例规则**不变**（R230：不得在执行中途改写）
    expect(instanceRules(inst)).toEqual(['规则甲']);
    expect(resolveInstanceRule(inst, '规则甲').allowed).toBe(true);

    // 差**可解释**：frozen_rules 不变，但 removed_since_binding 暴露被回滚的规则
    const diff = instanceRuleDiff(inst, repo);
    expect(diff.frozen_rules).toEqual(['规则甲']);
    expect(diff.removed_since_binding).toEqual(['规则甲']);
    expect(diff.current_active_lessons).toEqual([]);

    // 新实例才拿到新规则（本批已无有效经验 ⇒ 空规则）
    const inst2 = rebindInstance(inst, repo, { new_instance_id: 'inst-2', at: AT2 });
    expect(instanceRules(inst2)).toEqual([]);
    expect(resolveInstanceRule(inst2, '规则甲').allowed).toBe(false);
  });

  it('反例（核心）：绑定后**失效**其规则 ⇒ 旧实例不变、新实例拿不到该规则', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('规则甲'), cand('规则乙')], ids);

    const inst = bindInstanceExperience(repo, { instance_id: 'inst-1', owner_id: U1, template_id: TPL, at: AT });
    const both = ['规则甲', '规则乙'].sort(); // 按码点排序，与实现一致
    expect([...instanceRules(inst)].sort()).toEqual(both);

    const record = invalidateOne(repo, '规则甲');
    expect(record.memory_id).toBe(findByLesson(repo, '规则甲').memory_id);

    // 旧实例仍持有两条（含已失效的「规则甲」）
    expect([...instanceRules(inst)].sort()).toEqual(both);
    expect(resolveInstanceRule(inst, '规则甲').allowed).toBe(true);

    const diff = instanceRuleDiff(inst, repo);
    expect([...diff.frozen_rules].sort()).toEqual(both);
    expect(diff.removed_since_binding).toEqual(['规则甲']);
    expect(diff.still_active).toEqual(['规则乙']);
    expect(diff.current_active_lessons).toEqual(['规则乙']);

    // 新实例只拿到当前有效规则
    const inst2 = rebindInstance(inst, repo, { new_instance_id: 'inst-2', at: AT2 });
    expect(instanceRules(inst2)).toEqual(['规则乙']);
    expect(resolveInstanceRule(inst2, '规则甲').allowed).toBe(false);
    expect(resolveInstanceRule(inst2, '规则乙').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 并发 + 回滚：确定性 + 失败不留半个状态
// ---------------------------------------------------------------------------

describe('MEM-07 批次回滚（确定性 + 无半状态）', () => {
  it('正例：同一组目标换到达顺序 ⇒ 结果一致（rolled_back 按 id 升序、有效集合相同）', () => {
    const repoA = createMemoryRepository();
    const idsA = idFactory();
    append(repoA, [cand('经验 A'), cand('经验 B'), cand('经验 C')], idsA);
    const a1 = findByLesson(repoA, '经验 A');
    const b1 = findByLesson(repoA, '经验 B');

    const repoB = createMemoryRepository();
    const idsB = idFactory();
    append(repoB, [cand('经验 C'), cand('经验 B'), cand('经验 A')], idsB); // 到达顺序相反
    const a2 = findByLesson(repoB, '经验 A');
    const b2 = findByLesson(repoB, '经验 B');

    const rA = rollbackExperienceBatch({
      repository: repoA,
      owner_id: U1,
      targets: [
        { memory_id: b1.memory_id, expected_version: b1.version },
        { memory_id: a1.memory_id, expected_version: a1.version },
      ],
      at: AT2,
      reason: '批次回滚',
    });
    const rB = rollbackExperienceBatch({
      repository: repoB,
      owner_id: U1,
      targets: [
        { memory_id: a2.memory_id, expected_version: a2.version },
        { memory_id: b2.memory_id, expected_version: b2.version },
      ],
      at: AT2,
      reason: '批次回滚',
    });

    expect(rA.kind).toBe('rolled_back');
    expect(rB.kind).toBe('rolled_back');
    if (rA.kind !== 'rolled_back' || rB.kind !== 'rolled_back') return;
    expect(rA.mutated).toBe(true);
    // 与输入顺序无关：两次结果逐字段一致
    expect(rA.rolled_back).toEqual(rB.rolled_back);
    expect(activeLessons(repoA)).toEqual(activeLessons(repoB));
    expect(activeLessons(repoA)).toEqual(['经验 C']);
  });

  it('反例（无半状态）：批次含一个已失效目标 ⇒ **整批不执行**，其余目标仍有效', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A'), cand('经验 B')], ids);
    const a = findByLesson(repo, '经验 A');
    const b = findByLesson(repo, '经验 B');

    // 先把 B 失效，使整批里出现一个不合规目标
    const record = invalidateOne(repo, '经验 B');
    expect(record.memory_id).toBe(b.memory_id);

    const result = rollbackExperienceBatch({
      repository: repo,
      owner_id: U1,
      targets: [
        { memory_id: a.memory_id, expected_version: a.version },
        { memory_id: b.memory_id, expected_version: b.version },
      ],
      at: AT2,
      reason: '含不合规目标的批次',
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.stage).toBe('validate');
    expect(result.reason).toBe('already_invalid');
    expect(result.mutated).toBe(false);
    // 无半状态：A 未被回滚（仍 active / 可命中）
    expect(isExperienceInjectable(repo, U1, a.memory_id)).toBe(true);
    expect(activeLessons(repo)).toEqual(['经验 A']);
  });

  it('反例（无半状态）：批次含**未写入**目标 ⇒ 整批不执行，合法目标不被回滚', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const a = findByLesson(repo, '经验 A');

    const result = rollbackExperienceBatch({
      repository: repo,
      owner_id: U1,
      targets: [
        { memory_id: a.memory_id, expected_version: a.version },
        { memory_id: asMemoryId('never-written'), expected_version: asRevision(0) },
      ],
      at: AT2,
      reason: '含不存在目标的批次',
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('not_written');
    expect(result.mutated).toBe(false);
    expect(activeLessons(repo)).toEqual(['经验 A']);
  });

  it('反例（无半状态）：批次含版本不匹配目标 ⇒ 整批不执行', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('经验 A')], ids);
    const a = findByLesson(repo, '经验 A');

    const result = rollbackExperienceBatch({
      repository: repo,
      owner_id: U1,
      targets: [{ memory_id: a.memory_id, expected_version: asRevision(42) }],
      at: AT2,
      reason: '版本不匹配',
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('version_mismatch');
    expect(result.mutated).toBe(false);
    expect(activeLessons(repo)).toEqual(['经验 A']);
  });
});

describe('MEM-07 并发追加 + 回滚（半批次写入不得留在库里）', () => {
  it('正例：全部落库成功 ⇒ 全批回滚，有效集合回到追加前，历史保留', () => {
    const repo = createMemoryRepository();
    const ids = idFactory();
    append(repo, [cand('既有经验')], ids); // 追加前已有 1 条

    const result = concurrentAppendThenRollback({
      repository: repo,
      owner_id: U1,
      candidates: [cand('经验 B'), cand('经验 C')],
      at: AT2,
      isSensitive: () => false,
      detectConflict: () => false,
      source: SOURCE,
      newMemoryId: ids,
      reason: '整批回滚',
    });

    expect(result.outcome).toBe('completed');
    expect(result.append.all_committed).toBe(true);
    expect(result.no_half_state).toBe(true);
    expect(result.active_before).toEqual(['既有经验']);
    expect(result.active_after).toEqual(['既有经验']);
    // 历史保留：既有 + 两条被回滚的 = 3 条都在库里
    expect(allEntries(repo)).toHaveLength(3);
    expect(activeLessons(repo)).toEqual(['既有经验']);
  });

  it('反例（无半状态）：追加**部分失败** ⇒ 已写入部分被回滚，有效集合回到追加前', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: (entry) => {
          if (entry.kind === 'template_experience' && entry.lesson === '经验 B') {
            throw new Error('模拟「经验 B」写入失败');
          }
        },
      },
    });
    const ids = idFactory();
    append(repo, [cand('既有经验')], ids);

    const result = concurrentAppendThenRollback({
      repository: repo,
      owner_id: U1,
      candidates: [cand('经验 B'), cand('经验 A')],
      at: AT2,
      isSensitive: () => false,
      detectConflict: () => false,
      source: SOURCE,
      newMemoryId: ids,
      reason: '部分失败后回滚半批次',
    });

    // 追加阶段部分失败（B 写失败、A 写成功）——不宣称整批成功
    expect(result.append.all_committed).toBe(false);
    expect(result.append.failed_count).toBe(1);
    // 已写入的 A 被回滚，最终有效集合回到追加前
    expect(result.outcome).toBe('partial_compensated');
    expect(result.no_half_state).toBe(true);
    expect(result.active_before).toEqual(['既有经验']);
    expect(result.active_after).toEqual(['既有经验']);
    expect(activeLessons(repo)).toEqual(['既有经验']);
  });

  it('正例（确定性）：候选到达顺序不同 ⇒ 最终有效集合与结论一致', () => {
    const run = (order: readonly ExperienceCandidate[]) => {
      const repo = createMemoryRepository();
      const ids = idFactory();
      append(repo, [cand('既有经验')], ids);
      const result = concurrentAppendThenRollback({
        repository: repo,
        owner_id: U1,
        candidates: order,
        at: AT2,
        isSensitive: () => false,
        detectConflict: () => false,
        source: SOURCE,
        newMemoryId: ids,
        reason: '顺序无关',
      });
      return { result, repo };
    };

    const forward = run([cand('经验 B'), cand('经验 C')]);
    const reverse = run([cand('经验 C'), cand('经验 B')]);

    expect(forward.result.append.merged.order).toEqual(reverse.result.append.merged.order);
    expect(forward.result.active_after).toEqual(reverse.result.active_after);
    expect(activeLessons(forward.repo)).toEqual(activeLessons(reverse.repo));
    expect(forward.result.no_half_state).toBe(true);
    expect(reverse.result.no_half_state).toBe(true);
  });
});
