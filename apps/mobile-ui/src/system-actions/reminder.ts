/**
 * F-R06 system-actions —— 提醒 / 计时（T07）专属表单。
 *
 * design-07 行 55 T07：自管/系统归属、闹钟、计时器、秒表、世界时钟；
 * 行 187 CLK-07–10：重启/时区/精确提醒权限、系统接口边界、**自管与系统分别验收**、
 * **不把 dismiss 都标为删除**。
 *
 * 本模块产出 `ReminderFormView` 与一张**动作效果表**：
 *   - `owner`（自管 / 系统）必须显式，系统归属还要给系统通道引用（I-D）；
 *   - 权限 `denied`/`unknown` 时表单可构建但 `armed=false` + `blockedReason`——不假报已设置；
 *   - `reminderActionEffect` 把「停止未来触发」与「删除记录」分开（I-E）。
 */

import { returnTargetFor, type ConversationReturnTarget } from './return.js';
import {
  requireIsoTimestamp,
  requireResolvedTime,
  requireTimezone,
  summarizeTime,
  type TimeSpec,
} from './time.js';
import {
  SystemActionError,
  makeWarning,
  requireNonEmptyString,
  requireOccurrenceScope,
  requireRecurrence,
  requireTitle,
  type FormWarning,
  type Recurrence,
  type RecurrenceScope,
} from './types.js';

export type ReminderKind = 'alarm' | 'timer' | 'stopwatch' | 'world-clock' | 'reminder';
export const REMINDER_KINDS: readonly ReminderKind[] = [
  'alarm',
  'timer',
  'stopwatch',
  'world-clock',
  'reminder',
];

/** 归属：`self` 自管 / `system` 交系统（design-07 行 187「自管与系统分别验收」）。 */
export type ReminderOwner = 'self' | 'system';
export const REMINDER_OWNERS: readonly ReminderOwner[] = ['self', 'system'];

export type ReminderPermission = 'granted' | 'denied' | 'unknown';
export const REMINDER_PERMISSIONS: readonly ReminderPermission[] = ['granted', 'denied', 'unknown'];

export type ReminderBlockedReason = 'permission-denied' | 'permission-unknown';

export function requireReminderKind(value: unknown): ReminderKind {
  if (typeof value !== 'string' || !REMINDER_KINDS.includes(value as ReminderKind)) {
    throw new SystemActionError('invalid-reminder-kind', `reminder kind 非法：${String(value)}`, {
      field: 'kind',
    });
  }
  return value as ReminderKind;
}

export function requireReminderOwner(value: unknown): ReminderOwner {
  if (typeof value !== 'string' || !REMINDER_OWNERS.includes(value as ReminderOwner)) {
    throw new SystemActionError('invalid-reminder-owner', `reminder owner 非法：${String(value)}`, {
      field: 'owner',
    });
  }
  return value as ReminderOwner;
}

export function requireReminderPermission(value: unknown): ReminderPermission {
  if (typeof value !== 'string' || !REMINDER_PERMISSIONS.includes(value as ReminderPermission)) {
    throw new SystemActionError('invalid-reminder-kind', `permission 非法：${String(value)}`, {
      field: 'permission',
    });
  }
  return value as ReminderPermission;
}

export interface ReminderInput {
  readonly reminderId?: string;
  readonly conversationId: string;
  readonly anchorMessageId?: string | null;
  readonly kind: ReminderKind;
  readonly label: string;
  readonly owner: ReminderOwner;
  /** alarm / reminder 必填；相对表达会被 I-A 拒绝。 */
  readonly time?: TimeSpec;
  /** timer 必填（正整数毫秒）。 */
  readonly durationMs?: number;
  /** world-clock 必填。 */
  readonly timezone?: string;
  readonly recurrence?: Recurrence | null;
  readonly occurrenceScope?: RecurrenceScope;
  /** owner=`system` 必填：系统提醒通道/应用引用。 */
  readonly systemChannel?: string;
  readonly permission: ReminderPermission;
  readonly expectedRevision?: number;
}

export interface ReminderFormView {
  readonly kind: 'reminder';
  readonly conversationId: string;
  readonly reminderId: string | null;
  readonly reminderKind: ReminderKind;
  readonly label: string;
  readonly owner: ReminderOwner;
  /** 绝对执行摘要（I-A）；无时间型（秒表）为 null。 */
  readonly timeSummary: string | null;
  readonly durationMs: number | null;
  readonly timezone: string | null;
  readonly recurrenceRule: string | null;
  readonly occurrenceScope: RecurrenceScope | null;
  readonly systemChannel: string | null;
  readonly permission: ReminderPermission;
  /** 是否已武装（可被触发）。权限非 granted 时恒为 false。 */
  readonly armed: boolean;
  readonly blockedReason: ReminderBlockedReason | null;
  readonly warnings: readonly FormWarning[];
  readonly returnTarget: ConversationReturnTarget;
  readonly expectedRevision: number | null;
}

/** 校验并构造提醒/计时详情表单。 */
export function buildReminderForm(input: ReminderInput): ReminderFormView {
  const label = requireTitle(input.label, 'label');
  const kind = requireReminderKind(input.kind);
  const owner = requireReminderOwner(input.owner);
  const permission = requireReminderPermission(input.permission);
  const returnTarget = returnTargetFor(input.conversationId, input.anchorMessageId);

  let timeSummary: string | null = null;
  let timezone: string | null = null;
  let durationMs: number | null = null;

  if (kind === 'alarm' || kind === 'reminder') {
    timeSummary = summarizeTime(input.time, 'time');
  }
  if (kind === 'timer') {
    if (typeof input.durationMs !== 'number' || !Number.isInteger(input.durationMs) || input.durationMs <= 0) {
      throw new SystemActionError('missing-duration', 'timer 必须给出正整数 durationMs', {
        field: 'durationMs',
      });
    }
    durationMs = input.durationMs;
  }
  if (kind === 'world-clock') {
    timezone = requireTimezone(input.timezone, 'timezone');
  }

  let systemChannel: string | null = null;
  if (owner === 'system') {
    systemChannel = requireNonEmptyString(
      input.systemChannel,
      'systemChannel',
      'missing-system-channel',
      'system 归属必须给出系统提醒通道引用',
    );
  }

  const recurrence = requireRecurrence(input.recurrence);
  const editing = typeof input.reminderId === 'string' && input.reminderId.trim() !== '';
  const occurrenceScope = requireOccurrenceScope({
    recurring: recurrence !== null,
    editing,
    provided: input.occurrenceScope,
  });

  let blockedReason: ReminderBlockedReason | null = null;
  if (permission === 'denied') blockedReason = 'permission-denied';
  else if (permission === 'unknown') blockedReason = 'permission-unknown';

  const warnings: FormWarning[] = [];
  if (blockedReason === 'permission-denied') {
    warnings.push(makeWarning('permission-denied', '精确提醒权限被拒绝，本提醒不会触发；未标记为已设置', 'error'));
  } else if (blockedReason === 'permission-unknown') {
    warnings.push(makeWarning('permission-unknown', '提醒权限状态未知，需确认后才能触发', 'warn'));
  }
  if (owner === 'system') {
    warnings.push(makeWarning('system-owned', '本提醒交由系统调度，属系统归属', 'info'));
  }
  if (recurrence !== null && editing) {
    warnings.push(makeWarning('recurrence-scope', `本次修改仅作用于：${occurrenceScope}`, 'info'));
  }

  return Object.freeze({
    kind: 'reminder' as const,
    conversationId: returnTarget.conversationId,
    reminderId: editing ? (input.reminderId as string).trim() : null,
    reminderKind: kind,
    label,
    owner,
    timeSummary,
    durationMs,
    timezone,
    recurrenceRule: recurrence === null ? null : recurrence.rule,
    occurrenceScope,
    systemChannel,
    permission,
    armed: blockedReason === null,
    blockedReason,
    warnings: Object.freeze(warnings),
    returnTarget,
    expectedRevision:
      input.expectedRevision === undefined ? null : requireRevisionValue(input.expectedRevision),
  });
}

function requireRevisionValue(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SystemActionError('invalid-revision', 'expectedRevision 必须是非负整数', {
      field: 'expectedRevision',
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// 动作效果表：dismiss ≠ delete（I-E）
// ---------------------------------------------------------------------------

export type ReminderAction = 'dismiss' | 'snooze' | 'disable' | 'delete';
export const REMINDER_ACTIONS: readonly ReminderAction[] = ['dismiss', 'snooze', 'disable', 'delete'];

export interface ReminderActionEffect {
  readonly action: ReminderAction;
  /** 是否从记录中删除该提醒（连历史也清掉）。 */
  readonly removesRecord: boolean;
  /** 是否阻止该提醒的后续触发。 */
  readonly stopsFutureFire: boolean;
  readonly label: string;
}

const EFFECTS: Readonly<Record<ReminderAction, ReminderActionEffect>> = Object.freeze({
  // 本次 dismissing 只跳过这一次触发，记录仍在（这正是「不把 dismiss 都标为删除」的落点）。
  dismiss: Object.freeze({ action: 'dismiss', removesRecord: false, stopsFutureFire: true, label: '忽略本次' }),
  snooze: Object.freeze({ action: 'snooze', removesRecord: false, stopsFutureFire: false, label: '稍后提醒' }),
  // 停用保留记录、阻止后续，但可再启用。
  disable: Object.freeze({ action: 'disable', removesRecord: false, stopsFutureFire: true, label: '停用' }),
  delete: Object.freeze({ action: 'delete', removesRecord: true, stopsFutureFire: true, label: '删除' }),
});

export function reminderActionEffect(action: unknown): ReminderActionEffect {
  if (typeof action !== 'string' || !REMINDER_ACTIONS.includes(action as ReminderAction)) {
    throw new SystemActionError('invalid-reminder-action', `未知提醒动作：${String(action)}`, {
      field: 'action',
    });
  }
  return EFFECTS[action as ReminderAction];
}

/** 供测试与 UI 复用的合法性断言（把 UTC 时间戳校验暴露给调用方）。 */
export function isReminderFireTime(value: unknown): boolean {
  try {
    requireIsoTimestamp(value, 'fireAt');
    return true;
  } catch {
    return false;
  }
}
