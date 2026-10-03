/**
 * K-R05 独立验证 ①：**模版卸载撤权**。
 *
 * 这些用例断言 K-R05 声称的"卸载撤权"保证在真实产品实现（K06）上确实成立——
 * 不成立即红（该拒的没拒 / 该撤的没撤）。缺陷另见 `02-inflight-freeze.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { expectThrow, installedPinnedFixture, makeFixture, manifest } from './fixtures.js';

describe('K-R05 卸载撤权：权限 / 启用 / 新入口', () => {
  it('卸载在用且无在途任务：撤销全部已授权限并移除（wasActive=true, removed=true）', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.enable('meituan');
    lifecycle.authorize('meituan', undefined, ['network', 'external-order']);

    const report = lifecycle.uninstall('meituan');
    expect(report.wasActive).toBe(true);
    expect(report.retainedForPinnedTasks).toBe(false);
    expect(report.removed).toBe(true);
    // 撤权回执必须逐条列出被撤销的权限，不得为空话。
    expect(report.revokedPermissions).toEqual(['network', 'external-order']);
    expect(lifecycle.get('meituan')).toBeNull();
    expect(lifecycle.activeVersionOf('meituan')).toBeNull();
  });

  it('被在途任务钉住时卸载：撤权 + 停用 + 保留，resolve 仍取到冻结版本（撤权但不夺走版本）', () => {
    const { lifecycle } = installedPinnedFixture();

    const report = lifecycle.uninstall('meituan');
    expect(report.retainedForPinnedTasks).toBe(true);
    expect(report.removed).toBe(false);
    expect(report.revokedPermissions).toEqual(['network', 'external-order']);

    const frozen = lifecycle.resolve('task-1');
    expect(frozen.version).toBe('1.0.0');
    expect(frozen.uninstalled).toBe(true);
    expect(frozen.enabled).toBe(false);
    expect(frozen.grantedPermissions).toEqual([]); // 撤权落到实例可见快照
    // manifest 声明的权限不受影响（只是"未授予"，不是"被删声明"）。
    expect(frozen.manifest.permissions).toEqual(['network', 'external-order']);
  });

  it('卸载后不得再给该版本授权（不得凭卸载残留重新扩权）', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    expectThrow(() => lifecycle.authorize('meituan', '1.0.0', ['network']), '已卸载');
  });

  it('卸载后不得再启用该版本', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    expectThrow(() => lifecycle.enable('meituan', '1.0.0'), '已卸载');
  });

  it('卸载后新任务不得再钉该版本（撤掉新入口）', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    expectThrow(() => lifecycle.pin('task-9', 'meituan'), '已卸载');
  });

  it('在途任务释放后，保留版本被真正移除，且释放后的任务不再能 resolve', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    expect(lifecycle.get('meituan', '1.0.0')).not.toBeNull();

    lifecycle.release('task-1');
    expect(lifecycle.get('meituan', '1.0.0')).toBeNull();
    expectThrow(() => lifecycle.resolve('task-1'), '没有冻结任何模板版本');
  });

  it('两个任务钉同一版本：释放其一仍保留，释放其二才移除（保留期按最后一次释放结束）', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.pin('t1', 'meituan');
    lifecycle.pin('t2', 'meituan');
    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['t1', 't2']);

    lifecycle.uninstall('meituan');
    lifecycle.release('t1');
    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['t2']);
    expect(lifecycle.resolve('t2').version).toBe('1.0.0');

    lifecycle.release('t2');
    expect(lifecycle.get('meituan', '1.0.0')).toBeNull();
  });

  it('卸载后四态就绪报告如实反映"未安装（uninstalled）"，不美化成就绪', async () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    const report = await lifecycle.reportReadiness('meituan', '1.0.0');

    expect(report.installed.state).toBe('not-ready');
    expect(report.installed.reason).toContain('uninstalled');
    expect(report.enabled.state).toBe('not-ready');
    // 撤权后授权态也不得为 ready。
    expect(report.authorized.state).toBe('not-ready');
  });
});
