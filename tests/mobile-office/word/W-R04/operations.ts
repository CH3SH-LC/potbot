/**
 * **W-R04 — 输入/无障碍/定位操作的 schema 与校验。**
 *
 * 对齐总方案 §5 的命令与事件契约：每个命令信封含
 * `schemaVersion, commandId, operation, idempotencyKey, payload`。
 * 本节提供：
 *
 * - 本包**操作名**的封闭集合与每个操作的 payload 字段规约（`OP_PAYLOAD_SPEC`）；
 * - `validateOperation(unknown)` 做结构校验，返回**结构化 issue 列表**（不是布尔）；
 * - 事件信封类型（`OperationEvent`）与其状态词表。
 *
 * 校验是**纯函数**、不触碰文档、不联网。它只判"信封与 payload 形状是否合法"，
 * 不判业务语义（如范围是否越界由 `ime-bridge.ts`/内核负责）——分层清晰，避免这里
 * 变成第二个真相源。
 */

/** 本包 schema 版本。与会话级合同版本分开演进（新增可选字段不升主版本）。 */
export const WORD_INPUT_SCHEMA_VERSION = 'word-input-v1';

/** 本包支持的操作名（封闭集合）。 */
export type OperationName =
  | 'word.ime.beginComposition'
  | 'word.ime.setComposingText'
  | 'word.ime.setCompositionRegion'
  | 'word.ime.commitText'
  | 'word.ime.finishComposingText'
  | 'word.ime.deleteSurroundingText'
  | 'word.selection.set'
  | 'word.a11y.moveSelection'
  | 'word.a11y.setSelection'
  | 'word.target.hitTest';

export const OPERATION_NAMES: readonly OperationName[] = [
  'word.ime.beginComposition',
  'word.ime.setComposingText',
  'word.ime.setCompositionRegion',
  'word.ime.commitText',
  'word.ime.finishComposingText',
  'word.ime.deleteSurroundingText',
  'word.selection.set',
  'word.a11y.moveSelection',
  'word.a11y.setSelection',
  'word.target.hitTest',
];

type FieldType = 'string' | 'number' | 'boolean';

/** 每个操作的 payload 必填字段与类型。`*Utf16`/`*Dp` 额外要求有限数值。 */
export const OP_PAYLOAD_SPEC: Readonly<Record<OperationName, Readonly<Record<string, FieldType>>>> = {
  'word.ime.beginComposition': { nodeId: 'string', caretUtf16: 'number' },
  'word.ime.setComposingText': { nodeId: 'string', text: 'string' },
  'word.ime.setCompositionRegion': { nodeId: 'string', startUtf16: 'number', endUtf16: 'number' },
  'word.ime.commitText': { nodeId: 'string', text: 'string' },
  'word.ime.finishComposingText': { nodeId: 'string' },
  'word.ime.deleteSurroundingText': { nodeId: 'string', beforeLength: 'number', afterLength: 'number' },
  'word.selection.set': { nodeId: 'string', startUtf16: 'number', endUtf16: 'number' },
  'word.a11y.moveSelection': { nodeId: 'string', granularity: 'string', direction: 'string', extend: 'boolean' },
  'word.a11y.setSelection': { nodeId: 'string', startUtf16: 'number', endUtf16: 'number' },
  'word.target.hitTest': { nodeId: 'string', xDp: 'number', yDp: 'number' },
};

/** 数值字段中必须是**非负整数**的那些（码元偏移 / 长度）。 */
const NON_NEGATIVE_INTEGER_FIELDS: ReadonlySet<string> = new Set([
  'caretUtf16',
  'startUtf16',
  'endUtf16',
  'beforeLength',
  'afterLength',
]);

/** 命令信封。 */
export interface OperationEnvelope {
  readonly schemaVersion: string;
  readonly commandId: string;
  readonly operation: OperationName;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly SchemaIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 校验命令信封与 payload 形状。返回全部 issue（不短路），便于一次性反馈给调用方。
 * 不校验业务语义。
 */
export function validateOperation(input: unknown): ValidationResult {
  const issues: SchemaIssue[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path: '', message: '命令必须是对象。' }] };
  }

  if (input.schemaVersion !== WORD_INPUT_SCHEMA_VERSION) {
    issues.push({
      path: 'schemaVersion',
      message: `schemaVersion 必须为 "${WORD_INPUT_SCHEMA_VERSION}"，收到 ${JSON.stringify(input.schemaVersion)}。`,
    });
  }
  if (!isNonEmptyString(input.commandId)) {
    issues.push({ path: 'commandId', message: 'commandId 必须是非空字符串。' });
  }
  if (!isNonEmptyString(input.idempotencyKey)) {
    issues.push({ path: 'idempotencyKey', message: 'idempotencyKey 必须是非空字符串。' });
  }

  const operation = input.operation;
  if (typeof operation !== 'string' || !(OPERATION_NAMES as readonly string[]).includes(operation)) {
    issues.push({ path: 'operation', message: `未知操作名：${JSON.stringify(operation)}。` });
    // 无法继续校验 payload（没有规约）。
    return { ok: issues.length === 0, issues };
  }

  if (!isPlainObject(input.payload)) {
    issues.push({ path: 'payload', message: 'payload 必须是对象。' });
    return { ok: false, issues };
  }

  const spec = OP_PAYLOAD_SPEC[operation as OperationName];
  for (const [field, type] of Object.entries(spec)) {
    const value = input.payload[field];
    if (value === undefined) {
      issues.push({ path: `payload.${field}`, message: `缺少必填字段 ${field}。` });
      continue;
    }
    if (typeof value !== type) {
      issues.push({ path: `payload.${field}`, message: `字段 ${field} 应为 ${type}，收到 ${typeof value}。` });
      continue;
    }
    if (NON_NEGATIVE_INTEGER_FIELDS.has(field) && (!Number.isInteger(value) || (value as number) < 0)) {
      issues.push({ path: `payload.${field}`, message: `字段 ${field} 应为非负整数，收到 ${String(value)}。` });
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/** 事件状态词表（对齐 §5 事件结构）。 */
export type EventStatus = 'ok' | 'conflict' | 'cancelled' | 'failed';

export interface OperationError {
  readonly code: string;
  readonly message: string;
}

export interface OperationEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly commandId: string;
  readonly revision: number;
  readonly status: EventStatus;
  readonly resultRef?: string;
  readonly error?: OperationError;
}

/** 校验事件信封形状：失败事件必须带 error；成功事件不得带 error。 */
export function validateEvent(input: unknown): ValidationResult {
  const issues: SchemaIssue[] = [];
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: '', message: '事件必须是对象。' }] };
  if (!isNonEmptyString(input.eventId)) issues.push({ path: 'eventId', message: 'eventId 必须是非空字符串。' });
  if (!Number.isInteger(input.seq) || (input.seq as number) < 0) issues.push({ path: 'seq', message: 'seq 必须是非负整数。' });
  if (!isNonEmptyString(input.commandId)) issues.push({ path: 'commandId', message: 'commandId 必须是非空字符串。' });
  if (!Number.isInteger(input.revision) || (input.revision as number) < 0) {
    issues.push({ path: 'revision', message: 'revision 必须是非负整数。' });
  }
  const statuses: readonly string[] = ['ok', 'conflict', 'cancelled', 'failed'];
  if (typeof input.status !== 'string' || !statuses.includes(input.status)) {
    issues.push({ path: 'status', message: `status 必须是 ${statuses.join('/')} 之一。` });
  }
  if (input.status === 'failed' && !isPlainObject(input.error)) {
    issues.push({ path: 'error', message: 'failed 事件必须带 error 对象。' });
  }
  if (input.status === 'ok' && input.error !== undefined) {
    issues.push({ path: 'error', message: 'ok 事件不得带 error。' });
  }
  return { ok: issues.length === 0, issues };
}
