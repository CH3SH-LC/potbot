/**
 * M10 工具声明与「按实际 scope 暴露」。
 *
 * 负例断言的是**具体原因码与具体工具 ID**，不是"抛了个错"。
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoPaymentTool,
  enabledToolContracts,
  meituanToolContracts,
  MEITUAN_TOOL_DECLARATIONS,
  NO_TOOL_CAPABILITIES,
  PAYMENT_IS_NOT_A_TOOL,
  resolveExposedTools,
  validateMeituanTools,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { fullyVerifiedMatrix, matrixFrom, unverifiedMatrix } from './support.js';

describe('M10 工具声明自洽', () => {
  it('全部工具声明通过 R241 校验，且没有不可撤销副作用', () => {
    expect(validateMeituanTools()).toEqual([]);
    expect(meituanToolContracts().length).toBe(MEITUAN_TOOL_DECLARATIONS.length);
  });

  it('支付不是工具：无任何工具挂到 pay 能力，assertNoPaymentTool 通过', () => {
    expect(PAYMENT_IS_NOT_A_TOOL).toBe(true);
    expect(NO_TOOL_CAPABILITIES).toContain('pay');
    const payTools = MEITUAN_TOOL_DECLARATIONS.filter((d) => (d.capability as string | null) === 'pay');
    expect(payTools).toEqual([]);
    expect(() => assertNoPaymentTool()).not.toThrow();
  });

  it('提交/取消工具声明为 write + 需确认 + 可回读', () => {
    const submit = MEITUAN_TOOL_DECLARATIONS.find((d) => d.contract.toolId === 'cap.meituan.submitOrder');
    expect(submit?.contract.externalSideEffect).toBe('write');
    expect(submit?.contract.requiresConfirmation).toBe(true);
    expect(submit?.contract.queryable).toBe(true);
    const cancel = MEITUAN_TOOL_DECLARATIONS.find((d) => d.contract.toolId === 'cap.meituan.cancelOrder');
    expect(cancel?.contract.requiresConfirmation).toBe(true);
  });
});

describe('M10 工具按 scope 矩阵暴露（唯一出口 resolveExposedTools）', () => {
  it('全部未核实 ⇒ 除本地确认外全部 blocked(scope_unverified)', () => {
    const tools = resolveExposedTools(unverifiedMatrix());
    const byId = new Map(tools.map((tool) => [tool.toolId, tool]));
    expect(byId.get('cap.meituan.search')?.exposure).toBe('blocked');
    expect(byId.get('cap.meituan.search')?.reason).toBe('scope_unverified');
    expect(byId.get('cap.meituan.submitOrder')?.exposure).toBe('blocked');
    // 本地确认无平台 API 依赖，始终可用。
    expect(byId.get('cap.meituan.confirm')?.exposure).toBe('enabled');
    expect(byId.get('cap.meituan.confirm')?.reason).toBe('no_scope_capability');
  });

  it('能力被拒 ⇒ blocked(scope_denied)，与 unverified 可区分', () => {
    const tools = resolveExposedTools(matrixFrom({ submit: 'denied' }));
    const submit = tools.find((tool) => tool.toolId === 'cap.meituan.submitOrder');
    expect(submit?.exposure).toBe('blocked');
    expect(submit?.reason).toBe('scope_denied');
  });

  it('能力核实为 verified ⇒ 对应工具 enabled(scope_verified)', () => {
    const tools = resolveExposedTools(matrixFrom({ submit: 'verified', query: 'verified' }));
    const submit = tools.find((tool) => tool.toolId === 'cap.meituan.submitOrder');
    expect(submit?.exposure).toBe('enabled');
    expect(submit?.reason).toBe('scope_verified');
    const search = tools.find((tool) => tool.toolId === 'cap.meituan.search');
    expect(search?.exposure).toBe('blocked'); // 未在 overrides 里 ⇒ 仍 unverified
  });

  it('交给模型的 toolSchemas 只含 enabled 的工具', () => {
    const tools = resolveExposedTools(matrixFrom({ submit: 'verified' }));
    const enabled = enabledToolContracts(tools);
    const ids = enabled.map((contract) => contract.toolId);
    expect(ids).toContain('cap.meituan.submitOrder');
    expect(ids).not.toContain('cap.meituan.search'); // 仍未核实
    expect(ids).toContain('cap.meituan.confirm'); // 本地动作始终在
  });

  it('全核实矩阵下，每个 scope 能力都有且仅有一个 enabled 工具', () => {
    const tools = resolveExposedTools(fullyVerifiedMatrix());
    const enabled = tools.filter((tool) => tool.exposure === 'enabled');
    const capabilities = enabled.map((tool) => tool.capability).filter((c): c is NonNullable<typeof c> => c !== null);
    expect([...capabilities].sort()).toEqual(
      ['address', 'cancel', 'menu', 'preview', 'query', 'search', 'submit'].sort(),
    );
  });
});
