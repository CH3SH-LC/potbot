/**
 * A04 验收夹具（归属 D08 验收批；规格 `docs/other/prep/D07-D09-prep-验收场景规格.md` §3）。
 *
 * **本文件不实现内核**：它只接线 D01 存储 / D02 收件箱去重 / D03 调度器 / D06 器件，
 * 并按 0.3「夹具必须提供的能力」把「投递入口 / 夹具持有调度推进权 / 可注入缺陷」串起来。
 *
 * 冻结点标识：D11 收尾后取自**单一来源** `tests/acceptance/freeze-identity.ts`
 * （原先把 FREEZE-1 的摘要硬编码在本文件里，导致 D03 修复后的重跑证据自称 FREEZE-1、
 * 实际被测的是 FREEZE-2 源码——D10 复核发现，违反 R24）。
 *
 * ## 三个变体与对照
 * - 变体甲（顺序重试）、变体乙（并发重试）、变体丙（混合）：同一 `message_id` 投递 5 次；
 * - 对照 A04-C：内容逐字相同但 `message_id` / `request_id` 均不同 → 必须各自独立保留。
 *
 * ## 受控缺陷注入（R7）——**只在隔离夹具内**，不碰 `src/**`
 * - `no_dedup`：把去重判定的三个读口全部neutered（「去掉去重判定」）；
 * - `content_dedup`：把去重键从 `message_id` 换成**内容指纹**（「按内容去重」）。
 * 两者都通过**包裹 `Store.transact` 传来的 `StorageTransaction`** 实现，
 * 生产源码一个字节未改。
 */

import {
  asInstanceId,
  asLogicalTime,
  createGroupMember,
  createIdSource,
  mergeSchedulingCounters,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  type DeliveryResult,
  type EventCounters,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type RunId,
  type SchedulingCounters,
  type SnapshotCounters,
  type Store,
  type StorageTransaction,
  type StoreSnapshot,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createScheduler, type AdvanceStep, type OnMessageOutcome, type Scheduler } from '../../../src/scheduler/index.js';
import {
  Barrier,
  BASELINE_GROUP_ID,
  BASELINE_INSTANCE_C,
  BASELINE_TASK_ID,
  BASELINE_TASK_REVISION,
  SchedulerAdvanceSeam,
  artifactRefFor,
  createDeliveryRequest,
  createScenarioBaseline,
  type DeliveryRequest,
} from '../../../src/fake/index.js';
import { freezePointEvidence } from '../freeze-identity.js';

/**
 * 全量（src + tests）源码树摘要——来自单一来源（D11）。
 * 旧导出名保留，只为不动本目录外（`dedup.test.ts` / `reliable-delivery.test.ts`）的既有引用。
 */
const FREEZE_POINT = freezePointEvidence();
export const FREEZE_1_SOURCE_TREE_SHA256 = FREEZE_POINT.source_tree_sha256;

/** 受控缺陷注入种类（仅隔离夹具）。 */
export type A04Defect = 'none' | 'no_dedup' | 'content_dedup';

/**
 * 标准发送成员（合同 v1.2 R35.5；修复 F07）：入口默认鉴权器的第 4 项判据要求发送者是
 * **本群已登记成员**。登记进**独立的成员表**（`putGroupMember`），不是 `putInstance`
 * ——后者会改变 `instances` 计数与调度观测口径（见 `src/protocol/membership.ts`）。
 */
export const STANDARD_MEMBER_IDS: readonly InstanceId[] = [
  asInstanceId('S1'),
  asInstanceId('S2'),
  asInstanceId('S3'),
  asInstanceId('S4'),
];

/** 收件箱 `payload.content`（缺陷注入要读它来模拟「按内容去重」）。 */
function contentOf(message: { readonly payload?: unknown }): string | null {
  const payload: unknown = message.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const content = (payload as { readonly content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

// ---------------------------------------------------------------------------
// 受控缺陷注入（包裹事务句柄，不改共享源码）
// ---------------------------------------------------------------------------

/** `no_dedup`：让去重判定的三个读口「永远查不到重复」。 */
function neuterDedupTx(tx: StorageTransaction): StorageTransaction {
  return new Proxy(tx, {
    get(target, prop) {
      switch (prop) {
        case 'getMessageInGroup':
          return (): undefined => undefined;
        case 'hasMessageInGroup':
          return (): boolean => false;
        case 'hasInboxEntry':
          return (): boolean => false;
        case 'getMessage':
          return (): undefined => undefined;
        default: {
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
      }
    },
  });
}

/**
 * `content_dedup`：把去重键从 `message_id` 换成**内容指纹**——
 * 群内只要存在一条 `payload.content` 与本次投递相同的消息，就判为重复。
 */
function contentDedupTx(tx: StorageTransaction, contentOfIncoming: () => string | null): StorageTransaction {
  return new Proxy(tx, {
    get(target, prop) {
      switch (prop) {
        case 'getMessageInGroup':
          return (_groupId: GroupId, _messageId: MessageId): unknown => {
            const incoming = contentOfIncoming();
            if (incoming === null) return undefined;
            for (const message of target.listMessages()) {
              if (contentOf(message) === incoming) return message;
            }
            return undefined;
          };
        case 'hasMessageInGroup':
          return (): boolean => false;
        default: {
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
      }
    },
  });
}

/** 把缺陷注入挂在 `Store.transact` 上（其余方法原样透传，绑定到真实实例）。 */
function wrapStoreWithDefect(
  store: Store,
  defect: Exclude<A04Defect, 'none'>,
  contentOfIncoming: () => string | null,
): Store {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'transact') {
        return <T>(work: (tx: StorageTransaction) => T): T =>
          target.transact((tx) =>
            work(defect === 'no_dedup' ? neuterDedupTx(tx) : contentDedupTx(tx, contentOfIncoming)),
          );
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// 一次投递的证据记录
// ---------------------------------------------------------------------------

export interface DeliveryAttemptRecord {
  readonly index: number;
  /** 投递发起时的**夹具逻辑步号**（逻辑时钟读数，非墙钟）。 */
  readonly step: number;
  readonly message_id: MessageId;
  readonly request_id: RequestId | null;
  readonly content_fingerprint: string;
  readonly result: DeliveryResult;
  /** 投递时**已启动**的推进（= 冻结）次数。 */
  readonly advance_seq: number;
  readonly work_item_created: boolean;
  readonly queued: boolean;
  readonly merged_wakeup: boolean;
  readonly duplicate_of: MessageId | null;
  readonly inbox_entry_sequence: number | null;
}

export interface DeliveryRequestSpec {
  readonly message_id: string;
  readonly request_id?: string;
  readonly content: string;
  readonly sender_instance_id?: InstanceId;
  readonly at: LogicalTime;
  readonly requires_wakeup?: boolean;
  /** 额外 payload 字段（A04-06 用它区分「重试那份」与「首次那份」）。 */
  readonly extra_payload?: Readonly<Record<string, unknown>>;
}

/** 计数器三件套（R19：事件侧与快照侧**两组来源**分别留证后再合并）。 */
export interface CounterTriple {
  readonly event: EventCounters;
  readonly snapshot: SnapshotCounters;
  readonly merged: SchedulingCounters;
}

/**
 * A04 场景夹具：一个独立存储 + 独立调度器 + 独立推进接缝（规格 0.2「隔离」）。
 */
export class A04Harness {
  readonly clock = new LogicalClock();
  readonly store: Store;
  readonly seam: SchedulerAdvanceSeam;
  readonly scheduler: Scheduler;
  readonly attempts: DeliveryAttemptRecord[] = [];
  readonly defect: A04Defect;
  #lastStep: AdvanceStep | null = null;
  #incomingContent: string | null = null;

  constructor(options: { readonly defect?: A04Defect; readonly idSeed?: string } = {}) {
    this.defect = options.defect ?? 'none';
    const raw = createMemoryStore({ clock: () => this.clock.now() });
    this.store =
      this.defect === 'none'
        ? raw
        : wrapStoreWithDefect(raw, this.defect, () => this.#incomingContent);

    // 基线：把接收实例 C 注册进存储（规格 0.2：C 空闲、收件箱空、工作承诺表空）。
    const baseline = createScenarioBaseline({ at: this.clock.time });
    this.store.transact((tx) => {
      tx.putInstance(baseline.instance_c);
      // R35.5：注册标准发送成员（成员表独立于 instances，不参与调度观测）。
      for (const member of STANDARD_MEMBER_IDS) {
        tx.putGroupMember(
          createGroupMember({
            group_id: baseline.group_id,
            instance_id: member,
            registered_at: this.clock.time,
          }),
        );
      }
    });

    this.seam = new SchedulerAdvanceSeam(this.clock);
    this.scheduler = createScheduler(this.store, {
      clock: () => this.clock.now(),
      idSource: createIdSource({ seed: options.idSeed ?? 'a04' }),
      default_task_id: BASELINE_TASK_ID,
      // D03 报告给的接线（D07-D09-prep §「接线」）：投递登记**不触发推进**。
      onDeliveryCommitted: (note) => {
        this.seam.noteDeliveryCommit({ ...note, label: note.result });
      },
    });
    this.seam.bind(() => {
      const step = this.scheduler.advanceOnce();
      this.#lastStep = step;
      return step;
    });
  }

  /** R35.5：登记一个合法发送成员（成员表独立于 `instances`，只被入口鉴权读取）。 */
  registerMember(memberId: InstanceId, groupId: GroupId = BASELINE_GROUP_ID): void {
    this.store.transact((tx) => {
      tx.putGroupMember(
        createGroupMember({ group_id: groupId, instance_id: memberId, registered_at: this.clock.time }),
      );
    });
  }

  /** 构造一条待投递消息（同一 `message_id` 可重复构造，`at` 可不同）。 */
  makeRequest(spec: DeliveryRequestSpec): DeliveryRequest {
    return createDeliveryRequest({
      task_id: BASELINE_TASK_ID,
      group_id: BASELINE_GROUP_ID,
      task_revision: BASELINE_TASK_REVISION,
      message_id: spec.message_id as MessageId,
      sender_instance_id: spec.sender_instance_id ?? asInstanceId('S1'),
      recipient_instance_id: BASELINE_INSTANCE_C,
      type: 'work_request',
      content: spec.content,
      at: spec.at,
      ...(spec.request_id === undefined ? {} : { request_id: spec.request_id as RequestId }),
      ...(spec.requires_wakeup === undefined ? {} : { requires_wakeup: spec.requires_wakeup }),
      ...(spec.extra_payload === undefined ? {} : { payload: spec.extra_payload }),
    });
  }

  /** 投递一条消息（经 D03 的 `onMessage` 入口），并留下逐条回执。 */
  deliver(request: DeliveryRequest): OnMessageOutcome {
    const step = this.clock.now();
    const advanceSeq = this.seam.advanceSeq;
    this.#incomingContent = contentOf(request.message);
    let outcome: OnMessageOutcome;
    try {
      outcome = this.scheduler.onMessage(request.message);
    } finally {
      this.#incomingContent = null;
    }
    this.attempts.push({
      index: this.attempts.length + 1,
      step,
      message_id: request.message.message_id,
      request_id: request.request_id,
      content_fingerprint: request.content_fingerprint,
      result: outcome.result,
      advance_seq: advanceSeq,
      work_item_created: outcome.work_item_created,
      queued: outcome.queued,
      merged_wakeup: outcome.merged_wakeup,
      duplicate_of: outcome.duplicate_of,
      inbox_entry_sequence: outcome.inbox_entry === null ? null : outcome.inbox_entry.sequence,
    });
    return outcome;
  }

  /** 顺序投递（变体甲 / 变体丙的顺序段）：逐条投递，每条返回后再投下一条。 */
  deliverSequential(requests: readonly DeliveryRequest[]): readonly OnMessageOutcome[] {
    return requests.map((request) => this.deliver(request));
  }

  /**
   * 并发投递（变体乙 / 变体丙的并发段）：**同一屏障 B-deliver 后同时起跑**，
   * 夹具等全部返回才继续（B-alldone）。全部投递共享同一逻辑步（无时钟推进）。
   */
  async deliverConcurrent(requests: readonly DeliveryRequest[]): Promise<readonly OnMessageOutcome[]> {
    const barrier = new Barrier(requests.length);
    return Promise.all(
      requests.map(async (request) => {
        await barrier.arrive();
        return this.deliver(request);
      }),
    );
  }

  /** 显式放行一次调度推进（放行点 R1），并返回本次内核启动的轮次记录。 */
  async advanceOnce(label: string): Promise<AdvanceStep> {
    await this.seam.advanceOnce(label);
    const step = this.#lastStep;
    if (step === null) throw new Error('推进接缝未回传内核的 AdvanceStep（夹具接线错误）');
    return step;
  }

  /** 空推进直至空闲（A04-07 / P2 的收敛判定）。 */
  async advanceUntilIdle(maxSteps: number, label: string): Promise<void> {
    await this.seam.advanceUntilIdle(maxSteps, label);
  }

  /** 假 Agent 的「本轮产出结果」：把某项工作置为 `completed` 并带结果引用（P4-10）。 */
  finishCompleted(runId: RunId, requestId: RequestId, suffix = 'result'): void {
    const outcome = this.scheduler.finishRun({
      run_id: runId,
      publications: [
        { kind: 'completed', request_id: requestId, result_refs: [artifactRefFor(requestId, suffix)] },
      ],
    });
    if (!outcome.accepted) {
      throw new Error(`finish_run 被拒（${String(outcome.rejection_reason)}）：夹具无法产出结局`);
    }
  }

  snapshot(): StoreSnapshot {
    return this.scheduler.snapshot();
  }

  inboxOfC(): readonly { readonly message_id: MessageId }[] {
    return this.snapshot().inbox_entries.filter((entry) => entry.instance_id === BASELINE_INSTANCE_C);
  }

  /** 收件箱中某 `message_id` 的条目数（**A04-01 的原始观测**）。 */
  inboxEntryCount(messageId: string): number {
    return this.snapshot().inbox_entries.filter((entry) => entry.message_id === messageId).length;
  }

  /** 工作承诺表中某 `request_id` 的工作项数（**A04-02 的原始观测**）。 */
  workItemCount(requestId: string): number {
    return this.snapshot().work_items.filter((item) => item.request_id === requestId).length;
  }

  /** 读入过某 `request_id` 的轮次（**A04-03 的原始观测**）。 */
  runsReading(requestId: string): readonly RunId[] {
    return this.snapshot()
      .runs.filter((run) => run.frozen_request_ids.includes(requestId as RequestId))
      .map((run) => run.run_id);
  }

  /** R19：事件侧 6 项 + 快照侧 2 项 + 合并（两组来源分别留证）。 */
  counters(): CounterTriple {
    const event = summarizeKernelEvents(this.snapshot().kernel_events);
    const snapshot = summarizeSnapshotCounters(this.snapshot());
    return { event, snapshot, merged: mergeSchedulingCounters(event, snapshot) };
  }

  /** 把字符串折成品牌类型的便捷口（测试可读性）。 */
  static at(value: number): LogicalTime {
    return asLogicalTime(value);
  }
}

/** `{ content }` 之外，重试那份额外带的 payload 标记（A04-06 的「不覆盖」观测点）。 */
export const RETRY_PAYLOAD_KEY = 'attempt';
