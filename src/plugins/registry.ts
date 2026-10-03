/**
 * 模板平台注册表：安装 / 启用 / 停用 / 卸载的**持久状态**，与**五态能力发现**
 * （design-06 P6 / PLG-02、PLG-04、PLG-06；合同 R228 / R230 / R231 / R233）。
 *
 * ## 五态发现为什么是五态，而不是一个布尔（R231）
 *
 * 「这个模板能不能用」是五个**互相独立**的问题，任何一个为假都不能算可用：
 *
 * 1. `installed` —— 装了吗；
 * 2. `enabled` —— 启了吗（**停用阻止新实例**，R230）；
 * 3. `authorized` —— 授权还有效吗（**撤销即时检查**，每次现读，不缓存，R230）；
 * 4. `dependencies_ready` —— 适配器依赖就绪吗（缺哪个要说得出名字，R228 "依赖缺失可诊断"）；
 * 5. `actually_supported` —— **实测支持**吗（只由注入的探针回答；本层**默认一律为假**，
 *    绝不因为"代码存在"就自称已实测——R233 / R240 的"不编造"精神）。
 *
 * ## R233：未就绪先给原因
 *
 * `not_ready_reasons` **在排序上先于**任何"可用"结论，且**逐条可指认**（哪一态为假、缺哪个依赖）。
 * stub 清单（`implementation === 'stub'`）在发现结果里**始终**带 `stub: true` 与原因。
 *
 * ## 版本固定（R230）
 *
 * `pin()` 把"活跃实例用哪个版本、哪些能力"固化成不可变绑定：**新经验不在执行中途改规则**。
 * 绑定一旦签发，注册表后续的启用/停用/授权变动**不会**改写它（改的是"能否**新建**实例"）。
 *
 * ## 持久状态与重启回归（R228 / R230）
 *
 * `snapshot()` / `restoreSnapshot()` 让启用、授权、版本这些状态**跨重启保留**。
 * `restoreSnapshot` 按 `(plugin_id)` 合并，**取 `updated_at` 更大的一条**：因此一次更晚发生的
 * 卸载**不会**被更早的离线快照"复活"。
 *
 * 纯内存 + 注入探针：零 IO，时间全部由调用方经 `LogicalTime` 传入。
 */

import type { CapabilityId, LogicalTime } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import { PLUGIN_CATALOG, findPluginManifest } from './catalog.js';
import {
  compareVersions,
  type InstallSource,
  type PluginId,
  type PluginManifest,
  type ValidatedPackage,
} from './manifest.js';

// ---------------------------------------------------------------------------
// 注入探针（把"运行期事实"与"本层的判断逻辑"分开）
// ---------------------------------------------------------------------------

/** 适配器就绪探针：由运行环境回答"某个适配器此刻是否可用"。 */
export interface DependencyProbe {
  isAdapterReady(adapter_id: string): boolean;
}

/** 实测支持探针：由真实执行器回答"这个能力是否已被实测支持"。 */
export interface SupportProbe {
  isActuallySupported(plugin_id: string, capability_id: string): boolean;
}

/** 探针集合。**两个都是必填**——不给就说明调用方没打算做真实判断，不应拿到"可用"结论。 */
export interface DiscoveryProbes {
  readonly dependencies: DependencyProbe;
  readonly support: SupportProbe;
}

/** 一个"一律未实测、只认内置适配器"的探针：用于离线 / 未接线场景，产出**保守**结论。 */
export function conservativeProbes(options: { readonly readyAdapters?: readonly string[] } = {}): DiscoveryProbes {
  const ready = new Set(options.readyAdapters ?? []);
  return {
    dependencies: { isAdapterReady: (adapterId) => ready.has(adapterId) },
    support: { isActuallySupported: () => false },
  };
}

// ---------------------------------------------------------------------------
// 持久状态
// ---------------------------------------------------------------------------

/** 一个插件的安装记录（持久状态的一条）。 */
export interface PluginInstallRecord {
  readonly plugin_id: PluginId;
  /** 已安装的**固定版本**（活跃实例按绑定取版本，见 `pin`）。 */
  readonly version: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  /** 授权是否有效。撤权后为 `false`，且**即时**影响后续的新实例判定。 */
  readonly authorized: boolean;
  readonly install_source: InstallSource;
  readonly installed_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

/** 注册表持久快照（可序列化；跨重启保留）。 */
export interface PluginRegistrySnapshot {
  readonly records: readonly PluginInstallRecord[];
  /** 状态版本号（每次变更 +1；供回归测试核对"确实变了"）。 */
  readonly revision: number;
}

export function emptyRegistrySnapshot(): PluginRegistrySnapshot {
  return Object.freeze({ records: Object.freeze([]), revision: 0 });
}

// ---------------------------------------------------------------------------
// 五态发现结果
// ---------------------------------------------------------------------------

/** 一条依赖的诊断结果。 */
export interface DependencyDiagnosis {
  readonly adapter_id: string;
  readonly kind: string;
  readonly required: boolean;
  readonly ready: boolean;
  readonly reason: string;
}

/** 一个插件的五态能力发现结果。 */
export interface CapabilityDiscovery {
  readonly plugin_id: PluginId;
  readonly version: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly dependencies_ready: boolean;
  readonly actually_supported: boolean;
  /** 五态全真才是 `true`。 */
  readonly ready: boolean;
  /** 未就绪原因（R233：**先给原因**；全就绪时为空数组）。 */
  readonly not_ready_reasons: readonly string[];
  readonly stub: boolean;
  readonly stub_reason: string | null;
  /** 逐条依赖诊断（含可选依赖）。 */
  readonly dependencies: readonly DependencyDiagnosis[];
  /** **可用操作清单**（只在 `ready` 时非空；只给标签，不给指令全文，R231）。 */
  readonly available_operations: readonly string[];
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/** 安装结果。 */
export type InstallResult =
  | { readonly ok: true; readonly record: PluginInstallRecord }
  | { readonly ok: false; readonly reason: InstallFailureReason; readonly detail: string };

export const INSTALL_FAILURE_REASONS = [
  'unknown_plugin', // 目录里没有这个插件
  'already_installed', // 已安装
  'source_not_acceptable', // 安装来源不可接受（内置以外必须经包校验）
  'version_incompatible', // 与当前内核不兼容
] as const;
export type InstallFailureReason = (typeof INSTALL_FAILURE_REASONS)[number];

/** 新建实例的判定结果。 */
export type InstanceCreationGate =
  | { readonly ok: true; readonly binding: PluginBinding }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** 活跃实例的固定绑定（R230：执行中途不改规则）。 */
export interface PluginBinding {
  readonly plugin_id: PluginId;
  readonly version: string;
  readonly capability_ids: readonly CapabilityId[];
  readonly pinned_at: LogicalTime;
}

export interface PluginRegistryOptions {
  /** 初始清单（默认真实注册目录）。 */
  readonly manifests?: readonly PluginManifest[];
  /** 当前内核版本（用于安装期兼容性判定）。默认 `0.9.0`。 */
  readonly kernelVersion?: string;
}

/**
 * 模板平台注册表。所有变更都是显式调用，时间由调用方给出（确定性）。
 */
export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly records = new Map<string, PluginInstallRecord>();
  private stateRevision = 0;
  private readonly kernelVersion: string;

  constructor(options: PluginRegistryOptions = {}) {
    for (const manifest of options.manifests ?? PLUGIN_CATALOG) {
      this.manifests.set(manifest.plugin_id, manifest);
    }
    this.kernelVersion = options.kernelVersion ?? '0.9.0';
  }

  /** 注册目录里已知的插件清单（**只读**）。 */
  manifestOf(pluginId: string): PluginManifest | undefined {
    return this.manifests.get(pluginId) ?? findPluginManifest(pluginId);
  }

  /** 当前安装记录（未记载返回 `undefined`，**不编造**）。 */
  recordOf(pluginId: string): PluginInstallRecord | undefined {
    return this.records.get(pluginId);
  }

  listRecords(): readonly PluginInstallRecord[] {
    return Object.freeze([...this.records.values()]);
  }

  /** 当前状态版本号。 */
  get revision(): number {
    return this.stateRevision;
  }

  /**
   * 用**内置来源**安装一个目录中的插件。
   * 声明式包请走 `installFromPackage()`（经 R229 内容校验后的包）。
   */
  install(pluginId: string, options: { readonly at: LogicalTime; readonly source?: InstallSource }): InstallResult {
    const manifest = this.manifestOf(pluginId);
    if (manifest === undefined) {
      return { ok: false, reason: 'unknown_plugin', detail: `注册目录里没有插件 ${pluginId}` };
    }
    const source = options.source ?? { kind: 'builtin' as const, origin: 'builtin' };
    if (source.kind !== 'builtin') {
      return {
        ok: false,
        reason: 'source_not_acceptable',
        detail:
          '非内置来源必须经 validateDeclarativePackage 校验后用 installFromPackage 安装：' +
          '声明式安装不得绕过包内容校验（R229）',
      };
    }
    const existing = this.records.get(pluginId);
    if (existing !== undefined && existing.installed) {
      return { ok: false, reason: 'already_installed', detail: `插件 ${pluginId} 已安装（版本 ${existing.version}）` };
    }
    const compatibility = checkKernelCompatibility(manifest, this.kernelVersion);
    if (!compatibility.compatible) {
      return { ok: false, reason: 'version_incompatible', detail: compatibility.reason ?? '内核不兼容' };
    }

    const record = Object.freeze({
      plugin_id: pluginId as PluginId,
      version: manifest.version,
      installed: true,
      enabled: false, // 安装 ≠ 启用：启用必须显式发生（R228 的三态分开）
      authorized: source.kind === 'builtin', // 内置默认受信；声明式包需另行授权
      install_source: source,
      installed_at: options.at,
      updated_at: options.at,
    });
    this.records.set(pluginId, record);
    this.stateRevision += 1;
    return { ok: true, record };
  }

  /**
   * 从**已通过 R229 校验的声明式包**安装。
   * 包内清单被并入注册目录（受控目录可扩展，PLG-08），初始**未启用、未授权**。
   */
  installFromPackage(pkg: ValidatedPackage, at: LogicalTime): InstallResult {
    const manifest = pkg.manifest;
    this.manifests.set(manifest.plugin_id, manifest);
    const compatibility = checkKernelCompatibility(manifest, this.kernelVersion);
    if (!compatibility.compatible) {
      return { ok: false, reason: 'version_incompatible', detail: compatibility.reason ?? '内核不兼容' };
    }
    const record = Object.freeze({
      plugin_id: manifest.plugin_id,
      version: manifest.version,
      installed: true,
      enabled: false,
      authorized: false, // 声明式包默认未授权
      install_source: Object.freeze({ kind: 'declarative_package' as const, origin: pkg.package_id }),
      installed_at: at,
      updated_at: at,
    });
    this.records.set(manifest.plugin_id, record);
    this.stateRevision += 1;
    return { ok: true, record };
  }

  /** 启用（要求已安装）。 */
  enable(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.patch(pluginId, at, (record) => {
      if (!record.installed) {
        throw new ValidationError(`插件 ${pluginId} 未安装，不能启用`);
      }
      return { ...record, enabled: true };
    });
  }

  /** 停用（R230：**阻止新实例**；活跃实例的既有绑定不受影响）。 */
  disable(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.patch(pluginId, at, (record) => ({ ...record, enabled: false }));
  }

  /** 授权（声明式包启用前必须显式授权）。 */
  authorize(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.patch(pluginId, at, (record) => ({ ...record, authorized: true }));
  }

  /** 撤销授权（R230：**即时**影响后续的新实例判定；不影响已经签发的绑定）。 */
  revokeAuthorization(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.patch(pluginId, at, (record) => ({ ...record, authorized: false }));
  }

  /**
   * 卸载：置为未安装 / 未启用 / 未授权，并保留记录（`updated_at` 前移）。
   * 更晚的卸载在 `restoreSnapshot` 的合并里胜出，**不会被离线快照复活**（R238 的同型纪律）。
   */
  uninstall(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.patch(pluginId, at, (record) => ({
      ...record,
      installed: false,
      enabled: false,
      authorized: false,
    }));
  }

  private patch(
    pluginId: string,
    at: LogicalTime,
    update: (record: PluginInstallRecord) => PluginInstallRecord,
  ): PluginInstallRecord {
    const existing = this.records.get(pluginId);
    if (existing === undefined) {
      throw new ValidationError(`插件 ${pluginId} 没有安装记录：请先 install()`);
    }
    const next = Object.freeze({ ...update(existing), updated_at: at });
    this.records.set(pluginId, next);
    this.stateRevision += 1;
    return next;
  }

  // --- 五态发现 ---

  /** 对一个插件做五态发现。`pluginId` 不在目录里 ⇒ 返回 `undefined`（不编造结论）。 */
  discover(pluginId: string, probes: DiscoveryProbes): CapabilityDiscovery | undefined {
    const manifest = this.manifestOf(pluginId);
    if (manifest === undefined) {
      return undefined;
    }
    return describeDiscovery(manifest, this.records.get(pluginId), probes);
  }

  /** 对**整份注册目录**做五态发现（顺序 = 目录顺序）。 */
  discoverAll(probes: DiscoveryProbes): readonly CapabilityDiscovery[] {
    const result: CapabilityDiscovery[] = [];
    for (const manifest of this.manifests.values()) {
      result.push(describeDiscovery(manifest, this.records.get(manifest.plugin_id), probes));
    }
    return Object.freeze(result);
  }

  /**
   * 供前台主智能体按需读取的**可用操作清单**：只含**就绪**插件的**能力标签**，
   * **不含指令全文**——这正是 R231 "不把全部模板全文塞进上下文"的落点。
   */
  describeAvailableOperations(
    probes: DiscoveryProbes,
  ): readonly { readonly plugin_id: PluginId; readonly capability_id: CapabilityId; readonly label: string }[] {
    const operations: { plugin_id: PluginId; capability_id: CapabilityId; label: string }[] = [];
    for (const manifest of this.manifests.values()) {
      const discovery = describeDiscovery(manifest, this.records.get(manifest.plugin_id), probes);
      if (!discovery.ready) {
        continue;
      }
      for (const capability of manifest.capabilities) {
        operations.push({
          plugin_id: manifest.plugin_id,
          capability_id: capability.capability_id,
          label: capability.label,
        });
      }
    }
    return Object.freeze(operations);
  }

  // --- 版本固定与新建实例闸门 ---

  /**
   * 固化一个活跃实例的绑定（版本 + 能力 ID）。要求该插件**此刻就绪**；
   * 绑定签发后，后续的启用 / 停用 / 授权变动**不会**改写它（R230）。
   */
  pin(pluginId: string, at: LogicalTime, probes: DiscoveryProbes): PluginBinding {
    const gate = this.gateInstanceCreation(pluginId, at, probes);
    if (!gate.ok) {
      throw new ValidationError(`插件 ${pluginId} 当前不可用，不能签发实例绑定：${gate.reasons.join('；')}`);
    }
    return gate.binding;
  }

  /**
   * **新建实例闸门**：停用阻止新实例、撤权即时拒绝（每次都现读记录，不缓存）。
   */
  gateInstanceCreation(pluginId: string, at: LogicalTime, probes: DiscoveryProbes): InstanceCreationGate {
    const manifest = this.manifestOf(pluginId);
    if (manifest === undefined) {
      return { ok: false, reasons: Object.freeze([`注册目录里没有插件 ${pluginId}`]) };
    }
    const discovery = describeDiscovery(manifest, this.records.get(pluginId), probes);
    if (!discovery.ready) {
      return { ok: false, reasons: discovery.not_ready_reasons };
    }
    return {
      ok: true,
      binding: Object.freeze({
        plugin_id: manifest.plugin_id,
        version: manifest.version,
        capability_ids: Object.freeze(manifest.capabilities.map((capability) => capability.capability_id)),
        pinned_at: at,
      }),
    };
  }

  // --- 持久状态 ---

  /** 导出持久快照。 */
  snapshot(): PluginRegistrySnapshot {
    return Object.freeze({ records: this.listRecords(), revision: this.stateRevision });
  }

  /**
   * 从离线快照**合并恢复**：逐插件取 `updated_at` 更大的一条。
   * 因此"更晚的卸载"不会被"更早的快照"复活。合并后状态版本号**只增不减**。
   */
  restoreSnapshot(snapshot: PluginRegistrySnapshot): void {
    for (const incoming of snapshot.records) {
      const current = this.records.get(incoming.plugin_id);
      if (current === undefined || incoming.updated_at > current.updated_at) {
        this.records.set(incoming.plugin_id, Object.freeze({ ...incoming }));
      }
    }
    this.stateRevision = Math.max(this.stateRevision, snapshot.revision) + 1;
  }
}

/** 构造注册表（默认载入真实注册目录）。 */
export function createPluginRegistry(options: PluginRegistryOptions = {}): PluginRegistry {
  return new PluginRegistry(options);
}

// ---------------------------------------------------------------------------
// 纯函数：兼容性与发现
// ---------------------------------------------------------------------------

/** 内核兼容性判定。 */
export function checkKernelCompatibility(
  manifest: PluginManifest,
  kernelVersion: string,
): { readonly compatible: boolean; readonly reason: string | null } {
  const { min_version: min, max_version: max } = manifest.kernel_compatibility;
  if (compareVersions(kernelVersion, min) < 0) {
    return {
      compatible: false,
      reason: `插件 ${manifest.plugin_id} 要求内核 ≥ ${min}，当前 ${kernelVersion}`,
    };
  }
  if (max !== null && compareVersions(kernelVersion, max) > 0) {
    return {
      compatible: false,
      reason: `插件 ${manifest.plugin_id} 要求内核 ≤ ${max}，当前 ${kernelVersion}`,
    };
  }
  return { compatible: true, reason: null };
}

/** 逐条依赖诊断（缺哪个、为什么）。 */
export function diagnoseDependencies(
  manifest: PluginManifest,
  probe: DependencyProbe,
): readonly DependencyDiagnosis[] {
  return Object.freeze(
    manifest.adapter_dependencies.map((dependency) =>
      Object.freeze({
        adapter_id: dependency.adapter_id,
        kind: dependency.kind,
        required: dependency.required,
        ready: probe.isAdapterReady(dependency.adapter_id),
        reason: probe.isAdapterReady(dependency.adapter_id)
          ? `适配器 ${dependency.adapter_id} 就绪`
          : `适配器 ${dependency.adapter_id} 未就绪（${dependency.description}）` +
            (dependency.required ? '，且为必需依赖' : '，为可选依赖'),
      }),
    ),
  );
}

/**
 * 五态发现的核心（纯函数，便于单测直接喂记录）。
 *
 * 未就绪原因**按固定顺序**收集：未安装 → 未启用 → 未授权 → 必需依赖缺失 → 未实测支持 → stub。
 * 任一态为假都会让 `ready` 为假，且**至少给出一条原因**（R233：先给未就绪原因，绝不空口称可用）。
 */
export function describeDiscovery(
  manifest: PluginManifest,
  record: PluginInstallRecord | undefined,
  probes: DiscoveryProbes,
): CapabilityDiscovery {
  const installed = record?.installed ?? false;
  const enabled = record?.enabled ?? false;
  const authorized = record?.authorized ?? false;

  const dependencies = diagnoseDependencies(manifest, probes.dependencies);
  const missingRequired = dependencies.filter((entry) => entry.required && !entry.ready);
  const dependenciesReady = missingRequired.length === 0;

  const unsupported = manifest.capabilities.filter(
    (capability) => !probes.support.isActuallySupported(manifest.plugin_id, capability.capability_id),
  );
  const actuallySupported =
    unsupported.length === 0 && manifest.capabilities.length > 0;

  const stub = manifest.implementation === 'stub';

  const reasons: string[] = [];
  if (!installed) {
    reasons.push(`未安装：插件 ${manifest.plugin_id} 不在已安装记录里`);
  }
  if (installed && !enabled) {
    reasons.push(`未启用：插件 ${manifest.plugin_id} 已安装但被停用（停用阻止新实例，R230）`);
  }
  if (installed && enabled && !authorized) {
    reasons.push(`未授权：插件 ${manifest.plugin_id} 的授权缺失或已被撤销`);
  }
  for (const dependency of missingRequired) {
    reasons.push(`依赖未就绪：${dependency.reason}`);
  }
  if (unsupported.length > 0 && !stub) {
    reasons.push(
      `未实测支持：能力 ${unsupported.map((capability) => capability.capability_id).join(', ')} ` +
        '尚未由真实执行器验证（本层默认不宣称已实测）',
    );
  }
  if (stub) {
    reasons.push(`stub 实现：${manifest.stub_reason ?? '未给出原因'}`);
  }

  // stub **永不**判就绪（R233）：即使探针说"支持"、依赖也齐，桩实现也不得被当作可用模板。
  const ready = installed && enabled && authorized && dependenciesReady && actuallySupported && !stub;

  return Object.freeze({
    plugin_id: manifest.plugin_id,
    version: manifest.version,
    installed,
    enabled,
    authorized,
    dependencies_ready: dependenciesReady,
    actually_supported: actuallySupported,
    ready,
    not_ready_reasons: Object.freeze(reasons),
    stub,
    stub_reason: manifest.stub_reason,
    dependencies,
    available_operations: ready
      ? Object.freeze(manifest.capabilities.map((capability) => capability.label))
      : Object.freeze([]),
  });
}
