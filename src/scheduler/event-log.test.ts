/**
 * KRN-10 事件侧：**必录清单 + 丢弃检出 + 顺序约束 + 只读审计**。
 *
 * ## 这个文件要钉死的判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 完整日志 ⇒ 四域必录齐备，`dropped=false`、`repaired=false`、`read_only=true` | 正例 |
 * | 2 | 人为丢一条必录事件（清单对账）⇒ 审计报缺 | **反向对照（主判据）** |
 * | 3 | 丢一条**清单之外**的事件 ⇒ 只靠**序号洞**检出 | **反向对照** |
 * | 4 | 待投递事件与内核事件**共用 evt 序号空间** ⇒ 不得误报为洞（S6 教训） | **防分类混淆** |
 * | 5 | 先投递后保存 / 投递了没落盘意图 ⇒ 顺序违规 | **反例** |
 * | 6 | 已确认完成而缺可信回执 / 缺副作用留痕 ⇒ 动作域报缺 | **反例** |
 * | 7 | `user_reported_complete` **不得**当确认完成（无回执不是缺陷） | **反向对照** |
 * | 8 | 审计不写任何东西（快照前后一致） | 只读纪律 |
 *
 * ## 介质说明
 *
 * 本文件全部在**同进程**内构造快照（内存 Store + 手搓快照覆盖），
 * **未做真实双进程**实测——跨进程结论不在本文件的口径内，不作为其判据。
 */

import { describe, expect, it } from 'vitest';

import {
  asEventId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createKernelEvent,
  createRunRecord,
  createWorkItem,
  markEventDelivered,
  type EventIdSource,
  type GroupId,
  type InstanceId,
  type KernelEvent,
  type PendingEvent,
  type StoreSnapshot,
  type TaskId,
} from '../protocol/index.js';
import { createSideEffect } from '../workledger/index.js';
import { createMemoryStore } from '../storage/index.js';
import { prepareAction, applyActionTransition, type ActionRecord } from '../workledger/index.js';
import { buildMessage } from './test-support.js';
import {
  EVENT_DOMAINS,
  MANDATORY_EVENTS,
  auditEventLog,
  auditActionRecords,
  checkSaveBeforeDeliver,
  describeEventLogAudit,
  detectEventIdGaps,
  missingRequiredEvents,
  requiredKernelEventsOf,
} from './event-log.js';

const TASK: TaskId = asTaskId('T1');
const GROUP = 'G1' as GroupId;
const INSTANCE: InstanceId = asInstanceId('C');

/** 以内存 Store 的空快照为底，按需覆盖字段（避免手搓 14 个空集合）。 */
function emptyBase(): StoreSnapshot {
  return createMemoryStore().snapshot();
}

function snap(over: Partial<StoreSnapshot>): StoreSnapshot {
  return { ...emptyBase(), ...over };
}

function kernelEvent(
  idSource: EventIdSource,
  input: Parameters<typeof createKernelEvent>[0],
): KernelEvent {
  return createKernelEvent(input, idSource);
}

/** 一小段"完全合规"的持久记录 + 事件日志：1 消息 + 1 工作项 + 1 已完成轮次 + 1 未投递 outbox。 */
function healthyFixture(): {
  readonly snapshot: StoreSnapshot;
  readonly delivery: readonly PendingEvent[];
} {
  const ids = createIdSource();
  const message = buildMessage({ message_id: asMessageId('m-1') });
  const item = createWorkItem({
    request_id: asRequestId('r-1'),
    task_id: TASK,
    owner_instance_id: INSTANCE,
    created_at: asLogicalTime(2),
    status: 'pending',
    blocker_reason: { kind: 'other', detail: '待调度' },
  });
  const run = createRunRecord({
    run_id: asRunId('run-1'),
    task_id: TASK,
    group_id: GROUP,
    instance_id: INSTANCE,
    task_revision: asRevision(1),
    started_at: asLogicalTime(2),
    lease_deadline: asLogicalTime(1002),
    status: 'finished',
    finished_at: asLogicalTime(3),
  });
  const events: KernelEvent[] = [
    kernelEvent(ids, {
      kind: 'message_accepted',
      at: asLogicalTime(1),
      task_id: TASK,
      message_id: message.message_id,
    }),
    kernelEvent(ids, {
      kind: 'work_item_created',
      at: asLogicalTime(2),
      task_id: TASK,
      request_id: item.request_id,
    }),
    kernelEvent(ids, { kind: 'run_started', at: asLogicalTime(2), task_id: TASK, run_id: run.run_id }),
    kernelEvent(ids, { kind: 'run_finished', at: asLogicalTime(3), task_id: TASK, run_id: run.run_id }),
  ];
  // outbox：与记录同批提交（先保存），未投递。
  const delivery = [
    createDeliveryEvent(
      {
        kind: 'wakeup_queued',
        task_id: TASK,
        group_id: GROUP,
        instance_id: INSTANCE,
        created_at: asLogicalTime(2),
        reason: '工作项可运行',
      },
      ids,
    ),
  ];
  return {
    snapshot: snap({ messages: [message], work_items: [item], runs: [run], kernel_events: events }),
    delivery,
  };
}

describe('KRN-10 事件侧：必录清单', () => {
  it('① 四域齐备，且清单里声明的种类都在 KERNEL_EVENT_KINDS 内', () => {
    for (const domain of EVENT_DOMAINS) {
      expect(MANDATORY_EVENTS[domain].domain).toBe(domain);
    }
    expect(MANDATORY_EVENTS.action.carrier).toBe('action_ledger');
    expect(MANDATORY_EVENTS.message.kinds).toEqual(['message_accepted']);
    expect(MANDATORY_EVENTS.task.kinds).toContain('run_finished');
  });

  it('② 从持久记录反推必录事件：消息 / 工作项 / 轮次各就其位', () => {
    const { snapshot } = healthyFixture();
    const required = requiredKernelEventsOf(snapshot);
    const identities = required.map((r) => `${r.kind}#${r.subject}`);
    expect(identities).toContain('message_accepted#m-1');
    expect(identities).toContain('work_item_created#r-1');
    expect(identities).toContain('run_started#run-1');
    expect(identities).toContain('run_finished#run-1');
    // run_started 同时被任务域与预算域要求 ⇒ 合并成一条，不重复计。
    expect(identities.filter((id) => id === 'run_started#run-1')).toHaveLength(1);
  });
});

describe('KRN-10 事件侧：丢弃检出', () => {
  it('③ 完整日志 ⇒ 无缺失、无洞、`dropped=false`、`repaired=false`、`read_only=true`', () => {
    const { snapshot, delivery } = healthyFixture();
    const full = snap({ ...snapshot, delivery_events: delivery });
    const audit = auditEventLog({ snapshot: full });
    expect(audit.missing_required).toEqual([]);
    expect(audit.gaps).toEqual([]);
    expect(audit.ordering_violations).toEqual([]);
    expect(audit.dropped).toBe(false);
    expect(audit.repaired).toBe(false);
    expect(audit.read_only).toBe(true);
    expect(describeEventLogAudit(audit)).toContain('通过');
  });

  it('④ 反向对照（主判据）：人为丢一条**必录**事件 ⇒ 审计报缺（不静默补齐）', () => {
    const { snapshot } = healthyFixture();
    // 丢的是**最后一条**（run_finished），并把 outbox 一并排除 ⇒ 序号仍连续（无洞）。
    // 这样做的目的：让**只有清单对账**能检出这条缺失，与序号洞判据清晰分离。
    const dropped = snapshot.kernel_events.filter((e) => e.kind !== 'run_finished');
    const audit = auditEventLog({
      snapshot: snap({ ...snapshot, kernel_events: dropped, delivery_events: [] }),
    });
    expect(audit.gaps, '序号仍连续，洞检不出这条').toEqual([]);
    expect(audit.missing_required.map((m) => m.kind)).toEqual(['run_finished']);
    expect(audit.missing_required[0]?.subject).toBe('run-1');
    expect(audit.dropped).toBe(true);
    // 只读：不得返回任何"已补齐"的东西。
    expect(audit.repaired).toBe(false);
  });

  it('⑤ 反向对照：丢一条**清单之外**的事件 ⇒ 只靠序号洞检出', () => {
    const ids = createIdSource();
    // evt-1 与 evt-3 在，evt-2 被丢；且 evt-2 对应的对象**不在**任何持久记录里
    // （模拟"记录本身也不见了，清单对账无从下手"）。
    const events = [
      kernelEvent(ids, { kind: 'recovery_performed', at: asLogicalTime(1) }),
      kernelEvent(ids, { kind: 'delivery_event_published', at: asLogicalTime(3) }),
    ];
    // ids 实际发到 evt-2；重排一次拿到 evt-1 / evt-3 的效果：手工把第二条改成 evt-3。
    const withHole = events.map((e, index) =>
      index === 1 ? { ...e, event_id: asEventId('evt-3') } : { ...e, event_id: asEventId('evt-1') },
    );
    const gaps = detectEventIdGaps({ kernel_events: withHole, delivery_events: [] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missing).toEqual([2]);
    expect(missingRequiredEvents(snap({ kernel_events: withHole }))).toEqual([]);
  });

  it('⑥ 待投递事件与内核事件**共用 evt 序号空间** ⇒ 不得误报为洞（S6 教训）', () => {
    const ids = createIdSource();
    const first = kernelEvent(ids, { kind: 'recovery_performed', at: asLogicalTime(1) });
    const shared = createDeliveryEvent(
      { kind: 'run_requested', task_id: TASK, group_id: GROUP, instance_id: INSTANCE, created_at: asLogicalTime(1), reason: 'r' },
      ids,
    );
    const third = kernelEvent(ids, { kind: 'recovery_performed', at: asLogicalTime(2) });
    // 内核集合里只有 evt-1 / evt-3；evt-2 是 outbox 事件。
    expect(detectEventIdGaps({ kernel_events: [first, third], delivery_events: [shared] })).toEqual([]);
    // 反向：把 outbox 事件拿走 ⇒ 同一个洞立刻现身（证明上一条不是空转）。
    const gaps = detectEventIdGaps({ kernel_events: [first, third], delivery_events: [] });
    expect(gaps[0]?.missing).toEqual([2]);
  });
});

describe('KRN-10 事件侧：顺序约束（先保存再投递）', () => {
  it('⑦ 反例：先投递后保存 ⇒ `save_before_deliver` 违规', () => {
    const ids = createIdSource();
    const record = kernelEvent(ids, { kind: 'message_accepted', at: asLogicalTime(5), task_id: TASK, message_id: asMessageId('m-9') });
    const pending = markEventDelivered(
      createDeliveryEvent(
        { kind: 'wakeup_queued', task_id: TASK, group_id: GROUP, instance_id: INSTANCE, created_at: asLogicalTime(5), reason: 'r' },
        ids,
      ),
      asLogicalTime(3),
    );
    const violations = checkSaveBeforeDeliver({ kernel_events: [record], delivery_events: [pending] });
    expect(violations.map((v) => v.rule)).toContain('save_before_deliver');
  });

  it('⑧ 反例：投递了一个**还没落盘**的意图 ⇒ `record_before_deliver` 违规', () => {
    const ids = createIdSource();
    const lateRecord = kernelEvent(ids, { kind: 'work_item_created', at: asLogicalTime(9), task_id: TASK, request_id: asRequestId('r-1') });
    const pending = createDeliveryEvent(
      { kind: 'run_requested', task_id: TASK, group_id: GROUP, instance_id: INSTANCE, created_at: asLogicalTime(2), reason: 'r' },
      ids,
    );
    const violations = checkSaveBeforeDeliver({ kernel_events: [lateRecord], delivery_events: [pending] });
    expect(violations.map((v) => v.rule)).toEqual(['record_before_deliver']);
  });

  it('⑨ 正例：记录先落盘、提交后才投递 ⇒ 无违规', () => {
    const ids = createIdSource();
    const record = kernelEvent(ids, { kind: 'message_accepted', at: asLogicalTime(1), task_id: TASK, message_id: asMessageId('m-1') });
    const pending = markEventDelivered(
      createDeliveryEvent(
        { kind: 'wakeup_queued', task_id: TASK, group_id: GROUP, instance_id: INSTANCE, created_at: asLogicalTime(1), reason: 'r' },
        ids,
      ),
      asLogicalTime(2),
    );
    expect(checkSaveBeforeDeliver({ kernel_events: [record], delivery_events: [pending] })).toEqual([]);
  });
});

describe('KRN-10 事件侧：动作域（七态语义，逐字沿用）', () => {
  function authorized(): ActionRecord {
    return prepareAction({
      action_id: 'act-1',
      task_id: TASK,
      task_revision: asRevision(1),
      action_kind: 'open_page',
      params: { url: 'https://example.com' },
      authorization: {
        source: 'app.foreground',
        user_approved: true,
        task_revision: asRevision(1),
        revoked: false,
        subject_instance_id: null,
        granted_at: asLogicalTime(1),
      },
      at: asLogicalTime(1),
    });
  }

  it('⑩ 反例：已确认完成却缺可信回执 / 缺副作用留痕 ⇒ 报缺', () => {
    // 直接构造一个"自称已完成"但既无回执、又无副作用留痕的记录：
    // 这里刻意**绕过** applyActionTransition（它本会拒绝），以模拟"被写坏/被降级的记录"。
    const broken = { ...authorized(), state: 'confirmed_complete' } as ActionRecord;
    const defects = auditActionRecords([broken]);
    expect(defects.map((d) => d.reason).sort()).toEqual([
      'missing_side_effect_record',
      'missing_trusted_receipt',
    ]);
  });

  it('⑪ 反向对照：`user_reported_complete` 无回执**不是**缺陷（不等于确认完成）', () => {
    const submitted = applyActionTransition({
      action: authorized(),
      to: 'submitted',
      at: asLogicalTime(2),
      side_effect: createSideEffect({ effect_id: 'e-1', description: '打开了目标页', at: asLogicalTime(2) }),
    });
    const reported = applyActionTransition({
      action: submitted,
      to: 'user_reported_complete',
      at: asLogicalTime(3),
      user_report: { message_id: asMessageId('m-2'), note: '用户说完成了' },
    });
    expect(reported.state).toBe('user_reported_complete');
    expect(auditActionRecords([reported])).toEqual([]);
  });

  it('⑫ 正例：已确认完成 + 可信回执 + 副作用留痕 ⇒ 无缺陷', () => {
    const submitted = applyActionTransition({
      action: authorized(),
      to: 'submitted',
      at: asLogicalTime(2),
      side_effect: createSideEffect({ effect_id: 'e-1', description: '打开了目标页', at: asLogicalTime(2) }),
    });
    const confirmed = applyActionTransition({
      action: submitted,
      to: 'confirmed_complete',
      at: asLogicalTime(3),
      receipt: { trusted: true, source: 'browser', detail: '页面已打开', at: asLogicalTime(3) },
    });
    expect(confirmed.state).toBe('confirmed_complete');
    expect(auditActionRecords([confirmed])).toEqual([]);
  });
});

describe('KRN-10 事件侧：只读纪律', () => {
  it('⑬ 审计不写任何东西：快照前后逐字段一致', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putMessage(buildMessage({ message_id: asMessageId('m-1') }));
    });
    const before = store.snapshot();
    auditEventLog({ snapshot: before });
    const after = store.snapshot();
    expect(after).toEqual(before);
  });
});
