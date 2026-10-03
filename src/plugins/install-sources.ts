/**
 * PLG-01 / PLG-02 / PLG-07：**安装来源目录**、**安装/启用/停用/卸载入口与持久状态**、
 * **模板 / 工具 / 文件格式分层**（design-06 P6；合同 R227 / R228 / R232）。
 *
 * ## PLG-01：七个业务模板的**真实清单**（不是名字，也不是 prompt）
 *
 * `TEMPLATE_INVENTORY` 逐条给出每个模板的版本、内核兼容、能力、指令条数、输入输出端口、
 * 必需 / 可选适配器依赖、权限、数据范围、经验策略、产出 / 读取格式、实现标记。
 * 这些值**派生自** `catalog.ts` 的真清单（单一来源），本层**不另抄一份**。
 *
 * ## PLG-02：安装来源与**持久状态**
 *
 * `REGISTERED_INSTALL_SOURCES` 列出每个插件此刻的安装来源；`InstallSourceManager` 把
 * `PluginRegistry` 的 install / enable / disable / uninstall **入口**接到一个可替换的
 * `InstallStateStore` 上，让启用、授权、版本这些状态**跨重启保留**（`persist()` / `reload()`）。
 *
 * ## PLG-07：模板、**工具**与**文件格式**分开建模（R232）
 *
 * 三个命名空间**正交**，互不包含：
 *
 * | 命名空间 | 取值 | 谁在用 |
 * |---|---|---|
 * | 文件格式 `FILE_FORMAT_KINDS` | `docx` / `xlsx` / `pptx` | protocol 的唯一来源 |
 * | 工具 `TOOL_MODEL_IDS` | `tool.meituan` / `tool.clock` / `tool.calendar` / `tool.research` | 外部动作 / 能力 |
 * | 模板 `BUSINESS_TEMPLATE_IDS` | 七个 `template.*` | 能力单元 |
 * | 角色 `BASE_ROLE_IDS` | 三个 `role.*` | 运行时身份 |
 *
 * **美团 / 时钟 / 日历 / 资料检索是工具，不是文件格式**：它们**永不**出现在
 * `FILE_FORMAT_KINDS` 里。`assertNamespacesDisjoint()` 把这条纪律变成运行时断言。
 *
 * ## 「只有名字或 prompt 不算模板可用」（R228）
 *
 * `evaluateTemplateUsability()` 对一份**可能不完整**的清单做体检：缺能力 / 缺端口 / 缺指令
 * 一律**不可用**并**逐条给原因**，杜绝"起了个名字就算有了模板"。
 *
 * 纯内存 + 注入的存储与探针：零 IO、不含墙钟与随机数。
 */

import type { CapabilityId, LogicalTime } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import {
  BASE_ROLE_IDS,
  BUSINESS_TEMPLATE_IDS,
  FILE_FORMAT_KINDS,
  type BusinessTemplateId,
  type BusinessTemplateManifest,
  type DataScopeLevel,
  type ExperienceStrategy,
  type Implementation,
  type InstallSource,
  type InstallSourceKind,
  type KernelCompatibility,
  type PluginId,
  type PluginKind,
  type PluginManifest,
} from './manifest.js';
import { BASE_ROLES, BUSINESS_TEMPLATES, findPluginManifest } from './catalog.js';
import {
  createPluginRegistry,
  diagnoseDependencies,
  emptyRegistrySnapshot,
  type DependencyDiagnosis,
  type DependencyProbe,
  type InstallResult,
  type PluginInstallRecord,
  type PluginRegistry,
  type PluginRegistrySnapshot,
} from './registry.js';
import {
  validateDeclarativePackageForInstall,
  type PackageValidationIssue,
  type PackageValidationOptions,
  type StrictValidatedPackage,
} from './declarative-package.js';

// ---------------------------------------------------------------------------
// PLG-07：命名空间分层（模板 / 工具 / 文件格式 / 角色）
// ---------------------------------------------------------------------------

/** 四个正交的建模层（顺序即分层说明顺序）。 */
export const PLUGIN_MODELLING_LAYERS = ['file_format', 'tool', 'business_template', 'base_role'] as const;
export type PluginModellingLayer = (typeof PLUGIN_MODELLING_LAYERS)[number];

/**
 * **文件格式命名空间**——直接就是 `manifest.FILE_FORMAT_KINDS`（其唯一来源是 protocol）。
 * 只有 `docx` / `xlsx` / `pptx`。
 */
export const FILE_FORMAT_NAMESPACE: readonly string[] = FILE_FORMAT_KINDS;

/**
 * **工具命名空间**——外部动作 / 能力单元（不是文件格式，也不是模板）。
 * 美团 / 时钟 / 日历 / 资料检索四个**工具**在此，**永不**进文件类型枚举（R232）。
 */
export const TOOL_MODEL_IDS = ['tool.meituan', 'tool.clock', 'tool.calendar', 'tool.research'] as const;
export type ToolModelId = (typeof TOOL_MODEL_IDS)[number];

/** 工具的关键词（用于断言"它们不是文件格式"这类反向对照）。 */
export const TOOL_KEYWORDS = ['meituan', 'clock', 'calendar', 'research'] as const;

/** 是否是文件格式名（`docx` / `xlsx` / `pptx`）。工具名一律为 `false`。 */
export function isFileFormatName(value: unknown): boolean {
  return typeof value === 'string' && (FILE_FORMAT_NAMESPACE as readonly string[]).includes(value);
}

/** 是否是工具模型 id。 */
export function isToolModelId(value: unknown): value is ToolModelId {
  return typeof value === 'string' && (TOOL_MODEL_IDS as readonly string[]).includes(value);
}

/** 某个名字落在哪些命名空间里（可能为空——既不是格式、工具，也不是模板 / 角色）。 */
export function classifyModelName(value: unknown): readonly PluginModellingLayer[] {
  if (typeof value !== 'string') return Object.freeze([]);
  const layers: PluginModellingLayer[] = [];
  if (isFileFormatName(value)) layers.push('file_format');
  if (isToolModelId(value)) layers.push('tool');
  if ((BUSINESS_TEMPLATE_IDS as readonly string[]).includes(value)) layers.push('business_template');
  if ((BASE_ROLE_IDS as readonly string[]).includes(value)) layers.push('base_role');
  return Object.freeze(layers);
}

/** 同时落在**多于一个**命名空间里的名字（正常应为空——R232 要求三者正交）。 */
export function findNamespaceOverlaps(): readonly string[] {
  const names = new Set<string>([...FILE_FORMAT_NAMESPACE, ...TOOL_MODEL_IDS, ...BUSINESS_TEMPLATE_IDS, ...BASE_ROLE_IDS]);
  const overlaps: string[] = [];
  for (const name of names) {
    if (classifyModelName(name).length > 1) {
      overlaps.push(name);
    }
  }
  return Object.freeze(overlaps);
}

/**
 * **R232 的运行时守卫**：模板 / 工具 / 文件格式必须正交，任何名字不得跨两个命名空间。
 *
 * @throws {ValidationError} 存在跨命名空间重名（例如有人把 `meituan` 塞进了文件类型枚举）。
 */
export function assertNamespacesDisjoint(): void {
  const overlaps = findNamespaceOverlaps();
  if (overlaps.length > 0) {
    throw new ValidationError(
      `模板 / 工具 / 文件格式必须分开建模（R232）：名字 ${overlaps.join('、')} 同时落在多个命名空间`,
    );
  }
}

// ---------------------------------------------------------------------------
// PLG-01：七个业务模板的真实清单
// ---------------------------------------------------------------------------

/** 模板与工具的绑定（工具是独立命名空间；办公模板用的是**内置构建器**，不是工具）。 */
const TEMPLATE_TOOL_BINDINGS: Readonly<Record<string, readonly ToolModelId[]>> = Object.freeze({
  'template.meituan': Object.freeze(['tool.meituan'] as const),
  'template.clock': Object.freeze(['tool.clock'] as const),
  'template.calendar': Object.freeze(['tool.calendar'] as const),
  'template.research': Object.freeze(['tool.research'] as const),
});

function toolModelsOf(pluginId: string): readonly ToolModelId[] {
  return TEMPLATE_TOOL_BINDINGS[pluginId] ?? Object.freeze([]);
}

/** 一个业务模板的完整清单投影（PLG-01 的逐项字段）。 */
export interface TemplateInventorySource {
  readonly plugin_id: BusinessTemplateId;
  readonly display_name: string;
  readonly version: string;
  readonly kernel_compatibility: KernelCompatibility;
  readonly capability_ids: readonly CapabilityId[];
  readonly instruction_count: number;
  readonly input_ports: readonly string[];
  readonly output_ports: readonly string[];
  readonly required_adapter_ids: readonly string[];
  readonly optional_adapter_ids: readonly string[];
  readonly permission_ids: readonly string[];
  readonly data_scope_level: DataScopeLevel;
  readonly experience_strategy: ExperienceStrategy;
  /** 产出文件格式（只可能是 `docx` / `xlsx` / `pptx` 的子集）。 */
  readonly produces_file_formats: readonly string[];
  /** 读取的资料格式（自由字符串，**不是**文件类型枚举）。 */
  readonly consumes_formats: readonly string[];
  /** 绑定的**工具**（独立命名空间）。 */
  readonly tool_models: readonly ToolModelId[];
  readonly install_source_kind: InstallSourceKind;
  readonly implementation: Implementation;
  readonly is_stub: boolean;
}

function projectTemplate(manifest: BusinessTemplateManifest): TemplateInventorySource {
  return Object.freeze({
    plugin_id: manifest.plugin_id,
    display_name: manifest.display_name,
    version: manifest.version,
    kernel_compatibility: manifest.kernel_compatibility,
    capability_ids: Object.freeze(manifest.capabilities.map((capability) => capability.capability_id)),
    instruction_count: manifest.instructions.length,
    input_ports: Object.freeze(manifest.inputs.map((port) => port.name)),
    output_ports: Object.freeze(manifest.outputs.map((port) => port.name)),
    required_adapter_ids: Object.freeze(
      manifest.adapter_dependencies.filter((dependency) => dependency.required).map((dependency) => dependency.adapter_id),
    ),
    optional_adapter_ids: Object.freeze(
      manifest.adapter_dependencies.filter((dependency) => !dependency.required).map((dependency) => dependency.adapter_id),
    ),
    permission_ids: Object.freeze(manifest.permissions.map((permission) => permission.permission_id)),
    data_scope_level: manifest.data_scope.level,
    experience_strategy: manifest.experience_policy.strategy,
    produces_file_formats: manifest.produces_file_formats,
    consumes_formats: manifest.consumes_formats,
    tool_models: toolModelsOf(manifest.plugin_id),
    install_source_kind: manifest.install_source.kind,
    implementation: manifest.implementation,
    is_stub: manifest.implementation === 'stub',
  });
}

/** 七个业务模板的完整清单（顺序 = 注册目录顺序）。 */
export const TEMPLATE_INVENTORY: readonly TemplateInventorySource[] = Object.freeze(
  BUSINESS_TEMPLATES.map(projectTemplate),
);

/** 按 id 取模板清单投影（查不到返回 `undefined`，不编造）。 */
export function getTemplateInventory(pluginId: string): TemplateInventorySource | undefined {
  return TEMPLATE_INVENTORY.find((entry) => entry.plugin_id === pluginId);
}

// ---------------------------------------------------------------------------
// PLG-02：安装来源目录
// ---------------------------------------------------------------------------

/** 一条安装来源记录（插件此刻的来源 + 清单版本）。 */
export interface RegisteredInstallSource {
  readonly plugin_id: PluginId;
  readonly kind: PluginKind;
  readonly version: string;
  readonly install_source: InstallSource;
  readonly is_stub: boolean;
}

function toInstallSourceEntry(manifest: PluginManifest): RegisteredInstallSource {
  return Object.freeze({
    plugin_id: manifest.plugin_id,
    kind: manifest.kind,
    version: manifest.version,
    install_source: manifest.install_source,
    is_stub: manifest.implementation === 'stub',
  });
}

/** 注册目录里每个插件的安装来源（七个业务模板 + 三个基础角色）。 */
export const REGISTERED_INSTALL_SOURCES: readonly RegisteredInstallSource[] = Object.freeze([
  ...BUSINESS_TEMPLATES.map(toInstallSourceEntry),
  ...BASE_ROLES.map(toInstallSourceEntry),
]);

/** 按 id 取安装来源记录。 */
export function findInstallSource(pluginId: string): RegisteredInstallSource | undefined {
  return REGISTERED_INSTALL_SOURCES.find((entry) => entry.plugin_id === pluginId);
}

/** 七个业务模板的安装来源（顺序 = 部分 = 目录顺序）。 */
export function listBusinessTemplateSources(): readonly RegisteredInstallSource[] {
  return Object.freeze(REGISTERED_INSTALL_SOURCES.filter((entry) => entry.kind === 'business_template'));
}

// ---------------------------------------------------------------------------
// PLG-07 / R228：模板可用性体检与依赖诊断
// ---------------------------------------------------------------------------

/** 一份清单的可用性体检结果。 */
export interface TemplateUsability {
  readonly usable: boolean;
  /** 是否只是"起了个名字 / 写了段 prompt"，却没有可执行的能力与端口（R228）。 */
  readonly name_only: boolean;
  readonly reasons: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNamedEntries(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => isPlainObject(entry) && typeof entry.name === 'string' && entry.name.length > 0);
}

function hasCapabilityIds(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => isPlainObject(entry) && typeof entry.capability_id === 'string' && entry.capability_id.length > 0)
  );
}

/**
 * **R228 的体检**：一份清单是不是"真模板"。
 *
 * 只有名字 / prompt 的写法（缺能力、缺端口、缺指令）一律 `usable: false` 并**逐条给原因**；
 * 反向对照：注册目录里的真清单 `usable: true`、原因为空。
 */
export function evaluateTemplateUsability(raw: unknown): TemplateUsability {
  if (!isPlainObject(raw)) {
    return Object.freeze({
      usable: false,
      name_only: true,
      reasons: Object.freeze(['不是清单对象：只有名字或 prompt 不算模板可用（R228）']),
    });
  }

  const reasons: string[] = [];
  const missingCapabilities = !hasCapabilityIds(raw.capabilities);
  const missingPorts = !hasNamedEntries(raw.inputs) && !hasNamedEntries(raw.outputs);
  const missingInstructions = !(Array.isArray(raw.instructions) && raw.instructions.length > 0);
  const missingVersion = typeof raw.version !== 'string' || raw.version.length === 0;

  if (missingCapabilities) {
    reasons.push('缺可发现的能力 ID（capabilities 为空或每条都缺 capability_id）：只有名字或 prompt 不算模板可用（R228）');
  }
  if (missingPorts) {
    reasons.push('缺输入 / 输出端口：没有输入输出的"模板"无法接线（R228）');
  }
  if (missingInstructions) {
    reasons.push('缺可执行的指令声明（R227）');
  }
  if (missingVersion) {
    reasons.push('缺版本号：无法做内核兼容判定（R227）');
  }

  const nameOnly = missingCapabilities && missingPorts && (missingInstructions || missingVersion);
  return Object.freeze({ usable: reasons.length === 0, name_only: nameOnly, reasons: Object.freeze(reasons) });
}

/** 依赖诊断报告（缺哪个、为什么，逐条具名）。 */
export interface TemplateDependencyReport {
  readonly plugin_id: string;
  readonly dependencies: readonly DependencyDiagnosis[];
  readonly required_adapter_ids: readonly string[];
  readonly missing_required: readonly DependencyDiagnosis[];
  readonly missing_optional: readonly DependencyDiagnosis[];
  readonly dependencies_ready: boolean;
  readonly summary: string;
}

/** 对一份清单做**可诊断**的依赖体检：缺失的每一个依赖都带名字与原因（R228）。 */
export function diagnoseTemplateDependencies(
  manifest: PluginManifest,
  probe: DependencyProbe,
): TemplateDependencyReport {
  const dependencies = diagnoseDependencies(manifest, probe);
  const missingRequired = dependencies.filter((entry) => entry.required && !entry.ready);
  const missingOptional = dependencies.filter((entry) => !entry.required && !entry.ready);
  const ready = missingRequired.length === 0;
  return Object.freeze({
    plugin_id: manifest.plugin_id,
    dependencies,
    required_adapter_ids: Object.freeze(
      manifest.adapter_dependencies.filter((dependency) => dependency.required).map((dependency) => dependency.adapter_id),
    ),
    missing_required: Object.freeze(missingRequired),
    missing_optional: Object.freeze(missingOptional),
    dependencies_ready: ready,
    summary: ready
      ? '必需适配器依赖全部就绪'
      : `缺少必需依赖：${missingRequired.map((entry) => entry.adapter_id).join('、')}`,
  });
}

/** 模板的综合可用性（"是不是真模板" + "依赖齐不齐"）。 */
export interface TemplateAvailability {
  readonly plugin_id: string;
  readonly usable: boolean;
  readonly dependencies_ready: boolean;
  readonly missing_required_adapter_ids: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * 把 `evaluateTemplateUsability` 与 `diagnoseTemplateDependencies` 合成一个可用性结论：
 * 任一为假即不可用，且**先给原因**、逐条具名。
 */
export function evaluateTemplateAvailability(
  manifest: PluginManifest,
  probe: DependencyProbe,
): TemplateAvailability {
  const usability = evaluateTemplateUsability(manifest);
  const dependencies = diagnoseTemplateDependencies(manifest, probe);
  const reasons = [...usability.reasons, ...dependencies.missing_required.map((entry) => entry.reason)];
  return Object.freeze({
    plugin_id: manifest.plugin_id,
    usable: usability.usable && dependencies.dependencies_ready,
    dependencies_ready: dependencies.dependencies_ready,
    missing_required_adapter_ids: Object.freeze(dependencies.missing_required.map((entry) => entry.adapter_id)),
    reasons: Object.freeze(reasons),
  });
}

// ---------------------------------------------------------------------------
// PLG-02：安装状态持久化
// ---------------------------------------------------------------------------

/** 安装状态的持久存储（注入式；本层不绑任何具体介质，零 IO）。 */
export interface InstallStateStore {
  save(snapshot: PluginRegistrySnapshot): void;
  load(): PluginRegistrySnapshot | undefined;
}

/** 内存实现（测试 / 无持久介质的运行环境用）。 */
export function createMemoryInstallStateStore(initial?: PluginRegistrySnapshot): InstallStateStore {
  let stored: PluginRegistrySnapshot | undefined = initial;
  return {
    save(snapshot) {
      stored = snapshot;
    },
    load() {
      return stored;
    },
  };
}

/** 声明式包安装结果（校验失败时不落任何状态）。 */
export type DeclarativeInstallResult =
  | { readonly ok: true; readonly record: PluginInstallRecord }
  | { readonly ok: false; readonly issues: readonly PackageValidationIssue[] };

export interface InstallSourceManagerOptions {
  readonly registry?: PluginRegistry;
  readonly store?: InstallStateStore;
  readonly kernelVersion?: string;
  readonly manifests?: readonly PluginManifest[];
}

/**
 * **安装来源管理器**：把 install / enable / disable / uninstall **入口**与持久状态接起来。
 *
 * - `install()` 只从**内置来源**装目录中的插件；
 * - `installDeclarativePackage()` 先过 PLG-03 严格校验，**校验失败一个字节都不落**；
 * - `persist()` / `reload()` 让启用、授权、版本跨重启保留；空存储 `reload()` 返回 `false`
 *   且**不编造**任何记录。
 */
export class InstallSourceManager {
  private readonly registry: PluginRegistry;
  private readonly store: InstallStateStore;

  constructor(options: InstallSourceManagerOptions = {}) {
    this.registry = options.registry ?? createPluginRegistry({
      kernelVersion: options.kernelVersion,
      manifests: options.manifests,
    });
    this.store = options.store ?? createMemoryInstallStateStore();
  }

  /** 底层注册表（只读用途；写操作请走本类入口，便于统一持久化）。 */
  get pluginRegistry(): PluginRegistry {
    return this.registry;
  }

  /** 某插件此刻的安装来源记录（查不到返回 `undefined`，不编造）。 */
  sourceOf(pluginId: string): RegisteredInstallSource | undefined {
    const registered = findInstallSource(pluginId);
    if (registered !== undefined) {
      return registered;
    }
    const manifest = this.registry.manifestOf(pluginId);
    return manifest === undefined ? undefined : toInstallSourceEntry(manifest);
  }

  /** 从**内置来源**安装目录中的插件。 */
  install(pluginId: string, at: LogicalTime): InstallResult {
    return this.registry.install(pluginId, { at, source: { kind: 'builtin', origin: 'builtin' } });
  }

  /**
   * 从**声明式包**安装：先 PLG-03 严格校验，再落状态。
   * 校验失败 ⇒ 返回具名拒因，**注册表状态不变**。
   */
  installDeclarativePackage(
    raw: unknown,
    at: LogicalTime,
    options: PackageValidationOptions = {},
  ): DeclarativeInstallResult {
    const validation = validateDeclarativePackageForInstall(raw, options);
    if (!validation.ok) {
      return Object.freeze({ ok: false, issues: validation.issues });
    }
    const pkg: StrictValidatedPackage = validation.package;
    const result = this.registry.installFromPackage(pkg, at);
    if (!result.ok) {
      // 校验已过、却装不上（例如内核不兼容）：如实转成具名拒因，不谎称成功
      return Object.freeze({
        ok: false,
        issues: Object.freeze([
          Object.freeze({
            code: 'invalid_manifest' as const,
            subject: pkg.package_id,
            detail: `声明式包校验通过但安装失败（${result.reason}）：${result.detail}`,
          }),
        ]),
      });
    }
    return Object.freeze({ ok: true, record: result.record });
  }

  /** 启用（要求已安装）。 */
  enable(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.registry.enable(pluginId, at);
  }

  /** 停用（阻止新实例；既有绑定不受影响）。 */
  disable(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.registry.disable(pluginId, at);
  }

  /** 卸载（保留记录、前移 `updated_at`）。 */
  uninstall(pluginId: string, at: LogicalTime): PluginInstallRecord {
    return this.registry.uninstall(pluginId, at);
  }

  /** 当前持久状态快照。 */
  snapshot(): PluginRegistrySnapshot {
    return this.registry.snapshot();
  }

  /** 把当前状态写入存储。 */
  persist(): void {
    this.store.save(this.registry.snapshot());
  }

  /**
   * 从存储恢复状态。
   * @returns 是否有可恢复的快照（`false` ⇒ 什么都没恢复，**不编造**）。
   */
  reload(): boolean {
    const snapshot = this.store.load();
    if (snapshot === undefined) {
      return false;
    }
    this.registry.restoreSnapshot(snapshot);
    return true;
  }
}

/** 空安装状态快照（供新运行环境起步；不假装已装任何东西）。 */
export function emptyInstallState(): PluginRegistrySnapshot {
  return emptyRegistrySnapshot();
}

/** 便捷：构造一个默认的管理器（真实注册目录 + 内存存储）。 */
export function createInstallSourceManager(options: InstallSourceManagerOptions = {}): InstallSourceManager {
  return new InstallSourceManager(options);
}

/** 目录里已知的全部插件清单（转出，便于调用方核对来源与清单一致）。 */
export function listRegisteredManifests(): readonly PluginManifest[] {
  return Object.freeze(REGISTERED_INSTALL_SOURCES.map((entry) => findPluginManifest(entry.plugin_id)).filter(
    (manifest): manifest is PluginManifest => manifest !== undefined,
  ));
}
