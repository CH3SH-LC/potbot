import { describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  createIdSource,
  createInstanceState,
  createWorkItem,
  type InstanceId,
} from '../protocol/index.js';
import { SchedulerAdvanceSeam } from '../fake/index.js';
import { appendKernelEvent, enqueueDeliveryEvent, queueEnqueuedEvent } from './kernel-events.js';
import type { Scheduler } from './scheduler.js';
import {
  GROUP_ID,
  INSTANCE_C,
  SENDER_S1,
  SENDER_S2,
  SENDER_S3,
  SENDER_S4,
  TASK_ID,
  buildScheduler,
  buildStore,
  countEvents,
  factsOf,
  registerInstance,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';

/**
 * 合并唤醒（`design-01-P1` / `P3`）——用**夹具持有推进权**的方式复现 A02 / A02-L / A03 的形状：
 * 投递只入箱与入队，**绝不启动轮次**；轮次只能由显式的推进放行点启动。
 */
describe('A02 形状：多成员请求空闲实例', () => {
  it('4 条投递全部在第一次冻结之前到达 → 同轮处理、总轮次 1、峰值活动轮次 1', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const senders = [SENDER_S1, SENDER_S2, SENDER_S3, SENDER_S4];
    const outcomes = senders.map((sender, index) =>
      scheduler.onMessage(workRequest(index + 1, { sender_instance_id: sender })),
    );

    // A02-09：4 次投递全部「已接受」，没有一次因已有活动轮次/排队标记被丢弃
    expect(outcomes.map((outcome) => outcome.result)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    // 合并的是运行机会：三条被合并进同一个排队标记
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
    // 放行点 R1 之前，内核一次轮次都没启动
    expect(factsOf(scheduler).runs).toEqual([]);

    const first = scheduler.advanceOnce();
    expect(first.startedRuns).toBe(1);
    // A02-07：唯一一轮的冻结快照包含全部 4 条（证明是同轮处理）
    expect(first.run?.frozen_input_message_ids).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(first.run?.frozen_request_ids).toEqual(['r-1', 'r-2', 'r-3', 'r-4']);

    const finish = scheduler.finishRun({
      run_id: first.run?.run_id ?? ('run-1' as never),
      publications: [1, 2, 3, 4].map((n) => ({
        kind: 'completed' as const,
        request_id: requestId(`r-${n}`),
        result_refs: [resultRef(requestId(`r-${n}`))],
      })),
    });
    expect(finish.applied_request_ids).toEqual(['r-1', 'r-2', 'r-3', 'r-4']);
    expect(finish.queued_next_run).toBe(false);

    // R2…R6：空推进不产生新轮次
    const empties = [1, 2, 3, 4, 5].map(() => scheduler.advanceOnce());
    expect(empties.every((step) => step.startedRuns === 0)).toBe(true);

    const facts = factsOf(scheduler);
    expect(facts.unique_inbox_message_ids).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(facts.work_items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    // A02-12：4 项工作各有与其 request_id 匹配的结果引用（不是靠"一条都不处理"）
    expect(facts.work_items.map((item) => item.result_refs)).toEqual([
      ['r-1#result'],
      ['r-2#result'],
      ['r-3#result'],
      ['r-4#result'],
    ]);
    expect(facts.active_run_ids).toEqual([null]);
    expect(facts.queued_flags).toEqual([false]);

    const counters = scheduler.summarize();
    expect(counters.run_count).toBe(1);
    expect(counters.peak_active_runs).toBe(1);
    expect(counters.peak_queued_flags).toBe(1);
    expect(counters.inbox_message_count).toBe(4);
    expect(counters.rejected_publication_count).toBe(0);
  });

  it('A02-L 形状：冻结之后到达的输入合法地产生**一次**后续轮次（不吞消息）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const first = scheduler.advanceOnce();
    expect(first.run?.frozen_input_message_ids).toEqual(['m-1']);

    // 首轮活动期间顺序投递 3 条后到消息
    const late = [2, 3, 4].map((n) =>
      scheduler.onMessage(workRequest(n, { sender_instance_id: SENDER_S2 })),
    );
    expect(late.every((outcome) => outcome.result === 'accepted')).toBe(true);
    // A02-L-03：首轮进行期间「入队」事件数 = 0（≤1）
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1); // 仍是 m-1 那次
    expect(late.every((outcome) => outcome.merged_wakeup && !outcome.queued)).toBe(true);

    const finishFirst = scheduler.finishRun({
      run_id: first.run?.run_id ?? ('run-1' as never),
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });
    // 本轮结束后**至多一次**后续运行机会
    expect(finishFirst.queued_next_run).toBe(true);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(2);

    const second = scheduler.advanceOnce();
    expect(second.startedRuns).toBe(1);
    expect(second.run?.frozen_input_message_ids).toEqual(['m-2', 'm-3', 'm-4']);
    const finishSecond = scheduler.finishRun({
      run_id: second.run?.run_id ?? ('run-2' as never),
      publications: [2, 3, 4].map((n) => ({
        kind: 'completed' as const,
        request_id: requestId(`r-${n}`),
        result_refs: [resultRef(requestId(`r-${n}`))],
      })),
    });
    expect(finishSecond.queued_next_run).toBe(false);

    // A02-L-04：总轮次 = 2；A02-L-02：收件箱 4 条一条不少
    expect([1, 2].map(() => scheduler.advanceOnce()).every((step) => step.startedRuns === 0)).toBe(true);
    const counters = scheduler.summarize();
    expect(counters.run_count).toBe(2);
    expect(counters.peak_active_runs).toBe(1);
    expect(counters.peak_queued_flags).toBe(1);
    expect(counters.inbox_message_count).toBe(4);
  });
});

describe('A03 形状：运行中连续唤醒（合并运行机会，不合并请求）', () => {
  it('运行中到达 3 条：保留 3 项工作、运行中 0 次入队、结束后至多一次排队、共 2 轮', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(0));
    const first = scheduler.advanceOnce();
    expect(first.run?.frozen_input_message_ids).toEqual(['m-0']);
    const enqueuedAfterFirstStart = countEvents(scheduler, 'delegation_queue_enqueued');

    const late = [1, 2, 3].map((n) => scheduler.onMessage(workRequest(n)));
    expect(late.every((outcome) => outcome.result === 'accepted')).toBe(true);
    expect(late.every((outcome) => outcome.merged_wakeup)).toBe(true);
    // A03-03：首轮活动期间「入队」事件数 = 0（≤1）
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(enqueuedAfterFirstStart);

    // A03-04：首轮快照不含后到三条；A03-09：3 项后到工作没有被合并成 1 项
    expect(first.run?.frozen_input_message_ids).toEqual(['m-0']);
    expect(factsOf(scheduler).work_items.map((item) => item.status)).toEqual([
      'processing',
      'pending',
      'pending',
      'pending',
    ]);

    const finishFirst = scheduler.finishRun({
      run_id: first.run?.run_id ?? ('run-1' as never),
      publications: [
        { kind: 'completed', request_id: requestId('r-0'), result_refs: [resultRef(requestId('r-0'))] },
      ],
    });
    expect(finishFirst.queued_next_run).toBe(true);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(enqueuedAfterFirstStart + 1);

    // A03-07：run-2 的快照包含全部 3 条后到消息
    const second = scheduler.advanceOnce();
    expect(second.startedRuns).toBe(1);
    expect(second.run?.frozen_input_message_ids).toEqual(['m-1', 'm-2', 'm-3']);
    const finishSecond = scheduler.finishRun({
      run_id: second.run?.run_id ?? ('run-2' as never),
      publications: [1, 2, 3].map((n) => ({
        kind: 'completed' as const,
        request_id: requestId(`r-${n}`),
        result_refs: [resultRef(requestId(`r-${n}`))],
      })),
    });
    expect(finishSecond.queued_next_run).toBe(false);

    // A03-11：场景结束时无活动轮次、排队标记 = 0，且再空推进不产生新轮次
    expect([1, 2, 3].map(() => scheduler.advanceOnce()).every((step) => step.startedRuns === 0)).toBe(true);
    const facts = factsOf(scheduler);
    expect(facts.active_run_ids).toEqual([null]);
    expect(facts.queued_flags).toEqual([false]);
    expect(facts.unique_inbox_message_ids).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
    expect(facts.work_items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);

    const counters = scheduler.summarize();
    expect(counters.run_count).toBe(2);
    expect(counters.peak_active_runs).toBe(1);
    expect(counters.peak_queued_flags).toBe(1);
    expect(counters.inbox_message_count).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 受控缺陷注入（合同 R7：只在测试内实现缺陷形状，不进生产路径）
// 目的：证明"关键断言在该缺陷下真会变红"。
// ---------------------------------------------------------------------------

/** 缺陷形状 I-A02-2：目标实例已有活动轮次或排队标记时**直接丢弃**本条消息。 */
function defectiveDropWhenBusy(scheduler: Scheduler, message: ReturnType<typeof workRequest>): 'dropped' | 'handled' {
  const busy = scheduler
    .snapshot()
    .instances.some(
      (instance) =>
        instance.instance_id === message.recipient_instance_id &&
        (instance.active_run_id !== null || instance.queued_flag),
    );
  if (busy) {
    return 'dropped';
  }
  scheduler.onMessage(message);
  return 'handled';
}

/** 缺陷形状 I-A03-2：去掉"已有排队标记则不再入队"的保护，每条消息各自入队一次。 */
function defectiveEnqueueAlways(
  store: ReturnType<typeof buildStore>,
  instanceId: InstanceId,
  at: number,
): void {
  const idSource = createIdSource({ seed: 'defect' });
  store.transact((tx) => {
    const instance = tx.getInstance(instanceId);
    if (instance === undefined) {
      throw new Error('实例应已注册');
    }
    enqueueDeliveryEvent(
      tx,
      {
        kind: 'wakeup_queued',
        task_id: TASK_ID,
        group_id: GROUP_ID,
        instance_id: instance.instance_id,
        created_at: asLogicalTime(at),
        reason: '缺陷注入：无保护入队',
      },
      idSource,
    );
    appendKernelEvent(
      tx,
      queueEnqueuedEvent({ instance_id: instance.instance_id, at: asLogicalTime(at) }),
      idSource,
    );
    tx.putInstance(
      createInstanceState({
        ...instance,
        queued_flag: true,
        queued_since: asLogicalTime(at),
        updated_at: asLogicalTime(at),
      }),
    );
  });
}

/** 已完成却没有结果引用的项（"读即完成"缺陷的探测器；P4-10 / A03-10）。 */
function completedWithoutResult(scheduler: Scheduler): readonly string[] {
  return scheduler
    .snapshot()
    .work_items.filter((item) => item.status === 'completed' && item.result_refs.length === 0)
    .map((item) => item.request_id);
}

describe('与 D06 的调度推进接缝对接（R10：夹具持有推进权）', () => {
  it('投递只登记提交、**不**触发推进；bind(advanceOnce) 后一次推进启动至多一个轮次', async () => {
    const store = buildStore();
    registerInstance(store);
    const seam = new SchedulerAdvanceSeam();
    const scheduler = buildScheduler(store, {
      // 一行接线：字段形状与 D06 的 DeliveryCommitInput 对齐
      onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result }),
    });
    seam.bind(() => scheduler.advanceOnce());

    scheduler.onMessage(workRequest(1));
    scheduler.onMessage(workRequest(2));

    // 两次投递都发生在**任何**推进之前（A02「全部投递在快照冻结前到达」的结构性前提）
    expect(seam.deliveries).toHaveLength(2);
    expect(seam.advanceSeq).toBe(0);
    expect(seam.assertAllDeliveriesBefore(0)).toBeUndefined();
    expect(seam.deliveries.map((note) => note.advanceSeq)).toEqual([0, 0]);
    expect(factsOf(scheduler).runs).toEqual([]);

    const record = await seam.advanceOnce('R1');
    expect(record.startedRuns).toBe(1);
    expect(seam.startedRuns).toBe(1);

    // 运行中到达的投递被记为"冻结之后"（A02-L / A03 归属语义）
    scheduler.onMessage(workRequest(3));
    expect(seam.deliveries[2]?.advanceSeq).toBe(1);
    expect(() => seam.assertAllDeliveriesBefore(0)).toThrow(/第 0 次推进之后/);

    // 结束首轮后：后到的那条产生至多一次后续机会，随后推进会空推进收敛
    scheduler.finishRun({ run_id: 'run-1' as never });
    const idle = await seam.advanceUntilIdle();
    expect(idle[idle.length - 1]?.startedRuns).toBe(0);
  });
});

describe('受控缺陷注入：证明断言真的会失败（R7）', () => {
  it('I-A02-2「丢一条请求」：收件箱条数（守恒主判据）真的变红', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const results = [1, 2, 3, 4].map((n) => defectiveDropWhenBusy(scheduler, workRequest(n)));

    expect(results).toEqual(['handled', 'dropped', 'dropped', 'dropped']);
    // 正确实现下这里是 4（A02-04）；缺陷实现下只有 1 → 断言确实能击穿缺陷
    expect(factsOf(scheduler).unique_inbox_message_ids).toEqual(['m-1']);
    expect(factsOf(scheduler).unique_inbox_message_ids).not.toHaveLength(4);
    expect(factsOf(scheduler).work_items).toHaveLength(1);
  });

  it('I-A03-2「重复排队」：运行中入队事件数真的超过 1 → A03-03 会红', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(0));
    scheduler.advanceOnce();
    const before = countEvents(scheduler, 'delegation_queue_enqueued');

    for (const n of [1, 2, 3]) {
      defectiveEnqueueAlways(store, INSTANCE_C, n);
    }

    const after = countEvents(scheduler, 'delegation_queue_enqueued');
    expect(after - before).toBe(3);
    // A03-03 的判据是"首轮活动期间入队事件数 ≤ 1"：缺陷下为 3 → 真会变红
    expect(after - before).toBeGreaterThan(1);
    // 正确实现下同一步骤是同一条断言的反面（见 A03 主场景：delta = 0）
    expect(countEvents(scheduler, 'delegation_queue_cleared')).toBe(1);
  });

  it('I-A03-3「读即完成」：已完成但无结果引用的项真的会出现 → A03-10 会红', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();

    // 正确实现：认领后仍是 processing，没有"已完成却无结果引用"的项
    expect(completedWithoutResult(scheduler)).toEqual([]);

    // 缺陷注入：轮次读取消息后直接把工作项置为「已完成」，不留结果引用
    store.transact((tx) => {
      const item = tx.getWorkItem(requestId('r-1'));
      if (item === undefined) throw new Error('工作项应已存在');
      tx.putWorkItem(
        createWorkItem({
          request_id: item.request_id,
          task_id: item.task_id,
          task_revision: item.task_revision,
          owner_instance_id: item.owner_instance_id,
          description: item.description,
          status: 'completed',
          blocker_reason: null,
          created_at: item.created_at,
          updated_at: asLogicalTime(1),
        }),
      );
    });

    expect(completedWithoutResult(scheduler)).toEqual(['r-1']);
    expect(step.run?.frozen_request_ids).toEqual(['r-1']);
  });
});
