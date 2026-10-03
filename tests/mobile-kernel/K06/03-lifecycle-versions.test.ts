/**
 * K06 独立验证 ③：升级 / 回滚 / 卸载撤权，以及**版本冻结**（不得静默替换在途任务手里的旧版本）。
 *
 * 核心负例三条：
 *  - 升级后，被在途任务钉住的旧版本仍能被 `resolve()` 取回（旧版本冻结而非被替换）；
 *  - 卸载后在途任务仍能取到已冻结版本，但**新任务**不得再钉该版本；
 *  - 迁移链对不上 / 不可逆 / 需人工确认时，升级或回滚必须被拒。
 */

import { describe, expect, it } from 'vitest';

import {
  createTemplateLifecycle,
  type TemplateLifecycle,
  type TemplateManifest,
} from '../../../apps/mobile-kernel/templates/index.js';
import { baseManifest, expectTemplateError, makeFixture, type K06Fixture } from './fixtures.js';

function lifecycleFor(fixture: K06Fixture): TemplateLifecycle {
  return createTemplateLifecycle({
    clock: fixture.clock,
    host: fixture.host,
    probe: fixture.probe,
    onTransition: (event) => fixture.transitions.push(`${event.kind}:${event.id}@${event.version}`),
  });
}

function upgradeManifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
  return baseManifest({
    version: '1.1.0',
    migration: { from: '1.0.0', to: '1.1.0', strategy: 'additive', reversible: true },
    ...overrides,
  });
}

/** 装好 1.0.0、启用、授权、并让 task-1 钉住它。 */
function installedAndPinned(fixture: K06Fixture): TemplateLifecycle {
  const lifecycle = lifecycleFor(fixture);
  lifecycle.install(baseManifest());
  lifecycle.enable('meituan');
  lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
  lifecycle.pin('task-1', 'meituan');
  return lifecycle;
}

describe('K06 正例：安装 / 启用 / 授权 / 卸载撤权四步状态可观测', () => {
  it('安装后 active 且未启用未授权；启用授权后快照如实反映', () => {
    const fixture = makeFixture();
    const lifecycle = lifecycleFor(fixture);

    const installed = lifecycle.install(baseManifest());
    expect(installed.active).toBe(true);
    expect(installed.enabled).toBe(false);
    expect(installed.grantedPermissions).toEqual([]);
    expect(installed.uninstalled).toBe(false);
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.0.0');

    const enabled = lifecycle.enable('meituan');
    expect(enabled.enabled).toBe(true);

    const authorized = lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
    expect(authorized.grantedPermissions).toEqual(['network', 'external-order']);
    expect(Object.isFrozen(authorized.grantedPermissions)).toBe(true);

    const report = lifecycle.uninstall('meituan');
    expect(report.wasActive).toBe(true);
    expect(report.revokedPermissions).toEqual(['network', 'external-order']);
    expect(report.removed).toBe(true);
    expect(lifecycle.get('meituan')).toBeNull();
    expect(lifecycle.activeVersionOf('meituan')).toBeNull();
    expect(fixture.transitions).toEqual([
      'installed:meituan@1.0.0',
      'enabled:meituan@1.0.0',
      'authorized:meituan@1.0.0',
      'uninstalled:meituan@1.0.0',
    ]);
  });

  it('重复安装同一 id@version ⇒ template_already_installed（不静默覆盖）', () => {
    const fixture = makeFixture();
    const lifecycle = lifecycleFor(fixture);
    lifecycle.install(baseManifest());
    expectTemplateError(() => lifecycle.install(baseManifest()), 'template_already_installed');
  });
});

describe('K06 负例①：升级后旧版本冻结保留，在途任务仍取到旧版本（不得静默替换）', () => {
  it('task-1 钉 1.0.0 → 升级 1.1.0 → resolve(task-1) 仍是 1.0.0，新任务才拿到 1.1.0', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);

    const upgraded = lifecycle.upgrade('meituan', upgradeManifest());
    expect(upgraded.version).toBe('1.1.0');
    expect(upgraded.active).toBe(true);
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.1.0');

    // 关键：在途任务手里的旧版本**没有被替换**
    const frozen = lifecycle.resolve('task-1');
    expect(frozen.version).toBe('1.0.0');
    expect(frozen.frozen).toBe(true);
    expect(frozen.active).toBe(false);
    expect(frozen.pinnedBy).toEqual(['task-1']);

    // 新任务拿到的是新版本
    const fresh = lifecycle.pin('task-2', 'meituan');
    expect(fresh.version).toBe('1.1.0');
    expect(fresh.frozen).toBe(false);

    // 旧版本仍在（冻结保留），可被检索
    const old = lifecycle.get('meituan', '1.0.0');
    expect(old?.version).toBe('1.0.0');
    expect(old?.frozen).toBe(true);
    expect(lifecycle.list('meituan').map((entry) => entry.version).sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('迁移链 from 对不上 ⇒ migration_chain_mismatch（field=migration.from）', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    expectTemplateError(
      () =>
        lifecycle.upgrade(
          'meituan',
          upgradeManifest({ migration: { from: '0.9.0', to: '1.1.0', strategy: 'additive', reversible: true } }),
        ),
      'migration_chain_mismatch',
      'migration.from',
    );
    // 对照组：from 正确即通过
    expect(lifecycle.upgrade('meituan', upgradeManifest()).version).toBe('1.1.0');
  });

  it('migration.to 与目标版本不符 ⇒ migration_chain_mismatch（field=migration.to）', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    expectTemplateError(
      () =>
        lifecycle.upgrade(
          'meituan',
          upgradeManifest({ migration: { from: '1.0.0', to: '9.9.9', strategy: 'additive', reversible: true } }),
        ),
      'migration_chain_mismatch',
      'migration.to',
    );
  });

  it('strategy=manual 未显式确认 ⇒ 拒绝；显式确认后通过', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    const manual = upgradeManifest({
      migration: { from: '1.0.0', to: '1.1.0', strategy: 'manual', reversible: true },
    });
    expectTemplateError(() => lifecycle.upgrade('meituan', manual), 'migration_manual_confirmation_required');
    expect(lifecycle.upgrade('meituan', manual, { manualConfirmed: true }).version).toBe('1.1.0');
  });

  it('对没有任何在用版本的 id 调 upgrade ⇒ template_not_installed', () => {
    const fixture = makeFixture();
    const lifecycle = lifecycleFor(fixture);
    expectTemplateError(() => lifecycle.upgrade('ghost', upgradeManifest({ id: 'ghost' })), 'template_not_installed');
  });
});

describe('K06 负例②：回滚 —— 可逆才回，不可逆一律拒', () => {
  it('可逆迁移：回滚把在用版本切回 1.0.0，1.1.0 转冻结', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    lifecycle.upgrade('meituan', upgradeManifest());

    const rolled = lifecycle.rollback('meituan');
    expect(rolled.version).toBe('1.0.0');
    expect(rolled.active).toBe(true);
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.0.0');
    expect(lifecycle.get('meituan', '1.1.0')?.frozen).toBe(true);
    // 在途任务全程不受影响
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });

  it('reversible=false 的迁移 ⇒ migration_not_reversible，且在用版本不变', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    lifecycle.upgrade(
      'meituan',
      upgradeManifest({ migration: { from: '1.0.0', to: '1.1.0', strategy: 'transform', reversible: false } }),
    );
    expectTemplateError(() => lifecycle.rollback('meituan'), 'migration_not_reversible');
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.1.0');
  });
});

describe('K06 负例③：卸载撤权 —— 在途任务仍取到冻结版本，新任务被拒', () => {
  it('卸载被钉住的版本：撤权 + 停用 + 保留；resolve 仍返回旧版本', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);

    const report = lifecycle.uninstall('meituan');
    expect(report.retainedForPinnedTasks).toBe(true);
    expect(report.removed).toBe(false);
    expect(report.revokedPermissions).toEqual(['network', 'external-order']);

    // 在途任务**仍能**取到已冻结版本（这条是本题的硬要求）
    const frozen = lifecycle.resolve('task-1');
    expect(frozen.version).toBe('1.0.0');
    expect(frozen.uninstalled).toBe(true);
    expect(frozen.enabled).toBe(false);
    expect(frozen.grantedPermissions).toEqual([]); // 权限已撤销
    expect(frozen.manifest.permissions).toEqual(['network', 'external-order']); // 声明不受影响

    // 新任务不得再钉已卸载版本
    expectTemplateError(() => lifecycle.pin('task-9', 'meituan'), 'version_not_installed');
  });

  it('在途任务释放后，卸载版本被真正移除', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    lifecycle.uninstall('meituan');
    expect(lifecycle.get('meituan', '1.0.0')).not.toBeNull();

    lifecycle.release('task-1');
    expect(lifecycle.get('meituan', '1.0.0')).toBeNull();
    expectTemplateError(() => lifecycle.resolve('task-1'), 'pin_not_found');
  });

  it('无在途任务时卸载 ⇒ 直接移除（removed=true）', () => {
    const fixture = makeFixture();
    const lifecycle = lifecycleFor(fixture);
    lifecycle.install(baseManifest());
    const report = lifecycle.uninstall('meituan');
    expect(report.retainedForPinnedTasks).toBe(false);
    expect(report.removed).toBe(true);
    expect(report.revokedPermissions).toEqual([]);
  });

  it('任务已钉住后再钉 ⇒ task_already_pinned（不得静默换版本）', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    expectTemplateError(() => lifecycle.pin('task-1', 'meituan'), 'task_already_pinned');
  });

  it('升级后为同一个任务改钉新版本会被拒（必须先 release）——对照组：release 后可钉新版本', () => {
    const fixture = makeFixture();
    const lifecycle = installedAndPinned(fixture);
    lifecycle.upgrade('meituan', upgradeManifest());
    expectTemplateError(() => lifecycle.pin('task-1', 'meituan'), 'task_already_pinned');

    lifecycle.release('task-1');
    expect(lifecycle.pin('task-1', 'meituan').version).toBe('1.1.0');
  });
});
