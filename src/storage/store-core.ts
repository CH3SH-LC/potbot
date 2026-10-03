/**
 * 存储内核的**共享机制**：状态形状、写时复制、事务视图、状态编解码。
 *
 * 为什么单独成文件（design-06-P5 / 合同 R214–R220）：`memory-store.ts` 与
 * `file-store.ts` 必须是**同一个 `Store` 接口的两个实现**，不是两套语义。
 * 事务边界、读时一致性、主键归一化只能有一份定义——否则"内存版通过、落盘版
 * 悄悄改了语义"这类分叉无从发现。本文件是那份唯一定义。
 *
 * 本文件**不做任何 I/O**：落盘、加锁、跨进程协调归 `file-store.ts`。
 */

import {
  markEventDelivered,
  toActionableInputKey,
  toGroupMemberKey,
  toMessageScopeKey,
  undelivered,
  ValidationError,
  type ActionableInputMark,
  type ArtifactRecord,
  type ArtifactRef,
  type EventId,
  type FactRef,
  type GroupId,
  type GroupMember,
  type GroupMessage,
  type InboxEntry,
  type InstanceId,
  type InstanceState,
  type KernelEvent,
  type LogicalTime,
  type MessageId,
  type PendingEvent,
  type ReadReceipt,
  type RequestId,
  type RunId,
  type RunRecord,
  type SharedFactRecord,
  type StorageTransaction,
  type StoreSnapshot,
  type TaskControlState,
  type TaskId,
  type TaskRecord,
  type TransactionSummary,
  type WorkItem,
} from '../protocol/index.js';

export interface StoreState {
  readonly tasks: Map<TaskId, TaskRecord>;
  readonly taskControlStates: Map<TaskId, TaskControlState>;
  /**
   * 消息以**群作用域键**存储（`toMessageScopeKey(group, message_id)`，R6）：
   * 同一个 `message_id` 在不同群组是两条不同消息，可共存、互不覆盖（Q1-d / Q3-b）。
   */
  readonly messages: Map<string, GroupMessage>;
  readonly inboxEntries: InboxEntry[];
  readonly readReceipts: ReadReceipt[];
  readonly actionableInputs: Map<string, ActionableInputMark>;
  readonly workItems: Map<RequestId, WorkItem>;
  readonly instances: Map<InstanceId, InstanceState>;
  /** 群成员登记：键 = `toGroupMemberKey(group_id, instance_id)`（F07）。 */
  readonly groupMembers: Map<string, GroupMember>;
  readonly runs: Map<RunId, RunRecord>;
  readonly deliveryEvents: Map<EventId, PendingEvent>;
  readonly kernelEvents: KernelEvent[];
  /** 产物记录（design-02 A 批）：键 = `artifact_id`。 */
  readonly artifacts: Map<ArtifactRef, ArtifactRecord>;
  /** 共享事实记录（design-02 A 批）：键 = `fact_id`。 */
  readonly sharedFacts: Map<FactRef, SharedFactRecord>;
  /**
   * **动作台账**（FA-S；`src/workledger/action-ledger.ts` 的 `ActionRecord`）：键 = `action_id`。
   *
   * 类型是 `object`（**不是** `ActionRecord`）——这是依赖方向决定的，不是偷懒：
   * `ActionRecord` 定义在 `src/workledger`、`TaskLifecycleState` 定义在 `src/scheduler`，
   * 而 `src/scheduler → src/storage` 是**既有方向**；`src/storage` 反向 import 会成环
   * （合同 §八 的模块归属）。存储因此只按"**有字符串主键的行**"保存与持久化，
   * 具体形状由上层解释：`src/scheduler/task-action-store.ts` 的适配器在**运行时校验**
   * 六个接缝方法存在之后做结构转换（不静默、不猜）。
   *
   * `src/protocol/**` **未改动**（总协调独占）：这也是本集合用结构性扩展而不是
   * 把 `ActionRecord` 提升进 protocol 的原因。
   */
  readonly actions: Map<string, object>;
  /** **任务生命周期**（FA-S；`src/scheduler/task-lifecycle.ts` 的 `TaskLifecycleState`）：键 = `task_id`。 */
  readonly taskLifecycles: Map<string, object>;
}

export function emptyState(): StoreState {
  return {
    tasks: new Map(),
    taskControlStates: new Map(),
    messages: new Map(),
    inboxEntries: [],
    readReceipts: [],
    actionableInputs: new Map(),
    workItems: new Map(),
    instances: new Map(),
    groupMembers: new Map(),
    runs: new Map(),
    deliveryEvents: new Map(),
    kernelEvents: [],
    artifacts: new Map(),
    sharedFacts: new Map(),
    actions: new Map(),
    taskLifecycles: new Map(),
  };
}

/** 写时复制：浅拷贝各容器；元素本身在写入时已冻结，故无需深拷贝。 */
export function cloneState(state: StoreState): StoreState {
  return {
    tasks: new Map(state.tasks),
    taskControlStates: new Map(state.taskControlStates),
    messages: new Map(state.messages),
    inboxEntries: [...state.inboxEntries],
    readReceipts: [...state.readReceipts],
    actionableInputs: new Map(state.actionableInputs),
    workItems: new Map(state.workItems),
    instances: new Map(state.instances),
    groupMembers: new Map(state.groupMembers),
    runs: new Map(state.runs),
    deliveryEvents: new Map(state.deliveryEvents),
    kernelEvents: [...state.kernelEvents],
    artifacts: new Map(state.artifacts),
    sharedFacts: new Map(state.sharedFacts),
    actions: new Map(state.actions),
    taskLifecycles: new Map(state.taskLifecycles),
  };
}

/** 事务内触及的记录标识收集器。 */
export class TouchTracker {
  private readonly taskIds = new Set<TaskId>();
  private readonly messageIds = new Set<MessageId>();
  private readonly requestIds = new Set<RequestId>();
  private readonly instanceIds = new Set<InstanceId>();
  private readonly runIds = new Set<RunId>();
  private readonly eventIds = new Set<EventId>();
  private readonly artifactIds = new Set<ArtifactRef>();

  recordTask(id: TaskId): void {
    this.taskIds.add(id);
  }
  recordMessage(id: MessageId): void {
    this.messageIds.add(id);
  }
  recordRequest(id: RequestId): void {
    this.requestIds.add(id);
  }
  recordInstance(id: InstanceId): void {
    this.instanceIds.add(id);
  }
  recordRun(id: RunId): void {
    this.runIds.add(id);
  }
  recordEvent(id: EventId): void {
    this.eventIds.add(id);
  }
  recordArtifact(id: ArtifactRef): void {
    this.artifactIds.add(id);
  }

  summary(): TransactionSummary {
    return Object.freeze({
      task_ids: Object.freeze([...this.taskIds]),
      message_ids: Object.freeze([...this.messageIds]),
      request_ids: Object.freeze([...this.requestIds]),
      instance_ids: Object.freeze([...this.instanceIds]),
      run_ids: Object.freeze([...this.runIds]),
      event_ids: Object.freeze([...this.eventIds]),
      artifact_ids: Object.freeze([...this.artifactIds]),
    });
  }
}

/** 事务视图：所有读写都落在 draft 状态上。 */
export class TransactionView implements StorageTransaction {
  constructor(
    private readonly draft: StoreState,
    private readonly touched: TouchTracker,
  ) {}

  // --- 任务 ---
  putTask(task: TaskRecord): void {
    this.draft.tasks.set(task.task_id, Object.freeze(task));
    this.touched.recordTask(task.task_id);
  }
  getTask(taskId: TaskId): TaskRecord | undefined {
    return this.draft.tasks.get(taskId);
  }
  listTasks(): readonly TaskRecord[] {
    return Object.freeze([...this.draft.tasks.values()]);
  }

  // --- 任务控制状态（取消 / 需求更新优先落点，B4）---
  putTaskControlState(state: TaskControlState): void {
    this.draft.taskControlStates.set(state.task_id, Object.freeze(state));
    this.touched.recordTask(state.task_id);
  }
  getTaskControlState(taskId: TaskId): TaskControlState | undefined {
    return this.draft.taskControlStates.get(taskId);
  }
  listTaskControlStates(): readonly TaskControlState[] {
    return Object.freeze([...this.draft.taskControlStates.values()]);
  }

  // --- 消息（群作用域键，R6）---
  putMessage(message: GroupMessage): void {
    this.draft.messages.set(
      toMessageScopeKey(message.group_id, message.message_id),
      Object.freeze(message),
    );
    this.touched.recordMessage(message.message_id);
  }
  getMessageInGroup(groupId: GroupId, messageId: MessageId): GroupMessage | undefined {
    return this.draft.messages.get(toMessageScopeKey(groupId, messageId));
  }
  hasMessageInGroup(groupId: GroupId, messageId: MessageId): boolean {
    return this.draft.messages.has(toMessageScopeKey(groupId, messageId));
  }
  getMessage(messageId: MessageId): GroupMessage | undefined {
    let found: GroupMessage | undefined;
    for (const message of this.draft.messages.values()) {
      if (message.message_id !== messageId) {
        continue;
      }
      if (found !== undefined) {
        throw new ValidationError(
          `全局查询 getMessage(${messageId}) 有歧义：同一 message_id 出现在多个群组` +
            `（${found.group_id} / ${message.group_id}）。message_id 只在群内唯一（Q1-d），` +
            '请改用 getMessageInGroup(groupId, messageId)',
        );
      }
      found = message;
    }
    return found;
  }
  hasMessage(messageId: MessageId): boolean {
    for (const message of this.draft.messages.values()) {
      if (message.message_id === messageId) {
        return true;
      }
    }
    return false;
  }
  listMessages(): readonly GroupMessage[] {
    return Object.freeze([...this.draft.messages.values()]);
  }

  // --- 收件箱 ---
  appendInboxEntry(entry: InboxEntry): void {
    this.draft.inboxEntries.push(Object.freeze(entry));
    this.touched.recordInstance(entry.instance_id);
  }
  getInbox(instanceId: InstanceId): readonly InboxEntry[] {
    return Object.freeze(this.draft.inboxEntries.filter((entry) => entry.instance_id === instanceId));
  }
  hasInboxEntry(instanceId: InstanceId, messageId: MessageId): boolean {
    return this.draft.inboxEntries.some(
      (entry) => entry.instance_id === instanceId && entry.message_id === messageId,
    );
  }
  listInboxEntries(): readonly InboxEntry[] {
    return Object.freeze([...this.draft.inboxEntries]);
  }

  // --- 已读记录 ---
  appendReadReceipt(receipt: ReadReceipt): void {
    this.draft.readReceipts.push(Object.freeze(receipt));
    this.touched.recordInstance(receipt.instance_id);
  }
  getReadReceipts(instanceId: InstanceId): readonly ReadReceipt[] {
    return Object.freeze(
      this.draft.readReceipts.filter((receipt) => receipt.instance_id === instanceId),
    );
  }
  hasReadReceipt(instanceId: InstanceId, messageId: MessageId): boolean {
    return this.draft.readReceipts.some(
      (receipt) => receipt.instance_id === instanceId && receipt.message_id === messageId,
    );
  }

  // --- 可运行输入标记 ---
  putActionableInput(mark: ActionableInputMark): void {
    this.draft.actionableInputs.set(
      toActionableInputKey(mark.instance_id, mark.ref_id),
      Object.freeze(mark),
    );
    this.touched.recordInstance(mark.instance_id);
  }
  getActionableInputs(instanceId: InstanceId): readonly ActionableInputMark[] {
    return Object.freeze(
      [...this.draft.actionableInputs.values()].filter((mark) => mark.instance_id === instanceId),
    );
  }

  // --- 工作项 ---
  putWorkItem(item: WorkItem): void {
    this.draft.workItems.set(item.request_id, Object.freeze(item));
    this.touched.recordRequest(item.request_id);
  }
  getWorkItem(requestId: RequestId): WorkItem | undefined {
    return this.draft.workItems.get(requestId);
  }
  listWorkItems(): readonly WorkItem[] {
    return Object.freeze([...this.draft.workItems.values()]);
  }

  // --- 实例状态 ---
  putInstance(instance: InstanceState): void {
    this.draft.instances.set(instance.instance_id, Object.freeze(instance));
    this.touched.recordInstance(instance.instance_id);
  }
  getInstance(instanceId: InstanceId): InstanceState | undefined {
    return this.draft.instances.get(instanceId);
  }
  listInstances(): readonly InstanceState[] {
    return Object.freeze([...this.draft.instances.values()]);
  }

  // --- 群成员登记（F07：入口鉴权的成员资格判据）---
  putGroupMember(member: GroupMember): void {
    this.draft.groupMembers.set(
      toGroupMemberKey(member.group_id, member.instance_id),
      Object.freeze(member),
    );
    this.touched.recordInstance(member.instance_id);
  }
  getGroupMember(groupId: GroupId, instanceId: InstanceId): GroupMember | undefined {
    return this.draft.groupMembers.get(toGroupMemberKey(groupId, instanceId));
  }
  listGroupMembers(): readonly GroupMember[] {
    return Object.freeze([...this.draft.groupMembers.values()]);
  }

  // --- 轮次 ---
  putRun(run: RunRecord): void {
    this.draft.runs.set(run.run_id, Object.freeze(run));
    this.touched.recordRun(run.run_id);
    this.touched.recordInstance(run.instance_id);
  }
  getRun(runId: RunId): RunRecord | undefined {
    return this.draft.runs.get(runId);
  }
  getActiveRun(instanceId: InstanceId): RunRecord | undefined {
    for (const run of this.draft.runs.values()) {
      if (run.instance_id === instanceId && run.status === 'running') {
        return run;
      }
    }
    return undefined;
  }
  listRuns(): readonly RunRecord[] {
    return Object.freeze([...this.draft.runs.values()]);
  }

  // --- 待投递事件 ---
  enqueueDeliveryEvent(event: PendingEvent): void {
    this.draft.deliveryEvents.set(event.event_id, Object.freeze(event));
    this.touched.recordEvent(event.event_id);
    this.touched.recordInstance(event.instance_id);
  }
  getDeliveryEvent(eventId: EventId): PendingEvent | undefined {
    return this.draft.deliveryEvents.get(eventId);
  }
  listDeliveryEvents(): readonly PendingEvent[] {
    return Object.freeze([...this.draft.deliveryEvents.values()]);
  }

  // --- 观测事件日志 ---
  appendKernelEvent(event: KernelEvent): void {
    this.draft.kernelEvents.push(Object.freeze(event));
    this.touched.recordEvent(event.event_id);
  }
  listKernelEvents(): readonly KernelEvent[] {
    return Object.freeze([...this.draft.kernelEvents]);
  }

  // --- 产物记录（design-02 A 批）---
  putArtifact(record: ArtifactRecord): void {
    this.draft.artifacts.set(record.artifact_id, Object.freeze(record));
    this.touched.recordArtifact(record.artifact_id);
  }
  getArtifact(artifactId: ArtifactRef): ArtifactRecord | undefined {
    return this.draft.artifacts.get(artifactId);
  }
  listArtifacts(): readonly ArtifactRecord[] {
    return Object.freeze([...this.draft.artifacts.values()]);
  }

  // --- 共享事实记录（design-02 A 批）---
  putSharedFact(record: SharedFactRecord): void {
    this.draft.sharedFacts.set(record.fact_id, Object.freeze(record));
    // 事实按任务 + 版本归属，与产物同理登记到任务上，便于事务摘要追溯。
    this.touched.recordTask(record.task_id);
  }
  getSharedFact(factId: FactRef): SharedFactRecord | undefined {
    return this.draft.sharedFacts.get(factId);
  }
  listSharedFacts(): readonly SharedFactRecord[] {
    return Object.freeze([...this.draft.sharedFacts.values()]);
  }

  // --- 动作台账（FA-S；KRN-07；形状由 `src/workledger` 解释）---
  // 主键读法：`action_id`。写入时记录到任务身份上，使事务摘要能追溯到"这次动作属于哪个任务"
  // （与 `putSharedFact` 同理——否则"动作写了但摘要里看不见"）。
  putActionRecord(record: { readonly action_id: string; readonly task_id: string }): void {
    this.draft.actions.set(record.action_id, Object.freeze(record));
    this.touched.recordTask(record.task_id as TaskId);
  }
  getActionRecord(actionId: string): object | undefined {
    return this.draft.actions.get(actionId);
  }
  listActionRecords(): readonly object[] {
    return Object.freeze([...this.draft.actions.values()]);
  }

  // --- 任务生命周期（FA-S；KRN-09；形状由 `src/scheduler` 解释）---
  putTaskLifecycle(state: { readonly task_id: string }): void {
    this.draft.taskLifecycles.set(state.task_id, Object.freeze(state));
    this.touched.recordTask(state.task_id as TaskId);
  }
  getTaskLifecycle(taskId: string): object | undefined {
    return this.draft.taskLifecycles.get(taskId);
  }
  listTaskLifecycles(): readonly object[] {
    return Object.freeze([...this.draft.taskLifecycles.values()]);
  }
}

/**
 * 快照投影 —— 在 `StoreSnapshot` 之上**追加**两个 FA-S 集合（KRN-07 / KRN-09）。
 *
 * 为什么是"返回更宽的类型"而不是改 `StoreSnapshot`：后者定义在 `src/protocol/storage.ts`，
 * 属总协调独占写权。返回类型更宽是**协变**的（`Store.snapshot(): StoreSnapshot` 照常满足），
 * 因此 `src/storage/memory-store.ts` / `file-store.ts` **零改动**。
 * 读侧要拿这两个集合，走 `src/scheduler/task-action-store.ts` 的适配器。
 */
export type StoreSnapshotWithExtensions = StoreSnapshot & {
  /** 动作台账（FA-S；KRN-07）。 */
  readonly actions: readonly object[];
  /** 任务生命周期（FA-S；KRN-09）。 */
  readonly task_lifecycles: readonly object[];
};

/** 只读快照投影（两个实现共用同一形状，避免读侧口径分叉）。 */
export function snapshotOf(state: StoreState): StoreSnapshotWithExtensions {
  return {
    tasks: Object.freeze([...state.tasks.values()]),
    task_control_states: Object.freeze([...state.taskControlStates.values()]),
    messages: Object.freeze([...state.messages.values()]),
    inbox_entries: Object.freeze([...state.inboxEntries]),
    read_receipts: Object.freeze([...state.readReceipts]),
    actionable_inputs: Object.freeze([...state.actionableInputs.values()]),
    work_items: Object.freeze([...state.workItems.values()]),
    instances: Object.freeze([...state.instances.values()]),
    group_members: Object.freeze([...state.groupMembers.values()]),
    runs: Object.freeze([...state.runs.values()]),
    delivery_events: Object.freeze([...state.deliveryEvents.values()]),
    kernel_events: Object.freeze([...state.kernelEvents]),
    artifacts: Object.freeze([...state.artifacts.values()]),
    shared_facts: Object.freeze([...state.sharedFacts.values()]),
    actions: Object.freeze([...state.actions.values()]),
    task_lifecycles: Object.freeze([...state.taskLifecycles.values()]),
  };
}

/** 标记若干事件已投递（幂等）。返回真正改变状态的条数。 */
export function markDeliveredIn(
  state: StoreState,
  eventIds: readonly EventId[],
  at: LogicalTime,
): number {
  let changed = 0;
  for (const eventId of eventIds) {
    const event = state.deliveryEvents.get(eventId);
    if (event !== undefined && !event.delivered) {
      state.deliveryEvents.set(eventId, markEventDelivered(event, at));
      changed += 1;
    }
  }
  return changed;
}

export function pendingEventsOf(state: StoreState): readonly PendingEvent[] {
  return Object.freeze(undelivered([...state.deliveryEvents.values()]));
}

/**
 * 已持久化状态里出现过的**最大逻辑时间**（R203 的续期锚点）。
 *
 * 用途：重启后宿主必须让逻辑时钟从**不早于**这个值起步。否则时钟回到 0，
 * 重启前签发的租约（`lease_deadline` 是逻辑时间）会重新变成"未过期"，
 * 等于把已随进程死亡而作废的租约**复活**——R203 明文禁止。
 *
 * 覆盖面：轮次（开始/冻结/结束）、观测事件、待投递事件、收件箱与已读记录、任务与工作项。
 *
 * ## **刻意排除 `lease_deadline`**（R203 的关键一处）
 *
 * 租约截止是**未来时刻**，不是"已经发生的事"。若把它算进高水位，重启后时钟会被直接
 * 推到所有截止时刻之上 ⇒ **每一张遗留租约都立刻变成"已过期"** ——
 * 那不是"不复活租约"，而是**凭空烧掉租约**，把"未过期的租约重启后仍能用"（C2 的正例）
 * 变成不可能。所以高水位只取**观测到的时间**；租约是否过期由调度侧用同一个逻辑时间
 * 与各自的 `lease_deadline` 单独判定（见 `src/scheduler/restart.ts`）。
 */
export function logicalTimeHighWater(snapshot: StoreSnapshot): number {
  let max = 0;
  const bump = (value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value;
  };
  for (const run of snapshot.runs) {
    bump(run.started_at);
    bump(run.frozen_at);
    bump(run.finished_at);
  }
  for (const event of snapshot.kernel_events) bump(event.at);
  for (const event of snapshot.delivery_events) {
    bump(event.created_at);
    bump(event.delivered_at);
  }
  for (const entry of snapshot.inbox_entries) bump(entry.received_at);
  for (const receipt of snapshot.read_receipts) bump(receipt.read_at);
  for (const mark of snapshot.actionable_inputs) bump(mark.marked_at);
  for (const task of snapshot.tasks) {
    bump(task.created_at);
    bump(task.updated_at);
  }
  for (const item of snapshot.work_items) {
    bump(item.created_at);
    bump(item.updated_at);
  }
  // FA-S 追加的两个集合：它们同样带**已发生**的逻辑时间戳。
  // 不纳入高水位的话，重启后时钟可能退回到某条动作/生命周期记录之前，
  // 让"已发生的动作"在时间轴上落在未来（R203 要消灭的正是这类倒流）。
  // 参数类型仍是 `StoreSnapshot`（protocol 独占），因此这两个集合按**可选**读取：
  // 手搓快照字面量（既有夹具）没有它们 ⇒ 视为空，不因此抛错。
  const extended = snapshot as StoreSnapshot & {
    readonly actions?: readonly object[];
    readonly task_lifecycles?: readonly object[];
  };
  bumpExtensionTimes(extended.actions ?? [], ['created_at', 'updated_at'], bump);
  bumpExtensionTimes(extended.task_lifecycles ?? [], ['updated_at'], bump);
  return max;
}

/**
 * 从 FA-S 的两个不透明集合里取逻辑时间戳（`store-core` 不认识它们的具体形状，
 * 因此按**键名**保守取值：只认有限数字，其余一律忽略——不猜、不抛）。
 */
function bumpExtensionTimes(
  rows: readonly object[],
  keys: readonly string[],
  bump: (value: number | null | undefined) => void,
): void {
  for (const row of rows) {
    const record = row as Readonly<Record<string, unknown>>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number') {
        bump(value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 状态编解码（落盘用；**不含 I/O**）
// ---------------------------------------------------------------------------

/**
 * 落盘格式版本。**只增不改**：任何字段语义变化都必须换字符串，
 * 让旧文件走"拒绝加载"而不是"悄悄按新语义解释旧数据"。
 */
export const STORE_SCHEMA = 'potbot-kernel-store.v1';

export interface SerializedStoreState {
  readonly schema: string;
  readonly tasks: readonly TaskRecord[];
  readonly task_control_states: readonly TaskControlState[];
  readonly messages: readonly GroupMessage[];
  readonly inbox_entries: readonly InboxEntry[];
  readonly read_receipts: readonly ReadReceipt[];
  readonly actionable_inputs: readonly ActionableInputMark[];
  readonly work_items: readonly WorkItem[];
  readonly instances: readonly InstanceState[];
  readonly group_members: readonly GroupMember[];
  readonly runs: readonly RunRecord[];
  readonly delivery_events: readonly PendingEvent[];
  readonly kernel_events: readonly KernelEvent[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly shared_facts: readonly SharedFactRecord[];
  /**
   * 动作台账（FA-S；KRN-07）。**加法新增**：`schema` 字符串**不动**
   * （`potbot-kernel-store.v1`），旧文件照常加载——见 `decodeStoreState()` 的兼容分支。
   */
  readonly actions: readonly object[];
  /** 任务生命周期（FA-S；KRN-09）。**加法新增**，同上。 */
  readonly task_lifecycles: readonly object[];
}

export function encodeStoreState(state: StoreState): SerializedStoreState {
  return {
    schema: STORE_SCHEMA,
    tasks: [...state.tasks.values()],
    task_control_states: [...state.taskControlStates.values()],
    messages: [...state.messages.values()],
    inbox_entries: [...state.inboxEntries],
    read_receipts: [...state.readReceipts],
    actionable_inputs: [...state.actionableInputs.values()],
    work_items: [...state.workItems.values()],
    instances: [...state.instances.values()],
    group_members: [...state.groupMembers.values()],
    runs: [...state.runs.values()],
    delivery_events: [...state.deliveryEvents.values()],
    kernel_events: [...state.kernelEvents],
    artifacts: [...state.artifacts.values()],
    shared_facts: [...state.sharedFacts.values()],
    actions: [...state.actions.values()],
    task_lifecycles: [...state.taskLifecycles.values()],
  };
}

export type DecodeResult =
  | { readonly ok: true; readonly state: StoreState }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 严格解码：**任何一处不合规就整份拒绝**，不做"丢掉坏条目接着加载"。
 *
 * 为什么严格：`file-store` 是崩溃恢复的落点。若解码时静默丢条目，恢复出来的
 * 就是一份**看起来成功、实际缺件**的状态——那比"读不回来"危险得多（R216/R220）。
 */
export function decodeStoreState(raw: unknown): DecodeResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: '落盘状态不是对象' };
  }
  if (raw['schema'] !== STORE_SCHEMA) {
    return {
      ok: false,
      reason: `落盘状态 schema 不匹配：期望 ${STORE_SCHEMA}，实际 ${JSON.stringify(raw['schema'])}`,
    };
  }

  const fields = [
    'tasks',
    'task_control_states',
    'messages',
    'inbox_entries',
    'read_receipts',
    'actionable_inputs',
    'work_items',
    'instances',
    'group_members',
    'runs',
    'delivery_events',
    'kernel_events',
    'artifacts',
    'shared_facts',
  ] as const;

  for (const field of fields) {
    if (!Array.isArray(raw[field])) {
      return { ok: false, reason: `落盘状态字段 ${field} 不是数组` };
    }
  }

  const state = emptyState();
  const rows = (field: (typeof fields)[number]): readonly Record<string, unknown>[] =>
    raw[field] as readonly Record<string, unknown>[];

  const requireKey = (
    row: unknown,
    field: string,
    key: string,
  ): string | { readonly bad: string } => {
    if (!isRecord(row) || typeof row[key] !== 'string' || row[key] === '') {
      return { bad: `落盘状态 ${field} 里有一条记录缺少字符串主键 ${key}` };
    }
    return row[key] as string;
  };

  // --- 直接以标识为主键的集合 ---
  const simple: readonly [ (typeof fields)[number], string, Map<string, unknown> ][] = [
    ['tasks', 'task_id', state.tasks as Map<string, unknown>],
    ['task_control_states', 'task_id', state.taskControlStates as Map<string, unknown>],
    ['work_items', 'request_id', state.workItems as Map<string, unknown>],
    ['instances', 'instance_id', state.instances as Map<string, unknown>],
    ['runs', 'run_id', state.runs as Map<string, unknown>],
    ['delivery_events', 'event_id', state.deliveryEvents as Map<string, unknown>],
    ['artifacts', 'artifact_id', state.artifacts as Map<string, unknown>],
    ['shared_facts', 'fact_id', state.sharedFacts as Map<string, unknown>],
  ];
  for (const [field, key, target] of simple) {
    for (const row of rows(field)) {
      const got = requireKey(row, field, key);
      if (typeof got !== 'string') return { ok: false, reason: got.bad };
      target.set(got, Object.freeze(row));
    }
  }

  // --- 复合主键的集合（键必须经与写入路径**同一**的归一化函数生成）---
  for (const row of rows('messages')) {
    const groupId = requireKey(row, 'messages', 'group_id');
    if (typeof groupId !== 'string') return { ok: false, reason: groupId.bad };
    const messageId = requireKey(row, 'messages', 'message_id');
    if (typeof messageId !== 'string') return { ok: false, reason: messageId.bad };
    state.messages.set(
      toMessageScopeKey(groupId as GroupId, messageId as MessageId),
      Object.freeze(row) as unknown as GroupMessage,
    );
  }
  for (const row of rows('actionable_inputs')) {
    const instanceId = requireKey(row, 'actionable_inputs', 'instance_id');
    if (typeof instanceId !== 'string') return { ok: false, reason: instanceId.bad };
    const refId = requireKey(row, 'actionable_inputs', 'ref_id');
    if (typeof refId !== 'string') return { ok: false, reason: refId.bad };
    state.actionableInputs.set(
      toActionableInputKey(instanceId as InstanceId, refId),
      Object.freeze(row) as unknown as ActionableInputMark,
    );
  }
  for (const row of rows('group_members')) {
    const groupId = requireKey(row, 'group_members', 'group_id');
    if (typeof groupId !== 'string') return { ok: false, reason: groupId.bad };
    const instanceId = requireKey(row, 'group_members', 'instance_id');
    if (typeof instanceId !== 'string') return { ok: false, reason: instanceId.bad };
    state.groupMembers.set(
      toGroupMemberKey(groupId as GroupId, instanceId as InstanceId),
      Object.freeze(row) as unknown as GroupMember,
    );
  }

  // --- 顺序敏感的追加式日志（顺序即语义：收件箱 / 已读 / 观测事件）---
  for (const row of rows('inbox_entries')) state.inboxEntries.push(Object.freeze(row) as never);
  for (const row of rows('read_receipts')) state.readReceipts.push(Object.freeze(row) as never);
  for (const row of rows('kernel_events')) state.kernelEvents.push(Object.freeze(row) as never);

  // --- FA-S 追加的两个集合（动作台账 / 任务生命周期）---
  //
  // **唯一的一处"缺失即空"**（其余 14 个字段仍然是"缺一即整份拒绝"，上面的 `fields` 未变）。
  // 为什么这里放宽：这两个集合是 FA-S 的**加法**，而 `schema` 字符串按总协调的要求**不动**
  // （`potbot-kernel-store.v1`）——那么"改造前写下的旧 `store.json`"必然没有这两个字段。
  // 若按 `fields` 的严格口径处理，旧文件会**整份拒绝加载**，等于把"加法"变成"破坏性变更"。
  // 因此：**字段缺失 ⇒ 空集合**；字段存在但不是数组 ⇒ 仍然整份拒绝（不静默丢坏数据）。
  // 这条放宽由 `src/storage/store-core.compat.test.ts` 的兼容性用例守着（含反向对照：
  // 去掉 `tasks` 仍必须整份拒绝——证明放宽**只**限于这两个新字段）。
  const extensionCollections: readonly [string, Map<string, object>, string][] = [
    ['actions', state.actions, 'action_id'],
    ['task_lifecycles', state.taskLifecycles, 'task_id'],
  ];
  for (const [field, target, key] of extensionCollections) {
    const value: unknown = raw[field];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      return { ok: false, reason: `落盘状态字段 ${field} 不是数组` };
    }
    for (const row of value as readonly unknown[]) {
      const got = requireKey(row, field, key);
      if (typeof got !== 'string') return { ok: false, reason: got.bad };
      target.set(got, Object.freeze(row as Record<string, unknown>) as object);
    }
  }

  return { ok: true, state };
}
