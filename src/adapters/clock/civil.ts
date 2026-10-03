/**
 * 民用日历的**纯整数**换算（Howard Hinnant 的 `days_from_civil` / `civil_from_days`）。
 *
 * ## 为什么不用 `Date`
 *
 * 合同 R50.4 的纪律扫描器（`tests/acceptance/office/w-disc-kernel-discipline.test.ts`）
 * 在 `src/**` 非测试代码里**禁用** `new Date(` / `Date.now(` / `toLocaleString`（含 `Date`
 * 对象的一切构造路径），因为墙钟与本地化都是**非确定性**来源。日历 / 时钟换算本来
 * 完全可以只用整数算术完成，所以这里**一个 `Date` 都不碰**——同一输入必得同一输出。
 *
 * `Date.UTC(` 虽未被禁用，但既然民用换算已可纯整数完成，就不再引入第二个时间实现。
 *
 * 本模块是 clock 与 calendar 两包的**共同底座**（时间原语归属 clock 包）。
 */

/** 一个**朴素**民用时刻（无时区含义，配合 ZonePort 的偏移才有绝对含义）。 */
export interface WallClock {
  /** 完整年份（如 2026）。 */
  readonly year: number;
  /** 1–12。 */
  readonly month: number;
  /** 1–31。 */
  readonly day: number;
  /** 0–23。 */
  readonly hour: number;
  /** 0–59。 */
  readonly minute: number;
  /** 0–59。 */
  readonly second: number;
}

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** 截断除法（与 Hinnant 原文的 C++ 整数除法同语义；**不是** `Math.floor`）。 */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** 取模（结果恒非负，用于"负 epoch 也要落到当天 0 点"）；`b` 必须为正。 */
export function floorMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** 民用日期 → 自 1970-01-01 起的天数（可为负）。 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = idiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = idiv(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** 自 1970-01-01 起的天数 → 民用日期。 */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = idiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100)); // [0, 365]
  const mp = idiv(5 * doy + 2, 153); // [0, 11]
  const d = doy - idiv(153 * mp + 2, 5) + 1; // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

/** 该民用日期的星期几（0 = 周日 … 6 = 周六）。1970-01-01 是周四。 */
export function weekdayOfDays(days: number): number {
  return floorMod(days + 4, 7);
}

/** 某年某月的天数。 */
export function daysInMonth(year: number, month: number): number {
  const first = daysFromCivil(year, month, 1);
  const next = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  return next - first;
}

/**
 * 绝对时刻 + UTC 偏移（分钟）⇒ 朴素民用时刻。
 *
 * 偏移是"该时刻在当地相对 UTC 的偏移"（东为正，如 Asia/Shanghai = +480）。
 */
export function epochToWall(instantMs: number, offsetMinutes: number): WallClock {
  const shifted = instantMs + offsetMinutes * MS_PER_MINUTE;
  const days = Math.floor(shifted / MS_PER_DAY);
  const msOfDay = shifted - days * MS_PER_DAY;
  const civil = civilFromDays(days);
  return {
    year: civil.year,
    month: civil.month,
    day: civil.day,
    hour: Math.floor(msOfDay / MS_PER_HOUR),
    minute: Math.floor((msOfDay % MS_PER_HOUR) / MS_PER_MINUTE),
    second: Math.floor((msOfDay % MS_PER_MINUTE) / MS_PER_SECOND),
  };
}

/** 朴素民用时刻 + UTC 偏移（分钟）⇒ 绝对时刻。 */
export function wallToEpoch(wall: WallClock, offsetMinutes: number): number {
  const days = daysFromCivil(wall.year, wall.month, wall.day);
  const msOfDay =
    wall.hour * MS_PER_HOUR + wall.minute * MS_PER_MINUTE + wall.second * MS_PER_SECOND;
  return days * MS_PER_DAY + msOfDay - offsetMinutes * MS_PER_MINUTE;
}

/** 把时刻归到当地自然日的 0 点（用给定偏移）。 */
export function startOfLocalDay(instantMs: number, offsetMinutes: number): number {
  const shifted = instantMs + offsetMinutes * MS_PER_MINUTE;
  const dayStart = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY;
  return dayStart - offsetMinutes * MS_PER_MINUTE;
}

/** `YYYY-MM-DD`（**不**用 toLocaleString；纪律禁用）。 */
export function formatDate(wall: { year: number; month: number; day: number }): string {
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`;
}

/** `YYYY-MM-DD HH:MM[:SS]`。 */
export function formatDateTime(wall: WallClock, withSeconds = false): string {
  const base = `${formatDate(wall)} ${pad(wall.hour, 2)}:${pad(wall.minute, 2)}`;
  return withSeconds ? `${base}:${pad(wall.second, 2)}` : base;
}

/** `HH:MM`。 */
export function formatTimeOfDay(wall: { hour: number; minute: number }): string {
  return `${pad(wall.hour, 2)}:${pad(wall.minute, 2)}`;
}

function pad(value: number, width: number): string {
  const text = String(Math.abs(value));
  return `${value < 0 ? '-' : ''}${text.padStart(width, '0')}`;
}

/** 解析 `YYYY-MM-DD`；非法返回 null（不做宽松猜测）。 */
export function parseDate(text: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}
