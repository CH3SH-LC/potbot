import { describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asRevision,
  asRunId,
  assertInstanceStateInvariants,
  createWorkItem,
  type LogicalTime,
} from '../protocol/index.js';
import { markDependencyResolutionInput } from '../inbox/index.js';
import {
  BASELINE_REVISION,
  INSTANCE_C,
  SENDER_S1,
  SENDER_S2,
  TASK_ID,
  buildScheduler,
  buildStore,
  countEvents,
  factsOf,
  instanceId,
  messageId,
  readTx,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';

const TASK_REV_1 = BASELINE_REVISION;
const RUN_1 = asRunId('run-1');
const RUN_2 = asRunId('run-2');

/** `start_run`：抢占 + 冻结 + run_id + 租约 + 置活动，五件事在同一事务里（§九-3）。 */
describe('start_run：原子抢占 + 冻结快照 + 有限租约', () => {
  it('一次事务内完成抢占、冻结、分配 run_id 与租约、置活动', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();

    expect(step.startedRuns).toBe(1);
    expect(step.run?.run_id).toBe('run-1');
    expect(step.run?.status).toBe('running');
    expect(step.run?.instance_id).toBe(INSTANCE_C);
    expect(step.run?.task_id).toBe(TASK_ID);
    expect(step.run?.task_revision).toBe(TASK_REV_1);
    // 有限租约：逻辑时间度量、不自动续租（Q7-a）
    expect(step.run?.lease_deadline).toBe(asLogicalTime(1000));
    expect(step.run?.frozen_input_message_ids).toEqual(['m-1']);
    expect(step.run?.frozen_request_ids).toEqual(['r-1']);

    const facts = factsOf(scheduler);
    expect(facts.active_run_ids).toEqual(['run-1']);
    expect(facts.queued_flags).toEqual([false]);
    expect(facts.runs.map((run) => run.status)).toEqual(['running']);
    expect(countEvents(scheduler, 'run_started')).toBe(1);
    // 排队标记被抢占 → 必须发清除事件（peak_queued_flags 的减法端，R4）
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
    expect(countEvents(scheduler, 'delegation_queue_cleared')).toBe(1);
    // 认领：pending → processing（唯一能走向 completed 的入口状态）
    expect(facts.work_items.map((item) => item.status)).toEqual(['processing']);
  });

  it('冻结即标已读，且**绝不**改变工作项状态为「已完成」（R16-1、§九-5）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();

    const snapshot = store.snapshot();
    expect(snapshot.read_receipts.map((receipt) => [receipt.message_id, receipt.run_id])).toEqual([
      ['m-1', 'run-1'],
    ]);
    expect(snapshot.instances[0]?.consumed_message_ids).toEqual(['m-1']);
    expect(snapshot.work_items[0]?.included_in_snapshot).toBe(true);
    expect(snapshot.work_items[0]?.snapshot_run_ids).toEqual(['run-1']);
    // 读入 ≠ 完成
    expect(snapshot.work_items[0]?.status).toBe('processing');
  });

  it('同一实例不得并发启动两个轮次（§9.1）：第二次 start 返回 already_active 且峰值活动轮次 = 1', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const first = scheduler.startRun({ instance_id: INSTANCE_C });
    const second = scheduler.startRun({ instance_id: INSTANCE_C });

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.reason).toBe('already_active');
    expect(second.run).toBeNull();
    expect(countEvents(scheduler, 'run_started')).toBe(1);
    expect(scheduler.eventCounters().peak_active_runs).toBe(1);
  });

  it('无有效工作不运行（§9.4）：没有可运行输入 → no_runnable_input，且不写任何记录', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const outcome = scheduler.startRun({ instance_id: INSTANCE_C });

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toBe('no_runnable_input');
    const facts = factsOf(scheduler);
    expect(facts.runs).toEqual([]);
    expect(facts.kernel_event_kinds).toEqual([]);
    expect(store.snapshot().read_receipts).toEqual([]);
  });

  it('任务身份不可推断 → task_unresolved（在任何写入之前判出，不留"已读但无轮次"）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    // 用 D02 的原语直接登记一条可运行输入：没有消息、没有工作项、也没有待投递事件
    // → 六条推断路径全落空（这是"配置不完整"的边界，D07/D09 应注册任务或传 default_task_id）
    store.transact((tx) =>
      markDependencyResolutionInput(tx, { instance_id: INSTANCE_C, ref_id: 'r-dep', at: asLogicalTime(0) }),
    );
    expect(scheduler.hasRunnableInput(INSTANCE_C)).toBe(true);

    const outcome = scheduler.startRun({ instance_id: INSTANCE_C });

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toBe('task_unresolved');
    expect(store.snapshot().read_receipts).toEqual([]);
    expect(store.snapshot().runs).toEqual([]);

    // 显式给出 task_id 后即可启动（调用方补上配置即可）
    const withTask = scheduler.startRun({ instance_id: INSTANCE_C, task_id: TASK_ID });
    expect(withTask.started).toBe(true);
    expect(withTask.run?.frozen_actionable_input_refs).toEqual(['r-dep']);
  });

  it('已注册任务时以任务版本为准（冻结版本绑定，供 stale 判定）', () => {
    const store = buildStore();
    registerInstance(store);
    registerTask(store, { revision: asRevision(3) });
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1, { task_revision: asRevision(3) }));
    const step = scheduler.startRun({ instance_id: INSTANCE_C });

    expect(step.run?.task_revision).toBe(asRevision(3));
  });
});

/** `finish_run`：所有权核验 → 发布 → 清活动 → 至多一次入队 / 置空闲。 */
describe('finish_run：所有权核验与拒绝迟到发布（P7）', () => {
  it('正常路径：结果落库 + 工作项转终态 + 清活动轮次 + 置空闲', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();
    const finish = scheduler.finishRun({
      run_id: RUN_1,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    expect(finish.accepted).toBe(true);
    expect(finish.rejection_reason).toBeNull();
    expect(finish.applied_request_ids).toEqual(['r-1']);
    expect(finish.rejected_publications).toEqual([]);
    expect(finish.queued_next_run).toBe(false);

    const facts = factsOf(scheduler);
    expect(facts.work_items.map((item) => [item.status, item.result_refs])).toEqual([
      ['completed', ['r-1#result']],
    ]);
    expect(facts.runs.map((run) => run.status)).toEqual(['finished']);
    expect(facts.active_run_ids).toEqual([null]);
    expect(facts.queued_flags).toEqual([false]);
    expect(countEvents(scheduler, 'run_finished')).toBe(1);
    expect(countEvents(scheduler, 'run_started')).toBe(1);
    expect(step.run?.run_id).toBe('run-1');

    // 收敛：再空推进不产生新轮次
    expect([1, 2, 3].map(() => scheduler.advanceOnce()).every((s) => s.startedRuns === 0)).toBe(true);
    const counters = scheduler.summarize();
    expect(counters.run_count).toBe(1);
    expect(counters.peak_active_runs).toBe(1);
    expect(counters.peak_queued_flags).toBe(1);
    expect(counters.rejected_publication_count).toBe(0);
  });

  it('迟到发布：任务版本已变 → stale_task_revision，拒绝写入任何结果', () => {
    const store = buildStore();
    registerInstance(store);
    registerTask(store, { revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1, { task_revision: asRevision(1) }));
    scheduler.advanceOnce();

    // 任务版本在轮次进行中推进（新任务版本替代旧状态，§9.3）
    store.transact((tx) => {
      const task = tx.getTask(TASK_ID);
      if (task === undefined) throw new Error('任务应已注册');
      tx.putTask({ ...task, revision: asRevision(2) });
    });

    const finish = scheduler.finishRun({
      run_id: RUN_1,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    expect(finish.accepted).toBe(false);
    expect(finish.rejection_reason).toBe('stale_task_revision');
    // 没有任何结果被写入，工作项仍是处理中（读入 ≠ 完成）
    expect(factsOf(scheduler).work_items.map((item) => [item.status, item.result_refs])).toEqual([
      ['processing', []],
    ]);
    expect(countEvents(scheduler, 'publication_rejected')).toBe(1);
    expect(scheduler.eventCounters().rejected_publication_count).toBe(1);
    // 被拒的发布不计入运行轮次数（Q10-a 口径）
    expect(scheduler.eventCounters().run_count).toBe(1);
  });

  it('迟到发布：租约已过期 → lease_expired', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store, { lease_ttl: 10 });

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();

    const finish = scheduler.finishRun({
      run_id: RUN_1,
      at: asLogicalTime(10),
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    expect(finish.accepted).toBe(false);
    expect(finish.rejection_reason).toBe('lease_expired');
    expect(factsOf(scheduler).work_items[0]?.status).toBe('processing');
  });

  it('R14-6：不得把 A 拥有的工作项交给 B 的轮次写（owner_mismatch 被拒）', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerInstance(store, instanceId('B'));
    const scheduler = buildScheduler(store);

    // C 收到工作请求并启动轮次
    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();

    // 直接改负责人为 B（模拟"别人的工作项"），再让 C 的轮次尝试写它
    store.transact((tx) => {
      const item = tx.getWorkItem(requestId('r-1'));
      if (item === undefined) throw new Error('工作项应已存在');
      tx.putWorkItem(
        createWorkItem({
          request_id: item.request_id,
          task_id: item.task_id,
          task_revision: item.task_revision,
          owner_instance_id: instanceId('B'),
          description: item.description,
          status: item.status,
          blocker_reason: item.blocker_reason,
          created_at: item.created_at,
          updated_at: item.updated_at,
        }),
      );
    });

    const finish = scheduler.finishRun({
      run_id: RUN_1,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([]);
    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('owner_mismatch');
    expect(factsOf(scheduler).work_items[0]?.status).toBe('processing');
    expect(countEvents(scheduler, 'publication_rejected')).toBe(1);
  });

  it('未知轮次 / 已结束的轮次 → unknown_run / run_not_active', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const unknown = scheduler.finishRun({ run_id: 'run-404' as never });
    expect(unknown.accepted).toBe(false);
    expect(unknown.rejection_reason).toBe('unknown_run');

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();
    scheduler.finishRun({ run_id: RUN_1 });
    const again = scheduler.finishRun({ run_id: RUN_1 });
    expect(again.accepted).toBe(false);
    expect(again.rejection_reason).toBe('run_not_active');
    expect(countEvents(scheduler, 'publication_rejected')).toBe(2);
  });

  it('非终态发布（等待依赖 / 本轮无结局）只改状态、不产生终态（读入 ≠ 完成）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();

    const finish = scheduler.finishRun({
      run_id: RUN_1,
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-1'),
          dependency_refs: [{ request_id: requestId('r-jx') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 jx 的结果' },
        },
      ],
    });

    expect(finish.applied_request_ids).toEqual(['r-1']);
    const item = store.snapshot().work_items[0];
    expect(item?.status).toBe('waiting_dependency');
    expect(item?.dependency_refs).toEqual([{ request_id: 'r-jx' }]);
    expect(item?.blocker_reason).toEqual({ kind: 'waiting_dependency', detail: '等 jx 的结果' });
    expect(item?.result_refs).toEqual([]);
  });

  it('空结果引用的「已完成」被拒（P4-10 / A03-10），其它发布不受影响', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1, { sender_instance_id: SENDER_S1 }));
    scheduler.onMessage(workRequest(2, { sender_instance_id: SENDER_S2 }));
    scheduler.advanceOnce();

    const finish = scheduler.finishRun({
      run_id: RUN_1,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [] },
        { kind: 'completed', request_id: requestId('r-2'), result_refs: [resultRef(requestId('r-2'))] },
      ],
    });

    expect(finish.applied_request_ids).toEqual(['r-2']);
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('missing_result_ref');
    const statuses = factsOf(scheduler).work_items.map((item) => item.status);
    expect(statuses).toEqual(['processing', 'completed']);
  });

  it('轮次结束后仍有可运行输入 → 至多一次入队；无输入 → 置空闲（§六）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const first = scheduler.advanceOnce();
    // 运行中到达第二条（消息保留）
    scheduler.onMessage(workRequest(2));

    const finishFirst = scheduler.finishRun({
      run_id: first.run?.run_id ?? RUN_1,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    expect(finishFirst.queued_next_run).toBe(true);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(2);
    expect(factsOf(scheduler).queued_flags).toEqual([true]);

    // 抢占排队项 → 第二轮只冻结后到那条
    const second = scheduler.advanceOnce();
    expect(second.run?.frozen_input_message_ids).toEqual(['m-2']);
    const finishSecond = scheduler.finishRun({
      run_id: second.run?.run_id ?? RUN_2,
      publications: [
        { kind: 'completed', request_id: requestId('r-2'), result_refs: [resultRef(requestId('r-2'))] },
      ],
    });
    expect(finishSecond.queued_next_run).toBe(false);
    expect(factsOf(scheduler).queued_flags).toEqual([false]);
    expect([1, 2].map(() => scheduler.advanceOnce()).every((step) => step.startedRuns === 0)).toBe(true);
  });
});

/** 事件流自洽性：D01 的汇总器会对"重复启动 / 重复建工作"抛错，故必须真不重复。 */
describe('观测事件自洽性（R4：由 protocol 的 summarizeKernelEvents 计算）', () => {
  it('端到端一轮：不抛错，且 6 项事件侧计数都是真实值', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    scheduler.onMessage(workRequest(2));
    scheduler.advanceOnce();
    scheduler.finishRun({
      run_id: RUN_1,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
        { kind: 'failed', request_id: requestId('r-2'), failure_reason: '工具失败' },
      ],
    });

    const counters = scheduler.summarize();
    expect(counters.run_count).toBe(1);
    expect(counters.peak_active_runs).toBe(1);
    expect(counters.peak_queued_flags).toBe(1);
    expect(counters.inbox_message_count).toBe(2);
    expect(counters.rejected_publication_count).toBe(0);
    expect(counters.diagnosis_count).toBe(0);
    // 快照侧（R19）：事件侧不再产出状态分布
    expect(counters.work_item_status_distribution.completed).toBe(1);
    expect(counters.work_item_status_distribution.failed).toBe(1);
  });

  it('实例状态的形状不变量在每次写入后都成立（active 配 run_id + 租约）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);
    const at: LogicalTime = asLogicalTime(5);

    scheduler.onMessage(workRequest(1, { at }));
    const step = scheduler.advanceOnce();
    const instance = store.snapshot().instances[0];
    expect(instance?.activity).toBe('active');
    expect(instance?.active_run_id).toBe(step.run?.run_id);
    expect(instance?.lease_deadline).toBe(step.run?.lease_deadline);
    // 形状不变量自检（D01 的判据，不重写）
    expect(instance).toBeDefined();
    expect(() => assertInstanceStateInvariants(instance!)).not.toThrow();
  });

  it('等待依赖的项不被下一轮误认领：解析到的是"可运行输入"，不是"改状态"（Q5-c/R14-3）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    // 走到 waiting_dependency：请求到达 → 认领 → 本轮报告"需要 r-dep 的结果"
    scheduler.onMessage(workRequest(1, { message_id: messageId('m-wait'), request_id: requestId('r-wait') }));
    const first = scheduler.startRun({ instance_id: INSTANCE_C });
    scheduler.finishRun({
      run_id: first.run?.run_id ?? RUN_1,
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-wait'),
          dependency_refs: [{ request_id: requestId('r-dep') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-dep 的结果' },
        },
      ],
    });
    expect(readTx(store, (tx) => tx.getWorkItem(requestId('r-wait')))?.status).toBe('waiting_dependency');

    // 依赖解除（D05 的形状：只登记可运行输入 + 唤醒，不直接改工作项状态）
    scheduler.wakeOnDependencyResolved({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      ref_id: 'r-dep',
      reason: 'r-dep 的结果到达',
    });

    const second = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(second.started).toBe(true);
    // 本轮读入的是**可运行输入引用**（Q5-c），不是把等待项改回处理中
    expect(second.run?.frozen_actionable_input_refs).toEqual(['r-dep']);
    expect(second.run?.frozen_input_message_ids).toEqual([]);
    expect(second.claimed_request_ids).toEqual([]);
    const item = readTx(store, (tx) => tx.getWorkItem(requestId('r-wait')));
    expect(item?.status).toBe('waiting_dependency');
    expect(item?.blocker_reason).toEqual({ kind: 'waiting_dependency', detail: '等 r-dep 的结果' });
  });
});
