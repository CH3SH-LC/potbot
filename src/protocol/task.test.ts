import { describe, expect, it } from 'vitest';

import {
  applyTaskPatch,
  asCapabilityId,
  asLogicalTime,
  asRevision,
  asTaskId,
  classifyTaskPatch,
  createTaskPatch,
  createTaskRecord,
  INITIAL_REVISION,
  isSubstantivePatch,
  nextRevision,
  ValidationError,
} from './index.js';

const T1 = asTaskId('T1');
const T0 = asLogicalTime(0);

describe('createTaskRecord（附录 A1）', () => {
  it('补齐默认空集，并以 created_at 作为 updated_at 默认值', () => {
    const task = createTaskRecord({ task_id: T1, goal: '生成活动预算表', created_at: T0 });
    expect(task.revision).toBe(INITIAL_REVISION);
    expect(task.hard_constraints).toEqual([]);
    expect(task.current_group_id).toBeNull();
    expect(task.updated_at).toBe(T0);
  });

  it('goal 为空时拒绝构造', () => {
    expect(() => createTaskRecord({ task_id: T1, goal: '', created_at: T0 })).toThrow(ValidationError);
  });
});

describe('classifyTaskPatch（合同 Q1-a：结构化 patch，不接受自然语言自称）', () => {
  it('仅触及软偏好 → 非实质性，revision 不变', () => {
    const patch = createTaskPatch(T1, asRevision(3), [
      { field: 'soft_preferences', kind: 'add', value: '最好步行十五分钟内' },
    ]);
    const result = classifyTaskPatch(patch);
    expect(result.substantive).toBe(false);
    expect(result.triggers).toEqual([]);
    expect(result.target_revision).toBe(asRevision(3));
    expect(isSubstantivePatch(patch)).toBe(false);
  });

  it('触及硬约束 → 实质性，触发 hard_constraint', () => {
    const patch = createTaskPatch(T1, asRevision(3), [
      { field: 'hard_constraints', kind: 'add', value: '人数固定为十人' },
    ]);
    const result = classifyTaskPatch(patch);
    expect(result.substantive).toBe(true);
    expect(result.triggers).toEqual(['hard_constraint']);
    expect(result.target_revision).toBe(asRevision(4));
  });

  it('同时触及交付物与预算 → 两个触发类别，按常量顺序输出', () => {
    const patch = createTaskPatch(T1, asRevision(1), [
      { field: 'budget_limits', kind: 'replace', value: { total_cny: 600 } },
      { field: 'deliverables', kind: 'add', value: '预算表' },
    ]);
    expect(classifyTaskPatch(patch).triggers).toEqual(['deliverable', 'budget']);
  });

  it('触及禁止事项 → 实质性，触发 forbidden_action', () => {
    const patch = createTaskPatch(T1, asRevision(0), [
      { field: 'forbidden_actions', kind: 'add', value: '不得自动购买' },
    ]);
    expect(classifyTaskPatch(patch).triggers).toEqual(['forbidden_action']);
  });
});

describe('applyTaskPatch', () => {
  const base = createTaskRecord({
    task_id: T1,
    goal: '八人活动预算',
    created_at: T0,
    revision: asRevision(2),
  });

  it('实质性 patch 只递增一次版本，即使有多条命中操作', () => {
    const patch = createTaskPatch(T1, asRevision(2), [
      { field: 'hard_constraints', kind: 'add', value: '十人' },
      { field: 'budget_limits', kind: 'replace', value: { total_cny: 600 } },
    ]);
    const updated = applyTaskPatch(base, patch, asLogicalTime(50));
    expect(updated.revision).toBe(asRevision(3));
    expect(updated.hard_constraints).toEqual(['十人']);
    expect(updated.budget_limits).toEqual({ total_cny: 600 });
    expect(updated.updated_at).toBe(asLogicalTime(50));
    expect(base.revision).toBe(asRevision(2)); // 原记录不变
  });

  it('非实质性 patch 保留原版本', () => {
    const patch = createTaskPatch(T1, asRevision(2), [
      { field: 'soft_preferences', kind: 'add', value: '优先地铁' },
    ]);
    const updated = applyTaskPatch(base, patch, asLogicalTime(50));
    expect(updated.revision).toBe(asRevision(2));
    expect(updated.soft_preferences).toEqual(['优先地铁']);
  });

  it('remove 删除集合元素', () => {
    const withPrefs = createTaskRecord({
      task_id: T1,
      goal: 'g',
      created_at: T0,
      soft_preferences: ['A', 'B'],
    });
    const patch = createTaskPatch(T1, INITIAL_REVISION, [
      { field: 'soft_preferences', kind: 'remove', value: 'A' },
    ]);
    expect(applyTaskPatch(withPrefs, patch, T0).soft_preferences).toEqual(['B']);
  });

  it('base_revision 与当前版本不一致时拒绝套用（错配不得静默应用）', () => {
    const patch = createTaskPatch(T1, asRevision(1), [
      { field: 'hard_constraints', kind: 'add', value: 'x' },
    ]);
    expect(() => applyTaskPatch(base, patch, T0)).toThrow(ValidationError);
  });

  it('patch 触及不可 patch 字段时拒绝', () => {
    const patch = createTaskPatch(T1, asRevision(2), [
      { field: 'revision' as never, kind: 'replace', value: 9 },
    ]);
    expect(() => classifyTaskPatch(patch)).toThrow(ValidationError);
  });
});

/**
 * v1.1 C5：`replace` 必须有形状校验，不得把未校验的 `unknown` 写进 `TaskRecord`。
 * 每条都给出一个"形状不合法"的值，要求**拒绝**而不是产出违规记录。
 */
describe('applyTaskPatch 的运行时形状校验（v1.1 C5）', () => {
  const base = createTaskRecord({
    task_id: T1,
    goal: '八人活动预算',
    created_at: T0,
    revision: asRevision(2),
    capability_scope: [asCapabilityId('spreadsheet')],
  });

  function patchWith(field: string, value: unknown, kind: 'replace' | 'add' | 'remove' = 'replace') {
    return createTaskPatch(T1, asRevision(2), [{ field: field as never, kind, value }]);
  }

  it('title 必须是字符串，不是字符串时拒绝', () => {
    expect(() => applyTaskPatch(base, patchWith('title', 42), T0)).toThrow(ValidationError);
    expect(applyTaskPatch(base, patchWith('title', '十人活动预算'), T0).title).toBe('十人活动预算');
  });

  it('goal 不能是空字符串（与 createTaskRecord 同规则）', () => {
    expect(() => applyTaskPatch(base, patchWith('goal', ''), T0)).toThrow(ValidationError);
    expect(() => applyTaskPatch(base, patchWith('goal', null), T0)).toThrow(ValidationError);
  });

  it('集合字段的 replace 必须是字符串数组；元素必须是字符串', () => {
    expect(() => applyTaskPatch(base, patchWith('hard_constraints', '十人'), T0)).toThrow(ValidationError);
    expect(() => applyTaskPatch(base, patchWith('hard_constraints', [1, 2]), T0)).toThrow(ValidationError);
    const ok = applyTaskPatch(base, patchWith('hard_constraints', ['十人']), T0);
    expect(ok.hard_constraints).toEqual(['十人']);
  });

  it('集合元素的 add/remove 必须给元素而不是数组（代替旧的"整份替换"）', () => {
    const withElement = applyTaskPatch(base, patchWith('deliverables', '预算表', 'add'), T0);
    expect(withElement.deliverables).toEqual(['预算表']);
    // add 一个数组是常见误用：必须拒绝，否则会写出 string[] 里嵌数组的违规记录。
    expect(() => applyTaskPatch(base, patchWith('deliverables', ['预算表'], 'add'), T0)).toThrow(
      ValidationError,
    );
    // deliverables 是实质性字段，add 已把版本推到 3：第二份 patch 必须基于新版本（Q1-a）
    const removed = applyTaskPatch(
      withElement,
      createTaskPatch(T1, withElement.revision, [
        { field: 'deliverables', kind: 'remove', value: '预算表' },
      ]),
      T0,
    );
    expect(removed.deliverables).toEqual([]);
  });

  it('budget_limits 必须是 { 名称: 有限数 }，值非数 / NaN / 数组都拒绝', () => {
    expect(() => applyTaskPatch(base, patchWith('budget_limits', 600), T0)).toThrow(ValidationError);
    expect(() => applyTaskPatch(base, patchWith('budget_limits', { total: '600' }), T0)).toThrow(ValidationError);
    expect(() => applyTaskPatch(base, patchWith('budget_limits', { total: Number.NaN }), T0)).toThrow(
      ValidationError,
    );
    const ok = applyTaskPatch(base, patchWith('budget_limits', { total_cny: 600 }), T0);
    expect(ok.budget_limits).toEqual({ total_cny: 600 });
  });

  it('budget_limits 只支持 replace（add/remove 无意义，拒绝）', () => {
    expect(() => applyTaskPatch(base, patchWith('budget_limits', { total_cny: 600 }, 'add'), T0)).toThrow(
      ValidationError,
    );
  });

  it('current_group_id 只接受字符串或 null；不支持 add/remove', () => {
    expect(() => applyTaskPatch(base, patchWith('current_group_id', 7), T0)).toThrow(ValidationError);
    expect(applyTaskPatch(base, patchWith('current_group_id', null), T0).current_group_id).toBeNull();
    expect(() => applyTaskPatch(base, patchWith('current_group_id', 'G1', 'add'), T0)).toThrow(ValidationError);
  });

  it('capability_scope 的 replace 与 add 都经过品牌化构造（元素必须是非空字符串）', () => {
    const replaced = applyTaskPatch(base, patchWith('capability_scope', ['search']), T0);
    expect(replaced.capability_scope).toEqual([asCapabilityId('search')]);
    const added = applyTaskPatch(base, patchWith('capability_scope', 'calendar', 'add'), T0);
    expect(added.capability_scope).toEqual([asCapabilityId('spreadsheet'), asCapabilityId('calendar')]);
    expect(() => applyTaskPatch(base, patchWith('capability_scope', [''], 'replace'), T0)).toThrow();
  });

  it('标量字段（title/goal）不接受 add/remove', () => {
    expect(() => applyTaskPatch(base, patchWith('title', 'x', 'add'), T0)).toThrow(ValidationError);
    expect(() => applyTaskPatch(base, patchWith('goal', 'x', 'add'), T0)).toThrow(ValidationError);
  });

  it('校验失败时原记录不变，且不会产出"半套"记录', () => {
    const before = JSON.stringify(base);
    expect(() =>
      applyTaskPatch(base, patchWith('budget_limits', { total: 'oops' }), T0),
    ).toThrow(ValidationError);
    expect(JSON.stringify(base)).toBe(before);
    expect(base.budget_limits).toEqual({});
  });
});

describe('revision 基础操作', () => {
  it('nextRevision 单调递增', () => {
    expect(nextRevision(asRevision(0))).toBe(asRevision(1));
    expect(nextRevision(asRevision(41))).toBe(asRevision(42));
  });

  it('asRevision 拒绝负数与非整数', () => {
    expect(() => asRevision(-1)).toThrow(RangeError);
    expect(() => asRevision(1.5)).toThrow(RangeError);
    expect(asRevision(0) as unknown as number).toBe(0);
    expect(INITIAL_REVISION as unknown as number).toBe(0);
  });
});
