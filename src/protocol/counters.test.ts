import { describe, expect, it } from 'vitest';

import {
  asEventId,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  blockerKindsOf,
  createIdSource,
  createKernelEvent,
  EventCountingError,
  EVENT_STREAM_COHERENCE,
  mergeSchedulingCounters,
  statusDistribution,
  summarizeBlockers,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  WORK_ITEM_STATUSES,
  type KernelEvent,
  type KernelEventInput,
  type StoreSnapshot,
  type WorkItem,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const D = asInstanceId('D');
const ids = createIdSource({ seed: 'evt' });

function ev(seq: number, input: Omit<KernelEventInput, 'at'> & { at?: number }): KernelEvent {
  return createKernelEvent(
    { ...input, at: asLogicalTime(input.at ?? 0), event_id: asEventId(`e-${seq}`) },
    ids,
  );
}

// ---------------------------------------------------------------------------
// 事件侧：6 项
// ---------------------------------------------------------------------------

describe('summarizeKernelEvents → EventCounters（v1.1 R4/R19：只算事件可算的 6 项）', () => {
  it('空事件流的真实值是全 0（不是占位符）', () => {
    const counters = summarizeKernelEvents([]);
    expect(counters.run_count).toBe(0);
    expect(counters.peak_active_runs).toBe(0);
    expect(counters.peak_queued_flags).toBe(0);
    expect(counters.inbox_message_count).toBe(0);
  });

  it('**不**伪造快照侧字段（R19：两组由类型强制，缺失即观测不完整）', () => {
    const counters = summarizeKernelEvents([]);
    expect('work_item_status_distribution' in counters).toBe(false);
    expect('blocker_reasons' in counters).toBe(false);
    expect(Object.keys(counters).sort()).toEqual(
      [
        'diagnosis_count',
        'inbox_message_count',
        'peak_active_runs',
        'peak_queued_flags',
        'rejected_publication_count',
        'run_count',
      ].sort(),
    );
  });

  it('真实算出运行轮次数与峰值活动轮次（重叠时才 > 1）', () => {
    const counters = summarizeKernelEvents([
      ev(1, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
      ev(2, { kind: 'run_started', run_id: asRunId('r2'), instance_id: D }),
      ev(3, { kind: 'run_finished', run_id: asRunId('r1') }),
      ev(4, { kind: 'run_started', run_id: asRunId('r3'), instance_id: C }),
    ]);
    expect(counters.run_count).toBe(3);
    expect(counters.peak_active_runs).toBe(2);
  });

  it('单实例顺序执行时峰值活动轮次为 1（A02 的判据，按 R17 用等号断言）', () => {
    const counters = summarizeKernelEvents([
      ev(1, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
      ev(2, { kind: 'run_finished', run_id: asRunId('r1') }),
      ev(3, { kind: 'run_started', run_id: asRunId('r2'), instance_id: C }),
      ev(4, { kind: 'run_finished', run_id: asRunId('r2') }),
    ]);
    expect(counters.run_count).toBe(2);
    expect(counters.peak_active_runs).toBe(1);
  });

  it('峰值排队标记按"同时为真的实例数"计，清除后回落', () => {
    const counters = summarizeKernelEvents([
      ev(1, { kind: 'delegation_queue_enqueued', instance_id: C }),
      ev(2, { kind: 'delegation_queue_enqueued', instance_id: D }),
      ev(3, { kind: 'delegation_queue_cleared', instance_id: C }),
    ]);
    expect(counters.peak_queued_flags).toBe(2);
  });

  it('被拒绝发布次数单列，不计入 run_count；诊断次数独立', () => {
    const counters = summarizeKernelEvents([
      ev(1, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
      ev(2, { kind: 'publication_rejected', rejection_reason: 'stale_task_revision', run_id: asRunId('r1') }),
      ev(3, { kind: 'publication_rejected', rejection_reason: 'lease_expired', run_id: asRunId('r1') }),
      ev(4, { kind: 'diagnosis_performed' }),
    ]);
    expect(counters.run_count).toBe(1);
    expect(counters.rejected_publication_count).toBe(2);
    expect(counters.diagnosis_count).toBe(1);
  });

  it('收件箱条数按 (实例, 消息) 去重', () => {
    const counters = summarizeKernelEvents([
      ev(1, { kind: 'message_accepted', message_id: asMessageId('m1'), instance_id: C }),
      ev(2, { kind: 'message_accepted', message_id: asMessageId('m2'), instance_id: C }),
      ev(3, { kind: 'message_accepted', message_id: asMessageId('m1'), instance_id: C }),
      ev(4, { kind: 'message_accepted', message_id: asMessageId('m1'), instance_id: D }),
    ]);
    expect(counters.inbox_message_count).toBe(3);
  });

  it('返回的计数器是冻结的（防调用方就地改写观测值）', () => {
    expect(Object.isFrozen(summarizeKernelEvents([]))).toBe(true);
  });

  it('不参与计数的事件种类被忽略，但不会污染计数器', () => {
    const counters = summarizeKernelEvents([
      ev(1, { kind: 'message_duplicate_rejected', message_id: asMessageId('m1'), instance_id: C }),
      ev(2, { kind: 'inbox_message_consumed', message_id: asMessageId('m1'), instance_id: C }),
      ev(3, { kind: 'task_revision_advanced', task_id: TASK, group_id: GROUP }),
      ev(4, { kind: 'work_item_status_changed', request_id: asRequestId('q1') }), // 不要求 data.status
    ]);
    expect(counters.inbox_message_count).toBe(0);
    expect(counters.run_count).toBe(0);
  });
});

describe('summarizeKernelEvents：算不出就抛错，绝不静默 0（v1.1 R4）', () => {
  function counterOf(fn: () => unknown): string | undefined {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error instanceof EventCountingError ? error.counter : `非预期错误：${String(error)}`;
    }
  }

  it('run_started 缺 run_id → run_count 抛错', () => {
    expect(counterOf(() => summarizeKernelEvents([ev(1, { kind: 'run_started', instance_id: C })]))).toBe(
      'run_count',
    );
  });

  it('run_finished 无法与 run_started 配对 → peak_active_runs 抛错', () => {
    expect(
      counterOf(() => summarizeKernelEvents([ev(1, { kind: 'run_finished', run_id: asRunId('ghost') })])),
    ).toBe('peak_active_runs');
  });

  it('delegation_queue_* 缺 instance_id → peak_queued_flags 抛错', () => {
    expect(counterOf(() => summarizeKernelEvents([ev(1, { kind: 'delegation_queue_enqueued' })]))).toBe(
      'peak_queued_flags',
    );
    expect(counterOf(() => summarizeKernelEvents([ev(1, { kind: 'delegation_queue_cleared' })]))).toBe(
      'peak_queued_flags',
    );
  });

  it('message_accepted 缺 message_id 或 instance_id → inbox_message_count 抛错', () => {
    expect(
      counterOf(() => summarizeKernelEvents([ev(1, { kind: 'message_accepted', instance_id: C })])),
    ).toBe('inbox_message_count');
    expect(
      counterOf(() =>
        summarizeKernelEvents([ev(1, { kind: 'message_accepted', message_id: asMessageId('m1') })]),
      ),
    ).toBe('inbox_message_count');
  });
});

describe('事件流自相矛盾 → 拒绝汇总（受控缺陷探测器，合同 R7/R18）', () => {
  function coherenceError(events: readonly KernelEvent[]): EventCountingError | undefined {
    try {
      summarizeKernelEvents(events);
      return undefined;
    } catch (error) {
      return error instanceof EventCountingError ? error : undefined;
    }
  }

  it('同一 run_id 被启动两次（“重复启动”缺陷）→ EVENT_STREAM_COHERENCE', () => {
    const error = coherenceError([
      ev(1, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
      ev(2, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
    ]);
    expect(error?.counter).toBe(EVENT_STREAM_COHERENCE);
    expect(error?.event_index).toBe(1);
  });

  it('同一 run_id 被结束两次 → EVENT_STREAM_COHERENCE', () => {
    const error = coherenceError([
      ev(1, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
      ev(2, { kind: 'run_finished', run_id: asRunId('r1') }),
      ev(3, { kind: 'run_finished', run_id: asRunId('r1') }),
    ]);
    expect(error?.counter).toBe(EVENT_STREAM_COHERENCE);
  });

  it('同一 request_id 被创建两次（“重复建工作”缺陷）→ EVENT_STREAM_COHERENCE', () => {
    const error = coherenceError([
      ev(1, { kind: 'work_item_created', request_id: asRequestId('q1') }),
      ev(2, { kind: 'work_item_created', request_id: asRequestId('q1') }),
    ]);
    expect(error?.counter).toBe(EVENT_STREAM_COHERENCE);
  });

  it('work_item_created 缺 request_id → 无法做重复建工作探测，拒绝汇总', () => {
    expect(coherenceError([ev(1, { kind: 'work_item_created' })])?.counter).toBe(EVENT_STREAM_COHERENCE);
  });
});

// ---------------------------------------------------------------------------
// 快照侧：2 项
// ---------------------------------------------------------------------------

let itemSequence = 0;
function item(status: WorkItem['status'], overrides: Partial<WorkItem> = {}): WorkItem {
  itemSequence += 1;
  return {
    request_id: asRequestId(`q-${itemSequence}`),
    task_id: TASK,
    task_revision: asRevision(1),
    owner_instance_id: C,
    description: '',
    expected_output: '',
    status,
    dependency_refs: [],
    result_refs: [],
    blocker_reason: null,
    failure_reason: null,
    triggering_message_ids: [],
    included_in_snapshot: false,
    snapshot_run_ids: [],
    supersedes_request_id: null,
    created_at: asLogicalTime(0),
    updated_at: asLogicalTime(0),
    ...overrides,
  };
}

function snapshotWith(workItems: readonly WorkItem[]): StoreSnapshot {
  return {
    tasks: [],
    task_control_states: [],
    messages: [],
    inbox_entries: [],
    read_receipts: [],
    actionable_inputs: [],
    work_items: workItems,
    instances: [],
    group_members: [],
    runs: [],
    delivery_events: [],
    kernel_events: [],
    // design-02 A 批：快照集合**必填**（缺项会被读者当成"可能没有"，见 storage.ts 的说明）。
    artifacts: [],
    shared_facts: [],
  };
}

describe('summarizeSnapshotCounters → SnapshotCounters（v1.1 R19：只从快照算的 2 项）', () => {
  it('空快照：六态齐全且全 0（每个 0 都是真实观测，不是占位）', () => {
    const counters = summarizeSnapshotCounters(snapshotWith([]));
    expect(Object.keys(counters.work_item_status_distribution).sort()).toEqual(
      [...WORK_ITEM_STATUSES].sort(),
    );
    for (const status of WORK_ITEM_STATUSES) {
      expect(counters.work_item_status_distribution[status]).toBe(0);
    }
    expect(counters.blocker_reasons).toEqual([]);
  });

  it('按快照里的工作项真实计数（六态分布）', () => {
    const counters = summarizeSnapshotCounters(
      snapshotWith([
        item('pending'),
        item('processing'),
        item('processing'),
        item('completed'),
        item('failed', { failure_reason: '工具超时' }),
      ]),
    );
    expect(counters.work_item_status_distribution).toEqual({
      pending: 1,
      processing: 2,
      waiting_dependency: 0,
      completed: 1,
      failed: 1,
      cancelled: 0,
    });
  });

  it('阻塞原因去重、按首次出现顺序，且忽略 blocker 为空的工作项', () => {
    const counters = summarizeSnapshotCounters(
      snapshotWith([
        item('failed', { blocker_reason: { kind: 'capability_missing', detail: '没有该能力' } }),
        item('waiting_dependency', { blocker_reason: { kind: 'waiting_dependency', detail: '等 B' } }),
        item('processing', { blocker_reason: { kind: 'capability_missing', detail: '重复项' } }),
        item('completed'),
      ]),
    );
    expect(counters.blocker_reasons).toEqual(['capability_missing', 'waiting_dependency']);
  });

  it('返回的快照计数是冻结的', () => {
    const counters = summarizeSnapshotCounters(snapshotWith([]));
    expect(Object.isFrozen(counters)).toBe(true);
    expect(Object.isFrozen(counters.work_item_status_distribution)).toBe(true);
    expect(Object.isFrozen(counters.blocker_reasons)).toBe(true);
  });

  it('statusDistribution / blockerKindsOf 可单独用于一组工作项', () => {
    const items = [item('cancelled'), item('failed', { blocker_reason: { kind: 'other', detail: 'x' } })];
    expect(statusDistribution(items).cancelled).toBe(1);
    expect(blockerKindsOf(items)).toEqual(['other']);
  });

  it('summarizeBlockers 逐项列出"哪一项在等哪一项"（R3 观测字段表）', () => {
    const blockers = summarizeBlockers([
      item('waiting_dependency', {
        request_id: asRequestId('q-A'),
        blocker_reason: { kind: 'waiting_dependency', detail: '等待 B 的结果' },
        dependency_refs: [{ request_id: asRequestId('q-B') }, { instance_id: D }],
      }),
      item('failed', {
        request_id: asRequestId('q-C'),
        blocker_reason: { kind: 'capability_missing', detail: '没有该能力' },
        failure_reason: '无匹配能力',
      }),
    ]);

    expect(blockers[0]).toEqual({
      request_id: asRequestId('q-A'),
      status: 'waiting_dependency',
      blocker_kind: 'waiting_dependency',
      blocker_detail: '等待 B 的结果',
      depends_on_request_ids: [asRequestId('q-B')],
      failure_reason: null,
    });
    expect(blockers[1]?.failure_reason).toBe('无匹配能力');
  });
});

describe('mergeSchedulingCounters：把两组来源合成观测形状（R19）', () => {
  it('合并后 8 项齐全，且两组来源的字段都在', () => {
    const eventCounters = summarizeKernelEvents([
      ev(1, { kind: 'run_started', run_id: asRunId('r1'), instance_id: C }),
    ]);
    const snapshotCounters = summarizeSnapshotCounters(snapshotWith([item('completed')]));

    const merged = mergeSchedulingCounters(eventCounters, snapshotCounters);
    expect(Object.keys(merged).sort()).toEqual(
      [
        'blocker_reasons',
        'diagnosis_count',
        'inbox_message_count',
        'peak_active_runs',
        'peak_queued_flags',
        'rejected_publication_count',
        'run_count',
        'work_item_status_distribution',
      ].sort(),
    );
    expect(merged.run_count).toBe(1);
    expect(merged.work_item_status_distribution.completed).toBe(1);
    expect(Object.isFrozen(merged)).toBe(true);
  });
});
