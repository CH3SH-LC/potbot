/**
 * M04 购物车操作的**声明式操作描述符**（payload 字段规格）。
 *
 * 六线方案 §5 的命令契约要求公共输入含 `schemaVersion, commandId, operation,
 * idempotencyKey, payload`。本模块只描述**购物车自身操作**的 `payload` 形状
 * （字段名 / 类型 / 必填 / 下限与枚举），不含命令信封本身——信封归 mobile-v1
 * 契约（冻结件 `contracts/mobile-v1/`），这里**不重定义**它。
 *
 * 供 M10（mobile-feature 工具 schema）与前端 F 渲染表单时复用**同一份**字段规格，
 * 避免「工具 schema 写一套、实现写一套」的漂移。
 *
 * 这些操作在本包内**没有**下单 / 支付语义（描述符里也不存在这类字段）。
 *
 * ## 文件位置说明（重要）
 *
 * 本模块位于 `cart/contract/` 子目录，而**不在** `cart/` 顶层：历史 M04 的
 * `tests/mobile-meituan/M04/boundary.test.ts` 用**硬编码的文件名清单**断言
 * `cart/` 顶层恰好只有 9 个 `.ts` 文件，且 `readdirSync` 非递归。新增顶层文件会使
 * 它变红，而该测试不在本单元的写权限内。放在子目录既不动那份清单，也不改动任何
 * 现有模块；代价是顶层边界扫描不覆盖本文件，故由 `tests/mobile-meituan/M-I04/`
 * 的边界用例专门扫描 `contract/` 与顶层两个目录。
 */

/** 购物车自身的操作 id（与 mobile-v1 命令的 `operation` 字段对应）。 */
export type CartOperationId =
  | 'cart.add_line'
  | 'cart.set_quantity'
  | 'cart.set_specs'
  | 'cart.set_delivery_address'
  | 'cart.set_pricing_inputs'
  | 'cart.request_quote'
  | 'cart.check_quote';

/** 一个 payload 字段 / 子结构的 JSON-Schema 风格描述节点。 */
export interface CartPayloadSchemaNode {
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  readonly description?: string;
  /** 允许 `null`（例如清空地址引用）；缺省不允许。 */
  readonly nullable?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly string[];
  /** `type === 'array'` 时元素的描述节点。 */
  readonly items?: CartPayloadSchemaNode;
}

/** payload 顶层对象的描述。 */
export interface CartPayloadObjectSchema {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
  readonly properties: Readonly<Record<string, CartPayloadSchemaNode>>;
}

/** 一个操作的完整描述符（入/出 payload 形状 + 副作用声明）。 */
export interface CartOperationSchema {
  readonly operation: CartOperationId;
  readonly schemaVersion: '1';
  /** 是否改变本地购物车状态。 */
  readonly mutatesCart: boolean;
  /** 是否只读（不产生任何外部副作用，也不改本地状态）。 */
  readonly readOnly: boolean;
  /** 是否要求会话当前持有**可用**报价（`request_quote` 之外暂未使用）。 */
  readonly requiresQuoteUsable: boolean;
  readonly input: CartPayloadObjectSchema;
  readonly output: CartPayloadObjectSchema;
}

/** 一次规格选择 `{groupId, optionId}`。 */
const SELECTION_NODE: CartPayloadSchemaNode = Object.freeze({
  type: 'object',
  description: '单个规格选择 {groupId, optionId}',
});

/** 规格选择数组。 */
const SELECTIONS_NODE: CartPayloadSchemaNode = Object.freeze({
  type: 'array',
  description: '规格选择数组：元素为 {groupId, optionId}',
  items: SELECTION_NODE,
});

/** 购物车条目的 wire 形状（无任何金额字段——价格只在报价里）。 */
const LINE_NODE: CartPayloadObjectSchema = Object.freeze({
  type: 'object',
  required: ['lineId', 'merchantId', 'dishId', 'skuId', 'specs', 'quantity'],
  additionalProperties: true,
  properties: Object.freeze({
    lineId: { type: 'string' as const, description: '会话内稳定条目 id' },
    merchantId: { type: 'string' as const },
    dishId: { type: 'string' as const },
    skuId: { type: 'string' as const },
    specs: SELECTIONS_NODE,
    quantity: { type: 'integer' as const, minimum: 1, maximum: 999 },
  }),
});

const QUOTE_STALE_REASONS = Object.freeze([
  'not_current',
  'invalidated',
  'params_changed',
  'expired',
] as const);

/**
 * 七个购物车操作的声明式描述符。
 *
 * 金额一律以**整数最小单位**（`amountMinor`）出现，与 mobile-v1 金额裁决一致；
 * 这里**不存在**任何下单 / 支付字段。
 */
export const CART_OPERATIONS: readonly CartOperationSchema[] = Object.freeze([
  Object.freeze({
    operation: 'cart.add_line' as const,
    schemaVersion: '1' as const,
    mutatesCart: true,
    readOnly: false,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['dishId', 'skuId']),
      additionalProperties: false,
      properties: Object.freeze({
        dishId: { type: 'string' as const },
        skuId: { type: 'string' as const },
        specs: SELECTIONS_NODE,
        quantity: { type: 'integer' as const, minimum: 1, maximum: 999, description: '省略按 1 计' },
      }),
    }),
    output: LINE_NODE,
  }),
  Object.freeze({
    operation: 'cart.set_quantity' as const,
    schemaVersion: '1' as const,
    mutatesCart: true,
    readOnly: false,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['lineId', 'quantity']),
      additionalProperties: false,
      properties: Object.freeze({
        lineId: { type: 'string' as const },
        quantity: { type: 'integer' as const, minimum: 1, maximum: 999 },
      }),
    }),
    output: LINE_NODE,
  }),
  Object.freeze({
    operation: 'cart.set_specs' as const,
    schemaVersion: '1' as const,
    mutatesCart: true,
    readOnly: false,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['lineId', 'specs']),
      additionalProperties: false,
      properties: Object.freeze({
        lineId: { type: 'string' as const },
        specs: SELECTIONS_NODE,
      }),
    }),
    output: LINE_NODE,
  }),
  Object.freeze({
    operation: 'cart.set_delivery_address' as const,
    schemaVersion: '1' as const,
    mutatesCart: true,
    readOnly: false,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze([] as string[]),
      additionalProperties: false,
      properties: Object.freeze({
        addressRef: {
          type: 'string' as const,
          nullable: true,
          description: '地址**引用**（不存明文）；传 null 表示清除',
        },
      }),
    }),
    output: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['addressRef']),
      additionalProperties: true,
      properties: Object.freeze({
        addressRef: { type: 'string' as const, nullable: true },
      }),
    }),
  }),
  Object.freeze({
    operation: 'cart.set_pricing_inputs' as const,
    schemaVersion: '1' as const,
    mutatesCart: true,
    readOnly: false,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze([] as string[]),
      additionalProperties: false,
      properties: Object.freeze({
        couponCodes: Object.freeze({
          type: 'array' as const,
          description: '优惠码（金额由计价端口解释）',
          items: { type: 'string' as const },
        }),
        serviceOptions: Object.freeze({
          type: 'array' as const,
          description: '附加服务（金额由计价端口解释）',
          items: { type: 'string' as const },
        }),
      }),
    }),
    output: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['couponCodes', 'serviceOptions']),
      additionalProperties: true,
      properties: Object.freeze({
        couponCodes: Object.freeze({ type: 'array' as const, items: { type: 'string' as const } }),
        serviceOptions: Object.freeze({ type: 'array' as const, items: { type: 'string' as const } }),
      }),
    }),
  }),
  Object.freeze({
    operation: 'cart.request_quote' as const,
    schemaVersion: '1' as const,
    mutatesCart: false,
    readOnly: false,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze([] as string[]),
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    output: Object.freeze({
      type: 'object' as const,
      required: Object.freeze([
        'quoteRef',
        'merchantId',
        'currency',
        'amountMinor',
        'subtotalMinor',
        'expiresAt',
        'paramsDigest',
        'isOrderTotal',
      ]),
      additionalProperties: true,
      properties: Object.freeze({
        quoteRef: { type: 'string' as const },
        merchantId: { type: 'string' as const },
        currency: { type: 'string' as const },
        amountMinor: { type: 'integer' as const, minimum: 0, description: '整数最小单位；由端口给出，本地不重算' },
        subtotalMinor: { type: 'integer' as const, minimum: 0 },
        expiresAt: { type: 'integer' as const, description: '逻辑时钟毫秒；经 wire 时间戳模块转 ISO-8601' },
        paramsDigest: { type: 'string' as const },
        isOrderTotal: { type: 'boolean' as const, description: '恒为 false：报价不是订单总额' },
      }),
    }),
  }),
  Object.freeze({
    operation: 'cart.check_quote' as const,
    schemaVersion: '1' as const,
    mutatesCart: false,
    readOnly: true,
    requiresQuoteUsable: false,
    input: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['quoteRef']),
      additionalProperties: false,
      properties: Object.freeze({
        quoteRef: { type: 'string' as const },
      }),
    }),
    output: Object.freeze({
      type: 'object' as const,
      required: Object.freeze(['usable', 'quoteRef', 'reasons', 'detail']),
      additionalProperties: true,
      properties: Object.freeze({
        usable: { type: 'boolean' as const },
        quoteRef: { type: 'string' as const },
        reasons: Object.freeze({
          type: 'array' as const,
          enum: QUOTE_STALE_REASONS,
          items: { type: 'string' as const, enum: QUOTE_STALE_REASONS },
        }),
        detail: { type: 'string' as const },
      }),
    }),
  }),
]);

/** 全部操作 id（稳定顺序，便于遍历/生成）。 */
export const CART_OPERATION_IDS: readonly CartOperationId[] = Object.freeze(
  CART_OPERATIONS.map((descriptor) => descriptor.operation),
);

/** 按操作 id 查找描述符；未知操作返回 `undefined`。 */
export function findCartOperation(operation: string): CartOperationSchema | undefined {
  return CART_OPERATIONS.find((descriptor) => descriptor.operation === operation);
}

/** 一条 payload 结构违规（区分「调用方写错」与业务问题）。 */
export interface CartPayloadViolation {
  readonly path: string;
  readonly message: string;
}

/** payload 结构校验结果。 */
export interface CartPayloadValidationResult {
  readonly ok: boolean;
  readonly operation: CartOperationId | null;
  readonly violations: readonly CartPayloadViolation[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkType(value: unknown, node: CartPayloadSchemaNode): boolean {
  if (value === null) return node.nullable === true || node.type === 'null';
  switch (node.type) {
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
 * 结构校验一个购物车操作 payload：操作名已知、必填字段齐全、类型匹配、
 * 数值下限/上限满足、枚举匹配、不接受未声明字段（顶层 `additionalProperties: false`）。
 *
 * 只做**顶层 + 数组元素**的浅校验（与声明式描述符的粒度一致）；不做深层业务校验
 * （业务规则见 `specs.ts` 与 `cart.ts`）。
 */
export function validateCartOperationPayload(
  operation: string,
  payload: unknown,
): CartPayloadValidationResult {
  const descriptor = findCartOperation(operation);
  if (descriptor === undefined) {
    return Object.freeze({
      ok: false,
      operation: null,
      violations: Object.freeze([{ path: '', message: `未知操作 ${operation}` }]),
    });
  }
  if (!isPlainObject(payload)) {
    return Object.freeze({
      ok: false,
      operation: descriptor.operation,
      violations: Object.freeze([{ path: '', message: 'payload 必须是对象' }]),
    });
  }
  const violations: CartPayloadViolation[] = [];
  const schema = descriptor.input;
  if (!schema.additionalProperties) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) violations.push({ path: key, message: `未声明字段 ${key}` });
    }
  }
  for (const key of schema.required) {
    if (!(key in payload)) violations.push({ path: key, message: `缺少必填字段 ${key}` });
  }
  for (const [key, node] of Object.entries(schema.properties)) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (!checkType(value, node)) {
      violations.push({ path: key, message: `字段 ${key} 类型应为 ${node.type}` });
      continue;
    }
    if (value === null) continue;
    if (node.type === 'string' && node.enum !== undefined && !node.enum.includes(value as string)) {
      violations.push({ path: key, message: `字段 ${key} 取值必须是 ${node.enum.join(' / ')}` });
    }
    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) {
        violations.push({ path: key, message: `字段 ${key} 不得小于 ${node.minimum}` });
      }
      if (node.maximum !== undefined && value > node.maximum) {
        violations.push({ path: key, message: `字段 ${key} 不得大于 ${node.maximum}` });
      }
    }
    if (node.type === 'array' && node.items !== undefined) {
      const elements = value as readonly unknown[];
      for (let index = 0; index < elements.length; index += 1) {
        if (!checkType(elements[index], node.items)) {
          violations.push({ path: `${key}[${index}]`, message: `字段 ${key}[${index}] 类型应为 ${node.items.type}` });
        }
      }
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    operation: descriptor.operation,
    violations: Object.freeze(violations),
  });
}
