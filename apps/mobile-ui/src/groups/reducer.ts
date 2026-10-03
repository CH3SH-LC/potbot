/**
 * F04 groups —— 任务状态机：**唯一**能改变任务态的入口是 `applyTaskEvent`（I1）。
 *
 * 设计要点：
 *
 * 1) **状态由真实事件驱动。** 构造 pause/resume/cancel/change-conditions **命令**本身不改状态
 *    （命令要发往内核；见 `commands.ts`）。状态只在对应事件到达时改变；测试断言「只发命令、
 *    未收事件 ⇒ 状态逐字段不变」。
 *
 * 2) **revision 守卫（I1、I6）。** 事件携带 `revision`：
 *      - `revision <= 当前`      ⇒ `stale-revision`（过期/重复/乱序，拒绝，不覆盖本地较新态）
 *      - `revision >  当前 + 1`  ⇒ `unknown-revision`（缺口，需重同步）
 *      - `revision === 当前 + 1` ⇒ 受理
 *    这就是验收口径「过期 revision 更新」被机器化锁死的地方。
 *
 * 3) **群组 ≠ 内部 Agent 群聊（I2）。** 事件类别必须先过白名单 `isRenderableActivityKind`；
 *    内部对话/思维链/工具流水（`agent-message` / `reasoning` / `tool-trace` …）一律
 *    `internal-chat-rejected`。因此这类事件**进不了状态、也进不了活动记录**。
 *
 * 4) **完成有据（I5）。** 进入 `completed` 必须 `status='succeeded'` + `resultRef` +
 *    `verificationMode='real'`；否则 `missing-completion-evidence`——不以实例空闲/缺凭据判完成。
 *
 * 5) **不做 I/O。** 不读时钟、不读随机数、不发请求；同一事件序列必得同一状态。
 */

import {
  GroupError,
  isRenderableActivityKind,
  isTerminalTaskState,
  isWaitingTaskState,
  bucketOf,
} from './types.js';
import type {
  ActivityEntry,
  CancelState,
  ConditionChange,
  DecisionRef,
  GroupsState,
  StageView,
  TaskBucket,
  TaskEvent,
  TaskState,
  TaskView,
} from './types.js';
import { requireIsoTimestamp } from './util.js';

// ---------------------------------------------------------------------------
// 合法状态迁移表
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['processing', 'awaiting-authorization', 'awaiting-input', 'paused', 'cancelling', 'failed'],
  processing: [
    'awaiting-input',
    'awaiting-authorization',
    'awaiting-external',
    'paused',
    'partially-complete',
    'completed',
    'cancelling',
    'failed',
  ],
  'awaiting-input': [
    'processing',
    'awaiting-authorization',
    'awaiting-external',
    'paused',
    'cancelling',
    'failed',
  ],
  'awaiting-authorization': [
    'processing',
    'awaiting-input',
    'awaiting-external',
    'paused',
    'cancelling',
    'failed',
  ],
  'awaiting-external': [
    'processing',
    'awaiting-input',
    'awaiting-authorization',
    'partially-complete',
    'completed',
    'cancelling',
    'failed',
  ],
  paused: ['processing', 'cancelling', 'failed'],
  'partially-complete': ['processing', 'completed', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'processing', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

function assertTransition(from: TaskState, to: TaskState, taskId: string): void {
  if (!canTransition(from, to)) {
    throw new GroupError('illegal-transition', `非法状态迁移：${from} → ${to}`, {
      taskId,
      from,
      to,
    });
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function replaceTask(state: GroupsState, taskId: string, next: TaskView): GroupsState {
  const index = state.taskIndexById[taskId];
  if (index === undefined) {
    throw new GroupError('unknown-task', '任务不存在', { taskId });
  }
  const tasks = state.tasks.slice();
  tasks[index] = next;
  return { ...state, tasks };
}

/** 事件发生后追加的活动条目。 */
function entryFor(event: TaskEvent, summary: string): ActivityEntry {
  const meta = event.metadata;
  const entry: ActivityEntry = {
    seq: event.seq,
    at: meta.at,
    kind: meta.kind,
    summary,
  };
  return meta.reason === undefined ? entry : { ...entry, reason: meta.reason };
}

function defaultSummary(event: TaskEvent): string {
  const meta = event.metadata;
  switch (meta.kind) {
    case 'state':
      return meta.summary ?? `状态 → ${meta.to ?? '未知'}`;
    case 'stage':
      return meta.summary ?? `阶段 ${meta.stageId ?? ''} → ${meta.stageStatus ?? ''}`;
    case 'wait':
      return meta.summary ?? `等待：${meta.waitReason ?? ''}`;
    case 'permission':
      return meta.summary ?? '权限变化';
    case 'artifact':
      return meta.summary ?? `产出：${meta.artifact?.label ?? ''}`;
    case 'decision':
      return meta.summary ?? `待处理：${meta.decision?.label ?? ''}`;
    case 'evidence':
      return meta.summary ?? '完成凭据';
    case 'condition':
      return meta.summary ?? '修改条件';
    case 'cancel-result':
      return meta.summary ?? `取消核验：${meta.cancellation?.outcome ?? ''}`;
    default:
      return meta.summary ?? '进展';
  }
}

// ---------------------------------------------------------------------------
// 各类事件的应用
// ---------------------------------------------------------------------------

function waitingReasonFor(to: TaskState, provided: string | undefined): string | null {
  if (!isWaitingTaskState(to)) return null;
  if (provided !== undefined && provided.trim() !== '') return provided.trim();
  return null;
}

function applyStateEvent(task: TaskView, event: TaskEvent): TaskView {
  const meta = event.metadata;
  const to = meta.to;
  if (to === undefined) {
    throw new GroupError('missing-target-state', "kind='state' 事件必须给出 metadata.to", {
      taskId: task.taskId,
    });
  }
  // I5：完成必须有真实凭据，且不得由 fixture 冒充。
  if (to === 'completed') {
    const hasResult = typeof event.resultRef === 'string' && event.resultRef.length > 0;
    if (event.status !== 'succeeded' || !hasResult || event.verificationMode !== 'real') {
      throw new GroupError(
        'missing-completion-evidence',
        "进入 completed 需要 status='succeeded' + resultRef + verificationMode='real'",
        { taskId: task.taskId, status: event.status },
      );
    }
  }
  assertTransition(task.state, to, task.taskId);
  const resumeFrom = to === 'paused' ? task.state : null;
  const cancel: CancelState | null =
    to === 'cancelling' ? { requestedAt: meta.at, outcome: 'pending' } : task.cancel;
  return {
    ...task,
    state: to,
    resumeFrom,
    cancel,
    waitReason: waitingReasonFor(to, meta.waitReason),
  };
}

function applyWaitEvent(task: TaskView, event: TaskEvent): TaskView {
  const meta = event.metadata;
  const reason = meta.waitReason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new GroupError('missing-wait-reason', "kind='wait' 事件必须给出非空 metadata.waitReason", {
      taskId: task.taskId,
    });
  }
  const to = meta.to ?? task.state;
  if (to !== task.state) {
    assertTransition(task.state, to, task.taskId);
  }
  return { ...task, state: to, waitReason: reason.trim() };
}

function applyStageEvent(task: TaskView, event: TaskEvent): TaskView {
  const meta = event.metadata;
  if (typeof meta.stageId !== 'string' || meta.stageId === '' || meta.stageStatus === undefined) {
    throw new GroupError('missing-stage-ref', "kind='stage' 事件必须给出 metadata.stageId 与 stageStatus", {
      taskId: task.taskId,
    });
  }
  const index = task.stages.findIndex((stage) => stage.stageId === meta.stageId);
  if (index < 0) {
    throw new GroupError('unknown-stage', '未知阶段', { taskId: task.taskId, stageId: meta.stageId });
  }
  const current = task.stages[index];
  if (current === undefined) {
    throw new GroupError('unknown-stage', '阶段下标失效', { taskId: task.taskId });
  }
  const nextStatus = meta.stageStatus;
  // I4：已完成/已跳过的阶段不得回退为 pending/active；也不得把更早的阶段重新激活。
  if ((current.status === 'done' || current.status === 'skipped') && (nextStatus === 'pending' || nextStatus === 'active')) {
    throw new GroupError('stage-regression', '不得回退已完成的阶段', {
      taskId: task.taskId,
      stageId: meta.stageId,
      from: current.status,
      to: nextStatus,
    });
  }
  if (nextStatus === 'active' && index < task.activeStageIndex) {
    throw new GroupError('stage-regression', '不得激活已越过的阶段', {
      taskId: task.taskId,
      stageId: meta.stageId,
      index,
      activeStageIndex: task.activeStageIndex,
    });
  }

  const stages = task.stages.map((stage, i) => {
    if (i === index) {
      const updated: StageView =
        meta.note === undefined ? { ...stage, status: nextStatus } : { ...stage, status: nextStatus, note: String(meta.note) };
      return updated;
    }
    // 激活某阶段时，把它之前仍 pending/active 的阶段补记 done（阶段单调推进：
    // 一个阶段被推进到下一个时，先前在做的阶段即视为完成）。
    if (nextStatus === 'active' && i < index && (stage.status === 'pending' || stage.status === 'active')) {
      return { ...stage, status: 'done' as const };
    }
    return stage;
  });
  const activeStageIndex = nextStatus === 'active' ? Math.max(task.activeStageIndex, index) : task.activeStageIndex;
  return { ...task, stages, activeStageIndex };
}

function applyArtifactEvent(task: TaskView, event: TaskEvent): TaskView {
  const artifact = event.metadata.artifact;
  if (artifact === undefined || artifact.refId === '') {
    throw new GroupError('missing-artifact', "kind='artifact' 事件必须给出 metadata.artifact.refId", {
      taskId: task.taskId,
    });
  }
  if (task.artifacts.some((a) => a.refId === artifact.refId)) return task;
  return { ...task, artifacts: [...task.artifacts, artifact] };
}

function applyDecisionEvent(task: TaskView, event: TaskEvent): TaskView {
  const decision = event.metadata.decision;
  if (decision === undefined || decision.actionId === '') {
    throw new GroupError('missing-decision', "kind='decision' 事件必须给出 metadata.decision.actionId", {
      taskId: task.taskId,
    });
  }
  if (task.pendingDecisions.some((d) => d.actionId === decision.actionId)) return task;
  const next: DecisionRef = { ...decision };
  return { ...task, pendingDecisions: [...task.pendingDecisions, next] };
}

function applyConditionEvent(task: TaskView, event: TaskEvent): TaskView {
  const meta = event.metadata;
  const changes = meta.changes ?? [];
  const affected = meta.affected ?? { artifactIds: [], actionIds: [], decisionIds: [] };

  let constraints = [...task.constraints];
  for (const change of changes) {
    constraints = applyConditionChange(constraints, change);
  }

  // I6：受影响的待确认动作与外部动作引用失效；产物保留（是结果，不销毁）。
  const decisionIds = new Set(affected.decisionIds);
  const actionIds = new Set(affected.actionIds);
  const pendingDecisions = task.pendingDecisions.filter((d) => !decisionIds.has(d.actionId));
  const actionRefs = task.actionRefs.filter((ref) => !actionIds.has(ref));

  return { ...task, constraints, pendingDecisions, actionRefs };
}

/** 应用一条条件修改：`remove` 删除匹配项，否则替换同名或追加。 */
function applyConditionChange(constraints: readonly string[], change: ConditionChange): string[] {
  const token = `${change.field}=${change.value}`;
  if (change.remove === true) {
    return constraints.filter((c) => c !== token);
  }
  // 同字段替换（`field=` 前缀），否则追加。
  const prefix = `${change.field}=`;
  const filtered = constraints.filter((c) => !c.startsWith(prefix));
  return [...filtered, token];
}

function applyCancelResultEvent(task: TaskView, event: TaskEvent): TaskView {
  const cancellation = event.metadata.cancellation;
  if (cancellation === undefined) {
    throw new GroupError('missing-cancellation', "kind='cancel-result' 事件必须给出 metadata.cancellation", {
      taskId: task.taskId,
    });
  }
  if (task.state !== 'cancelling' || task.cancel === null) {
    throw new GroupError('not-cancelling', '只有取消中的任务才接受取消核验结果', {
      taskId: task.taskId,
      state: task.state,
    });
  }
  const requestedAt = task.cancel.requestedAt;
  switch (cancellation.outcome) {
    case 'provider-confirmed':
      return {
        ...task,
        state: 'cancelled',
        cancel: { requestedAt, outcome: 'provider-confirmed' },
        waitReason: null,
      };
    case 'provider-rejected':
      return {
        ...task,
        state: 'processing',
        cancel: { requestedAt, outcome: 'provider-rejected' },
        waitReason: '取消被供应方拒绝，任务继续',
      };
    case 'unknown':
      // 未知 ≠ 已取消：留在 cancelling，明确不可声称完成。
      return {
        ...task,
        state: 'cancelling',
        cancel: { requestedAt, outcome: 'unknown' },
        waitReason: '正在确认取消结果',
      };
    case 'pending':
      return { ...task, cancel: { requestedAt, outcome: 'pending' } };
    default:
      throw new GroupError('missing-cancellation', '未知的取消核验结果', { taskId: task.taskId });
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 受理一个任务事件。任何不合法输入一律抛 `GroupError`，**不改变状态**。
 * 返回新的 `GroupsState`（其余任务/群组对象引用不变）。
 */
export function applyTaskEvent(state: GroupsState, event: TaskEvent): GroupsState {
  const meta = event.metadata;

  // I2：类别白名单——内部 Agent 对话/思维链/工具流水一律拒收。
  if (!isRenderableActivityKind(meta.kind)) {
    throw new GroupError('internal-chat-rejected', '事件类别不属于用户可见活动，拒收（群组不是内部 Agent 群聊）', {
      taskId: typeof meta.taskId === 'string' ? meta.taskId : null,
      kind: typeof meta.kind === 'string' ? meta.kind : null,
    });
  }

  const index = state.taskIndexById[meta.taskId];
  if (index === undefined) {
    throw new GroupError('unknown-task', '任务不存在', { taskId: meta.taskId });
  }
  const task = state.tasks[index];
  if (task === undefined) {
    throw new GroupError('unknown-task', '任务下标失效', { taskId: meta.taskId });
  }

  requireIsoTimestamp(meta.at, 'event.at');

  // I1/I6：revision 守卫。
  if (typeof event.revision !== 'number' || !Number.isInteger(event.revision)) {
    throw new GroupError('missing-revision', '事件 revision 必须是整数', { taskId: task.taskId });
  }
  if (event.revision <= task.revision) {
    throw new GroupError('stale-revision', '过期/重复/乱序事件，拒绝覆盖本地较新状态', {
      taskId: task.taskId,
      eventRevision: event.revision,
      current: task.revision,
    });
  }
  if (event.revision > task.revision + 1) {
    throw new GroupError('unknown-revision', '事件 revision 出现缺口，需重同步', {
      taskId: task.taskId,
      eventRevision: event.revision,
      current: task.revision,
    });
  }

  let next: TaskView;
  switch (meta.kind) {
    case 'state':
      next = applyStateEvent(task, event);
      break;
    case 'wait':
      next = applyWaitEvent(task, event);
      break;
    case 'stage':
      next = applyStageEvent(task, event);
      break;
    case 'artifact':
      next = applyArtifactEvent(task, event);
      break;
    case 'decision':
      next = applyDecisionEvent(task, event);
      break;
    case 'condition':
      next = applyConditionEvent(task, event);
      break;
    case 'cancel-result':
      next = applyCancelResultEvent(task, event);
      break;
    case 'permission':
    case 'evidence':
      next = task; // 纯记录：只追加活动条目。
      break;
    default:
      throw new GroupError('internal-chat-rejected', '未受理的事件类别', {
        taskId: task.taskId,
        kind: meta.kind,
      });
  }

  const updated: TaskView = {
    ...next,
    revision: event.revision,
    lastEventSeq: event.seq,
    lastUpdatedAt: meta.at,
    activity: [...task.activity, entryFor(event, defaultSummary(event))],
  };
  return replaceTask(state, task.taskId, updated);
}

/** 顺序受理一串事件；任一非法即抛出且此前的合法事件已生效（与逐条调用一致）。 */
export function applyTaskEvents(state: GroupsState, events: readonly TaskEvent[]): GroupsState {
  let current = state;
  for (const event of events) current = applyTaskEvent(current, event);
  return current;
}

/** 某任务的筛选桶（供 UI/测试直接读取）。 */
export function taskBucket(task: TaskView): TaskBucket {
  return bucketOf(task.state);
}

/** 是否终态（completed / cancelled / failed）。 */
export function isTaskTerminal(task: TaskView): boolean {
  return isTerminalTaskState(task.state);
}
