/**
 * FA-A-E2E —— 需求簇 4：**模板安装/停用/更新/回滚 + 运行中撤权**（A06 / A17 / A18）。
 *
 * 主张：安装 / 停用 / 更新 / 回滚模板，运行中撤销权限；**旧实例版本固定**，
 * 后续调用受到撤销约束，**缺能力清楚反馈**。
 *
 * 真跑落点（全部走真实 `src/plugins/**` 与 `src/roles/**`）：
 * - `createPluginRegistry()` 的 install / enable / disable / authorize / revokeAuthorization；
 * - `readAvailableOperations()` 的"停用即缺能力"如实报告；
 * - `VersionFreezer` 的实例版本固定 + 漂移报告（升版 / 回滚）；
 * - `installFromPackage()` 作为更新与回滚的真实原语；
 * - `assertNoPrivilegeMutation()` 的"不借成员越权"。
 */
import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import {
  createPluginRegistry,
  findPluginManifest,
  type DiscoveryProbes,
} from '../../../src/plugins/index.js';
import { createBusinessTemplateManifest, type ValidatedPackage } from '../../../src/plugins/manifest.js';
import { readAvailableOperations, stateVector } from '../../../src/plugins/capability-discovery.js';
import { VersionFreezer } from '../../../src/plugins/version-freeze.js';
import { assertNoPrivilegeMutation } from '../../../src/roles/index.js';

const READY_PROBES: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};

const DOC = 'template.document' as const;

function clock(): () => ReturnType<typeof asLogicalTime> {
  let t = 0;
  return () => asLogicalTime(++t);
}

/** 用一个受控清单包替换注册表里的模板：更新（更高版本）与回滚（更低版本）都用它。 */
function packageFor(version: string): ValidatedPackage {
  const base = findPluginManifest(DOC);
  if (base === undefined) throw new Error('目录里没有 template.document');
  // 通过公开构造口重新校验一份清单（不复制记录形状）。
  const raw = { ...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>), version };
  return { package_id: `pkg.document.${version}`, version, manifest: createBusinessTemplateManifest(raw) };
}

describe('A18 停用/撤权即时生效：不再新建实例、后续调用受限', () => {
  it('停用后：门禁拒绝新建实例，可用操作消失，缺能力如实报告', () => {
    const registry = createPluginRegistry();
    const tick = clock();
    expect(registry.install(DOC, { at: tick() }).ok).toBe(true);
    registry.enable(DOC, tick());

    expect(registry.gateInstanceCreation(DOC, tick(), READY_PROBES).ok).toBe(true);

    registry.disable(DOC, tick());
    const gate = registry.gateInstanceCreation(DOC, tick(), READY_PROBES);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reasons.join(' ')).toContain('停用');

    // 缺能力：停用模板的操作不在可用清单里（total 0）。
    const listing = readAvailableOperations(registry, READY_PROBES);
    expect(listing.total_available).toBe(0);
    expect(listing.entries.length).toBe(0);

    const discovery = registry.discover(DOC, READY_PROBES);
    expect(discovery).toBeDefined();
    const vector = stateVector(discovery!);
    expect(vector.ready).toBe(false);
    expect(vector.false_states).toContain('enabled');
  });

  it('运行中撤销授权：后续调用即时受限；重新授权后恢复', () => {
    const registry = createPluginRegistry();
    const tick = clock();
    registry.install(DOC, { at: tick() });
    registry.enable(DOC, tick());
    expect(registry.gateInstanceCreation(DOC, tick(), READY_PROBES).ok).toBe(true);

    registry.revokeAuthorization(DOC, tick());
    const revoked = registry.gateInstanceCreation(DOC, tick(), READY_PROBES);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reasons.join(' ')).toContain('撤销');

    registry.authorize(DOC, tick());
    expect(registry.gateInstanceCreation(DOC, tick(), READY_PROBES).ok).toBe(true);
  });

  it('A06：经验维护角色不得改权限 / 工具地址（不借成员越权）', () => {
    expect(() => assertNoPrivilegeMutation({ kind: 'permission_grant', target: 'template.document', detail: '自批写权限' })).toThrow();
    expect(() => assertNoPrivilegeMutation({ kind: 'tool_address_change', target: 'adapter.meituan', detail: '改跳转地址' })).toThrow();
  });
});

describe('A17 更新/回滚：旧实例版本固定，新实例才拿新版本', () => {
  it('更新后旧实例仍钉在旧版本；新实例需重新启用/授权才拿到新版本', () => {
    const registry = createPluginRegistry();
    const freezer = new VersionFreezer(registry);
    const tick = clock();
    registry.install(DOC, { at: tick() });
    registry.enable(DOC, tick());

    const frozen = freezer.issue(DOC, 'inst-1', tick(), READY_PROBES);
    expect(frozen.version).toBe('0.9.0');

    // 更新到 1.0.0。
    expect(registry.installFromPackage(packageFor('1.0.0'), tick()).ok).toBe(true);

    // 旧实例不热换规则：仍钉在 0.9.0。
    expect(freezer.get('inst-1')?.version).toBe('0.9.0');
    const drift = freezer.driftReport(DOC);
    expect(drift[0]?.frozen_version).toBe('0.9.0');
    expect(drift[0]?.current_version).toBe('1.0.0');
    expect(drift[0]?.direction).toBe('upgraded');
    expect(drift[0]?.frozen_binding_intact).toBe(true);

    // 新实例：需重新启用 + 授权，之后拿到新版本。
    expect(freezer.checkNewInstance(DOC, tick(), READY_PROBES).ok).toBe(false);
    registry.enable(DOC, tick());
    registry.authorize(DOC, tick());
    const gate = freezer.checkNewInstance(DOC, tick(), READY_PROBES);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.binding.version).toBe('1.0.0');
  });

  it('回滚到 0.9.0：注册表版本回落，旧实例不动，漂移方向变 downgraded', () => {
    const registry = createPluginRegistry();
    const freezer = new VersionFreezer(registry);
    const tick = clock();
    registry.install(DOC, { at: tick() });
    registry.enable(DOC, tick());
    freezer.issue(DOC, 'inst-1', tick(), READY_PROBES);

    registry.installFromPackage(packageFor('1.0.0'), tick());
    registry.enable(DOC, tick());
    registry.authorize(DOC, tick());
    freezer.issue(DOC, 'inst-2', tick(), READY_PROBES); // 新实例拿到 1.0.0
    expect(freezer.get('inst-2')?.version).toBe('1.0.0');

    // 回滚：以更低版本包替换。
    expect(registry.installFromPackage(packageFor('0.9.0'), tick()).ok).toBe(true);
    expect(registry.recordOf(DOC)?.version).toBe('0.9.0');
    const drift = freezer.driftReport(DOC);
    const second = drift.find((entry) => entry.instance_id === 'inst-2');
    expect(second?.direction).toBe('downgraded');
    expect(second?.frozen_binding_intact).toBe(true);
    // 两个实例的固定版本都不受回滚影响。
    expect(freezer.get('inst-1')?.version).toBe('0.9.0');
    expect(freezer.get('inst-2')?.version).toBe('1.0.0');
  });
});

describe('模板平台 —— 显式跳过（需真机/真实宿主）', () => {
  it.skip('App 上停用模板/撤销权限的按钮到即时生效链路 → 需真机 App', () => {
    // 本套件证明注册表门禁；真机点击到门禁的链路未验证。
  });
});
