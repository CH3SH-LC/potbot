import { describe, expect, it } from 'vitest';

import { evaluateOrigin, isOwnershipLost, isStaleOrigin, type RunOrigin } from './index.js';
import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createInstanceState,
  createRunRecord,
  createWorkItem,
  type InstanceState,
  type WorkItem,
} from '../protocol/index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const D = asInstanceId('D');
const RUN = asRunId('run-1');

/**
 * 构造一个"处理中"的工作项（非终态，必须有等待原因）。
 *
 * `task_revision` 必须与 `runOf()` 的默认冻结版本一致（同为 r1）——否则会被 R42.1 第 3 步
 * 的范围核对判为 `stale_task_revision`，与用例本意（"来源合法，问题出在别处"）不符。
 */
function processingItem(owner = C): WorkItem {
  return createWorkItem({
    request_id: asRequestId('req-1'),
    task_id: TASK,
    task_revision: asRevision(1),
    owner_instance_id: owner,
    created_at: asLogicalTime(0),
    status: 'processing',
    blocker_reason: { kind: 'other', detail: '本轮处理中' },
  });
}

function failedItem(): WorkItem {
  return createWorkItem({
    request_id: asRequestId('req-done'),
    task_id: TASK,
    task_revision: asRevision(1),
    owner_instance_id: C,
    created_at: asLogicalTime(0),
    status: 'failed',
    failure_reason: '工具超时',
  });
}

function instanceFor(instanceId = C, runId = RUN): InstanceState {
  return createInstanceState({
    instance_id: instanceId,
    group_id: GROUP,
    updated_at: asLogicalTime(0),
    activity: 'active',
    active_run_id: runId,
    lease_deadline: asLogicalTime(1000),
  });
}

function runOf(instanceId = C, revision = 1): ReturnType<typeof createRunRecord> {
  return createRunRecord({
    run_id: RUN,
    task_id: TASK,
    group_id: GROUP,
    instance_id: instanceId,
    task_revision: asRevision(revision),
    started_at: asLogicalTime(0),
    lease_deadline: asLogicalTime(1000),
  });
}

function runOrigin(over: Partial<RunOrigin> = {}): RunOrigin {
  return {
    kind: 'run',
    run: 'run' in over ? over.run : runOf(),
    instance: 'instance' in over ? over.instance : instanceFor(),
    current_task_revision: over.current_task_revision ?? asRevision(1),
    now: over.now ?? asLogicalTime(500),
  };
}

describe('发起方所有权判定（P4 第 6 条：终态不可被旧轮次或失去所有权的轮次回退）', () => {
  it('内核自身发起的写入不做轮次所有权核对', () => {
    expect(evaluateOrigin({ kind: 'kernel' }, processingItem()).allowed).toBe(true);
    expect(evaluateOrigin(undefined, processingItem()).allowed).toBe(true);
  });

  it('所有权 + 租约 + 版本都成立 → 允许（复用 protocol 的 evaluateRunOwnership）', () => {
    const verdict = evaluateOrigin(runOrigin(), processingItem());
    expect(verdict).toEqual({
      allowed: true,
      reason: null,
      ownership_reason: null,
      detail: '允许写入',
    });
  });

  it('找不到轮次记录 → ownership_rejected / unknown_run', () => {
    const verdict = evaluateOrigin({ ...runOrigin(), run: undefined }, processingItem());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('ownership_rejected');
    expect(verdict.ownership_reason).toBe('unknown_run');
  });

  it('实例不再持有该轮次 → ownership_rejected / not_run_owner', () => {
    const origin = runOrigin({ instance: instanceFor(C, asRunId('run-other')) });
    const verdict = evaluateOrigin(origin, processingItem());
    expect(verdict.reason).toBe('ownership_rejected');
    expect(verdict.ownership_reason).toBe('not_run_owner');
    expect(isOwnershipLost(origin, processingItem())).toBe(true);
    expect(isStaleOrigin(origin, processingItem())).toBe(false);
  });

  it('实例已不存在 → ownership_rejected / not_run_owner', () => {
    const verdict = evaluateOrigin(runOrigin({ instance: undefined }), processingItem());
    expect(verdict.reason).toBe('ownership_rejected');
    expect(verdict.ownership_reason).toBe('not_run_owner');
  });

  it('租约已过期 → ownership_rejected / lease_expired（迟到发布被拒绝）', () => {
    const origin = runOrigin({ now: asLogicalTime(1000) });
    const verdict = evaluateOrigin(origin, processingItem());
    expect(verdict.reason).toBe('ownership_rejected');
    expect(verdict.ownership_reason).toBe('lease_expired');
    expect(isOwnershipLost(origin, processingItem())).toBe(true);
  });

  it('任务版本已变 → stale_task_revision（stale 拒绝，§九-9）', () => {
    const origin = runOrigin({ current_task_revision: asRevision(2) });
    const verdict = evaluateOrigin(origin, processingItem());
    expect(verdict.reason).toBe('stale_task_revision');
    expect(verdict.ownership_reason).toBe('stale_task_revision');
    expect(isStaleOrigin(origin, processingItem())).toBe(true);
    expect(isOwnershipLost(origin, processingItem())).toBe(false);
  });

  it('轮次实例不是工作项负责人 → owner_mismatch（工作项级所有权）', () => {
    // 轮次属于 C 且轮次级所有权成立，但工作项归 D 所有。
    const verdict = evaluateOrigin(runOrigin(), processingItem(D));
    expect(verdict.reason).toBe('owner_mismatch');
    expect(verdict.ownership_reason).toBe(null);
    expect(isOwnershipLost(runOrigin(), processingItem(D))).toBe(true);
  });

  it('发起方层不判定终态锁：终态项对合法发起方仍然"有权"，由转换路径拒绝', () => {
    expect(evaluateOrigin(runOrigin(), failedItem()).allowed).toBe(true);
    expect(evaluateOrigin(runOrigin({ now: asLogicalTime(1000) }), failedItem()).allowed).toBe(false);
  });
});
