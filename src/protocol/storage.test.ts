/**
 * 存储新增集合（`artifacts` / `shared_facts`）的事务语义，以及**既有字段与计数未被改动**的对照断言。
 *
 * 这里刻意与 `src/storage/memory-store.test.ts`（D01 的既有测试，本包不得修改）分开：
 * 本文件只覆盖 design-02 A 批**加法**部分的行为，并用对照断言证明既有快照字段
 * 与 `counters.ts` 的计数口径没有变化。
 */

import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../storage/index.js';
import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  createTaskRecord,
  createWorkItem,
  PersistenceError,
  snapshotArtifacts,
  snapshotSharedFacts,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  type ArtifactRecordInput,
  type ArtifactRecord,
  type SharedFactRecordInput,
  type StoreSnapshot,
  type TransactionSummary,
} from './index.js';

const TASK = asTaskId('T1');
const INSTANCE = asInstanceId('I-A');
const R1 = asRevision(1);
const T0 = asLogicalTime(0);

function artifactInput(overrides: Partial<ArtifactRecordInput> = {}): ArtifactRecordInput {
  return {
    artifact_id: asArtifactRef('art-1'),
    task_id: TASK,
    task_revision: R1,
    artifact_version: 1,
    template_kind: 'document',
    byte_length: 100,
    content_digest: 'sha256:abc',
    source_fact_refs: [asFactRef('fact-1')],
    created_by_instance_id: INSTANCE,
    status: 'staged',
    created_at: T0,
    ...overrides,
  };
}

function factInput(overrides: Partial<SharedFactRecordInput> = {}): SharedFactRecordInput {
  return {
    fact_id: asFactRef('fact-1'),
    task_id: TASK,
    task_revision: R1,
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmed_by: INSTANCE,
    confirmed_at: T0,
    ...overrides,
  };
}

function seedWorkItem(store: ReturnType<typeof createMemoryStore>) {
  store.transact((tx) => {
    tx.putTask(createTaskRecord({ task_id: TASK, goal: '组织一次十人晚宴', created_at: T0 }));
    tx.putWorkItem(
      createWorkItem({
        request_id: asRequestId('req-1'),
        task_id: TASK,
        task_revision: R1,
        owner_instance_id: INSTANCE,
        created_at: T0,
        status: 'pending',
        blocker_reason: { kind: 'waiting_user', detail: '等用户确认人数' },
      }),
    );
  });
}

describe('新增集合的事务可见性', () => {
  it('事务内写的产物与事实，提交前外部看不到', () => {
    const store = createMemoryStore();
    seedWorkItem(store);
    expect(snapshotArtifacts(store.snapshot())).toEqual([]);

    let insideCount = -1;
    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput()));
      tx.putSharedFact(createSharedFactRecord(factInput()));
      // 事务内可见
      insideCount = tx.listArtifacts().length;
      expect(tx.getArtifact(asArtifactRef('art-1'))?.artifact_id).toBe('art-1');
      expect(tx.getSharedFact(asFactRef('fact-1'))?.fact_key).toBe('headcount');
    });

    expect(insideCount).toBe(1);
    // 提交后可见
    expect(snapshotArtifacts(store.snapshot()).map((r) => r.artifact_id)).toEqual(['art-1']);
    expect(snapshotSharedFacts(store.snapshot()).map((r) => r.fact_id)).toEqual(['fact-1']);
  });

  it('事务体内抛错 ⇒ 新增集合与同事务的其它写入一并丢弃（未接受）', () => {
    const store = createMemoryStore();
    expect(() =>
      store.transact((tx) => {
        tx.putTask(createTaskRecord({ task_id: TASK, goal: 'x', created_at: T0 }));
        tx.putArtifact(createArtifactRecord(artifactInput()));
        tx.putSharedFact(createSharedFactRecord(factInput()));
        throw new Error('事务体内失败');
      }),
    ).toThrow(PersistenceError);

    const snapshot = store.snapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshotArtifacts(snapshot)).toEqual([]);
    expect(snapshotSharedFacts(snapshot)).toEqual([]);
  });

  it('提交前故障接缝抛错 ⇒ 已写入的产物不落库（accepted === false）', () => {
    const store = createMemoryStore();
    store.faults.beforeCommit = () => {
      throw new Error('提交前注入失败');
    };
    expect(() =>
      store.transact((tx) => {
        tx.putArtifact(createArtifactRecord(artifactInput()));
      }),
    ).toThrow(PersistenceError);
    expect(snapshotArtifacts(store.snapshot())).toEqual([]);
  });

  it('同一 artifact_id 重复写入按既有集合的语义覆盖（不是追加）', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput({ byte_length: 1 })));
      tx.putArtifact(createArtifactRecord(artifactInput({ byte_length: 2 })));
    });
    const records = snapshotArtifacts(store.snapshot());
    expect(records).toHaveLength(1);
    expect(records[0]?.byte_length).toBe(2);
  });
});

describe('TransactionSummary 的加法：artifact_ids', () => {
  it('既有 6 个字段名称与顺序不变，artifact_ids 追加在末尾且按写入顺序去重', () => {
    const store = createMemoryStore();
    const captured: TransactionSummary[] = [];
    store.faults.beforeCommit = (summary) => {
      captured.push(summary);
    };
    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput({ artifact_id: asArtifactRef('art-1') })));
      tx.putArtifact(createArtifactRecord(artifactInput({ artifact_id: asArtifactRef('art-2') })));
      tx.putArtifact(createArtifactRecord(artifactInput({ artifact_id: asArtifactRef('art-1') })));
    });
    const summary = captured[0];
    expect(summary).toBeDefined();
    expect(Object.keys(summary ?? {})).toEqual([
      'task_ids',
      'message_ids',
      'request_ids',
      'instance_ids',
      'run_ids',
      'event_ids',
      'artifact_ids',
    ]);
    expect(summary?.artifact_ids).toEqual(['art-1', 'art-2']);
  });

  it('没有产物写入时 artifact_ids 为空数组（不是 undefined）', () => {
    const store = createMemoryStore();
    const captured: TransactionSummary[] = [];
    store.faults.beforeCommit = (summary) => {
      captured.push(summary);
    };
    store.transact((tx) => {
      tx.putSharedFact(createSharedFactRecord(factInput()));
    });
    expect(captured[0]?.artifact_ids).toEqual([]);
  });
});

describe('对照断言：既有快照字段与计数口径未被改动', () => {
  it('新增集合不改变既有 12 个快照数组的内容', () => {
    const store = createMemoryStore();
    seedWorkItem(store);
    const before = store.snapshot();

    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput()));
      tx.putSharedFact(createSharedFactRecord(factInput()));
    });
    const after = store.snapshot();

    expect(after.tasks).toEqual(before.tasks);
    expect(after.task_control_states).toEqual(before.task_control_states);
    expect(after.messages).toEqual(before.messages);
    expect(after.inbox_entries).toEqual(before.inbox_entries);
    expect(after.read_receipts).toEqual(before.read_receipts);
    expect(after.actionable_inputs).toEqual(before.actionable_inputs);
    expect(after.work_items).toEqual(before.work_items);
    expect(after.instances).toEqual(before.instances);
    expect(after.group_members).toEqual(before.group_members);
    expect(after.runs).toEqual(before.runs);
    expect(after.delivery_events).toEqual(before.delivery_events);
    expect(after.kernel_events).toEqual(before.kernel_events);
    // 既有的 12 个键一个不少、一个不多；**新增集合只能是这里具名的这几个**。
    //
    // 为什么改成"具名白名单"而不是钉死总数：这条断言的真实意图是"**除了明确登记的新集合，
    // 快照不多出别的东西**"。2026-10-03 用户把范围扩为"完整 App + 可恢复的持久后台内核"
    // 后，动作台账与任务生命周期（KRN-07/KRN-09）必须落进同一个 Store（不另造存储），
    // 由 FA-S 追加了 `actions` 与 `task_lifecycles` —— 那是**已授权的加法**，
    // 而"12 个键"这个数字在范围扩展时必然过期。钉白名单既保住原意（没有意外新增），
    // 也不需要在每次合法扩展时改一个数字。
    const ADDED_COLLECTIONS = ['artifacts', 'shared_facts', 'actions', 'task_lifecycles'];
    const legacyKeys = Object.keys(before).filter((key) => !ADDED_COLLECTIONS.includes(key));
    expect(legacyKeys).toHaveLength(12);
    // 集合相等（不锁插入顺序：顺序不是这条断言要守的不变量）。
    expect([...Object.keys(after)].sort()).toEqual([...legacyKeys, ...ADDED_COLLECTIONS].sort());
  });

  it('快照侧计数（R19 的 2 项）不因新增集合而变', () => {
    const store = createMemoryStore();
    seedWorkItem(store);
    const before = summarizeSnapshotCounters(store.snapshot());
    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput()));
      tx.putSharedFact(createSharedFactRecord(factInput()));
    });
    const after = summarizeSnapshotCounters(store.snapshot());
    expect(after).toEqual(before);
    expect(before.work_item_status_distribution.pending).toBe(1);
    expect(Object.keys(before.work_item_status_distribution)).toHaveLength(6);
  });

  it('事件侧计数（6 项）不因新增集合而变', () => {
    const store = createMemoryStore();
    seedWorkItem(store);
    const before = summarizeKernelEvents(store.snapshot().kernel_events);
    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput()));
    });
    const after = summarizeKernelEvents(store.snapshot().kernel_events);
    expect(after).toEqual(before);
    expect(after).toEqual({
      run_count: 0,
      rejected_publication_count: 0,
      peak_active_runs: 0,
      peak_queued_flags: 0,
      diagnosis_count: 0,
      inbox_message_count: 0,
    });
  });

  it('内存实现一定提供两个新数组；手搓字面量省略时由归一化读取口兜底', () => {
    const store = createMemoryStore();
    const snapshot = store.snapshot();
    expect(Array.isArray(snapshot.artifacts)).toBe(true);
    expect(Array.isArray(snapshot.shared_facts)).toBe(true);

    const handBuilt = { work_items: [] } as unknown as StoreSnapshot;
    expect(snapshotArtifacts(handBuilt)).toEqual([]);
    expect(snapshotSharedFacts(handBuilt)).toEqual([]);
  });

  it('reset() 后新增集合一并清空', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putArtifact(createArtifactRecord(artifactInput()));
      tx.putSharedFact(createSharedFactRecord(factInput()));
    });
    expect(snapshotArtifacts(store.snapshot())).toHaveLength(1);
    store.reset();
    expect(snapshotArtifacts(store.snapshot())).toEqual([]);
    expect(snapshotSharedFacts(store.snapshot())).toEqual([]);
  });
});

describe('产物记录在快照里保持只读', () => {
  it('快照返回的产物数组被冻结，元素仍是同一份冻结记录', () => {
    const store = createMemoryStore();
    const record: ArtifactRecord = createArtifactRecord(artifactInput());
    store.transact((tx) => {
      tx.putArtifact(record);
    });
    const artifacts = snapshotArtifacts(store.snapshot());
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(artifacts[0]).toEqual(record);
    expect(Object.isFrozen(artifacts[0])).toBe(true);
  });
});
