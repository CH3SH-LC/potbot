/**
 * 时钟域的数据模型（CLK-01 起）。
 *
 * **归属必须显式**（CLK-01：「明确区分 potbot 自管提醒、系统时钟交接和可读回的厂商能力；
 * 每个对象记录真实归属与 ID」）。本文件把三种归属做成**类型**，而不是靠字符串约定：
 * 自管对象只能是 {@link AlarmRecord}（`ownership: 'self_managed'`），
 * 系统侧对象只能经 {@link ./handoff.ts} 产生，且**不携带**可写回的本地记录。
 */

/** 0 = 周日 … 6 = 周六。 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 重复规则（CLK-02：工作日 / 指定日期 / 单次 / 重复）。 */
export type RepeatRule =
  /** 单次。 */
  | { readonly kind: 'once' }
  /** 每 `interval` 天。 */
  | { readonly kind: 'daily'; readonly interval: number }
  /** 每 `interval` 周，在这些星期几。 */
  | {
      readonly kind: 'weekly';
      readonly interval: number;
      readonly weekdays: readonly Weekday[];
    }
  /** 工作日（周一至周五）。 */
  | { readonly kind: 'workdays' }
  /** 每 `interval` 月，在这些日（1–31；不足该日的月份跳过该次）。 */
  | {
      readonly kind: 'monthly';
      readonly interval: number;
      readonly daysOfMonth: readonly number[];
    }
  /** 指定日期（`YYYY-MM-DD`）。 */
  | { readonly kind: 'dates'; readonly dates: readonly string[] };

/**
 * 对象的**真实归属**（CLK-01）。
 *
 * - `self_managed`：potbot 自己记账、自己恢复的提醒；**不是**系统闹钟；
 * - `system_handoff`：交给系统/厂商时钟应用执行的动作；我们**没有**它的记录，只有交接回执；
 * - `vendor_readable`：厂商提供了**读取接口**、可回读的能力（当前**未接通**，见 not-ready）。
 */
export type AlarmOwnership = 'self_managed' | 'system_handoff' | 'vendor_readable';

/** 一条自管提醒的完整记录。 */
export interface AlarmRecord {
  /** 本地稳定 ID。 */
  readonly id: string;
  readonly ownership: 'self_managed';
  readonly label: string;
  readonly zoneId: string;
  /** 首次触发的**绝对**时刻（相对时间必须已解析成具体时刻，CLK-02）。 */
  readonly firstTriggerMs: number;
  readonly repeat: RepeatRule;
  readonly enabled: boolean;
  /** 每次修改 +1（动作参数绑版本，CLK-09）。 */
  readonly revision: number;
  readonly createdAtMs: number;
  /** 被"取消一次发生"跳过的本地日期（`YYYY-MM-DD`）。 */
  readonly skippedDates: readonly string[];
}

/** 创建自管提醒的输入。 */
export interface AlarmDraft {
  readonly label: string;
  readonly zoneId: string;
  readonly firstTriggerMs: number;
  readonly repeat: RepeatRule;
}

/** 一次触发（用于展示与"下次触发"计算）。 */
export interface AlarmOccurrence {
  readonly alarmId: string;
  readonly triggerMs: number;
  /** 触发时刻在闹钟时区里的本地日期（`YYYY-MM-DD`）。 */
  readonly localDate: string;
  readonly revision: number;
}
