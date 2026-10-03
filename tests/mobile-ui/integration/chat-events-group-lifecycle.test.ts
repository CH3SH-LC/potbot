/**
 * 跨模块集成（F02 chat / F03 conversations ↔ F04 groups）：
 *   A. F02 的内核 Event 驱动 F04 的任务态（同一 v1 `Event` 对象喂两条流水）；
 *   B. F03 的 `TaskBinding.status`（粗粒度 `EventStatus`）与 F04 的 `TaskView.state`
 *      （细粒度 `TaskState`）在**归档 / 删除**下保持口径一致。
 *
 * 背景：这两条是 wave-1 的 F04 integrationRequests 里点名的接缝——
 *   「deliver task lifecycle events into groups.applyTaskEvent」与
 *   「keep TaskBinding.status (EventStatus) and groups TaskView.state consistent on delete/archive」。
 *
 * A 部分的关键点：F02 的 `applyKernelEvent` 与 F04 的 `applyTaskEvent` **消费同一条 v1 Event**，
 * 因此「内核事件」是二者唯一的事实来源；本文件证明它们对同一条事件得出**互相一致**的结论，
 * 并在「自称 succeeded 却缺 resultRef」的坏事件上**同时 fail-closed**（纵深防御）。
 *
 * B 部分是**粗/细粒度状态词表的对账**：F03 只存 `EventStatus`，F04 存完整 `TaskState`。
 * 二者没有现成的映射函数（这是集成缺口，见文件末尾与 residuals），本文件把映射**显式写成
 * 集成契约**并断言：(1) 对 F04 的每个 TaskState 都有对应的 F03 状态；(2) 归档不改任务态、
 * 绑定状态与 F04 状态保持一致；(3) 删除会话不静默改 F04 任务态，且删除前 `runningTaskIds`
 * 由绑定状态（= 映射后的 F04 状态）如实给出。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/integration/chat-events-group-lifecycle.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  applyKernelEvent,
  idleTask,
  isTaskSucceeded,
  type Event,
  type EventStatus,
} from '../../../apps/mobile-ui/src/chat/index.js';
import {
  applyTaskEvent,
  createGroup,
  createGroupsState,
  createGroupsStream,
  createTask,
  getTask,
  isTerminalTaskState,
  GroupError,
  TASK_STATES,
  type GroupsState,
  type TaskEvent,
  type TaskEventMeta,
  type TaskState,
  type TaskView,
} from '../../../apps/mobile-ui/src/groups/index.js';
import { reconcileTaskEvents } from '../../../apps/mobile-ui/src/groups/index.js';
import {
  archiveConversation,
  bindTask,
  createConversation,
  createConversationsState,
  ConversationError,
  deleteConversation,
  getConversation,
  listConversations,
  planDelete,
  taskOwnership,
  type ConversationsState,
  type DeleteScope,
} from '../../../apps/mobile-ui/src/conversations/index.js';

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const GROUP = 'grp-weekly';
const CONV = 'conv-weekly';
const TASK = 'task-weekly-1';
const CMD = 'cmd-weekly-1';
const AT1 = '2026-10-03T10:00:00Z';
const AT2 = '2026-10-03T10:05:00Z';

function seedOneTask(state: TaskState = 'queued'): GroupsState {
  let groups = createGroupsState();
  groups = createGroup(groups, {
    id: GROUP,
    name: '周报整理',
    conversationId: CONV,
    createdAt: '2026-10-03T08:00:00Z',
    summary: '把周报改成一页',
  });
  groups = createTask(groups, {
    taskId: TASK,
    groupId: GROUP,
    conversationId: CONV,
    title: '把周报改成一页',
    goal: '输出一页纸周报并发送',
    state,
    stages: [
      { stageId: 'draft', label: '起草', status: state === 'queued' ? 'pending' : 'active' },
      { stageId: 'export', label: '导出', status: 'pending' },
    ],
    activeStageIndex: state === 'queued' ? -1 : 0,
    updatedAt: AT1,
  });
  return groups;
}

function taskOf(groups: GroupsState, taskId: string = TASK): TaskView {
  const task = getTask(groups, taskId);
  if (task === null) throw new Error(`夹具读取失败：${taskId} 缺失`);
  return task;
}

/** 契约形状的内核事件：metadata 承载任务语义（F04），其余字段（F02）共用同一对象。 */
function event(meta: TaskEventMeta, overrides: Partial<TaskEvent> = {}): TaskEvent {
  const base: TaskEvent = {
    eventId: `evt-${String(meta.kind)}-${String(meta.to ?? '')}-${meta.at}`,
    seq: 1,
    commandId: CMD,
    revision: 2,
    status: 'running',
    metadata: meta,
  };
  return { ...base, ...overrides };
}

const EV_RUNNING: TaskEvent = event(
  { taskId: TASK, kind: 'state', to: 'processing', at: AT1 },
  { eventId: 'evt-running', seq: 1, revision: 2 },
);

const EV_DONE: TaskEvent = event(
  { taskId: TASK, kind: 'state', to: 'completed', at: AT2 },
  { eventId: 'evt-done', seq: 2, revision: 3, status: 'succeeded', resultRef: 'ref:weekly-1', verificationMode: 'real' },
);

/** 自称 succeeded 却缺 resultRef 的坏事件（对两条流水都必须 fail-closed）。 */
const EV_FAKE_DONE: TaskEvent = event(
  { taskId: TASK, kind: 'state', to: 'completed', at: AT1 },
  { eventId: 'evt-fake-done', seq: 1, revision: 2, status: 'succeeded' },
);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GroupError) return error.code;
    throw error;
  }
  throw new Error('预期抛 GroupError，但没有抛');
}

// ===========================================================================
// A. F02 内核 Event → F04 任务态
// ===========================================================================

describe('集成 F02→F04 · 同一条内核 Event 驱动两条流水', () => {
  it('running 事件：F04 态 queued→processing，F02 任务 idle→running（同一对象）', () => {
    const groups = applyTaskEvent(seedOneTask('queued'), EV_RUNNING);
    expect(taskOf(groups).state).toBe('processing');

    const kernel = applyKernelEvent(idleTask(), EV_RUNNING);
    expect(kernel.status).toBe('running');
    expect(kernel.commandId).toBe(CMD);
    expect(kernel.lastSeq).toBe(1);
  });

  it('成功事件：F04 进入 completed ⇔ F02 判 succeeded 且有 resultRef', () => {
    const groups = applyTaskEvent(applyTaskEvent(seedOneTask('queued'), EV_RUNNING), EV_DONE);
    const task = taskOf(groups);
    expect(task.state).toBe('completed');
    expect(isTerminalTaskState(task.state)).toBe(true);

    const kernel = applyKernelEvent(applyKernelEvent(idleTask(), EV_RUNNING), EV_DONE);
    expect(kernel.status).toBe('succeeded');
    expect(kernel.resultRef).toBe('ref:weekly-1');
    expect(isTaskSucceeded(kernel)).toBe(true);

    // 交叉一致性：F04 的「已完成」与 F02 的「succeeded 且有 resultRef」必须同一真值。
    expect(isTaskSucceeded(kernel)).toBe(task.state === 'completed');
  });

  it('反向对照（fail-closed）：succeeded 缺 resultRef 的事件，两条流水都拒绝当成功', () => {
    // F02：降级为 failed，failClosed 置位。
    const kernel = applyKernelEvent(idleTask(), EV_FAKE_DONE);
    expect(kernel.status).toBe('failed');
    expect(kernel.failClosed).toBe(true);
    expect(isTaskSucceeded(kernel)).toBe(false);

    // F04：进入 completed 需要真实凭据，直接拒（missing-completion-evidence）。
    expect(codeOf(() => applyTaskEvent(seedOneTask('queued'), EV_FAKE_DONE))).toBe(
      'missing-completion-evidence',
    );
  });

  it('F04 事件流适配层：连续事件 applied，过期重放为 replay', () => {
    let result = reconcileTaskEvents(createGroupsStream(seedOneTask('queued')), EV_RUNNING);
    expect(result.changed).toBe(true);
    expect(result.outcomes[0]?.code).toBe('applied');
    expect(taskOf(result.stream.state).state).toBe('processing');

    // 同一条 revision 再次到达 ⇒ replay（幂等重放，不重复推进）。
    result = reconcileTaskEvents(result.stream, EV_RUNNING);
    expect(result.changed).toBe(false);
    expect(result.outcomes[0]?.code).toBe('replay');
    expect(taskOf(result.stream.state).state).toBe('processing');
  });
});

// ===========================================================================
// B. F03 TaskBinding.status ↔ F04 TaskView.state
// ===========================================================================

/**
 * 粗/细粒度状态词表的**集成契约**（F04 → F03）。
 * F04 的 11 个 TaskState 全部映射到 F03 的 `EventStatus`；F03 的 `EventStatus` 里
 * `'conflict'` **没有** F04 对应态（见下方缺口断言）。
 */
const TASK_STATE_TO_EVENT_STATUS: Readonly<Record<TaskState, EventStatus>> = {
  queued: 'pending',
  processing: 'running',
  'awaiting-input': 'running',
  'awaiting-authorization': 'running',
  'awaiting-external': 'running',
  paused: 'running',
  'partially-complete': 'running',
  completed: 'succeeded',
  cancelling: 'running',
  cancelled: 'cancelled',
  failed: 'failed',
};

const DELETE_SCOPE: DeleteScope = {
  tasks: 'cascade',
  files: 'cascade',
  memory: 'cascade',
  externalActions: 'request-cancel',
};

/** 一个会话里绑定两个任务：run=processing、done=completed，状态由 F04 状态映射导出。 */
function seedConversation(): { groups: GroupsState; conv: ConversationsState } {
  let groups = createGroupsState();
  groups = createGroup(groups, {
    id: GROUP,
    name: '周报整理',
    conversationId: CONV,
    createdAt: '2026-10-03T08:00:00Z',
    summary: '把周报改成一页',
  });
  groups = createTask(groups, {
    taskId: 'task-run',
    groupId: GROUP,
    conversationId: CONV,
    title: '把周报改成一页',
    goal: '输出一页纸周报并发送',
    state: 'processing',
    updatedAt: AT1,
  });
  groups = createTask(groups, {
    taskId: 'task-done',
    groupId: GROUP,
    conversationId: CONV,
    title: '导出草稿',
    goal: '导出成 docx',
    state: 'completed',
    updatedAt: AT2,
  });

  let conv = createConversationsState();
  conv = createConversation(conv, { id: CONV, title: '周报整理', lastActiveAt: AT2 });
  conv = bindTask(conv, {
    conversationId: CONV,
    expectedRevision: 1,
    task: { taskId: 'task-run', title: '把周报改成一页', status: TASK_STATE_TO_EVENT_STATUS['processing'] },
  });
  conv = bindTask(conv, {
    conversationId: CONV,
    expectedRevision: 2,
    task: { taskId: 'task-done', title: '导出草稿', status: TASK_STATE_TO_EVENT_STATUS['completed'] },
  });
  return { groups, conv };
}

describe('集成 F03↔F04 · 绑定状态与任务态口径一致（归档 / 删除）', () => {
  it('映射对 F04 的每个 TaskState 全覆盖；绑定状态 = 映射后的 F04 状态', () => {
    expect(Object.keys(TASK_STATE_TO_EVENT_STATUS).sort()).toEqual([...TASK_STATES].sort());

    const { groups, conv } = seedConversation();
    for (const taskId of ['task-run', 'task-done']) {
      const binding = taskOwnership(conv, taskId);
      expect(binding?.status).toBe(TASK_STATE_TO_EVENT_STATUS[taskOf(groups, taskId).state]);
    }
    expect(taskOwnership(conv, 'task-run')?.status).toBe('running');
    expect(taskOwnership(conv, 'task-done')?.status).toBe('succeeded');
  });

  it('删除前 runningTaskIds 由绑定状态（= 映射后的 F04 状态）如实给出', () => {
    const { conv } = seedConversation();
    const plan = planDelete(conv, CONV);
    expect(plan.taskIds).toEqual(['task-run', 'task-done']);
    // 只有 run（processing→running）在跑；done（completed→succeeded）不算 running。
    expect(plan.runningTaskIds).toEqual(['task-run']);
  });

  it('归档：只改会话 lifecycle，绑定状态与 F04 任务态都不变（保持一致）', () => {
    const { groups, conv } = seedConversation();
    const archived = archiveConversation(conv, { conversationId: CONV, expectedRevision: 3 });

    expect(getConversation(archived, CONV)?.lifecycle).toBe('archived');
    expect(listConversations(archived, { status: 'archived' })).toHaveLength(1);
    expect(listConversations(archived, { status: 'active' })).toHaveLength(0);

    // 两侧状态均未被归档触碰，一致关系保持。
    expect(taskOwnership(archived, 'task-run')?.status).toBe('running');
    expect(taskOwnership(archived, 'task-done')?.status).toBe('succeeded');
    expect(taskOf(groups, 'task-run').state).toBe('processing');
    expect(taskOwnership(archived, 'task-run')?.status).toBe(TASK_STATE_TO_EVENT_STATUS[taskOf(groups, 'task-run').state]);
  });

  it('删除：会话从 F03 集合移除，F04 任务态不被静默改写', () => {
    const { groups, conv } = seedConversation();
    const archived = archiveConversation(conv, { conversationId: CONV, expectedRevision: 3 });
    const deleted = deleteConversation(archived, {
      conversationId: CONV,
      expectedRevision: 4,
      scope: DELETE_SCOPE,
    });

    expect(getConversation(deleted, CONV)).toBeNull();
    expect(listConversations(deleted, { status: 'all' })).toHaveLength(0);
    expect(taskOwnership(deleted, 'task-run')).toBeNull();

    // 反向对照：删会话 ≠ 完成任务。F04 是独立事实，删除不得把它悄悄改成 completed/cancelled。
    expect(taskOf(groups, 'task-run').state).toBe('processing');
    expect(taskOf(groups, 'task-done').state).toBe('completed');
  });

  it('缺口记录：EventStatus 的 conflict 无 F04 对应态；F03 无绑定状态更新路径', () => {
    const conflict: EventStatus = 'conflict';
    const mapped = new Set(Object.values(TASK_STATE_TO_EVENT_STATUS));
    // F03 词表比 F04 多一个 conflict —— 目前无法从 F04 任务态推导，属未收敛口径，如实记录。
    expect(mapped.has(conflict)).toBe(false);

    // F03 的 bindTask 只追加、不做状态更新：重复绑定被拒 ⇒ 绑定后 F04 的 lifecycle 变化
    // 没有通道回写到 TaskBinding.status（见 residuals：需要 F03 提供 update/rebind 路径）。
    const { conv } = seedConversation();
    let code: string | null = null;
    try {
      bindTask(conv, {
        conversationId: CONV,
        expectedRevision: 3,
        task: { taskId: 'task-run', title: '把周报改成一页', status: 'succeeded' },
      });
    } catch (error) {
      if (error instanceof ConversationError) code = error.code;
      else throw error;
    }
    expect(code).toBe('duplicate-task-binding');
  });
});
