/**
 * 重复规则展开与"下次触发"计算（CLK-02 / CLK-03 / CLK-04）。
 *
 * 全部为**纯函数**：时刻由调用方给出，时区偏移由 {@link ZonePort} 注入。
 * 不读墙钟、不用 `Date`（纪律），因而同一输入在任何机器上结果相同。
 *
 * ## 已明确声明的边界
 *
 * - 展开是**有界**的（`MAX_LOOKAHEAD_DAYS`，见常量说明）；超出上限返回 `null` 并**如实报告**，
 *   不静默给出"没有下一次"。搜索窗口足够覆盖任何现实中的提醒间隔。
 * - 时区未知 ⇒ 返回 `null`（**不**以 UTC 顶替，CLK-03「不得伪造」的同源纪律）。
 * - 「取消一次发生」以**本地日期**（闹钟时区）为单位跳过，与用户看到的那一天一致。
 */

import {
  MS_PER_DAY,
  civilFromDays,
  epochToWall,
  floorMod,
  formatDate,
  parseDate,
  weekdayOfDays,
} from './civil.js';
import type { AlarmRecord, AlarmOccurrence, RepeatRule } from './types.js';
import { zoneToInstant, type ZonePort } from './zone.js';

/**
 * 展开搜索窗口（天）。366 × 30 ≈ 30 年。
 * 取这个量级的理由：即便 `interval` 取到 12 个月或 365 天，"下一次"也必在窗口内；
 * 越小越可能在极端规则下误报"无下一次"，越大越费时——30 年是两者的安全交点。
 */
const MAX_LOOKAHEAD_DAYS = 366 * 30;

/** 该绝对时刻在指定时区落在哪一天（自 1970-01-01 起的天数）；时区未知返回 null。 */
export function localDayNumber(
  zonePort: ZonePort,
  zoneId: string,
  instantMs: number,
): number | null {
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  if (offset === null) return null;
  return Math.floor((instantMs + offset * 60_000) / MS_PER_DAY);
}

/** 某年的第几个月（`year*12 + month-1`），用于月间隔判定。 */
function monthIndex(day: number): number {
  const civil = civilFromDays(day);
  return civil.year * 12 + (civil.month - 1);
}

/** 把一天对齐到所在周的起点（周日起）。所有 `weekStart` 之差都是 7 的整数倍。 */
function weekStart(day: number): number {
  return day - weekdayOfDays(day);
}

interface RuleAnchor {
  /** 首次触发的本地日序号。 */
  readonly baseDay: number;
  readonly baseMonthIndex: number;
  readonly baseWeekStart: number;
}

/**
 * 判某一天是否符合规则（不含"是否晚于 anchor"这一条——那由调用方把关）。
 * `repeat.kind === 'once'` 时只认 `baseDay` 本身。
 */
export function matchesRule(rule: RepeatRule, day: number, anchor: RuleAnchor): boolean {
  switch (rule.kind) {
    case 'once':
      return day === anchor.baseDay;
    case 'daily': {
      const diff = day - anchor.baseDay;
      return diff >= 0 && floorMod(diff, rule.interval) === 0;
    }
    case 'weekly': {
      if (!(rule.weekdays as readonly number[]).includes(weekdayOfDays(day))) return false;
      const weeksApart = (weekStart(day) - anchor.baseWeekStart) / 7;
      return weeksApart >= 0 && floorMod(weeksApart, rule.interval) === 0;
    }
    case 'workdays': {
      const weekday = weekdayOfDays(day);
      return weekday >= 1 && weekday <= 5;
    }
    case 'monthly': {
      const civil = civilFromDays(day);
      if (!rule.daysOfMonth.includes(civil.day)) return false;
      const monthsApart = monthIndex(day) - anchor.baseMonthIndex;
      return monthsApart >= 0 && floorMod(monthsApart, rule.interval) === 0;
    }
    case 'dates': {
      const text = formatDate(civilFromDays(day));
      return rule.dates.includes(text);
    }
  }
}

export interface NextOccurrenceParams {
  readonly rule: RepeatRule;
  readonly zoneId: string;
  readonly zonePort: ZonePort;
  /** 首次触发的绝对时刻（规则的锚点：时间点 + 相位）。 */
  readonly anchorMs: number;
  /** 只找**严格晚于**该时刻的下一次。 */
  readonly afterMs: number;
  /** 被跳过的本地日期（`YYYY-MM-DD`）。 */
  readonly skippedDates?: readonly string[];
}

/**
 * 下一次触发时刻；没有下一次（单次已过 / 超出搜索窗口 / 时区未知）返回 `null`。
 *
 * 返回 `null` 时**必须**由调用方区分三种原因（单次已过是正常的；超窗口/时区未知是异常），
 * 故另有 {@link nextOccurrenceDetailed}。
 */
export function nextOccurrence(params: NextOccurrenceParams): number | null {
  const detailed = nextOccurrenceDetailed(params);
  return detailed.triggerMs;
}

export type NextOccurrenceReason =
  | 'found'
  | 'single_elapsed'
  | 'exhausted_window'
  | 'unknown_zone'
  | 'skipped_all';

export interface NextOccurrenceResult {
  readonly triggerMs: number | null;
  readonly reason: NextOccurrenceReason;
}

/** 带原因的版本（供 readiness / 展示层如实报告"为什么没有下一次"）。 */
export function nextOccurrenceDetailed(params: NextOccurrenceParams): NextOccurrenceResult {
  const { rule, zoneId, zonePort, anchorMs, afterMs } = params;
  const skipped = new Set(params.skippedDates ?? []);

  const anchorOffset = zonePort.offsetMinutesAt(zoneId, anchorMs);
  if (anchorOffset === null) return { triggerMs: null, reason: 'unknown_zone' };
  const anchorWall = epochToWall(anchorMs, anchorOffset);
  const anchorDay = localDayNumber(zonePort, zoneId, anchorMs);
  if (anchorDay === null) return { triggerMs: null, reason: 'unknown_zone' };

  const buildInstant = (day: number): number | null => {
    const civil = civilFromDays(day);
    return zoneToInstant(zonePort, zoneId, {
      year: civil.year,
      month: civil.month,
      day: civil.day,
      hour: anchorWall.hour,
      minute: anchorWall.minute,
      second: anchorWall.second,
    });
  };

  if (rule.kind === 'once') {
    if (anchorMs > afterMs && !skipped.has(formatDate(anchorWall))) {
      return { triggerMs: anchorMs, reason: 'found' };
    }
    return { triggerMs: null, reason: 'single_elapsed' };
  }

  if (rule.kind === 'dates') {
    const candidates = rule.dates
      .map((text) => parseDate(text))
      .filter((value): value is { year: number; month: number; day: number } => value !== null)
      .map((civil) => ({ civil, instant: zoneToInstant(zonePort, zoneId, { ...civil, hour: anchorWall.hour, minute: anchorWall.minute, second: anchorWall.second }) }))
      .filter((entry): entry is { civil: { year: number; month: number; day: number }; instant: number } => entry.instant !== null)
      .sort((a, b) => a.instant - b.instant);
    for (const entry of candidates) {
      if (entry.instant <= afterMs) continue;
      if (skipped.has(formatDate(entry.civil))) continue;
      return { triggerMs: entry.instant, reason: 'found' };
    }
    return { triggerMs: null, reason: 'exhausted_window' };
  }

  const anchor: RuleAnchor = {
    baseDay: anchorDay,
    baseMonthIndex: monthIndex(anchorDay),
    baseWeekStart: weekStart(anchorDay),
  };

  const startDay = localDayNumber(zonePort, zoneId, afterMs);
  if (startDay === null) return { triggerMs: null, reason: 'unknown_zone' };

  let sawSkipped = false;
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const day = startDay + offset;
    if (day < anchorDay) continue;
    if (!matchesRule(rule, day, anchor)) continue;
    const localDateText = formatDate(civilFromDays(day));
    if (skipped.has(localDateText)) {
      sawSkipped = true;
      continue;
    }
    const instant = buildInstant(day);
    if (instant === null) return { triggerMs: null, reason: 'unknown_zone' };
    if (instant > afterMs) return { triggerMs: instant, reason: 'found' };
  }

  // 走到窗口边缘仍未找到：区分"全被跳过"与"规则本身再无匹配"。
  return { triggerMs: null, reason: sawSkipped ? 'skipped_all' : 'exhausted_window' };
}

/** 某条自管闹钟的下一次触发（未启用 ⇒ 无）。 */
export function nextTriggerOf(record: AlarmRecord, zonePort: ZonePort, afterMs: number): number | null {
  if (!record.enabled) return null;
  return nextOccurrence({
    rule: record.repeat,
    zoneId: record.zoneId,
    zonePort,
    anchorMs: record.firstTriggerMs,
    afterMs,
    skippedDates: record.skippedDates,
  });
}

/** 列出 `[fromMs, toMs]` 内的触发（用于"显示下次触发与重复规则"）。 */
export function occurrencesBetween(
  record: AlarmRecord,
  zonePort: ZonePort,
  fromMs: number,
  toMs: number,
  limit = 64,
): readonly AlarmOccurrence[] {
  const out: AlarmOccurrence[] = [];
  let cursor = fromMs - 1;
  for (let i = 0; i < limit; i += 1) {
    const trigger = nextOccurrence({
      rule: record.repeat,
      zoneId: record.zoneId,
      zonePort,
      anchorMs: record.firstTriggerMs,
      afterMs: cursor,
      skippedDates: record.skippedDates,
    });
    if (trigger === null || trigger > toMs) break;
    const offset = zonePort.offsetMinutesAt(record.zoneId, trigger);
    out.push({
      alarmId: record.id,
      triggerMs: trigger,
      localDate: offset === null ? '' : formatDate(epochToWall(trigger, offset)),
      revision: record.revision,
    });
    cursor = trigger;
  }
  return out;
}

/** 人可读的重复规则描述（CLK-03：查询结果显示重复规则）。 */
export function describeRepeat(rule: RepeatRule): string {
  switch (rule.kind) {
    case 'once':
      return '仅一次';
    case 'daily':
      return rule.interval === 1 ? '每天' : `每 ${rule.interval} 天`;
    case 'weekly': {
      const names = rule.weekdays
        .slice()
        .sort((a, b) => a - b)
        .map((day) => WEEKDAY_NAMES[day] ?? String(day))
        .join('、');
      const cycle = rule.interval === 1 ? '每周' : `每 ${rule.interval} 周`;
      return `${cycle} ${names}`;
    }
    case 'workdays':
      return '工作日（周一至周五）';
    case 'monthly': {
      const days = rule.daysOfMonth.slice().sort((a, b) => a - b).join('、');
      const cycle = rule.interval === 1 ? '每月' : `每 ${rule.interval} 月`;
      return `${cycle} ${days} 日`;
    }
    case 'dates':
      return `指定日期：${rule.dates.slice().sort().join('、')}`;
  }
}

const WEEKDAY_NAMES: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 校验一条重复规则是否自洽；返回问题清单。 */
export function validateRepeatRule(rule: RepeatRule): readonly string[] {
  const problems: string[] = [];
  switch (rule.kind) {
    case 'once':
      break;
    case 'daily':
      if (!Number.isInteger(rule.interval) || rule.interval < 1) {
        problems.push('daily.interval 必须是 ≥1 的整数');
      }
      break;
    case 'weekly':
      if (!Number.isInteger(rule.interval) || rule.interval < 1) {
        problems.push('weekly.interval 必须是 ≥1 的整数');
      }
      if (rule.weekdays.length === 0) problems.push('weekly.weekdays 不得为空');
      for (const day of rule.weekdays) {
        if (!Number.isInteger(day) || day < 0 || day > 6) problems.push(`非法星期值：${day}`);
      }
      break;
    case 'workdays':
      break;
    case 'monthly':
      if (!Number.isInteger(rule.interval) || rule.interval < 1) {
        problems.push('monthly.interval 必须是 ≥1 的整数');
      }
      if (rule.daysOfMonth.length === 0) problems.push('monthly.daysOfMonth 不得为空');
      for (const day of rule.daysOfMonth) {
        if (!Number.isInteger(day) || day < 1 || day > 31) problems.push(`非法日值：${day}`);
      }
      break;
    case 'dates':
      if (rule.dates.length === 0) problems.push('dates 不得为空');
      for (const text of rule.dates) {
        if (parseDate(text) === null) problems.push(`非法日期（应为 YYYY-MM-DD）：${text}`);
      }
      break;
  }
  return problems;
}
