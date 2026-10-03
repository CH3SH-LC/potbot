import { describe, expect, it } from 'vitest';

import {
  applyWorkItemTransition,
  createReopenedWorkItem,
  describeWorkItemOutcome,
  evaluateOutcomeCompleteness,
  evaluateWorkItemTransition,
  findReadButNotCompleted,
  findRequestsMissingWorkItem,
  findRequestsWithoutOutcome,
  groupWorkItemsByOwner,
  isReopenOf,
  isWorkLedgerError,
  markWorkItemReadBySnapshot,
  markWorkItemsReadBySnapshot,
  summarizeWorkLedger,
  type RunOrigin,
} from './index.js';
import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createInstanceState,
  createRunRecord,
  createWorkItem,
  type WorkItem,
  type WorkItemInput,
  type WorkItemStatus,
} from '../protocol/index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const RUN1 = asRunId('run-1');
const T0 = asLogicalTime(0);
const T5 = asLogicalTime(5);

type MkOver = Omit<Partial<WorkItemInput>, 'request_id' | 'status'> & {
  request_id?: string;
  status?: WorkItemStatus;
};

function mk(over: MkOver = {}): WorkItem {
  const { request_id, status, ...rest } = over;
  return createWorkItem({
    request_id: asRequestId(request_id ?? 'req-1'),
    task_id: TASK,
    // 与 `runFor()` 的默认冻结版本一致（r1）：否则 R42.1 第 3 步范围核对会先判 stale，
    // 让"终态锁定 / 负责人不符"等用例拿到错误的拒因。
    task_revision: asRevision(1),
    owner_instance_id: C,
    created_at: T0,
    status: status ?? 'pending',
    blocker_reason: { kind: 'waiting_user', detail: '等待用户确认' },
    ...rest,
  });
}

/** 直接构造"坏记录"（绕过 createWorkItem 的构造期校验），验证守卫而非构造器。 */
function corrupt(over: Partial<WorkItem>): WorkItem {
  return { ...mk(), ...over } as WorkItem;
}

const PENDING = mk();
const PROCESSING = mk({ status: 'processing' });
const WAITING = mk({
  status: 'waiting_dependency',
  blocker_reason: { kind: 'waiting_dependency', detail: '等待 req-B' },
  dependency_refs: [{ request_id: asRequestId('req-B') }],
});
const COMPLETED = mk({
  status: 'completed',
  result_refs: [asArtifactRef('art-1')],
  blocker_reason: null,
});
const FAILED = mk({ status: 'failed', failure_reason: '工具超时', blocker_reason: null });
const CANCELLED = mk({
  status: 'cancelled',
  blocker_reason: { kind: 'other', detail: '用户撤回' },
});

function instanceFor(instanceId = C, runId = RUN1) {
  return createInstanceState({
    instance_id: instanceId,
    group_id: GROUP,
    updated_at: T0,
    activity: 'active',
    active_run_id: runId,
    lease_deadline: asLogicalTime(1000),
  });
}

function runFor(instanceId = C, revision = 1) {
  return createRunRecord({
    run_id: RUN1,
    task_id: TASK,
    group_id: GROUP,
    instance_id: instanceId,
    task_revision: asRevision(revision),
    started_at: T0,
    lease_deadline: asLogicalTime(1000),
  });
}

function runOrigin(over: Partial<RunOrigin> = {}): RunOrigin {
  return {
    kind: 'run',
    run: 'run' in over ? over.run : runFor(),
    instance: 'instance' in over ? over.instance : instanceFor(),
    current_task_revision: over.current_task_revision ?? asRevision(1),
    now: over.now ?? asLogicalTime(500),
  };
}

// ---------------------------------------------------------------------------
// 合法转换
// ---------------------------------------------------------------------------

describe('合法转换路径（P4：每项请求有明确结局）', () => {
  it('待处理 → 处理中（内核发起），原因保留，时间戳推进', () => {
    const next = applyWorkItemTransition({ item: PENDING, to: 'processing', at: T5 });
    expect(next.status).toBe('processing');
    expect(next.blocker_reason).toEqual({ kind: 'waiting_user', detail: '等待用户确认' });
    expect(next.updated_at).toBe(T5);
    expect(next.created_at).toBe(T0);
    // 入参不被修改
    expect(PENDING.status).toBe('pending');
    expect(PENDING.updated_at).toBe(T0);
  });

  it('处理中 → 已完成：必须带结果引用，等待原因被清空', () => {
    const next = applyWorkItemTransition({
      item: PROCESSING,
      to: 'completed',
      at: T5,
      completion: { request_id: asRequestId('req-1'), result_refs: [asArtifactRef('art-final')] },
    });
    expect(next.status).toBe('completed');
    expect(next.result_refs).toEqual([asArtifactRef('art-final')]);
    expect(next.blocker_reason).toBe(null);
    expect(next.failure_reason).toBe(null);
  });

  it('已完成时结果引用追加去重（阶段成果 + 最终成果不丢）', () => {
    const withStage = mk({
      status: 'processing',
      result_refs: [asArtifactRef('art-stage')],
    });
    const next = applyWorkItemTransition({
      item: withStage,
      to: 'completed',
      at: T5,
      completion: {
        request_id: asRequestId('req-1'),
        result_refs: [asArtifactRef('art-stage'), asArtifactRef('art-final')],
      },
    });
    expect(next.result_refs).toEqual([asArtifactRef('art-stage'), asArtifactRef('art-final')]);
  });

  it('处理中 → 等待依赖：登记可指认的依赖项', () => {
    const next = applyWorkItemTransition({
      item: PROCESSING,
      to: 'waiting_dependency',
      at: T5,
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 req-B 的结果' },
      dependency_refs: [{ request_id: asRequestId('req-B') }],
    });
    expect(next.status).toBe('waiting_dependency');
    expect(next.dependency_refs).toEqual([{ request_id: asRequestId('req-B') }]);
    expect(next.blocker_reason?.kind).toBe('waiting_dependency');
  });

  it('等待依赖 → 处理中（依赖解除后可重新运行，Q5-c）', () => {
    const next = applyWorkItemTransition({
      item: WAITING,
      to: 'processing',
      at: T5,
      blocker_reason: { kind: 'other', detail: '依赖已解除，重新运行' },
    });
    expect(next.status).toBe('processing');
  });

  it('处理中 → 失败：failure_reason 写入，等待原因归位为空', () => {
    const next = applyWorkItemTransition({
      item: PROCESSING,
      to: 'failed',
      at: T5,
      failure_reason: '工具超时',
    });
    expect(next.status).toBe('failed');
    expect(next.failure_reason).toBe('工具超时');
    expect(next.blocker_reason).toBe(null);
  });

  it('失败可保留 blocker_reason（能力缺失必须可观测，Q2-c）', () => {
    const next = applyWorkItemTransition({
      item: PROCESSING,
      to: 'failed',
      at: T5,
      failure_reason: '无匹配能力',
      blocker_reason: { kind: 'capability_missing', detail: '没有 spreadsheet 能力' },
    });
    expect(next.status).toBe('failed');
    expect(next.blocker_reason?.kind).toBe('capability_missing');
  });

  it('待处理 → 取消：必须带取消原因，默认类别 other', () => {
    const next = applyWorkItemTransition({
      item: PENDING,
      to: 'cancelled',
      at: T5,
      cancellation_reason: '用户撤回请求',
    });
    expect(next.status).toBe('cancelled');
    expect(next.blocker_reason).toEqual({ kind: 'other', detail: '用户撤回请求' });
  });

  it('取消可指定原因类别', () => {
    const next = applyWorkItemTransition({
      item: PENDING,
      to: 'cancelled',
      at: T5,
      cancellation_reason: '用户撤回请求',
      cancellation_blocker_kind: 'waiting_user',
    });
    expect(next.blocker_reason?.kind).toBe('waiting_user');
  });

  it('处理中 → 待处理（本轮未产出结局，退回队列）', () => {
    const next = applyWorkItemTransition({
      item: PROCESSING,
      to: 'pending',
      at: T5,
      blocker_reason: { kind: 'waiting_external', detail: '本轮未产出结局' },
    });
    expect(next.status).toBe('pending');
  });

  it('非终态自环只更新元数据（等待原因明细可改写）', () => {
    const next = applyWorkItemTransition({
      item: PENDING,
      to: 'pending',
      at: T5,
      blocker_reason: { kind: 'waiting_user', detail: '等待用户补充人数' },
    });
    expect(next.status).toBe('pending');
    expect(next.blocker_reason?.detail).toBe('等待用户补充人数');
  });

  it('转换可携带触发消息与快照读入（读入 ≠ 完成）', () => {
    const next = applyWorkItemTransition({
      item: PENDING,
      to: 'processing',
      at: T5,
      add_triggering_message_ids: [asMessageId('m-1')],
      snapshot_run_id: RUN1,
    });
    expect(next.triggering_message_ids).toEqual([asMessageId('m-1')]);
    expect(next.included_in_snapshot).toBe(true);
    expect(next.snapshot_run_ids).toEqual([RUN1]);
    expect(next.status).toBe('processing');
  });
});

// ---------------------------------------------------------------------------
// 非法转换
// ---------------------------------------------------------------------------

describe('拒绝非法转换（P4：合法转换表 + 拒绝）', () => {
  it('目标状态取值非法 → unknown_status', () => {
    const verdict = evaluateWorkItemTransition({
      item: PENDING,
      to: 'done' as WorkItemStatus,
      at: T5,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection?.reason).toBe('unknown_status');
    expect(verdict.next).toBe(null);
  });

  it('待处理不能直接跳到已完成 → illegal_transition（没处理过就不能完成）', () => {
    const verdict = evaluateWorkItemTransition({
      item: PENDING,
      to: 'completed',
      at: T5,
      completion: { request_id: asRequestId('req-1'), result_refs: [asArtifactRef('art-1')] },
    });
    expect(verdict.rejection?.reason).toBe('illegal_transition');
  });

  it('等待依赖不能直接跳到已完成 → illegal_transition（依赖解除是新的可运行输入）', () => {
    const verdict = evaluateWorkItemTransition({
      item: WAITING,
      to: 'completed',
      at: T5,
      completion: { request_id: asRequestId('req-1'), result_refs: [asArtifactRef('art-1')] },
    });
    expect(verdict.rejection?.reason).toBe('illegal_transition');
  });

  it('源状态落在枚举外 → illegal_transition', () => {
    const verdict = evaluateWorkItemTransition({
      item: corrupt({ status: 'done' as unknown as WorkItemStatus }),
      to: 'processing',
      at: T5,
    });
    expect(verdict.rejection?.reason).toBe('illegal_transition');
  });
});

// ---------------------------------------------------------------------------
// 终态锁定与失去所有权
// ---------------------------------------------------------------------------

describe('终态不可回退（Q4-b、§九-9）', () => {
  it('已完成 → 处理中是终态锁定（内核发起也一样）', () => {
    const verdict = evaluateWorkItemTransition({ item: COMPLETED, to: 'processing', at: T5 });
    expect(verdict.rejection?.reason).toBe('terminal_locked');
    expect(verdict.next).toBe(null);
  });

  it('失败 → 待处理是终态锁定', () => {
    const verdict = evaluateWorkItemTransition({
      item: FAILED,
      to: 'pending',
      at: T5,
      blocker_reason: { kind: 'other', detail: '重开' },
    });
    expect(verdict.rejection?.reason).toBe('terminal_locked');
  });

  it('取消 → 取消（同态自环）也被拒绝：终态是冻结记录', () => {
    const verdict = evaluateWorkItemTransition({
      item: CANCELLED,
      to: 'cancelled',
      at: T5,
      cancellation_reason: '再取消一次',
    });
    expect(verdict.rejection?.reason).toBe('terminal_locked');
  });

  it('合法轮次也不能回退终态 → terminal_locked（不是重开，重开须新建）', () => {
    const verdict = evaluateWorkItemTransition({
      item: COMPLETED,
      to: 'processing',
      at: T5,
      origin: runOrigin(),
    });
    expect(verdict.rejection?.reason).toBe('terminal_locked');
  });

  it('失去所有权的轮次写终态 → ownership_rejected（透出 protocol 的 lease_expired）', () => {
    const verdict = evaluateWorkItemTransition({
      item: FAILED,
      to: 'pending',
      at: T5,
      origin: runOrigin({ now: asLogicalTime(1000) }),
      blocker_reason: { kind: 'other', detail: '重开' },
    });
    expect(verdict.rejection?.reason).toBe('ownership_rejected');
    expect(verdict.rejection?.ownership_reason).toBe('lease_expired');
  });

  it('非所有者轮次写终态 → ownership_rejected / not_run_owner', () => {
    const verdict = evaluateWorkItemTransition({
      item: FAILED,
      to: 'cancelled',
      at: T5,
      origin: runOrigin({ instance: instanceFor(C, asRunId('run-other')) }),
      cancellation_reason: '撤回',
    });
    expect(verdict.rejection?.reason).toBe('ownership_rejected');
    expect(verdict.rejection?.ownership_reason).toBe('not_run_owner');
  });

  it('stale 轮次写终态 → stale_task_revision', () => {
    const verdict = evaluateWorkItemTransition({
      item: FAILED,
      to: 'pending',
      at: T5,
      origin: runOrigin({ current_task_revision: asRevision(2) }),
      blocker_reason: { kind: 'other', detail: '重开' },
    });
    expect(verdict.rejection?.reason).toBe('stale_task_revision');
  });

  it('轮次实例不是负责人 → owner_mismatch（工作项级所有权）', () => {
    const verdict = evaluateWorkItemTransition({
      item: mk({ owner_instance_id: asInstanceId('D') }),
      to: 'processing',
      at: T5,
      origin: runOrigin(),
    });
    expect(verdict.rejection?.reason).toBe('owner_mismatch');
    expect(verdict.rejection?.ownership_reason).toBe(null);
  });

  it('失去所有权的轮次写非终态同样被拒绝（不会把等待原因覆盖掉）', () => {
    const verdict = evaluateWorkItemTransition({
      item: WAITING,
      to: 'processing',
      at: T5,
      origin: runOrigin({ now: asLogicalTime(1000) }),
      blocker_reason: { kind: 'other', detail: '假装依赖解除' },
    });
    expect(verdict.rejection?.reason).toBe('ownership_rejected');
    expect(WAITING.status).toBe('waiting_dependency');
  });

  it('applyWorkItemTransition 被拒时抛 WorkLedgerError，且不产生新对象', () => {
    try {
      applyWorkItemTransition({ item: COMPLETED, to: 'pending', at: T5, blocker_reason: { kind: 'other', detail: 'x' } });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isWorkLedgerError(error)).toBe(true);
      if (isWorkLedgerError(error)) {
        expect(error.reason).toBe('terminal_locked');
        expect(error.accepted).toBe(false);
      }
    }
    expect(COMPLETED.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 结局证据守卫
// ---------------------------------------------------------------------------

describe('结局证据守卫（非终态必须有原因；失败必须有失败原因）', () => {
  it('显式清空等待原因 → missing_blocker_reason', () => {
    const verdict = evaluateWorkItemTransition({
      item: PENDING,
      to: 'processing',
      at: T5,
      blocker_reason: null,
    });
    expect(verdict.rejection?.reason).toBe('missing_blocker_reason');
  });

  it('阻塞原因类别非法 → missing_blocker_reason', () => {
    const verdict = evaluateWorkItemTransition({
      item: PENDING,
      to: 'processing',
      at: T5,
      blocker_reason: { kind: 'nonsense' as never, detail: 'x' },
    });
    expect(verdict.rejection?.reason).toBe('missing_blocker_reason');
  });

  it('等待原因 detail 为空白 → missing_blocker_reason', () => {
    const verdict = evaluateWorkItemTransition({
      item: PENDING,
      to: 'processing',
      at: T5,
      blocker_reason: { kind: 'other', detail: '   ' },
    });
    expect(verdict.rejection?.reason).toBe('missing_blocker_reason');
  });

  it('转等待依赖但显式清空依赖项 → missing_dependency_ref', () => {
    const verdict = evaluateWorkItemTransition({
      item: PROCESSING,
      to: 'waiting_dependency',
      at: T5,
      blocker_reason: { kind: 'waiting_dependency', detail: '等待' },
      dependency_refs: [],
    });
    expect(verdict.rejection?.reason).toBe('missing_dependency_ref');
  });

  it('依赖项不可指认（三项引用全空）→ missing_dependency_ref（P4-02）', () => {
    const verdict = evaluateWorkItemTransition({
      item: PROCESSING,
      to: 'waiting_dependency',
      at: T5,
      blocker_reason: { kind: 'waiting_dependency', detail: '等待某个东西' },
      dependency_refs: [{}],
    });
    expect(verdict.rejection?.reason).toBe('missing_dependency_ref');
  });

  it('转失败但无失败原因 → missing_failure_reason', () => {
    expect(
      evaluateWorkItemTransition({ item: PROCESSING, to: 'failed', at: T5 }).rejection?.reason,
    ).toBe('missing_failure_reason');
    expect(
      evaluateWorkItemTransition({ item: PROCESSING, to: 'failed', at: T5, failure_reason: '  ' })
        .rejection?.reason,
    ).toBe('missing_failure_reason');
  });

  it('转取消但无取消原因 → missing_cancellation_reason', () => {
    expect(
      evaluateWorkItemTransition({ item: PENDING, to: 'cancelled', at: T5 }).rejection?.reason,
    ).toBe('missing_cancellation_reason');
  });

  it('取消原因类别非法 → invalid_blocker_kind', () => {
    const verdict = evaluateWorkItemTransition({
      item: PENDING,
      to: 'cancelled',
      at: T5,
      cancellation_reason: '撤回',
      cancellation_blocker_kind: 'nonsense' as never,
    });
    expect(verdict.rejection?.reason).toBe('invalid_blocker_kind');
  });

  it('转完成但没有结果引用证据 → missing_result_ref（P4-10 / A03-10）', () => {
    expect(
      evaluateWorkItemTransition({ item: PROCESSING, to: 'completed', at: T5 }).rejection?.reason,
    ).toBe('missing_result_ref');
    expect(
      evaluateWorkItemTransition({
        item: PROCESSING,
        to: 'completed',
        at: T5,
        completion: { request_id: asRequestId('req-1'), result_refs: [] },
      }).rejection?.reason,
    ).toBe('missing_result_ref');
  });

  it('结果引用答复的不是本工作项 → result_request_mismatch（不得张冠李戴）', () => {
    const verdict = evaluateWorkItemTransition({
      item: PROCESSING,
      to: 'completed',
      at: T5,
      completion: { request_id: asRequestId('req-OTHER'), result_refs: [asArtifactRef('art-1')] },
    });
    expect(verdict.rejection?.reason).toBe('result_request_mismatch');
  });

  it('输入记录损坏时以 invariant_violation 拒绝，而不是写坏账（防御分支）', () => {
    const broken = corrupt({ triggering_message_ids: undefined });
    const verdict = evaluateWorkItemTransition({ item: broken, to: 'processing', at: T5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection?.reason).toBe('invariant_violation');
    expect(verdict.next).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Q4-a 已读 ≠ 已完成
// ---------------------------------------------------------------------------

describe('Q4-a：“已读”不等于“已完成”（合同 §九-5）', () => {
  it('登记快照读入绝不改变状态', () => {
    const read = markWorkItemReadBySnapshot(PENDING, RUN1, T5);
    expect(read.status).toBe('pending');
    expect(read.included_in_snapshot).toBe(true);
    expect(read.snapshot_run_ids).toEqual([RUN1]);
    expect(read.updated_at).toBe(T5);
    expect(PENDING.included_in_snapshot).toBe(false);
  });

  it('读入的 run_id 去重（同一轮重复登记不产生重复归属）', () => {
    const once = markWorkItemReadBySnapshot(PENDING, RUN1, T5);
    const twice = markWorkItemReadBySnapshot(once, RUN1, T5);
    expect(twice.snapshot_run_ids).toEqual([RUN1]);
    const second = markWorkItemReadBySnapshot(twice, asRunId('run-2'), T5);
    expect(second.snapshot_run_ids).toEqual([RUN1, asRunId('run-2')]);
  });

  it('正向观测：读过消息的项仍是非终态、没有明确结局', () => {
    const read = markWorkItemReadBySnapshot(
      mk({ triggering_message_ids: [asMessageId('m-1')] }),
      RUN1,
      T5,
    );
    expect(read.triggering_message_ids).toEqual([asMessageId('m-1')]);
    expect(read.included_in_snapshot).toBe(true);
    expect(read.status).toBe('pending');
    expect(findReadButNotCompleted([read])).toEqual([read]);
    expect(describeWorkItemOutcome(read).has_outcome).toBe(false);
    expect(findRequestsWithoutOutcome([read])).toEqual([]); // 但它有等待原因，不算"无结局无原因"
  });

  it('读入不构成完成的理由：转完成仍必须给出匹配的结果引用', () => {
    const read = markWorkItemReadBySnapshot(PROCESSING, RUN1, T5);
    const verdict = evaluateWorkItemTransition({ item: read, to: 'completed', at: T5 });
    expect(verdict.rejection?.reason).toBe('missing_result_ref');
  });

  it('按冻结快照批量登记只影响快照内的请求', () => {
    const other = mk({ request_id: 'req-2' });
    const run = createRunRecord({
      run_id: RUN1,
      task_id: TASK,
      group_id: GROUP,
      instance_id: C,
      task_revision: asRevision(1),
      started_at: T0,
      lease_deadline: asLogicalTime(1000),
      frozen_request_ids: [asRequestId('req-1')],
    });
    const after = markWorkItemsReadBySnapshot([PENDING, other], run, T5);
    expect(after[0]?.included_in_snapshot).toBe(true);
    expect(after[1]).toBe(other); // 未在快照内 → 原样返回同一引用
    expect(findReadButNotCompleted(after).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Q4-b 重开
// ---------------------------------------------------------------------------

describe('Q4-b：失败/取消后重开 = 新建工作项，不回退旧项', () => {
  it('由失败项新建重开项，旧项保持终态不变', () => {
    const reopened = createReopenedWorkItem({
      previous: FAILED,
      new_request_id: asRequestId('req-1-retry'),
      at: T5,
      blocker_reason: { kind: 'other', detail: '重开：原因为工具临时故障' },
    });
    expect(reopened.status).toBe('pending');
    expect(reopened.request_id).toBe(asRequestId('req-1-retry'));
    expect(reopened.supersedes_request_id).toBe(FAILED.request_id);
    expect(reopened.owner_instance_id).toBe(C);
    // 旧项不动
    expect(FAILED.status).toBe('failed');
    expect(FAILED.supersedes_request_id).toBe(null);
    expect(isReopenOf(FAILED, reopened)).toBe(true);
  });

  it('由取消项也可以重开', () => {
    const reopened = createReopenedWorkItem({
      previous: CANCELLED,
      new_request_id: asRequestId('req-1-again'),
      at: T5,
      blocker_reason: { kind: 'other', detail: '用户重新发起' },
    });
    expect(reopened.supersedes_request_id).toBe(CANCELLED.request_id);
  });

  it('已完成项不可"重开"（完成是成功结局，新增需求走新请求）', () => {
    try {
      createReopenedWorkItem({
        previous: COMPLETED,
        new_request_id: asRequestId('req-1-retry'),
        at: T5,
        blocker_reason: { kind: 'other', detail: '重开' },
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isWorkLedgerError(error) && error.reason).toBe('reopen_requires_terminal');
    }
  });

  it('非终态项不可重开', () => {
    expect(() =>
      createReopenedWorkItem({
        previous: PENDING,
        new_request_id: asRequestId('req-1-retry'),
        at: T5,
        blocker_reason: { kind: 'other', detail: '重开' },
      }),
    ).toThrowError(/failed \/ cancelled/);
  });

  it('重开必须使用新的 request_id（新建而非复用）', () => {
    try {
      createReopenedWorkItem({
        previous: FAILED,
        new_request_id: FAILED.request_id,
        at: T5,
        blocker_reason: { kind: 'other', detail: '重开' },
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect(isWorkLedgerError(error) && error.reason).toBe('reopen_same_request_id');
    }
  });
});

// ---------------------------------------------------------------------------
// 汇总与守恒
// ---------------------------------------------------------------------------

describe('承诺表汇总与守恒判据（P4 观测字段）', () => {
  it('状态分布覆盖六态且各键求和等于总数', () => {
    const summary = summarizeWorkLedger([PENDING, PROCESSING, WAITING, COMPLETED, FAILED, CANCELLED]);
    expect(summary.total).toBe(6);
    expect(summary.status_distribution).toEqual({
      pending: 1,
      processing: 1,
      waiting_dependency: 1,
      completed: 1,
      failed: 1,
      cancelled: 1,
    });
    const sum = Object.values(summary.status_distribution).reduce((a, b) => a + b, 0);
    expect(sum).toBe(summary.total);
    expect(summary.terminal_count).toBe(3);
    expect(summary.non_terminal_count).toBe(3);
  });

  it('健康账本没有守恒违例，且非终态项都列在等待原因里', () => {
    const summary = summarizeWorkLedger([PENDING, PROCESSING, WAITING, COMPLETED, FAILED, CANCELLED]);
    expect(summary.violations).toEqual([]);
    expect(summary.wait_reasons.map((w) => w.request_id)).toEqual([
      asRequestId('req-1'),
      asRequestId('req-1'),
      asRequestId('req-1'),
    ]);
    expect(findRequestsWithoutOutcome([PENDING, PROCESSING, WAITING, COMPLETED, FAILED, CANCELLED])).toEqual([]);
  });

  it('损坏账本会被汇总报出来（既无结局也无原因）', () => {
    const bad = corrupt({ status: 'processing', blocker_reason: null });
    const summary = summarizeWorkLedger([bad]);
    expect(summary.violations.map((v) => v.kind)).toContain('non_terminal_without_wait_reason');
    expect(findRequestsWithoutOutcome([bad])).toEqual([asRequestId('req-1')]);
  });

  it('P4-11：收件箱里的请求在承诺表里找不到对应项', () => {
    const missing = findRequestsMissingWorkItem(
      [asRequestId('req-1'), asRequestId('req-9')],
      [PENDING],
    );
    expect(missing).toEqual([asRequestId('req-9')]);
  });

  it('P4-03：每项工作都有负责人，且可按负责人分组', () => {
    const byOwner = groupWorkItemsByOwner([PENDING, mk({ request_id: 'req-2', owner_instance_id: asInstanceId('D') })]);
    expect(byOwner.get(C)?.length).toBe(1);
    expect(byOwner.get(asInstanceId('D'))?.length).toBe(1);
    for (const item of [PENDING, PROCESSING, WAITING, COMPLETED, FAILED, CANCELLED]) {
      expect(describeWorkItemOutcome(item).owner_instance_id).toBe(C);
    }
  });

  it('P4-09：终态项带结局证据，非终态项带等待原因', () => {
    expect(describeWorkItemOutcome(COMPLETED).has_outcome).toBe(true);
    expect(describeWorkItemOutcome(FAILED).has_outcome).toBe(true);
    expect(describeWorkItemOutcome(CANCELLED).has_outcome).toBe(true);
    expect(describeWorkItemOutcome(CANCELLED).cancellation_reason).toBe('用户撤回');
    expect(describeWorkItemOutcome(WAITING).has_wait_reason).toBe(true);
    expect(describeWorkItemOutcome(WAITING).dependency_refs).toEqual([
      { request_id: asRequestId('req-B') },
    ]);
  });

  it('Q4-a 汇总：读入状态单独呈现，不并入结局', () => {
    const read = markWorkItemReadBySnapshot(PROCESSING, RUN1, T5);
    const outcome = describeWorkItemOutcome(read);
    expect(outcome.read_in_snapshot).toBe(true);
    expect(outcome.snapshot_run_ids).toEqual([RUN1]);
    expect(outcome.has_outcome).toBe(false);
  });

  it('R3 观测量：工作项状态分布 + 阻塞原因分布（含终态携带的 blocker）', () => {
    const capabilityMissing = mk({
      request_id: 'req-cap',
      status: 'failed',
      failure_reason: '无匹配能力',
      blocker_reason: { kind: 'capability_missing', detail: '没有 spreadsheet 能力' },
    });
    const summary = summarizeWorkLedger([
      PENDING, // waiting_user
      PROCESSING, // waiting_user
      WAITING, // waiting_dependency
      COMPLETED,
      FAILED,
      CANCELLED, // other
      capabilityMissing, // capability_missing（终态也计入，合同 R9）
    ]);
    expect(summary.status_distribution.completed).toBe(1);
    expect(summary.status_distribution.failed).toBe(2);
    expect(summary.blocker_kind_distribution).toEqual({
      waiting_user: 2,
      waiting_dependency: 1,
      other: 1,
      capability_missing: 1,
    });
    expect(summary.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R7：受控缺陷注入 —— 证明这些断言不是空的（注入后必须变红）
// ---------------------------------------------------------------------------

describe('R7 受控缺陷注入：关键断言必须可证伪', () => {
  it('注入 I-P4-1「读即完成」→ “读入不得改变状态”与结局守恒同时变红', () => {
    // 缺陷实现：读入时顺手把工作项置为已完成（就是合同要禁的那种写法）。
    const defectiveReadCompletes = (item: WorkItem, runId: ReturnType<typeof asRunId>): WorkItem =>
      ({ ...markWorkItemReadBySnapshot(item, runId, T5), status: 'completed' }) as WorkItem;

    // 正确实现：读入后仍是非终态 —— 这条断言就是它能变红的那一条。
    expect(markWorkItemReadBySnapshot(PENDING, RUN1, T5).status).toBe('pending');
    // 注入后：同一断言不成立（此处显式反向确认，证明断言非空）。
    expect(defectiveReadCompletes(PENDING, RUN1).status).toBe('completed');

    // 而且缺陷会被守恒判据抓住：完成却没有任何结果引用。
    const defective = defectiveReadCompletes(PENDING, RUN1);
    expect(evaluateOutcomeCompleteness(defective).map((v) => v.kind)).toContain(
      'completed_without_result_ref',
    );
    expect(summarizeWorkLedger([defective]).violations.length).toBeGreaterThan(0);
    // 正确实现下这两条判据都不报警。
    const correct = markWorkItemReadBySnapshot(PENDING, RUN1, T5);
    expect(summarizeWorkLedger([correct]).violations).toEqual([]);
  });

  it('注入 I-P4-2「折叠等待态」（丢掉等待原因）→ 等待原因守恒判据变红', () => {
    // 缺陷实现：把等待原因抹掉（等价于把等待态折叠进"处理中且无原因"）。
    const defectiveDropsReason = (item: WorkItem): WorkItem =>
      ({ ...item, blocker_reason: null, status: 'processing' }) as WorkItem;

    expect(findRequestsWithoutOutcome([PENDING])).toEqual([]); // 正确实现：有原因 → 不报
    const defective = defectiveDropsReason(PENDING);
    expect(findRequestsWithoutOutcome([defective])).toEqual([PENDING.request_id]); // 注入后变红
    expect(evaluateOutcomeCompleteness(defective).map((v) => v.kind)).toContain(
      'non_terminal_without_wait_reason',
    );
  });

  it('注入 I-P4-3「静默失败」（失败记为完成且空结果）→ 结局证据判据变红', () => {
    const silentSuccess = (item: WorkItem): WorkItem =>
      ({ ...item, status: 'completed', result_refs: [] }) as WorkItem;

    expect(describeWorkItemOutcome(FAILED).has_outcome).toBe(true);
    const defective = silentSuccess(FAILED);
    expect(evaluateOutcomeCompleteness(defective).map((v) => v.kind)).toContain(
      'completed_without_result_ref',
    );
    expect(describeWorkItemOutcome(defective).has_outcome).toBe(false);
  });

  it('注入 I-P4-4「无主工作项」→ 负责人判据变红（P4-03）', () => {
    const ownerless = (item: WorkItem): WorkItem =>
      ({ ...item, owner_instance_id: '' }) as WorkItem;
    expect(evaluateOutcomeCompleteness(PENDING)).toEqual([]);
    expect(evaluateOutcomeCompleteness(ownerless(PENDING)).map((v) => v.kind)).toContain(
      'missing_owner',
    );
  });

  it('注入 I-P4-5「终态可回退」→ 终态锁定断言变红（Q4-b / §九-9）', () => {
    // 缺陷实现：无视终态锁直接把状态改回去（正是合同禁止的"回退旧项"）。
    const defectiveRevert = (item: WorkItem, to: WorkItemStatus): WorkItem =>
      ({ ...item, status: to }) as WorkItem;

    // 正确实现：被拒，且不给新对象。
    const verdict = evaluateWorkItemTransition({ item: COMPLETED, to: 'processing', at: T5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection?.reason).toBe('terminal_locked');
    expect(verdict.next).toBe(null);
    // 注入后：同一断言不成立 —— 证明 `ok === false` 这条断言不是恒真。
    expect(defectiveRevert(COMPLETED, 'processing').status).toBe('processing');
  });

  it('注入 I-P4-6「绕过守卫直接造工作项」→ protocol 的构造期不变量拦住它', () => {
    // 任何"绕过转换路径"的写法一旦造出非终态缺原因的项，构造期即抛错。
    expect(() =>
      createWorkItem({
        request_id: asRequestId('req-1'),
        task_id: TASK,
        owner_instance_id: C,
        created_at: T0,
        status: 'processing',
      }),
    ).toThrowError(/blocker_reason/);
    // 转换路径的候选项同样必须过这一步，故守卫不可能被静默绕过。
    expect(() =>
      createWorkItem({
        request_id: asRequestId('req-1'),
        task_id: TASK,
        owner_instance_id: C,
        created_at: T0,
        status: 'failed',
      }),
    ).toThrowError(/failure_reason/);
  });
});
