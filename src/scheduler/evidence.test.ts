import { writeEvidenceArtifacts } from '../../tests/acceptance/freeze-identity.js';

import { describe, expect, it } from 'vitest';

import { asInstanceId, asLogicalTime, asRevision, createWorkItem } from '../protocol/index.js';
import { markDependencyResolutionInput } from '../inbox/index.js';
import * as schedulerModule from './index.js';
import { RunBudgetConfigError, runBudgetConfigMessage } from './errors.js';
import {
  INSTANCE_C,
  TASK_ID,
  buildScheduler,
  buildStore,
  countEvents,
  factsOf,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';


/** A02 形状：4 条投递 → 同轮处理 → 4 项各有结局。 */
function a02Shape() {
  const store = buildStore();
  registerInstance(store);
  const scheduler = buildScheduler(store);

  const deliveries = [1, 2, 3, 4].map((n) => scheduler.onMessage(workRequest(n)));
  const first = scheduler.advanceOnce();
  const finish = scheduler.finishRun({
    run_id: first.run?.run_id ?? ('run-1' as never),
    publications: [1, 2, 3, 4].map((n) => ({
      kind: 'completed' as const,
      request_id: requestId(`r-${n}`),
      result_refs: [resultRef(requestId(`r-${n}`))],
    })),
  });
  const emptyAdvances = [1, 2, 3, 4, 5].map(() => scheduler.advanceOnce().startedRuns);
  const facts = factsOf(scheduler);
  const counters = scheduler.summarize();

  return {
    delivery_results: deliveries.map((outcome) => outcome.result),
    queued_flag_after_deliveries: deliveries.map((outcome) => outcome.queued),
    enqueued_events_total: countEvents(scheduler, 'delegation_queue_enqueued'),
    enqueued_events_cleared_total: countEvents(scheduler, 'delegation_queue_cleared'),
    frozen_input_message_ids: first.run?.frozen_input_message_ids ?? [],
    frozen_request_ids: first.run?.frozen_request_ids ?? [],
    claimed_request_ids: first.claimed_request_ids,
    completed_result_refs: facts.work_items.map((item) => item.result_refs),
    empty_advances: emptyAdvances,
    runs: facts.runs.map((run) => run.status),
    active_run_ids: facts.active_run_ids,
    queued_flags: facts.queued_flags,
    unique_inbox_message_ids: facts.unique_inbox_message_ids,
    counters: {
      run_count: counters.run_count,
      peak_active_runs: counters.peak_active_runs,
      peak_queued_flags: counters.peak_queued_flags,
      inbox_message_count: counters.inbox_message_count,
      rejected_publication_count: counters.rejected_publication_count,
      work_item_status_distribution: counters.work_item_status_distribution,
    },
  };
}

/** A03 形状：运行中连续到达 3 条 → 合并运行机会、保留 3 项工作。 */
function a03Shape() {
  const store = buildStore();
  registerInstance(store);
  const scheduler = buildScheduler(store);

  scheduler.onMessage(workRequest(0));
  const first = scheduler.advanceOnce();
  const enqueuedAfterStart = countEvents(scheduler, 'delegation_queue_enqueued');

  const late = [1, 2, 3].map((n) => scheduler.onMessage(workRequest(n)));
  const enqueuedDuringRun = countEvents(scheduler, 'delegation_queue_enqueued') - enqueuedAfterStart;
  const workItemsDuringRun = factsOf(scheduler).work_items.map((item) => item.status);

  const finishFirst = scheduler.finishRun({
    run_id: first.run?.run_id ?? ('run-1' as never),
    publications: [
      { kind: 'completed', request_id: requestId('r-0'), result_refs: [resultRef(requestId('r-0'))] },
    ],
  });
  const second = scheduler.advanceOnce();
  scheduler.finishRun({
    run_id: second.run?.run_id ?? ('run-2' as never),
    publications: [1, 2, 3].map((n) => ({
      kind: 'completed' as const,
      request_id: requestId(`r-${n}`),
      result_refs: [resultRef(requestId(`r-${n}`))],
    })),
  });
  const counters = scheduler.summarize();
  const facts = factsOf(scheduler);

  return {
    late_delivery_results: late.map((outcome) => outcome.result),
    late_queued: late.map((outcome) => outcome.queued),
    late_merged: late.map((outcome) => outcome.merged_wakeup),
    enqueued_events_during_first_run: enqueuedDuringRun,
    work_item_statuses_during_run: workItemsDuringRun,
    first_frozen_message_ids: first.run?.frozen_input_message_ids ?? [],
    second_frozen_message_ids: second.run?.frozen_input_message_ids ?? [],
    queued_next_run_after_first: finishFirst.queued_next_run,
    final_work_item_status_distribution: counters.work_item_status_distribution,
    final_active_run_ids: facts.active_run_ids,
    final_queued_flags: facts.queued_flags,
    counters: {
      run_count: counters.run_count,
      peak_active_runs: counters.peak_active_runs,
      peak_queued_flags: counters.peak_queued_flags,
      inbox_message_count: counters.inbox_message_count,
    },
  };
}

/** P7：五种拒绝原因各造一次，并确认被拒时没有任何结果被写入。 */
function p7Rejections() {
  const cases: Record<string, { readonly reason: string | null; readonly results_written: boolean }> = {};

  // unknown_run
  {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);
    const outcome = scheduler.finishRun({ run_id: 'run-404' as never });
    cases['unknown_run'] = { reason: outcome.rejection_reason, results_written: false };
  }
  // run_not_active（正常结束后再发布一次）
  {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);
    scheduler.onMessage(workRequest(1));
    scheduler.startRun({ instance_id: INSTANCE_C });
    scheduler.finishRun({ run_id: 'run-1' as never });
    const outcome = scheduler.finishRun({ run_id: 'run-1' as never });
    cases['run_not_active'] = { reason: outcome.rejection_reason, results_written: false };
  }
  // lease_expired
  {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store, { lease_ttl: 10 });
    scheduler.onMessage(workRequest(1));
    scheduler.startRun({ instance_id: INSTANCE_C });
    const outcome = scheduler.finishRun({
      run_id: 'run-1' as never,
      at: asLogicalTime(10),
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });
    cases['lease_expired'] = {
      reason: outcome.rejection_reason,
      results_written: factsOf(scheduler).work_items.some((item) => item.result_refs.length > 0),
    };
  }
  // stale_task_revision
  {
    const store = buildStore();
    registerInstance(store);
    registerTask(store, { revision: asRevision(1) });
    const scheduler = buildScheduler(store);
    scheduler.onMessage(workRequest(1, { task_revision: asRevision(1) }));
    scheduler.startRun({ instance_id: INSTANCE_C });
    store.transact((tx) => {
      const task = tx.getTask(TASK_ID);
      if (task === undefined) throw new Error('任务应已注册');
      tx.putTask({ ...task, revision: asRevision(2) });
    });
    const outcome = scheduler.finishRun({
      run_id: 'run-1' as never,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });
    cases['stale_task_revision'] = {
      reason: outcome.rejection_reason,
      results_written: factsOf(scheduler).work_items.some((item) => item.result_refs.length > 0),
    };
  }
  // owner_mismatch（工作项级，R14-6：不得把 A 拥有的工作项交给 B 的轮次写）
  {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerInstance(store, asInstanceId('B'));
    const scheduler = buildScheduler(store);
    scheduler.onMessage(workRequest(1));
    scheduler.startRun({ instance_id: INSTANCE_C });
    store.transact((tx) => {
      const item = tx.getWorkItem(requestId('r-1'));
      if (item === undefined) throw new Error('工作项应已存在');
      tx.putWorkItem(
        createWorkItem({
          request_id: item.request_id,
          task_id: item.task_id,
          task_revision: item.task_revision,
          owner_instance_id: asInstanceId('B'),
          description: item.description,
          status: item.status,
          blocker_reason: item.blocker_reason,
          created_at: item.created_at,
          updated_at: item.updated_at,
        }),
      );
    });
    const outcome = scheduler.finishRun({
      run_id: 'run-1' as never,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });
    cases['owner_mismatch'] = {
      reason: outcome.rejected_publications[0]?.ledger_reason ?? null,
      results_written: factsOf(scheduler).work_items.some((item) => item.result_refs.length > 0),
    };
  }

  return cases;
}

/** 待投递事件（outbox）的取证：含**已投递**的，因此能区分"从没写过"与"写了又发布"。 */
function outboxKindsOf(scheduler: ReturnType<typeof buildScheduler>): readonly string[] {
  return scheduler
    .snapshot()
    .delivery_events.map((event) => `${event.kind}${event.delivered ? '(delivered)' : '(pending)'}`);
}

/** R16.2：D02 缺口 vs D03 唤醒端口。 */
function dependencyWakeupGap() {
  // 缺口形状：只用 D02 的 markDependencyResolutionInput
  const gapStore = buildStore();
  registerInstance(gapStore);
  const gapScheduler = buildScheduler(gapStore);
  gapStore.transact((tx) =>
    markDependencyResolutionInput(tx, { instance_id: INSTANCE_C, ref_id: 'r-dep', at: asLogicalTime(0) }),
  );

  // D03 的端口形状
  const portStore = buildStore();
  registerInstance(portStore);
  const portScheduler = buildScheduler(portStore);
  portScheduler.wakeOnDependencyResolved({
    task_id: TASK_ID,
    instance_id: INSTANCE_C,
    ref_id: 'r-dep',
    reason: 'r-dep 的结果到达',
  });
  const queuedBeforeStart = factsOf(portScheduler).queued_flags[0] ?? null;
  const step = portScheduler.startRun({ instance_id: INSTANCE_C });

  return {
    d02_gap: {
      runnable_input: gapScheduler.hasRunnableInput(INSTANCE_C),
      queued_flag: factsOf(gapScheduler).queued_flags[0] ?? null,
      delegation_queue_enqueued_events: countEvents(gapScheduler, 'delegation_queue_enqueued'),
      outbox_events: outboxKindsOf(gapScheduler),
    },
    with_d03_port: {
      queued_flag: queuedBeforeStart,
      delegation_queue_enqueued_events: countEvents(portScheduler, 'delegation_queue_enqueued'),
      outbox_events: outboxKindsOf(portScheduler),
      frozen_actionable_input_refs: step.run?.frozen_actionable_input_refs ?? [],
      frozen_input_message_ids: step.run?.frozen_input_message_ids ?? [],
    },
  };
}

/** 停滞检查点（R25.3）：报告才记账；正常等待不产生诊断事件。 */
function stagnationFacts() {
  const limits = { runs: 6, diagnoses: 4, time: 10_000 };
  const charged: { diagnoses: number } = { diagnoses: 0 };
  const ledger = {
    charge: (kind: string, amount = 1): number => {
      if (kind === 'diagnoses') {
        charged.diagnoses += amount;
      }
      return charged.diagnoses;
    },
    used: (): number => charged.diagnoses,
  };

  // 正常等待（等用户）⇒ pause ⇒ 不记账、不写事件
  const pauseStore = buildStore();
  registerInstance(pauseStore);
  const pauseScheduler = buildScheduler(pauseStore, { stagnation: { budget: limits, ledger } });
  pauseScheduler.onMessage(workRequest(1));
  pauseScheduler.advanceOnce();
  const pauseFinish = pauseScheduler.finishRun({
    run_id: 'run-1' as never,
    publications: [
      {
        kind: 'processing',
        request_id: requestId('r-1'),
        blocker_reason: { kind: 'waiting_user' as const, detail: '等用户确认' },
      },
    ],
  });

  return {
    budget_registered_required: '未传预算时 finish_run 不做停滞判定（stagnation = null），不静默套默认值',
    normal_wait: {
      verdict: pauseFinish.stagnation?.diagnosis.verdict ?? null,
      disposition: pauseFinish.stagnation?.diagnosis.disposition ?? null,
      diagnosis_events: countEvents(pauseScheduler, 'diagnosis_performed'),
      charged_diagnoses: charged.diagnoses,
      releasable_instance_ids: pauseFinish.stagnation?.releasable_instance_ids ?? [],
    },
  };
}

describe('D03 证据：调度内核单元级机器可读汇总', () => {
  it('汇总可确定复现（无时间戳、无随机），并落盘到 docs/other/evidence/D03/', () => {
    const a02 = a02Shape();
    const a03 = a03Shape();
    const wakeup = dependencyWakeupGap();
    const stagnation = stagnationFacts();

    // 关键断言先行：证据里写的每个数都必须与真实行为一致
    expect(a02.delivery_results).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(a02.counters.run_count).toBe(1);
    expect(a02.counters.peak_active_runs).toBe(1);
    expect(a02.counters.peak_queued_flags).toBe(1);
    expect(a02.completed_result_refs).toEqual([
      ['r-1#result'],
      ['r-2#result'],
      ['r-3#result'],
      ['r-4#result'],
    ]);
    expect(a03.enqueued_events_during_first_run).toBe(0);
    expect(a03.counters.run_count).toBe(2);
    expect(a03.queued_next_run_after_first).toBe(true);
    expect(wakeup.d02_gap.queued_flag).toBe(false);
    expect(wakeup.d02_gap.delegation_queue_enqueued_events).toBe(0);
    expect(wakeup.with_d03_port.queued_flag).toBe(true);
    expect(wakeup.with_d03_port.frozen_actionable_input_refs).toEqual(['r-dep']);

    expect(stagnation.normal_wait.disposition).toBe('pause');
    expect(stagnation.normal_wait.diagnosis_events).toBe(0);

    const payload = {
      schema: 'd03-scheduler-unit-summary.v1',
      module: 'src/scheduler',
      contract_versions: ['接口合同-冻结v1', '接口合同-冻结v1.1'],
      design_points: ['design-01-P1', 'design-01-P3', 'design-01-P7'],
      value_exports: Object.keys(schedulerModule).sort(),
      r19_observability: {
        event_side_counters: [
          'run_count',
          'rejected_publication_count',
          'peak_active_runs',
          'peak_queued_flags',
          'diagnosis_count',
          'inbox_message_count',
        ],
        snapshot_side_counters: ['work_item_status_distribution', 'blocker_reasons'],
        note: 'D03 只发事件；计数一律由 protocol 的 summarizeKernelEvents + summarizeSnapshotCounters 计算（R4/R19）',
      },
      a02_shape: a02,
      a03_shape: a03,
      p7_rejections: p7Rejections(),
      r16_2_dependency_wakeup: wakeup,
      r25_3_stagnation_checkpoint: {
        where: 'finish_run 收尾（附录 B 的 check task progress and waiting conditions）',
        accountability: 'D03：写 diagnosis_performed 事件 + 记预算台账；判定归 D05 的 diagnoseStagnation',
        budget_type: 'D05 的 DiagnosisBudget（D06 的 ScenarioBudget 结构相同，可直接传）—— 未新造预算类型（R25.4）',
        only_report_is_counted: 'disposition === report 才写事件 / 记账；pause（正常等待）不计（R8 / A05-L-06）',
        cycle_landing: 'verdict === cycle_detected ⇒ planCycleStop（默认 report_failed）⇒ 环上项 failed + failure_reason（R25.1 / A05-12）',
        not_run_without_budget: '未登记预算时根本不启动检查点（D05 在预算缺省时抛错，A05-01）',
        ...stagnation,
      },
      controlled_defect_injections: [
        {
          id: 'I-A02-2',
          description: '已有活动轮次或排队标记时直接丢弃本条消息',
          primary_assertion: 'A02-04 收件箱唯一 message_id 数 = 4',
          correct_outcome: '4',
          defective_outcome: '1',
          assertion_fails_under_defect: true,
        },
        {
          id: 'I-A03-2',
          description: '去掉"已有排队标记则不再入队"的保护，每条各自入队',
          primary_assertion: 'A03-03 首轮活动期间入队事件数 ≤ 1',
          correct_outcome: '0（运行中）',
          defective_outcome: '3',
          assertion_fails_under_defect: true,
        },
        {
          id: 'I-A03-3',
          description: '轮次读取消息后直接把工作项置为已完成、无结果引用',
          primary_assertion: 'A03-10 已完成项必须带与其 request_id 匹配的结果引用',
          correct_outcome: '无此类项',
          defective_outcome: 'r-1',
          assertion_fails_under_defect: true,
        },
      ],
      cancel_handling: {
        task_reference: '任务书 §9.3 / 验收规格 P4-12',
        applies: 'synchronously_in_same_transaction',
        inbox_entry_requires_wakeup: false,
        note: '取消消息的收件箱条目为安静条目：取消已同步生效，不为它起一轮（否则多出一轮无有效工作的轮次）',
      },
      counters_reference_implementation: 'src/protocol/counters.ts（D01）',
      r34_1_run_budget_gate: {
        where: 'start_run 的启动路径（获取执行权 / 消费快照 / 认领工作**之前**判定）',
        accounting:
          '合同 v1.2 R34.3（修复 F06）：记账 = **已提交事件的幂等投影**（src/scheduler/budget-projection.ts）。' +
          '`run_started` ⇒ `run:<run_id>`、`diagnosis_performed` ⇒ `diagnosis:<event_id>`；' +
          '事件随事务一同提交或回滚，投影在提交之后按事件身份补齐，重复重放不重复扣费。' +
          '**不得**在事务体内直接改注入台账（那早于提交，提交前失败会留下一笔幽灵账）。',
        enforcement:
          'runBudgetExhausted（复用 D05 的 evaluateBudget，判据 `used + 1 > limit`）⇒ start_run 返回 budget_exhausted',
        upper_bound:
          'R_max（**启动前硬上限**，合同 v1.2 R34.1）。R = 0 启动 0 轮、R = 1 只启动 1 轮、一般 R = N 不超过 N。' +
          'v1.1 R30.1 的 `R_max + 1` 口径已作废（那次是把"事后超限"当成了启动许可）。',
        report_vs_gate:
          'R34.2：诊断侧的"已超限"（usage > limit ⇒ budget_exhausted）只用于**报告**，不得复用为启动许可',
        defect_mirror: 'defects.ignore_budget 关闭闸断；记账由已提交事件投影承担，与开关无关',
        no_third_budget_type: '上限用 D05 的 DiagnosisBudget、台账用 D06 的 BudgetLedger（R25.4）',
        without_ledger: '登记了预算却不注入台账 ⇒ 抛 RunBudgetConfigError（R30.3，不静默放行）',
        unit_evidence: [
          'stagnation.test.ts 的「轮次预算的内核闸断」5 个用例（含 R = 0 与"持续投递也不超限"）',
          'repair-batch.test.ts 的「F06 预算记账 = 已提交事件的幂等投影」2 个用例',
        ],
      },
      r29_2_commit_registration: {
        where: 'Scheduler.onMessage：事务提交后**立即**登记，然后才尝试发布',
        covered_paths: [
          'store.transact 自身的 afterCommitBeforePublish 接缝抛 PublicationError（D07 实测的那条）',
          '门面随后的 publishPendingEvents() 抛 PublicationError',
        ],
        mechanism:
          '事务闭包写入外部引用 committed；catch 到 PublicationError 时用 committed 完成登记后再抛出',
        semantics: '只要 committed（accepted === true）就必然出现在接缝登记里，与发布成败无关',
      },
      r30_3_budget_config_guard: {
        rule: '登记了运行轮次预算但**未注入台账** ⇒ 抛 RunBudgetConfigError（不静默降级为"不闸断"）',
        boundary_kept: '完全不登记预算 ⇒ 不做闸断、不抛错（有意的"无预算运行"，A02/A03/A04/P2 的夹具即此）',
        error_name: new RunBudgetConfigError('').name,
        message: runBudgetConfigMessage(),
        where: 'runBudgetGateOf（start_run 的闸断入口）；抛错经 Store.transact 包成 PersistenceError（accepted === false）',
        unit_evidence: [
          'stagnation.test.ts「配了预算却不给台账 ⇒ 抛明确的配置错误」',
          'stagnation.test.ts「完全不配预算 ⇒ 不闸断、不抛错」',
        ],
      },
      acceptance_impact: {
        note: '两处修复会让三条**编码了修复前行为**的验收断言变红（tests/acceptance 归 D07/D09，D03 不得修改）',
        stale_assertions: [
          'tests/acceptance/a05/a05.cycle-dependency.test.ts:610 — ledger_usage.runs 期望 0，实际 2（R26.3 的"台账里没有 runs"已被 R27.1 取代）',
          'tests/acceptance/p4/p4.work-commitment.test.ts:579 — ledger_usage.runs 期望 0，实际 4（同上）',
          'tests/acceptance/a02a03/defects.test.ts:200 — seam.deliveries.length 期望 0，实际 1（R29.2 已判定该期望是缺陷语义）',
        ],
        r30_3_expected_reds: '无（A05/P4 都已注入台账；A02/A03/A04/P2 完全不配预算）',
      },
    };

    // R46.1（G05）：落盘目录由**证据发布器**决定——frozen ⇒ `docs/other/evidence/{freeze_id}/`，
    // 否则 `.dev-evidence/{freeze_id}/`。开发期产物**不再**覆写 `docs/other/evidence/D03/` 的历史证据。
    const outcome = writeEvidenceArtifacts((identity) => [
      {
        file_name: 'scheduler-unit-summary.json',
        content: `${JSON.stringify({ ...payload, identity }, null, 2)}\n`,
      },
    ]);
    expect(outcome.written).toHaveLength(1);

    expect(payload.value_exports).toContain('createScheduler');
    expect(payload.value_exports).toContain('Scheduler');
  });
});
