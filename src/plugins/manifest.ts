/**
 * 插件（业务模板 / 基础角色）的**声明式清单**与结构校验
 * （design-06 P6；合同 v1 冻结 R227 / R228 / R229 / R232 / R233）。
 *
 * ## 这一层为什么存在
 *
 * R228 把底线写死了：**「只有名字或 prompt 不算模板可用」**。因此模板不是一个字符串、
 * 也不是一段提示词，而是一份**可机器检查的清单**：版本、内核兼容、能力 ID、指令、
 * 输入输出、适配器依赖、权限、数据范围、经验策略。本文件定义这份清单的形状，
 * 并把「只有名字」这种冒充写法**在构造期就拒掉**。
 *
 * ## R232：模板、工具、文件格式**分开建模**
 *
 * 这是本文件最容易写错、也最被合同强调的一点。三种东西是三个正交的概念：
 *
 * 1. **文件格式**（file format）：`docx` / `xlsx` / `pptx`——**唯一的字面量来源**是
 *    `src/protocol/artifact.ts` 的 `TEMPLATE_KIND_EXTENSIONS`。本层**派生**而不另抄一份，
 *    避免出现第二份"文件类型枚举"（合同反复出现的教训：单一来源只能有一个）。
 * 2. **模板**（business template）：产出或处理某类任务的**能力单元**，共七个。文档 / 表格 /
 *    演示文稿三个模板**产出**文件格式；而**美团 / 时钟 / 日历 / 资料检索四个模板不产出**
 *    docx/xlsx/pptx——把它们塞进文件类型枚举就是 R232 明令禁止的写法。
 * 3. **角色**（base role）：前台主智能体 / 群内分身 / 经验维护智能体，它们是**运行时身份**，
 *    不是能力单元（R200）。因此本文件用**两个独立的清单类型**（`BusinessTemplateManifest`
 *    与 `BaseRoleManifest`）承载，而不是"一个枚举 + 一个 kind 字段"。
 *
 * `produces_file_formats` 与 `consumes_formats` 也**刻意分开**：检索模板会**读取** PDF /
 * Markdown 等资料，那是**输入资料格式**，既不是产出格式，也**不得**进文件类型枚举。
 *
 * ## R233：stub 必须显式标识
 *
 * `implementation: 'real' | 'stub'` 是必填字段。标 `stub` 的清单**必须**给出 `stub_reason`
 * （非空），标 `real` 的**不得**携带原因；构造期强制，杜绝"含糊带过"。
 *
 * ## R229：声明式包不得暗中获得执行权
 *
 * `validateDeclarativePackage()` 对**安装来源**做内容校验：声明式包一旦申请
 * `code_execution` / `install_dependencies` / `start_mcp_server` 之类的权限，或夹带脚本，
 * 一律**结构化拒绝**——声明式安装不是任意代码执行的后门。
 *
 * 纯函数、零 IO：不含墙钟、不含随机数、不读 `process.*`。
 */

import {
  TEMPLATE_KIND_EXTENSIONS,
  TEMPLATE_KINDS,
  ValidationError,
  asCapabilityId,
  type CapabilityId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 文件格式（R232 的唯一来源：从 protocol 的模板种类扩展名派生）
// ---------------------------------------------------------------------------

/**
 * **文件格式封闭枚举**——只可能是 `docx` / `xlsx` / `pptx`。
 *
 * 直接从 `TEMPLATE_KINDS` + `TEMPLATE_KIND_EXTENSIONS` 派生，**不另抄字面量**：
 * protocol 是文件格式的唯一来源，本层只是它在本目录视角下的一个别名。
 * 任何"把美团 / 时钟 / 日历 / 检索加进来"的改动都会与 protocol 分叉，测试会立刻变红。
 */
export const FILE_FORMAT_KINDS: readonly string[] = Object.freeze(
  TEMPLATE_KINDS.map((kind) => TEMPLATE_KIND_EXTENSIONS[kind]),
);

export type FileFormat = (typeof FILE_FORMAT_KINDS)[number];

/** 某字符串是否是合法文件格式（大小写敏感，精确匹配）。 */
export function isFileFormat(value: unknown): value is FileFormat {
  return typeof value === 'string' && (FILE_FORMAT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 插件分类（R200：模板与角色**不在同一枚举里**）
// ---------------------------------------------------------------------------

/** 插件目录的两大类（**不是**文件格式，也不是具体模板名）。 */
export const PLUGIN_KINDS = ['business_template', 'base_role'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * 七个**业务模板**的稳定 id（封闭枚举）。
 * 前三个产出文件格式，后四个不产出——见各清单的 `produces_file_formats`。
 */
export const BUSINESS_TEMPLATE_IDS = [
  'template.document',
  'template.spreadsheet',
  'template.presentation',
  'template.meituan',
  'template.clock',
  'template.calendar',
  'template.research',
] as const;
export type BusinessTemplateId = (typeof BUSINESS_TEMPLATE_IDS)[number];

/** 三个**基础角色**的稳定 id（封闭枚举）。角色是运行时身份，与模板分属不同枚举。 */
export const BASE_ROLE_IDS = [
  'role.front_agent',
  'role.group_follower',
  'role.experience_maintainer',
] as const;
export type BaseRoleId = (typeof BASE_ROLE_IDS)[number];

/** 插件 id（两个封闭枚举的并集；仅用于注册表的键，不改变二者分属不同枚举这一事实）。 */
export type PluginId = BusinessTemplateId | BaseRoleId;

// ---------------------------------------------------------------------------
// 清单的构件
// ---------------------------------------------------------------------------

/** 一条能力声明（`capability_id` 是能力发现用的稳定标识，**不是**实例身份，Q1-c）。 */
export interface PluginCapability {
  readonly capability_id: CapabilityId;
  /** 能力的人类可读短标签（能力发现清单里显示的就是它，**不是**指令全文）。 */
  readonly label: string;
  readonly description: string;
}

/** 端口种类（输入 / 输出各自的载荷类型，封闭枚举）。 */
export const PLUGIN_PORT_KINDS = ['text', 'file', 'fact', 'query', 'action'] as const;
export type PluginPortKind = (typeof PLUGIN_PORT_KINDS)[number];

/** 一个输入 / 输出端口声明。 */
export interface PluginPort {
  readonly name: string;
  readonly kind: PluginPortKind;
  readonly description: string;
  /**
   * 该端口涉及的格式（自由字符串，如 `pdf` / `markdown` / `csv`）。
   * **不是** `produces_file_formats`：这里可以出现非 OOXML 的资料格式，但**永不**进入文件类型枚举。
   */
  readonly formats: readonly string[];
}

/** 适配器依赖种类（封闭枚举）。 */
export const ADAPTER_DEPENDENCY_KINDS = ['builtin', 'system_api', 'backend_service', 'mcp'] as const;
export type AdapterDependencyKind = (typeof ADAPTER_DEPENDENCY_KINDS)[number];

/** 一条适配器依赖声明。**就绪与否是运行期事实**（由注入的探针回答），声明只描述"依赖谁"。 */
export interface AdapterDependency {
  readonly adapter_id: string;
  readonly kind: AdapterDependencyKind;
  /** 必需依赖缺失 ⇒ 模板未就绪；可选依赖缺失 ⇒ 只降级对应能力。 */
  readonly required: boolean;
  readonly description: string;
}

/** 一条权限声明。 */
export interface PermissionDeclaration {
  readonly permission_id: string;
  readonly description: string;
  readonly required: boolean;
}

/**
 * 数据范围（封闭枚举）。把"能碰多少数据"写成可核对的值，而不是含糊的说明。
 * 词汇与 R235 的记忆范围（任务 / 模板 / 用户）对齐，另加 `none`（不碰数据）与
 * `external`（外部来源，视为数据不是指令）。
 */
export const DATA_SCOPE_LEVELS = ['none', 'task', 'template', 'user', 'external'] as const;
export type DataScopeLevel = (typeof DATA_SCOPE_LEVELS)[number];

export interface DataScope {
  readonly level: DataScopeLevel;
  readonly detail: string;
}

/** 经验策略（封闭枚举）。模板级"经验怎么攒"的口径（对应 R239 的生命周期）。 */
export const EXPERIENCE_STRATEGIES = ['none', 'candidate_review', 'auto_versioned'] as const;
export type ExperienceStrategy = (typeof EXPERIENCE_STRATEGIES)[number];

export interface ExperiencePolicy {
  readonly strategy: ExperienceStrategy;
  readonly detail: string;
}

/** 内核兼容区间。`max_version` 为 `null` 表示无上限。 */
export interface KernelCompatibility {
  readonly min_version: string;
  readonly max_version: string | null;
}

/** 安装来源种类（封闭枚举）。 */
export const INSTALL_SOURCE_KINDS = ['builtin', 'declarative_package'] as const;
export type InstallSourceKind = (typeof INSTALL_SOURCE_KINDS)[number];

export interface InstallSource {
  readonly kind: InstallSourceKind;
  /** 来源标识（内置为 `builtin`；包安装为包 id 或受控目录路径，**不是**任意 URL）。 */
  readonly origin: string;
}

/** 实现标记（封闭枚举）。R233：stub 必须显式标识。 */
export const IMPLEMENTATIONS = ['real', 'stub'] as const;
export type Implementation = (typeof IMPLEMENTATIONS)[number];

// ---------------------------------------------------------------------------
// 清单（两种独立形状）
// ---------------------------------------------------------------------------

/** 两种清单的公共字段（`kind` 与 `plugin_id` 由子类型各自收窄）。 */
interface PluginManifestCommon {
  readonly display_name: string;
  readonly version: string;
  readonly kernel_compatibility: KernelCompatibility;
  readonly capabilities: readonly PluginCapability[];
  /**
   * 指令声明。**存的是指令**，但能力发现（R231）**只暴露 `capabilities[].label`**，
   * 不把这些全文塞进上下文。
   */
  readonly instructions: readonly string[];
  readonly inputs: readonly PluginPort[];
  readonly outputs: readonly PluginPort[];
  readonly adapter_dependencies: readonly AdapterDependency[];
  readonly permissions: readonly PermissionDeclaration[];
  readonly data_scope: DataScope;
  readonly experience_policy: ExperiencePolicy;
  readonly install_source: InstallSource;
  readonly implementation: Implementation;
  /** 仅当 `implementation === 'stub'` 时非空（R233）。 */
  readonly stub_reason: string | null;
}

/** **业务模板**清单：能力单元，可能产出文件格式。 */
export interface BusinessTemplateManifest extends PluginManifestCommon {
  readonly kind: 'business_template';
  readonly plugin_id: BusinessTemplateId;
  /**
   * 本模板**产出**的文件格式，只能取 `FILE_FORMAT_KINDS` 的子集。
   * 美团 / 时钟 / 日历 / 资料检索四个模板此处为**空数组**（R232）。
   */
  readonly produces_file_formats: readonly FileFormat[];
  /**
   * 本模板**可读取**的资料格式（自由字符串）。与 `produces_file_formats` 语义不同：
   * 资料检索可以读 `pdf` / `markdown`，但**不产出**它们、更不把它们变成文件类型枚举。
   */
  readonly consumes_formats: readonly string[];
}

/** **基础角色**清单：运行时身份，不是能力单元。 */
export interface BaseRoleManifest extends PluginManifestCommon {
  readonly kind: 'base_role';
  readonly plugin_id: BaseRoleId;
  /** 运行时身份标识（如 `foreground_primary`）——角色清单描述"这个身份是谁"，而非"产出什么"。 */
  readonly runtime_identity: string;
}

export type PluginManifest = BusinessTemplateManifest | BaseRoleManifest;

// ---------------------------------------------------------------------------
// 校验工具
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空（收到 ${describe(value)}）`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} 必须是 ${allowed.join(' | ')} 之一，收到 ${describe(value)}`);
  }
  return value as T;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} 必须是布尔值，收到 ${describe(value)}`);
  }
  return value;
}

/** 版本号形状（宽松 semver：至少 `major.minor.patch`）。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;

function requireVersion(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (!VERSION_PATTERN.test(raw)) {
    throw new ValidationError(`${field} 必须是形如 major.minor.patch 的版本号，收到 ${JSON.stringify(raw)}`);
  }
  return raw;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} 必须是数组，收到 ${describe(value)}`);
  }
  return value;
}

function freezeCapabilities(raw: unknown): readonly PluginCapability[] {
  const list = requireArray(raw, 'PluginManifest.capabilities');
  if (list.length === 0) {
    throw new ValidationError(
      'PluginManifest.capabilities 不能为空：只有名字或 prompt 不算模板可用（R228）——' +
        '模板必须声明至少一条可发现的能力 ID',
    );
  }
  const seen = new Set<string>();
  const frozen: PluginCapability[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      throw new ValidationError(`capabilities[] 必须是对象，收到 ${describe(entry)}`);
    }
    const id = requireNonEmptyString(entry.capability_id, 'PluginCapability.capability_id');
    if (seen.has(id)) {
      throw new ValidationError(`能力 ID ${id} 在同一清单里出现了两次（能力发现会因此产生歧义）`);
    }
    seen.add(id);
    frozen.push(
      Object.freeze({
        capability_id: asCapabilityId(id),
        label: requireNonEmptyString(entry.label, `能力 ${id} 的 label`),
        description: requireNonEmptyString(entry.description, `能力 ${id} 的 description`),
      }),
    );
  }
  return Object.freeze(frozen);
}

function freezeStringArray(raw: unknown, field: string): readonly string[] {
  const list = requireArray(raw, field);
  const frozen = list.map((item) => requireNonEmptyString(item, `${field}[]`));
  if (new Set(frozen).size !== frozen.length) {
    throw new ValidationError(`${field} 含重复项`);
  }
  return Object.freeze(frozen);
}

function freezePorts(raw: unknown, field: string): readonly PluginPort[] {
  const list = requireArray(raw, field);
  const seen = new Set<string>();
  const frozen: PluginPort[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      throw new ValidationError(`${field}[] 必须是对象，收到 ${describe(entry)}`);
    }
    const name = requireNonEmptyString(entry.name, `${field}[].name`);
    if (seen.has(name)) {
      throw new ValidationError(`${field} 出现重复端口名 ${name}`);
    }
    seen.add(name);
    frozen.push(
      Object.freeze({
        name,
        kind: requireEnum(entry.kind, PLUGIN_PORT_KINDS, `${field}[].kind`),
        description: requireNonEmptyString(entry.description, `${field}[].description`),
        formats: freezeStringArray(entry.formats ?? [], `${field}[].formats`),
      }),
    );
  }
  return Object.freeze(frozen);
}

function freezeAdapterDependencies(raw: unknown): readonly AdapterDependency[] {
  const list = requireArray(raw, 'PluginManifest.adapter_dependencies');
  const seen = new Set<string>();
  const frozen: AdapterDependency[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      throw new ValidationError(`adapter_dependencies[] 必须是对象，收到 ${describe(entry)}`);
    }
    const adapterId = requireNonEmptyString(entry.adapter_id, 'AdapterDependency.adapter_id');
    if (seen.has(adapterId)) {
      throw new ValidationError(`适配器依赖 ${adapterId} 声明了两次`);
    }
    seen.add(adapterId);
    frozen.push(
      Object.freeze({
        adapter_id: adapterId,
        kind: requireEnum(entry.kind, ADAPTER_DEPENDENCY_KINDS, 'AdapterDependency.kind'),
        required: requireBoolean(entry.required, `依赖 ${adapterId} 的 required`),
        description: requireNonEmptyString(entry.description, `依赖 ${adapterId} 的 description`),
      }),
    );
  }
  return Object.freeze(frozen);
}

function freezePermissions(raw: unknown): readonly PermissionDeclaration[] {
  const list = requireArray(raw, 'PluginManifest.permissions');
  const seen = new Set<string>();
  const frozen: PermissionDeclaration[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      throw new ValidationError(`permissions[] 必须是对象，收到 ${describe(entry)}`);
    }
    const id = requireNonEmptyString(entry.permission_id, 'PermissionDeclaration.permission_id');
    if (seen.has(id)) {
      throw new ValidationError(`权限 ${id} 声明了两次`);
    }
    seen.add(id);
    frozen.push(
      Object.freeze({
        permission_id: id,
        description: requireNonEmptyString(entry.description, `权限 ${id} 的 description`),
        required: requireBoolean(entry.required, `权限 ${id} 的 required`),
      }),
    );
  }
  return Object.freeze(frozen);
}

function freezeKernelCompatibility(raw: unknown): KernelCompatibility {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`kernel_compatibility 必须是对象，收到 ${describe(raw)}`);
  }
  const minVersion = requireVersion(raw.min_version, 'kernel_compatibility.min_version');
  const maxRaw = raw.max_version;
  const maxVersion =
    maxRaw === null || maxRaw === undefined
      ? null
      : requireVersion(maxRaw, 'kernel_compatibility.max_version');
  if (maxVersion !== null && compareVersions(maxVersion, minVersion) < 0) {
    throw new ValidationError(
      `kernel_compatibility.max_version (${maxVersion}) 低于 min_version (${minVersion})：空区间无意义`,
    );
  }
  return Object.freeze({ min_version: minVersion, max_version: maxVersion });
}

function freezeInstallSource(raw: unknown): InstallSource {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`install_source 必须是对象，收到 ${describe(raw)}`);
  }
  return Object.freeze({
    kind: requireEnum(raw.kind, INSTALL_SOURCE_KINDS, 'install_source.kind'),
    origin: requireNonEmptyString(raw.origin, 'install_source.origin'),
  });
}

function freezeDataScope(raw: unknown): DataScope {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`data_scope 必须是对象，收到 ${describe(raw)}`);
  }
  return Object.freeze({
    level: requireEnum(raw.level, DATA_SCOPE_LEVELS, 'data_scope.level'),
    detail: requireNonEmptyString(raw.detail, 'data_scope.detail'),
  });
}

function freezeExperiencePolicy(raw: unknown): ExperiencePolicy {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`experience_policy 必须是对象，收到 ${describe(raw)}`);
  }
  return Object.freeze({
    strategy: requireEnum(raw.strategy, EXPERIENCE_STRATEGIES, 'experience_policy.strategy'),
    detail: requireNonEmptyString(raw.detail, 'experience_policy.detail'),
  });
}

function freezeStub(raw: Record<string, unknown>): { implementation: Implementation; stub_reason: string | null } {
  const implementation = requireEnum(raw.implementation, IMPLEMENTATIONS, 'PluginManifest.implementation');
  const reasonRaw = raw.stub_reason;
  if (implementation === 'stub') {
    return {
      implementation,
      stub_reason: requireNonEmptyString(reasonRaw, 'stub_reason（implementation 为 stub 时必填，R233）'),
    };
  }
  if (reasonRaw !== null && reasonRaw !== undefined) {
    throw new ValidationError(
      'implementation 为 real 的清单不得携带 stub_reason（含糊标注会让"是否 stub"无法判定）',
    );
  }
  return { implementation, stub_reason: null };
}

/**
 * 冻结清单的公共字段。
 * @throws {ValidationError} 字段缺失、类型不符，或违反 R228（只有名字）/ R233（stub 未标识）时。
 */
function freezeCommon(raw: Record<string, unknown>): PluginManifestCommon {
  const capabilities = freezeCapabilities(raw.capabilities);
  const instructions = freezeStringArray(raw.instructions ?? [], 'PluginManifest.instructions');
  if (instructions.length === 0) {
    throw new ValidationError(
      'PluginManifest.instructions 不能为空：模板要有可执行的指令声明（R227）',
    );
  }
  const inputs = freezePorts(raw.inputs ?? [], 'PluginManifest.inputs');
  const outputs = freezePorts(raw.outputs ?? [], 'PluginManifest.outputs');
  if (inputs.length + outputs.length === 0) {
    throw new ValidationError(
      'PluginManifest 必须声明至少一个输入或输出端口：没有输入输出的"模板"无法接线（R228）',
    );
  }
  const stub = freezeStub(raw);
  return {
    display_name: requireNonEmptyString(raw.display_name, 'PluginManifest.display_name'),
    version: requireVersion(raw.version, 'PluginManifest.version'),
    kernel_compatibility: freezeKernelCompatibility(raw.kernel_compatibility),
    capabilities,
    instructions,
    inputs,
    outputs,
    adapter_dependencies: freezeAdapterDependencies(raw.adapter_dependencies ?? []),
    permissions: freezePermissions(raw.permissions ?? []),
    data_scope: freezeDataScope(raw.data_scope),
    experience_policy: freezeExperiencePolicy(raw.experience_policy),
    install_source: freezeInstallSource(raw.install_source),
    implementation: stub.implementation,
    stub_reason: stub.stub_reason,
  };
}

/**
 * **R232 的核心守卫**：产出文件格式只能是 `FILE_FORMAT_KINDS` 的子集。
 * 把 `meituan` / `clock` / `calendar` / `research` 塞进来会在此**立刻失败**。
 */
function freezeProducesFileFormats(raw: unknown, pluginId: string): readonly FileFormat[] {
  const list = requireArray(raw, 'BusinessTemplateManifest.produces_file_formats');
  const frozen: FileFormat[] = [];
  for (const item of list) {
    if (!isFileFormat(item)) {
      throw new ValidationError(
        `模板 ${pluginId} 声明产出的文件格式 ${JSON.stringify(item)} 不是合法文件格式` +
          `（只允许 ${FILE_FORMAT_KINDS.join(' | ')}）。` +
          '模板与文件格式分开建模（R232）：美团 / 时钟 / 日历 / 资料检索不得进入文件类型枚举',
      );
    }
    if (frozen.includes(item)) {
      throw new ValidationError(`模板 ${pluginId} 重复声明产出格式 ${item}`);
    }
    frozen.push(item);
  }
  return Object.freeze(frozen);
}

/** 比较两个 `major.minor.patch` 版本。返回 -1 / 0 / 1（忽略预发布后缀）。 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] =>
    value.split('.').slice(0, 3).map((part) => {
      const digits = /^\d+/.exec(part);
      return digits === null ? 0 : Number(digits[0]);
    });
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 构造**业务模板**清单。 */
export function createBusinessTemplateManifest(raw: unknown): BusinessTemplateManifest {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`业务模板清单必须是对象，收到 ${describe(raw)}`);
  }
  const pluginId = requireEnum(raw.plugin_id, BUSINESS_TEMPLATE_IDS, 'BusinessTemplateManifest.plugin_id');
  const common = freezeCommon(raw);
  return Object.freeze({
    ...common,
    kind: 'business_template',
    plugin_id: pluginId,
    produces_file_formats: freezeProducesFileFormats(raw.produces_file_formats ?? [], pluginId),
    consumes_formats: freezeStringArray(raw.consumes_formats ?? [], 'BusinessTemplateManifest.consumes_formats'),
  });
}

/** 构造**基础角色**清单。 */
export function createBaseRoleManifest(raw: unknown): BaseRoleManifest {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`基础角色清单必须是对象，收到 ${describe(raw)}`);
  }
  const pluginId = requireEnum(raw.plugin_id, BASE_ROLE_IDS, 'BaseRoleManifest.plugin_id');
  const common = freezeCommon(raw);
  return Object.freeze({
    ...common,
    kind: 'base_role',
    plugin_id: pluginId,
    runtime_identity: requireNonEmptyString(raw.runtime_identity, 'BaseRoleManifest.runtime_identity'),
  });
}

/**
 * 按 `kind` 分派构造清单（供注册目录一次性载入）。
 * @throws {ValidationError} `kind` 缺失 / 非枚举 / 各子类型字段违规时。
 */
export function createPluginManifest(raw: unknown): PluginManifest {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`插件清单必须是对象，收到 ${describe(raw)}`);
  }
  const kind = requireEnum(raw.kind, PLUGIN_KINDS, 'PluginManifest.kind');
  return kind === 'business_template'
    ? createBusinessTemplateManifest(raw)
    : createBaseRoleManifest(raw);
}

/** 形状自检（供从注册目录读回或从持久状态反序列化的清单复核）。 */
export function assertPluginManifestInvariants(manifest: PluginManifest): void {
  createPluginManifest(manifest);
}

// ---------------------------------------------------------------------------
// R229：声明式包的内容校验
// ---------------------------------------------------------------------------

/**
 * 声明式包**不得**申请的权限（封闭枚举）。
 * 申请其中任何一项 ⇒ 拒绝安装：声明式安装不是任意代码执行的入口（R229）。
 */
export const PACKAGE_FORBIDDEN_CAPABILITIES = [
  'code_execution', // 执行任意代码
  'install_dependencies', // 自行安装依赖
  'start_mcp_server', // 启动未知 MCP 服务
  'network_fetch_arbitrary', // 无约束地拉取任意外部内容
] as const;
export type PackageForbiddenCapability = (typeof PACKAGE_FORBIDDEN_CAPABILITIES)[number];

/** 包校验拒因码（封闭枚举）。 */
export const PACKAGE_REJECTION_CODES = [
  'invalid_package', // 包不是对象
  'missing_package_id', // 缺包 id
  'invalid_source', // 安装来源非法（非受控目录 / 非内置）
  'forbidden_capability', // 申请了禁止的能力（R229）
  'embedded_script', // 夹带脚本
  'invalid_manifest', // 内嵌清单构造失败
] as const;
export type PackageRejectionCode = (typeof PACKAGE_REJECTION_CODES)[number];

export interface PackageRejection {
  readonly code: PackageRejectionCode;
  readonly detail: string;
}

/** 通过校验的声明式包。 */
export interface ValidatedPackage {
  readonly package_id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
}

export type PackageValidation =
  | { readonly ok: true; readonly package: ValidatedPackage }
  | { readonly ok: false; readonly rejections: readonly PackageRejection[] };

/**
 * 校验一个**声明式包**：内嵌清单合法 + 不申请禁止能力 + 不夹带脚本。
 *
 * 一律返回结构化结果（**不抛**），一次收齐所有问题。
 */
export function validateDeclarativePackage(raw: unknown): PackageValidation {
  const rejections: PackageRejection[] = [];
  const reject = (code: PackageRejectionCode, detail: string): void => {
    rejections.push(Object.freeze({ code, detail }));
  };

  if (!isPlainObject(raw)) {
    reject('invalid_package', `声明式包必须是对象，收到 ${describe(raw)}`);
    return Object.freeze({ ok: false, rejections: Object.freeze(rejections) });
  }

  if (typeof raw.package_id !== 'string' || raw.package_id.length === 0) {
    reject('missing_package_id', '声明式包必须给出非空 package_id');
  }

  const source = raw.install_source;
  if (!isPlainObject(source) || source.kind !== 'declarative_package' || typeof source.origin !== 'string' || source.origin.length === 0) {
    reject(
      'invalid_source',
      '声明式包的 install_source.kind 必须是 declarative_package 且 origin 非空' +
        '（只接受受控目录 / 受控来源，不接受任意 URL）',
    );
  }

  for (const capability of requireArraySafe(raw.requested_capabilities)) {
    if (typeof capability === 'string' && (PACKAGE_FORBIDDEN_CAPABILITIES as readonly string[]).includes(capability)) {
      reject(
        'forbidden_capability',
        `声明式包申请了禁止的能力 ${capability}：` +
          '声明式安装不得暗中获得任意代码执行、安装依赖或启动未知 MCP 服务（R229）',
      );
    }
  }

  const scripts = raw.embedded_scripts;
  if (Array.isArray(scripts) && scripts.length > 0) {
    reject('embedded_script', '声明式包不得夹带脚本（embedded_scripts 非空）');
  }

  let manifest: PluginManifest | null = null;
  try {
    manifest = createPluginManifest(raw.manifest);
  } catch (error) {
    reject('invalid_manifest', `内嵌清单构造失败：${error instanceof Error ? error.message : describe(error)}`);
  }

  if (rejections.length > 0 || manifest === null) {
    return Object.freeze({ ok: false, rejections: Object.freeze(rejections) });
  }

  return Object.freeze({
    ok: true,
    package: Object.freeze({
      package_id: raw.package_id as string,
      version: requireVersion(raw.version, '声明式包的 version'),
      manifest,
    }),
  });
}

function requireArraySafe(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
