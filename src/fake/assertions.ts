/**
 * 只读快照的断言辅助（归属 D06，`src/fake/`）。
 *
 * 对应验收规格 0.3 第 5 条：「**只读快照接口**（断言只能经此读取，不得窥探内核内部内存）」，
 * 以及 0.4「断言设计三原则」里的**守恒类**与**归属类**断言。
 *
 * 输入一律是 D01 的 `StoreSnapshot`（`src/protocol/storage.ts`），本模块**只读**它，
 * 不写存储、不改任何状态；发现违规时按需返回「违规项清单」或抛 `ConservationViolationError`，
 * 让失败原因可见（不得静默吞掉）。
 */

import {
  isTerminalStatus,
  statusDistribution,
  summarizeBlockers,
  type BlockerDetail,
  type InboxEntry,
  type InstanceId,
  type MessageId,
  type RequestId,
  type StoreSnapshot,
  type WorkItem,
} from '../protocol/index.js';
import { ConservationViolationError } from './errors.js';

/** message_id 唯一性检查结果。 */
export interface MessageIdUniqueness {
  /** 去重后的 id（保持首次出现顺序）。 */
  readonly unique: readonly MessageId[];
  /** 出现次数 > 1 的 id（A04-06 的违规证据）。 */
  readonly duplicates: readonly MessageId[];
}

/** 检查收件箱条目的 message_id 唯一性。 */
export function uniqueMessageIds(entries: readonly InboxEntry[]): MessageIdUniqueness {
  const counts = new Map<MessageId, number>();
  const order: MessageId[] = [];
  for (const entry of entries) {
    if (!counts.has(entry.message_id)) order.push(entry.message_id);
    counts.set(entry.message_id, (counts.get(entry.message_id) ?? 0) + 1);
  }
  const duplicates = order.filter((id) => (counts.get(id) ?? 0) > 1);
  return { unique: order, duplicates };
}

/** 断言收件箱内 message_id 互不重复（A04-01 / A04-06 的守恒判据）。 */
export function assertUniqueMessageIds(entries: readonly InboxEntry[]): void {
  const { duplicates } = uniqueMessageIds(entries);
  if (duplicates.length > 0) {
    throw new ConservationViolationError(
      '收件箱中出现重复 message_id（同一消息被重复落库）',
      duplicates.map(String),
    );
  }
}

/** 断言收件箱恰好包含给定集合（A02-04 / A03-05 的守恒判据）。 */
export function assertInboxMessageIds(
  entries: readonly InboxEntry[],
  expected: readonly MessageId[],
): void {
  assertUniqueMessageIds(entries);
  const actualSet = new Set(entries.map((entry) => entry.message_id));
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((id) => !actualSet.has(id));
  const extra = [...actualSet].filter((id) => !expectedSet.has(id));
  const violations: string[] = [];
  if (missing.length > 0) violations.push(`缺失：[${missing.join(', ')}]`);
  if (extra.length > 0) violations.push(`多余：[${extra.join(', ')}]`);
  if (violations.length > 0) {
    throw new ConservationViolationError(
      `收件箱 message_id 集合与期望不符（期望 ${expectedSet.size} 条，实际 ${actualSet.size} 条）`,
      violations,
    );
  }
}

/** 工作承诺表按 request_id 索引 + 重复检查（A02-05 / A04-02 / A04-C-02）。 */
export interface WorkItemIndex {
  readonly byRequestId: ReadonlyMap<RequestId, WorkItem>;
  /** request_id 重复的工作项（A02-06 的违规证据）。 */
  readonly duplicates: readonly RequestId[];
}

/** 按 request_id 索引工作项，并找出重复项。 */
export function indexWorkItems(items: readonly WorkItem[]): WorkItemIndex {
  const byRequestId = new Map<RequestId, WorkItem>();
  const duplicates: RequestId[] = [];
  for (const item of items) {
    if (byRequestId.has(item.request_id)) duplicates.push(item.request_id);
    else byRequestId.set(item.request_id, item);
  }
  return { byRequestId, duplicates };
}

/** 断言 request_id 互不重复。 */
export function assertUniqueRequestIds(items: readonly WorkItem[]): void {
  const { duplicates } = indexWorkItems(items);
  if (duplicates.length > 0) {
    throw new ConservationViolationError(
      '工作承诺表中出现重复 request_id（同一请求被重复建项）',
      duplicates.map(String),
    );
  }
}

/**
 * 找「既非终态、又没有等待/阻塞原因」的工作项
 * ——A02-08 / A03-08 / P4-09 明示的禁止情形。
 */
export function findItemsWithoutOutcome(items: readonly WorkItem[]): readonly WorkItem[] {
  return items.filter((item) => !isTerminalStatus(item.status) && item.blocker_reason === null);
}

/** 断言不存在「既无结局也无原因」的工作项。 */
export function assertEveryItemHasOutcome(items: readonly WorkItem[]): void {
  const offenders = findItemsWithoutOutcome(items);
  if (offenders.length > 0) {
    throw new ConservationViolationError(
      '存在既非终态、又缺少等待/阻塞原因的工作项',
      offenders.map((item) => `${item.request_id}(${item.status})`),
    );
  }
}

/** 找「已完成但没有结果引用」的工作项（A03-10 / P4-10 的反作弊判据）。 */
export function findCompletedWithoutResult(items: readonly WorkItem[]): readonly WorkItem[] {
  return items.filter((item) => item.status === 'completed' && item.result_refs.length === 0);
}

/** 找触发消息为空的工作项（A02-06 的「孤儿工作项」）。 */
export function findItemsWithoutTriggeringMessage(items: readonly WorkItem[]): readonly WorkItem[] {
  return items.filter((item) => item.triggering_message_ids.length === 0);
}

/** 消息 → 工作项的归属映射（A02-06 / A02-07 的归属类断言材料）。 */
export function messageToRequestIds(snapshot: StoreSnapshot): ReadonlyMap<MessageId, readonly RequestId[]> {
  const map = new Map<MessageId, RequestId[]>();
  for (const item of snapshot.work_items) {
    for (const messageId of item.triggering_message_ids) {
      const list = map.get(messageId);
      if (list === undefined) map.set(messageId, [item.request_id]);
      else list.push(item.request_id);
    }
  }
  return map;
}

/** 找收件箱里**没有被任何工作项承载**的消息（「丢了请求」的证据）。 */
export function findUnmappedMessages(snapshot: StoreSnapshot): readonly MessageId[] {
  const mapped = messageToRequestIds(snapshot);
  const unmapped: MessageId[] = [];
  for (const entry of snapshot.inbox_entries) {
    if (!mapped.has(entry.message_id)) unmapped.push(entry.message_id);
  }
  return unmapped;
}

/**
 * 逐项阻塞原因摘要的类型别名。
 *
 * **实现不在这里**：`statusDistribution` / `summarizeBlockers` 的权威实现在
 * `src/protocol/counters.ts`（R4：同一概念不许两套实现）。本模块只转出，并保留
 * `BlockerSummaryEntry` 这个对外名字（= protocol 的 `BlockerDetail`，字段逐一相同）。
 */
export type BlockerSummaryEntry = BlockerDetail;

export { statusDistribution, summarizeBlockers };

/** 取某实例的收件箱条目（薄封装，语义直白；实现委托 D01 的 `snapshotInboxOf`）。 */
export function inboxOf(snapshot: StoreSnapshot, instanceId: InstanceId): readonly InboxEntry[] {
  return snapshot.inbox_entries.filter((entry) => entry.instance_id === instanceId);
}

/** 「已读」与「已完成」是两组记录（合同 §九-5）——一致性检查。 */
export interface ReadVsDoneReport {
  /** 已读但对应工作项不存在的消息（读过却没有登记工作）。 */
  readonly read_without_work: readonly MessageId[];
  /** 已完成但从未被任何轮次读入的工作项（不可能完成却没读过）。 */
  readonly done_without_read: readonly RequestId[];
}

/**
 * 检查「已读」与「已完成」两组记录的一致性
 * （P4-01「已读≠已完成」与 P4-11「不存在读过但未登记」的正向判据）。
 *
 * 「已读」取自 `snapshot.read_receipts`（`ReadReceipt`，Q5-b：读取即标记），
 * 「已完成」取自 `WorkItem.status`——两者在 D01 的数据模型里就是两组独立记录（合同 §九-5）。
 */
export function compareReadAndDone(snapshot: StoreSnapshot, instanceId: InstanceId): ReadVsDoneReport {
  const readMessageIds = new Set(
    snapshot.read_receipts
      .filter((receipt) => receipt.instance_id === instanceId)
      .map((receipt) => receipt.message_id),
  );
  const mapped = messageToRequestIds(snapshot);

  const readWithoutWork: MessageId[] = [];
  for (const messageId of readMessageIds) {
    if (!mapped.has(messageId)) readWithoutWork.push(messageId);
  }

  const doneWithoutRead: RequestId[] = [];
  for (const item of snapshot.work_items) {
    if (item.status !== 'completed') continue;
    // 工作项读入过哪些轮次由 `snapshot_run_ids` 记录（Q4-a：读入 ≠ 完成）。
    if (item.snapshot_run_ids.length === 0) doneWithoutRead.push(item.request_id);
  }

  return { read_without_work: readWithoutWork, done_without_read: doneWithoutRead };
}
