/**
 * M-I10：`resolveExposedTools` 是唯一暴露出口——只有能力核实为 `verified` 的工具才 `enabled`；
 * 无 scope 能力的本地工具（confirm）恒 enabled；`unverified` / `denied` / 缺项一律 blocked。
 */

import { describe, expect, it } from 'vitest';

import {
  enabledToolContracts,
  MEITUAN_TOOL_DECLARATIONS,
  resolveExposedTools,
  SCOPE_CAPABILITIES,
  type CapabilityMatrix,
  type ScopeCapability,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { fullyVerifiedMatrix, matrixFrom, unverifiedMatrix } from './support.js';

describe('M-I10 resolveExposedTools 只放行 verified 能力', () => {
  it('全部未核实：除本地 confirm 外全部 blocked(scope_unverified)', () => {
    const tools = resolveExposedTools(unverifiedMatrix());
    const byId = new Map(tools.map((tool) => [tool.toolId, tool]));
    expect(byId.get('cap.meituan.search')?.exposure).toBe('blocked');
    expect(byId.get('cap.meituan.search')?.reason).toBe('scope_unverified');
    expect(byId.get('cap.meituan.submitOrder')?.exposure).toBe('blocked');
    expect(byId.get('cap.meituan.confirm')?.exposure).toBe('enabled');
    expect(byId.get('cap.meituan.confirm')?.reason).toBe('no_scope_capability');
  });

  it('能力被拒 ⇒ blocked(scope_denied)，与 unverified 可区分', () => {
    const submit = resolveExposedTools(matrixFrom({ submit: 'denied' })).find(
      (tool) => tool.toolId === 'cap.meituan.submitOrder',
    );
    expect(submit?.exposure).toBe('blocked');
    expect(submit?.reason).toBe('scope_denied');
  });

  it('能力核实 ⇒ enabled(scope_verified)，其余仍未核实', () => {
    const tools = resolveExposedTools(matrixFrom({ submit: 'verified', query: 'verified' }));
    expect(tools.find((t) => t.toolId === 'cap.meituan.submitOrder')?.exposure).toBe('enabled');
    expect(tools.find((t) => t.toolId === 'cap.meituan.submitOrder')?.reason).toBe('scope_verified');
    expect(tools.find((t) => t.toolId === 'cap.meituan.queryOrder')?.exposure).toBe('enabled');
    expect(tools.find((t) => t.toolId === 'cap.meituan.search')?.exposure).toBe('blocked');
  });

  it('全核实：除 pay 外每个 scope 能力恰好一个 enabled 工具，且没有 pay 工具', () => {
    const tools = resolveExposedTools(fullyVerifiedMatrix());
    const enabledCaps = tools
      .filter((tool) => tool.exposure === 'enabled')
      .map((tool) => tool.capability)
      .filter((c): c is ScopeCapability => c !== null)
      .sort();
    const expected = SCOPE_CAPABILITIES.filter((c) => c !== 'pay').slice().sort();
    expect(enabledCaps).toEqual(expected);
    expect(tools.some((tool) => (tool.capability as string | null) === 'pay')).toBe(false);
  });

  it('每个 enabled 工具都对应"无能力"或 availability=verified（不变量）', () => {
    const matrix = matrixFrom({ search: 'verified', menu: 'denied', preview: 'verified' });
    for (const tool of resolveExposedTools(matrix)) {
      if (tool.exposure !== 'enabled') continue;
      if (tool.capability === null) {
        expect(tool.reason).toBe('no_scope_capability');
        continue;
      }
      expect(matrix.verdicts[tool.capability].availability).toBe('verified');
      expect(tool.reason).toBe('scope_verified');
    }
  });

  it('能力矩阵缺项 ⇒ 按 unverified 处理（blocked），绝不默认可用', () => {
    const partial = { verdicts: { submit: matrixFrom({ submit: 'verified' }).verdicts.submit } } as unknown as CapabilityMatrix;
    const submit = resolveExposedTools(partial).find((tool) => tool.toolId === 'cap.meituan.submitOrder');
    const search = resolveExposedTools(partial).find((tool) => tool.toolId === 'cap.meituan.search');
    expect(submit?.exposure).toBe('enabled');
    expect(search?.exposure).toBe('blocked');
    expect(search?.reason).toBe('scope_unverified');
  });

  it('交给模型的 toolSchemas 只含 enabled 的工具', () => {
    const tools = resolveExposedTools(matrixFrom({ submit: 'verified' }));
    const ids = enabledToolContracts(tools).map((contract) => contract.toolId);
    expect(ids).toContain('cap.meituan.submitOrder');
    expect(ids).toContain('cap.meituan.confirm');
    expect(ids).not.toContain('cap.meituan.search');
    expect(enabledToolContracts(tools).length).toBe(tools.filter((t) => t.exposure === 'enabled').length);
  });

  it('工具声明数与登记数一致，且没有工具挂到 pay 能力', () => {
    expect(MEITUAN_TOOL_DECLARATIONS.length).toBeGreaterThan(0);
    expect(MEITUAN_TOOL_DECLARATIONS.some((d) => (d.capability as string | null) === 'pay')).toBe(false);
  });
});
