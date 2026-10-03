/**
 * 自管提醒的**查询 / 筛选 / 变更**（CLK-03 / CLK-04）。
 *
 * ## CLK-03 的硬边界：**不伪造"手机上的全部闹钟"**
 *
 * {@link queryManagedAlarms} 只返回**本工具可管理**的自管提醒，并把这一点写进结果的
 * `scope` / `disclaimer`——它**不是**手机系统闹钟列表。
 *
 * {@link querySystemAlarms} 是系统侧唯一的读取入口，其返回类型**刻意没有**
 * "读到了空列表 ⇒ 没有闹钟"这种分支：`conclusive` 恒为 `false`。没有读取接口时是
 * `unreadable`（连 `alarms` 字段都不存在）；即便厂商接口返回了空数组，也判为
 * `unreadable`——**空结果不等于没有闹钟**，因为我们无法区分"真的没有"与"读不到"（CLK-03 / CLK-10）。
 *
 * ## CLK-04 的四个变更 + 幂等
 *
 * - 修改（时间 / 标签 / 重复）、启用 / 禁用、删除、取消一次发生；
 * - 每次变更都要求 `expectedRevision`：不符 ⇒ 显式 `revision_conflict`，**不静默覆盖**；
 * - 创建经幂等键（{@link createManagedAlarm}）：同键重放返回既有记录，不重复创建；
 * - 查询出的行与目标对象**是同一个 ID**（{@link ManagedAlarmRow.id}）——"查询结果与目标一致"。
 *
 * 不读墙钟：`nowMs` 由调用方注入；不用 `Date`。
 */

import type { AlarmMutationResult, AlarmStore } from './alarm-store.js';
import { epochToWall, formatDateTime } from './civil.js';
import { describeRepeat } from './repeat.js';
import type { SystemAlarmReadPort, SystemAlarmRef } from './handoff.js';
import type { AlarmDraft, AlarmRecord } from './types.js';
import type { ZonePort } from './zone.js';

// ---------------------------------------------------------------------------
// 一、自管查询（CLK-03）
// ---------------------------------------------------------------------------

export interface AlarmQueryOptions {
  readonly store: AlarmStore;
  readonly zonePort: ZonePort;
  readonly nowMs: number;
}

export interface AlarmFilter {
  /** 是否包含已禁用的提醒（默认 true，全部列出）。 */
  readonly includeDisabled?: boolean;
  /** 标签包含该子串（区分大小写）。 */
  readonly labelContains?: string;
  /** 只列该时区的提醒。 */
  readonly zoneId?: string;
  /** 只列"下次触发早于该绝对时刻"的提醒。 */
  readonly nextBeforeMs?: number;
}

export interface ManagedAlarmRow {
  readonly id: string;
  readonly ownership: 'self_managed';
  readonly label: string;
  readonly enabled: boolean;
  readonly zoneId: string;
  readonly repeatText: string;
  readonly firstTriggerMs: number;
  readonly firstTriggerText: string;
  readonly nextTriggerMs: number | null;
  readonly nextTriggerText: string | null;
  readonly skippedDates: readonly string[];
  readonly revision: number;
}

export interface ManagedAlarmQuery {
  /** 明确标注作用域：**只有**自管提醒。 */
  readonly scope: 'self_managed_only';
  readonly disclaimer: string;
  readonly nowMs: number;
  readonly total: number;
  readonly rows: readonly ManagedAlarmRow[];
}

/** 作用域说明（展示层应原样带上，防止被读成"手机全部闹钟"）。 */
export const MANAGED_SCOPE_DISCLAIMER =
  '以上仅为 potbot 自管提醒（本工具记账、本工具恢复），**不是**手机系统时钟应用里的闹钟列表；' +
  '系统闹钟没有可枚举的读取通道（见 querySystemAlarms）。';

/** 本地时刻文本；时区未知返回 null（不猜、不以 UTC 顶替）。 */
function localText(zonePort: ZonePort, zoneId: string, instantMs: number): string | null {
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  return offset === null ? null : formatDateTime(epochToWall(instantMs, offset));
}

function toRow(options: AlarmQueryOptions, record: AlarmRecord): ManagedAlarmRow {
  const summary = options.store.describe(record.id, options.nowMs);
  return {
    id: record.id,
    ownership: 'self_managed',
    label: record.label,
    enabled: record.enabled,
    zoneId: record.zoneId,
    repeatText: summary?.repeatText ?? describeRepeat(record.repeat),
    firstTriggerMs: record.firstTriggerMs,
    firstTriggerText: localText(options.zonePort, record.zoneId, record.firstTriggerMs) ?? '',
    nextTriggerMs: summary?.nextTriggerMs ?? null,
    nextTriggerText: summary?.nextTriggerText ?? null,
    skippedDates: record.skippedDates,
    revision: record.revision,
  };
}

/**
 * 查询 / 筛选手管提醒，并给出下次触发与重复规则。
 * **只含自管记录**；系统侧请走 {@link querySystemAlarms}。
 */
export function queryManagedAlarms(
  options: AlarmQueryOptions,
  filter: AlarmFilter = {},
): ManagedAlarmQuery {
  const includeDisabled = filter.includeDisabled ?? true;
  const all = options.store.list();

  const rows: ManagedAlarmRow[] = [];
  for (const record of all) {
    if (!includeDisabled && !record.enabled) continue;
    if (filter.zoneId !== undefined && record.zoneId !== filter.zoneId) continue;
    if (filter.labelContains !== undefined && !record.label.includes(filter.labelContains)) continue;
    const row = toRow(options, record);
    if (
      filter.nextBeforeMs !== undefined &&
      (row.nextTriggerMs === null || row.nextTriggerMs >= filter.nextBeforeMs)
    ) {
      continue;
    }
    rows.push(row);
  }

  rows.sort((a, b) => {
    const ax = a.nextTriggerMs ?? Number.POSITIVE_INFINITY;
    const bx = b.nextTriggerMs ?? Number.POSITIVE_INFINITY;
    if (ax !== bx) return ax - bx;
    return a.firstTriggerMs - b.firstTriggerMs;
  });

  return {
    scope: 'self_managed_only',
    disclaimer: MANAGED_SCOPE_DISCLAIMER,
    nowMs: options.nowMs,
    total: rows.length,
    rows,
  };
}

/** 取单条自管提醒的展示行；不存在返回 null。 */
export function managedAlarmById(
  options: AlarmQueryOptions,
  id: string,
): ManagedAlarmRow | null {
  const record = options.store.get(id);
  return record === null ? null : toRow(options, record);
}

// ---------------------------------------------------------------------------
// 二、系统闹钟读取（CLK-03：恒不可下结论）
// ---------------------------------------------------------------------------

/**
 * 系统闹钟的读取结果。
 *
 * **注意类型本身**：`conclusive` 恒为 `false`，且 `unreadable` 分支**没有** `alarms` 字段——
 * 于是"读不到 ⇒ 没有闹钟"在**类型层面**就无法表达（CLK-03 的机器化落点）。
 */
export type SystemAlarmListing =
  | {
      readonly status: 'unreadable';
      readonly conclusive: false;
      /** 为什么读不到（可审计）。 */
      readonly reason: string;
      /** 用户可怎么办（把"没有通道"如实变成下一步，而不是假装查过了）。 */
      readonly guidance: string;
    }
  | {
      readonly status: 'partial_vendor_read';
      readonly conclusive: false;
      readonly alarms: readonly SystemAlarmRef[];
      readonly source: string;
      readonly caveat: string;
    };

/**
 * 读系统闹钟。
 *
 * - `port === null`（**产品基线默认**）⇒ `unreadable`；
 * - 端口返回**空数组** ⇒ 仍然 `unreadable`（空结果 ≠ 没有闹钟，无法与"读不到"区分）；
 * - 端口返回非空 ⇒ `partial_vendor_read`，并声明厂商数据可能不完整、且**不可写回**。
 */
export async function querySystemAlarms(
  port: SystemAlarmReadPort | null,
  sourceLabel = 'system_clock_app',
): Promise<SystemAlarmListing> {
  if (port === null) {
    return {
      status: 'unreadable',
      conclusive: false,
      reason:
        '没有系统闹钟读取接口：公开 Android 平台未提供枚举用户系统闹钟的通用通道（cap.clock.system_alarm_read 记阻塞）。',
      guidance:
        '只能改为「打开时钟 App 交给用户自行查看」，或评估厂商私有 SDK（需另行授权）。' +
        '**不得**用 potbot 自管提醒顶替系统闹钟列表。',
    };
  }

  const alarms = await port.list();
  if (alarms.length === 0) {
    return {
      status: 'unreadable',
      conclusive: false,
      reason:
        '读取接口返回了空结果，但**空结果不等于"没有闹钟"**：无合法枚举通道时无法区分' +
        '「确实一个都没有」与「读不到 / 被系统限制」。',
      guidance: '如实报告"未知"，不要下"没有闹钟"的结论，也不要返回空数组冒充查询成功。',
    };
  }

  return {
    status: 'partial_vendor_read',
    conclusive: false,
    alarms,
    source: sourceLabel,
    caveat:
      '来自厂商 / 系统接口的**只读**结果，可能不完整（部分厂商只暴露自有闹钟）；' +
      '本批**没有**写回通道，不能据此声称已修改系统闹钟（CLK-08 / CLK-10）。',
  };
}

// ---------------------------------------------------------------------------
// 三、创建与四个变更（CLK-04）
// ---------------------------------------------------------------------------

export interface ManagedCreateResult {
  readonly ok: boolean;
  readonly record: AlarmRecord | null;
  /** true = 命中幂等键，**未**新建。 */
  readonly duplicate: boolean;
  readonly problems: readonly string[];
}

/** 创建自管提醒（幂等键由调用方给出；同一意图重复提交必须复用同一个键）。 */
export function createManagedAlarm(
  store: AlarmStore,
  draft: AlarmDraft,
  idempotencyKey: string,
): ManagedCreateResult {
  const created = store.create(draft, idempotencyKey);
  if (!created.ok) {
    return { ok: false, record: null, duplicate: false, problems: created.problems };
  }
  return { ok: true, record: created.record, duplicate: created.duplicate, problems: [] };
}

export type MutationKind = 'update' | 'set_enabled' | 'remove' | 'cancel_occurrence';
export type MutationReason = 'ok' | 'not_found' | 'revision_conflict' | 'invalid_patch';

export interface MutationOutcome {
  readonly ok: boolean;
  readonly kind: MutationKind;
  readonly id: string;
  /** 是否**真的**改动了对象（版本冲突 / 找不到 / 补丁非法时为 false）。 */
  readonly applied: boolean;
  readonly record: AlarmRecord | null;
  readonly reason: MutationReason;
  readonly problems: readonly string[];
}

function mapMutation(kind: MutationKind, id: string, result: AlarmMutationResult): MutationOutcome {
  if (result.ok) {
    return { ok: true, kind, id, applied: true, record: result.record, reason: 'ok', problems: [] };
  }
  return {
    ok: false,
    kind,
    id,
    applied: false,
    record: result.current,
    reason: result.reason,
    problems: result.problems,
  };
}

/** 修改时间 / 标签 / 重复（要求 `expectedRevision`，不符即冲突）。 */
export function updateManagedAlarm(
  store: AlarmStore,
  id: string,
  patch: { readonly label?: string; readonly zoneId?: string; readonly firstTriggerMs?: number; readonly repeat?: AlarmDraft['repeat'] },
  expectedRevision: number,
): MutationOutcome {
  return mapMutation('update', id, store.update(id, patch, expectedRevision));
}

/** 启用 / 禁用。 */
export function setManagedEnabled(
  store: AlarmStore,
  id: string,
  enabled: boolean,
  expectedRevision: number,
): MutationOutcome {
  return mapMutation('set_enabled', id, store.setEnabled(id, enabled, expectedRevision));
}

/** 删除整条提醒。 */
export function removeManagedAlarm(
  store: AlarmStore,
  id: string,
  expectedRevision: number,
): MutationOutcome {
  return mapMutation('remove', id, store.remove(id, expectedRevision));
}

/**
 * 取消**一次发生**（按提醒时区的本地日期跳过该次），**不**删除整条。
 * 这正是"dismiss / 跳过 ≠ 删除"在自管侧的落点（与 CLK-08 的系统侧语义同源）。
 */
export function cancelOneOccurrence(
  store: AlarmStore,
  id: string,
  occurrenceEpochMs: number,
  expectedRevision: number,
): MutationOutcome {
  return mapMutation('cancel_occurrence', id, store.cancelOccurrence(id, occurrenceEpochMs, expectedRevision));
}
