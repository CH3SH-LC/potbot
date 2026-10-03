/**
 * FA-M 时钟适配器 —— **产品可调用入口**（CLK-01–10）。
 *
 * ⚠️ 边界（与 FA-G2 同口径）：本文件**不是**共用合同层，只实现合同已冻结的语义；
 * 跨层缺口写进 `outputs/FA-M/interface-declaration.md` 由总协调定夺。
 *
 * ⚠️ **不做**：不实现任何 Android 代码（`apps/android/**` 归 A 负责人）；
 * 本包只提供**给 A 的接口需求**与**不含设备即可验证的纯逻辑**。
 *
 * ⚠️ **自管 ≠ 系统闹钟**（CLK-10）：{@link ClockAdapter.store} 只含 potbot 自管提醒；
 * 系统侧只能经 {@link ClockAdapter.handoffSystemAction} 报告交接，**不能**回读、**不能**冒充。
 */

import { createAlarmStore, type AlarmStore, type AlarmStoreOptions } from './alarm-store.js';
import { clockReadinessReport, type ClockNotReadyCapability } from './not-ready.js';
import {
  handoffSystemClockAction,
  listSystemAlarms,
  type ClockIntentPort,
  type SystemAlarmListResult,
  type SystemAlarmReadPort,
  type SystemClockAction,
  type SystemHandoffResult,
} from './handoff.js';
import type { SubitemReadiness } from './readiness.js';
import { createStopwatch, type StopwatchState } from './stopwatch.js';
import { createTimer, type TimerState } from './timer.js';
import { parseNaturalTime, type TimeParseResult } from './time-parse.js';
import { readWorldClock, type WorldClockResult, type ZonePort } from './zone.js';

export interface ClockAdapterOptions {
  readonly zonePort: ZonePort;
  /** 解析"今天/明天"这类相对日期时使用的默认时区（用户所在时区）。 */
  readonly defaultZoneId: string;
  /** 自管提醒的宿主端口（id 来源、初始快照）。 */
  readonly store?: Omit<AlarmStoreOptions, 'zonePort'>;
  /** 系统时钟交接端口；**未装配时**交接调用会抛出（不静默假装成功）。 */
  readonly intents?: ClockIntentPort;
  /** 系统闹钟读取端口；**默认没有**（见 not-ready 的 cap.clock.system_alarm_read）。 */
  readonly systemAlarmRead?: SystemAlarmReadPort | null;
}

export interface ClockAdapter {
  /** 自管提醒仓库（**只**含自管对象）。 */
  readonly store: AlarmStore;
  parseTime(text: string, nowMs: number, zoneId?: string): TimeParseResult;
  worldClock(zoneIds: readonly string[], atMs: number): WorldClockResult;
  createTimer(id: string, label: string, durationMs: number): TimerState;
  createStopwatch(id: string): StopwatchState;
  handoffSystemAction(
    action: SystemClockAction,
    params: Readonly<Record<string, string | number>>,
  ): Promise<SystemHandoffResult>;
  listSystemAlarms(): Promise<SystemAlarmListResult>;
  /** 逐子项就绪度 + 能力级未就绪清单。 */
  readiness(): {
    readonly subitems: readonly SubitemReadiness[];
    readonly capabilities: readonly ClockNotReadyCapability[];
  };
}

export function createClockAdapter(options: ClockAdapterOptions): ClockAdapter {
  const store = createAlarmStore({ ...options.store, zonePort: options.zonePort });

  return {
    store,

    parseTime(text, nowMs, zoneId) {
      return parseNaturalTime(text, {
        nowMs,
        zoneId: zoneId ?? options.defaultZoneId,
        zonePort: options.zonePort,
      });
    },

    worldClock(zoneIds, atMs) {
      return readWorldClock(options.zonePort, zoneIds, atMs);
    },

    createTimer,
    createStopwatch,

    async handoffSystemAction(action, params) {
      if (options.intents === undefined) {
        throw new Error(
          '未装配系统时钟交接端口（ClockIntentPort）：本批不实现 Android Intent 调用（apps/android 归 A 负责人）。' +
            '不得在没有端口的情况下假装已交接。',
        );
      }
      return handoffSystemClockAction(options.intents, action, params);
    },

    listSystemAlarms() {
      return listSystemAlarms(options.systemAlarmRead ?? null);
    },

    readiness() {
      return clockReadinessReport();
    },
  };
}

export { createAlarmStore } from './alarm-store.js';
export {
  createActionLedger,
  assertTransition,
  ACTION_STATES,
  ACTION_STATE_LABELS,
} from './action-contract.js';
export {
  handoffSystemClockAction,
  listSystemAlarms,
  selectAlarmTarget,
  SYSTEM_ACTION_SEMANTICS,
  actionsThatDeleteAlarms,
} from './handoff.js';
export { createTimer } from './timer.js';
export { createStopwatch } from './stopwatch.js';
export { createFixedZonePort, createIntlZonePort } from './zone.js';
export { parseNaturalTime } from './time-parse.js';
export { CLOCK_SUBITEMS, CLOCK_NOT_READY, clockReadinessReport } from './not-ready.js';
export { countVerdicts, VERDICT_LABELS } from './readiness.js';

export type { AlarmRecord, AlarmDraft, RepeatRule, Weekday, AlarmOwnership, AlarmOccurrence } from './types.js';
export type {
  AlarmStore,
  AlarmStoreOptions,
  AlarmSummary,
  AlarmPatch,
  AlarmMutationResult,
  AlarmCreateResult,
} from './alarm-store.js';
export type {
  ActionState,
  ActionReceipt,
  ToolContract,
  ActionLedger,
  ActionLedgerEntry,
  ReceiptKind,
  SideEffect,
} from './action-contract.js';
export type {
  ClockIntentPort,
  SystemHandoffResult,
  SystemClockAction,
  SystemAlarmReadPort,
  SystemAlarmRef,
  SystemAlarmListResult,
} from './handoff.js';
export type { TimeParseResult, TimeCandidate } from './time-parse.js';
export type { ZonePort, WorldClockReading, WorldClockResult } from './zone.js';
export type { CapabilityState, SubitemReadiness, ReadinessVerdict } from './readiness.js';
export type { TimerState, StopwatchState };

// ---------------------------------------------------------------------------
// FA-WIRE-ADAPTERS-REACH：补齐 `reminder-restore.ts`（CLK-07）的 barrel 导出
// ---------------------------------------------------------------------------
//
// 最终普查点名：本模块此前只在包内测试里被引用，barrel 未 re-export ⇒ 产品侧不可达。
// **只做加法**：不改、不删任何既有导出。消费点见
// `apps/demo/server/adapters-extra-routes.ts` 的 `/api/adapters/extra/clock/reminder`。

export {
  RESTORE_SNAPSHOT_VERSION,
  captureSnapshot,
  restoreStore,
  rebaseOnZoneOrTimeChange,
  inspectPreciseReminderStatus,
  planNextTrigger,
  assertAbsoluteScheduling,
  describeSchedulingDiscipline,
} from './reminder-restore.js';
export type {
  RestoreSnapshot,
  RestoreProblemKind,
  RestoreProblem,
  RestoreReport,
  RestoreOptions,
  RebaseReport,
  PermissionState,
  PreciseReminderInput,
  PreciseReminderStatus,
  SchedulePlan,
} from './reminder-restore.js';
