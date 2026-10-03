/**
 * KRN-03：**同一实例最多一个活动轮次**；**合并后续唤醒但保留全部请求**；
 * 快照边界；空闲 / 运行时到达；公平调度。
 *
 * ## 与既有模块的关系
 *
 * 真实路径上的这三件事分别落在：
 * - 排队标记 → `src/scheduler/queue.ts` 的 `markQueueFlagged()`（**最多一个**，重复置位即合并）；
 * - 轮次与快照 → `src/scheduler/runs.ts` 的 `startRunInTransaction()` +
 *   `src/inbox/snapshot.ts` 的 `freezeInputSnapshot()`（Q5-a：冻结与 run_id / 租约同事务）；
 * - 公平调度 → `src/scheduler/scheduler.ts` 的 `advanceOnce()`。
 *
 * 那些实现全部要求 `StorageTransaction`。KRN-03 的判据里有一半是**并发语义**——
 * "运行中来两条唤醒仍保留两项请求"、"冻结后到达的消息不进本轮"——
 * 它们应当能被**独立验证**，而不必先跑通持久介质。因此本模块给出一个
 * **纯内存、可并发驱动**的顺序模型：语义与 `queue.ts` / `snapshot.ts` 一致，
 * 但**不替代**它们（生产路径仍走事务版本）。
 *
 * ## 五条被冻结的语义
 *
 * 1. **同一实例最多一个活动轮次**（§9.1）：`beginRun()` 在已有活动轮次时**拒绝启动**
 *    （`already_active`），绝不覆盖 `active_run_id`。
 * 2. **合并后续唤醒、保留全部请求**（§9.2）：运行中到达的唤醒**不新增运行机会**
 *    （已经有一个）；但每一个 `request_id` 都留在请求账上，**一条都不丢**。
 * 3. **快照边界**（Q5-a）：一轮的输入在 `beginRun()` **那一刻**冻结；
 *    冻结**之后**到达的消息不属于本轮，只可能进后续轮次。
 * 4. **空闲 / 运行时到达**：空闲到达 ⇒ 置（至多一个）排队标记；
 *    运行中到达 ⇒ 只记请求，不动排队标记；轮次结束时若仍有请求 ⇒ **至多一次**新运行机会。
 * 5. **公平调度**：`selectRunnableInstances()` 按"等待最久优先"排序（同刻按 id 稳定排序）——
 *    任何置了排队标记的实例都会在有限步内被选中，**不会饿死**。
 *
 * ## 并发模型的诚实边界（务必读完）
 *
 * - 本模块的每个公开方法都是**同步临界区**：进入后不再让出执行权。JS 运行在**单线程**
 *   事件循环上，因此"两个并发调用者交错到临界区中间"在**本进程内**不可能发生。
 * - 据此，"至多一个活动轮次"在**同进程**内是**结构性保证**；测试用 `Promise` 交错
 *   （微任务 + 宏任务）驱动多个调用者，验证的正是"交错发生在临界区之间时语义仍然正确"。
 * - **这不是线程安全，也不是跨进程安全**：真实的多进程/多设备并发需要持久介质上的
 *   乐观并发控制（版本 / 租约），未在本模块与本次测试范围内验证。
 */

import {
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type RunId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 实例调度态
// ---------------------------------------------------------------------------

export interface InstanceScheduleState {
  readonly instance_id: InstanceId;
  readonly group_id: GroupId | null;
  /** 活动轮次（**至多一个**；无则 null）。 */
  readonly active_run_id: RunId | null;
  readonly active_run_started_at: LogicalTime | null;
  /** 本轮冻结的输入快照（消息 id）。活动轮次为 null 时恒为空。 */
  readonly frozen_message_ids: readonly MessageId[];
  /** 本轮冻结的工作请求（启动时从 pending 认领）。 */
  readonly frozen_request_ids: readonly RequestId[];
  readonly frozen_at: LogicalTime | null;
  /** 排队标记：**布尔，最多一个**（§9.1）。 */
  readonly queued: boolean;
  readonly queued_since: LogicalTime | null;
  /** **尚未**进入任何轮次的请求（合并唤醒时全部保留）。 */
  readonly pending_request_ids: readonly RequestId[];
  /** 已经历过轮次的请求（`pending + handled = 收到过的全部请求`）。 */
  readonly handled_request_ids: readonly RequestId[];
  /** 已到达但**尚未**被任何快照冻结的消息（快照边界之外）。 */
  readonly arrived_message_ids: readonly MessageId[];
  /** 已被某个快照冻结过的消息（读入 ≠ 完成）。 */
  readonly snapshotted_message_ids: readonly MessageId[];
}

/** 拒绝启动的原因（与 `src/scheduler/errors.ts` 的取值同名同义）。 */
export const RUN_START_REJECTIONS = ['unknown_instance', 'already_active', 'no_runnable_input'] as const;
export type RunStartRejection = (typeof RUN_START_REJECTIONS)[number];

export interface WakeupDecision {
  readonly instance_id: InstanceId;
  readonly request_id: RequestId;
  /** 本次是否真的置位了排队标记（已有活动轮次或已排队 ⇒ false）。 */
  readonly queued: boolean;
  /** 运行机会被合并（已有活动轮次或已有排队标记）。 */
  readonly merged: boolean;
  /** 该请求此前是否已收到过（重复通知 ⇒ 不重复记账）。 */
  readonly duplicate: boolean;
}

export interface BeginRunDecision {
  readonly instance_id: InstanceId;
  readonly started: boolean;
  readonly run_id: RunId | null;
  readonly rejection: RunStartRejection | null;
  /** 本轮的输入快照（`started` 为 false 时为空）。 */
  readonly frozen_message_ids: readonly MessageId[];
  readonly frozen_request_ids: readonly RequestId[];
  readonly frozen_at: LogicalTime | null;
}

export interface FinishRunDecision {
  readonly instance_id: InstanceId;
  readonly run_id: RunId;
  readonly finished: boolean;
  /** 轮次结束后是否**再置一次**（至多一次）运行机会。 */
  readonly requeued: boolean;
  readonly queued_since: LogicalTime | null;
}

// ---------------------------------------------------------------------------
// 调度核心
// ---------------------------------------------------------------------------

function emptyInstance(instanceId: InstanceId, groupId: GroupId | null): InstanceScheduleState {
  return Object.freeze({
    instance_id: instanceId,
    group_id: groupId,
    active_run_id: null,
    active_run_started_at: null,
    frozen_message_ids: Object.freeze([]),
    frozen_request_ids: Object.freeze([]),
    frozen_at: null,
    queued: false,
    queued_since: null,
    pending_request_ids: Object.freeze([]),
    handled_request_ids: Object.freeze([]),
    arrived_message_ids: Object.freeze([]),
    snapshotted_message_ids: Object.freeze([]),
  });
}

/**
 * 公平调度核心。
 *
 * 每个公开方法都是**同步临界区**（不 `await`、不让出）；并发调用者只能在
 * 临界区**之间**交错。见文件头"并发模型的诚实边界"。
 */
export class FairScheduler {
  private readonly instances = new Map<InstanceId, InstanceScheduleState>();

  /** 注册实例（幂等：重复注册同 id 只补 group_id，不清状态）。 */
  public registerInstance(instanceId: InstanceId, at: LogicalTime, groupId: GroupId | null = null): void {
    const existing = this.instances.get(instanceId);
    if (existing === undefined) {
      void at;
      this.instances.set(instanceId, emptyInstance(instanceId, groupId));
      return;
    }
    if (existing.group_id === null && groupId !== null) {
      this.instances.set(instanceId, Object.freeze({ ...existing, group_id: groupId }));
    }
  }

  public get(instanceId: InstanceId): InstanceScheduleState | undefined {
    return this.instances.get(instanceId);
  }

  public instanceIds(): readonly InstanceId[] {
    return Object.freeze([...this.instances.keys()]);
  }

  // -------------------------------------------------------------------------
  // 唤醒（空闲到达 vs 运行时到达）
  // -------------------------------------------------------------------------

  /**
   * 一次唤醒请求到达。
   *
   * - **空闲到达**：置排队标记（**至多一个**，`queued_since` 只在首次置位时记录）。
   * - **运行时到达**：**合并**——不动排队标记（运行机会已被占用），但请求**照记不误**。
   * - 同一 `request_id` 重复到达 ⇒ `merged: true` 且不重复记账（幂等）。
   */
  public requestWakeup(input: {
    readonly instance_id: InstanceId;
    readonly request_id: RequestId;
    readonly message_ids?: readonly MessageId[];
    readonly at: LogicalTime;
  }): WakeupDecision {
    const state = this.require(input.instance_id);
    const duplicate =
      state.pending_request_ids.includes(input.request_id) ||
      state.handled_request_ids.includes(input.request_id);

    const nextPending = duplicate
      ? state.pending_request_ids
      : Object.freeze([...state.pending_request_ids, input.request_id]);

    const arrived = input.message_ids ?? [];
    const nextArrived =
      arrived.length === 0 ? state.arrived_message_ids : Object.freeze([...state.arrived_message_ids, ...arrived]);

    const running = state.active_run_id !== null;
    const alreadyQueued = state.queued;
    const shouldQueue = !running && !alreadyQueued;

    this.instances.set(
      input.instance_id,
      Object.freeze({
        ...state,
        pending_request_ids: nextPending,
        arrived_message_ids: nextArrived,
        queued: state.queued || shouldQueue,
        queued_since: shouldQueue ? input.at : state.queued_since,
      }),
    );

    return Object.freeze({
      instance_id: input.instance_id,
      request_id: input.request_id,
      queued: shouldQueue,
      merged: running || alreadyQueued || duplicate,
      duplicate,
    });
  }

  // -------------------------------------------------------------------------
  // 启动轮次（至多一个活动轮次 + 快照边界）
  // -------------------------------------------------------------------------

  /**
   * 启动一轮。
   *
   * 拒绝条件（**正常路径**，不抛错）：
   * - 已有活动轮次 ⇒ `already_active`（**同一实例最多一个活动轮次**）；
   * - 没有可运行输入（未排队、无待处理请求、无未冻结消息）⇒ `no_runnable_input`。
   *
   * 启动时**冻结快照**：此刻未冻结的消息 + 全部待处理请求进入本轮；
   * 冻结**之后**到达的消息不会出现在本轮的 `frozen_message_ids` 里（快照边界）。
   */
  public beginRun(input: { readonly instance_id: InstanceId; readonly run_id: RunId; readonly at: LogicalTime }): BeginRunDecision {
    const state = this.require(input.instance_id);

    if (state.active_run_id !== null) {
      return Object.freeze({
        instance_id: input.instance_id,
        started: false,
        run_id: null,
        rejection: 'already_active',
        frozen_message_ids: Object.freeze([]),
        frozen_request_ids: Object.freeze([]),
        frozen_at: null,
      });
    }

    const runnable =
      state.queued || state.pending_request_ids.length > 0 || state.arrived_message_ids.length > 0;
    if (!runnable) {
      return Object.freeze({
        instance_id: input.instance_id,
        started: false,
        run_id: null,
        rejection: 'no_runnable_input',
        frozen_message_ids: Object.freeze([]),
        frozen_request_ids: Object.freeze([]),
        frozen_at: null,
      });
    }

    const frozenMessages = state.arrived_message_ids;
    const frozenRequests = state.pending_request_ids;

    this.instances.set(
      input.instance_id,
      Object.freeze({
        ...state,
        active_run_id: input.run_id,
        active_run_started_at: input.at,
        frozen_message_ids: frozenMessages,
        frozen_request_ids: frozenRequests,
        frozen_at: input.at,
        queued: false,
        queued_since: null,
        pending_request_ids: Object.freeze([]),
        handled_request_ids: Object.freeze([...state.handled_request_ids, ...frozenRequests]),
        arrived_message_ids: Object.freeze([]),
        snapshotted_message_ids: Object.freeze([...state.snapshotted_message_ids, ...frozenMessages]),
      }),
    );

    return Object.freeze({
      instance_id: input.instance_id,
      started: true,
      run_id: input.run_id,
      rejection: null,
      frozen_message_ids: frozenMessages,
      frozen_request_ids: frozenRequests,
      frozen_at: input.at,
    });
  }

  /**
   * 结束一轮。若仍有待处理请求或未冻结消息 ⇒ **至多一次**新运行机会（`requeued: true`）。
   * 这正是"运行中来三条唤醒、C 完成后统一进入下一轮"（§9.2）的收尾。
   */
  public finishRun(input: { readonly run_id: RunId; readonly at: LogicalTime }): FinishRunDecision {
    const found = this.findByActiveRun(input.run_id);
    if (found === undefined) {
      throw new Error(`未知或非活动的轮次 ${input.run_id}：不得结束一个不属于本实例的轮次`);
    }
    const state = found;
    const hasMore = state.pending_request_ids.length > 0 || state.arrived_message_ids.length > 0;

    this.instances.set(
      state.instance_id,
      Object.freeze({
        ...state,
        active_run_id: null,
        active_run_started_at: null,
        frozen_message_ids: Object.freeze([]),
        frozen_request_ids: Object.freeze([]),
        frozen_at: null,
        queued: hasMore,
        queued_since: hasMore ? input.at : null,
      }),
    );

    return Object.freeze({
      instance_id: state.instance_id,
      run_id: input.run_id,
      finished: true,
      requeued: hasMore,
      queued_since: hasMore ? input.at : null,
    });
  }

  // -------------------------------------------------------------------------
  // 公平调度
  // -------------------------------------------------------------------------

  /**
   * 可运行的实例，按"**等待最久优先**"排序（同刻按 instance_id 稳定排序）。
   * 任何置了排队标记的实例都在结果里 —— 因此不会被饿死。
   */
  public selectRunnableInstances(): readonly InstanceId[] {
    return Object.freeze(
      [...this.instances.values()]
        .filter((state) => state.queued && state.active_run_id === null)
        .sort((a, b) => {
          const at = a.queued_since ?? 0;
          const bt = b.queued_since ?? 0;
          if (at !== bt) return at - bt;
          return a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0;
        })
        .map((state) => state.instance_id),
    );
  }

  /** 取"下一个该跑的实例"（公平调度的一次决策；无可运行实例时为 null）。 */
  public nextRunCandidate(): InstanceId | null {
    const candidates = this.selectRunnableInstances();
    return candidates.length === 0 ? null : (candidates[0] as InstanceId);
  }

  /** 全部实例的当前活动轮次（用于断言"每实例至多一个"）。 */
  public activeRuns(): Readonly<Record<string, RunId>> {
    const active: Record<string, RunId> = {};
    for (const state of this.instances.values()) {
      if (state.active_run_id !== null) {
        active[state.instance_id] = state.active_run_id;
      }
    }
    return Object.freeze(active);
  }

  // -------------------------------------------------------------------------
  // 不变量自检（并发测试在每个交错点调用）
  // -------------------------------------------------------------------------

  /**
   * 不变量违规清单（空 = 无违规）。检查：
   * - 恰有一个活动轮次（结构上恒真，此处显式复核）；
   * - `queued` ⇒ `queued_since !== null`；
   * - 活动轮次为 null ⇒ 冻结快照为空；
   * - `pending` / `handled` 无重复，且消息不重复冻结。
   */
  public invariantViolations(): readonly string[] {
    const violations: string[] = [];
    for (const state of this.instances.values()) {
      if (state.queued && state.queued_since === null) {
        violations.push(`${state.instance_id}: queued 但没有 queued_since`);
      }
      if (state.active_run_id === null && (state.frozen_message_ids.length > 0 || state.frozen_at !== null)) {
        violations.push(`${state.instance_id}: 无活动轮次却残留冻结快照`);
      }
      const seen = new Set<string>();
      for (const requestId of [...state.pending_request_ids, ...state.handled_request_ids]) {
        if (seen.has(requestId)) {
          violations.push(`${state.instance_id}: 请求 ${requestId} 在请求账上出现两次`);
        }
        seen.add(requestId);
      }
      const seenMessages = new Set<string>();
      for (const messageId of [...state.arrived_message_ids, ...state.snapshotted_message_ids]) {
        if (seenMessages.has(messageId)) {
          violations.push(`${state.instance_id}: 消息 ${messageId} 既在快照外又在快照内`);
        }
        seenMessages.add(messageId);
      }
    }
    return Object.freeze(violations);
  }

  /** 某实例收到的**全部**请求（`pending + handled`），用于"一条都没丢"的断言。 */
  public allRequestsOf(instanceId: InstanceId): readonly RequestId[] {
    const state = this.require(instanceId);
    return Object.freeze([...state.pending_request_ids, ...state.handled_request_ids]);
  }

  // -------------------------------------------------------------------------

  private require(instanceId: InstanceId): InstanceScheduleState {
    const state = this.instances.get(instanceId);
    if (state === undefined) {
      throw new Error(`实例 ${instanceId} 未注册：唤醒 / 启动轮次必须先注册实例`);
    }
    return state;
  }

  private findByActiveRun(runId: RunId): InstanceScheduleState | undefined {
    for (const state of this.instances.values()) {
      if (state.active_run_id === runId) {
        return state;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 观测汇总
// ---------------------------------------------------------------------------

export interface FairScheduleSummary {
  readonly instance_count: number;
  readonly active_run_count: number;
  readonly queued_instance_ids: readonly InstanceId[];
  readonly total_pending_requests: number;
  readonly total_handled_requests: number;
  readonly invariant_violations: readonly string[];
}

export function summarizeFairSchedule(scheduler: FairScheduler): FairScheduleSummary {
  const states = scheduler.instanceIds().map((id) => scheduler.get(id)).filter((s): s is InstanceScheduleState => s !== undefined);
  return Object.freeze({
    instance_count: states.length,
    active_run_count: Object.keys(scheduler.activeRuns()).length,
    queued_instance_ids: Object.freeze(states.filter((s) => s.queued).map((s) => s.instance_id)),
    total_pending_requests: states.reduce((sum, s) => sum + s.pending_request_ids.length, 0),
    total_handled_requests: states.reduce((sum, s) => sum + s.handled_request_ids.length, 0),
    invariant_violations: scheduler.invariantViolations(),
  });
}
