/**
 * KRN-02：**消息先可靠保存，再投递 / 唤醒**；收件箱、读回执、工作承诺**分别记录**；
 * **重复 `messageId` 不重复建工作**。
 *
 * ## 与既有模块的关系
 *
 * 真实存储路径上的可靠保存 + 去重已在 `src/inbox/delivery.ts` 落地（`deliverToInbox`），
 * 它的纪律是"**先判重再写入**"（`dedup.ts` 的 D-1：`putMessage` 是覆盖语义，重复写入会
 * **改写**首条到达的消息）。本模块把同一条纪律表达为**可独立验证的顺序状态机**：
 * 三次交付尝试落成三个阶段（`saved` → `delivered` → `woken`），阶段的先后**可断言**，
 * 而不必依赖持久介质。
 *
 * 为什么不直接复用 `deliverToInbox`：它按设计需要 `Store` / `StorageTransaction`
 * （落盘、事务回滚、outbox）。KRN-02 的判据里有一半是**顺序与分离**（"先保存再唤醒"、
 * "已读 ≠ 已完成"），这些在没有持久介质时也应能被独立验证；本模块提供的是
 * **纯内存的顺序模型**，语义与 `deliverToInbox` 一致而**不替代**它。
 *
 * ## 三条被冻结的语义
 *
 * 1. **先保存，再投递/唤醒**（合同 §九-1 第一条）：三个阶段严格有序；
 *    `onSaved` 抛错 ⇒ **保存失败 ⇒ 不投递、不唤醒**（终态是"什么都没发生"）；
 *    `onDelivered` / `onWakeup` 抛错 ⇒ 消息**仍然已保存**，且仍留在待唤醒队列里
 *    （可重试）——**不允许**出现"唤醒失败导致消息丢失"。
 * 2. **三组记录各自独立**（合同 §九-5）：收件箱条目、读回执、工作承诺是三张互不推导的表。
 *    "已读"不意味着"已建工作"；"已建工作"也不意味着"已读"。
 * 3. **群内去重**（Q1-d / Q3-b / Q3-c）：重复 `messageId`（同群）⇒ 不重复建工作、
 *    **不改写首条内容**；内容相同但 id 不同 ⇒ **分别保留**（去重只看 id，绝不比内容）；
 *    同一 id 在**另一个群**⇒ 不是重复（群作用域）。
 *
 * ## 纪律与边界
 *
 * - 纯函数 + 不可变记录；时间以 `LogicalTime` 传入（无墙钟 / 无随机）。
 * - 副作用经**注入的 sink**（`InboxSideEffectSink`）表达，便于验证顺序与注入失败；
 *   生产路径的副作用仍是 `src/inbox` + outbox，本模块**不**做持久化。
 * - 本模块是**进程内状态机**：它证明的是顺序与分离语义，**不证明**跨进程持久性
 *   （跨进程恢复需要真实持久介质，未在本模块与本次测试范围内验证）。
 */

import {
  toMessageScopeKey,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type RunId,
  type TaskId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 记录（三张互不推导的表 + 一张消息表）
// ---------------------------------------------------------------------------

/** 已可靠保存的消息正文记录（**首次到达的那一份**，重复送达不得改写它）。 */
export interface StoredMessage {
  readonly message_id: MessageId;
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly sender_instance_id: InstanceId;
  readonly recipient_instance_id: InstanceId;
  /** 该消息携带的工作请求（无则 null）。 */
  readonly request_id: RequestId | null;
  readonly requires_wakeup: boolean;
  /** 正文（用于验证"重复送达不改写首条"）。 */
  readonly body: string;
  readonly created_at: LogicalTime;
}

/** 收件箱条目：消息"已保存到该实例收件箱"的落地记录。 */
export interface InboxEntry {
  readonly message_id: MessageId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly task_id: TaskId;
  /** 该实例收件箱内的到达序号（插入序）。 */
  readonly sequence: number;
  readonly received_at: LogicalTime;
  readonly requires_wakeup: boolean;
}

/** 读回执：读取即标记。**与工作承诺是两张表**（合同 §九-5）。 */
export interface ReadReceipt {
  readonly message_id: MessageId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly run_id: RunId;
  readonly read_at: LogicalTime;
}

/** 工作承诺：由消息携带的工作请求产生的**未完成工作**（与"已读"分开记录）。 */
export interface WorkCommitment {
  readonly request_id: RequestId;
  readonly message_id: MessageId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly committed_at: LogicalTime;
  /** 幂等来源：由哪条消息建立（重复 messageId 不产生第二条）。 */
  readonly created_by_message_id: MessageId;
}

/** 交付阶段（严格有序）。 */
export const INBOX_PHASES = ['saved', 'delivered', 'woken', 'read'] as const;
export type InboxPhase = (typeof INBOX_PHASES)[number];

export interface PhaseLogEntry {
  readonly message_id: MessageId;
  /** 全局单调序号（跨消息也保序，便于直接断言先后）。 */
  readonly sequence: number;
  readonly phase: InboxPhase;
  readonly at: LogicalTime;
}

export interface InboxState {
  /** 消息表，键 = 群作用域键（群内唯一）。 */
  readonly messages: Readonly<Record<string, StoredMessage>>;
  /** 收件箱条目表，键 = 群作用域键。 */
  readonly entries: Readonly<Record<string, InboxEntry>>;
  /** 读回执表（独立于工作承诺）。 */
  readonly read_receipts: readonly ReadReceipt[];
  /** 工作承诺表（独立于读回执）。 */
  readonly commitments: readonly WorkCommitment[];
  /** 阶段日志：顺序证据。 */
  readonly phase_log: readonly PhaseLogEntry[];
  /** 已保存但**尚未确认唤醒**的消息（outbox 视角；重试的入口）。 */
  readonly pending_wakeups: readonly MessageId[];
}

export function createEmptyInboxState(): InboxState {
  return Object.freeze({
    messages: Object.freeze({}),
    entries: Object.freeze({}),
    read_receipts: Object.freeze([]),
    commitments: Object.freeze([]),
    phase_log: Object.freeze([]),
    pending_wakeups: Object.freeze([]),
  });
}

/** 群作用域键（**群内唯一**；同一 id 在不同群是两条不同消息，Q1-d / Q3-b）。 */
export function inboxScopeKey(groupId: GroupId, messageId: MessageId): string {
  return toMessageScopeKey(groupId, messageId);
}

// ---------------------------------------------------------------------------
// 注入的副作用口（用于验证顺序 / 注入失败）
// ---------------------------------------------------------------------------

/**
 * 副作用口。三个回调**按 saved → delivered → woken 的顺序**被调用；
 * 任一抛错都在 `acceptMessage()` 的结果上如实体现（不吞掉、不假装成功）。
 */
export interface InboxSideEffectSink {
  readonly onSaved?: (message: StoredMessage) => void;
  readonly onDelivered?: (entry: InboxEntry) => void;
  readonly onWakeup?: (messageId: MessageId) => void;
}

// ---------------------------------------------------------------------------
// 接受一条消息
// ---------------------------------------------------------------------------

export interface AcceptMessageInput {
  readonly message: StoredMessage;
  readonly at: LogicalTime;
}

export interface AcceptMessageOutcome {
  readonly state: InboxState;
  readonly result: 'accepted' | 'duplicate_not_created';
  /** 首次接受时的收件箱条目。 */
  readonly entry: InboxEntry | null;
  /** 本次新建的工作承诺（重复送达 / 无 request_id 时为 null）。 */
  readonly work_commitment: WorkCommitment | null;
  readonly duplicate_of: MessageId | null;
  /**
   * 重复送达且**内容不同** ⇒ true：首条内容被保留，本次送达被如实判为"内容冲突的重复"。
   * （这是"重复不得改写首条"的可观测证据。）
   */
  readonly content_conflict: boolean;
  /** 本次调用写入的阶段（按发生顺序）。 */
  readonly phases: readonly InboxPhase[];
  /** 投递是否成功（`onDelivered` 抛错 ⇒ false）。 */
  readonly delivered: boolean;
  /** 唤醒是否成功（不需要唤醒时为 false 但 `wakeup_required` 为 false）。 */
  readonly woken: boolean;
  readonly wakeup_required: boolean;
}

function nextSequenceOf(state: InboxState, instanceId: InstanceId): number {
  let max = 0;
  for (const entry of Object.values(state.entries)) {
    if (entry.instance_id === instanceId && entry.sequence > max) {
      max = entry.sequence;
    }
  }
  return max + 1;
}

function nextPhaseSequence(state: InboxState): number {
  const last = state.phase_log[state.phase_log.length - 1];
  return last === undefined ? 1 : last.sequence + 1;
}

function appendPhase(
  state: InboxState,
  messageId: MessageId,
  phase: InboxPhase,
  at: LogicalTime,
): InboxState {
  const entry: PhaseLogEntry = Object.freeze({
    message_id: messageId,
    sequence: nextPhaseSequence(state),
    phase,
    at,
  });
  return Object.freeze({ ...state, phase_log: Object.freeze([...state.phase_log, entry]) });
}

/**
 * **可靠保存 + 投递 / 唤醒**的唯一入口。
 *
 * 顺序（不可交换，也不可跳过）：
 * 1. **判重**（读群作用域键）——命中即返回 `duplicate_not_created`，**不写任何东西**
 *    （既不重复建工作，也不改写首条内容）；
 * 2. **`saved`**：消息 + 收件箱条目 + 工作承诺（若有 request_id）一并写入，
 *    并调用 `onSaved`；**此回调抛错 ⇒ 整个接受失败**（调用方看到的 state 不含该消息，
 *    且 `delivered` / `woken` 阶段从未发生）——这正是"先可靠保存"的强制点；
 * 3. **`delivered`**：调用 `onDelivered`；抛错 ⇒ 保存仍成立，`delivered: false`；
 * 4. **`woken`**：仅当 `requires_wakeup` 且已投递时调用 `onWakeup`；抛错 ⇒
 *    消息留在 `pending_wakeups` 里等待重试（**绝不因唤醒失败而丢消息**）。
 */
export function acceptMessage(
  state: InboxState,
  input: AcceptMessageInput,
  sink: InboxSideEffectSink = {},
): AcceptMessageOutcome {
  const message = input.message;
  const at = input.at;
  const key = inboxScopeKey(message.group_id, message.message_id);
  const existing = state.messages[key];

  if (existing !== undefined) {
    // 重复送达：业务工作不重复建、首条内容不改写。去重**只看 id**（不看内容）。
    return Object.freeze({
      state,
      result: 'duplicate_not_created',
      entry: state.entries[key] ?? null,
      work_commitment: null,
      duplicate_of: message.message_id,
      content_conflict: existing.body !== message.body,
      phases: Object.freeze([]),
      delivered: true,
      woken: !message.requires_wakeup,
      wakeup_required: message.requires_wakeup,
    });
  }

  // ---- 阶段 1：save（抛错 ⇒ 什么都没发生） ----
  sink.onSaved?.(message);

  const entry: InboxEntry = Object.freeze({
    message_id: message.message_id,
    group_id: message.group_id,
    instance_id: message.recipient_instance_id,
    task_id: message.task_id,
    sequence: nextSequenceOf(state, message.recipient_instance_id),
    received_at: at,
    requires_wakeup: message.requires_wakeup,
  });

  // 工作承诺：只由**首次**到达的消息建立（幂等键 = 群作用域消息身份）。
  const commitment: WorkCommitment | null =
    message.request_id === null
      ? null
      : Object.freeze({
          request_id: message.request_id,
          message_id: message.message_id,
          group_id: message.group_id,
          instance_id: message.recipient_instance_id,
          committed_at: at,
          created_by_message_id: message.message_id,
        });

  let next: InboxState = Object.freeze({
    ...state,
    messages: Object.freeze({ ...state.messages, [key]: Object.freeze({ ...message }) }),
    entries: Object.freeze({ ...state.entries, [key]: entry }),
    commitments: commitment === null ? state.commitments : Object.freeze([...state.commitments, commitment]),
  });
  next = appendPhase(next, message.message_id, 'saved', at);
  const phases: InboxPhase[] = ['saved'];

  // ---- 阶段 2：deliver ----
  let delivered = true;
  try {
    sink.onDelivered?.(entry);
  } catch {
    delivered = false;
  }
  if (delivered) {
    next = appendPhase(next, message.message_id, 'delivered', at);
    phases.push('delivered');
  }

  // ---- 阶段 3：wake ----
  let woken = false;
  if (message.requires_wakeup && delivered) {
    try {
      sink.onWakeup?.(message.message_id);
      woken = true;
      next = appendPhase(next, message.message_id, 'woken', at);
      phases.push('woken');
    } catch {
      woken = false;
    }
  }
  // 需要唤醒但没有成功唤醒 ⇒ 留在待唤醒队列里（可重试；消息已保存，绝不丢）。
  if (message.requires_wakeup && !woken) {
    next = Object.freeze({ ...next, pending_wakeups: Object.freeze([...next.pending_wakeups, message.message_id]) });
  }

  return Object.freeze({
    state: next,
    result: 'accepted',
    entry,
    work_commitment: commitment,
    duplicate_of: null,
    content_conflict: false,
    phases: Object.freeze([...phases]),
    delivered,
    woken,
    wakeup_required: message.requires_wakeup,
  });
}

// ---------------------------------------------------------------------------
// 读回执（与工作承诺分开）
// ---------------------------------------------------------------------------

export interface MarkReadInput {
  readonly group_id: GroupId;
  readonly message_id: MessageId;
  readonly instance_id: InstanceId;
  readonly run_id: RunId;
  readonly at: LogicalTime;
}

/**
 * 标记"已读"。**只写读回执表**——绝不因为"读了"而建工作承诺（§九-5）。
 * 消息未保存时抛错（读一条不存在的消息属调用方错误，不静默）。
 */
export function markRead(state: InboxState, input: MarkReadInput): InboxState {
  const key = inboxScopeKey(input.group_id, input.message_id);
  if (state.messages[key] === undefined) {
    throw new Error(`消息 ${input.message_id} 未保存：不得对其写读回执（读 ≠ 保存）`);
  }
  const receipt: ReadReceipt = Object.freeze({
    message_id: input.message_id,
    group_id: input.group_id,
    instance_id: input.instance_id,
    run_id: input.run_id,
    read_at: input.at,
  });
  const withReceipt: InboxState = Object.freeze({
    ...state,
    read_receipts: Object.freeze([...state.read_receipts, receipt]),
  });
  return appendPhase(withReceipt, input.message_id, 'read', input.at);
}

// ---------------------------------------------------------------------------
// 只读视图与自检
// ---------------------------------------------------------------------------

export function isDuplicateInInbox(state: InboxState, groupId: GroupId, messageId: MessageId): boolean {
  return state.messages[inboxScopeKey(groupId, messageId)] !== undefined;
}

/** 该实例收到的全部工作承诺（**未完成工作**；与读回执无关）。 */
export function commitmentsOf(state: InboxState, instanceId: InstanceId): readonly WorkCommitment[] {
  return Object.freeze(state.commitments.filter((commitment) => commitment.instance_id === instanceId));
}

/** 该实例已读但**没有**对应工作承诺的消息（"读了 ≠ 建了工作"，§九-5 的正向表达）。 */
export function readWithoutWork(state: InboxState, instanceId: InstanceId): readonly MessageId[] {
  const committedMessages = new Set(state.commitments.map((commitment) => commitment.message_id));
  return Object.freeze(
    state.read_receipts
      .filter((receipt) => receipt.instance_id === instanceId && !committedMessages.has(receipt.message_id))
      .map((receipt) => receipt.message_id),
  );
}

/**
 * 顺序自检：任何 `delivered` / `woken` / `read` 阶段，其**同一条消息**的 `saved`
 * 必须先出现（全局序号更小）。返回违规描述（空 = 无违规）。
 */
export function phaseOrderViolations(state: InboxState): readonly string[] {
  const savedAt = new Map<string, number>();
  for (const entry of state.phase_log) {
    if (entry.phase === 'saved') {
      savedAt.set(entry.message_id, entry.sequence);
    }
  }
  const violations: string[] = [];
  for (const entry of state.phase_log) {
    if (entry.phase === 'saved') continue;
    const saved = savedAt.get(entry.message_id);
    if (saved === undefined || saved > entry.sequence) {
      violations.push(`${entry.message_id}: ${entry.phase} 先于 saved 出现`);
    }
  }
  return Object.freeze(violations);
}

/** 尚未确认唤醒的消息（重试入口；"先保存"保证它们不会丢）。 */
export function outstandingWakeups(state: InboxState): readonly MessageId[] {
  return state.pending_wakeups;
}

/** 确认一次唤醒（重试成功后清除待唤醒标记）。 */
export function confirmWakeup(state: InboxState, messageId: MessageId, at: LogicalTime): InboxState {
  if (!state.pending_wakeups.includes(messageId)) {
    return state;
  }
  const cleared: InboxState = Object.freeze({
    ...state,
    pending_wakeups: Object.freeze(state.pending_wakeups.filter((id) => id !== messageId)),
  });
  return appendPhase(cleared, messageId, 'woken', at);
}

export interface InboxSummary {
  readonly message_count: number;
  readonly entry_count: number;
  readonly read_receipt_count: number;
  readonly work_commitment_count: number;
  readonly pending_wakeup_count: number;
  readonly phase_order_violations: readonly string[];
}

export function summarizeInbox(state: InboxState): InboxSummary {
  return Object.freeze({
    message_count: Object.keys(state.messages).length,
    entry_count: Object.keys(state.entries).length,
    read_receipt_count: state.read_receipts.length,
    work_commitment_count: state.commitments.length,
    pending_wakeup_count: state.pending_wakeups.length,
    phase_order_violations: phaseOrderViolations(state),
  });
}
