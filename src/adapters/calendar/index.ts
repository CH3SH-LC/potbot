/**
 * FA-M 日历适配器 —— **产品可调用入口**（CAL-01–10）。
 *
 * ⚠️ 边界（与 clock / research 同口径）：只实现合同已冻结的语义；不做任何 Android 代码；
 * 跨层缺口写进 `outputs/FA-M/interface-declaration.md`。
 *
 * ⚠️ **两条写路径的上限不同**（CAL-09）：`createEventDirect`（授权直写，读回一致才算完成）
 * 与 `openCalendarEditor`（打开编辑页，**最高只能报"已交接"**）。
 */

import { createEventLinkIndex, type EventLinkIndex } from './links.js';
import { computeBusy, findConflicts, queryEvents, type QueryOptions, type QueryResult } from './conflict.js';
import { expandRecurrence, planScopeEdit, type ExpansionResult, type ScopePlan } from './recur.js';
import { eventRange, validateEvent, type EventValidation, type InstantRange } from './event.js';
import {
  createEventDirect,
  openCalendarEditor,
  checkCalendarAccess,
  planEventCopy,
  planEventDelete,
  planEventUpdate,
  declareAttendeeSave,
  validateReminders,
  type CalendarAccess,
  type CalendarEditorPort,
  type CalendarWritePort,
  type CalendarWriteResult,
  type MutationPlan,
} from './handoff.js';
import { calendarReadinessReport, type CalendarNotReadyCapability } from './not-ready.js';
import type { SubitemReadiness } from '../clock/readiness.js';
import type { ZonePort } from '../clock/zone.js';
import type { CalendarEvent, EditScope, EventTime, RecurrenceRule } from './types.js';

export interface CalendarAdapterOptions {
  readonly zonePort: ZonePort;
  /** 授权面（由宿主在拿到运行时权限后提供）。 */
  readonly access: CalendarAccess;
  /** 授权直写端口；未装配时直写会**抛出**（不静默假装成功）。 */
  readonly writer?: CalendarWritePort;
  /** 打开系统编辑页端口；未装配时交接会**抛出**。 */
  readonly editor?: CalendarEditorPort;
}

export interface CalendarAdapter {
  readonly access: CalendarAccess;
  readonly links: EventLinkIndex;
  validate(event: CalendarEvent): EventValidation;
  rangeOf(time: EventTime): InstantRange | null;
  query(events: readonly CalendarEvent[], options: QueryOptions): QueryResult;
  busy(events: readonly CalendarEvent[]): ReturnType<typeof computeBusy>;
  conflicts(target: CalendarEvent, existing: readonly CalendarEvent[]): ReturnType<typeof findConflicts>;
  expand(
    time: EventTime,
    rule: RecurrenceRule,
    fromMs: number,
    toMs: number,
  ): ExpansionResult;
  planScope(
    time: EventTime,
    scope: EditScope,
    occurrenceStartMs: number,
  ): ScopePlan | null;
  planUpdate(
    current: CalendarEvent,
    patch: Parameters<typeof planEventUpdate>[1],
    expectedRevision: number,
  ): MutationPlan;
  planDelete(current: CalendarEvent, expectedRevision: number): MutationPlan;
  copy(current: CalendarEvent, newId: string): CalendarEvent;
  createDirect(event: CalendarEvent): Promise<CalendarWriteResult>;
  openEditor(event: CalendarEvent): Promise<CalendarWriteResult>;
  attendeeDeclaration(count: number): ReturnType<typeof declareAttendeeSave>;
  validateReminders: typeof validateReminders;
  checkAccess: typeof checkCalendarAccess;
  readiness(): {
    readonly subitems: readonly SubitemReadiness[];
    readonly capabilities: readonly CalendarNotReadyCapability[];
  };
}

export function createCalendarAdapter(options: CalendarAdapterOptions): CalendarAdapter {
  const { zonePort } = options;

  return {
    access: options.access,
    links: createEventLinkIndex(),

    validate(event) {
      return validateEvent(event, zonePort);
    },
    rangeOf(time) {
      return eventRange(time, zonePort);
    },
    query(events, queryOptions) {
      return queryEvents(events, zonePort, queryOptions);
    },
    busy(events) {
      return computeBusy(events, zonePort);
    },
    conflicts(target, existing) {
      return findConflicts(target, existing, zonePort);
    },
    expand(time, rule, fromMs, toMs) {
      return expandRecurrence(time, rule, zonePort, fromMs, toMs);
    },
    planScope(time, scope, occurrenceStartMs) {
      return planScopeEdit(time, scope, occurrenceStartMs, zonePort);
    },
    planUpdate(current, patch, expectedRevision) {
      return planEventUpdate(current, patch, expectedRevision, zonePort);
    },
    planDelete(current, expectedRevision) {
      return planEventDelete(current, expectedRevision);
    },
    copy(current, newId) {
      return planEventCopy(current, newId);
    },

    async createDirect(event) {
      if (options.writer === undefined) {
        throw new Error(
          '未装配日历直写端口（CalendarWritePort）：本批不调用平台 provider（apps/android 归 A 负责人）。' +
            '不得在没有端口的情况下假装已写入。',
        );
      }
      return createEventDirect(options.writer, options.access, event, zonePort);
    },

    async openEditor(event) {
      if (options.editor === undefined) {
        throw new Error('未装配日历编辑页端口（CalendarEditorPort）：不能假装已交接。');
      }
      return openCalendarEditor(options.editor, event);
    },

    attendeeDeclaration: declareAttendeeSave,
    validateReminders,
    checkAccess: checkCalendarAccess,

    readiness() {
      return calendarReadinessReport();
    },
  };
}

export { createEventLinkIndex } from './links.js';
export { queryEvents, computeBusy, findConflicts, overlaps } from './conflict.js';
export { expandRecurrence, planScopeEdit, scopePlanSignature } from './recur.js';
export { allDayRange, eventRange, eventDurationMs, validateEvent, validateRecurrenceShape } from './event.js';
export {
  createEventDirect,
  openCalendarEditor,
  checkCalendarAccess,
  planEventUpdate,
  planEventDelete,
  planEventCopy,
  declareAttendeeSave,
  validateReminders,
} from './handoff.js';
export { CALENDAR_SUBITEMS, CALENDAR_NOT_READY, calendarReadinessReport } from './not-ready.js';
export { EDIT_SCOPE_LABELS } from './types.js';

export type { CalendarEvent, EventTime, RecurrenceRule, EditScope, Attendee, AttendeeStatus } from './types.js';
export type { QueryOptions, QueryResult, ConflictReport, BusyResult } from './conflict.js';
export type { ExpansionResult, Occurrence, ScopePlan } from './recur.js';
export type {
  CalendarAccess,
  CalendarInfo,
  CalendarPermission,
  CalendarWritePort,
  CalendarEditorPort,
  CalendarWriteResult,
} from './handoff.js';
export type { EventLinkIndex, EventFactLink, FactChangeOutcome } from './links.js';
export type { InstantRange, EventValidation } from './event.js';
