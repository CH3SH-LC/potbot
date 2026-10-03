/**
 * F08 templates —— 模版目录 / 详情的视图模型类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包只产出**可断言的模版生命周期状态与纯函数**：不渲染、不引框架、不发网络请求、
 * 不读真实文件字节、不持久化、不碰 `KernelClient`、不读时钟 / 随机数。
 * 清单形状只读消费 `contracts/mobile-v1/types.ts`，不另发明契约。
 *
 * 只读消费（不改动）：
 *   - `contracts/mobile-v1/types.ts`：`TemplateManifest` / `TemplatePermission` /
 *     `RuntimeCompatibility` / `Migration` / `VerificationMode` / `VerificationLayer`。
 *
 * 设计来源：design-07 §7（M05 模版目录 / M06 模版详情）与 design-07 行 157 / 158 / 206 / 243：
 *   - 行 157：目录**分别**展示「已安装、已启用、已授权、依赖就绪、实际支持」，
 *     缺失项有**可操作原因**，不用一个绿色开关代表全部就绪。
 *   - 行 206：模板状态「可并存，不能压成一个『可用』标签」。
 *   - 行 243：安装 → 缺依赖/未授权原因 → 按需授权 → 运行中撤权 → 版本更新及新增权限
 *     → 回滚 → 卸载处理活动任务与数据。
 *
 * 核心不变量（由 `tests/mobile-ui/F08/` 机器化断言）：
 *   I1 **四态独立**：`installed / enabled / authorized / portReady` 是四个独立布尔，
 *      任何单值「就绪」都不会被产出。契约 `template-manifest.schema.json` 的
 *      `additionalProperties: false` 会直接拒绝合并字段（如 `ready`）。
 *   I2 **不能装 == 不能用**：`portReady` 来自内核探针，与安装态正交——
 *      允许「已授权但端口未就绪」与「端口就绪但未授权」两种并存（契约自带的
 *      word / meituan fixture 正是这两个方向的实例）。
 *   I3 **启用需已安装**：未安装时启用被拒（`not-installed`），不静默置位。
 *   I4 **授权 != 已启用**：授权覆盖 `requiredPermissions`（当前版本）才算 authorized；
 *      缺项时保留逐项待授权原因（`pending-authorization`）。
 *   I5 **更新比对新增权限**：目标版本新增的权限**不自动授予**，必须明确的再授权；
 *      因此更新后 authorized 会掉回 false 并给出 `pending-authorization`。
 *   I6 **回滚可复原**：回滚把安装版本与授权集合恢复到更新前快照，不凭猜。
 *   I7 **能力不足始终可见**：只要有任一维未就绪（或运行时不支持某能力），
 *      `blockers` 必非空，且每条 blocker 带可操作 `remedy`。
 */

import type {
  Migration,
  RuntimeCompatibility,
  TemplateManifest,
  TemplatePermission,
  TemplateProbe,
  VerificationLayer,
  VerificationMode,
} from '../../../../contracts/mobile-v1/types.js';

export type {
  Migration,
  RuntimeCompatibility,
  TemplateManifest,
  TemplatePermission,
  TemplateProbe,
  VerificationLayer,
  VerificationMode,
};

// ---------------------------------------------------------------------------
// 模板标识
// ---------------------------------------------------------------------------

/**
 * 七个业务模板的**规范 id**（与 `src/plugins/catalog.ts` 的 `plugin_id` 逐字一致）。
 *
 * 前端**不新造**模板名；「模版」是界面用字，底层模板模型与七模板范围不变（design-07 行 40 / 151）。
 */
export const TEMPLATE_IDS = [
  'template.document',
  'template.spreadsheet',
  'template.presentation',
  'template.meituan',
  'template.clock',
  'template.calendar',
  'template.research',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** 七个模板的确定性展示顺序；目录行按此排序，保证断言可复现。 */
export const TEMPLATE_CATALOG_COUNT = TEMPLATE_IDS.length;

// ---------------------------------------------------------------------------
// 静态定义（离线可得，不含任何运行时状态）
// ---------------------------------------------------------------------------

/** 一条能力描述（目录/详情展示用）。 */
export interface CapabilityDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 该能力依赖的权限；缺权限时能力不可用（用于「能力不足可见」）。 */
  readonly requiresPermission?: TemplatePermission;
}

/**
 * 一个模板的**静态定义**：来自产品目录，不是运行时探针结果。
 * 运行时四态在 `TemplateLifecycle` 里，两者严格分开——静态定义不得冒充就绪。
 */
export interface TemplateDefinition {
  readonly id: TemplateId;
  readonly displayName: string;
  readonly summary: string;
  /** 目录携带的当前版本（`^\d+\.\d+\.\d+$`）。 */
  readonly version: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  /** 该版本要求的权限集合（授权判定基准）。 */
  readonly permissions: readonly TemplatePermission[];
  readonly runtimeCompatibility: RuntimeCompatibility;
  readonly migration: Migration;
  /** 产出的文件格式（无则空数组：美团/时钟/日历/资料检索**不产出** OOXML）。 */
  readonly producesFileFormats: readonly string[];
  /** 可消费的输入资料格式。 */
  readonly consumesFormats: readonly string[];
  /** 该模板依赖的外部端口（人可读；缺失即 `missing-dependency`）。 */
  readonly externalDependency: string;
}

// ---------------------------------------------------------------------------
// 运行时生命周期状态
// ---------------------------------------------------------------------------

/**
 * 生命周期阶段。与 design-07 行 206 的词表对齐：
 * 未安装 / 安装中 / 已安装 / （启用/停用由独立 `enabled` 布尔表达）/ 卸载中 / 更新中。
 */
export type TemplatePhase =
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'uninstalling'
  | 'updating';

/** 一个已安装版本的回滚快照（回滚时逐字段复原，不重建）。 */
export interface TemplateVersionSnapshot {
  readonly version: string;
  readonly requiredPermissions: readonly TemplatePermission[];
  readonly grantedPermissions: readonly TemplatePermission[];
  readonly enabled: boolean;
}

/**
 * 单个模板的运行时状态。
 *
 * 注意：这里**没有** `ready` 合并字段，也没有任何一个字段能表达「全部就绪」——
 * 四态分别由 `phase` / `enabled` / `grantedPermissions` / `portReady` 派生（I1）。
 */
export interface TemplateLifecycle {
  readonly id: TemplateId;
  readonly phase: TemplatePhase;
  /** 启用开关。仅当已安装时才有语义；未安装时强制 false（I3）。 */
  readonly enabled: boolean;
  /** 已安装版本；未安装为 null。 */
  readonly installedVersion: string | null;
  /** 当前安装版本要求的权限（授权判定基准）。 */
  readonly requiredPermissions: readonly TemplatePermission[];
  /** 用户已授予的权限。 */
  readonly grantedPermissions: readonly TemplatePermission[];
  /** 内核探针：该模板的运行时端口是否就绪（与安装态正交，I2）。 */
  readonly portReady: boolean;
  /** 端口未就绪的可操作原因（来自探针；不得含密钥 / 地址 / 手机号）。 */
  readonly portReason: string | null;
  /** 运行时不支持的能力 id（「实际支持」不足，design-07 行 157）。 */
  readonly unsupportedCapabilities: readonly string[];
  /** 缺失的依赖（如未接通的外部端口）。 */
  readonly missingDependencies: readonly string[];
  /** 运行时兼容性判定（安卓版本 / ABI / runtime）。 */
  readonly runtimeCompatible: boolean;
  readonly verificationMode: VerificationMode;
  readonly layers: readonly VerificationLayer[];
  /** 探针检查时间（UTC ISO 8601）；未探测为 null。 */
  readonly checkedAt: string | null;
  /** 乐观锁版本：每次写入 +1；不作为契约字段，仅视图内部用。 */
  readonly revision: number;
  /** 已安装版本历史（最近一次在末尾）；回滚据此复原（I6）。 */
  readonly history: readonly TemplateVersionSnapshot[];
}

export interface TemplatesState {
  readonly templates: readonly TemplateLifecycle[];
  /** id → 下标：O(1) 定位。 */
  readonly indexById: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// 派生视图（目录行 / 详情）
// ---------------------------------------------------------------------------

/** 四个独立就绪态（契约 `probe` 的同形投影）。**不提供**任何合并布尔。 */
export interface TemplateReadiness {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly portReady: boolean;
}

export type BlockerSeverity = 'info' | 'warn' | 'error';

/**
 * 可操作阻断原因。每条**必须**带 `remedy`——缺失项要给用户可操作出口，
 * 不能只显示一个红点（design-07 行 157 / 206）。
 */
export interface TemplateBlocker {
  readonly code: TemplateBlockerCode;
  readonly message: string;
  readonly remedy: string;
  readonly severity: BlockerSeverity;
}

export type TemplateBlockerCode =
  | 'installing'
  | 'updating'
  | 'not-installed'
  | 'disabled'
  | 'missing-dependency'
  | 'incompatible'
  | 'pending-authorization'
  | 'not-port-ready'
  | 'capability-gap';

/** 能力缺口：某能力因为缺权限 / 运行时不支持而不可用。 */
export interface TemplateCapabilityGap {
  readonly capabilityId: string;
  readonly label: string;
  readonly reason: string;
}

/** 目录行：七行恒可见，无论是否安装（FRONTEND.md F08 行）。 */
export interface TemplateCatalogRow {
  readonly id: TemplateId;
  readonly displayName: string;
  readonly summary: string;
  /** 已安装版本；未安装为目录版本（便于展示「可安装到 vX」）。 */
  readonly installedVersion: string | null;
  /** 目录（可安装）版本。 */
  readonly catalogVersion: string;
  readonly phase: TemplatePhase;
  readonly readiness: TemplateReadiness;
  /** 待授权权限（required - granted），按规范序。 */
  readonly missingPermissions: readonly TemplatePermission[];
  readonly capabilityGaps: readonly TemplateCapabilityGap[];
  readonly blockers: readonly TemplateBlocker[];
  readonly missingDependencies: readonly string[];
  readonly runtimeCompatible: boolean;
  readonly verificationMode: VerificationMode;
}

/** 详情：目录行 + 静态能力 / 权限 / 数据范围 / 迁移信息（design-07 M06 行 158）。 */
export interface TemplateDetail extends TemplateCatalogRow {
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly permissions: readonly TemplatePermission[];
  readonly grantedPermissions: readonly TemplatePermission[];
  readonly runtimeCompatibility: RuntimeCompatibility;
  readonly migration: Migration;
  readonly producesFileFormats: readonly string[];
  readonly consumesFormats: readonly string[];
  readonly externalDependency: string;
  readonly history: readonly TemplateVersionSnapshot[];
  readonly checkedAt: string | null;
  readonly portReason: string | null;
}

/** 权限差异：更新时比对**新增**权限（新增必须再授权，design-07 行 158 / 243）。 */
export interface PermissionDelta {
  readonly added: readonly TemplatePermission[];
  readonly removed: readonly TemplatePermission[];
  readonly unchanged: readonly TemplatePermission[];
  /** 新增权限非空 ⇒ 需要明确再授权。 */
  readonly requiresReauthorization: boolean;
}

/** 一次待应用的更新（目标版本 + 其权限集合）。 */
export interface PendingUpdate {
  readonly version: string;
  readonly permissions: readonly TemplatePermission[];
}

/**
 * 卸载范围：卸载模板前**必须**逐类声明关联对象的处置（design-07 行 243「卸载处理活动任务与数据」）。
 * 缺字段 ⇒ 拒绝卸载，绝不猜默认范围（与 F03 的 `DeleteScope` 同构）。
 */
export interface UninstallScope {
  /** 运行中的任务如何处理：取消 / 等待完成后再卸。 */
  readonly activeTasks: 'cancel' | 'await';
  /** 该模板产出的 artifact 数据如何处理：级联移除 / 保留。 */
  readonly artifactData: 'cascade' | 'retain';
  /** 卸载失败是否保留已安装状态（不半卸载）。 */
  readonly keepInstalledOnFailure: boolean;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type TemplateErrorCode =
  | 'unknown-template'
  | 'invalid-transition'
  | 'invalid-version'
  | 'invalid-permissions'
  | 'no-rollback-target'
  | 'permission-not-granted'
  | 'duplicate-template';

/**
 * 结构化错误：只带 code + 可读 message + 脱敏 details，不含密钥 / 路径 / 手机号。
 * 测试按 `code` 断言，避免只匹配文案。
 */
export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: TemplateErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.details = details;
  }
}
