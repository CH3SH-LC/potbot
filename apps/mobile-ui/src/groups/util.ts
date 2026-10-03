/**
 * F04 groups —— 时间戳与非空字符串校验（零依赖、纯函数）。
 *
 * 不读时钟：所有「现在 / 发生时」都由调用方以 UTC ISO 8601 字符串显式注入，
 * 保证同一输入在任何机器上得到同一状态与同一活动顺序，测试可逐字段断言。
 */

import { GroupError } from './types.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** 是否合法 UTC ISO 8601 时间戳（与契约同形状）。 */
export function isIsoUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value);
}

/**
 * 断言时间戳合法，否则抛 `invalid-timestamp`。
 * 不合法时**不猜测**、不落成空串——排序键被污染会让「最近进展」失真。
 */
export function requireIsoTimestamp(value: unknown, field: string): string {
  if (!isIsoUtcTimestamp(value)) {
    throw new GroupError('invalid-timestamp', `${field} 必须是 UTC ISO 8601 时间戳`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

/** 断言非空字符串（去首尾空白后仍非空），否则抛 `invalid-value`。 */
export function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GroupError('invalid-value', `${field} 必须是非空字符串`, { field });
  }
  return value.trim();
}
