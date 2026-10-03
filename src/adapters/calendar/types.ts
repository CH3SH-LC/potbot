/**
 * 日历域的数据模型（CAL-01 起）。
 *
 * ## 全天事件的语义（**本适配器的契约，非平台断言**）
 *
 * 全天事件用**日期**而不是时刻表达，且结束日期**排他**（iCal/RFC 5545 惯例：
 * 「8 月 1 日全天」表示为 `start=2026-08-01, endExclusive=2026-08-02`）。
 * 采用排他端点是为了让"跨天/多天全天事件"的算法统一（时长 = 端点之差）。
 *
 * **如实声明**：这是**本适配器**的契约；它与具体平台（如 Android `CalendarContract` 的
 * `ALL_DAY` 列）的映射与边界（时区列、端点含不含）**必须在真机上核对**，
 * 见 `outputs/FA-M/readiness-matrix.md` 的 CAL-03 / CAL-10。
 *
 * 星期类型复用时钟包的 {@link ../clock/types.js} 的 `Weekday`（时间原语归 clock 包）。
 */

import type { Weekday } from '../clock/types.js';

export type { Weekday };

/** 事件时间：定时（绝对时刻）或全天（日期区间，结束排他）。 */
export type EventTime =
  | {
      readonly kind: 'timed';
      readonly startMs: number;
      readonly endMs: number;
      /** 事件时区（跨时区语义，CAL-03）。 */
      readonly zoneId: string;
    }
  | {
      readonly kind: 'allDay';
      /** `YYYY-MM-DD`（含）。 */
      readonly startDate: string;
      /** `YYYY-MM-DD`（**不含**，排他端点）。 */
      readonly endDateExclusive: string;
      /** 全天事件的时区（决定"这一天"从何时开始）。 */
      readonly zoneId: string;
    };

export type AttendeeStatus = 'pending' | 'accepted' | 'declined' | 'tentative';

export interface Attendee {
  readonly email: string;
  readonly status: AttendeeStatus;
  readonly note: string | null;
}

/**
 * 重复规则（CAL-05）。字段对应 iCal 的 FREQ/INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/EXDATE。
 * `exdates` 是**例外日期**（被排除的实例）。
 */
export interface RecurrenceRule {
  readonly freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  readonly interval: number;
  /** 次数上限（与 `untilDate` 二者最多取其一，见校验）。 */
  readonly count?: number;
  /** 截止日期 `YYYY-MM-DD`（含）。 */
  readonly untilDate?: string;
  /** 周重复时的星期几。 */
  readonly byWeekday?: readonly Weekday[];
  /** 月重复时的日（1–31）。 */
  readonly byMonthDay?: readonly number[];
  /** 例外日期 `YYYY-MM-DD`（这些实例被排除）。 */
  readonly exdates?: readonly string[];
}

export interface CalendarEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly time: EventTime;
  readonly location: string | null;
  readonly description: string | null;
  readonly attendees: readonly Attendee[];
  readonly recurrence: RecurrenceRule | null;
  /** 每次变更 +1（CAL-06「绑定真实 eventId 与版本」）。 */
  readonly revision: number;
}

/** 编辑作用的范围（CAL-05）。**三者语义必须分开**，不得混为一谈。 */
export type EditScope = 'this' | 'following' | 'all';

export const EDIT_SCOPE_LABELS: Readonly<Record<EditScope, string>> = Object.freeze({
  this: '仅此一次',
  following: '此事件及后续',
  all: '整个系列',
});
