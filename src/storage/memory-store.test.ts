import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  assertInstanceStateInvariants,
  assertWorkItemInvariants,
  applyTaskControlIntent,
  createActionableInputMark,
  createDeliveryEvent,
  createIdSource,
  createInboxEntry,
  createInstanceState,
  createKernelEvent,
  createMessage,
  createReadReceipt,
  createRunLease,
  createRunRecord,
  createTaskControlState,
  createWorkItem,
  nextInboxSequence,
  PersistenceError,
  PublicationError,
  SenderBinding,
  ValidationError,
  type InstanceState,
  type LogicalTime,
  type MessageId,
  type PendingEvent,
  type RequestId,
  type StorageTransaction,
  type Store,
} from '../protocol/index.js';
import { createMemoryStore } from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const SENDER = asInstanceId('S1');
const C = asInstanceId('C');
const REV1 = asRevision(1);
const R1 = asRequestId('req-1');
const RUN1 = asRunId('run-1');
const T = (n: number): LogicalTime => asLogicalTime(n);

/** 捕获同步抛错，便于断言错误的 accepted 标志。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function makeMessage(messageId: MessageId, requestId: RequestId = R1) {
  return makeMessageInGroup(GROUP, messageId, requestId);
}

/** 指定群组的消息构造（R6：同一 message_id 在不同群组是不同消息）。 */
function makeMessageInGroup(groupId: ReturnType<typeof asGroupId>, messageId: MessageId, requestId: RequestId = R1) {
  return createMessage(
    {
      message_id: messageId,
      task_id: TASK,
      group_id: groupId,
      task_revision: REV1,
      recipient_instance_id: C,
      type: 'work_request',
      request_id: requestId,
      requires_wakeup: true,
      created_at: T(0),
    },
    SenderBinding.bind(SENDER, { group_id: groupId, task_id: TASK }),
    { idSource: createIdSource({ seed: 'store' }) },
  );
}

/** 在**同一个事务**内写入：消息 + 收件箱 + 工作项 + 排队事件（合同 §九-1 的一致提交）。 */
function deliverRequest(
  store: Store,
  options: { messageId: MessageId; requestId: RequestId; enqueue: boolean },
) {
  const ids = createIdSource({ seed: 'store' });
  const message = makeMessage(options.messageId, options.requestId);
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
      reason: '有新的工作请求，接收者空闲 → 置排队标记',
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
    if (options.enqueue) {
      tx.enqueueDeliveryEvent(event);
    }
    tx.appendKernelEvent(
      createKernelEvent({ kind: 'message_accepted', at: T(0), message_id: options.messageId }, ids),
    );
  });

  return { message, workItem, event };
}

function instanceOf(store: Store, instanceId: ReturnType<typeof asInstanceId>): InstanceState | undefined {
  return store.snapshot().instances.find((state) => state.instance_id === instanceId);
}

describe('事务边界（合同 §九-1：一致提交）', () => {
  it('消息 + 工作项 + 待投递事件在同一事务内一并可见', () => {
    const store = createMemoryStore();
    const { message, event } = deliverRequest(store, {
      messageId: asMessageId('m-1'),
      requestId: R1,
      enqueue: true,
    });

    const snapshot = store.snapshot();
    expect(snapshot.messages.map((m) => m.message_id)).toEqual([message.message_id]);
    expect(snapshot.inbox_entries.length).toBe(1);
    expect(snapshot.work_items.map((w) => w.request_id)).toEqual([R1]);
    expect(snapshot.delivery_events.map((e) => e.event_id)).toEqual([event.event_id]);
    expect(snapshot.read_receipts).toEqual([]); // 未读
    expect(store.pendingDeliveryEvents().length).toBe(1);
  });

  it('提交前外部看不到任何改动（事务隔离）', () => {
    const store = createMemoryStore();
    const message = makeMessage(asMessageId('m-iso'));
    store.transact((tx) => {
      tx.putMessage(message);
      expect(store.snapshot().messages.length).toBe(0);
    });
    expect(store.snapshot().messages.length).toBe(1);
  });

  it('事务抛错 → 全部回滚，错误标记为“未接受”', () => {
    const store = createMemoryStore();
    const message = makeMessage(asMessageId('m-rollback'));
    const error = capture(() =>
      store.transact((tx) => {
        tx.putMessage(message);
        tx.appendInboxEntry(
          createInboxEntry({
            message_id: message.message_id,
            instance_id: C,
            group_id: GROUP,
            task_id: TASK,
            sequence: 1,
            received_at: T(0),
            requires_wakeup: true,
          }),
        );
        throw new Error('业务校验失败');
      }),
    );

    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).accepted).toBe(false);
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().inbox_entries).toEqual([]);
  });

  it('禁止嵌套事务', () => {
    const store = createMemoryStore();
    const error = capture(() =>
      store.transact(() => {
        store.transact(() => undefined);
      }),
    );
    expect(error).toBeInstanceOf(PersistenceError);
  });
});

describe('故障注入接缝（Q10-c；验收规格 0.3 的三个注入点）', () => {
  it('默认关闭：不设置接缝时不会打断', () => {
    const store = createMemoryStore();
    expect(store.faults).toEqual({});
    expect(() =>
      deliverRequest(store, { messageId: asMessageId('m-clean'), requestId: R1, enqueue: true }),
    ).not.toThrow();
  });

  it('提交前中断 → 未接受；消息未落库，不得报告已接受（P2）', () => {
    const store = createMemoryStore();
    store.faults.beforeCommit = () => {
      throw new Error('注入：提交前进程中断');
    };
    const error = capture(() =>
      deliverRequest(store, { messageId: asMessageId('m-fault-commit'), requestId: R1, enqueue: true }),
    );

    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).accepted).toBe(false);
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().work_items).toEqual([]);
    expect(store.pendingDeliveryEvents()).toEqual([]);
  });

  it('提交后、投递前中断 → 已接受；事件仍待投递，重放后送达且不重复投递（P2 恢复）', () => {
    const store = createMemoryStore();
    store.faults.afterCommitBeforePublish = () => {
      throw new Error('注入：转向执行队列前进程中断');
    };
    const error = capture(() =>
      deliverRequest(store, { messageId: asMessageId('m-fault-publish'), requestId: R1, enqueue: true }),
    );

    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).accepted).toBe(true);
    // 已可靠保存：消息与工作项都在
    expect(store.snapshot().messages.length).toBe(1);
    expect(store.snapshot().work_items.length).toBe(1);
    // 但事件仍待投递
    expect(store.pendingDeliveryEvents().length).toBe(1);

    /**
     * 投递处理器**真的建一份业务工作**（v1.1 W3）：若重放重复投递，业务工作就会多出来
     * ——原版 handler 什么都不做，`work_items.length === 1` 是恒真的同义反复。
     *
     * 处理器自己按 event_id 去重，模拟"投递消费者必须幂等"；这里断言的是
     * **存储不会把同一条事件投递两次**，以及**handler 只被调用一次**。
     */
    const deliveredEventIds: string[] = [];
    const handler = (event: PendingEvent): void => {
      if (deliveredEventIds.includes(event.event_id)) {
        return; // 消费者侧幂等（不该发生：存储不应重复投递）
      }
      deliveredEventIds.push(event.event_id);
      store.transact((tx) => {
        tx.putWorkItem(
          createWorkItem({
            request_id: asRequestId(`delivered-${event.event_id}`),
            task_id: TASK,
            task_revision: REV1,
            owner_instance_id: C,
            created_at: T(0),
            status: 'pending',
            blocker_reason: { kind: 'waiting_user', detail: '由投递处理器创建' },
          }),
        );
      });
    };

    // 恢复 1：重放未投递事件
    store.faults.afterCommitBeforePublish = undefined;
    const published = store.replayUndelivered(handler);
    expect(published.length).toBe(1);
    expect(deliveredEventIds.length).toBe(1);
    expect(store.pendingDeliveryEvents()).toEqual([]);
    expect(store.snapshot().work_items.length).toBe(2); // 原始 1 + 投递产生的 1

    // 恢复 2：重复恢复不产生第二次投递，也不多建业务工作
    const again = store.replayUndelivered(handler);
    expect(again).toEqual([]);
    expect(deliveredEventIds.length).toBe(1);
    expect(store.snapshot().work_items.length).toBe(2);
  });

  it('逐条投递前中断 → 已接受，未投递 id 可据以恢复', () => {
    const store = createMemoryStore();
    const { event } = deliverRequest(store, {
      messageId: asMessageId('m-fault-handler'),
      requestId: R1,
      enqueue: true,
    });
    const error = capture(() =>
      store.publishPending(() => {
        throw new Error('注入：执行队列不可用');
      }),
    );

    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).undelivered_event_ids).toEqual([event.event_id]);
    expect(store.pendingDeliveryEvents().length).toBe(1);

    // 恢复
    const published: PendingEvent[] = [];
    store.replayUndelivered((e) => published.push(e));
    expect(published.map((e) => e.event_id)).toEqual([event.event_id]);
  });
});

describe('outbox 投递与标记（Q6-b）', () => {
  it('发布成功后标记已投递；markDelivered 幂等', () => {
    const store = createMemoryStore();
    const { event } = deliverRequest(store, {
      messageId: asMessageId('m-publish'),
      requestId: R1,
      enqueue: true,
    });

    const published = store.publishPending(() => undefined);
    expect(published.map((e) => e.event_id)).toEqual([event.event_id]);
    expect(store.pendingDeliveryEvents()).toEqual([]);

    expect(store.markDelivered([event.event_id])).toBe(0);
    expect(store.snapshot().delivery_events[0]?.delivered).toBe(true);
  });

  it('待投递事件按写入顺序（FIFO）', () => {
    const store = createMemoryStore();
    const ids = createIdSource({ seed: 'fifo' });
    const make = (kindReason: string) =>
      createDeliveryEvent(
        { kind: 'run_requested', task_id: TASK, group_id: GROUP, instance_id: C, created_at: T(0), reason: kindReason },
        ids,
      );
    const first = make('第一条');
    const second = make('第二条');
    store.transact((tx) => {
      tx.enqueueDeliveryEvent(first);
      tx.enqueueDeliveryEvent(second);
    });
    expect(store.pendingDeliveryEvents().map((e) => e.reason)).toEqual(['第一条', '第二条']);
  });

  it('投递时间来自注入的时钟，存储不自行推进时间（Q8-a）', () => {
    let now = 0;
    const store = createMemoryStore({ clock: () => asLogicalTime(now) });
    const { event } = deliverRequest(store, {
      messageId: asMessageId('m-clock'),
      requestId: R1,
      enqueue: true,
    });
    now = 42;
    store.markDelivered([event.event_id]);
    expect(store.snapshot().delivery_events[0]?.delivered_at as unknown as number).toBe(42);
  });
});

describe('三组记录分离（合同 §九-5：已读 ≠ 已完成）', () => {
  it('读取即标记已读，但工作项仍为未完成', () => {
    const store = createMemoryStore();
    const { message } = deliverRequest(store, {
      messageId: asMessageId('m-read'),
      requestId: R1,
      enqueue: false,
    });

    store.transact((tx) => {
      tx.appendReadReceipt(
        createReadReceipt({
          message_id: message.message_id,
          instance_id: C,
          run_id: RUN1,
          read_at: T(10),
        }),
      );
      // 读入快照 ≠ 完成
      tx.putWorkItem(
        createWorkItem({
          request_id: R1,
          task_id: TASK,
          task_revision: REV1,
          owner_instance_id: C,
          created_at: T(0),
          status: 'processing',
          blocker_reason: { kind: 'waiting_user', detail: '处理中，等待用户确认' },
          triggering_message_ids: [message.message_id],
          included_in_snapshot: true,
          snapshot_run_ids: [RUN1],
        }),
      );
      // 另有一项从未被读入的工作项（证明两张表互不推导、可各自独立存在）
      tx.putWorkItem(
        createWorkItem({
          request_id: asRequestId('req-2'),
          task_id: TASK,
          task_revision: REV1,
          owner_instance_id: C,
          created_at: T(0),
          status: 'pending',
          blocker_reason: { kind: 'waiting_user', detail: '尚未开始' },
        }),
      );
    });

    const snapshot = store.snapshot();
    expect(snapshot.read_receipts.length).toBe(1);
    expect(snapshot.read_receipts[0]?.message_id).toBe(message.message_id);
    expect(snapshot.work_items.length).toBe(2); // 已读 1 条，但工作项 2 项
    const read = snapshot.work_items.find((w) => w.request_id === R1);
    const neverRead = snapshot.work_items.find((w) => w.request_id === asRequestId('req-2'));
    expect(read?.status).toBe('processing'); // 读入 ≠ 完成
    expect(read?.included_in_snapshot).toBe(true);
    expect(neverRead?.included_in_snapshot).toBe(false); // 未被读入也存在于承诺表
  });

  it('可运行输入标记（依赖解除）单独存放，不占收件箱（Q5-c）', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putActionableInput(
        createActionableInputMark({
          instance_id: C,
          source: 'dependency_resolution',
          ref_id: 'req-B:completed',
          marked_at: T(20),
        }),
      );
    });
    const snapshot = store.snapshot();
    expect(snapshot.actionable_inputs.length).toBe(1);
    expect(snapshot.actionable_inputs[0]?.source).toBe('dependency_resolution');
    expect(snapshot.inbox_entries).toEqual([]);
    expect(snapshot.messages).toEqual([]);
  });
});

describe('消息保存（Q3-a / Q3-b / Q1-d；v1.1 R6）', () => {
  it('接受测试直接注入任意 message_id（A04 依赖）', () => {
    const store = createMemoryStore();
    const injected = asMessageId('injected-0001');
    deliverRequest(store, { messageId: injected, requestId: R1, enqueue: false });
    expect(store.snapshot().messages.map((m) => m.message_id)).toEqual([injected]);
  });

  /**
   * v1.1 W6：原版把 last-write-wins **覆盖**语义写成了期望行为——那是缺口，不是规范。
   * 现状如实记录如下：**同一群内**同 id 直接 `putMessage`（绕过判重）会覆盖首次到达的记录，
   * 因此 D02 **必须**先 `hasMessageInGroup()` 判重再写（D-1 / R6）。
   */
  it('缺口如实记录（非规范）：同群同 id 直接重写会覆盖首次到达的记录', () => {
    const store = createMemoryStore();
    const first = makeMessage(asMessageId('m-same'), asRequestId('req-a'));
    const second = makeMessage(asMessageId('m-same'), asRequestId('req-b'));

    store.transact((tx) => {
      // 这一步在 D02 的入口事务里必须被 isDuplicateDelivery() 拦住（R6 明确要求）。
      tx.putMessage(first);
      tx.putMessage(second); // ← 覆盖：缺口，不是被认可的语义
    });

    const stored = store.snapshot().messages;
    expect(stored.length).toBe(1);
    expect(stored[0]?.request_id).toBe(asRequestId('req-b')); // 首次到达（req-a）的内容已丢
  });

  it('R6 群作用域查询：同一 message_id 在不同群组各自存活，互不覆盖', () => {
    const store = createMemoryStore();
    const groupA = asGroupId('G-A');
    const groupB = asGroupId('G-B');
    const first = makeMessageInGroup(groupA, asMessageId('m-shared'), asRequestId('req-a'));
    const second = makeMessageInGroup(groupB, asMessageId('m-shared'), asRequestId('req-b'));

    store.transact((tx) => {
      tx.putMessage(first);
      tx.putMessage(second);
    });

    expect(store.snapshot().messages.length).toBe(2); // 两条共存（旧实现会互相覆盖）
    store.transact((tx) => {
      expect(tx.hasMessageInGroup(groupA, asMessageId('m-shared'))).toBe(true);
      expect(tx.hasMessageInGroup(groupB, asMessageId('m-shared'))).toBe(true);
      expect(tx.getMessageInGroup(groupA, asMessageId('m-shared'))?.request_id).toBe(asRequestId('req-a'));
      expect(tx.getMessageInGroup(groupB, asMessageId('m-shared'))?.request_id).toBe(asRequestId('req-b'));

      // 群内没有该 id 时判 false（不得跨群误判为重复）
      expect(tx.hasMessageInGroup(asGroupId('G-C'), asMessageId('m-shared'))).toBe(false);
      expect(tx.getMessageInGroup(asGroupId('G-C'), asMessageId('m-shared'))).toBeUndefined();

      // 全局查询仍可用：hasMessage 为"至少一个群有"；唯一时 getMessage 正常返回
      expect(tx.hasMessage(asMessageId('m-shared'))).toBe(true);
      expect(tx.hasMessage(asMessageId('m-absent'))).toBe(false);
    });
  });

  it('R6：全局 getMessage 在多群同 id 时**显式报歧义**，不静默给出错误的那一条', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putMessage(makeMessageInGroup(asGroupId('G-A'), asMessageId('m-dup'), asRequestId('req-a')));
      tx.putMessage(makeMessageInGroup(asGroupId('G-B'), asMessageId('m-dup'), asRequestId('req-b')));
    });

    const error = capture(() =>
      store.transact((tx) => {
        tx.getMessage(asMessageId('m-dup'));
      }),
    );
    // 事务内抛错统一以 "未接受" 报出；真实原因（歧义）保留在 cause 里，消息可操作。
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).accepted).toBe(false);
    const cause = (error as PersistenceError).cause;
    expect(cause).toBeInstanceOf(ValidationError);
    expect((cause as ValidationError).message).toContain('getMessageInGroup');
  });

  it('不同 message_id、内容相同 → 分别保留（不比较内容，Q3-c）', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putMessage(makeMessage(asMessageId('m-a'), asRequestId('req-1')));
      tx.putMessage(makeMessage(asMessageId('m-b'), asRequestId('req-1')));
    });
    expect(store.snapshot().messages.length).toBe(2);
  });
});

describe('任务控制状态（v1.1 B4：取消优先，与消息同一事务）', () => {
  it('取消写入与消息**同一事务**一致提交', () => {
    const store = createMemoryStore();
    const cancelMessage = makeMessage(asMessageId('m-cancel'), R1);

    store.transact((tx) => {
      tx.putMessage(cancelMessage);
      tx.appendInboxEntry(
        createInboxEntry({
          message_id: cancelMessage.message_id,
          instance_id: C,
          group_id: GROUP,
          task_id: TASK,
          sequence: 1,
          received_at: T(5),
          requires_wakeup: true,
        }),
      );
      tx.putTaskControlState(
        applyTaskControlIntent(createTaskControlState({ task_id: TASK, updated_at: T(0) }), {
          kind: 'cancel',
          message_id: cancelMessage.message_id,
          task_revision: REV1,
          at: T(5),
          reason: '用户取消',
        }),
      );
    });

    const control = store.snapshot().task_control_states[0];
    expect(control?.cancelled).toBe(true);
    expect(control?.cancelled_by_message_id).toBe(asMessageId('m-cancel'));
    expect(store.snapshot().messages.length).toBe(1);
    expect(store.snapshot().inbox_entries.length).toBe(1);
  });

  it('事务被中断 → 消息与控制状态**都不存在**（不留"消息在但控制丢失"的窗口）', () => {
    const store = createMemoryStore();
    const cancelMessage = makeMessage(asMessageId('m-cancel-2'), R1);
    store.faults.beforeCommit = () => {
      throw new Error('注入：提交前中断');
    };

    const error = capture(() =>
      store.transact((tx) => {
        tx.putMessage(cancelMessage);
        tx.putTaskControlState(
          applyTaskControlIntent(createTaskControlState({ task_id: TASK, updated_at: T(0) }), {
            kind: 'cancel',
            message_id: cancelMessage.message_id,
            task_revision: REV1,
            at: T(5),
          }),
        );
      }),
    );

    expect(error).toBeInstanceOf(PersistenceError);
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().task_control_states).toEqual([]);
  });

  it('需求更新与取消都落在同一条控制记录上（取消优先）', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putTaskControlState(
        applyTaskControlIntent(createTaskControlState({ task_id: TASK, updated_at: T(0) }), {
          kind: 'cancel',
          message_id: asMessageId('m-1'),
          task_revision: REV1,
          at: T(1),
        }),
      );
    });
    store.transact((tx) => {
      const current = tx.getTaskControlState(TASK);
      if (current === undefined) {
        throw new Error('控制状态应已存在');
      }
      tx.putTaskControlState(
        applyTaskControlIntent(current, {
          kind: 'requirement_update',
          message_id: asMessageId('m-2'),
          task_revision: asRevision(2),
          at: T(2),
        }),
      );
    });

    const control = store.snapshot().task_control_states[0];
    expect(control?.cancelled).toBe(true); // 需求更新没有复活已取消的任务
    expect(control?.requirement_update_pending).toBe(true);
    expect(control?.control_epoch).toBe(2);
  });
});

describe('start_run 式一致性（合同 §九-3：抢占 + 快照 + run_id + 租约 + 置活动）', () => {
  /** start_run 的等价写入：抢占排队项 + 冻结快照 + 分配 run_id 与租约 + 置活动，都在同一事务。 */
  const startRunTransaction = (tx: StorageTransaction): void => {
      const lease = createRunLease(RUN1, C, T(100), 1000);
      tx.putRun(
        createRunRecord({
          run_id: RUN1,
          task_id: TASK,
          group_id: GROUP,
          instance_id: C,
          task_revision: REV1,
          started_at: T(100),
          lease_deadline: lease.lease_deadline,
          frozen_input_message_ids: [asMessageId('m-1')],
          frozen_request_ids: [R1],
        }),
      );
      tx.putInstance(
        createInstanceState({
          instance_id: C,
          group_id: GROUP,
          updated_at: T(100),
          activity: 'active',
          active_run_id: RUN1,
          lease_deadline: lease.lease_deadline,
          queued_flag: false, // 抢占排队项
          inbox_message_ids: [asMessageId('m-1')],
          pending_request_ids: [R1],
        }),
      );
      tx.appendReadReceipt(
        createReadReceipt({
          message_id: asMessageId('m-1'),
          instance_id: C,
          run_id: RUN1,
          read_at: T(100),
        }),
      );
      tx.putWorkItem(
        createWorkItem({
          request_id: R1,
          task_id: TASK,
          task_revision: REV1,
          owner_instance_id: C,
          created_at: T(0),
          status: 'processing',
          blocker_reason: { kind: 'waiting_user', detail: '处理中' },
          included_in_snapshot: true,
          snapshot_run_ids: [RUN1],
        }),
      );
  };

  it('一个事务内完成抢占、冻结快照、分配 run_id 与租约、置活动', () => {
    const store = createMemoryStore();
    deliverRequest(store, { messageId: asMessageId('m-1'), requestId: R1, enqueue: true });

    store.transact(startRunTransaction);

    const instance = instanceOf(store, C);
    expect(instance?.activity).toBe('active');
    expect(instance?.queued_flag).toBe(false);
    expect(instance?.active_run_id).toBe(RUN1);
    expect(instance?.lease_deadline as unknown as number).toBe(1100);
    expect(instance).toBeDefined();
    if (instance !== undefined) {
      assertInstanceStateInvariants(instance);
    }

    const run = store.snapshot().runs.find((r) => r.run_id === RUN1);
    expect(run?.frozen_input_message_ids).toEqual([asMessageId('m-1')]);
    expect(run?.frozen_request_ids).toEqual([R1]);

    const item = store.snapshot().work_items.find((w) => w.request_id === R1);
    expect(item?.status).toBe('processing');
    expect(item?.included_in_snapshot).toBe(true);
    if (item !== undefined) {
      assertWorkItemInvariants(item);
    }

    // 该事务已提交，原先的排队事件仍在 outbox
    expect(store.pendingDeliveryEvents().length).toBe(1);
  });

  it('该事务被中断时，抢占/快照/租约全部不生效（原子性）', () => {
    const store = createMemoryStore();
    deliverRequest(store, { messageId: asMessageId('m-1'), requestId: R1, enqueue: true });

    store.faults.beforeCommit = () => {
      throw new Error('注入：启动轮次前中断');
    };
    const error = capture(() => store.transact(startRunTransaction));
    expect(error).toBeInstanceOf(PersistenceError);

    const instance = instanceOf(store, C);
    expect(instance?.activity).toBe('idle');
    expect(instance?.queued_flag).toBe(true); // 排队项未被抢占
    expect(instance?.active_run_id).toBeNull();
    expect(store.snapshot().runs).toEqual([]);
    expect(store.snapshot().read_receipts).toEqual([]);
  });

  it('重置可清空场景状态（隔离用）', () => {
    const store = createMemoryStore();
    deliverRequest(store, { messageId: asMessageId('m-reset'), requestId: R1, enqueue: true });
    store.reset();
    const snapshot = store.snapshot();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.work_items).toEqual([]);
    expect(snapshot.instances).toEqual([]);
    expect(snapshot.delivery_events).toEqual([]);
    expect(snapshot.kernel_events).toEqual([]);
  });
});

describe('观测事件日志与 outbox 分离（Q10-b）', () => {
  it('观测事件不进入 outbox；两者独立计数', () => {
    const store = createMemoryStore();
    const ids = createIdSource({ seed: 'evt' });
    deliverRequest(store, { messageId: asMessageId('m-evt'), requestId: R1, enqueue: true });

    store.transact((tx) => {
      tx.appendKernelEvent(
        createKernelEvent({ kind: 'run_finished', at: T(30), run_id: asRunId('run-x') }, ids),
      );
    });

    const snapshot = store.snapshot();
    expect(snapshot.kernel_events.length).toBe(2); // message_accepted + run_finished
    expect(snapshot.delivery_events.length).toBe(1); // 只有排队事件进 outbox
    expect(snapshot.kernel_events[1]?.kind).toBe('run_finished');
  });
});
