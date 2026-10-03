import { describe, expect, it } from 'vitest';

import {
  assertOutcomeCompleteness,
  cancellationReasonOf,
  describeBlocker,
  evaluateOutcomeCompleteness,
  hasExplicitOutcome,
  hasWaitReason,
  isValidBlockerKind,
  isWorkLedgerError,
  OUTCOME_VIOLATION_KINDS,
  WorkLedgerError,
} from './index.js';
import {
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asTaskId,
  createWorkItem,
  type WorkItem,
  type WorkItemInput,
} from '../protocol/index.js';

const TASK = asTaskId('T1');
const OWNER = asInstanceId('C');
const REQ = asRequestId('req-1');
const T0 = asLogicalTime(0);

/** 基线工作项：省略的字段用默认值，`over` 覆盖。 */
function base(over: Partial<WorkItemInput> = {}): WorkItem {
  return createWorkItem({
    request_id: REQ,
    task_id: TASK,
    owner_instance_id: OWNER,
    created_at: T0,
    status: 'pending',
    blocker_reason: { kind: 'waiting_external', detail: '等待外部条件' },
    ...over,
  });
}

const PENDING_OK = base({
  status: 'pending',
  blocker_reason: { kind: 'waiting_external', detail: '等待外部条件' },
});

const WAITING_OK = base({
  status: 'waiting_dependency',
  blocker_reason: { kind: 'waiting_dependency', detail: '等待 req-B 的结果' },
  dependency_refs: [{ request_id: asRequestId('req-B') }],
});

const FAILED_OK = base({ status: 'failed', failure_reason: '工具超时' });

const COMPLETED_OK = base({ status: 'completed', result_refs: [asArtifactRef('artifact-1')] });

const CANCELLED_OK = base({
  status: 'cancelled',
  blocker_reason: { kind: 'other', detail: '用户撤回请求' },
});

/** 直接构造一个"坏记录"（绕过 createWorkItem 的构造期校验），用于验证报告器本身有效。 */
function corrupt(over: Partial<WorkItem>): WorkItem {
  return { ...PENDING_OK, ...over } as WorkItem;
}

describe('结局完整性判据（P4-03 / P4-09 / P4-10）', () => {
  it('六态各自的合格形状都不产生违例', () => {
    for (const item of [PENDING_OK, WAITING_OK, FAILED_OK, COMPLETED_OK, CANCELLED_OK]) {
      expect(evaluateOutcomeCompleteness(item)).toEqual([]);
      expect(() => assertOutcomeCompleteness(item)).not.toThrow();
    }
  });

  it('违例枚举是封闭的（六个 P4 判据 + 负责人/枚举外取值）', () => {
    expect([...OUTCOME_VIOLATION_KINDS]).toEqual([
      'missing_owner',
      'status_out_of_enum',
      'non_terminal_without_wait_reason',
      'waiting_without_dependency_ref',
      'failed_without_failure_reason',
      'completed_without_result_ref',
      'cancelled_without_cancellation_reason',
    ]);
  });

  it('非终态缺等待原因 → 违例（并可由 assert 抛出 WorkLedgerError/missing_blocker_reason）', () => {
    const bad = corrupt({ status: 'processing', blocker_reason: null });
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain(
      'non_terminal_without_wait_reason',
    );
    try {
      assertOutcomeCompleteness(bad);
      throw new Error('应当抛错');
    } catch (error) {
      expect(isWorkLedgerError(error)).toBe(true);
      if (isWorkLedgerError(error)) {
        expect(error.reason).toBe('missing_blocker_reason');
        expect(error.accepted).toBe(false);
      }
    }
  });

  it('等待依赖却没有依赖项 → 违例', () => {
    const bad = corrupt({
      status: 'waiting_dependency',
      blocker_reason: { kind: 'waiting_dependency', detail: '等' },
      dependency_refs: [],
    });
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain(
      'waiting_without_dependency_ref',
    );
  });

  it('失败却没有失败原因 → 违例', () => {
    const bad = corrupt({ status: 'failed', failure_reason: null, blocker_reason: null });
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain(
      'failed_without_failure_reason',
    );
    expect(hasExplicitOutcome(bad)).toBe(false);
  });

  it('已完成却没有结果引用 → 违例（P4-10；比 protocol 的 assertWorkItemInvariants 更严）', () => {
    const bad = base({ status: 'completed' });
    expect(bad.result_refs).toEqual([]);
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain(
      'completed_without_result_ref',
    );
    expect(hasExplicitOutcome(bad)).toBe(false);
    expect(hasExplicitOutcome(COMPLETED_OK)).toBe(true);
  });

  it('取消却没有取消原因 → 违例（取消原因读自 blocker_reason.detail）', () => {
    const bad = base({ status: 'cancelled', blocker_reason: null });
    expect(cancellationReasonOf(bad)).toBe(null);
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain(
      'cancelled_without_cancellation_reason',
    );

    expect(cancellationReasonOf(CANCELLED_OK)).toBe('用户撤回请求');
    expect(cancellationReasonOf(PENDING_OK)).toBe(null); // 非取消项不把等待原因读成取消原因
  });

  it('没有负责人 → 违例（P4-03）', () => {
    const bad = corrupt({ owner_instance_id: '' as never });
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain('missing_owner');
  });

  it('状态取值落在枚举外 → 违例（P4-04），且只报这一条', () => {
    const bad = corrupt({ status: 'done' as never });
    const violations = evaluateOutcomeCompleteness(bad);
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('status_out_of_enum');
  });

  it('等待原因必须是合法的 blocker kind（枚举外的 kind 不算"明确原因"）', () => {
    expect(isValidBlockerKind('waiting_dependency')).toBe(true);
    expect(isValidBlockerKind('nonsense')).toBe(false);
    const bad = corrupt({
      status: 'pending',
      blocker_reason: { kind: 'nonsense' as never, detail: 'x' },
    });
    expect(hasWaitReason(bad)).toBe(false);
    expect(evaluateOutcomeCompleteness(bad).map((v) => v.kind)).toContain(
      'non_terminal_without_wait_reason',
    );
  });

  it('空白的 detail 不算明确原因', () => {
    const blank = corrupt({
      status: 'pending',
      blocker_reason: { kind: 'other', detail: '   ' },
    });
    expect(hasWaitReason(blank)).toBe(false);
  });

  it('describeBlocker 输出可读文本', () => {
    expect(describeBlocker({ kind: 'waiting_dependency', detail: '等 B' })).toBe(
      'waiting_dependency: 等 B',
    );
    expect(describeBlocker(null)).toBe('（无等待原因）');
  });

  it('WorkLedgerError 是 ValidationError 的子类（accepted === false）', () => {
    const error = new WorkLedgerError('missing_result_ref', '缺结果引用');
    expect(error).toBeInstanceOf(Error);
    expect(error.accepted).toBe(false);
    expect(error.reason).toBe('missing_result_ref');
    expect(error.ownership_reason).toBe(null);
  });
});
