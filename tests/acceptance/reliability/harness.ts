/**
 * P2「可靠交付」验收夹具（归属 D08 验收批；规格 §6）。
 *
 * **本文件不实现内核**：它只接线 D01 存储 / D02 收件箱 / D03 调度器 / D06 的故障注入与恢复器件，
 * 按 0.3 第 6 条把三个注入点（W1/W2/W3）挂到 `MutableStoreFaultHooks` 上。
 *
 * 冻结点标识**不硬编码**：取自**单一来源** `tests/acceptance/freeze-identity.ts`
 * （值在 `docs/other/evidence/D11/freeze-identity.json`；R24 / R32.1）。
 *
 * ## 三个注入点的落点（D06 `storeFaultHooks()` 的映射）
 * | 注入点 | D01 钩子 | 触发时机 | 语义 |
 * |---|---|---|---|
 * | W2 `message.persist` | `beforeCommit` | 提交前 | 事务回滚 → `PersistenceError`（**未接受**） |
 * | W1 `scheduling.event.persist` | `afterCommitBeforePublish` | 提交后、投递前 | 已接受，事件仍在 outbox |
 * | W3 `execution.enqueue` | `beforePublishEvent` | **逐条事件投递时** | 单条投递失败，可 `replayUndelivered()` 补投 |
 *
 * ## R20.3 纪律（否则假绿）
 * D01 的 `transact()` **不自动发布**——`beforePublishEvent` 只在 `publishPending` / `replayUndelivered`
 * 里触发。因此夹具**必须走显式发布入口**。本夹具走 `Scheduler.onMessage()`
 * （它在提交后调用 `publishPendingEvents()`），并在 W3 里以
 * 「中断后 `pendingDeliveryEvents().length === 1` 且执行队列为空」**证明故障窗口真的被触发**。
 */

import {
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRunId,
  createGroupMember,
  createIdSource,
  mergeSchedulingCounters,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  PublicationError,
  type EventCounters,
  type IdSource,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type PendingEvent,
  type RequestId,
  type RunId,
  type SchedulingCounters,
  type SnapshotCounters,
  type StorageTransaction,
  type Store,
  type StoreSnapshot,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createScheduler, type AdvanceStep, type OnMessageOutcome, type Scheduler } from '../../../src/scheduler/index.js';
import {
  BASELINE_GROUP_ID,
  BASELINE_INSTANCE_C,
  BASELINE_TASK_ID,
  BASELINE_TASK_REVISION,
  FaultInjector,
  INJECTION_POINTS,
  SchedulerAdvanceSeam,
  artifactRefFor,
  createDeliveryRequest,
  createScenarioBaseline,
  runRecoveryAttempts,
  storeFaultHooks,
  type DeliveryRequest,
  type InjectionPoint,
  type RecoveryRun,
} from '../../../src/fake/index.js';
import { freezePointEvidence } from '../freeze-identity.js';

/**
 * 全量（src + tests）源码树摘要——来自单一来源（D11）。
 * 旧导出名保留，只为不动本目录外（`reliable-delivery.test.ts`）的既有引用。
 */
const FREEZE_POINT = freezePointEvidence();
export const FREEZE_1_SOURCE_TREE_SHA256 = FREEZE_POINT.source_tree_sha256;

export { INJECTION_POINTS };
export type { InjectionPoint, RecoveryRun };

/** 计数器三件套（R19：事件侧 + 快照侧**两组来源**分别留证后再合并）。 */
export interface CounterTriple {
  readonly event: EventCounters;
  readonly snapshot: SnapshotCounters;
  readonly merged: SchedulingCounters;
}

export interface P2DeliverResult {
  /** 投递调用返回的三值结果（无异常时）；抛异常时为 null。 */
  readonly outcome: OnMessageOutcome | null;
  /** 抛出的异常（`PublicationError` / 其他）；未抛时为 null。 */
  readonly thrown: unknown;
  /** 是否抛出了 `PublicationError`（= 已接受但事件未投递）。 */
  readonly accepted_but_unpublished: boolean;
  /** 中断前**已提交**的动作清单（`InjectedInterrupt` 携带）。 */
  readonly committed: readonly string[];
  /** 中断时**尚未提交**的动作清单。 */
  readonly pending: readonly string[];
}

export interface P2RequestSpec {
  readonly message_id: string;
  readonly request_id?: string;
  readonly content: string;
  readonly sender_instance_id?: InstanceId;
  readonly at: LogicalTime;
}

/**
 * 标准发送成员（合同 v1.2 R35.5；修复 F07）：入口默认鉴权器的第 4 项判据要求发送者是
 * 本群**已登记成员**。登记进独立成员表（`putGroupMember`），不写成 `putInstance`
 * ——那样会让 `instances` 计数与调度观测凭空多出若干项。
 */
export const STANDARD_MEMBER_IDS: readonly InstanceId[] = [
  asInstanceId('S1'),
  asInstanceId('S2'),
  asInstanceId('S3'),
  asInstanceId('S4'),
];

/** 受控缺陷注入（仅隔离夹具，不改 `src/**`）。 */
export type P2Defect =
  | 'none'
  /** I-P2-1「落盘不记事件」：把待投递调度事件的写入吞掉（消息照常提交、outbox 为空）。 */
  | 'drop_outbox';

/**
 * P2 场景夹具：独立存储（带故障接缝）+ 独立调度器 + 独立执行队列 + 独立推进接缝。
 */
export class P2Harness {
  readonly clock: LogicalClock;
  readonly injector: FaultInjector;
  readonly store: Store;
  readonly seam: SchedulerAdvanceSeam;
  /** 执行队列（「向执行队列投递」的落点；夹具侧的假执行侧）。 */
  readonly execQueue: PendingEvent[] = [];
  readonly defect: P2Defect;
  scheduler: Scheduler;
  readonly #idSource: IdSource;
  #lastStep: AdvanceStep | null = null;
  /** `drop_outbox` 缺陷的开关（仅在投递事务期间打开）。 */
  #dropOutbox = false;

  constructor(scenario: string, options: { readonly defect?: P2Defect } = {}) {
    this.clock = new LogicalClock();
    this.injector = new FaultInjector({ isolated: true, scenario });
    this.defect = options.defect ?? 'none';
    const raw = createMemoryStore({
      clock: () => this.clock.now(),
      // D06 已提供：三个同步钩子（默认关闭时为空操作），接 tripSync。
      faults: storeFaultHooks(this.injector),
    });
    this.store = this.defect === 'none' ? raw : this.#wrapWithDefect(raw);
    this.#idSource = createIdSource({ seed: scenario });

    const baseline = createScenarioBaseline({ at: this.clock.time });
    this.store.transact((tx) => {
      tx.putInstance(baseline.instance_c);
      // R35.5（F07）：注册标准发送成员。成员登记在**独立成员表**，不是 `putInstance`
      // ——后者会改变 `instances` 计数与调度观测口径。
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
    this.scheduler = this.#createScheduler();
  }

  /** I-P2-1 的载体：把「写待投递调度事件」吞掉（消息与排队标记照常提交）。 */
  #wrapWithDefect(store: Store): Store {
    return new Proxy(store, {
      get: (target, prop) => {
        if (prop === 'transact') {
          return <T>(work: (tx: StorageTransaction) => T): T =>
            target.transact((tx) =>
              work(
                new Proxy(tx, {
                  get: (txTarget, txProp) => {
                    if (txProp === 'enqueueDeliveryEvent') {
                      return (event: PendingEvent): void => {
                        if (this.#dropOutbox) return;
                        txTarget.enqueueDeliveryEvent(event);
                      };
                    }
                    const value = Reflect.get(txTarget, txProp, txTarget) as unknown;
                    return typeof value === 'function'
                      ? (value as (...a: unknown[]) => unknown).bind(txTarget)
                      : value;
                  },
                }),
              ),
            );
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** 打开 / 关闭 I-P2-1 注入（只在待注入的投递事务周围打开）。 */
  armOutboxDrop(): void {
    this.#dropOutbox = true;
  }
  disarmOutboxDrop(): void {
    this.#dropOutbox = false;
  }

  #createScheduler(): Scheduler {
    return createScheduler(this.store, {
      clock: () => this.clock.now(),
      idSource: this.#idSource,
      default_task_id: BASELINE_TASK_ID,
      deliverySink: (event) => {
        this.execQueue.push(event);
      },
      onDeliveryCommitted: (note) => {
        this.seam.noteDeliveryCommit({ ...note, label: note.result });
      },
    });
  }

  /** 模拟恢复：丢弃当前调度器对象、**重建**调度器并复用同一存储（规格 6.3）。 */
  rebuildScheduler(): void {
    this.seam.unbind();
    this.scheduler = this.#createScheduler();
    this.seam.bind(() => {
      const step = this.scheduler.advanceOnce();
      this.#lastStep = step;
      return step;
    });
  }

  /** 首次挂接（构造时不自动挂接，保持「未 bind 不能推进」的结构）。 */
  bindAdvance(): void {
    this.seam.bind(() => {
      const step = this.scheduler.advanceOnce();
      this.#lastStep = step;
      return step;
    });
  }

  // ---- 故障注入（仅隔离配置）--------------------------------------------

  armInterrupt(
    point: InjectionPoint,
    committed: readonly string[],
    pending: readonly string[],
    detail?: string,
  ): void {
    this.injector.register({
      point,
      behavior: 'interrupt',
      times: 1,
      committed,
      pending,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  armFail(point: InjectionPoint, detail?: string): void {
    this.injector.register({
      point,
      behavior: 'fail',
      times: 1,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  // ---- 投递 ---------------------------------------------------------------

  makeRequest(spec: P2RequestSpec): DeliveryRequest {
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
    });
  }

  /** 投递一条消息并**捕获**异常（P2 的三个注入点都会让入口抛错或返回 failed）。 */
  deliverCatching(request: DeliveryRequest): P2DeliverResult {
    try {
      const outcome = this.scheduler.onMessage(request.message);
      return { outcome, thrown: null, accepted_but_unpublished: false, committed: [], pending: [] };
    } catch (thrown) {
      const isPublication = thrown instanceof PublicationError;
      const committed =
        thrown instanceof Error && 'committed' in thrown && Array.isArray((thrown as { committed?: unknown }).committed)
          ? ((thrown as { committed: string[] }).committed)
          : [];
      const pending =
        thrown instanceof Error && 'pending' in thrown && Array.isArray((thrown as { pending?: unknown }).pending)
          ? ((thrown as { pending: string[] }).pending)
          : [];
      return { outcome: null, thrown, accepted_but_unpublished: isPublication, committed, pending };
    }
  }

  // ---- 恢复（复用 D06 的 attemptRecovery / runRecoveryAttempts）------------

  recover(attempts: number, via: RecoveryRun['via'] = 'replayUndelivered'): readonly RecoveryRun[] {
    return runRecoveryAttempts(this.store, (event) => this.execQueue.push(event), attempts, { via });
  }

  // ---- 观测 ---------------------------------------------------------------

  pendingDeliveryEvents(): readonly PendingEvent[] {
    return this.store.pendingDeliveryEvents();
  }

  /** 已投递到「执行队列」的待投递事件中，属于某条消息的那些（P2-03 / P2-06 的原始观测）。 */
  publishedFor(messageId: string): readonly PendingEvent[] {
    return this.execQueue.filter((event) => event.payload['message_id'] === messageId);
  }

  kernelEventCount(kind: string): number {
    return this.snapshot().kernel_events.filter((event) => event.kind === kind).length;
  }

  inboxEntryCount(messageId: string): number {
    return this.snapshot().inbox_entries.filter((entry) => entry.message_id === messageId).length;
  }

  workItemCount(requestId: string): number {
    return this.snapshot().work_items.filter((item) => item.request_id === requestId).length;
  }

  runsReading(requestId: string): readonly string[] {
    return this.snapshot()
      .runs.filter((run) => run.frozen_request_ids.includes(requestId as RequestId))
      .map((run) => run.run_id);
  }

  snapshot(): StoreSnapshot {
    return this.scheduler.snapshot();
  }

  counters(): CounterTriple {
    const event = summarizeKernelEvents(this.snapshot().kernel_events);
    const snapshot = summarizeSnapshotCounters(this.snapshot());
    return { event, snapshot, merged: mergeSchedulingCounters(event, snapshot) };
  }

  async advanceOnce(label: string): Promise<AdvanceStep> {
    await this.seam.advanceOnce(label);
    const step = this.#lastStep;
    if (step === null) throw new Error('推进接缝未回传 AdvanceStep（夹具接线错误）');
    return step;
  }

  async advanceUntilIdle(maxSteps: number, label: string): Promise<void> {
    await this.seam.advanceUntilIdle(maxSteps, label);
  }

  finishCompleted(runId: RunId, requestId: RequestId): void {
    const outcome = this.scheduler.finishRun({
      run_id: runId,
      publications: [
        { kind: 'completed', request_id: requestId, result_refs: [artifactRefFor(requestId, 'result')] },
      ],
    });
    if (!outcome.accepted) {
      throw new Error(`finish_run 被拒（${String(outcome.rejection_reason)}）：夹具无法产出结局`);
    }
  }

  /** 直接尝试一次发布尝试（P2-12 的「旧 run_id 发布尝试」观测口）。 */
  attemptFinish(runId: RunId, requestId: RequestId): {
    readonly accepted: boolean;
    readonly rejection_reason: string | null;
  } {
    const outcome = this.scheduler.finishRun({
      run_id: runId,
      publications: [
        { kind: 'completed', request_id: requestId, result_refs: [artifactRefFor(requestId, 'late')] },
      ],
    });
    return { accepted: outcome.accepted, rejection_reason: outcome.rejection_reason };
  }

  /** 观测到的注入记录（证明注入真的发生、发生在哪个点）。 */
  firedInjections(): readonly { readonly index: number; readonly point: string; readonly behavior: string }[] {
    return this.injector.fired.map((f) => ({ index: f.index, point: f.point, behavior: f.behavior }));
  }

  static at(value: number): LogicalTime {
    return asLogicalTime(value);
  }
}

/** 便捷：把消息 id 折成 `MessageId`。 */
export function messageIdOf(value: string): MessageId {
  return asMessageId(value);
}

/** 便捷：把 run id 折成 `RunId`。 */
export function runIdOf(value: string): RunId {
  return asRunId(value);
}
