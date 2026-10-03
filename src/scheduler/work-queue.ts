/**
 * **持久工作队列与后台工作进程的领取 / 续租 / 完成**（KRN-10；R214–R220、R216、R202、R225）。
 *
 * ## 这一件修的是什么
 *
 * 后台工作进程（worker）是**进程**：会崩、会重启、会被杀掉。若"谁领了什么活、领到什么时候"
 * 只活在进程内存里，那么一次崩溃就会同时丢掉三样东西：
 * 1. **谁在干**——在途的领取记录没了，同一份活可能被第二个 worker 领第二遍；
 * 2. **干到哪了**——消息、任务、动作、预算的进展全丢，重启后从零开始；
 * 3. **额度**——预算台账清零（R225 明令禁止，见 `restart.ts`）。
 *
 * ## 落点：复用既有持久记录，**不新造集合、不动协议/存储**
 *
 * `src/protocol/storage.ts` 里没有"队列条目"这一类记录的位置，而该文件与本目录的既有文件
 * 都不在本包写权内。本模块因此把队列**映射到既有的原生持久记录**上——不是另起一套，
 * 而是恰好对应关系表里的语义：
 *
 * | 队列概念 | 持久载体 | 依据 |
 * |---|---|---|
 * | 队列条目 | `WorkItem`（工作承诺表） | 它就是"已承诺、待兑现的工作" |
 * | 领取 / 租约 | `RunRecord`（`run_id` + 有限租约 + 冻结输入引用） | Q7-a 的租约载体 |
 * | 谁在干 / 还在干 | `InstanceState`（`activity` / `active_run_id` / `lease_deadline` / `pending_request_ids`） | A3 的"实例状态 ≠ 工作状态" |
 * | 恢复出来的消息 | `PendingEvent`（outbox）+ `InboxEntry` | 两者本就与收件箱同事务提交 |
 * | 恢复出来的动作 | `ActionRecord`（经 `task-action-store.ts` 的接缝） | KRN-07 的七态台账 |
 * | 恢复出来的预算 | 已提交的 `run_started` / `diagnosis_performed` 事件 | `budget-projection.ts` |
 *
 * 队列条目与租约用 **namespace 前缀**（`wq-…` / `wq-lease-…`，由注入的 `IdSource` 生成）
 * 与调度器自己的 `req-…` / `run-…` 区分开：`isQueueItem()` / `isQueueLease()` 是唯一判据，
 * 因此**共享同一个 Store 也不会把调度器的轮次当成队列租约**（见 `recoverAfterCrash()` 的
 * 作用域说明，以及本文件不直接调用 `reconcileLeasesAfterRestart()` 的原因）。
 *
 * ## 交付语义：**至少一次，不是恰好一次**
 *
 * 崩溃发生在"侧效应已发生、完成记录尚未落盘"的窗口里，恢复方**无法**从本地状态分辨
 * "外部系统到底执行了没有"。因此本模块**只承诺至少一次**（`at_least_once`），
 * 并在返回值上给出 `exactly_once_claimed: false` 的**字面量**——
 * 不宣称外部系统恰好执行一次（KRN-10 原文）。任何"恰好一次"的宣称都必须来自外部系统
 * 自身的幂等 / 去重能力，不由本层代替。
 *
 * ## 未知副作用不盲重放
 *
 * `planActionRecovery()` 按七态分类：只有 `prepared`（**还没有接触外部世界**）可以安全重排；
 * `handed_off` / `submitted` / `result_unknown` 一律 `no_replay_unknown_effect`——
 * 停在原地等可信回执或用户确认（`ACTION_TRANSITIONS` 也不允许从 `result_unknown` 回到执行态，
 * R246 的"不得盲目重试"在本模块**逐字沿用，不另立一套**）。
 *
 * ## 诚实边界
 *
 * - "崩溃"在本模块的测试里是**同一台机器上的同进程模拟**（关掉 store 再开一个新的），
 *   **不是**真实多进程并发写入的实测。跨进程并发写同一状态文件的实测**未做**。
 * - 队列恢复**只覆盖本模块自己创建的条目与租约**；调度器轮次（`run-…`）不在此列，
 *   它们由 `restart.ts` 的 `reconcileLeasesAfterRestart()` 负责。
 */

import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  createIdSource,
  createInstanceState,
  createRunRecord,
  createWorkItem,
  isLeaseExpired,
  isTerminalStatus,
  type GroupId,
  type IdSource,
  type InstanceId,
  type InstanceState,
  type LogicalTime,
  type RequestId,
  type Revision,
  type RunId,
  type RunRecord,
  type Store,
  type TaskId,
  type WorkItem,
} from '../protocol/index.js';
import {
  isExecutingActionState,
  isTerminalActionState,
  type ActionRecord,
  type ActionState,
} from '../workledger/index.js';
import { recoverBudgetFromCommittedFacts, type BudgetRestoreReport } from './budget-projection.js';
import { taskActionPortOf } from './task-action-store.js';
import type { StagnationBudgetLedger } from './stagnation.js';

// ---------------------------------------------------------------------------
// 命名空间与交付语义
// ---------------------------------------------------------------------------

/** 队列条目 id 的命名空间（`IdSource.next('wq')` ⇒ `wq-<n>`）。 */
export const WORK_QUEUE_ITEM_NAMESPACE = 'wq';
/** 队列租约 id 的命名空间。 */
export const WORK_QUEUE_LEASE_NAMESPACE = 'wq-lease';
/** 队列条目在阻塞原因里使用的稳定前缀（可读性；不参与判定）。 */
export const WORK_QUEUE_BLOCKER_PREFIX = '队列';

/**
 * 交付语义的**唯一取值**：至少一次。
 *
 * 单一取值的联合类型是刻意的：本模块在类型层面就**无法**表达"恰好一次"。
 */
export const QUEUE_DELIVERY_SEMANTICS = 'at_least_once' as const;
export type QueueDeliverySemantics = typeof QUEUE_DELIVERY_SEMANTICS;

/** 交付语义的**如实声明**（含"未宣称恰好一次"的字面量）。 */
export interface QueueDeliveryGuarantee {
  readonly guarantee: QueueDeliverySemantics;
  /** 恒为 `false`：本层不宣称外部系统恰好执行一次。 */
  readonly exactly_once_claimed: false;
  readonly note: string;
}

export function deliveryGuarantee(): QueueDeliveryGuarantee {
  return Object.freeze({
    guarantee: QUEUE_DELIVERY_SEMANTICS,
    exactly_once_claimed: false as const,
    note:
      '崩溃窗口内已发生的外部副作用无法由本地状态判定是否完成，因此只承诺至少一次；' +
      '恰好一次必须由外部系统自身的幂等键保证，本层不代替也不宣称。',
  });
}

// ---------------------------------------------------------------------------
// 队列条目视图
// ---------------------------------------------------------------------------

/** 条目在队列里的可读投影（全部来自持久记录，不缓存第二份状态）。 */
export interface QueueItemView {
  readonly request_id: RequestId;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly status: WorkItem['status'];
  readonly owner_instance_id: InstanceId | null;
  readonly description: string;
  /** 该条目被领取过的次数（= 引用它的租约条数；从持久记录推导，不另存计数）。 */
  readonly attempts: number;
  /** 最近一次租约的截止时刻（无租约时为 null）。 */
  readonly lease_deadline: LogicalTime | null;
}

/** 一次领取（= 一条租约 + 一个工作态实例 + 一个 `in_progress` 条目）。 */
export interface QueueClaim {
  readonly lease_id: RunId;
  readonly request_id: RequestId;
  readonly worker_id: InstanceId;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly claimed_at: LogicalTime;
  readonly lease_deadline: LogicalTime;
}

// ---------------------------------------------------------------------------
// 恢复报告
// ---------------------------------------------------------------------------

/** 动作恢复的四种处置（KRN-10「未知副作用不盲重放」的机器可执行形式）。 */
export const ACTION_RECOVERY_DISPOSITIONS = [
  /** 已终局：不需要任何动作。 */
  'terminal',
  /** 只准备过、**未接触外部世界** ⇒ 可以安全重排。 */
  'requeue_safe',
  /** 用户报告完成但无可信回执 ⇒ 需要解析（不得当成功，也不得重放）。 */
  'resolve_required',
  /** 已交接 / 已提交 / 结果未知 ⇒ **禁止盲重放**，只能等回执或用户确认。 */
  'no_replay_unknown_effect',
] as const;
export type ActionRecoveryDisposition = (typeof ACTION_RECOVERY_DISPOSITIONS)[number];

export interface ActionRecoveryDecision {
  readonly action_id: string;
  readonly state: ActionState;
  readonly disposition: ActionRecoveryDisposition;
  readonly reason: string;
}

export interface ActionRecoveryPlan {
  /** 动作台账接缝是否可用（不可用则 `decisions` 为空且 `wired === false`）。 */
  readonly wired: boolean;
  readonly wiring: 'store' | 'unwired';
  readonly decisions: readonly ActionRecoveryDecision[];
  /** 可安全重排的动作 id（仅 `prepared`）。 */
  readonly requeue_action_ids: readonly string[];
  /** 副作用未知、**禁止重放**的动作 id。 */
  readonly unknown_effect_action_ids: readonly string[];
  /** 有待解析（用户报告完成）的动作 id。 */
  readonly resolve_required_action_ids: readonly string[];
  /**
   * 存在"副作用未知"动作的任务 id（升序、去重）。
   * 这些任务的队列条目**不得**被恢复成可领取状态：那等于盲重放。
   */
  readonly blocked_task_ids: readonly TaskId[];
  /** 恒为 `false`：本层不存在"盲目重放未知副作用"的开关。 */
  readonly blind_replay_allowed: false;
}

export interface QueueRecoveryReport {
  readonly delivery: QueueDeliveryGuarantee;
  /** 已过期 ⇒ 作废的队列租约（条目回到可领取）。 */
  readonly expired_lease_ids: readonly RunId[];
  /** 未过期 ⇒ 原样续接的队列租约（条目**保持**在工作态，不得被别人领走）。 */
  readonly continuing_lease_ids: readonly RunId[];
  /** 本次因租约过期而**回到可领取**的条目 id（已排除被未知副作用阻塞的那些）。 */
  readonly reclaimed_request_ids: readonly RequestId[];
  /** 因任务存在未知副作用而**拒绝**回到可领取的条目 id。 */
  readonly withheld_request_ids: readonly RequestId[];
  readonly messages: {
    /** 未投递的待投递事件条数（重启后需重放；至少一次）。 */
    readonly pending_delivery_events: number;
    readonly inbox_entries: number;
    readonly messages: number;
  };
  readonly tasks: { readonly task_records: number };
  readonly actions: ActionRecoveryPlan;
  /** 给了台账才会恢复预算（否则 `null`，如实表示"本次没有预算要恢复"）。 */
  readonly budget: BudgetRestoreReport | null;
  /** 从持久记录推导出的 id 高水位（重启后据此续发，R202：id 可以跳号，不能重号）。 */
  readonly id_high_water: Readonly<Record<string, number>>;
  /** 观察到的 worker 实例 id（升序；可信身份在队列里就是这些显式 id）。 */
  readonly worker_ids: readonly InstanceId[];
}

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

export interface WorkQueueOptions {
  /** id 源（缺省自建）。`seed` 与 `resume` 透传，用于跨重启的 id 连续性。 */
  readonly id_source?: IdSource;
  /** 注入的 id 种子（自建 id 源时用）。 */
  readonly id_seed?: string;
  /** 有限租约时长（默认取自 `RunRecord` 的既有默认，见 `createRunLease`）。 */
  readonly lease_ttl?: number;
  /** 逻辑时间读取口（默认恒为逻辑时间原点；`src/**` 禁墙钟）。 */
  readonly now?: () => LogicalTime;
  /** 预算台账（给了才会在恢复里折算已提交事实；不给 ⇒ 不恢复预算，如实回报 null）。 */
  readonly budget_ledger?: StagnationBudgetLedger | null;
}

const DEFAULT_QUEUE_LEASE_TTL = 1000;

/**
 * "无负责人"的占位实例 id。
 *
 * 为什么需要它：`WorkItem.owner_instance_id` 是必填的（附录 A5），而**空闲条目本来就没有负责人**。
 * 这个哨兵值把"无人认领"表达出来，并在 `QueueItemView` 上**映射回 `null`**
 * （对外只暴露"有 / 无负责人"两种语义，不让哨兵泄漏到调用方）。
 */
const UNASSIGNED_WORKER: InstanceId = asInstanceId('unassigned');

function ownerOrNull(owner: InstanceId): InstanceId | null {
  return String(owner) === String(UNASSIGNED_WORKER) ? null : owner;
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

export interface WorkQueue {
  /** 入队（幂等：同一 `request_id` 重复入队不新建，返回既有条目）。 */
  enqueue(input: EnqueueInput): QueueItemView;
  /** 领取下一条可运行条目；无可用条目时 `claimed === false`（不是异常）。 */
  claim(workerId: InstanceId, at: LogicalTime): ClaimOutcome;
  /** 续租（有限租约，**显式**续；不自动续租）。过期 / 失权 ⇒ 拒绝。 */
  renew(claim: QueueClaim, at: LogicalTime): RenewOutcome;
  /** 完成（写入结果引用，释放 worker 的执行槽）。 */
  complete(claim: QueueClaim, at: LogicalTime, resultRefs?: readonly string[]): CompleteOutcome;
  /** 失败（终局；给出失败原因）。 */
  fail(claim: QueueClaim, at: LogicalTime, reason: string): CompleteOutcome;
  /** 队列里的全部条目（升序，确定性）。 */
  listItems(): readonly QueueItemView[];
  /** 可领取的条目（`pending` 且无占用）。 */
  listClaimable(): readonly QueueItemView[];
  /** 崩溃后恢复：租约、消息、任务、动作、预算、id 高水位。 */
  recoverAfterCrash(now: LogicalTime): QueueRecoveryReport;
}

export interface EnqueueInput {
  readonly task_id: TaskId;
  readonly task_revision?: Revision;
  readonly request_id?: RequestId;
  readonly description?: string;
  readonly expected_output?: string;
  readonly at?: LogicalTime;
}

export interface ClaimOutcome {
  readonly claimed: boolean;
  readonly reason: 'claimed' | 'empty' | 'all_blocked';
  readonly claim: QueueClaim | null;
  readonly item: QueueItemView | null;
}

export interface RenewOutcome {
  readonly renewed: boolean;
  readonly reason: 'renewed' | 'unknown_lease' | 'not_owner' | 'lease_expired' | 'not_running';
  readonly lease_deadline: LogicalTime | null;
}

export interface CompleteOutcome {
  readonly completed: boolean;
  readonly reason: 'completed' | 'failed' | 'unknown_lease' | 'not_owner' | 'already_terminal';
  readonly item: QueueItemView | null;
}

/** 构造一个持久工作队列（所有状态都在注入的 `Store` 里，本对象**不缓存状态**）。 */
export function createWorkQueue(store: Store, options: WorkQueueOptions = {}): WorkQueue {
  const seed = options.id_seed;
  const idSource =
    options.id_source ?? createIdSource(seed === undefined ? {} : { seed });
  const leaseTtl = options.lease_ttl ?? DEFAULT_QUEUE_LEASE_TTL;
  const now = options.now ?? (() => asLogicalTime(0));
  const ledger = options.budget_ledger ?? null;

  const prefixOf = (namespace: string): string =>
    seed === undefined || seed.length === 0 ? `${namespace}-` : `${seed}/${namespace}-`;

  const itemPrefix = prefixOf(WORK_QUEUE_ITEM_NAMESPACE);
  const leasePrefix = prefixOf(WORK_QUEUE_LEASE_NAMESPACE);

  const isQueueItem = (item: WorkItem): boolean => String(item.request_id).startsWith(itemPrefix);
  const isQueueLease = (run: RunRecord): boolean => String(run.run_id).startsWith(leasePrefix);

  /** 从持久记录推导 id 高水位：`IdSource` 的 `resume` 是重启后不重号的唯一依据。 */
  function highWaterMarks(snapshot: { runs: readonly RunRecord[]; work_items: readonly WorkItem[] }): Record<string, number> {
    const marks: Record<string, number> = {};
    const bump = (namespace: string, id: string): void => {
      const match = /(\d+)$/.exec(id);
      const value = match === null ? 0 : Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }
      if ((marks[namespace] ?? 0) < value) {
        marks[namespace] = value;
      }
    };
    for (const item of snapshot.work_items) {
      if (isQueueItem(item)) bump(WORK_QUEUE_ITEM_NAMESPACE, String(item.request_id));
    }
    for (const run of snapshot.runs) {
      if (isQueueLease(run)) bump(WORK_QUEUE_LEASE_NAMESPACE, String(run.run_id));
    }
    return marks;
  }

  function viewOf(item: WorkItem, attempts: number, leaseDeadline: LogicalTime | null): QueueItemView {
    return Object.freeze({
      request_id: item.request_id,
      task_id: item.task_id,
      task_revision: item.task_revision,
      status: item.status,
      owner_instance_id: ownerOrNull(item.owner_instance_id),
      description: item.description,
      attempts,
      lease_deadline: leaseDeadline,
    });
  }

  /** 读一次"队列全貌"：条目 + 引用它们的租约（数量即尝试次数）。 */
  function readQueue(snapshot: { runs: readonly RunRecord[]; work_items: readonly WorkItem[] }): {
    readonly items: readonly QueueItemView[];
    readonly leases: readonly RunRecord[];
  } {
    const leases = snapshot.runs.filter(isQueueLease);
    const byRequest = new Map<string, RunRecord[]>();
    for (const lease of leases) {
      for (const requestId of lease.frozen_request_ids) {
        const bucket = byRequest.get(String(requestId)) ?? [];
        bucket.push(lease);
        byRequest.set(String(requestId), bucket);
      }
    }
    const items = snapshot.work_items
      .filter(isQueueItem)
      .map((item) => {
        const attempts = byRequest.get(String(item.request_id)) ?? [];
        const live = attempts.filter((lease) => lease.status === 'running');
        const deadline = live.reduce<LogicalTime | null>(
          (latest, lease) => (latest === null || lease.lease_deadline > latest ? lease.lease_deadline : latest),
          null,
        );
        return viewOf(item, attempts.length, deadline);
      })
      .slice()
      .sort((a, b) => (String(a.request_id) < String(b.request_id) ? -1 : 1));
    return { items: Object.freeze(items), leases: Object.freeze(leases) };
  }

  function readItem(storeHandle: Store, requestId: RequestId): WorkItem | undefined {
    let found: WorkItem | undefined;
    storeHandle.transact((tx) => {
      found = tx.getWorkItem(requestId);
    });
    return found;
  }

  function listItems(): readonly QueueItemView[] {
    return readQueue(store.snapshot()).items;
  }

  function listClaimable(): readonly QueueItemView[] {
    return listItems().filter((item) => item.status === 'pending' && item.owner_instance_id === null);
  }

  /** 写入时统一使用哨兵（`WorkItem.owner_instance_id` 必填）。 */
  function unassign(): InstanceId {
    return UNASSIGNED_WORKER;
  }

  return {
    enqueue(input: EnqueueInput): QueueItemView {
      const at = input.at ?? now();
      const revision = input.task_revision ?? asRevision(1);
      const requestId = input.request_id ?? asRequestId(idSource.next(WORK_QUEUE_ITEM_NAMESPACE));
      const existing = readItem(store, requestId);
      if (existing !== undefined) {
        return viewOf(existing, 0, null);
      }
      const item = createWorkItem({
        request_id: requestId,
        owner_instance_id: unassign(),
        task_id: input.task_id,
        task_revision: revision,
        description: input.description ?? '队列工作',
        expected_output: input.expected_output ?? '',
        status: 'pending',
        blocker_reason: { kind: 'other', detail: `${WORK_QUEUE_BLOCKER_PREFIX}：已入队，等待领取` },
        created_at: at,
        updated_at: at,
      });
      store.transact((tx) => {
        tx.putWorkItem(item);
      });
      return viewOf(item, 0, null);
    },

    claim(workerId: InstanceId, at: LogicalTime): ClaimOutcome {
      const item = listClaimable()[0];
      if (item === undefined) {
        const empty = listItems().length === 0;
        return Object.freeze({
          claimed: false,
          reason: empty ? 'empty' : 'all_blocked',
          claim: null,
          item: null,
        });
      }
      const leaseId = asRunId(idSource.next(WORK_QUEUE_LEASE_NAMESPACE));
      const deadline = asLogicalTime(at + leaseTtl);
      const claim: QueueClaim = Object.freeze({
        lease_id: leaseId,
        request_id: item.request_id,
        worker_id: workerId,
        task_id: item.task_id,
        task_revision: item.task_revision,
        claimed_at: at,
        lease_deadline: deadline,
      });

      store.transact((tx) => {
        const stored = tx.getWorkItem(item.request_id);
        if (stored === undefined || stored.status !== 'pending') {
          // 在本事务内被别人抢先：抛错回滚，不做半截领取。
          throw new Error(`条目 ${item.request_id} 已被领取或在事务内发生变化`);
        }
        tx.putRun(
          createRunRecord({
            run_id: leaseId,
            task_id: item.task_id,
            group_id: currentGroupOf(tx, workerId),
            instance_id: workerId,
            task_revision: item.task_revision,
            started_at: at,
            lease_deadline: deadline,
            status: 'running',
            frozen_at: at,
            frozen_request_ids: [item.request_id],
          }),
        );
        const worker = tx.getInstance(workerId);
        const base =
          worker ??
          createInstanceState({ instance_id: workerId, group_id: currentGroupOf(tx, workerId), updated_at: at });
        tx.putInstance(
          createInstanceState({
            instance_id: workerId,
            group_id: base.group_id,
            updated_at: at,
            template_id: base.template_id,
            pinned_template_version: base.pinned_template_version,
            private_context_ref: base.private_context_ref,
            activity: 'active',
            active_run_id: leaseId,
            queued_flag: base.queued_flag,
            queued_since: base.queued_since,
            lease_deadline: deadline,
            inbox_message_ids: base.inbox_message_ids,
            consumed_message_ids: base.consumed_message_ids,
            pending_request_ids: dedupe([...base.pending_request_ids, item.request_id]),
          }),
        );
        tx.putWorkItem(
          createWorkItem({
            ...stored,
            // 六态里"处理中"就是 `processing`（`src/protocol/constants.ts` 的封闭取值）。
            status: 'processing',
            owner_instance_id: workerId,
            blocker_reason: {
              kind: 'other',
              detail: `${WORK_QUEUE_BLOCKER_PREFIX}：由 ${String(workerId)} 持有租约至 ${String(deadline)}`,
            },
            updated_at: at,
          }),
        );
      });

      const after = readItem(store, item.request_id);
      return Object.freeze({
        claimed: true,
        reason: 'claimed',
        claim,
        item: after === undefined ? item : viewOf(after, 1, deadline),
      });
    },

    renew(claim: QueueClaim, at: LogicalTime): RenewOutcome {
      let outcome: RenewOutcome = { renewed: false, reason: 'unknown_lease', lease_deadline: null };
      store.transact((tx) => {
        const run = tx.getRun(claim.lease_id);
        if (run === undefined || !isQueueLease(run)) {
          outcome = { renewed: false, reason: 'unknown_lease', lease_deadline: null };
          return;
        }
        if (run.status !== 'running') {
          outcome = { renewed: false, reason: 'not_running', lease_deadline: null };
          return;
        }
        if (isLeaseExpired(run, at)) {
          // 已过期 ⇒ 不得续命（R203 的"过期就是过期"在队列侧的落点）。
          outcome = { renewed: false, reason: 'lease_expired', lease_deadline: run.lease_deadline };
          return;
        }
        const worker = tx.getInstance(claim.worker_id);
        if (worker === undefined || worker.active_run_id !== claim.lease_id) {
          outcome = { renewed: false, reason: 'not_owner', lease_deadline: null };
          return;
        }
        const deadline = asLogicalTime(at + leaseTtl);
        tx.putRun(
          createRunRecord({
            ...run,
            lease_deadline: deadline,
            frozen_at: run.frozen_at,
          }),
        );
        tx.putInstance(
          createInstanceState({
            ...worker,
            updated_at: at,
            lease_deadline: deadline,
          }),
        );
        outcome = { renewed: true, reason: 'renewed', lease_deadline: deadline };
      });
      return Object.freeze(outcome);
    },

    complete(claim: QueueClaim, at: LogicalTime, resultRefs: readonly string[] = []): CompleteOutcome {
      return settle('completed', claim, at, null, resultRefs);
    },

    fail(claim: QueueClaim, at: LogicalTime, reason: string): CompleteOutcome {
      return settle('failed', claim, at, reason, []);
    },

    listItems,

    listClaimable,

    recoverAfterCrash(nowAt: LogicalTime): QueueRecoveryReport {
      const snapshot = store.snapshot();
      const leases = snapshot.runs.filter(isQueueLease);
      const actionPlan = planActionRecovery(store);
      const blockedTasks = new Set<string>(actionPlan.blocked_task_ids.map(String));

      const expired: RunId[] = [];
      const continuing: RunId[] = [];
      const reclaimed: RequestId[] = [];
      const withheld: RequestId[] = [];
      const workerIds = new Set<string>();

      store.transact((tx) => {
        for (const lease of leases) {
          if (String(lease.instance_id) !== 'unassigned') {
            workerIds.add(String(lease.instance_id));
          }
          if (lease.status !== 'running') {
            continue;
          }
          if (!isLeaseExpired(lease, nowAt)) {
            continuing.push(lease.run_id);
            continue;
          }
          expired.push(lease.run_id);
          tx.putRun(
            createRunRecord({ ...lease, status: 'aborted', finished_at: nowAt, frozen_at: lease.frozen_at }),
          );
          const worker = tx.getInstance(lease.instance_id);
          if (worker !== undefined && worker.active_run_id === lease.run_id) {
            tx.putInstance(
              createInstanceState({
                ...worker,
                updated_at: nowAt,
                activity: 'idle',
                active_run_id: null,
                lease_deadline: null,
                pending_request_ids: worker.pending_request_ids.filter(
                  (id) => !lease.frozen_request_ids.some((frozen) => String(frozen) === String(id)),
                ),
              }),
            );
          }
          for (const requestId of lease.frozen_request_ids) {
            const item = tx.getWorkItem(requestId);
            if (item === undefined || !isQueueItem(item) || isTerminalStatus(item.status)) {
              continue;
            }
            if (blockedTasks.has(String(item.task_id))) {
              // 未知副作用：**不回到可领取**，停在"等待回执"（禁止盲重放）。
              withheld.push(item.request_id);
              tx.putWorkItem(
                createWorkItem({
                  ...item,
                  status: 'waiting_dependency',
                  owner_instance_id: unassign(),
                  blocker_reason: {
                    kind: 'unknown_tool_state',
                    detail:
                      `${WORK_QUEUE_BLOCKER_PREFIX}：任务 ${String(item.task_id)} 存在外部副作用未知的动作，` +
                      '需可信回执或用户确认后才可重放（禁止盲重放）',
                  },
                  dependency_refs: [{ artifact_ref: asArtifactRef(`receipt:${String(item.task_id)}`) }],
                  updated_at: nowAt,
                }),
              );
              continue;
            }
            reclaimed.push(item.request_id);
            tx.putWorkItem(
              createWorkItem({
                ...item,
                status: 'pending',
                owner_instance_id: unassign(),
                blocker_reason: {
                  kind: 'other',
                  detail: `${WORK_QUEUE_BLOCKER_PREFIX}：租约 ${String(lease.run_id)} 崩溃后过期，已回到可领取`,
                },
                updated_at: nowAt,
              }),
            );
          }
        }
      });

      const budget =
        ledger === null ? null : recoverBudgetFromCommittedFacts(ledger, snapshot.kernel_events);

      return Object.freeze({
        delivery: deliveryGuarantee(),
        expired_lease_ids: Object.freeze([...expired]),
        continuing_lease_ids: Object.freeze([...continuing]),
        reclaimed_request_ids: Object.freeze([...reclaimed]),
        withheld_request_ids: Object.freeze([...withheld]),
        messages: Object.freeze({
          pending_delivery_events: snapshot.delivery_events.length,
          inbox_entries: snapshot.inbox_entries.length,
          messages: snapshot.messages.length,
        }),
        tasks: Object.freeze({ task_records: snapshot.tasks.length }),
        actions: actionPlan,
        budget,
        id_high_water: Object.freeze(highWaterMarks({ runs: snapshot.runs, work_items: snapshot.work_items })),
        worker_ids: Object.freeze([...workerIds].sort().map((id) => asInstanceId(id))),
      });
    },
  };

  /** 完成 / 失败的公共落地（同一份所有权与状态校验，不分叉）。 */
  function settle(
    status: 'completed' | 'failed',
    claim: QueueClaim,
    at: LogicalTime,
    failureReason: string | null,
    resultRefs: readonly string[],
  ): CompleteOutcome {
    let outcome: CompleteOutcome = {
      completed: false,
      reason: 'unknown_lease',
      item: null,
    };
    store.transact((tx) => {
      const run = tx.getRun(claim.lease_id);
      if (run === undefined || !isQueueLease(run)) {
        outcome = { completed: false, reason: 'unknown_lease', item: null };
        return;
      }
      const item = tx.getWorkItem(claim.request_id);
      if (item === undefined || isTerminalStatus(item.status)) {
        outcome = { completed: false, reason: 'already_terminal', item: null };
        return;
      }
      const worker = tx.getInstance(claim.worker_id);
      if (worker === undefined || worker.active_run_id !== claim.lease_id) {
        outcome = { completed: false, reason: 'not_owner', item: null };
        return;
      }
      const next = createWorkItem({
        ...item,
        status,
        owner_instance_id: claim.worker_id,
        result_refs: resultRefs.map((ref) => asArtifactRef(ref)),
        blocker_reason:
          status === 'completed'
            ? { kind: 'other', detail: `${WORK_QUEUE_BLOCKER_PREFIX}：已完成` }
            : { kind: 'other', detail: `${WORK_QUEUE_BLOCKER_PREFIX}：已失败` },
        failure_reason: failureReason,
        updated_at: at,
      });
      tx.putWorkItem(next);
      tx.putRun(
        createRunRecord({ ...run, status: 'finished', finished_at: at, frozen_at: run.frozen_at }),
      );
      tx.putInstance(
        createInstanceState({
          ...worker,
          updated_at: at,
          activity: 'idle',
          active_run_id: null,
          lease_deadline: null,
          pending_request_ids: worker.pending_request_ids.filter(
            (id) => String(id) !== String(claim.request_id),
          ),
        }),
      );
      outcome = { completed: true, reason: status, item: viewOf(next, 0, null) };
    });
    return Object.freeze(outcome);
  }
}

// ---------------------------------------------------------------------------
// 动作恢复计划
// ---------------------------------------------------------------------------

/**
 * 按动作七态给出恢复处置。
 *
 * 关键判据（**唯一**，不另立一套状态机）：`ACTION_TRANSITIONS` 不允许 `result_unknown`
 * 回到 `handed_off` / `submitted`（R246「不得盲目重试」），本函数与该表**同源**——
 * 只要某个状态**可能已经接触过外部世界**（`handed_off` / `submitted`）或**结果未知**
 * （`result_unknown`），就不允许重放。
 */
export function planActionRecovery(store: Store): ActionRecoveryPlan {
  let records: readonly ActionRecord[] = [];
  let wired = false;
  store.transact((tx) => {
    const port = taskActionPortOf(tx);
    if (port === null) {
      return;
    }
    wired = true;
    records = port.listActionRecords();
  });

  const decisions: ActionRecoveryDecision[] = [];
  const requeue: string[] = [];
  const unknown: string[] = [];
  const resolveRequired: string[] = [];
  const blockedTasks = new Set<string>();

  for (const record of records) {
    const disposition = dispositionOf(record);
    decisions.push(
      Object.freeze({
        action_id: String(record.action_id),
        state: record.state,
        disposition,
        reason: reasonOf(disposition),
      }),
    );
    if (disposition === 'requeue_safe') {
      requeue.push(String(record.action_id));
    } else if (disposition === 'no_replay_unknown_effect') {
      unknown.push(String(record.action_id));
      blockedTasks.add(String(record.task_id));
    } else if (disposition === 'resolve_required') {
      resolveRequired.push(String(record.action_id));
    }
  }

  return Object.freeze({
    wired,
    wiring: wired ? 'store' : 'unwired',
    decisions: Object.freeze(
      decisions.slice().sort((a, b) => (a.action_id < b.action_id ? -1 : 1)),
    ),
    requeue_action_ids: Object.freeze(requeue.slice().sort()),
    unknown_effect_action_ids: Object.freeze(unknown.slice().sort()),
    resolve_required_action_ids: Object.freeze(resolveRequired.slice().sort()),
    blocked_task_ids: Object.freeze([...blockedTasks].sort().map((id) => id as unknown as TaskId)),
    blind_replay_allowed: false as const,
  });
}

function dispositionOf(record: ActionRecord): ActionRecoveryDisposition {
  if (isTerminalActionState(record.state)) {
    return 'terminal';
  }
  if (record.state === 'prepared') {
    // 只准备过 ⇒ 外部世界一无所知 ⇒ 可以安全重排。
    return 'requeue_safe';
  }
  if (record.state === 'user_reported_complete') {
    return 'resolve_required';
  }
  if (isExecutingActionState(record.state) || record.state === 'result_unknown') {
    return 'no_replay_unknown_effect';
  }
  // 七态封闭：走到这里说明新增了状态却忘了分类——大声失败，不静默当作安全。
  throw new Error(`未分类的动作状态：${String(record.state)}（ACTION_STATES 已扩展？请补分类）`);
}

function reasonOf(disposition: ActionRecoveryDisposition): string {
  switch (disposition) {
    case 'terminal':
      return '已终局，无需处置';
    case 'requeue_safe':
      return '仅 prepared（未接触外部世界）⇒ 可安全重排';
    case 'resolve_required':
      return '用户报告完成但无可信回执 ⇒ 需解析，既不得当成功也不得重放';
    case 'no_replay_unknown_effect':
      return '已交接 / 已提交 / 结果未知 ⇒ 外部副作用是否发生未知，禁止盲重放';
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function dedupe<T extends string>(values: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    if (seen.has(String(value))) {
      continue;
    }
    seen.add(String(value));
    out.push(value);
  }
  return Object.freeze(out);
}

function currentGroupOf(tx: { getInstance(id: InstanceId): InstanceState | undefined; listInstances(): readonly InstanceState[] }, workerId: InstanceId): GroupId {
  const worker = tx.getInstance(workerId);
  if (worker !== undefined) {
    return worker.group_id;
  }
  const any = tx.listInstances()[0];
  if (any !== undefined) {
    return any.group_id;
  }
  // 没有任何实例可参考时，用占位群组（groupId 是字符串品牌，不参与本模块判定）。
  return asGroupId('queue-unassigned');
}

/** 供调用方判断"这条工作项是不是本队列管理的条目"。 */
export function isQueueItem(item: WorkItem, prefix = `${WORK_QUEUE_ITEM_NAMESPACE}-`): boolean {
  return String(item.request_id).startsWith(prefix);
}

/** 供调用方判断"这条轮次是不是本队列的租约"。 */
export function isQueueLease(run: RunRecord, prefix = `${WORK_QUEUE_LEASE_NAMESPACE}-`): boolean {
  return String(run.run_id).startsWith(prefix);
}

/** 便于测试与证据：把条目视图转成稳定的可读行。 */
export function describeQueueItem(item: QueueItemView): string {
  return (
    `${String(item.request_id)} [${item.status}] 尝试 ${String(item.attempts)} 次，` +
    `负责人 ${item.owner_instance_id === null ? '无' : String(item.owner_instance_id)}，` +
    `租约截止 ${item.lease_deadline === null ? '无' : String(item.lease_deadline)}`
  );
}
