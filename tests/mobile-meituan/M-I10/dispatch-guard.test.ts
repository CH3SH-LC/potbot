/**
 * M-I10 工具派发越权守卫：未知工具 / 未暴露工具 / 未声明参数 / 购买动作参数 / scope 越权
 * 一律**整调用被拒**，绝不静默丢弃。
 *
 * 负例断言的是**具体拒绝码与具体主体**，不是"抛了个错"。
 */

import { describe, expect, it } from 'vitest';

import {
  assertToolCallAllowed,
  assertToolCallAllowedForTools,
  buildDispatchRegistry,
  createFixtureFeatureHost,
  dispatchToolCall,
  NEVER_SILENTLY_DROPS_PARAMETERS,
  ToolDispatchError,
  validateToolCall,
  type DispatchErrorCode,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { fullyVerifiedMatrix, matrixFrom, ports, unverifiedMatrix } from './support.js';

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

function registryForSearchEnabled() {
  const host = createFixtureFeatureHost({
    ports: ports().ports,
    matrix: matrixFrom({ search: 'verified', address: 'verified' }),
  });
  return buildDispatchRegistry(host.tools);
}

describe('M-I10 越权守卫：未知 / 未暴露工具被拒', () => {
  it('未登记的工具 ⇒ unknown_tool', () => {
    const registry = registryForSearchEnabled();
    expectReject(
      () => assertToolCallAllowed(registry, { toolId: 'cap.meituan.evil', arguments: {} }),
      'unknown_tool',
      'cap.meituan.evil',
    );
  });

  it('已登记但未暴露的工具（scope 未核实）⇒ tool_not_exposed，而不是悄悄放行', () => {
    const host = createFixtureFeatureHost({ ports: ports().ports, matrix: unverifiedMatrix() });
    const registry = buildDispatchRegistry(host.tools);
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: 'cap.meituan.submitOrder',
          arguments: { actionId: 'a1', authorizationRef: 'gr-1', idempotencyKey: 'k1' },
        }),
      'tool_not_exposed',
      'cap.meituan.submitOrder',
    );
  });

  it('调用缺非空 toolId ⇒ invalid_call', () => {
    const registry = registryForSearchEnabled();
    expectReject(() => assertToolCallAllowed(registry, { toolId: '  ', arguments: {} }), 'invalid_call');
  });

  it('arguments 不是普通对象（数组）⇒ invalid_call', () => {
    const registry = registryForSearchEnabled();
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: 'cap.meituan.confirm',
          arguments: [] as unknown as Record<string, unknown>,
        }),
      'invalid_call',
    );
  });
});

describe('M-I10 越权守卫：购买动作参数最先被拦', () => {
  it.each(['place_order', 'place-order', 'placeOrder', 'submit_order', 'pay', 'payment'])(
    '参数名 %s ⇒ forbidden_purchase_parameter',
    (key) => {
      const registry = registryForSearchEnabled();
      expectReject(
        () =>
          assertToolCallAllowed(registry, {
            toolId: 'cap.meituan.confirm',
            arguments: { quoteRef: 'q1', paramsDigest: 'd1', [key]: true },
          }),
        'forbidden_purchase_parameter',
        key,
      );
    },
  );

  it('购买参数优先于"未声明参数"：不会先被当成 undeclared 再放行', () => {
    const registry = registryForSearchEnabled();
    const verdict = validateToolCall(registry, {
      toolId: 'cap.meituan.confirm',
      arguments: { pay: true },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('forbidden_purchase_parameter');
    }
  });
});

describe('M-I10 越权守卫：原型污染 / scope 越权 / 未声明 / 缺必填 / 类型 / enum', () => {
  it('原型污染键 ⇒ unsafe_parameter_key', () => {
    const registry = registryForSearchEnabled();
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, unknown>;
    expectReject(
      () => assertToolCallAllowed(registry, { toolId: 'cap.meituan.confirm', arguments: polluted }),
      'unsafe_parameter_key',
      '__proto__',
    );
  });

  it('scope 越权 ⇒ scope_escalation', () => {
    const registry = registryForSearchEnabled();
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: 'cap.meituan.confirm',
          arguments: { quoteRef: 'q1', paramsDigest: 'd1', scope: 'purchase' },
        }),
      'scope_escalation',
      'scope',
    );
  });

  it('未声明参数 ⇒ undeclared_parameter', () => {
    const registry = registryForSearchEnabled();
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: 'cap.meituan.confirm',
          arguments: { quoteRef: 'q1', paramsDigest: 'd1', amount: 1 },
        }),
      'undeclared_parameter',
      'amount',
    );
  });

  it('缺必填 ⇒ missing_required_parameter', () => {
    const registry = registryForSearchEnabled();
    expectReject(
      () => assertToolCallAllowed(registry, { toolId: 'cap.meituan.confirm', arguments: {} }),
      'missing_required_parameter',
    );
  });

  it('类型不符 ⇒ invalid_parameter_type', () => {
    const registry = registryForSearchEnabled();
    expectReject(
      () =>
        assertToolCallAllowed(registry, {
          toolId: 'cap.meituan.confirm',
          arguments: { quoteRef: 123, paramsDigest: 'd1' },
        }),
      'invalid_parameter_type',
      'quoteRef',
    );
  });

  it('取值不在 enumValues ⇒ enum_value_not_allowed', () => {
    const registry = registryForSearchEnabled();
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

describe('M-I10 越权守卫：放行的是原样参数，绝不静默丢弃', () => {
  it('合法调用放行，参数原样保留、droppedParameters 恒空', () => {
    const registry = registryForSearchEnabled();
    const call = assertToolCallAllowed(registry, {
      toolId: 'cap.meituan.confirm',
      arguments: { quoteRef: 'q1', paramsDigest: 'd1' },
    });
    expect(call.toolId).toBe('cap.meituan.confirm');
    expect(call.arguments).toEqual({ quoteRef: 'q1', paramsDigest: 'd1' });
    expect(call.parameterNames).toEqual(['paramsDigest', 'quoteRef']);
    expect(call.droppedParameters).toEqual([]);
    expect(Object.isFrozen(call.arguments)).toBe(true);
  });

  it('被拦的调用不会以"只剩合法参数"的形态放行', () => {
    const registry = registryForSearchEnabled();
    let released: unknown = null;
    try {
      released = assertToolCallAllowed(registry, {
        toolId: 'cap.meituan.confirm',
        arguments: { quoteRef: 'q1', paramsDigest: 'd1', place_order: true },
      });
    } catch {
      released = null;
    }
    // 越权调用要么抛错，要么（绝不该发生）原样放行——但绝不会"删掉 place_order 后放行"。
    expect(released).toBeNull();
  });

  it('字面量断言：本守卫从不静默丢弃参数', () => {
    expect(NEVER_SILENTLY_DROPS_PARAMETERS).toBe(true);
  });

  it('便利入口 assertToolCallAllowedForTools / dispatchToolCall 等价放行', () => {
    const host = createFixtureFeatureHost({
      ports: ports().ports,
      matrix: fullyVerifiedMatrix(),
    });
    const call = dispatchToolCall(host, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '上海' },
    });
    expect(call.toolId).toBe('cap.meituan.search');
    expect(
      assertToolCallAllowedForTools(host.tools, {
        toolId: 'cap.meituan.search',
        arguments: { category: '火锅', location: '上海' },
      }).arguments,
    ).toEqual(call.arguments);
  });

  it('validateToolCall 是**非抛出**形态：越权返回判定对象', () => {
    const registry = registryForSearchEnabled();
    const verdict = validateToolCall(registry, { toolId: 'cap.meituan.nope', arguments: {} });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('unknown_tool');
      expect(verdict.subject).toBe('cap.meituan.nope');
    }
  });
});
