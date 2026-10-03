/**
 * **后台工作进程循环**（KRN-10 进程侧）。
 *
 * ## 这一件修的是什么
 *
 * `work-queue.ts` 给的是**账本语义**（领取 / 续租 / 完成 / 崩溃恢复），但它是"被调用的函数"，
 * 不是"跑起来的进程"。真实的后台 worker 是一个**会一直跑、会崩、会被停机**的循环；
 * 光有账本语义，三个东西没人管：
 * 1. **空队列时干什么**——真进程必须退避等待，不能忙轮询烧 CPU；
 * 2. **长任务的租约**——执行超过租约时长就丢权，必须在到期前显式续租；
 * 3. **被杀之后**——重启要回收在途项、且**不得盲目重放未知副作用**。
 *
 * 本模块只做"进程侧"的三件事：**驱动循环、退避等待、把账本结果如实落成观测**。
 * 队列语义**一个字都不重写**——领取/续租/完成/恢复全部委托给注入的 `WorkQueue`
 * （即 `work-queue.ts` 的实现），恢复口径也**直接复用** `recoverAfterCrash()` 与它内部的
 * `planActionRecovery()`，不另造一套七态分类。
 *
 * ## 端口注入：真进程用真钟，测试用逻辑钟
 *
 * `src/**` 禁墙钟（见仓库纪律），所以时间与等待走注入的 `WorkerClock`：
 * `now()` 读逻辑时间、`wait(ticks)` 等待并推进逻辑时间。测试用
 * `createLogicalClockDriver()`（纯计数器 + 让出微任务），**不碰墙钟**。
 * 生产侧若要用真实 `setTimeout`，实现同一个 `WorkerClock` 接口即可——本模块不关心。
 *
 * ## 五条行为（每条都配一条"反向对照"测试）
 *
 * | # | 行为 | 反向对照（检测器必须会响） |
 * |---|---|---|
 * | 1 | 空队列**退避等待**，不忙轮询 | `PollingDiscipline` 在 `busy` 注入模式下检出忙轮询 |
 * | 2 | 长任务**到期前续租**；续租失败 ⇒ 放弃执行 | 执行器**谎报成功**也不得记为成功 |
 * | 3 | 被杀重启后**回收在途项**、未知副作用**不重放** | `auditReplaySafety()` 在状态被篡改后检出 |
 * | 4 | **停机信号**后不再领新项，在途项收尾 | 停机后剩余条目仍可领取、未被领走 |
 * | 5 | 多循环共享介质**同一项不被两人领取** | `auditSingleOwnership()` 在植入双租约后检出 |
 *
 * ## 诚实边界（**逐条如实标注，不编造**）
 *
 * - **"崩溃"与"多进程"都是同进程模拟**。第 3 条的"进程被杀"= 关掉 store 再开一个新的
 *   （读同一份磁盘）；第 5 条的"并发"= **同进程内两个 `WorkerLoop` 实例**共享同一个
 *   `WorkQueue`。**不是**真实多进程并发写同一状态文件的实测——跨进程实测**未做**。
 * - 第 5 条共用一个 `WorkQueue` 实例（因而共用一个 `IdSource`）。**真跨进程**需要两个
 *   独立 `IdSource`，那会撞上 R202 的发号问题（两个源各自从 1 起会发出同一个 `wq-lease-1`）；
 *   正确做法是用 `id-clock-continuity.ts` 的高水位续发——**本模块未模拟这一步，未验证**。
 * - 续租失败后的"释放"= **停止触碰该条目，交由租约过期后的 `recoverAfterCrash()` 回收**，
 *   而不是当场把条目改回 `pending`：当场改回等于绕过 `planActionRecovery()` 的未知副作用闸门。
 *   代价是"至少一次"——被回收的条目会被再执行一次，这是交付语义的**如实后果**，不是缺陷。
 * - 执行器是**注入**的：本模块不执行任何真实工具/外部副作用，因此"未知副作用不重放"
 *   在这里证明的是**账本层不重排**，**不是**"外部系统没有被重复调用"。
 */

import {
  asLogicalTime,
  asRequestId,
  type InstanceId,
  type LogicalTime,
  type RequestId,
  type RunId,
  type Store,
} from '../protocol/index.js';
import {
  deliveryGuarantee,
  isQueueLease,
  type CompleteOutcome,
  type QueueClaim,
  type QueueDeliveryGuarantee,
  type QueueItemView,
  type QueueRecoveryReport,
  type RenewOutcome,
  type WorkQueue,
} from './work-queue.js';

// ---------------------------------------------------------------------------
// 逻辑钟端口
// ---------------------------------------------------------------------------

/** 时间与等待的注入端口。**唯一**的时间来源；本模块不读墙钟。 */
export interface WorkerClock {
  /** 当前逻辑时间。 */
  now(): LogicalTime;
  /** 等待 `ticks` 个逻辑时间片；返回后 `now()` 已至少推进 `ticks`。 */
  wait(ticks: number): Promise<void>;
}

export interface LogicalClockDriver extends WorkerClock {
  /** 当前逻辑时间的只读视图（测试断言用）。 */
  readonly value: LogicalTime;
}

/**
 * 确定性逻辑钟：`wait()` = 推进计数器 + 让出一个微任务。
 *
 * 刻意**不**用 `setTimeout`：逻辑时间必须由测试完全掌控，且 `src/**` 禁墙钟。
 * 让出微任务是为了让"同进程两循环"能真正交错（否则 `Promise.all` 退化成串行）。
 */
export function createLogicalClockDriver(start: LogicalTime = asLogicalTime(0)): LogicalClockDriver {
  let current = start;
  return {
    get value(): LogicalTime {
      return current;
    },
    now: (): LogicalTime => current,
    wait: async (ticks: number): Promise<void> => {
      const delta = Number.isFinite(ticks) && ticks > 0 ? ticks : 0;
      current = asLogicalTime(Number(current) + delta);
      await Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// 退避策略
// ---------------------------------------------------------------------------

export interface BackoffPolicy {
  /** 首次空轮询的等待时长。 */
  readonly initial: number;
  /** 每次空轮询后的放大倍数。 */
  readonly factor: number;
  /** 等待时长上限。 */
  readonly max: number;
}

/** 默认退避：10 → 20 → 40 → 80 → … → 1000（封顶）。 */
export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  initial: 10,
  factor: 2,
  max: 1000,
});

export interface BackoffRunner {
  /** 取本次等待时长并推进到下一档。 */
  next(): number;
  /** 领到活之后回到初始档。 */
  reset(): void;
  readonly current: number;
}

export function createBackoff(policy: BackoffPolicy): BackoffRunner {
  let current = policy.initial;
  return {
    get current(): number {
      return current;
    },
    next(): number {
      const delay = current;
      current = Math.min(policy.max, Math.max(policy.initial, current * policy.factor));
      return delay;
    },
    reset(): void {
      current = policy.initial;
    },
  };
}

// ---------------------------------------------------------------------------
// 轮询纪律（忙轮询检测器）
// ---------------------------------------------------------------------------

/** 一次忙轮询违规（机器可断言）。 */
export interface PollingViolation {
  readonly kind: 'busy_poll';
  readonly at: LogicalTime;
  /** 触发时"连续未等待的空轮询"计数。 */
  readonly consecutive_idle_polls: number;
  readonly detail: string;
}

export interface PollingStats {
  readonly polls: number;
  readonly idle_polls: number;
  readonly waits: number;
  readonly total_wait_ticks: number;
  /** 历史最长"连续未等待的空轮询"串长；正常循环里恒为 1。 */
  readonly longest_unwaited_idle_run: number;
}

/**
 * 轮询纪律：**每两次空轮询之间必须有一次等待**。
 *
 * 它是循环自己用的对象（不是事后统计），因此"循环忘了等"会在下一次 `beforePoll()`
 * 当场被记成违规。`busy` 注入模式正是靠它被检出（见测试的反向对照）。
 */
export interface PollingDiscipline {
  /** 每次领取尝试**之前**调用。 */
  beforePoll(at: LogicalTime): void;
  /** 领取失败（空队列 / 全阻塞）时调用。 */
  idlePoll(at: LogicalTime): void;
  /** 等待结束、进入下一轮之前调用。 */
  waited(ticks: number): void;
  violations(): readonly PollingViolation[];
  stats(): PollingStats;
}

export function createPollingDiscipline(): PollingDiscipline {
  let polls = 0;
  let idle = 0;
  let waits = 0;
  let waitTicks = 0;
  let unwaited = 0;
  let longest = 0;
  const found: PollingViolation[] = [];

  return {
    beforePoll(at: LogicalTime): void {
      polls += 1;
      if (unwaited > 0) {
        found.push(
          Object.freeze({
            kind: 'busy_poll' as const,
            at,
            consecutive_idle_polls: unwaited,
            detail:
              `连续 ${unwaited} 次空队列轮询之间没有等待——这是忙轮询（烧 CPU），不是退避等待。`,
          }),
        );
      }
    },
    idlePoll(_at: LogicalTime): void {
      idle += 1;
      unwaited += 1;
      if (unwaited > longest) {
        longest = unwaited;
      }
    },
    waited(ticks: number): void {
      waits += 1;
      waitTicks += Number.isFinite(ticks) && ticks > 0 ? ticks : 0;
      unwaited = 0;
    },
    violations(): readonly PollingViolation[] {
      return Object.freeze([...found]);
    },
    stats(): PollingStats {
      return Object.freeze({
        polls,
        idle_polls: idle,
        waits,
        total_wait_ticks: waitTicks,
        longest_unwaited_idle_run: longest,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 执行器端口
// ---------------------------------------------------------------------------

/** 执行器对"一件事"的处置意向。 */
export type ExecutorOutcome =
  | { readonly status: 'completed'; readonly result_refs?: readonly string[] }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'abandoned'; readonly reason: string };

/**
 * 交给执行器的上下文。
 *
 * `renew()` 是**显式**的——与 `work-queue.ts` 的"显式续，不自动续租"契约同源：
 * 长任务的执行器自己决定何时续租（循环不做后台心跳，因为 `src/**` 禁墙钟）。
 * 续租一旦失败，`cancelled` 立刻为真；**执行器的自报结论不再被采信**。
 */
export interface ExecutorContext {
  readonly claim: QueueClaim;
  readonly item: QueueItemView;
  at(): LogicalTime;
  /** 等待并推进逻辑时间（长任务模拟用）。 */
  wait(ticks: number): Promise<void>;
  /** 显式续租；失败 ⇒ `cancelled` 置真。 */
  renew(): RenewOutcome;
  /** 是否已被要求放弃（续租失败）。 */
  readonly cancelled: boolean;
  /** 停机是否已被请求（执行器可据此选择收尾或放弃）。 */
  readonly stop_requested: boolean;
  /** 最近一次续租结果（未续租过则为 `null`）。 */
  readonly last_renew: RenewOutcome | null;
}

export interface WorkerExecutor {
  readonly name?: string;
  execute(context: ExecutorContext): Promise<ExecutorOutcome> | ExecutorOutcome;
}

// ---------------------------------------------------------------------------
// 结算与统计
// ---------------------------------------------------------------------------

export type ReleaseDisposition = 'not_abandoned' | 'awaiting_lease_expiry_reclaim';

/** 一次执行的结算（**如实**记录：意向 ≠ 账本是否真的落了）。 */
export interface SettlementOutcome {
  readonly request_id: RequestId;
  /** 执行器/循环的意向。 */
  readonly intent: 'completed' | 'failed' | 'abandoned';
  /** 执行器自报的状态（可能与最终结论不同——见续租失败时的"谎报"用例）。 */
  readonly executor_status: ExecutorOutcome['status'];
  /** 账本是否真的落了一条终局记录。 */
  readonly applied: boolean;
  /** 账本给出的结论（未落账时为 `null`）。 */
  readonly ledger_reason: CompleteOutcome['reason'] | null;
  readonly renewals: number;
  readonly last_renew: RenewOutcome | null;
  readonly release: ReleaseDisposition;
  readonly note: string;
}

export interface WorkerLoopStats {
  readonly worker_id: InstanceId;
  readonly ticks: number;
  readonly claims: number;
  readonly completed: number;
  readonly failed: number;
  readonly abandoned: number;
  /** 执行器自报终局但**账本拒绝**（如租约已过期）的次数。 */
  readonly refused: number;
  readonly idle_polls: number;
  /** 执行器被调用的次数（空队列期间必须为 0 的那一项）。 */
  readonly executor_calls: number;
  readonly renewals: number;
  readonly recoveries: number;
  readonly stop_requested: boolean;
  readonly idle_streak: number;
}

export type TickOutcome =
  | { readonly kind: 'stopped'; readonly reason: 'stop_requested' }
  | {
      readonly kind: 'idle';
      readonly reason: 'empty' | 'all_blocked';
      readonly waited: number;
    }
  | { readonly kind: 'executed'; readonly settlement: SettlementOutcome };

export type LoopStopReason = 'stop_requested' | 'max_ticks' | 'idle_limit';

export interface LoopSummary {
  readonly stop_reason: LoopStopReason;
  readonly stats: WorkerLoopStats;
  readonly polling: PollingStats;
  readonly polling_violations: readonly PollingViolation[];
  readonly last_recovery: QueueRecoveryReport | null;
}

// ---------------------------------------------------------------------------
// 端口与选项
// ---------------------------------------------------------------------------

export interface WorkerLoopPorts {
  /** 存储（只用于**只读**审计：所有权 / 重放安全）。 */
  readonly store: Store;
  /** 队列语义的唯一来源（`work-queue.ts`）；本模块不重写它。 */
  readonly queue: WorkQueue;
  readonly clock: WorkerClock;
  readonly executor: WorkerExecutor;
  /** 外部停机信号（与 `loop.requestStop()` 取或）。 */
  readonly stopRequested?: () => boolean;
}

export interface WorkerLoopOptions {
  readonly worker_id: InstanceId;
  readonly backoff?: Partial<BackoffPolicy>;
  /**
   * `backoff`（默认）：空轮询按退避策略等待。
   * `busy`：**故意跳过等待**——只为证明忙轮询检测器会响，**不得用于生产**。
   */
  readonly polling?: 'backoff' | 'busy';
  /** 连续空轮询达到此数后 `run()` 以 `idle_limit` 退出（缺省不退出）。 */
  readonly max_idle_ticks?: number;
  /** 循环启动时是否先做一次崩溃恢复（缺省 `true`：新进程本就该先回收在途项）。 */
  readonly recover_on_start?: boolean;
}

export interface WorkerLoop {
  readonly worker_id: InstanceId;
  /** 崩溃恢复：**直接**用 `WorkQueue.recoverAfterCrash()`，不另造口径；结果留档。 */
  recover(): QueueRecoveryReport;
  /** 跑一步：领 → 执行 → 结算；空队列则退避等待。 */
  tick(): Promise<TickOutcome>;
  /** 跑到停机 / 触顶 / 连续空轮询达上限。 */
  run(maxTicks?: number): Promise<LoopSummary>;
  /** 请求优雅停机：之后不再领新项。 */
  requestStop(): void;
  stats(): WorkerLoopStats;
  polling_violations(): readonly PollingViolation[];
  last_recovery(): QueueRecoveryReport | null;
  /** 交付语义（透传队列的**至少一次**，不另立说法）。 */
  delivery(): QueueDeliveryGuarantee;
}

// ---------------------------------------------------------------------------
// 循环
// ---------------------------------------------------------------------------

export function createWorkerLoop(ports: WorkerLoopPorts, options: WorkerLoopOptions): WorkerLoop {
  const workerId = options.worker_id;
  const policy: BackoffPolicy = Object.freeze({
    initial: options.backoff?.initial ?? DEFAULT_BACKOFF.initial,
    factor: options.backoff?.factor ?? DEFAULT_BACKOFF.factor,
    max: options.backoff?.max ?? DEFAULT_BACKOFF.max,
  });
  const pollingMode = options.polling ?? 'backoff';
  const maxIdleTicks = options.max_idle_ticks;
  const recoverOnStart = options.recover_on_start ?? true;

  const backoff = createBackoff(policy);
  const discipline = createPollingDiscipline();

  let internalStop = false;
  let recovered = false;
  let lastRecovery: QueueRecoveryReport | null = null;

  let ticks = 0;
  let claims = 0;
  let completedCount = 0;
  let failedCount = 0;
  let abandonedCount = 0;
  let refusedCount = 0;
  let idlePolls = 0;
  let executorCalls = 0;
  let renewals = 0;
  let recoveries = 0;
  let idleStreak = 0;

  function stopped(): boolean {
    return internalStop || (ports.stopRequested !== undefined && ports.stopRequested());
  }

  function recover(): QueueRecoveryReport {
    const report = ports.queue.recoverAfterCrash(ports.clock.now());
    lastRecovery = report;
    recoveries += 1;
    recovered = true;
    return report;
  }

  async function tick(): Promise<TickOutcome> {
    ticks += 1;
    if (stopped()) {
      return Object.freeze({ kind: 'stopped' as const, reason: 'stop_requested' as const });
    }
    if (recoverOnStart && !recovered) {
      recover();
    }

    discipline.beforePoll(ports.clock.now());
    const claimed = ports.queue.claim(workerId, ports.clock.now());

    if (!claimed.claimed || claimed.claim === null) {
      // 空队列 / 全阻塞：**退避等待**，不忙轮询。
      const reason: 'empty' | 'all_blocked' = claimed.reason === 'empty' ? 'empty' : 'all_blocked';
      discipline.idlePoll(ports.clock.now());
      idleStreak += 1;
      idlePolls += 1;
      let waited = 0;
      if (pollingMode === 'busy') {
        // 故意不等：让下一次 beforePoll() 记一条忙轮询违规（反向对照用）。
        await Promise.resolve();
      } else {
        waited = backoff.next();
        await ports.clock.wait(waited);
        discipline.waited(waited);
      }
      return Object.freeze({ kind: 'idle' as const, reason, waited });
    }

    claims += 1;
    idleStreak = 0;
    backoff.reset();

    const claim = claimed.claim;
    const item =
      claimed.item ??
      Object.freeze({
        request_id: claim.request_id,
        task_id: claim.task_id,
        task_revision: claim.task_revision,
        status: 'processing' as const,
        owner_instance_id: workerId,
        description: '',
        attempts: 1,
        lease_deadline: claim.lease_deadline,
      });

    let cancelled = false;
    let lastRenew: RenewOutcome | null = null;

    const context: ExecutorContext = {
      claim,
      item,
      at: () => ports.clock.now(),
      wait: (delta: number) => ports.clock.wait(delta),
      renew: (): RenewOutcome => {
        const outcome = ports.queue.renew(claim, ports.clock.now());
        renewals += 1;
        lastRenew = outcome;
        if (!outcome.renewed) {
          // 续租失败就是失败：不得续命（R203），执行器须尽快收尾。
          cancelled = true;
        }
        return outcome;
      },
      get cancelled(): boolean {
        return cancelled;
      },
      get stop_requested(): boolean {
        return stopped();
      },
      get last_renew(): RenewOutcome | null {
        return lastRenew;
      },
    };

    executorCalls += 1;
    let executorOutcome: ExecutorOutcome;
    try {
      executorOutcome = await ports.executor.execute(context);
    } catch (error) {
      executorOutcome = { status: 'failed', reason: `执行器抛出：${messageOf(error)}` };
    }

    const settlement = settle(claim, executorOutcome, cancelled, renewals, lastRenew);
    return Object.freeze({ kind: 'executed' as const, settlement });
  }

  /**
   * 把一次执行落成账本结论。
   *
   * **续租失败 ⇒ 不采信执行器的自报结论**：哪怕执行器说 `completed`，
   * 也只当"放弃"，并交由租约过期后的恢复回收（见文件头的边界说明）。
   */
  function settle(
    claim: QueueClaim,
    executorOutcome: ExecutorOutcome,
    cancelled: boolean,
    renewalCount: number,
    lastRenew: RenewOutcome | null,
  ): SettlementOutcome {
    if (cancelled) {
      abandonedCount += 1;
      return Object.freeze({
        request_id: claim.request_id,
        intent: 'abandoned' as const,
        executor_status: executorOutcome.status,
        applied: false,
        ledger_reason: null,
        renewals: renewalCount,
        last_renew: lastRenew,
        release: 'awaiting_lease_expiry_reclaim' as const,
        note:
          '续租失败 ⇒ 放弃执行；本循环不再触碰该条目（不记成功、不记失败），' +
          '由租约过期后的 recoverAfterCrash() 回收——回收时会再过一遍未知副作用闸门。',
      });
    }

    const at = ports.clock.now();
    if (executorOutcome.status === 'completed') {
      const done = ports.queue.complete(claim, at, executorOutcome.result_refs ?? []);
      if (done.completed) {
        completedCount += 1;
      } else {
        refusedCount += 1;
      }
      return Object.freeze({
        request_id: claim.request_id,
        intent: 'completed' as const,
        executor_status: executorOutcome.status,
        applied: done.completed,
        ledger_reason: done.reason,
        renewals: renewalCount,
        last_renew: lastRenew,
        release: 'not_abandoned' as const,
        note: done.completed
          ? '执行器自报完成，账本已落到 completed。'
          : `执行器自报完成，但账本拒绝（${done.reason}）——不得据此宣称成功；该条目可能被恢复重放（至少一次）。`,
      });
    }

    const done = ports.queue.fail(claim, at, executorOutcome.reason);
    if (done.completed) {
      if (executorOutcome.status === 'abandoned') {
        abandonedCount += 1;
      } else {
        failedCount += 1;
      }
    } else {
      refusedCount += 1;
    }
    return Object.freeze({
      request_id: claim.request_id,
      intent: executorOutcome.status === 'abandoned' ? ('abandoned' as const) : ('failed' as const),
      executor_status: executorOutcome.status,
      applied: done.completed,
      ledger_reason: done.reason,
      renewals: renewalCount,
      last_renew: lastRenew,
      release: 'not_abandoned' as const,
      note: done.completed
        ? '账本已落到 failed（如实标记：本次未产出可用结果）。'
        : `账本拒绝落 failed（${done.reason}）——条目仍在途，将由租约过期后的恢复回收。`,
    });
  }

  async function run(maxTicks = Number.POSITIVE_INFINITY): Promise<LoopSummary> {
    let reason: LoopStopReason = 'max_ticks';
    for (;;) {
      if (stopped()) {
        reason = 'stop_requested';
        break;
      }
      if (ticks >= maxTicks) {
        reason = 'max_ticks';
        break;
      }
      if (maxIdleTicks !== undefined && idleStreak >= maxIdleTicks) {
        reason = 'idle_limit';
        break;
      }
      await tick();
    }
    return Object.freeze({
      stop_reason: reason,
      stats: stats(),
      polling: discipline.stats(),
      polling_violations: discipline.violations(),
      last_recovery: lastRecovery,
    });
  }

  function stats(): WorkerLoopStats {
    return Object.freeze({
      worker_id: workerId,
      ticks,
      claims,
      completed: completedCount,
      failed: failedCount,
      abandoned: abandonedCount,
      refused: refusedCount,
      idle_polls: idlePolls,
      executor_calls: executorCalls,
      renewals,
      recoveries,
      stop_requested: stopped(),
      idle_streak: idleStreak,
    });
  }

  return {
    worker_id: workerId,
    recover,
    tick,
    run,
    requestStop(): void {
      internalStop = true;
    },
    stats,
    polling_violations: () => discipline.violations(),
    last_recovery: () => lastRecovery,
    delivery: () => deliveryGuarantee(),
  };
}

// ---------------------------------------------------------------------------
// 只读审计（两条"必须被检出"的检测器）
// ---------------------------------------------------------------------------

export interface OwnershipViolation {
  readonly request_id: RequestId;
  /** 同一时刻引用该条目的在途租约（>1 即双领）。 */
  readonly lease_ids: readonly RunId[];
}

/**
 * 双领检测器：**同一队列条目在同一时刻被两条以上 `running` 租约引用**即违规。
 *
 * 正常情况（含同进程两循环）恒为空。空结果**不是**结论的证明——测试另配一条
 * "植入双租约 ⇒ 检出"的反向对照，证明这个检测器**会响**。
 */
export function auditSingleOwnership(store: Store): readonly OwnershipViolation[] {
  const snapshot = store.snapshot();
  const byRequest = new Map<string, RunId[]>();
  for (const run of snapshot.runs) {
    if (!isQueueLease(run) || run.status !== 'running') {
      continue;
    }
    for (const requestId of run.frozen_request_ids) {
      const bucket = byRequest.get(String(requestId)) ?? [];
      bucket.push(run.run_id);
      byRequest.set(String(requestId), bucket);
    }
  }
  const out: OwnershipViolation[] = [];
  for (const [requestId, leaseIds] of byRequest) {
    if (leaseIds.length > 1) {
      out.push(
        Object.freeze({
          request_id: asRequestId(requestId),
          lease_ids: Object.freeze([...leaseIds].sort()),
        }),
      );
    }
  }
  return Object.freeze(
    out.sort((a, b) => (String(a.request_id) < String(b.request_id) ? -1 : 1)),
  );
}

export type ReplayViolationKind = 'withheld_item_became_claimable' | 'blocked_task_item_claimable';

export interface ReplayViolation {
  readonly request_id: RequestId;
  readonly kind: ReplayViolationKind;
  readonly detail: string;
}

/**
 * 重放安全检测器：**恢复报告说"扣留"的条目，实际不得变成可领取**。
 *
 * 这是"未知副作用不重放"的**交叉校验**——报告是一份声明，状态是事实；
 * 两者不一致就说明有人把扣留的条目偷偷放回了可领取（即盲重放）。
 */
export function auditReplaySafety(
  queue: WorkQueue,
  report: QueueRecoveryReport,
): readonly ReplayViolation[] {
  const blockedTasks = new Set(report.actions.blocked_task_ids.map(String));
  const withheld = new Set(report.withheld_request_ids.map(String));
  const out: ReplayViolation[] = [];
  for (const item of queue.listClaimable()) {
    const requestId = String(item.request_id);
    if (withheld.has(requestId)) {
      out.push(
        Object.freeze({
          request_id: item.request_id,
          kind: 'withheld_item_became_claimable' as const,
          detail: `条目 ${requestId} 被恢复报告扣留，却出现在可领取集合里 ⇒ 等于盲重放未知副作用。`,
        }),
      );
      continue;
    }
    if (blockedTasks.has(String(item.task_id))) {
      out.push(
        Object.freeze({
          request_id: item.request_id,
          kind: 'blocked_task_item_claimable' as const,
          detail:
            `条目 ${requestId} 所属任务 ${String(item.task_id)} 有副作用未知的动作，` +
            '其条目不得可领取（禁止盲重放）。',
        }),
      );
    }
  }
  return Object.freeze(
    out.sort((a, b) => (String(a.request_id) < String(b.request_id) ? -1 : 1)),
  );
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
