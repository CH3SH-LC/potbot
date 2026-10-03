/**
 * 观测计数的**唯一权威实现处**（合同 §七 Q10-a/Q10-b；v1.1 R3/R4/R19）。
 *
 * ## 为什么按来源拆两组（R19）
 *
 * `SchedulingCounters` 的 8 项里，有 6 项是**事件流可算**的（谁启动、谁结束、谁排队……），
 * 另 2 项（`work_item_status_distribution` / `blocker_reasons`）是**快照事实**——
 * 工作项表当前长什么样，只能从 `StoreSnapshot` 读，事件流里推不出来。
 *
 * 若把两者混在一个"算不出就抛错"的函数里，快照那两项会让每次调用都抛错；
 * 若像第一轮那样给它们返回 `{}` / `[]`，又**与"确实没有工作项"无法区分**——仍是假绿。
 *
 * 因此按来源拆开、**由类型强制两组都必须提供**才能拼成观测用的 `SchedulingCounters`：
 * 缺任一组就编译不过（缺失即"观测不完整"，不是"通过"）。两组各自的来源要在证据里标明。
 *
 * ## 分组
 *
 * - `EventCounters`：`summarizeKernelEvents(events)` 产出（只此一处实现）。
 * - `SnapshotCounters`：`summarizeSnapshotCounters(snapshot)` 产出（只此一处实现）。
 * - `SchedulingCounters`：两者合并（`mergeSchedulingCounters`）。
 * - 逐项阻塞明细（观测字段表「阻塞原因：逐项列出」）：`summarizeBlockers(items)`。
 */

import {
  BLOCKER_KINDS,
  WORK_ITEM_STATUSES,
  type BlockerKind,
  type WorkItemStatus,
} from './constants.js';
import { EventCountingError } from './errors.js';
import type { InstanceId, RequestId, RunId } from './ids.js';
import type { KernelEvent } from './events.js';
import type { StoreSnapshot } from './storage.js';
import type { WorkItem } from './work-item.js';

// ---------------------------------------------------------------------------
// 事件侧：6 项
// ---------------------------------------------------------------------------

/**
 * **只能从事件流算出**的 6 项（Q10-a 口径）：
 * - `run_count`：**实际启动**的轮次总数，**不含**被拒绝的发布尝试；
 * - `rejected_publication_count`：被拒绝的发布尝试次数（**单列**，不计入 `run_count`）；
 * - `peak_active_runs`：同时活动轮次的最大值（同一实例不得 > 1）；
 * - `peak_queued_flags`：同时为真的排队标记最大值；
 * - `diagnosis_count`：诊断次数（Q9-a 的预算量）；
 * - `inbox_message_count`：收件箱条数（按 (实例, 消息) 去重的已接受消息数）。
 */
export interface EventCounters {
  readonly run_count: number;
  readonly rejected_publication_count: number;
  readonly peak_active_runs: number;
  readonly peak_queued_flags: number;
  readonly diagnosis_count: number;
  readonly inbox_message_count: number;
}

// ---------------------------------------------------------------------------
// 快照侧：2 项
// ---------------------------------------------------------------------------

/**
 * **只能从快照算出**的 2 项：
 * - `work_item_status_distribution`：工作项当前状态分布，**六态齐全、缺项记 0**
 *   ——每个 0 都是"快照里该状态确实没有工作项"的**真实观测**，
 *   不是 R4 禁止的那种"算不出就用 0 冒充"（本组的值全部由快照逐项数出）；
 * - `blocker_reasons`：快照里出现过的阻塞原因类别（去重，按首次出现顺序）。
 *   逐项明细（哪一项在等哪一项）用 `summarizeBlockers()`。
 */
export interface SnapshotCounters {
  readonly work_item_status_distribution: Readonly<Record<WorkItemStatus, number>>;
  readonly blocker_reasons: readonly BlockerKind[];
}

/** 观测记录里合并后的计数形状：两组**都必须提供**（R19）。 */
export type SchedulingCounters = EventCounters & SnapshotCounters;

// ---------------------------------------------------------------------------
// 事件侧实现
// ---------------------------------------------------------------------------

/** 事件流自相矛盾（同一 run_id 重复启动/结束、同一 request_id 重复创建）时用的伪计数器名。 */
export const EVENT_STREAM_COHERENCE = 'event_stream_coherence';

function requireId<T>(value: T | null, event: KernelEvent, index: number, field: string, counter: string): T {
  if (value === null) {
    throw new EventCountingError(
      `事件 #${index}（${event.kind}）缺少 ${field}，无法真实计算「${counter}」。` +
        `禁止用 0 冒充观测值：请让生产端补齐该字段（见 summarizeKernelEvents 的字段表）`,
      counter,
      index,
    );
  }
  return value;
}

/**
 * **唯一权威实现**（R4/R19）：从事件流真实算出**事件可算的 6 项**。
 *
 * 事件顺序以**数组顺序**为准（事件日志 append-only 且有序），不依赖 `at` 的取值大小，
 * 因此在同一逻辑时刻内发生的事件也有确定结果（Q8-c）。
 *
 * 生产者必须提供的字段（缺失 → `EventCountingError`，**绝不返回 0 冒充观测值**）：
 *
 * | 事件种类 | 必填 | 影响的计数器 |
 * |---|---|---|
 * | `run_started` | `run_id` | `run_count`、`peak_active_runs` |
 * | `run_finished` | `run_id`（且必须与某个 `run_started` 配对） | `peak_active_runs` |
 * | `delegation_queue_enqueued` / `delegation_queue_cleared` | `instance_id` | `peak_queued_flags` |
 * | `message_accepted` | `message_id` + `instance_id` | `inbox_message_count` |
 * | `publication_rejected` | — | `rejected_publication_count` |
 * | `diagnosis_performed` | — | `diagnosis_count` |
 *
 * 其余事件种类不参与这 6 个计数器。其中 `work_item_created` 仍被校验
 * `request_id`（用于"重复建工作"探测），但**不再**参与任何事件侧计数——
 * 工作项状态分布与阻塞原因一律取自快照（R19）。
 *
 * 事件流**自相矛盾**时抛错（受控缺陷探测器，合同 R7/R18）：
 * - 同一 `run_id` 出现两次 `run_started`（或两次 `run_finished`）→ "重复启动"缺陷；
 * - 同一 `request_id` 出现两次 `work_item_created` → "重复建工作"缺陷。
 *   两者都用 `EventCountingError.counter === EVENT_STREAM_COHERENCE` 标出。
 *
 * **D06 的采样器必须调用本函数**，不得另写一套 peak 计算（R4）。
 *
 * @throws {EventCountingError} 计数器无法真实算出、或事件流不自洽时。
 */
export function summarizeKernelEvents(events: readonly KernelEvent[]): EventCounters {
  let runCount = 0;
  let activeRuns = 0;
  let peakActiveRuns = 0;
  const startedRuns = new Set<RunId>();
  const finishedRuns = new Set<RunId>();

  const queuedInstances = new Set<InstanceId>();
  let peakQueuedFlags = 0;

  let rejectedPublicationCount = 0;
  let diagnosisCount = 0;

  const inboxKeys = new Set<string>();
  const createdRequestIds = new Set<RequestId>();

  events.forEach((event, index) => {
    switch (event.kind) {
      case 'run_started': {
        const runId = requireId(event.run_id, event, index, 'run_id', 'run_count');
        if (startedRuns.has(runId)) {
          throw new EventCountingError(
            `事件 #${index}：run_id ${runId} 被启动了两次——一次运行轮次身份必须唯一。` +
              `若不变量被破坏（例如"重复启动"缺陷），计数器不可信，故拒绝汇总`,
            EVENT_STREAM_COHERENCE,
            index,
          );
        }
        startedRuns.add(runId);
        runCount += 1;
        activeRuns += 1;
        if (activeRuns > peakActiveRuns) {
          peakActiveRuns = activeRuns;
        }
        break;
      }
      case 'run_finished': {
        const runId = requireId(event.run_id, event, index, 'run_id', 'peak_active_runs');
        if (!startedRuns.has(runId)) {
          throw new EventCountingError(
            `事件 #${index}：run_finished 引用了从未 run_started 的 run_id ${runId}，` +
              `无法真实计算「peak_active_runs」`,
            'peak_active_runs',
            index,
          );
        }
        if (finishedRuns.has(runId)) {
          throw new EventCountingError(
            `事件 #${index}：run_id ${runId} 被结束了两次，事件流自相矛盾`,
            EVENT_STREAM_COHERENCE,
            index,
          );
        }
        finishedRuns.add(runId);
        activeRuns -= 1;
        break;
      }
      case 'delegation_queue_enqueued': {
        const instanceId = requireId(event.instance_id, event, index, 'instance_id', 'peak_queued_flags');
        queuedInstances.add(instanceId);
        if (queuedInstances.size > peakQueuedFlags) {
          peakQueuedFlags = queuedInstances.size;
        }
        break;
      }
      case 'delegation_queue_cleared': {
        const instanceId = requireId(event.instance_id, event, index, 'instance_id', 'peak_queued_flags');
        queuedInstances.delete(instanceId);
        break;
      }
      case 'publication_rejected': {
        rejectedPublicationCount += 1;
        break;
      }
      case 'diagnosis_performed': {
        diagnosisCount += 1;
        break;
      }
      case 'message_accepted': {
        const messageId = requireId(event.message_id, event, index, 'message_id', 'inbox_message_count');
        const instanceId = requireId(event.instance_id, event, index, 'instance_id', 'inbox_message_count');
        // 按 (instance, message) 去重计条目：同一消息被重复接受不应重复计数。
        inboxKeys.add(`${instanceId.length}:${instanceId}${messageId}`);
        break;
      }
      case 'work_item_created': {
        // 不再参与事件侧计数（R19）；只保留"重复建工作"探测所需的 request_id。
        const requestId = requireId(
          event.request_id,
          event,
          index,
          'request_id',
          EVENT_STREAM_COHERENCE,
        );
        if (createdRequestIds.has(requestId)) {
          throw new EventCountingError(
            `事件 #${index}：request_id ${requestId} 被创建了两次——重复建业务工作` +
              `（Q4-b：重开必须是**新**工作项 / 新 request_id），故拒绝汇总`,
            EVENT_STREAM_COHERENCE,
            index,
          );
        }
        createdRequestIds.add(requestId);
        break;
      }
      default:
        // 其余事件种类不参与事件侧的 6 个计数器。
        break;
    }
  });

  return Object.freeze({
    run_count: runCount,
    rejected_publication_count: rejectedPublicationCount,
    peak_active_runs: peakActiveRuns,
    peak_queued_flags: peakQueuedFlags,
    diagnosis_count: diagnosisCount,
    inbox_message_count: inboxKeys.size,
  });
}

// ---------------------------------------------------------------------------
// 快照侧实现
// ---------------------------------------------------------------------------

/** 工作项六态分布（六态齐全、缺项记 0；每个 0 都是快照的真实观测）。 */
export function statusDistribution(items: readonly WorkItem[]): Record<WorkItemStatus, number> {
  const distribution = {} as Record<WorkItemStatus, number>;
  for (const status of WORK_ITEM_STATUSES) {
    distribution[status] = 0;
  }
  for (const item of items) {
    distribution[item.status] += 1;
  }
  return distribution;
}

/** 快照里出现过的阻塞原因类别（去重，按首次出现顺序；`blocker_reason` 为空者不参与）。 */
export function blockerKindsOf(items: readonly WorkItem[]): BlockerKind[] {
  const kinds: BlockerKind[] = [];
  for (const item of items) {
    const kind = item.blocker_reason?.kind;
    if (kind !== undefined && BLOCKER_KINDS.includes(kind) && !kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * **唯一权威实现**（R19）：从**只读快照**算出快照侧的 2 项计数。
 *
 * 本函数只做投影：不修改快照、不做事件推断、不校验工作项不变量
 * （不变量由 `createWorkItem` / `assertWorkItemInvariants` / D04 的承诺表负责）。
 */
export function summarizeSnapshotCounters(snapshot: StoreSnapshot): SnapshotCounters {
  return Object.freeze({
    work_item_status_distribution: Object.freeze(statusDistribution(snapshot.work_items)),
    blocker_reasons: Object.freeze(blockerKindsOf(snapshot.work_items)),
  });
}

// ---------------------------------------------------------------------------
// 逐项阻塞明细（观测字段表「阻塞原因：逐项列出」）
// ---------------------------------------------------------------------------

/** 单项阻塞摘要：哪一项在等哪一项。 */
export interface BlockerDetail {
  readonly request_id: RequestId;
  readonly status: WorkItemStatus;
  readonly blocker_kind: BlockerKind | null;
  readonly blocker_detail: string | null;
  readonly depends_on_request_ids: readonly RequestId[];
  readonly failure_reason: string | null;
}

/**
 * 逐项列出阻塞 / 失败原因与依赖对象（R3 的观测字段表要求"逐项列出"）。
 * 与 `blockerKindsOf()` 的区别：后者是去重后的类别集合，本函数保留逐项明细。
 */
export function summarizeBlockers(items: readonly WorkItem[]): readonly BlockerDetail[] {
  return Object.freeze(
    items.map((item) =>
      Object.freeze({
        request_id: item.request_id,
        status: item.status,
        blocker_kind: item.blocker_reason === null ? null : item.blocker_reason.kind,
        blocker_detail: item.blocker_reason === null ? null : item.blocker_reason.detail,
        depends_on_request_ids: Object.freeze(
          item.dependency_refs
            .map((ref) => ref.request_id)
            .filter((id): id is RequestId => id !== undefined),
        ),
        failure_reason: item.failure_reason,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// 合并（观测记录用）
// ---------------------------------------------------------------------------

/**
 * 把两组计数器合并为观测记录用的 `SchedulingCounters`。
 *
 * 纯合并，不做任何计算——两组都必须由各自唯一实现产出（R19）。
 * 类型上少给一组就编译不过，因此"只取一半"无法伪装成完整观测。
 */
export function mergeSchedulingCounters(
  eventCounters: EventCounters,
  snapshotCounters: SnapshotCounters,
): SchedulingCounters {
  return Object.freeze({ ...eventCounters, ...snapshotCounters });
}
