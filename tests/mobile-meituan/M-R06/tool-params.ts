/**
 * M-R06 —— **越权工具参数防护**（零依赖、无 IO、无时钟）。
 *
 * ## 洞：模型/编排层给出的工具参数本身就是攻击面
 *
 * 工具 schema 声明了"这个工具能收哪些参数"。但**参数来自不可信来源**
 * （模型输出，或一段被注入的商家描述诱导出的调用）。可能越权携带：
 *
 * - `{"toolId":"cap.meituan.search","arguments":{"category":"火锅","place_order":true}}`
 *   ——给只读工具塞购买动作参数；
 * - `{"toolId":"cap.meituan.search","arguments":{"scope":"purchase"}}`
 *   ——升级权限范围；
 * - `{"toolId":"cap.meituan.search","arguments":{"__proto__":{...}}}`
 *   ——原型污染；
 * - 未声明字段 `amount` / `accountRef` —— 把参数当通道传下去。
 *
 * ## 对策：**先对照 schema，再进执行器**；越权即整调用被拒
 *
 * {@link validateToolCall} 的规则（顺序即优先级，先拦危险再拦形状）：
 * 1. `toolId` 不在登记清单 ⇒ `unknown_tool`；
 * 2. 出现购买/支付类参数名 ⇒ `forbidden_purchase_parameter`（**最先**拦，因为它最危险）；
 * 3. 出现原型污染键（`__proto__`/`constructor`/`prototype`）⇒ `unsafe_parameter_key`；
 * 4. 出现 `scope` 越权 ⇒ `scope_escalation`；
 * 5. 参数名未在 schema 声明 ⇒ `undeclared_parameter`；
 * 6. 必填缺失 ⇒ `missing_required_parameter`；
 * 7. 类型不符 ⇒ `invalid_parameter_type`；
 * 8. 取值不在 enumValues ⇒ `enum_value_not_allowed`。
 *
 * 关键纪律：**越权参数不会"被静默丢弃后放行"**——整调用被拒。
 * `ValidatedToolCall.droppedParameters` 因此恒为空数组：本模块不提供"悄悄删参数"的出口，
 * 免得调用方以为过滤过了、实际放行了被篡改的意图。
 */

import { M06GuardError } from './errors.js';
import { PURCHASE_ACTION_WORDS } from './description-injection.js';
import type {
  DeclaredParameter,
  DeclaredToolSchema,
  ParameterJsonType,
  ToolCall,
  ToolCallVerdict,
  ValidatedToolCall,
} from './types.js';

/** 原型污染类危险键。 */
export const UNSAFE_PARAMETER_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

/** 越权范围词（不得作为任何读工具的参数值出现）。 */
export const FORBIDDEN_SCOPE_VALUES: readonly string[] = Object.freeze([
  'purchase',
  'pay',
  'payment',
  'place-order',
  'submit-order',
  'payment-confirm',
]);

function looksLikePurchaseKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PURCHASE_ACTION_WORDS.some((word) => {
    const needle = word.toLowerCase();
    if (lower === needle) return true;
    // 归一化下划线：placeOrder / place-order / place_order 一律命中。
    const flat = lower.replace(/[-_]/g, '');
    return flat === needle.replace(/[-_]/g, '');
  });
}

/** 判断 JS 值是否匹配声明的 JSON 类型（数组不算 number/object；整数才算 number）。 */
export function valueMatchesType(value: unknown, type: ParameterJsonType): boolean {
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
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/** 在登记清单里找 schema（未找到返回 undefined）。 */
function findSchema(
  schemas: readonly DeclaredToolSchema[],
  toolId: string,
): DeclaredToolSchema | undefined {
  return schemas.find((schema) => schema.toolId === toolId);
}

/**
 * 校验一次工具调用（**非抛出**，返回判定对象）。
 * 越权参数会导致 `ok:false`，**不会**被静默丢弃。
 */
export function validateToolCall(
  schemas: readonly DeclaredToolSchema[],
  call: ToolCall,
): ToolCallVerdict {
  if (typeof call?.toolId !== 'string' || call.toolId.trim().length === 0) {
    return reject('unknown_tool', null, '工具调用缺少非空 toolId');
  }
  const schema = findSchema(schemas, call.toolId);
  if (schema === undefined) {
    return reject('unknown_tool', call.toolId, `工具 ${call.toolId} 不在已登记工具清单内`);
  }

  const rawArgs = call.arguments;
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return reject('invalid_parameter_type', call.toolId, 'arguments 必须是普通对象');
  }
  const fields = schema.inputSchema.fields;
  const keys = Object.keys(rawArgs);

  // 1) 购买/支付类参数名 —— 最危险，最先拦。
  for (const key of keys) {
    if (looksLikePurchaseKey(key)) {
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
    if (typeof scope !== 'string' || FORBIDDEN_SCOPE_VALUES.includes(scope.toLowerCase())) {
      return reject(
        'scope_escalation',
        'scope',
        `scope=${JSON.stringify(scope)} 属于购买/支付越权范围；读工具不得升级权限`,
      );
    }
  }
  // 4) 未声明参数。
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
    if (!valueMatchesType(value, field.type)) {
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
 * 校验并**抛出**。任何越权参数 ⇒ `M06GuardError`。
 * 执行器只应接到本函数放行的 `ValidatedToolCall`。
 */
export function assertToolCallAllowed(
  schemas: readonly DeclaredToolSchema[],
  call: ToolCall,
): ValidatedToolCall {
  const verdict = validateToolCall(schemas, call);
  if (!verdict.ok) {
    throw new M06GuardError(verdict.code, verdict.detail, verdict.subject);
  }
  return verdict.call;
}

function reject(
  code: import('./errors.js').M06ErrorCode,
  subject: string | null,
  detail: string,
): ToolCallVerdict {
  return Object.freeze({ ok: false as const, code, subject, detail });
}
