/**
 * K-I04 宿主装配 —— 命令载荷读取（宿主扩展槽约定）。
 *
 * ## 为什么有这一层
 *
 * K01 的形状校验（`bootstrap/validate.ts`）按 `command.schema.json` 的
 * `additionalProperties: false` **逐分支**收窄允许键：
 *
 * | 分支 | 允许键（摘） |
 * | --- | --- |
 * | create / import | `conversationId` `taskId` `goal` `templateId` `args` `patch` `content` … |
 * | mutate / apply / export / undo / redo | `conversationId` `taskId` `expectedRevision` `args` `patch` `content` |
 * | preview / inspect / query / cancel | `conversationId` `taskId` `filters` … |
 *
 * 因此宿主**不能**在 payload 顶层加自定义键（如 `op` / `split`）——会被校验器拒。
 * 契约给模块参数留的扩展槽是：
 *   - mutation / create 分支：`args`（对象）；
 *   - query 分支：`filters`（对象）。
 *
 * 宿主约定：**模块子操作名与参数放进扩展槽**（`args.op` / `filters.op` + 其余字段）。
 * 这是契约内的合法承载方式，不改契约、不绕过校验。
 *
 * 本文件只做"读 + 形状校验"，不解释业务语义；缺字段 / 类型不符 ⇒ 抛 `HOST_PAYLOAD_INVALID`。
 */

import type { Command } from '../bootstrap/index.js';
import { hostError } from './errors.js';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** query 分支的 operation（其扩展槽是 `filters`；其余分支是 `args`）。 */
const QUERY_BRANCH_OPERATIONS: ReadonlySet<string> = new Set(['preview', 'inspect', 'query', 'cancel']);

export function payloadOf(command: Command): JsonRecord {
  return isRecord(command.payload) ? command.payload : {};
}

/** 取宿主扩展槽：query 分支 → `filters`；create / import / mutation 分支 → `args`。 */
export function hostSlot(command: Command): JsonRecord {
  const payload = payloadOf(command);
  const slot = payload[QUERY_BRANCH_OPERATIONS.has(command.operation) ? 'filters' : 'args'];
  return isRecord(slot) ? slot : {};
}

/** 子操作名（扩展槽的 `op`）。缺省由各适配器自行兜底。 */
export function hostOp(slot: JsonRecord): string | undefined {
  return optionalString(slot, 'op', 'host.args');
}

export function optionalString(record: JsonRecord, key: string, context: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context}.${key} 必须是非空字符串`, key);
  }
  return value;
}

export function requireString(record: JsonRecord, key: string, context: string): string {
  const value = optionalString(record, key, context);
  if (value === undefined) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context} 缺必填字段 ${key}`, key);
  }
  return value;
}

export function optionalInteger(record: JsonRecord, key: string, context: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context}.${key} 必须是安全整数`, key);
  }
  return value;
}

export function requireInteger(record: JsonRecord, key: string, context: string): number {
  const value = optionalInteger(record, key, context);
  if (value === undefined) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context} 缺必填整数字段 ${key}`, key);
  }
  return value;
}

export function requireRecord(record: JsonRecord, key: string, context: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context} 缺对象字段 ${key}`, key);
  }
  return value;
}

export function optionalRecord(record: JsonRecord, key: string, context: string): JsonRecord | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context}.${key} 必须是对象`, key);
  }
  return value;
}

export function requireArray(record: JsonRecord, key: string, context: string): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context} 缺数组字段 ${key}`, key);
  }
  return value;
}

export function optionalArray(record: JsonRecord, key: string, context: string): readonly unknown[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw hostError('HOST_PAYLOAD_INVALID', `${context}.${key} 必须是数组`, key);
  }
  return value;
}

/** 命令顶层目标 id：targetId / id / taskId / conversationId 依序取第一个非空串。 */
export function payloadId(command: Command): string | undefined {
  const payload = payloadOf(command);
  for (const key of ['targetId', 'id', 'taskId', 'conversationId'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
