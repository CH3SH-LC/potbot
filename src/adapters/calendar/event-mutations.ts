/**
 * CAL-06 / CAL-07：**修改、改期、复制、取消/删除**既有日程（绑定**真实 eventId 与版本**，
 * **失败保留原记录**），以及**参与者资料 / 状态 / 备注**的变更
 * （**保存参与者 ≠ 已发邀请**）。
 *
 * ## 相对既有 `handoff.ts` 补的是什么
 *
 * - `handoff.planEventUpdate` / `planEventDelete` / `planEventCopy` 是**纯规划**；本模块把
 *   规划接到一个**变更端口**上，形成"绑定 → 规划 → 执行 → 读回"的闭环，并把
 *   **失败保留原记录**做成**结构性**结论：任何非成功分支都返回原记录，
 *   `next` 恒为 null，本地副本**从不**被就地改写。
 * - CAL-06 要求"绑定**真实** eventId 与版本"。{@link bindEvent} 拒绝占位 id（`draft:` /
 *   `new:` / 空串）与非法版本；{@link bindFromProvider} 更严格——**必须读得回**才算绑定，
 *   因此"凭空编一个 id 去改"在接口上就走不通。
 *
 * ## CAL-07：**保存参与者不等于发了邀请**
 *
 * 平台层面 `CalendarContract.Attendees` 的文档**未声明**插入 Attendee 行会发送邀请，
 * 故 {@link attendeeDeclaration} **固定** `invitationSent: false`（复用
 * `handoff.declareAttendeeSave`，不另造一份）。参与者"已保存"只能报 `submitted`。
 *
 * ## 如实声明（不得编造）
 *
 * - 变更端口的真实 provider 行为**未验证（需真机）**；本模块只保证**端口语义**正确。
 * - 取消"某一次"用 EXDATE、取消"后续"用 UNTIL 截断——**平台是否接受该组合需真机核对**；
 *   若与 `count` 冲突，本模块**如实报失败**而非偷偷改写规则。
 *
 * ## 交付说明
 *
 * 子智能体模型身份**未确认为 DS**；本文件为在 `fa/calendar-core` 工作树内**新增**。
 */

import { assertTransition, type ActionState } from '../clock/action-contract.js';
import { civilFromDays, daysFromCivil, epochToWall, parseDate } from '../clock/civil.js';
import type { ZonePort } from '../clock/zone.js';
import { eventDurationMs, validateEvent } from './event.js';
import {
  declareAttendeeSave,
  planEventCopy,
  planEventUpdate,
  type AttendeeSaveDeclaration,
  type MutationPlan,
} from './handoff.js';
import { localDateAt, planScopedDelete } from './recurrence.js';
import type {
  Attendee,
  AttendeeStatus,
  CalendarEvent,
  EditScope,
  EventTime,
  RecurrenceRule,
} from './types.js';

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// CAL-06：绑定真实 eventId 与版本
// ---------------------------------------------------------------------------

export interface EventBinding {
  readonly eventId: string;
  readonly revision: number;
}

export type BindResult =
  | { readonly ok: true; readonly binding: EventBinding }
  | { readonly ok: false; readonly reason: string };

/** 本地占位 id 前缀：这些**不是** provider 分配的 eventId，不得用来改线上记录。 */
const PLACEHOLDER_PREFIXES = ['draft:', 'new:', 'local:', 'tmp:'] as const;

/**
 * 绑定一条**既有**事件的 eventId 与版本。
 *
 * 拒绝：空 id / 占位前缀 id / 非 ≥1 整数版本。通过则给出稳定绑定。
 */
export function bindEvent(event: CalendarEvent): BindResult {
  const id = event.id.trim();
  if (id === '') return { ok: false, reason: '未绑定 eventId：不得对"没有 id"的事件发起修改' };
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (id.startsWith(prefix)) {
      return {
        ok: false,
        reason: `eventId「${id}」是本地占位（${prefix}…），不是 provider 分配的真实 id：不得据此改动`,
      };
    }
  }
  if (!Number.isInteger(event.revision) || event.revision < 1) {
    return { ok: false, reason: `版本非法（须为 ≥1 的整数）：${String(event.revision)}` };
  }
  return { ok: true, binding: { eventId: id, revision: event.revision } };
}

// ---------------------------------------------------------------------------
// CAL-06：变更端口与结果
// ---------------------------------------------------------------------------

export type MutationPortOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: string; readonly observed: CalendarEvent | null };

/** 既有日程的变更端口（由宿主 / Android 侧装配）。 */
export interface CalendarMutationPort {
  /** 读回事件；不存在返回 null。 */
  readEvent(eventId: string): Promise<CalendarEvent | null>;
  /** 按 `expectedRevision` 做乐观并发写；版本不符必须失败。 */
  updateEvent(eventId: string, next: CalendarEvent, expectedRevision: number): Promise<MutationPortOutcome>;
  deleteEvent(eventId: string, expectedRevision: number): Promise<MutationPortOutcome>;
}

export interface MutationResult {
  readonly ok: boolean;
  /** 成功后的新事件（读回值）；失败为 null。 */
  readonly next: CalendarEvent | null;
  /** 失败/未定时**未被改动**的原记录（本地副本原样返回）；成功为 null。 */
  readonly preserved: CalendarEvent | null;
  readonly state: ActionState;
  readonly reason: string | null;
  readonly notes: readonly string[];
}

function preserve(current: CalendarEvent, state: ActionState, reason: string, notes: readonly string[] = []): MutationResult {
  return { ok: false, next: null, preserved: current, state, reason, notes };
}

export type BindFromProviderResult =
  | { readonly ok: true; readonly binding: EventBinding; readonly event: CalendarEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * **从 provider 读回**再绑定（CAL-06 的严格口径）。
 *
 * 读不回 ⇒ 不能绑定：既不能改，也不能删——"改一条不存在的事件"只能报未找到。
 */
export async function bindFromProvider(
  port: CalendarMutationPort,
  eventId: string,
): Promise<BindFromProviderResult> {
  const event = await port.readEvent(eventId);
  if (event === null) {
    return { ok: false, reason: `provider 中读不到事件，无法绑定：${eventId}（不得凭本地副本改线上记录）` };
  }
  const binding = bindEvent(event);
  if (!binding.ok) return { ok: false, reason: binding.reason };
  return { ok: true, binding: binding.binding, event };
}

/**
 * 核心变更：绑定校验 → 乐观并发写 → **读回核对**。
 *
 * 任何一步不过 ⇒ 返回 `preserved = current`（**原记录保留**），本地副本不被改写。
 * 只有读回一致才 `confirmed`（回执为 `readback`，构造经 `assertTransition` 校验）。
 */
export async function applyMutation(
  port: CalendarMutationPort,
  current: CalendarEvent,
  next: CalendarEvent,
  expectedRevision: number,
  zonePort: ZonePort,
): Promise<MutationResult> {
  const binding = bindEvent(current);
  if (!binding.ok) return preserve(current, 'failed', binding.reason);

  if (current.revision !== expectedRevision) {
    return preserve(
      current,
      'failed',
      `版本冲突：期望 ${String(expectedRevision)}，当前 ${String(current.revision)}（原记录保留）`,
    );
  }
  if (next.id !== current.id) {
    return preserve(current, 'failed', `变更不得换 id：${current.id} → ${next.id}（换 id 属复制，不是修改）`);
  }

  const validation = validateEvent(next, zonePort);
  if (!validation.ok) {
    return preserve(current, 'failed', `变更后事件不自洽：${validation.problems.join('；')}`);
  }

  const written = await port.updateEvent(current.id, next, expectedRevision);
  if (!written.ok) {
    return preserve(current, 'failed', written.reason, [
      '写入未成功 ⇒ 原记录保留，本地与远端都不改写（CAL-06）。',
    ]);
  }

  assertTransition('prepared', 'submitted', {
    receipt: {
      kind: 'acknowledgement',
      source: 'calendar_provider',
      detail: `更新已受理，revision=${String(written.revision)}`,
    },
  });

  const readBack = await port.readEvent(current.id);
  if (readBack === null) {
    assertTransition('submitted', 'unknown');
    return preserve(current, 'unknown', `更新已受理但**读不回** ${current.id}：只能报"结果未知"`, [
      '不得把"受理"当"完成"；原记录保留，等待后续回读（R246）。',
    ]);
  }

  const mismatch = compareEssentials(next, readBack);
  if (mismatch.length > 0) {
    return preserve(current, 'unknown', `读回与意图不一致：${mismatch.join('；')}`, [
      '读回不一致 ⇒ 结果未知，不当作修改成功；原记录保留。',
    ]);
  }

  const confirmed = assertTransition('submitted', 'confirmed', {
    receipt: {
      kind: 'readback',
      source: 'calendar_provider',
      detail: `已读回 ${current.id}`,
      observed: {
        eventId: readBack.id,
        revision: String(readBack.revision),
        title: readBack.title,
      },
    },
  });

  return {
    ok: true,
    next: readBack,
    preserved: null,
    state: confirmed.to,
    reason: null,
    notes: [],
  };
}

function compareEssentials(intent: CalendarEvent, observed: CalendarEvent): readonly string[] {
  const diffs: string[] = [];
  if (intent.title !== observed.title) diffs.push(`标题「${intent.title}」≠「${observed.title}」`);
  if (intent.calendarId !== observed.calendarId) diffs.push('日历不一致');
  if (observed.revision < intent.revision) {
    diffs.push(`读回版本 ${String(observed.revision)} 落后于意图 ${String(intent.revision)}`);
  }
  return diffs;
}

/** 修改（标题/时间/地点/描述/参与者）：规划复用 `handoff.planEventUpdate`，再走 {@link applyMutation}。 */
export async function applyUpdate(
  port: CalendarMutationPort,
  current: CalendarEvent,
  patch: Parameters<typeof planEventUpdate>[1],
  expectedRevision: number,
  zonePort: ZonePort,
): Promise<MutationResult> {
  const planned: MutationPlan = planEventUpdate(current, patch, expectedRevision, zonePort);
  if (!planned.ok || planned.next === null) {
    return preserve(current, 'failed', planned.reason ?? '规划失败', ['规划即失败 ⇒ 原记录未被触碰。']);
  }
  return applyMutation(port, current, planned.next, expectedRevision, zonePort);
}

// ---------------------------------------------------------------------------
// CAL-06：改期 / 复制
// ---------------------------------------------------------------------------

/**
 * 改期：把事件平移到新起点。
 *
 * - **定时**：保持**时长不变**（`endMs − startMs`），只换 `startMs`。
 * - **全天**：按**自然日整数平移**（用 `startMs` 在事件时区的本地日与目标日的差）。
 *
 * 时区未知或时长不可得 ⇒ null（不猜）。
 */
export function rescheduleEvent(
  current: CalendarEvent,
  newStartMs: number,
  zonePort: ZonePort,
): EventTime | null {
  if (current.time.kind === 'timed') {
    const duration = eventDurationMs(current.time, zonePort);
    if (duration === null || duration <= 0) return null;
    return { ...current.time, startMs: newStartMs, endMs: newStartMs + duration };
  }
  const offset = zonePort.offsetMinutesAt(current.time.zoneId, newStartMs);
  if (offset === null) return null;
  const start = parseDate(current.time.startDate);
  const end = parseDate(current.time.endDateExclusive);
  if (start === null || end === null) return null;
  const targetDay = Math.floor((newStartMs + offset * 60_000) / MS_PER_DAY);
  const baseDay = daysFromCivil(start.year, start.month, start.day);
  const delta = targetDay - baseDay;
  const shiftedStart = civilFromDays(daysFromCivil(start.year, start.month, start.day) + delta);
  const shiftedEnd = civilFromDays(daysFromCivil(end.year, end.month, end.day) + delta);
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return {
    ...current.time,
    startDate: `${pad(shiftedStart.year, 4)}-${pad(shiftedStart.month, 2)}-${pad(shiftedStart.day, 2)}`,
    endDateExclusive: `${pad(shiftedEnd.year, 4)}-${pad(shiftedEnd.month, 2)}-${pad(shiftedEnd.day, 2)}`,
  };
}

/** 展示用：某时刻在事件时区的墙上时刻（失败返回 null）。 */
export function wallAt(zonePort: ZonePort, zoneId: string, instantMs: number) {
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  if (offset === null) return null;
  return epochToWall(instantMs, offset);
}

/** 复制：**必须换新 id**（复用 `handoff.planEventCopy`；沿用同 id 会互相覆盖）。 */
export function copyEvent(current: CalendarEvent, newId: string): CalendarEvent {
  return planEventCopy(current, newId);
}

// ---------------------------------------------------------------------------
// CAL-06：取消 / 删除（按范围）
// ---------------------------------------------------------------------------

export interface CancelPlan {
  readonly ok: boolean;
  readonly scope: EditScope;
  /** 变更后的定义（`all` 时为 null——整组删除没有"下一条定义"）。 */
  readonly next: CalendarEvent | null;
  readonly reason: string | null;
  readonly strategy: string;
}

/** 规划"按范围取消/删除"：`this` ⇒ 加 EXDATE；`following` ⇒ 设 UNTIL 截断；`all` ⇒ 删整组。 */
export function planCancel(
  current: CalendarEvent,
  scope: EditScope,
  occurrenceStartMs: number,
  zonePort: ZonePort,
  window: { readonly fromMs: number; readonly toMs: number },
): CancelPlan {
  if (scope === 'all') {
    return {
      ok: true,
      scope,
      next: null,
      reason: null,
      strategy: 'delete_whole_series：删除父系列行，全部实例随之消失。',
    };
  }
  if (current.recurrence === null) {
    return {
      ok: false,
      scope,
      next: null,
      reason: '事件不重复：不存在"某一次 / 后续"的区分，只能整条取消（scope=all）',
      strategy: 'degenerate：非重复事件按 this/following 取消没有平台语义。',
    };
  }

  const localDate = localDateAt(zonePort, current.time.zoneId, occurrenceStartMs);
  if (localDate === null) {
    return { ok: false, scope, next: null, reason: `事件时区未知：${current.time.zoneId}`, strategy: '' };
  }

  if (scope === 'this') {
    const exdates = [...(current.recurrence.exdates ?? []), localDate];
    const rule: RecurrenceRule = { ...current.recurrence, exdates };
    return finishCancel(current, scope, rule, zonePort, `把 ${localDate} 加入 EXDATE（仅取消该次）`);
  }

  const scoped = planScopedDelete(current, 'following', occurrenceStartMs, zonePort, window);
  if (scoped === null || scoped.plan.kind !== 'split_series') {
    return { ok: false, scope, next: null, reason: '无法计算"后续"的截断点', strategy: '' };
  }
  const rule: RecurrenceRule = { ...current.recurrence, untilDate: scoped.plan.headUntilLocalDate };
  return finishCancel(
    current,
    scope,
    rule,
    zonePort,
    `原系列设 UNTIL=${scoped.plan.headUntilLocalDate} 截断（自 ${localDate} 起不再生成）`,
  );
}

function finishCancel(
  current: CalendarEvent,
  scope: EditScope,
  rule: RecurrenceRule,
  zonePort: ZonePort,
  strategy: string,
): CancelPlan {
  const next: CalendarEvent = { ...current, recurrence: rule, revision: current.revision + 1 };
  const validation = validateEvent(next, zonePort);
  if (!validation.ok) {
    return {
      ok: false,
      scope,
      next: null,
      reason: `取消后的重复规则不自洽：${validation.problems.join('；')}（原规则保留，不偷偷改写）`,
      strategy,
    };
  }
  return { ok: true, scope, next, reason: null, strategy };
}

/** 执行一次取消/删除（绑定真实 id 与版本；失败保留原记录）。 */
export async function applyCancel(
  port: CalendarMutationPort,
  current: CalendarEvent,
  scope: EditScope,
  occurrenceStartMs: number,
  expectedRevision: number,
  zonePort: ZonePort,
  window: { readonly fromMs: number; readonly toMs: number },
): Promise<MutationResult> {
  const binding = bindEvent(current);
  if (!binding.ok) return preserve(current, 'failed', binding.reason);

  const plan = planCancel(current, scope, occurrenceStartMs, zonePort, window);

  if (scope === 'all') {
    if (current.revision !== expectedRevision) {
      return preserve(current, 'failed', `版本冲突：期望 ${String(expectedRevision)}，当前 ${String(current.revision)}`, [
        '删除前必须版本匹配：原记录保留。',
      ]);
    }
    const deleted = await port.deleteEvent(current.id, expectedRevision);
    if (!deleted.ok) {
      return preserve(current, 'failed', deleted.reason, ['删除未成功 ⇒ 原记录保留（CAL-06）。']);
    }
    assertTransition('submitted', 'confirmed', {
      receipt: {
        kind: 'readback',
        source: 'calendar_provider',
        detail: `已确认 ${current.id} 不可再读回（删除读回）`,
        observed: { eventId: current.id, deleted: 'true' },
      },
    });
    const after = await port.readEvent(current.id);
    if (after !== null) {
      return preserve(current, 'unknown', `删除已受理但事件仍可读回 ${current.id}：结果未知`, [
        '不得把"删除受理"当"已删除"；原记录保留待复核。',
      ]);
    }
    return { ok: true, next: null, preserved: null, state: 'confirmed', reason: null, notes: [] };
  }

  if (!plan.ok || plan.next === null) {
    return preserve(current, 'failed', plan.reason ?? '取消规划失败', [plan.strategy]);
  }
  const result = await applyMutation(port, current, plan.next, expectedRevision, zonePort);
  return { ...result, notes: [...result.notes, plan.strategy] };
}

// ---------------------------------------------------------------------------
// CAL-07：参与者（资料 / 状态 / 备注）
// ---------------------------------------------------------------------------

export type AttendeeOp =
  | { readonly kind: 'add'; readonly attendee: Attendee }
  | { readonly kind: 'remove'; readonly email: string }
  | { readonly kind: 'setStatus'; readonly email: string; readonly status: AttendeeStatus }
  | { readonly kind: 'setNote'; readonly email: string; readonly note: string | null };

export interface AttendeePlan {
  readonly ok: boolean;
  readonly attendees: readonly Attendee[];
  readonly problems: readonly string[];
}

function isEmailShaped(email: string): boolean {
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1 && !trimmed.includes(' ');
}

/** 规划参与者变更（CAL-07：资料/状态/备注）。失败 ⇒ 返回**原集合**。 */
export function planAttendees(current: readonly Attendee[], ops: readonly AttendeeOp[]): AttendeePlan {
  let list: Attendee[] = [...current];
  const problems: string[] = [];

  for (const op of ops) {
    if (op.kind === 'add') {
      if (!isEmailShaped(op.attendee.email)) {
        problems.push(`参与者邮箱格式非法：${op.attendee.email}`);
        continue;
      }
      if (list.some((entry) => entry.email === op.attendee.email)) {
        problems.push(`参与者已存在（不重复添加）：${op.attendee.email}`);
        continue;
      }
      list = [...list, op.attendee];
      continue;
    }

    const index = list.findIndex((entry) => entry.email === op.email);
    if (index < 0) {
      problems.push(`参与者不存在：${op.email}`);
      continue;
    }
    if (op.kind === 'remove') {
      list = list.filter((entry) => entry.email !== op.email);
      continue;
    }
    const target = list[index] as Attendee;
    list = list.map((entry, position) =>
      position === index
        ? op.kind === 'setStatus'
          ? { ...target, status: op.status }
          : { ...target, note: op.note }
        : entry,
    );
  }

  if (problems.length > 0) return { ok: false, attendees: current, problems };
  return { ok: true, attendees: list, problems: [] };
}

/**
 * CAL-07 的如实声明：保存参与者**不代表已发邀请**（恒 `invitationSent: false`）。
 *
 * 直接复用 `handoff.declareAttendeeSave`，**不另造**一份声明——避免两处口径漂移。
 */
export function attendeeDeclaration(attendeeCount: number): AttendeeSaveDeclaration {
  return declareAttendeeSave(attendeeCount);
}
