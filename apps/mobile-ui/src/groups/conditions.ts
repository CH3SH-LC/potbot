/**
 * F04 groups —— 改条件预览（T03：当前条件、修改范围、受影响产物与待失效动作）。
 *
 * `planChangeConditions` 是**只读**预览：不改变任何状态。它校验 revision（过期/未知即拒），
 * 计算修改后的约束集合，并核对 `affected` 里列出的产物/动作/确认卡确实存在于该任务——
 * 列一个不存在的 id 会被 `unknown-affected-id` 拒绝，避免「影响面」凭空编造。
 *
 * 真正的失效发生在内核回 `condition` 事件、经 `applyTaskEvent` 之时（I6）。
 */

import { GroupError } from './types.js';
import type { ConditionChange, GroupsState, TaskView } from './types.js';
import { getTask } from './state.js';

export interface ChangeConditionsPlanInput {
  readonly taskId: string;
  /** 命令基于的任务 revision；必须精确等于当前值。 */
  readonly expectedRevision: number;
  readonly changes: readonly ConditionChange[];
  readonly affected?: {
    readonly artifactIds: readonly string[];
    readonly actionIds: readonly string[];
    readonly decisionIds: readonly string[];
  };
}

export interface ChangeConditionsPlan {
  readonly taskId: string;
  readonly currentRevision: number;
  readonly nextRevision: number;
  readonly changes: readonly ConditionChange[];
  readonly currentConstraints: readonly string[];
  readonly nextConstraints: readonly string[];
  readonly affectedArtifactIds: readonly string[];
  readonly affectedActionIds: readonly string[];
  readonly invalidatedDecisionIds: readonly string[];
  /** 受影响产物标签（展示用；不删除、不销毁）。 */
  readonly affectedArtifactLabels: readonly string[];
}

const EMPTY_AFFECTED = { artifactIds: [], actionIds: [], decisionIds: [] } as const;

/** 精确定位任务并校验 revision（与 `applyTaskEvent` 同一套 stale/unknown 语义）。 */
function requireTaskAtRevision(state: GroupsState, taskId: string, expectedRevision: unknown): TaskView {
  const task = getTask(state, taskId);
  if (task === null) {
    throw new GroupError('unknown-task', '任务不存在', { taskId });
  }
  if (expectedRevision === undefined) {
    throw new GroupError('missing-revision', '改条件必须携带 expectedRevision', { taskId });
  }
  if (!Number.isInteger(expectedRevision)) {
    throw new GroupError('unknown-revision', 'expectedRevision 必须是整数', { taskId });
  }
  const expected = expectedRevision as number;
  if (expected > task.revision) {
    throw new GroupError('unknown-revision', '本地不存在这个较新的 revision', { taskId, expected, current: task.revision });
  }
  if (expected < task.revision) {
    throw new GroupError('stale-revision', '改条件基于过期 revision，拒绝覆盖较新状态', { taskId, expected, current: task.revision });
  }
  return task;
}

function nextConstraintsOf(constraints: readonly string[], changes: readonly ConditionChange[]): string[] {
  let result = [...constraints];
  for (const change of changes) {
    const token = `${change.field}=${change.value}`;
    if (change.remove === true) {
      result = result.filter((c) => c !== token);
    } else {
      const prefix = `${change.field}=`;
      result = [...result.filter((c) => !c.startsWith(prefix)), token];
    }
  }
  return result;
}

/** 计算改条件的预览方案（只读）。 */
export function planChangeConditions(
  state: GroupsState,
  input: ChangeConditionsPlanInput,
): ChangeConditionsPlan {
  const task = requireTaskAtRevision(state, input.taskId, input.expectedRevision);
  if (input.changes.length === 0) {
    throw new GroupError('invalid-value', '改条件必须至少给出一条 change', { taskId: task.taskId });
  }
  const affected = input.affected ?? EMPTY_AFFECTED;

  const artifactIds = new Set(task.artifacts.map((a) => a.refId));
  for (const id of affected.artifactIds) {
    if (!artifactIds.has(id)) {
      throw new GroupError('unknown-affected-id', 'affected.artifactIds 含不存在的产物', { taskId: task.taskId, id });
    }
  }
  const actionIds = new Set(task.actionRefs);
  for (const id of affected.actionIds) {
    if (!actionIds.has(id)) {
      throw new GroupError('unknown-affected-id', 'affected.actionIds 含不存在的外部动作', { taskId: task.taskId, id });
    }
  }
  const decisionIds = new Set(task.pendingDecisions.map((d) => d.actionId));
  for (const id of affected.decisionIds) {
    if (!decisionIds.has(id)) {
      throw new GroupError('unknown-affected-id', 'affected.decisionIds 含不存在的确认卡', { taskId: task.taskId, id });
    }
  }

  return {
    taskId: task.taskId,
    currentRevision: task.revision,
    nextRevision: task.revision + 1,
    changes: input.changes,
    currentConstraints: task.constraints,
    nextConstraints: nextConstraintsOf(task.constraints, input.changes),
    affectedArtifactIds: [...affected.artifactIds],
    affectedActionIds: [...affected.actionIds],
    invalidatedDecisionIds: [...affected.decisionIds],
    affectedArtifactLabels: task.artifacts
      .filter((a) => affected.artifactIds.includes(a.refId))
      .map((a) => a.label),
  };
}
