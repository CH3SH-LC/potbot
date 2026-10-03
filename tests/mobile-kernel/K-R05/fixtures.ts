/**
 * K-R05 夹具：装配真实的 `TemplateLifecycle`（K06 产品实现）+ 确定性时钟 + 固定探针，
 * 让每条反例独立驱动"卸载撤权 / 在途版本冻结"。不依赖真机、网络或墙钟。
 */

import {
  createManualClock,
  createTemplateLifecycle,
  type HostPlatform,
  type InstalledTemplate,
  type ManualClock,
  type TemplateLifecycle,
  type TemplateManifest,
  type TemplateProbePort,
} from '../../../apps/mobile-kernel/templates/index.js';

export const T0 = 1_700_000_000_000;

export function baseHost(overrides: Partial<HostPlatform> = {}): HostPlatform {
  return {
    os: 'android',
    apiLevel: 34,
    runtimes: ['quickjs'],
    abis: ['arm64-v8a'],
    capabilities: ['order.place', 'order.read'],
    ...overrides,
  };
}

/** 恒就绪探针：本包只审计生命周期记账，不审计探针（那归 K06）。 */
export function readyProbe(): TemplateProbePort {
  return {
    identity: 'k-r05.ready-probe',
    probeInstalled: () => ({ ok: true, evidenceRef: 'evidence://probe/installed' }),
    probeEnabled: () => ({ ok: true, evidenceRef: 'evidence://probe/enabled' }),
    probeAuthorized: () => ({ ok: true, evidenceRef: 'evidence://probe/authorized' }),
    probePorts: () => ({ ok: true, evidenceRef: 'evidence://probe/ports' }),
  };
}

/** 美团模板 1.0.0：两个能力、两个权限，运行时与 baseHost 匹配。 */
export function manifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    id: 'meituan',
    displayName: '美团下单模板',
    version: '1.0.0',
    capabilities: ['order.place', 'order.read'],
    schemas: ['mobile-v1/external-receipt'],
    permissions: ['network', 'external-order'],
    runtimeCompatibility: { os: 'android', minimumOs: 26, runtimes: ['quickjs'], abis: ['arm64-v8a'] },
    migration: { from: '', to: '1.0.0', strategy: 'none', reversible: true },
    probe: {
      installed: true,
      enabled: true,
      authorized: true,
      portReady: true,
      verificationMode: 'fixture',
      layers: ['unit', 'contract'],
    },
    ...overrides,
  };
}

/** 1.1.0 升级清单（additive + reversible）。 */
export function upgradeManifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
  return manifest({
    version: '1.1.0',
    migration: { from: '1.0.0', to: '1.1.0', strategy: 'additive', reversible: true },
    ...overrides,
  });
}

export interface K_R05_Fixture {
  readonly clock: ManualClock;
  readonly host: HostPlatform;
  readonly probe: TemplateProbePort;
  readonly lifecycle: TemplateLifecycle;
}

export function makeFixture(start = T0): K_R05_Fixture {
  const clock = createManualClock(start);
  const host = baseHost();
  const probe = readyProbe();
  const lifecycle = createTemplateLifecycle({ clock, host, probe });
  return { clock, host, probe, lifecycle };
}

/** 装好 → 启用 → 授权 → task-1 钉住 1.0.0。返回同一个 fixture 便于继续操作。 */
export function installedPinnedFixture(): K_R05_Fixture {
  const fixture = makeFixture();
  const { lifecycle } = fixture;
  lifecycle.install(manifest());
  lifecycle.enable('meituan');
  lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
  lifecycle.pin('task-1', 'meituan');
  return fixture;
}

/** 手工构造一个 `InstalledTemplate` 快照（仅供 03 的自证假探针使用）。 */
export function snapshot(overrides: Partial<InstalledTemplate> = {}): InstalledTemplate {
  return {
    id: 'meituan',
    version: '1.0.0',
    manifest: manifest(),
    installedAt: T0,
    active: true,
    frozen: false,
    uninstalled: false,
    enabled: true,
    grantedPermissions: [],
    pinnedBy: [],
    ...overrides,
  };
}

/** 断言一段同步调用抛错；**没有抛错即判据失败**（避免反例退化成空壳）。 */
export function expectThrow(fn: () => unknown, messageIncludes?: string): Error {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error('期望抛出错误，但调用没有抛错（判据是空壳：该拒的没拒）');
  }
  const error = caught instanceof Error ? caught : new Error(String(caught));
  if (messageIncludes !== undefined && !error.message.includes(messageIncludes)) {
    throw new Error(`期望错误信息包含 ${JSON.stringify(messageIncludes)}，实际是 ${error.message}`);
  }
  return error;
}
