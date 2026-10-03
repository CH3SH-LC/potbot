/**
 * K-I16 ①：把派发命令面**绑到冻结契约** `contracts/mobile-v1/schemas/command.schema.json`。
 *
 * K05 的自证缺口：`schema.ts` 的规则只由同包测试断言，没有外部冻结物件当裁判。本文件读取
 * 冻结文件，机械核对 `schema.ts` 导出的常量，并用**由该文件驱动**的通用子集求值器
 * （`json-schema-subset.ts`）验证 `toContractCommand()` 的投影产物，同时给出负例。
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_ROOT_ALLOWED,
  COMMAND_ROOT_REQUIRED,
  COMMAND_SCHEMA_VERSION,
  CONTRACT_ID_MAX_LENGTH,
  CONTRACT_ID_MIN_LENGTH,
  CONTRACT_OPERATION_HINT,
  CONTRACT_PUBLIC_OPERATIONS,
  CONTRACT_PUBLIC_ROOT_FIELDS,
  CONTRACT_SCHEMA_ID,
  DISPATCH_OPERATIONS,
  toContractCommand,
  validateDispatchCommand,
  type DispatchOperation,
} from '../../../apps/mobile-kernel/dispatch/schema.js';
import {
  isDispatchError,
  type DispatchError,
} from '../../../apps/mobile-kernel/dispatch/index.js';

import { loadContractSchema, spec, split } from './fixtures.js';
import { validateSubset } from './json-schema-subset.js';

const schema = loadContractSchema();

function defs(schemaObject: Record<string, unknown>): Record<string, unknown> {
  const value = schemaObject.$defs;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('冻结契约缺 $defs');
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.every((item) => typeof item === 'string') === false) {
    throw new Error(`${label} 不是字符串数组`);
  }
  return value as string[];
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${label} 不是数字`);
  }
  return value;
}

const contractDefs = defs(schema);
const contractOperationEnum = asStringArray(
  (contractDefs.operation as Record<string, unknown>).enum,
  '$defs.operation.enum',
);

const planCommand = {
  schemaVersion: 'mobile-v1',
  commandId: 'cmd-plan',
  operation: 'plan',
  idempotencyKey: 'idem-plan',
  payload: {
    goal: '做周报',
    split: split('做周报', [spec('a', 'word.edit')]),
    max_parallel: 2,
  },
} as const;

const cancelCommand = {
  schemaVersion: 'mobile-v1',
  commandId: 'cmd-cancel',
  operation: 'cancel',
  idempotencyKey: 'idem-cancel',
  payload: { task_id: 'task-1', reason: '停' },
} as const;

const statusCommand = {
  schemaVersion: 'mobile-v1',
  commandId: 'cmd-status',
  operation: 'status',
  idempotencyKey: 'idem-status',
  payload: { task_id: 'task-1' },
} as const;

function issuePaths(input: unknown): string[] {
  return validateDispatchCommand(input).issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe('K-I16 §A · 契约身份与根形状绑定', () => {
  it('冻结文件可读且 $id 与绑定点一致', () => {
    expect(schema.$id).toBe(CONTRACT_SCHEMA_ID);
  });

  it('根必需字段集合 === COMMAND_ROOT_REQUIRED（契约驱动，不是抄写）', () => {
    const contractRequired = asStringArray(schema.required, 'root.required');
    expect([...contractRequired].sort()).toEqual([...COMMAND_ROOT_REQUIRED].sort());
  });

  it('契约根是封闭对象；派发允许集是契约允许集的**子集**（可严不可松）', () => {
    expect(schema.additionalProperties).toBe(false);
    const contractProperties = Object.keys(
      (schema.properties as Record<string, unknown>) ?? {},
    );
    expect([...contractProperties].sort()).toEqual([...CONTRACT_PUBLIC_ROOT_FIELDS].sort());
    for (const field of COMMAND_ROOT_ALLOWED) {
      expect(contractProperties, `派发允许字段 ${field} 不在契约 properties 里`).toContain(field);
    }
  });

  it('schemaVersion 常量绑定到契约 $defs.schemaVersion.const', () => {
    expect((contractDefs.schemaVersion as Record<string, unknown>).const).toBe(
      COMMAND_SCHEMA_VERSION,
    );
  });

  it('公共 id 的长度约束绑定到契约 $defs.id', () => {
    const idDef = contractDefs.id as Record<string, unknown>;
    expect(asNumber(idDef.maxLength, '$defs.id.maxLength')).toBe(CONTRACT_ID_MAX_LENGTH);
    expect(asNumber(idDef.minLength, '$defs.id.minLength')).toBe(CONTRACT_ID_MIN_LENGTH);
  });
});

describe('K-I16 §B · operation 映射绑定', () => {
  it('每个可对外投影的操作都落在契约 operation 枚举里', () => {
    for (const operation of CONTRACT_PUBLIC_OPERATIONS) {
      const hinted = CONTRACT_OPERATION_HINT[operation];
      expect(hinted, `操作 ${operation} 应可对外投影`).not.toBeNull();
      expect(contractOperationEnum).toContain(hinted);
    }
  });

  it('CONTRACT_PUBLIC_OPERATIONS 恰为映射表里非 null 的操作（派生无漂移）', () => {
    const derived = DISPATCH_OPERATIONS.filter(
      (operation) => CONTRACT_OPERATION_HINT[operation as DispatchOperation] !== null,
    );
    expect([...CONTRACT_PUBLIC_OPERATIONS]).toEqual([...derived]);
    expect([...CONTRACT_PUBLIC_OPERATIONS].sort()).toEqual(['cancel', 'plan', 'status']);
  });

  it('内核内部操作（launch/result）没有契约对应词', () => {
    expect(CONTRACT_OPERATION_HINT.launch).toBeNull();
    expect(CONTRACT_OPERATION_HINT.result).toBeNull();
  });
});

describe('K-I16 §C · 投影产物通过冻结 schema（外部裁判）', () => {
  const exposed: readonly [string, unknown][] = [
    ['plan', planCommand],
    ['cancel', cancelCommand],
    ['status', statusCommand],
  ];

  for (const [name, command] of exposed) {
    it(`${name}：派发校验通过 → 投影为契约信封 → 冻结 schema 接受`, () => {
      expect(validateDispatchCommand(command).ok, `${name} 命令应合法`).toBe(true);
      const envelope = toContractCommand(command);
      const result = validateSubset(schema, envelope);
      expect(result.errors, `${name} 投影未通过契约：${result.errors.join(' | ')}`).toEqual([]);
      expect(result.valid).toBe(true);
      expect(envelope.schemaVersion).toBe(COMMAND_SCHEMA_VERSION);
      expect(contractOperationEnum).toContain(envelope.operation);
    });
  }

  it('plan → create，payload 只保留契约认识的 goal（split/max_parallel 被丢弃）', () => {
    const envelope = toContractCommand(planCommand);
    expect(envelope.operation).toBe('create');
    expect(Object.keys(envelope.payload).sort()).toEqual(['goal']);
    expect(envelope.payload.goal).toBe('做周报');
  });

  it('cancel → cancel，task_id 按契约命名投影为 taskId（reason 被丢弃）', () => {
    const envelope = toContractCommand(cancelCommand);
    expect(envelope.operation).toBe('cancel');
    expect(Object.keys(envelope.payload).sort()).toEqual(['taskId']);
    expect(envelope.payload.taskId).toBe('task-1');
  });

  it('status → query，指向 taskId', () => {
    const envelope = toContractCommand(statusCommand);
    expect(envelope.operation).toBe('query');
    expect(envelope.payload.taskId).toBe('task-1');
  });
});

describe('K-I16 §D · 内部操作不产生对外信封', () => {
  it('launch / result 投影抛 DispatchError(invalid_command)', () => {
    const launch = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'launch',
      idempotencyKey: 'i',
      payload: { task_id: 't' },
    };
    const result = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'result',
      idempotencyKey: 'i',
      payload: { task_id: 't', subtask_id: 'a', outcome: 'succeeded' },
    };
    for (const command of [launch, result]) {
      let caught: unknown;
      try {
        toContractCommand(command);
      } catch (error) {
        caught = error;
      }
      expect(isDispatchError(caught), `${command.operation} 应抛 DispatchError`).toBe(true);
      expect((caught as DispatchError).code).toBe('invalid_command');
    }
  });
});

describe('K-I16 §E · 负例（证明冻结 schema 的裁判真的在起作用）', () => {
  it('create 信封若带上派发私有字段 split ⇒ 冻结 schema 拒绝（所以投影必须丢弃）', () => {
    const bad = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'create',
      idempotencyKey: 'i',
      payload: { goal: 'x', split: { goal: 'x', subtasks: [] } },
    };
    expect(validateSubset(schema, bad).valid).toBe(false);
  });

  it('cancel 信封缺 taskId ⇒ 冻结 schema 拒绝（query payload 的 anyOf 生效）', () => {
    const bad = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'cancel',
      idempotencyKey: 'i',
      payload: {},
    };
    expect(validateSubset(schema, bad).valid).toBe(false);
  });

  it('内核内部操作 launch 没有匹配分支 ⇒ 冻结 schema 拒绝（oneOf 需恰一个）', () => {
    const bad = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'launch',
      idempotencyKey: 'i',
      payload: { task_id: 't' },
    };
    expect(validateSubset(schema, bad).valid).toBe(false);
  });

  it('schemaVersion 非 mobile-v1 ⇒ 冻结 schema 拒绝', () => {
    const bad = {
      schemaVersion: 'mobile-v2',
      commandId: 'c',
      operation: 'create',
      idempotencyKey: 'i',
      payload: { goal: 'x' },
    };
    expect(validateSubset(schema, bad).valid).toBe(false);
  });

  it('公共 id 长度边界：两侧校验一致（128 收、129 拒）', () => {
    const maxId = 'x'.repeat(CONTRACT_ID_MAX_LENGTH);
    const tooLongId = 'x'.repeat(CONTRACT_ID_MAX_LENGTH + 1);

    expect(
      validateDispatchCommand({ ...planCommand, commandId: maxId }).ok,
      '128 长 commandId 应被派发校验接受',
    ).toBe(true);
    expect(
      issuePaths({ ...planCommand, commandId: tooLongId }),
      '129 长 commandId 应被派发校验拒绝',
    ).toContain('$.commandId:invalid_value');

    const contractEnvelope = {
      schemaVersion: 'mobile-v1',
      commandId: maxId,
      operation: 'create',
      idempotencyKey: 'i',
      payload: { goal: 'x' },
    };
    expect(validateSubset(schema, contractEnvelope).valid, '128 长 commandId 应过契约').toBe(true);
    expect(
      validateSubset(schema, { ...contractEnvelope, commandId: tooLongId }).valid,
      '129 长 commandId 应被契约拒绝',
    ).toBe(false);
  });

  it('契约比派发面更宽：metadata 契约接受、派发面拒绝（派发是更严子集）', () => {
    const withMetadata = { ...planCommand, metadata: { trace: 't' } };
    expect(issuePaths(withMetadata)).toContain('$.metadata:unknown_field');
    // 契约确实允许 metadata（否则上面的"更严子集"论断就没有证据）。
    const envelope = {
      schemaVersion: 'mobile-v1',
      commandId: 'c',
      operation: 'create',
      idempotencyKey: 'i',
      payload: { goal: 'x' },
      metadata: {},
    };
    expect(validateSubset(schema, envelope).valid).toBe(true);
  });
});

describe('K-I16 §F · 求值器自检（不是恒真）', () => {
  const tiny = {
    type: 'object',
    additionalProperties: false,
    required: ['x'],
    properties: { x: { type: 'string', minLength: 2 } },
  } as Record<string, unknown>;

  it('正例通过', () => {
    expect(validateSubset(tiny, { x: 'ab' }).valid).toBe(true);
  });

  it('负例：类型 / 缺必需 / 额外属性 / minLength 都被拒', () => {
    expect(validateSubset(tiny, { x: 1 }).valid).toBe(false);
    expect(validateSubset(tiny, {}).valid).toBe(false);
    expect(validateSubset(tiny, { x: 'ab', y: 1 }).valid).toBe(false);
    expect(validateSubset(tiny, { x: 'a' }).valid).toBe(false);
  });

  it('负例：错误信息可读（带路径）', () => {
    const result = validateSubset(tiny, { x: 1 });
    expect(result.errors.join(' | ')).toContain('$.x');
  });
});
