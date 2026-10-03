/**
 * F08 templates —— 四态派生、可操作阻断原因、目录行与详情（纯函数，零依赖）。
 *
 * 这是本包的核心：把 `TemplateLifecycle` 派生为界面可直接消费的**四态独立**视图
 * （design-07 行 157：已安装 / 已启用 / 已授权 / 端口就绪**分别**展示）。
 *
 * 绝不产出合并的「就绪」布尔——`TemplateReadiness` 只有四个字段，任何一个都不代表整体。
 * `blockers` 在任一维未就绪时必非空，且每条带可操作 `remedy`（I7）。
 */

import type {
  CapabilityDescriptor,
  TemplateBlocker,
  TemplateBlockerCode,
  TemplateCapabilityGap,
  TemplateCatalogRow,
  TemplateDefinition,
  TemplateDetail,
  TemplateLifecycle,
  TemplatePermission,
  TemplateReadiness,
  TemplatesState,
} from './types.js';
import { getTemplateDefinition, PERMISSION_ORDER } from './catalog.js';
import { getTemplate } from './lifecycle.js';

// ---------------------------------------------------------------------------
// 四态
// ---------------------------------------------------------------------------

function isInstalledPhase(phase: TemplateLifecycle['phase']): boolean {
  return phase === 'installed' || phase === 'updating';
}

/** required - granted，按规范序。 */
export function missingPermissions(lifecycle: TemplateLifecycle): readonly TemplatePermission[] {
  const granted = new Set(lifecycle.grantedPermissions);
  return PERMISSION_ORDER.filter(
    (permission) => lifecycle.requiredPermissions.includes(permission) && !granted.has(permission),
  );
}

/**
 * 派生四个**独立**就绪态（契约 `probe` 的同形投影）。
 *
 * 关键：这四个量互不推导成单一结论——
 *   - `installed`：安装态由 phase/版本决定；
 *   - `enabled`：启用开关**仅当已安装**才生效（未安装恒 false，避免「幽灵启用」）；
 *   - `authorized`：仅当已安装且 required 被 granted 全覆盖；
 *   - `portReady`：**直接来自内核探针**，与前三者正交（I2）。
 */
export function deriveReadiness(lifecycle: TemplateLifecycle): TemplateReadiness {
  const installed = isInstalledPhase(lifecycle.phase) && lifecycle.installedVersion !== null;
  const enabled = installed && lifecycle.enabled;
  const missing = missingPermissions(lifecycle);
  const authorized = installed && lifecycle.requiredPermissions.length > 0 && missing.length === 0;
  return {
    installed,
    enabled,
    authorized,
    portReady: lifecycle.portReady,
  };
}

// ---------------------------------------------------------------------------
// 可操作阻断原因
// ---------------------------------------------------------------------------

function blocker(
  code: TemplateBlockerCode,
  severity: TemplateBlocker['severity'],
  message: string,
  remedy: string,
): TemplateBlocker {
  return { code, message, remedy, severity };
}

/**
 * 派生阻断原因列表（固定顺序，保证断言可复现）。
 * 每条都带 `remedy`——design-07 行 157 要求「缺失项有可操作原因」。
 */
export function deriveBlockers(lifecycle: TemplateLifecycle): readonly TemplateBlocker[] {
  const readiness = deriveReadiness(lifecycle);
  const blockers: TemplateBlocker[] = [];

  if (lifecycle.phase === 'installing') {
    blockers.push(blocker('installing', 'info', '正在安装', '等待安装完成'));
  } else if (lifecycle.phase === 'updating') {
    blockers.push(blocker('updating', 'info', '正在更新', '等待更新完成'));
  } else if (!readiness.installed) {
    blockers.push(
      blocker('not-installed', 'error', '模版未安装', '安装该模版后再使用'),
    );
  }

  if (readiness.installed) {
    if (!readiness.enabled) {
      blockers.push(blocker('disabled', 'warn', '模版已安装但未启用', '启用模版'));
    }
    if (lifecycle.missingDependencies.length > 0) {
      blockers.push(
        blocker(
          'missing-dependency',
          'error',
          `依赖缺失：${lifecycle.missingDependencies.join('、')}`,
          '接通或安装所需依赖后重试',
        ),
      );
    }
    if (!lifecycle.runtimeCompatible) {
      blockers.push(
        blocker('incompatible', 'error', '当前设备运行时不兼容', '升级系统或改用受支持的 ABI'),
      );
    }
    const missing = missingPermissions(lifecycle);
    if (missing.length > 0) {
      blockers.push(
        blocker(
          'pending-authorization',
          'warn',
          `待授权：${missing.join('、')}`,
          `授权 ${missing.join('、')}`,
        ),
      );
    }
  }

  if (!readiness.portReady) {
    blockers.push(
      blocker(
        'not-port-ready',
        'warn',
        lifecycle.portReason ?? '运行时端口未就绪',
        '接通内核端口（K06 probe）后重试',
      ),
    );
  }

  if (lifecycle.unsupportedCapabilities.length > 0) {
    blockers.push(
      blocker(
        'capability-gap',
        'info',
        `当前运行时不支持能力：${lifecycle.unsupportedCapabilities.join('、')}`,
        '查看详情中不支持的能力，改用替代入口',
      ),
    );
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// 能力缺口
// ---------------------------------------------------------------------------

/** 该能力是否不可用：运行时不支持，或缺其所需权限未授予。 */
function gapReason(
  capability: CapabilityDescriptor,
  lifecycle: TemplateLifecycle,
  granted: ReadonlySet<TemplatePermission>,
): string | null {
  if (lifecycle.unsupportedCapabilities.includes(capability.id)) {
    return '当前运行时不支持该能力';
  }
  const required = capability.requiresPermission;
  if (required !== undefined && !granted.has(required)) {
    return `缺少权限：${required}`;
  }
  return null;
}

export function capabilityGaps(
  definition: TemplateDefinition,
  lifecycle: TemplateLifecycle,
): readonly TemplateCapabilityGap[] {
  const granted = new Set(lifecycle.grantedPermissions);
  const gaps: TemplateCapabilityGap[] = [];
  for (const capability of definition.capabilities) {
    const reason = gapReason(capability, lifecycle, granted);
    if (reason !== null) {
      gaps.push({ capabilityId: capability.id, label: capability.label, reason });
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// 目录行 / 详情
// ---------------------------------------------------------------------------

function toRow(definition: TemplateDefinition, lifecycle: TemplateLifecycle): TemplateCatalogRow {
  return {
    id: definition.id,
    displayName: definition.displayName,
    summary: definition.summary,
    installedVersion: lifecycle.installedVersion,
    catalogVersion: definition.version,
    phase: lifecycle.phase,
    readiness: deriveReadiness(lifecycle),
    missingPermissions: missingPermissions(lifecycle),
    capabilityGaps: capabilityGaps(definition, lifecycle),
    blockers: deriveBlockers(lifecycle),
    missingDependencies: lifecycle.missingDependencies,
    runtimeCompatible: lifecycle.runtimeCompatible,
    verificationMode: lifecycle.verificationMode,
  };
}

/**
 * 目录行：**七个模板恒可见**，无论安装与否（FRONTEND.md F08 行）。
 * 顺序固定为规范展示顺序。
 */
export function catalogRows(state: TemplatesState): readonly TemplateCatalogRow[] {
  return state.templates.map((lifecycle) => toRow(getTemplateDefinition(lifecycle.id), lifecycle));
}

/** 详情：目录行 + 静态能力 / 权限 / 数据范围 / 迁移（design-07 M06 行 158）。 */
export function templateDetail(state: TemplatesState, id: string): TemplateDetail {
  const lifecycle = getTemplate(state, id);
  const definition = getTemplateDefinition(id);
  const row = toRow(definition, lifecycle);
  return {
    ...row,
    capabilities: definition.capabilities,
    permissions: definition.permissions,
    grantedPermissions: lifecycle.grantedPermissions,
    runtimeCompatibility: definition.runtimeCompatibility,
    migration: definition.migration,
    producesFileFormats: definition.producesFileFormats,
    consumesFormats: definition.consumesFormats,
    externalDependency: definition.externalDependency,
    history: lifecycle.history,
    checkedAt: lifecycle.checkedAt,
    portReason: lifecycle.portReason,
  };
}
