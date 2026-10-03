/**
 * K-I01 集成夹具：装配真实的 `TemplateLifecycle`（K06 产品实现）+ 确定性时钟 + 恒就绪探针。
 *
 * 本包是"保留期记账"集成单元：只驱动生命周期（安装 / 钉住 / 升级 / 卸载 / 重装），
 * 不审计探针本身（那归 K06）。全部结论来自对真实实现的**读回**，不用 mock 顶替状态机。
 */

import {
  createManualClock,
  createTemplateLifecycle,
  isTemplateError,
  type HostPlatform,
  type ManualClock,
  type TemplateError,
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

/** 恒就绪探针：本包只算生命周期记账，不验探针。 */
export function readyProbe(): TemplateProbePort {
  return {
    identity: 'k-i01.ready-probe',
    probeInstalled: () => ({ ok: true, evidenceRef: 'evidence://probe/installed' }),
    probeEnabled: () => ({ ok: true, evidenceRef: 'evidence://probe/enabled' }),
    probeAuthorized: () => ({ ok: true, evidenceRef: 'evidence://probe/authorized' }),
    probePorts: () => ({ ok: true, evidenceRef: 'evidence://probe/ports' }),
  };
}

/** 美团模板 1.0.0：与 baseHost 匹配的运行时 + 两能力两权限。 */
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

export interface K_I01_Fixture {
  readonly clock: ManualClock;
  readonly host: HostPlatform;
  readonly probe: TemplateProbePort;
  readonly lifecycle: TemplateLifecycle;
}

export function makeFixture(start = T0): K_I01_Fixture {
  const clock = createManualClock(start);
  const host = baseHost();
  const probe = readyProbe();
  const lifecycle = createTemplateLifecycle({ clock, host, probe });
  return { clock, host, probe, lifecycle };
}

/** 装好 → 启用 → 授权 → task-1 钉住 1.0.0。 */
export function installedPinnedFixture(): K_I01_Fixture {
  const fixture = makeFixture();
  const { lifecycle } = fixture;
  lifecycle.install(manifest());
  lifecycle.enable('meituan');
  lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
  lifecycle.pin('task-1', 'meituan');
  return fixture;
}

/**
 * 断言一段同步调用抛出 `TemplateError`，返回它供逐项核对 `code`。
 * **没有抛错即判据失败**（避免反例退化成空壳）。
 */
export function captureTemplateError(fn: () => unknown): TemplateError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error('期望抛出 TemplateError，但调用没有抛错（判据是空壳：该拒的没拒）');
  }
  if (!isTemplateError(caught)) {
    throw new Error(`期望 TemplateError，实际收到 ${String(caught)}`);
  }
  return caught;
}
