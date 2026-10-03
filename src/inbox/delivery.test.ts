/**
 * D02 单元测试：收件箱可靠保存 + 群内 message_id 去重（合同 §九-1/§九-2、Q1-d/Q3-a/Q3-b）。
 *
 * 覆盖 A04 的守恒类断言骨架（A04-01/02/04/06/07）与 A04-C 对照（A04-C-01/02/04），
 * 以及 P2-W2 的"持久化失败不得报告已接受"。
 * 断言只经 `store.snapshot()` 读取（验收规格 0.3-5：不得窥探内核内部内存）。
 */

import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createInstanceState,
  createMessage,
  createWorkItem,
  PersistenceError,
  SenderBinding,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type MessageDraft,
  type Store,
  type StoreSnapshot,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';

import { deliverMessage, deliverToInbox } from './delivery.js';
import {
  findCrossGroupIdCollision,
  findScopedMessage,
  isDuplicateDelivery,
  messageScopeKeyOf,
  supportsGroupScopedMessages,
} from './dedup.js';
import { defaultRequiresWakeup } from './wakeup.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const GROUP2 = asGroupId('G2');
const SENDER = asInstanceId('S1');
const RECIPIENT = asInstanceId('C');
const REV1 = asRevision(1);
const T = (n: number): LogicalTime => asLogicalTime(n);

function makeStore(): Store {
  return createMemoryStore({ clock: () => T(0) });
}

function registerInstance(store: Store, instanceId: InstanceId, groupId: GroupId = GROUP): void {
  store.transact((tx) => {
    tx.putInstance(
      createInstanceState({
        instance_id: instanceId,
        group_id: groupId,
        updated_at: T(0),
      }),
    );
  });
}

function makeMessage(
  messageId: string,
  options: {
    requestId?: string;
    groupId?: GroupId;
    recipient?: InstanceId;
    payload?: unknown;
    createdAt?: LogicalTime;
    requiresWakeup?: boolean;
    type?: MessageDraft['type'];
  } = {},
) {
  const type = options.type ?? 'work_request';
  const groupId = options.groupId ?? GROUP;
  const draft: MessageDraft = {
    message_id: asMessageId(messageId),
    task_id: TASK,
    group_id: groupId,
    task_revision: REV1,
    recipient_instance_id: options.recipient ?? RECIPIENT,
    type,
    ...(options.requestId === undefined ? {} : { request_id: asRequestId(options.requestId) }),
    requires_wakeup: options.requiresWakeup ?? true,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    created_at: options.createdAt ?? T(0),
  };
  // R35.2：内核签发绑定同时携带 group_id / task_id。
  return createMessage(draft, SenderBinding.bind(SENDER, { group_id: groupId, task_id: TASK }), {
    idSource: createIdSource({ seed: 'inbox' }),
  });
}

function messagesWith(snapshot: StoreSnapshot, messageId: MessageId) {
  return snapshot.messages.filter((message) => message.message_id === messageId);
}

function inboxFor(snapshot: StoreSnapshot, instanceId: InstanceId) {
  return snapshot.inbox_entries.filter((entry) => entry.instance_id === instanceId);
}

/**
 * 模拟合同附录 B 的 `on_message` 事务（D03 将来要写的编排）：
 * 收件箱写入 + 工作项变更 + 排队事件**一致提交**（合同 §九-1）。
 * 这里刻意按合同分支出"重复则不建业务工作"，用来证明去重判定的位置正确。
 */
function deliverAndMaybeCreateWork(
  store: Store,
  message: ReturnType<typeof makeMessage>,
): 'accepted' | 'duplicate_not_created' {
  const ids = createIdSource({ seed: 'inbox' });
  return store.transact((tx) => {
    const outcome = deliverToInbox(tx, message, { event_ids: ids });
    if (outcome.result === 'accepted') {
      tx.putWorkItem(
        createWorkItem({
          request_id: message.request_id ?? asRequestId('req-fallback'),
          task_id: TASK,
          task_revision: REV1,
          owner_instance_id: message.recipient_instance_id,
          created_at: message.created_at,
          status: 'pending',
          blocker_reason: { kind: 'waiting_user', detail: '尚未开始' },
          triggering_message_ids: [message.message_id],
        }),
      );
      tx.enqueueDeliveryEvent(
        createDeliveryEvent(
          {
            kind: 'wakeup_queued',
            task_id: TASK,
            group_id: message.group_id,
            instance_id: message.recipient_instance_id,
            created_at: message.created_at,
            reason: '有新的工作请求，接收者空闲 → 置排队标记',
          },
          ids,
        ),
      );
    }
    return outcome.result;
  });
}

describe('收件箱可靠保存（合同 §九-1 第一条）', () => {
  it('首次投递返回 accepted，并且消息 + 收件箱条目 + 实例索引一致落库', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);

    const outcome = deliverMessage(store, makeMessage('m-1', { requestId: 'r-1' }));

    expect(outcome.result).toBe('accepted');
    expect(outcome.failure_reason).toBeNull();
    expect(outcome.inbox_entry?.sequence).toBe(1);

    const snapshot = store.snapshot();
    expect(messagesWith(snapshot, asMessageId('m-1'))).toHaveLength(1);
    expect(inboxFor(snapshot, RECIPIENT)).toHaveLength(1);
    expect(inboxFor(snapshot, RECIPIENT)[0]?.message_id).toBe('m-1');
    expect(inboxFor(snapshot, RECIPIENT)[0]?.requires_wakeup).toBe(true);
    expect(snapshot.instances[0]?.inbox_message_ids).toEqual(['m-1']);
  });

  it('同一事务内可与工作项、待投递事件一致提交（合同 §九-1）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);

    const result = deliverAndMaybeCreateWork(store, makeMessage('m-1', { requestId: 'r-1' }));

    expect(result).toBe('accepted');
    const snapshot = store.snapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.work_items).toHaveLength(1);
    expect(snapshot.delivery_events).toHaveLength(1);
    expect(snapshot.delivery_events[0]?.kind).toBe('wakeup_queued');
  });

  it('事务内抛错则整体回滚：不得留下半成品，也不得报告已接受', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    const message = makeMessage('m-1', { requestId: 'r-1' });

    expect(() =>
      store.transact((tx) => {
        deliverToInbox(tx, message);
        throw new Error('下游步骤失败');
      }),
    ).toThrow(PersistenceError);

    const snapshot = store.snapshot();
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.inbox_entries).toHaveLength(0);
    expect(snapshot.instances[0]?.inbox_message_ids).toEqual([]);
  });

  it('目标实例未注册属路由无效：投递失败且不留痕（P8 方向）', () => {
    const store = makeStore();
    const outcome = deliverMessage(store, makeMessage('m-1', { requestId: 'r-1' }));

    expect(outcome.result).toBe('failed');
    expect(outcome.failure_reason).toContain('未注册');
    const snapshot = store.snapshot();
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.inbox_entries).toHaveLength(0);
  });

  it('收件箱到达序号按插入序递增（确定性断言用）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    deliverMessage(store, makeMessage('m-1', { requestId: 'r-1' }));
    deliverMessage(store, makeMessage('m-2', { requestId: 'r-2' }));

    const sequences = inboxFor(store.snapshot(), RECIPIENT).map((entry) => entry.sequence);
    expect(sequences).toEqual([1, 2]);
  });
});

describe('群内 message_id 去重（A04 主场景骨架）', () => {
  it('同一 message_id 顺序投递 5 次：1 次 accepted + 4 次 duplicate_not_created，收件箱恰好 1 条', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    const message = makeMessage('m-a04-01', { requestId: 'r-a04-01' });

    const results = Array.from({ length: 5 }, () => deliverAndMaybeCreateWork(store, message));

    expect(results).toEqual([
      'accepted',
      'duplicate_not_created',
      'duplicate_not_created',
      'duplicate_not_created',
      'duplicate_not_created',
    ]);

    const snapshot = store.snapshot();
    // A04-01：收件箱中该 message_id 恰好 1 条
    expect(inboxFor(snapshot, RECIPIENT)).toHaveLength(1);
    expect(messagesWith(snapshot, asMessageId('m-a04-01'))).toHaveLength(1);
    // A04-02：工作承诺表中该 request_id 恰好 1 项
    expect(snapshot.work_items.filter((item) => item.request_id === 'r-a04-01')).toHaveLength(1);
    // A04-06：不存在两条收件箱记录共享同一 message_id
    const ids = snapshot.inbox_entries.map((entry) => entry.message_id);
    expect(new Set(ids).size).toBe(ids.length);
    // A04-04：5 次调用无一失败
    expect(results).not.toContain('failed');
    // 去重不得重复排队：待投递事件仍只有 1 条（A04-07 方向的收件箱层证据）
    expect(snapshot.delivery_events).toHaveLength(1);
  });

  it('重复送达不覆盖首次到达记录（D01 的 D-1：存储以 message_id 为键）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);

    deliverMessage(store, makeMessage('m-1', { requestId: 'r-1', payload: { n: 1 }, createdAt: T(5) }));
    const outcome = deliverMessage(
      store,
      makeMessage('m-1', { requestId: 'r-1', payload: { n: 2 }, createdAt: T(9) }),
    );

    expect(outcome.result).toBe('duplicate_not_created');
    const stored = messagesWith(store.snapshot(), asMessageId('m-1'))[0];
    expect(stored?.payload).toEqual({ n: 1 });
    expect(stored?.created_at).toBe(5);
    // 收件箱条目也保持首次到达的序号与时戳
    expect(inboxFor(store.snapshot(), RECIPIENT)[0]?.received_at).toBe(5);
  });

  it('重复送达的返回值不给调用方留"可以建工作"的余地', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    const message = makeMessage('m-1', { requestId: 'r-1' });

    const first = store.transact((tx) => deliverToInbox(tx, message));
    const second = store.transact((tx) => deliverToInbox(tx, message));

    expect(first.result).toBe('accepted');
    expect(first.inbox_entry).not.toBeNull();
    expect(second.result).toBe('duplicate_not_created');
    expect(second.inbox_entry).toBeNull();
    expect(second.duplicate_of).toBe('m-1');
    expect(second.observation_events).toHaveLength(0);
  });

  it('内容逐字相同但 message_id 不同 → 两条都保留，互不合并（A04-C 对照）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    const payload = { job: 'jD', expected: 'pD' };

    const first = deliverAndMaybeCreateWork(
      store,
      makeMessage('m-a04-01', { requestId: 'r-a04-01', payload }),
    );
    const second = deliverAndMaybeCreateWork(
      store,
      makeMessage('m-a04-02', { requestId: 'r-a04-02', payload }),
    );

    // A04-C-04：内容相同的第二条不得被当作重复丢弃
    expect(first).toBe('accepted');
    expect(second).toBe('accepted');

    const snapshot = store.snapshot();
    // A04-C-01：收件箱唯一 message_id 数 = 2
    expect(snapshot.inbox_entries).toHaveLength(2);
    // A04-C-02：工作承诺表唯一 request_id 数 = 2
    expect(snapshot.work_items.map((item) => item.request_id).sort()).toEqual(['r-a04-01', 'r-a04-02']);
    // A04-C-03：两项工作各自独立，未互相引用为同一项
    const triggering = snapshot.work_items.flatMap((item) => item.triggering_message_ids);
    expect(new Set(triggering).size).toBe(2);
    expect(snapshot.work_items.every((item) => item.supersedes_request_id === null)).toBe(true);
  });

  it('去重只看 id 不看内容：同 id 内容不同仍判重复', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    deliverMessage(store, makeMessage('m-1', { requestId: 'r-1', payload: { a: 1 } }));
    const outcome = deliverMessage(store, makeMessage('m-1', { requestId: 'r-1', payload: { a: 999 } }));

    expect(outcome.result).toBe('duplicate_not_created');
    expect(inboxFor(store.snapshot(), RECIPIENT)).toHaveLength(1);
  });

  it('去重作用域是群（R6）：不同群组的同 id 不得被判为重复', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT, GROUP);
    registerInstance(store, asInstanceId('C2'), GROUP2);
    // R6：D01 是否已落地群作用域键查询。本断言据此自适应，两种世界都成立。
    const scoped = store.transact((tx) => supportsGroupScopedMessages(tx));

    const inG1 = deliverMessage(store, makeMessage('m-shared', { requestId: 'r-1' }));
    const inG2 = deliverMessage(
      store,
      makeMessage('m-shared', { requestId: 'r-2', groupId: GROUP2, recipient: asInstanceId('C2') }),
    );

    expect(inG1.result).toBe('accepted');
    // 核心（Q1-d/Q3-b，不随存储实现变）：跨群的同 id **绝不是**重复，不得误去重。
    expect(inG2.result).not.toBe('duplicate_not_created');
    expect(store.snapshot().messages.map((message) => message.group_id)).toContain('G1');

    if (scoped) {
      // 群作用域键已落地 → 两群各一条，互不覆盖。
      expect(inG2.result).toBe('accepted');
      expect(store.snapshot().messages).toHaveLength(2);
    } else {
      // 全局键存储（D01 第一轮）无法共存 → **显式报错**而不是静默覆盖 G1 的消息。
      expect(inG2.result).toBe('failed');
      expect(inG2.failure_reason).toContain('已被群组');
      expect(store.snapshot().messages).toHaveLength(1);
    }
  });
});

describe('去重判据（纯函数层）', () => {
  it('作用域键带群组长度前缀，群与消息 id 不同即键不同', () => {
    const key = messageScopeKeyOf(makeMessage('m-1'));
    expect(key).toBe(`${'G1'.length}:G1m-1`);
    expect(messageScopeKeyOf(makeMessage('m-2'))).not.toBe(key);
    expect(messageScopeKeyOf(makeMessage('m-1', { groupId: GROUP2 }))).not.toBe(key);
  });

  it('写入前 isDuplicateDelivery 为 false，写入后为 true', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    const message = makeMessage('m-1');

    const before = store.transact((tx) => ({
      dup: isDuplicateDelivery(tx, message),
      found: findScopedMessage(tx, message),
      collision: findCrossGroupIdCollision(tx, message),
    }));
    expect(before.dup).toBe(false);
    expect(before.found).toBeUndefined();
    expect(before.collision).toBeUndefined();

    deliverMessage(store, message);

    const after = store.transact((tx) => ({
      dup: isDuplicateDelivery(tx, message),
      found: findScopedMessage(tx, message)?.message_id,
      collision: findCrossGroupIdCollision(tx, message),
    }));
    expect(after.dup).toBe(true);
    expect(after.found).toBe('m-1');
    expect(after.collision).toBeUndefined();
  });

  it('跨群占用可被显式识别（不与同群重复混为一谈）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT, GROUP);
    registerInstance(store, asInstanceId('C2'), GROUP2);
    deliverMessage(store, makeMessage('m-shared', { requestId: 'r-1' }));

    const probe = store.transact((tx) => {
      const other = makeMessage('m-shared', { groupId: GROUP2, recipient: asInstanceId('C2') });
      return {
        scopedApi: supportsGroupScopedMessages(tx),
        collisionGroup: findCrossGroupIdCollision(tx, other)?.group_id,
        scoped: findScopedMessage(tx, other),
      };
    });

    // 两个群里"同 id"永远不是同一群内的重复（R6 的核心）。
    expect(probe.scoped).toBeUndefined();
    if (probe.scopedApi) {
      // 群作用域键可共存 → 不存在"占用"概念。
      expect(probe.collisionGroup).toBeUndefined();
    } else {
      // 全局键存储 → 可识别出占用者属于 G1。
      expect(probe.collisionGroup).toBe('G1');
    }
  });
});

describe('R2 唤醒默认值', () => {
  it('只有 stage_result（公共进度）默认不唤醒，其余 7 类默认唤醒', () => {
    expect(defaultRequiresWakeup('stage_result')).toBe(false);
    for (const type of [
      'work_request',
      'work_result',
      'blocked_report',
      'cancel',
      'requirement_update',
      'capability_missing',
      'user_input_request',
    ] as const) {
      expect(defaultRequiresWakeup(type)).toBe(true);
    }
  });

  it('公共进度消息仍然可靠入箱（只是不构成运行机会）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);

    const outcome = deliverMessage(
      store,
      makeMessage('m-progress', {
        type: 'stage_result',
        requiresWakeup: defaultRequiresWakeup('stage_result'),
      }),
    );

    expect(outcome.result).toBe('accepted');
    const snapshot = store.snapshot();
    const [entry] = inboxFor(snapshot, RECIPIENT);
    expect(entry?.requires_wakeup).toBe(false);
    expect(snapshot.messages).toHaveLength(1);
  });
});

describe('观测事件（证据面；Q10-b 内核原生发出）', () => {
  it('接受写 message_accepted，重复写 message_duplicate_rejected', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    const ids = createIdSource({ seed: 'evt' });
    const message = makeMessage('m-1', { requestId: 'r-1' });

    store.transact((tx) => deliverToInbox(tx, message, { event_ids: ids }));
    store.transact((tx) => deliverToInbox(tx, message, { event_ids: ids }));

    const kinds = store.snapshot().kernel_events.map((event) => event.kind);
    expect(kinds).toEqual(['message_accepted', 'message_duplicate_rejected']);
  });

  it('不提供 event_ids 时不写任何观测事件（默认零副作用）', () => {
    const store = makeStore();
    registerInstance(store, RECIPIENT);
    deliverMessage(store, makeMessage('m-1', { requestId: 'r-1' }));
    expect(store.snapshot().kernel_events).toHaveLength(0);
  });
});
