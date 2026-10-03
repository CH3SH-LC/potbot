/**
 * M04 wire 时间戳：把**注入的逻辑时钟**（epoch 毫秒）与 ISO-8601（UTC）字符串互转。
 *
 * ## 为什么单独一个模块
 *
 * 报价的 `expiresAt` / 请求的 `requestedAt` / 计价时刻 `pricedAt` 在领域内是
 * **逻辑时钟毫秒数**（`QuoteClock.now()` 注入，见 `types.ts`）。一旦要落到 wire
 * （命令 / 事件 / 工具结果），必须给出**标准时间字符串**，否则跨端各自格式化会漂移。
 *
 * ## 纪律
 *
 * - **绝不读墙钟**：本模块不读取宿主当前时刻、不构造墙钟日期对象、不读环境；输入永远是
 *   调用方传入的 epoch 毫秒。时间**只**来自注入时钟。
 * - 纯函数、可重现：同一 epoch 永远得到同一字符串（本目录的边界用例静态扫描保证）。
 * - 只处理 **UTC（`Z`）**：不做时区换算（时区/本地墙钟属于 clock 适配器，不归购物车）。
 *
 * 文件位于 `cart/contract/` 子目录的原因同 `operations.ts`（历史 M04 边界用例硬编码
 * 顶层文件清单，删不得也加不得）。
 */

import { CartValidationError } from '../errors.js';

/** 毫秒精度 ISO-8601 UTC 字符串的匹配式（不接受时区偏移，只接受 `Z`）。 */
const ISO8601_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const MS_PER_DAY = 86_400_000;

/** 报价/请求里需要 wire 转换的时间字段名（逻辑时钟毫秒 ⇒ ISO-8601 字符串）。 */
export const WIRE_TIMESTAMP_FIELDS: readonly string[] = Object.freeze([
  'requestedAt',
  'pricedAt',
  'expiresAt',
  'createdAt',
]);

/** ISO 输出精度。 */
export type Iso8601Precision = 'milliseconds' | 'seconds';

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Howard Hinnant `civil_from_days`：自 1970-01-01 起的天数 ⇒ 公历年月日。 */
function civilFromDays(daysSinceEpoch: number): CivilDate {
  const z = daysSinceEpoch + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  let year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  if (month <= 2) year += 1;
  return { year, month, day };
}

/** Howard Hinnant `days_from_civil`：公历年月日 ⇒ 自 1970-01-01 起的天数。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * 将注入的 epoch 毫秒转成 ISO-8601 UTC 字符串（默认毫秒精度）。
 *
 * @throws {CartValidationError} `epochMs` 不是安全整数时（避免精度静默丢失）。
 */
export function epochToIso8601(
  epochMs: number,
  options: { readonly precision?: Iso8601Precision } = {},
): string {
  if (!Number.isSafeInteger(epochMs)) {
    throw new CartValidationError(`时间戳必须是安全整数（epoch 毫秒），收到 ${String(epochMs)}`);
  }
  const precision = options.precision ?? 'milliseconds';
  if (precision !== 'milliseconds' && precision !== 'seconds') {
    throw new CartValidationError(`未知的时间戳精度 ${String(precision)}`);
  }
  const days = Math.floor(epochMs / MS_PER_DAY);
  let msOfDay = epochMs - days * MS_PER_DAY;
  if (precision === 'seconds') {
    msOfDay -= msOfDay % 1000;
  }
  const hour = Math.floor(msOfDay / 3_600_000);
  const minute = Math.floor((msOfDay % 3_600_000) / 60_000);
  const second = Math.floor((msOfDay % 60_000) / 1000);
  const millisecond = msOfDay % 1000;
  const civil = civilFromDays(days);
  const sign = civil.year < 0 ? '-' : '';
  const yearText = pad(Math.abs(civil.year), 4);
  const base = `${sign}${yearText}-${pad(civil.month, 2)}-${pad(civil.day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
  return precision === 'seconds' ? `${base}Z` : `${base}.${pad(millisecond, 3)}Z`;
}

/**
 * 将 ISO-8601 UTC 字符串解析回 epoch 毫秒（`epochToIso8601` 的逆）。
 *
 * @throws {CartValidationError} 形状不匹配或日期越界（如 `2023-02-30`）时。
 */
export function iso8601ToEpoch(iso: string): number {
  if (typeof iso !== 'string') {
    throw new CartValidationError('时间戳必须是字符串');
  }
  const match = ISO8601_UTC_PATTERN.exec(iso);
  if (match === null) {
    throw new CartValidationError(`时间戳不是合法的 ISO-8601 UTC 字符串：${iso}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CartValidationError(`时间戳日期越界：${iso}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new CartValidationError(`时间戳时间越界：${iso}`);
  }
  const days = daysFromCivil(year, month, day);
  const epoch = days * MS_PER_DAY + hour * 3_600_000 + minute * 60_000 + second * 1000 + millisecond;
  // 回代校验，拦截 2023-02-30 这类「形状合法、日历不存在」的日期。
  const civil = civilFromDays(days);
  if (civil.year !== year || civil.month !== month || civil.day !== day) {
    throw new CartValidationError(`时间戳日期不存在：${iso}`);
  }
  if (!Number.isSafeInteger(epoch)) {
    throw new CartValidationError(`时间戳超出安全整数范围：${iso}`);
  }
  return epoch;
}
