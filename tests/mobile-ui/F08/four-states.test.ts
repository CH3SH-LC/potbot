/**
 * F08 / 四态独立：installed / enabled / authorized / portReady 是四个独立布尔，
 * 互不合并（design-07 行 157 / 206；契约 `probe` 的同形）。
 *
 * 反向对照：任何把四态压成一个字段的尝试都必须被本层断言或契约校验器拒绝。
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoCollapsedReady,
  authorizeTemplate,
  catalogRows,
  createTemplatesState,
  deriveBlockers,
  deriveReadiness,
  disableTemplate,
  enableTemplate,
  getTemplate,
  installTemplate,
  recordProbe,
  toProbe,
} from '../../../apps/mobile-ui/src/templates/index.js';
import { fixtureState } from './fixtures.js';

function rowOf(state: ReturnType<typeof fixtureState>, id: string) {
  const row = catalogRows(state).find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`目录行缺失：${id}`);
  return row;
}

describe('F08 / 四态独立', () => {
  it('四态可以两两分裂：同一模板出现「已安装/已启用/已授权但端口未就绪」', () => {
    const row = rowOf(fixtureState(), 'template.spreadsheet');
    expect(row.readiness).toEqual({
      installed: true,
      enabled: true,
      authorized: true,
      portReady: false,
    });
  });

  it('反向分裂：「端口就绪但未授权」与「已安装/已启用/已授权但未就绪」并存', () => {
    const state = fixtureState();
    // 演示：已安装、已启用、端口就绪，但未授权。
    expect(rowOf(state, 'template.presentation').readiness).toEqual({
      installed: true,
      enabled: true,
      authorized: false,
      portReady: true,
    });
    // 美团：前三真、端口假。
    expect(rowOf(state, 'template.meituan').readiness).toEqual({
      installed: true,
      enabled: true,
      authorized: true,
      portReady: false,
    });
  });

  it('portReady 独立于安装态：未安装也可以端口就绪（日历）', () => {
    const row = rowOf(fixtureState(), 'template.calendar');
    expect(row.readiness.installed).toBe(false);
    expect(row.readiness.portReady).toBe(true);
  });

  it('未安装的模板即使内部 enabled 位被置位也不会报告 enabled（无幽灵启用）', () => {
    const lifecycle = { ...getTemplate(createTemplatesState(), 'template.clock'), enabled: true };
    expect(deriveReadiness(lifecycle)).toEqual({
      installed: false,
      enabled: false,
      authorized: false,
      portReady: false,
    });
  });

  it('未安装时启用被拒（invalid-transition），不静默置位', () => {
    const state = createTemplatesState();
    try {
      enableTemplate(state, 'template.clock');
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid-transition');
    }
  });

  it('已安装未启用时给出 disabled 阻断；停用后 enabled 掉回 false，其余态不变', () => {
    let state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
    state = authorizeTemplate(state, 'template.document', ['storage', 'file-write', 'model']);
    state = enableTemplate(state, 'template.document');
    expect(rowOf(state, 'template.document').readiness.enabled).toBe(true);

    state = disableTemplate(state, 'template.document');
    const row = rowOf(state, 'template.document');
    expect(row.readiness.enabled).toBe(false);
    // 安装与授权不受停用影响。
    expect(row.readiness.installed).toBe(true);
    expect(row.readiness.authorized).toBe(true);
    expect(row.blockers.some((blocker) => blocker.code === 'disabled')).toBe(true);
  });

  it('probe 只有契约四态字段，本地断言拒绝任何合并就绪字段', () => {
    const probe = toProbe(getTemplate(fixtureState(), 'template.document'));
    expect(Object.keys(probe).sort()).toEqual(
      ['authorized', 'checkedAt', 'enabled', 'installed', 'layers', 'portReady', 'verificationMode'].sort(),
    );
    // 反向对照：塞入合并字段必须被本地断言拒绝。
    const polluted = { ...probe, ready: true } as unknown as typeof probe;
    expect(() => assertNoCollapsedReady(polluted)).toThrowError(/非契约字段/);
  });

  it('blockers 在任一维未就绪时必非空，且每条都带可操作 remedy', () => {
    const state = fixtureState();
    for (const row of catalogRows(state)) {
      const visible = row.blockers;
      const allReady =
        row.readiness.installed &&
        row.readiness.enabled &&
        row.readiness.authorized &&
        row.readiness.portReady;
      if (!allReady) {
        expect(visible.length).toBeGreaterThan(0);
      }
      for (const blocker of visible) {
        expect(blocker.remedy.length).toBeGreaterThan(0);
        expect(['info', 'warn', 'error']).toContain(blocker.severity);
      }
    }
    // 文档模板四态全绿 ⇒ 无阻断。
    expect(rowOf(state, 'template.document').blockers).toEqual([]);
  });

  it('未安装模板的阻断在安装后消失（not-installed → 更具体的状态）', () => {
    let state = createTemplatesState();
    expect(deriveBlockers(getTemplate(state, 'template.clock')).some((b) => b.code === 'not-installed')).toBe(true);
    state = installTemplate(state, 'template.clock', '1.0.0');
    expect(deriveBlockers(getTemplate(state, 'template.clock')).some((b) => b.code === 'not-installed')).toBe(false);
  });

  it('portReady=true 时探针拒绝携带未就绪原因（不自相矛盾）', () => {
    const state = createTemplatesState();
    try {
      recordProbe(state, 'template.clock', { portReady: true, portReason: '不该出现' });
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid-transition');
    }
  });
});
