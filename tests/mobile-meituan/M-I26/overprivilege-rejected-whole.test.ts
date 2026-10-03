/**
 * M-I26 / 越权面 —— **M10 工具派发的越权/伪造调用被整调用拒绝**（不静默丢弃）。
 *
 * 覆盖工作书点名的四类攻击参数，并额外覆盖"未暴露工具"（scope 越权）与"未声明参数"：
 * 未知工具 / 购买动作参数 / `__proto__` 原型污染键 / `scope` 越权 /
 * 未声明字段 / 未暴露的写工具。
 *
 * 关键纪律：被拦的是**整调用**——`validateToolCall` 的 `ok:false` 分支里没有 `call`，
 * 调用方拿不到"只剩合法参数"的放行结果。放行的调用参数原样保留、`droppedParameters` 恒空。
 */

import { describe, expect, it } from 'vitest';

import {
  NEVER_SILENTLY_DROPS_PARAMETERS,
  ToolDispatchError,
  assertToolCallAllowed,
  validateToolCall,
  type DispatchErrorCode,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import {
  ACTION_ID,
  IDEMPOTENCY_KEY,
  SEARCH_TOOL,
  SUBMIT_TOOL,
  purchaseRegistry,
  unverifiedRegistry,
} from './support.js';

function expectReject(
  fn: () => unknown,
  code: DispatchErrorCode,
  subject?: string,
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolDispatchError);
    expect((error as ToolDispatchError).code).toBe(code);
    if (subject !== undefined) {
      expect((error as ToolDispatchError).subject).toBe(subject);
    }
    return;
  }
  throw new Error(`期望拒绝码 ${code}，但没有抛错`);
}

const registry = purchaseRegistry();

describe('未知 / 未暴露工具被拒（不转发给执行器）', () => {
  it('未登记的工具 ⇒ unknown_tool', () => {
    expectReject(
      () => assertToolCallAllowed(registry, { toolId: 'cap.meituan.forged', arguments: {} }),
      'unknown_tool',
      'cap.meituan.forged',
    );
  });

  it('已登记但 scope 未核实 ⇒ tool_not_exposed（不是悄悄放行）', () => {
    expectReject(
      () =>
        assertToolCallAllowed(unverifiedRegistry(), {
          toolId: SUBMIT_TOOL,
          arguments: { actionId: ACTION_ID, authorizationRef: 'g-1', idempotencyKey: IDEMPOTENCY_KEY },
        }),
      'tool_not_exposed',
      SUBMIT_TOOL,
    );
  });

  it('缺非空 toolId / arguments 非普通对象 ⇒ invalid_call', () => {
    expectReject(() => assertToolCallAllowed(registry, { toolId: '  ', arguments: {} }), 'invalid_call');
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: SEARCH_TOOL,
          arguments: [] as unknown as Record<string, unknown>,
        }),
      'invalid_call',
    );
  });
});

describe('购买动作参数最先被拦（读工具不得携带购买语义）', () => {
  it.each(['place_order', 'place-order', 'placeOrder', 'submit_order', 'pay', 'payment', '下单', '支付'])(
    '搜索工具携带购买参数 %s ⇒ forbidden_purchase_parameter',
    (key) => {
      expectReject(
        () =>
          assertToolCallAllowed(registry, {
            toolId: SEARCH_TOOL,
            arguments: { category: '火锅', location: '徐汇', [key]: true },
          }),
        'forbidden_purchase_parameter',
        key,
      );
    },
  );

  it('提交工具携带额外的购买参数 pay ⇒ forbidden_purchase_parameter（先于 schema 形状）', () => {
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: SUBMIT_TOOL,
          arguments: {
            actionId: ACTION_ID,
            authorizationRef: 'g-1',
            idempotencyKey: IDEMPOTENCY_KEY,
            pay: true,
          },
        }),
      'forbidden_purchase_parameter',
      'pay',
    );
  });
});

describe('原型污染 / scope 越权 / 未声明 / 类型 / enum', () => {
  it('原型污染键 __proto__ ⇒ unsafe_parameter_key', () => {
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, unknown>;
    expectReject(
      () => assertToolCallAllowed(registry, { toolId: SEARCH_TOOL, arguments: polluted }),
      'unsafe_parameter_key',
      '__proto__',
    );
  });

  it('scope 越权 ⇒ scope_escalation', () => {
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: SEARCH_TOOL,
          arguments: { category: '火锅', location: '徐汇', scope: 'purchase' },
        }),
      'scope_escalation',
      'scope',
    );
  });

  it('scope 传非字符串 ⇒ scope_escalation（读工具不得升级权限）', () => {
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: SEARCH_TOOL,
          arguments: { category: '火锅', location: '徐汇', scope: 7 },
        }),
      'scope_escalation',
      'scope',
    );
  });

  it('未声明字段 amount ⇒ undeclared_parameter', () => {
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: SUBMIT_TOOL,
          arguments: {
            actionId: ACTION_ID,
            authorizationRef: 'g-1',
            idempotencyKey: IDEMPOTENCY_KEY,
            amount: 1,
          },
        }),
      'undeclared_parameter',
      'amount',
    );
  });

  it('类型不符 ⇒ invalid_parameter_type', () => {
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: SEARCH_TOOL,
          arguments: { category: 123, location: '徐汇' },
        }),
      'invalid_parameter_type',
      'category',
    );
  });

  it('取值不在 enumValues ⇒ enum_value_not_allowed', () => {
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: 'cap.meituan.address',
          arguments: { resolutionMode: 'admin_override' },
        }),
      'enum_value_not_allowed',
      'resolutionMode',
    );
  });
});

describe('整调用被拒：没有"静默丢弃后放行"的出口', () => {
  it('ok:false 判定对象里没有 call / droppedParameters', () => {
    const verdict = validateToolCall(registry, {
      toolId: SEARCH_TOOL,
      arguments: { category: '火锅', location: '徐汇', place_order: true },
    });
    expect(verdict.ok).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(verdict, 'call')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(verdict, 'droppedParameters')).toBe(false);
  });

  it('越权调用不会以"只剩合法参数"的形态放行', () => {
    let released: unknown = null;
    try {
      released = assertToolCallAllowed(registry, {
        toolId: SEARCH_TOOL,
        arguments: { category: '火锅', location: '徐汇', pay: true },
      });
    } catch {
      released = null;
    }
    expect(released).toBeNull();
  });

  it('字面量断言：守卫从不静默丢弃参数', () => {
    expect(NEVER_SILENTLY_DROPS_PARAMETERS).toBe(true);
  });
});

describe('正例对照：合法调用原样放行（负例非空真）', () => {
  it('合法 submitOrder 调用放行，参数原样、droppedParameters 为空', () => {
    const call = assertToolCallAllowed(registry, {
      toolId: SUBMIT_TOOL,
      arguments: { actionId: ACTION_ID, authorizationRef: 'g-1', idempotencyKey: IDEMPOTENCY_KEY },
    });
    expect(call.toolId).toBe(SUBMIT_TOOL);
    expect(call.arguments).toEqual({
      actionId: ACTION_ID,
      authorizationRef: 'g-1',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(call.parameterNames).toEqual(['actionId', 'authorizationRef', 'idempotencyKey']);
    expect(call.droppedParameters).toEqual([]);
    expect(Object.isFrozen(call.arguments)).toBe(true);
  });
});
