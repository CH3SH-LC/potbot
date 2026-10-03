/**
 * **时钟 / 日历自管能力的会话接入口**（工作包 FA-CAL-CLOCK-PRODUCT）。
 *
 * ## 为什么它和 `./xlsx.ts` **同形**
 *
 * `xlsx.ts` 把 `src/spreadsheets/**` 接进通用交付会话，靠的是四条约定：
 *
 * 1. **封闭的操作枚举**（`XlsxEdit`）——产品入口只认这份有限词汇，不认"任意 JSON"；
 * 2. **结构化结果**（`AdapterEditResult<S>`：`{ok:true,…} | {ok:false,kind,detail}`），
 *    底层纯函数以抛错表达形状问题，**绝不让异常穿出会话层**；
 * 3. **一个冻结的单例适配器**（`xlsxDeliverableAdapter`），把"怎么描述 / 怎么改"收进一处；
 * 4. **只转发，不另造协议**——取值形状、语义表全部从下层读，本层不复制字面量。
 *
 * 本文件把这四条原样搬到时钟 / 日历两个域：`ClockToolOp` / `CalendarToolOp` 是封闭枚举；
 * 成功分支与 `AdapterEditResult<S>` **逐字段同形**（并有一条编译期对照
 * {@link SameShapeAsEditResult} 把它钉住），只是多一列结构化产出 `outcome`，
 * 好让会话**不必解析人话**就能做下一步判断；`calClockToolAdapter` 是那个冻结单例。
 *
 * **唯一的不同点，如实写在最前面**：交付适配器的源（工作簿 / 演示）是**不可变数据**，
 * 编辑返回新源；而自管提醒活在**有状态的仓库**里（`AlarmStore`）——本入口返回的
 * `source` 因此是**同一个句柄**，改动落在仓库内部。本适配器**不假装**它是不可变的。
 *
 * ## 四条产品纪律（逐条都有机器化反向对照）
 *
 * | 纪律 | 落点 |
 * |---|---|
 * | **相对时间必须解析成绝对时刻并回给用户核对** | `alarm.propose` → `ScheduleProposal.absoluteMs` / `absoluteLocal`；`requiresConfirmation = true` 时**不落地** |
 * | **查询只报自管闹钟；系统闹钟恒"不可读"** | `alarm.list` 恒带 `scope:'self_managed_only'` + 免责声明；`system.alarm_list` 走 `querySystemAlarms`，**空数组 ≠ 没有闹钟** |
 * | **系统时钟交接最高只到「已交接」；`dismiss` 不是删除** | `system.handoff` 走 `dispatchClockIntent`，不可回读 ⇒ 永不 `confirmed`；语义表复用 `SYSTEM_ACTION_SEMANTICS` |
 * | **直写要读回才算完成；编辑页最高「已交接」；保存参与者 ≠ 已发邀请** | `calendar.create` 的 `path` 决定上限（画像来自 `creationPathProfile`）；`calendar.attendees` 固定 `invitationSent:false` |
 *
 * ## 未就绪 / 阻塞 / 失权（如实呈现，不编造）
 *
 * - **无设备端口** ⇒ `{ok:false, kind:'not_ready', detail:<原因>, unblockedBy:<解锁条件>}`；
 * - **平台无合法通道**（读系统全部闹钟）⇒ 结论 `blocked`，理由与解锁条件取自 `CLOCK_NOT_READY`；
 * - **授权被撤回** ⇒ 日历的每一次调用都**当场**重读 `source.access()`，因此**下一次调用即被拒**。
 *
 * ## 本文件不做 / 未验证
 *
 * - **不实现任何 Android 代码**（`apps/android/**` 归 A 负责人）：端口缺席就是缺席；
 * - **真机层未验证**：全部 provider 端口的真实行为只能在设备上核实，本文件只保证
 *   **端口语义与报告**正确（真机侧未验证，需真机）；
 * - 本文件是**纯的**：零 IO、零墙钟（`nowMs` 由调用方注入）、零随机数。
 */

import {
  CLOCK_NOT_READY,
  SYSTEM_ACTION_SEMANTICS,
  actionsThatDeleteAlarms,
  clockReadinessReport,
  countVerdicts,
  createActionLedger,
  VERDICT_LABELS,
  type ActionLedger,
  type ActionReceipt,
  type ActionState,
  type AlarmRecord,
  type AlarmStore,
  type ClockIntentPort,
  type RepeatRule,
  type StopwatchState,
  type SystemAlarmReadPort,
  type SystemAlarmRef,
  type SystemClockAction,
  type TimerState,
  type WorldClockResult,
  type ZonePort,
  type SubitemReadiness,
  type ReadinessVerdict,
} from '../../adapters/clock/index.js';
import { readWorldClock } from '../../adapters/clock/zone.js';
import type { ClockNotReadyCapability } from '../../adapters/clock/not-ready.js';
import {
  dispatchClockIntent,
  type DispatchContext,
  type DispatchRequest,
  type DispatchResult,
  type IntentPermissionState,
} from '../../adapters/clock/alarm-intent.js';
import { commitSchedule, proposeSchedule, type ScheduleProposal } from '../../adapters/clock/alarm-schedule.js';
import {
  cancelOneOccurrence,
  queryManagedAlarms,
  querySystemAlarms,
  removeManagedAlarm,
  setManagedEnabled,
  updateManagedAlarm,
  type AlarmFilter,
  type ManagedAlarmQuery,
  type MutationOutcome,
  type SystemAlarmListing,
} from '../../adapters/clock/alarm-query.js';
import { createStopwatch, totalMs as stopwatchTotalMs } from '../../adapters/clock/stopwatch.js';
import { createTimer, isDue, remainingMs } from '../../adapters/clock/timer.js';
import {
  calendarReadinessReport,
  checkCalendarAccess,
  declareAttendeeSave,
  eventDurationMs,
  openCalendarEditor,
  type CalendarAccess,
  type CalendarEditorPort,
  type CalendarEvent,
  type CalendarWritePort,
  type EditScope,
  type QueryResult,
} from '../../adapters/calendar/index.js';
import type { CalendarNotReadyCapability } from '../../adapters/calendar/not-ready.js';
import {
  directoryView,
  queryWithinAccess,
  type CalendarDirectoryView,
} from '../../adapters/calendar/calendars-and-query.js';
import {
  applyCancel,
  applyUpdate,
  type CalendarMutationPort,
  type MutationResult,
} from '../../adapters/calendar/event-mutations.js';
import { buildEvent, createEvent, type EventDraft } from '../../adapters/calendar/event-model.js';
import { planScopedEdit, type ScopedChangePlan, type ScopeWindow } from '../../adapters/calendar/recurrence.js';
import { creationPathProfile, type CreationPath } from '../../adapters/calendar/reconcile.js';
import type { AttendeeSaveDeclaration } from '../../adapters/calendar/handoff.js';
import type { AdapterEditResult } from '../adapter.js';
// I-5：本入口按源对象记忆的默认台账必须**版本敏感**——同 requestId、不同 revision
// 不是同一动作（R213）。权威推导在 workledger（`deriveClockLedgerKey`），此处只**注入**。
import { versionAwareClockLedgerOptions } from '../../workledger/action-state-alignment.js';

// ---------------------------------------------------------------------------
// 一、源与端口（全部注入；缺端口就是缺端口，不假装）
// ---------------------------------------------------------------------------

/** 与会话交互的**宿主事实**（派发系统时钟动作前必须先判断的那些条件）。 */
export interface DispatchHostFacts {
  /** 系统里是否有能处理该动作的时钟应用。 */
  readonly handlerAvailable: boolean;
  /** 权限状态（按权限 id 索引）。 */
  readonly permissions: Readonly<Record<string, IntentPermissionState>>;
  /** 可候选的系统闹钟（多候选 ⇒ 交给用户选，不替用户猜）。 */
  readonly candidates: readonly SystemAlarmRef[];
  /** 目标当前版本（与 `targetRevision` 对账）。 */
  readonly currentRevision: number | null;
  /** **已触发**的目标 id（取消这类目标必须显冲突，保留已发生事实）。 */
  readonly firedTargetIds: readonly string[];
}

/** 时钟侧端口（可缺省 ⇒ 相应操作结构化未就绪）。 */
export interface ClockToolPorts {
  /** 系统时钟交接端口；缺省 ⇒ `unverified_interface`（**不**假装交出去了）。 */
  readonly intents?: ClockIntentPort;
  /** 该端口是否来自**已验证**的接口（CLK-08「使用已验证接口」）。 */
  readonly intentsVerified?: boolean;
  /** 系统闹钟读取端口；`undefined` / `null`（产品基线）⇒ 结论**阻塞**。 */
  readonly systemAlarmRead?: SystemAlarmReadPort | null;
  readonly dispatch?: DispatchHostFacts;
  /** 动作台账；缺省时本适配器按源对象记忆一个（保证"重复点击不重复执行"跨调用生效）。 */
  readonly ledger?: ActionLedger;
}

/** 日历侧端口（可缺省 ⇒ 相应操作结构化未就绪）。 */
export interface CalendarToolPorts {
  readonly writer?: CalendarWritePort;
  readonly editor?: CalendarEditorPort;
  readonly mutation?: CalendarMutationPort;
}

/**
 * 会话持有的时钟 / 日历源。
 *
 * `access` 是一个**函数**而不是快照：授权可能在两次调用之间被用户撤回，
 * 因此每次调用都当场重读——这是"授权被撤回后下一次调用即被拒"的落点。
 */
export interface CalClockSource {
  readonly zonePort: ZonePort;
  /** 注入的"现在"（毫秒）。适配器零墙钟。 */
  readonly nowMs: number;
  /** 自管提醒仓库（**只**含自管对象）。 */
  readonly store: AlarmStore;
  readonly clockPorts: ClockToolPorts;
  readonly calendarPorts: CalendarToolPorts;
  /** 会话持有的（已授权范围内的）日程快照；真实读取需 provider（未接通）。 */
  readonly events: readonly CalendarEvent[];
  /** **每次调用**读取当前授权面。 */
  readonly access: () => CalendarAccess;
}

// ---------------------------------------------------------------------------
// 二、封闭的操作枚举（与 `XlsxEdit` 同形：只有这些，没有"任意 JSON"）
// ---------------------------------------------------------------------------

/** 自管提醒的局部补丁（形状与 `AlarmStore.update` 的 patch **同一套**）。 */
export interface AlarmPatchInput {
  readonly label?: string;
  readonly zoneId?: string;
  readonly firstTriggerMs?: number;
  readonly repeat?: RepeatRule;
}

/** 对**一次发生**（或整条）的处置。 */
export type AlarmMutationInput =
  | { readonly kind: 'update'; readonly patch: AlarmPatchInput }
  | { readonly kind: 'set_enabled'; readonly enabled: boolean }
  | { readonly kind: 'remove' }
  | { readonly kind: 'cancel_occurrence'; readonly occurrenceEpochMs: number };

/** 时钟侧操作（封闭枚举）。 */
export type ClockToolOp =
  /** 自然语言 / 绝对时刻 → 可核对的调度提案（**不落地**）。 */
  | {
      readonly op: 'alarm.propose';
      readonly label: string;
      readonly zoneId: string;
      readonly repeat: RepeatRule;
      readonly whenText?: string;
      readonly atMs?: number;
    }
  /** 把一份 `ready` 提案落地（幂等键由调用方给出）。 */
  | { readonly op: 'alarm.commit'; readonly proposal: ScheduleProposal; readonly idempotencyKey: string }
  /** 查询 / 筛选**自管**提醒（恒带作用域说明）。 */
  | { readonly op: 'alarm.list'; readonly filter?: AlarmFilter }
  | {
      readonly op: 'alarm.mutate';
      readonly id: string;
      readonly expectedRevision: number;
      readonly mutation: AlarmMutationInput;
    }
  | { readonly op: 'timer.create'; readonly id: string; readonly label: string; readonly durationMs: number }
  | { readonly op: 'stopwatch.create'; readonly id: string }
  | { readonly op: 'world_clock'; readonly zoneIds: readonly string[] }
  /** 系统时钟动作交接（最高只到「已交接」）。 */
  | {
      readonly op: 'system.handoff';
      readonly requestId: string;
      readonly action: SystemClockAction;
      readonly params: Readonly<Record<string, string | number>>;
      readonly targetRevision?: number;
      readonly confirmed?: boolean;
      readonly target?: DispatchRequest['target'];
    }
  /** 读**系统**闹钟列表（产品基线恒"不可读"）。 */
  | { readonly op: 'system.alarm_list' };

/** 日历侧操作（封闭枚举）。 */
export type CalendarToolOp =
  | { readonly op: 'calendar.directory' }
  | { readonly op: 'calendar.query'; readonly fromMs: number; readonly toMs: number; readonly keyword?: string }
  /** 建事件：`path` 决定**上限**（直写可到 confirmed，编辑页只到 handed_off）。 */
  | { readonly op: 'calendar.create'; readonly path: CreationPath; readonly draft: EventDraft }
  | {
      readonly op: 'calendar.update';
      readonly current: CalendarEvent;
      readonly patch: Partial<Pick<CalendarEvent, 'title' | 'time' | 'location' | 'description' | 'attendees'>>;
      readonly expectedRevision: number;
    }
  /** 按范围删除（`this` / `following` / `all` 语义**必须分开**）。 */
  | {
      readonly op: 'calendar.delete';
      readonly current: CalendarEvent;
      readonly scope: EditScope;
      readonly occurrenceStartMs: number;
      readonly window: ScopeWindow;
      readonly expectedRevision: number;
    }
  /** 只看计划与受影响实例集合（不写任何东西）。 */
  | {
      readonly op: 'calendar.scope_preview';
      readonly current: CalendarEvent;
      readonly scope: EditScope;
      readonly occurrenceStartMs: number;
      readonly window: ScopeWindow;
    }
  | { readonly op: 'calendar.attendees'; readonly attendeeCount: number };

export type CalClockToolOp = ClockToolOp | CalendarToolOp;

/** 支持的操作用名字集合（展示 / 自检用；与 {@link CalClockToolOp} 的判别字段同源）。 */
export const CAL_CLOCK_OPS: readonly string[] = Object.freeze([
  'alarm.propose',
  'alarm.commit',
  'alarm.list',
  'alarm.mutate',
  'timer.create',
  'stopwatch.create',
  'world_clock',
  'system.handoff',
  'system.alarm_list',
  'calendar.directory',
  'calendar.query',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  'calendar.scope_preview',
  'calendar.attendees',
]);

// ---------------------------------------------------------------------------
// 三、结构化产出（会话据此判断，不必解析人话）
// ---------------------------------------------------------------------------

export type CalClockOutcome =
  | { readonly kind: 'alarm_proposal'; readonly proposal: ScheduleProposal }
  | { readonly kind: 'alarm_created'; readonly record: AlarmRecord; readonly duplicate: boolean }
  | { readonly kind: 'alarm_listing'; readonly query: ManagedAlarmQuery }
  | { readonly kind: 'alarm_mutation'; readonly mutation: MutationOutcome }
  | {
      readonly kind: 'timer';
      readonly timer: TimerState;
      readonly remainingMs: number;
      readonly due: boolean;
      readonly note: string;
    }
  | { readonly kind: 'stopwatch'; readonly stopwatch: StopwatchState; readonly totalMs: number }
  | { readonly kind: 'world_clock'; readonly readings: WorldClockResult }
  | { readonly kind: 'system_handoff'; readonly dispatch: DispatchResult }
  | {
      readonly kind: 'system_alarm_listing';
      readonly listing: SystemAlarmListing;
      /** 恒为 `false`：无合法枚举通道时，**不得**下"没有闹钟"的结论。 */
      readonly conclusive: false;
      readonly verdict: ReadinessVerdict;
      readonly unblockedBy: string;
    }
  | { readonly kind: 'calendar_directory'; readonly view: CalendarDirectoryView }
  | { readonly kind: 'calendar_query'; readonly result: QueryResult }
  | {
      readonly kind: 'calendar_write';
      readonly path: CreationPath;
      readonly state: ActionState;
      readonly eventId: string | null;
      readonly receipt: ActionReceipt;
      readonly writeNotes: readonly string[];
      /** 保存参与者 ≠ 已发邀请时，这里恒为 `false`（CAL-07）。 */
      readonly invitationSent?: false;
    }
  | { readonly kind: 'calendar_mutation'; readonly mutation: MutationResult }
  | { readonly kind: 'calendar_scope_preview'; readonly plan: ScopedChangePlan };

/**
 * 成功分支：与 `AdapterEditResult<CalClockSource>` **逐字段同形**，外加 `outcome`。
 *
 * 为什么多这一列：交付适配器的消费者是"下载文件"，看一眼回执就够；而本适配器的消费者是
 * **会话**，它要据"这次是提案还是已落地""交接到了哪一态"决定下一步——让会话去正则解析
 * `notes` 是最脆的接口。
 */
export interface CalClockOk {
  readonly ok: true;
  readonly source: CalClockSource;
  readonly changed: boolean;
  readonly notes: readonly string[];
  readonly outcome: CalClockOutcome;
}

/**
 * 失败分支。`verdict` / `unblockedBy` 只在"能力未就绪 / 被阻塞"时有值——
 * 这正是 R233「未就绪先给原因与解锁条件」的机器化落点。
 */
export interface CalClockFail {
  readonly ok: false;
  readonly kind: string;
  readonly detail: string;
  readonly verdict?: ReadinessVerdict;
  readonly unblockedBy?: string;
}

export type CalClockToolResult = CalClockOk | CalClockFail;

/** 编译期对照：本适配器的成功分支可**直接当作** `AdapterEditResult<S>` 使用（同形的机器化落点）。 */
export type SameShapeAsEditResult = CalClockOk extends AdapterEditResult<CalClockSource> ? true : false;

/** @see SameShapeAsEditResult */
export const SAME_SHAPE_AS_EDIT_RESULT: SameShapeAsEditResult = true;

/** 本接入口的工具标识与归属模板（与 `src/plugins/catalog.ts` 的 capability_id 对齐）。 */
export const CAL_CLOCK_TOOL_ID = 'cal-clock';
export const CAL_CLOCK_TEMPLATES: readonly string[] = Object.freeze(['template.clock', 'template.calendar']);

// ---------------------------------------------------------------------------
// 四、小工具
// ---------------------------------------------------------------------------

function fail(kind: string, detail: string, extra: Omit<CalClockFail, 'ok' | 'kind' | 'detail'> = {}): CalClockFail {
  return { ok: false, kind, detail, ...extra };
}

/**
 * 结构化未就绪：**原因**（detail）+ **解锁条件**（unblockedBy）一并给出。
 * 刻意**不抛异常、也不返回空结果冒充"查过了"**。
 */
function notReady(
  kind: string,
  reason: string,
  unblockedBy: string,
  verdict: ReadinessVerdict = 'not_ready',
): CalClockFail {
  return { ok: false, kind, detail: reason, verdict, unblockedBy };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function clockCapability(id: string): ClockNotReadyCapability | null {
  return CLOCK_NOT_READY.find((entry) => entry.id === id) ?? null;
}

/** 按源对象记忆默认动作台账（`WeakMap` ⇒ 不跨源串味，也不引入任何全局可变状态）。 */
const DEFAULT_LEDGERS = new WeakMap<object, ActionLedger>();

function ledgerFor(source: CalClockSource): ActionLedger {
  const provided = source.clockPorts.ledger;
  if (provided !== undefined) return provided;
  const existing = DEFAULT_LEDGERS.get(source);
  if (existing !== undefined) return existing;
  // I-5 生产接线：版本敏感台账（`createActionLedger` 的默认口径只按 requestId 去重）。
  const created = createActionLedger(versionAwareClockLedgerOptions());
  DEFAULT_LEDGERS.set(source, created);
  return created;
}

const MUTATION_UNBLOCKED_BY =
  'A 负责人在 apps/android 装配 CalendarContract 的读写 provider；本批不实现 Android 代码。';

const EDITOR_UNBLOCKED_BY =
  'A 负责人在 apps/android 装配 ACTION_INSERT / ACTION_EDIT 的 Intent 交接；本批不实现 Android 代码。';

// ---------------------------------------------------------------------------
// 五、操作派发（唯一的入口；先判断，后动手）
// ---------------------------------------------------------------------------

/**
 * 应用一次时钟 / 日历操作。
 *
 * 与 `XlsxDeliverableAdapter.applyEdit` 同形：**永不把异常抛给会话**——底层端口或纯函数
 * 抛出的形状问题在这里被结构化成 `{ok:false, kind, detail}`。差别只有两处，且都是刻意的：
 * **① 因为域端口是异步的，本入口返回 `Promise`；② 成功分支多一列 `outcome`。**
 *
 * `changed` 的口径：**自管侧**是否真的改动了仓库（`alarm.commit` 的幂等重放为 `false`）；
 * **系统 / provider 侧**是否真的把东西交出去 / 受理（`failed` 与"未派发"为 `false`）。
 */
export async function applyCalClockOp(source: CalClockSource, op: unknown): Promise<CalClockToolResult> {
  if (typeof op !== 'object' || op === null) {
    return fail('invalid_op', '操作必须是一个对象');
  }
  const name = (op as { readonly op?: unknown }).op;
  try {
    return await dispatchOp(source, op as CalClockToolOp, name);
  } catch (error) {
    // 底层以抛错表达形状问题（非法时间表达 / 非法重复规则 / 非法窗口）：
    // **结构化成失败**，而不是让异常穿出会话层（那会绕过"未就绪如实呈现"的承诺）。
    return fail('invalid_op', describeError(error));
  }
}

async function dispatchOp(
  source: CalClockSource,
  op: CalClockToolOp,
  name: unknown,
): Promise<CalClockToolResult> {
  switch (op.op) {
    // -----------------------------------------------------------------------
    // 时钟：自管提醒
    // -----------------------------------------------------------------------
    case 'alarm.propose': {
      const proposal = proposeSchedule(
        {
          label: op.label,
          zoneId: op.zoneId,
          repeat: op.repeat,
          ...(op.whenText === undefined ? {} : { whenText: op.whenText }),
          ...(op.atMs === undefined ? {} : { atMs: op.atMs }),
        },
        { nowMs: source.nowMs, zonePort: source.zonePort },
      );
      const notes: string[] = [];
      if (proposal.absoluteLocal !== null) {
        notes.push(`解析为 ${proposal.absoluteLocal}（${String(proposal.absoluteMs)} ms）。`);
      }
      if (proposal.requiresConfirmation) {
        notes.push('这是**待用户核对**的提案：确认前不落地（CLK-02）。');
      }
      if (proposal.kind === 'needs_choice') {
        notes.push(`存在 ${String(proposal.candidates.length)} 个候选时刻，请用户选择（不替用户猜）。`);
      }
      // 提案本身不改任何状态 ⇒ changed = false。
      return { ok: true, source, changed: false, notes, outcome: { kind: 'alarm_proposal', proposal } };
    }

    case 'alarm.commit': {
      if (op.proposal.kind !== 'ready' || op.proposal.absoluteMs === null) {
        return fail(
          'proposal_not_confirmable',
          `提案不是可落地的 ready 状态（${op.proposal.kind}）：${op.proposal.reason ?? '缺少绝对时刻'}；` +
            '拒绝创建，以免把模糊意图写成确切的闹钟。',
        );
      }
      const created = commitSchedule(source.store, op.proposal, op.idempotencyKey);
      if (!created.ok || created.record === null) {
        return fail('alarm_create_failed', created.problems.join('；') || '创建失败');
      }
      return {
        ok: true,
        source,
        changed: !created.duplicate,
        notes: [
          created.duplicate
            ? `幂等命中：未新建，复用既有提醒 ${created.record.id}（CLK-04）。`
            : `已创建自管提醒 ${created.record.id}（**自管**，不是系统闹钟）。`,
        ],
        outcome: { kind: 'alarm_created', record: created.record, duplicate: created.duplicate },
      };
    }

    case 'alarm.list': {
      const query = queryManagedAlarms(
        { store: source.store, zonePort: source.zonePort, nowMs: source.nowMs },
        op.filter ?? {},
      );
      return {
        ok: true,
        source,
        changed: false,
        notes: [`自管提醒 ${String(query.total)} 条。${query.disclaimer}`],
        outcome: { kind: 'alarm_listing', query },
      };
    }

    case 'alarm.mutate': {
      const mutation = applyAlarmMutation(source, op.id, op.expectedRevision, op.mutation);
      return {
        ok: true,
        source,
        changed: mutation.applied,
        notes: [
          mutation.problems.length === 0
            ? `已应用 ${mutation.kind}（${mutation.id}）。`
            : mutation.problems.join('；'),
        ],
        outcome: { kind: 'alarm_mutation', mutation },
      };
    }

    // -----------------------------------------------------------------------
    // 时钟：计时器 / 秒表 / 世界时钟
    // -----------------------------------------------------------------------
    case 'timer.create': {
      const timer = createTimer(op.id, op.label, op.durationMs);
      return {
        ok: true,
        source,
        changed: true,
        notes: ['计时器账目已建；**不声称**能准点响铃（cap.clock.precise_firing 未接通）。'],
        outcome: {
          kind: 'timer',
          timer,
          remainingMs: remainingMs(timer, source.nowMs),
          due: isDue(timer, source.nowMs),
          note: '到点触发必须由系统调度保证，本批未接通；本结果只保证时间账目正确。',
        },
      };
    }

    case 'stopwatch.create': {
      const stopwatch = createStopwatch(op.id);
      return {
        ok: true,
        source,
        changed: true,
        notes: ['秒表状态只有绝对起点与累计量，前后台切换后读数仍正确（CLK-06）。'],
        outcome: { kind: 'stopwatch', stopwatch, totalMs: stopwatchTotalMs(stopwatch, source.nowMs) },
      };
    }

    case 'world_clock': {
      const readings = readWorldClock(source.zonePort, op.zoneIds, source.nowMs);
      return {
        ok: true,
        source,
        changed: false,
        notes: [
          `世界时钟：${String(readings.readings.length)} 个时区读数，未知时区 ${String(readings.unknownZones.length)} 个。`,
        ],
        outcome: { kind: 'world_clock', readings },
      };
    }

    // -----------------------------------------------------------------------
    // 时钟：系统侧（最高只到「已交接」；`dismiss` 不是删除）
    // -----------------------------------------------------------------------
    case 'system.handoff': {
      const dispatch = await dispatchClockIntent(dispatchContextFor(source), {
        requestId: op.requestId,
        action: op.action,
        params: op.params,
        ...(op.targetRevision === undefined ? {} : { targetRevision: op.targetRevision }),
        ...(op.confirmed === undefined ? {} : { confirmed: op.confirmed }),
        ...(op.target === undefined ? {} : { target: op.target }),
      });
      return {
        ok: true,
        source,
        changed: dispatch.dispatched,
        notes: [
          dispatch.message,
          `当前状态：${dispatch.state}（本批系统时钟动作不可回读 ⇒ **最高只到"已交接"**，永不"已确认完成"）。`,
          dispatch.deletesAlarm ? '**会删除闹钟条目**' : '不删除闹钟条目（dismiss / 取消计时都不等于删除）。',
        ],
        outcome: { kind: 'system_handoff', dispatch },
      };
    }

    case 'system.alarm_list': {
      const listing = await querySystemAlarms(source.clockPorts.systemAlarmRead ?? null);
      const blocked = clockCapability('cap.clock.system_alarm_read');
      return {
        ok: true,
        source,
        changed: false,
        notes: [
          listing.status === 'unreadable'
            ? listing.reason
            : `读到 ${String(listing.alarms.length)} 条（厂商只读，可能不完整）。`,
        ],
        outcome: {
          kind: 'system_alarm_listing',
          listing,
          // 恒 false：无合法枚举通道时**不得**下"没有闹钟"的结论（CLK-03）。
          conclusive: false,
          verdict: blocked?.verdict ?? 'blocked',
          unblockedBy: blocked?.unblockedBy ?? '无合法通道；改为"打开时钟 App 交用户查看"。',
        },
      };
    }

    // -----------------------------------------------------------------------
    // 日历
    // -----------------------------------------------------------------------
    case 'calendar.directory': {
      const view = directoryView(source.access());
      return {
        ok: true,
        source,
        changed: false,
        notes: [
          view.readGranted
            ? `获准日历 ${String(view.calendars.length)} 个（账号 ${view.accounts.join('、') || '无'}）。`
            : '未获得读取授权：目录为空（**不是**"没有日历"，而是看不到）。',
        ],
        outcome: { kind: 'calendar_directory', view },
      };
    }

    case 'calendar.query': {
      const result = queryWithinAccess(source.access(), source.events, source.zonePort, {
        fromMs: op.fromMs,
        toMs: op.toMs,
        ...(op.keyword === undefined ? {} : { keyword: op.keyword }),
      });
      if (!result.ok) return fail('authorization_revoked', result.reason);
      return {
        ok: true,
        source,
        changed: false,
        notes: [
          `查到 ${String(result.result.events.length)} 条；越权排除 ${String(result.result.excludedUnauthorized)} 条。`,
        ],
        outcome: { kind: 'calendar_query', result: result.result },
      };
    }

    case 'calendar.create': {
      const built = buildEvent(op.draft, source.zonePort);
      if (!built.ok) return fail('invalid_event', built.problems.join('；'));
      const access = source.access();
      // 会话层统一闸门：授权被撤回 ⇒ 本次（以及此后的每一次）当场被拒。
      const gate = checkCalendarAccess(access, built.event.calendarId, 'write');
      if (!gate.ok) return fail('authorization_revoked', gate.reason);
      const profile = creationPathProfile(op.path);

      if (op.path === 'direct_write') {
        const outcome = await createEvent(source.calendarPorts.writer, access, built.event, source.zonePort);
        if (!outcome.ready) return notReady('not_ready', outcome.reason, outcome.note);
        return {
          ok: true,
          source,
          changed: outcome.result.state !== 'failed',
          notes: [profile.note, ...outcome.result.notes, `状态：${outcome.result.state}（上限 ${profile.maxState}）。`],
          outcome: {
            kind: 'calendar_write',
            path: 'direct_write',
            state: outcome.result.state,
            eventId: outcome.result.eventId,
            receipt: outcome.result.receipt,
            writeNotes: outcome.result.notes,
          },
        };
      }

      const editor = source.calendarPorts.editor;
      if (editor === undefined) {
        return notReady('not_ready', '未装配日历编辑页端口（CalendarEditorPort）', EDITOR_UNBLOCKED_BY);
      }
      const result = await openCalendarEditor(editor, built.event);
      return {
        ok: true,
        source,
        changed: result.state !== 'failed',
        notes: [profile.note, ...result.notes, `状态：${result.state}（上限 ${profile.maxState}）。`],
        outcome: {
          kind: 'calendar_write',
          path: 'open_editor',
          state: result.state,
          eventId: result.eventId,
          receipt: result.receipt,
          writeNotes: result.notes,
        },
      };
    }

    case 'calendar.update': {
      const rejection = rejectIfNoWriteAccess(source, op.current);
      if (rejection !== null) return rejection;
      const port = source.calendarPorts.mutation;
      if (port === undefined) {
        return notReady('not_ready', '未装配日历变更端口（CalendarMutationPort）', MUTATION_UNBLOCKED_BY);
      }
      const mutation = await applyUpdate(port, op.current, op.patch, op.expectedRevision, source.zonePort);
      return mutationResult(source, mutation);
    }

    case 'calendar.delete': {
      const rejection = rejectIfNoWriteAccess(source, op.current);
      if (rejection !== null) return rejection;
      const port = source.calendarPorts.mutation;
      if (port === undefined) {
        return notReady('not_ready', '未装配日历变更端口（CalendarMutationPort）', MUTATION_UNBLOCKED_BY);
      }
      const mutation = await applyCancel(
        port,
        op.current,
        op.scope,
        op.occurrenceStartMs,
        op.expectedRevision,
        source.zonePort,
        op.window,
      );
      return mutationResult(source, mutation);
    }

    case 'calendar.scope_preview': {
      const plan = planScopedEdit(op.current, op.scope, op.occurrenceStartMs, source.zonePort, op.window);
      if (plan === null) {
        return fail(
          'scope_plan_unavailable',
          '无法计算该范围的受影响实例（时区未知 / 窗口非法 / 时刻非法）——不猜。',
        );
      }
      return {
        ok: true,
        source,
        changed: false,
        notes: [
          `范围「${plan.scopeLabel}」影响 ${String(plan.affectedLocalDates.length)} 次，未影响 ${String(plan.untouchedLocalDates.length)} 次。`,
          plan.wholeSeries ? '这是**整个系列**。' : '不是整个系列。',
        ],
        outcome: { kind: 'calendar_scope_preview', plan },
      };
    }

    case 'calendar.attendees': {
      const declaration = declareAttendeeSave(op.attendeeCount);
      return {
        ok: true,
        source,
        changed: true,
        // `invitationSent` 恒为 false：保存参与者**不等于**已发邀请（CAL-07）。
        notes: [declaration.note],
        outcome: {
          kind: 'calendar_write',
          path: 'direct_write',
          state: 'submitted',
          eventId: null,
          receipt: { kind: 'acknowledgement', source: 'calendar_provider', detail: declaration.note },
          writeNotes: [declaration.note],
          invitationSent: false,
        },
      };
    }

    default:
      return fail(
        'unsupported_op',
        `不支持的操作 ${JSON.stringify(String(name))}（封闭枚举：${CAL_CLOCK_OPS.join(' / ')}）`,
      );
  }
}

// ---------------------------------------------------------------------------
// 六、派发细节
// ---------------------------------------------------------------------------

function applyAlarmMutation(
  source: CalClockSource,
  id: string,
  expectedRevision: number,
  mutation: AlarmMutationInput,
): MutationOutcome {
  switch (mutation.kind) {
    case 'update':
      return updateManagedAlarm(source.store, id, mutation.patch, expectedRevision);
    case 'set_enabled':
      return setManagedEnabled(source.store, id, mutation.enabled, expectedRevision);
    case 'remove':
      return removeManagedAlarm(source.store, id, expectedRevision);
    case 'cancel_occurrence':
      // 「取消一次发生」只跳过该次，**不删除整条**（与 CLK-08 的系统侧语义同源）。
      return cancelOneOccurrence(source.store, id, mutation.occurrenceEpochMs, expectedRevision);
  }
}

function dispatchContextFor(source: CalClockSource): DispatchContext {
  const facts = source.clockPorts.dispatch;
  return {
    port: source.clockPorts.intents ?? null,
    portVerified: source.clockPorts.intentsVerified === true,
    handlerAvailable: facts?.handlerAvailable ?? false,
    permissions: facts?.permissions ?? {},
    candidates: facts?.candidates ?? [],
    currentRevision: facts?.currentRevision ?? null,
    firedTargetIds: facts?.firedTargetIds ?? [],
    ledger: ledgerFor(source),
    nowMs: source.nowMs,
  };
}

function rejectIfNoWriteAccess(source: CalClockSource, event: CalendarEvent): CalClockFail | null {
  const gate = checkCalendarAccess(source.access(), event.calendarId, 'write');
  return gate.ok ? null : fail('authorization_revoked', gate.reason);
}

function mutationResult(source: CalClockSource, mutation: MutationResult): CalClockToolResult {
  return {
    ok: true,
    source,
    changed: mutation.ok,
    notes: mutation.ok
      ? [`已读回并确认：${mutation.next?.id ?? ''}（${mutation.state}）。`]
      : [mutation.reason ?? '变更未成功', ...mutation.notes, '失败 ⇒ **原记录保留**（CAL-06）。'],
    outcome: { kind: 'calendar_mutation', mutation },
  };
}

// ---------------------------------------------------------------------------
// 七、冻结的单例适配器（与 `xlsxDeliverableAdapter` 同形）
// ---------------------------------------------------------------------------

/**
 * 时钟 / 日历的工具接入口（唯一实例，纯函数集合）。
 *
 * `describe` 只产出**一行人可读描述**（进日志），**不参与任何判定**——
 * 与 `XlsxDeliverableAdapter.describe` 同口径。
 */
export const calClockToolAdapter = Object.freeze({
  tool: CAL_CLOCK_TOOL_ID,
  templates: CAL_CLOCK_TEMPLATES,
  describe(source: CalClockSource): string {
    const access = source.access();
    const readGranted = access.granted.includes('read');
    return (
      `自管提醒 ${String(source.store.list().length)} 条；` +
      `日历：读取授权 ${readGranted ? '有' : '无'}，获准日历 ${String(readGranted ? access.calendars.length : 0)} 个`
    );
  },
  apply: applyCalClockOp,
});

// ---------------------------------------------------------------------------
// 八、就绪度汇总（把两个域的结论并到一处，供会话统一展示）
// ---------------------------------------------------------------------------

export interface CalClockReadiness {
  readonly subitems: readonly SubitemReadiness[];
  readonly capabilities: readonly (ClockNotReadyCapability | CalendarNotReadyCapability)[];
  readonly counts: Record<ReadinessVerdict, number>;
}

/**
 * 汇总时钟 + 日历的就绪度。
 *
 * **如实**：这里只是把两个域各自的报告并起来（`implemented` 只表示"本批范围内、不依赖
 * 真机的那部分"），**不**代表真机已验收——真机层是本项目当前最大空白。
 */
export function clockCalendarReadiness(): CalClockReadiness {
  const clock = clockReadinessReport();
  const calendar = calendarReadinessReport();
  const subitems = [...clock.subitems, ...calendar.subitems];
  return {
    subitems,
    capabilities: [...clock.capabilities, ...calendar.capabilities],
    counts: countVerdicts(subitems),
  };
}

// ---------------------------------------------------------------------------
// 九、原样转发系统时钟语义（**不另造协议**：产品面读的就是域里那一份）
// ---------------------------------------------------------------------------

export { SYSTEM_ACTION_SEMANTICS, actionsThatDeleteAlarms, VERDICT_LABELS };

/** 该动作是否**删除闹钟条目**。本批恒为 `false`——尤其 `dismiss`（CLK-08）。 */
export function dismissalDeletesAlarm(action: SystemClockAction): boolean {
  return actionsThatDeleteAlarms().includes(action);
}

/** 展示用：某系统时钟动作的七态上限说明（读的是域里那一份语义表）。 */
export function describeSystemActionCeiling(action: SystemClockAction): string {
  return SYSTEM_ACTION_SEMANTICS[action].readable
    ? '该动作可回读：只有读回与意图一致才可报「已确认完成」。'
    : '该动作**不可回读** ⇒ 交接的最高状态是「已交接」，永不「已确认完成」（CLK-08）。';
}

/** 事件时长（毫秒）；无法确定返回 null。转发 `calendar/event`，供会话展示用。 */
export const eventDuration = eventDurationMs;

/** 转发参与者声明类型（产品面读的就是域里那一份）。 */
export type { AttendeeSaveDeclaration };
