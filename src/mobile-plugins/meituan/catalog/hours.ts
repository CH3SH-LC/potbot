/**
 * 营业时段判定 —— 只看注入时钟，未知就是未知。
 *
 * ## 时间口径
 *
 * 本模块**不读系统时间**（墙钟 API 由 boundary 测试静态禁止）。
 * 时间来自：
 * - `WeekTime`：显式的「星期几 + 当日分钟」，由调用者或 `weekTimeFromEpoch` 得到；
 * - `weekTimeFromEpoch(epochMs, tzOffsetMinutes)`：纯算术把注入的 epoch 毫秒
 *   按给定时区偏移换算，不碰宿主时区。
 *
 * ## 未知纪律
 *
 * 营业时间为未知时，判定结果只能是 `state: 'unknown'`，**绝不**默认成「营业中」。
 * 已知但没有任何时段（空数组）是**已知闭店**（`state: 'closed'`），与未知区分开。
 */

import { CatalogValidationError } from './errors.js';
import { isKnown, type MaybeKnown } from './known.js';
import { assertIntegerInRange } from './provenance.js';
import { validateOperatingWindows } from './validate.js';
import type { OperatingWindow } from './types.js';

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

/** 一个明确的时刻：`dayOfWeek` 星期一 = 0 … 星期日 = 6；`minuteOfDay` 0–1439。 */
export interface WeekTime {
  readonly dayOfWeek: number;
  readonly minuteOfDay: number;
}

/** 构造并校验一个 `WeekTime`。 */
export function makeWeekTime(dayOfWeek: number, minuteOfDay: number): WeekTime {
  assertIntegerInRange(dayOfWeek, 0, 6, 'weekTime.dayOfWeek');
  assertIntegerInRange(minuteOfDay, 0, MINUTES_PER_DAY - 1, 'weekTime.minuteOfDay');
  return Object.freeze({ dayOfWeek, minuteOfDay });
}

/**
 * 从注入的 epoch 毫秒 + 时区偏移（分钟）换算 `WeekTime`。
 *
 * 约定：Unix epoch（0）是 **1970-01-01 星期四** ⇒ 星期一=0 时星期四=3。
 * 纯算术，不依赖宿主时区或 `Date`。
 */
export function weekTimeFromEpoch(epochMs: number, tzOffsetMinutes = 0): WeekTime {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw new CatalogValidationError(`epochMs 必须是有限数，收到 ${String(epochMs)}`);
  }
  if (typeof tzOffsetMinutes !== 'number' || !Number.isInteger(tzOffsetMinutes)) {
    throw new CatalogValidationError(`tzOffsetMinutes 必须是整数分钟，收到 ${String(tzOffsetMinutes)}`);
  }
  const localMs = epochMs + tzOffsetMinutes * MS_PER_MINUTE;
  const dayIndex = Math.floor(localMs / (MINUTES_PER_DAY * MS_PER_MINUTE));
  const minuteOfDay = Math.floor((localMs - dayIndex * MINUTES_PER_DAY * MS_PER_MINUTE) / MS_PER_MINUTE);
  const dayOfWeek = (((dayIndex + 3) % 7) + 7) % 7;
  return makeWeekTime(dayOfWeek, minuteOfDay);
}

/** 营业判定结果。 */
export type OperatingState = 'open' | 'closed' | 'unknown';

export interface OperatingStatus {
  readonly state: OperatingState;
  readonly at: WeekTime;
  readonly detail: string;
  /** 命中的时段（营业中时给出；否则 null）。 */
  readonly matchedWindow: OperatingWindow | null;
}

/** 判断 `at` 是否落在单个时段内（支持跨午夜）。 */
export function isWithinWindow(window: OperatingWindow, at: WeekTime): boolean {
  if (window.openMinute < window.closeMinute) {
    return at.dayOfWeek === window.dayOfWeek && at.minuteOfDay >= window.openMinute && at.minuteOfDay < window.closeMinute;
  }
  // 跨午夜：当天从 openMinute 到 24:00，以及次日 00:00 到 closeMinute。
  const nextDay = (window.dayOfWeek + 1) % 7;
  return (
    (at.dayOfWeek === window.dayOfWeek && at.minuteOfDay >= window.openMinute) ||
    (at.dayOfWeek === nextDay && at.minuteOfDay < window.closeMinute)
  );
}

/**
 * 判定营业状态。
 *
 * - 未知营业时间 ⇒ `unknown`（带原因），**不**默认营业中；
 * - 已知但无任何时段 ⇒ `closed`（已知闭店）；
 * - 时段非法 ⇒ 抛 `CatalogValidationError`（不静默忽略）。
 */
export function evaluateOperatingHours(
  hours: MaybeKnown<readonly OperatingWindow[]>,
  at: WeekTime,
): OperatingStatus {
  if (!isKnown(hours)) {
    return Object.freeze({
      state: 'unknown',
      at,
      detail: `营业时间未知（${hours.reason}）；不得默认按营业中处理`,
      matchedWindow: null,
    });
  }
  const windows = hours.value;
  validateOperatingWindows(windows, 'operatingHours');
  if (windows.length === 0) {
    return Object.freeze({
      state: 'closed',
      at,
      detail: '已知营业时段为空：当前按闭店处理（这是已知的闭店，不是未知）',
      matchedWindow: null,
    });
  }
  const matched = windows.find((window) => isWithinWindow(window, at));
  if (matched !== undefined) {
    return Object.freeze({
      state: 'open',
      at,
      detail: `命中营业时段 ${matched.dayOfWeek} ${matched.openMinute}–${matched.closeMinute}`,
      matchedWindow: matched,
    });
  }
  return Object.freeze({
    state: 'closed',
    at,
    detail: '当前时刻不落在任何营业时段内',
    matchedWindow: null,
  });
}
