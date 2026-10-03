/**
 * K06 夹具：把宿主平台、四条探针、一个标准 manifest 装配好，让每条用例**独立驱动**
 * 生命周期，不依赖真实设备 / 真实时间 / 网络。
 *
 * 反例纪律：`expectTemplateError` / `expectTemplateErrorAsync` 在**没有抛错时主动失败**。
 * 若实现把"该拒的"悄悄改成返回 null，判据就会退化成空壳——这里宁可让用例红。
 */

import {
  createManualClock,
  isTemplateError,
  type HostPlatform,
  type ManualClock,
  type ProbeOutcome,
  type ProbeRequest,
  type TemplateError,
  type TemplateManifest,
  type TemplateProbePort,
} from '../../../apps/mobile-kernel/templates/index.js';

export const T0 = 1_700_000_000_000;

export type ProbeKind = 'installed' | 'enabled' | 'authorized' | 'ports';

/** 标准 manifest：美团模板 1.0.0，两个能力、两个权限，运行时与宿主匹配。 */
export function baseManifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    id: 'meituan',
    displayName: '美团下单模板',
    version: '1.0.0',
    capabilities: ['order.place', 'order.read'],
    schemas: ['mobile-v1/external-receipt'],
    permissions: ['network', 'external-order'],
    runtimeCompatibility: {
      os: 'android',
      minimumOs: 26,
      runtimes: ['quickjs'],
      abis: ['arm64-v8a'],
    },
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

/** 标准宿主：API 34、有 quickjs/node、arm64、能力覆盖 baseManifest 的两个能力。 */
export function baseHost(overrides: Partial<HostPlatform> = {}): HostPlatform {
  return {
    os: 'android',
    apiLevel: 34,
    runtimes: ['quickjs', 'node'],
    abis: ['arm64-v8a'],
    capabilities: ['order.place', 'order.read'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 探针夹具（四条读回路径各自可配，并记录每次请求）
// ---------------------------------------------------------------------------

export interface FixtureProbe extends TemplateProbePort {
  readonly calls: Record<ProbeKind, ProbeRequest[]>;
  setOutcome(kind: ProbeKind, outcome: ProbeOutcome): void;
}

export function fixtureProbe(
  overrides: Partial<Record<ProbeKind, ProbeOutcome>> = {},
): FixtureProbe {
  const outcomes: Record<ProbeKind, ProbeOutcome> = {
    installed: { ok: true, evidenceRef: 'evidence://probe/installed' },
    enabled: { ok: true, evidenceRef: 'evidence://probe/enabled' },
    authorized: { ok: true, evidenceRef: 'evidence://probe/authorized' },
    ports: { ok: true, evidenceRef: 'evidence://probe/ports' },
    ...overrides,
  };
  const calls: Record<ProbeKind, ProbeRequest[]> = {
    installed: [],
    enabled: [],
    authorized: [],
    ports: [],
  };
  const invoke = (kind: ProbeKind, request: ProbeRequest): ProbeOutcome => {
    calls[kind].push(request);
    return outcomes[kind];
  };
  return {
    identity: 'fixture.probe',
    calls,
    setOutcome(kind: ProbeKind, outcome: ProbeOutcome) {
      outcomes[kind] = outcome;
    },
    probeInstalled: (request) => invoke('installed', request),
    probeEnabled: (request) => invoke('enabled', request),
    probeAuthorized: (request) => invoke('authorized', request),
    probePorts: (request) => invoke('ports', request),
  };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export interface K06Fixture {
  readonly clock: ManualClock;
  readonly host: HostPlatform;
  readonly probe: FixtureProbe;
  /** 状态迁移事件（`kind:id@version`），由用例在装配生命周期时收集。 */
  readonly transitions: string[];
}

export function makeFixture(
  options: {
    readonly host?: Partial<HostPlatform>;
    readonly probe?: Partial<Record<ProbeKind, ProbeOutcome>>;
    readonly start?: number;
  } = {},
): K06Fixture {
  return {
    clock: createManualClock(options.start ?? T0),
    host: baseHost(options.host),
    probe: fixtureProbe(options.probe),
    transitions: [],
  };
}

// ---------------------------------------------------------------------------
// 反例断言：**没有抛错就是失败**
// ---------------------------------------------------------------------------

function describeCaught(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  return String(value);
}

export function expectTemplateError(fn: () => unknown, code: string, field?: string): TemplateError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出错误码 ${code}，但调用没有抛错（判据是空壳：该拒的没拒）`);
  }
  if (!isTemplateError(caught)) {
    throw new Error(`期望 TemplateError(${code})，实际收到 ${describeCaught(caught)}`);
  }
  const error = caught as TemplateError;
  if (error.code !== code) {
    throw new Error(`期望错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  if (field !== undefined && error.field !== field) {
    throw new Error(`期望拒因字段 ${field}，实际是 ${String(error.field)}：${error.message}`);
  }
  return error;
}
