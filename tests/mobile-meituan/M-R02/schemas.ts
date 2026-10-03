/**
 * M-R02 —— 操作 schema / 类型描述符。
 *
 * 六线方案 §5 的命令与事件契约要求：公共输入含 `schemaVersion, commandId, operation,
 * idempotencyKey, payload`。本包提供两个**只读校验类操作**的 payload schema
 * （JSON-Schema 风格描述符 + 本地结构校验器），供 M03/M04/M06 接线时复用同一形状。
 *
 * 这两个操作都**只读、不提交、不支付**；schema 里也不存在任何下单/支付字段。
 */

export type CatalogOperationId = 'catalog.validate-line' | 'cart.preflight-merchant';

/** 一个操作描述符：入/出 payload 的形状 + 必填字段。 */
export interface OperationSchema {
  readonly operation: CatalogOperationId;
  readonly schemaVersion: '1';
  /** 只读操作：不产生任何外部副作用。 */
  readonly readOnly: true;
  readonly input: JsonSchemaObject;
  readonly output: JsonSchemaObject;
}

interface JsonSchemaObject {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly additionalProperties: boolean;
}

interface JsonSchemaNode {
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  readonly description?: string;
  readonly items?: JsonSchemaNode;
  readonly minimum?: number;
  readonly enum?: readonly string[];
}

const SELECTION_NODE: JsonSchemaNode = {
  type: 'array',
  description: '规格选择：每个元素是 {groupId, optionId}',
  items: {
    type: 'object',
    description: '单个规格选择',
  },
};

const ISSUE_NODE: JsonSchemaNode = {
  type: 'array',
  description: '问题列表：元素含 code/message（及可选 limit/actual）',
  items: { type: 'object' },
};

export const CATALOG_OPERATIONS: readonly OperationSchema[] = Object.freeze([
  Object.freeze({
    operation: 'catalog.validate-line' as const,
    schemaVersion: '1' as const,
    readOnly: true as const,
    input: {
      type: 'object' as const,
      required: ['merchantId', 'dishId', 'skuId', 'selections', 'quantity'],
      additionalProperties: false,
      properties: {
        merchantId: { type: 'string' as const },
        dishId: { type: 'string' as const },
        skuId: { type: 'string' as const },
        selections: SELECTION_NODE,
        quantity: { type: 'integer' as const, minimum: 1 },
      },
    },
    output: {
      type: 'object' as const,
      required: ['ok', 'issues', 'availableQuantity', 'maxAddableQuantity'],
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' as const },
        issues: ISSUE_NODE,
        availableQuantity: { type: 'null' as const, description: 'null = 不限量' },
        maxAddableQuantity: { type: 'null' as const, description: 'null = 无已知上限' },
      },
    },
  }),
  Object.freeze({
    operation: 'cart.preflight-merchant' as const,
    schemaVersion: '1' as const,
    readOnly: true as const,
    input: {
      type: 'object' as const,
      required: ['merchantId', 'subtotalMinor', 'currency', 'distanceMeters'],
      additionalProperties: false,
      properties: {
        merchantId: { type: 'string' as const },
        subtotalMinor: { type: 'integer' as const, minimum: 0 },
        currency: { type: 'string' as const },
        distanceMeters: { type: 'number' as const, minimum: 0 },
      },
    },
    output: {
      type: 'object' as const,
      required: ['ok', 'issues', 'shortfallMinor', 'inRange'],
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' as const },
        issues: ISSUE_NODE,
        shortfallMinor: { type: 'integer' as const, minimum: 0 },
        inRange: { type: 'boolean' as const },
      },
    },
  }),
]);

/** 一条结构违规（与业务问题码分开，便于区分「调用方写错」与「用户需满足的条件」）。 */
export interface SchemaViolation {
  readonly path: string;
  readonly message: string;
}

/** schema 结构校验结果。 */
export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly operation: CatalogOperationId | null;
  readonly violations: readonly SchemaViolation[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkType(value: unknown, type: JsonSchemaNode['type']): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/**
 * 结构校验一个操作 payload：操作名已知、必填字段齐全、类型匹配、数值下限满足、
 * 不接受未声明字段（`additionalProperties: false`）。
 */
export function validateOperationPayload(operation: string, payload: unknown): SchemaValidationResult {
  const descriptors = CATALOG_OPERATIONS.filter((entry) => entry.operation === operation);
  const descriptor = descriptors[0];
  if (descriptor === undefined) {
    return Object.freeze({
      ok: false,
      operation: null,
      violations: Object.freeze([{ path: '', message: `未知操作 ${operation}` }]),
    });
  }
  const violations: SchemaViolation[] = [];
  if (!isPlainObject(payload)) {
    return Object.freeze({
      ok: false,
      operation: descriptor.operation,
      violations: Object.freeze([{ path: '', message: 'payload 必须是对象' }]),
    });
  }
  const allowed = new Set(Object.keys(descriptor.input.properties));
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      violations.push({ path: key, message: `未声明字段 ${key}` });
    }
  }
  for (const key of descriptor.input.required) {
    if (!(key in payload)) {
      violations.push({ path: key, message: `缺少必填字段 ${key}` });
    }
  }
  for (const [key, node] of Object.entries(descriptor.input.properties)) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (!checkType(value, node.type)) {
      violations.push({ path: key, message: `字段 ${key} 类型应为 ${node.type}` });
      continue;
    }
    if (node.minimum !== undefined && typeof value === 'number' && value < node.minimum) {
      violations.push({ path: key, message: `字段 ${key} 不得小于 ${node.minimum}` });
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    operation: descriptor.operation,
    violations: Object.freeze(violations),
  });
}
