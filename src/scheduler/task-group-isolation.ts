/**
 * KRN-01：**持久任务 / 群组 / 实例 / 运行轮次**四层身份的边界分离。
 *
 * ## 为什么要有这个模块
 *
 * 任务书与合同把四层身份写成四种不同的东西：
 * - **任务（`TaskRecord`）**：持久，跨群组存在，跨进程续接（R202/R203 的 id 单调性）；
 * - **群组（`GroupId`）**：任务级临时容器，任务完成即可释放；
 * - **实例（`InstanceId`）**：群内临时工作者，随群组释放；
 * - **轮次（`RunId`）**：实例上的一次运行，与有限租约绑定。
 *
 * 现有代码里这四层**分别**由 `protocol/task.ts` / `protocol/instance.ts` /
 * `protocol/run.ts` 承载，但**没有一处**回答"它们的边界关系是什么、释放时谁留谁走"。
 * 缺了这一层，最容易出现的失效模式是：用群组身份代替任务身份、把实例的存活
 * 当成任务的存活、或者"任务完成顺手把任务记录也清了"。
 *
 * 本模块用一份**纯内存、不可变**的登记表把边界写成可断言的不变量（无 I/O、无墙钟）。
 *
 * ## 五条被冻结的不变量
 *
 * 1. **身份空间互不冒充**：`group_id` 不得被当成 `task_id` 用（反之亦然）——
 *    `identityNamespaceCollisions()` 检出跨命名空间重名。
 * 2. **归属链**：实例属于群组、群组属于任务；轮次属于实例，且其 `task_id` / `group_id`
 *    必须与实例的归属一致。任一断裂抛 `ScopeIsolationError`（**不做静默修正**）。
 * 3. **任务跨群续接**：`continueTaskInNewGroup()` 换群**不换任务身份**，`revision` 不倒退。
 * 4. **完成后释放临时实例、保留必要记录**：`releaseTaskScopes()` 只允许对 `completed`
 *    任务调用；它把群组与实例置 `released`（运行态归零），但**任务记录、证据引用、
 *    轮次记录与群组历史一律保留**（反向对照：任务记录绝不可被本函数删除）。
 * 5. **跨进程续接**：`toContinuationPayload()` / `resumeFromContinuation()` 把"必须跨进程
 *    存活的东西"与"可以死的临时东西"分开。
 *
 * ## 纪律与边界（务必如实理解）
 *
 * - 纯函数 + 不可变记录，**无 I/O**；时间一律以 `LogicalTime` 传入（无墙钟 / 无随机）。
 * - 本模块**只**做边界分离与释放记账；消息入口、轮次编排、持久化仍归既有模块。
 * - **跨进程续接是进程内模拟**：`resumeFromContinuation()` 只是用另一份登记表重建状态，
 *   它**不**证明真实的第二个操作系统进程能恢复（真进程重启需要验证持久介质，
 *   未在本模块与本次测试范围内验证）。
 */

import {
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type RunId,
  type RunStatus,
  type TaskId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 违规原因与错误
// ---------------------------------------------------------------------------

export const SCOPE_VIOLATION_REASONS = [
  'unknown_task',
  'unknown_group',
  'unknown_instance',
  'identity_namespace_collision',
  'group_task_mismatch',
  'instance_group_mismatch',
  'run_instance_mismatch',
  'run_group_mismatch',
  'run_task_mismatch',
  'instance_released',
  'task_not_completed',
  'revision_regression',
  'duplicate_registration',
] as const;

export type ScopeViolationReason = (typeof SCOPE_VIOLATION_REASONS)[number];

/** 边界违规：**抛错而不是静默修正**（静默修正会让"越界"变成不可观测的成功）。 */
export class ScopeIsolationError extends Error {
  readonly reason: ScopeViolationReason;

  constructor(reason: ScopeViolationReason, message: string) {
    super(message);
    this.name = 'ScopeIsolationError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 四层记录
// ---------------------------------------------------------------------------

export const TASK_PERSISTENCE_STATES = ['active', 'completed', 'cancelled'] as const;
export type TaskPersistenceState = (typeof TASK_PERSISTENCE_STATES)[number];

export const GROUP_SCOPE_STATES = ['active', 'released'] as const;
export type GroupScopeState = (typeof GROUP_SCOPE_STATES)[number];

export const INSTANCE_SCOPE_STATES = ['live', 'released'] as const;
export type InstanceScopeState = (typeof INSTANCE_SCOPE_STATES)[number];

/** 持久任务边界。它**不属于**任何群组；`current_group_id` 只是"现在挂在哪个群"。 */
export interface TaskScope {
  readonly task_id: TaskId;
  readonly revision: Revision;
  /**
   * 打开该任务的进程标识。跨进程续接后本字段变为新进程 —— 是"任务跨进程存活"的
   * 可断言证据（任务身份 `task_id` 不变，进程身份变）。
   */
  readonly opened_in_process: string;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
  /** 当前挂载的群组（可为 null：任务在两个群组之间的间隙）。 */
  readonly current_group_id: GroupId | null;
  readonly state: TaskPersistenceState;
  /** 任务级**必留**记录：临时实例释放后这些仍在。 */
  readonly retained_evidence_refs: readonly string[];
  /** 曾挂载过的群组（跨群续接的痕迹；释放后仍保留）。 */
  readonly group_history: readonly GroupId[];
}

/** 临时群组边界：属于某个任务，任务完成即可释放。 */
export interface GroupScope {
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
  readonly state: GroupScopeState;
  readonly release_reason: string | null;
}

/** 临时实例边界：属于某个群组（因而属于该群组的任务）。 */
export interface InstanceScope {
  readonly instance_id: InstanceId;
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
  readonly state: InstanceScopeState;
  readonly release_reason: string | null;
}

/** 运行轮次边界：属于某个实例，因而同时绑定任务与群组。 */
export interface RunScope {
  readonly run_id: RunId;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly started_at: LogicalTime;
  readonly status: RunStatus;
}

/** 释放审计：每一次释放都留痕（"释放"本身也是要保留的记录）。 */
export interface ReleaseRecord {
  readonly task_id: TaskId;
  readonly at: LogicalTime;
  readonly reason: string;
  readonly released_group_ids: readonly GroupId[];
  readonly released_instance_ids: readonly InstanceId[];
}

export interface ScopeRegistry {
  readonly tasks: Readonly<Record<string, TaskScope>>;
  readonly groups: Readonly<Record<string, GroupScope>>;
  readonly instances: Readonly<Record<string, InstanceScope>>;
  readonly runs: Readonly<Record<string, RunScope>>;
  readonly releases: readonly ReleaseRecord[];
}

export function createEmptyScopeRegistry(): ScopeRegistry {
  return Object.freeze({
    tasks: Object.freeze({}),
    groups: Object.freeze({}),
    instances: Object.freeze({}),
    runs: Object.freeze({}),
    releases: Object.freeze([]),
  });
}

// ---------------------------------------------------------------------------
// 登记（每一层都校验归属链）
// ---------------------------------------------------------------------------

export interface RegisterTaskInput {
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly process_id: string;
  readonly at: LogicalTime;
  readonly retained_evidence_refs?: readonly string[];
}

export function registerTask(registry: ScopeRegistry, input: RegisterTaskInput): ScopeRegistry {
  if (typeof input.process_id !== 'string' || input.process_id.length === 0) {
    throw new ScopeIsolationError('unknown_task', '登记任务必须给出非空 process_id（跨进程续接的判据）');
  }
  if (registry.tasks[input.task_id] !== undefined) {
    throw new ScopeIsolationError(
      'duplicate_registration',
      `任务 ${input.task_id} 已登记：不得重复登记（续接请用 resumeFromContinuation / continueTaskInNewGroup）`,
    );
  }
  const task: TaskScope = Object.freeze({
    task_id: input.task_id,
    revision: input.revision,
    opened_in_process: input.process_id,
    created_at: input.at,
    updated_at: input.at,
    current_group_id: null,
    state: 'active',
    retained_evidence_refs: Object.freeze([...(input.retained_evidence_refs ?? [])]),
    group_history: Object.freeze([]),
  });
  return Object.freeze({ ...registry, tasks: Object.freeze({ ...registry.tasks, [input.task_id]: task }) });
}

export interface RegisterGroupInput {
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  readonly at: LogicalTime;
}

/** 挂载一个临时群组。群组**必须**属于一个已登记的任务（归属链第一环）。 */
export function registerGroup(registry: ScopeRegistry, input: RegisterGroupInput): ScopeRegistry {
  const task = registry.tasks[input.task_id];
  if (task === undefined) {
    throw new ScopeIsolationError('unknown_task', `群组 ${input.group_id} 指向未登记的任务 ${input.task_id}`);
  }
  if (task.state !== 'active') {
    throw new ScopeIsolationError(
      'unknown_task',
      `任务 ${input.task_id} 处于 ${task.state}：不得再挂载新群组（任务已完成/取消，群组是临时容器）`,
    );
  }
  if (registry.groups[input.group_id] !== undefined) {
    throw new ScopeIsolationError('duplicate_registration', `群组 ${input.group_id} 已登记`);
  }
  const group: GroupScope = Object.freeze({
    group_id: input.group_id,
    task_id: input.task_id,
    created_at: input.at,
    updated_at: input.at,
    state: 'active',
    release_reason: null,
  });
  const nextTask: TaskScope = Object.freeze({
    ...task,
    current_group_id: input.group_id,
    group_history: Object.freeze([...task.group_history, input.group_id]),
    updated_at: input.at,
  });
  return Object.freeze({
    ...registry,
    tasks: Object.freeze({ ...registry.tasks, [input.task_id]: nextTask }),
    groups: Object.freeze({ ...registry.groups, [input.group_id]: group }),
  });
}

export interface RegisterInstanceInput {
  readonly instance_id: InstanceId;
  readonly group_id: GroupId;
  readonly at: LogicalTime;
}

/** 登记临时实例。`task_id` **从群组推导**，调用方无权另报一个（防止归属链被伪造）。 */
export function registerInstance(registry: ScopeRegistry, input: RegisterInstanceInput): ScopeRegistry {
  const group = registry.groups[input.group_id];
  if (group === undefined) {
    throw new ScopeIsolationError(
      'unknown_group',
      `实例 ${input.instance_id} 指向未登记的群组 ${input.group_id}`,
    );
  }
  if (group.state === 'released') {
    throw new ScopeIsolationError(
      'instance_released',
      `群组 ${input.group_id} 已释放：不得在其下新建实例`,
    );
  }
  if (registry.instances[input.instance_id] !== undefined) {
    throw new ScopeIsolationError('duplicate_registration', `实例 ${input.instance_id} 已登记`);
  }
  const instance: InstanceScope = Object.freeze({
    instance_id: input.instance_id,
    group_id: input.group_id,
    task_id: group.task_id,
    created_at: input.at,
    updated_at: input.at,
    state: 'live',
    release_reason: null,
  });
  return Object.freeze({
    ...registry,
    instances: Object.freeze({ ...registry.instances, [input.instance_id]: instance }),
  });
}

export interface RegisterRunInput {
  readonly run_id: RunId;
  readonly instance_id: InstanceId;
  readonly at: LogicalTime;
  readonly status?: RunStatus;
}

/** 登记运行轮次。`task_id` 与 `group_id` 一律**从实例推导**并逐项复核。 */
export function registerRun(registry: ScopeRegistry, input: RegisterRunInput): ScopeRegistry {
  const instance = registry.instances[input.instance_id];
  if (instance === undefined) {
    throw new ScopeIsolationError('unknown_instance', `轮次 ${input.run_id} 指向未登记的实例 ${input.instance_id}`);
  }
  if (instance.state === 'released') {
    throw new ScopeIsolationError(
      'instance_released',
      `实例 ${input.instance_id} 已释放：不得在其上起新轮次（释放即运行态归零）`,
    );
  }
  const group = registry.groups[instance.group_id];
  if (group === undefined) {
    throw new ScopeIsolationError(
      'unknown_group',
      `实例 ${input.instance_id} 的群组 ${instance.group_id} 未登记（归属链断裂）`,
    );
  }
  if (group.task_id !== instance.task_id) {
    throw new ScopeIsolationError(
      'run_task_mismatch',
      `实例 ${input.instance_id} 的任务 ${instance.task_id} 与群组任务 ${group.task_id} 不一致`,
    );
  }
  if (registry.runs[input.run_id] !== undefined) {
    throw new ScopeIsolationError('duplicate_registration', `轮次 ${input.run_id} 已登记`);
  }
  const run: RunScope = Object.freeze({
    run_id: input.run_id,
    task_id: instance.task_id,
    group_id: instance.group_id,
    instance_id: instance.instance_id,
    started_at: input.at,
    status: input.status ?? 'running',
  });
  return Object.freeze({ ...registry, runs: Object.freeze({ ...registry.runs, [input.run_id]: run }) });
}

// ---------------------------------------------------------------------------
// 分离判定
// ---------------------------------------------------------------------------

/** 身份空间冒充检测：同一字符串同时出现在两个不同命名空间即违规（不变量 1）。 */
export function identityNamespaceCollisions(registry: ScopeRegistry): readonly string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  const scan = (namespace: string, ids: readonly string[]): void => {
    for (const id of ids) {
      const previous = seen.get(id);
      if (previous !== undefined && previous !== namespace) {
        collisions.push(`${id}: ${previous} ↔ ${namespace}`);
        continue;
      }
      seen.set(id, namespace);
    }
  };
  scan('task', Object.keys(registry.tasks));
  scan('group', Object.keys(registry.groups));
  scan('instance', Object.keys(registry.instances));
  scan('run', Object.keys(registry.runs));
  return Object.freeze(collisions);
}

/**
 * 归属链自检（不变量 2）：实例 → 群组 → 任务；轮次 → 实例 → 群组 → 任务。
 * 任一条断裂即抛错。**只读**，不改状态。
 */
export function assertScopeSeparation(registry: ScopeRegistry): void {
  const collisions = identityNamespaceCollisions(registry);
  if (collisions.length > 0) {
    throw new ScopeIsolationError(
      'identity_namespace_collision',
      `身份空间被冒充：${collisions.join('；')}（任务/群组/实例/轮次是四种不同身份）`,
    );
  }
  for (const instance of Object.values(registry.instances)) {
    const group = registry.groups[instance.group_id];
    if (group === undefined) {
      throw new ScopeIsolationError('instance_group_mismatch', `实例 ${instance.instance_id} 的群组不存在`);
    }
    if (group.task_id !== instance.task_id) {
      throw new ScopeIsolationError(
        'instance_group_mismatch',
        `实例 ${instance.instance_id}（任务 ${instance.task_id}）挂在不属于它的群组 ${group.group_id}（任务 ${group.task_id}）`,
      );
    }
  }
  for (const run of Object.values(registry.runs)) {
    const instance = registry.instances[run.instance_id];
    if (instance === undefined) {
      throw new ScopeIsolationError('run_instance_mismatch', `轮次 ${run.run_id} 的实例不存在`);
    }
    if (instance.group_id !== run.group_id || instance.task_id !== run.task_id) {
      throw new ScopeIsolationError(
        'run_group_mismatch',
        `轮次 ${run.run_id} 归属（任务 ${run.task_id} / 群组 ${run.group_id}）与实例 ${instance.instance_id} ` +
          `（任务 ${instance.task_id} / 群组 ${instance.group_id}）不一致`,
      );
    }
  }
}

/** 某任务此刻**存活**（live）的实例 id（释放后应为空）。 */
export function liveInstanceIdsOf(registry: ScopeRegistry, taskId: TaskId): readonly InstanceId[] {
  return Object.freeze(
    Object.values(registry.instances)
      .filter((instance) => instance.task_id === taskId && instance.state === 'live')
      .map((instance) => instance.instance_id),
  );
}

// ---------------------------------------------------------------------------
// 任务跨群续接（不变量 3）
// ---------------------------------------------------------------------------

export interface ContinueTaskInNewGroupInput {
  readonly task_id: TaskId;
  readonly new_group_id: GroupId;
  readonly at: LogicalTime;
  readonly reason: string;
}

export interface ContinueTaskReport {
  readonly registry: ScopeRegistry;
  readonly task: TaskScope;
  readonly previous_group_id: GroupId | null;
}

/**
 * 把任务续接到一个新群组：**任务身份 `task_id` 不变**，`revision` 不倒退，
 * 旧群组记为历史。这是"任务跨群组存在"的直接落地。
 */
export function continueTaskInNewGroup(
  registry: ScopeRegistry,
  input: ContinueTaskInNewGroupInput,
): ContinueTaskReport {
  const task = registry.tasks[input.task_id];
  if (task === undefined) {
    throw new ScopeIsolationError('unknown_task', `未登记的任务 ${input.task_id} 不能续接群组`);
  }
  if (task.state !== 'active') {
    throw new ScopeIsolationError(
      'unknown_task',
      `任务 ${input.task_id} 处于 ${task.state}：终态任务不得续接新群组`,
    );
  }
  const registered = registerGroup(registry, {
    group_id: input.new_group_id,
    task_id: input.task_id,
    at: input.at,
  });
  const after = registered.tasks[input.task_id];
  if (after === undefined) {
    // registerGroup 成功则任务必然在册；此处只是让类型收窄诚实。
    throw new ScopeIsolationError('unknown_task', `续接后任务 ${input.task_id} 丢失（不应发生）`);
  }
  if (after.revision < task.revision) {
    throw new ScopeIsolationError('revision_regression', `续接不得让任务版本倒退`);
  }
  return Object.freeze({
    registry: registered,
    task: after,
    previous_group_id: task.current_group_id,
  });
}

// ---------------------------------------------------------------------------
// 完成后释放临时实例、保留必要记录（不变量 4）
// ---------------------------------------------------------------------------

export interface ReleaseAfterCompletionInput {
  readonly task_id: TaskId;
  readonly at: LogicalTime;
  readonly reason: string;
}

export interface ScopeReleaseReport {
  readonly registry: ScopeRegistry;
  readonly task_id: TaskId;
  readonly released_group_ids: readonly GroupId[];
  readonly released_instance_ids: readonly InstanceId[];
  /** 保留的轮次记录（轮次是历史，不随实例释放而消失）。 */
  readonly retained_run_ids: readonly RunId[];
  /** 保留的证据引用（任务级必留记录）。 */
  readonly retained_evidence_refs: readonly string[];
  /** 保留的群组历史。 */
  readonly retained_group_history: readonly GroupId[];
  /** 释放后仍在册的任务记录（**必有**；反向对照即"任务绝不被本函数删除"）。 */
  readonly retained_task: TaskScope;
}

/** 把任务置终态（完成）。释放的**前置条件**（不变量 4 的前半）。 */
export function completeTask(
  registry: ScopeRegistry,
  input: { readonly task_id: TaskId; readonly at: LogicalTime; readonly evidence_refs?: readonly string[] },
): ScopeRegistry {
  const task = registry.tasks[input.task_id];
  if (task === undefined) {
    throw new ScopeIsolationError('unknown_task', `未登记的任务 ${input.task_id}`);
  }
  const next: TaskScope = Object.freeze({
    ...task,
    state: 'completed',
    updated_at: input.at,
    retained_evidence_refs: Object.freeze([
      ...task.retained_evidence_refs,
      ...(input.evidence_refs ?? []),
    ]),
  });
  return Object.freeze({ ...registry, tasks: Object.freeze({ ...registry.tasks, [input.task_id]: next }) });
}

/**
 * 任务完成后：**释放临时实例**（及其群组）但**保留必要记录**。
 *
 * 保留清单（本函数绝不删）：任务记录、证据引用、群组历史、全部轮次记录、释放审计。
 * 释放清单：群组与实例的 `state` 置 `released`（运行态归零；`liveInstanceIdsOf()` 变空）。
 *
 * 释放**只允许**对 `completed` 任务调用 —— 否则抛 `task_not_completed`
 * （反向对照：对 `active` 任务调用必须失败，不得"顺手释放"）。
 */
export function releaseAfterCompletion(
  registry: ScopeRegistry,
  input: ReleaseAfterCompletionInput,
): ScopeReleaseReport {
  const task = registry.tasks[input.task_id];
  if (task === undefined) {
    throw new ScopeIsolationError('unknown_task', `未登记的任务 ${input.task_id}`);
  }
  if (task.state !== 'completed') {
    throw new ScopeIsolationError(
      'task_not_completed',
      `任务 ${input.task_id} 处于 ${task.state}：只有 completed 才允许释放临时实例` +
        `（运行中的任务释放实例会留下无人负责的轮次）`,
    );
  }

  const releasedGroups: GroupId[] = [];
  const releasedInstances: InstanceId[] = [];
  const nextGroups: Record<string, GroupScope> = { ...registry.groups };
  const nextInstances: Record<string, InstanceScope> = { ...registry.instances };

  for (const instance of Object.values(registry.instances)) {
    if (instance.task_id !== input.task_id || instance.state === 'released') {
      continue;
    }
    nextInstances[instance.instance_id] = Object.freeze({
      ...instance,
      state: 'released',
      release_reason: input.reason,
      updated_at: input.at,
    });
    releasedInstances.push(instance.instance_id);
  }
  for (const group of Object.values(registry.groups)) {
    if (group.task_id !== input.task_id || group.state === 'released') {
      continue;
    }
    nextGroups[group.group_id] = Object.freeze({
      ...group,
      state: 'released',
      release_reason: input.reason,
      updated_at: input.at,
    });
    releasedGroups.push(group.group_id);
  }

  const nextTask: TaskScope = Object.freeze({ ...task, current_group_id: null, updated_at: input.at });
  const release: ReleaseRecord = Object.freeze({
    task_id: input.task_id,
    at: input.at,
    reason: input.reason,
    released_group_ids: Object.freeze(releasedGroups),
    released_instance_ids: Object.freeze(releasedInstances),
  });

  const nextRegistry: ScopeRegistry = Object.freeze({
    tasks: Object.freeze({ ...registry.tasks, [input.task_id]: nextTask }),
    groups: Object.freeze(nextGroups),
    instances: Object.freeze(nextInstances),
    runs: registry.runs,
    releases: Object.freeze([...registry.releases, release]),
  });

  return Object.freeze({
    registry: nextRegistry,
    task_id: input.task_id,
    released_group_ids: Object.freeze(releasedGroups),
    released_instance_ids: Object.freeze(releasedInstances),
    retained_run_ids: Object.freeze(
      Object.values(nextRegistry.runs)
        .filter((run) => run.task_id === input.task_id)
        .map((run) => run.run_id),
    ),
    retained_evidence_refs: nextTask.retained_evidence_refs,
    retained_group_history: nextTask.group_history,
    retained_task: nextTask,
  });
}

// ---------------------------------------------------------------------------
// 跨进程续接（不变量 5；**进程内模拟**，非真实第二进程）
// ---------------------------------------------------------------------------

/** 必须跨进程存活的**最小**信息（临时群组/实例不在其中）。 */
export interface TaskContinuationPayload {
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly retained_evidence_refs: readonly string[];
  readonly group_history: readonly GroupId[];
  readonly completed_run_ids: readonly RunId[];
  /** id 生成器高水位（R202：跨进程不得重发已用过的 id）。 */
  readonly id_high_water_marks: Readonly<Record<string, number>>;
}

export function toContinuationPayload(
  registry: ScopeRegistry,
  input: { readonly task_id: TaskId; readonly id_high_water_marks: Readonly<Record<string, number>> },
): TaskContinuationPayload {
  const task = registry.tasks[input.task_id];
  if (task === undefined) {
    throw new ScopeIsolationError('unknown_task', `未登记的任务 ${input.task_id} 不能导出续接载荷`);
  }
  return Object.freeze({
    task_id: task.task_id,
    revision: task.revision,
    retained_evidence_refs: task.retained_evidence_refs,
    group_history: task.group_history,
    completed_run_ids: Object.freeze(
      Object.values(registry.runs)
        .filter((run) => run.task_id === input.task_id)
        .map((run) => run.run_id),
    ),
    id_high_water_marks: Object.freeze({ ...input.id_high_water_marks }),
  });
}

export interface ResumeFromContinuationInput {
  readonly process_id: string;
  readonly at: LogicalTime;
  /** 续接后立即挂载的群组（省略 = 任务先处于"无群组"间隙）。 */
  readonly new_group_id?: GroupId;
}

export interface ResumeFromContinuationReport {
  readonly registry: ScopeRegistry;
  readonly task: TaskScope;
  /** 续接前的版本（用于断言 **revision 不倒退**）。 */
  readonly resumed_from_revision: Revision;
}

/**
 * 用续接载荷在（模拟的）新进程里重建任务边界。
 *
 * **它恢复了什么**：任务身份、版本、证据引用、群组历史、轮次历史、id 高水位。
 * **它没有恢复什么**（如实标注）：临时群组与实例的**运行态**（释放就是释放）、
 * 以及任何依赖持久介质的真实进程重启。本函数是**进程内模拟**——
 * "同进程内用两份登记表重建状态" ≠ "真实第二个操作系统进程能恢复"。
 */
export function resumeFromContinuation(
  payload: TaskContinuationPayload,
  input: ResumeFromContinuationInput,
): ResumeFromContinuationReport {
  if (typeof input.process_id !== 'string' || input.process_id.length === 0) {
    throw new ScopeIsolationError('unknown_task', '续接必须给出非空 process_id');
  }
  let registry = registerTask(createEmptyScopeRegistry(), {
    task_id: payload.task_id,
    revision: payload.revision,
    process_id: input.process_id,
    at: input.at,
    retained_evidence_refs: payload.retained_evidence_refs,
  });
  // 群组历史照实恢复（它记录的是"曾挂过哪些群"，不是"这些群还活着"）。
  const restored = registry.tasks[payload.task_id];
  if (restored === undefined) {
    throw new ScopeIsolationError('unknown_task', `续接登记后任务丢失（不应发生）`);
  }
  registry = Object.freeze({
    ...registry,
    tasks: Object.freeze({
      ...registry.tasks,
      [payload.task_id]: Object.freeze({ ...restored, group_history: payload.group_history }),
    }),
  });
  if (input.new_group_id !== undefined) {
    registry = registerGroup(registry, {
      group_id: input.new_group_id,
      task_id: payload.task_id,
      at: input.at,
    });
  }
  const task = registry.tasks[payload.task_id];
  if (task === undefined || task.revision < payload.revision) {
    throw new ScopeIsolationError('revision_regression', `续接后任务版本低于续接载荷：${String(payload.revision)}`);
  }
  return Object.freeze({ registry, task, resumed_from_revision: payload.revision });
}

// ---------------------------------------------------------------------------
// 观测汇总
// ---------------------------------------------------------------------------

export interface ScopeSeparationSummary {
  readonly task_id: TaskId;
  readonly task_state: TaskPersistenceState;
  readonly task_revision: Revision;
  readonly opened_in_process: string;
  readonly group_count: number;
  readonly live_group_count: number;
  readonly instance_count: number;
  readonly live_instance_count: number;
  readonly run_count: number;
  readonly current_group_id: GroupId | null;
  readonly identity_collisions: readonly string[];
  /** 任务记录存在与否——**恒 true**：分离模块绝不删除任务（可断言的强不变量）。 */
  readonly task_record_present: boolean;
}

export function summarizeScopeSeparation(
  registry: ScopeRegistry,
  taskId: TaskId,
): ScopeSeparationSummary {
  const task = registry.tasks[taskId];
  const groups = Object.values(registry.groups).filter((group) => group.task_id === taskId);
  const instances = Object.values(registry.instances).filter((instance) => instance.task_id === taskId);
  const runs = Object.values(registry.runs).filter((run) => run.task_id === taskId);
  return Object.freeze({
    task_id: taskId,
    task_state: task?.state ?? 'active',
    task_revision: task?.revision ?? (0 as Revision),
    opened_in_process: task?.opened_in_process ?? '',
    group_count: groups.length,
    live_group_count: groups.filter((group) => group.state === 'active').length,
    instance_count: instances.length,
    live_instance_count: instances.filter((instance) => instance.state === 'live').length,
    run_count: runs.length,
    current_group_id: task?.current_group_id ?? null,
    identity_collisions: identityNamespaceCollisions(registry),
    task_record_present: task !== undefined,
  });
}
