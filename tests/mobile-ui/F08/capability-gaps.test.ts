/**
 * F08 / 能力不足可见：缺权限或运行时不支持的能力必须逐条列出并给原因
 * （design-07 行 157「缺失项有可操作原因」）。
 */

import { describe, expect, it } from 'vitest';

import {
  authorizeTemplate,
  capabilityGaps,
  catalogRows,
  createTemplatesState,
  getTemplate,
  getTemplateDefinition,
  installTemplate,
  recordProbe,
  revokePermission,
  templateDetail,
} from '../../../apps/mobile-ui/src/templates/index.js';

function row(id: string, state: ReturnType<typeof createTemplatesState>) {
  const found = catalogRows(state).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`目录行缺失：${id}`);
  return found;
}

describe('F08 / 能力不足可见', () => {
  it('已安装但零授权：所有依赖权限的能力都进缺口，并标明缺少的权限', () => {
    const state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
    const gaps = row('template.document', state).capabilityGaps;
    // 文档模板：create 依赖 model，edit/export 依赖 file-write，import 依赖 storage。
    expect(gaps.map((gap) => gap.capabilityId).sort()).toEqual(
      ['cap.doc.create', 'cap.doc.edit', 'cap.doc.export', 'cap.doc.import'].sort(),
    );
    for (const gap of gaps) {
      expect(gap.reason).toMatch(/缺少权限/);
      expect(gap.label.length).toBeGreaterThan(0);
    }
  });

  it('补齐授权后对应能力缺口消失（能力可见性随授权实时变化）', () => {
    let state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
    state = authorizeTemplate(state, 'template.document', ['storage', 'file-write', 'model']);
    expect(row('template.document', state).capabilityGaps).toEqual([]);
  });

  it('运行时不支持的能力即使已授权也列为缺口，原因是「运行时不支持」', () => {
    let state = installTemplate(createTemplatesState(), 'template.meituan', '1.0.0');
    state = authorizeTemplate(state, 'template.meituan', ['network', 'model', 'external-order']);
    state = recordProbe(state, 'template.meituan', {
      portReady: false,
      portReason: '美团接口未接通',
      unsupportedCapabilities: ['cap.meituan.search'],
    });
    const gaps = row('template.meituan', state).capabilityGaps;
    const search = gaps.find((gap) => gap.capabilityId === 'cap.meituan.search');
    expect(search).toBeDefined();
    expect(search?.reason).toMatch(/运行时不支持/);
  });

  it('撤权后能力重新变为缺口（运行中撤权实时反映）——撤权成功', () => {
    let state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
    state = authorizeTemplate(state, 'template.document', ['storage', 'file-write', 'model']);
    expect(row('template.document', state).capabilityGaps).toEqual([]);

    state = revokePermission(state, 'template.document', 'file-write');
    const gaps = row('template.document', state).capabilityGaps;
    expect(gaps.some((gap) => gap.capabilityId === 'cap.doc.edit')).toBe(true);
    expect(gaps.some((gap) => gap.reason === '缺少权限：file-write')).toBe(true);
    // 未授予的权限再撤一次必须报错，不静默通过。
    try {
      revokePermission(state, 'template.document', 'file-write');
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('permission-not-granted');
    }
  });

  it('缺失依赖在阻断列表中给出可操作 remedy', () => {
    let state = installTemplate(createTemplatesState(), 'template.meituan', '1.0.0');
    state = recordProbe(state, 'template.meituan', {
      portReady: false,
      portReason: '美团接口未接通',
      missingDependencies: ['已授权的美团接口 / MCP'],
    });
    const blocker = row('template.meituan', state).blockers.find((b) => b.code === 'missing-dependency');
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe('error');
    expect(blocker?.message).toContain('已授权的美团接口');
    expect(blocker?.remedy.length).toBeGreaterThan(0);
  });

  it('详情携带静态能力 / 权限 / 数据范围 / 迁移，缺口与目录行一致', () => {
    const state = installTemplate(createTemplatesState(), 'template.research', '1.0.0');
    const detail = templateDetail(state, 'template.research');
    const definition = getTemplateDefinition('template.research');
    expect(detail.capabilities).toEqual(definition.capabilities);
    expect(detail.permissions).toEqual(definition.permissions);
    expect(detail.consumesFormats).toContain('pdf');
    expect(detail.migration.strategy).toBe('transform');
    expect(detail.capabilityGaps).toEqual(capabilityGaps(definition, getTemplate(state, 'template.research')));
  });
});
