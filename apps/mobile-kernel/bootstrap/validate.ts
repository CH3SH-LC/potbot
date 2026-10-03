/**
 * K01 —— `command` 形状校验（`contracts/mobile-v1/schemas/command.schema.json` 的
 * 零依赖子集实现）。
 *
 * 为什么不直接跑 `contracts/mobile-v1/validate.mjs`：那是 CLI，读文件系统，手机内运行时
 * 不方便；且桥的入口接收的是**未信任的 JS 对象**，需要在**进程内**快速拒绝。这里实现的是
 * 同一形状的可判定子集，并**只覆盖 command**（event 由本层生成，天然满足）。
 *
 * 覆盖的分支规则（与 schema 逐条对应）：
 *   - 公共必需：`schemaVersion=const "mobile-v1"` / `commandId` / `operation` / `idempotencyKey` / `payload`；
 *   - `create|import`：目标 id/revision 可缺省，**不要求** expectedRevision；
 *   - `mutate|apply|export|undo|redo`：**必须**有 `expectedRevision`，且 **必须**有
 *     `conversationId` 或 `taskId`；
 *   - `preview|inspect|query|cancel`：**必须**有 `conversationId` 或 `taskId`；
 *   - payload 的 `additionalProperties:false`：按分支给出允许键集合，出现未知键即报错。
 *
 * 已知局限（如实声明）：不校验 `metadata` 的深层语义；数字判断把 `1.0` 视作整数
 * （与契约校验器的子集口径一致）。
 */

import type { CommandOperation } from '../../../contracts/mobile-v1/types.js';
import type { BootstrapIssue } from './errors.js';

export interface CommandValidation {
  readonly ok: boolean;
  readonly issues: readonly BootstrapIssue[];
}

export const COMMAND_OPERATIONS: readonly CommandOperation[] = [
  'create',
  'import',
  'mutate',
  'apply',
  'export',
  'undo',
  'redo',
  'preview',
  'inspect',
  'query',
  'cancel',
];

export const CREATE_OPERATIONS: readonly CommandOperation[] = ['create', 'import'];
export const MUTATION_OPERATIONS: readonly CommandOperation[] = ['mutate', 'apply', 'export', 'undo', 'redo'];
export const QUERY_OPERATIONS: readonly CommandOperation[] = ['preview', 'inspect', 'query', 'cancel'];

const COMMON_KEYS: readonly string[] = ['schemaVersion', 'commandId', 'operation', 'idempotencyKey', 'payload', 'metadata'];

const CREATE_PAYLOAD_KEYS: readonly string[] = [
  'conversationId',
  'taskId',
  'targetId',
  'id',
  'revision',
  'expectedRevision',
  'goal',
  'templateId',
  'roleHint',
  'content',
  'patch',
  'args',
  'filters',
];

const MUTATION_PAYLOAD_KEYS: readonly string[] = [
  'conversationId',
  'taskId',
  'targetId',
  'id',
  'revision',
  'expectedRevision',
  'patch',
  'args',
  'content',
];

const QUERY_PAYLOAD_KEYS: readonly string[] = [
  'conversationId',
  'taskId',
  'targetId',
  'id',
  'revision',
  'expectedRevision',
  'filters',
];

const ID_MAX = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= ID_MAX;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function branchOf(operation: CommandOperation): 'create' | 'mutation' | 'query' {
  if (CREATE_OPERATIONS.includes(operation)) return 'create';
  if (MUTATION_OPERATIONS.includes(operation)) return 'mutation';
  return 'query';
}

function allowedPayloadKeys(branch: 'create' | 'mutation' | 'query'): readonly string[] {
  if (branch === 'create') return CREATE_PAYLOAD_KEYS;
  if (branch === 'mutation') return MUTATION_PAYLOAD_KEYS;
  return QUERY_PAYLOAD_KEYS;
}

/** 校验一条命令。返回问题清单；`ok === issues.length === 0`。 */
export function validateCommand(input: unknown): CommandValidation {
  const issues: BootstrapIssue[] = [];
  const push = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(input)) {
    push('$', 'NOT_AN_OBJECT', '命令必须是对象');
    return { ok: false, issues };
  }

  for (const key of Object.keys(input)) {
    if (!COMMON_KEYS.includes(key)) push(key, 'UNKNOWN_KEY', `command 不接受额外字段 ${key}`);
  }

  if (input.schemaVersion !== 'mobile-v1') {
    push('schemaVersion', 'NOT_MOBILE_V1', 'schemaVersion 必须为 "mobile-v1"');
  }
  if (!isId(input.commandId)) push('commandId', 'INVALID_ID', 'commandId 必须是 1..128 的字符串');
  if (!isId(input.idempotencyKey)) push('idempotencyKey', 'INVALID_ID', 'idempotencyKey 必须是 1..128 的字符串');
  if (input.metadata !== undefined && !isRecord(input.metadata)) push('metadata', 'NOT_AN_OBJECT', 'metadata 必须是对象');

  if (typeof input.operation !== 'string' || !COMMAND_OPERATIONS.includes(input.operation as CommandOperation)) {
    push('operation', 'UNKNOWN_OPERATION', `operation 必须是 ${COMMAND_OPERATIONS.join(' | ')} 之一`);
  }

  if (!isRecord(input.payload)) {
    push('payload', 'NOT_AN_OBJECT', 'payload 必须是对象');
    return { ok: issues.length === 0, issues };
  }

  const payload = input.payload;
  const operation = input.operation as CommandOperation | undefined;
  if (operation === undefined || !COMMAND_OPERATIONS.includes(operation)) {
    return { ok: false, issues };
  }
  const branch = branchOf(operation);

  for (const key of Object.keys(payload)) {
    if (!allowedPayloadKeys(branch).includes(key)) {
      push(`payload.${key}`, 'UNKNOWN_KEY', `payload 在 ${operation} 分支不接受字段 ${key}`);
    }
  }

  // 类型：有则必须合法。
  for (const key of ['conversationId', 'taskId', 'targetId', 'id'] as const) {
    if (payload[key] !== undefined && !isId(payload[key])) {
      push(`payload.${key}`, 'INVALID_ID', `${key} 必须是 1..128 的字符串`);
    }
  }
  for (const key of ['revision', 'expectedRevision'] as const) {
    if (payload[key] !== undefined && !isRevision(payload[key])) {
      push(`payload.${key}`, 'NOT_AN_INTEGER', `${key} 必须是 >=0 的整数`);
    }
  }

  if (branch === 'mutation') {
    if (payload.expectedRevision === undefined) {
      push('payload.expectedRevision', 'MISSING', `${operation} 必须携带 expectedRevision`);
    }
    if (payload.conversationId === undefined && payload.taskId === undefined) {
      push('payload', 'MISSING_TARGET', `${operation} 必须携带 conversationId 或 taskId`);
    }
    if (payload.patch !== undefined && !isRecord(payload.patch)) push('payload.patch', 'NOT_AN_OBJECT', 'patch 必须是对象');
    if (payload.args !== undefined && !isRecord(payload.args)) push('payload.args', 'NOT_AN_OBJECT', 'args 必须是对象');
  }

  if (branch === 'query') {
    if (payload.conversationId === undefined && payload.taskId === undefined) {
      push('payload', 'MISSING_TARGET', `${operation} 必须携带 conversationId 或 taskId`);
    }
    if (payload.filters !== undefined && !isRecord(payload.filters)) push('payload.filters', 'NOT_AN_OBJECT', 'filters 必须是对象');
  }

  if (branch === 'create') {
    if (payload.goal !== undefined && !(typeof payload.goal === 'string' && payload.goal.length >= 1)) {
      push('payload.goal', 'INVALID_STRING', 'goal 必须是非空字符串');
    }
    if (payload.patch !== undefined && !isRecord(payload.patch)) push('payload.patch', 'NOT_AN_OBJECT', 'patch 必须是对象');
    if (payload.args !== undefined && !isRecord(payload.args)) push('payload.args', 'NOT_AN_OBJECT', 'args 必须是对象');
    if (payload.filters !== undefined && !isRecord(payload.filters)) push('payload.filters', 'NOT_AN_OBJECT', 'filters 必须是对象');
  }

  return { ok: issues.length === 0, issues };
}
