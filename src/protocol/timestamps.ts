/**
 * 纯整数的 UTC 时间换算（合同 R50.4 的**内核零墙钟**要求）。
 *
 * ## 为什么需要这个文件
 *
 * `new Date(x).toISOString()` 对**给定**的 epoch 毫秒是确定性的（不读墙钟），但它仍然用了
 * 被禁用的 token `new Date(`。`w-disc-kernel-discipline` 的判据**不看意图、只看 token**——
 * 这是刻意的：一旦内核里允许 `new Date(`，就无法机器化区分"格式化一个已知值"和"顺手读了现在"。
 * 因此本仓的内核改用 Howard Hinnant 的**纯整数 civil 算法**，输出与 `toISOString()` 同格式。
 *
 * ## 边界
 *
 * - 只做 **UTC**（`toISOString()` 也是 UTC）。要本地时区请走 `src/adapters/clock` 的 civil/zone 层。
 * - 不读墙钟、不用 `Date`、不含随机数 ⇒ 同输入恒同输出。
 * - 支持的年份范围与 `Date` 的 `toISOString()` 略有差别：本实现不因年份超出 `±275760` 而抛
 *   `RangeError`，而是照常计算（调用方若需要 RangeError 语义请在别处校验）。
 */

/** 一天的毫秒数。 */
const MS_PER_DAY = 86_400_000;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** 公历年月日 → 1970-01-01 起的天数（Howard Hinnant，`civil_from_days` 的逆）。 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 1970-01-01 起的天数 → 公历年月日（Howard Hinnant，`civil_from_days`）。 */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/**
 * epoch 毫秒 → `YYYY-MM-DDTHH:MM:SS.sssZ`（与 `Date.prototype.toISOString()` 同格式）。
 *
 * 对负数时间戳（1970 之前）同样给出正确的日与时刻——`Math.floor` 与一次余数回正是刻意的。
 */
export function formatIsoTimestampUtc(instantMs: number): string {
  const days = Math.floor(instantMs / MS_PER_DAY);
  let rest = instantMs - days * MS_PER_DAY;
  if (rest < 0) {
    rest += MS_PER_DAY;
  }
  const { year, month, day } = civilFromDays(days);
  const hour = Math.floor(rest / 3_600_000);
  rest -= hour * 3_600_000;
  const minute = Math.floor(rest / 60_000);
  rest -= minute * 60_000;
  const second = Math.floor(rest / 1000);
  const milli = rest - second * 1000;

  const yearText = year < 0 ? `-${pad(-year, 6)}` : pad(year, 4);
  return `${yearText}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(milli, 3)}Z`;
}

/** epoch 毫秒 → 1970-01-01 起的**整天数**（UTC；负数取值向下取整）。 */
export function dayNumberUtc(instantMs: number): number {
  return Math.floor(instantMs / MS_PER_DAY);
}

/** `formatIsoTimestampUtc` 的严格逆：`YYYY-MM-DDTHH:MM:SS.sssZ`（恰好四位年 + 毫秒 + `Z`）。 */
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** 各月天数（UTC，非闰年）；2 月由 `isLeapYearUtc` 修正。 */
function daysInMonthUtc(year: number, month: number): number {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYearUtc(year)) {
    return 29;
  }
  return table[month - 1] ?? 0;
}

/** 公历闰年判定（UTC 语义；与 `civilFromDays` 同一套算法，不依赖 `Date`）。 */
export function isLeapYearUtc(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * `YYYY-MM-DDTHH:MM:SS.sssZ` → epoch 毫秒；**不是合法时刻返回 `null`**（不猜、不静默进位）。
 *
 * 与 `formatIsoTimestampUtc` 构成**逐字符往返**。刻意**不用 `new Date()`**：合同 R50.4 禁该 token。
 * 拒绝 `2026-02-30` 这类"格式正确但日历上不存在"的日期（与 `xls-io` 的日期守卫同口径）。
 */
export function parseIsoTimestampUtc(text: string): number | null {
  const match = ISO_TIMESTAMP_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milli = Number(match[7]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonthUtc(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return (
    timestampFromCivilUtc(year, month, day) +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1000 +
    milli
  );
}

/** 公历年月日 → epoch 毫秒（UTC 零点）。是 `daysFromCivil` 的毫秒版。 */
export function timestampFromCivilUtc(year: number, month: number, day: number): number {
  return daysFromCivil(year, month, day) * MS_PER_DAY;
}
