/**
 * 重复日程的展开与「本次 / 后续 / 整个系列」的语义（CAL-05）。
 *
 * ## 本模块的定位（避免过度声称）
 *
 * 本模块实现**展开规则**与**编辑范围的语义规划**（`this` / `following` / `all`
 * 分别意味着哪些实例受影响）。它**不**直接写平台日历。
 *
 * **平台事实（已核实，2026-10-03，见 `outputs/FA-M/readiness-matrix.md` 的来源链接）**：
 * Android `CalendarContract` **没有** this/following/all 的三选一参数或 API；provider 只提供
 * **结构化机制**——例外行（`ORIGINAL_ID` + `ORIGINAL_INSTANCE_TIME`）与 `EXDATE`，
 * 且约束「若 rrule/rdate 非空，original_id/original_sync_id 必须为空」。
 * 因此"改成后续"在平台上通常是**应用层**的"截断原系列 + 新建系列"两步操作。
 * 该两步操作**在真机上执行与读回**属未就绪项（见 `not-ready.ts` 的 CAL-05）。
 *
 * ## 计数口径
 *
 * `count` 按 RFC 5545 口径：统计**匹配到的实例数（含被 EXDATE 排除的）**，
 * 而不是"实际返回的实例数"。这样 `exdates` 不会改变系列的总长度。
 */

import { civilFromDays, daysFromCivil, epochToWall, floorMod, formatDate, parseDate } from '../clock/civil.js';
import { zoneToInstant, type ZonePort } from '../clock/zone.js';
import { eventDurationMs } from './event.js';
import type { EventTime, RecurrenceRule } from './types.js';

/**
 * 展开步数上限（天）。20,000 天 ≈ 54 年，足以覆盖任何现实系列；
 * 触发上限时 `truncated=true`，调用方**必须**如实告知结果不完整。
 */
const MAX_STEPS = 20_000;

export interface Occurrence {
  /** 第几次（从 1 起，按系列顺序，含被 EXDATE 排除的）。 */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** 该次所在的本地日期（事件时区）。 */
  readonly localDate: string;
}

export interface ExpansionResult {
  readonly occurrences: readonly Occurrence[];
  /** 因上限被截断 ⇒ 结果**不完整**。 */
  readonly truncated: boolean;
  /** 失败原因（时区未知 / 日期非法）；成功为 null。 */
  readonly reason: string | null;
}

function weekdayOf(day: number): number {
  return floorMod(day + 4, 7);
}

function weekStartOf(day: number): number {
  return day - weekdayOf(day);
}

/** 该重复规则在"本地日 `day`"是否命中。 */
function matchesRecurrence(rule: RecurrenceRule, baseDay: number, day: number): boolean {
  if (day < baseDay) return false;
  const civil = civilFromDays(day);
  const baseCivil = civilFromDays(baseDay);
  switch (rule.freq) {
    case 'daily':
      return (day - baseDay) % rule.interval === 0;
    case 'weekly': {
      const weekdays = rule.byWeekday ?? [weekdayOf(baseDay)];
      if (!(weekdays as readonly number[]).includes(weekdayOf(day))) return false;
      const weeksApart = (weekStartOf(day) - weekStartOf(baseDay)) / 7;
      return weeksApart >= 0 && weeksApart % rule.interval === 0;
    }
    case 'monthly': {
      const monthsApart = civil.year * 12 + civil.month - (baseCivil.year * 12 + baseCivil.month);
      if (monthsApart < 0 || monthsApart % rule.interval !== 0) return false;
      const days = rule.byMonthDay ?? [baseCivil.day];
      return (days as readonly number[]).includes(civil.day);
    }
    case 'yearly': {
      const yearsApart = civil.year - baseCivil.year;
      if (yearsApart < 0 || yearsApart % rule.interval !== 0) return false;
      return civil.month === baseCivil.month && civil.day === baseCivil.day;
    }
  }
}

/** 系列首日（本地日序号）与基准墙上时刻；无法确定返回 null。 */
function baseAnchor(
  time: EventTime,
  zonePort: ZonePort,
): { baseDay: number; wall: { hour: number; minute: number; second: number } } | null {
  if (time.kind === 'allDay') {
    const parsed = parseDate(time.startDate);
    if (parsed === null) return null;
    return {
      baseDay: daysFromCivil(parsed.year, parsed.month, parsed.day),
      wall: { hour: 0, minute: 0, second: 0 },
    };
  }
  const offset = zonePort.offsetMinutesAt(time.zoneId, time.startMs);
  if (offset === null) return null;
  const wall = epochToWall(time.startMs, offset);
  return {
    baseDay: daysFromCivil(wall.year, wall.month, wall.day),
    wall: { hour: wall.hour, minute: wall.minute, second: wall.second },
  };
}

/** 第 `day` 天的实例起始绝对时刻。 */
function occurrenceStartMs(
  zoneId: string,
  day: number,
  wall: { hour: number; minute: number; second: number },
  zonePort: ZonePort,
): number | null {
  const civil = civilFromDays(day);
  return zoneToInstant(zonePort, zoneId, { ...civil, ...wall });
}

/** 展开 `[fromMs, toMs]` 内的实例。 */
export function expandRecurrence(
  time: EventTime,
  rule: RecurrenceRule,
  zonePort: ZonePort,
  fromMs: number,
  toMs: number,
): ExpansionResult {
  const duration = eventDurationMs(time, zonePort);
  if (duration === null) {
    return { occurrences: [], truncated: false, reason: '事件时间无法确定（时区未知或日期非法）' };
  }
  const anchor = baseAnchor(time, zonePort);
  if (anchor === null) {
    return { occurrences: [], truncated: false, reason: `事件时区未知或日期非法：${time.zoneId}` };
  }

  const exdates = new Set(rule.exdates ?? []);
  let untilDay: number | null = null;
  if (rule.untilDate !== undefined) {
    const parsed = parseDate(rule.untilDate);
    if (parsed === null) {
      return { occurrences: [], truncated: false, reason: `截止日期非法：${rule.untilDate}` };
    }
    untilDay = daysFromCivil(parsed.year, parsed.month, parsed.day);
  }

  const occurrences: Occurrence[] = [];
  let occurrenceIndex = 0;
  let truncated = false;
  let exhausted = true;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const day = anchor.baseDay + step;
    if (untilDay !== null && day > untilDay) {
      exhausted = false;
      break;
    }
    if (!matchesRecurrence(rule, anchor.baseDay, day)) continue;

    occurrenceIndex += 1;
    if (rule.count !== undefined && occurrenceIndex > rule.count) {
      exhausted = false;
      break;
    }

    const startMs = occurrenceStartMs(time.zoneId, day, anchor.wall, zonePort);
    if (startMs === null) {
      return { occurrences, truncated: false, reason: `无法把实例换算成绝对时刻（时区：${time.zoneId}）` };
    }
    const endMs = startMs + duration;

    if (endMs <= fromMs) continue;
    if (startMs > toMs) {
      exhausted = false;
      break;
    }
    const localDate = formatDate(civilFromDays(day));
    if (exdates.has(localDate)) continue;

    occurrences.push({ index: occurrenceIndex, startMs, endMs, localDate });
  }

  if (exhausted) truncated = true;

  return { occurrences, truncated, reason: null };
}

// ---------------------------------------------------------------------------
// 「本次 / 后续 / 整个系列」的语义规划（CAL-05）
// ---------------------------------------------------------------------------

export type ScopePlan =
  /** 仅此一次：产生一个**例外**（排除原实例 + 落一个新实例）。 */
  | {
      readonly kind: 'single_exception';
      readonly occurrenceMs: number;
      readonly localDate: string;
      readonly providerMechanism: string;
    }
  /** 此事件及后续：**截断**原系列 + **新建**系列（两步）。 */
  | {
      readonly kind: 'split_series';
      readonly splitAtMs: number;
      readonly headUntilLocalDate: string;
      readonly tailStartsAtMs: number;
      readonly providerMechanism: string;
    }
  /** 整个系列：改父系列定义，所有实例随之变化。 */
  | {
      readonly kind: 'whole_series';
      readonly providerMechanism: string;
    };

/**
 * 规划一次"按范围编辑"。**只产出计划，不执行。**
 *
 * 三种范围的计划**形状不同**（用例断言它们互不相同），这是"不误改整组"的**结构性**保证：
 * 调用方不可能把 `this` 的计划当作 `all` 的计划去执行。
 *
 * 时区未知或时刻非法 ⇒ 返回 null（**不**猜测）。
 */
export function planScopeEdit(
  time: EventTime,
  scope: 'this' | 'following' | 'all',
  occurrenceStartMsValue: number,
  zonePort: ZonePort,
): ScopePlan | null {
  const offset = zonePort.offsetMinutesAt(time.zoneId, occurrenceStartMsValue);
  if (offset === null) return null;
  const localDay = Math.floor((occurrenceStartMsValue + offset * 60_000) / 86_400_000);
  const localDate = formatDate(civilFromDays(localDay));

  switch (scope) {
    case 'this':
      return {
        kind: 'single_exception',
        occurrenceMs: occurrenceStartMsValue,
        localDate,
        providerMechanism:
          '平台侧：插入例外行（ORIGINAL_ID + ORIGINAL_INSTANCE_TIME）或把该日加入 EXDATE；' +
          'provider 约束「rrule/rdate 非空时 original_id/original_sync_id 必须为空」。',
      };
    case 'following':
      return {
        kind: 'split_series',
        splitAtMs: occurrenceStartMsValue,
        headUntilLocalDate: formatDate(civilFromDays(localDay - 1)),
        tailStartsAtMs: occurrenceStartMsValue,
        providerMechanism:
          '平台侧：**两步**——① 把原系列截断到分叉点之前（设 UNTIL/COUNT）；' +
          '② 新建一个从分叉点开始的系列。provider **没有**三选一 API，故这是应用层操作（CAL-05）。',
      };
    case 'all':
      return {
        kind: 'whole_series',
        providerMechanism: '平台侧：改父系列行（RRULE/DTSTART/DURATION 等），全部实例随之变化。',
      };
  }
}

/** 三种范围是否会**改动同一批实例**（用于自检：必须两两不同）。 */
export function scopePlanSignature(plan: ScopePlan): string {
  switch (plan.kind) {
    case 'single_exception':
      return `single:${String(plan.occurrenceMs)}`;
    case 'split_series':
      return `split:${String(plan.splitAtMs)}`;
    case 'whole_series':
      return 'whole';
  }
}
