/**
 * 经验流水线的**产品运行期接线**（FA-MEM-PIPELINE-PRODUCT）。
 *
 * ## 这一层回答的问题
 *
 * `src/memory/**` 与 `src/roles/experience-agent.ts` 已经把"经验是什么、怎么裁决、怎么版本化"
 * 实现成纯函数；`apps/demo/server/memory-routes.ts` 把它们的**管理口**（查看 / 回滚 / 失效）
 * 接到了 HTTP。**缺的是运行期那根线**——"任务真的做完了、拿到真实证据了，据此固化一条经验，
 * 让下一个任务的**新实例**吃上；出问题还能回滚"。本文件只接这根线，**不重造任何裁决逻辑**。
 *
 * ## 五个必须成立的点（每点都有反向对照，见 `experience-wiring.test.ts`）
 *
 * 1. **终态触发**：只有任务**终态**（`completed === true`，完成 / 失败皆可）才允许提经验候选。
 *    在途任务（仍有非终态工作项 / 在途轮次 / 未决动作）**结构上**走不到裁决与写库——
 *    `synthesizeTaskExperience()` 在触发门后**提前返回**，`proposal` / `pipeline` 均为 `null`。
 *    终态判定**只读复用** `./task-completion.js` 的 `TaskCompletionView`（不另造一套"算不算完"）。
 * 2. **证据门槛**：候选只接受**已封存且读回验证**（`sealed && readback_verified`）的证据
 *    （复用 `proposeExperienceCandidates()` 的双门）。未封存 / 未读回的证据被记为
 *    `evidence_not_sealed`，**不产出候选**。`unknown_external`（外部结果未知）即便已封存也**不得**
 *    固化成成功经验——它在流水线里被 `blocked_unknown_external` 挡下（R239）。
 * 3. **候选 → 裁决 → 版本化写入**：走 `synthesizeExperiences()`；**可得出"不新增"**——
 *    同文本候选去重为 `no_change`（一等结论，此时 `written` 为空、库不变）。
 * 4. **注入**：`bindTaskInstanceExperience()` 为**下一个任务的新实例**绑定一份冻结经验快照
 *    与可注入 lesson（`recall` 真实路径）。被失效 / 忘记的经验**不再注入**；
 *    `verifyInstanceInjection()` 把"旧实例冻结规则里已被失效的 lesson"变成可断言的证据
 *    （`removed_since_binding` 非空 ⇒ 检出）。
 * 5. **可回滚**：`rollbackTaskExperience()` 回滚**一次具体写入（版本）**；回滚后**检索不再命中**
 *    （`injectable_after === false`）、**历史保留**（条目数不变，只停用不删除）。
 *
 * ## 只读复用（不改任何既有文件）
 *
 * `TaskCompletionView` / `deriveTaskCompletion`（终态）、`proposeExperienceCandidates`（证据双门）、
 * `synthesizeExperiences` / `isExperiencePipelineClean`（裁决 + 落库）、`bindInstanceExperience` /
 * `instanceRuleDiff`（注入与隔离）、`injectableExperienceLessons` / `isExperienceInjectable`（检索路径）、
 * `rollbackExperienceWrite`（回滚）。本文件**不导出任何调度 / HTTP 形状**——挂载由协调者在
 * `http.ts` / `main.ts` 负责（不在本包写权内）。
 *
 * ## 如实标注（结果不得编造）
 *
 * - 本模块**单进程内**运行：不落盘、不起进程、不跨进程。真实持久化由宿主经
 *   `MemoryPersistencePort` 另行注入（见 `memory-routes.ts`）；**真实跨进程恢复未验证**。
 * - **未接真实模型**：证据从哪来、模型怎么读证据，由宿主提供；本层对"证据是否为真"的判据只到
 *   `sealed && readback_verified` 这两个宿主声明的事实，不替宿主编造证据来源。
 * - 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { LogicalTime, Revision, TemplateId } from '../../../src/protocol/index.js';
import {
  bindInstanceExperience,
  injectableExperienceLessons,
  instanceRuleDiff,
  isExperienceInjectable,
  isExperiencePipelineClean,
  rollbackExperienceWrite,
  synthesizeExperiences,
  type ExperienceCandidate,
  type ExperienceContext,
  type ExperiencePipelineReport,
  type InstanceExperienceBinding,
  type MemoryId,
  type MemoryRepository,
  type MemorySource,
  type OwnerId,
  type RollbackExperienceWriteResult,
  type TemplateExperienceMemory,
  type WrittenExperience,
  asMemoryId,
} from '../../../src/memory/index.js';
import {
  proposeExperienceCandidates,
  type CandidateProposal,
  type EvidenceRejection,
  type SealedEvidence,
} from '../../../src/roles/index.js';
import type { TaskCompletionView } from './task-completion.js';

// ---------------------------------------------------------------------------
// 1. 终态触发门：在途任务不得提经验候选
// ---------------------------------------------------------------------------

/** 触发门的两态。`eligible` = 任务终态，允许固化经验；`in_flight` = 在途，**不得提**。 */
export const EXPERIENCE_TRIGGER_STATES = ['eligible', 'in_flight'] as const;
export type ExperienceTriggerState = (typeof EXPERIENCE_TRIGGER_STATES)[number];

/** 一次触发门判定。`reasons` 在 `in_flight` 时逐条给出"还差在哪"。 */
export interface ExperienceTriggerDecision {
  readonly state: ExperienceTriggerState;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * 判定一个任务是否到了"可以固化经验"的**终态**。
 *
 * 终态口径**完全**取自 `TaskCompletionView.completed`（= 三个谓词的合取；完成与失败都算终态，
 * 成功与否由 `label` 区分，不影响"能不能提经验"）。在途任务返回 `eligible: false` 并列出原因。
 */
export function experienceTriggerOf(view: TaskCompletionView): ExperienceTriggerDecision {
  const reasons: string[] = [];
  if (!view.predicates.all_work_items_terminal) reasons.push('仍有非终态工作项');
  if (!view.predicates.no_in_flight_runs) {
    reasons.push(`仍有在途轮次：${view.in_flight_run_ids.join(', ') || '（见 counts.runs_in_flight）'}`);
  }
  if (!view.predicates.no_unresolved_actions) {
    reasons.push(`仍有未决动作：${view.unresolved_action_ids.join(', ') || '（见 counts.actions_unresolved）'}`);
  }
  const eligible = view.completed;
  return Object.freeze({
    state: eligible ? ('eligible' as const) : ('in_flight' as const),
    eligible,
    // 终态时**不得**残留任何"还差在哪"的说辞（避免"看着像终态其实有理由"）。
    reasons: Object.freeze(eligible ? [] : reasons),
  });
}

/** 在途任务提经验候选时抛错（宿主若要求 fail-loud 可调用；主流程用结构化拒绝路径）。 */
export class ExperienceTriggerError extends Error {
  readonly trigger: ExperienceTriggerDecision;
  constructor(taskId: string, trigger: ExperienceTriggerDecision) {
    super(
      `任务 ${taskId} 尚未到终态（${trigger.reasons.join('；')}）：在途任务不得提经验候选，` +
        '经验只能建立在任务终态后的真实证据上（FA-MEM 触发门）',
    );
    this.name = 'ExperienceTriggerError';
    this.trigger = trigger;
  }
}

/** fail-loud 版触发门：非终态 ⇒ 抛 `ExperienceTriggerError`。 */
export function assertExperienceTriggerEligible(taskId: string, trigger: ExperienceTriggerDecision): void {
  if (!trigger.eligible) {
    throw new ExperienceTriggerError(taskId, trigger);
  }
}

// ---------------------------------------------------------------------------
// 2 / 3. 终态 + 证据 → 裁决 → 版本化写入
// ---------------------------------------------------------------------------

/** 默认写入来源（R235：留来源是硬要求）。 */
export const DEFAULT_EXPERIENCE_SOURCE: MemorySource = Object.freeze({
  kind: 'tool_result',
  detail: '任务终态后的经验固化（经验流水线产品接线，FA-MEM）',
});

export interface TaskExperienceWiringInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly template_id: TemplateId;
  /** 任务级完成视图（来自 `deriveTaskCompletion` / `taskCompletionOf`）——终态判定的**唯一**依据。 */
  readonly completion: TaskCompletionView;
  /** 任务产出的证据（宿主提供；是否为真由 `sealed && readback_verified` 两道门把关）。 */
  readonly evidence: readonly SealedEvidence[];
  readonly at: LogicalTime;
  /** 生成新条目 id 的**确定性**接缝（宿主注入；见 `createSequenceMemoryIdFactory`）。 */
  readonly newMemoryId: () => MemoryId;
  /** 写入来源；省略用 `DEFAULT_EXPERIENCE_SOURCE`。 */
  readonly source?: MemorySource;
  /** 敏感判定策略（省略：不判敏感——策略由宿主注入，本层不替调用方决定，与 `experience.ts` 同风格）。 */
  readonly isSensitive?: (candidate: ExperienceCandidate) => boolean;
  /** 冲突判定策略（省略：不判冲突）。 */
  readonly detectConflict?: (
    candidate: ExperienceCandidate,
    existing: readonly TemplateExperienceMemory[],
  ) => boolean;
}

/** 一次任务终态后的经验固化结论。 */
export interface TaskExperienceWiringReport {
  readonly task_id: string;
  readonly template_id: TemplateId;
  readonly trigger: ExperienceTriggerDecision;
  /** 未终态 ⇒ `null`（结构上不产生候选）。 */
  readonly proposal: CandidateProposal | null;
  /** 未终态 ⇒ `null`（结构上不裁决、不写库）。 */
  readonly pipeline: ExperiencePipelineReport | null;
  readonly accepted_lessons: readonly string[];
  readonly no_change_lessons: readonly string[];
  /** 真正落库成功的经验（`no_change` / 被拒 ⇒ 空）。 */
  readonly written: readonly WrittenExperience[];
  /** 因"外部结果未知"被挡下的 lesson（R239；**必然不在** `accepted_lessons`）。 */
  readonly blocked_unknown_external: readonly string[];
  /** 未封存 / 未读回的证据（如实记录，不静默丢弃）。 */
  readonly evidence_rejections: readonly EvidenceRejection[];
  /** 属于**别的模板**、被本模板接线剔除的证据引用（如实登记——不静默丢弃）。 */
  readonly foreign_template_evidence_refs: readonly string[];
  /** 流水线是否干净（无落库失败，且没有未知外部结果被接受）。 */
  readonly clean: boolean;
  readonly detail: string;
}

/** 生成确定性 id 工厂（宿主构造**一次**并复用；本层不替调用方造 id 来源）。 */
export function createSequenceMemoryIdFactory(prefix = 'exp'): () => MemoryId {
  let seq = 0;
  return () => asMemoryId(`${prefix}-${String(seq++)}`);
}

/** 同 owner + 同模板 + 有效的既有经验（版本号计算的输入）。 */
function activeTemplateExperiences(
  repository: MemoryRepository,
  ownerId: OwnerId,
  templateId: TemplateId,
): readonly TemplateExperienceMemory[] {
  return repository
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
    .filter(
      (entry) =>
        entry.owner_id === ownerId && entry.template_id === templateId && entry.status === 'active',
    );
}

/**
 * 任务终态后，按真实证据固化经验（**产品运行期唯一的写入口**）。
 *
 * 顺序（每一道门都由既有实现承担，本层只串起来）：
 * 1. **触发门**：`experienceTriggerOf(completion)`；非终态 ⇒ **提前返回**（`proposal` / `pipeline`
 *    为 `null`，一个字节都不写）。在途任务不得提经验候选。
 * 2. **证据门**：`proposeExperienceCandidates(evidence)` —— 只放行 `sealed && readback_verified`；
 *    其余进 `evidence_rejections`。
 * 3. **裁决 + 版本化写入**：`synthesizeExperiences({candidates, context, at, repository})`。
 *    同文本 ⇒ `no_change`（**不写库**）；`unknown_external` ⇒ `blocked_unknown_external`（不写库）；
 *    `add` ⇒ 版本化写入（版本 = 既有同模板最大版本 + 1）。
 */
export function synthesizeTaskExperience(input: TaskExperienceWiringInput): TaskExperienceWiringReport {
  const trigger = experienceTriggerOf(input.completion);

  // 证据必须属于本任务的模板：候选的 `template_id` 取自证据，若不先按模板筛掉，
  // 别的模板的证据会被写成本模板的经验（模板归属错位）。剔除的如实登记，不静默丢弃。
  const ownEvidence = input.evidence.filter((item) => item.template_id === input.template_id);
  const foreignRefs = Object.freeze(
    input.evidence.filter((item) => item.template_id !== input.template_id).map((item) => item.evidence_ref),
  );

  if (!trigger.eligible) {
    // **在途任务在这里被拦下**：没有候选、没有裁决、没有写库路径可走。
    return Object.freeze({
      task_id: input.completion.task_id,
      template_id: input.template_id,
      trigger,
      proposal: null,
      pipeline: null,
      accepted_lessons: Object.freeze([]),
      no_change_lessons: Object.freeze([]),
      written: Object.freeze([]),
      blocked_unknown_external: Object.freeze([]),
      evidence_rejections: Object.freeze([]),
      foreign_template_evidence_refs: foreignRefs,
      clean: true,
      detail:
        `任务 ${input.completion.task_id} 尚未到终态（${trigger.reasons.join('；')}）：` +
        '在途任务不得提经验候选（FA-MEM 触发门）——不产生候选、不裁决、不写库',
    });
  }

  const proposal = proposeExperienceCandidates(ownEvidence);

  const context: ExperienceContext = {
    owner_id: input.owner_id,
    existing: activeTemplateExperiences(input.repository, input.owner_id, input.template_id),
    isSensitive: input.isSensitive ?? (() => false),
    detectConflict: input.detectConflict ?? (() => false),
    source: input.source ?? DEFAULT_EXPERIENCE_SOURCE,
    newMemoryId: input.newMemoryId,
  };

  const pipeline = synthesizeExperiences({
    candidates: proposal.candidates,
    context,
    at: input.at,
    repository: input.repository,
  });

  return Object.freeze({
    task_id: input.completion.task_id,
    template_id: input.template_id,
    trigger,
    proposal,
    pipeline,
    accepted_lessons: pipeline.accepted_lessons,
    no_change_lessons: pipeline.no_change_lessons,
    written: pipeline.written,
    blocked_unknown_external: pipeline.blocked_unknown_external,
    evidence_rejections: proposal.rejections,
    foreign_template_evidence_refs: foreignRefs,
    clean: isExperiencePipelineClean(pipeline),
    detail:
      `任务 ${input.completion.task_id}（${input.completion.label}）经验固化：` +
      `接受 ${String(pipeline.accepted_lessons.length)}、不新增 ${String(pipeline.no_change_lessons.length)}、` +
      `拒绝 ${String(pipeline.rejected.length)}、写入 ${String(pipeline.written.length)}`,
  });
}

// ---------------------------------------------------------------------------
// 4. 注入：下一个任务的新实例
// ---------------------------------------------------------------------------

export interface TaskInstanceInjectionInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly template_id: TemplateId;
  /** **新实例**的 id（下一个任务开跑时签发）。 */
  readonly instance_id: string;
  readonly at: LogicalTime;
}

/** 一个实例绑定到的经验注入面。 */
export interface TaskInstanceInjection {
  readonly instance_id: string;
  readonly template_id: TemplateId;
  readonly binding: InstanceExperienceBinding;
  /** 本实例**冻结**的规则（= 绑定时刻的有效经验 lesson；不随库变化）。 */
  readonly rules: readonly string[];
  /** 走**真实检索路径**（`recall`）此刻可注入的经验 lesson。 */
  readonly recall_lessons: readonly string[];
}

/**
 * 为**新实例**绑定经验注入（下一个任务开跑时调用）。
 *
 * 冻结快照语义来自 `bindInstanceExperience`：绑定后到达的新经验**不会**进入本实例规则；
 * 想吃到必须重新签发（下下个实例）。`recall_lessons` 走真实检索路径，用于与冻结规则对照。
 */
export function bindTaskInstanceExperience(input: TaskInstanceInjectionInput): TaskInstanceInjection {
  const binding = bindInstanceExperience(input.repository, {
    instance_id: input.instance_id,
    owner_id: input.owner_id,
    template_id: input.template_id,
    at: input.at,
  });
  return Object.freeze({
    instance_id: input.instance_id,
    template_id: input.template_id,
    binding,
    rules: binding.rules,
    recall_lessons: injectableExperienceLessons(input.repository, input.owner_id, input.template_id),
  });
}

/** 实例注入面的**卫生检查**（把"失效后仍在旧实例规则里"变成可断言的证据）。 */
export interface InjectionHygiene {
  readonly instance_id: string;
  /** 绑定时刻冻结的规则（不随库变化）。 */
  readonly frozen_rules: readonly string[];
  /** 走 `recall` 此刻能注入的 lesson。 */
  readonly recall_lessons: readonly string[];
  /** 库里此刻有效的 lesson。 */
  readonly active_now: readonly string[];
  /** 冻结规则里**已被失效 / 回滚 / 忘记**的 lesson（非空 ⇒ 该实例规则已陈旧）。 */
  readonly removed_since_binding: readonly string[];
  /** 绑定之后**新增**的有效 lesson（本实例尚未吃到）。 */
  readonly added_since_binding: readonly string[];
  /** 本实例与库之间是否存在任何差（新增或移除）。 */
  readonly stale: boolean;
  /** **字面量判据**：冻结规则里是否有已失效的 lesson（= "失效后仍注入"被检出）。 */
  readonly drifted: boolean;
}

/**
 * 检查一个实例绑定的注入卫生。
 *
 * 关键：`removed_since_binding` 非空 ⇒ 该实例的冻结规则里**含有此刻已不可注入**的经验。
 * 若产品仍然照旧实例的 `rules` 注入（而不重新签发），那些失效经验就会**继续被注入**——
 * 这正是"失效后仍注入"必须被检出的情形。`drifted` 是对它的直接布尔判据。
 */
export function verifyInstanceInjection(
  injection: TaskInstanceInjection,
  repository: MemoryRepository,
): InjectionHygiene {
  const diff = instanceRuleDiff(injection.binding, repository);
  return Object.freeze({
    instance_id: injection.instance_id,
    frozen_rules: diff.frozen_rules,
    recall_lessons: injectableExperienceLessons(
      repository,
      injection.binding.owner_id,
      injection.binding.template_id,
    ),
    active_now: diff.current_active_lessons,
    removed_since_binding: diff.removed_since_binding,
    added_since_binding: diff.added_since_binding,
    stale: diff.stale,
    drifted: diff.removed_since_binding.length > 0,
  });
}

// ---------------------------------------------------------------------------
// 5. 回滚：一次具体写入；回滚后不再命中、历史保留
// ---------------------------------------------------------------------------

export interface TaskExperienceRollbackInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId;
  /** 调用方声明回滚**哪一个版本**（杜绝"回滚最新那条"的模糊语义）。 */
  readonly expected_version: Revision;
  readonly at: LogicalTime;
  readonly reason: string;
}

/** 一次经验回滚的产品报告（在 `rollbackExperienceWrite` 之上补"检索不再命中 + 历史保留"的复核）。 */
export interface TaskExperienceRollbackReport {
  readonly result: RollbackExperienceWriteResult;
  readonly rolled_back: boolean;
  /** 回滚后走**真实检索路径**是否仍能命中该版本（期望 `false`）。 */
  readonly injectable_after: boolean;
  /** 回滚前该 owner 的模板经验条目总数（含停用——历史条目）。 */
  readonly history_before: number;
  /** 回滚后同口径条目总数（期望与回滚前**相等**）。 */
  readonly history_after: number;
  /** **字面量判据**：历史确实保留（条目数不变）。 */
  readonly history_preserved: boolean;
  readonly detail: string;
}

/** 某 owner 的模板经验条目总数（含停用 / 删除——审计历史口径）。 */
function historyCount(repository: MemoryRepository, ownerId: OwnerId): number {
  return repository
    .listByKind('template_experience')
    .filter((entry) => entry.owner_id === ownerId).length;
}

/**
 * 回滚**一次具体的经验写入（版本）**，并复核两条不变量：
 * - **检索不再命中**：回滚后 `recall` 取不到该条目（`injectable_after === false`）；
 * - **历史保留**：条目只被停用、不被删除，总数不变（`history_preserved === true`）。
 *
 * 校验（未写入 / 版本不符 / 无原因 …）完全交给 `rollbackExperienceWrite`——本层不复制其判据。
 */
export function rollbackTaskExperience(input: TaskExperienceRollbackInput): TaskExperienceRollbackReport {
  const before = historyCount(input.repository, input.owner_id);
  const result = rollbackExperienceWrite({
    repository: input.repository,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    expected_version: input.expected_version,
    at: input.at,
    reason: input.reason,
  });
  const after = historyCount(input.repository, input.owner_id);
  const injectableAfter = isExperienceInjectable(input.repository, input.owner_id, input.memory_id);
  const rolledBack = result.kind === 'rolled_back';
  let detail: string;
  if (result.kind === 'rolled_back') {
    detail =
      `经验 ${String(input.memory_id)} 已回滚（r${String(input.expected_version)}）：` +
      `检索${injectableAfter ? '仍能' : '不再'}命中；历史条目数 ${String(before)} → ${String(after)}`;
  } else {
    detail = `经验 ${String(input.memory_id)} 回滚失败（${result.reason}）：${result.detail}`;
  }
  return Object.freeze({
    result,
    rolled_back: rolledBack,
    injectable_after: injectableAfter,
    history_before: before,
    history_after: after,
    history_preserved: before === after,
    detail,
  });
}
