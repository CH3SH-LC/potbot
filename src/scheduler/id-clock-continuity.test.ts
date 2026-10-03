/**
 * KRN-10：ID 与逻辑钟的**跨重启连续性**（R202 / R203 / R225）。
 *
 * ## 判据表
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 高水位合并**只增不减**（旧表不拉低结果） | 正例 |
 * | 2 | 高水位倒退 ⇒ 大声抛错 | **反例** |
 * | 3 | 带 `resume` 续发 ⇒ 序号严格大于重启前；不带 ⇒ **真的重号** | **反向对照（主判据）** |
 * | 4 | 观测高水位与 `src/storage` 的 `logicalTimeHighWater` **逐值相等**（防漂移） | 正例 |
 * | 5 | 重启后新事件时间戳**严格大于**重启前最后一个 | 正例 |
 * | 6 | 时间戳不前进 ⇒ 抛错 | **反例** |
 * | 7 | 过期租约不因重启复活；未过期续接 | 正例 + **反例** |
 * | 8 | 预算不因重启清零（只上不下）；摘掉持久事实 ⇒ 归零（证明持久是真来源） | 正例 + **反向对照** |
 *
 * ## 介质说明
 *
 * "重启"= **同进程内**重建 store / 重建源并读回。**真实双进程**的并发发号与时钟交叉
 * **未实测**，本文件不据此宣称跨进程结论（`src/storage/file-store.cross-process.test.ts`
 * 才是真进程口径）。
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
  createKernelEvent,
  createRunRecord,
  type StoreSnapshot,
  type TaskId,
} from '../protocol/index.js';
import { __deleteStoreFiles, createFileStore, createMemoryStore } from '../storage/index.js';
import { logicalTimeHighWater } from '../storage/index.js';
import {
  assertClockResumed,
  assertHighWaterMonotonic,
  assertNewEventIsLater,
  continueAfterRestart,
  mergeHighWater,
  numericSuffix,
  observedHighWater,
  observedTimeHighWater,
  planIdContinuity,
  resumeIdSource,
  resumeTimeAfter,
} from './id-clock-continuity.js';

const TASK: TaskId = asTaskId('T1');

function emptyBase(): StoreSnapshot {
  return createMemoryStore().snapshot();
}

describe('KRN-10 连续性：id 高水位只增不减（R202）', () => {
  it('① 合并取逐命名空间 max：旧表拉不低新表', () => {
    expect(mergeHighWater({ evt: 5, run: 2 }, { evt: 3, msg: 7 })).toEqual({ evt: 5, run: 2, msg: 7 });
    expect(mergeHighWater(undefined, { evt: 4 })).toEqual({ evt: 4 });
    // 反向对照：较低的表**不能**改写结果。
    expect(mergeHighWater({ evt: 9 }, { evt: 1 })['evt']).toBe(9);
  });

  it('② 反例：高水位倒退 ⇒ 大声抛错（不静默取大）', () => {
    expect(() => assertHighWaterMonotonic({ evt: 5 }, { evt: 4 })).toThrow(/高水位倒退/);
    expect(() => assertHighWaterMonotonic({ evt: 5 }, {})).toThrow(/高水位倒退/);
    expect(() => assertHighWaterMonotonic({ evt: 5 }, { evt: 5 })).not.toThrow();
  });

  it('③ 反向对照（主判据）：带 `resume` 续发不重号；不带 `resume` **真的重号**', () => {
    // 重启前：第一个进程发出 evt-1 / evt-2。
    const first = createIdSource();
    const used = [first.newEventId(), first.newEventId()];
    const marks = first.highWaterMarks();
    expect(used.map(String)).toEqual(['evt-1', 'evt-2']);

    // 重启后：从持久高水位续发。
    const snapshot = { ...emptyBase() };
    const plan = planIdContinuity({ snapshot, persisted: marks });
    const { source } = resumeIdSource(plan);
    const resumed = [source.newEventId(), source.newEventId()];
    expect(resumed.map(String)).toEqual(['evt-3', 'evt-4']);
    for (const id of resumed) expect(used.map(String)).not.toContain(String(id));

    // 反向：**不带** resume 的"第二次进程"会重新发出 evt-1 —— 证明续发不是摆设。
    const naive = createIdSource();
    expect(String(naive.newEventId())).toBe('evt-1');
    expect(used.map(String)).toContain('evt-1');
  });

  it('③b 观测高水位兜底：即使落盘表丢了，也能从记录里复算下限', () => {
    // 直接用手搓快照验证观测口径（避免依赖消息构造的重夹具）。
    const snapshot: StoreSnapshot = {
      ...emptyBase(),
      runs: [
        createRunRecord({
          run_id: asRunId('run-7'),
          task_id: TASK,
          group_id: asGroupId('G1'),
          instance_id: asInstanceId('C'),
          task_revision: asRevision(1),
          started_at: asLogicalTime(1),
          lease_deadline: asLogicalTime(1001),
        }),
      ],
    };
    expect(observedHighWater(snapshot)).toEqual({ run: 7 });
    // 落盘表更低时，观测值把下限抬回来（合取大）。
    const plan = planIdContinuity({ snapshot, persisted: { run: 2 } });
    expect(plan.effective).toEqual({ run: 7 });
  });

  it('③c 非序号 id（如检查点事件）不参与高水位，不误伤', () => {
    expect(numericSuffix('evt-ckpt-abc-1234-header')).toBeNull();
    expect(numericSuffix('seed/msg-12')).toBe(12);
    expect(numericSuffix('msg-0')).toBeNull();
  });
});

describe('KRN-10 连续性：逻辑钟不回原点（R203）', () => {
  it('④ 观测时间高水位与 `src/storage` 的实现**逐值相等**（防口径漂移）', () => {
    const ids = createIdSource();
    const snapshot: StoreSnapshot = {
      ...emptyBase(),
      runs: [
        createRunRecord({
          run_id: asRunId('run-1'),
          task_id: TASK,
          group_id: asGroupId('G1'),
          instance_id: asInstanceId('C'),
          task_revision: asRevision(1),
          started_at: asLogicalTime(3),
          lease_deadline: asLogicalTime(1003),
          finished_at: asLogicalTime(9),
        }),
      ],
      kernel_events: [
        createKernelEvent({ kind: 'run_started', at: asLogicalTime(3), run_id: asRunId('run-1') }, ids),
        createKernelEvent({ kind: 'run_finished', at: asLogicalTime(9), run_id: asRunId('run-1') }, ids),
      ],
      delivery_events: [
        createDeliveryEvent(
          { kind: 'wakeup_queued', task_id: TASK, group_id: asGroupId('G1'), instance_id: asInstanceId('C'), created_at: asLogicalTime(11), reason: 'r' },
          ids,
        ),
      ],
    };
    expect(observedTimeHighWater(snapshot)).toBe(asLogicalTime(11));
    expect(observedTimeHighWater(snapshot)).toBe(logicalTimeHighWater(snapshot));
  });

  it('⑤ 重启后首条事件时间戳**严格大于**重启前最后一个', () => {
    const ids = createIdSource();
    const snapshot: StoreSnapshot = {
      ...emptyBase(),
      kernel_events: [createKernelEvent({ kind: 'recovery_performed', at: asLogicalTime(40) }, ids)],
    };
    const preLast = observedTimeHighWater(snapshot);
    const resumeAt = resumeTimeAfter(snapshot);
    expect(resumeAt).toBeGreaterThan(preLast);
    // 真实写入一条新事件，断言它严格更晚。
    assertNewEventIsLater({
      preRestartLast: preLast,
      newEvent: createKernelEvent({ kind: 'recovery_performed', at: resumeAt }, ids),
    });
  });

  it('⑥ 反例：时间戳不前进（原地 / 倒退）⇒ 抛错', () => {
    expect(() => assertClockResumed(asLogicalTime(40), asLogicalTime(40))).toThrow(/严格前进/);
    expect(() => assertClockResumed(asLogicalTime(40), asLogicalTime(0))).toThrow(/严格前进/);
    expect(() => assertClockResumed(asLogicalTime(40), asLogicalTime(41))).not.toThrow();
    // 步长必须为正。
    expect(() => resumeTimeAfter({ ...emptyBase() }, 0)).toThrow(/步长/);
  });
});

describe('KRN-10 连续性：租约与预算不因重启复活（R203 / R225）', () => {
  it('⑦ 过期租约重启后仍过期（不复活）；未过期按剩余续接', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putRun(
        createRunRecord({
          run_id: asRunId('run-dead'),
          task_id: TASK,
          group_id: asGroupId('G1'),
          instance_id: asInstanceId('C'),
          task_revision: asRevision(1),
          started_at: asLogicalTime(1),
          lease_deadline: asLogicalTime(5),
          status: 'running',
        }),
      );
      tx.putRun(
        createRunRecord({
          run_id: asRunId('run-alive'),
          task_id: TASK,
          group_id: asGroupId('G1'),
          instance_id: asInstanceId('C'),
          task_revision: asRevision(1),
          started_at: asLogicalTime(1),
          lease_deadline: asLogicalTime(900),
          status: 'running',
        }),
      );
    });
    // 显式给 now（= 恢复时刻）：run-dead 的截止 5 落在它之前 ⇒ 过期；run-alive 的截止 900 之后 ⇒ 续接。
    const report = continueAfterRestart({ store, now: asLogicalTime(10) });
    expect(report.leases.expired).toEqual(['run-dead']);
    expect(report.leases.continuing).toEqual(['run-alive']);
    // 反向对照：未过期的**不得**被顺手作废（否则正例被误杀）。
    expect(report.leases.expired).not.toContain('run-alive');
    expect(report.clock_reset_to_origin).toBe(false);
    expect(report.budget_reset_on_restart).toBe(false);
    expect(store.snapshot().runs.find((r) => String(r.run_id) === 'run-dead')?.status).toBe('aborted');
  });

  it('⑧ 预算不因重启清零；摘掉持久事实 ⇒ 归零（证明持久是真来源）', () => {
    const ids = createIdSource();
    const withFacts = createMemoryStore();
    withFacts.transact((tx) => {
      tx.appendKernelEvent(createKernelEvent({ kind: 'run_started', at: asLogicalTime(1), run_id: asRunId('run-1') }, ids));
      tx.appendKernelEvent(createKernelEvent({ kind: 'run_started', at: asLogicalTime(2), run_id: asRunId('run-2') }, ids));
    });
    const ledger = new BudgetLedger(DEFAULT_SCENARIO_BUDGET);
    const report = continueAfterRestart({ store: withFacts, ledger });
    expect(report.budget?.charged['runs']).toBe(2);
    expect(ledger.used('runs'), '预算不得从 0 重新开始').toBe(2);

    // 反向对照：换成**空的**事实来源，同一份恢复逻辑得到 0 —— 说明上面那个 2 来自持久事实。
    const empty = createMemoryStore();
    const ledger2 = new BudgetLedger(DEFAULT_SCENARIO_BUDGET);
    continueAfterRestart({ store: empty, ledger: ledger2 });
    expect(ledger2.used('runs')).toBe(0);
  });
});

describe('KRN-10 连续性：跨 store 重开（同进程模拟，非跨进程）', () => {
  let dir = '';
  let storePath = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'potbot-continuity-'));
    storePath = join(dir, 'kernel-store.json');
  });

  afterEach(() => {
    __deleteStoreFiles(storePath);
    rmSync(dir, { recursive: true, force: true });
  });

  it('⑨ 落盘的时间与 id 在"重开 store"后可见，续发严格更大', () => {
    const open = () =>
      createFileStore({ filePath: storePath, clock: () => asLogicalTime(0), now: () => 0, lockOwner: 'continuity-test' });

    const first = open();
    const ids = createIdSource();
    first.transact((tx) => {
      tx.appendKernelEvent(createKernelEvent({ kind: 'recovery_performed', at: asLogicalTime(50) }, ids));
    });
    const marks = ids.highWaterMarks();

    // 同进程内重开（**不是**真进程重启）：从磁盘读回。
    const second = open();
    const report = continueAfterRestart({ store: second, persistedMarks: marks });
    expect(report.clock.last_observed).toBe(asLogicalTime(50));
    expect(report.clock.resume_at).toBeGreaterThan(report.clock.last_observed);
    const { source } = resumeIdSource(report.ids);
    expect(String(source.newEventId())).toBe('evt-2');
  });
});
