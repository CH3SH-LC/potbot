/**
 * F07 验收：遗忘范围 · 进度 · 影响提示（I6 / I7 / I8）。
 *
 * 这是本包「真实状态可恢复，失败不假报忘记；遗忘影响提示来自内核」的核心闸门。
 *
 * 反向对照：
 *   1) `confirmed` 没带回执引用 → missing-evidence（UI 不能自己宣布完成）；
 *   2) 失败 / 取消 → 状态非 confirmed，`shouldRemoveRows` 恒 false（列表一行都不动）；
 *   3) 影响数字只来自内核；没给 → 显式「未知」，不自造；
 *   4) 进度只能上升、不越界；终态后不再接事件。
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryViewModelError,
  applyForgetEvent,
  describeForgetProgress,
  describeImpact,
  describeScope,
  isForgotten,
  isForgetTerminal,
  previewForgetScope,
  rowInForgetScope,
  shouldRemoveRows,
  startForget,
  type ForgetJob,
} from '../../../apps/mobile-ui/src/memory/index.js';

import { OWNER, row, sessionMessage, taskFact, templateExperience } from './fixtures.js';
import { toMemoryRow } from '../../../apps/mobile-ui/src/memory/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryViewModelError ? error.code : `non-vm-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

function job(scope: Parameters<typeof startForget>[0]['scope'], expectedTotal?: number) {
  return startForget({ jobId: 'job-1', ownerId: OWNER, scope, expectedTotal });
}

describe('F07 / 遗忘范围预览', () => {
  const rows = [
    row({ memoryId: 'p1' }),
    toMemoryRow(taskFact('t1', 'task-9')),
    toMemoryRow(taskFact('t2', 'task-9')),
    toMemoryRow(templateExperience('e1', 'word')),
    toMemoryRow(sessionMessage('s1')),
  ];

  it('entry 范围只命中一条', () => {
    const p = previewForgetScope(rows, { kind: 'entry', memoryId: 'p1' });
    expect(p.matchedMemoryIds).toEqual(['p1']);
    expect(p.authoritative).toBe(false); // UI 预览不是权威
  });

  it('task 范围命中该任务全部记忆', () => {
    const p = previewForgetScope(rows, { kind: 'task', taskId: 'task-9' });
    expect([...p.matchedMemoryIds].sort()).toEqual(['t1', 't2']);
  });

  it('template 范围命中模板经验', () => {
    expect(previewForgetScope(rows, { kind: 'template', templateId: 'word' }).matchedCount).toBe(1);
  });

  it('owner 范围命中全部', () => {
    expect(previewForgetScope(rows, { kind: 'owner' }).matchedCount).toBe(5);
  });

  it('rowInForgetScope 与预览一致', () => {
    const r = toMemoryRow(taskFact('t9', 'task-1'));
    expect(rowInForgetScope(r, { kind: 'task', taskId: 'task-1' })).toBe(true);
    expect(rowInForgetScope(r, { kind: 'task', taskId: 'task-2' })).toBe(false);
  });

  it('非法范围被拒', () => {
    expect(codeOf(() => startForget({ jobId: 'j', ownerId: OWNER, scope: { kind: 'bogus' } as never }))).toBe(
      'invalid-forget-scope',
    );
  });
});

describe('F07 / I6 完成需内核凭据，失败不假报忘记', () => {
  it('confirmed 缺回执引用 → missing-evidence（UI 不能自宣布完成）', () => {
    const j = job({ kind: 'owner' });
    expect(codeOf(() => applyForgetEvent(j, { type: 'confirmed', evidenceRef: '   ' }))).toBe(
      'missing-evidence',
    );
  });

  it('confirmed 带回执 → 才算已忘记，且可移除行', () => {
    let j = job({ kind: 'owner' });
    j = applyForgetEvent(j, { type: 'progress', processed: 2 });
    j = applyForgetEvent(j, {
      type: 'confirmed',
      evidenceRef: 'receipt://kernel/forget/1',
      affectedMemoryIds: ['m1', 'm2'],
    });
    expect(isForgotten(j)).toBe(true);
    expect(shouldRemoveRows(j)).toBe(true);
    expect(j.evidenceRef).toBe('receipt://kernel/forget/1');
  });

  it('failed → 不是已忘记，且不移除任何行', () => {
    let j = job({ kind: 'task', taskId: 'task-9' });
    j = applyForgetEvent(j, { type: 'progress', processed: 1 });
    j = applyForgetEvent(j, { type: 'failed', reason: '存储写墓碑失败' });
    expect(j.state).toBe('failed');
    expect(isForgotten(j)).toBe(false);
    expect(shouldRemoveRows(j)).toBe(false);
    expect(j.affectedMemoryIds).toEqual([]); // 失败没抹掉任何东西
    expect(j.failureReason).toBe('存储写墓碑失败');
  });

  it('cancelled → 不是已忘记，且不移除任何行', () => {
    let j = job({ kind: 'owner' });
    j = applyForgetEvent(j, { type: 'cancelled' });
    expect(j.state).toBe('cancelled');
    expect(isForgotten(j)).toBe(false);
    expect(shouldRemoveRows(j)).toBe(false);
  });

  it('progress 中途的 job 不移除行（未确认不得当已完成）', () => {
    let j = job({ kind: 'owner' });
    j = applyForgetEvent(j, { type: 'progress', processed: 5 });
    expect(shouldRemoveRows(j)).toBe(false);
  });
});

describe('F07 / I7 影响提示来自内核', () => {
  it('内核未给影响 → 显式「未知」，不自造数字', () => {
    const j = job({ kind: 'owner' });
    const impact = describeImpact(j);
    expect(impact.known).toBe(false);
    expect(impact.affectedMemoryCount).toBeNull();
    expect(impact.invalidatedDerivedCount).toBeNull();
    expect(impact.lines.join()).toContain('未知');
  });

  it('内核给了影响 → 原样展示', () => {
    let j = job({ kind: 'owner' });
    j = applyForgetEvent(j, {
      type: 'confirmed',
      evidenceRef: 'r1',
      affectedMemoryIds: ['m1'],
      impactedDerivedIds: ['d1', 'd2'],
      impact: { affectedMemoryCount: 12, invalidatedDerivedCount: 3, note: '含 2 条摘要' },
    });
    const impact = describeImpact(j);
    expect(impact.known).toBe(true);
    expect(impact.affectedMemoryCount).toBe(12);
    expect(impact.invalidatedDerivedCount).toBe(3);
    expect(impact.lines.join()).toContain('含 2 条摘要');
  });

  it('进度展示包含范围 / 状态 / 进度 / 影响行', () => {
    let j = job({ kind: 'task', taskId: 'task-9' }, 4);
    j = applyForgetEvent(j, { type: 'progress', processed: 2 });
    const p = describeForgetProgress(j);
    expect(p.stateLabel).toBe('处理中');
    expect(p.progressText).toBe('2 / 4');
    expect(p.ratio).toBe(0.5);
    expect(p.lines.join()).toContain('任务 task-9');
  });
});

describe('F07 / I8 进度单调不越界，终态不再接事件', () => {
  it('进度倒退 → non-monotonic-progress', () => {
    let j = job({ kind: 'owner' });
    j = applyForgetEvent(j, { type: 'progress', processed: 3 });
    expect(codeOf(() => applyForgetEvent(j, { type: 'progress', processed: 2 }))).toBe(
      'non-monotonic-progress',
    );
  });

  it('进度超过总数 → progress-overflow', () => {
    const j = job({ kind: 'owner' }, 2);
    expect(codeOf(() => applyForgetEvent(j, { type: 'progress', processed: 3 }))).toBe(
      'progress-overflow',
    );
  });

  it('终态之后不再接受任何事件 → job-terminal', () => {
    let j = job({ kind: 'owner' });
    j = applyForgetEvent(j, { type: 'confirmed', evidenceRef: 'r1', affectedMemoryIds: ['m'] });
    expect(isForgetTerminal(j.state)).toBe(true);
    expect(codeOf(() => applyForgetEvent(j, { type: 'progress', processed: 9 }))).toBe('job-terminal');
    expect(codeOf(() => applyForgetEvent(j, { type: 'failed', reason: 'x' }))).toBe('job-terminal');
  });

  it('negative / 非整数 processed 被拒', () => {
    const j = job({ kind: 'owner' });
    expect(codeOf(() => applyForgetEvent(j, { type: 'progress', processed: -1 }))).toBe('invalid-event');
    expect(codeOf(() => applyForgetEvent(j, { type: 'progress', processed: 1.5 }))).toBe('invalid-event');
  });

  it('原 job 不被就地修改（纯函数）', () => {
    const j = job({ kind: 'owner' });
    applyForgetEvent(j, { type: 'progress', processed: 1 });
    expect(j.state).toBe('pending');
    expect(j.processed).toBe(0);
  });
});

describe('F07 / 范围描述', () => {
  it('describeScope 覆盖四种范围', () => {
    expect(describeScope({ kind: 'entry', memoryId: 'm1' })).toContain('m1');
    expect(describeScope({ kind: 'task', taskId: 't1' })).toContain('t1');
    expect(describeScope({ kind: 'template', templateId: 'word' })).toContain('word');
    expect(describeScope({ kind: 'owner' })).toContain('全部');
  });
});

// 类型层保证：ForgetJob 是 startForget 的返回类型（供未来扩展引用）。
const _typecheck: ForgetJob = startForget({ jobId: 'j', ownerId: OWNER, scope: { kind: 'owner' } });
void _typecheck;
