/**
 * **V2-accept — G03（诊断预算的事前许可）独立验收**（合同 v1.3 §3，R44.1–R44.7）。
 *
 * ## 本文件验的是什么
 *
 * 核心不变量（每条断言都用**等号**）：
 * ```text
 * diagnosis_performed 事件数（summarizeKernelEvents().diagnosis_count）
 *   == 注入台账的 diagnoses 用量（ledger.used('diagnoses') == scheduler.budgetUsage().diagnoses）
 *   <= D_max                                    // 预登记上限，场景执行前给出
 * ```
 *
 * ## 与缺陷复现材料的关系（本文件是它的**反向结论**）
 *
 * `docs/other/review/freeze4-recheck/scheduler.test.ts` 的最后两个用例
 * （`new boundary bug signature: diagnosis budget zero…` / `…budget one…`）
 * **刻意断言缺陷存在**（D=0 仍记 1 次诊断；D=1 累计 3 次并继续为耗尽报告计费）。
 * 它们是"修复前可复现"的历史记录，**不是验收**。本文件把同一素材的**反向结论**写成验收：
 * 同样的公开入口（`onMessage` / `startRun` / `finishRun` / `advanceOnce`）与同样的自依赖环素材，
 * 断言 D=0 仍为 0 次、D=1 此后恒为 1 次、耗尽报告按 `KernelEvent.kind` 可见且不消费额度。
 *
 * ## 纪律
 *
 * - 只经公开入口驱动：`onMessage` / `startRun` / `finishRun` / `advanceOnce`；
 *   断言只经只读通道（`snapshot()` / `kernelEvents()` / `budgetUsage()` / 注入台账的 `used()`）。
 * - 不补账、不调大预算、不删耗尽断言、不用"事件流里有几条就算几条"绕过。
 * - 夹具（`src/scheduler/test-support.ts`）只做接线（造存储 / 注册实例与任务 / 造消息），
 *   不代办内核步骤、不代内核补账。
 */

import { describe, expect, it } from 'vitest';

import {
  createIdSource,
  summarizeKernelEvents,
  type KernelEvent,
  type RequestId,
  type RunId,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { BudgetLedger } from '../../../src/clock/index.js';
import {
  createScheduler,
  type RunPublication,
  type Scheduler,
} from '../../../src/scheduler/index.js';
import {
  INSTANCE_C,
  instanceId,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from '../../../src/scheduler/test-support.js';

// ---------------------------------------------------------------------------
// 夹具与只读辅助（只接线，不代办内核步骤、不补账）
// ---------------------------------------------------------------------------

/** 预登记上限（R_max / D_max / T_max）——**场景执行前**给出。 */
interface Limits {
  readonly runs: number;
  readonly diagnoses: number;
  readonly time: number;
}

interface Scenario {
  readonly limits: Limits;
  readonly store: ReturnType<typeof createMemoryStore>;
  readonly ledger: BudgetLedger;
  readonly scheduler: Scheduler;
}

/**
 * 建场景：先登记上限（此时无任何存储 / 轮次），再建存储、注册实例与任务、建调度器。
 * `store` 可注入（提交前 / 提交后故障用例）。
 */
function startScenario(input: {
  readonly limits: Limits;
  readonly store?: ReturnType<typeof createMemoryStore>;
}): Scenario {
  const limits: Limits = Object.freeze({ ...input.limits });
  const store = input.store ?? createMemoryStore();
  const ledger = new BudgetLedger(limits);
  registerInstance(store);
  registerTask(store);
  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    stagnation: { budget: limits, ledger },
  });
  return { limits, store, ledger, scheduler };
}

/** 一条**自依赖**的结局声明：工作项等的是它自己 ⇒ 判定阶梯上必然命中"环"（报得出来）。 */
function selfDependency(rid: RequestId): RunPublication {
  return {
    kind: 'waiting_dependency',
    request_id: rid,
    dependency_refs: [{ request_id: rid }],
    blocker_reason: { kind: 'waiting_dependency', detail: '自依赖（环）' },
  };
}

/** 一条普通完成声明。 */
function completed(rid: RequestId): RunPublication {
  return { kind: 'completed', request_id: rid, result_refs: [resultRef(rid)] };
}

/** 诊断事件数（**口径的唯一权威实现**，R4：不另数一套）。 */
function diagnosisCountOf(scheduler: Scheduler): number {
  return summarizeKernelEvents(scheduler.kernelEvents()).diagnosis_count;
}

/** 事件流里某一类事件的条数（只读）。 */
function kindCount(scheduler: Scheduler, kind: KernelEvent['kind'] | string): number {
  return scheduler.kernelEvents().filter((event) => event.kind === kind).length;
}

/** 待投递事件里某一类的条数（依赖解除通知的取证口径）。 */
function deliveryKindCount(scheduler: Scheduler, kind: string): number {
  return scheduler.snapshot().delivery_events.filter((event) => event.kind === kind).length;
}

/** 工作项状态（只读；不存在即抛错，不静默跳过）。 */
function workItemStatus(scheduler: Scheduler, rid: RequestId): string {
  const item = scheduler.snapshot().work_items.find((work) => work.request_id === rid);
  if (item === undefined) {
    throw new Error(`工作承诺表里没有 ${String(rid)}`);
  }
  return item.status;
}

/** 当前活动（running）轮次 id 列表（只读）。 */
function activeRunIds(scheduler: Scheduler): readonly RunId[] {
  return scheduler.snapshot()
    .runs.filter((run) => run.status === 'running')
    .map((run) => run.run_id);
}

/** 恰有一个活动轮次时返回它的 id（少于 / 多于一个即断言失败）。 */
function soleActiveRunId(scheduler: Scheduler): RunId {
  const ids = activeRunIds(scheduler);
  expect(ids).toHaveLength(1);
  return ids[0] as RunId;
}

/**
 * **核心不变量**：`diagnosis_performed` 事件数 == 台账 `diagnoses` 用量 == 投影用量 ≤ `D_max`。
 * 三条全部用**等号 / 上界**断言，并返回事件数供调用方继续断言。
 */
function expectDiagnosisInvariant(
  scheduler: Scheduler,
  ledger: BudgetLedger,
  dMax: number,
): number {
  const eventCount = diagnosisCountOf(scheduler);
  const ledgerUsage = ledger.used('diagnoses');
  expect(eventCount).toBe(ledgerUsage);
  expect(ledgerUsage).toBeLessThanOrEqual(dMax);
  expect(scheduler.budgetUsage()?.diagnoses).toBe(ledgerUsage);
  return eventCount;
}

// ---------------------------------------------------------------------------
// 1. D = 0
// ---------------------------------------------------------------------------

describe('G03 / R44.2 — D = 0', () => {
  it('轮次收尾后零诊断、零台账、在预算内，且耗尽报告按事件种类可见（不消费额度）', () => {
    const { ledger, scheduler } = startScenario({
      limits: { runs: 4, diagnoses: 0, time: 10000 },
    });

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const step = scheduler.advanceOnce({ instance_id: INSTANCE_C });
    expect(step.startedRuns).toBe(1);

    const out = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [selfDependency(requestId('r-1'))],
    });
    expect(out.accepted).toBe(true);

    // 核心不变量（等号）：事件数 == 台账用量 == 0 ≤ D_max = 0
    expect(diagnosisCountOf(scheduler)).toBe(0);
    expect(ledger.used('diagnoses')).toBe(0);
    expect(expectDiagnosisInvariant(scheduler, ledger, 0)).toBe(0);
    expect(() => ledger.assertWithinBudget()).not.toThrow();

    // 耗尽报告**可见**：按 `KernelEvent.kind` 断言（**不**按 diagnosis_count 断言它存在）
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBe(1);
    expect(out.stagnation?.diagnosis.verdict).toBe('budget_exhausted');
    expect(out.stagnation?.diagnosis.disposition).toBe('report');
    expect(out.stagnation?.diagnosis.consumes_diagnosis_budget).toBe(false);
    expect(out.stagnation?.diagnosis.diagnosis_count).toBe(0);
    expect(out.stagnation?.diagnosis.should_start_run).toBe(false);
    expect(out.stagnation?.diagnosis.produces_new_runnable_input).toBe(false);

    // 报告期间不得占槽（A05-07；R44.2）：按作用域内非终态项的负责人给出
    expect(out.stagnation?.diagnosis.releasable_instance_ids).toEqual([INSTANCE_C]);

    // 许可不足 ⇒ 未做环判定、未落地循环停止计划（工作项保持等待，不被"假失败"）
    expect(out.stagnation?.diagnosis.cycles).toHaveLength(0);
    expect(out.stagnation?.diagnosis.blocked_request_ids).toHaveLength(0);
    expect(workItemStatus(scheduler, requestId('r-1'))).toBe('waiting_dependency');

    // R44.3：耗尽报告的 `data` 至少携带 verdict / used / limit / reason（可读、可取证）
    const exhaustedEvents = scheduler
      .kernelEvents()
      .filter((event) => event.kind === 'diagnosis_budget_exhausted');
    expect(exhaustedEvents).toHaveLength(1);
    const exhaustedData = exhaustedEvents[0]?.data as Record<string, unknown>;
    expect(exhaustedData.verdict).toBe('budget_exhausted');
    expect(exhaustedData.used).toBe(0);
    expect(exhaustedData.limit).toBe(0);
    expect(typeof exhaustedData.reason).toBe('string');
    expect(exhaustedData.consumes_diagnosis_budget).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. D = 1（逐轮）
// ---------------------------------------------------------------------------

describe('G03 / R44.1 + R44.2 — D = 1', () => {
  it('第 1 轮 1 次真实诊断；此后恒为 1，绝不出现 2 或 3', () => {
    const { ledger, scheduler } = startScenario({
      limits: { runs: 4, diagnoses: 1, time: 10000 },
    });

    const observed: Array<{
      readonly run: number;
      readonly verdict: string | null | undefined;
      readonly count: number;
      readonly usage: number;
    }> = [];

    for (let n = 1; n <= 3; n += 1) {
      expect(scheduler.onMessage(workRequest(n)).result).toBe('accepted');
      const step = scheduler.advanceOnce({ instance_id: INSTANCE_C });
      expect(step.startedRuns).toBe(1);

      const out = scheduler.finishRun({
        run_id: soleActiveRunId(scheduler),
        publications: [selfDependency(requestId(`r-${n}`))],
      });
      expect(out.accepted).toBe(true);

      observed.push({
        run: n,
        verdict: out.stagnation?.diagnosis.verdict,
        count: diagnosisCountOf(scheduler),
        usage: ledger.used('diagnoses'),
      });
    }

    // 逐轮：第 1 轮真实诊断（cycle_detected）；第 2、3 轮为不消费额度的耗尽报告
    expect(observed).toEqual([
      { run: 1, verdict: 'cycle_detected', count: 1, usage: 1 },
      { run: 2, verdict: 'budget_exhausted', count: 1, usage: 1 },
      { run: 3, verdict: 'budget_exhausted', count: 1, usage: 1 },
    ]);

    // 核心不变量
    expect(expectDiagnosisInvariant(scheduler, ledger, 1)).toBe(1);
    expect(() => ledger.assertWithinBudget()).not.toThrow();

    // 真实诊断路径逐位不变（R44.4）：第 1 轮的环照旧落地为 failed
    expect(workItemStatus(scheduler, requestId('r-1'))).toBe('failed');
    // 耗尽报告不落地循环停止：第 2、3 轮的项保持等待
    expect(workItemStatus(scheduler, requestId('r-2'))).toBe('waiting_dependency');
    expect(workItemStatus(scheduler, requestId('r-3'))).toBe('waiting_dependency');
    // 第 2、3 轮各产生一份耗尽报告（不消费额度）
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. 耗尽后新输入
// ---------------------------------------------------------------------------

describe('G03 / R44.6 — 耗尽后新输入', () => {
  it('再投递新工作 / 新消息后推进，事件数 == 台账用量 恒 ≤ D_max', () => {
    const { ledger, scheduler } = startScenario({
      limits: { runs: 6, diagnoses: 1, time: 10000 },
    });

    // 第 1 轮：用掉唯一的诊断额度（真实诊断）
    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(1);
    const first = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [selfDependency(requestId('r-1'))],
    });
    expect(first.stagnation?.diagnosis.verdict).toBe('cycle_detected');
    expect(expectDiagnosisInvariant(scheduler, ledger, 1)).toBe(1);

    // 耗尽后**新输入**逐轮投递并推进：每一轮都是"报得出来"的环
    for (let n = 2; n <= 3; n += 1) {
      expect(scheduler.onMessage(workRequest(n)).result).toBe('accepted');
      const step = scheduler.advanceOnce({ instance_id: INSTANCE_C });
      expect(step.startedRuns).toBe(1);

      const out = scheduler.finishRun({
        run_id: soleActiveRunId(scheduler),
        publications: [selfDependency(requestId(`r-${n}`))],
      });
      expect(out.accepted).toBe(true);
      // 照旧上报停止原因，但**不**消费额度
      expect(out.stagnation?.diagnosis.verdict).toBe('budget_exhausted');
      expect(out.stagnation?.diagnosis.consumes_diagnosis_budget).toBe(false);
      expect(diagnosisCountOf(scheduler)).toBe(1);
      expect(ledger.used('diagnoses')).toBe(1);
      expect(expectDiagnosisInvariant(scheduler, ledger, 1)).toBe(1);
    }

    // 空推进（无新输入）不得凭空产生诊断
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(0);
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(0);
    expect(expectDiagnosisInvariant(scheduler, ledger, 1)).toBe(1);

    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBeGreaterThanOrEqual(1);
    expect(() => ledger.assertWithinBudget()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. 提交前失败
// ---------------------------------------------------------------------------

describe('G03 / R44.6 — 提交前失败', () => {
  it('存储与台账都不新增；移除故障后恢复路径不被自己的账目堵死', () => {
    let failBeforeCommit = false;
    const store = createMemoryStore({
      faults: {
        beforeCommit(): void {
          if (failBeforeCommit) {
            throw new Error('注入：提交前失败');
          }
        },
      },
    });
    const { ledger, scheduler } = startScenario({
      limits: { runs: 4, diagnoses: 0, time: 10000 },
      store,
    });

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(1);
    expect(ledger.used('runs')).toBe(1);

    const eventsBefore = scheduler.kernelEvents().length;
    const runsBefore = scheduler.snapshot().runs.length;

    failBeforeCommit = true;
    expect(() =>
      scheduler.finishRun({
        run_id: soleActiveRunId(scheduler),
        publications: [selfDependency(requestId('r-1'))],
      }),
    ).toThrow();
    failBeforeCommit = false;

    // 事务回滚：存储与台账**都不新增**
    expect(scheduler.kernelEvents().length).toBe(eventsBefore);
    expect(scheduler.snapshot().runs.length).toBe(runsBefore);
    expect(ledger.used('diagnoses')).toBe(0);
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBe(0);
    expect(kindCount(scheduler, 'diagnosis_performed')).toBe(0);
    expect(activeRunIds(scheduler)).toHaveLength(1);
    expect(() => ledger.assertWithinBudget()).not.toThrow();

    // 移除故障后恢复：账目没有被自己的失败堵死；D=0 ⇒ 仍为 0 次
    const recovered = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [selfDependency(requestId('r-1'))],
    });
    expect(recovered.accepted).toBe(true);
    expect(recovered.stagnation?.diagnosis.verdict).toBe('budget_exhausted');
    expect(diagnosisCountOf(scheduler)).toBe(0);
    expect(ledger.used('diagnoses')).toBe(0);
    expect(expectDiagnosisInvariant(scheduler, ledger, 0)).toBe(0);
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBe(1);
    expect(activeRunIds(scheduler)).toHaveLength(0);
    expect(() => ledger.assertWithinBudget()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. 提交后失败 + 重放
// ---------------------------------------------------------------------------

describe('G03 / R44.6 — 提交后失败与重放', () => {
  it('afterCommitBeforePublish 失败、多次 publishPendingEvents() 重放 ⇒ 计数恰好一次', () => {
    let failAfterCommit = false;
    const store = createMemoryStore({
      faults: {
        afterCommitBeforePublish(): void {
          if (failAfterCommit) {
            throw new Error('注入：提交后、投递前失败');
          }
        },
      },
    });
    const { ledger, scheduler } = startScenario({
      limits: { runs: 4, diagnoses: 1, time: 10000 },
      store,
    });

    // 第 1 轮：用掉唯一的诊断额度（真实诊断，消费 1）
    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(1);
    const first = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [selfDependency(requestId('r-1'))],
    });
    expect(first.stagnation?.diagnosis.verdict).toBe('cycle_detected');
    expect(expectDiagnosisInvariant(scheduler, ledger, 1)).toBe(1);

    // 第 2 轮：已耗尽 ⇒ 耗尽报告；提交后失败（已提交、事件待投递）
    expect(scheduler.onMessage(workRequest(2)).result).toBe('accepted');
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(1);
    const runId = soleActiveRunId(scheduler);

    failAfterCommit = true;
    expect(() =>
      scheduler.finishRun({
        run_id: runId,
        publications: [selfDependency(requestId('r-2'))],
      }),
    ).toThrow();
    failAfterCommit = false;

    // 多次重放：已提交事实只补一次账，事件不重复
    scheduler.publishPendingEvents();
    scheduler.publishPendingEvents();
    scheduler.publishPendingEvents();

    // 耗尽报告恰好一份（重放不重复计数），且不消费额度
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBe(1);
    expect(kindCount(scheduler, 'diagnosis_performed')).toBe(1);
    expect(diagnosisCountOf(scheduler)).toBe(1);
    expect(ledger.used('diagnoses')).toBe(1);
    expect(expectDiagnosisInvariant(scheduler, ledger, 1)).toBe(1);
    expect(activeRunIds(scheduler)).toHaveLength(0);
    expect(() => ledger.assertWithinBudget()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. F03 不回归（R44.5）
// ---------------------------------------------------------------------------

describe('G03 / R44.5 — F03 不回归', () => {
  it('正常依赖解除（A 等 B、B 完成 ⇒ A 自然可运行并完成）在诊断预算已耗尽时仍然工作', () => {
    const instA = instanceId('A');
    const instB = instanceId('B');
    const { ledger, scheduler } = startScenario({
      limits: { runs: 6, diagnoses: 0, time: 10000 },
    });
    registerInstance(scheduler.store, instA);
    registerInstance(scheduler.store, instB);

    // A 的工作等 B 的工作；B 无依赖
    expect(scheduler.onMessage(workRequest(1, { recipient_instance_id: instA })).result).toBe(
      'accepted',
    );
    expect(scheduler.onMessage(workRequest(2, { recipient_instance_id: instB })).result).toBe(
      'accepted',
    );

    // 轮次 1：A 报告"等 B"——D=0 ⇒ 许可不足，走耗尽报告（不消费额度）
    expect(scheduler.advanceOnce({ instance_id: instA }).startedRuns).toBe(1);
    const a1 = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-1'),
          dependency_refs: [{ request_id: requestId('r-2') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等待 r-2 的结果' },
        },
      ],
    });
    expect(a1.accepted).toBe(true);
    expect(a1.stagnation?.diagnosis.verdict).toBe('budget_exhausted');
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBeGreaterThanOrEqual(1);
    expect(workItemStatus(scheduler, requestId('r-1'))).toBe('waiting_dependency');
    expect(scheduler.hasRunnableInput(instA)).toBe(false);

    // 轮次 2：B 无依赖 ⇒ 直接完成；`finish_run` 事务内自动解除 A 的等待
    expect(scheduler.advanceOnce({ instance_id: instB }).startedRuns).toBe(1);
    const b1 = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [completed(requestId('r-2'))],
    });
    expect(b1.accepted).toBe(true);
    expect(workItemStatus(scheduler, requestId('r-2'))).toBe('completed');

    // F03 的核心观测点：B 的轮次一结束，A 的等待项已可运行（解除独立于诊断预算，R44.5）
    expect(workItemStatus(scheduler, requestId('r-1'))).toBe('processing');
    expect(scheduler.hasRunnableInput(instA)).toBe(true);
    expect(deliveryKindCount(scheduler, 'dependency_resolved')).toBeGreaterThanOrEqual(1);

    // 轮次 3：A 处理已解除的依赖并出终态
    expect(scheduler.advanceOnce({ instance_id: instA }).startedRuns).toBe(1);
    const a2 = scheduler.finishRun({
      run_id: soleActiveRunId(scheduler),
      publications: [completed(requestId('r-1'))],
    });
    expect(a2.accepted).toBe(true);
    expect(workItemStatus(scheduler, requestId('r-1'))).toBe('completed');

    // 依赖解除全程没有消费任何诊断额度
    expect(diagnosisCountOf(scheduler)).toBe(0);
    expect(ledger.used('diagnoses')).toBe(0);
    expect(expectDiagnosisInvariant(scheduler, ledger, 0)).toBe(0);
    expect(() => ledger.assertWithinBudget()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. 对照（防假通过）：预算充裕时真实诊断路径逐位一致
// ---------------------------------------------------------------------------

describe('G03 / R44.4 — 对照（防假通过）', () => {
  it('D = 4 预算充裕：该报告时照报（cycle_detected），不为"不超限"而停止报告', () => {
    const { ledger, scheduler } = startScenario({
      limits: { runs: 8, diagnoses: 4, time: 10000 },
    });

    const observed: Array<{
      readonly run: number;
      readonly verdict: string | null | undefined;
      readonly count: number;
      readonly usage: number;
    }> = [];

    for (let n = 1; n <= 5; n += 1) {
      expect(scheduler.onMessage(workRequest(n)).result).toBe('accepted');
      const step = scheduler.advanceOnce({ instance_id: INSTANCE_C });
      expect(step.startedRuns).toBe(1);

      const out = scheduler.finishRun({
        run_id: soleActiveRunId(scheduler),
        publications: [selfDependency(requestId(`r-${n}`))],
      });
      expect(out.accepted).toBe(true);

      observed.push({
        run: n,
        verdict: out.stagnation?.diagnosis.verdict,
        count: diagnosisCountOf(scheduler),
        usage: ledger.used('diagnoses'),
      });
    }

    // 前 4 轮：预算充裕 ⇒ 照旧做真实诊断（cycle_detected），逐轮 +1 直到恰好用满 D_max
    // 第 5 轮：许可不足 ⇒ 耗尽报告（不消费额度），计数停在上限 4
    expect(observed).toEqual([
      { run: 1, verdict: 'cycle_detected', count: 1, usage: 1 },
      { run: 2, verdict: 'cycle_detected', count: 2, usage: 2 },
      { run: 3, verdict: 'cycle_detected', count: 3, usage: 3 },
      { run: 4, verdict: 'cycle_detected', count: 4, usage: 4 },
      { run: 5, verdict: 'budget_exhausted', count: 4, usage: 4 },
    ]);

    // 前 4 轮照报（环被落地为 failed），第 5 轮不落地停止计划
    expect(workItemStatus(scheduler, requestId('r-1'))).toBe('failed');
    expect(workItemStatus(scheduler, requestId('r-4'))).toBe('failed');
    expect(workItemStatus(scheduler, requestId('r-5'))).toBe('waiting_dependency');

    expect(kindCount(scheduler, 'diagnosis_performed')).toBe(4);
    expect(kindCount(scheduler, 'diagnosis_budget_exhausted')).toBe(1);
    expect(expectDiagnosisInvariant(scheduler, ledger, 4)).toBe(4);
    expect(() => ledger.assertWithinBudget()).not.toThrow();
  });
});
