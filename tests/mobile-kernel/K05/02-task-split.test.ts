/**
 * K05 独立验证 ②：**主智能体拆分的结构校验**。
 *
 * 正向：合法拆分通过并把角色规范化成唯一执行席位 `worker`。
 * 负例：重复 id / 未知依赖 / 依赖成环 / 空拆分 / 空目标 —— 一律大声抛 `DispatchError`，
 * 不静默裁掉某条子任务（静默裁掉会让"拆分与计划不一致"变成不可观测的成功）。
 */

import { describe, expect, it } from 'vitest';

import {
  DispatchError,
  isDispatchError,
  validateSplit,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import { expectDispatchError, spec, split } from './fixtures.js';

describe('K05 拆分校验 · 正例', () => {
  it('合法拆分通过，角色规范化为 worker，依赖数组被冻结', () => {
    const normalized = validateSplit(split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit', ['a'])]));
    expect(normalized.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(normalized[1]?.depends_on).toEqual(['a']);
    expect(normalized.every((entry) => entry.role === 'worker')).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('省略 role 视为 worker；显式写 worker 也合法', () => {
    const normalized = validateSplit(split('目标', [spec('a', 'word.edit', [], { role: 'worker' })]));
    expect(normalized[0]?.role).toBe('worker');
  });
});

describe('K05 拆分校验 · 负例', () => {
  it('重复子任务 id ⇒ duplicate_subtask_id', () => {
    const error = expectDispatchError(
      () => validateSplit(split('目标', [spec('a', 'word.edit'), spec('a', 'sheet.edit')])),
      'duplicate_subtask_id',
    );
    expect(error).toBeInstanceOf(DispatchError);
  });

  it('依赖不存在的子任务 ⇒ unknown_dependency', () => {
    expectDispatchError(
      () => validateSplit(split('目标', [spec('a', 'word.edit', ['ghost'])])),
      'unknown_dependency',
    );
  });

  it('依赖成环（a→b→c→a）⇒ dependency_cycle 且指向环', () => {
    const error = expectDispatchError(
      () =>
        validateSplit(
          split('目标', [
            spec('a', 'word.edit', ['c']),
            spec('b', 'sheet.edit', ['a']),
            spec('c', 'slide.edit', ['b']),
          ]),
        ),
      'dependency_cycle',
    );
    expect((error as DispatchError).message).toContain('→');
  });

  it('自依赖（a→a）也算环 ⇒ dependency_cycle', () => {
    expectDispatchError(
      () => validateSplit(split('目标', [spec('a', 'word.edit', ['a'])])),
      'dependency_cycle',
    );
  });

  it('空子任务 ⇒ invalid_split', () => {
    expectDispatchError(() => validateSplit(split('目标', [])), 'invalid_split');
  });

  it('空目标 ⇒ invalid_split', () => {
    expectDispatchError(() => validateSplit(split('', [spec('a', 'word.edit')])), 'invalid_split');
  });

  it('子任务缺 capability_id（空串）⇒ invalid_split', () => {
    expectDispatchError(
      () => validateSplit(split('目标', [spec('a', '')])),
      'invalid_split',
    );
  });

  it('isDispatchError 守卫不是空壳', () => {
    const thrown = (() => {
      try {
        validateSplit(split('目标', [spec('a', 'word.edit', ['ghost'])]));
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(isDispatchError(thrown)).toBe(true);
    expect(isDispatchError({ code: 'not_a_real_code' })).toBe(false);
    expect(isDispatchError(new Error('plain'))).toBe(false);
  });
});
