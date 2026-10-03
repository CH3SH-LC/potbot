import { describe, expect, it } from 'vitest';

import {
  allowedTransitionsFrom,
  assertLegalTransition,
  canTransition,
  isAbsorbingStatus,
  isReopenableStatus,
  isTerminalLocked,
  isWorkItemStatus,
  transitionTableSnapshot,
  WORK_ITEM_TRANSITIONS,
} from './index.js';
import { ValidationError, WORK_ITEM_STATUSES, type WorkItemStatus } from '../protocol/index.js';

const TERMINAL: readonly WorkItemStatus[] = ['completed', 'failed', 'cancelled'];
const NON_TERMINAL: readonly WorkItemStatus[] = ['pending', 'processing', 'waiting_dependency'];

describe('工作项转换表（P4：合法转换表 + 拒绝非法转换）', () => {
  it('表覆盖全部六态且每项都是合法目标状态', () => {
    expect(Object.keys(WORK_ITEM_TRANSITIONS).sort()).toEqual([...WORK_ITEM_STATUSES].sort());
    for (const from of WORK_ITEM_STATUSES) {
      for (const to of WORK_ITEM_TRANSITIONS[from]) {
        expect(isWorkItemStatus(to)).toBe(true);
      }
    }
    expect([...WORK_ITEM_STATUSES]).toEqual([
      'pending',
      'processing',
      'waiting_dependency',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('终态是吸收态：出度为 0，任何转换（含自环）都不合法', () => {
    for (const status of TERMINAL) {
      expect(WORK_ITEM_TRANSITIONS[status]).toEqual([]);
      expect(isAbsorbingStatus(status)).toBe(true);
      expect(isTerminalLocked(status)).toBe(true);
      for (const to of WORK_ITEM_STATUSES) {
        expect(canTransition(status, to)).toBe(false);
      }
    }
  });

  it('非终态允许自环（只更新元数据，不改变状态）', () => {
    for (const status of NON_TERMINAL) {
      expect(canTransition(status, status)).toBe(true);
      expect(isAbsorbingStatus(status)).toBe(false);
      expect(isTerminalLocked(status)).toBe(false);
    }
  });

  it('只有 processing 可以走向 completed（“读/等”都不能凭空完成，§九-5）', () => {
    expect(canTransition('processing', 'completed')).toBe(true);
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('waiting_dependency', 'completed')).toBe(false);

    const sourcesReachingCompleted = WORK_ITEM_STATUSES.filter((from) =>
      WORK_ITEM_TRANSITIONS[from].includes('completed'),
    );
    expect([...sourcesReachingCompleted]).toEqual(['processing']);
  });

  it('非终态其余方向可迁移（等待态可回到可运行态）', () => {
    expect(canTransition('pending', 'processing')).toBe(true);
    expect(canTransition('pending', 'waiting_dependency')).toBe(true);
    expect(canTransition('waiting_dependency', 'processing')).toBe(true);
    expect(canTransition('waiting_dependency', 'pending')).toBe(true);
    expect(canTransition('processing', 'waiting_dependency')).toBe(true);
    expect(canTransition('processing', 'pending')).toBe(true);
  });

  it('失败与取消可以直接作用于待处理项（Q2-c 能力缺失、Q4-c 取消优先）', () => {
    expect(canTransition('pending', 'failed')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
  });

  it('未知取值一律判不合法（不抛错）', () => {
    expect(canTransition('done' as WorkItemStatus, 'pending')).toBe(false);
    expect(canTransition('pending', 'done' as WorkItemStatus)).toBe(false);
    expect(isWorkItemStatus('done')).toBe(false);
    expect(isWorkItemStatus('')).toBe(false);
    expect(isWorkItemStatus(undefined)).toBe(false);
    expect(isWorkItemStatus(null)).toBe(false);
    expect(isWorkItemStatus(3)).toBe(false);
    expect(isWorkItemStatus('pending')).toBe(true);
  });

  it('allowedTransitionsFrom 返回表的副本；未知源状态抛 ValidationError', () => {
    const allowed = allowedTransitionsFrom('pending');
    expect(allowed).toContain('processing');
    expect(() => allowedTransitionsFrom('done' as WorkItemStatus)).toThrow(ValidationError);
  });

  it('assertLegalTransition 对非法转换抛错、对合法转换放行', () => {
    expect(() => assertLegalTransition('pending', 'processing')).not.toThrow();
    expect(() => assertLegalTransition('processing', 'completed')).not.toThrow();
    expect(() => assertLegalTransition('completed', 'processing')).toThrow(ValidationError);
    expect(() => assertLegalTransition('pending', 'completed')).toThrow(ValidationError);
    expect(() => assertLegalTransition('cancelled', 'cancelled')).toThrow(ValidationError);
    expect(() => assertLegalTransition('done' as WorkItemStatus, 'pending')).toThrow(ValidationError);
    expect(() => assertLegalTransition('pending', 'done' as WorkItemStatus)).toThrow(ValidationError);
  });

  it('重开只针对 failed / cancelled（Q4-b）', () => {
    expect(isReopenableStatus('failed')).toBe(true);
    expect(isReopenableStatus('cancelled')).toBe(true);
    expect(isReopenableStatus('completed')).toBe(false);
    expect(isReopenableStatus('pending')).toBe(false);
    expect(isReopenableStatus('processing')).toBe(false);
    expect(isReopenableStatus('waiting_dependency')).toBe(false);
  });

  it('transitionTableSnapshot 是深拷贝，改不动内部表', () => {
    const snapshot = transitionTableSnapshot();
    snapshot.pending = [];
    expect(WORK_ITEM_TRANSITIONS.pending.length).toBeGreaterThan(0);
    expect(allowedTransitionsFrom('pending').length).toBeGreaterThan(0);
  });
});
