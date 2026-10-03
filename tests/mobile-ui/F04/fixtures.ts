/**
 * F04 测试夹具：一个已知的群组/任务状态（显式 id、显式时间，保证可复现）。
 *
 * 时间戳固定为字面量，不读时钟——同一夹具在任何机器上得到同一顺序与同一活动序列。
 * 事件由 `makeEvent` 构造：契约 `Event` 字段 + 任务语义 `metadata`。
 */

import {
  createGroup,
  createGroupsState,
  createTask,
  getTask,
  type GroupsState,
  type TaskEvent,
  type TaskEventMeta,
  type TaskView,
} from '../../../apps/mobile-ui/src/groups/index.js';

export const IDS = {
  weeklyGroup: 'grp-weekly',
  tripGroup: 'grp-trip',
  weeklyTask: 'task-weekly-1',
  tripTask: 'task-trip-1',
  convWeekly: 'conv-weekly',
  convTrip: 'conv-trip',
} as const;

export const DIGEST = `sha256:${'c'.repeat(64)}` as `sha256:${string}`;

/**
 * 两个群组、两个任务：
 *   weekly：processing，3 阶段（draft 进行中），有待确认动作 act-send + 外部动作 act-send，
 *           产物 art-draft；约束 budget / deadline。
 *   trip：awaiting-authorization（进入「待处理」桶），等待原因「等待你的授权」，
 *           待确认动作 act-book + 外部动作 act-book。
 */
export function seed(): GroupsState {
  let state = createGroupsState();
  state = createGroup(state, {
    id: IDS.weeklyGroup,
    name: '周报整理',
    conversationId: IDS.convWeekly,
    createdAt: '2026-10-03T08:00:00Z',
    summary: '把周报改成一页',
  });
  state = createGroup(state, {
    id: IDS.tripGroup,
    name: '差旅安排',
    conversationId: IDS.convTrip,
    createdAt: '2026-10-03T09:00:00Z',
    summary: '预订行程',
  });

  state = createTask(state, {
    taskId: IDS.weeklyTask,
    groupId: IDS.weeklyGroup,
    conversationId: IDS.convWeekly,
    title: '把周报改成一页',
    goal: '输出一页纸周报并发送',
    state: 'processing',
    stages: [
      { stageId: 'draft', label: '起草', status: 'active' },
      { stageId: 'review', label: '复核', status: 'pending' },
      { stageId: 'export', label: '导出', status: 'pending' },
    ],
    activeStageIndex: 0,
    artifacts: [{ refId: 'art-draft', label: '周报草稿', digest: DIGEST }],
    pendingDecisions: [{ actionId: 'act-send', label: '发送周报', taskRevision: 1 }],
    actionRefs: ['act-send'],
    constraints: ['budget=已批准', 'deadline=2026-10-05'],
    updatedAt: '2026-10-03T09:30:00Z',
  });

  state = createTask(state, {
    taskId: IDS.tripTask,
    groupId: IDS.tripGroup,
    conversationId: IDS.convTrip,
    title: '预订高铁票',
    goal: '预订周五上海到北京的高铁票',
    state: 'awaiting-authorization',
    waitReason: '等待你的授权',
    stages: [
      { stageId: 'search', label: '选票', status: 'done' },
      { stageId: 'book', label: '下单', status: 'active' },
    ],
    activeStageIndex: 1,
    pendingDecisions: [{ actionId: 'act-book', label: '预订车票', taskRevision: 1 }],
    actionRefs: ['act-book'],
    updatedAt: '2026-10-03T10:00:00Z',
  });

  return state;
}

export function taskOf(state: GroupsState, taskId: string): TaskView {
  const task = getTask(state, taskId);
  if (task === null) throw new Error(`夹具读取失败：${taskId} 缺失`);
  return task;
}

export interface EventOverrides {
  readonly revision?: number;
  readonly seq?: number;
  readonly status?: TaskEvent['status'];
  readonly resultRef?: string;
  readonly verificationMode?: TaskEvent['verificationMode'];
}

/** 构造契约形状的事件：`metadata` 承载任务语义，其余字段可覆盖。 */
export function makeEvent(meta: TaskEventMeta, overrides: EventOverrides = {}): TaskEvent {
  const base: TaskEvent = {
    eventId: `evt-${meta.taskId}-${String(meta.kind)}-${meta.at}`,
    seq: overrides.seq ?? 1,
    commandId: 'cmd-fixture',
    revision: overrides.revision ?? 2,
    status: overrides.status ?? 'running',
    metadata: meta,
  };
  let event: TaskEvent = base;
  if (overrides.verificationMode !== undefined) {
    event = { ...event, verificationMode: overrides.verificationMode };
  }
  if (overrides.resultRef !== undefined) {
    event = { ...event, resultRef: overrides.resultRef };
  }
  return event;
}
