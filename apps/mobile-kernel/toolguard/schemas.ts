/**
 * 操作 schema 与校验器（K-I26：由 K-R03 测试区提升为**产品模块**）——
 * 重试策略、工具执行记录的可机读形状。
 *
 * 契约风格对齐 `contracts/mobile-v1/schemas/*.schema.json`（draft 2020-12，
 * `additionalProperties: false`，未知键**拒绝而非忽略**）。这里导出的是**本模块自持**的
 * 两份 schema（不在 `contracts/` 内——那是总协调单写区），供外部 JSON-Schema 校验器复用；
 * 同时提供**零依赖**的结构校验器，避免测试引入完整 schema 引擎。
 *
 * 为什么要有校验器而不只是 schema 对象：`retryableCodes: []` 或 `maxAttempts: 0` 这类
 * "形状合法、语义致命"的输入（空重试集=永不重试、0 次尝试=永不发送），必须在构造处
 * 就红掉，而不是等到运行期"表现为不重试"被误读成"不可重试"。
 */

import type { RetryPolicy } from './retry.js';
import type { ToolExecutionRecord, ToolExecutionState } from './idempotency.js';

/** `retryPolicy` 的 JSON Schema（draft 2020-12）。 */
export const RETRY_POLICY_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'apps/mobile-kernel/toolguard/schemas/retry-policy.schema.json',
  title: 'RetryPolicy',
  description:
    '有界重试策略。retryableCodes 缺省时取内核 RETRYABLE_ERROR_CODES。空 retryableCodes 非法（等于永不重试，请用 maxAttempts:1 表达）。',
  type: 'object',
  additionalProperties: false,
  required: ['maxAttempts'],
  properties: {
    maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
    retryableCodes: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z_]*$' },
    },
    backoffMs: {
      type: 'array',
      maxItems: 9,
      items: { type: 'integer', minimum: 0 },
    },
  },
});

/** `toolExecutionRecord` 的 JSON Schema（draft 2020-12）。 */
export const TOOL_EXECUTION_RECORD_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'apps/mobile-kernel/toolguard/schemas/tool-execution-record.schema.json',
  title: 'ToolExecutionRecord',
  description: '工具动作幂等账本的一条记录。reused=true 表示执行器未被调用、结果为复用。',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'toolName', 'toolCallId', 'state', 'value', 'reused', 'error'],
  properties: {
    key: { type: 'string', minLength: 1 },
    toolName: { type: 'string', minLength: 1 },
    toolCallId: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_.:-]+$' },
    state: { enum: ['executed', 'pending', 'failed'] },
    value: {},
    reused: { type: 'boolean' },
    error: { type: ['string', 'null'] },
  },
});

const TOOL_EXECUTION_STATES: readonly ToolExecutionState[] = Object.freeze([
  'executed',
  'pending',
  'failed',
]);

const RETRY_POLICY_KEYS = ['maxAttempts', 'retryableCodes', 'backoffMs'] as const;
const RECORD_KEYS = ['key', 'toolName', 'toolCallId', 'state', 'value', 'reused', 'error'] as const;

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${what} 含未知字段 "${key}"（additionalProperties: false：拒绝而非忽略）`);
    }
  }
}

/** 校验并归一化重试策略。语义红线：`maxAttempts ∈ [1,10]`；`retryableCodes` 非空、唯一、小写。 */
export function validateRetryPolicy(input: unknown): RetryPolicy {
  const obj = asObject(input, 'retryPolicy');
  rejectUnknown(obj, RETRY_POLICY_KEYS, 'retryPolicy');

  const maxAttempts = obj['maxAttempts'];
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 10) {
    throw new RangeError(`retryPolicy.maxAttempts 必须是 1..10 的整数，收到 ${JSON.stringify(maxAttempts)}`);
  }

  let retryableCodes: readonly string[] | undefined;
  if (obj['retryableCodes'] !== undefined) {
    const raw = obj['retryableCodes'];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new TypeError('retryPolicy.retryableCodes 必须是非空数组');
    }
    const seen = new Set<string>();
    for (const code of raw) {
      if (typeof code !== 'string' || !/^[a-z][a-z_]*$/.test(code)) {
        throw new TypeError(`retryPolicy.retryableCodes 含非法码 ${JSON.stringify(code)}（须匹配 ^[a-z][a-z_]*$）`);
      }
      if (seen.has(code)) {
        throw new TypeError(`retryPolicy.retryableCodes 含重复码 "${code}"`);
      }
      seen.add(code);
    }
    retryableCodes = Object.freeze([...raw] as string[]);
  }

  let backoffMs: readonly number[] | undefined;
  if (obj['backoffMs'] !== undefined) {
    const raw = obj['backoffMs'];
    if (!Array.isArray(raw)) {
      throw new TypeError('retryPolicy.backoffMs 必须是数组');
    }
    for (const ms of raw) {
      if (!Number.isInteger(ms) || (ms as number) < 0) {
        throw new TypeError(`retryPolicy.backoffMs 必须是非负整数，收到 ${JSON.stringify(ms)}`);
      }
    }
    backoffMs = Object.freeze([...raw] as number[]);
  }

  return Object.freeze({
    maxAttempts: maxAttempts as number,
    ...(retryableCodes === undefined ? {} : { retryableCodes }),
    ...(backoffMs === undefined ? {} : { backoffMs }),
  });
}

/** 校验一条工具执行记录。`state` 必须落在三态词表；`reused` 必须是布尔。 */
export function validateToolExecutionRecord(input: unknown): ToolExecutionRecord {
  const obj = asObject(input, 'toolExecutionRecord');
  rejectUnknown(obj, RECORD_KEYS, 'toolExecutionRecord');

  const key = obj['key'];
  const toolName = obj['toolName'];
  const toolCallId = obj['toolCallId'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('toolExecutionRecord.key 必须是非空字符串');
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new TypeError('toolExecutionRecord.toolName 必须是非空字符串');
  }
  if (typeof toolCallId !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(toolCallId)) {
    throw new TypeError(`toolExecutionRecord.toolCallId 不符合 pattern ^[A-Za-z0-9_.:-]+$：${JSON.stringify(toolCallId)}`);
  }
  const state = obj['state'];
  if (typeof state !== 'string' || !(TOOL_EXECUTION_STATES as readonly string[]).includes(state)) {
    throw new TypeError(`toolExecutionRecord.state 非法：${JSON.stringify(state)}（合法：executed/pending/failed）`);
  }
  if (typeof obj['reused'] !== 'boolean') {
    throw new TypeError('toolExecutionRecord.reused 必须是布尔');
  }
  const error = obj['error'];
  if (error !== null && typeof error !== 'string') {
    throw new TypeError('toolExecutionRecord.error 必须是字符串或 null');
  }

  return Object.freeze({
    key,
    toolName,
    toolCallId,
    state: state as ToolExecutionState,
    value: obj['value'],
    reused: obj['reused'],
    error: error as string | null,
  });
}

/** schema 自洽检查：`required` 必须是 `properties` 的子集，且非空。外部可复用。 */
export function schemaRequiredIsSubsetOfProperties(schema: {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}): boolean {
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};
  return required.length > 0 && required.every((name) => Object.prototype.hasOwnProperty.call(properties, name));
}
