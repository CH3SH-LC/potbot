/**
 * K05 独立验证 ⑥：**无固定规划 / 审核角色**。
 *
 * K05 明确"无固定规划/审核角色"：拆分由主智能体自己（唯一规划者）完成，群里只有执行席位。
 * 任何在子任务里声明 `planner` / `reviewer` / `orchestrator` / `supervisor` 的拆分必须被拒。
 * 正向对照：显式 `worker` 或省略角色都合法；合法计划里所有群组成员都是 `worker`。
 */

import { describe, expect, it } from 'vitest';

import {
  EXECUTOR_ROLE,
  FORBIDDEN_FIXED_ROLES,
  isForbiddenFixedRole,
  validateSplit,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import { expectDispatchError, planOf, spec, split } from './fixtures.js';

describe('K05 角色纪律 · 固定规划/审核角色必须被拒', () => {
  it('声明的禁止角色集合非空且含 planner / reviewer', () => {
    expect(FORBIDDEN_FIXED_ROLES.length).toBeGreaterThan(0);
    expect(FORBIDDEN_FIXED_ROLES).toContain('planner');
    expect(FORBIDDEN_FIXED_ROLES).toContain('reviewer');
  });

  it.each([...FORBIDDEN_FIXED_ROLES])('子任务声明 %s ⇒ fixed_role_forbidden', (role) => {
    expectDispatchError(
      () => validateSplit(split('目标', [spec('a', 'word.edit', [], { role })])),
      'fixed_role_forbidden',
    );
    expect(isForbiddenFixedRole(role)).toBe(true);
  });

  it('planDispatch 同样拒绝（不是只有 validateSplit 拦）', () => {
    expectDispatchError(
      () => planOf(split('目标', [spec('a', 'word.edit', [], { role: 'planner' })])),
      'fixed_role_forbidden',
    );
  });

  it('未知角色（非禁止、非 worker）⇒ invalid_split', () => {
    expectDispatchError(
      () => validateSplit(split('目标', [spec('a', 'word.edit', [], { role: 'wizard' })])),
      'invalid_split',
    );
  });
});

describe('K05 角色纪律 · 正向对照', () => {
  it('合法计划里，所有群组成员角色都是唯一执行席位 worker', () => {
    const plan = planOf(
      split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit', ['a']), spec('c', 'slide.edit')]),
    );
    expect(EXECUTOR_ROLE).toBe('worker');
    expect(plan.group.members.every((member) => member.role === 'worker')).toBe(true);
    expect(plan.subtasks.every((task) => task.role === 'worker')).toBe(true);
    // 群里没有任何规划/审核席位
    expect(plan.group.members.some((member) => isForbiddenFixedRole(member.role))).toBe(false);
  });

  it('isForbiddenFixedRole 对正常角色与空值返回 false', () => {
    expect(isForbiddenFixedRole('worker')).toBe(false);
    expect(isForbiddenFixedRole('')).toBe(false);
  });
});
