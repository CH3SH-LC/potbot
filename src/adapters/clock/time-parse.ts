/**
 * 自然语言时间的**解析**（CLK-02：「相对时间解析为具体时间让用户核对」）。
 *
 * ## 设计立场：宁可说"不确定"，不猜
 *
 * 本模块**只**覆盖一组**明确定义**的表达，其余一律 `unparsed` 并给出原因。
 * 理由：CLK-02 的价值在于"把模糊说法变成用户能核对的具体时刻"；一个自作聪明的
 * 模糊解析会把"19:00 还是 07:00"的歧义**藏起来**，反而比"看不懂"更危险。
 * 因此：
 * - **歧义**（如无上下午的"7 点"）⇒ 返回**多个候选**，`requiresConfirmation = true`，**不替用户选**；
 * - **相对时间**（如"10 分钟后"）⇒ 解析成具体时刻，但 `requiresConfirmation = true`（必须给用户看）；
 * - **看不懂** ⇒ `unparsed` + 原因。
 *
 * 全程不读墙钟（`nowMs` 由调用方注入）、不用 `Date`（纪律）。
 */

import { civilFromDays, epochToWall, formatDateTime } from './civil.js';
import { zoneToInstant, type ZonePort } from './zone.js';
import { localDayNumber } from './repeat.js';

export interface TimeCandidate {
  readonly epochMs: number;
  readonly zoneId: string;
  /** `YYYY-MM-DD HH:MM`。 */
  readonly local: string;
  /** 人话解释（用户核对用），如「10 分钟后」。 */
  readonly interpretation: string;
}

export type TimeParseKind = 'resolved' | 'ambiguous' | 'unparsed';

export interface TimeParseResult {
  readonly kind: TimeParseKind;
  /** 唯一解；`ambiguous` / `unparsed` 时为 null。 */
  readonly resolved: TimeCandidate | null;
  /** 一个或多个候选（`ambiguous` 时至少两个）。 */
  readonly candidates: readonly TimeCandidate[];
  /** 是否**必须**请用户核对后才可落地（相对时间与歧义都必须）。 */
  readonly requiresConfirmation: boolean;
  /** `unparsed` 时必填原因；`ambiguous` 时说明歧义类型。 */
  readonly reason: string | null;
}

export interface ParseTimeOptions {
  readonly nowMs: number;
  readonly zoneId: string;
  readonly zonePort: ZonePort;
}

const CN_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

function cnDigit(text: string): number | null {
  if (/^\d$/.test(text)) return Number(text);
  return CN_DIGITS[text] ?? null;
}

/** 解析 0–99 的中文/阿拉伯数字；`半` 只作为独立词返回 0.5。 */
export function parseCnNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '半') return 0.5;
  const tenIndex = trimmed.indexOf('十');
  if (tenIndex !== -1) {
    const left = trimmed.slice(0, tenIndex);
    const right = trimmed.slice(tenIndex + 1);
    const tens = left === '' ? 1 : cnDigit(left);
    const ones = right === '' ? 0 : cnDigit(right);
    if (tens === null || ones === null) return null;
    return tens * 10 + ones;
  }
  return cnDigit(trimmed);
}

const NUMBER_PATTERN = '(\\d+|[零一二两三四五六七八九十]+|半)';

interface TimeUnit {
  readonly minutes: number;
  readonly label: string;
}

const TIME_UNITS: Readonly<Record<string, TimeUnit>> = Object.freeze({
  秒: { minutes: 1 / 60, label: '秒' },
  秒钟: { minutes: 1 / 60, label: '秒' },
  分: { minutes: 1, label: '分钟' },
  分钟: { minutes: 1, label: '分钟' },
  小时: { minutes: 60, label: '小时' },
  天: { minutes: 1440, label: '天' },
  周: { minutes: 1440 * 7, label: '周' },
  星期: { minutes: 1440 * 7, label: '周' },
});

/** 归一化单位词：剥掉可选的「个」，再查表。 */
function lookupUnit(word: string): TimeUnit | undefined {
  return TIME_UNITS[word.replace(/^个/, '')];
}

/** 相对时间：`N 个单位后`，只认明确单位（`半个`、`一会儿` 之类一律 unparsed）。 */
function parseRelative(text: string, options: ParseTimeOptions): TimeParseResult | null {
  const match = new RegExp(
    `^${NUMBER_PATTERN}\\s*(?:个)?\\s*([\\u4e00-\\u9fa5]{1,3})\\s*(?:后|之后|以后)$`,
  ).exec(text.trim());
  if (match === null) return null;
  const amount = parseCnNumber(match[1] ?? '');
  const unitWord = match[2] ?? '';
  const unit = lookupUnit(unitWord);
  if (amount === null) {
    return unparsed(`无法识别数量「${match[1] ?? ''}」`);
  }
  if (unit === undefined) {
    return unparsed(`无法识别时间单位「${unitWord}」`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return unparsed('相对时间的数量必须为正');
  }
  const deltaMs = Math.round(amount * unit.minutes * 60_000);
  const target = options.nowMs + deltaMs;
  const candidate = makeCandidate(target, options, `${match[1] ?? ''}${unit.label}后`);
  if (candidate === null) return unparsed('时区未知，无法换算成具体时刻');
  return {
    kind: 'resolved',
    resolved: candidate,
    candidates: [candidate],
    // 相对时间**必须**给用户看具体时刻（CLK-02）。
    requiresConfirmation: true,
    reason: null,
  };
}

type DayHint = 'today' | 'tomorrow' | 'dayAfter' | 'none';
type Period = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'night' | 'none';

const DAY_HINTS: readonly { readonly pattern: RegExp; readonly hint: DayHint; readonly label: string }[] = [
  { pattern: /^(今天|今日)/, hint: 'today', label: '今天' },
  { pattern: /^(明天|明日)/, hint: 'tomorrow', label: '明天' },
  { pattern: /^后天/, hint: 'dayAfter', label: '后天' },
];

const PERIODS: readonly { readonly pattern: RegExp; readonly period: Period; readonly label: string }[] = [
  { pattern: /^凌晨/, period: 'dawn', label: '凌晨' },
  { pattern: /^(早上|早晨|上午)/, period: 'morning', label: '上午' },
  { pattern: /^中午/, period: 'noon', label: '中午' },
  { pattern: /^(下午|傍晚)/, period: 'afternoon', label: '下午' },
  { pattern: /^晚上/, period: 'night', label: '晚上' },
];

/** 把 12 小时制的钟点 + 时段，换算成 0–23 的 24 小时制钟点。 */
function resolveHour(hour12: number, period: Period): number | null {
  switch (period) {
    case 'dawn':
      return hour12 >= 1 && hour12 <= 5 ? hour12 : null;
    case 'morning':
      return hour12 >= 1 && hour12 <= 12 ? hour12 : null;
    case 'noon':
      if (hour12 === 12) return 12;
      return hour12 >= 1 && hour12 <= 2 ? 12 + hour12 : null;
    case 'afternoon':
      if (hour12 === 12) return 12;
      return hour12 >= 1 && hour12 <= 11 ? hour12 + 12 : null;
    case 'night':
      if (hour12 === 12) return 0; // 晚上 12 点 = 次日 0 点
      return hour12 >= 1 && hour12 <= 11 ? hour12 + 12 : null;
    case 'none':
      return hour12 >= 0 && hour12 <= 23 ? hour12 : null;
  }
}

function unparsed(reason: string): TimeParseResult {
  return { kind: 'unparsed', resolved: null, candidates: [], requiresConfirmation: false, reason };
}

/**
 * 解析一句时间表达。支持：
 * - 相对：`10分钟后` / `半小时后` / `两天后` / `3小时后`；
 * - 绝对：`[今天|明天|后天] + [时段] + H点[M分]` 或 `H:MM`（24 小时制）。
 *
 * 其余返回 `unparsed` 并给原因；歧义返回多候选。
 */
export function parseNaturalTime(text: string, options: ParseTimeOptions): TimeParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return unparsed('空的时间表达');

  const relative = parseRelative(trimmed, options);
  if (relative !== null) return relative;

  const baseDay = localDayNumber(options.zonePort, options.zoneId, options.nowMs);
  if (baseDay === null) return unparsed(`时区未知，无法换算成具体时刻：${options.zoneId}`);

  let rest = trimmed;
  let dayHint: DayHint = 'none';
  let dayLabel = '';
  for (const entry of DAY_HINTS) {
    if (entry.pattern.test(rest)) {
      dayHint = entry.hint;
      dayLabel = entry.label;
      rest = rest.replace(entry.pattern, '');
      break;
    }
  }

  let period: Period = 'none';
  let periodLabel = '';
  for (const entry of PERIODS) {
    if (entry.pattern.test(rest)) {
      period = entry.period;
      periodLabel = entry.label;
      rest = rest.replace(entry.pattern, '');
      break;
    }
  }
  rest = rest.replace(/^天/, ''); // 「明天7点」里"天"已被 DAY_HINTS 吃掉；此处兜底

  // 钟点：`7点30分` / `7:30` / `19点`
  const pointMatch = /^(\d{1,2}|[零一二两三四五六七八九十]+)\s*[点时:：]\s*(半|\d{1,2}|[零一二两三四五六七八九十]+)?\s*分?$/.exec(
    rest,
  );
  if (pointMatch === null) {
    return unparsed(`无法识别的时间表达：「${trimmed}」（本切片只支持相对时间与「[日期][时段]H点MM分 / H:MM」）`);
  }

  const hourRaw = parseCnNumber(pointMatch[1] ?? '');
  if (hourRaw === null) return unparsed(`无法识别的钟点：${pointMatch[1] ?? ''}`);
  const minuteRaw = pointMatch[2] === undefined ? 0 : parseCnNumber(pointMatch[2]);
  if (minuteRaw === null) return unparsed(`无法识别的分钟：${pointMatch[2] ?? ''}`);
  const minute = minuteRaw === 0.5 ? 30 : minuteRaw;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return unparsed(`非法分钟：${pointMatch[2] ?? ''}`);
  }

  // 歧义 A：显式给了时段 ⇒ 无歧义；否则 1–12 点可能是上午也可能是下午。
  const hour = resolveHour(hourRaw, period);
  if (hour === null) {
    return unparsed(`「${periodLabel}${String(hourRaw)}点」不是合理的钟点`);
  }
  const ambiguousMeridiem = period === 'none' && hourRaw >= 1 && hourRaw <= 12;

  // 歧义 B：没给日期，且时刻已过 ⇒ 今天还是明天？
  const ambiguousDay = dayHint === 'none';

  const dayOffset = dayHint === 'today' ? 0 : dayHint === 'tomorrow' ? 1 : dayHint === 'dayAfter' ? 2 : 0;

  const candidates: TimeCandidate[] = [];
  const hourOptions = ambiguousMeridiem ? [hourRaw, hourRaw + 12] : [hour];

  for (const candidateHour of hourOptions) {
    if (candidateHour > 23) continue;
    const dayCandidates = ambiguousDay ? [baseDay + dayOffset, baseDay + dayOffset + 1] : [baseDay + dayOffset];
    for (const day of dayCandidates) {
      const candidate = makeCandidateFromDay(day, candidateHour, minute, options, {
        dayLabel: ambiguousDay ? (day === baseDay ? '今天' : '明天') : dayLabel,
        periodLabel: ambiguousMeridiem ? '' : periodLabel,
      });
      if (candidate === null) continue;
      // 明确给了日期时，已过的时刻不算候选（由用户自己说清楚）。
      if (!ambiguousDay && candidate.epochMs <= options.nowMs) continue;
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return unparsed(`「${trimmed}」解析出的时刻已过去，请说明更明确的日期`);
  }

  const unique = dedupeByEpoch(candidates);

  if (unique.length === 1) {
    const only = unique[0];
    if (only === undefined) return unparsed('内部错误：候选为空');
    return {
      kind: 'resolved',
      resolved: only,
      candidates: unique,
      // 没有时段/日期提示时也要核对（歧义的另一半仍在）。
      requiresConfirmation: ambiguousMeridiem || ambiguousDay,
      reason: null,
    };
  }

  const reasons: string[] = [];
  if (ambiguousMeridiem) reasons.push('未说明上午/下午');
  if (ambiguousDay) reasons.push('未说明是哪一天');
  return {
    kind: 'ambiguous',
    resolved: null,
    candidates: unique,
    requiresConfirmation: true,
    reason: `${reasons.join('，') || '存在多种解释'}；请用户选择其中一个具体时刻`,
  };
}

function dedupeByEpoch(candidates: readonly TimeCandidate[]): TimeCandidate[] {
  const seen = new Set<number>();
  const out: TimeCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.epochMs)) continue;
    seen.add(candidate.epochMs);
    out.push(candidate);
  }
  return out;
}

function makeCandidate(
  epochMs: number,
  options: ParseTimeOptions,
  interpretation: string,
): TimeCandidate | null {
  const offset = options.zonePort.offsetMinutesAt(options.zoneId, epochMs);
  if (offset === null) return null;
  return {
    epochMs,
    zoneId: options.zoneId,
    local: formatDateTime(epochToWall(epochMs, offset)),
    interpretation,
  };
}

function makeCandidateFromDay(
  day: number,
  hour: number,
  minute: number,
  options: ParseTimeOptions,
  labels: { readonly dayLabel: string; readonly periodLabel: string },
): TimeCandidate | null {
  const civil = civilFromDays(day);
  const instant = zoneToInstant(options.zonePort, options.zoneId, {
    year: civil.year,
    month: civil.month,
    day: civil.day,
    hour,
    minute,
    second: 0,
  });
  if (instant === null) return null;
  const offset = options.zonePort.offsetMinutesAt(options.zoneId, instant);
  if (offset === null) return null;
  return {
    epochMs: instant,
    zoneId: options.zoneId,
    local: formatDateTime(epochToWall(instant, offset)),
    interpretation: `${labels.dayLabel}${labels.periodLabel}${pad2(hour)}:${pad2(minute)}`,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
