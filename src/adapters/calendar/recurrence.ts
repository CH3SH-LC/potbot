/**
 * CAL-05：**重复规则、截止、例外**，以及「**本次 / 后续 / 整个系列**」的
 * 编辑与删除语义——三者的**受影响实例集合必须分别验明**，绝不误改整组。
 *
 * ## 相对既有 `recur.ts` 补的是什么
 *
 * `recur.planScopeEdit` 只给出**平台机制的形状**（`single_exception` /
 * `split_series` / `whole_series`）。本模块在它之上再给出**受影响与不受影响的实例清单**
 * （本地日期），于是"`this` 只动一次""`all` 才动整组"从注释变成**可断言的集合关系**：
 *
 * - `this` ⇒ `affected` 恰为 **1** 条；`untouched` 含其余全部；
 * - `following` ⇒ `affected` = 从分叉点起的后缀；`untouched` = 其前缀；
 * - `all` ⇒ `untouched` 为空、`wholeSeries === true`；
 * - 三者 `signature` 两两不同（`this ≠ following ≠ all`）。
 *
 * ## 如实声明（不得编造）
 *
 * - 平台（Android `CalendarContract`）**没有** this/following/all 的三选一 API，只有
 *   例外行（`ORIGINAL_ID` + `ORIGINAL_INSTANCE_TIME`）与 `EXDATE` 这类**结构化机制**。
 *   "改成后续"在平台上通常是**应用层两步**（截断原系列 + 新建系列）。**该两步在真机上的
 *   执行与读回未验证（需真机）**；本模块只产出**计划**，不写平台。
 * - `count` 计数按 RFC 5545 口径（含被 EXDATE 排除的实例），与 `recur.ts` 保持一致。
 *
 * ## 交付说明
 *
 * 子智能体模型身份**未确认为 DS**；本文件为在 `fa/calendar-core` 工作树内**新增**。
 */

import { civilFromDays, formatDate } from '../clock/civil.js';
import type { ZonePort } from '../clock/zone.js';
import { validateRecurrenceShape } from './event.js';
import {
  expandRecurrence,
  planScopeEdit,
  scopePlanSignature,
  type ExpansionResult,
  type Occurrence,
  type ScopePlan,
} from './recur.js';
import { EDIT_SCOPE_LABELS, type CalendarEvent, type EditScope, type RecurrenceRule } from './types.js';

const MS_PER_DAY = 86_400_000;

/** 重复规则的形状校验（透传 `event.validateRecurrenceShape`）。 */
export function validateRule(rule: RecurrenceRule): readonly string[] {
  return validateRecurrenceShape(rule);
}

/** 绝对时刻 → 某时区的本地日期；未知时区返回 null（不猜）。 */
export function localDateAt(zonePort: ZonePort, zoneId: string, instantMs: number): string | null {
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  if (offset === null) return null;
  const day = Math.floor((instantMs + offset * 60_000) / MS_PER_DAY);
  return formatDate(civilFromDays(day));
}

/**
 * 展开一个**事件**（含"不重复"事件）。
 *
 * - 有重复规则 ⇒ 走 `recur.expandRecurrence`；
 * - 无重复规则 ⇒ 把事件自身当作**唯一一次**返回（`degenerate: true` 由上层标注）。
 */
export function expandSeries(
  event: CalendarEvent,
  zonePort: ZonePort,
  fromMs: number,
  toMs: number,
): ExpansionResult {
  if (event.recurrence === null) {
    if (event.time.kind === 'timed') {
      const offset = zonePort.offsetMinutesAt(event.time.zoneId, event.time.startMs);
      if (offset === null) {
        return { occurrences: [], truncated: false, reason: `事件时区未知：${event.time.zoneId}` };
      }
      const single: Occurrence = {
        index: 1,
        startMs: event.time.startMs,
        endMs: event.time.endMs,
        localDate: formatDate(civilFromDays(Math.floor((event.time.startMs + offset * 60_000) / MS_PER_DAY))),
      };
      const inWindow = single.endMs > fromMs && single.startMs <= toMs;
      return { occurrences: inWindow ? [single] : [], truncated: false, reason: null };
    }
    const expanded = expandRecurrence(event.time, { freq: 'daily', interval: 1, count: 1 }, zonePort, fromMs, toMs);
    return expanded;
  }
  return expandRecurrence(event.time, event.recurrence, zonePort, fromMs, toMs);
}

export interface ScopedChangePlan {
  readonly scope: EditScope;
  readonly scopeLabel: string;
  /** 平台机制形状（来自 `recur.planScopeEdit`）。 */
  readonly plan: ScopePlan;
  /** 受影响的实例本地日期（按系列顺序）。 */
  readonly affectedLocalDates: readonly string[];
  /** **不受影响**的实例本地日期（反向对照）。 */
  readonly untouchedLocalDates: readonly string[];
  /** 是否改动整个系列（仅 `all` 为 true）。 */
  readonly wholeSeries: boolean;
  /** 事件本身不重复 ⇒ 三种范围退化为同一次（此时不得声称"只影响一次"是系列语义）。 */
  readonly degenerate: boolean;
  /** 三种范围的结构签名（用于断言两两不同）。 */
  readonly signature: string;
}

export interface ScopeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * 规划一次"按范围编辑"（CAL-05）。
 *
 * 返回受/不受影响的实例清单；时区未知、时刻非法或窗口非法 ⇒ null（**不猜**）。
 */
export function planScopedEdit(
  event: CalendarEvent,
  scope: EditScope,
  occurrenceStartMs: number,
  zonePort: ZonePort,
  window: ScopeWindow,
): ScopedChangePlan | null {
  if (window.toMs <= window.fromMs) {
    throw new Error('展开窗口必须满足 toMs > fromMs（CAL-02/CAL-05：范围必须明确）');
  }
  const plan = planScopeEdit(event.time, scope, occurrenceStartMs, zonePort);
  if (plan === null) return null;
  const anchorDate = localDateAt(zonePort, event.time.zoneId, occurrenceStartMs);
  if (anchorDate === null) return null;

  const expansion = expandSeries(event, zonePort, window.fromMs, window.toMs);
  if (expansion.reason !== null) return null;

  const occurrences = expansion.occurrences;
  const affected: Occurrence[] = occurrences.filter((occurrence) => {
    if (scope === 'all') return true;
    if (scope === 'this') return occurrence.localDate === anchorDate;
    return occurrence.startMs >= occurrenceStartMs;
  });
  const affectedDates = affected.map((occurrence) => occurrence.localDate);
  const affectedSet = new Set(affectedDates);
  const untouchedDates = occurrences
    .filter((occurrence) => !affectedSet.has(occurrence.localDate))
    .map((occurrence) => occurrence.localDate);

  return {
    scope,
    scopeLabel: EDIT_SCOPE_LABELS[scope],
    plan,
    affectedLocalDates: affectedDates,
    untouchedLocalDates: untouchedDates,
    wholeSeries: scope === 'all',
    degenerate: event.recurrence === null,
    signature: scopePlanSignature(plan),
  };
}

export interface ScopedDeletePlan extends ScopedChangePlan {
  /** 删除策略的可复核描述（不同范围**策略不同**）。 */
  readonly deleteStrategy: string;
}

/**
 * 规划一次"按范围删除"（CAL-05 的删除分支）。
 *
 * 与编辑共用受影响集合的计算，但**删除策略文本不同**：
 * `this` ⇒ 把该次加入 EXDATE；`following` ⇒ 截断（设 UNTIL）；`all` ⇒ 删父系列行。
 */
export function planScopedDelete(
  event: CalendarEvent,
  scope: EditScope,
  occurrenceStartMs: number,
  zonePort: ZonePort,
  window: ScopeWindow,
): ScopedDeletePlan | null {
  const change = planScopedEdit(event, scope, occurrenceStartMs, zonePort, window);
  if (change === null) return null;
  const strategy =
    scope === 'this'
      ? '平台侧：把该次本地日期加入 EXDATE（或删对应的例外行）。'
      : scope === 'following'
        ? '平台侧：给原系列设 UNTIL = 分叉点前一日（**截断**），后续实例不再生成。'
        : '平台侧：删除父系列行，全部实例随之消失。';
  return { ...change, deleteStrategy: strategy };
}

/**
 * 自检：三种范围的**受影响集合两两不同**。
 *
 * 返回问题清单（空 = 通过）。这是"不误改整组"的**运行时**兜底——除用例断言外，
 * 宿主也可在动手前调用一次。
 */
export function checkScopeIsolation(plans: readonly ScopedChangePlan[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Map<string, EditScope>();
  for (const plan of plans) {
    if (plan.degenerate) continue;
    const key = `${plan.signature}|${plan.affectedLocalDates.join(',')}`;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== plan.scope) {
      problems.push(`范围「${previous}」与「${plan.scope}」的影响集合完全相同：可能误改整组`);
    }
    seen.set(key, plan.scope);
  }
  const all = plans.find((plan) => plan.scope === 'all');
  if (all !== undefined && !all.wholeSeries) {
    problems.push('范围「all」未标记 wholeSeries=true');
  }
  const single = plans.find((plan) => plan.scope === 'this');
  if (single !== undefined && !single.degenerate && single.affectedLocalDates.length !== 1) {
    problems.push(`范围「this」影响的实例数应为 1，实际 ${String(single.affectedLocalDates.length)}`);
  }
  return problems;
}
