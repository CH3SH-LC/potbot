/**
 * `src/scheduler` 单测共用的**测试夹具**（不对外导出，不在 `index.ts` 里登记）。
 *
 * 只做三件事：造存储、造实例/任务、按脚本造并投递消息。它**不模拟内核**
 * （不写工作项、不置排队标记、不启动轮次）——那些必须经被测代码走。
 */

import {
  createGroupMember,
  createIdSource,
  createInstanceState,
  createMessage,
  createTaskRecord,
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  SenderBinding,
  type ArtifactRef,
  type GroupId,
  type GroupMessage,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type MessageType,
  type RequestId,
  type Revision,
  type StorageTransaction,
  type TaskId,
  type TrustLabel,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';
import { createScheduler, type Scheduler, type SchedulerOptions } from './scheduler.js';

export const TASK_ID: TaskId = asTaskId('T1');
export const GROUP_ID: GroupId = asGroupId('G1');
export const INSTANCE_C: InstanceId = asInstanceId('C');
export const SENDER_S1: InstanceId = asInstanceId('S1');
export const SENDER_S2: InstanceId = asInstanceId('S2');
export const SENDER_S3: InstanceId = asInstanceId('S3');
export const SENDER_S4: InstanceId = asInstanceId('S4');
export const BASELINE_REVISION: Revision = asRevision(1);

export function instanceId(value: string): InstanceId {
  return asInstanceId(value);
}

export function requestId(value: string): RequestId {
  return asRequestId(value);
}

export function messageId(value: string): MessageId {
  return asMessageId(value);
}

export function taskId(value: string): TaskId {
  return asTaskId(value);
}

/** 造一个空存储（可选注入逻辑时钟）。 */
export function buildStore(clock?: () => LogicalTime) {
  return createMemoryStore(clock === undefined ? {} : { clock });
}

/** 造调度器（确定性 id 源 + 可注入时钟）。id 形如 `run-1` / `msg-1`（Q8-c：固定顺序）。 */
export function buildScheduler(
  store: ReturnType<typeof buildStore>,
  options: SchedulerOptions = {},
): Scheduler {
  return createScheduler(store, { idSource: createIdSource(), ...options });
}

/**
 * 群内**标准发送成员**（合同 v1.2 R35.2 第 4 项：发送者必须是本群已注册实例）。
 *
 * 为什么夹具要注册它们：旧入口只检查"sender 是非空字符串"，S1…S4 可以是**未注册**的标识；
 * 修复后成员资格是硬判据，夹具必须给出合法的发送成员——**不得为了保持旧夹具不变而跳过注册**。
 * 它们是"同群其他成员"，注册后 `advanceOnce` 仍只会挑有可运行输入的实例（它们没有输入），
 * 因此不影响 A02/A03 的轮次计数。
 */
export const DEFAULT_SENDER_IDS: readonly InstanceId[] = Object.freeze([
  SENDER_S1,
  SENDER_S2,
  SENDER_S3,
  SENDER_S4,
]);

/**
 * 注册一个空闲实例；默认同时把该群的标准发送成员登记进**成员表**（`withSenders: false` 可关）。
 *
 * 注意成员表 ≠ 实例表（`src/protocol/membership.ts`）：登记成员**不会**改变
 * `instances` 的数量与 `advanceOnce` 的候选集合，因此 A02/A03 等场景的实例计数断言不受影响。
 */
export function registerInstance(
  store: ReturnType<typeof buildStore>,
  id: InstanceId = INSTANCE_C,
  group: GroupId = GROUP_ID,
  at: LogicalTime = asLogicalTime(0),
  options: { readonly withSenders?: boolean } = {},
): void {
  store.transact((tx) => {
    tx.putInstance(
      createInstanceState({
        instance_id: id,
        group_id: group,
        updated_at: at,
      }),
    );
    if (options.withSenders !== false) {
      registerMembersInTx(tx, group, at);
    }
  });
}

/** 在同一事务内登记标准发送成员（只写成员表，不写实例表）。 */
function registerMembersInTx(tx: StorageTransaction, group: GroupId, at: LogicalTime): void {
  for (const memberId of DEFAULT_SENDER_IDS) {
    tx.putGroupMember(createGroupMember({ group_id: group, instance_id: memberId, registered_at: at }));
  }
}

/** 单独登记一个群成员（负向用例：错群身份时要显式控制登记内容）。 */
export function registerMember(
  store: ReturnType<typeof buildStore>,
  instanceId: InstanceId,
  group: GroupId = GROUP_ID,
  at: LogicalTime = asLogicalTime(0),
): void {
  store.transact((tx) => {
    tx.putGroupMember(createGroupMember({ group_id: group, instance_id: instanceId, registered_at: at }));
  });
}

/** 注册任务（用于 Q1-b 的版本判定与 P7 的 stale 构造）。 */
export function registerTask(
  store: ReturnType<typeof buildStore>,
  options: {
    readonly task_id?: TaskId;
    readonly group_id?: GroupId;
    readonly revision?: Revision;
    readonly at?: LogicalTime;
  } = {},
): void {
  const at = options.at ?? asLogicalTime(0);
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: options.task_id ?? TASK_ID,
        goal: 'D03 单测目标',
        current_group_id: options.group_id ?? GROUP_ID,
        revision: options.revision ?? BASELINE_REVISION,
        created_at: at,
        updated_at: at,
      }),
    );
  });
}

export interface MessageSpec {
  readonly message_id: MessageId;
  readonly request_id?: RequestId;
  readonly reply_to?: RequestId;
  readonly sender_instance_id?: InstanceId;
  readonly recipient_instance_id?: InstanceId;
  readonly group_id?: GroupId;
  readonly task_id?: TaskId;
  readonly task_revision?: Revision;
  readonly type?: MessageType;
  readonly requires_wakeup?: boolean;
  readonly content?: string;
  readonly trust_label?: TrustLabel;
  readonly artifact_refs?: readonly ArtifactRef[];
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly at?: LogicalTime;
}

/** 按脚本造一条内核绑定的群消息（发送者经 `SenderBinding`，草稿里没有 sender 字段）。 */
export function buildMessage(spec: MessageSpec): GroupMessage {
  const group = spec.group_id ?? GROUP_ID;
  const task = spec.task_id ?? TASK_ID;
  // 绑定携带 (sender, group, task) 三元组，且与消息草稿必须同源（合同 v1.2 R35.2）。
  const binding = SenderBinding.bind(spec.sender_instance_id ?? SENDER_S1, {
    group_id: group,
    task_id: task,
  });
  return createMessage(
    {
      message_id: spec.message_id,
      task_id: task,
      group_id: group,
      task_revision: spec.task_revision ?? BASELINE_REVISION,
      recipient_instance_id: spec.recipient_instance_id ?? INSTANCE_C,
      type: spec.type ?? 'work_request',
      ...(spec.request_id === undefined ? {} : { request_id: spec.request_id }),
      ...(spec.reply_to === undefined ? {} : { reply_to: spec.reply_to }),
      requires_wakeup: spec.requires_wakeup ?? true,
      payload: { content: spec.content ?? `工作 ${String(spec.request_id ?? spec.message_id)}`, ...(spec.payload ?? {}) },
      ...(spec.artifact_refs === undefined ? {} : { artifact_refs: spec.artifact_refs }),
      ...(spec.trust_label === undefined ? {} : { trust_label: spec.trust_label }),
      ...(spec.at === undefined ? {} : { created_at: spec.at }),
    },
    binding,
    { idSource: createIdSource() },
  );
}

/** 造一条工作请求消息（A02/A03 的常规形状）。 */
export function workRequest(
  n: number,
  overrides: Partial<MessageSpec> = {},
): GroupMessage {
  return buildMessage({
    message_id: messageId(`m-${n}`),
    request_id: requestId(`r-${n}`),
    type: 'work_request',
    requires_wakeup: true,
    content: `独立工作 j${n}`,
    ...overrides,
  });
}

/** 结果产物引用（首轮不产出真实文件）。 */
export function resultRef(request: RequestId): ArtifactRef {
  return asArtifactRef(`${request}#result`);
}

/** 只读统计（断言只经快照读取，不窥探内部内存）。 */
export interface SnapshotFacts {
  readonly inbox_message_ids: readonly MessageId[];
  readonly unique_inbox_message_ids: readonly MessageId[];
  readonly work_items: readonly {
    readonly request_id: RequestId;
    readonly status: string;
    readonly owner: InstanceId;
    readonly result_refs: readonly ArtifactRef[];
  }[];
  readonly runs: readonly { readonly run_id: string; readonly status: string }[];
  readonly kernel_event_kinds: readonly string[];
  readonly pending_delivery_event_kinds: readonly string[];
  readonly active_run_ids: readonly (string | null)[];
  readonly queued_flags: readonly boolean[];
}

export function factsOf(scheduler: Scheduler): SnapshotFacts {
  const snapshot = scheduler.snapshot();
  const inboxIds = snapshot.inbox_entries.map((entry) => entry.message_id);
  return {
    inbox_message_ids: Object.freeze(inboxIds),
    unique_inbox_message_ids: Object.freeze([...new Set(inboxIds)]),
    work_items: Object.freeze(
      snapshot.work_items.map((item) => ({
        request_id: item.request_id,
        status: item.status,
        owner: item.owner_instance_id,
        result_refs: item.result_refs,
      })),
    ),
    runs: Object.freeze(snapshot.runs.map((run) => ({ run_id: run.run_id, status: run.status }))),
    kernel_event_kinds: Object.freeze(snapshot.kernel_events.map((event) => event.kind)),
    pending_delivery_event_kinds: Object.freeze(
      scheduler.pendingDeliveryEvents().map((event) => event.kind),
    ),
    active_run_ids: Object.freeze(snapshot.instances.map((instance) => instance.active_run_id)),
    queued_flags: Object.freeze(snapshot.instances.map((instance) => instance.queued_flag)),
  };
}

/** 数某类观测事件出现的次数。 */
export function countEvents(scheduler: Scheduler, kind: string): number {
  return scheduler.kernelEvents().filter((event) => event.kind === kind).length;
}

/** 只读事务包装（测试里读实例/工作项时用；避免直接碰私有内存）。 */
export function readTx<T>(store: ReturnType<typeof buildStore>, work: (tx: StorageTransaction) => T): T {
  return store.transact(work);
}
