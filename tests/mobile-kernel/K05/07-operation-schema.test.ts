/**
 * K05 独立验证 ⑦：**操作 schema / 命令校验**。
 *
 * 逐字段验证：缺必需字段 / 类型不符 / 未知字段 / 枚举外取值 / 空数组 各成一类问题；
 * 正向对照证明校验器不是恒拒；`assertDispatchCommand` 在失败时抛 `DispatchError('invalid_command')`。
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_ROOT_ALLOWED,
  DISPATCH_OPERATIONS,
  assertDispatchCommand,
  validateDispatchCommand,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import { expectDispatchError, spec, split } from './fixtures.js';

const validPlanCommand = {
  schemaVersion: 'mobile-v1',
  commandId: 'cmd-1',
  operation: 'plan',
  idempotencyKey: 'idem-1',
  payload: {
    goal: '做周报',
    split: split('做周报', [spec('a', 'word.edit')]),
    max_parallel: 2,
  },
} as const;

function paths(input: unknown): string[] {
  return validateDispatchCommand(input).issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe('K05 命令 schema · 正向对照（不是恒拒）', () => {
  it('合法 plan 命令 0 条问题', () => {
    const result = validateDispatchCommand(validPlanCommand);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(() => assertDispatchCommand(validPlanCommand)).not.toThrow();
  });

  it('各操作的必需字段表被覆盖（launch/result/cancel/status）', () => {
    expect(
      validateDispatchCommand({
        schemaVersion: 'mobile-v1',
        commandId: 'c',
        operation: 'launch',
        idempotencyKey: 'i',
        payload: { task_id: 't' },
      }).ok,
    ).toBe(true);
    expect(
      validateDispatchCommand({
        schemaVersion: 'mobile-v1',
        commandId: 'c',
        operation: 'result',
        idempotencyKey: 'i',
        payload: { task_id: 't', subtask_id: 'a', outcome: 'succeeded' },
      }).ok,
    ).toBe(true);
    expect(
      validateDispatchCommand({
        schemaVersion: 'mobile-v1',
        commandId: 'c',
        operation: 'cancel',
        idempotencyKey: 'i',
        payload: { task_id: 't', reason: '停' },
      }).ok,
    ).toBe(true);
    expect(
      validateDispatchCommand({
        schemaVersion: 'mobile-v1',
        commandId: 'c',
        operation: 'status',
        idempotencyKey: 'i',
        payload: { task_id: 't' },
      }).ok,
    ).toBe(true);
  });

  it('根对象允许字段恰好是 5 个公共字段', () => {
    expect([...COMMAND_ROOT_ALLOWED].sort()).toEqual([
      'commandId',
      'idempotencyKey',
      'operation',
      'payload',
      'schemaVersion',
    ]);
    expect(DISPATCH_OPERATIONS).toContain('plan');
  });
});

describe('K05 命令 schema · 负例', () => {
  it('缺 idempotencyKey ⇒ missing_required', () => {
    const { idempotencyKey, ...rest } = validPlanCommand;
    void idempotencyKey;
    expect(paths(rest)).toContain('$.idempotencyKey:missing_required');
  });

  it('根对象多出未知字段 ⇒ unknown_field', () => {
    expect(paths({ ...validPlanCommand, extra: true })).toContain('$.extra:unknown_field');
  });

  it('operation 枚举外取值 ⇒ unknown_operation', () => {
    expect(paths({ ...validPlanCommand, operation: 'launchAll' })).toContain('$.operation:unknown_operation');
  });

  it('schemaVersion 非 mobile-v1 ⇒ invalid_value', () => {
    expect(paths({ ...validPlanCommand, schemaVersion: 'mobile-v2' })).toContain('$.schemaVersion:invalid_value');
  });

  it('plan 缺 split.subtasks ⇒ missing_required', () => {
    const command = {
      ...validPlanCommand,
      payload: { goal: 'x', split: { goal: 'x' } },
    };
    expect(paths(command)).toContain('$.payload.split.subtasks:missing_required');
  });

  it('plan 的 split.subtasks 为空数组 ⇒ empty_array', () => {
    const command = {
      ...validPlanCommand,
      payload: { goal: 'x', split: { goal: 'x', subtasks: [] } },
    };
    expect(paths(command)).toContain('$.payload.split.subtasks:empty_array');
  });

  it('plan 的 max_parallel 非正整数 ⇒ invalid_value', () => {
    const command = { ...validPlanCommand, payload: { ...validPlanCommand.payload, max_parallel: 0 } };
    expect(paths(command)).toContain('$.payload.max_parallel:invalid_value');
  });

  it('result 的 outcome 枚举外取值 ⇒ invalid_value', () => {
    const command = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'result',
      idempotencyKey: 'i',
      payload: { task_id: 't', subtask_id: 'a', outcome: 'maybe' },
    };
    expect(paths(command)).toContain('$.payload.outcome:invalid_value');
  });

  it('payload 不是对象 ⇒ wrong_type', () => {
    expect(paths({ ...validPlanCommand, payload: 42 })).toContain('$.payload:wrong_type');
  });

  it('assertDispatchCommand 失败抛 invalid_command（带问题摘要）', () => {
    expectDispatchError(() => assertDispatchCommand({ ...validPlanCommand, extra: true }), 'invalid_command');
  });
});
