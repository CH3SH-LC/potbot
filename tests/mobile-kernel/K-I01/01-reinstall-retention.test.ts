/**
 * K-I01 集成验证 ① —— **重装保留版本不得丢失 pin 记账**（关闭 K-R05 D1 / 不变量 I2）。
 *
 * 缺陷原状（K-R05 复现）：`adopt()` 对"已卸载但被在途任务保留"的同版本直接建**全新记录**
 * （`pinnedBy: []`），丢掉在途任务的 pin 记账；随后 `uninstall()` 因"无人钉住"而移除该版本，
 * `resolve(taskId)` 抛 `version_not_installed`。
 *
 * 修复后应成立：版本是身份的一部分——重装**复活既有记录并保留 `pinnedBy`**；再次卸载因在途
 * 钉住而保留；在途任务始终 `resolve` 得到同一版本；释放后方才真正移除。
 */

import { describe, expect, it } from 'vitest';

import { captureTemplateError, installedPinnedFixture, makeFixture, manifest } from './fixtures.js';

describe('K-I01 D1：重装被在途任务保留的版本（保留 pin 记账）', () => {
  it('重装保留版本保留 pinnedBy；再次卸载保留；resolve 取到同一版本', () => {
    const { lifecycle } = installedPinnedFixture();

    const first = lifecycle.uninstall('meituan'); // 有在途钉住 ⇒ 保留
    expect(first.retainedForPinnedTasks).toBe(true);
    expect(first.removed).toBe(false);
    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['task-1']);

    const reinstalled = lifecycle.install(manifest()); // 用户重装同一版本
    // 关键：pin 记账不得被重置（修复前这里是 []）。
    expect(reinstalled.pinnedBy).toEqual(['task-1']);

    const second = lifecycle.uninstall('meituan'); // 再次卸载
    expect(second.retainedForPinnedTasks).toBe(true); // 仍在途钉住 ⇒ 保留
    expect(second.removed).toBe(false);

    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });

  it('重装把被保留的版本复活为在用版本，但绑定记账不变', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan'); // retained
    lifecycle.install(manifest()); // reinstall

    expect(lifecycle.activeVersionOf('meituan')).toBe('1.0.0');
    const snapshot = lifecycle.get('meituan');
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.uninstalled).toBe(false); // 复活为正常在用
    expect(snapshot?.pinnedBy).toEqual(['task-1']); // 在途记账原样保留
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });

  it('多个任务钉同一版本：重装后两个 pin 都保留，逐个释放才移除', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.pin('t1', 'meituan');
    lifecycle.pin('t2', 'meituan');
    lifecycle.uninstall('meituan'); // retained for t1,t2
    lifecycle.install(manifest()); // reinstall，不得丢账

    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['t1', 't2']);

    lifecycle.uninstall('meituan'); // retained again
    lifecycle.release('t1');
    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['t2']);
    expect(lifecycle.resolve('t2').version).toBe('1.0.0');

    lifecycle.release('t2');
    expect(lifecycle.get('meituan', '1.0.0')).toBeNull();
    expect(captureTemplateError(() => lifecycle.resolve('t2')).code).toBe('pin_not_found');
  });

  it('保留期不泄漏：重装 → 再次卸载 → 释放后版本被真正移除', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    lifecycle.install(manifest());
    lifecycle.uninstall('meituan');
    expect(lifecycle.get('meituan', '1.0.0')).not.toBeNull();

    lifecycle.release('task-1');
    expect(lifecycle.get('meituan', '1.0.0')).toBeNull();
    expect(captureTemplateError(() => lifecycle.resolve('task-1')).code).toBe('pin_not_found');
  });
});

describe('K-I01 D1 对照：常规安装路径不受影响', () => {
  it('无在途任务的卸载会真正移除；随后重装得到一条全新、无绑定的记录', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    const report = lifecycle.uninstall('meituan');
    expect(report.removed).toBe(true);
    expect(lifecycle.get('meituan')).toBeNull();

    const reinstalled = lifecycle.install(manifest());
    expect(reinstalled.pinnedBy).toEqual([]);
    expect(reinstalled.active).toBe(true);
    expect(lifecycle.list('meituan').map((entry) => entry.version)).toEqual(['1.0.0']);
  });

  it('重复安装"已安装且未卸载"的版本仍被拒（template_already_installed，未回归）', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    expect(captureTemplateError(() => lifecycle.install(manifest())).code).toBe('template_already_installed');
  });
});
