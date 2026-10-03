/**
 * 经验并发追加与实例固定绑定单测（design-06 P4 / MEM-07；合同 R230 / R239）。
 *
 * 正反例：
 * - **正例**：一批**并发到达**的候选合并确定（换顺序结果一致）、逐条落库；
 * - **反例 1**：同批重复候选去重为 `no_change`（不写两条同义经验）；
 * - **反例 2**：落库失败 ⇒ `all_committed: false`、失败条目不落库（不宣称整批成功）；
 * - **反例 3**（核心）：**实例绑定之后**到达的新经验**不改变**该实例规则，且
 *   `resolveInstanceRule()` 对绑定后新增的 lesson **一律拒绝**（执行期闸门，R230）；
 * - **反例 4**：失效后同 lesson 可被**重新评估**新增（去重只针对有效经验）；
 * - **正例**：回滚撤销一次取代、前驱恢复，且**正在运行的实例绑定不受影响**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTemplateId, type TemplateId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  type MemoryId,
  type MemorySource,
  type OwnerId,
  type TemplateExperienceMemory,
} from './types.js';
import { createMemoryRepository, type MemoryRepository } from './repository.js';
import { evaluateExperienceCandidate, type ExperienceCandidate } from './experience.js';
import {
  commitExperienceDecision,
  invalidateExperience,
  mergeExperienceCandidates,
  rollbackExperience,
} from './experience-merge.js';
import {
  appendExperiencesConcurrently,
  bindInstanceExperience,
  instanceHasRule,
  instanceIsStale,
  instanceRules,
  pendingNewLessons,
  rebindInstance,
  resolveInstanceRule,
} from './experience-concurrency.js';

const U1: OwnerId = asOwnerId('user-a');
const TPL: TemplateId = asTemplateId('template.document');
const AT = asLogicalTime(10);
const AT2 = asLogicalTime(20);
const SOURCE: MemorySource = { kind: 'tool_result', detail: '已封存证据' };

let counter = 0;
function nextId(): MemoryId {
  counter += 1;
  return asMemoryId(`exp-${String(counter)}`);
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
    newMemoryId: nextId,
  });
}

const activeLessons = (repo: MemoryRepository): string[] =>
  repo
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
    .filter((entry) => entry.status === 'active')
    .map((entry) => entry.lesson)
    .sort();

describe('MEM-07 并发追加与合并（确定 + 落库）', () => {
  it('正例：一批并发到达的候选全部落库；换顺序结果一致', () => {
    const repoA = createMemoryRepository();
    const forward = append(repoA, [cand('经验 A'), cand('经验 B'), cand('经验 C')]);
    expect(forward.accepted_lessons).toEqual(['经验 A', '经验 B', '经验 C']);
    expect(forward.all_committed).toBe(true);
    expect(forward.failed_count).toBe(0);
    expect(activeLessons(repoA)).toEqual(['经验 A', '经验 B', '经验 C']);

    const repoB = createMemoryRepository();
    const reversed = append(repoB, [cand('经验 C'), cand('经验 B'), cand('经验 A')]);
    expect(reversed.merged.order).toEqual(forward.merged.order);
    expect(activeLessons(repoB)).toEqual(activeLessons(repoA));
  });

  it('反例：同批重复候选去重为 no_change（不写两条同义经验）', () => {
    const repo = createMemoryRepository();
    const result = append(repo, [cand('经验 A'), cand('经验 A'), cand('经验 B')]);
    expect(result.merged.no_change_count).toBe(1);
    expect(result.accepted_lessons).toEqual(['经验 A', '经验 B']);
    expect(activeLessons(repo)).toEqual(['经验 A', '经验 B']);
  });

  it('反例：落库失败 ⇒ all_committed:false、失败条目不落库（不宣称整批成功）', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          throw new Error('模拟写失败');
        },
      },
    });
    const result = append(repo, [cand('经验 A'), cand('经验 B')]);
    expect(result.all_committed).toBe(false);
    expect(result.failed_count).toBe(result.committed.length);
    expect(activeLessons(repo)).toEqual([]);
  });
});

describe('MEM-07 实例固定经验绑定（新经验不在执行中途改规则，R230）', () => {
  it('反例（核心）：绑定后到达的新经验不进入绑定，执行期闸门拒绝新 lesson', () => {
    const repo = createMemoryRepository();
    append(repo, [cand('经验 A')]);

    const inst = bindInstanceExperience(repo, { instance_id: 'inst-1', owner_id: U1, template_id: TPL, at: AT });
    expect(instanceRules(inst)).toEqual(['经验 A']);

    // 执行中途到达的新经验
    append(repo, [cand('经验 B')], AT2);

    expect(instanceRules(inst)).toEqual(['经验 A']); // 绑定不变
    expect(instanceHasRule(inst, '经验 B')).toBe(false);
    const gate = resolveInstanceRule(inst, '经验 B');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('R230');
    expect(resolveInstanceRule(inst, '经验 A').allowed).toBe(true);

    // 与最新经验的差**可解释**
    expect(pendingNewLessons(inst, repo)).toEqual(['经验 B']);
    expect(instanceIsStale(inst, repo)).toBe(true);
  });

  it('正例：重新签发（新实例）才吃到新经验', () => {
    const repo = createMemoryRepository();
    append(repo, [cand('经验 A')]);
    const inst1 = bindInstanceExperience(repo, { instance_id: 'inst-1', owner_id: U1, template_id: TPL, at: AT });
    append(repo, [cand('经验 B')], AT2);

    const inst2 = rebindInstance(inst1, repo, { new_instance_id: 'inst-2', at: AT2 });
    expect(inst2.instance_id).toBe('inst-2');
    expect(instanceRules(inst2)).toEqual(['经验 A', '经验 B']);
    expect(resolveInstanceRule(inst2, '经验 B').allowed).toBe(true);
    expect(instanceIsStale(inst2, repo)).toBe(false);
    // 旧绑定仍冻结
    expect(instanceRules(inst1)).toEqual(['经验 A']);
  });

  it('反例：失效后同 lesson 可被**重新评估**新增（去重只针对有效经验）', () => {
    const repo = createMemoryRepository();
    append(repo, [cand('经验 A')]);
    const existing = repo
      .listByKind('template_experience')
      .filter((e): e is TemplateExperienceMemory => e.kind === 'template_experience');
    const first = existing[0];
    if (first === undefined) throw new Error('应有经验');

    // 未失效时同 lesson ⇒ no_change
    const before = mergeExperienceCandidates([cand('经验 A')], {
      owner_id: U1,
      existing,
      isSensitive: () => false,
      detectConflict: () => false,
      source: SOURCE,
      newMemoryId: nextId,
    }, AT);
    expect(before.no_change_count).toBe(1);

    const invalidated = invalidateExperience({ repository: repo, owner_id: U1, memory_id: first.memory_id, at: AT2, reason: '过时' });
    expect(invalidated.kind).toBe('invalidated');

    const after = append(repo, [cand('经验 A')], AT2);
    expect(after.accepted_lessons).toEqual(['经验 A']);
    expect(after.merged.no_change_count).toBe(0);
  });

  it('正例：回滚撤销一次取代、前驱恢复，且正在运行的实例绑定不受影响', () => {
    const repo = createMemoryRepository();
    append(repo, [cand('旧做法')]);
    append(repo, [cand('更好的做法', '旧做法')], AT2);

    // 实例在"更好的做法"生效时绑定
    const inst = bindInstanceExperience(repo, { instance_id: 'inst-run', owner_id: U1, template_id: TPL, at: AT2 });
    expect(instanceRules(inst)).toEqual(['更好的做法']);

    const newer = repo
      .listByKind('template_experience')
      .filter((e): e is TemplateExperienceMemory => e.kind === 'template_experience')
      .find((e) => e.lesson === '更好的做法');
    if (newer === undefined) throw new Error('应有新经验');

    const rolled = rollbackExperience({ repository: repo, owner_id: U1, memory_id: newer.memory_id, at: AT2, reason: '用户要求回滚' });
    expect(rolled.kind).toBe('rolled_back');
    if (rolled.kind === 'rolled_back') expect(rolled.restored).not.toBeNull();
    expect(activeLessons(repo)).toEqual(['旧做法']);

    // 运行中实例的规则**不因回滚而改变**（冻结）
    expect(instanceRules(inst)).toEqual(['更好的做法']);

    // 新实例才拿到回滚后的规则
    const inst2 = rebindInstance(inst, repo, { new_instance_id: 'inst-next', at: AT2 });
    expect(instanceRules(inst2)).toEqual(['旧做法']);
  });

  it('反例：跨用户隔离——别人的经验不进本实例绑定', () => {
    const repo = createMemoryRepository();
    append(repo, [cand('经验 A')]);
    // 直接构造一条属于 user-b 的经验
    const decision = evaluateExperienceCandidate(cand('别人的经验'), {
      owner_id: asOwnerId('user-b'),
      existing: [],
      isSensitive: () => false,
      detectConflict: () => false,
      source: SOURCE,
      newMemoryId: nextId,
    }, AT);
    const committed = commitExperienceDecision({
      repository: repo,
      owner_id: asOwnerId('user-b'),
      decision,
      supersedes_lesson: null,
      at: AT,
    });
    expect(committed.kind).toBe('written');

    const inst = bindInstanceExperience(repo, { instance_id: 'inst-x', owner_id: U1, template_id: TPL, at: AT });
    expect(instanceRules(inst)).toEqual(['经验 A']);
    expect(instanceHasRule(inst, '别人的经验')).toBe(false);
  });
});
