import { describe, expect, it } from 'vitest';

import {
  SenderBinding,
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createInboxEntry,
  createMessage,
  createReadReceipt,
  createWorkItem,
  type InboxEntry,
  type MessageId,
  type RequestId,
  type StoreSnapshot,
  type WorkItem,
} from '../protocol/index.js';
import {
  ConservationViolationError,
  assertEveryItemHasOutcome,
  assertInboxMessageIds,
  assertUniqueMessageIds,
  assertUniqueRequestIds,
  compareReadAndDone,
  findCompletedWithoutResult,
  findItemsWithoutOutcome,
  findItemsWithoutTriggeringMessage,
  findUnmappedMessages,
  inboxOf,
  indexWorkItems,
  messageToRequestIds,
  statusDistribution,
  summarizeBlockers,
  uniqueMessageIds,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const S1 = asInstanceId('S1');
const RUN1 = asRunId('run-1');
const REV1 = asRevision(1);
const T = (n: number) => asLogicalTime(n);

const m = (id: string) => asMessageId(id);
const r = (id: string) => asRequestId(id);

function entry(messageId: MessageId, consumed = false): InboxEntry {
  void consumed;
  return createInboxEntry({
    message_id: messageId,
    instance_id: C,
    group_id: GROUP,
    task_id: TASK,
    sequence: 1,
    received_at: T(0),
    requires_wakeup: true,
  });
}

function item(requestId: RequestId, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({
      request_id: requestId,
      task_id: TASK,
      task_revision: REV1,
      owner_instance_id: C,
      created_at: T(0),
      status: 'pending',
      blocker_reason: { kind: 'waiting_user', detail: '未开始' },
      triggering_message_ids: [m(`m-${requestId}`)],
    }),
    ...overrides,
  };
}

function snapshotOf(
  entries: readonly InboxEntry[],
  workItems: readonly WorkItem[],
  readReceipts: StoreSnapshot['read_receipts'] = [],
): StoreSnapshot {
  return {
    tasks: [],
    messages: [],
    inbox_entries: entries,
    read_receipts: readReceipts,
    task_control_states: [],
    actionable_inputs: [],
    work_items: workItems,
    instances: [],
    group_members: [],
    runs: [],
    delivery_events: [],
    kernel_events: [],
    // design-02 A 批：快照集合**必填**（跟随 schema，不是放宽断言）。
    artifacts: [],
    shared_facts: [],
  };
}

describe('守恒类断言（0.4 第 2 类）', () => {
  it('uniqueMessageIds 找出重复 message_id（A04-06）', () => {
    const result = uniqueMessageIds([entry(m('m-1')), entry(m('m-2')), entry(m('m-1'))]);
    expect(result.unique).toEqual(['m-1', 'm-2']);
    expect(result.duplicates).toEqual(['m-1']);
    expect(() => assertUniqueMessageIds([entry(m('m-1')), entry(m('m-1'))])).toThrow(
      ConservationViolationError,
    );
    expect(() => assertUniqueMessageIds([entry(m('m-1'))])).not.toThrow();
  });

  it('assertInboxMessageIds 同时报缺失与多余（A02-04 / A03-05）', () => {
    const entries = [entry(m('m-1')), entry(m('m-2'))];
    expect(() => assertInboxMessageIds(entries, [m('m-1'), m('m-2')])).not.toThrow();
    expect(() => assertInboxMessageIds(entries, [m('m-1'), m('m-3')])).toThrow(/缺失/);
    expect(() => assertInboxMessageIds(entries, [m('m-1')])).toThrow(/多余/);
  });

  it('indexWorkItems 找出重复 request_id（A02-06 / A04-02）', () => {
    const { byRequestId, duplicates } = indexWorkItems([item(r('r-1')), item(r('r-1')), item(r('r-2'))]);
    expect(duplicates).toEqual(['r-1']);
    expect(byRequestId.size).toBe(2);
    expect(() => assertUniqueRequestIds([item(r('r-1')), item(r('r-1'))])).toThrow(
      ConservationViolationError,
    );
  });

  it('findItemsWithoutOutcome / assertEveryItemHasOutcome（A02-08 / A03-08 / P4-09）', () => {
    const ok = item(r('r-1'), { status: 'completed', blocker_reason: null, result_refs: [] });
    const offender = item(r('r-2'), { status: 'processing', blocker_reason: null });
    const waiting = item(r('r-3'), {
      status: 'waiting_dependency',
      blocker_reason: { kind: 'waiting_dependency', detail: '等 r-x' },
      dependency_refs: [{ request_id: r('r-x') }],
    });
    const list = [ok, offender, waiting];
    expect(findItemsWithoutOutcome(list).map((work) => work.request_id)).toEqual(['r-2']);
    expect(() => assertEveryItemHasOutcome(list)).toThrow(/既非终态/);
    expect(() => assertEveryItemHasOutcome([ok, waiting])).not.toThrow();
  });

  it('findCompletedWithoutResult（A03-10 / P4-10：读即完成的反作弊）', () => {
    const silent = item(r('r-1'), { status: 'completed', blocker_reason: null });
    const withResult = item(r('r-2'), {
      status: 'completed',
      blocker_reason: null,
      result_refs: [asArtifactRef('r-2#result')],
    });
    expect(findCompletedWithoutResult([silent, withResult]).map((work) => work.request_id)).toEqual(['r-1']);
  });

  it('findUnmappedMessages / findItemsWithoutTriggeringMessage（丢请求与孤儿）', () => {
    const entries = [entry(m('m-1')), entry(m('m-2'))];
    const items = [item(r('r-1'))]; // 由 m-r-1 触发 → 与 m-1 / m-2 都不匹配
    const snapshot = snapshotOf(entries, items);
    expect(findUnmappedMessages(snapshot)).toEqual(['m-1', 'm-2']);
    expect(findItemsWithoutTriggeringMessage([item(r('r-9'), { triggering_message_ids: [] })])).toHaveLength(1);
  });

  it('messageToRequestIds 给出归属映射（A02-06 的「一对一」判据材料）', () => {
    const items = [
      item(r('r-1'), { triggering_message_ids: [m('m-1')] }),
      item(r('r-2'), { triggering_message_ids: [m('m-1'), m('m-2')] }),
    ];
    const map = messageToRequestIds(snapshotOf([], items));
    expect(map.get(m('m-1'))).toEqual(['r-1', 'r-2']);
    expect(map.get(m('m-2'))).toEqual(['r-2']);
    expect(map.get(m('m-3'))).toBeUndefined();
  });
});

describe('观测字段表的汇总项', () => {
  it('statusDistribution 六态齐全，缺项记 0（R3 的观测最小集）', () => {
    const distribution = statusDistribution([
      item(r('r-1'), { status: 'completed', blocker_reason: null }),
      item(r('r-2'), { status: 'completed', blocker_reason: null }),
      item(r('r-3'), { status: 'failed', blocker_reason: null, failure_reason: '工具失败' }),
    ]);
    expect(distribution).toEqual({
      pending: 0,
      processing: 0,
      waiting_dependency: 0,
      completed: 2,
      failed: 1,
      cancelled: 0,
    });
  });

  it('summarizeBlockers 逐项列出阻塞原因与在等哪一项（P4-02 / A05-06）', () => {
    const summaries = summarizeBlockers([
      item(r('r-1'), {
        status: 'waiting_dependency',
        blocker_reason: { kind: 'waiting_dependency', detail: '等 jx 的结果' },
        dependency_refs: [{ request_id: r('r-x') }],
      }),
      item(r('r-2'), { status: 'failed', blocker_reason: null, failure_reason: '工具 502' }),
    ]);
    expect(summaries[0]).toEqual({
      request_id: 'r-1',
      status: 'waiting_dependency',
      blocker_kind: 'waiting_dependency',
      blocker_detail: '等 jx 的结果',
      depends_on_request_ids: ['r-x'],
      failure_reason: null,
    });
    expect(summaries[1]).toMatchObject({ blocker_kind: null, failure_reason: '工具 502' });
  });

  it('inboxOf 取某实例的收件箱条目', () => {
    const other = createInboxEntry({
      message_id: m('m-other'),
      instance_id: asInstanceId('D'),
      group_id: GROUP,
      task_id: TASK,
      sequence: 1,
      received_at: T(0),
      requires_wakeup: true,
    });
    expect(inboxOf(snapshotOf([entry(m('m-1')), other], []), C).map((e) => e.message_id)).toEqual(['m-1']);
  });

  it('compareReadAndDone：已读未登记 / 已完成却从未读入（合同 §九-5）', () => {
    const readReceipt = createReadReceipt({
      message_id: m('m-1'),
      instance_id: C,
      run_id: RUN1,
      read_at: T(0),
    });
    const unreadCompleted = item(r('r-9'), {
      status: 'completed',
      blocker_reason: null,
      snapshot_run_ids: [],
    });
    const readCompleted = item(r('r-1'), {
      status: 'completed',
      blocker_reason: null,
      snapshot_run_ids: [RUN1],
      triggering_message_ids: [m('m-1')],
    });
    const report = compareReadAndDone(snapshotOf([entry(m('m-1'))], [unreadCompleted, readCompleted], [readReceipt]), C);
    expect(report.read_without_work).toEqual([]);
    expect(report.done_without_read).toEqual(['r-9']);
  });

  it('已读但没有任何工作项承载 → read_without_work 报出来（P4-11）', () => {
    const readReceipt = createReadReceipt({
      message_id: m('m-orphan'),
      instance_id: C,
      run_id: RUN1,
      read_at: T(0),
    });
    const report = compareReadAndDone(
      snapshotOf([entry(m('m-orphan'))], [item(r('r-1'))], [readReceipt]),
      C,
    );
    expect(report.read_without_work).toEqual(['m-orphan']);
  });
});

describe('断言辅助不修改只读快照', () => {
  it('调用前后快照逐字节不变', () => {
    const snapshot = snapshotOf([entry(m('m-1'))], [item(r('r-1'))]);
    const before = JSON.stringify(snapshot);
    uniqueMessageIds(snapshot.inbox_entries);
    indexWorkItems(snapshot.work_items);
    statusDistribution(snapshot.work_items);
    summarizeBlockers(snapshot.work_items);
    messageToRequestIds(snapshot);
    findUnmappedMessages(snapshot);
    compareReadAndDone(snapshot, C);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('消息构造未参与断言路径（夹具只读快照，不碰 sender 绑定）', () => {
    const message = createMessage(
      {
        message_id: m('m-1'),
        task_id: TASK,
        group_id: GROUP,
        task_revision: REV1,
        recipient_instance_id: C,
        type: 'work_request',
        requires_wakeup: true,
      },
      SenderBinding.bind(S1, { group_id: GROUP, task_id: TASK }),
      { idSource: { newMessageId: () => m('unused') } },
    );
    expect(message.sender_instance_id).toBe('S1');
  });
});
