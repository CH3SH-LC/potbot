/**
 * K-I01 集成验证 ② —— **无在用版本时，未指定版本的新 pin 必须被拒**（关闭 K-R05 D2 / I5）。
 *
 * 缺陷原状（K-R05 复现）：在用版本被卸载后，`resolveTargetVersion()` 为"卸载后仍能报告单一
 * 保留版本"而设计的路由回退被 `pin()` 复用，令未指定版本的新任务静默绑到**唯一剩余的旧/
 * 已被取代版本**，而 `activeVersionOf()` 已是 null。
 *
 * 修复后应成立：未指定版本 ⇒ 只能绑当前在用版本；没有在用版本即拒绝。同时保持既有口径：
 * "唯一版本已卸载"仍抛 `version_not_installed`（K06 用例依赖该码）。
 */

import { describe, expect, it } from 'vitest';

import { captureTemplateError, installedPinnedFixture, makeFixture, manifest, upgradeManifest } from './fixtures.js';

describe('K-I01 D2：无在用版本时，未指定版本的 pin 被拒', () => {
  it('在用版本被卸载后，未指定版本的新 pin 抛 template_not_installed（不静默绑旧版本）', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.pin('task-1', 'meituan');
    lifecycle.upgrade('meituan', upgradeManifest()); // 1.0.0 frozen, 1.1.0 active
    lifecycle.uninstall('meituan'); // 卸掉在用 1.1.0
    expect(lifecycle.activeVersionOf('meituan')).toBeNull();

    const error = captureTemplateError(() => lifecycle.pin('task-2', 'meituan'));
    expect(error.code).toBe('template_not_installed');
    expect(error.message).toContain('没有在用版本');
  });

  it('被拒之后状态未被改动：无新绑定、在途绑定不变、旧版本仍可被在途任务取回', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.pin('task-1', 'meituan');
    lifecycle.upgrade('meituan', upgradeManifest());
    lifecycle.uninstall('meituan');

    captureTemplateError(() => lifecycle.pin('task-2', 'meituan'));

    expect(lifecycle.activeVersionOf('meituan')).toBeNull();
    expect(lifecycle.get('meituan', '1.0.0')?.pinnedBy).toEqual(['task-1']); // 未混入 task-2
    expect(lifecycle.resolve('task-1').version).toBe('1.0.0');
    expect(captureTemplateError(() => lifecycle.resolve('task-2')).code).toBe('pin_not_found');
  });

  it('既有口径保持：唯一版本已卸载时，未指定版本的 pin 仍抛 version_not_installed', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan'); // 唯一版本被保留但已卸载，activeVersionOf=null
    expect(lifecycle.activeVersionOf('meituan')).toBeNull();

    const error = captureTemplateError(() => lifecycle.pin('task-9', 'meituan'));
    expect(error.code).toBe('version_not_installed');
  });

  it('显式指定已卸载版本同样被拒（version_not_installed）', () => {
    const { lifecycle } = installedPinnedFixture();
    lifecycle.uninstall('meituan');
    expect(captureTemplateError(() => lifecycle.pin('task-9', 'meituan', '1.0.0')).code).toBe(
      'version_not_installed',
    );
  });
});

describe('K-I01 D2 对照：有在用版本时，未指定版本的 pin 绑到在用版本', () => {
  it('全新安装后，未指定版本的 pin 绑到在用 1.0.0', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    expect(lifecycle.pin('task-9', 'meituan').version).toBe('1.0.0');
  });

  it('升级后，未指定版本的 pin 绑到在用 1.1.0，而非被取代的 1.0.0', () => {
    const { lifecycle } = makeFixture();
    lifecycle.install(manifest());
    lifecycle.upgrade('meituan', upgradeManifest()); // 1.0.0 superseded, 1.1.0 active
    expect(lifecycle.activeVersionOf('meituan')).toBe('1.1.0');

    const pinned = lifecycle.pin('task-9', 'meituan');
    expect(pinned.version).toBe('1.1.0');
    expect(pinned.frozen).toBe(false);
  });
});
