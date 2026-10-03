/**
 * F09 settings / 通知与后台说明（M09、I6）。
 *
 * 「进度通知、提醒权限、后台受限原因与系统设置入口。」
 * 不编造：提醒权限未授权时 `remindersEffective` 必须为 false，不得声称提醒可用；
 * 后台受限时给出**受限原因（脱敏）**与系统设置入口。
 */

import { sanitizeFailure, type RedactionKind } from './diagnostics.js';
import { SettingsError, type PermissionStatus } from './types.js';

export interface NotificationInput {
  /** 用户希望开启进度通知。 */
  readonly progress: boolean;
  /** 用户希望开启提醒。 */
  readonly reminders: boolean;
  /** 系统提醒权限状态。 */
  readonly reminderPermission: PermissionStatus;
  readonly backgroundRestricted: boolean;
  /** 后台受限原因（可能含路径/密钥，展示前必须脱敏）。 */
  readonly backgroundReason: string | null;
  /** 系统设置入口（settings:// 或 android.settings.*）。 */
  readonly systemSettingsEntry: string;
}

export interface NotificationView {
  /** 进度通知是否生效（用户开启 且 应用有通知能力）。 */
  readonly progressEffective: boolean;
  /** 提醒是否生效（用户开启 且 系统提醒权限已授权）。 */
  readonly remindersEffective: boolean;
  readonly reminderPermission: PermissionStatus;
  readonly backgroundRestricted: boolean;
  /** 脱敏后的后台受限说明；不受限时为 null。 */
  readonly backgroundNotice: string | null;
  readonly backgroundRedactedCount: number;
  readonly backgroundRedactedKinds: readonly RedactionKind[];
  readonly systemSettingsEntry: string;
  readonly label: string;
}

const SETTINGS_ENTRY_SHAPE = /^(settings:\/\/|android\.settings\.)[A-Za-z0-9._:/?#-]*$/;

export function isValidSettingsEntry(value: unknown): value is string {
  return typeof value === 'string' && SETTINGS_ENTRY_SHAPE.test(value);
}

/**
 * 推导通知视图。提醒权限未授权 ⇒ `remindersEffective=false` 且 `label` 明说提醒不可用；
 * 后台受限 ⇒ 提供脱敏原因与系统设置入口。
 */
export function describeNotifications(input: NotificationInput): NotificationView {
  if (!isValidSettingsEntry(input.systemSettingsEntry)) {
    throw new SettingsError('invalid-notification', '系统设置入口必须是 settings:// 或 android.settings.*', {});
  }
  const remindersEffective = input.reminders && input.reminderPermission === 'granted';

  let backgroundNotice: string | null = null;
  let backgroundRedactedCount = 0;
  let backgroundRedactedKinds: readonly RedactionKind[] = [];
  if (input.backgroundRestricted) {
    const rawReason = input.backgroundReason ?? '系统限制了后台运行';
    const sanitized = sanitizeFailure(rawReason);
    backgroundRedactedCount = sanitized.redactedCount;
    backgroundRedactedKinds = sanitized.redactedKinds;
    backgroundNotice = `${sanitized.message}；到「${input.systemSettingsEntry}」调整`;
  }

  const labelParts: string[] = [];
  labelParts.push(input.progress ? '进度通知：开' : '进度通知：关');
  if (input.reminders) {
    labelParts.push(remindersEffective ? '提醒：开' : `提醒：不可用（权限${input.reminderPermission}）`);
  } else {
    labelParts.push('提醒：关');
  }
  if (input.backgroundRestricted) labelParts.push('后台受限');

  return {
    progressEffective: input.progress,
    remindersEffective,
    reminderPermission: input.reminderPermission,
    backgroundRestricted: input.backgroundRestricted,
    backgroundNotice,
    backgroundRedactedCount,
    backgroundRedactedKinds,
    systemSettingsEntry: input.systemSettingsEntry,
    label: labelParts.join(' · '),
  };
}
