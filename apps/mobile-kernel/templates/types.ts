/**
 * K06 模板 manifest 生命周期 —— **词表、数据结构与端口**（零依赖、纯类型 + 纯函数）。
 *
 * 契约来源：`contracts/mobile-v1/schemas/template-manifest.schema.json`。
 * 本文件里的每个 enum 都**逐字**取自该 schema 的 `$defs`，不是本模块自造词表：
 * `permission` / `runtimeCompatibility.runtimes` / `abis` / `migration.strategy` /
 * `verificationMode` / `verificationLayer`。
 *
 * ## 四个就绪态（**各自独立，禁止合并**）
 *
 * `installed`（已安装）/ `enabled`（已启用）/ `authorized`（已授权）/ `portReady`（端口就绪）
 * 是**四个**各自独立的判定，每个都是一份 `StateReport`（`ready` 或 `not-ready` + 原因）。
 * 本模块刻意**不提供**任何"整体就绪 / ready"布尔：契约的 `additionalProperties: false`
 * 会拒掉这种字段，运行期 `assertSeparateReadinessStates()` 再拦一道。
 *
 * ## 状态来自探针，不来自 manifest 自称
 *
 * manifest 的 `probe` 字段（四个布尔 + `verificationMode` + `layers`）是模板**声明**，
 * 只用于校验形状；就绪判定的实际输入是宿主侧 `TemplateProbePort` 的**真实读回结果**。
 */

// ---------------------------------------------------------------------------
// 词表（逐字取自契约 $defs）
// ---------------------------------------------------------------------------

/** 契约 `$defs.permission.enum`。 */
export const TEMPLATE_PERMISSIONS = [
  'network',
  'storage',
  'model',
  'device',
  'external-order',
  'file-write',
] as const;
export type TemplatePermission = (typeof TEMPLATE_PERMISSIONS)[number];

/** 契约 `$defs.runtimeCompatibility.properties.runtimes.items.enum`。 */
export const TEMPLATE_RUNTIMES = ['quickjs', 'node', 'v8', 'native'] as const;
export type TemplateRuntime = (typeof TEMPLATE_RUNTIMES)[number];

/** 契约 `$defs.runtimeCompatibility.properties.abis.items.enum`。 */
export const TEMPLATE_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'] as const;
export type TemplateAbi = (typeof TEMPLATE_ABIS)[number];

/** 契约 `$defs.migration.properties.strategy.enum`。 */
export const MIGRATION_STRATEGIES = ['none', 'additive', 'transform', 'manual'] as const;
export type MigrationStrategy = (typeof MIGRATION_STRATEGIES)[number];

/** 契约 `$defs.verificationMode.enum`。 */
export const VERIFICATION_MODES = ['fixture', 'real'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** 契约 `$defs.verificationLayer.enum`。 */
export const VERIFICATION_LAYERS = [
  'unit',
  'contract',
  'real-api',
  'on-device',
  'consumer-reopen',
  'cross-lane',
] as const;
export type VerificationLayer = (typeof VERIFICATION_LAYERS)[number];

/** 契约 `runtimeCompatibility.properties.os.const`。 */
export const TEMPLATE_OS = 'android' as const;

/** 版本号形状：契约 `$defs.version.pattern` 为 `^\d+\.\d+\.\d+$`。 */
export const MANIFEST_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// manifest 结构（字段名严格照契约）
// ---------------------------------------------------------------------------

export interface RuntimeCompatibility {
  readonly os: typeof TEMPLATE_OS;
  /** 最低 Android API 级别（契约：`integer, minimum 1`）。 */
  readonly minimumOs: number;
  readonly runtimes: readonly TemplateRuntime[];
  readonly abis: readonly TemplateAbi[];
}

export interface MigrationDeclaration {
  readonly from: string;
  readonly to: string;
  readonly strategy: MigrationStrategy;
  readonly reversible: boolean;
}

/**
 * 模板**自称**的探针声明。
 *
 * 这四个布尔是模板侧的声明，**不参与**就绪判定——就绪判定读宿主探针。
 * 它们的唯一作用是形状校验（契约把它们列为 `required`）。
 */
export interface ProbeDeclaration {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly portReady: boolean;
  readonly verificationMode: VerificationMode;
  readonly layers: readonly VerificationLayer[];
  readonly checkedAt?: string;
}

export interface TemplateManifest {
  readonly id: string;
  readonly displayName?: string;
  readonly version: string;
  /** 能力清单（契约：`minItems: 1`）。 */
  readonly capabilities: readonly string[];
  readonly schemas: readonly string[];
  readonly permissions: readonly TemplatePermission[];
  readonly runtimeCompatibility: RuntimeCompatibility;
  readonly migration: MigrationDeclaration;
  readonly probe: ProbeDeclaration;
}

// ---------------------------------------------------------------------------
// 就绪报告（四态分别报告）
// ---------------------------------------------------------------------------

/** 四个就绪态的**名字**（顺序即契约 probe 里 required 的顺序）。 */
export const READINESS_STATE_NAMES = ['installed', 'enabled', 'authorized', 'portReady'] as const;
export type ReadinessStateName = (typeof READINESS_STATE_NAMES)[number];

/** 单个态的判定结果：只有这两个取值。 */
export const READINESS_VERDICTS = ['ready', 'not-ready'] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

/** 单个态的如实报告：`not-ready` **必须**带原因（`ready` 时原因为 null）。 */
export interface StateReport {
  readonly state: ReadinessVerdict;
  /** `not-ready` 时的可机读原因；`ready` 时恒为 null。 */
  readonly reason: string | null;
  /** 探针给出的证据引用（无证据为 null——不得编造）。 */
  readonly evidenceRef: string | null;
  readonly checkedAt: number;
}

/** 四态**分别**报告。刻意没有 `ready` 这类汇总布尔。 */
export interface ReadinessReport {
  readonly id: string;
  readonly version: string;
  readonly installed: StateReport;
  readonly enabled: StateReport;
  readonly authorized: StateReport;
  readonly portReady: StateReport;
}

/** 中文名（展示用；**不参与判定**）。 */
export const READINESS_STATE_LABELS: Readonly<Record<ReadinessStateName, string>> = Object.freeze({
  installed: '已安装',
  enabled: '已启用',
  authorized: '已授权',
  portReady: '端口就绪',
});

// ---------------------------------------------------------------------------
// 宿主平台描述与端口
// ---------------------------------------------------------------------------

/** 宿主（手机内核）侧的平台事实。运行时兼容判定的对照面。 */
export interface HostPlatform {
  readonly os: typeof TEMPLATE_OS;
  /** 宿主 Android API 级别。 */
  readonly apiLevel: number;
  readonly runtimes: readonly TemplateRuntime[];
  readonly abis: readonly TemplateAbi[];
  /** 宿主**实际具备**的能力（不是模板声明的能力）。缺失即端口未就绪。 */
  readonly capabilities: readonly string[];
}

export interface Clock {
  now(): number;
}

export interface ManualClock extends Clock {
  set(value: number): void;
  advance(delta: number): void;
}

/** 确定性时钟：测试与夹具用，**不读墙钟**。 */
export function createManualClock(start: number): ManualClock {
  let current = start;
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    advance(delta: number) {
      current += delta;
    },
  };
}

/** 交给探针的请求（探针据此读回宿主侧真实状态）。 */
export interface ProbeRequest {
  readonly id: string;
  readonly version: string;
  /** manifest 声明的能力（探针据此逐个核对端口是否真的就绪）。 */
  readonly capabilities: readonly string[];
  /** manifest 声明的权限（探针据此核对授权是否真的落到宿主）。 */
  readonly permissions: readonly TemplatePermission[];
}

/** 探针单次读回结果。`ok === false` 时 `reason` 必须给出（否则无法定位是哪个环节没通）。 */
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly evidenceRef?: string;
}

/**
 * 宿主探针端口（真机上是异步的：查包管理器 / 查端口 / 查权限；夹具可同步）。
 *
 * **四个态各有自己的探针**——这正是"四态不得合并"的落点：合并成一个布尔就无法
 * 分别驱动这四条读回路径。
 */
export interface TemplateProbePort {
  readonly identity: string;
  probeInstalled(request: ProbeRequest): ProbeOutcome | Promise<ProbeOutcome>;
  probeEnabled(request: ProbeRequest): ProbeOutcome | Promise<ProbeOutcome>;
  probeAuthorized(request: ProbeRequest): ProbeOutcome | Promise<ProbeOutcome>;
  probePorts(request: ProbeRequest): ProbeOutcome | Promise<ProbeOutcome>;
}

// ---------------------------------------------------------------------------
// 已安装实例
// ---------------------------------------------------------------------------

/**
 * 一个已安装版本的可观测快照（不可变）。
 *
 * `frozen` = 该版本已被升级**取代**（不再是在用版本），但仍保留、仍可被在途任务取回：
 * 升级**不得静默替换**在途任务手里的旧版本。
 */
export interface InstalledTemplate {
  readonly id: string;
  readonly version: string;
  readonly manifest: TemplateManifest;
  readonly installedAt: number;
  /** 是否是当前在用版本。 */
  readonly active: boolean;
  /** 是否已被取代（冻结保留）。 */
  readonly frozen: boolean;
  /** 是否已卸载（撤权、停用、不再接受新任务）。 */
  readonly uninstalled: boolean;
  readonly enabled: boolean;
  readonly grantedPermissions: readonly TemplatePermission[];
  /** 冻结/占用该版本的在途任务 id。 */
  readonly pinnedBy: readonly string[];
}

/** 卸载结果（如实描述"撤了什么权"）。 */
export interface UninstallReport {
  readonly id: string;
  readonly version: string;
  readonly revokedPermissions: readonly TemplatePermission[];
  readonly wasActive: boolean;
  /** 卸载后该版本是否仍被在途任务冻结持有（true ⇒ 记录保留，仅撤销新任务入口）。 */
  readonly retainedForPinnedTasks: boolean;
  /** 是否被真正移除（无在途任务时才会）。 */
  readonly removed: boolean;
}
