/**
 * **重启恢复**：租约与预算的跨重启连续性（C2；合同 R203 / R218 / R225）。
 *
 * ## 本文件要钉死的四类判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 额度用掉 N ⇒ 重启 ⇒ `used ≥ N`，**不得归零**；继续消费被**拒绝** | **反例** |
 * | 2 | 租约已过期 ⇒ 重启后**仍然过期**，不得可用 | **反例** |
 * | 3 | 未过期租约重启后**仍能**正常使用；未超限额度重启后**仍能**继续消费 | **正例（对照）** |
 * | 4 | 把持久化摘掉（内存实现）⇒ 用例 1/2 的判据**必须变红** | **反向对照** |
 *
 * 第 4 条是本文件的关键：没有它，"重启后 used 是 N"可能只是因为**根本没重启**
 * （同一个进程、同一个台账）。所以每条反例都配一份"同输入、只把介质换成易失"的对照，
 * 用**同一个断言函数**去跑，并要求结论相反。
 *
 * ## 用真文件、真重新构造，不用假替身
 *
 * "重启"= **同一份磁盘、全新的进程内状态**：`createFileStore` 重新构造一个实例读回落盘状态，
 * 逻辑时钟用落盘高水位播种（`logicalTimeHighWater`）。这正是
 * `apps/demo/server/kernel.ts` 启动时走的同一条路径。
 *
 * ## 时间纪律
 *
 * 全程逻辑时间。`src/**` 禁墙钟（R50.4），本文件也不例外。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BudgetLedger, DEFAULT_SCENARIO_BUDGET } from '../clock/index.js';
import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asRunId,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createInstanceState,
  createRunRecord,
  evaluateRunOwnership,
  isLeaseExpired,
  type LogicalTime,
  type RunRecord,
  type RunStatus,
  type Store,
} from '../protocol/index.js';
import { createFileStore, createMemoryStore, logicalTimeHighWater } from '../storage/index.js';
import { appendKernelEvent, runStartedEvent } from './kernel-events.js';
import { budgetRecoverySummary, reconcileLeasesAfterRestart, recoverAfterRestart } from './restart.js';

const GROUP = asGroupId('G-1');
const TASK = asTaskId('T-1');
const INSTANCE = asInstanceId('I-1');

let workDir: string;
let storePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-restart-'));
  storePath = join(workDir, 'kernel-store.json');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 一个"进程"。`file` = 落盘（重启后状态还在）；`memory` = 易失（模拟"没落盘"）。 */
function openStore(kind: 'file' | 'memory'): Store {
  if (kind === 'memory') {
    return createMemoryStore({ clock: () => asLogicalTime(0) });
  }
  return createFileStore({
    filePath: storePath,
    clock: () => asLogicalTime(0),
    now: () => 0,
    lockOwner: 'restart-test',
    lockStaleMs: 1,
  });
}

/** 重启：新进程读回同一份磁盘，逻辑时钟按**落盘高水位**播种（与宿主启动同一条路径）。 */
function restart(store: Store, kind: 'file' | 'memory'): { store: Store; now: LogicalTime } {
  const reopened = openStore(kind);
  const now = asLogicalTime(logicalTimeHighWater(reopened.snapshot()));
  return { store: reopened, now };
}

function makeRun(input: {
  readonly runId: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly status?: RunStatus;
  readonly finishedAt?: number | null;
  readonly instanceId?: string;
}): RunRecord {
  return createRunRecord({
    run_id: asRunId(input.runId),
    task_id: TASK,
    group_id: GROUP,
    instance_id: asInstanceId(input.instanceId ?? String(INSTANCE)),
    task_revision: asRevision(1),
    started_at: asLogicalTime(input.startedAt),
    lease_deadline: asLogicalTime(input.deadline),
    status: input.status ?? 'running',
    finished_at: input.finishedAt === undefined || input.finishedAt === null
      ? null
      : asLogicalTime(input.finishedAt),
  });
}

/** 写入一条轮次**并**留下同事务的 `run_started` 观测事件（预算事实的唯一权威来源）。 */
function putRunWithStartedEvent(source: Store, run: RunRecord): void {
  const ids = createIdSource();
  source.transact((tx) => {
    tx.putRun(run);
    appendKernelEvent(tx, runStartedEvent(run), ids);
  });
}

/**
 * 写一条 `running` 轮次：轮次 + 指向它的实例（所有权判定才成立）+ `run_started` 事件。
 */
function putRunning(source: Store, run: RunRecord): void {
  const ids = createIdSource();
  source.transact((tx) => {
    tx.putRun(run);
    tx.putInstance(
      createInstanceState({
        instance_id: run.instance_id,
        group_id: run.group_id,
        updated_at: run.started_at,
        active_run_id: run.run_id,
      }),
    );
    appendKernelEvent(tx, runStartedEvent(run), ids);
  });
}

/**
 * 把"已发生的时间"推到 `at`——**不产生任何预算事实**。
 * 用待投递事件而不是 `run_started`：它参与高水位（`created_at`），但不计入预算。
 */
function pushObservedTime(source: Store, at: number): void {
  const ids = createIdSource();
  source.transact((tx) => {
    tx.enqueueDeliveryEvent(
      createDeliveryEvent(
        {
          kind: 'wakeup_queued',
          task_id: TASK,
          group_id: GROUP,
          instance_id: INSTANCE,
          created_at: asLogicalTime(at),
          reason: '推观测时间（不计预算）',
        },
        ids,
      ),
    );
  });
}

/**
 * **同一段断言**，正反两种介质各跑一次。
 *
 * `expectRefused`：本次重启后"继续消费"是否**应当**被拒绝。
 * 落盘 ⇒ true（额度没清零）；易失 ⇒ false（额度归零了，所以放行——这就是缺陷的样子）。
 */
function assertBudgetGateAfterRestart(kind: 'file' | 'memory', expectRefused: boolean): void {
  const limit = 2;
  const budget = { ...DEFAULT_SCENARIO_BUDGET, runs: limit };

  // ── 第一个进程：跑掉 N = limit 轮 ──
  const first = openStore(kind);
  for (let index = 0; index < limit; index += 1) {
    putRunWithStartedEvent(
      first,
      makeRun({
        runId: `R-${String(index)}`,
        startedAt: index,
        deadline: index + 1000,
        status: 'finished',
        finishedAt: index,
      }),
    );
  }
  // 对照用：第一个进程的台账如实记到 limit。
  const firstLedger = new BudgetLedger(budget);
  for (let index = 0; index < limit; index += 1) {
    firstLedger.charge('runs', 1, { at: asLogicalTime(index), label: '第一个进程' });
  }
  expect(firstLedger.used('runs')).toBe(limit);

  // ── 重启 ──
  const restarted = restart(first, kind);
  const freshLedger = new BudgetLedger(budget);
  // 新进程的台账**一开始**是 0 —— 这正是过去"白送额度"的形状。
  expect(freshLedger.used('runs')).toBe(0);

  const report = recoverAfterRestart({
    store: restarted.store,
    now: restarted.now,
    ledger: freshLedger,
  });

  if (expectRefused) {
    // 落盘：恢复后**不得低于**已消费量，且闸门拒绝继续消费。
    expect(freshLedger.used('runs')).toBeGreaterThanOrEqual(limit);
    expect(report.budget?.target.runs).toBe(limit);
    expect(report.budget?.charged.runs).toBe(limit);
    expect(budgetRecoverySummary(freshLedger, budget)['runs']?.available).toBe(false);
  } else {
    // 易失：事实全丢 ⇒ 台账仍是 0 ⇒ **闸门放行本应被拒的消费**。
    // 这一支就是"没落盘"的样子，上一条的判别力由它担保。
    expect(freshLedger.used('runs')).toBe(0);
    expect(report.budget?.target.runs).toBe(0);
    expect(budgetRecoverySummary(freshLedger, budget)['runs']?.available).toBe(true);
  }
}

describe('C2 预算：重启不得清零（R225 / R218）', () => {
  it('反例：额度用掉 N ⇒ 重启 ⇒ used ≥ N，继续消费被**拒绝**', () => {
    assertBudgetGateAfterRestart('file', true);
  });

  it('反向对照：同输入、只把介质换成**易失** ⇒ 额度回到 0、闸门放行（证明上一条有判别力）', () => {
    assertBudgetGateAfterRestart('memory', false);
  });

  it('正例：只用了 1/3 的额度 ⇒ 重启后仍可继续消费（恢复不等于"一律锁死"）', () => {
    const budget = { ...DEFAULT_SCENARIO_BUDGET, runs: 3 };
    const first = openStore('file');
    putRunWithStartedEvent(
      first,
      makeRun({ runId: 'R-0', startedAt: 0, deadline: 1000, status: 'finished', finishedAt: 0 }),
    );

    const restarted = restart(first, 'file');
    const ledger = new BudgetLedger(budget);
    recoverAfterRestart({ store: restarted.store, now: restarted.now, ledger });

    expect(ledger.used('runs')).toBe(1);
    expect(budgetRecoverySummary(ledger, budget)['runs']?.available).toBe(true);
    // 且**还能再消费**：上限 3、已用 1。
    ledger.charge('runs', 1, { at: asLogicalTime(1), label: '重启后继续' });
    expect(ledger.used('runs')).toBe(2);
    expect(ledger.isExhausted('runs')).toBe(false);
  });

  it('恢复是**收敛**的：重复调用不重复记账（真幂等，不依赖进程内 applied 集合）', () => {
    const budget = { ...DEFAULT_SCENARIO_BUDGET, runs: 5 };
    const first = openStore('file');
    putRunWithStartedEvent(
      first,
      makeRun({ runId: 'R-0', startedAt: 0, deadline: 1000, status: 'finished', finishedAt: 0 }),
    );

    const ledger = new BudgetLedger(budget);
    const firstRun = recoverAfterRestart({
      store: openStore('file'),
      now: asLogicalTime(0),
      ledger,
    });
    expect(firstRun.budget?.charged.runs).toBe(1);
    const secondRun = recoverAfterRestart({
      store: openStore('file'),
      now: asLogicalTime(0),
      ledger,
    });
    expect(secondRun.budget?.charged.runs).toBe(0);
    expect(ledger.used('runs')).toBe(1);
  });

  it('R218：**换账本不等于新额度** —— 再开一本新台账也恢复到同一用量', () => {
    const budget = { ...DEFAULT_SCENARIO_BUDGET, runs: 4 };
    const first = openStore('file');
    putRunWithStartedEvent(
      first,
      makeRun({ runId: 'R-0', startedAt: 0, deadline: 1000, status: 'finished', finishedAt: 0 }),
    );

    // 两本**互不相干**的新台账（模拟"换个进程 / 换本账"）。
    const ledgerA = new BudgetLedger(budget);
    const ledgerB = new BudgetLedger(budget);
    recoverAfterRestart({ store: openStore('file'), now: asLogicalTime(0), ledger: ledgerA });
    recoverAfterRestart({ store: openStore('file'), now: asLogicalTime(0), ledger: ledgerB });
    expect(ledgerA.used('runs')).toBe(1);
    expect(ledgerB.used('runs')).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('C2 租约：已过期的重启后仍过期，未过期的按剩余时长续接（R203）', () => {
  it('反例：租约已过期 ⇒ 重启后仍然过期（置 aborted）且结论**落盘**', () => {
    const first = openStore('file');
    // 起点 0、截止 10；再把"已发生的时间"推到 50 ⇒ 该租约已过期。
    putRunning(first, makeRun({ runId: 'R-expired', startedAt: 0, deadline: 10 }));
    pushObservedTime(first, 50);

    const restarted = restart(first, 'file');
    expect(restarted.now).toBe(50);

    const result = reconcileLeasesAfterRestart({ store: restarted.store, now: restarted.now });
    expect(result.expired).toEqual(['R-expired']);
    expect(result.continuing).toEqual([]);

    // 落盘：第三个实例读回仍是 aborted ⇒ 不是只在内存里改了一下。
    const third = openStore('file');
    const run = third.snapshot().runs.find((candidate) => String(candidate.run_id) === 'R-expired');
    expect(run?.status).toBe('aborted');
    expect(run?.finished_at).toBe(50);

    // 且**不可用**：所有权判定拒绝（轮次已非活动）。
    const validity = evaluateRunOwnership({
      run,
      instance: third.snapshot().instances[0],
      now: restarted.now,
      current_task_revision: asRevision(1),
    });
    expect(validity.valid).toBe(false);
    expect(validity.reason).toBe('run_not_active');
  });

  it('反向对照：同样的租约、介质换成**易失** ⇒ 重启后它根本不存在（证明上一条测的是持久化）', () => {
    const first = openStore('memory');
    putRunning(first, makeRun({ runId: 'R-expired', startedAt: 0, deadline: 10 }));
    pushObservedTime(first, 50);

    const restarted = restart(first, 'memory');
    expect(restarted.store.snapshot().runs).toEqual([]);
    const result = reconcileLeasesAfterRestart({ store: restarted.store, now: asLogicalTime(50) });
    expect(result.expired).toEqual([]);
    expect(result.continuing).toEqual([]);
  });

  it('正例：租约**未**过期 ⇒ 重启后仍 `running` 且仍可用（按剩余时长续接）', () => {
    const first = openStore('file');
    // 起点 0、截止 1000；观测时间只到 3 ⇒ 还剩 997。
    putRunning(first, makeRun({ runId: 'R-live', startedAt: 0, deadline: 1000 }));
    pushObservedTime(first, 3);

    const restarted = restart(first, 'file');
    // 关键：时钟**不会**被租约截止推着往前跑（高水位刻意排除 lease_deadline）。
    expect(restarted.now).toBe(3);

    const result = reconcileLeasesAfterRestart({ store: restarted.store, now: restarted.now });
    expect(result.expired).toEqual([]);
    expect(result.continuing).toEqual(['R-live']);

    const run = restarted.store.snapshot().runs.find((c) => String(c.run_id) === 'R-live');
    expect(run?.status).toBe('running');
    expect(run === undefined ? true : isLeaseExpired(run, restarted.now)).toBe(false);

    // **仍能正常使用**：所有权判定通过（同实例、活跃轮次一致、租约未过期、版本未变）。
    const validity = evaluateRunOwnership({
      run,
      instance: restarted.store.snapshot().instances[0],
      now: restarted.now,
      current_task_revision: asRevision(1),
    });
    expect(validity).toEqual({ valid: true, reason: null });
  });

  it('已结束的轮次不被动到（协调只碰 running，不改历史）', () => {
    const first = openStore('file');
    putRunWithStartedEvent(
      first,
      makeRun({ runId: 'R-done', startedAt: 0, deadline: 10, status: 'finished', finishedAt: 5 }),
    );
    const restarted = restart(first, 'file');
    const result = reconcileLeasesAfterRestart({ store: restarted.store, now: asLogicalTime(5000) });
    expect(result.expired).toEqual([]);
    expect(result.continuing).toEqual([]);
    expect(openStore('file').snapshot().runs[0]?.status).toBe('finished');
  });

  it('时钟锚点：`lease_deadline` **不**参与高水位（否则所有遗留租约都会被凭空烧掉）', () => {
    const store = openStore('file');
    putRunning(store, makeRun({ runId: 'R-live', startedAt: 0, deadline: 1000 }));
    // 高水位只取"发生过的事"（started_at = 0），不取未来的截止时刻 1000。
    expect(logicalTimeHighWater(store.snapshot())).toBe(0);
  });
});

describe('C2 总入口：租约与预算一次恢复', () => {
  it('同时给 store 与 ledger ⇒ 两类结论在同一份报告里，且**只认** run_started 计预算', () => {
    const budget = { ...DEFAULT_SCENARIO_BUDGET, runs: 1 };
    const first = openStore('file');
    putRunning(first, makeRun({ runId: 'R-live', startedAt: 0, deadline: 10 }));
    // 推时间用的待投递事件**不计**预算（它只是"发生过的事"）。
    pushObservedTime(first, 50);

    const restarted = restart(first, 'file');
    const ledger = new BudgetLedger(budget);
    const report = recoverAfterRestart({
      store: restarted.store,
      now: restarted.now,
      ledger,
    });

    expect(report.leases.expired).toEqual(['R-live']);
    expect(report.leases.continuing).toEqual([]);
    // 只有 run_started 计成 runs；wakeup 事件不参与预算计量。
    expect(report.budget?.target.runs).toBe(1);
    expect(ledger.used('runs')).toBe(1);
    expect(ledger.isExhausted('runs')).toBe(true);
    expect(ledger.used('diagnoses')).toBe(0);
  });

  it('不给台账 ⇒ `budget` 如实为 null（不假装恢复过预算）', () => {
    const first = openStore('file');
    pushObservedTime(first, 1);
    const restarted = restart(first, 'file');
    const report = recoverAfterRestart({ store: restarted.store, now: restarted.now });
    expect(report.budget).toBeNull();
    expect(report.leases.expired).toEqual([]);
  });
});
