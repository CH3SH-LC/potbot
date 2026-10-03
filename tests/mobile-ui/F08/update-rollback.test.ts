/**
 * F08 / 更新与回滚（design-07 行 158 / 243）：
 *   - 更新比对**新增权限**，新增必须再授权 ⇒ authorized 掉回 false 并出现 pending-authorization；
 *   - 被移除的权限从授予集合剔除；
 *   - 回滚把版本与授权复原到更新前快照；
 *   - 卸载必须声明范围，且清除安装/启用/授权。
 */

import { describe, expect, it } from 'vitest';

import {
  applyUpdate,
  authorizeTemplate,
  catalogRows,
  createTemplatesState,
  diffPermissions,
  enableTemplate,
  getTemplate,
  installTemplate,
  recordProbe,
  rollbackTemplate,
  uninstallTemplate,
} from '../../../apps/mobile-ui/src/templates/index.js';

function row(state: ReturnType<typeof createTemplatesState>, id: string) {
  const found = catalogRows(state).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`目录行缺失：${id}`);
  return found;
}

function installedDoc() {
  let state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
  state = authorizeTemplate(state, 'template.document', ['storage', 'file-write', 'model']);
  state = enableTemplate(state, 'template.document');
  state = recordProbe(state, 'template.document', { portReady: true });
  return state;
}

describe('F08 / 更新比对与再授权', () => {
  it('diffPermissions 只把新增标为需要再授权', () => {
    const delta = diffPermissions(['storage', 'model'], ['storage', 'model', 'external-order']);
    expect(delta.added).toEqual(['external-order']);
    expect(delta.removed).toEqual([]);
    expect(delta.unchanged).toEqual(['storage', 'model']);
    expect(delta.requiresReauthorization).toBe(true);
  });

  it('无新增权限的更新不要求再授权', () => {
    const delta = diffPermissions(['storage', 'model'], ['model', 'storage']);
    expect(delta.added).toEqual([]);
    expect(delta.requiresReauthorization).toBe(false);
  });

  it('更新带来新增权限：authorized 掉回 false，出现 pending-authorization 阻断', () => {
    let state = installedDoc();
    expect(row(state, 'template.document').readiness.authorized).toBe(true);

    const result = applyUpdate(state, 'template.document', {
      version: '1.1.0',
      permissions: ['storage', 'file-write', 'model', 'external-order'],
    });
    state = result.state;
    expect(result.delta.added).toEqual(['external-order']);
    expect(result.delta.requiresReauthorization).toBe(true);

    const after = row(state, 'template.document');
    expect(after.installedVersion).toBe('1.1.0');
    expect(after.readiness.installed).toBe(true);
    expect(after.readiness.authorized).toBe(false);
    expect(after.missingPermissions).toEqual(['external-order']);
    expect(after.blockers.some((b) => b.code === 'pending-authorization')).toBe(true);
  });

  it('再授权新增权限后 authorized 恢复', () => {
    let state = installedDoc();
    state = applyUpdate(state, 'template.document', {
      version: '1.1.0',
      permissions: ['storage', 'file-write', 'model', 'external-order'],
    }).state;
    state = authorizeTemplate(state, 'template.document', ['external-order']);
    expect(row(state, 'template.document').readiness.authorized).toBe(true);
    expect(row(state, 'template.document').missingPermissions).toEqual([]);
  });

  it('更新移除权限：该权限从授予集合剔除，不残留', () => {
    let state = installedDoc();
    state = authorizeTemplate(state, 'template.document', ['external-order']);
    expect(getTemplate(state, 'template.document').grantedPermissions).toContain('external-order');

    const result = applyUpdate(state, 'template.document', {
      version: '1.2.0',
      // 去掉 external-order 与 file-write
      permissions: ['storage', 'model'],
    });
    state = result.state;
    // removed 比对的是**版本要求的权限集**（1.0.0 的 file-write 不再被要求）；
    // 已授予但从未被要求的 external-order 不算 removed，但会因不在目标集而被剔出授予。
    expect(result.delta.removed).toEqual(['file-write']);
    expect(getTemplate(state, 'template.document').grantedPermissions).toEqual(['storage', 'model']);
    expect(row(state, 'template.document').readiness.authorized).toBe(true);
  });

  it('非法版本号被拒（invalid-version）', () => {
    const state = installedDoc();
    try {
      applyUpdate(state, 'template.document', { version: 'v1', permissions: ['storage'] });
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid-version');
    }
  });
});

describe('F08 / 回滚', () => {
  it('回滚复原版本与授权到更新前快照', () => {
    let state = installedDoc();
    // 更新前：版本 1.0.0，授权 storage/file-write/model。
    state = applyUpdate(state, 'template.document', {
      version: '1.1.0',
      permissions: ['storage', 'file-write', 'model', 'external-order'],
    }).state;
    expect(row(state, 'template.document').installedVersion).toBe('1.1.0');

    state = rollbackTemplate(state, 'template.document');
    const after = row(state, 'template.document');
    expect(after.installedVersion).toBe('1.0.0');
    // 规范权限序：network, storage, model, device, external-order, file-write。
    expect(getTemplate(state, 'template.document').grantedPermissions).toEqual([
      'storage',
      'model',
      'file-write',
    ]);
    // 回滚后 required 回到 1.0.0 的权限集 ⇒ authorized 恢复 true。
    expect(after.readiness.authorized).toBe(true);
    expect(after.readiness.enabled).toBe(true);
  });

  it('没有可回滚快照时抛 no-rollback-target（不假装回滚成功）', () => {
    const state = installTemplate(createTemplatesState(), 'template.clock', '1.0.0');
    try {
      rollbackTemplate(state, 'template.clock');
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('no-rollback-target');
    }
  });
});

describe('F08 / 卸载', () => {
  it('卸载必须声明范围；缺字段被拒', () => {
    const state = installedDoc();
    try {
      uninstallTemplate(state, 'template.document', {} as never);
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid-transition');
    }
  });

  it('卸载清除安装 / 启用 / 授权，目录行仍在（七行恒可见）', () => {
    let state = installedDoc();
    state = uninstallTemplate(state, 'template.document', {
      activeTasks: 'cancel',
      artifactData: 'retain',
      keepInstalledOnFailure: true,
    });
    const after = row(state, 'template.document');
    expect(after.installedVersion).toBeNull();
    expect(after.readiness).toEqual({
      installed: false,
      enabled: false,
      authorized: false,
      portReady: false,
    });
    expect(catalogRows(state)).toHaveLength(7);
  });
});
