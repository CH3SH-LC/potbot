import { describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  assertWorkItemInvariants,
  createWorkItem,
  isNonTerminalStatus,
  isTerminalStatus,
  NON_TERMINAL_WORK_ITEM_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
  ValidationError,
  WORK_ITEM_STATUSES,
  type WorkItemStatus,
} from './index.js';

const TASK = asTaskId('T1');
const OWNER = asInstanceId('C');
const R1 = asRequestId('req-1');
const T0 = asLogicalTime(0);

function item(status: WorkItemStatus, extra: Partial<Parameters<typeof createWorkItem>[0]> = {}) {
  return createWorkItem({
    request_id: R1,
    task_id: TASK,
    owner_instance_id: OWNER,
    created_at: T0,
    status,
    ...extra,
  });
}

describe('工作项六态（任务书 §7.3 / 需求 4：封闭最小值）', () => {
  it('恰好包含待处理/处理中/等待依赖/已完成/失败/取消六态', () => {
    expect([...WORK_ITEM_STATUSES]).toEqual([
      'pending',
      'processing',
      'waiting_dependency',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('终态与非终态构成完整划分且互斥', () => {
    const partition = [...TERMINAL_WORK_ITEM_STATUSES, ...NON_TERMINAL_WORK_ITEM_STATUSES];
    expect(new Set(partition).size).toBe(partition.length);
    expect([...partition].sort()).toEqual([...WORK_ITEM_STATUSES].sort());
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('waiting_dependency')).toBe(false);
    expect(isNonTerminalStatus('waiting_dependency')).toBe(true);
    expect(isNonTerminalStatus('cancelled')).toBe(false);
  });

  it('非终态缺少阻塞原因时拒绝构造（任务书:156）', () => {
    expect(() => item('pending')).toThrow(ValidationError);
    expect(() => item('processing')).toThrow(ValidationError);
    expect(() => item('waiting_dependency')).toThrow(ValidationError);
  });

  it('非终态带明确阻塞原因时成立', () => {
    const waiting = item('waiting_dependency', {
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 B 的结果' },
      dependency_refs: [{ request_id: asRequestId('req-B') }],
    });
    expect(waiting.blocker_reason?.kind).toBe('waiting_dependency');
    expect(() => assertWorkItemInvariants(waiting)).not.toThrow();
  });

  it('failed 必须给出 failure_reason', () => {
    expect(() => item('failed')).toThrow(ValidationError);
    const failed = item('failed', { failure_reason: '工具超时' });
    expect(failed.failure_reason).toBe('工具超时');
    expect(() => assertWorkItemInvariants(failed)).not.toThrow();
  });

  it('waiting_dependency 在**构造路径**上就必须登记依赖项（v1.1 W7）', () => {
    expect(() =>
      item('waiting_dependency', {
        blocker_reason: { kind: 'waiting_dependency', detail: '等待' },
      }),
    ).toThrow(ValidationError);

    // 更有意义的一条：依赖项为**空数组**（显式给了字段但没给内容）同样拒绝。
    expect(() =>
      item('waiting_dependency', {
        blocker_reason: { kind: 'waiting_dependency', detail: '等待' },
        dependency_refs: [],
      }),
    ).toThrow(ValidationError);
  });

  it('自检对**外部构造**的记录（如从存储读回）同样拦住"等待但无依赖项"', () => {
    const waiting = item('waiting_dependency', {
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 B' },
      dependency_refs: [{ request_id: asRequestId('req-B') }],
    });
    // 外部记录可能绕过 createWorkItem：这里用结构等价的记录验证自检仍然生效。
    const external: typeof waiting = { ...waiting, dependency_refs: [] };
    expect(() => assertWorkItemInvariants(external)).toThrow(ValidationError);
    expect(() => assertWorkItemInvariants(waiting)).not.toThrow();
  });

  it('能力缺失工作项可直接被判为终态 failed（Q2-c：不得静默丢弃）', () => {
    const missing = item('failed', {
      failure_reason: '无匹配能力',
      blocker_reason: { kind: 'capability_missing', detail: '没有 spreadsheet 能力' },
      triggering_message_ids: [asMessageId('m-1')],
    });
    expect(missing.status).toBe('failed');
    // v1.1 R9：终态**允许且应当**携带 blocker（能力缺失即此类），自检不得因此报错。
    expect(missing.blocker_reason?.kind).toBe('capability_missing');
    expect(() => assertWorkItemInvariants(missing)).not.toThrow();
  });
});

describe('Q4-a：“已读”与工作项是两组记录', () => {
  it('触发消息集合与“是否被快照读入”独立于状态', () => {
    const read = item('processing', {
      blocker_reason: { kind: 'waiting_user', detail: '等待确认' },
      triggering_message_ids: [asMessageId('m-1'), asMessageId('m-2')],
      included_in_snapshot: true,
      snapshot_run_ids: [asRunId('run-1')],
    });
    expect(read.included_in_snapshot).toBe(true);
    expect(read.status).toBe('processing'); // 读入 ≠ 完成
    expect(read.triggering_message_ids.length).toBe(2);
  });

  it('Q4-b：重开 = 新建工作项并保留旧项引用', () => {
    const reopened = item('pending', {
      blocker_reason: { kind: 'other', detail: '重开' },
      supersedes_request_id: asRequestId('req-old'),
      task_revision: asRevision(3),
    });
    expect(reopened.supersedes_request_id).toBe(asRequestId('req-old'));
  });
});
