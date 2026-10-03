/**
 * F08 templates —— 模版生命周期操作（安装 / 卸载 / 启用 / 停用 / 授权 / 撤权 / 端口探针 /
 * 更新 / 回滚）。全部是**纯函数**：`(state, …) => state`，不读时钟、不读随机数、不做 IO。
 *
 * 设计约束（design-07 行 206 / 243）：
 *   - 状态可并存，绝不压成一个「可用」标签；
 *   - 安装 → 缺依赖/未授权原因 → 按需授权 → 运行中撤权 → 版本更新及新增权限 → 回滚；
 *   - 卸载必须处理「活动任务与数据」——本层用 `UninstallScope` 显式要求调用方声明处置，
 *     与 F03 的删除范围同构（缺失 scope ⇒ 拒绝，不猜默认）。
 *
 * 所有写操作都会 `revision + 1`；未知模板抛 `unknown-template`；非法迁移抛 `invalid-transition`。
 */

import type {
  PermissionDelta,
  TemplateId,
  TemplateLifecycle,
  TemplatePermission,
  TemplatePhase,
  TemplateVersionSnapshot,
  TemplatesState,
  UninstallScope,
} from './types.js';
import { TemplateError, TEMPLATE_IDS } from './types.js';
import { getTemplateDefinition, normalizePermissions, PERMISSION_ORDER } from './catalog.js';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 单个模板的初始生命周期：未安装、未启用、未授权、端口未就绪。 */
export function createTemplateLifecycle(id: TemplateId): TemplateLifecycle {
  return {
    id,
    phase: 'not-installed',
    enabled: false,
    installedVersion: null,
    requiredPermissions: [],
    grantedPermissions: [],
    portReady: false,
    portReason: null,
    unsupportedCapabilities: [],
    missingDependencies: [],
    runtimeCompatible: true,
    verificationMode: 'fixture',
    layers: ['unit'],
    checkedAt: null,
    revision: 0,
    history: [],
  };
}

/**
 * 空状态：七个模板全部为「未安装」。**七行恒在**——目录不因为未安装就把模板藏起来。
 */
export function createTemplatesState(): TemplatesState {
  const templates = TEMPLATE_IDS.map(createTemplateLifecycle);
  return buildState(templates);
}

function buildState(templates: readonly TemplateLifecycle[]): TemplatesState {
  const indexById: Record<string, number> = {};
  templates.forEach((template, index) => {
    indexById[template.id] = index;
  });
  return { templates, indexById: Object.freeze(indexById) };
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 取某模板的生命周期；未知 id 抛错（不返回 null 静默降级）。 */
export function getTemplate(state: TemplatesState, id: string): TemplateLifecycle {
  const index = state.indexById[id];
  if (index === undefined) {
    throw new TemplateError('unknown-template', `未知模板 id：${id}`, { id });
  }
  const template = state.templates[index];
  if (template === undefined) {
    throw new TemplateError('unknown-template', `模板索引损坏：${id}`, { id });
  }
  return template;
}

// ---------------------------------------------------------------------------
// 内部替换
// ---------------------------------------------------------------------------

/** 用 patch 覆盖某模板，revision +1；其余模板逐字段不变。 */
function patchTemplate(
  state: TemplatesState,
  id: string,
  patch: Partial<TemplateLifecycle>,
): TemplatesState {
  const current = getTemplate(state, id);
  const next: TemplateLifecycle = { ...current, ...patch, revision: current.revision + 1 };
  const templates = state.templates.map((template) => (template.id === current.id ? next : template));
  return buildState(templates);
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new TemplateError('invalid-version', `版本号必须是 x.y.z：${version}`, { version });
  }
}

function assertPermissions(permissions: readonly TemplatePermission[]): void {
  for (const permission of permissions) {
    if (!PERMISSION_ORDER.includes(permission)) {
      throw new TemplateError('invalid-permissions', `未知权限：${String(permission)}`, {
        permission,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 安装 / 卸载
// ---------------------------------------------------------------------------

/** 进入「安装中」。未安装态才允许；否则 `invalid-transition`。 */
export function beginInstall(state: TemplatesState, id: string): TemplatesState {
  const current = getTemplate(state, id);
  if (current.phase !== 'not-installed') {
    throw new TemplateError('invalid-transition', `仅未安装态可开始安装：${current.phase}`, {
      id,
      phase: current.phase,
    });
  }
  return patchTemplate(state, id, { phase: 'installing' });
}

/**
 * 完成安装：置为已安装、记录版本与 requiredPermissions。
 * 已安装的权限**不自动授予**（`completedInstall` 只装不授权），授权是独立一步（I4）。
 */
export function completeInstall(state: TemplatesState, id: string, version: string): TemplatesState {
  assertVersion(version);
  const current = getTemplate(state, id);
  if (current.phase !== 'installing') {
    throw new TemplateError('invalid-transition', `仅安装中可完成安装：${current.phase}`, {
      id,
      phase: current.phase,
    });
  }
  const definition = getTemplateDefinition(id);
  const requiredPermissions = normalizePermissions(definition.permissions);
  return patchTemplate(state, id, {
    phase: 'installed',
    installedVersion: version,
    enabled: false,
    requiredPermissions,
    grantedPermissions: [],
    // 安装本身**不**判定依赖缺失——依赖缺失由内核探针 `recordProbe` 上报，
    // 前端不把「模板声明需要某依赖」等同为「依赖当前缺失」。
    missingDependencies: [],
    // 首次安装不产生回滚快照：回滚的目标是**上一个版本**，只有更新过才存在。
    history: [],
  });
}

/** 一步安装（begin + complete）。仅用于测试与本地 fixture。 */
export function installTemplate(state: TemplatesState, id: string, version: string): TemplatesState {
  return completeInstall(beginInstall(state, id), id, version);
}

/**
 * 卸载：必须显式声明 `UninstallScope`（活动任务与数据的处置），否则拒绝（I 设计约束）。
 * 卸载后清除安装版本、启用位与授权集合（授权随版本生命周期消失）。
 */
export function uninstallTemplate(
  state: TemplatesState,
  id: string,
  scope: UninstallScope,
): TemplatesState {
  const current = getTemplate(state, id);
  if (!isScopeComplete(scope)) {
    throw new TemplateError('invalid-transition', '卸载必须声明活动任务与数据的处置范围', {
      id,
    });
  }
  if (current.phase === 'not-installed') {
    throw new TemplateError('invalid-transition', '未安装的模板不能卸载', { id });
  }
  return patchTemplate(state, id, {
    phase: 'not-installed',
    enabled: false,
    installedVersion: null,
    requiredPermissions: [],
    grantedPermissions: [],
    portReady: false,
    portReason: null,
    unsupportedCapabilities: [],
    missingDependencies: [],
    history: [],
  });
}

function isScopeComplete(scope: UninstallScope): boolean {
  return (
    scope.activeTasks !== undefined &&
    scope.artifactData !== undefined &&
    scope.keepInstalledOnFailure !== undefined
  );
}

// ---------------------------------------------------------------------------
// 启用 / 停用
// ---------------------------------------------------------------------------

/** 启用。未安装被拒（`invalid-transition`）—— 不静默把未安装模板置为「启用」（I3）。 */
export function enableTemplate(state: TemplatesState, id: string): TemplatesState {
  const current = getTemplate(state, id);
  if (!isInstalled(current.phase)) {
    throw new TemplateError('invalid-transition', '未安装的模板不能启用', {
      id,
      phase: current.phase,
    });
  }
  return patchTemplate(state, id, { enabled: true });
}

/** 停用。已安装才可停用。 */
export function disableTemplate(state: TemplatesState, id: string): TemplatesState {
  const current = getTemplate(state, id);
  if (!isInstalled(current.phase)) {
    throw new TemplateError('invalid-transition', '未安装的模板不能停用', {
      id,
      phase: current.phase,
    });
  }
  return patchTemplate(state, id, { enabled: false });
}

function isInstalled(phase: TemplatePhase): boolean {
  return phase === 'installed' || phase === 'updating';
}

// ---------------------------------------------------------------------------
// 授权 / 撤权
// ---------------------------------------------------------------------------

/**
 * 授权：把权限加入 granted 集合。已安装才可授权；未知权限被拒（`invalid-permissions`）。
 * 只增不删；撤权走 `revokePermission`。
 */
export function authorizeTemplate(
  state: TemplatesState,
  id: string,
  permissions: readonly TemplatePermission[],
): TemplatesState {
  const current = getTemplate(state, id);
  if (!isInstalled(current.phase)) {
    throw new TemplateError('invalid-transition', '未安装的模板不能授权', { id, phase: current.phase });
  }
  assertPermissions(permissions);
  const merged = normalizePermissions([...current.grantedPermissions, ...permissions]);
  return patchTemplate(state, id, { grantedPermissions: merged });
}

/** 撤权：只移除指定权限；未授予的权限被拒（`permission-not-granted`），不静默通过。 */
export function revokePermission(
  state: TemplatesState,
  id: string,
  permission: TemplatePermission,
): TemplatesState {
  const current = getTemplate(state, id);
  if (!current.grantedPermissions.includes(permission)) {
    throw new TemplateError('permission-not-granted', `权限未授予，无法撤销：${permission}`, {
      id,
      permission,
    });
  }
  return patchTemplate(state, id, {
    grantedPermissions: current.grantedPermissions.filter((item) => item !== permission),
  });
}

// ---------------------------------------------------------------------------
// 端口探针 / 依赖 / 兼容性（内核上报，前端只记录不推断）
// ---------------------------------------------------------------------------

export interface ProbeInput {
  readonly portReady: boolean;
  /** 未就绪原因（人可读、脱敏）。ready 时必须为 null。 */
  readonly portReason?: string | null;
  readonly unsupportedCapabilities?: readonly string[];
  readonly missingDependencies?: readonly string[];
  readonly runtimeCompatible?: boolean;
  readonly checkedAt?: string;
}

/**
 * 记录内核探针结果。**只记录内核结论**，前端不自行推断端口是否就绪（design-07 行 157）。
 * `portReady=true` 时强制清空原因。
 */
export function recordProbe(state: TemplatesState, id: string, probe: ProbeInput): TemplatesState {
  if (probe.portReady && probe.portReason != null && probe.portReason !== '') {
    throw new TemplateError('invalid-transition', 'portReady=true 时不得携带未就绪原因', { id });
  }
  return patchTemplate(state, id, {
    portReady: probe.portReady,
    portReason: probe.portReady ? null : (probe.portReason ?? current0(state, id).portReason),
    unsupportedCapabilities: normalizeCapabilityIds(
      probe.unsupportedCapabilities ?? current0(state, id).unsupportedCapabilities,
    ),
    missingDependencies: normalizeStringList(
      probe.missingDependencies ?? current0(state, id).missingDependencies,
    ),
    runtimeCompatible: probe.runtimeCompatible ?? current0(state, id).runtimeCompatible,
    checkedAt: probe.checkedAt ?? current0(state, id).checkedAt,
  });
}

function current0(state: TemplatesState, id: string): TemplateLifecycle {
  // 取当前值以支持「部分更新」；单独函数便于阅读。
  const index = state.indexById[id];
  const template = index === undefined ? undefined : state.templates[index];
  if (template === undefined) {
    throw new TemplateError('unknown-template', `未知模板 id：${id}`, { id });
  }
  return template;
}

function normalizeCapabilityIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

function normalizeStringList(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// 更新 / 回滚
// ---------------------------------------------------------------------------

/**
 * 应用一次版本更新（design-07 行 158 / 243）。
 *
 * 语义：
 *   - 记录更新前快照（版本 + 授权 + required）供回滚（I6）；
 *   - 安装版本切到目标版本，required 换成目标权限集合；
 *   - **新增权限不自动授予**：granted 与目标集合取交集 ⇒ 新增权限丢失，
 *     因此 authorized 会掉回 false 并出现 `pending-authorization`（I5）；
 *   - 被目标版本移除的权限从 granted 中剔除（不再需要，且不残留越权）。
 */
export function applyUpdate(
  state: TemplatesState,
  id: string,
  update: { readonly version: string; readonly permissions: readonly TemplatePermission[] },
): { readonly state: TemplatesState; readonly delta: PermissionDelta } {
  assertVersion(update.version);
  assertPermissions(update.permissions);
  const current = getTemplate(state, id);
  if (!isInstalled(current.phase)) {
    throw new TemplateError('invalid-transition', '未安装的模板不能更新', { id, phase: current.phase });
  }
  const targetRequired = normalizePermissions(update.permissions);
  const delta = diffPermissions(current.requiredPermissions, targetRequired);
  const snapshot: TemplateVersionSnapshot = {
    version: current.installedVersion ?? '0.0.0',
    requiredPermissions: current.requiredPermissions,
    grantedPermissions: current.grantedPermissions,
    enabled: current.enabled,
  };
  const nextGranted = current.grantedPermissions.filter((permission) =>
    targetRequired.includes(permission),
  );
  const next = patchTemplate(state, id, {
    phase: 'installed',
    installedVersion: update.version,
    requiredPermissions: targetRequired,
    grantedPermissions: nextGranted,
    history: [...current.history, snapshot],
  });
  return { state: next, delta };
}

/**
 * 回滚到上一个已安装版本快照（I6）。没有可回滚目标时抛 `no-rollback-target`。
 * 复原版本、required 与 granted（授权集合回到更新前，包含新增的那次授权状态）。
 */
export function rollbackTemplate(state: TemplatesState, id: string): TemplatesState {
  const current = getTemplate(state, id);
  const history = current.history;
  const snapshot = history[history.length - 1];
  if (snapshot === undefined) {
    throw new TemplateError('no-rollback-target', '没有可回滚的版本快照', { id });
  }
  return patchTemplate(state, id, {
    phase: 'installed',
    installedVersion: snapshot.version,
    requiredPermissions: snapshot.requiredPermissions,
    grantedPermissions: snapshot.grantedPermissions,
    enabled: snapshot.enabled,
    history: history.slice(0, -1),
  });
}

// ---------------------------------------------------------------------------
// 权限差异
// ---------------------------------------------------------------------------

/** 比对 cur → next 的权限差异；added 非空 ⇒ 需再授权（I5）。 */
export function diffPermissions(
  cur: readonly TemplatePermission[],
  next: readonly TemplatePermission[],
): PermissionDelta {
  const curSet = new Set(cur);
  const nextSet = new Set(next);
  const added = PERMISSION_ORDER.filter((permission) => nextSet.has(permission) && !curSet.has(permission));
  const removed = PERMISSION_ORDER.filter(
    (permission) => curSet.has(permission) && !nextSet.has(permission),
  );
  const unchanged = PERMISSION_ORDER.filter(
    (permission) => curSet.has(permission) && nextSet.has(permission),
  );
  return {
    added,
    removed,
    unchanged,
    requiresReauthorization: added.length > 0,
  };
}
