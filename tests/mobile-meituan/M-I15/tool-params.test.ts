/**
 * M-I15 / 越权工具参数 —— 生产副本的集成验收。
 *
 * 用**真实** `MEITUAN_TOOLS` 作为 schema 来源（仓库里 `src/adapters/meituan/contract.ts`
 * 的 `cap.meituan.search/detail/handoff`）。
 *
 * 断言点：合法调用放行；越权参数（未声明字段 / 购买动作 / scope / 原型污染 / 类型 /
 * enum）一律**整调用被拒**，且**没有被静默丢弃的参数**（`droppedParameters` 恒为空）。
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_SCOPE_VALUES,
  UNSAFE_PARAMETER_KEYS,
  M06GuardError,
  assertToolCallAllowed,
  isM06GuardError,
  validateToolCall,
  valueMatchesType,
} from '../../../src/mobile-plugins/meituan/injection-guard/index.js';
import type { DeclaredToolSchema } from '../../../src/mobile-plugins/meituan/injection-guard/index.js';
import { REAL_MEITUAN_SCHEMAS } from './support.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (isM06GuardError(error)) return error.code;
  }
  return undefined;
}

describe('合法调用放行', () => {
  it('search：真实 schema 下合法参数通过', () => {
    const call = assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', people: 2, budgetYuan: 100 },
    });
    expect(call.toolId).toBe('cap.meituan.search');
    expect(call.parameterNames).toEqual(['budgetYuan', 'category', 'location', 'people']);
    // 没有被静默丢弃的参数。
    expect(call.droppedParameters).toEqual([]);
    expect(call.droppedParameters).toHaveLength(0);
  });

  it('handoff：required 参数齐全即通过', () => {
    const call = assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.handoff',
      arguments: { candidateId: 'cand-1', selectionRevision: 3 },
    });
    expect(call.parameterNames).toEqual(['candidateId', 'selectionRevision']);
  });

  it('参数对象被冻结', () => {
    const call = assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.detail',
      arguments: { candidateId: 'cand-1' },
    });
    expect(Object.isFrozen(call.arguments)).toBe(true);
  });
});

describe('越权/非法调用被整调用拒绝', () => {
  it('未知工具', () => {
    expect(
      codeOf(() => assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, { toolId: 'cap.meituan.pay', arguments: {} })),
    ).toBe('unknown_tool');
  });

  it('未声明参数（越界字段）：整调用被拒，不静默丢弃', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', coupon: 'X' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('undeclared_parameter');
      expect(v.subject).toBe('coupon');
    }
    // 拒绝路径**不产出** ValidatedToolCall，因此不存在「丢掉了 coupon 却放行」的形状。
    expect(v.ok).toBe(false);
  });

  it('购买动作参数 place_order', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', place_order: true },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('forbidden_purchase_parameter');
  });

  it('购买动作参数 submit_order（伪 JSON 注入的常见形状）', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', submit_order: { amount: 1 } },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('forbidden_purchase_parameter');
  });

  it('camelCase 变体 placeOrder 同样被拦（归一化下划线/连字符）', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', placeOrder: true },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('forbidden_purchase_parameter');
  });

  it('购买词 pay 单独出现也拦', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.detail',
      arguments: { candidateId: 'c1', pay: 1 },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('forbidden_purchase_parameter');
  });

  it('scope 越权（purchase）', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', scope: 'purchase' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('scope_escalation');
      expect(v.subject).toBe('scope');
    }
  });

  it('scope 为合法但越权范围 submit-order 也被拦', () => {
    expect(FORBIDDEN_SCOPE_VALUES).toContain('submit-order');
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', scope: 'submit-order' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('scope_escalation');
  });

  it('原型污染键 __proto__ 被拦（JSON.parse 造出 own property）', () => {
    const polluted = JSON.parse('{"category":"火锅","location":"徐汇","__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    expect(Object.keys(polluted)).toContain('__proto__');
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, { toolId: 'cap.meituan.search', arguments: polluted });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('unsafe_parameter_key');
    expect(UNSAFE_PARAMETER_KEYS).toContain('__proto__');
  });

  it('必填缺失', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('missing_required_parameter');
      expect(v.subject).toBe('location');
    }
  });

  it('类型不符', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: 123, location: '徐汇' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('invalid_parameter_type');
      expect(v.subject).toBe('category');
    }
  });

  it('arguments 不是普通对象', () => {
    expect(
      codeOf(() =>
        assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, {
          toolId: 'cap.meituan.detail',
          arguments: [] as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe('invalid_parameter_type');
  });
});

describe('enum 取值校验（用带 enumValues 的本地 schema 驱动）', () => {
  const schemaWithEnum: DeclaredToolSchema = {
    toolId: 'cap.meituan.search',
    inputSchema: {
      fields: {
        category: { type: 'string', required: true, enumValues: ['火锅', '烧烤'] },
      },
    },
  };

  it('合法取值通过', () => {
    const v = validateToolCall([schemaWithEnum], { toolId: 'cap.meituan.search', arguments: { category: '火锅' } });
    expect(v.ok).toBe(true);
  });

  it('越界取值被拒', () => {
    const v = validateToolCall([schemaWithEnum], { toolId: 'cap.meituan.search', arguments: { category: '牛排' } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('enum_value_not_allowed');
  });
});

describe('valueMatchesType 边界', () => {
  it('数组不算 object / number', () => {
    expect(valueMatchesType([], 'object')).toBe(false);
    expect(valueMatchesType([], 'number')).toBe(false);
    expect(valueMatchesType([], 'array')).toBe(true);
  });
  it('NaN / Infinity 不算 number', () => {
    expect(valueMatchesType(Number.NaN, 'number')).toBe(false);
    expect(valueMatchesType(Number.POSITIVE_INFINITY, 'number')).toBe(false);
  });
});

describe('硬拒抛 M06GuardError', () => {
  it('抛出的错误类型与 code 稳定', () => {
    let caught: unknown;
    try {
      assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, {
        toolId: 'cap.meituan.search',
        arguments: { category: '火锅', location: '徐汇', pay: 1 },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(M06GuardError);
    expect((caught as M06GuardError).code).toBe('forbidden_purchase_parameter');
  });
});
