/**
 * F09 settings / 权限与连接（M07、I3）。
 *
 * 「权限在使用前按需申请；拒绝后提供当前可完成部分和准确恢复入口，不循环弹系统权限窗。」
 * 「撤权影响后续工具调用」——撤权**实时**反映：`revoke` 后 `statusOf` / `granted()` /
 * `isCapabilityAllowed` 立即改变，不做延迟或缓存命中。
 */

import type { TemplatePermission } from '../../../../contracts/mobile-v1/types.js';

import {
  CAPABILITY_REQUIREMENTS,
  PERMISSION_LABELS,
  SettingsError,
  isIsoTimestamp,
  type CapabilityId,
  type PermissionStatus,
} from './types.js';

export interface PermissionEntry {
  readonly permission: TemplatePermission;
  readonly status: PermissionStatus;
  /** 授权范围描述（design-07「授权范围」）。 */
  readonly scope: string;
  readonly grantedAt: string | null;
  readonly revokedAt: string | null;
}

export interface CapabilityDecision {
  readonly capability: CapabilityId;
  readonly allowed: boolean;
  /** 缺失（未授权/被撤销）的权限。 */
  readonly missing: readonly TemplatePermission[];
  /** 当前可完成部分 / 恢复入口说明。 */
  readonly hint: string;
}

/** 系统级权限（需跳系统设置）vs 应用内权限（可应用内恢复）。 */
const SYSTEM_LEVEL_PERMISSIONS: readonly TemplatePermission[] = ['device'];

/** 每个权限的准确恢复入口文案。 */
export function recoveryHint(permission: TemplatePermission, status: PermissionStatus): string {
  const label = PERMISSION_LABELS[permission];
  const entry = SYSTEM_LEVEL_PERMISSIONS.includes(permission) ? '系统设置 → 应用 → 权限' : '设置 → 权限与连接';
  if (status === 'granted') return `${label}已授权`;
  if (status === 'revoked') return `${label}已撤销；到「${entry}」重新授权`;
  if (status === 'denied') return `${label}被拒绝；到「${entry}」开启后再继续`;
  return `${label}尚未申请；到「${entry}」按需授权`;
}

export interface PermissionRegistry {
  entryOf(permission: TemplatePermission): PermissionEntry;
  statusOf(permission: TemplatePermission): PermissionStatus;
  grant(permission: TemplatePermission, nowIso: string, scope?: string): PermissionEntry;
  deny(permission: TemplatePermission, nowIso: string, scope?: string): PermissionEntry;
  /** 撤销：**立即**生效。 */
  revoke(permission: TemplatePermission, nowIso: string): PermissionEntry;
  /** 已授权权限快照。 */
  granted(): readonly TemplatePermission[];
  snapshot(): readonly PermissionEntry[];
  isCapabilityAllowed(capability: CapabilityId): CapabilityDecision;
}

function assertPermission(permission: string): asserts permission is TemplatePermission {
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_LABELS, permission)) {
    throw new SettingsError('unknown-permission', '未知权限', { permission });
  }
}

export function createPermissionRegistry(
  initial?: readonly { permission: TemplatePermission; status?: PermissionStatus; scope?: string }[],
): PermissionRegistry {
  const store = new Map<TemplatePermission, PermissionEntry>();

  const make = (
    permission: TemplatePermission,
    status: PermissionStatus,
    scope: string,
    nowIso: string | null,
  ): PermissionEntry => ({
    permission,
    status,
    scope,
    grantedAt: status === 'granted' ? nowIso : null,
    revokedAt: status === 'revoked' ? nowIso : null,
  });

  for (const item of initial ?? []) {
    assertPermission(item.permission);
    store.set(item.permission, make(item.permission, item.status ?? 'not-requested', item.scope ?? '', null));
  }

  const require = (permission: TemplatePermission): PermissionEntry => {
    const found = store.get(permission);
    if (found === undefined) {
      throw new SettingsError('unknown-permission', '权限尚未登记', { permission });
    }
    return found;
  };

  const set = (
    permission: TemplatePermission,
    status: PermissionStatus,
    nowIso: string,
    scope: string,
  ): PermissionEntry => {
    assertPermission(permission);
    if (!isIsoTimestamp(nowIso)) {
      throw new SettingsError('invalid-timestamp', '权限变更时间必须是 UTC ISO', {});
    }
    const entry = make(permission, status, scope, nowIso);
    store.set(permission, entry);
    return entry;
  };

  return {
    entryOf(permission: TemplatePermission): PermissionEntry {
      return require(permission);
    },
    statusOf(permission: TemplatePermission): PermissionStatus {
      return require(permission).status;
    },
    grant(permission, nowIso, scope = ''): PermissionEntry {
      return set(permission, 'granted', nowIso, scope);
    },
    deny(permission, nowIso, scope = ''): PermissionEntry {
      return set(permission, 'denied', nowIso, scope);
    },
    revoke(permission, nowIso): PermissionEntry {
      return set(permission, 'revoked', nowIso, require(permission).scope);
    },
    granted(): readonly TemplatePermission[] {
      return [...store.values()]
        .filter((entry) => entry.status === 'granted')
        .map((entry) => entry.permission)
        .sort();
    },
    snapshot(): readonly PermissionEntry[] {
      return [...store.values()].sort((a, b) => (a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0));
    },
    isCapabilityAllowed(capability: CapabilityId): CapabilityDecision {
      const required = CAPABILITY_REQUIREMENTS[capability];
      const missing = required.filter((permission) => store.get(permission)?.status !== 'granted');
      const allowed = missing.length === 0;
      const hint = allowed
        ? '全部所需权限已授权'
        : missing.map((permission) => recoveryHint(permission, store.get(permission)?.status ?? 'not-requested')).join('；');
      return { capability, allowed, missing, hint };
    },
  };
}
