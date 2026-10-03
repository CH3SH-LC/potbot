/**
 * 同模板并发经验的**批量追加与落库**、以及**实例固定经验绑定**（design-06 P4 / MEM-07；
 * 合同 R230 / R239）。
 *
 * ## 这一层补的是什么
 *
 * `experience-merge.ts` 已给出顺序无关的 `mergeExperienceCandidates()`（合并）
 * 与 `commitExperienceDecision()`（单条落库），以及 `pinExperienceSnapshot()`（取快照）。
 * 本文件把它们**编排**成两个真实使用姿势：
 *
 * 1. `appendExperiencesConcurrently()` —— 一批来自多个成员、**并发到达**的候选：
 *    先**一次性合并**（确定性去重 + 版本分配），再**逐条落库**；任一条落库失败都如实上报，
 *    不宣称"整批成功"。
 * 2. `bindInstanceExperience()` —— 实例开跑时**绑定**一份冻结经验快照。绑定后：
 *    - 期间到达的**新经验不会进入**该绑定（`rules` 不变）；
 *    - 用 `resolveInstanceRule()` 判定某条 lesson **是否属于本实例规则**——绑定之后才出现的新经验
 *      一律 `allowed: false`。这就是 R230"新经验**不得**在执行中途改变规则"的**执行期闸门**，
 *      而不是只靠"快照数组没变"的间接证据。
 *
 * 想吃新经验必须 `rebindInstance()` 签发一份**新实例**的绑定（下个实例 / 下一次执行）。
 *
 * `pendingNewLessons()` / `instanceIsStale()` 让"本实例与最新经验之间的差"**可解释**：
 * 调度器据此决定"是否值得重新签发"。
 *
 * 纯函数 + 注入仓库：零 IO、不含墙钟与随机数。
 */

import type { LogicalTime, TemplateId } from '../protocol/index.js';
import type {
  ExperienceCandidate,
  ExperienceContext,
} from './experience.js';
import {
  commitExperienceDecision,
  mergeExperienceCandidates,
  pinExperienceSnapshot,
  type CommitExperienceResult,
  type ExperienceMergeResult,
  type PinnedExperienceSnapshot,
} from './experience-merge.js';
import type { MemoryRepository } from './repository.js';
import type {
  MemoryId,
  MemorySource,
  OwnerId,
  TemplateExperienceMemory,
} from './types.js';

// ---------------------------------------------------------------------------
// 并发批量追加与落库
// ---------------------------------------------------------------------------

export interface ConcurrentAppendInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  /** 一批可能**并发到达**的候选（可来自多个成员）。 */
  readonly candidates: readonly ExperienceCandidate[];
  readonly at: LogicalTime;
  /** 敏感信息判定（调用方注入的策略）。 */
  readonly isSensitive: (candidate: ExperienceCandidate) => boolean;
  /** 冲突判定（调用方注入的策略）。 */
  readonly detectConflict: (
    candidate: ExperienceCandidate,
    existing: readonly TemplateExperienceMemory[],
  ) => boolean;
  /** 写入来源（R235：留来源是硬要求）。 */
  readonly source: MemorySource;
  /** 生成新条目 id 的确定性接缝（同一批内**不得**重复）。 */
  readonly newMemoryId: () => MemoryId;
}

export interface ConcurrentAppendResult {
  readonly merged: ExperienceMergeResult;
  /** 逐条落库结果（与 `merged.decisions` 中 `add` 的顺序一致）。 */
  readonly committed: readonly CommitExperienceResult[];
  readonly accepted_lessons: readonly string[];
  readonly failed_count: number;
  /** **整批**是否全部落库成功（任一条失败 ⇒ `false`，不宣称整批成功）。 */
  readonly all_committed: boolean;
  readonly detail: string;
}

/** 本 owner 当前**有效**的模板经验（跨全部模板；评估时按候选模板再过滤）。 */
function activeOwnerExperiences(
  repository: MemoryRepository,
  ownerId: OwnerId,
): readonly TemplateExperienceMemory[] {
  return Object.freeze(
    repository
      .listByKind('template_experience')
      .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
      .filter((entry) => entry.owner_id === ownerId && entry.status === 'active'),
  );
}

/**
 * 并发追加一批经验候选并落库。
 *
 * 合并**与输入顺序无关**（由 `mergeExperienceCandidates` 保证）；落库逐条进行，
 * 失败的条目**不落库**且计入 `failed_count`，`all_committed` 如实为 `false`（R240）。
 */
export function appendExperiencesConcurrently(input: ConcurrentAppendInput): ConcurrentAppendResult {
  const existing = activeOwnerExperiences(input.repository, input.owner_id);
  const context: ExperienceContext = {
    owner_id: input.owner_id,
    existing,
    isSensitive: input.isSensitive,
    detectConflict: input.detectConflict,
    source: input.source,
    newMemoryId: input.newMemoryId,
  };

  const merged = mergeExperienceCandidates(input.candidates, context, input.at);

  const committed: CommitExperienceResult[] = [];
  for (const pair of merged.decisions) {
    if (pair.decision.decision !== 'add' || pair.decision.entry === null) continue;
    committed.push(
      commitExperienceDecision({
        repository: input.repository,
        owner_id: input.owner_id,
        decision: pair.decision,
        supersedes_lesson: pair.candidate.supersedes_lesson,
        at: input.at,
      }),
    );
  }

  const failed = committed.filter((result) => result.kind === 'failed');
  const acceptedLessons = merged.accepted.map((entry) => entry.lesson);
  return Object.freeze({
    merged,
    committed: Object.freeze(committed),
    accepted_lessons: Object.freeze(acceptedLessons),
    failed_count: failed.length,
    all_committed: failed.length === 0,
    detail:
      `并发追加 ${String(input.candidates.length)} 条候选：接受 ${String(merged.accepted.length)} 条、` +
      `不新增 ${String(merged.no_change_count)} 条、拒绝 ${String(merged.rejected_count)} 条；` +
      `落库成功 ${String(committed.length - failed.length)} / ${String(committed.length)} 条`,
  });
}

// ---------------------------------------------------------------------------
// 实例固定经验绑定（R230）
// ---------------------------------------------------------------------------

/** 实例开跑时绑定的**冻结**经验快照（此后到达的新经验不进入）。 */
export interface InstanceExperienceBinding {
  readonly instance_id: string;
  readonly owner_id: OwnerId;
  readonly template_id: TemplateId;
  readonly bound_at: LogicalTime;
  /** 冻结快照（`entries` / `lessons` 均为冻结副本）。 */
  readonly snapshot: PinnedExperienceSnapshot;
  /** 本实例必须遵循的规则（= 绑定时刻的有效经验 lesson）。 */
  readonly rules: readonly string[];
  readonly rule_ids: readonly MemoryId[];
}

/** 为一个实例绑定经验快照（实例开跑时调一次）。 */
export function bindInstanceExperience(
  repository: MemoryRepository,
  input: {
    readonly instance_id: string;
    readonly owner_id: OwnerId;
    readonly template_id: TemplateId;
    readonly at: LogicalTime;
  },
): InstanceExperienceBinding {
  const snapshot = pinExperienceSnapshot({
    repository,
    owner_id: input.owner_id,
    template_id: input.template_id,
    at: input.at,
  });
  return Object.freeze({
    instance_id: input.instance_id,
    owner_id: input.owner_id,
    template_id: input.template_id,
    bound_at: input.at,
    snapshot,
    rules: snapshot.lessons,
    rule_ids: snapshot.experience_ids,
  });
}

/** 本实例的规则（冻结；不随库变化）。 */
export function instanceRules(binding: InstanceExperienceBinding): readonly string[] {
  return binding.rules;
}

/** 本实例的规则条目 id。 */
export function instanceRuleIds(binding: InstanceExperienceBinding): readonly MemoryId[] {
  return binding.rule_ids;
}

/** 某条 lesson 是否属于本实例的规则。 */
export function instanceHasRule(binding: InstanceExperienceBinding, lesson: string): boolean {
  return binding.rules.includes(lesson);
}

/** 判定一条经验是否可用于本实例（**执行期闸门**）。 */
export interface InstanceRuleDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * 执行期闸门：一条经验（lesson）是否**属于本实例**规则（R230）。
 *
 * 绑定之后才到达的新经验 ⇒ `allowed: false`——**新经验不得在执行中途改变本实例规则**。
 */
export function resolveInstanceRule(binding: InstanceExperienceBinding, lesson: string): InstanceRuleDecision {
  if (binding.rules.includes(lesson)) {
    return Object.freeze({
      allowed: true,
      reason: `lesson ${JSON.stringify(lesson)} 属于实例 ${binding.instance_id} 绑定时固定的经验规则`,
    });
  }
  return Object.freeze({
    allowed: false,
    reason:
      `lesson ${JSON.stringify(lesson)} 不在实例 ${binding.instance_id} 绑定时固定的规则内：` +
      '新经验不得在执行中途改变规则（R230）——需重新签发绑定才能生效',
  });
}

/** 库里当前有效、但**本实例绑定里没有**的 lesson（本实例尚未吃到的经验）。 */
export function pendingNewLessons(
  binding: InstanceExperienceBinding,
  repository: MemoryRepository,
): readonly string[] {
  const latest = activeOwnerExperiences(repository, binding.owner_id).filter(
    (entry) => entry.template_id === binding.template_id,
  );
  const known = new Set(binding.rules);
  return Object.freeze(
    [...new Set(latest.map((entry) => entry.lesson).filter((lesson) => !known.has(lesson)))].sort(),
  );
}

/** 本实例绑定是否已与最新经验**脱节**（有本实例未吃到的有效经验）。 */
export function instanceIsStale(
  binding: InstanceExperienceBinding,
  repository: MemoryRepository,
): boolean {
  return pendingNewLessons(binding, repository).length > 0;
}

/** 为**新实例**重新签发绑定（只有重新签发才能吃到新经验）。 */
export function rebindInstance(
  binding: InstanceExperienceBinding,
  repository: MemoryRepository,
  input: { readonly new_instance_id: string; readonly at: LogicalTime },
): InstanceExperienceBinding {
  return bindInstanceExperience(repository, {
    instance_id: input.new_instance_id,
    owner_id: binding.owner_id,
    template_id: binding.template_id,
    at: input.at,
  });
}
