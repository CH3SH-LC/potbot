/**
 * F07 验收：列表行投影 · 来源可见 · 范围一致 · 筛选排序（I2）。
 *
 * 反向对照：
 *   1) 来源详情为空 → 构造期即拒（不留白、不编造来源）；
 *   2) kind 与 scope 不一致 → 拒（内核 R235 的结构化强制在视图层同样生效）；
 *   3) 排序确定性：同输入必得同序（平局用 memoryId 打破）；
 *   4) 空 `kinds` 数组表示「什么都不匹配」，不是「全都匹配」。
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryViewModelError,
  filterMemoryRows,
  isInjectable,
  listMemoryRows,
  toMemoryRow,
  type MemoryEntryView,
} from '../../../apps/mobile-ui/src/memory/index.js';

import { entry, row, sessionMessage, taskFact, templateExperience } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryViewModelError ? error.code : `non-vm-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

describe('F07 / I2 行投影与来源可见', () => {
  it('行带齐来源 · 范围 · 确认态 · 版本', () => {
    const r = row({ source: { kind: 'document', detail: '来自合同.pdf' } });
    expect(r.sourceLabel).toBe('文档');
    expect(r.source.detail).toBe('来自合同.pdf');
    expect(r.scopeLabel).toBe('用户');
    expect(r.confirmationLabel).toBe('已确认');
    expect(r.version).toBe(3);
    expect(r.kindLabel).toBe('用户偏好');
  });

  it('来源详情为空 → 构造期拒绝，不留白', () => {
    expect(
      codeOf(() => toMemoryRow(entry({ source: { kind: 'user_statement', detail: '   ' } }))),
    ).toBe('invalid-source');
  });

  it('正文为空 → 拒绝', () => {
    expect(codeOf(() => toMemoryRow(entry({ body: '' })))).toBe('invalid-body');
  });

  it('kind 与 scope 不一致 → invalid-scope（任务事实不得是用户范围）', () => {
    const bad: MemoryEntryView = entry({
      kind: 'task_fact',
      scope: { kind: 'user', taskId: null, templateId: null },
      taskId: 't-1',
    });
    expect(codeOf(() => toMemoryRow(bad))).toBe('invalid-scope');
  });

  it('task_fact 两处 taskId 不一致 → 拒绝', () => {
    const bad: MemoryEntryView = entry({
      kind: 'task_fact',
      scope: { kind: 'task', taskId: 't-1', templateId: null },
      taskId: 't-2',
      body: 'x',
    });
    expect(codeOf(() => toMemoryRow(bad))).toBe('invalid-scope');
  });

  it('updatedAt 早于 createdAt → 拒绝', () => {
    expect(codeOf(() => toMemoryRow(entry({ createdAt: 10, updatedAt: 5 })))).toBe(
      'invalid-logical-time',
    );
  });
});

describe('F07 / I2 筛选与确定性排序', () => {
  const rows = [
    row({ memoryId: 'p1', kind: 'preference', updatedAt: 30, body: '喜欢喝美式' }),
    toMemoryRow(taskFact('t1', 'task-9', '任务里要打印两份')),
    toMemoryRow(templateExperience('e1', 'word')),
    toMemoryRow(sessionMessage('s1', 'conv-7')),
  ];

  it('按 kind 筛选', () => {
    expect(filterMemoryRows(rows, { kinds: ['task_fact'] }).map((r) => r.memoryId)).toEqual(['t1']);
  });

  it('按范围筛选', () => {
    expect(filterMemoryRows(rows, { scopeKind: 'template' }).map((r) => r.memoryId)).toEqual(['e1']);
  });

  it('文本子串匹配（大小写不敏感）', () => {
    expect(filterMemoryRows(rows, { text: '美式' }).map((r) => r.memoryId)).toEqual(['p1']);
  });

  it('空 kinds 数组 = 什么都不匹配（不是全都匹配）', () => {
    expect(filterMemoryRows(rows, { kinds: [] })).toEqual([]);
  });

  it('排序确定性：updatedAt 降序 + memoryId 升序打破平局', () => {
    const sorted = listMemoryRows(rows);
    const ids = sorted.map((r) => r.memoryId);
    // p1(30) 最前；其余 updatedAt=20，按 memoryId 升序：e1, s1, t1
    expect(ids).toEqual(['p1', 'e1', 's1', 't1']);
    // 同输入重复调用给同一结果
    expect(listMemoryRows(rows).map((r) => r.memoryId)).toEqual(ids);
  });

  it('可注入判定：停用 / 已否定 不再进入注入', () => {
    expect(isInjectable(row({ status: 'active', confirmation: 'confirmed' }))).toBe(true);
    expect(isInjectable(row({ status: 'disabled' }))).toBe(false);
    expect(isInjectable(row({ status: 'active', confirmation: 'rejected' }))).toBe(false);
  });
});
