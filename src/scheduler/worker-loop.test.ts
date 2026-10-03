/**
 * KRN-10 进程侧：后台工作进程循环（领取 / 续租 / 崩溃恢复 / 优雅停机 / 并发）。
 *
 * ## 这个文件要钉死的五类判据 + 三条反向对照
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 空队列按**退避等待**（10/20/40/80），空队列期间执行器**零调用** | 正例 |
 * | 1b | 注入 `busy` 模式 ⇒ **忙轮询被检出**（同一检测器对真循环生效） | **反向对照** |
 * | 2 | 长任务到期前续租成功 ⇒ 完成，租约延长 | 正例 |
 * | 2b | 续租失败 ⇒ **执行器谎报完成也不得记为成功**，条目交由恢复回收 | **反例** |
 * | 3 | 进程被杀重启 ⇒ 过期在途项回收，新循环可再领取并完成 | 正例 |
 * | 3b | 未知副作用 ⇒ 恢复**扣留**、循环不重放（执行器零调用） | **反例** |
 * | 3c | 把扣留项偷偷改回可领取 ⇒ `auditReplaySafety()` 检出 | **反向对照** |
 * | 4 | 停机信号后不再领新项；在途项收尾或**如实标记** | 正例 |
 * | 5 | 两循环共享同一介质 ⇒ 同一项不被两人领取 | 正例 |
 * | 5b | 植入第二条 `running` 租约 ⇒ `auditSingleOwnership()` 检出双领 | **反向对照** |
 *
 * ## 介质与"进程"的**如实说明**（不编造）
 *
 * - 第 3 条的"进程被杀"= **同进程内**关掉 store 再开一个新的（读同一份磁盘）。
 * - 第 5 条的"并发"= **同进程内两个 `WorkerLoop` 实例**共享**同一个** `WorkQueue`
 *   （因而共用一个 `IdSource`）。**不是**真实多进程并发写同一文件——跨进程实测**未做**，
 *   本文件不据此宣称跨进程结论。真跨进程要处理 R202 发号，**未模拟、未验证**。
 * - 执行器是**注入的假执行器**：不产生任何真实外部副作用。"不重放"证明的是**账本不重排**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRevision,
  asRunId,
  asTaskId,
  createIdSource,
  createRunRecord,
  createTaskRecord,
  createWorkItem,
  type LogicalTime,
  type Store,
  type TaskId,
} from '../protocol/index.js';
import {
  applyActionTransition,
  prepareAction,
  type ActionAuthorization,
  type ActionRecord,
  type ActionState,
} from '../workledger/index.js';
import { createFileStore, createMemoryStore, __deleteStoreFiles } from '../storage/index.js';
import { taskActionPortOf } from './task-action-store.js';
import {
  WORK_QUEUE_ITEM_NAMESPACE,
  WORK_QUEUE_LEASE_NAMESPACE,
  createWorkQueue,
  isQueueLease,
} from './work-queue.js';
import {
  auditReplaySafety,
  auditSingleOwnership,
  createLogicalClockDriver,
  createPollingDiscipline,
  createWorkerLoop,
  type ExecutorContext,
  type ExecutorOutcome,
  type WorkerClock,
  type WorkerExecutor,
} from './worker-loop.js';

const TASK_A = asTaskId('T-A');
const WORKER_1 = asInstanceId('W-1');
const WORKER_2 = asInstanceId('W-2');
const REV = asRevision(1);

let workDir: string;
let storePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-krn10-loop-'));
  storePath = join(workDir, 'queue-store.json');
});

afterEach(() => {
  __deleteStoreFiles(storePath);
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** `file` = 落盘（崩溃恢复用）；`memory` = 易失（同进程并发用）。 */
function openStore(kind: 'file' | 'memory'): Store {
  if (kind === 'memory') {
    return createMemoryStore({ clock: () => asLogicalTime(0) });
  }
  return createFileStore({
    filePath: storePath,
    clock: () => asLogicalTime(0),
    now: () => 0,
    lockOwner: 'krn10-loop-test',
    lockStaleMs: 1,
  });
}

function registerTask(store: Store, taskId: TaskId): void {
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: taskId,
        goal: `目标 ${String(taskId)}`,
        revision: REV,
        created_at: asLogicalTime(0),
      }),
    );
  });
}

function authFor(taskId: TaskId): ActionAuthorization {
  return {
    source: 'test/session',
    user_approved: true,
    task_revision: REV,
    revoked: false,
    subject_instance_id: null,
    granted_at: asLogicalTime(0),
  };
}

/** 把一个动作推进到目标状态并写进动作台账接缝（持久）。 */
function persistAction(store: Store, taskId: TaskId, actionId: string, to: ActionState): ActionRecord {
  let prepared = prepareAction({
    action_id: actionId,
    task_id: taskId,
    task_revision: REV,
    action_kind: 'send_message',
    params: { text: `参数 ${actionId}` },
    authorization: authFor(taskId),
    at: asLogicalTime(0),
  });
  const needsSubmitFirst: readonly ActionState[] = [
    'result_unknown',
    'user_reported_complete',
    'confirmed_complete',
  ];
  const hops: readonly ActionState[] =
    to === 'prepared' ? [] : needsSubmitFirst.includes(to) ? ['submitted', to] : [to];
  for (const hop of hops) {
    prepared = applyActionTransition({
      action: prepared,
      to: hop,
      at: asLogicalTime(1),
      ...(hop === 'confirmed_complete'
        ? { receipt: { trusted: true, source: 'test/receipt', detail: '可信回执', at: asLogicalTime(1) } }
        : {}),
      ...(hop === 'user_reported_complete'
        ? { user_report: { message_id: asMessageId('m-user-report'), note: '用户说完成了' } }
        : {}),
      ...(hop === 'invalidated_or_failed' ? { failure_reason: '测试置为失效' } : {}),
    });
  }
  const record = prepared;
  store.transact((tx) => {
    const port = taskActionPortOf(tx);
    if (port === null) {
      throw new Error('测试夹具要求动作台账接缝可用');
    }
    port.putActionRecord(record);
  });
  return record;
}

/** 逻辑钟 + 等待日志（断言退避序列用）。 */
function loggingClock(start = 0): { clock: WorkerClock; waits: number[]; value: () => LogicalTime } {
  const driver = createLogicalClockDriver(asLogicalTime(start));
  const waits: number[] = [];
  return {
    clock: {
      now: () => driver.now(),
      wait: async (ticks: number) => {
        waits.push(ticks);
        await driver.wait(ticks);
      },
    },
    waits,
    value: () => driver.value,
  };
}

function executorFn(
  fn: (ctx: ExecutorContext) => ExecutorOutcome | Promise<ExecutorOutcome>,
  onCall?: (ctx: ExecutorContext) => void,
): WorkerExecutor {
  return {
    name: 'test-executor',
    execute: async (ctx: ExecutorContext): Promise<ExecutorOutcome> => {
      onCall?.(ctx);
      return fn(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// 1 / 1b：主循环与退避等待（含忙轮询反向对照）
// ---------------------------------------------------------------------------

describe('KRN-10 工作进程循环：主循环与退避等待', () => {
  it('正例：入队三条 ⇒ 依次领取执行，全部 completed，账本终局且执行槽释放', async () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    for (let i = 0; i < 3; i += 1) {
      queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    }

    const { clock } = loggingClock();
    const seen: string[] = [];
    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: executorFn((ctx) => {
          seen.push(String(ctx.claim.request_id));
          return { status: 'completed', result_refs: [`artifact://${String(ctx.claim.request_id)}`] };
        }),
      },
      { worker_id: WORKER_1 },
    );

    const summary = await loop.run(3);
    expect(summary.stop_reason).toBe('max_ticks');
    expect(seen).toHaveLength(3);
    expect(summary.stats.claims).toBe(3);
    expect(summary.stats.completed).toBe(3);
    expect(summary.stats.abandoned).toBe(0);
    expect(summary.stats.refused).toBe(0);
    expect(queue.listClaimable()).toHaveLength(0);
    expect(queue.listItems().every((item) => item.status === 'completed')).toBe(true);

    const snapshot = store.snapshot();
    expect(snapshot.runs.filter((run) => isQueueLease(run)).every((run) => run.status === 'finished')).toBe(
      true,
    );
    const worker = snapshot.instances.find((instance) => String(instance.instance_id) === 'W-1');
    expect(worker?.activity).toBe('idle');
    expect(worker?.active_run_id).toBeNull();
    expect(worker?.lease_deadline).toBeNull();

    // 全程有活干 ⇒ 没有空轮询，也没有忙轮询违规。
    expect(summary.polling.idle_polls).toBe(0);
    expect(summary.polling_violations).toHaveLength(0);
  });

  it('正例：空队列期间执行器**零调用**，且按退避策略等待（10 / 20 / 40 / 80）', async () => {
    const store = openStore('memory');
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const { clock, waits } = loggingClock();
    let calls = 0;
    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: executorFn(() => {
          calls += 1;
          return { status: 'completed' };
        }),
      },
      { worker_id: WORKER_1, max_idle_ticks: 4 },
    );

    const summary = await loop.run(50);
    expect(summary.stop_reason).toBe('idle_limit');
    // 空队列期间执行器**一次都没被调用**（不是"调用了但返回空"）。
    expect(calls).toBe(0);
    expect(summary.stats.executor_calls).toBe(0);
    expect(summary.stats.claims).toBe(0);
    // 退避：10 → 20 → 40 → 80（初始档 ×2 递增）。
    expect(waits).toEqual([10, 20, 40, 80]);
    expect(summary.polling.idle_polls).toBe(4);
    expect(summary.polling.waits).toBe(4);
    expect(summary.polling.longest_unwaited_idle_run).toBe(1);
    expect(summary.polling_violations).toHaveLength(0);
  });

  it('反向对照：注入 busy 模式 ⇒ 忙轮询被检出（执行器仍零调用）', async () => {
    const store = openStore('memory');
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const { clock } = loggingClock();
    let calls = 0;
    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: executorFn(() => {
          calls += 1;
          return { status: 'completed' };
        }),
      },
      // `busy` 是**故意**跳过等待的注入模式：只为证明检测器会响，不得用于生产。
      { worker_id: WORKER_1, polling: 'busy' },
    );

    const summary = await loop.run(4);
    expect(calls).toBe(0);
    const violations = summary.polling_violations;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.kind).toBe('busy_poll');
    expect(violations[0]?.consecutive_idle_polls).toBeGreaterThanOrEqual(1);
    // 对照：正确循环（backoff）在同一检测器下零违规 —— 见上一用例的断言。

    // 同一检测器的**直接**反向对照：两次空轮询之间没有等待 ⇒ 下一次轮询前当场登记违规。
    const discipline = createPollingDiscipline();
    discipline.idlePoll(asLogicalTime(0));
    discipline.idlePoll(asLogicalTime(0));
    expect(discipline.violations()).toHaveLength(0);
    discipline.beforePoll(asLogicalTime(0));
    expect(discipline.violations()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2 / 2b：续租
// ---------------------------------------------------------------------------

describe('KRN-10 工作进程循环：续租', () => {
  it('正例：长任务在到期前续租成功 ⇒ 完成，租约截止被延长', async () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 100 });
    const item = queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    const { clock } = loggingClock(0);

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: executorFn(async (ctx) => {
          await ctx.wait(80); // 长任务：跑到 80（租约 100 尚未到期）
          const renewed = ctx.renew();
          expect(renewed.renewed).toBe(true);
          expect(renewed.lease_deadline).toBe(asLogicalTime(180));
          expect(ctx.cancelled).toBe(false);
          expect(ctx.last_renew?.renewed).toBe(true);
          return { status: 'completed' };
        }),
      },
      { worker_id: WORKER_1 },
    );

    const outcome = await loop.tick();
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') throw new Error('不可达');
    expect(outcome.settlement.intent).toBe('completed');
    expect(outcome.settlement.applied).toBe(true);
    expect(outcome.settlement.ledger_reason).toBe('completed');
    expect(outcome.settlement.renewals).toBe(1);
    expect(
      queue.listItems().find((view) => view.request_id === item.request_id)?.status,
    ).toBe('completed');
    const lease = store.snapshot().runs.find((run) => isQueueLease(run));
    expect(lease?.status).toBe('finished');
    expect(String(lease?.lease_deadline)).toBe('180');
  });

  it('反例：续租失败 ⇒ 放弃执行；执行器**谎报完成**也不得记为成功', async () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 100 });
    const item = queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    const { clock } = loggingClock(0);
    let calls = 0;

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: executorFn(async (ctx) => {
          calls += 1;
          await ctx.wait(150); // 睡过租约截止（100）
          const renewed = ctx.renew();
          expect(renewed.renewed).toBe(false);
          expect(renewed.reason).toBe('lease_expired');
          expect(ctx.cancelled).toBe(true);
          // 执行器**故意谎报完成**：循环不得采信。
          return { status: 'completed' };
        }),
      },
      { worker_id: WORKER_1 },
    );

    const outcome = await loop.tick();
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') throw new Error('不可达');
    expect(outcome.settlement.executor_status).toBe('completed'); // 执行器说完成
    expect(outcome.settlement.intent).toBe('abandoned'); // 循环判为放弃
    expect(outcome.settlement.applied).toBe(false); // 账本**没有**落任何终局
    expect(outcome.settlement.ledger_reason).toBeNull();
    expect(outcome.settlement.release).toBe('awaiting_lease_expiry_reclaim');
    // 条目仍是 processing —— 没有被记成功。
    expect(queue.listItems().find((view) => view.request_id === item.request_id)?.status).toBe(
      'processing',
    );

    // "释放"的证明：租约过期后 recovery 把它回收成可领取（恰好一次）。
    const report = loop.recover();
    expect(report.expired_lease_ids).toHaveLength(1);
    expect(report.reclaimed_request_ids.map(String)).toEqual([String(item.request_id)]);
    expect(queue.listClaimable().map((view) => String(view.request_id))).toEqual([
      String(item.request_id),
    ]);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3 / 3b / 3c：崩溃恢复
// ---------------------------------------------------------------------------

describe('KRN-10 工作进程循环：崩溃恢复', () => {
  it('正例：进程被杀重启 ⇒ 过期在途项回收，新循环可再领取并完成', async () => {
    const first = openStore('file');
    registerTask(first, TASK_A);
    const queueA = createWorkQueue(first, { lease_ttl: 100 });
    const item = queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0), description: '在途活' });
    expect(queueA.claim(WORKER_1, asLogicalTime(0)).claimed).toBe(true);
    // ——这里"进程被杀"：不续租、不完成、不再写。

    const second = openStore('file');
    // 新进程从**落盘高水位**续发 id（否则会重发 `wq-lease-1`，撞上旧租约）。
    const queueB = createWorkQueue(second, {
      lease_ttl: 100,
      id_source: createIdSource({
        resume: { [WORK_QUEUE_ITEM_NAMESPACE]: 1, [WORK_QUEUE_LEASE_NAMESPACE]: 1 },
      }),
    });
    const { clock } = loggingClock(500); // 重启时逻辑时间已越过旧租约截止（100）
    const executed: string[] = [];
    const loop = createWorkerLoop(
      {
        store: second,
        queue: queueB,
        clock,
        executor: executorFn((ctx) => {
          executed.push(String(ctx.claim.request_id));
          return { status: 'completed' };
        }),
      },
      { worker_id: WORKER_2 },
    );

    const report = loop.recover();
    expect(report.expired_lease_ids).toHaveLength(1);
    expect(report.reclaimed_request_ids.map(String)).toEqual([String(item.request_id)]);
    expect(report.withheld_request_ids).toHaveLength(0);
    expect(report.delivery.guarantee).toBe('at_least_once');
    expect(report.delivery.exactly_once_claimed).toBe(false);

    const outcome = await loop.tick();
    expect(outcome.kind).toBe('executed');
    expect(executed).toEqual([String(item.request_id)]);
    expect(
      queueB.listItems().find((view) => view.request_id === item.request_id)?.status,
    ).toBe('completed');
    expect(queueB.listItems().find((view) => view.request_id === item.request_id)?.attempts).toBe(2);
  });

  it('反例：未知副作用 ⇒ 恢复扣留、循环不重放（执行器零调用）', async () => {
    const first = openStore('file');
    registerTask(first, TASK_A);
    persistAction(first, TASK_A, 'a-submitted', 'submitted'); // 已接触外部世界
    const queueA = createWorkQueue(first, { lease_ttl: 100 });
    const item = queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    queueA.claim(WORKER_1, asLogicalTime(0));

    const second = openStore('file');
    const queueB = createWorkQueue(second, { lease_ttl: 100 });
    const { clock } = loggingClock(500);
    let calls = 0;
    const loop = createWorkerLoop(
      {
        store: second,
        queue: queueB,
        clock,
        executor: executorFn(() => {
          calls += 1;
          return { status: 'completed' };
        }),
      },
      { worker_id: WORKER_2 },
    );

    const report = loop.recover();
    expect(report.withheld_request_ids.map(String)).toEqual([String(item.request_id)]);
    expect(report.reclaimed_request_ids).toHaveLength(0);
    expect(report.actions.unknown_effect_action_ids).toEqual(['a-submitted']);
    expect(report.actions.blocked_task_ids.map(String)).toEqual(['T-A']);
    expect(report.actions.blind_replay_allowed).toBe(false);

    // 循环照常跑：唯一一条被扣留 ⇒ 领不到活，**执行器一次都没被调用**（没有盲重放）。
    const summary = await loop.run(3);
    expect(calls).toBe(0);
    expect(summary.stats.claims).toBe(0);
    expect(queueB.listClaimable()).toHaveLength(0);
    // 交叉校验：报告说"扣留"，持久状态也真的不可领取。
    expect(auditReplaySafety(queueB, report)).toHaveLength(0);
  });

  it('反向对照：把扣留项偷偷改回可领取 ⇒ auditReplaySafety 检出', async () => {
    const first = openStore('file');
    registerTask(first, TASK_A);
    persistAction(first, TASK_A, 'a-result-unknown', 'result_unknown');
    const queueA = createWorkQueue(first, { lease_ttl: 100 });
    const item = queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    queueA.claim(WORKER_1, asLogicalTime(0));

    const second = openStore('file');
    const queueB = createWorkQueue(second, { lease_ttl: 100 });
    const { clock } = loggingClock(500);
    const loop = createWorkerLoop(
      { store: second, queue: queueB, clock, executor: executorFn(() => ({ status: 'completed' })) },
      { worker_id: WORKER_2 },
    );
    const report = loop.recover();
    expect(report.withheld_request_ids).toHaveLength(1);
    expect(auditReplaySafety(queueB, report)).toHaveLength(0);

    // 篡改：直接把它改回 `pending` + 无主（`unassigned` 是 work-queue 的空闲哨兵）= 盲重放。
    second.transact((tx) => {
      const stored = tx.getWorkItem(item.request_id);
      if (stored === undefined) throw new Error('夹具要求条目存在');
      tx.putWorkItem(
        createWorkItem({
          ...stored,
          status: 'pending',
          owner_instance_id: asInstanceId('unassigned'),
        }),
      );
    });

    const violations = auditReplaySafety(queueB, report);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('withheld_item_became_claimable');
    expect(violations[0]?.request_id).toBe(item.request_id);
  });
});

// ---------------------------------------------------------------------------
// 4：优雅停机
// ---------------------------------------------------------------------------

describe('KRN-10 工作进程循环：优雅停机', () => {
  it('正例：停机信号后不再领新项；在途项收尾，剩余条目未被领走', async () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    for (let i = 0; i < 3; i += 1) {
      queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    }
    const { clock } = loggingClock();
    let stop = false;
    let calls = 0;

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        stopRequested: () => stop,
        executor: executorFn(() => {
          calls += 1;
          stop = true; // 执行完第一条后收到停机信号
          return { status: 'completed' };
        }),
      },
      { worker_id: WORKER_1 },
    );

    const summary = await loop.run(20);
    expect(summary.stop_reason).toBe('stop_requested');
    // 在途那条**收尾完成**；之后不再领新项。
    expect(calls).toBe(1);
    expect(summary.stats.completed).toBe(1);
    expect(summary.stats.executor_calls).toBe(1);
    expect(queue.listItems().filter((view) => view.status === 'completed')).toHaveLength(1);
    expect(queue.listClaimable()).toHaveLength(2);
    expect(auditSingleOwnership(store)).toHaveLength(0);
  });

  it('正例：停机时在途项**如实标记** —— 执行器放弃 ⇒ 记 failed，不谎报成功', async () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    const { clock } = loggingClock();
    let stop = false;

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        stopRequested: () => stop,
        executor: executorFn((ctx) => {
          stop = true;
          expect(ctx.stop_requested).toBe(true);
          return { status: 'abandoned', reason: '收到停机信号，未完成' };
        }),
      },
      { worker_id: WORKER_1 },
    );

    const outcome = await loop.tick();
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') throw new Error('不可达');
    expect(outcome.settlement.intent).toBe('abandoned');
    expect(outcome.settlement.applied).toBe(true);
    expect(outcome.settlement.ledger_reason).toBe('failed');
    const view = queue.listItems()[0];
    expect(view?.status).toBe('failed');
    // 队列视图不含失败原因，从**持久记录**读原始 WorkItem 核对（如实标记的证据）。
    const stored = store.transact((tx) =>
      view === undefined ? undefined : tx.getWorkItem(view.request_id),
    );
    expect(stored?.status).toBe('failed');
    expect(stored?.failure_reason).toContain('停机');
  });
});

// ---------------------------------------------------------------------------
// 5 / 5b：并发（同进程模拟）
// ---------------------------------------------------------------------------

describe('KRN-10 工作进程循环：并发（同进程模拟，非跨进程实测）', () => {
  const TOTAL = 4;

  it('正例：两循环共享同一介质 ⇒ 同一项不被两人领取', async () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    // 两个"进程"共享**同一个** WorkQueue（同一介质、同一个 IdSource）——同进程模拟。
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    for (let i = 0; i < TOTAL; i += 1) {
      queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    }

    const owners = new Map<string, string[]>();
    const makeLoop = (name: string) =>
      createWorkerLoop(
        {
          store,
          queue,
          clock: loggingClock().clock,
          executor: executorFn((ctx) => {
            const id = String(ctx.claim.request_id);
            owners.set(id, [...(owners.get(id) ?? []), name]);
            return { status: 'completed', result_refs: [`artifact://${name}/${id}`] };
          }),
        },
        { worker_id: asInstanceId(name) },
      );

    const [a, b] = await Promise.all([makeLoop('W-A').run(12), makeLoop('W-B').run(12)]);

    expect(owners.size).toBe(TOTAL);
    for (const [, by] of owners) {
      expect(by).toHaveLength(1); // 每一项**只被一个 worker 执行过**
    }
    expect(a.stats.claims + b.stats.claims).toBe(TOTAL);
    expect(a.stats.completed + b.stats.completed).toBe(TOTAL);
    expect(queue.listItems().every((view) => view.status === 'completed')).toBe(true);
    // 双领检测器：正常并发下零违规。
    expect(auditSingleOwnership(store)).toHaveLength(0);
    expect(a.polling_violations).toHaveLength(0);
    expect(b.polling_violations).toHaveLength(0);
  });

  it('反向对照：植入第二条 running 租约 ⇒ auditSingleOwnership 检出双领', () => {
    const store = openStore('memory');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const item = queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    const claim = queue.claim(WORKER_1, asLogicalTime(0)).claim;
    expect(claim).not.toBeNull();
    expect(auditSingleOwnership(store)).toHaveLength(0); // 正常：零违规

    // 手工再写一条指向**同一条目**的 running 租约 —— 模拟"双领真的发生了"。
    store.transact((tx) => {
      tx.putRun(
        createRunRecord({
          run_id: asRunId(`${WORK_QUEUE_LEASE_NAMESPACE}-999`),
          task_id: TASK_A,
          group_id: asGroupId('G1'),
          instance_id: WORKER_2,
          task_revision: REV,
          started_at: asLogicalTime(0),
          lease_deadline: asLogicalTime(1000),
          status: 'running',
          frozen_at: asLogicalTime(0),
          frozen_request_ids: [item.request_id],
        }),
      );
    });

    const violations = auditSingleOwnership(store);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.request_id).toBe(item.request_id);
    expect(violations[0]?.lease_ids).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 交付语义
// ---------------------------------------------------------------------------

describe('KRN-10 工作进程循环：交付语义', () => {
  it('至少一次、**不宣称**恰好一次（透传队列口径，不另立说法）', () => {
    const store = openStore('memory');
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock: createLogicalClockDriver(),
        executor: executorFn(() => ({ status: 'completed' })),
      },
      { worker_id: WORKER_1 },
    );
    const delivery = loop.delivery();
    expect(delivery.guarantee).toBe('at_least_once');
    expect(delivery.exactly_once_claimed).toBe(false);
    expect(delivery.note.length).toBeGreaterThan(0);
  });
});
