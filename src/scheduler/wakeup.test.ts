import { describe, expect, it } from 'vitest';

import { markDependencyResolutionInput } from '../inbox/index.js';
import { PersistenceError } from '../protocol/index.js';
import type { SchedulerWakeupPort } from './wakeup.js';
import {
  INSTANCE_C,
  TASK_ID,
  buildScheduler,
  buildStore,
  countEvents,
  factsOf,
  readTx,
  registerInstance,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';

/**
 * 给 D05 的唤醒端口（R16.2）与"依赖解除的唤醒侧"。
 *
 * 这里同时**证明 D02 的缺口确实存在**：只调 `markDependencyResolutionInput()` 时，
 * 可运行输入被登记了，但**没有排队标记、没有 `dependency_resolved` 待投递事件**——
 * 实例因此不会被唤醒（这正是 R16.2 要求 D03 补的那一半）。
 */
describe('依赖解除的唤醒侧（R16.2：D02 缺的那一半由 D03 补齐）', () => {
  it('只登记标记（D02 的缺口）：可运行输入存在，但没有唤醒信号', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    // 故意只用 D02 的 `markDependencyResolutionInput()`（缺口形状）
    store.transact((tx) =>
      markDependencyResolutionInput(tx, { instance_id: INSTANCE_C, ref_id: 'r-dep', at: 0 as never }),
    );

    // 可运行输入**确实**存在（D02 登记成功）
    expect(scheduler.hasRunnableInput(INSTANCE_C)).toBe(true);
    // 但没有任何唤醒信号：不排队、不写待投递事件
    expect(factsOf(scheduler).queued_flags).toEqual([false]);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(0);
    expect(factsOf(scheduler).pending_delivery_event_kinds).toEqual([]);
  });

  it('走 D03 的唤醒端口：登记标记 + 写 dependency_resolved 事件 + 置排队标记（同一事务）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const outcome = scheduler.wakeOnDependencyResolved({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      ref_id: 'r-dep',
      reason: 'r-dep 的结果到达',
    });

    expect(outcome.marked_actionable_input?.source).toBe('dependency_resolution');
    expect(outcome.marked_actionable_input?.ref_id).toBe('r-dep');
    expect(outcome.queued).toBe(true);
    expect(outcome.merged).toBe(false);
    expect(outcome.delivery_events.map((event) => event.kind)).toEqual([
      'dependency_resolved',
      'wakeup_queued',
    ]);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
    expect(factsOf(scheduler).queued_flags).toEqual([true]);
    // 事务提交后才发布
    expect(scheduler.pendingDeliveryEvents()).toEqual([]);

    // 该可运行输入真的进入下一轮快照（Q5-c：不作为新消息入箱）
    const step = scheduler.advanceOnce();
    expect(step.startedRuns).toBe(1);
    expect(step.run?.frozen_actionable_input_refs).toEqual(['r-dep']);
    expect(step.run?.frozen_input_message_ids).toEqual([]);
    // 抢占排队项 → 清除事件（峰值计算的减法端）
    expect(countEvents(scheduler, 'delegation_queue_cleared')).toBe(1);
  });

  it('幂等：同一 ref_id 重复登记不翻倍标记，也不重复写待投递事件', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.wakeOnDependencyResolved({ task_id: TASK_ID, instance_id: INSTANCE_C, ref_id: 'r-dep' });
    const second = scheduler.wakeOnDependencyResolved({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      ref_id: 'r-dep',
    });

    expect(second.marked_actionable_input).not.toBeNull();
    expect(second.merged).toBe(true);
    expect(second.delivery_events).toEqual([]);
    expect(store.snapshot().actionable_inputs).toHaveLength(1);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
  });

  it('运行中的依赖解除：登记标记但**合并**唤醒（本轮结束后至多一次排队）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();

    const merged = scheduler.wakeOnDependencyResolved({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      ref_id: 'r-dep',
      reason: '依赖解除（运行中到达）',
    });

    expect(merged.queued).toBe(false);
    expect(merged.merged).toBe(true);
    // 标记仍然登记（它是"新的可运行输入"，不会被合并掉）
    expect(merged.marked_actionable_input?.ref_id).toBe('r-dep');
    expect(merged.delivery_events.map((event) => event.kind)).toEqual(['dependency_resolved']);

    const finish = scheduler.finishRun({
      run_id: step.run?.run_id ?? ('run-1' as never),
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });
    // 本轮结束后**至多一次**后续运行机会
    expect(finish.queued_next_run).toBe(true);
    expect(factsOf(scheduler).queued_flags).toEqual([true]);

    const next = scheduler.advanceOnce();
    expect(next.run?.frozen_actionable_input_refs).toEqual(['r-dep']);
    // 该标记已被本轮消费，不会反复排队
    const consumed = readTx(store, (tx) => tx.getActionableInputs(INSTANCE_C));
    expect(consumed.map((mark) => mark.consumed_in_run_id)).toEqual([next.run?.run_id]);
  });

  it('通用唤醒端口：有新的可运行输入 → 至多一次运行机会（重复调用被合并）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const first = scheduler.requestWakeup({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      reason: '新证据到达',
      label: 'evidence-1',
    });
    const second = scheduler.requestWakeup({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      reason: '又一条新证据',
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.merged).toBe(true);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
    expect(first.delivery_events.map((event) => event.kind)).toEqual(['wakeup_queued']);
  });

  it('端口形状对 D05 可用：结构兼容的自建接口即可接上（D05 不需要 import 本模块）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    // D05 侧只会看到这样的形状（这里刻意不引用 Scheduler 类型）
    const port: SchedulerWakeupPort = scheduler;
    const outcome = port.wakeOnDependencyResolved({
      task_id: TASK_ID,
      instance_id: INSTANCE_C,
      ref_id: 'r-a05-LB',
      reason: 'jLB 的结果到达，唤醒等待方',
    });

    expect(outcome.queued).toBe(true);
    expect(port.requestWakeup({ task_id: TASK_ID, instance_id: INSTANCE_C, reason: '空转检查' }).merged).toBe(
      true,
    );
  });

  it('未注册实例的唤醒请求 → 未接受（事务回滚，不静默丢弃唤醒）', () => {
    const store = buildStore();
    const scheduler = buildScheduler(store);

    const expectRolledBack = (work: () => unknown): void => {
      let caught: unknown;
      try {
        work();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PersistenceError);
      const failure = caught as PersistenceError;
      expect(failure.accepted).toBe(false);
      expect((failure.cause as Error).message).toMatch(/未注册/);
    };

    expectRolledBack(() =>
      scheduler.wakeOnDependencyResolved({
        task_id: TASK_ID,
        instance_id: INSTANCE_C,
        ref_id: 'r-dep',
      }),
    );
    expectRolledBack(() =>
      scheduler.requestWakeup({ task_id: TASK_ID, instance_id: INSTANCE_C, reason: '未注册实例' }),
    );
    // 回滚后不留任何痕迹
    expect(factsOf(scheduler).queued_flags).toEqual([]);
    expect(store.snapshot().actionable_inputs).toEqual([]);
  });
});
