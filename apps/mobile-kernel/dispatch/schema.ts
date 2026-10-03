/**
 * K05 手机内核 · 主智能体派发 —— **操作 schema / 命令校验**（零依赖、纯函数）。
 *
 * 前端（F）与内核（K）之间的命令面按 README §5 的 v1 契约走：公共字段
 * `schemaVersion, commandId, operation, idempotencyKey, payload`。本文件实现 K05 这一侧的
 * **形状校验器**——不引 JSON Schema 运行时（手机 APK 要瘦），用一份与 K06 `validateManifest`
 * 同风格的纯 TS 校验：逐字段报 `{ path, code }`，缺字段 / 类型不符 / 未知字段 / 枚举外取值
 * 各成一类，都可逐条断言。
 *
 * ## 与契约 `operation` 的关系
 *
 * 契约 `contracts/mobile-v1/schemas/command.schema.json` 的 `operation` 枚举是通用业务面
 * （create/mutate/cancel/query…）。派发的 `plan`/`cancel`/`status` 对得上 `create`/`cancel`/`query`；
 * `launch`/`result` 是**内核内部的运行期步骤**（子任务启动、结果回灌），不作为独立对外命令暴露，
 * 故在此保留为本模块的操作，并在映射表里标出对应关系。这样既不与冻结契约冲突，也能让本层
 * 的运行时驱动（worker-loop 类）有明确的操作词。
 *
 * ## 与冻结契约的**绑定**（K-I16）
 *
 * K05 初版的自证问题：本文件的校验规则只由同包测试断言，缺少**外部冻结物件**做裁判。
 * 本模块据此补齐绑定，且**不在运行期读文件**（手机 APK 不引 `node:fs`）：绑定分两半——
 *
 * 1. **投影**（本文件）：`toContractCommand()` 把一条派发命令投影成**契约公共命令信封**
 *    （`Plan`→`create`、`Cancel`→`cancel`、`Status`→`query`；`launch`/`result` 是内核内部
 *    步骤，**没有**对外信封，投影时抛错）。契约 `targetPayload` / query payload 是
 *    `additionalProperties:false` 的，故派发私有的 `split` / `max_parallel` / `reason`
 *    在投影里**必须**被丢弃——这正是"公开面只带契约认识的字段"。
 * 2. **裁判**（`tests/mobile-kernel/K-I16/`）：契约测试**读取**冻结文件
 *    `contracts/mobile-v1/schemas/command.schema.json`，机械核对本文件导出的常量
 *    （`COMMAND_ROOT_REQUIRED` / `COMMAND_SCHEMA_VERSION` / `CONTRACT_ID_MAX_LENGTH` /
 *    `CONTRACT_OPERATION_HINT` 的取值），并用一个**由该文件驱动**的通用子集求值器验证投影
 *    产物确实通过冻结 schema，同时给出负例证明求值器不是恒真。
 *    因此 `commandId` / `idempotencyKey` 的 `maxLength` 也从契约 `$defs.id` 绑定过来。
 */

import { DispatchError } from './errors.js';

/** K05 派发命令的操作词（本模块内部命令面）。 */
export const DISPATCH_OPERATIONS = ['plan', 'launch', 'result', 'cancel', 'status'] as const;
export type DispatchOperation = (typeof DISPATCH_OPERATIONS)[number];

/** 与契约通用 operation 的对应（`null` = 内核内部步骤，不对外暴露为独立命令）。 */
export const CONTRACT_OPERATION_HINT: Readonly<Record<DispatchOperation, string | null>> = Object.freeze({
  plan: 'create',
  launch: null,
  result: null,
  cancel: 'cancel',
  status: 'query',
});

export const COMMAND_ROOT_REQUIRED = ['schemaVersion', 'commandId', 'operation', 'idempotencyKey', 'payload'] as const;
export const COMMAND_ROOT_ALLOWED = COMMAND_ROOT_REQUIRED;
export const COMMAND_SCHEMA_VERSION = 'mobile-v1' as const;

export const RESULT_OUTCOMES = ['succeeded', 'failed'] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// 契约绑定常量（对照只读冻结件 contracts/mobile-v1/schemas/command.schema.json）
// ---------------------------------------------------------------------------

/** 冻结契约文件路径（**只读**；K-I16 契约测试读取它并对本模块复算）。 */
export const CONTRACT_SCHEMA_ID = 'contracts/mobile-v1/schemas/command.schema.json';

/** 契约 `$defs.id` 的长度约束——公共 id（`commandId` / `idempotencyKey`）必须落在 [1, 128]。 */
export const CONTRACT_ID_MIN_LENGTH = 1;
export const CONTRACT_ID_MAX_LENGTH = 128;

/**
 * 契约根对象允许的字段（`additionalProperties:false` 下的 `properties` 键）。
 * 注意：契约允许可选的 `metadata`，而本派发面**不接受**它——本面是契约的**更严子集**
 * （子集仍满足契约；契约测试断言 `COMMAND_ROOT_ALLOWED ⊆` 该集合，而非相等）。
 */
export const CONTRACT_PUBLIC_ROOT_FIELDS = [
  'schemaVersion',
  'commandId',
  'operation',
  'idempotencyKey',
  'payload',
  'metadata',
] as const;

/**
 * 可**对外投影**的操作：契约里有对应词的操作（`CONTRACT_OPERATION_HINT` 非 null 的那几个）。
 * 从映射表派生，避免两处各写一份而漂移。
 */
export const CONTRACT_PUBLIC_OPERATIONS: readonly DispatchOperation[] = Object.freeze(
  DISPATCH_OPERATIONS.filter((operation) => CONTRACT_OPERATION_HINT[operation] !== null),
);

/** 契约公共命令信封——与 `command.schema.json` 的根字段一致。 */
export interface ContractCommand {
  readonly schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 校验问题码。新增须在此登记（测试逐条对照）。 */
export const COMMAND_ISSUE_CODES = [
  'missing_required',
  'wrong_type',
  'invalid_value',
  'unknown_field',
  'empty_array',
  'unknown_operation',
] as const;
export type CommandIssueCode = (typeof COMMAND_ISSUE_CODES)[number];

export interface CommandIssue {
  /** 出问题的字段路径，如 `$.payload.task_id`。 */
  readonly path: string;
  readonly code: CommandIssueCode;
  readonly detail: string;
}

export interface CommandValidation {
  readonly ok: boolean;
  readonly issues: readonly CommandIssue[];
}

const ALLOWED_ROOT = new Set<string>(COMMAND_ROOT_ALLOWED);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: CommandIssue[],
  maxLength?: number,
): void {
  const value = record[key];
  if (value === undefined) {
    issues.push({ path: `${path}.${key}`, code: 'missing_required', detail: `缺必需字段 ${key}` });
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    issues.push({ path: `${path}.${key}`, code: 'wrong_type', detail: `${key} 必须是非空字符串` });
    return;
  }
  if (maxLength !== undefined && value.length > maxLength) {
    issues.push({
      path: `${path}.${key}`,
      code: 'invalid_value',
      detail: `${key} 长度 ${String(value.length)} 超出契约上限 ${String(maxLength)}（command.schema.json $defs.id.maxLength）`,
    });
  }
}

/** 每个操作里**必须是字符串**的必需字段。对象类字段（`split`）在下方单独校验。 */
const PAYLOAD_STRING_FIELDS: Readonly<Record<DispatchOperation, readonly string[]>> = Object.freeze({
  plan: ['goal'],
  launch: ['task_id'],
  result: ['task_id', 'subtask_id', 'outcome'],
  cancel: ['task_id', 'reason'],
  status: ['task_id'],
});

function validatePayload(
  operation: DispatchOperation,
  payload: unknown,
  issues: CommandIssue[],
): void {
  const path = '$.payload';
  if (!isPlainObject(payload)) {
    issues.push({ path, code: 'wrong_type', detail: 'payload 必须是对象' });
    return;
  }
  for (const key of PAYLOAD_STRING_FIELDS[operation]) {
    requiredString(payload, key, path, issues);
  }

  if (operation === 'plan') {
    const split = payload.split;
    if (split === undefined) {
      issues.push({ path: `${path}.split`, code: 'missing_required', detail: '缺必需字段 split' });
    } else if (!isPlainObject(split)) {
      issues.push({ path: `${path}.split`, code: 'wrong_type', detail: 'split 必须是对象' });
    } else {
      requiredString(split, 'goal', `${path}.split`, issues);
      const subtasks = split.subtasks;
      if (subtasks === undefined) {
        issues.push({ path: `${path}.split.subtasks`, code: 'missing_required', detail: '缺 subtasks' });
      } else if (!Array.isArray(subtasks)) {
        issues.push({ path: `${path}.split.subtasks`, code: 'wrong_type', detail: 'subtasks 必须是数组' });
      } else if (subtasks.length === 0) {
        issues.push({ path: `${path}.split.subtasks`, code: 'empty_array', detail: 'subtasks 不得为空' });
      }
    }
    const maxParallel = payload.max_parallel;
    if (maxParallel !== undefined) {
      if (typeof maxParallel !== 'number' || !Number.isInteger(maxParallel) || maxParallel < 1) {
        issues.push({
          path: `${path}.max_parallel`,
          code: 'invalid_value',
          detail: 'max_parallel 必须是 ≥ 1 的整数',
        });
      }
    }
  }

  if (operation === 'result') {
    const outcome = payload.outcome;
    if (outcome !== undefined && !(RESULT_OUTCOMES as readonly unknown[]).includes(outcome)) {
      issues.push({
        path: `${path}.outcome`,
        code: 'invalid_value',
        detail: `outcome 必须是 ${RESULT_OUTCOMES.join(' | ')} 之一`,
      });
    }
  }
}

/**
 * 校验一条派发命令。纯函数，逐项报问题（**不是**抛错——调用方决定是否 `assert`）。
 */
export function validateDispatchCommand(input: unknown): CommandValidation {
  const issues: CommandIssue[] = [];
  if (!isPlainObject(input)) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([{ path: '$', code: 'wrong_type' as const, detail: '命令必须是对象' }]),
    });
  }

  for (const key of COMMAND_ROOT_REQUIRED) {
    if (!(key in input)) {
      issues.push({ path: `$.${key}`, code: 'missing_required', detail: `缺必需字段 ${key}` });
    }
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_ROOT.has(key)) {
      issues.push({ path: `$.${key}`, code: 'unknown_field', detail: `未知字段 ${key}（根对象不得有多余字段）` });
    }
  }

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== COMMAND_SCHEMA_VERSION) {
    issues.push({
      path: '$.schemaVersion',
      code: 'invalid_value',
      detail: `schemaVersion 必须是 ${COMMAND_SCHEMA_VERSION}`,
    });
  }

  requiredString(input, 'commandId', '$', issues, CONTRACT_ID_MAX_LENGTH);
  requiredString(input, 'idempotencyKey', '$', issues, CONTRACT_ID_MAX_LENGTH);

  const operation = input.operation;
  if (operation === undefined) {
    // 已在上面的 required 检查里报过；不重复。
  } else if (typeof operation !== 'string' || !(DISPATCH_OPERATIONS as readonly string[]).includes(operation)) {
    issues.push({
      path: '$.operation',
      code: 'unknown_operation',
      detail: `operation 必须是 ${DISPATCH_OPERATIONS.join(' | ')} 之一`,
    });
  } else {
    validatePayload(operation as DispatchOperation, input.payload, issues);
  }

  return Object.freeze({ ok: issues.length === 0, issues: Object.freeze(issues) });
}

/** 校验失败即抛 `DispatchError('invalid_command')`（宿主缺陷要大声失败）。 */
export function assertDispatchCommand(input: unknown): void {
  const result = validateDispatchCommand(input);
  if (!result.ok) {
    const summary = result.issues.map((issue) => `${issue.path}:${issue.code}`).join(', ');
    throw new DispatchError('invalid_command', `派发命令不合法：${summary}`, 'command');
  }
}

// ---------------------------------------------------------------------------
// 契约公共命令信封投影（对外面；契约测试用冻结 schema 验证产物）
// ---------------------------------------------------------------------------

/** 一个操作是否可对外投影（契约里有对应词）。 */
export function isContractExposedOperation(operation: string): operation is DispatchOperation {
  return (CONTRACT_PUBLIC_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * 契约 payload 的最小投影：**只保留契约 `targetPayload` / query payload 认识的字段**。
 * 派发私有字段（`split` / `max_parallel` / `reason`）在契约里是 `additionalProperties:false`
 * 禁止的，故必须丢弃；`task_id` 按契约命名改投影为 `taskId`。
 */
function projectContractPayload(
  operation: DispatchOperation,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (operation) {
    case 'plan':
      return { goal: payload.goal };
    case 'cancel':
      return { taskId: payload.task_id };
    case 'status':
      return { taskId: payload.task_id };
    default:
      throw new DispatchError(
        'invalid_command',
        `操作 ${operation} 是内核内部步骤（子任务启动 / 结果回灌），不映射为对外契约命令`,
        'operation',
      );
  }
}

/**
 * 把一条**合法**的派发命令投影为契约公共命令信封（`command.schema.json` 根形状）。
 *
 * 先 `assertDispatchCommand`（不合法即抛 `invalid_command`）；`launch` / `result` 是内核内部
 * 步骤，`CONTRACT_OPERATION_HINT` 为 `null`，投影时同样抛 `invalid_command`——它们**不得**
 * 出现在对外命令面上。
 *
 * @throws {DispatchError} 命令不合法，或操作是内核内部步骤（无对外信封）。
 */
export function toContractCommand(input: unknown): ContractCommand {
  assertDispatchCommand(input);
  const command = input as {
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly operation: DispatchOperation;
    readonly payload: Record<string, unknown>;
  };
  const contractOperation = CONTRACT_OPERATION_HINT[command.operation];
  if (contractOperation === null) {
    throw new DispatchError(
      'invalid_command',
      `操作 ${command.operation} 是内核内部步骤（子任务启动 / 结果回灌），不映射为对外契约命令`,
      'operation',
    );
  }
  return Object.freeze({
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commandId: command.commandId,
    operation: contractOperation,
    idempotencyKey: command.idempotencyKey,
    payload: Object.freeze(projectContractPayload(command.operation, command.payload)),
  });
}
