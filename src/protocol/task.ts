/**
 * 任务记录与版本判定（附录 A1；合同 §二 Q1-a）。
 *
 * Q1-a 的裁决要求 revision 的"实质性"由**结构化 patch** 表达，内核按
 * 「是否触及 硬约束 / 交付物 / 禁止事项 / 预算」自动判定，**不接受模型的自然语言自称**。
 * 本文件把该形状落地为 `TaskPatch` + 纯函数 `classifyTaskPatch()` / `applyTaskPatch()`；
 * 何时调用由 D03 决定（本文件不含调度）。
 */

import {
  asCapabilityId,
  asGroupId,
  asRevision,
  nextRevision,
  type ActionRef,
  type ArtifactRef,
  type CapabilityId,
  type EvidenceRef,
  type FactRef,
  type GroupId,
  type LogicalTime,
  type Revision,
  type TaskId,
  INITIAL_REVISION,
} from './ids.js';
import { REVISION_TRIGGER_KINDS, type RevisionTrigger } from './constants.js';
import { ValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// 任务记录（附录 A1 TaskRecord；字段名可调，语义不可丢）
// ---------------------------------------------------------------------------

export interface TaskRecord {
  readonly task_id: TaskId;
  /** 任务版本，单调递增；旧版本结果不得覆盖最新（任务书:270 / §13）。 */
  readonly revision: Revision;
  readonly title: string;
  readonly goal: string;
  readonly hard_constraints: readonly string[];
  readonly soft_preferences: readonly string[];
  readonly deliverables: readonly string[];
  readonly completion_criteria: readonly string[];
  readonly authorized_data_refs: readonly string[];
  /** 允许的能力范围（用**能力标识**，不是实例身份）。 */
  readonly capability_scope: readonly CapabilityId[];
  readonly forbidden_actions: readonly string[];
  readonly current_group_id: GroupId | null;
  readonly waiting_conditions: readonly string[];
  readonly budget_limits: Readonly<Record<string, number>>;
  readonly shared_fact_refs: readonly FactRef[];
  readonly artifact_refs: readonly ArtifactRef[];
  readonly action_refs: readonly ActionRef[];
  readonly evidence_refs: readonly EvidenceRef[];
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

export interface TaskRecordInput {
  readonly task_id: TaskId;
  readonly goal: string;
  readonly created_at: LogicalTime;
  readonly revision?: Revision;
  readonly title?: string;
  readonly hard_constraints?: readonly string[];
  readonly soft_preferences?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly completion_criteria?: readonly string[];
  readonly authorized_data_refs?: readonly string[];
  readonly capability_scope?: readonly CapabilityId[];
  readonly forbidden_actions?: readonly string[];
  readonly current_group_id?: GroupId | null;
  readonly waiting_conditions?: readonly string[];
  readonly budget_limits?: Readonly<Record<string, number>>;
  readonly shared_fact_refs?: readonly FactRef[];
  readonly artifact_refs?: readonly ArtifactRef[];
  readonly action_refs?: readonly ActionRef[];
  readonly evidence_refs?: readonly EvidenceRef[];
  readonly updated_at?: LogicalTime;
}

/** 用默认空集补齐可选字段，方便下游构造。 */
export function createTaskRecord(input: TaskRecordInput): TaskRecord {
  if (input.goal.length === 0) {
    throw new ValidationError('TaskRecord.goal 不能为空');
  }
  return Object.freeze({
    task_id: input.task_id,
    revision: input.revision ?? INITIAL_REVISION,
    title: input.title ?? '',
    goal: input.goal,
    hard_constraints: input.hard_constraints ?? [],
    soft_preferences: input.soft_preferences ?? [],
    deliverables: input.deliverables ?? [],
    completion_criteria: input.completion_criteria ?? [],
    authorized_data_refs: input.authorized_data_refs ?? [],
    capability_scope: input.capability_scope ?? [],
    forbidden_actions: input.forbidden_actions ?? [],
    current_group_id: input.current_group_id ?? null,
    waiting_conditions: input.waiting_conditions ?? [],
    budget_limits: input.budget_limits ?? {},
    shared_fact_refs: input.shared_fact_refs ?? [],
    artifact_refs: input.artifact_refs ?? [],
    action_refs: input.action_refs ?? [],
    evidence_refs: input.evidence_refs ?? [],
    created_at: input.created_at,
    updated_at: input.updated_at ?? input.created_at,
  });
}

// ---------------------------------------------------------------------------
// 结构化 patch（Q1-a 的形状由 D01 定；已在 D01 报告中登记）
// ---------------------------------------------------------------------------

/** 可被 patch 触及的任务字段（白名单；不在名单内的字段只能由内核维护）。 */
export const TASK_PATCHABLE_FIELDS = [
  'title',
  'goal',
  'hard_constraints',
  'soft_preferences',
  'deliverables',
  'completion_criteria',
  'authorized_data_refs',
  'capability_scope',
  'forbidden_actions',
  'waiting_conditions',
  'budget_limits',
  'current_group_id',
] as const;

export type TaskPatchableField = (typeof TASK_PATCHABLE_FIELDS)[number];

export type TaskPatchOperationKind = 'add' | 'remove' | 'replace';

/**
 * 一条结构化 patch 操作：**只有字段与操作种类**，不含自然语言结论。
 * `add` / `remove` 用于集合类字段，`replace` 用于标量或整字段替换。
 */
export interface TaskPatchOperation {
  readonly field: TaskPatchableField;
  readonly kind: TaskPatchOperationKind;
  readonly value?: unknown;
}

export interface TaskPatch {
  readonly task_id: TaskId;
  /** patch 所基于的任务版本（用于错配检测，Q1-b 的输入之一）。 */
  readonly base_revision: Revision;
  readonly operations: readonly TaskPatchOperation[];
}

/**
 * 触及这些字段的 patch 被判为**实质性** → 递增 revision。
 * 其余字段（如 `soft_preferences`）不递增：偏好不得被默默升级为绝对限制（任务书:145）。
 */
export const SUBSTANTIVE_FIELD_TRIGGERS: Readonly<
  Partial<Record<TaskPatchableField, RevisionTrigger>>
> = {
  hard_constraints: 'hard_constraint',
  deliverables: 'deliverable',
  forbidden_actions: 'forbidden_action',
  budget_limits: 'budget',
};

export interface TaskPatchClassification {
  /** 是否属于"实质性需求变更"（决定 revision 是否递增）。 */
  readonly substantive: boolean;
  /** 命中的触发类别（去重、按 `REVISION_TRIGGER_KINDS` 顺序稳定输出）。 */
  readonly triggers: readonly RevisionTrigger[];
  /** 从 `base_revision` 出发应落到的目标版本。 */
  readonly target_revision: Revision;
}

const PATCHABLE_FIELD_SET: ReadonlySet<string> = new Set<string>(TASK_PATCHABLE_FIELDS);

/**
 * 按 Q1-a 判定一份结构化 patch 的影响面。
 * 纯函数：不写存储、不读时钟。
 */
export function classifyTaskPatch(patch: TaskPatch): TaskPatchClassification {
  const hit = new Set<RevisionTrigger>();
  for (const operation of patch.operations) {
    if (!PATCHABLE_FIELD_SET.has(operation.field)) {
      throw new ValidationError(`patch 触及了不可 patch 的字段：${String(operation.field)}`);
    }
    const trigger = SUBSTANTIVE_FIELD_TRIGGERS[operation.field];
    if (trigger !== undefined) {
      hit.add(trigger);
    }
  }
  const triggers = REVISION_TRIGGER_KINDS.filter((kind) => hit.has(kind));
  const substantive = triggers.length > 0;
  return Object.freeze({
    substantive,
    triggers,
    target_revision: substantive ? nextRevision(patch.base_revision) : patch.base_revision,
  });
}

/**
 * patch 应用期的形状校验（合同 v1.1 C5）。
 *
 * 每个字段都有自己的类型：`replace` 必须给出**该字段完整类型**的值，
 * `add` / `remove` 只接受**集合元素**；不合法一律抛 `ValidationError`，
 * **不允许**把未校验的 `unknown` 直接塞进 `TaskRecord`（那会写出违反声明的记录）。
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function requireStringValue(field: TaskPatchableField, value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`字段 ${field} 必须是字符串，收到 ${describeValue(value)}`);
  }
  return value;
}

function requireNonEmptyStringValue(field: TaskPatchableField, value: unknown): string {
  const text = requireStringValue(field, value);
  if (text.length === 0) {
    throw new ValidationError(`字段 ${field} 不能是空字符串`);
  }
  return text;
}

function requireStringArrayValue(field: TaskPatchableField, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`字段 ${field} 的 replace 值必须是字符串数组，收到 ${describeValue(value)}`);
  }
  return value.map((item) => requireStringValue(field, item));
}

function requireBudgetLimitsValue(field: TaskPatchableField, value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`字段 ${field} 的 replace 值必须是 { 名称: 有限数 } 对象，收到 ${describeValue(value)}`);
  }
  const limits: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new ValidationError(`字段 ${field} 的 ${key} 必须是有限数，收到 ${describeValue(entry)}`);
    }
    limits[key] = entry;
  }
  return limits;
}

function requireGroupIdValue(field: TaskPatchableField, value: unknown): GroupId | null {
  if (value === null) {
    return null;
  }
  return asGroupId(requireNonEmptyStringValue(field, value));
}

/** 标量字段只允许 `replace`。 */
function requireReplaceOnly(field: TaskPatchableField, kind: TaskPatchOperationKind): void {
  if (kind !== 'replace') {
    throw new ValidationError(`字段 ${field} 不是集合，只支持 replace，不支持 ${kind}`);
  }
}

/** 集合字段接受三种操作；`replace` 必须给出完整数组。 */
function requireCollectionElement(field: TaskPatchableField, value: unknown): string {
  return requireStringValue(field, value);
}

/**
 * 把结构化 patch 应用到任务记录，产出新记录。
 *
 * - 仅当 `classifyTaskPatch().substantive` 为真时递增 revision（结构判定，不看模型措辞）。
 * - `patch.base_revision` 与当前 revision 不一致时抛错（错配不得静默套用）。
 * - **每个被改字段都经运行时形状校验**；最终记录用 `satisfies TaskRecord` 由类型检查器复核，
 *   不存在"用 `as` 把未校验数据塞进记录"的旁路（v1.1 C5）。
 */
export function applyTaskPatch(
  task: TaskRecord,
  patch: TaskPatch,
  now: LogicalTime,
): TaskRecord {
  if (patch.task_id !== task.task_id) {
    throw new ValidationError('patch.task_id 与目标任务不一致');
  }
  if (patch.base_revision !== task.revision) {
    throw new ValidationError(
      `patch 基于 revision ${String(patch.base_revision)}，但任务当前为 ${String(task.revision)}`,
    );
  }
  const classification = classifyTaskPatch(patch);

  // 逐字段的可变草稿：字段类型与 TaskRecord 一一对应（capability_scope 保留品牌类型）。
  const title = task.title;
  const goal = task.goal;
  const hardConstraints = [...task.hard_constraints];
  const softPreferences = [...task.soft_preferences];
  const deliverables = [...task.deliverables];
  const completionCriteria = [...task.completion_criteria];
  const authorizedDataRefs = [...task.authorized_data_refs];
  const capabilityScope: CapabilityId[] = [...task.capability_scope];
  const forbiddenActions = [...task.forbidden_actions];
  const waitingConditions = [...task.waiting_conditions];
  const budgetLimits: Record<string, number> = { ...task.budget_limits };
  let currentGroupId: GroupId | null = task.current_group_id;

  // 标量字段：只允许 replace。以局部变量承接，避免 Record<string, unknown> 的中转。
  let nextTitle = title;
  let nextGoal = goal;

  for (const operation of patch.operations) {
    const { field, kind } = operation;
    switch (field) {
      case 'title':
        requireReplaceOnly(field, kind);
        nextTitle = requireStringValue(field, operation.value);
        break;
      case 'goal':
        requireReplaceOnly(field, kind);
        nextGoal = requireNonEmptyStringValue(field, operation.value);
        break;
      case 'current_group_id':
        requireReplaceOnly(field, kind);
        currentGroupId = requireGroupIdValue(field, operation.value);
        break;
      case 'capability_scope': {
        // 元素是品牌化的能力标识：与普通字符串数组分开处理，避免用 `as` 处理未校验值。
        if (kind === 'replace') {
          capabilityScope.length = 0;
          capabilityScope.push(...requireStringArrayValue(field, operation.value).map(asCapabilityId));
        } else {
          const element = asCapabilityId(requireCollectionElement(field, operation.value));
          if (kind === 'add') {
            capabilityScope.push(element);
          } else {
            const position = capabilityScope.indexOf(element);
            if (position >= 0) {
              capabilityScope.splice(position, 1);
            }
          }
        }
        break;
      }
      case 'hard_constraints':
      case 'soft_preferences':
      case 'deliverables':
      case 'completion_criteria':
      case 'authorized_data_refs':
      case 'forbidden_actions':
      case 'waiting_conditions': {
        const target = stringCollectionOf({
          field,
          hardConstraints,
          softPreferences,
          deliverables,
          completionCriteria,
          authorizedDataRefs,
          forbiddenActions,
          waitingConditions,
        });
        if (kind === 'replace') {
          target.length = 0;
          target.push(...requireStringArrayValue(field, operation.value));
        } else {
          const element = requireCollectionElement(field, operation.value);
          if (kind === 'add') {
            target.push(element);
          } else {
            const position = target.indexOf(element);
            if (position >= 0) {
              target.splice(position, 1);
            }
          }
        }
        break;
      }
      case 'budget_limits': {
        if (kind !== 'replace') {
          throw new ValidationError(`字段 ${field} 只支持 replace（给出完整的 { 名称: 上限 } 对象）`);
        }
        const limits = requireBudgetLimitsValue(field, operation.value);
        for (const key of Object.keys(budgetLimits)) {
          delete budgetLimits[key];
        }
        for (const [key, value] of Object.entries(limits)) {
          budgetLimits[key] = value;
        }
        break;
      }
      default:
        // `classifyTaskPatch` 已拒绝白名单外的字段；这里保留穷尽性兜底。
        throw new ValidationError(`字段 ${String(field)} 不可 patch`);
    }
  }

  const next = {
    task_id: task.task_id,
    revision: classification.target_revision,
    title: nextTitle,
    goal: nextGoal,
    hard_constraints: hardConstraints,
    soft_preferences: softPreferences,
    deliverables,
    completion_criteria: completionCriteria,
    authorized_data_refs: authorizedDataRefs,
    capability_scope: capabilityScope,
    forbidden_actions: forbiddenActions,
    current_group_id: currentGroupId,
    waiting_conditions: waitingConditions,
    budget_limits: budgetLimits,
    shared_fact_refs: task.shared_fact_refs,
    artifact_refs: task.artifact_refs,
    action_refs: task.action_refs,
    evidence_refs: task.evidence_refs,
    created_at: task.created_at,
    updated_at: now,
  } satisfies TaskRecord;

  return Object.freeze(next);
}

/** 纯字符串集合字段名 → 草稿数组的绑定表（保持 switch 的穷尽性与类型安全）。 */
function stringCollectionOf(bindings: {
  field: TaskPatchableField;
  hardConstraints: string[];
  softPreferences: string[];
  deliverables: string[];
  completionCriteria: string[];
  authorizedDataRefs: string[];
  forbiddenActions: string[];
  waitingConditions: string[];
}): string[] {
  switch (bindings.field) {
    case 'hard_constraints':
      return bindings.hardConstraints;
    case 'soft_preferences':
      return bindings.softPreferences;
    case 'deliverables':
      return bindings.deliverables;
    case 'completion_criteria':
      return bindings.completionCriteria;
    case 'authorized_data_refs':
      return bindings.authorizedDataRefs;
    case 'forbidden_actions':
      return bindings.forbiddenActions;
    case 'waiting_conditions':
      return bindings.waitingConditions;
    default:
      throw new ValidationError(`字段 ${String(bindings.field)} 不是纯字符串集合字段`);
  }
}

/** 便捷判定：这份 patch 是否需要递增 revision。 */
export function isSubstantivePatch(patch: TaskPatch): boolean {
  return classifyTaskPatch(patch).substantive;
}

/** 便捷构造：把一组字段变更表达为结构化 patch。 */
export function createTaskPatch(
  taskId: TaskId,
  baseRevision: Revision,
  operations: readonly TaskPatchOperation[],
): TaskPatch {
  return Object.freeze({ task_id: taskId, base_revision: asRevision(baseRevision), operations });
}
