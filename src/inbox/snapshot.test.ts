/**
 * D02 单元测试：输入快照冻结、"已读 ≠ 已完成"、依赖解除可运行输入
 * （合同 Q5-a / Q5-b / Q5-c、§九-5；任务书 §9.2/§9.4、附录 B `start_run`）。
 */

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
  createIdSource,
  createInstanceState,
  createMessage,
  createTaskRecord,
  createWorkItem,
  PersistenceError,
  SenderBinding,
  ValidationError,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageDraft,
  type Revision,
  type RunId,
  type Store,
  type StoreSnapshot,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';
// 依赖解除输入的**身份编码**唯一来源（W 复核 N-新1：收件箱层不再自带第二套编码器）。
import { resolutionInputRefId } from '../dependency/index.js';

import { deliverToInbox } from './delivery.js';
import {
  actionableInputMarks,
  computeFrozenInput,
  findActionableInput,
  freezeInputSnapshot,
  hasActionableInput,
  hasEligibleTaskRevision,
  hasRunnableInput,
  isRunnableInputEntry,
  isStaleInboxEntry,
  markDependencyResolutionInput,
  pendingActionableInputs,
  unreadInboxEntries,
  wakingInboxEntries,
} from './snapshot.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const SENDER = asInstanceId('S1');
const C = asInstanceId('C');
const REV1 = asRevision(1);
const RUN1 = asRunId('run-1');
const RUN2 = asRunId('run-2');
const T = (n: number): LogicalTime => asLogicalTime(n);

function makeStore(): Store {
  return createMemoryStore({ clock: () => T(0) });
}

function registerInstance(store: Store, instanceId: InstanceId = C, groupId: GroupId = GROUP): void {
  store.transact((tx) => {
    tx.putInstance(createInstanceState({ instance_id: instanceId, group_id: groupId, updated_at: T(0) }));
  });
}

/** 注册任务记录（F09 的"当前任务版本"权威来源；未注册时版本无法判定、不判陈旧）。 */
function registerTask(store: Store, revision: number, groupId: GroupId = GROUP): void {
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: TASK,
        goal: '输入快照 / 运行资格用例任务',
        created_at: T(0),
        revision: asRevision(revision),
        current_group_id: groupId,
      }),
    );
  });
}

function makeMessage(
  messageId: string,
  requestId?: string,
  groupId: GroupId = GROUP,
  options: {
    type?: MessageDraft['type'];
    requiresWakeup?: boolean;
    revision?: Revision;
    recipient?: InstanceId;
  } = {},
) {
  const type = options.type ?? 'work_request';
  const draft: MessageDraft = {
    message_id: asMessageId(messageId),
    task_id: TASK,
    group_id: groupId,
    task_revision: options.revision ?? REV1,
    recipient_instance_id: options.recipient ?? C,
    type,
    ...(requestId === undefined ? {} : { request_id: asRequestId(requestId) }),
    requires_wakeup: options.requiresWakeup ?? true,
    created_at: T(0),
  };
  // R35.2：内核签发绑定同时携带 group_id / task_id。
  return createMessage(draft, SenderBinding.bind(SENDER, { group_id: groupId, task_id: TASK }), {
    idSource: createIdSource({ seed: 'inbox' }),
  });
}

function readReceiptsFor(snapshot: StoreSnapshot, instanceId: InstanceId) {
  return snapshot.read_receipts.filter((receipt) => receipt.instance_id === instanceId);
}

/** 捕获同步抛错，便于断言错误的 accepted 标志与 cause（D01 的错误分类）。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * 未接受的判据按**合同**写，不绑定 D01 的错误分类实现：
 * `accepted === false` 才是不变量（合同 §九-1）；具体是 `ValidationError`
 * 原样冒泡还是被包成 `PersistenceError` 属实现细节（D01 第二轮已改为前者）。
 */
function assertNotAccepted(error: unknown, reasonFragment: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof ValidationError || error instanceof PersistenceError).toBe(true);
  expect((error as { accepted: boolean }).accepted).toBe(false);
  const cause = (error as { cause?: unknown }).cause;
  const text = cause instanceof Error ? cause.message : (error as Error).message;
  expect(text).toContain(reasonFragment);
}

function consume(store: Store, runId: RunId, at: number) {
  return store.transact((tx) => freezeInputSnapshot(tx, { instance_id: C, run_id: runId, at: T(at) }));
}

describe('Q5-a 输入快照冻结', () => {
  it('冻结读入全部未读消息与它们的 request_id，并写上 run_id', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-1', 'r-1'));
      deliverToInbox(tx, makeMessage('m-2', 'r-2'));
    });

    const frozen = consume(store, RUN1, 10);

    expect(frozen.run_id).toBe(RUN1);
    expect(frozen.frozen_at).toBe(10);
    expect(frozen.message_ids).toEqual(['m-1', 'm-2']);
    expect(frozen.request_ids).toEqual(['r-1', 'r-2']);
    expect(frozen.actionable_input_refs).toEqual([]);

    const receipts = readReceiptsFor(store.snapshot(), C);
    expect(receipts.map((receipt) => receipt.message_id)).toEqual(['m-1', 'm-2']);
    expect(receipts.every((receipt) => receipt.run_id === RUN1)).toBe(true);
    expect(receipts.every((receipt) => receipt.read_at === 10)).toBe(true);
  });

  it('已读的消息不再进入下一轮快照（第二轮为空）', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => deliverToInbox(tx, makeMessage('m-1', 'r-1')));

    consume(store, RUN1, 1);
    const second = consume(store, RUN2, 2);

    expect(second.message_ids).toEqual([]);
    expect(second.request_ids).toEqual([]);
    // 已读位置独立记录：两轮各有一条已读记录，互不覆盖
    expect(readReceiptsFor(store.snapshot(), C)).toHaveLength(1);
  });

  it('冻结后到达的消息不得进入本轮（同一事务内先冻结、后投递）', () => {
    const store = makeStore();
    registerInstance(store);

    const result = store.transact((tx) => {
      const frozen = freezeInputSnapshot(tx, { instance_id: C, run_id: RUN1, at: T(1) });
      deliverToInbox(tx, makeMessage('m-late', 'r-late'));
      return frozen;
    });

    expect(result.message_ids).toEqual([]);

    const snapshot = store.snapshot();
    // 消息被可靠保留（不丢），但不属于本轮
    expect(snapshot.inbox_entries).toHaveLength(1);
    expect(snapshot.read_receipts).toHaveLength(0);

    const next = consume(store, RUN2, 2);
    expect(next.message_ids).toEqual(['m-late']);
  });

  it('一条消息携带多个 request 时 request_ids 去重保序', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-1', 'r-1'));
      deliverToInbox(tx, makeMessage('m-2', 'r-1'));
      deliverToInbox(tx, makeMessage('m-3', 'r-2'));
    });

    const frozen = consume(store, RUN1, 1);
    expect(frozen.message_ids).toEqual(['m-1', 'm-2', 'm-3']);
    expect(frozen.request_ids).toEqual(['r-1', 'r-2']);
  });

  it('computeFrozenInput 只读：预览不消耗任何输入', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => deliverToInbox(tx, makeMessage('m-1', 'r-1')));

    const preview = store.transact((tx) =>
      computeFrozenInput(tx, { instance_id: C, run_id: RUN1, at: T(1) }),
    );

    expect(preview.message_ids).toEqual(['m-1']);
    const snapshot = store.snapshot();
    expect(snapshot.read_receipts).toHaveLength(0);
    expect(snapshot.instances[0]?.consumed_message_ids).toEqual([]);
  });

  it('实例未注册时冻结报错（不得凭空起轮次）', () => {
    const store = makeStore();
    assertNotAccepted(capture(() => consume(store, RUN1, 1)), '未注册');
    expect(store.snapshot().read_receipts).toHaveLength(0);
  });
});

describe('Q5-b「已读」≠「已完成」（合同 §九-5）', () => {
  it('冻结只写已读记录，不触碰工作项状态', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-1', 'r-1'));
      tx.putWorkItem(
        createWorkItem({
          request_id: asRequestId('r-1'),
          task_id: TASK,
          task_revision: REV1,
          owner_instance_id: C,
          created_at: T(0),
          status: 'pending',
          blocker_reason: { kind: 'waiting_user', detail: '尚未开始' },
          triggering_message_ids: [asMessageId('m-1')],
        }),
      );
    });

    consume(store, RUN1, 5);

    const snapshot = store.snapshot();
    // 已读：消息被读入
    expect(readReceiptsFor(snapshot, C)).toHaveLength(1);
    expect(snapshot.instances[0]?.consumed_message_ids).toEqual(['m-1']);
    // 未完成：工作项状态原样，仍是 pending（读入 ≠ 完成）
    expect(snapshot.work_items).toHaveLength(1);
    expect(snapshot.work_items[0]?.status).toBe('pending');
    expect(snapshot.work_items[0]?.result_refs).toEqual([]);
  });

  it('收件箱条目在读取后仍然保留（已读不删消息）', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => deliverToInbox(tx, makeMessage('m-1', 'r-1')));

    consume(store, RUN1, 1);

    const snapshot = store.snapshot();
    expect(snapshot.inbox_entries).toHaveLength(1);
    expect(snapshot.instances[0]?.inbox_message_ids).toEqual(['m-1']);
    expect(snapshot.instances[0]?.consumed_message_ids).toEqual(['m-1']);
  });

  it('unreadInboxEntries 只看已读位置，与工作项状态无关', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-1', 'r-1'));
      deliverToInbox(tx, makeMessage('m-2', 'r-2'));
    });

    consume(store, RUN1, 1);
    store.transact((tx) => deliverToInbox(tx, makeMessage('m-3', 'r-3')));

    const unread = store.transact((tx) => unreadInboxEntries(tx, C));
    expect(unread.map((entry) => entry.message_id)).toEqual(['m-3']);
  });
});

describe('Q5-c 依赖解除作为"新的可运行输入"（不作为新消息入箱）', () => {
  it('登记依赖解除不产生消息、不产生收件箱条目、不参与去重', () => {
    const store = makeStore();
    registerInstance(store);

    const mark = store.transact((tx) =>
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-1', at: T(3) }),
    );

    expect(mark.source).toBe('dependency_resolution');
    expect(mark.consumed_in_run_id).toBeNull();

    const snapshot = store.snapshot();
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.inbox_entries).toHaveLength(0);
    expect(snapshot.instances[0]?.inbox_message_ids).toEqual([]);
  });

  it('可运行输入进入下一轮快照，并在冻结时被标记为已消费', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-1', at: T(1) }));

    const frozen = consume(store, RUN1, 2);
    expect(frozen.message_ids).toEqual([]);
    expect(frozen.actionable_input_refs).toEqual(['r-dep-1']);

    const [mark] = store.snapshot().actionable_inputs;
    expect(mark?.consumed_in_run_id).toBe(RUN1);

    // 至多一次排队：第二次冻结不再包含它
    const second = consume(store, RUN2, 3);
    expect(second.actionable_input_refs).toEqual([]);
  });

  it('可运行输入与消息可同轮冻结，二者互不干扰', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-1', 'r-1'));
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-2', at: T(1) });
    });

    const frozen = consume(store, RUN1, 2);
    expect(frozen.message_ids).toEqual(['m-1']);
    expect(frozen.request_ids).toEqual(['r-1']);
    expect(frozen.actionable_input_refs).toEqual(['r-dep-2']);
  });

  it('同一 ref_id 重复登记不翻倍（幂等）', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-1', at: T(1) });
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-1', at: T(2) });
    });

    const marks = store.snapshot().actionable_inputs;
    expect(marks).toHaveLength(1);
    expect(marks[0]?.marked_at).toBe(2);
  });

  it('空 ref_id 或未注册实例 → 事务回滚且未接受', () => {
    const store = makeStore();
    registerInstance(store);

    const emptyRef = capture(() =>
      store.transact((tx) => markDependencyResolutionInput(tx, { instance_id: C, ref_id: '', at: T(1) })),
    );
    assertNotAccepted(emptyRef, '不能为空');
    expect(store.snapshot().actionable_inputs).toHaveLength(0);

    const ghost = capture(() =>
      store.transact((tx) =>
        markDependencyResolutionInput(tx, { instance_id: asInstanceId('ghost'), ref_id: 'x', at: T(1) }),
      ),
    );
    assertNotAccepted(ghost, '未注册');
    expect(store.snapshot().actionable_inputs).toHaveLength(0);
  });

  it('pendingActionableInputs 只返回未被消费的标记，按登记时刻排序', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-b', at: T(2) });
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-a', at: T(1) });
    });

    const pending = store.transact((tx) => pendingActionableInputs(tx, C));
    expect(pending.map((mark) => mark.ref_id)).toEqual(['r-a', 'r-b']);
  });
});

describe('R2：公共进度既不空转、也不滞留', () => {
  it('仅有公共进度（requires_wakeup=false）时不构成运行机会', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) =>
      deliverToInbox(
        tx,
        makeMessage('m-progress', undefined, GROUP, { type: 'stage_result', requiresWakeup: false }),
      ),
    );

    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);
    // 但它仍然在收件箱里、仍未读——不会被丢弃，也不占运行机会
    expect(store.transact((tx) => unreadInboxEntries(tx, C))).toHaveLength(1);
    expect(store.transact((tx) => wakingInboxEntries(tx, C))).toHaveLength(0);
  });

  it('公共进度会被后续合法轮次读入（不会永久滞留收件箱）', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(
        tx,
        makeMessage('m-progress', undefined, GROUP, { type: 'stage_result', requiresWakeup: false }),
      );
      deliverToInbox(tx, makeMessage('m-work', 'r-work'));
    });

    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(true);

    const frozen = consume(store, RUN1, 1);
    // 冻结读入**全部未读**（含公共进度）——读入 ≠ 它是起轮次的理由
    expect(frozen.message_ids).toEqual(['m-progress', 'm-work']);
    expect(frozen.request_ids).toEqual(['r-work']);
    expect(store.transact((tx) => unreadInboxEntries(tx, C))).toHaveLength(0);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);
  });

  it('wakingInboxEntries 只滤除唤醒标记，不改动已读语义', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-wake', 'r-1'));
      deliverToInbox(
        tx,
        makeMessage('m-quiet', undefined, GROUP, { type: 'stage_result', requiresWakeup: false }),
      );
    });

    const waking = store.transact((tx) => wakingInboxEntries(tx, C));
    expect(waking.map((entry) => entry.message_id)).toEqual(['m-wake']);
    expect(store.snapshot().read_receipts).toHaveLength(0);
  });
});

describe('F04 / R37.1：快照消息查询走群作用域', () => {
  const GROUP_B = asGroupId('G2');
  const C_B = asInstanceId('C2');

  it('两群复用同一 message_id、不同 request_id：各自按群冻结，互不串味', () => {
    const store = makeStore();
    registerInstance(store, C, GROUP);
    registerInstance(store, C_B, GROUP_B);

    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-shared', 'r-a', GROUP));
      deliverToInbox(tx, makeMessage('m-shared', 'r-b', GROUP_B, { recipient: C_B }));
    });

    // 存储的歧义守卫**保留**（不是被去掉，而是被绕开）：全局查询在同 id 跨群时显式报错。
    expect(() => store.transact((tx) => tx.getMessage(asMessageId('m-shared')))).toThrow();

    // 群作用域查询各取各的：两群都能冻结，互不串味。
    const frozenA = store.transact((tx) =>
      computeFrozenInput(tx, { instance_id: C, run_id: RUN1, at: T(1) }),
    );
    const frozenB = store.transact((tx) =>
      computeFrozenInput(tx, { instance_id: C_B, run_id: RUN2, at: T(1) }),
    );

    expect(frozenA.message_ids).toEqual(['m-shared']);
    expect(frozenA.request_ids).toEqual(['r-a']);
    expect(frozenB.message_ids).toEqual(['m-shared']);
    expect(frozenB.request_ids).toEqual(['r-b']);

    // 真正冻结（写已读 + 建 RunRecord 前的快照）同样不得因同 id 抛歧义
    const consumedA = consume(store, RUN1, 2);
    expect(consumedA.request_ids).toEqual(['r-a']);
    const consumedB = store.transact((tx) =>
      freezeInputSnapshot(tx, { instance_id: C_B, run_id: RUN2, at: T(2) }),
    );
    expect(consumedB.request_ids).toEqual(['r-b']);
  });
});

describe('F09 / R37.3：历史消息保存但不获运行资格', () => {
  it('仅投递旧版本消息：无运行机会，但条目仍留在收件箱里', () => {
    const store = makeStore();
    registerInstance(store);
    registerTask(store, 2);
    store.transact((tx) =>
      deliverToInbox(tx, makeMessage('m-old', 'r-old', GROUP, { revision: asRevision(1) })),
    );

    // 执行资格：假 —— 不为陈旧历史起一轮
    expect(store.transact((tx) => hasEligibleTaskRevision(tx, TASK, asRevision(1)))).toBe(false);
    expect(store.transact((tx) => wakingInboxEntries(tx, C))).toHaveLength(0);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);

    // 快照内容（读入语义）：条目仍在收件箱、仍未读，未被丢弃
    const unread = store.transact((tx) => unreadInboxEntries(tx, C));
    expect(unread.map((entry) => entry.message_id)).toEqual(['m-old']);
    expect(store.transact((tx) => isStaleInboxEntry(tx, unread[0]!))).toBe(true);
    expect(store.transact((tx) => isRunnableInputEntry(tx, unread[0]!))).toBe(false);

    // 只读预览仍把它读入（读入 ≠ 运行资格）
    const preview = store.transact((tx) =>
      computeFrozenInput(tx, { instance_id: C, run_id: RUN1, at: T(1) }),
    );
    expect(preview.message_ids).toEqual(['m-old']);

    // 没有任何轮次被起，故无已读记录、预算不受旧消息影响
    expect(store.snapshot().read_receipts).toHaveLength(0);
    expect(store.snapshot().actionable_inputs).toHaveLength(0);
  });

  it('当前版本消息仍可运行；与陈旧消息并存时允许起轮且历史被读入', () => {
    const store = makeStore();
    registerInstance(store);
    registerTask(store, 2);
    store.transact((tx) => {
      deliverToInbox(tx, makeMessage('m-old', 'r-old', GROUP, { revision: asRevision(1) }));
      deliverToInbox(tx, makeMessage('m-new', 'r-new', GROUP, { revision: asRevision(2) }));
    });

    expect(store.transact((tx) => hasEligibleTaskRevision(tx, TASK, asRevision(2)))).toBe(true);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(true);
    expect(store.transact((tx) => wakingInboxEntries(tx, C)).map((entry) => entry.message_id)).toEqual([
      'm-new',
    ]);

    const frozen = consume(store, RUN1, 1);
    // 读入语义不变：陈旧历史仍被读入上下文，只是不构成起轮次的理由
    expect(frozen.message_ids).toEqual(['m-old', 'm-new']);
    // **本次修复翻转的断言**（F09 / R37.3）：旧实现把陈旧消息的 `request_id` 也算进
    // 冻结请求集合，于是历史 request_id 会进入本轮的工作认领与发布范围——
    // 那正是 R37.3 要求避免的。现在历史消息**照读入**（上一行），但**不贡献** request_id。
    expect(frozen.request_ids).toEqual(['r-new']);
  });

  it('显式 currentTaskRevision 覆盖：任务未注册也能判定陈旧', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) =>
      deliverToInbox(tx, makeMessage('m-old', 'r-old', GROUP, { revision: asRevision(1) })),
    );

    // 任务未注册 → 无法判定 → 放行（有则从严、无则放行）
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(true);

    const options = { currentTaskRevision: () => asRevision(3) };
    expect(store.transact((tx) => hasRunnableInput(tx, C, options))).toBe(false);
    expect(store.transact((tx) => wakingInboxEntries(tx, C, options))).toHaveLength(0);
    // 读入语义不受影响
    expect(store.transact((tx) => unreadInboxEntries(tx, C))).toHaveLength(1);
  });
});

describe('F10 / R37.3：已消费的解除通知保持幂等', () => {
  it('已消费的同一 ref_id 重放：不复位消费状态、不产生运行机会', () => {
    const store = makeStore();
    registerInstance(store);
    store.transact((tx) =>
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-1', at: T(1) }),
    );
    consume(store, RUN1, 2); // 消费该输入
    expect(store.snapshot().actionable_inputs[0]?.consumed_in_run_id).toBe(RUN1);

    // 每轮结束后重放同一通知（旧实现会在这里把 consumed_in_run_id 重置为 null）
    for (const at of [3, 4, 5]) {
      store.transact((tx) =>
        markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep-1', at: T(at) }),
      );
    }

    const marks = store.snapshot().actionable_inputs;
    expect(marks).toHaveLength(1);
    expect(marks[0]?.consumed_in_run_id).toBe(RUN1); // 消费事实未被重置
    expect(marks[0]?.marked_at).toBe(1); // 登记时刻也未被刷新
    expect(store.transact((tx) => pendingActionableInputs(tx, C))).toHaveLength(0);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);

    // 完整输入身份（含已消费）看得见它 → 调度层据此判"旧通知重试"而非"新输入"
    expect(store.transact((tx) => hasActionableInput(tx, C, 'r-dep-1'))).toBe(true);
    expect(store.transact((tx) => findActionableInput(tx, C, 'r-dep-1')?.consumed_in_run_id)).toBe(
      RUN1,
    );
    expect(store.transact((tx) => actionableInputMarks(tx, C))).toHaveLength(1);
  });

  it('真正的新解除（版本不同）仍能产生新输入', () => {
    const store = makeStore();
    registerInstance(store);
    // **身份的编码由 D05 的 `resolutionInputRefId` 唯一负责**（W 复核 N-新1：
    // 本模块原先另有一套 `dep:<task>@<rev>:<target>` 编码器，两套会产出不同字符串）。
    // 现在收件箱层只按传入的 `ref_id` 字符串做幂等，编码器不再重复定义。
    const atRev1 = resolutionInputRefId({
      task_id: TASK,
      task_revision: asRevision(1),
      request_id: asRequestId('r-dep'),
      resolved_dependency_ids: ['req:dep-X'],
    });
    const atRev2 = resolutionInputRefId({
      task_id: TASK,
      task_revision: asRevision(2),
      request_id: asRequestId('r-dep'),
      resolved_dependency_ids: ['req:dep-X'],
    });
    expect(atRev2).not.toBe(atRev1);

    store.transact((tx) =>
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: atRev1, at: T(1) }),
    );
    consume(store, RUN1, 2);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);

    // 同任务、同解除对象，但版本提升 → 新输入（R37.3：不得永久禁止同一请求的所有未来解除）
    store.transact((tx) =>
      markDependencyResolutionInput(tx, { instance_id: C, ref_id: atRev2, at: T(3) }),
    );

    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(true);
    const marks = store.transact((tx) => actionableInputMarks(tx, C));
    expect(marks.map((mark) => mark.ref_id)).toEqual([atRev1, atRev2]);
    expect(marks[1]?.consumed_in_run_id).toBeNull();

    const frozen = consume(store, RUN2, 4);
    expect(frozen.actionable_input_refs).toEqual([atRev2]);
  });

  it('空 ref_id → 拒绝（身份不得为空；编码归 D05，本层只做幂等登记）', () => {
    const store = makeStore();
    registerInstance(store);
    const bad = capture(() =>
      store.transact((tx) =>
        markDependencyResolutionInput(tx, { instance_id: C, ref_id: '', at: T(1) }),
      ),
    );
    assertNotAccepted(bad, '不能为空');
    expect(store.snapshot().actionable_inputs).toHaveLength(0);
  });
});

describe('可运行输入判据（D03 的"是否需要起轮次"接缝）', () => {
  it('无输入 → false；未读消息或未消费标记 → true；冻结后 → false', () => {
    const store = makeStore();
    registerInstance(store);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);

    store.transact((tx) => deliverToInbox(tx, makeMessage('m-1', 'r-1')));
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(true);

    consume(store, RUN1, 1);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);

    store.transact((tx) => markDependencyResolutionInput(tx, { instance_id: C, ref_id: 'r-dep', at: T(2) }));
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(true);

    consume(store, RUN2, 3);
    expect(store.transact((tx) => hasRunnableInput(tx, C))).toBe(false);
  });
});
