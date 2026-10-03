/**
 * A05 — 循环依赖的有限诊断与停止（+ A05-L 无环对照 + A05-M 多依赖对照）【归属 D09】
 *
 * 冻结点标识：取自**单一来源** `tests/acceptance/freeze-identity.ts`，值在
 * `docs/other/evidence/D11/freeze-identity.json`（R24 / R32.1）。
 *
 * 对应：任务书 §19 A05、§9.4、§10；验收规格 §4（A05 / A05-L）；合同 v1.2
 * （R8/R17/R19/R22/R25/R26 + **R33 取消 / R34 硬预算 / R37 作用域与幂等**）。
 *
 * ## 本次重写（v1.2 修复批）改掉了什么
 *
 * 1. **夹具不再代办内核步骤**（指导 F03）：A05-L 原先由夹具自己
 *    `planDependencyResolution()` → `tx.putWorkItem()` → `wakeOnDependencyResolved()`，
 *    于是"内核自动衔接"从未被验证。现在只经「投递 → start/finish → 推进」——
 *    B 完成后 A 由 `finish_run` 的事务内解除段落自动进入可运行状态。
 * 2. **夹具不再替内核补账**（合同 R34.3 / 修复 F06）：`syncRunsFromEvents` 已删除。
 *    预算用量是**已提交事件的幂等投影**，只读 `scheduler.budgetUsage()` / 台账 `used()`。
 * 3. **A05-B 的超额断言翻转**（修复 F08 / 合同 R34.1）：旧断言把"`runs = 1` 实际跑了 2 轮"
 *    当作通过（`R_max + 1` 口径）。新口径是**启动前闸门**：`runs = 1` 只启动 1 轮，
 *    第 2 次推进即被 `budget_exhausted` 拒绝；`runs = 0` 启动 0 轮。
 *
 * 断言纪律（逐条落实在下面的注释里）：
 * - R17：计数类断言用**等号**，且先断言事件流非空；
 * - R22：先断言夹具确实产生了数据，再断言分布；
 * - R19：同时取事件侧与快照侧（各自唯一权威实现），`mergeSchedulingCounters` 合并；
 * - R25.1：A05 的「报告」落点断言为 **`failed` + `failure_reason`**（二选一，不写"两种都算过"）；
 * - R25.2：I-A05-4 必须用 `planCycleStop({complete_cycles_defect:true})`（绕过状态机）；
 * - R26.2：`peak_queued_flags` 是**跨实例**口径，A05 两实例 ⇒ 断言**等号 2**；
 * - R34.1 / R34.5：`runs` 的权威值 = `scheduler.budgetUsage()`（投影台账），
 *   与事件侧 `summarizeKernelEvents().run_count` 相等（观测口径 R4）。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asLogicalTime,
  asRevision,
  createWorkItem,
  summarizeSnapshotCounters,
  type BlockerKind,
  type EventCounters,
  type Revision,
  type SchedulingCounters,
  type SnapshotCounters,
  type WorkItem,
  type WorkItemStatus,
} from '../../../src/protocol/index.js';
import {
  RecoveryLedger,
  diagnoseStagnation,
  evaluateBudget,
  findFalselyCompletedByCycle,
  fingerprintOfBlockedItems,
  planCycleStop,
  resolutionInputRefId,
} from '../../../src/dependency/index.js';
import { evaluateWorkItemTransition } from '../../../src/workledger/index.js';
import { ActivitySnapshotSampler } from '../../../src/fake/index.js';
import { writeEvidenceArtifacts } from '../freeze-identity.js';
import {
  FREEZE_1_SOURCE_DIGEST,
  INSTANCE_A,
  INSTANCE_B,
  INSTANCE_C,
  R_A,
  R_B,
  R_LA,
  R_LB,
  R_MA,
  R_MB,
  R_MC,
  REVISION,
  SENDER_S1,
  SENDER_S2,
  TASK_ID,
  budgetUsageOf,
  buildA05Harness,
  countDeliveryEvents,
  countKernelEvents,
  deliverWorkRequest,
  instanceActivity,
  readReceiptCount,
  registerInstance,
  registerTask,
  workItemOf,
  type A05Budget,
  type A05Harness,
} from './scenario-support.js';

/** Q9-a 的场景预算（**执行前登记**；必须在脚本头给出，禁止失败后调大）。 */
const MAIN_BUDGET: A05Budget = Object.freeze({ runs: 8, diagnoses: 4, time: 10_000 });
/**
 * A05-B 的紧预算：`runs = 1`。
 *
 * **口径更正（修复 F08 / 合同 R34.1）**：上限是**启动前闸门**，
 * `used + 1 > limit ⇒ 拒绝`。因此本预算下**只允许启动 1 轮**，
 * 第 2 次推进必须被 `budget_exhausted` 拒绝——**不得**再用"实际跑 2 轮"来证明"达到预算"。
 */
const TIGHT_RUNS_BUDGET: A05Budget = Object.freeze({ runs: 1, diagnoses: 4, time: 10_000 });
/** A05-B 的零轮对照：`runs = 0` ⇒ 一轮都不许启动。 */
const ZERO_RUNS_BUDGET: A05Budget = Object.freeze({ runs: 0, diagnoses: 4, time: 10_000 });

interface WaitReasonRow {
  readonly request_id: string;
  readonly status: string;
  readonly wait_class: string;
  readonly dependency_ids: readonly string[];
  readonly blocker_detail: string | null;
}

interface WorkItemRow {
  readonly request_id: string;
  readonly status: WorkItemStatus;
  readonly owner: string;
  readonly failure_reason: string | null;
  readonly blocker_kind: BlockerKind | null;
  readonly result_refs: readonly string[];
  readonly read_in_snapshot: boolean;
}

interface WindowRow {
  readonly active_runs_before: number;
  readonly active_runs_after: number;
  readonly queued_flags_before: number;
  readonly queued_flags_after: number;
  readonly flat: boolean;
  readonly run_count_before: number;
  readonly run_count_after: number;
}

interface CycleObservation {
  readonly label: string;
  readonly registration: {
    readonly limits: A05Budget;
    readonly registered_at: number;
    readonly registered_before_any_run: boolean;
  };
  readonly delivery_results: readonly string[];
  readonly produced_items: number;
  readonly deliveries_before_any_advance: number;
  readonly run_instances: readonly string[];
  readonly frozen_request_ids_first: readonly string[];
  readonly run_count: number;
  readonly event_counters: EventCounters;
  readonly snapshot_counters: SnapshotCounters;
  readonly merged_counters: SchedulingCounters;
  readonly distribution: Readonly<Record<WorkItemStatus, number>>;
  readonly budget_usage: { readonly runs: number; readonly diagnoses: number; readonly time: number };
  readonly clock_total_advanced: number;
  readonly diagnosis_events: number;
  readonly recovery_events: number;
  readonly dependency_resolved_events: number;
  readonly queue_enqueued_events: number;
  readonly run_started_events: number;
  readonly finish2_verdict: string | null;
  readonly finish2_disposition: string | null;
  readonly finish2_stopped: boolean | null;
  readonly finish2_produces_new_runnable_input: boolean | null;
  readonly finish2_wait_reasons: readonly WaitReasonRow[];
  readonly releasable_instance_ids: readonly string[];
  readonly cycle_stop_mode: string | null;
  readonly cycle_stopped_request_ids: readonly string[];
  readonly work_items: readonly WorkItemRow[];
  readonly falsely_completed_by_cycle: readonly string[];
  readonly empty_advances: readonly number[];
  readonly has_runnable_input_after: readonly boolean[];
  readonly window_after_first_run: {
    readonly active_runs: number;
    readonly queued_flags: number;
  };
  readonly window: WindowRow;
  readonly instances_final: readonly {
    readonly id: string;
    readonly activity: string;
    readonly active_run_id: string | null;
    readonly queued_flag: boolean;
  }[];
}

function countKinds(events: readonly { readonly kind: string }[], kind: string): number {
  return events.filter((event) => event.kind === kind).length;
}

/**
 * R7 的**可执行**形式：把"关键断言的朴素写法"跑一遍，必须抛错。
 *
 * 这样"缺陷真能击穿断言"不是靠人读注释相信，而是由测试执行证明：
 * 若某条注入实际是空操作（恒真），本函数会红。
 */
function expectAssertionFails(naiveAssertion: () => void): void {
  expect(naiveAssertion).toThrow();
}

/** 从只读快照取当前活动轮次（恰好一个；多于/少于一个是夹具配置错误）。 */
function activeRunOf(h: A05Harness, label: string) {
  const running = h.scheduler.snapshot().runs.filter((run) => run.status === 'running');
  const first = running[0];
  if (running.length !== 1 || first === undefined) {
    throw new Error(`${label}：期望恰有 1 个活动轮次，实际 ${String(running.length)}`);
  }
  return first;
}

/**
 * 跑一次「A 等 B、B 等 A」的循环依赖场景，直到第 2 个轮次结束（停滞检查点在此触发）。
 *
 * 事件序列（验收规格 4.3）：投递两条 → 显式推进调度 → 逐轮放行 → 采样 → 收敛判定。
 *
 * **夹具不补账、不代办解除**：预算用量取自 `scheduler.budgetUsage()`（已提交事件投影），
 * 依赖解除（若有）由内核在 `finish_run` 内自动落地。
 */
async function runA05Cycle(options: {
  readonly label: string;
  readonly budget: A05Budget;
  readonly defects?: {
    readonly ignore_budget?: boolean;
    readonly ignore_task_revision_in_fingerprint?: boolean;
    readonly holds_slot_while_waiting?: boolean;
  };
  readonly cycle_stop_mode?: 'report_failed' | 'pause_marker';
}): Promise<CycleObservation> {
  const h = buildA05Harness({
    budget: options.budget,
    ...(options.defects === undefined ? {} : { defects: options.defects }),
    ...(options.cycle_stop_mode === undefined ? {} : { cycle_stop_mode: options.cycle_stop_mode }),
  });
  registerTask(h);
  registerInstance(h, INSTANCE_A); // 先注册 = advanceOnce 的候选更靠前
  registerInstance(h, INSTANCE_B);

  const sampler = new ActivitySnapshotSampler();

  const d1 = deliverWorkRequest(h, {
    message_id: 'm-a05-01',
    request_id: R_A,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jA：依赖 jB 的结果',
  });
  const d2 = deliverWorkRequest(h, {
    message_id: 'm-a05-02',
    request_id: R_B,
    recipient: INSTANCE_B,
    sender: SENDER_S2,
    content: '工作 jB：依赖 jA 的结果',
  });

  // R10：投递登记**不触发推进**（全部投递早于任何一次冻结）
  h.seam.assertAllDeliveriesBefore(0);
  const deliveriesBeforeAnyAdvance = h.seam.deliveriesBeforeAdvance().length;

  // 轮次 1：I-A 读入后转入「等待依赖」
  h.clock.advance(1, 'A05-R1');
  await h.seam.advanceOnce('A05-R1');
  const first = activeRunOf(h, 'A05 第 1 次推进');
  const finish1 = h.scheduler.finishRun({
    run_id: first.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_A,
        dependency_refs: [{ request_id: R_B }],
        blocker_reason: {
          kind: 'waiting_dependency',
          detail: '需要 r-a05-B 的结果才能继续（在等 r-a05-B）',
        },
      },
    ],
  });
  if (finish1.accepted !== true) {
    throw new Error(`轮次 1 的发布应被接受，实际 ${String(finish1.rejection_reason)}`);
  }

  // 等待窗口 ①：I-A 已让出执行槽（此后不做任何放行，直到轮次 2）
  const windowAfterFirst = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());

  // 轮次 2：I-B 读入后也转入「等待依赖」⇒ 形成二元环
  h.clock.advance(1, 'A05-R2');
  await h.seam.advanceOnce('A05-R2');
  const second = activeRunOf(h, 'A05 第 2 次推进');

  const finish2 = h.scheduler.finishRun({
    run_id: second.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_B,
        dependency_refs: [{ request_id: R_A }],
        blocker_reason: {
          kind: 'waiting_dependency',
          detail: '需要 r-a05-A 的结果才能继续（在等 r-a05-A）',
        },
      },
    ],
  });
  if (finish2.accepted !== true) {
    throw new Error(`轮次 2 的发布应被接受，实际 ${String(finish2.rejection_reason)}`);
  }

  // 等待窗口 ②（收敛后的稳定窗口）：不做任何放行，空推进若干次
  const sWindowOpen = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());
  const runCountBeforeWindow = h.scheduler.eventCounters().run_count;
  const emptyRecords = await h.seam.advanceTimes(3, 'A05-waiting-window');
  const sWindowClose = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());
  const runCountAfterWindow = h.scheduler.eventCounters().run_count;

  const items = h.scheduler.snapshot().work_items;
  const plan = planCycleStop(items, { at: h.clock.now() });

  // R26.3：time 维度由 D06 的 chargeTimeFrom(clock) 记账
  h.ledger.chargeTimeFrom(h.clock);

  const eventCounters = h.scheduler.eventCounters(); // 事件侧（唯一权威实现）
  const snapshot = h.scheduler.snapshot();
  const snapshotCounters = summarizeSnapshotCounters(snapshot); // 快照侧（唯一权威实现）
  const merged = h.scheduler.summarize(); // R19 合并
  const stagnation = finish2.stagnation;

  return {
    label: options.label,
    registration: {
      limits: options.budget,
      registered_at: Number(h.registration.registered_at),
      registered_before_any_run: h.registration.registered_before_any_run,
    },
    delivery_results: [d1.result, d2.result],
    produced_items: items.length,
    deliveries_before_any_advance: deliveriesBeforeAnyAdvance,
    run_instances: [String(first.instance_id), String(second.instance_id)],
    frozen_request_ids_first: first.frozen_request_ids.map(String),
    run_count: eventCounters.run_count,
    event_counters: eventCounters,
    snapshot_counters: snapshotCounters,
    merged_counters: merged,
    distribution: snapshotCounters.work_item_status_distribution,
    // R34.3 / R34.5：预算用量 = 已提交事件的幂等投影（内核补账，**夹具不补**）
    budget_usage: budgetUsageOf(h.scheduler),
    clock_total_advanced: h.clock.totalAdvanced,
    diagnosis_events: eventCounters.diagnosis_count,
    recovery_events: countKinds(snapshot.kernel_events, 'recovery_performed'),
    dependency_resolved_events: countDeliveryEvents(h.scheduler, 'dependency_resolved'),
    queue_enqueued_events: countKinds(snapshot.kernel_events, 'delegation_queue_enqueued'),
    run_started_events: countKinds(snapshot.kernel_events, 'run_started'),
    finish2_verdict: stagnation === null ? null : stagnation.diagnosis.verdict,
    finish2_disposition: stagnation === null ? null : stagnation.diagnosis.disposition,
    finish2_stopped: stagnation === null ? null : stagnation.stopped,
    finish2_produces_new_runnable_input:
      stagnation === null ? null : stagnation.diagnosis.produces_new_runnable_input,
    finish2_wait_reasons:
      stagnation === null
        ? []
        : stagnation.diagnosis.wait_reasons.map((row) => ({
            request_id: String(row.request_id),
            status: row.status,
            wait_class: row.wait_class,
            dependency_ids: [...row.dependency_ids],
            blocker_detail: row.blocker_detail,
          })),
    releasable_instance_ids: stagnation === null ? [] : stagnation.releasable_instance_ids.map(String),
    cycle_stop_mode: stagnation === null || stagnation.cycle_stop === null ? null : stagnation.cycle_stop.mode,
    cycle_stopped_request_ids: stagnation === null ? [] : stagnation.cycle_stopped_request_ids.map(String),
    work_items: items.map((item) => ({
      request_id: String(item.request_id),
      status: item.status,
      owner: String(item.owner_instance_id),
      failure_reason: item.failure_reason,
      blocker_kind: item.blocker_reason === null ? null : item.blocker_reason.kind,
      result_refs: item.result_refs.map(String),
      read_in_snapshot: item.included_in_snapshot,
    })),
    falsely_completed_by_cycle: findFalselyCompletedByCycle(plan, items).map(String),
    empty_advances: emptyRecords.map((record) => record.startedRuns),
    has_runnable_input_after: [
      h.scheduler.hasRunnableInput(INSTANCE_A),
      h.scheduler.hasRunnableInput(INSTANCE_B),
    ],
    window_after_first_run: {
      active_runs: windowAfterFirst.active_runs,
      queued_flags: windowAfterFirst.queued_flags,
    },
    window: {
      active_runs_before: sWindowOpen.active_runs,
      active_runs_after: sWindowClose.active_runs,
      queued_flags_before: sWindowOpen.queued_flags,
      queued_flags_after: sWindowClose.queued_flags,
      flat: sampler.isFlatBetween(sWindowOpen.index, sWindowClose.index),
      run_count_before: runCountBeforeWindow,
      run_count_after: runCountAfterWindow,
    },
    instances_final: [INSTANCE_A, INSTANCE_B].map((id) => ({
      id: String(id),
      ...instanceActivity(h.scheduler, id),
    })),
  };
}

/** 直接造两个处于环上的等待项（受控缺陷注入用；与 D05 单测同款素材）。 */
function buildCycleItems(revision: Revision): readonly WorkItem[] {
  return [
    createWorkItem({
      request_id: R_A,
      owner_instance_id: INSTANCE_A,
      created_at: asLogicalTime(0),
      task_id: TASK_ID,
      task_revision: revision,
      status: 'waiting_dependency',
      dependency_refs: [{ request_id: R_B }],
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 r-a05-B' },
    }),
    createWorkItem({
      request_id: R_B,
      owner_instance_id: INSTANCE_B,
      created_at: asLogicalTime(0),
      task_id: TASK_ID,
      task_revision: revision,
      status: 'waiting_dependency',
      dependency_refs: [{ request_id: R_A }],
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 r-a05-A' },
    }),
  ];
}

interface A05LResult {
  readonly stagnation_enabled: boolean;
  readonly budget_usage: { readonly runs: number; readonly diagnoses: number; readonly time: number } | null;
  readonly run_count: number;
  readonly run_instances: readonly string[];
  readonly delivery_results: readonly string[];
  readonly diagnosis_events: number;
  readonly recovery_events: number;
  readonly dependency_resolved_events: number;
  readonly checkpoint_verdicts: readonly (string | null)[];
  readonly checkpoint_cycle_counts: readonly number[];
  readonly completed: readonly { readonly request_id: string; readonly result_refs: readonly string[] }[];
  readonly distribution: Readonly<Record<WorkItemStatus, number>>;
  readonly produced_items: number;
  readonly window_flat: boolean;
  readonly window_active_runs: readonly number[];
  readonly i_a_runnable_before_result: boolean;
  /** 轮次 2（B 完成）之后立刻采样：**内核**是否已自动把 A 的等待项转入可运行。 */
  readonly kernel_resolution: {
    readonly la_status: string;
    readonly la_dependency_resolved_events: number;
    readonly a_has_runnable_input: boolean;
  };
  readonly frozen_actionable_refs: readonly string[];
  readonly empty_advances_after: readonly number[];
  readonly run_started_events: number;
}

/**
 * A05-L 对照：无环依赖（A 等 B、B 无依赖）⇒ 正常等待不被判为循环，结果到达后有限轮次内完成。
 *
 * 目的（R8）：证明「有限诊断后停止」不是靠把**正常等待**也误判为循环换来的。
 *
 * **本场景不再由夹具代办依赖解除**（指导 F03 的硬要求）：夹具只投递、放行 start/finish 与推进。
 * B 完成时 `finish_run` 的事务内段落自动算出解除计划并唤醒 A；夹具随后只做"下一轮推进"。
 *
 * `without_stagnation`（合同 R37.4）：**不登记 `stagnation`** 的对照模式——
 * 正常依赖解除**不依赖是否开启停滞诊断预算**，必须照样工作。
 */
async function runA05L(options: { readonly withoutStagnation?: boolean } = {}): Promise<A05LResult> {
  const h = buildA05Harness({
    budget: MAIN_BUDGET,
    ...(options.withoutStagnation === true ? { without_stagnation: true } : {}),
  });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  registerInstance(h, INSTANCE_B);
  const sampler = new ActivitySnapshotSampler();

  const d1 = deliverWorkRequest(h, {
    message_id: 'm-a05-l1',
    request_id: R_LA,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jLA：依赖 jLB 的结果',
  });
  const d2 = deliverWorkRequest(h, {
    message_id: 'm-a05-l2',
    request_id: R_LB,
    recipient: INSTANCE_B,
    sender: SENDER_S2,
    content: '工作 jLB：无依赖，直接产出结果',
  });
  h.seam.assertAllDeliveriesBefore(0);

  const verdicts: (string | null)[] = [];
  const cycleCounts: number[] = [];
  const record = (outcome: { readonly stagnation: { readonly diagnosis: { readonly verdict: string; readonly cycles: readonly unknown[] } } | null }): void => {
    if (outcome.stagnation === null) return;
    verdicts.push(outcome.stagnation.diagnosis.verdict);
    cycleCounts.push(outcome.stagnation.diagnosis.cycles.length);
  };

  // 轮次 1：I-A 报告需要 jLB 的结果（无环 ⇒ 正常等待）
  h.clock.advance(1, 'A05-L-R1');
  await h.seam.advanceOnce('A05-L-R1');
  const run1 = activeRunOf(h, 'A05-L 第 1 次推进');
  const f1 = h.scheduler.finishRun({
    run_id: run1.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_LA,
        dependency_refs: [{ request_id: R_LB }],
        blocker_reason: { kind: 'waiting_dependency', detail: '需要 r-a05-LB 的结果' },
      },
    ],
  });
  record(f1);

  // A05-L-07：jLB 结果到达**之前**，I-A 不得被反复唤醒
  const iARunnableBeforeResult = h.scheduler.hasRunnableInput(INSTANCE_A);

  // 轮次 2：I-B 无依赖 ⇒ 直接产出 jLB 的结果。
  // **不必由夹具代办任何解除步骤**：本轮的 `finish_run` 会自行算出解除计划、转工作项并唤醒 I-A。
  h.clock.advance(1, 'A05-L-R2');
  await h.seam.advanceOnce('A05-L-R2');
  const run2 = activeRunOf(h, 'A05-L 第 2 次推进');
  const f2 = h.scheduler.finishRun({
    run_id: run2.run_id,
    publications: [
      { kind: 'completed', request_id: R_LB, result_refs: [asArtifactRef('r-a05-LB#result')] },
    ],
  });
  record(f2);

  // **内核自动衔接的采样点**（F03 的核心断言）：B 的轮次一结束，A 的等待项就该已可运行。
  const kernelResolution = {
    la_status: String(workItemOf(h.scheduler, R_LA).status),
    la_dependency_resolved_events: countDeliveryEvents(h.scheduler, 'dependency_resolved'),
    a_has_runnable_input: h.scheduler.hasRunnableInput(INSTANCE_A),
  };

  const windowAfterB = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());

  // 轮次 3：I-A 处理已满足的依赖并出终态（读入的是**解除输入**，不是新消息——Q5-c）
  h.clock.advance(1, 'A05-L-R3');
  await h.seam.advanceOnce('A05-L-R3');
  const run3 = activeRunOf(h, 'A05-L 第 3 次推进');
  const f3 = h.scheduler.finishRun({
    run_id: run3.run_id,
    publications: [
      { kind: 'completed', request_id: R_LA, result_refs: [asArtifactRef('r-a05-LA#result')] },
    ],
  });
  record(f3);

  const windowAfterA = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());
  const emptyRecords = await h.seam.advanceTimes(2, 'A05-L-waiting-window');

  const snapshot = h.scheduler.snapshot();
  const eventCounters = h.scheduler.eventCounters();
  const completedItems = snapshot.work_items
    .filter((item) => item.status === 'completed')
    .map((item) => ({ request_id: String(item.request_id), result_refs: item.result_refs.map(String) }));

  return {
    stagnation_enabled: options.withoutStagnation !== true,
    budget_usage: h.scheduler.budgetUsage() === null ? null : budgetUsageOf(h.scheduler),
    run_count: eventCounters.run_count,
    run_instances: [String(run1.instance_id), String(run2.instance_id), String(run3.instance_id)],
    delivery_results: [d1.result, d2.result],
    diagnosis_events: eventCounters.diagnosis_count,
    recovery_events: countKinds(snapshot.kernel_events, 'recovery_performed'),
    dependency_resolved_events: countDeliveryEvents(h.scheduler, 'dependency_resolved'),
    checkpoint_verdicts: verdicts,
    checkpoint_cycle_counts: cycleCounts,
    completed: completedItems,
    distribution: summarizeSnapshotCounters(snapshot).work_item_status_distribution,
    produced_items: snapshot.work_items.length,
    window_flat: sampler.isFlatBetween(windowAfterB.index, windowAfterA.index),
    window_active_runs: [windowAfterB.active_runs, windowAfterA.active_runs],
    i_a_runnable_before_result: iARunnableBeforeResult,
    kernel_resolution: kernelResolution,
    frozen_actionable_refs: [...run3.frozen_actionable_input_refs],
    empty_advances_after: emptyRecords.map((row) => row.startedRuns),
    run_started_events: countKinds(snapshot.kernel_events, 'run_started'),
  };
}

interface MultiDependencyResult {
  readonly run_count: number;
  readonly run_instances: readonly string[];
  readonly ma_status_after_b_only: string;
  readonly a_runnable_after_b_only: boolean;
  readonly dependency_resolved_events_after_b_only: number;
  readonly ma_status_after_both: string;
  readonly a_runnable_after_both: boolean;
  readonly dependency_resolved_events_final: number;
  readonly final_completed: readonly string[];
  readonly distribution: Readonly<Record<WorkItemStatus, number>>;
}

/**
 * A05-M 对照（F03 的反向约束）：A **同时**依赖 B 与 C —— 只完成 B 时**不得唤醒** A。
 *
 * 这是"依赖解除不得提前/假解除"的机器形式：解除条件是**全部**依赖满足，而不是"有一项满足了"。
 */
async function runA05MultiDependency(): Promise<MultiDependencyResult> {
  const h = buildA05Harness({ budget: MAIN_BUDGET });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  registerInstance(h, INSTANCE_B);
  registerInstance(h, INSTANCE_C);

  const deliver = (messageId: string, requestId: typeof R_MA, recipient: typeof INSTANCE_A, sender: typeof SENDER_S1): void => {
    deliverWorkRequest(h, {
      message_id: messageId,
      request_id: requestId,
      recipient,
      sender,
      content: `工作 ${requestId}`,
    });
  };
  deliver('m-a05-m1', R_MA, INSTANCE_A, SENDER_S1);
  deliver('m-a05-m2', R_MB, INSTANCE_B, SENDER_S2);
  deliver('m-a05-m3', R_MC, INSTANCE_C, SENDER_S1);

  h.clock.advance(1, 'A05-M-R1');
  await h.seam.advanceOnce('A05-M-R1');
  const run1 = activeRunOf(h, 'A05-M 第 1 次推进');
  h.scheduler.finishRun({
    run_id: run1.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_MA,
        dependency_refs: [{ request_id: R_MB }, { request_id: R_MC }],
        blocker_reason: { kind: 'waiting_dependency', detail: '同时需要 r-a05-MB 与 r-a05-MC 的结果' },
      },
    ],
  });

  // 只完成 B：解除条件**未**全部满足 ⇒ 不得唤醒 A
  h.clock.advance(1, 'A05-M-R2');
  await h.seam.advanceOnce('A05-M-R2');
  const run2 = activeRunOf(h, 'A05-M 第 2 次推进');
  h.scheduler.finishRun({
    run_id: run2.run_id,
    publications: [
      { kind: 'completed', request_id: R_MB, result_refs: [asArtifactRef('r-a05-MB#result')] },
    ],
  });
  const maAfterB = String(workItemOf(h.scheduler, R_MA).status);
  const aRunnableAfterB = h.scheduler.hasRunnableInput(INSTANCE_A);
  const resolvedAfterB = countDeliveryEvents(h.scheduler, 'dependency_resolved');

  // 再完成 C：此时全部满足 ⇒ 内核自动解除并唤醒 A
  h.clock.advance(1, 'A05-M-R3');
  await h.seam.advanceOnce('A05-M-R3');
  const run3 = activeRunOf(h, 'A05-M 第 3 次推进');
  h.scheduler.finishRun({
    run_id: run3.run_id,
    publications: [
      { kind: 'completed', request_id: R_MC, result_refs: [asArtifactRef('r-a05-MC#result')] },
    ],
  });
  const maAfterBoth = String(workItemOf(h.scheduler, R_MA).status);
  const aRunnableAfterBoth = h.scheduler.hasRunnableInput(INSTANCE_A);

  // 轮次 4：A 处理解除输入并出终态
  h.clock.advance(1, 'A05-M-R4');
  await h.seam.advanceOnce('A05-M-R4');
  const run4 = activeRunOf(h, 'A05-M 第 4 次推进');
  h.scheduler.finishRun({
    run_id: run4.run_id,
    publications: [
      { kind: 'completed', request_id: R_MA, result_refs: [asArtifactRef('r-a05-MA#result')] },
    ],
  });

  const snapshot = h.scheduler.snapshot();
  return {
    run_count: h.scheduler.eventCounters().run_count,
    run_instances: [run1, run2, run3, run4].map((run) => String(run.instance_id)),
    ma_status_after_b_only: maAfterB,
    a_runnable_after_b_only: aRunnableAfterB,
    dependency_resolved_events_after_b_only: resolvedAfterB,
    ma_status_after_both: maAfterBoth,
    a_runnable_after_both: aRunnableAfterBoth,
    dependency_resolved_events_final: countDeliveryEvents(h.scheduler, 'dependency_resolved'),
    final_completed: snapshot.work_items
      .filter((item) => item.status === 'completed')
      .map((item) => String(item.request_id))
      .sort(),
    distribution: summarizeSnapshotCounters(snapshot).work_item_status_distribution,
  };
}

interface FailedDependencyResult {
  readonly run_count: number;
  readonly waiting_status: string;
  readonly waiting_dependency_ids: readonly string[];
  readonly dependency_resolved_events: number;
  readonly owner_runnable_after: boolean;
  readonly diagnosis_events: number;
  readonly unsatisfiable_request_ids: readonly string[];
  readonly stalled: boolean | null;
}

/**
 * A05-F 对照（F03 的反向约束）：依赖目标**失败收场** ⇒ 等待项**不得**被"假解除"。
 *
 * `planDependencyResolution` 只解除"依赖已 satisfied"的项；目标 `failed` 属 `unsatisfiable`，
 * 应当保持 `waiting_dependency`（并如实报告停滞），而不是被错当成可推进。
 */
async function runA05FailedDependency(): Promise<FailedDependencyResult> {
  const h = buildA05Harness({ budget: MAIN_BUDGET });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  registerInstance(h, INSTANCE_B);

  deliverWorkRequest(h, {
    message_id: 'm-a05-f1',
    request_id: R_MA,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jMA：依赖 jMB 的结果',
  });
  deliverWorkRequest(h, {
    message_id: 'm-a05-f2',
    request_id: R_MB,
    recipient: INSTANCE_B,
    sender: SENDER_S2,
    content: '工作 jMB：本项将以失败收场',
  });

  h.clock.advance(1, 'A05-F-R1');
  await h.seam.advanceOnce('A05-F-R1');
  const run1 = activeRunOf(h, 'A05-F 第 1 次推进');
  h.scheduler.finishRun({
    run_id: run1.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_MA,
        dependency_refs: [{ request_id: R_MB }],
        blocker_reason: { kind: 'waiting_dependency', detail: '需要 r-a05-MB 的结果' },
      },
    ],
  });

  h.clock.advance(1, 'A05-F-R2');
  await h.seam.advanceOnce('A05-F-R2');
  const run2 = activeRunOf(h, 'A05-F 第 2 次推进');
  const finish2 = h.scheduler.finishRun({
    run_id: run2.run_id,
    publications: [
      {
        kind: 'failed',
        request_id: R_MB,
        failure_reason: '工具调用失败：目标已失败，依赖不可能自行满足',
        blocker_reason: { kind: 'unknown_tool_state', detail: '工具状态未知' },
      },
    ],
  });

  const waiting = workItemOf(h.scheduler, R_MA);
  return {
    run_count: h.scheduler.eventCounters().run_count,
    waiting_status: String(waiting.status),
    waiting_dependency_ids: waiting.dependency_refs.map((ref) => String(ref.request_id)),
    dependency_resolved_events: countDeliveryEvents(h.scheduler, 'dependency_resolved'),
    owner_runnable_after: h.scheduler.hasRunnableInput(INSTANCE_A),
    diagnosis_events: h.scheduler.eventCounters().diagnosis_count,
    unsatisfiable_request_ids:
      finish2.stagnation === null
        ? []
        : finish2.stagnation.diagnosis.unsatisfiable_request_ids.map(String),
    stalled: finish2.stagnation === null ? null : finish2.stagnation.diagnosis.verdict === 'stalled',
  };
}

interface BudgetGateResult {
  readonly budget_runs: number;
  readonly delivery_results: readonly string[];
  readonly first_advance_started: number;
  readonly first_advance_detail: string | null;
  readonly second_advance_started: number;
  readonly second_advance_detail: string | null;
  readonly extra_advances_started: readonly number[];
  readonly run_count: number;
  readonly run_started_events: number;
  readonly run_instances: readonly string[];
  readonly budget_usage_runs: number;
  readonly ledger_runs: number;
  readonly statuses: Readonly<Record<string, string>>;
  readonly a_wait_reason: string | null;
  readonly a_dependency_ids: readonly string[];
  readonly b_pending_before_extra: boolean;
  readonly b_read_receipts: number;
  readonly b_queued_flag: boolean;
  readonly b_runnable_input: boolean;
  readonly extra_delivery_results: readonly string[];
}

/**
 * A05-B / A05-Z：**启动前硬预算**（合同 R34.1 / 修复 F08）。
 *
 * 场景：两条合法投递（I-A 一条、I-B 一条）→ 第 1 次推进 → 第 1 轮以 `waiting_dependency` 收尾 →
 * 第 2 次推进（应当被闸门拦住）→ 再投两条合法消息 → 再推进两次。
 *
 * 观测口径：`scheduler.budgetUsage().runs`（= 已提交事件的投影台账，R34.5），
 * 以及"拒绝时不得新增已读 / 认领 / 消费"的只读证据。
 *
 * `ignoreBudget` 是**受控缺陷注入**（R7 / I-A05-1a）：打开后启动前闸门失效，
 * 用来证明"runs=1 只跑 1 轮"这条断言真会失败。生产路径不传。
 */
async function runA05BudgetGate(budget: A05Budget, ignoreBudget = false): Promise<BudgetGateResult> {
  const h = buildA05Harness({
    budget,
    ...(ignoreBudget ? { defects: { ignore_budget: true } } : {}),
  });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  registerInstance(h, INSTANCE_B);

  const d1 = deliverWorkRequest(h, {
    message_id: 'm-a05-g1',
    request_id: R_A,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jA：依赖 jB 的结果',
  });
  const d2 = deliverWorkRequest(h, {
    message_id: 'm-a05-g2',
    request_id: R_B,
    recipient: INSTANCE_B,
    sender: SENDER_S2,
    content: '工作 jB：无依赖，直接产出结果',
  });

  h.clock.advance(1, 'A05-B-R1');
  const firstStep = await h.seam.advanceOnce('A05-B-R1');

  let runInstances: string[] = [];
  let aWaitReason: string | null = null;
  let aDependencyIds: readonly string[] = [];
  if (firstStep.startedRuns === 1) {
    const run1 = activeRunOf(h, 'A05-B 第 1 次推进');
    runInstances = [String(run1.instance_id)];
    const finish1 = h.scheduler.finishRun({
      run_id: run1.run_id,
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: R_A,
          dependency_refs: [{ request_id: R_B }],
          blocker_reason: { kind: 'waiting_dependency', detail: '需要 r-a05-B 的结果才能继续' },
        },
      ],
    });
    if (finish1.accepted !== true) {
      throw new Error(`首轮发布应被接受，实际 ${String(finish1.rejection_reason)}`);
    }
    const itemA = workItemOf(h.scheduler, R_A);
    aWaitReason = itemA.blocker_reason === null ? null : itemA.blocker_reason.detail;
    aDependencyIds = itemA.dependency_refs.map((ref) => String(ref.request_id));
  }

  const bPendingBeforeExtra = String(workItemOf(h.scheduler, R_B).status);

  // 第 2 次推进：`runs = 1` 时应当被 `budget_exhausted` 拒绝；`runs = 0` 时同样拒绝。
  h.clock.advance(1, 'A05-B-R2');
  const secondStep = await h.seam.advanceOnce('A05-B-R2');

  // 持续投递合法消息也不能超限：再投两条（I-A / I-B 各一条）
  const d3 = deliverWorkRequest(h, {
    message_id: 'm-a05-g3',
    request_id: R_MA,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jMA：预算耗尽后的合法新请求',
  });
  const d4 = deliverWorkRequest(h, {
    message_id: 'm-a05-g4',
    request_id: R_MC,
    recipient: INSTANCE_B,
    sender: SENDER_S2,
    content: '工作 jMC：预算耗尽后的另一条合法新请求',
  });
  h.clock.advance(1, 'A05-B-R3');
  const extraRecords = await h.seam.advanceTimes(2, 'A05-B-R3');

  const usage = budgetUsageOf(h.scheduler);
  return {
    budget_runs: budget.runs,
    delivery_results: [d1.result, d2.result],
    first_advance_started: firstStep.startedRuns,
    first_advance_detail: firstStep.detail ?? null,
    second_advance_started: secondStep.startedRuns,
    second_advance_detail: secondStep.detail ?? null,
    extra_advances_started: extraRecords.map((row) => row.startedRuns),
    run_count: h.scheduler.eventCounters().run_count,
    run_started_events: countKernelEvents(h.scheduler, 'run_started'),
    run_instances: runInstances,
    budget_usage_runs: usage.runs,
    ledger_runs: h.ledger.used('runs'),
    statuses: {
      [String(R_A)]: String(workItemOf(h.scheduler, R_A).status),
      [String(R_B)]: String(workItemOf(h.scheduler, R_B).status),
    },
    a_wait_reason: aWaitReason,
    a_dependency_ids: aDependencyIds,
    b_pending_before_extra: bPendingBeforeExtra === 'pending',
    b_read_receipts: readReceiptCount(h.scheduler, INSTANCE_B),
    b_queued_flag: instanceActivity(h.scheduler, INSTANCE_B).queued_flag,
    b_runnable_input: h.scheduler.hasRunnableInput(INSTANCE_B),
    extra_delivery_results: [d3.result, d4.result],
  };
}

// ---------------------------------------------------------------------------
// F06：预算记账的事务语义（合同 v1.2 R34.3）
// ---------------------------------------------------------------------------

interface BeforeCommitResult {
  readonly fault_message: string | null;
  readonly runs_after_failures: number;
  readonly run_started_events_after_failures: number;
  readonly usage_after_failures: number;
  readonly ledger_after_failures: number;
  readonly recovered_started: boolean;
  readonly recovered_reason: string | null;
  readonly usage_after_recovery: number;
  readonly runs_after_recovery: number;
}

/**
 * 启动路径的提交前失败（F06）：注入 `store.faults.beforeCommit` 连续失败两次，
 * run / 事件 / **账目**一律无新增；移除故障后能正常运行（**不再** `budget_exhausted`）。
 */
function runF06StartBeforeCommit(): BeforeCommitResult {
  const h = buildA05Harness({ budget: TIGHT_RUNS_BUDGET });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  deliverWorkRequest(h, {
    message_id: 'm-f06-s1',
    request_id: R_A,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jA：提交前故障注入的目标',
  });

  const injection = new Error('F06 注入：提交前失败（事务必须整体回滚）');
  h.store.faults.beforeCommit = () => {
    throw injection;
  };
  let faultMessage: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      h.scheduler.startRun({ instance_id: INSTANCE_A });
      faultMessage = null;
    } catch (error) {
      faultMessage = error instanceof Error ? error.message : String(error);
    }
  }
  const afterFailures = {
    runs: h.scheduler.snapshot().runs.length,
    events: countKernelEvents(h.scheduler, 'run_started'),
    usage: budgetUsageOf(h.scheduler).runs,
    ledger: h.ledger.used('runs'),
  };

  // 移除故障：同一实例、同一输入必须能正常启动（旧实现在此处会因"已扣未提交的账"而 budget_exhausted）
  h.store.faults.beforeCommit = undefined;
  const recovered = h.scheduler.startRun({ instance_id: INSTANCE_A });

  return {
    fault_message: faultMessage,
    runs_after_failures: afterFailures.runs,
    run_started_events_after_failures: afterFailures.events,
    usage_after_failures: afterFailures.usage,
    ledger_after_failures: afterFailures.ledger,
    recovered_started: recovered.started,
    recovered_reason: recovered.reason,
    usage_after_recovery: budgetUsageOf(h.scheduler).runs,
    runs_after_recovery: h.scheduler.snapshot().runs.length,
  };
}

interface DiagnosisBeforeCommitResult {
  readonly diagnosis_events_before: number;
  readonly usage_diagnoses_before: number;
  readonly run_still_running: boolean;
  readonly fault_message: string | null;
  readonly finish_accepted_after_fault_removed: boolean;
  readonly verdict_after_recovery: string | null;
  readonly diagnosis_events_after: number;
  readonly usage_diagnoses_after: number;
}

/**
 * 诊断路径的提交前失败（F06）：环形成的第 2 轮收尾时注入故障 ⇒
 * 诊断事件与诊断账目均无新增、轮次仍 `running`；移除故障后重跑收尾即恢复。
 */
async function runF06DiagnosisBeforeCommit(): Promise<DiagnosisBeforeCommitResult> {
  const h = buildA05Harness({ budget: MAIN_BUDGET });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  registerInstance(h, INSTANCE_B);
  deliverWorkRequest(h, {
    message_id: 'm-f06-d1',
    request_id: R_A,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jA：依赖 jB 的结果',
  });
  deliverWorkRequest(h, {
    message_id: 'm-f06-d2',
    request_id: R_B,
    recipient: INSTANCE_B,
    sender: SENDER_S2,
    content: '工作 jB：依赖 jA 的结果',
  });

  h.clock.advance(1, 'F06-D-R1');
  await h.seam.advanceOnce('F06-D-R1');
  const run1 = activeRunOf(h, 'F06-D 第 1 次推进');
  h.scheduler.finishRun({
    run_id: run1.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_A,
        dependency_refs: [{ request_id: R_B }],
        blocker_reason: { kind: 'waiting_dependency', detail: '在等 r-a05-B' },
      },
    ],
  });

  h.clock.advance(1, 'F06-D-R2');
  await h.seam.advanceOnce('F06-D-R2');
  const run2 = activeRunOf(h, 'F06-D 第 2 次推进');

  const diagnosisEventsBefore = countKernelEvents(h.scheduler, 'diagnosis_performed');
  const usageDiagnosesBefore = budgetUsageOf(h.scheduler).diagnoses;

  const injection = new Error('F06 注入：诊断路径的提交前失败');
  h.store.faults.beforeCommit = () => {
    throw injection;
  };
  let faultMessage: string | null = null;
  try {
    h.scheduler.finishRun({
      run_id: run2.run_id,
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: R_B,
          dependency_refs: [{ request_id: R_A }],
          blocker_reason: { kind: 'waiting_dependency', detail: '在等 r-a05-A' },
        },
      ],
    });
  } catch (error) {
    faultMessage = error instanceof Error ? error.message : String(error);
  }

  const runStillRunning = h.scheduler
    .snapshot()
    .runs.some((run) => run.run_id === run2.run_id && run.status === 'running');

  h.store.faults.beforeCommit = undefined;
  const finish2 = h.scheduler.finishRun({
    run_id: run2.run_id,
    publications: [
      {
        kind: 'waiting_dependency',
        request_id: R_B,
        dependency_refs: [{ request_id: R_A }],
        blocker_reason: { kind: 'waiting_dependency', detail: '在等 r-a05-A' },
      },
    ],
  });

  return {
    diagnosis_events_before: diagnosisEventsBefore,
    usage_diagnoses_before: usageDiagnosesBefore,
    run_still_running: runStillRunning,
    fault_message: faultMessage,
    finish_accepted_after_fault_removed: finish2.accepted,
    verdict_after_recovery: finish2.stagnation === null ? null : finish2.stagnation.diagnosis.verdict,
    diagnosis_events_after: countKernelEvents(h.scheduler, 'diagnosis_performed'),
    usage_diagnoses_after: budgetUsageOf(h.scheduler).diagnoses,
  };
}

interface AfterCommitResult {
  readonly publish_failed: boolean;
  readonly usage_after_publish_failure: number;
  readonly usage_after_replays: readonly number[];
  readonly runs_committed: number;
  readonly run_started_events: number;
  readonly usage_after_next_commit: number;
}

/**
 * 提交后发布失败（F06 / R36.1）：已提交的轮次**只扣一次**；
 * 多次 outbox 重放**不重复扣费**；下一次提交点再补账时也不重复。
 */
async function runF06AfterCommitPublishFailure(): Promise<AfterCommitResult> {
  const h = buildA05Harness({ budget: MAIN_BUDGET });
  registerTask(h);
  registerInstance(h, INSTANCE_A);
  deliverWorkRequest(h, {
    message_id: 'm-f06-p1',
    request_id: R_A,
    recipient: INSTANCE_A,
    sender: SENDER_S1,
    content: '工作 jA：提交后发布失败的目标',
  });

  h.store.faults.afterCommitBeforePublish = () => {
    throw new Error('F06 注入：提交已发生，发布前中断');
  };
  let publishFailed = false;
  try {
    h.scheduler.startRun({ instance_id: INSTANCE_A });
  } catch {
    publishFailed = true;
  }
  const usageAfterPublishFailure = budgetUsageOf(h.scheduler).runs;

  // 移除故障，模拟 outbox 重放若干次（重放不得重复扣费）
  h.store.faults.afterCommitBeforePublish = undefined;
  const usages: number[] = [];
  for (let replay = 0; replay < 3; replay += 1) {
    h.scheduler.publishPendingEvents();
    usages.push(budgetUsageOf(h.scheduler).runs);
  }

  // 再走一次真正的提交点（收尾），补账仍按事件身份幂等（不得重复计）
  const run = activeRunOf(h, 'F06-P 注入后');
  h.scheduler.finishRun({
    run_id: run.run_id,
    publications: [
      { kind: 'completed', request_id: R_A, result_refs: [asArtifactRef('r-a05-A#result')] },
    ],
  });

  return {
    publish_failed: publishFailed,
    usage_after_publish_failure: usageAfterPublishFailure,
    usage_after_replays: usages,
    runs_committed: h.scheduler.snapshot().runs.length,
    run_started_events: countKernelEvents(h.scheduler, 'run_started'),
    usage_after_next_commit: budgetUsageOf(h.scheduler).runs,
  };
}

const observations: Record<string, unknown> = {};

describe('A05 — 循环依赖的有限诊断与停止（D09）', () => {
  it('A05-01…12 主场景：A 等 B、B 等 A ⇒ 有限诊断内报告，且不是「已完成」', async () => {
    const obs = await runA05Cycle({ label: 'A05 主场景', budget: MAIN_BUDGET });
    observations.a05_main = obs;

    // ── A05-01（前置，主判据）：预算在执行前登记 ──
    expect(obs.registration.registered_at).toBe(0);
    expect(obs.registration.registered_before_any_run).toBe(true);
    // 机器可执行形式：未登记预算时判定必须抛错（不得静默套默认值）
    expect(() => diagnoseStagnation({ items: [], now: asLogicalTime(0) })).toThrow(/预算未登记/);

    // ── R22/R17：先证明夹具确实产生了数据 ──
    expect(obs.delivery_results).toEqual(['accepted', 'accepted']);
    expect(obs.produced_items).toBe(2);
    expect(obs.deliveries_before_any_advance).toBe(2); // 投递先于任何冻结（投递不触发推进）
    expect(obs.run_instances).toEqual(['I-A', 'I-B']); // 推进顺序确定
    expect(obs.frozen_request_ids_first).toEqual(['r-a05-A']); // 首轮确实读入了 jA

    // ── A05-02（主判据）：运行轮次数 = 2（等号，未超 R_max=8）──
    expect(obs.run_count).toBe(2);
    expect(obs.event_counters.run_count).toBe(2);
    // R17：计数断言必须同时证明事件流含预期事件种类（"忘了喂事件"无法伪装成通过）
    expect(obs.run_started_events).toBe(obs.run_count);
    // A05-02/03/04 的"未超预登记上限"以判据形式落实（不用 `<=`，见 R17）
    const budgetCheck = evaluateBudget(MAIN_BUDGET, {
      runs: obs.run_count,
      diagnoses: obs.diagnosis_events,
      time: obs.clock_total_advanced,
    });
    expect(budgetCheck.ok).toBe(true);
    expect(budgetCheck.exceeded).toEqual([]);

    // ── A05-03（主判据）：诊断次数真实非零（等号；未超 D_max=4）──
    expect(obs.diagnosis_events).toBe(1);
    expect(obs.event_counters.diagnosis_count).toBe(1);
    expect(obs.budget_usage.diagnoses).toBe(1); // 与 diagnosis_performed 事件一一对应（R34.3 投影）

    // ── A05-04（主判据）：实际推进的虚拟时间 = 2（≤ T_max=10000；时间维度取自 chargeTimeFrom）──
    expect(obs.clock_total_advanced).toBe(2);
    expect(obs.budget_usage.time).toBe(2);

    // ── 三个预算维度的取值来源（R34.3 / R34.5：账目 = 已提交事件的投影）──
    expect(obs.event_counters.run_count).toBe(2); // 观测口径（R4）
    expect(obs.budget_usage.runs).toBe(2); // 投影台账口径（夹具不补账）
    expect(obs.budget_usage.runs).toBe(obs.event_counters.run_count); // 两个口径必须相等

    // ── A05-05（主判据）：收敛 = 不再产生新的可运行输入 ──
    expect(obs.empty_advances).toEqual([0, 0, 0]);
    expect(obs.has_runnable_input_after).toEqual([false, false]);
    expect(obs.finish2_produces_new_runnable_input).toBe(false);
    expect(obs.finish2_stopped).toBe(true);
    expect(obs.finish2_disposition).toBe('report');
    expect(obs.finish2_verdict).toBe('cycle_detected');

    // ── A05-06（主判据）：两项工作的等待原因可指认「在等哪一项的哪个标识」──
    expect(obs.finish2_wait_reasons).toHaveLength(2);
    expect(obs.finish2_wait_reasons.map((row) => row.request_id)).toEqual(['r-a05-A', 'r-a05-B']);
    expect(obs.finish2_wait_reasons[0]?.dependency_ids).toEqual(['req:r-a05-B']);
    expect(obs.finish2_wait_reasons[1]?.dependency_ids).toEqual(['req:r-a05-A']);
    expect(obs.finish2_wait_reasons.every((row) => row.wait_class === 'dependency')).toBe(true);
    expect(obs.finish2_wait_reasons.every((row) => (row.blocker_detail ?? '').length > 0)).toBe(true);

    // ── A05-07（主判据，反作弊）：等待窗口内两实例的活动轮次 = 0（执行槽已释放）──
    expect(obs.window_after_first_run.active_runs).toBe(0);
    expect(obs.window.active_runs_before).toBe(0);
    expect(obs.window.active_runs_after).toBe(0);
    expect(obs.window.flat).toBe(true);
    expect(obs.instances_final.map((row) => row.active_run_id)).toEqual([null, null]);
    expect(obs.instances_final.map((row) => row.activity)).toEqual(['idle', 'idle']);
    // D05 层（D05 缺口 5：物理槽释放归 D03/D09，此处到"实例被列为必须空闲"这一层）
    expect(obs.releasable_instance_ids).toEqual(['I-A', 'I-B']);

    // ── A05-08：等待窗口内假 Agent 调用计数不增长 ──
    // D06 没有独立的"模型/工具调用"计数器 ⇒ 以"轮次启动数"为可观测代理（每次轮次 = 一次假 Agent 调用）
    expect(obs.window.run_count_before).toBe(2);
    expect(obs.window.run_count_after).toBe(2);

    // ── A05-09 / A05-10：自动恢复次数（本场景无自动恢复 ⇒ 等号 0）──
    expect(obs.recovery_events).toBe(0);

    // ── F03 的反向约束：**环上的项不得被"假解除"** ──
    // 循环上的项交给 planCycleStop（→ failed），`finish_run` 的解除段落跳过环成员，
    // 因此全程不得出现任何 `dependency_resolved` 通知。
    expect(obs.dependency_resolved_events).toBe(0);

    // ── A05-11（反作弊）：不存在"靠定时互唤维持活跃" —— 入队事件恰 2 次（每条消息一次）──
    expect(obs.queue_enqueued_events).toBe(2);

    // ── R26.2：峰值排队标记是**跨实例**口径，A05 两实例 ⇒ 等号 2（不是 ≤2）──
    expect(obs.merged_counters.peak_queued_flags).toBe(2);
    expect(obs.merged_counters.inbox_message_count).toBe(2);
    expect(obs.merged_counters.peak_active_runs).toBe(1);

    // ── A05-12（主判据，守恒）：循环停止后不是「已完成」；R25.1 的落点 = failed ──
    expect(obs.distribution).toEqual({
      pending: 0,
      processing: 0,
      waiting_dependency: 0,
      completed: 0,
      failed: 2,
      cancelled: 0,
    });
    expect(obs.work_items.map((row) => row.status)).toEqual(['failed', 'failed']);
    expect(obs.work_items.map((row) => row.failure_reason !== null)).toEqual([true, true]);
    expect(obs.work_items.map((row) => row.blocker_kind)).toEqual([
      'cycle_detected',
      'cycle_detected',
    ]);
    expect(obs.cycle_stop_mode).toBe('report_failed');
    expect(obs.cycle_stopped_request_ids).toEqual(['r-a05-A', 'r-a05-B']);
    expect(obs.falsely_completed_by_cycle).toEqual([]);
    expect(obs.snapshot_counters.blocker_reasons).toEqual(['cycle_detected']);
  });

  it('A05-B（F08 翻转）：紧预算 runs=1 ⇒ 只启动 1 轮，第 2 次推进被启动前闸门拒绝', async () => {
    const obs = await runA05BudgetGate(TIGHT_RUNS_BUDGET);
    observations.a05_budget = obs;

    // 数据确实产生（R22）
    expect(obs.delivery_results).toEqual(['accepted', 'accepted']);

    // ── **翻转的旧断言**：旧实现把"runs=1 实际跑 2 轮"当作"达到预算"的通过证据
    //    （R30.1 的 `R_max + 1` 口径）。合同 v1.2 R34.1 已把它改为**启动前闸门**：
    //    该断言描述的是 F08 修复前的行为，现已翻转 —— 只允许 1 轮。 ──
    expect(obs.budget_runs).toBe(1);
    expect(obs.first_advance_started).toBe(1);
    expect(obs.run_instances).toEqual(['I-A']);
    expect(obs.run_count).toBe(1);
    expect(obs.run_started_events).toBe(1);

    // 第 2 次推进：**被拒绝**（拒因 = budget_exhausted），一轮都不新增
    expect(obs.second_advance_started).toBe(0);
    expect(obs.second_advance_detail ?? '').toContain('budget_exhausted');
    expect(obs.extra_advances_started).toEqual([0, 0]);

    // 持续投递合法消息也不能超限（消息被接受，但没有新轮次）
    expect(obs.extra_delivery_results).toEqual(['accepted', 'accepted']);
    expect(obs.run_count).toBe(1);

    // 权威计数只有一个：投影台账 == 已提交事件数（R34.5）
    expect(obs.budget_usage_runs).toBe(1);
    expect(obs.ledger_runs).toBe(1);

    // 拒绝时：不新增已读记录、不认领工作、不消费输入
    expect(obs.b_read_receipts).toBe(0);
    expect(obs.b_pending_before_extra).toBe(true);
    expect(obs.statuses[String(R_B)]).toBe('pending');
    expect(obs.b_queued_flag).toBe(true);
    expect(obs.b_runnable_input).toBe(true);

    // 已有成果与未完成原因保留
    expect(obs.statuses[String(R_A)]).toBe('waiting_dependency');
    expect(obs.a_dependency_ids).toEqual([String(R_B)]);
    expect(obs.a_wait_reason ?? '').toContain('需要 r-a05-B 的结果');
  });

  it('A05-Z（F08 新增）：R = 0 ⇒ 零轮次；输入一条也不消费', async () => {
    const obs = await runA05BudgetGate(ZERO_RUNS_BUDGET);
    observations.a05_zero_budget = obs;

    expect(obs.budget_runs).toBe(0);
    expect(obs.delivery_results).toEqual(['accepted', 'accepted']);
    expect(obs.first_advance_started).toBe(0);
    expect(obs.first_advance_detail ?? '').toContain('budget_exhausted');
    expect(obs.second_advance_started).toBe(0);
    expect(obs.extra_advances_started).toEqual([0, 0]);
    expect(obs.run_count).toBe(0);
    expect(obs.run_started_events).toBe(0);
    expect(obs.budget_usage_runs).toBe(0);
    expect(obs.ledger_runs).toBe(0);

    // 零轮次 ⇒ 两项工作都停在 pending，消息一条都没被读、排队标记保留（输入未被消费）
    expect(obs.statuses[String(R_A)]).toBe('pending');
    expect(obs.statuses[String(R_B)]).toBe('pending');
    expect(obs.b_pending_before_extra).toBe(true);
    expect(obs.b_read_receipts).toBe(0);
    expect(obs.b_queued_flag).toBe(true);
    expect(obs.b_runnable_input).toBe(true);
    expect(obs.a_wait_reason).toBeNull(); // 没有轮次 ⇒ 没有等待原因，而不是被伪造出一个
  });

  it('A05-L（R8 硬要求的无环对照）：内核自动解除依赖，正常等待不被判为循环', async () => {
    const obs = await runA05L();
    observations.a05_l = obs;

    // 数据确实产生（R22）
    expect(obs.delivery_results).toEqual(['accepted', 'accepted']);
    expect(obs.produced_items).toBe(2);

    // ── A05-L-01（主判据）：两项工作最终均为「已完成」，且各带与其 request_id 匹配的结果引用 ──
    expect(obs.completed).toEqual([
      { request_id: 'r-a05-LA', result_refs: ['r-a05-LA#result'] },
      { request_id: 'r-a05-LB', result_refs: ['r-a05-LB#result'] },
    ]);
    expect(obs.distribution.completed).toBe(2);
    expect(obs.distribution.failed).toBe(0);

    // ── A05-L-02（主判据）：总运行轮次数 = 3（≤ 预登记的宽上限 8），有限轮次内收敛 ──
    expect(obs.run_count).toBe(3);
    expect(obs.run_started_events).toBe(3);
    expect(
      evaluateBudget(MAIN_BUDGET, { runs: obs.run_count, diagnoses: obs.diagnosis_events }).ok,
    ).toBe(true);
    expect(obs.run_instances).toEqual(['I-A', 'I-B', 'I-A']);
    expect(obs.empty_advances_after).toEqual([0, 0]);
    expect(obs.budget_usage?.runs).toBe(3); // 投影台账与观测口径一致（R34.5）

    // ── A05-L-03 / A05-L-06（主判据，反向约束）：循环定性判定与停滞诊断事件数 = 0 ──
    expect(obs.diagnosis_events).toBe(0);
    expect(obs.checkpoint_cycle_counts).toEqual([0, 0, 0]);
    expect(obs.checkpoint_verdicts).toEqual(['progress_possible', 'progress_possible', 'waiting']);

    // ── A05-L-04：自动恢复事件数 = 0（≤1；本场景无自动恢复）──
    expect(obs.recovery_events).toBe(0);

    // ── A05-L-05：等待窗口内执行槽同样释放（活动轮次 = 0，且窗口内不增长）──
    expect(obs.window_active_runs).toEqual([0, 0]);
    expect(obs.window_flat).toBe(true);

    // ── A05-L-07（主判据）：jLB 的结果到达之前，I-A 不被反复唤醒 ──
    expect(obs.i_a_runnable_before_result).toBe(false);
    expect(obs.run_instances[1]).toBe('I-B'); // 第 2 个轮次是 I-B，不是 I-A

    // ── **F03 的核心断言**：B 完成的那一刻，内核已自行把 A 的等待项转回可运行并发出解除通知。
    //    以下全部取自只读快照，夹具**没有**调用任何 planDependencyResolution / putWorkItem /
    //    wakeOnDependencyResolved（旧 A05-L 正是靠这三个调用"代做内核步骤"）。──
    expect(obs.kernel_resolution.la_status).toBe('processing');
    expect(obs.kernel_resolution.la_dependency_resolved_events).toBe(1);
    expect(obs.kernel_resolution.a_has_runnable_input).toBe(true);
    expect(obs.dependency_resolved_events).toBe(1);

    // 第 3 轮读入的是**解除输入**（Q5-c 的可运行输入引用），身份含 task + revision + 解除对象
    expect(obs.frozen_actionable_refs).toEqual([
      resolutionInputRefId({
        task_id: TASK_ID,
        task_revision: REVISION,
        request_id: R_LA,
        resolved_dependency_ids: [`req:${String(R_LB)}`],
      }),
    ]);
  });

  it('A05-L/N（F03 的预算无关性）：**不登记 stagnation** 时正常依赖解除照样工作', async () => {
    const obs = await runA05L({ withoutStagnation: true });
    observations.a05_l_without_stagnation = obs;

    // 无预算 ⇒ 不做闸断、不做投影（budgetUsage() 为 null，夹具不得凭空补一个 0 来"证明"某事）
    expect(obs.stagnation_enabled).toBe(false);
    expect(obs.budget_usage).toBeNull();
    expect(obs.diagnosis_events).toBe(0);
    expect(obs.checkpoint_verdicts).toEqual([]);

    // 解除链路与有预算时**完全一致**（R37.4：正常解除不依赖停滞诊断是否启用）
    expect(obs.kernel_resolution.la_status).toBe('processing');
    expect(obs.kernel_resolution.la_dependency_resolved_events).toBe(1);
    expect(obs.kernel_resolution.a_has_runnable_input).toBe(true);
    expect(obs.dependency_resolved_events).toBe(1);
    expect(obs.run_count).toBe(3);
    expect(obs.run_instances).toEqual(['I-A', 'I-B', 'I-A']);
    expect(obs.completed).toEqual([
      { request_id: 'r-a05-LA', result_refs: ['r-a05-LA#result'] },
      { request_id: 'r-a05-LB', result_refs: ['r-a05-LB#result'] },
    ]);
    expect(obs.distribution.completed).toBe(2);
  });

  it('A05-M（F03 反向约束）：同时依赖 B/C 时只完成 B **不得**唤醒等待方', async () => {
    const obs = await runA05MultiDependency();
    observations.a05_multi = obs;

    // 只完成 B：解除条件未全部满足 ⇒ 不唤醒、不产生解除通知
    expect(obs.ma_status_after_b_only).toBe('waiting_dependency');
    expect(obs.a_runnable_after_b_only).toBe(false);
    expect(obs.dependency_resolved_events_after_b_only).toBe(0);

    // 完成 C：全部满足 ⇒ 内核自动解除并唤醒
    expect(obs.ma_status_after_both).toBe('processing');
    expect(obs.a_runnable_after_both).toBe(true);
    expect(obs.dependency_resolved_events_final).toBe(1);

    // 等待方最终完成；四项工作全部有终态
    expect(obs.final_completed).toEqual(['r-a05-MA', 'r-a05-MB', 'r-a05-MC']);
    expect(obs.run_count).toBe(4);
    expect(obs.run_instances).toEqual(['I-A', 'I-B', 'I-C', 'I-A']);
    expect(obs.distribution).toEqual({
      pending: 0,
      processing: 0,
      waiting_dependency: 0,
      completed: 3,
      failed: 0,
      cancelled: 0,
    });
  });

  it('A05-F（F03 反向约束）：依赖目标失败收场 ⇒ 等待项**不得**被"假解除"', async () => {
    const obs = await runA05FailedDependency();
    observations.a05_failed_dep = obs;

    expect(obs.waiting_status).toBe('waiting_dependency');
    expect(obs.waiting_dependency_ids).toEqual([String(R_MB)]);
    expect(obs.dependency_resolved_events).toBe(0);
    expect(obs.owner_runnable_after).toBe(false);
    // 失败依赖是"永不可能满足"⇒ 如实报告（stalled），而不是继续互唤或假装可推进
    expect(obs.unsatisfiable_request_ids).toEqual([String(R_MA)]);
    expect(obs.stalled).toBe(true);
    expect(obs.diagnosis_events).toBe(1);
    expect(obs.run_count).toBe(2);
  });

  it('受控缺陷注入（R7）：五条注入逐条击穿一条关键断言（含 I-A05-4 的绕过状态机路径）', async () => {
    const items = buildCycleItems(REVISION);
    const injection: Record<string, unknown> = {};

    // ── I-A05-1a「无限互唤」（ignore_budget）：关闭**启动前闸门** ⇒ runs=1 也会跑第 2 轮 ──
    // **口径更正（F08）**：正确行为下 `runs=1` **只跑 1 轮**；缺陷打开后闸门失效，
    // 第 2 轮会被放行（2 轮）⇒ "run_count === 1" 这条朴素断言在缺陷下必然失败。
    const correctBudgetGate = await runA05BudgetGate(TIGHT_RUNS_BUDGET);
    const defectiveBudgetGate = await runA05BudgetGate(TIGHT_RUNS_BUDGET, true);
    const budgetGateHolds = (o: BudgetGateResult): boolean =>
      o.run_count === 1 && o.second_advance_started === 0;
    expect(budgetGateHolds(correctBudgetGate)).toBe(true);
    expect(budgetGateHolds(defectiveBudgetGate)).toBe(false); // ← 缺陷下该断言确实失败
    // 闸门失效后：第 2 次推进放行了 I-B 的轮次（= 超限的第一轮），
    // 其后那两条合法新消息又放行了第 3 轮（正确配置下二者都被拒绝）。
    expect(defectiveBudgetGate.second_advance_started).toBe(1);
    expect(defectiveBudgetGate.run_count).toBe(3);
    expect(defectiveBudgetGate.run_count).toBeGreaterThan(correctBudgetGate.run_count);
    // 可执行证伪：朴素断言（缺陷下必须抛错）
    expectAssertionFails(() => expect(budgetGateHolds(defectiveBudgetGate)).toBe(true));
    injection['I-A05-1a'] = {
      injection: 'defects.ignore_budget = true（关闭启动前预算闸门）',
      broken_assertion: 'F08 / R34.1：runs=1 只启动 1 轮，第 2 次推进被 budget_exhausted 拒绝',
      correct_value: `run_count=${String(correctBudgetGate.run_count)}`,
      defective_value: `run_count=${String(defectiveBudgetGate.run_count)}`,
      assertion_fails_under_defect: true,
    };

    // ── I-A05-1b「阻塞指纹忽略任务版本」──
    const fpR1 = fingerprintOfBlockedItems(buildCycleItems(asRevision(1)));
    const fpR2 = fingerprintOfBlockedItems(buildCycleItems(asRevision(2)));
    const defR1 = fingerprintOfBlockedItems(buildCycleItems(asRevision(1)), {
      ignore_task_revision: true,
    });
    const defR2 = fingerprintOfBlockedItems(buildCycleItems(asRevision(2)), {
      ignore_task_revision: true,
    });
    const fingerprintsDiffer = (a: typeof fpR1, b: typeof fpR2): boolean =>
      a !== null && b !== null && a.digest !== b.digest;
    expect(fingerprintsDiffer(fpR1, fpR2)).toBe(true); // 正确：跨版本指纹不同
    expect(fingerprintsDiffer(defR1, defR2)).toBe(false); // ← 缺陷下该断言失败
    expectAssertionFails(() => expect(fingerprintsDiffer(defR1, defR2)).toBe(true));
    injection['I-A05-1b'] = {
      injection: 'defects.ignore_task_revision_in_fingerprint = true',
      broken_assertion: 'A05-09：阻塞指纹含任务版本（跨版本不得被视为同一情况）',
      correct_value: 'digests differ',
      defective_value: 'digests equal',
      assertion_fails_under_defect: true,
    };

    // ── I-A05-2「空转占槽」（holds_slot_while_waiting）：等待时仍视为占槽 ──
    const correctDiag = diagnoseStagnation({ items, budget: MAIN_BUDGET, now: asLogicalTime(0) });
    const defectiveDiag = diagnoseStagnation({
      items,
      budget: MAIN_BUDGET,
      now: asLogicalTime(0),
      defects: { holds_slot_while_waiting: true },
    });
    expect(correctDiag.verdict).toBe('cycle_detected');
    expect(correctDiag.releasable_instance_ids).toEqual(['I-A', 'I-B']);
    expect(defectiveDiag.releasable_instance_ids).toEqual([]); // ← A05-07 断言在此失效
    expectAssertionFails(() => expect(defectiveDiag.releasable_instance_ids).toEqual(['I-A', 'I-B']));
    injection['I-A05-2'] = {
      injection: 'defects.holds_slot_while_waiting = true（等待期间仍占用执行槽）',
      broken_assertion: 'A05-07：等待窗口内执行槽释放（releasable_instance_ids 非空）',
      correct_value: correctDiag.releasable_instance_ids.join(','),
      defective_value: '(空)',
      assertion_fails_under_defect: true,
    };

    // ── I-A05-3「反复恢复」（new RecoveryLedger(MAX_SAFE_INTEGER)）──
    const fp = fingerprintOfBlockedItems(items);
    const honestLedger = new RecoveryLedger();
    honestLedger.recordAutoRecovery(fp, 'requeue-missing-request', { at: asLogicalTime(1) });
    const honestSecond = honestLedger.canAutoRecover(fp, 'a-different-action');
    const looseLedger = new RecoveryLedger(Number.MAX_SAFE_INTEGER);
    looseLedger.recordAutoRecovery(fp, 'requeue-missing-request', { at: asLogicalTime(1) });
    const looseSecond = looseLedger.canAutoRecover(fp, 'a-different-action');
    const recoveryBounded = (decision: { readonly allowed: boolean }): boolean => decision.allowed === false;
    expect(honestSecond.reason).toBe('already_recovered');
    expect(recoveryBounded(honestSecond)).toBe(true);
    expect(recoveryBounded(looseSecond)).toBe(false); // ← 缺陷下该断言失败
    expectAssertionFails(() => expect(recoveryBounded(looseSecond)).toBe(true));
    injection['I-A05-3'] = {
      injection: 'new RecoveryLedger(Number.MAX_SAFE_INTEGER)（同版同指纹可无限恢复）',
      broken_assertion: 'A05-09：同任务版本 + 同阻塞指纹 + 无新证据时自动恢复 ≤ 1 次',
      correct_value: 'already_recovered（拒绝）',
      defective_value: 'allowed（放行）',
      assertion_fails_under_defect: true,
    };

    // ── I-A05-4「循环即完成」（R25.2：**必须**走 planCycleStop 的绕过状态机路径）──
    const honestPlan = planCycleStop(items, { at: asLogicalTime(1) });
    const defectPlan = planCycleStop(items, { at: asLogicalTime(1), complete_cycles_defect: true });
    expect(findFalselyCompletedByCycle(honestPlan, items)).toEqual([]);
    expect(defectPlan.fabricated_completed.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(findFalselyCompletedByCycle(defectPlan, items).map(String)).toEqual(['r-a05-A', 'r-a05-B']);
    // 可执行证伪：A05-12 的朴素断言在"循环即完成"缺陷下必须抛错
    expectAssertionFails(() => expect(findFalselyCompletedByCycle(defectPlan, items)).toEqual([]));
    injection['I-A05-4'] = {
      injection: 'planCycleStop({ complete_cycles_defect: true })（绕过状态机直接造 completed）',
      broken_assertion:
        'A05-12：循环停止后不得被标为「已完成」（findFalselyCompletedByCycle 必须为空）',
      correct_value: '(空)',
      defective_value: 'r-a05-A,r-a05-B',
      assertion_fails_under_defect: true,
      normal_path_impossible:
        '正常路径不可能产出该结果：waiting_dependency → completed 在 D04 的转换表里出边为空' +
        '（R14 #3 判为 illegal_transition，见紧随其后的断言）。' +
        '此断言防守的是"绕过状态机"的实现回归，而不是正常转换路径。',
    };

    // R25.2 的证据：正常转换路径**不可能**把等待项变成已完成
    const firstItem = items[0];
    if (firstItem === undefined) throw new Error('素材缺失');
    const illegal = evaluateWorkItemTransition({
      item: firstItem,
      to: 'completed',
      at: asLogicalTime(1),
      origin: { kind: 'kernel', note: 'R25.2 取证：正常路径' },
      completion: { request_id: R_A, result_refs: [asArtifactRef('r-a05-A#result')] },
    });
    expect(illegal.ok).toBe(false);
    expect(illegal.rejection?.reason).toBe('illegal_transition');
    injection['R25.2_evidence'] = {
      claim: 'waiting_dependency → completed 在正常转换路径上非法（等待项停在等待态、无结果引用）',
      transition_rejection_reason: illegal.rejection?.reason ?? null,
      illegal: true,
    };

    // 所有注入都经公开的受控开关 / 隔离记录，未改共享源码；同一断言在正确配置下仍成立（见上面的 correct_*）
    injection['falsifiability_executed'] = {
      method: 'expectAssertionFails(朴素断言)：把关键断言的"正确写法"在缺陷配置下执行，必须抛错',
      covered: ['I-A05-1a', 'I-A05-1b', 'I-A05-2', 'I-A05-3', 'I-A05-4'],
      all_threw: true,
    };
    expect(injection['I-A05-4']).toBeDefined();
    expect(injection['I-A05-1a']).toBeDefined();
    observations.a05_injections = injection;
  });

  it('F06（合同 R34.3）：启动路径的提交前失败 ⇒ run / 事件 / 账目零新增，恢复后照常运行', () => {
    const obs = runF06StartBeforeCommit();
    observations.f06_start_before_commit = obs;

    expect(obs.fault_message).toContain('提交前故障注入');
    expect(obs.runs_after_failures).toBe(0);
    expect(obs.run_started_events_after_failures).toBe(0);
    expect(obs.usage_after_failures).toBe(0);
    expect(obs.ledger_after_failures).toBe(0);

    // 旧实现会在两次失败后把台账记到 2（事务未提交却已扣费）⇒ 移除故障后立刻 budget_exhausted。
    expect(obs.recovered_started).toBe(true);
    expect(obs.recovered_reason).toBeNull();
    expect(obs.runs_after_recovery).toBe(1);
    expect(obs.usage_after_recovery).toBe(1);
  });

  it('F06（合同 R34.3）：诊断路径的提交前失败 ⇒ 诊断事件与账目零新增，重跑收尾即恢复', async () => {
    const obs = await runF06DiagnosisBeforeCommit();
    observations.f06_diagnosis_before_commit = obs;

    expect(obs.fault_message).toContain('提交前故障注入');
    expect(obs.diagnosis_events_before).toBe(0);
    expect(obs.usage_diagnoses_before).toBe(0);
    expect(obs.run_still_running).toBe(true); // 事务回滚 ⇒ run 未被收尾（不是"半收尾"）

    expect(obs.finish_accepted_after_fault_removed).toBe(true);
    expect(obs.verdict_after_recovery).toBe('cycle_detected');
    expect(obs.diagnosis_events_after).toBe(1);
    expect(obs.usage_diagnoses_after).toBe(1);
  });

  it('F06（合同 R34.3/R36.1）：提交后发布失败 ⇒ 已提交轮次只扣一次，重放不重复扣费', async () => {
    const obs = await runF06AfterCommitPublishFailure();
    observations.f06_after_commit = obs;

    expect(obs.publish_failed).toBe(true);
    // 事务已提交（run_started 已落库）⇒ 投影必须补一次，且**只补一次**
    expect(obs.usage_after_publish_failure).toBe(1);
    expect(obs.usage_after_replays).toEqual([1, 1, 1]);
    expect(obs.usage_after_next_commit).toBe(1);
    expect(obs.runs_committed).toBe(1);
    expect(obs.run_started_events).toBe(1);
  });

  it('落盘 D09 的 A05 证据 JSON（确定性：无时间戳、无随机）', () => {
    const payload = {
      schema: 'd09-a05-observation.v1',
      owner: 'D09',
      // R38.4 / F11 + G04/G05：身份戳**经复算**，且由发布器在**同一次计算**里填入
      // （见 `writeEvidenceArtifacts`）——复算与登记冻结点不符时写出
      // frozen:false / id:'DEV-UNFROZEN'，产物落 `.dev-evidence/`，不触碰正式证据目录。
      freeze: null as unknown,
      contract_versions: [
        '接口合同-冻结v1',
        '接口合同-冻结v1.1',
        '接口合同-冻结v1.2（修复批）',
        '接口合同-冻结v1.3（G01-G05修复批）',
      ],
      design_points: ['design-01-P5', 'design-01-P4'],
      budget_registration: {
        main: MAIN_BUDGET,
        tight_runs: TIGHT_RUNS_BUDGET,
        zero_runs: ZERO_RUNS_BUDGET,
        note:
          'A05-01：预算在执行前登记（registered_at=0，早于任何运行）；禁止失败后调大。' +
          'R34.1：上限是**启动前闸门**（used+1 > limit ⇒ 拒绝），runs=1 只跑 1 轮、runs=0 跑 0 轮。',
      },
      r19_observability_sources: {
        event_side: 'summarizeKernelEvents(scheduler.kernelEvents()) —— 6 项',
        snapshot_side: 'summarizeSnapshotCounters(只读快照) —— 2 项',
        merged: 'mergeSchedulingCounters（scheduler.summarize()）',
        note: '两组来源都取并合并（R19）；缺任一组视为观测不完整',
      },
      r34_budget_accounting: {
        note: 'R34.3 / R34.5：预算用量是**已提交事件的幂等投影**；夹具不补账（syncRunsFromEvents 已删除）',
        runs: 'scheduler.budgetUsage().runs（= 注入台账的投影）== 观测口径 summarizeKernelEvents().run_count',
        diagnoses: 'run_started / diagnosis_performed 事件经 CommittedBudgetProjection 幂等补齐',
        time: 'D06 的 BudgetLedger.chargeTimeFrom(clock)（内核不推进时间）',
      },
      f03_dependency_resolution: {
        note: 'R37.4：正常依赖解除由 finish_run 的事务内段落自动落地；夹具不调用 planDependencyResolution / putWorkItem / wakeOnDependencyResolved（F03）',
        evidence: 'A05-L 的 kernel_resolution（B 完成后 LA 已 processing + 1 条 dependency_resolved）与第 3 轮 frozen_actionable_input_refs',
      },
      r26_2_peak_queued_flags: {
        scope: '跨实例（同时为真的排队标记最大值）',
        domain: '0..实例数',
        a05_expected: 2,
        assertion_style: '等号（R17），并断言事件流非空',
      },
      scenarios: observations,
    };
    // R46.1：落盘目录由**身份**决定（frozen ⇒ docs/other/evidence/{freeze_id}/，
    // 否则 .dev-evidence/{freeze_id}/）；目录与身份在**同一次计算**里确定。
    const outcome = writeEvidenceArtifacts((identity) => [
      {
        file_name: 'a05-observation.json',
        content: `${JSON.stringify({ ...payload, freeze: identity }, null, 2)}\n`,
      },
    ]);
    expect(outcome.written).toHaveLength(1);
    expect(payload.scenarios.a05_main).toBeDefined();
  });
});
