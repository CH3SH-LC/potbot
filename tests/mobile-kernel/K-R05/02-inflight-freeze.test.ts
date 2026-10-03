/**
 * K-R05 独立验证 ②：**在途版本冻结**（in-flight version freeze）。
 *
 * 前半是**成立**的保证（升级/回滚/卸载都不改写、不夺走在途任务手里的版本）。
 * 后半原先用 `it.fails` 钉住两条**实测存在**的缺陷（D1/D2）。K06 已在
 * `apps/mobile-kernel/templates/lifecycle.ts` 修复（集成单元 K-I01 落地），故这里把
 * 两条守卫**转为硬断言**：用例体断言的是**应有**行为，现在必须真的通过。
 *
 * 两条操作轨迹（REINSTALL / STALE_FALLBACK）在**修复后的真实实现**上跑 `runTrace`，
 * 审计器现在**零发现**——缺陷不隐藏、修复即报警的收口。检测器本身会不会报，仍由
 * `03-audit-module.test.ts` 用**故意损坏**的假探针自证（判据非空壳）。
 */

import { describe, expect, it } from 'vitest';

import { runTrace } from './freeze-audit.js';
import type { K_R05_Op } from './freeze-audit.js';
import { installedPinnedFixture, makeFixture, manifest, upgradeManifest } from './fixtures.js';

describe('K-R05 在途版本冻结：升级 / 回滚不得改写绑定（当前成立）', () => {
  it('升级后 task-1 仍 resolve 到 1.0.0，新任务拿 1.1.0', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.upgrade('meituan', upgradeManifest());

    const frozen = lifecycle.resolve('task-1');
    expect(frozen.version).toBe('1.0.0');
    expect(frozen.frozen).toBe(true);
    expect(frozen.active).toBe(false);
    expect(frozen.pinnedBy).toEqual(['task-1']);

    expect(lifecycle.pin('task-2', 'meituan').version).toBe('1.1.0');
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.1.0');
  });

  it('回滚后 task-1 的绑定不受影响', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.upgrade('meituan', upgradeManifest());
    lifecycle.rollback('meituan');
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.0.0');
  });

  it('卸载在用版本（非钉住版本）后，在途任务的旧冻结版本仍可取回', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.upgrade('meituan', upgradeManifest()); // 1.0.0 frozen, 1.1.0 active; task-1 -> 1.0.0
    const report = lifecycle.uninstall('meituan'); // 卸 1.1.0（未钉住 -> 移除）
    expect(report.version).toBe('1.1.0');
    expect(report.removed).toBe(true);
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// D1（已修复）：重装"为在途任务保留"的同版本，必须保留 pinnedBy，不得夺走版本
// ---------------------------------------------------------------------------

const REINSTALL_TRACE: readonly K_R05_Op[] = [
  { kind: 'install', manifest: manifest(), label: 'install(meituan@1.0.0)' },
  { kind: 'enable', id: 'meituan', label: 'enable(meituan)' },
  { kind: 'authorize', id: 'meituan', granted: ['network', 'external-order'], label: 'authorize(meituan)' },
  { kind: 'pin', taskId: 'task-1', id: 'meituan', label: 'pin(task-1)' },
  { kind: 'uninstall', id: 'meituan', label: 'uninstall#1(retained for task-1)' },
  { kind: 'install', manifest: manifest(), label: 'reinstall(meituan@1.0.0) while task-1 in flight' },
  { kind: 'uninstall', id: 'meituan', label: 'uninstall#2' },
];

describe('K-R05 缺陷①（已修复）：重装被在途任务保留的版本后再次卸载，task-1 仍 resolve 到 1.0.0', () => {
  it('重装保留版本保留 pin 记账；再次卸载因在途钉住而保留，resolve 取到同一版本', () => {
    const { lifecycle } = installedPinnedFixture();

    const first = lifecycle.uninstall('meituan'); // retained for task-1
    expect(first.retainedForPinnedTasks).toBe(true);
    expect(first.removed).toBe(false);
    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['task-1']);

    const reinstalled = lifecycle.install(manifest()); // 用户重装同一版本
    // 关键：重装不得重置在途任务的 pin 记账（版本是身份的一部分）。
    expect(reinstalled.pinnedBy).toEqual(['task-1']);

    const second = lifecycle.uninstall('meituan'); // 再次卸载
    // 关键：仍在途钉住 ⇒ 保留，不得移除在途任务手里的版本。
    expect(second.retainedForPinnedTasks).toBe(true);
    expect(second.removed).toBe(false);
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });

  it('审计器在真实实现上对 REINSTALL_TRACE 零发现（I1/I2 不再触发）', () => {
    const { lifecycle } = makeFixture();
    const result = runTrace(lifecycle, REINSTALL_TRACE);

    // 修复后：在途版本未被夺走，故 I1（resolve 失败）/ I2（pin 记账丢失）都不再触发。
    expect(result.findings).toEqual([]);

    // 账面证据：重装成功，且卸载#2 因在途钉住而"保留"（removed=false）。
    const reinstall = result.journal.find((entry) => entry.label.startsWith('reinstall'));
    expect(reinstall?.ok).toBe(true);
    const uninstall2 = result.journal.find((entry) => entry.label === 'uninstall#2');
    expect(uninstall2?.ok).toBe(true);
    expect(uninstall2?.detail).toContain('removed=false');

    // 在途任务照样取得到冻结版本。
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// D2（已修复）：在用版本被卸载后，新任务未指定版本时不得静默回退到旧（已取代）版本
// ---------------------------------------------------------------------------

const STALE_FALLBACK_TRACE: readonly K_R05_Op[] = [
  { kind: 'install', manifest: manifest(), label: 'install(1.0.0)' },
  { kind: 'pin', taskId: 'task-1', id: 'meituan', label: 'pin(task-1 -> 1.0.0)' },
  { kind: 'upgrade', id: 'meituan', manifest: upgradeManifest(), label: 'upgrade(1.0.0 -> 1.1.0)' },
  { kind: 'uninstall', id: 'meituan', label: 'uninstall(active 1.1.0 -> removed)' },
  { kind: 'pin', taskId: 'task-2', id: 'meituan', label: 'pin(task-2, no version)' },
];

describe('K-R05 缺陷②（已修复）：在用版本卸载后，未指定版本的新 pin 被拒，不静默回退旧版本', () => {
  it('没有在用版本时，未指定版本的新 pin 必须抛错（而不是悄悄绑 1.0.0）', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.pin('task-1', 'meituan');
    lifecycle.upgrade('meituan', upgradeManifest());
    lifecycle.uninstall('meituan'); // 卸掉在用 1.1.0
    expect(lifecycle.activeVersionOf('meituan')).toBeNull();

    // 应有行为：没有在用版本时，新 pin 应被拒（而不是悄悄绑 1.0.0）。
    expect(() => lifecycle.pin('task-2', 'meituan')).toThrow();

    // 在途任务的既有绑定不受影响。
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });

  it('审计器在真实实现上对 STALE_FALLBACK_TRACE 零发现（该拒的真的拒了）', () => {
    const { lifecycle } = makeFixture();
    const result = runTrace(lifecycle, STALE_FALLBACK_TRACE);

    // 新 pin 被拒 ⇒ 审计器不会记到一次"静默回退"，I5 不触发。
    expect(result.findings).toEqual([]);

    const stalePin = result.journal.find((entry) => entry.label === 'pin(task-2, no version)');
    expect(stalePin?.ok).toBe(false); // 该拒的真的拒了，不是空壳判据

    expect(lifecycle.activeVersionOf('meituan')).toBeNull();
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
  });
});
