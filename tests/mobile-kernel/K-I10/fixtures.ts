/**
 * K-I10 夹具：装配 ①合成的 manifest + 就绪报告（纯投影用例）与 ②**真实** K06 七模板生命周期
 * （`install → enable → authorize` 走真实现，探针为夹具，因为本机无真机）。
 *
 * 反例纪律：`expectDispatchError` / `expectRejects` 在没有抛错 / 没有拒绝时**主动失败**，
 * 避免"该拒的没拒"悄悄变绿。
 */

import { expect } from 'vitest';

import {
  identityInstanceId,
  isDispatchError,
  planDispatch,
  type DispatchErrorCode,
  type DispatchPlan,
  type SubtaskSpec,
  type TaskSplit,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import {
  createManualClock,
  createTemplateLifecycle,
  type Clock,
  type HostPlatform,
  type ManualClock,
  type ProbeOutcome,
  type ProbeRequest,
  type ReadinessReport,
  type ReadinessStateName,
  type StateReport,
  type TemplateLifecycle,
  type TemplateManifest,
  type TemplateProbePort,
} from '../../../apps/mobile-kernel/templates/index.js';
import { TEMPLATE_MANIFESTS } from '../../../apps/mobile-kernel/templates/index.js';
import type { TemplateReadinessSnapshot } from '../../../apps/mobile-kernel/adapters/capability-discovery/index.js';

export const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 合成 manifest（纯投影用例；与真实目录无关）
// ---------------------------------------------------------------------------

export function syntheticManifest(
  id: string,
  capabilities: readonly string[],
  version = '1.0.0',
): TemplateManifest {
  return {
    id,
    displayName: `${id} 模板`,
    version,
    capabilities: [...capabilities],
    schemas: ['command.schema.json'],
    permissions: ['storage'],
    runtimeCompatibility: { os: 'android', minimumOs: 26, runtimes: ['quickjs'], abis: ['arm64-v8a'] },
    migration: { from: '', to: version, strategy: 'none', reversible: true },
    // manifest 自称的 probe 布尔**不参与**本层判定；投影只读就绪报告。
    probe: {
      installed: false,
      enabled: false,
      authorized: false,
      portReady: false,
      verificationMode: 'fixture',
      layers: ['unit', 'contract'],
    },
  };
}

// ---------------------------------------------------------------------------
// 就绪报告构造器
// ---------------------------------------------------------------------------

export function readyState(evidenceRef = 'evidence://probe/ok'): StateReport {
  return { state: 'ready', reason: null, evidenceRef, checkedAt: T0 };
}

export function blockedState(reason: string): StateReport {
  return { state: 'not-ready', reason, evidenceRef: null, checkedAt: T0 };
}

export function readiness(
  overrides: Partial<Record<ReadinessStateName, StateReport>> = {},
  id = 'tpl',
  version = '1.0.0',
): ReadinessReport {
  return {
    id,
    version,
    installed: readyState(),
    enabled: readyState(),
    authorized: readyState(),
    portReady: readyState(),
    ...overrides,
  };
}

/** 一条快照：有探针报告。 */
export function snapshot(
  manifest: TemplateManifest,
  report: ReadinessReport | null,
): TemplateReadinessSnapshot {
  return { manifest, readiness: report };
}

/** 一条**缺席**快照：宿主没有任何该模板的安装版本。 */
export function absentSnapshot(manifest: TemplateManifest): TemplateReadinessSnapshot {
  return { manifest, readiness: null };
}

// ---------------------------------------------------------------------------
// 探针夹具（供真实 K06 生命周期使用）
// ---------------------------------------------------------------------------

export type ProbeKind = 'installed' | 'enabled' | 'authorized' | 'ports';

export interface FixtureProbe extends TemplateProbePort {
  readonly calls: Record<ProbeKind, ProbeRequest[]>;
  setOutcome(kind: ProbeKind, outcome: ProbeOutcome): void;
}

export function makeProbe(overrides: Partial<Record<ProbeKind, ProbeOutcome>> = {}): FixtureProbe {
  const outcomes: Record<ProbeKind, ProbeOutcome> = {
    installed: { ok: true, evidenceRef: 'evidence://probe/installed' },
    enabled: { ok: true, evidenceRef: 'evidence://probe/enabled' },
    authorized: { ok: true, evidenceRef: 'evidence://probe/authorized' },
    ports: { ok: true, evidenceRef: 'evidence://probe/ports' },
    ...overrides,
  };
  const calls: Record<ProbeKind, ProbeRequest[]> = { installed: [], enabled: [], authorized: [], ports: [] };
  const invoke = (kind: ProbeKind, request: ProbeRequest): ProbeOutcome => {
    calls[kind].push(request);
    return outcomes[kind];
  };
  return {
    identity: 'fixture.probe',
    calls,
    setOutcome(kind, outcome) {
      outcomes[kind] = outcome;
    },
    probeInstalled: (request) => invoke('installed', request),
    probeEnabled: (request) => invoke('enabled', request),
    probeAuthorized: (request) => invoke('authorized', request),
    probePorts: (request) => invoke('ports', request),
  };
}

// ---------------------------------------------------------------------------
// 真实 K06 七模板生命周期装配
// ---------------------------------------------------------------------------

export interface SevenTemplateFixture {
  readonly manifests: readonly TemplateManifest[];
  /** 全部模板声明的能力（去重后顺序稳定）。 */
  readonly allCapabilities: readonly string[];
  /** capability_id → 声明它的模板 id（真实目录里能力不撞名）。 */
  readonly capabilityToTemplate: ReadonlyMap<string, string>;
  readonly lifecycle: TemplateLifecycle;
  readonly clock: ManualClock;
  readonly host: HostPlatform;
  readonly probe: FixtureProbe;
}

export interface SevenTemplateOptions {
  /** 默认全部 7 个都装。 */
  readonly installedIds?: readonly string[];
  /** 默认全部已装模板都授权。 */
  readonly authorizedIds?: readonly string[];
  /** 安装后停用的模板 id（默认无）。 */
  readonly disabledIds?: readonly string[];
  /** 宿主实际具备的能力（默认覆盖全部模板声明的能力）。 */
  readonly hostCapabilities?: readonly string[];
}

export function buildSevenTemplateLifecycle(options: SevenTemplateOptions = {}): SevenTemplateFixture {
  const manifests = TEMPLATE_MANIFESTS;
  const allCapabilities = [...new Set(manifests.flatMap((manifest) => [...manifest.capabilities]))];
  const capabilityToTemplate = new Map<string, string>();
  for (const manifest of manifests) {
    for (const capability of manifest.capabilities) {
      if (!capabilityToTemplate.has(capability)) {
        capabilityToTemplate.set(capability, manifest.id);
      }
    }
  }

  const clock = createManualClock(T0);
  const host: HostPlatform = {
    os: 'android',
    apiLevel: 34,
    runtimes: ['quickjs'],
    abis: ['arm64-v8a'],
    capabilities: [...(options.hostCapabilities ?? allCapabilities)],
  };
  const probe = makeProbe();
  const lifecycle = createTemplateLifecycle({ clock, host, probe });

  const installed = new Set(options.installedIds ?? manifests.map((manifest) => manifest.id));
  const authorized = new Set(options.authorizedIds ?? [...installed]);
  const disabled = new Set(options.disabledIds ?? []);

  for (const manifest of manifests) {
    if (!installed.has(manifest.id)) {
      continue;
    }
    lifecycle.install(manifest);
    lifecycle.enable(manifest.id);
    if (authorized.has(manifest.id)) {
      lifecycle.authorize(manifest.id, undefined, manifest.permissions);
    }
  }
  for (const id of disabled) {
    if (installed.has(id)) {
      lifecycle.disable(id);
    }
  }

  return { manifests, allCapabilities, capabilityToTemplate, lifecycle, clock, host, probe };
}

// ---------------------------------------------------------------------------
// 派发夹具（对账 K05 阻塞原因 —— K05 的实际判定才是判据）
// ---------------------------------------------------------------------------

export function spec(
  id: string,
  capability_id: string,
  depends_on: readonly string[] = [],
): SubtaskSpec {
  return { id, goal: `do ${id}`, capability_id, depends_on };
}

export function split(goal: string, subtasks: readonly SubtaskSpec[]): TaskSplit {
  return { goal, subtasks };
}

export interface PlanOptions {
  readonly task_id?: string;
  readonly group_id?: string;
  readonly max_parallel?: number;
  readonly discovery: import('../../../apps/mobile-kernel/dispatch/index.js').CapabilityDiscoveryPort;
  readonly start_at?: number;
}

export function planOf(input: TaskSplit, options: PlanOptions): DispatchPlan {
  return planDispatch({
    task_id: options.task_id ?? 'task-1',
    split: input,
    discovery: options.discovery,
    max_parallel: options.max_parallel ?? 4,
    clock: createManualClock(options.start_at ?? T0),
    group_id: options.group_id ?? 'grp-1',
    instance_id_for: identityInstanceId,
  });
}

/** 断言抛出的是带指定 code 的 DispatchError（没抛即失败）。 */
export function expectDispatchError(fn: () => unknown, code: DispatchErrorCode): unknown {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望抛出 DispatchError(${code})，实际没有抛出`).toBeDefined();
  expect(isDispatchError(caught), `抛出的不是 DispatchError：${String(caught)}`).toBe(true);
  if (isDispatchError(caught)) {
    expect(caught.code).toBe(code);
  }
  return caught;
}

/** 断言 Promise 被拒绝（没拒绝即失败）。 */
export async function expectRejects(promise: Promise<unknown>, message: string): Promise<unknown> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    caught = error;
    rejected = true;
  }
  expect(rejected, message).toBe(true);
  return caught;
}

/** 一个极简时钟（供假读回源用；不读墙钟）。 */
export function fixedClock(value: number): Clock {
  return { now: () => value };
}
