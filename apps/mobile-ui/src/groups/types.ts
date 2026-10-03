/**
 * F04 groups —— 群组列表与任务详情视图模型的类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包只产出**可断言的视图状态与纯函数**：不渲染、不引框架、不发网络请求、不读文件字节、
 * 不触碰时钟（所有「现在/发生时」由调用方以 UTC ISO 字符串注入）、不用随机数（id 确定性推导）。
 *
 * 只读消费（不改动）：
 *   - `contracts/mobile-v1/types.ts`：v1 契约类型（`Command` / `Event` / `EventStatus` /
 *     `VerificationMode`）。命令与事件一律按契约形状产出，不另发明字段。
 *
 * 参见 design-07：T01 群组列表、T02 任务详情、T03 修改任务、T08 活动记录，
 * 第 9 节「任务」状态合同与「暂无内部 Agent 群聊」。
 *
 * 核心不变量（由 `tests/mobile-ui/F04/` 机器化断言）：
 *   I1 状态由真实事件驱动：「任务态只经 `applyTaskEvent` 改变」。构造暂停/取消/改条件命令
 *      **本身不改状态**（命令要发往内核、由内核回事件）；同理，过期（revision ≤ 当前）的事件
 *      被拒为 `stale-revision` 且不覆盖本地较新态，缺口 revision 被拒为 `unknown-revision`。
 *   I2 群组不是内部 Agent 群聊：任务事件只接受「用户可见」的活动类别白名单；内部 Agent
 *      对话/思维链/工具流水（`agent-message` / `agent-turn` / `internal-chat` / `reasoning`
 *      / `tool-trace`）一律拒收，且状态对象**没有** `messages` 字段，不产出任何活动条目。
 *   I3 暂停可续接：暂停记录 `resumeFrom`，恢复回到暂停前的态；取消是两步（`cancelling`
 *      非终态 → 核验 `cancel-result` 才 `cancelled`），且**已发生的成果保留**。
 *   I4 阶段单调：阶段只能向前推进（active → done、激活下一个），不得把已完成阶段回退。
 *   I5 完成有据：进入 `completed` 必须带 `status='succeeded'` + `resultRef` + `verificationMode='real'`
 *      （`missing-completion-evidence` 拒绝 fixture 或无凭据的完成）。
 *   I6 改条件即失效：改条件升 revision，并使受影响的待确认动作与外部动作引用失效；
 *      旧 revision 的提交必然被拒（`stale-revision`）。
 */

import type { Command, Event, EventStatus, VerificationMode } from '../../../../contracts/mobile-v1/types.js';

export type { Command, Event, EventStatus, VerificationMode };

// ---------------------------------------------------------------------------
// 任务生命周期（design-07 第 9 节「任务」行）
// ---------------------------------------------------------------------------

/**
 * 任务状态全集（与 design-07 第 9 节逐项对应，顺序亦一致）：
 *   排队 / 处理中 / 等资料 / 等授权 / 等外部结果 / 已暂停 / 部分完成 / 已完成 / 取消中 / 已取消 / 失败
 */
export type TaskState =
  | 'queued'
  | 'processing'
  | 'awaiting-input'
  | 'awaiting-authorization'
  | 'awaiting-external'
  | 'paused'
  | 'partially-complete'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export const TASK_STATES: readonly TaskState[] = [
  'queued',
  'processing',
  'awaiting-input',
  'awaiting-authorization',
  'awaiting-external',
  'paused',
  'partially-complete',
  'completed',
  'cancelling',
  'cancelled',
  'failed',
];

/** 终态集合：进入其一后不再受理状态迁移。 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'cancelled', 'failed'];

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** 等待类状态：正在等外部/用户，`waitReason` 必须可见。 */
export const WAITING_TASK_STATES: readonly TaskState[] = [
  'awaiting-input',
  'awaiting-authorization',
  'awaiting-external',
  'paused',
];

export function isWaitingTaskState(state: TaskState): boolean {
  return WAITING_TASK_STATES.includes(state);
}

/** 需要**用户处理**的状态（进入「待处理」筛选桶）。 */
export const NEEDS_ACTION_TASK_STATES: readonly TaskState[] = [
  'awaiting-input',
  'awaiting-authorization',
  'paused',
];

export function needsUserAction(state: TaskState): boolean {
  return NEEDS_ACTION_TASK_STATES.includes(state);
}

/** 中文标签（仅展示用，不参与判定）。 */
export const TASK_STATE_LABELS: Readonly<Record<TaskState, string>> = {
  queued: '排队',
  processing: '处理中',
  'awaiting-input': '等资料',
  'awaiting-authorization': '等授权',
  'awaiting-external': '等外部结果',
  paused: '已暂停',
  'partially-complete': '部分完成',
  completed: '已完成',
  cancelling: '取消中',
  cancelled: '已取消',
  failed: '失败',
};

/** 每个等待类状态对应的默认等待原因文案（实际原因以事件注入为准）。 */
export const DEFAULT_WAIT_REASONS: Partial<Readonly<Record<TaskState, string>>> = {
  'awaiting-input': '等待补充资料',
  'awaiting-authorization': '等待你的授权',
  'awaiting-external': '等待外部结果',
  paused: '已暂停，可续接',
};

// ---------------------------------------------------------------------------
// 列表筛选桶（T01：待处理 / 进行中 / 已结束）
// ---------------------------------------------------------------------------

export type TaskBucket = 'needs-action' | 'in-progress' | 'ended';

export const TASK_BUCKETS: readonly TaskBucket[] = ['needs-action', 'in-progress', 'ended'];

export const TASK_BUCKET_LABELS: Readonly<Record<TaskBucket, string>> = {
  'needs-action': '待处理',
  'in-progress': '进行中',
  ended: '已结束',
};

/**
 * 状态 → 筛选桶。**显式穷举**、不靠默认分支：
 *   - 待处理：需要用户动手（等资料 / 等授权 / 已暂停）；
 *   - 进行中：仍在移动（排队 / 处理中 / 等外部结果 / 取消中）；
 *   - 已结束：有结论（部分完成 / 已完成 / 已取消 / 失败）。
 */
export const TASK_BUCKET_BY_STATE: Readonly<Record<TaskState, TaskBucket>> = {
  queued: 'in-progress',
  processing: 'in-progress',
  'awaiting-input': 'needs-action',
  'awaiting-authorization': 'needs-action',
  'awaiting-external': 'in-progress',
  paused: 'needs-action',
  'partially-complete': 'ended',
  completed: 'ended',
  cancelling: 'in-progress',
  cancelled: 'ended',
  failed: 'ended',
};

export function bucketOf(state: TaskState): TaskBucket {
  return TASK_BUCKET_BY_STATE[state];
}

// ---------------------------------------------------------------------------
// 阶段（T02 上部：目标与当前版本；中部：成果与待处理事项）
// ---------------------------------------------------------------------------

export type StageStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface StageView {
  readonly stageId: string;
  readonly label: string;
  readonly status: StageStatus;
  /** 阶段说明 / 跳过或卡住的原因（展示用）。 */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// 成果 / 待处理事项 / 外部动作
// ---------------------------------------------------------------------------

/** 产出引用（只描述，不读真实 bytes）。`digest` 只有合法 sha256 才算可核验。 */
export interface ArtifactRef {
  readonly refId: string;
  readonly label: string;
  readonly mime?: string;
  readonly digest?: `sha256:${string}`;
  readonly revision?: number;
}

/** 待处理事项：等用户确认/选择的动作（T02 中部；F05 负责公共确认卡，本包只列引用）。 */
export interface DecisionRef {
  readonly actionId: string;
  readonly label: string;
  /** 关联任务 revision：改条件/改参数后旧卡原位失效。 */
  readonly taskRevision: number;
}

/** 取消状态：核验结果未知时**不得**声称已取消（design-07 第 9/10 节）。 */
export type CancelOutcome = 'pending' | 'provider-confirmed' | 'provider-rejected' | 'unknown';

export interface CancelState {
  readonly requestedAt: string;
  readonly outcome: CancelOutcome;
}

// ---------------------------------------------------------------------------
// 任务 / 群组
// ---------------------------------------------------------------------------

export interface TaskView {
  readonly taskId: string;
  /** 聚合到哪个群组。 */
  readonly groupId: string;
  /** 所属对话：群组项的「所属对话」列。 */
  readonly conversationId: string;
  readonly title: string;
  /** 任务目标（T02 上部）。 */
  readonly goal: string;
  readonly state: TaskState;
  /** 乐观锁版本：每次受理事件 +1；写操作与事件都必须携带 revision（I1、I6）。 */
  readonly revision: number;
  readonly stages: readonly StageView[];
  /** 当前激活阶段下标；-1 表示尚未开始任何阶段。 */
  readonly activeStageIndex: number;
  readonly waitReason: string | null;
  /** 暂停前的状态：恢复入口（I3）。 */
  readonly resumeFrom: TaskState | null;
  /** 成果（T02）。 */
  readonly artifacts: readonly ArtifactRef[];
  /** 待处理事项（等确认动作）。 */
  readonly pendingDecisions: readonly DecisionRef[];
  /** 外部动作引用（下单/日程等）；只列引用，不做外部动作。 */
  readonly actionRefs: readonly string[];
  /** 约束（T03：修改约束时列出受影响项）。 */
  readonly constraints: readonly string[];
  /** 已受理的最后一个事件 seq（事件驱动轨迹，用于丢弃重复/乱序）。 */
  readonly lastEventSeq: number;
  /** 真实更新时间（调用方注入）。 */
  readonly lastUpdatedAt: string;
  readonly cancel: CancelState | null;
  /** 活动记录（T08）：只含用户可见类别，**不含**内部 Agent 群聊。 */
  readonly activity: readonly ActivityEntry[];
}

export interface GroupView {
  readonly groupId: string;
  readonly name: string;
  /** 所属对话。 */
  readonly conversationId: string;
  readonly revision: number;
  readonly seq: number;
  readonly createdAt: string;
  /**
   * 最近进展（简短）。**注意**：这是进展摘要，不是内部 Agent 对话；
   * `GroupView` 没有 `messages` 字段，群组不是聊天（I2）。
   */
  readonly summary: string;
}

export interface GroupsState {
  readonly groups: readonly GroupView[];
  readonly tasks: readonly TaskView[];
  readonly groupIndexById: Readonly<Record<string, number>>;
  readonly taskIndexById: Readonly<Record<string, number>>;
  /** 已分配的最大群组 seq（单调递增，删除不回退）。 */
  readonly counter: number;
}

// ---------------------------------------------------------------------------
// 活动记录（T08）
// ---------------------------------------------------------------------------

/**
 * 活动类别白名单（用户可见）。design-07 T08：重要变更、等待、权限变化与完成凭据；
 * **无内部完整群聊**。
 */
export type ActivityKind =
  | 'state' // 生命周期变化
  | 'stage' // 阶段推进
  | 'wait' // 等待与原因
  | 'permission' // 权限变化
  | 'artifact' // 产出
  | 'decision' // 待处理动作
  | 'evidence' // 完成凭据
  | 'condition' // 条件修改
  | 'cancel-result'; // 取消结果核验

export const RENDERABLE_ACTIVITY_KINDS: readonly ActivityKind[] = [
  'state',
  'stage',
  'wait',
  'permission',
  'artifact',
  'decision',
  'evidence',
  'condition',
  'cancel-result',
];

/**
 * 明确**不得**进入活动记录的类别：内部 Agent 对话/思维链/工具流水。
 * 出现即拒收（`internal-chat-rejected`），防止「群组变成内部 Agent 群聊」（I2）。
 */
export const FORBIDDEN_ACTIVITY_KINDS: readonly string[] = [
  'agent-message',
  'agent-turn',
  'agent-chat',
  'internal-chat',
  'internal-turn',
  'reasoning',
  'thought',
  'chain-of-thought',
  'tool-trace',
  'tool-call',
  'model-output',
  'prompt',
];

export function isRenderableActivityKind(kind: unknown): kind is ActivityKind {
  return typeof kind === 'string' && (RENDERABLE_ACTIVITY_KINDS as readonly string[]).includes(kind);
}

export function isForbiddenActivityKind(kind: unknown): boolean {
  return typeof kind === 'string' && FORBIDDEN_ACTIVITY_KINDS.includes(kind);
}

export interface ActivityEntry {
  readonly seq: number;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly summary: string;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 任务事件（消费契约 Event，metadata 承载任务语义）
// ---------------------------------------------------------------------------

/** 任务事件类别 === 活动类别（白名单一致）。 */
export type TaskEventKind = ActivityKind;

export interface ConditionChange {
  readonly field: string;
  readonly value: string;
  /** 删除该条约束（按 field+value 匹配）而非新增。 */
  readonly remove?: boolean;
}

/** 一次条件修改的影响面（T03：列出受影响产物与待失效动作）。 */
export interface AffectedSummary {
  readonly artifactIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly decisionIds: readonly string[];
}

export interface CancelResultRef {
  readonly outcome: CancelOutcome;
  readonly evidenceRef?: string;
}

/**
 * 任务事件 metadata。带索引签名，保证可赋给契约 `Event.metadata: Record<string, unknown>`。
 */
export interface TaskEventMeta {
  readonly taskId: string;
  readonly kind: TaskEventKind;
  /** 发生时间（UTC ISO），由调用方注入。 */
  readonly at: string;
  readonly summary?: string;
  readonly reason?: string;
  // kind === 'state' / 'wait'
  readonly to?: TaskState;
  readonly waitReason?: string;
  // kind === 'stage'
  readonly stageId?: string;
  readonly stageStatus?: StageStatus;
  // kind === 'artifact'
  readonly artifact?: ArtifactRef;
  // kind === 'decision'
  readonly decision?: DecisionRef;
  // kind === 'condition'
  readonly changes?: readonly ConditionChange[];
  readonly affected?: AffectedSummary;
  // kind === 'cancel-result'
  readonly cancellation?: CancelResultRef;
  readonly [extra: string]: unknown;
}

/** 任务事件：契约 `Event` 的字段 + 任务语义 metadata。 */
export type TaskEvent = Omit<Event, 'metadata'> & { readonly metadata: TaskEventMeta };

// ---------------------------------------------------------------------------
// 群组列表行（T01）
// ---------------------------------------------------------------------------

export interface ListGroupsOptions {
  /** 筛选桶；缺省为全部。 */
  readonly bucket?: TaskBucket;
  /** 搜索关键字（群组名 / 任务标题 / 目标，忽略大小写、首尾空白）；空串不过滤。 */
  readonly query?: string;
}

export interface GroupListRow {
  readonly groupId: string;
  readonly name: string;
  readonly conversationId: string;
  /** 聚合后的桶：有需要用户处理的任务则最高优先为 needs-action，其次 in-progress，最后 ended。 */
  readonly bucket: TaskBucket;
  readonly taskCount: number;
  readonly needsActionCount: number;
  readonly lastActiveAt: string;
  readonly taskIds: readonly string[];
  /** 下一步 / 等待原因（需要用户处理时给出简短而具体的说明）。 */
  readonly nextStep: string;
  readonly waitReason: string | null;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type GroupErrorCode =
  | 'unknown-group'
  | 'unknown-task'
  | 'unknown-stage'
  | 'invalid-value'
  | 'invalid-timestamp'
  | 'stale-revision'
  | 'unknown-revision'
  | 'missing-revision'
  | 'illegal-transition'
  | 'missing-target-state'
  | 'missing-wait-reason'
  | 'missing-completion-evidence'
  | 'missing-stage-ref'
  | 'missing-artifact'
  | 'missing-decision'
  | 'missing-cancellation'
  | 'not-cancelling'
  | 'stage-regression'
  | 'internal-chat-rejected'
  | 'unknown-affected-id';

/**
 * 视图模型的结构化错误：只带 code + 可读 message + 脱敏 details，
 * 不含密钥/请求体/本地路径。测试按 `code` 断言，避免只匹配文案。
 */
export class GroupError extends Error {
  readonly code: GroupErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: GroupErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'GroupError';
    this.code = code;
    this.details = details;
  }
}
