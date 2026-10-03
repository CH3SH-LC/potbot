import { describe, expect, it } from 'vitest';

import { PublicationError, asGroupId, asRevision } from '../protocol/index.js';
import { SchedulerAdvanceSeam } from '../fake/index.js';
import { rejectingSenderAuthenticator } from './on-message.js';
import {
  INSTANCE_C,
  SENDER_S1,
  TASK_ID,
  buildMessage,
  buildScheduler,
  buildStore,
  countEvents,
  factsOf,
  instanceId,
  messageId,
  readTx,
  registerInstance,
  registerMember,
  registerTask,
  requestId,
  workRequest,
} from './test-support.js';

/**
 * `on_message` 入口事务编排（P1/P2/P8 的入口侧；合同 §六、§九-1/§九-4、R2）。
 * 这些断言全部经只读快照与门面读取，不窥探内核内部内存。
 */
describe('on_message：落库 + 建工作项 + 合并唤醒（同一事务）', () => {
  it('工作请求：一条消息 → 收件箱 1 条 + 工作项 1 项 + 排队标记 + 待投递事件', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const outcome = scheduler.onMessage(workRequest(1));

    expect(outcome.result).toBe('accepted');
    expect(outcome.work_item_created).toBe(true);
    expect(outcome.work_item?.status).toBe('pending');
    expect(outcome.work_item?.owner_instance_id).toBe(INSTANCE_C);
    // 非终态必须带等待/阻塞原因（工作项形状不变量）
    expect(outcome.work_item?.blocker_reason?.detail.length).toBeGreaterThan(0);
    expect(outcome.queued).toBe(true);
    expect(outcome.merged_wakeup).toBe(false);
    expect(outcome.delivery_events.map((event) => event.kind)).toEqual(['wakeup_queued']);

    const facts = factsOf(scheduler);
    expect(facts.unique_inbox_message_ids).toEqual(['m-1']);
    expect(facts.work_items.map((item) => [item.request_id, item.status])).toEqual([['r-1', 'pending']]);
    expect(facts.queued_flags).toEqual([true]);
    expect(facts.active_run_ids).toEqual([null]);
    expect(countEvents(scheduler, 'message_accepted')).toBe(1);
    expect(countEvents(scheduler, 'work_item_created')).toBe(1);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
    // 事务提交后才发布：投递事件不再待投递
    expect(scheduler.pendingDeliveryEvents()).toEqual([]);
  });

  it('入口**绝不启动轮次**：投递只置可运行输入与排队标记（附录 B 的 on_message）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    scheduler.onMessage(workRequest(2));

    expect(factsOf(scheduler).runs).toEqual([]);
    expect(factsOf(scheduler).active_run_ids).toEqual([null]);
    // 三条入队事件被合并成一次（§9.1：最多一个排队标记）
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
  });

  it('重复 message_id：不重复建工作、不覆盖首次记录、不重复入队', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const first = scheduler.onMessage(workRequest(1));
    const second = scheduler.onMessage(workRequest(1, { content: '内容被改写过的重复送达' }));

    expect(first.result).toBe('accepted');
    expect(second.result).toBe('duplicate_not_created');
    expect(second.duplicate_of).toBe('m-1');
    expect(second.work_item).toBeNull();
    expect(second.inbox_entry).toBeNull();

    const facts = factsOf(scheduler);
    // 收件箱条数（A04-01 的主判据口径）：append 数组，不去重就会翻倍
    expect(facts.unique_inbox_message_ids).toEqual(['m-1']);
    expect(facts.inbox_message_ids).toHaveLength(1);
    expect(facts.work_items).toHaveLength(1);
    expect(countEvents(scheduler, 'work_item_created')).toBe(1);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(1);
    expect(countEvents(scheduler, 'message_duplicate_rejected')).toBe(1);
    // 首次到达的记录未被覆盖（Q1-d / R15 的 A04-06）
    expect(store.snapshot().messages[0]?.payload).toMatchObject({ content: '独立工作 j1' });
  });

  it('A04 形状：同一 message_id 投递 5 次 → 收件箱恰好 1 条（R15 的主判据口径）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const deliveries = [1, 2, 3, 4, 5].map(() => scheduler.onMessage(workRequest(1)));

    expect(deliveries[0]?.result).toBe('accepted');
    expect(deliveries.slice(1).map((outcome) => outcome.result)).toEqual([
      'duplicate_not_created',
      'duplicate_not_created',
      'duplicate_not_created',
      'duplicate_not_created',
    ]);
    // 无一返回 failed（幂等去重 ≠ 报错拒绝，A04-04）
    expect(deliveries.every((outcome) => outcome.result !== 'failed')).toBe(true);
    // 收件箱条数：append 数组，不去重就会是 5
    expect(factsOf(scheduler).inbox_message_ids).toHaveLength(1);
    expect(factsOf(scheduler).work_items).toHaveLength(1);
    expect(countEvents(scheduler, 'work_item_created')).toBe(1);
    // R15：D08 观测的口径必须是**收件箱条数**（这里就是唯一权威实现算出来的值）
    expect(scheduler.eventCounters().inbox_message_count).toBe(1);
  });

  it('A04 对照组：内容相同但 id 不同 → 各自独立保留（不按内容合并）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1, { content: '独立工作 jD，期望产物 pD' }));
    const second = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-2'),
        request_id: requestId('r-2'),
        type: 'work_request',
        content: '独立工作 jD，期望产物 pD', // 与上一条逐字相同
      }),
    );

    expect(second.result).toBe('accepted');
    expect(factsOf(scheduler).unique_inbox_message_ids).toEqual(['m-1', 'm-2']);
    expect(factsOf(scheduler).work_items.map((item) => item.request_id)).toEqual(['r-1', 'r-2']);
  });

  it('R29.2：事务已提交但发布中断 → 这次投递**仍然**出现在接缝登记里', () => {
    const store = buildStore();
    registerInstance(store);
    const seam = new SchedulerAdvanceSeam();
    const scheduler = buildScheduler(store, {
      onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result }),
    });
    store.faults.afterCommitBeforePublish = () => {
      throw new Error('DEFECT 演示：事务已提交，但发布前中断');
    };

    let thrown: unknown = null;
    try {
      scheduler.onMessage(workRequest(1));
    } catch (error) {
      thrown = error;
    }

    // 两类失败可区分：已接受（消息与 outbox 已落盘），只是没有发布到执行队列
    expect(thrown).toBeInstanceOf(PublicationError);
    expect((thrown as PublicationError).accepted).toBe(true);
    expect((thrown as PublicationError).undelivered_event_ids.length).toBeGreaterThan(0);
    expect(store.snapshot().inbox_entries).toHaveLength(1);

    // **R29.2 的修**:已 committed ⇒ 登记必然存在（不再"因发布失败而消失"）
    expect(seam.deliveries).toHaveLength(1);
    expect(seam.deliveriesBeforeAdvance()).toHaveLength(1);
    expect(seam.deliveries[0]?.message_id).toBe('m-1');
    expect(seam.deliveries[0]?.advanceSeq).toBe(0);

    // 恢复路径：补投成功（登记不会因此重复）
    store.faults.afterCommitBeforePublish = undefined;
    expect(scheduler.publishPendingEvents()).toHaveLength(1);
    expect(seam.deliveries).toHaveLength(1);
  });

  it('R2：stage_result 不唤醒、不入队，但仍会被后续轮次读入（不滞留）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const quiet = scheduler.onMessage(
      buildMessage({ message_id: messageId('m-q1'), type: 'stage_result', requires_wakeup: false }),
    );

    expect(quiet.result).toBe('accepted');
    expect(quiet.queued).toBe(false);
    expect(factsOf(scheduler).queued_flags).toEqual([false]);
    expect(countEvents(scheduler, 'delegation_queue_enqueued')).toBe(0);
    expect(scheduler.hasRunnableInput(INSTANCE_C)).toBe(false);
    // 公共进度**不构成运行机会**，但仍是收件箱里的真实消息
    expect(factsOf(scheduler).unique_inbox_message_ids).toEqual(['m-q1']);

    // 一条工作请求到达后，公共进度与它**同轮**被读入（读入 ≠ 完成）
    scheduler.onMessage(workRequest(2));
    const step = scheduler.advanceOnce();
    expect(step.startedRuns).toBe(1);
    expect(step.run?.frozen_input_message_ids).toEqual(['m-q1', 'm-2']);
    expect(step.run?.frozen_request_ids).toEqual(['r-2']);
  });

  it('P8 负向：路由指向未注册实例 → 未接受（failed），消息不进入有效收件箱', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const outcome = scheduler.onMessage(workRequest(1, { recipient_instance_id: instanceId('X') }));

    expect(outcome.result).toBe('failed');
    expect(outcome.failure_reason).toMatch(/未注册/);
    const facts = factsOf(scheduler);
    expect(facts.inbox_message_ids).toEqual([]);
    expect(facts.work_items).toEqual([]);
    expect(facts.kernel_event_kinds).toEqual([]);
    expect(facts.pending_delivery_event_kinds).toEqual([]);
  });

  it('P8 负向：路由到别群实例 → 未接受（failed）', () => {
    const store = buildStore();
    registerInstance(store);
    // 发送者是 G2 的**合法成员**（否则先被 F07 的成员资格判据拦下，
    // 就测不到"路由必须解析为**本群内**的实例"这条判据）。
    registerMember(store, SENDER_S1, asGroupId('G2'));
    const scheduler = buildScheduler(store);

    const outcome = scheduler.onMessage(workRequest(1, { group_id: asGroupId('G2') }));

    expect(outcome.result).toBe('failed');
    expect(outcome.failure_reason).toMatch(/本群内/);
    expect(factsOf(scheduler).inbox_message_ids).toEqual([]);
  });

  it('P8 负向：伪造发送者（注入拒绝式鉴权器）→ 未接受，且不产生业务工作', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    const outcome = scheduler.onMessage(workRequest(1), {
      authenticator: rejectingSenderAuthenticator(),
    });

    expect(outcome.result).toBe('failed');
    const facts = factsOf(scheduler);
    expect(facts.inbox_message_ids).toEqual([]);
    expect(facts.work_items).toEqual([]);
  });

  it('Q1-b：陈旧版本消息只入库留历史，不产生业务工作、不唤醒', () => {
    const store = buildStore();
    registerInstance(store);
    registerTask(store, { revision: asRevision(2) });
    const scheduler = buildScheduler(store);

    const outcome = scheduler.onMessage(workRequest(1, { task_revision: asRevision(1) }));

    expect(outcome.result).toBe('accepted');
    expect(outcome.stale_revision).toBe(true);
    expect(outcome.work_item).toBeNull();
    expect(outcome.queued).toBe(false);
    const facts = factsOf(scheduler);
    expect(facts.unique_inbox_message_ids).toEqual(['m-1']);
    expect(facts.work_items).toEqual([]);
    expect(facts.queued_flags).toEqual([false]);
    expect(countEvents(scheduler, 'message_rejected')).toBe(1);
  });

  it('版本高于当前任务版本的消息 → 未接受（不可能的来源）', () => {
    const store = buildStore();
    registerInstance(store);
    registerTask(store, { revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    const outcome = scheduler.onMessage(workRequest(1, { task_revision: asRevision(3) }));

    expect(outcome.result).toBe('failed');
    expect(outcome.failure_reason).toMatch(/高于当前版本/);
    expect(factsOf(scheduler).inbox_message_ids).toEqual([]);
  });

  it('§9.3：取消在同一事务内同步生效（工作项转终态 + 任务控制状态），且不产生运行机会', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();
    expect(step.run?.frozen_request_ids).toEqual(['r-1']);

    const cancel = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-cancel'),
        type: 'cancel',
        request_id: requestId('r-1'),
        reply_to: requestId('r-1'),
        content: '用户取消',
        payload: { reason: '用户改主意了' },
      }),
    );

    expect(cancel.result).toBe('accepted');
    expect(cancel.queued).toBe(false);
    expect(factsOf(scheduler).work_items.map((item) => item.status)).toEqual(['cancelled']);

    const control = readTx(store, (tx) => tx.getTaskControlState(TASK_ID));
    expect(control?.cancelled).toBe(true);
    expect(control?.cancel_reason).toBe('用户改主意了');
    expect(control?.cancelled_by_message_id).toBe('m-cancel');
    expect(countEvents(scheduler, 'task_control_state_updated')).toBe(1);
    // 取消消息的收件箱条目是**安静条目**（§9.3：不作为普通群消息排队）
    expect(store.snapshot().inbox_entries.map((entry) => entry.requires_wakeup)).toEqual([true, false]);
    // 运行中的取消：不置排队标记（运行机会已占用）
    expect(factsOf(scheduler).queued_flags).toEqual([false]);
  });

  it('§9.3：需求更新写入任务控制状态并保持唤醒（运行中时被合并）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();

    const update = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-update'),
        type: 'requirement_update',
        content: '人数从八人改为十人',
      }),
    );

    expect(update.result).toBe('accepted');
    const control = readTx(store, (tx) => tx.getTaskControlState(TASK_ID));
    expect(control?.requirement_update_pending).toBe(true);
    expect(control?.cancelled).toBe(false);
    // 运行中：唤醒被合并（消息保留，本轮结束后统一进入下一轮）
    expect(update.merged_wakeup).toBe(true);
    expect(update.queued).toBe(false);
  });

  it('同一 request_id 的第二条消息：不重复建工作，只登记触发消息', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));

    const second = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-1b'),
        request_id: requestId('r-1'),
        type: 'work_request',
        content: '同一请求的另一条消息',
      }),
    );

    expect(second.result).toBe('accepted');
    expect(second.work_item_created).toBe(false);
    const items = store.snapshot().work_items;
    expect(items).toHaveLength(1);
    expect(items[0]?.triggering_message_ids).toEqual(['m-1', 'm-1b']);
    expect(countEvents(scheduler, 'work_item_created')).toBe(1);
  });
});
