/**
 * 存储合同（合同 §五 Q6-b/Q6-d、§六 Q8-a、§七 Q10-c；guide:88）。
 *
 * 唯一硬底线（合同 §九-1）：**收件箱写入 + 适用的工作项变更 + 待投递事件一致提交**。
 * 本模块用 outbox 式实现该底线：三者写在同一事务里，事务提交后才发布事件，
 * 发布成功才标记已投递；恢复时重放未投递事件。
 *
 * 约定：
 * - **只有 `Store.transact()` 是写入通道**；读取走 `Store.snapshot()`（只读视图）。
 * - `transact()` 失败必须让调用方区分"未接受"（`PersistenceError`）与
 *   "已接受但事件未投递"（`PublicationError`）。
 * - 存储**不实现去重策略**（归 D02）：消息以**群作用域键**（group + message_id）存储，
 *   "重复送达返回什么"由 D02 在事务内先查 `hasMessageInGroup()` 决定（R6）。
 * - 取消与需求更新经 `putTaskControlState()` 与对应消息**同一事务**写入（Q6-c / B4）。
 * - 存储**不推进时间**（Q8-a）：需要时间的写入一律从注入的 clock 读取。
 * - 接缝（Q10-c）：`faults` 默认关闭，仅在隔离测试配置启用，不破坏生产源码。
 */

import type {
  ArtifactRef,
  EventId,
  FactRef,
  GroupId,
  InstanceId,
  LogicalTime,
  MessageId,
  RequestId,
  RunId,
  TaskId,
} from './ids.js';
import type { ArtifactRecord } from './artifact.js';
import type { SharedFactRecord } from './facts.js';
import type { GroupMessage } from './message.js';
import type { TaskControlState } from './task-control.js';
import type { TaskRecord } from './task.js';
import type { WorkItem } from './work-item.js';
import type { InstanceState } from './instance.js';
import type { GroupMember } from './membership.js';
import type { RunRecord } from './run.js';
import type { ActionableInputMark, InboxEntry, ReadReceipt } from './inbox.js';
import type { KernelEvent, PendingEvent } from './events.js';

/** 一次事务内触及的记录标识汇总（故障注入与诊断读）。 */
export interface TransactionSummary {
  readonly task_ids: readonly TaskId[];
  readonly message_ids: readonly MessageId[];
  readonly request_ids: readonly RequestId[];
  readonly instance_ids: readonly InstanceId[];
  readonly run_ids: readonly RunId[];
  readonly event_ids: readonly EventId[];
  /**
   * 本次事务触及的产物 id（design-02 A 批**加法**新增，追加到末尾）。
   * 既有 6 个字段的名称、口径与顺序**均未改动**（计数口径见 `counters.ts`）。
   */
  readonly artifact_ids: readonly ArtifactRef[];
}

/**
 * 事务内的读写句柄。
 * 事务提交前，外部（`Store.snapshot()`）**看不到**任何改动；事务抛错则全部丢弃。
 */
export interface StorageTransaction {
  // --- 任务 ---
  putTask(task: TaskRecord): void;
  getTask(taskId: TaskId): TaskRecord | undefined;
  listTasks(): readonly TaskRecord[];

  // --- 任务控制状态（取消 / 需求更新优先落点；B4。与对应消息同事务写入）---
  putTaskControlState(state: TaskControlState): void;
  getTaskControlState(taskId: TaskId): TaskControlState | undefined;
  listTaskControlStates(): readonly TaskControlState[];

  // --- 消息（先可靠保存，再决定入队）---
  putMessage(message: GroupMessage): void;
  /**
   * **群作用域**查询（R6；去重判定的唯一读口，D02 必须用这一对）。
   * 与 `hasMessage/getMessage` 的区别：后者是**全局**查询、表达不了"群内唯一"。
   */
  getMessageInGroup(groupId: GroupId, messageId: MessageId): GroupMessage | undefined;
  hasMessageInGroup(groupId: GroupId, messageId: MessageId): boolean;
  /**
   * **全局**查询（旧签名，语义见实现注释）：`message_id` 在首版群内唯一，
   * 同一 id 出现在多个群（合法）时本查询有歧义，调用方应改用 `getMessageInGroup`。
   */
  getMessage(messageId: MessageId): GroupMessage | undefined;
  hasMessage(messageId: MessageId): boolean;
  listMessages(): readonly GroupMessage[];

  // --- 收件箱 ---
  appendInboxEntry(entry: InboxEntry): void;
  getInbox(instanceId: InstanceId): readonly InboxEntry[];
  hasInboxEntry(instanceId: InstanceId, messageId: MessageId): boolean;
  listInboxEntries(): readonly InboxEntry[];

  // --- 已读记录（≠ 已完成）---
  appendReadReceipt(receipt: ReadReceipt): void;
  getReadReceipts(instanceId: InstanceId): readonly ReadReceipt[];
  hasReadReceipt(instanceId: InstanceId, messageId: MessageId): boolean;

  // --- 可运行输入标记（依赖解除，Q5-c）---
  putActionableInput(mark: ActionableInputMark): void;
  getActionableInputs(instanceId: InstanceId): readonly ActionableInputMark[];

  // --- 工作项（工作承诺表）---
  putWorkItem(item: WorkItem): void;
  getWorkItem(requestId: RequestId): WorkItem | undefined;
  listWorkItems(): readonly WorkItem[];

  // --- 实例状态 ---
  putInstance(instance: InstanceState): void;
  getInstance(instanceId: InstanceId): InstanceState | undefined;
  listInstances(): readonly InstanceState[];

  // --- 群成员登记（入口鉴权的成员资格判据；R35.2 第 4 项）---
  // 与 `InstanceState` 分开：成员资格不参与任何调度判定，登记它不得改变
  // `instances` 的观测口径（见 `membership.ts` 的说明）。
  putGroupMember(member: GroupMember): void;
  getGroupMember(groupId: GroupId, instanceId: InstanceId): GroupMember | undefined;
  listGroupMembers(): readonly GroupMember[];

  // --- 运行轮次（run_id + 有限租约）---
  putRun(run: RunRecord): void;
  getRun(runId: RunId): RunRecord | undefined;
  getActiveRun(instanceId: InstanceId): RunRecord | undefined;
  listRuns(): readonly RunRecord[];

  // --- 待投递事件（outbox；与上面各项同事务写入）---
  enqueueDeliveryEvent(event: PendingEvent): void;
  getDeliveryEvent(eventId: EventId): PendingEvent | undefined;
  listDeliveryEvents(): readonly PendingEvent[];

  // --- 观测事件日志（append-only）---
  appendKernelEvent(event: KernelEvent): void;
  listKernelEvents(): readonly KernelEvent[];

  // --- 产物记录（design-02 A 批；与 `ArtifactRef` 并列的载体记录）---
  // 与 `TaskRecord.artifact_refs` 分开：后者是"占位引用"，能否当"已交付"取决于
  // 本集合里是否存在 `status === 'published'` 的记录（见 `artifact.ts` 的读侧约定）。
  putArtifact(record: ArtifactRecord): void;
  getArtifact(artifactId: ArtifactRef): ArtifactRecord | undefined;
  listArtifacts(): readonly ArtifactRecord[];

  // --- 共享事实记录（design-02 A 批；P3 单一来源的落点）---
  putSharedFact(record: SharedFactRecord): void;
  getSharedFact(factId: FactRef): SharedFactRecord | undefined;
  listSharedFacts(): readonly SharedFactRecord[];
}

/** 只读快照：断言与驱动读取**只能**经此接口，不得窥探内核内部内存。 */
export interface StoreSnapshot {
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
  /**
   * 产物记录（design-02 A 批，**加法**）。
   *
   * **必填**：快照是"某一时刻的全部集合"，缺项会让读者以为"可能没有"而悄悄绕过
   * ——那正是 G04（"未登记 = 可放行"）那一类陷阱的同型。两处手搓快照字面量的夹具
   * （`counters.test.ts` 的 `snapshotWith`、`fake/assertions.test.ts` 的 `snapshotOf`）
   * 因此各补两个空数组：那是**跟随 schema**，不是放宽断言。
   */
  readonly artifacts: readonly ArtifactRecord[];
  /** 共享事实记录（design-02 A 批，**加法**）。 */
  readonly shared_facts: readonly SharedFactRecord[];
}

/** 待投递事件的发布处理器（D03 的调度推进入口；存储只负责顺序与投递标记）。 */
export type DeliveryHandler = (event: PendingEvent) => void;

/**
 * 可注入的故障接缝（Q10-c）。**默认全部未设置**（关闭），只在隔离测试配置里赋值。
 * 三个钩子对应验收规格 0.3 的三个注入点：
 * 1. `beforeCommit`      —— "消息持久化提交"之前；
 * 2. `afterCommitBeforePublish` —— "调度事件提交"之后、"向执行队列投递"之前（P2 的故障窗口）；
 * 3. `beforePublishEvent` —— 逐条事件投递之前。
 */
export interface MutableStoreFaultHooks {
  beforeCommit?: (summary: TransactionSummary, tx: StorageTransaction) => void;
  afterCommitBeforePublish?: (summary: TransactionSummary) => void;
  beforePublishEvent?: (event: PendingEvent) => void;
}

export interface StoreOptions {
  /** 逻辑时钟读取口（Q8-a：内核只读 now()，存储不自行推进时间）。默认恒为 0。 */
  readonly clock?: () => LogicalTime;
  /** 故障注入接缝（默认关闭）。 */
  readonly faults?: MutableStoreFaultHooks;
}

export interface Store {
  /**
   * 原子事务：`work` 全部成功则一并提交；抛错则**全部不生效**并抛 `PersistenceError`
   * （`accepted === false`，调用方不得报告消息已接受）。
   *
   * 事务提交后、投递前若命中 `afterCommitBeforePublish` 接缝而失败，抛
   * `PublicationError`（`accepted === true`，可用 `replayUndelivered()` 恢复）。
   */
  transact<T>(work: (tx: StorageTransaction) => T): T;

  /** 只读快照。 */
  snapshot(): StoreSnapshot;

  /** 当前未投递的事件（按写入顺序）。 */
  pendingDeliveryEvents(): readonly PendingEvent[];

  /** 标记指定事件已投递（幂等）。返回本次真正改变状态的事件条数。 */
  markDelivered(eventIds: readonly EventId[], at?: LogicalTime): number;

  /** 发布全部未投递事件：逐条 handler → 标记已投递。任一环失败抛 `PublicationError`。 */
  publishPending(handler: DeliveryHandler): readonly PendingEvent[];

  /** 重放未投递事件（Q6-b 的恢复路径）。与 `publishPending` 同义，语义上强调"恢复"。 */
  replayUndelivered(handler: DeliveryHandler): readonly PendingEvent[];

  /** 故障注入接缝（仅隔离测试配置启用）。 */
  readonly faults: MutableStoreFaultHooks;

  /** 清空全部状态（隔离场景用；不影响故障接缝配置）。 */
  reset(): void;
}

/** 读取快照中某个实例的收件箱（便捷函数，纯查询）。 */
export function snapshotInboxOf(snapshot: StoreSnapshot, instanceId: InstanceId): readonly InboxEntry[] {
  return snapshot.inbox_entries.filter((entry) => entry.instance_id === instanceId);
}

/** 读取快照中某个群组的消息（便捷函数，纯查询）。 */
export function snapshotMessagesOfGroup(
  snapshot: StoreSnapshot,
  groupId: GroupId,
): readonly GroupMessage[] {
  return snapshot.messages.filter((message) => message.group_id === groupId);
}

/**
 * 归一化读取快照里的产物记录（`undefined` 视为空，仅发生在手搓的纯函数测试字面量上）。
 * design-02 A 批的读侧请统一走本函数。
 */
export function snapshotArtifacts(snapshot: StoreSnapshot): readonly ArtifactRecord[] {
  return snapshot.artifacts ?? [];
}

/** 归一化读取快照里的共享事实记录（理由同 `snapshotArtifacts`）。 */
export function snapshotSharedFacts(snapshot: StoreSnapshot): readonly SharedFactRecord[] {
  return snapshot.shared_facts ?? [];
}
