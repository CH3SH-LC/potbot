/**
 * F04 groups —— 群组/任务的读取、筛选、搜索、聚合（纯函数，零依赖）。
 *
 * 排序（最近活跃）是**纯比较**，不读时钟：
 *   1) `lastActiveAt` 降序（空串表示未提供，排最后）；
 *   2) 平手时 `seq` 降序（后创建者在前）；
 *   3) 再平手按 id 升序。
 * 三级 tie-break 保证同一输入在任何环境下得到**同一顺序**。
 *
 * 「最近活跃」对群组是 max(群组自身与所聚合任务的 lastUpdatedAt)；空串表示未提供。
 */

import { bucketOf, GroupError } from './types.js';
import type {
  ArtifactRef,
  DecisionRef,
  GroupListRow,
  GroupView,
  GroupsState,
  ListGroupsOptions,
  StageView,
  TaskBucket,
  TaskState,
  TaskView,
} from './types.js';
import { groupIdFor } from './ids.js';
import { requireIsoTimestamp, requireNonEmpty } from './util.js';

/** 创建空状态。 */
export function createGroupsState(): GroupsState {
  return { groups: [], tasks: [], groupIndexById: {}, taskIndexById: {}, counter: 0 };
}

export function getGroup(state: GroupsState, groupId: string): GroupView | null {
  const index = state.groupIndexById[groupId];
  if (index === undefined) return null;
  return state.groups[index] ?? null;
}

export function getTask(state: GroupsState, taskId: string): TaskView | null {
  const index = state.taskIndexById[taskId];
  if (index === undefined) return null;
  return state.tasks[index] ?? null;
}

/** 某群组聚合的任务（按 taskIndexById 顺序，即加入顺序）。 */
export function tasksOfGroup(state: GroupsState, groupId: string): readonly TaskView[] {
  return state.tasks.filter((task) => task.groupId === groupId);
}

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------

export interface CreateGroupOptions {
  readonly id?: string;
  readonly name: string;
  readonly conversationId: string;
  readonly createdAt: string;
  readonly summary?: string;
}

/** 新建群组（仅容器）。revision=1。id 已存在 ⇒ `unknown-group` 之外用 `invalid-value` 拒绝重复。 */
export function createGroup(state: GroupsState, options: CreateGroupOptions): GroupsState {
  const name = requireNonEmpty(options.name, 'group.name');
  const conversationId = requireNonEmpty(options.conversationId, 'group.conversationId');
  const createdAt = requireIsoTimestamp(options.createdAt, 'group.createdAt');
  const seq = state.counter + 1;
  const groupId = groupIdFor(name, seq, options.id);
  if (state.groupIndexById[groupId] !== undefined) {
    throw new GroupError('invalid-value', '群组 id 已存在', { groupId });
  }
  const group: GroupView = {
    groupId,
    name,
    conversationId,
    revision: 1,
    seq,
    createdAt,
    summary: options.summary ?? '',
  };
  const groups = [...state.groups, group];
  return {
    ...state,
    groups,
    groupIndexById: { ...state.groupIndexById, [groupId]: groups.length - 1 },
    counter: seq,
  };
}

export interface CreateTaskOptions {
  readonly taskId: string;
  readonly groupId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly goal: string;
  readonly state?: TaskState;
  readonly stages?: readonly StageView[];
  readonly activeStageIndex?: number;
  readonly waitReason?: string | null;
  readonly artifacts?: readonly ArtifactRef[];
  readonly pendingDecisions?: readonly DecisionRef[];
  readonly actionRefs?: readonly string[];
  readonly constraints?: readonly string[];
  readonly updatedAt: string;
}

/** 新建任务并加入其群组。任务初始 revision=1、无活动记录。 */
export function createTask(state: GroupsState, options: CreateTaskOptions): GroupsState {
  const taskId = requireNonEmpty(options.taskId, 'task.taskId');
  if (state.taskIndexById[taskId] !== undefined) {
    throw new GroupError('invalid-value', '任务 id 已存在', { taskId });
  }
  if (getGroup(state, options.groupId) === null) {
    throw new GroupError('unknown-group', '任务所属群组不存在', { groupId: options.groupId });
  }
  const updatedAt = requireIsoTimestamp(options.updatedAt, 'task.updatedAt');
  const task: TaskView = {
    taskId,
    groupId: options.groupId,
    conversationId: requireNonEmpty(options.conversationId, 'task.conversationId'),
    title: requireNonEmpty(options.title, 'task.title'),
    goal: requireNonEmpty(options.goal, 'task.goal'),
    state: options.state ?? 'queued',
    revision: 1,
    stages: options.stages ?? [],
    activeStageIndex: options.activeStageIndex ?? -1,
    waitReason: options.waitReason ?? null,
    resumeFrom: null,
    artifacts: options.artifacts ?? [],
    pendingDecisions: options.pendingDecisions ?? [],
    actionRefs: options.actionRefs ?? [],
    constraints: options.constraints ?? [],
    lastEventSeq: 0,
    lastUpdatedAt: updatedAt,
    cancel: null,
    activity: [],
  };
  const tasks = [...state.tasks, task];
  return {
    ...state,
    tasks,
    taskIndexById: { ...state.taskIndexById, [taskId]: tasks.length - 1 },
  };
}

// ---------------------------------------------------------------------------
// 聚合与筛选（T01）
// ---------------------------------------------------------------------------

/** 群组内任务的聚合桶：needs-action 优先，其次 in-progress，最后 ended。 */
function aggregateBucket(tasks: readonly TaskView[]): TaskBucket {
  let hasInProgress = false;
  for (const task of tasks) {
    const bucket = bucketOf(task.state);
    if (bucket === 'needs-action') return 'needs-action';
    if (bucket === 'in-progress') hasInProgress = true;
  }
  return hasInProgress ? 'in-progress' : 'ended';
}

/** 群组最近活跃时间 = max(自身 createdAt 与任务 lastUpdatedAt)；空串表示未提供。 */
function latestActivity(group: GroupView, tasks: readonly TaskView[]): string {
  let latest = '';
  for (const task of tasks) if (task.lastUpdatedAt > latest) latest = task.lastUpdatedAt;
  return latest === '' ? '' : latest;
}

/** 需要用户处理时给出简短而具体的等待原因；否则给出下一步。 */
function nextStepFor(tasks: readonly TaskView[]): { nextStep: string; waitReason: string | null } {
  for (const task of tasks) {
    if (task.state === 'awaiting-input' || task.state === 'awaiting-authorization' || task.state === 'paused') {
      return {
        waitReason: task.waitReason ?? '需要你处理',
        nextStep: `处理：${task.title}`,
      };
    }
  }
  for (const task of tasks) {
    if (bucketOf(task.state) === 'in-progress') return { waitReason: null, nextStep: `进行中：${task.title}` };
  }
  return { waitReason: null, nextStep: '已结束' };
}

function matchesQuery(group: GroupView, tasks: readonly TaskView[], query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  if (group.name.toLowerCase().includes(needle)) return true;
  return tasks.some(
    (task) =>
      task.title.toLowerCase().includes(needle) || task.goal.toLowerCase().includes(needle),
  );
}

function compareRows(a: GroupListRow, b: GroupListRow, seqOf: (id: string) => number): number {
  if (a.lastActiveAt !== b.lastActiveAt) {
    if (a.lastActiveAt === '') return 1;
    if (b.lastActiveAt === '') return -1;
    return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
  }
  const sa = seqOf(a.groupId);
  const sb = seqOf(b.groupId);
  if (sa !== sb) return sb - sa;
  if (a.groupId === b.groupId) return 0;
  return a.groupId < b.groupId ? -1 : 1;
}

/** 列群组（聚合 + 过滤桶 + 搜索 + 排序）。 */
export function listGroups(state: GroupsState, options: ListGroupsOptions = {}): readonly GroupListRow[] {
  const query = (options.query ?? '').trim();
  const rows: GroupListRow[] = [];
  for (const group of state.groups) {
    const tasks = tasksOfGroup(state, group.groupId);
    if (!matchesQuery(group, tasks, query)) continue;
    const bucket = aggregateBucket(tasks);
    if (options.bucket !== undefined && options.bucket !== bucket) continue;
    const needsActionCount = tasks.filter((task) => bucketOf(task.state) === 'needs-action').length;
    const { nextStep, waitReason } = nextStepFor(tasks);
    rows.push({
      groupId: group.groupId,
      name: group.name,
      conversationId: group.conversationId,
      bucket,
      taskCount: tasks.length,
      needsActionCount,
      lastActiveAt: latestActivity(group, tasks),
      taskIds: tasks.map((task) => task.taskId),
      nextStep,
      waitReason,
    });
  }
  const seqOf = (id: string): number => getGroup(state, id)?.seq ?? 0;
  return [...rows].sort((a, b) => compareRows(a, b, seqOf));
}

/** 搜索群组：等价于 `listGroups` 带 query。 */
export function searchGroups(
  state: GroupsState,
  query: string,
  options: Omit<ListGroupsOptions, 'query'> = {},
): readonly GroupListRow[] {
  return listGroups(state, { ...options, query });
}

// ---------------------------------------------------------------------------
// 计数（列表头「待处理 / 进行中 / 已结束」计数）
// ---------------------------------------------------------------------------

export interface BucketCounts {
  readonly 'needs-action': number;
  readonly 'in-progress': number;
  readonly ended: number;
  readonly total: number;
}

/** 按桶统计群组数（用聚合后的桶，与 `listGroups` 一致，不是逐任务计数）。 */
export function countGroupsByBucket(state: GroupsState): BucketCounts {
  const counts = { 'needs-action': 0, 'in-progress': 0, ended: 0, total: 0 };
  for (const group of state.groups) {
    const tasks = tasksOfGroup(state, group.groupId);
    counts[aggregateBucket(tasks)] += 1;
    counts.total += 1;
  }
  return counts;
}
