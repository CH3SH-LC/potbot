/**
 * 自管提醒的**重启恢复 / 时区与系统时间变化 / 精确提醒权限与通知状态**（CLK-07）。
 *
 * ## 一条不可退让的算法纪律：**调度依据是绝对时刻，不是轮询**
 *
 * CLK-07 明写「不能用工作队列轮询保证准点」。本模块把它做成**类型**：
 * {@link SchedulePlan} 的 `absolute_instant` 分支 `pollIntervalMs` 恒为 `null`，
 * {@link assertAbsoluteScheduling} 对任何 `poll_interval` 计划**抛错**。
 * 到点触发本身必须由系统调度通道（AlarmManager / 通知）保证——该通道**未接通**，
 * 故 {@link inspectPreciseReminderStatus} 在无设备时一律 `unknown`，**不声称能准点响铃**。
 *
 * ## 重启恢复
 *
 * {@link captureSnapshot} / {@link restoreStore} 走自管仓库的快照；恢复时对每条记录做
 * **结构校验**：读不懂的记录**报问题并跳过**，绝不静默当成"没有这条"。
 *
 * ## 时区 / 系统时间变化
 *
 * 自管记录存的是**绝对时刻**（`firstTriggerMs`）+ 时区的墙上时间。时区或系统时间变化后，
 * 同一个绝对时刻在本地显示会变、重复规则的**触发瞬间也可能整体平移**。本模块**不替用户改**
 * 任何东西，只如实算出"变了多少"并要求用户确认（{@link rebaseOnZoneOrTimeChange}）。
 *
 * 不读墙钟：`nowMs` 由调用方注入；不用 `Date`。
 */

import { createAlarmStore, type AlarmStore } from './alarm-store.js';
import { epochToWall, formatDateTime } from './civil.js';
import { nextTriggerOf } from './repeat.js';
import type { AlarmRecord, RepeatRule } from './types.js';
import type { ZonePort } from './zone.js';

// ---------------------------------------------------------------------------
// 一、快照与恢复
// ---------------------------------------------------------------------------

export const RESTORE_SNAPSHOT_VERSION = 1;

export interface RestoreSnapshot {
  readonly version: number;
  readonly capturedAtMs: number;
  /** 自管仓库的 JSON 快照（不含任何系统侧对象）。 */
  readonly storeJson: string;
}

/** 采集一份恢复快照。 */
export function captureSnapshot(store: AlarmStore, capturedAtMs: number): RestoreSnapshot {
  return {
    version: RESTORE_SNAPSHOT_VERSION,
    capturedAtMs,
    storeJson: store.toSnapshot(),
  };
}

export type RestoreProblemKind =
  | 'version_mismatch'
  | 'unparsable_snapshot'
  | 'record_unreadable';

export interface RestoreProblem {
  readonly kind: RestoreProblemKind;
  /** 出问题的记录 id（整体快照问题时为 null）。 */
  readonly id: string | null;
  readonly detail: string;
}

export interface RestoreReport {
  readonly ok: boolean;
  readonly store: AlarmStore;
  readonly restoredIds: readonly string[];
  readonly problems: readonly RestoreProblem[];
}

export interface RestoreOptions {
  readonly zonePort: ZonePort;
  /** 稳定 ID 来源（跨重启唯一，合同 R202）。 */
  readonly idSource: () => string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const REPEAT_KINDS: readonly string[] = ['once', 'daily', 'weekly', 'workdays', 'monthly', 'dates'];

/** 结构校验一条记录；不合规返回原因。 */
function checkRecord(value: unknown): { readonly ok: true; readonly record: AlarmRecord } | { readonly ok: false; readonly id: string | null; readonly detail: string } {
  const object = asObject(value);
  if (object === null) return { ok: false, id: null, detail: '记录不是对象' };
  const idRaw = object['id'];
  const id = typeof idRaw === 'string' && idRaw.trim() !== '' ? idRaw : null;
  if (id === null) return { ok: false, id: null, detail: '缺少非空 id' };
  if (object['ownership'] !== 'self_managed') {
    return { ok: false, id, detail: `归属不是 self_managed（${String(object['ownership'])}）` };
  }
  const label = object['label'];
  if (typeof label !== 'string') return { ok: false, id, detail: 'label 非字符串' };
  const zoneId = object['zoneId'];
  if (typeof zoneId !== 'string' || zoneId.trim() === '') {
    return { ok: false, id, detail: 'zoneId 非字符串' };
  }
  const firstTriggerMs = object['firstTriggerMs'];
  if (typeof firstTriggerMs !== 'number' || !Number.isFinite(firstTriggerMs)) {
    return { ok: false, id, detail: 'firstTriggerMs 非有限数' };
  }
  const enabled = object['enabled'];
  if (typeof enabled !== 'boolean') return { ok: false, id, detail: 'enabled 非布尔' };
  const revision = object['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, id, detail: 'revision 非 ≥1 的整数' };
  }
  const repeat = asObject(object['repeat']);
  const repeatKind = repeat === null ? undefined : repeat['kind'];
  if (repeat === null || typeof repeatKind !== 'string' || !REPEAT_KINDS.includes(repeatKind)) {
    return { ok: false, id, detail: 'repeat 不是已知规则' };
  }
  const skippedRaw = object['skippedDates'];
  const skippedDates = Array.isArray(skippedRaw)
    ? skippedRaw.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const createdAtRaw = object['createdAtMs'];
  const createdAtMs =
    typeof createdAtRaw === 'number' && Number.isFinite(createdAtRaw) ? createdAtRaw : firstTriggerMs;

  return {
    ok: true,
    record: {
      id,
      ownership: 'self_managed',
      label,
      zoneId,
      firstTriggerMs,
      repeat: repeat as unknown as RepeatRule,
      enabled,
      revision,
      createdAtMs,
      skippedDates,
    },
  };
}

/**
 * 从快照恢复自管仓库。
 *
 * **如实**：版本不符 ⇒ 不恢复任何记录并报 `version_mismatch`；快照无法解析 ⇒
 * 报 `unparsable_snapshot`；个别记录读不懂 ⇒ 报 `record_unreadable` 并跳过该条
 * （**不是**静默丢弃，也不是静默保留半成品）。
 */
export function restoreStore(options: RestoreOptions, snapshot: RestoreSnapshot): RestoreReport {
  if (snapshot.version !== RESTORE_SNAPSHOT_VERSION) {
    return {
      ok: false,
      store: createAlarmStore({ zonePort: options.zonePort, idSource: options.idSource }),
      restoredIds: [],
      problems: [
        {
          kind: 'version_mismatch',
          id: null,
          detail: `快照版本 ${String(snapshot.version)} 与当前 ${String(RESTORE_SNAPSHOT_VERSION)} 不符，未恢复任何记录`,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.storeJson);
  } catch (error) {
    return {
      ok: false,
      store: createAlarmStore({ zonePort: options.zonePort, idSource: options.idSource }),
      restoredIds: [],
      problems: [
        {
          kind: 'unparsable_snapshot',
          id: null,
          detail: `快照不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const container = asObject(parsed);
  const rawRecords = container === null ? null : container['records'];
  if (!Array.isArray(rawRecords)) {
    return {
      ok: false,
      store: createAlarmStore({ zonePort: options.zonePort, idSource: options.idSource }),
      restoredIds: [],
      problems: [{ kind: 'unparsable_snapshot', id: null, detail: '快照缺少 records 数组' }],
    };
  }

  const problems: RestoreProblem[] = [];
  const records: AlarmRecord[] = [];
  for (const raw of rawRecords) {
    const checked = checkRecord(raw);
    if (checked.ok) records.push(checked.record);
    else problems.push({ kind: 'record_unreadable', id: checked.id, detail: checked.detail });
  }

  const idempotencyRaw = container === null ? null : asObject(container['idempotency']);
  const validIds = new Set(records.map((record) => record.id));
  const idempotency: Record<string, string> = {};
  if (idempotencyRaw !== null) {
    for (const [key, value] of Object.entries(idempotencyRaw)) {
      if (typeof value === 'string' && validIds.has(value)) idempotency[key] = value;
    }
  }

  const store = createAlarmStore({
    zonePort: options.zonePort,
    idSource: options.idSource,
    snapshot: JSON.stringify({ records, idempotency }),
  });

  return {
    ok: problems.length === 0,
    store,
    restoredIds: records.map((record) => record.id),
    problems,
  };
}

// ---------------------------------------------------------------------------
// 二、时区 / 系统时间变化
// ---------------------------------------------------------------------------

export interface RebaseReport {
  readonly record: AlarmRecord;
  readonly nextTriggerMs: number | null;
  readonly nextTriggerLocalBefore: string | null;
  readonly nextTriggerLocalAfter: string | null;
  /** 绝对触发瞬间是否被这次变化改变。 */
  readonly absoluteChanged: boolean;
  /** 本地显示是否被改变。 */
  readonly localDisplayChanged: boolean;
  /** 是否需要用户确认（有任何变化就必须确认，不自动应用）。 */
  readonly requiresUserConfirmation: boolean;
  readonly note: string;
}

function localTextOf(zonePort: ZonePort, zoneId: string, instantMs: number | null): string | null {
  if (instantMs === null) return null;
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  return offset === null ? null : formatDateTime(epochToWall(instantMs, offset));
}

/**
 * 时区 / 系统时间变化后，重新算一遍下次触发并**如实报告差异**。
 * **不修改**记录：要不要按新的本地时间重锚，必须由用户决定。
 */
export function rebaseOnZoneOrTimeChange(
  record: AlarmRecord,
  before: ZonePort,
  after: ZonePort,
  atMs: number,
): RebaseReport {
  const nextBefore = nextTriggerOf(record, before, atMs);
  const nextAfter = nextTriggerOf(record, after, atMs);
  const localBefore = localTextOf(before, record.zoneId, nextBefore);
  const localAfter = localTextOf(after, record.zoneId, nextAfter);
  const absoluteChanged = nextBefore !== nextAfter;
  const localDisplayChanged = localBefore !== localAfter;
  const changed = absoluteChanged || localDisplayChanged;

  return {
    record,
    nextTriggerMs: nextAfter,
    nextTriggerLocalBefore: localBefore,
    nextTriggerLocalAfter: localAfter,
    absoluteChanged,
    localDisplayChanged,
    requiresUserConfirmation: changed,
    note: changed
      ? '时区 / 系统时间变化改变了该提醒的触发点：自管记录存的是绝对时刻，本模块**不**自动改时间，请用户确认。'
      : '触发点未受影响，无需处置。',
  };
}

// ---------------------------------------------------------------------------
// 三、精确提醒权限与通知状态
// ---------------------------------------------------------------------------

export type PermissionState = 'granted' | 'denied' | 'unknown';

export interface PreciseReminderInput {
  /** 精确闹钟 / 提醒权限（Android SCHEDULE_EXACT_ALARM / USE_EXACT_ALARM）。 */
  readonly exactAlarmPermission: PermissionState;
  /** 通知权限。 */
  readonly notificationsPermission: PermissionState;
  /** 通知总开关是否打开（用户可能在系统里关掉了）。 */
  readonly notificationsEnabled: PermissionState;
  /** 是否已忽略电池优化（后台被清理会导致错过提醒）。 */
  readonly batteryOptimizationIgnored: PermissionState;
  /** 是否已装配系统调度通道（前台服务 / AlarmManager 适配，归 A 负责人）。 */
  readonly schedulerChannelInstalled: boolean;
}

export interface PreciseReminderStatus extends PreciseReminderInput {
  /** 是否**可以**承诺准点——四项全 granted 且通道已装配。 */
  readonly canGuaranteeOnTime: boolean;
  readonly verdict: 'ready' | 'not_ready' | 'unknown';
  readonly reason: string;
  readonly caveat: string;
}

const UNKNOWN_INPUT: PreciseReminderInput = {
  exactAlarmPermission: 'unknown',
  notificationsPermission: 'unknown',
  notificationsEnabled: 'unknown',
  batteryOptimizationIgnored: 'unknown',
  schedulerChannelInstalled: false,
};

/**
 * 检查精确提醒 / 通知状态。
 *
 * `input === null` 表示**没有设备可查**：四项全 `unknown`、`canGuaranteeOnTime = false`、
 * `verdict = 'unknown'`，并把"未验证（需真机）"写进 `reason`——**不**冒充已就绪。
 */
export function inspectPreciseReminderStatus(input: PreciseReminderInput | null): PreciseReminderStatus {
  if (input === null) {
    return {
      ...UNKNOWN_INPUT,
      canGuaranteeOnTime: false,
      verdict: 'unknown',
      reason: '无设备：精确提醒权限与通知状态**未验证（需真机）**，无法判断能否准点。',
      caveat: '即使权限齐全，到点触发仍需系统调度通道；该通道本批未接通（cap.clock.precise_firing）。',
    };
  }

  const allGranted =
    input.exactAlarmPermission === 'granted' &&
    input.notificationsPermission === 'granted' &&
    input.notificationsEnabled === 'granted' &&
    input.batteryOptimizationIgnored === 'granted' &&
    input.schedulerChannelInstalled;

  const hasUnknown =
    input.exactAlarmPermission === 'unknown' ||
    input.notificationsPermission === 'unknown' ||
    input.notificationsEnabled === 'unknown' ||
    input.batteryOptimizationIgnored === 'unknown';

  const verdict: PreciseReminderStatus['verdict'] = allGranted
    ? 'ready'
    : hasUnknown
      ? 'unknown'
      : 'not_ready';

  return {
    ...input,
    canGuaranteeOnTime: allGranted,
    verdict,
    reason: allGranted
      ? '精确提醒权限、通知与调度通道均已就绪。'
      : hasUnknown
        ? '存在未知项：权限 / 通知状态无法确认，**未验证（需真机）**。'
        : '有权限被拒或通道未装配，**不能**承诺准点提醒。',
    caveat: '提醒能否准点最终取决于系统调度与厂商省电策略，须在真机上实测（CLK-07）。',
  };
}

// ---------------------------------------------------------------------------
// 四、调度依据：绝对时刻（**禁止**轮询）
// ---------------------------------------------------------------------------

/**
 * 调度计划。`absolute_instant` 分支的 `pollIntervalMs` 恒为 `null`——
 * 轮询分支在类型上就是**另一个东西**，且 {@link assertAbsoluteScheduling} 会拒绝它。
 */
export type SchedulePlan =
  | {
      readonly basis: 'absolute_instant';
      readonly alarmId: string;
      readonly triggerMs: number;
      readonly pollIntervalMs: null;
    }
  | {
      readonly basis: 'poll_interval';
      readonly alarmId: string;
      readonly intervalMs: number;
      readonly triggerMs: null;
    };

/** 为一条自管提醒算出"下一次到点"的**绝对**调度计划；无下一次（禁用 / 已过）返回 null。 */
export function planNextTrigger(
  record: AlarmRecord,
  zonePort: ZonePort,
  afterMs: number,
): SchedulePlan | null {
  const triggerMs = nextTriggerOf(record, zonePort, afterMs);
  if (triggerMs === null) return null;
  return { basis: 'absolute_instant', alarmId: record.id, triggerMs, pollIntervalMs: null };
}

/**
 * 只接受绝对时刻计划；`poll_interval` 计划一律**抛错**（CLK-07「不能用轮询保证准点」）。
 */
export function assertAbsoluteScheduling(plan: SchedulePlan): { readonly alarmId: string; readonly triggerMs: number } {
  if (plan.basis !== 'absolute_instant') {
    throw new Error(
      '拒绝以轮询保证准点：CLK-07 明令不得用工作队列轮询替代系统调度。' +
        `收到 poll_interval(${String(plan.intervalMs)}ms)。`,
    );
  }
  return { alarmId: plan.alarmId, triggerMs: plan.triggerMs };
}

/** 纪律说明（展示 / 审计用）。 */
export function describeSchedulingDiscipline(): string {
  return (
    '自管提醒的调度依据是**绝对时刻**（firstTriggerMs / nextTriggerOf），不是"每 N 秒检查一次"。' +
    '到点触发由系统调度通道保证；该通道未接通前，本模块只保证时间账目正确，不声称准点响铃。'
  );
}
