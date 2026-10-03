/**
 * M10 工具派发 —— **越权工具参数防护**（把 M-R06 请求 #3 落成 M10 的派发出口）。
 *
 * ## 洞：模型给出的工具参数本身就是攻击面
 *
 * `resolveExposedTools` 决定了"交给模型哪些工具"，但真正执行前，**参数来自模型输出**
 * （或一段被注入的商家描述诱导出的调用），可能越权携带：
 *
 * - `{"toolId":"cap.meituan.search","arguments":{"category":"火锅","place_order":true}}`
 *   ——给只读工具塞购买动作参数；
 * - `{"toolId":"cap.meituan.search","arguments":{"scope":"purchase"}}`
 *   ——升级权限范围；
 * - `{"toolId":"cap.meituan.search","arguments":{"__proto__":{...}}}`
 *   ——原型污染；
 * - 未声明字段 `amount` / `accountRef` —— 把参数当通道偷偷传下去；
 * - `{"toolId":"cap.meituan.submitOrder",...}` 而 submit 能力在矩阵里还是 `unverified`
 *   ——调用一个**没有被暴露**的工具（scope 越权）。
 *
 * ## 对策：先对照 schema，再进执行器；越权即**整调用被拒**，不静默丢弃
 *
 * {@link assertToolCallAllowed} 是**唯一**的派发入口。规则（顺序即优先级）：
 * 1. 调用缺非空 `toolId` / `arguments` 不是普通对象 ⇒ `invalid_call`；
 * 2. `toolId` 不在登记清单 ⇒ `unknown_tool`；
 * 3. 工具已登记但**未暴露**（`exposure !== 'enabled'`，即 scope 未核实/被拒）
 *    ⇒ `tool_not_exposed`——**调用被拒**，不是"过滤掉再放行"；
 * 4. 出现购买/支付类参数名（`place_order` / `submit_order` / `pay` …）⇒
 *    `forbidden_purchase_parameter`（最先拦，因为它最危险）；
 * 5. 出现原型污染键（`__proto__`/`constructor`/`prototype`）⇒ `unsafe_parameter_key`；
 * 6. 出现 `scope` 越权 ⇒ `scope_escalation`；
 * 7. 参数名未在 schema 声明 ⇒ `undeclared_parameter`；
 * 8. 必填缺失 ⇒ `missing_required_parameter`；
 * 9. 类型不符 ⇒ `invalid_parameter_type`；
 * 10. 取值不在 `enumValues` ⇒ `enum_value_not_allowed`。
 *
 * **关键纪律**：本模块**不提供**"把越权参数悄悄删掉再放行"的出口。
 * `ValidatedToolCall.droppedParameters` 因此恒为空数组——放过的一定是**原样**参数，
 * 被拦的整调用被拒。
 *
 * ## 为什么在 M10 里自带一份，而不是 import M-R06 的文件
 *
 * M-R06 的 `assertToolCallAllowed` 目前位于 `tests/mobile-meituan/M-R06/`（测试树）。
 * `tsconfig.demo.json` 的 `include` 是 `["apps/demo","src"]`——**不含 tests**；若 `src/**`
 * 反向 import 测试树，`tsc -p tsconfig.demo.json`（Demo 构建）会因找不到模块而失败。
 * 因此这里按同一纪律在 `src` 内实现一份**结构等价**的守卫（同样的规则顺序与拒绝码口径），
 * 待 M-R06 的模块被提升进 `src/`（该移动在 M10 写区之外）后，可只在 {@link buildDispatchRegistry}
 * 处替换为 import，调用点不变。
 */

import type { JsonType } from '../../../adapters/clock/action-contract.js';
import type { ExposedTool, ScopeCapability } from './types.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const DISPATCH_ERROR_CODES = [
  'invalid_call',
  'unknown_tool',
  'tool_not_exposed',
  'forbidden_purchase_parameter',
  'unsafe_parameter_key',
  'scope_escalation',
  'undeclared_parameter',
  'missing_required_parameter',
  'invalid_parameter_type',
  'enum_value_not_allowed',
] as const;
export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[number];

export class ToolDispatchError extends Error {
  readonly code: DispatchErrorCode;
  readonly subject: string | null;
  constructor(code: DispatchErrorCode, message: string, subject: string | null = null) {
    super(message);
    this.name = 'ToolDispatchError';
    this.code = code;
    this.subject = subject;
  }
}

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

/** 原型污染类危险键。 */
export const UNSAFE_PARAMETER_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * 购买/支付类参数名（归一化下划线/连字符后比较，故 `place_order`/`place-order`/`placeOrder`
 * 一律命中）。工作书 M-R06 请求 #3 点名的三类是 `place_order` / `submit_order` / `pay`。
 */
export const FORBIDDEN_PURCHASE_PARAMETERS: readonly string[] = Object.freeze([
  'place_order',
  'submit_order',
  'placeOrder',
  'submitOrder',
  'pay',
  'payNow',
  'payment',
  'checkout',
  'purchase',
  '购买',
  '支付',
  '付款',
  '下单',
  '代付',
]);

/** 越权范围词（读工具不得借 `scope` 参数升级权限）。 */
export const FORBIDDEN_SCOPE_VALUES: readonly string[] = Object.freeze([
  'purchase',
  'pay',
  'payment',
  'place-order',
  'place_order',
  'submit-order',
  'submit_order',
  'payment-confirm',
  'checkout',
  'purchase_order',
  '支付',
  '下单',
]);

/** 归一化参数名 / scope 值：小写并去掉连字符、下划线、空白。 */
export function normalizeDispatchToken(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, '');
}

const PURCHASE_SET = new Set(FORBIDDEN_PURCHASE_PARAMETERS.map(normalizeDispatchToken));
const SCOPE_SET = new Set(FORBIDDEN_SCOPE_VALUES.map(normalizeDispatchToken));

/** 参数名是否是购买/支付类越权参数名。 */
export function isForbiddenPurchaseParameter(key: string): boolean {
  return PURCHASE_SET.has(normalizeDispatchToken(key));
}

// ---------------------------------------------------------------------------
// 派发登记表
// ---------------------------------------------------------------------------

/** 声明式参数（结构兼容 `ToolContract.inputSchema.fields[name]`）。 */
export interface DeclaredParameter {
  readonly type: JsonType;
  readonly required: boolean;
  readonly enumValues?: readonly string[];
}

/**
 * 派发登记项：工具 ID + 暴露结论 + 其输入 schema。
 *
 * **同时登记 enabled 与 blocked 的工具**——这样守卫才能区分"未登记工具"
 * （`unknown_tool`）与"已登记但未暴露的工具"（`tool_not_exposed`），
 * 四种越权原因可机读区分，不会混成一个笼统的失败。
 */
export interface DispatchToolSchema {
  readonly toolId: string;
  readonly exposure: 'enabled' | 'blocked';
  readonly capability: ScopeCapability | null;
  readonly fields: Readonly<Record<string, DeclaredParameter>>;
}

/** 一次待执行的工具调用（参数来自模型 / 模型编排层，**不可信**）。 */
export interface ToolCall {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 守卫放行的调用：参数已冻结、只含声明过的字段。 */
export interface ValidatedToolCall {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** 实际携带的参数名（已排序，便于断言）。 */
  readonly parameterNames: readonly string[];
  /** 恒为空数组：未声明参数**不会被静默丢弃**，而是整调用被拒。 */
  readonly droppedParameters: readonly [];
}

export type ToolCallVerdict =
  | { readonly ok: true; readonly call: ValidatedToolCall }
  | { readonly ok: false; readonly code: DispatchErrorCode; readonly subject: string | null; readonly detail: string };

/** 从暴露结论构造派发登记表（唯一入口）。 */
export function buildDispatchRegistry(tools: readonly ExposedTool[]): readonly DispatchToolSchema[] {
  return Object.freeze(
    tools.map((tool) => {
      const fields: Record<string, DeclaredParameter> = {};
      for (const [name, field] of Object.entries(tool.contract.inputSchema.fields)) {
        fields[name] = Object.freeze(
          field.enumValues === undefined
            ? { type: field.type, required: field.required }
            : { type: field.type, required: field.required, enumValues: field.enumValues },
        );
      }
      return Object.freeze({
        toolId: tool.toolId,
        exposure: tool.exposure,
        capability: tool.capability,
        fields: Object.freeze(fields),
      });
    }),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断 JS 值是否匹配声明的 JSON 类型（整数/有限数才算 number；数组不算 object）。 */
export function valueMatchesDeclaredType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function reject(code: DispatchErrorCode, subject: string | null, detail: string): ToolCallVerdict {
  return Object.freeze({ ok: false as const, code, subject, detail });
}

/**
 * 校验一次工具调用（**不抛出**，返回判定对象）。越权参数导致 `ok:false`，
 * **不会**被静默丢弃。
 */
export function validateToolCall(
  registry: readonly DispatchToolSchema[],
  call: ToolCall,
): ToolCallVerdict {
  if (!isPlainObject(call) || typeof call.toolId !== 'string' || call.toolId.trim().length === 0) {
    return reject('invalid_call', null, '工具调用必须是带非空 toolId 的对象');
  }
  const schema = registry.find((entry) => entry.toolId === call.toolId);
  if (schema === undefined) {
    return reject('unknown_tool', call.toolId, `工具 ${call.toolId} 不在已登记清单内：不得调用未声明的工具`);
  }
  if (schema.exposure !== 'enabled') {
    return reject(
      'tool_not_exposed',
      call.toolId,
      `工具 ${call.toolId} 未暴露（能力 ${schema.capability ?? '(无)'} 未核实/被拒）：不得调用未经 scope 放行的工具`,
    );
  }

  const rawArgs = call.arguments;
  if (!isPlainObject(rawArgs)) {
    return reject('invalid_call', call.toolId, 'arguments 必须是普通对象（不接受数组 / null / 非对象）');
  }
  const fields = schema.fields;
  const keys = Object.keys(rawArgs);

  // 1) 购买/支付类参数名 —— 最危险，最先拦。
  for (const key of keys) {
    if (isForbiddenPurchaseParameter(key)) {
      return reject(
        'forbidden_purchase_parameter',
        key,
        `工具 ${call.toolId} 不得携带购买动作参数 ${key}：购买/支付不属于本工具的能力范围`,
      );
    }
  }
  // 2) 原型污染键。
  for (const key of keys) {
    if (UNSAFE_PARAMETER_KEYS.includes(key)) {
      return reject('unsafe_parameter_key', key, `参数名 ${key} 是原型污染类危险键`);
    }
  }
  // 3) scope 越权。
  if ('scope' in rawArgs) {
    const scope = rawArgs['scope'];
    if (typeof scope !== 'string' || SCOPE_SET.has(normalizeDispatchToken(scope))) {
      return reject(
        'scope_escalation',
        'scope',
        `scope=${JSON.stringify(scope)} 属于购买/支付越权范围；读工具不得升级权限`,
      );
    }
  }
  // 4) 未声明参数 —— 整调用被拒，**不静默丢弃**。
  for (const key of keys) {
    if (!(key in fields)) {
      return reject('undeclared_parameter', key, `参数 ${key} 未在工具 ${call.toolId} 的 schema 中声明`);
    }
  }
  // 5) 必填缺失。
  for (const [name, field] of Object.entries(fields)) {
    if (field.required && !(name in rawArgs)) {
      return reject('missing_required_parameter', name, `工具 ${call.toolId} 必填参数 ${name} 缺失`);
    }
  }
  // 6) 类型 / enum。
  for (const key of keys) {
    const field = fields[key] as DeclaredParameter;
    const value = rawArgs[key];
    if (!valueMatchesDeclaredType(value, field.type)) {
      return reject(
        'invalid_parameter_type',
        key,
        `参数 ${key} 声明为 ${field.type}，收到 ${Array.isArray(value) ? 'array' : typeof value}`,
      );
    }
    if (field.enumValues !== undefined && typeof value === 'string' && !field.enumValues.includes(value)) {
      return reject(
        'enum_value_not_allowed',
        key,
        `参数 ${key}=${value} 不在允许集合 [${field.enumValues.join(' | ')}]`,
      );
    }
  }

  const validated: ValidatedToolCall = Object.freeze({
    toolId: call.toolId,
    arguments: Object.freeze({ ...rawArgs }),
    parameterNames: Object.freeze(keys.slice().sort()),
    droppedParameters: Object.freeze([]) as readonly [],
  });
  return Object.freeze({ ok: true as const, call: validated });
}

/**
 * 校验并**抛出**。任何越权 ⇒ {@link ToolDispatchError}。
 * 执行器只应接到本函数放行的 {@link ValidatedToolCall}。
 *
 * 这是 M10 的**唯一**派发入口（对应 M-R06 请求 #3 的 `assertToolCallAllowed(schemas, call)`）。
 */
export function assertToolCallAllowed(
  registry: readonly DispatchToolSchema[],
  call: ToolCall,
): ValidatedToolCall {
  const verdict = validateToolCall(registry, call);
  if (!verdict.ok) {
    throw new ToolDispatchError(verdict.code, verdict.detail, verdict.subject);
  }
  return verdict.call;
}

/** 便利重载：直接以"已暴露工具列表"为登记表（内部构造登记表后调用守卫）。 */
export function assertToolCallAllowedForTools(
  tools: readonly ExposedTool[],
  call: ToolCall,
): ValidatedToolCall {
  return assertToolCallAllowed(buildDispatchRegistry(tools), call);
}

/** 便利入口：把模型工具调用路由过守卫（宿主 / 任何带 `tools` 的对象）。 */
export function dispatchToolCall(
  source: { readonly tools: readonly ExposedTool[] },
  call: ToolCall,
): ValidatedToolCall {
  return assertToolCallAllowedForTools(source.tools, call);
}

/** 字面量断言：本守卫**从不**静默丢弃参数（被拦的整调用被拒，放过的原样保留）。 */
export const NEVER_SILENTLY_DROPS_PARAMETERS: true = true;
