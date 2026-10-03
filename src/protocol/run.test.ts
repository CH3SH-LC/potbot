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
  createInstanceState,
  createRunLease,
  createRunRecord,
  DEFAULT_LEASE_TTL,
  evaluateRunOwnership,
  isLeaseExpired,
  mustRejectPublication,
  ValidationError,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const RUN = asRunId('run-1');

describe('有限租约（合同 Q7-a）', () => {
  it('默认租约时长 1000 逻辑时间单位，且不自动续租', () => {
    const lease = createRunLease(RUN, C, asLogicalTime(0));
    expect(DEFAULT_LEASE_TTL).toBe(1000);
    expect(lease.lease_deadline as unknown as number).toBe(1000);
    expect(lease.renewable).toBe(false);
  });

  it('场景可配租约时长', () => {
    const lease = createRunLease(RUN, C, asLogicalTime(100), 25);
    expect(lease.lease_deadline as unknown as number).toBe(125);
  });

  it('非法时长被拒绝', () => {
    expect(() => createRunLease(RUN, C, asLogicalTime(0), 0)).toThrow(ValidationError);
    expect(() => createRunLease(RUN, C, asLogicalTime(0), -5)).toThrow(ValidationError);
  });

  it('有效期区间为 [issued_at, lease_deadline)：到期点本身算过期', () => {
    const lease = createRunLease(RUN, C, asLogicalTime(0), 1000);
    expect(isLeaseExpired(lease, asLogicalTime(999))).toBe(false);
    expect(isLeaseExpired(lease, asLogicalTime(1000))).toBe(true);
    expect(isLeaseExpired(lease, asLogicalTime(1001))).toBe(true);
  });
});

function activeInstance(runId = RUN) {
  return createInstanceState({
    instance_id: C,
    group_id: GROUP,
    updated_at: asLogicalTime(0),
    activity: 'active',
    active_run_id: runId,
    lease_deadline: asLogicalTime(1000),
  });
}

function runningRun() {
  return createRunRecord({
    run_id: RUN,
    task_id: TASK,
    group_id: GROUP,
    instance_id: C,
    task_revision: asRevision(1),
    started_at: asLogicalTime(0),
    lease_deadline: asLogicalTime(1000),
    frozen_input_message_ids: [],
    frozen_request_ids: [],
  });
}

describe('evaluateRunOwnership（P7：结束轮次核对所有权与版本）', () => {
  it('所有权 + 租约 + 版本都成立 → 允许发布', () => {
    const verdict = evaluateRunOwnership({
      run: runningRun(),
      instance: activeInstance(),
      now: asLogicalTime(500),
      current_task_revision: asRevision(1),
    });
    expect(verdict).toEqual({ valid: true, reason: null });
    expect(mustRejectPublication({
      run: runningRun(),
      instance: activeInstance(),
      now: asLogicalTime(500),
      current_task_revision: asRevision(1),
    })).toBe(false);
  });

  it('run_id 不存在 → unknown_run', () => {
    expect(
      evaluateRunOwnership({
        run: undefined,
        instance: activeInstance(),
        now: asLogicalTime(1),
        current_task_revision: asRevision(1),
      }).reason,
    ).toBe('unknown_run');
  });

  it('轮次已结束 → run_not_active', () => {
    const finished = createRunRecord({
      ...runningRun(),
      status: 'finished',
      finished_at: asLogicalTime(400),
    });
    expect(
      evaluateRunOwnership({
        run: finished,
        instance: activeInstance(),
        now: asLogicalTime(500),
        current_task_revision: asRevision(1),
      }).reason,
    ).toBe('run_not_active');
  });

  it('实例不再持有该轮次 → not_run_owner', () => {
    expect(
      evaluateRunOwnership({
        run: runningRun(),
        instance: activeInstance(asRunId('run-other')),
        now: asLogicalTime(500),
        current_task_revision: asRevision(1),
      }).reason,
    ).toBe('not_run_owner');
  });

  it('租约已过期 → lease_expired（迟到发布被拒绝）', () => {
    const verdict = evaluateRunOwnership({
      run: runningRun(),
      instance: activeInstance(),
      now: asLogicalTime(1000),
      current_task_revision: asRevision(1),
    });
    expect(verdict).toEqual({ valid: false, reason: 'lease_expired' });
  });

  it('任务版本已变 → stale_task_revision（stale 发布被拒绝）', () => {
    expect(
      evaluateRunOwnership({
        run: runningRun(),
        instance: activeInstance(),
        now: asLogicalTime(500),
        current_task_revision: asRevision(2),
      }).reason,
    ).toBe('stale_task_revision');
  });
});

describe('RunRecord 快照字段（Q5-a：快照与 run_id/租约同事务冻结）', () => {
  it('快照携带消息与请求集合，读入 ≠ 完成', () => {
    const run = createRunRecord({
      run_id: RUN,
      task_id: TASK,
      group_id: GROUP,
      instance_id: C,
      task_revision: asRevision(1),
      started_at: asLogicalTime(10),
      lease_deadline: asLogicalTime(1010),
      frozen_input_message_ids: [asMessageId('m1'), asMessageId('m2')],
      frozen_request_ids: [asRequestId('r1')],
    });
    expect(run.status).toBe('running');
    expect(run.frozen_at).toBe(asLogicalTime(10));
    expect(run.frozen_input_message_ids.length).toBe(2);
    expect(run.frozen_request_ids.length).toBe(1);
  });
});
