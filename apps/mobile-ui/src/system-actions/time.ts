/**
 * F-R06 system-actions —— 绝对时间绑定（I-A）。
 *
 * design-07 行 133：日程/提醒动作必须展示明确**日期、时间、时区、目标账号/应用、重复规则
 * 和影响范围**；**相对时间不得直接作为最终执行摘要**。
 *
 * 本模块把这条要求落成可机器断言的类型：
 *   TimeSpec = ResolvedTime（绝对瞬时 + IANA 时区，**可执行**）
 *            | RelativeTime（用户相对表达，**不可执行**、只能展示提示）
 *
 * `requireResolvedTime` 对相对表达 fail-closed；`summarizeTime` 产出的执行摘要**只**由
 * 绝对字段拼成，绝不回显相对表达。相对→绝对的解析属内核/模型侧职责，不在本包。
 */

import { SystemActionError } from './types.js';

/** 与契约同形的 UTC ISO 8601 时间戳。 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** IANA 时区 id（Area/Location 形式）或字面量 `UTC`；拒绝 `local`/`Z`/空串。 */
const IANA_TZ = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

export function isIsoUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value);
}

export function requireIsoTimestamp(value: unknown, field: string): string {
  if (!isIsoUtcTimestamp(value)) {
    throw new SystemActionError('invalid-timestamp', `${field} 必须是 UTC ISO 8601 时间戳`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

export function isIanaTimezone(value: unknown): value is string {
  return typeof value === 'string' && IANA_TZ.test(value);
}

export function requireTimezone(value: unknown, field = 'timezone'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SystemActionError('missing-timezone', `${field} 不能为空`, { field });
  }
  if (!isIanaTimezone(value)) {
    throw new SystemActionError(
      'invalid-timezone',
      `${field} 必须是 IANA 时区 id（如 Asia/Shanghai）或 UTC`,
      { field },
    );
  }
  return value;
}

/** 已解析、可执行的绝对时间。 */
export interface ResolvedTime {
  readonly kind: 'resolved';
  /** UTC 瞬时，ISO 8601。 */
  readonly instant: string;
  /** IANA 时区 id，展示与重复计算用。 */
  readonly timezone: string;
  readonly allDay: boolean;
}

/**
 * 用户给出的相对表达——**仅供展示提示**，不能作为最终执行摘要。
 * 解析成绝对时间后应改用 `ResolvedTime`。
 */
export interface RelativeTime {
  readonly kind: 'relative';
  readonly expression: string;
}

export type TimeSpec = ResolvedTime | RelativeTime;

export function isResolvedTime(value: unknown): value is ResolvedTime {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'resolved';
}

export function isRelativeTime(value: unknown): value is RelativeTime {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'relative';
}

/** 构造一个已解析的绝对时间（校验字段合法性）。 */
export function resolvedTime(instant: string, timezone: string, allDay = false): ResolvedTime {
  requireIsoTimestamp(instant, 'instant');
  requireTimezone(timezone, 'timezone');
  if (typeof allDay !== 'boolean') {
    throw new SystemActionError('invalid-timestamp', 'allDay 必须是布尔', { field: 'allDay' });
  }
  return Object.freeze({ kind: 'resolved', instant, timezone, allDay });
}

/** 构造一个相对表达（仅展示用）。 */
export function relativeTime(expression: string): RelativeTime {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new SystemActionError('relative-time-not-resolved', 'relative.expression 必须是非空字符串', {
      field: 'expression',
    });
  }
  return Object.freeze({ kind: 'relative', expression: expression.trim() });
}

/**
 * 要求「可执行的绝对时间」（I-A）。
 * 相对表达 / 缺字段 / 非法字段一律 fail-closed，绝不静默当作已解析。
 */
export function requireResolvedTime(spec: unknown, field: string): ResolvedTime {
  if (spec === undefined || spec === null || typeof spec !== 'object') {
    throw new SystemActionError('relative-time-not-resolved', `${field} 缺少可执行的时间`, { field });
  }
  if (isRelativeTime(spec)) {
    throw new SystemActionError(
      'relative-time-not-resolved',
      `${field} 仍是相对表达「${spec.expression}」，必须先解析为绝对时间才能执行`,
      { field, expression: spec.expression },
    );
  }
  if (!isResolvedTime(spec)) {
    throw new SystemActionError('relative-time-not-resolved', `${field} 不是合法的已解析时间`, { field });
  }
  return resolvedTime(spec.instant, spec.timezone, spec.allDay);
}

/**
 * 生成**执行摘要**：只由绝对字段拼成，绝不含相对表达。
 * 结果形如 `2026-10-04T01:00:00Z@Asia/Shanghai`（全天另加 ` (all-day)`）。
 */
export function summarizeTime(spec: unknown, field: string): string {
  const resolved = requireResolvedTime(spec, field);
  return `${resolved.instant}@${resolved.timezone}${resolved.allDay ? ' (all-day)' : ''}`;
}

/** 两个已解析瞬时的先后：`a` 早于 `b` 返回 -1，相等 0，晚于 1。 */
export function compareInstant(a: ResolvedTime, b: ResolvedTime): -1 | 0 | 1 {
  const ta = Date.parse(a.instant);
  const tb = Date.parse(b.instant);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}
