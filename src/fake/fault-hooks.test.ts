import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../storage/index.js';
import {
  PersistenceError,
  PublicationError,
  SenderBinding,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createInboxEntry,
  createInstanceState,
  createMessage,
  createWorkItem,
  nextInboxSequence,
  type EventId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Store,
} from '../protocol/index.js';
import {
  FaultInjector,
  INJECTION_POINTS,
  InjectedFailure,
  InjectedInterrupt,
  STORE_HOOK_POINTS,
  attemptRecovery,
  runRecoveryAttempts,
  storeFaultHooks,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const SENDER = asInstanceId('S1');
const C = asInstanceId('C');
const REV1 = asRevision(1);
const T = (n: number): LogicalTime => asLogicalTime(n);

/** 在**同一事务**内写入：消息 + 收件箱 + 工作项 + 排队事件（合同 §九-1 的一致提交）。 */
function deliverRequest(
  store: Store,
  options: { messageId: MessageId; requestId: RequestId; enqueue: boolean },
): void {
  const ids = createIdSource({ seed: 'd06' });
  const message = createMessage(
    {
      message_id: options.messageId,
      task_id: TASK,
      group_id: GROUP,
      task_revision: REV1,
      recipient_instance_id: C,
      type: 'work_request',
      request_id: options.requestId,
      requires_wakeup: true,
      created_at: T(0),
    },
    SenderBinding.bind(SENDER, { group_id: GROUP, task_id: TASK }),
    { idSource: ids },
  );
  const workItem = createWorkItem({
    request_id: options.requestId,
    task_id: TASK,
    task_revision: REV1,
    owner_instance_id: C,
    created_at: T(0),
    status: 'pending',
    blocker_reason: { kind: 'waiting_user', detail: '尚未开始' },
    triggering_message_ids: [options.messageId],
  });
  const event = createDeliveryEvent(
    {
      kind: 'wakeup_queued',
      task_id: TASK,
      group_id: GROUP,
      instance_id: C,
      created_at: T(0),
      reason: '新的工作请求',
    },
    ids,
  );

  store.transact((tx) => {
    tx.putMessage(message);
    tx.appendInboxEntry(
      createInboxEntry({
        message_id: options.messageId,
        instance_id: C,
        group_id: GROUP,
        task_id: TASK,
        sequence: nextInboxSequence(tx.getInbox(C)),
        received_at: T(0),
        requires_wakeup: true,
      }),
    );
    tx.putWorkItem(workItem);
    tx.putInstance(
      createInstanceState({
        instance_id: C,
        group_id: GROUP,
        updated_at: T(0),
        queued_flag: true,
        queued_since: T(0),
        inbox_message_ids: [options.messageId],
        pending_request_ids: [options.requestId],
      }),
    );
    if (options.enqueue) tx.enqueueDeliveryEvent(event);
  });
}

/** 统计 handler 收到的投递事件（P2 的「恢复后调度事件被补投且仅一次」）。 */
function countingHandler(): { handler: (event: { event_id: EventId }) => void; seen: EventId[] } {
  const seen: EventId[] = [];
  return {
    seen,
    handler: (event) => {
      seen.push(event.event_id);
    },
  };
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('storeFaultHooks：默认关闭时三个钩子都是空操作', () => {
  it('注入器未启用 → 事务与发布都正常（默认路径零语义变化）', () => {
    const injector = new FaultInjector();
    const store = createMemoryStore({ faults: storeFaultHooks(injector) });
    deliverRequest(store, { messageId: asMessageId('m-1'), requestId: asRequestId('r-1'), enqueue: true });
    const { handler, seen } = countingHandler();
    const published = store.publishPending(handler);
    expect(published).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(injector.firedCount).toBe(0);
    expect(store.snapshot().inbox_entries).toHaveLength(1);
  });

  it('钩子绑定的是默认注入点常量（P2 的三个窗口）', () => {
    expect(STORE_HOOK_POINTS).toEqual({
      beforeCommit: INJECTION_POINTS.messagePersist,
      afterCommitBeforePublish: INJECTION_POINTS.schedulingEventPersist,
      beforePublishEvent: INJECTION_POINTS.executionEnqueue,
    });
  });

  it('可把钩子改绑到自定义注入点（场景自定义点名）', () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: 'custom.beforeCommit', behavior: 'fail' });
    const store = createMemoryStore({
      faults: storeFaultHooks(injector, { beforeCommit: 'custom.beforeCommit' }),
    });
    expect(() =>
      deliverRequest(store, { messageId: asMessageId('m-1'), requestId: asRequestId('r-1'), enqueue: false }),
    ).toThrow(PersistenceError);
  });
});

describe('W2：消息持久化失败（beforeCommit）', () => {
  it('事务回滚 → PersistenceError（accepted=false），什么都没落库，投递不得报告已接受', () => {
    const injector = new FaultInjector({ isolated: true, scenario: 'P2-W2' });
    injector.register({ point: STORE_HOOK_POINTS.beforeCommit, behavior: 'fail', detail: '磁盘写入失败' });
    const store = createMemoryStore({ faults: storeFaultHooks(injector) });

    const error = capture(() =>
      deliverRequest(store, { messageId: asMessageId('m-p2-04'), requestId: asRequestId('r-p2-04'), enqueue: true }),
    );
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).accepted).toBe(false);

    // 收件箱、工作项、待投递事件都没有留下痕迹（P2-09）
    // （D01 的 transact() 不自动发布，因此这里无需再调 publishPending）
    const snapshot = store.snapshot();
    expect(snapshot.inbox_entries).toHaveLength(0);
    expect(snapshot.work_items).toHaveLength(0);
    expect(snapshot.delivery_events).toHaveLength(0);
    // 注入证据带上了事务上下文（哪条消息被拦下）
    expect(injector.fired[0]).toMatchObject({
      point: INJECTION_POINTS.messagePersist,
      behavior: 'fail',
      context: { hook: 'beforeCommit', message_ids: ['m-p2-04'] },
    });
  });
});

describe('W1：事务已提交、投递前被中断（afterCommitBeforePublish）', () => {
  it('抛 PublicationError（accepted=true），消息已可靠保存，恢复后补投且仅一次', () => {
    const injector = new FaultInjector({ isolated: true, scenario: 'P2-W1' });
    injector.register({
      point: STORE_HOOK_POINTS.afterCommitBeforePublish,
      behavior: 'interrupt',
      committed: ['message.persisted', 'inbox.appended', 'work_item.upserted'],
      pending: ['queue.marked', 'scheduling.event.persisted'],
      detail: '提交后、发布前的中断窗口',
    });
    const store = createMemoryStore({ faults: storeFaultHooks(injector) });

    const error = capture(() =>
      deliverRequest(store, { messageId: asMessageId('m-p2-01'), requestId: asRequestId('r-p2-01'), enqueue: true }),
    );
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).accepted).toBe(true);

    // 消息确实可靠保存（P2-01：收件箱恰好 1 条）
    expect(store.snapshot().inbox_entries).toHaveLength(1);
    expect(store.snapshot().work_items).toHaveLength(1);
    expect(store.pendingDeliveryEvents()).toHaveLength(1);
    expect((injector.fired[0] as { committed: readonly string[] }).committed).toContain(
      'message.persisted',
    );

    // 恢复：补投未投递事件
    const { handler, seen } = countingHandler();
    const runs = runRecoveryAttempts(store, handler, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ attempt: 1, pending_before: 1, published: 1, failed: false, via: 'replayUndelivered' });
    // 第二次恢复无待办，不多建业务工作（P2-04）
    expect(runs[1]).toMatchObject({ attempt: 2, pending_before: 0, published: 0, failed: false });
    expect(seen).toHaveLength(1);
    expect(store.snapshot().inbox_entries).toHaveLength(1);
    expect(store.snapshot().work_items).toHaveLength(1);
    expect(store.pendingDeliveryEvents()).toHaveLength(0);
  });

  it('恢复失败也会被如实记录（failed=true + 错误名），不静默吞掉', () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({
      point: STORE_HOOK_POINTS.beforePublishEvent,
      behavior: 'fail',
      times: 2, // 两次都会打中：首次发布 + 第一次恢复
    });
    const store = createMemoryStore({ faults: storeFaultHooks(injector) });
    const { handler } = countingHandler();

    deliverRequest(store, { messageId: asMessageId('m-1'), requestId: asRequestId('r-1'), enqueue: true });
    // 注意：D01 的 transact() **不自动发布**——发布是调用方的独立动作。
    expect(capture(() => store.publishPending(handler))).toBeInstanceOf(PublicationError);

    const first = attemptRecovery(store, handler);
    expect(first).toMatchObject({ attempt: 1, failed: true, published: 0, error_name: 'PublicationError' });
    const second = attemptRecovery(store, handler, { attempt: 2 });
    expect(second).toMatchObject({ attempt: 2, failed: false, published: 1 });
  });
});

describe('W3：逐条事件投递失败（beforePublishEvent）', () => {
  it('publishPending 失败后事件仍待投递，replayUndelivered 补投成功', () => {
    const injector = new FaultInjector({ isolated: true, scenario: 'P2-W3' });
    injector.register({
      point: STORE_HOOK_POINTS.beforePublishEvent,
      behavior: 'interrupt',
      committed: ['transaction.committed'],
      pending: ['execution.enqueued'],
    });
    const store = createMemoryStore({ faults: storeFaultHooks(injector) });

    deliverRequest(store, { messageId: asMessageId('m-p2-03'), requestId: asRequestId('r-p2-03'), enqueue: true });
    const error = capture(() => store.publishPending(countingHandler().handler));
    expect(error).toBeInstanceOf(PublicationError);
    expect(store.pendingDeliveryEvents()).toHaveLength(1);

    const { handler, seen } = countingHandler();
    const recovery = attemptRecovery(store, handler, { via: 'publishPending' });
    expect(recovery).toMatchObject({ via: 'publishPending', pending_before: 1, published: 1, failed: false });
    expect(seen).toHaveLength(1);
    expect(store.pendingDeliveryEvents()).toHaveLength(0);
    // 消息已提交且工作项有主（P2-07：不出现「已提交但事件永久丢失」）
    expect(store.snapshot().messages).toHaveLength(1);
    expect(store.snapshot().work_items).toHaveLength(1);
  });

  it('注入证据里带被拦下的事件 id（可追溯）', () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: STORE_HOOK_POINTS.beforePublishEvent, behavior: 'fail' });
    const store = createMemoryStore({ faults: storeFaultHooks(injector) });
    deliverRequest(store, { messageId: asMessageId('m-x'), requestId: asRequestId('r-x'), enqueue: true });
    capture(() => store.publishPending(countingHandler().handler));
    expect(injector.fired[0]?.context).toMatchObject({ hook: 'beforePublishEvent', delivered: false });
  });

  it('非法恢复次数显式抛错', () => {
    const store = createMemoryStore();
    expect(() => runRecoveryAttempts(store, () => {}, 0)).toThrow(RangeError);
  });
});

describe('注入失败类型可被夹具按类型捕获（区分注入与真实缺陷）', () => {
  it('InjectedFailure / InjectedInterrupt 是对外可见的类型', () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: 'p', behavior: 'fail' });
    expect(capture(() => injector.tripSync('p'))).toBeInstanceOf(InjectedFailure);
    injector.register({ point: 'q', behavior: 'interrupt' });
    expect(capture(() => injector.tripSync('q'))).toBeInstanceOf(InjectedInterrupt);
  });
});
