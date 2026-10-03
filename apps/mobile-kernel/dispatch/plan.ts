/**
 * K05 手机内核 · 主智能体派发 —— **能力发现 → 拆分校验 → 临时群组 → 依赖调度**（纯函数）。
 *
 * 输入一个目标 + 主智能体产出的拆分 + 能力发现端口，输出一份**不可变的 `DispatchPlan`**：
 * 哪些子任务可调度（进波次）、哪些被阻塞（如实登记原因）、临时群组有哪些成员。
 *
 * ## 四件事，各自的可断言形态
 *
 * 1. **能力发现**：只信 `CapabilityDiscoveryPort` 的读回结果。发现不到 ⇒ `missing_capability`；
 *    模板未授权 ⇒ `capability_not_authorized`（**"不能调未授权模板"**）；端口未就绪 ⇒
 *    `capability_not_executable`。三者**都进 `blocked`，都不进波次**。
 * 2. **拆分校验**：重复 id / 未知依赖 / 依赖成环 / 空目标 / **固定规划或审核角色**一律抛
 *    `DispatchError`（结构性缺陷要大声失败，不静默裁掉某条子任务）。
 * 3. **临时群组**：为每条**可调度**子任务建一名 `worker` 席位；被阻塞的子任务**不占席位**
 *    （不假装它会被执行）。
 * 4. **依赖调度**：拓扑分层成波次（wave）；同波内 ≤ `max_parallel`，任一波的依赖都在更早的波。
 *    确定性：同输入恒同波次与同摘要（无墙钟 / 无随机）。
 *
 * 纯函数、零 IO。**不调用真实模型、不执行子任务**。
 */

import {
  DispatchError,
  requireConcurrency,
  requireNonEmptyString,
  type SubtaskBlockReason,
} from './errors.js';
import { structuralDigest } from './digest.js';
import {
  EXECUTOR_ROLE,
  isForbiddenFixedRole,
  type BlockedSubtaskPlan,
  type CapabilityDiscoveryPort,
  type Clock,
  type DispatchPlan,
  type DispatchSchedule,
  type GroupId,
  type GroupMember,
  type InstanceId,
  type ScheduleWave,
  type SubtaskPlan,
  type SubtaskSpec,
  type TaskId,
  type TaskSplit,
} from './types.js';

// ---------------------------------------------------------------------------
// 拆分校验
// ---------------------------------------------------------------------------

/** 拆分字段的非空字符串校验：失败抛 `invalid_split`（不是 `invalid_command`——这是结构校验层）。 */
function splitString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DispatchError('invalid_split', `${field} 必须是非空字符串`, field);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new DispatchError('invalid_split', `${field} 必须是字符串数组`, field);
  }
  return value.map((item, index) => splitString(item, `${field}[${String(index)}]`));
}

/**
 * 校验并**规范化**一份拆分：补默认角色、去重判重、核对依赖、检环。
 *
 * @throws {DispatchError} 任一结构性问题（重复 id / 未知依赖 / 成环 / 固定角色 / 空目标）。
 */
export function validateSplit(split: TaskSplit): readonly SubtaskSpec[] {
  if (split === null || typeof split !== 'object') {
    throw new DispatchError('invalid_split', '拆分必须是对象', 'split');
  }
  splitString(split.goal, 'split.goal');
  if (!Array.isArray(split.subtasks) || split.subtasks.length === 0) {
    throw new DispatchError('invalid_split', '拆分必须至少含一条子任务（空拆分不成任务）', 'split.subtasks');
  }

  const normalized: SubtaskSpec[] = [];
  const seen = new Set<string>();
  split.subtasks.forEach((raw, index) => {
    const path = `split.subtasks[${String(index)}]`;
    if (raw === null || typeof raw !== 'object') {
      throw new DispatchError('invalid_split', `${path} 必须是对象`, path);
    }
    const id = splitString(raw.id, `${path}.id`);
    if (seen.has(id)) {
      throw new DispatchError('duplicate_subtask_id', `子任务 id 重复：${id}`, `${path}.id`);
    }
    seen.add(id);

    const subtaskGoal = splitString(raw.goal, `${path}.goal`);
    const capabilityId = splitString(raw.capability_id, `${path}.capability_id`);
    const dependsOn = requireStringArray(raw.depends_on ?? [], `${path}.depends_on`);

    const role = raw.role ?? EXECUTOR_ROLE;
    if (role !== EXECUTOR_ROLE) {
      if (isForbiddenFixedRole(role)) {
        throw new DispatchError(
          'fixed_role_forbidden',
          `子任务 ${id} 声明了固定角色 ${role}：K05 无固定规划/审核角色，` +
            '拆分由主智能体自己完成，群里只应有执行席位',
          `${path}.role`,
        );
      }
      throw new DispatchError(
        'invalid_split',
        `子任务 ${id} 的角色 ${role} 非法（唯一合法值为 '${EXECUTOR_ROLE}'）`,
        `${path}.role`,
      );
    }

    normalized.push(
      Object.freeze({
        id,
        goal: subtaskGoal,
        capability_id: capabilityId,
        depends_on: Object.freeze([...dependsOn]),
        role: EXECUTOR_ROLE,
      }),
    );
  });

  // 依赖必须指向拆分里存在的 id。
  for (const spec of normalized) {
    for (const dependency of spec.depends_on) {
      if (!seen.has(dependency)) {
        throw new DispatchError(
          'unknown_dependency',
          `子任务 ${spec.id} 依赖不存在的子任务 ${dependency}`,
          `split.subtasks.${spec.id}.depends_on`,
        );
      }
    }
  }

  // 检环（DFS 三色）。
  detectCycle(normalized);
  return Object.freeze(normalized);
}

/** 依赖成环检测。有环 ⇒ `dependency_cycle`。 */
function detectCycle(specs: readonly SubtaskSpec[]): void {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const spec of specs) {
    color.set(spec.id, WHITE);
  }
  const stack: string[] = [];

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    const spec = byId.get(id);
    for (const dependency of spec?.depends_on ?? []) {
      const state = color.get(dependency);
      if (state === GRAY) {
        const cycleStart = stack.indexOf(dependency);
        const cycle = [...stack.slice(cycleStart), dependency].join(' → ');
        throw new DispatchError('dependency_cycle', `依赖成环：${cycle}`, `split.subtasks.${id}.depends_on`);
      }
      if (state === WHITE) {
        visit(dependency);
      }
    }
    color.set(id, BLACK);
    stack.pop();
  };

  for (const spec of specs) {
    if (color.get(spec.id) === WHITE) {
      visit(spec.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 能力发现投影
// ---------------------------------------------------------------------------

type CapabilityVerdict =
  | { readonly ok: true; readonly template_id: string }
  | { readonly ok: false; readonly reason: SubtaskBlockReason; readonly detail: string };

function classifyCapability(
  capabilityId: string,
  discovery: CapabilityDiscoveryPort,
): CapabilityVerdict {
  const found = discovery.discover().find((capability) => capability.capability_id === capabilityId);
  if (found === undefined) {
    return {
      ok: false,
      reason: 'missing_capability',
      detail: `能力 ${capabilityId} 未被发现到（目录里没有承载实现）`,
    };
  }
  if (!found.authorized) {
    return {
      ok: false,
      reason: 'capability_not_authorized',
      detail: `能力 ${capabilityId} 的模板 ${found.template_id} 未授权：不得调用未授权模板`,
    };
  }
  if (!found.executable) {
    return {
      ok: false,
      reason: 'capability_not_executable',
      detail: `能力 ${capabilityId}（模板 ${found.template_id}）端口未就绪或仍是 stub${found.note === undefined ? '' : `（${found.note}）`}`,
    };
  }
  return { ok: true, template_id: found.template_id };
}

// ---------------------------------------------------------------------------
// 依赖调度（拓扑分波 + 并发上限）
// ---------------------------------------------------------------------------

/**
 * 把可调度子任务排成波次：每波只放依赖已在**更早**波里的子任务，且每波 ≤ `max_parallel`。
 * 确定性：每波内部按 id 升序取。
 */
function scheduleWaves(scheduled: readonly SubtaskPlan[], maxParallel: number): readonly ScheduleWave[] {
  const byId = new Map(scheduled.map((spec) => [spec.id, spec]));
  const remaining = new Set(scheduled.map((spec) => spec.id));
  const placed = new Set<string>();
  const waves: ScheduleWave[] = [];
  let waveNumber = 1;

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      const spec = byId.get(id);
      const depsSatisfied = (spec?.depends_on ?? []).every(
        (dependency) => !remaining.has(dependency) || placed.has(dependency),
      );
      if (depsSatisfied) {
        ready.push(id);
      }
    }
    ready.sort();
    const take = ready.slice(0, maxParallel);
    /* istanbul ignore next -- 环已在 validateSplit 拦掉；此处为内部一致性兜底。 */
    if (take.length === 0) {
      throw new DispatchError(
        'dependency_cycle',
        `调度推进不了且剩余 ${String(remaining.size)} 条：依赖关系内部不一致`,
        'schedule',
      );
    }
    for (const id of take) {
      remaining.delete(id);
      placed.add(id);
    }
    waves.push(Object.freeze({ wave: waveNumber, subtask_ids: Object.freeze(take) }));
    waveNumber += 1;
  }
  return Object.freeze(waves);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface PlanDispatchInput {
  readonly task_id: TaskId;
  readonly split: TaskSplit;
  readonly discovery: CapabilityDiscoveryPort;
  readonly max_parallel: number;
  readonly clock: Clock;
  /** 临时群组 id（由宿主经 id 源提供，保证确定性）。 */
  readonly group_id: GroupId;
  /** 子任务 → 实例 id 的确定性映射。 */
  readonly instance_id_for: (subtask_id: string) => InstanceId;
}

/** 全局同步时钟的默认实例 id 源（宿主可换成持久 id 源；测试用确定性源）。 */
export function identityInstanceId(subtaskId: string): InstanceId {
  return `inst-${subtaskId}`;
}

/**
 * 产出一份派发计划。纯函数：同输入恒同波次、同群组、同摘要。
 *
 * @throws {DispatchError} 拆分结构性问题 / 并发上限非法。
 */
export function planDispatch(input: PlanDispatchInput): DispatchPlan {
  const taskId = requireNonEmptyString(input.task_id, 'task_id');
  const maxParallel = requireConcurrency(input.max_parallel);
  const specs = validateSplit(input.split);

  // 1) 逐条按能力发现结果初判。
  const scheduledSpecs: SubtaskPlan[] = [];
  const blockedDraft: BlockedSubtaskPlan[] = [];
  const specById = new Map(specs.map((spec) => [spec.id, spec]));

  for (const spec of specs) {
    const verdict = classifyCapability(spec.capability_id, input.discovery);
    if (verdict.ok) {
      scheduledSpecs.push(
        Object.freeze({
          id: spec.id,
          goal: spec.goal,
          capability_id: spec.capability_id,
          template_id: verdict.template_id,
          depends_on: spec.depends_on,
          role: EXECUTOR_ROLE,
        }),
      );
    } else {
      blockedDraft.push(
        Object.freeze({
          id: spec.id,
          goal: spec.goal,
          capability_id: spec.capability_id,
          template_id: null,
          depends_on: spec.depends_on,
          block_reason: verdict.reason,
          block_detail: verdict.detail,
          blocked_by: Object.freeze([spec.capability_id]),
        }),
      );
    }
  }

  // 2) 依赖传播：上游被阻塞 ⇒ 下游也阻塞（直到不动点）。
  const blockedIds = new Set(blockedDraft.map((entry) => entry.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const spec of scheduledSpecs) {
      if (blockedIds.has(spec.id)) {
        continue;
      }
      const blocker = spec.depends_on.find((dependency) => blockedIds.has(dependency));
      if (blocker !== undefined) {
        blockedIds.add(spec.id);
        const source = blockedDraft.find((entry) => entry.id === blocker);
        blockedDraft.push(
          Object.freeze({
            id: spec.id,
            goal: spec.goal,
            capability_id: spec.capability_id,
            template_id: spec.template_id,
            depends_on: spec.depends_on,
            block_reason: 'dependency_blocked' as const,
            block_detail:
              `上游子任务 ${blocker} 被阻塞（${source?.block_reason ?? '未知'}）：` +
              '其下游随之阻塞，不进调度',
            blocked_by: Object.freeze([blocker]),
          }),
        );
        changed = true;
      }
    }
  }

  const finalScheduled = scheduledSpecs
    .filter((spec) => !blockedIds.has(spec.id))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const finalBlocked = blockedDraft.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  // 3) 调度成波。
  const waves = scheduleWaves(finalScheduled, maxParallel);
  const digest = structuralDigest(
    JSON.stringify({
      task_id: taskId,
      goal: input.split.goal,
      max_parallel: maxParallel,
      waves: waves.map((wave) => [wave.wave, wave.subtask_ids]),
      blocked: finalBlocked.map((entry) => [entry.id, entry.block_reason, entry.blocked_by]),
    }),
  );
  const schedule: DispatchSchedule = Object.freeze({
    max_parallel: maxParallel,
    waves,
    scheduled_ids: Object.freeze(finalScheduled.map((spec) => spec.id)),
    blocked_ids: Object.freeze(finalBlocked.map((spec) => spec.id)),
    digest,
  });

  // 4) 临时群组：只为**可调度**子任务建席位。
  const members: GroupMember[] = finalScheduled.map((spec) =>
    Object.freeze({
      instance_id: input.instance_id_for(spec.id),
      subtask_id: spec.id,
      capability_id: spec.capability_id,
      role: EXECUTOR_ROLE,
    }),
  );
  const createdAt = input.clock.now();
  const planDigest = structuralDigest(
    JSON.stringify({
      task_id: taskId,
      group_id: input.group_id,
      created_at: createdAt,
      schedule: digest,
      members: members.map((member) => member.instance_id),
      blocked: finalBlocked.map((entry) => entry.id),
    }),
  );

  // specById 保留引用以防未来扩展（当前未用）；显式 void 避免"未使用"误读。
  void specById;

  return Object.freeze({
    task_id: taskId,
    goal: input.split.goal,
    group: Object.freeze({
      group_id: input.group_id,
      task_id: taskId,
      created_at: createdAt,
      members: Object.freeze(members),
      released: false,
      released_at: null,
    }),
    schedule,
    subtasks: Object.freeze(finalScheduled),
    blocked: Object.freeze(finalBlocked),
    digest: planDigest,
  });
}
