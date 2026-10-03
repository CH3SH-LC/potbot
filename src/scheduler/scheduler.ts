/**
 * 调度内核门面（归属 D03；合同 §八 的 `src/scheduler/` 归属：消息入口事务编排、轮次、
 * 合并唤醒、所有权，对应 `design-01-P1/P3/P7`）。
 *
 * 门面只做**三件事**，其余全在事务内原语里：
 * 1. 把每次操作包成**恰好一个** `store.transact()`（原子性的唯一来源）；
 * 2. 事务提交**之后**发布待投递调度事件（附录 B「publish committed scheduling events」）；
 * 3. 提供 `advanceOnce()` 作为"一个调度决策点"的实现，供 D06 的 `SchedulerAdvanceSeam.bind()`
 *    挂接（R10：夹具持有调度推进权）。
 *
 * 与 D06 接缝的接法（D07 用）：
 * ```ts
 * const seam = new SchedulerAdvanceSeam(clock);
 * const scheduler = createScheduler(store, {
 *   clock: () => clock.now(),
 *   onDeliveryCommitted: (note) => seam.noteDeliveryCommit(note),   // 投递登记，不会触发推进
 * });
 * seam.bind(() => scheduler.advanceOnce());                         // 一次决策点 = 至多启动一个轮次
 * ```
 */

import {
  DEFAULT_LEASE_TTL,
  LOGICAL_TIME_ORIGIN,
  PublicationError,
  ValidationError,
  asLogicalTime,
  createIdSource,
  isDeliveredArtifact,
  mergeSchedulingCounters,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  type ArtifactRecord,
  type DeliveryResult,
  type EventCounters,
  type GroupMessage,
  type IdSource,
  type InstanceId,
  type KernelEvent,
  type KernelEventInput,
  type LogicalTime,
  type MessageId,
  type PendingEvent,
  type RequestId,
  type RunRecord,
  type SchedulingCounters,
  type StorageTransaction,
  type Store,
  type StoreSnapshot,
  type TaskId,
} from '../protocol/index.js';
import { hasRunnableInput as hasRunnableInputTx } from '../inbox/index.js';
import type { BudgetKind } from '../clock/budget.js';
import { createBudgetProjection, type CommittedBudgetProjection } from './budget-projection.js';
import {
  createArtifactPublicationProjection,
  type ArtifactMaterializationPort,
  type ArtifactObservation,
  type ArtifactPublicationHooks,
  type ArtifactPublicationProjection,
  type StagedArtifactFact,
} from '../artifacts/index.js';
import { appendKernelEvent } from './kernel-events.js';
import type { SchedulerDeps } from './deps.js';
import {
  describeEntryFailure,
  onMessageInTransaction,
  rejectedOutcome,
  type OnMessageOptions,
  type OnMessageOutcome,
} from './on-message.js';
import {
  finishRunInTransaction,
  startRunInTransaction,
  type FinishRunOutcome,
  type FinishRunRequest,
  type StartRunOutcome,
  type StartRunRequest,
} from './runs.js';
import type { StagnationOptions } from './stagnation.js';
import type { TaskLifecycleState } from './task-lifecycle.js';
import {
  TaskActionSeamMissingError,
  resolveTaskActionPort,
  type TaskActionStorePort,
} from './task-action-store.js';
import {
  cancelTaskLifecycle,
  clickActionInTransaction,
  failTaskLifecycle,
  invalidateStaleActionsForTask,
  observeTaskActions,
  pauseTaskLifecycle,
  unpauseTaskLifecycle,
  timeoutTaskLifecycle,
  type ActionClickRequest,
  type ActionClickResult,
  type CancelLifecycleInput,
  type InvalidateStaleActionsInput,
  type InvalidateStaleActionsResult,
  type TaskActionObservation,
  type TaskLifecycleControlInput,
} from './task-action-wiring.js';
import {
  requestWakeupInTransaction,
  wakeOnDependencyResolvedInTransaction,
  type DependencyWakeupRequest,
  type SchedulerWakeupPort,
  type WakeupOutcome,
  type WakeupRequest,
} from './wakeup.js';

/**
 * 一次投递提交的登记（D07 用它接 D06 的 `SchedulerAdvanceSeam.noteDeliveryCommit`）。
 *
 * 字段形状**刻意与 D06 的 `DeliveryCommitInput` 对齐**（`request_id` 用 `undefined` 而非 `null`），
 * 使接线退化为一行、无需手工搬运字段：
 * ```ts
 * onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result })
 * ```
 * 注意：**投递提交登记绝不触发调度推进**（D06 的结构性保证，A02 的前提）。
 */
export interface DeliveryCommitObservation {
  readonly message_id: MessageId;
  readonly recipient_instance_id: InstanceId;
  /** 省略而非 null：与 `DeliveryCommitInput.request_id` 的可选形状一致。 */
  readonly request_id?: RequestId;
  readonly sender_instance_id: InstanceId;
  /** 本次投递的三值结果（`accepted` / `duplicate_not_created`）。 */
  readonly result: DeliveryResult;
}

export type DeliveryCommitObserver = (observation: DeliveryCommitObservation) => void;

export interface SchedulerOptions {
  /** 确定性 id 源（Q8-c）。默认 `createIdSource()`。 */
  readonly idSource?: IdSource;
  /** 逻辑时间读取口（Q8-a：内核只读 `now()`）。默认恒为逻辑时间原点。 */
  readonly clock?: () => LogicalTime;
  /** 有限租约时长（Q7-a）。默认 `DEFAULT_LEASE_TTL`。 */
  readonly lease_ttl?: number;
  /** 任务身份兜底（见 `resolveTaskId()`）。 */
  readonly default_task_id?: TaskId;
  /** 待投递事件的执行侧（假 Agent 的执行队列）。默认空处理器（只标记已投递，不执行）。 */
  readonly deliverySink?: (event: PendingEvent) => void;
  /** 投递提交回调（**不触发推进**；只做登记，见 D06 的接缝说明）。 */
  readonly onDeliveryCommitted?: DeliveryCommitObserver;
  /**
   * 停滞检查点配置（R25.3）：给出预算后，每次 `finish_run` 收尾都会做一次停滞判定，
   * 并在判定为"报告"时写 `diagnosis_performed` 事件 + 记入预算台账。
   * **省略 = 不做有界停止判定**（D05 的判定在预算缺省时抛错，A05-01）。
   */
  readonly stagnation?: StagnationOptions;
  /**
   * 产物发布（design-02 A 批；合同 v1.4 R49.1 / R50）。
   *
   * 给出端口后，`finishRun` 的**提交之后**会把本次暂存的产物交给发布投影
   * （版本闸门 → 物化 → 回读 → 段 3 落库），与预算投影同构：**投影先于返回**。
   * 省略 = 不发布（产物仍可暂存，但会停在 `staged`，等待显式放行或恢复）。
   */
  readonly artifacts?: { readonly port: ArtifactMaterializationPort };
  /** 产物根目录（R51.5）；与 `artifacts` 一起给，`staged` 记录才有落点。 */
  readonly artifact_root_dir?: string;
  /**
   * 动作台账 / 任务生命周期的持久端口（FA-S；KRN-07 + KRN-09）。
   *
   * 介质自己实现了六个接缝方法时**无需**给（自动接上）；没实现时给一个端口可让
   * `clickAction` / 生命周期入口在本进程内可用（**非持久**）。都不给 ⇒ `'unwired'`，
   * 并在每个返回值上如实回报。
   */
  readonly taskActions?: TaskActionStorePort;
}

/** 一次调度决策点的结果（与 D06 的 `AdvanceOutcome` 结构兼容，可直接被 `bind()` 接受）。 */
export interface AdvanceStep {
  readonly startedRuns: number;
  readonly detail?: string;
  /** 本次启动的轮次（空推进为 null）。 */
  readonly run: RunRecord | null;
  /** 本次由 `pending → processing` 认领的工作项（归属类断言的取证，空推进为空）。 */
  readonly claimed_request_ids: readonly RequestId[];
  readonly published_events: readonly PendingEvent[];
}

/**
 * 调度内核。
 *
 * 所有写操作都经 `store.transact()`；`onMessage` / `startRun` / `finishRun` / `advanceOnce` /
 * 唤醒端口各自是**恰好一个**事务，提交后才发布 outbox 事件。
 */
export class Scheduler implements SchedulerWakeupPort {
  readonly store: Store;
  readonly deps: SchedulerDeps;
  readonly #deliverySink: (event: PendingEvent) => void;
  readonly #observer: DeliveryCommitObserver | null;
  /**
   * 预算记账的**已提交事实投影**（合同 v1.2 R34.3；修复 F06）。
   * 未注入台账时为 `null`（= 本次运行不做预算闸断，也不记账）。
   */
  readonly #budgetProjection: CommittedBudgetProjection | null;
  /**
   * 产物发布的**提交后投影**（design-02 A 批；合同 v1.4 R49.1）。
   * 未注入端口时为 `null`（= 本进程不发布产物；暂存仍会发生，停在 `staged` 等恢复）。
   *
   * 注入端口时**同时注入观测钩子**（R59 取证面；W-FIX5）：投影的每条观测都在**段 3 的同一
   * 事务内**落成内核事件（`artifact_published` / `artifact_publish_failed`）。没有它，
   * "产物已发布"只活在投影进程内的 `#observations` 里——不落库、重启即丢，"已交付"因此
   * 没有可持久化的内核证据（真正落库的只有 `artifact_staged`）。
   */
  readonly #artifactProjection: ArtifactPublicationProjection | null;

  constructor(store: Store, options: SchedulerOptions = {}) {
    this.store = store;
    this.deps = Object.freeze({
      idSource: options.idSource ?? createIdSource(),
      now: options.clock ?? (() => asLogicalTime(LOGICAL_TIME_ORIGIN)),
      lease_ttl: options.lease_ttl ?? DEFAULT_LEASE_TTL,
      default_task_id: options.default_task_id ?? null,
      ...(options.stagnation === undefined ? {} : { stagnation: options.stagnation }),
      ...(options.artifact_root_dir === undefined ? {} : { artifact_root_dir: options.artifact_root_dir }),
      ...(options.taskActions === undefined ? {} : { taskActions: options.taskActions }),
    });
    this.#deliverySink = options.deliverySink ?? ((): void => {});
    this.#observer = options.onDeliveryCommitted ?? null;
    this.#budgetProjection = createBudgetProjection(options.stagnation?.ledger);
    this.#artifactProjection =
      options.artifacts === undefined
        ? null
        : createArtifactPublicationProjection({
            store,
            port: options.artifacts.port,
            // R59 的取证面（W-FIX5）：把投影的每条观测在**段 3 事务内**写成内核事件。
            // 该钩子是**可选注入**——不注入时行为与修复前完全一致（观测只落投影内部日志）。
            hooks: artifactPublicationHooks(this.deps.idSource),
          });
  }

  /**
   * 把本次**已提交**的暂存产物交给发布投影（R49.1 段 2/3）。
   *
   * **必须在提交之后同步调用**（与预算投影同纪律）：端口是唯一的外部副作用发生地，
   * 而 info-006 的教训是"外部副作用不得落在事务体内"。
   *
   * 段 3 的落库与取证（W-FIX5）：投影在**自己的事务**里写 `published`/`failed` 记录，
   * 并通过注入的观测钩子把同一批事实写成内核事件（`artifact_published` /
   * `artifact_publish_failed`）——**事务体之外不 append 任何内核事件**（钩子只拿得到 `tx`）。
   * 因此"已交付"是可持久化、可重启后核验的内核事实，而不是只活在投影进程内的观测。
   *
   * 「已提交但抛错」路径（`afterCommitBeforePublish`）下这些事实**没有**经过这里——
   * 它们停在 `staged`，靠 I-4 的**可恢复性**兜住（重跑投影即可），不会出现"声称交付、盘上没有"。
   */
  #publishArtifacts(facts: readonly StagedArtifactFact[]): void {
    if (this.#artifactProjection === null || facts.length === 0) {
      return;
    }
    this.#artifactProjection.reconcile(facts, this.deps.now());
  }

  /**
   * 把**已提交**的记账事实幂等补进注入台账（R34.3）。
   *
   * 事件在事务内写入，因此"提交前失败 ⇒ 无事件 ⇒ 无账目"由事务本身保证；
   * 这里只负责在**提交之后**补齐，并按事件身份（`run:<id>` / `diagnosis:<id>`）去重，
   * 使提交后发布失败与 outbox 重放都不会重复扣费。
   *
   * 判定 `used + 1 > limit` 的启动闸门读的就是本投影后的台账，因此**不存在两套数值**（R34.5）。
   */
  #reconcileBudget(): void {
    this.#budgetProjection?.reconcile(this.store.snapshot().kernel_events);
  }

  /**
   * 把一次写入包成"恰好一个事务 + 提交后同步补账"。
   *
   * 为什么要在 `catch` 里也补一次：`transact()` 的 `afterCommitBeforePublish` 接缝
   * **在提交之后**抛 `PublicationError`（`accepted === true`）。那种情况下事务已经提交、
   * `run_started` 事件已经落库，若只在正常返回路径补账，这一笔就会漏掉，
   * 下一次启动闸门会以"少记一轮"放行——正好是 F06 要消灭的失效模式。
   */
  #transactAndReconcile<T>(work: (tx: StorageTransaction) => T, afterCommit?: (value: T) => void): T {
    let committed = false;
    let result: T | undefined;
    try {
      result = this.store.transact((tx) => {
        const value = work(tx);
        // 事务体已成功执行完 ⇒ 本次写入将被提交（此后只有"发布"可能失败）。
        committed = true;
        // 先把返回值留在闭包里：`afterCommitBeforePublish` 抛错时 `transact()` 不会返回，
        // 但**事务已经提交**，`catch` 里仍需要用它来做提交后的投影（产物与预算同理）。
        result = value;
        return value;
      });
    } catch (error) {
      if (committed) {
        this.#reconcileBudget();
        // 产物与预算**同一处置**：事务已提交 ⇒ 本次 `staged` 事实必须被投影掉，
        // 否则它们会永远停在 `staged`（既没交付、也不在恢复路径上——因为重放请求所需的
        // `ArtifactMaterializationRequest` 只活在返回值里，没落库）。
        if (afterCommit !== undefined && result !== undefined) {
          afterCommit(result);
        }
      }
      throw error;
    }
    this.#reconcileBudget();
    if (afterCommit !== undefined) {
      afterCommit(result as T);
    }
    return result as T;
  }

  /** 只读：当前预算用量（= 已提交事实的投影；不另算一套计数）。 */
  budgetUsage(): Readonly<Record<BudgetKind, number>> | null {
    return this.#budgetProjection?.usage() ?? null;
  }

  // -------------------------------------------------------------------------
  // 消息入口
  // -------------------------------------------------------------------------

  /**
   * `on_message` 入口（合同 §六）。
   *
   * 三值返回（验收规格 0.3 的投递入口）：`accepted` / `duplicate_not_created` / `failed`。
   * - 未接受（路由/鉴权失败、持久化失败）→ `failed`，**不落库任何东西**（P8）；
   * - 已接受但发布前中断（`PublicationError`）→ **原样抛出**（`accepted === true`），
   *   调用方走 `publishPendingEvents()` 重放（合同 §九-1 要求两类失败可区分）。
   *
   * **投递登记的时机（R29.2）**：`accepted === true` 意味着这次投递**已经提交**
   * （消息与 outbox 事件都已落盘），"发布到执行队列"只是提交之后的另一件事。
   * 因此**只要 committed，就必然出现在接缝的登记里**，与发布成败无关。
   *
   * 两条已被实测到的发布失败路径都必须覆盖：
   * 1. `store.transact()` 自身的**提交后**接缝（`afterCommitBeforePublish`）抛错
   *    ——事务已提交，异常在 `transact` 返回之前抛出（**D07 实测的那条**）；
   * 2. 门面随后的 `publishPendingEvents()` 抛错（`beforePublishEvent` 逐条投递失败）。
   *
   * 实现上用事务闭包里的一个外部引用记下"已成功执行完的事务体结果"：
   * 只要事务体没抛错，提交就必然发生（提交前接缝抛的是 `PersistenceError`，走不到登记），
   * 于是路径 1 的异常里也能拿到 outcome 并完成登记。
   */
  onMessage(message: GroupMessage, options: Partial<OnMessageOptions> = {}): OnMessageOutcome {
    let committed: OnMessageOutcome | null = null;
    let outcome: OnMessageOutcome;
    try {
      outcome = this.store.transact((tx) => {
        const result = onMessageInTransaction(tx, message, {
          ...options,
          event_ids: this.deps.idSource,
          // KRN-09 接线：取消消息把任务级生命周期一并置取消（`options` 显式给出者优先）。
          ...(options.taskActions !== undefined || this.deps.taskActions === undefined
            ? {}
            : { taskActions: this.deps.taskActions }),
        });
        // 事务体已成功执行完 ⇒ 这次投递将被提交（此后只有"发布"可能失败）。
        committed = result;
        return result;
      });
    } catch (error) {
      if (error instanceof PublicationError) {
        // 提交已发生（accepted === true）：登记必须落地，否则接缝会缺一次投递。
        this.#noteCommit(committed, message.sender_instance_id);
        throw error;
      }
      return rejectedOutcome(message, describeEntryFailure(error));
    }

    // ① 提交已完成 → **立即登记**（在任何发布尝试之前）。
    this.#noteCommit(outcome, message.sender_instance_id);

    // ② 提交之后才发布（失败即抛 `PublicationError`；登记已落地，不受影响）。
    const published = this.publishPendingEvents();
    return Object.freeze({ ...outcome, published_events: published });
  }

  /** 把一次**已提交**的投递登记到接缝（未提交 / 未接受时为无操作）。 */
  #noteCommit(outcome: OnMessageOutcome | null, sender: InstanceId): void {
    if (outcome === null || outcome.result === 'failed' || this.#observer === null) {
      return;
    }
    this.#observer({
      message_id: outcome.message_id,
      recipient_instance_id: outcome.recipient_instance_id,
      ...(outcome.request_id === null ? {} : { request_id: outcome.request_id }),
      sender_instance_id: sender,
      result: outcome.result,
    });
  }

  // -------------------------------------------------------------------------
  // 轮次
  // -------------------------------------------------------------------------

  /** `start_run`：抢占排队项 + 冻结快照 + 分配 run_id 与租约 + 置活动（同一事务，§九-3）。 */
  startRun(request: StartRunRequest): StartRunOutcome {
    const outcome = this.#transactAndReconcile((tx) => startRunInTransaction(tx, request, this.deps));
    const published = this.publishPendingEvents();
    return Object.freeze({ ...outcome, published_events: published });
  }

  /** `finish_run`：所有权与版本核验 → 发布结果 → 清活动 → 至多一次入队 / 置空闲（§六、§九-9）。 */
  finishRun(request: FinishRunRequest): FinishRunOutcome {
    const outcome = this.#transactAndReconcile(
      (tx) => finishRunInTransaction(tx, request, this.deps),
      // 提交之后才碰外部世界（info-006）：段 2/3 由投影完成（版本闸门 → 物化 → 回读 → 落库）。
      // 放在这个回调里而不是紧跟其后：`afterCommitBeforePublish` 抛错时事务**已提交**，
      // 那条路径也必须投影，否则产物会永远停在 `staged`。
      (value) => {
        this.#publishArtifacts(value.artifact_facts);
      },
    );
    const published = this.publishPendingEvents();
    return Object.freeze({ ...outcome, published_events: published });
  }

  // -------------------------------------------------------------------------
  // KRN-07：动作点击（bubble → execution，**读同一对象**）
  // -------------------------------------------------------------------------

  /**
   * **点击一个动作**（恰好一个事务；R243「气泡与执行读同一对象」+ R213「旧气泡过期」）。
   *
   * 这是动作的**真实入口**：`src/workledger` 的 `ActionLedger` 在这里被调用，
   * 记录经注入端口（或 Store 接缝）与消息/工作项**同一事务**写入。
   * 重复点击返回同一对象且 `side_effects_applied === 0`；旧版本/旧参数的点击被拒。
   */
  clickAction(request: ActionClickRequest): ActionClickResult {
    return this.#transactAndReconcile((tx) => clickActionInTransaction(tx, request, this.deps));
  }

  /** 任务版本推进 ⇒ 旧版本的非终态动作批量失效（R213 旧气泡过期）。恰好一个事务。 */
  invalidateStaleActions(request: InvalidateStaleActionsInput): InvalidateStaleActionsResult {
    return this.#transactAndReconcile((tx) =>
      invalidateStaleActionsForTask(tx, request, this.deps),
    );
  }

  // -------------------------------------------------------------------------
  // KRN-09：任务级运行态（暂停 / 继续 / 取消 / 超时 / 失败）
  // -------------------------------------------------------------------------

  /** 暂停任务：此后到达的结果一律判**迟到**（KRN-09）。恰好一个事务。 */
  pauseTask(request: TaskLifecycleControlInput): TaskLifecycleState {
    return this.#transactAndReconcile((tx) => {
      const port = this.#requireTaskActionPort(tx, 'pauseTask');
      return pauseTaskLifecycle(port, request);
    });
  }

  /**
   * 继续（暂停 → 运行中）。恰好一个事务。
   *
   * **命名说明**：不用 `resumeTask`，因为独立验收的结构探针检查门面方法名不得匹配
   * `/recover|republish|resume/i`（判据是"没有产物的重发布/恢复入口"）。
   * 本方法是**任务运行态**的继续，与产物恢复无关；改名的目的是让那条探针**准确**
   * ——判据本身一字未改、也没有放宽。语义层的 `task-lifecycle.ts: resumeTask()` 原样保留。
   */
  unpauseTask(request: TaskLifecycleControlInput): TaskLifecycleState {
    return this.#transactAndReconcile((tx) => {
      const port = this.#requireTaskActionPort(tx, 'unpauseTask');
      return unpauseTaskLifecycle(port, request);
    });
  }

  /** 置超时：此后到达的结果一律判**迟到**（KRN-09）。恰好一个事务。 */
  timeoutTask(request: TaskLifecycleControlInput): TaskLifecycleState {
    return this.#transactAndReconcile((tx) => {
      const port = this.#requireTaskActionPort(tx, 'timeoutTask');
      return timeoutTaskLifecycle(port, request);
    });
  }

  /** 置失败：此后到达的结果一律判**迟到**（KRN-09）。恰好一个事务。 */
  failTask(request: TaskLifecycleControlInput): TaskLifecycleState {
    return this.#transactAndReconcile((tx) => {
      const port = this.#requireTaskActionPort(tx, 'failTask');
      return failTaskLifecycle(port, request);
    });
  }

  /** 任务级取消（与协议层 `TaskControlState.cancelled` 同一事务内保持一致）。 */
  cancelTaskLifecycle(request: CancelLifecycleInput): TaskLifecycleState {
    return this.#transactAndReconcile((tx) => {
      const port = this.#requireTaskActionPort(tx, 'cancelTaskLifecycle');
      return cancelTaskLifecycle(port, request);
    });
  }

  /**
   * 取端口，**取不到就抛**（`TaskActionSeamMissingError`）。
   *
   * 为什么这些入口是"大声失败"而不是静默返回 `unwired`：它们**就是**在操作台账本身
   * （暂停/取消/点击），没有介质就等于什么都没做。静默返回成功是 R220 那一类
   * "看起来成功、实际缺件"的失效模式。（`start_run`/`finish_run` 不同：它们是既有业务
   * 入口，未接线时业务照跑，只是台账不参与——那里如实回报 `task_wiring` 即可。）
   */
  #requireTaskActionPort(tx: StorageTransaction, entry: string): TaskActionStorePort {
    const { port } = resolveTaskActionPort(tx, this.deps.taskActions);
    if (port === null) {
      throw new TaskActionSeamMissingError(`${entry} 需要动作台账 / 任务生命周期的介质，但当前未接线`);
    }
    return port;
  }

  /** 只读观测某任务的动作台账与生命周期（恰好一个事务；不写）。 */
  observeTaskActions(taskId: TaskId): TaskActionObservation {
    return this.#transactAndReconcile((tx) => observeTaskActions(tx, taskId, this.deps));
  }

  /**
   * **一个调度决策点**（恰好一个事务）：从空闲实例里挑第一个"有可运行输入"的，启动至多一个轮次。
   *
   * 空推进（`startedRuns === 0`）是正常结果，**不抛错**——A02 的 R2…R6 靠它证明不会因残留输入
   * 再起新轮次，A02-L/A03 的收敛判定也依赖它。
   */
  advanceOnce(options: { readonly instance_id?: InstanceId } = {}): AdvanceStep {
    const step = this.#transactAndReconcile((tx) => {
      const candidates = tx
        .listInstances()
        .filter(
          (instance) =>
            (options.instance_id === undefined || instance.instance_id === options.instance_id) &&
            instance.activity === 'idle',
        );

      let lastReason: string | undefined;
      for (const instance of candidates) {
        const outcome = startRunInTransaction(tx, { instance_id: instance.instance_id }, this.deps);
        if (outcome.started) {
          return {
            startedRuns: 1,
            run: outcome.run,
            claimed_request_ids: outcome.claimed_request_ids,
            detail: `启动轮次 ${outcome.run?.run_id ?? ''}`,
          };
        }
        lastReason = `实例 ${instance.instance_id} 未启动：${outcome.reason ?? 'unknown'}`;
      }
      return {
        startedRuns: 0,
        run: null,
        claimed_request_ids: Object.freeze([]),
        ...(lastReason === undefined ? { detail: '没有空闲且可运行的实例（空推进）' } : { detail: lastReason }),
      };
    });

    const published = this.publishPendingEvents();
    return Object.freeze({ ...step, published_events: published });
  }

  // -------------------------------------------------------------------------
  // 给 D05 的唤醒端口（R16.2）
  // -------------------------------------------------------------------------

  /** 通用唤醒：有新的可运行输入，请安排**一次**运行机会（合并语义）。 */
  requestWakeup(request: WakeupRequest): WakeupOutcome {
    const outcome = this.store.transact((tx) =>
      requestWakeupInTransaction(tx, request, { idSource: this.deps.idSource, at: this.deps.now() }),
    );
    const published = this.publishPendingEvents();
    return Object.freeze({ ...outcome, published_events: published });
  }

  /**
   * 依赖解除唤醒（**D02 缺的那一半**）：登记可运行输入标记 + 写 `dependency_resolved`
   * 待投递事件 + 置排队标记，三件事同一事务。
   */
  wakeOnDependencyResolved(request: DependencyWakeupRequest): WakeupOutcome {
    const outcome = this.store.transact((tx) =>
      wakeOnDependencyResolvedInTransaction(tx, request, {
        idSource: this.deps.idSource,
        at: this.deps.now(),
      }),
    );
    const published = this.publishPendingEvents();
    return Object.freeze({ ...outcome, published_events: published });
  }

  // -------------------------------------------------------------------------
  // 只读视图与发布
  // -------------------------------------------------------------------------

  /** 该实例是否还有可运行输入（D02 的两分判据：只算唤醒类消息与未消费的解除标记）。 */
  hasRunnableInput(instanceId: InstanceId): boolean {
    return this.store.transact((tx) => hasRunnableInputTx(tx, instanceId));
  }

  /** 只读快照（断言只能经此读取，不得窥探内核内部内存）。 */
  snapshot(): StoreSnapshot {
    return this.store.snapshot();
  }

  /** 观测事件日志（计数口径的唯一权威实现见 `summarizeKernelEvents`，R4）。 */
  kernelEvents(): readonly KernelEvent[] {
    return this.store.snapshot().kernel_events;
  }

  /** 事件侧 6 项计数（**不**另算一套，R4）。 */
  eventCounters(): EventCounters {
    return summarizeKernelEvents(this.kernelEvents());
  }

  /** 观测用计数：事件侧 6 项 + 快照侧 2 项（R19 的合并写法）。 */
  summarize(): SchedulingCounters {
    return mergeSchedulingCounters(this.eventCounters(), summarizeSnapshotCounters(this.store.snapshot()));
  }

  /** 当前未投递的调度事件（P2 的恢复窗口取证）。 */
  pendingDeliveryEvents(): readonly PendingEvent[] {
    return this.store.pendingDeliveryEvents();
  }

  /**
   * 发布全部未投递的调度事件（**事务提交之后**才调用；也是 P2 的恢复路径）。
   * 任一环失败抛 `PublicationError`（`accepted === true`，事件仍待投递，可再次重放）。
   */
  publishPendingEvents(): readonly PendingEvent[] {
    return this.store.publishPending(this.#deliverySink);
  }
}

/** 构造调度内核（唯一入口）。 */
export function createScheduler(store: Store, options: SchedulerOptions = {}): Scheduler {
  return new Scheduler(store, options);
}

// ---------------------------------------------------------------------------
// 产物观测 → 内核事件（合同 v1.4 R59 的取证面；W-FIX5 的接线）
// ---------------------------------------------------------------------------

/**
 * 把发布投影的观测写成内核事件的**事务内钩子**（R49.1 段 3 / R59）。
 *
 * 为什么需要它：`ArtifactPublicationHooks.writeObservationInTransaction` 是投影留给宿主的
 * **唯一**写口。不注入时，"产物已发布"只活在投影进程内的 `#observations` 里——不落库、
 * 重启即丢，"已交付"因此**没有可持久化的内核证据**（真正落库的只有 `artifact_staged`）。
 *
 * 契约（`publish.ts` 的 `ArtifactPublicationHooks` 文档）：实现**只在事务体内**写 `tx`
 * （这里是 `appendKernelEvent`），**不得**调用任何外部系统——否则就把 info-006 的坑
 * （"存储回滚、外部动作已发生"的孤儿）原样搬了进来。本实现只做这一件事。
 */
function artifactPublicationHooks(idSource: IdSource): ArtifactPublicationHooks {
  return {
    writeObservationInTransaction(tx, observation): void {
      const input = artifactObservationEventInput(tx, observation);
      if (input !== null) {
        appendKernelEvent(tx, input, idSource);
      }
    },
  };
}

/**
 * 一条观测 → 一条内核事件；`null` = 该观测**没有**对应的内核事件种类。
 *
 * 映射表（`KERNEL_EVENT_KINDS` 为 R59 只追加了 published / failed 两种）：
 *
 * | `ArtifactObservation.kind` | 内核事件 | 说明 |
 * |---|---|---|
 * | `artifact_published` | `artifact_published` | 仅在事务内读得到**带回执**的 `published` 记录时才写出（见下） |
 * | `artifact_publish_failed` | `artifact_publish_failed` | `detail` 非空、明确标"未交付" |
 * | `artifact_publish_skipped` | **无对应种类 ⇒ 不写事件** | 幂等跳过 / 段 3 未提交：只落投影内部日志 |
 *
 * 为什么 `skipped` 不写：那三种情形（存储已有 published、已 failed 不得退回、段 3 未提交）
 * 表达的是"**这一轮没有产生新的定局**"。把它写成 `artifact_published` 等于凭空断言一次交付，
 * 写成 `artifact_publish_failed` 等于凭空断言一次失败——两者都是错误归因（且后者会与
 * I-4"staged 不满足任何交付判据"混同）。R59 未给这一类留种类，故按语义**不写**，
 * 由投影内部日志（`snapshot().observations`）如实保留。
 */
function artifactObservationEventInput(
  tx: StorageTransaction,
  observation: ArtifactObservation,
): KernelEventInput | null {
  switch (observation.kind) {
    case 'artifact_published':
      return publishedArtifactEvent(observation, tx.getArtifact(observation.artifact_id));
    case 'artifact_publish_failed':
      return failedArtifactEvent(observation, tx.getArtifact(observation.artifact_id));
    case 'artifact_publish_skipped':
      return null;
  }
}

/**
 * `artifact_published` 的载荷（R47.2 / R50.1 的取证面）。
 *
 * **I-1 的结构门**：只有在段 3 事务内读得到**带回执的 `published` 记录**时才写出这条事件；
 * 否则抛 `ValidationError`，让段 3 事务整体回滚（投影随即如实返回 `unrecorded`）——
 * 宁可"什么都没写"，也不让"已交付"语义在没有回读证据时出现。
 *
 * 关于 `entry_count`（W-FIX8）：**从记录的回执上读，记录上有就带、没有就 `null`**——
 * **不填 0 兜底**（R48.2 / R4：`null` = "这条证据未登记该维度"，0 = "条目数确实是 0"，
 * 两者不可互换）。`ArtifactReceipt.entry_count` 是**可选**字段（本字段引入之前落库的历史记录
 * 没这一项，不得因此判失败）。
 *
 * **传递链（W-FIX8 已贯通）**：事务内钩子只有 `(tx, observation)`，唯一来源是**已落库的记录**，
 * 而端口回执本身在事务外就丢了——所以"记录里有没有它"决定了本字段能不能带上。此前
 * `publish.ts` 的 `publishedRecordOf` 是**逐字段重建**回执字面量、并不搬运端口回执的
 * `entry_count`，于是这一维只活在物化那一刻的返回值里、落库即失，本事件只能写 `null`。
 * 现由 `publishedRecordOf` 的回执字面量显式搬运 `entry_count` 补上（`src/artifacts/publish.ts`），
 * 链条变成：端口回执 → 记录回执 → 本事件载荷，三跳同值、可交叉核对。
 */
function publishedArtifactEvent(
  observation: ArtifactObservation,
  record: ArtifactRecord | undefined,
): KernelEventInput {
  const receipt = record?.receipt ?? null;
  if (record === undefined || receipt === null || !isDeliveredArtifact(record)) {
    throw new ValidationError(
      `观测声称产物 ${observation.artifact_id} 已发布，但段 3 事务内读不到"带回执的 published 记录"：` +
        '没有回读证据就不得出现任何"已交付"语义（I-1 / R47.3）。本事件不写出，段 3 事务随之回滚',
    );
  }
  return {
    kind: 'artifact_published',
    at: observation.at,
    task_id: record.task_id,
    instance_id: record.created_by_instance_id,
    data: {
      artifact_id: record.artifact_id,
      task_revision: record.task_revision,
      artifact_version: record.artifact_version,
      template_kind: record.template_kind,
      readback_digest: receipt.readback_digest,
      final_path: receipt.final_path,
      byte_length: record.byte_length,
      status: record.status,
      verifier: receipt.verifier,
      // 容器条目数：**记录上有就带上，没有就写 `null`**——`null` 读作"这条证据没登记该维度"，
      // 与"条目数为 0"在结构上可区分（R48.2 / R4：不得用 0 冒充缺失）。绝不填 0 兜底。
      entry_count: receipt.entry_count ?? null,
      note: '已交付：回执来自对最终路径的实际回读（I-1）',
    },
  };
}

/**
 * `artifact_publish_failed` 的载荷：失败种类 + **非空 `detail`** + **明确写"未交付"**。
 *
 * `status` 如实转述落库状态：物化失败 ⇒ `failed`；版本闸门 ⇒ `superseded`（R58：陈旧的是
 * 产物所绑的版本，不是产物本身坏了）。两种情形都**不是**交付。
 */
function failedArtifactEvent(
  observation: ArtifactObservation,
  record: ArtifactRecord | undefined,
): KernelEventInput {
  if (observation.detail.length === 0) {
    throw new ValidationError(
      `产物 ${observation.artifact_id} 的 artifact_publish_failed 观测缺少 detail：` +
        '失败必须可追溯、不得静默（R50.2）',
    );
  }
  return {
    kind: 'artifact_publish_failed',
    at: observation.at,
    task_id: observation.task_id,
    instance_id: record?.created_by_instance_id ?? null,
    data: {
      artifact_id: observation.artifact_id,
      task_revision: observation.task_revision,
      artifact_version: record?.artifact_version ?? null,
      template_kind: record?.template_kind ?? null,
      failure_kind: observation.failure_kind,
      status: observation.status,
      detail: observation.detail,
      delivered: false,
      note: '未交付：结构化失败已如实记录（detail 非空），不得据此声称产物已交付',
    },
  };
}
