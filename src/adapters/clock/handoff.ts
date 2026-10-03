/**
 * **系统时钟交接**（CLK-03 / CLK-08 / CLK-09 / CLK-10）。
 *
 * ## 本模块只做两件**不依赖设备**的事
 *
 * 1. 把"系统时钟动作"的**语义**定死——尤其 **`dismiss` ≠ 删除**（CLK-08）；
 * 2. 交接的**七态**报告路径（`prepared → handed_off / failed`），以及"多个候选/缺目标"
 *    的**选择**逻辑（歧义 ⇒ 交给用户选，不替用户猜）。
 *
 * ## 明确不做（并如实登记为未就绪）
 *
 * - **不**实现任何 Android Intent 的实际发送（需要设备与 `apps/android` 装配，归 A 负责人）；
 * - **不**伪造"手机上的全部闹钟"（CLK-03）：无读取接口时 {@link listSystemAlarms} 返回
 *   `not_ready` 并说明原因；
 * - **不**把交接记成完成：凡不可回读的动作，最高只能到"已交接"（CLK-08「无法读回只报交接」）。
 *
 * ## Android 事实的边界声明
 *
 * 动作名 {@link SystemClockAction} 是**本适配器的稳定词汇**，与 `cap.clock.*` 的既有命名对齐。
 * 其到 Android `AlarmClock` Intent 常量的**具体映射**、以及"是否存在系统闹钟读取接口"，
 * 由 FA-M 的 `readiness-matrix.md` 逐条给出核实结论（本文件不重复断言平台细节——
 * 平台事实需外部核实，见该矩阵）。映射由 A 负责人在 `apps/android/**` 装配时落地。
 */

import type { ActionReceipt, ActionState } from './action-contract.js';
import { assertTransition } from './action-contract.js';

/** 本适配器支持的系统时钟动作（稳定词汇）。 */
export type SystemClockAction =
  | 'create_alarm'
  | 'create_timer'
  | 'open_alarm_list'
  | 'open_timer_list'
  | 'dismiss_ringing_alarm'
  | 'snooze_ringing_alarm'
  | 'cancel_timer';

export interface SystemActionSemantics {
  /**
   * 在外部系统里的**效果类别**。
   * `open_only` = 只打开界面，**不改任何状态**（"打开页面不等于写入"，R246）。
   */
  readonly effect: 'create' | 'open_only' | 'stop_ringing' | 'postpone' | 'cancel';
  /**
   * **是否删除闹钟条目**。
   * `dismiss_ringing_alarm` 必须为 `false`：关闭本次响铃**不是**删除闹钟（CLK-08）。
   */
  readonly deletesAlarm: boolean;
  /** 我们能否**回读**其效果（决定七态的上限）。 */
  readonly readable: boolean;
  /** 是否需要目标应用存在（缺应用 ⇒ 交接失败，而不是"结果未知"）。 */
  readonly needsHandlerApp: boolean;
  readonly note: string;
}

export const SYSTEM_ACTION_SEMANTICS: Readonly<Record<SystemClockAction, SystemActionSemantics>> =
  Object.freeze({
    create_alarm: {
      effect: 'create',
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '创建系统闹钟：交接后**无法读回**，最高只能报"已交接"（CLK-08）。',
    },
    create_timer: {
      effect: 'create',
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '创建系统计时器：同上，交接后最高"已交接"。',
    },
    open_alarm_list: {
      effect: 'open_only',
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '**只打开**闹钟列表，不改变任何状态；不得据此声称读到了闹钟内容。',
    },
    open_timer_list: {
      effect: 'open_only',
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '**只打开**计时器列表，不改变任何状态。',
    },
    dismiss_ringing_alarm: {
      effect: 'stop_ringing',
      // ★ CLK-08 的核心断言：dismiss 不删除闹钟。
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '关闭**本次响铃**。**不是**删除闹钟——不得把 dismiss 当作删除（CLK-08）。',
    },
    snooze_ringing_alarm: {
      effect: 'postpone',
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '延后再响；不删除闹钟，也**不**改变原定的重复规则。',
    },
    cancel_timer: {
      effect: 'cancel',
      deletesAlarm: false,
      readable: false,
      needsHandlerApp: true,
      note: '取消计时器；取消的是一次计时，不是"删除闹钟"。',
    },
  });

/** 语义自检：任何"删除闹钟"的动作**不在**本词汇内——本批没有合法的系统闹钟删除通道。 */
export function actionsThatDeleteAlarms(): readonly SystemClockAction[] {
  return (Object.keys(SYSTEM_ACTION_SEMANTICS) as SystemClockAction[]).filter(
    (action) => SYSTEM_ACTION_SEMANTICS[action].deletesAlarm,
  );
}

export interface ClockHandoffOutcome {
  /** 是否找到了处理应用并成功把动作交出去。 */
  readonly delivered: boolean;
  readonly handlerLabel: string | null;
  readonly detail: string;
}

/** 交接端口（由宿主 / A 负责人的 Android 装配实现）。 */
export interface ClockIntentPort {
  handoff(
    action: SystemClockAction,
    params: Readonly<Record<string, string | number>>,
  ): Promise<ClockHandoffOutcome>;
}

export interface SystemHandoffResult {
  readonly action: SystemClockAction;
  readonly state: ActionState;
  readonly receipt: ActionReceipt;
  readonly semantics: SystemActionSemantics;
  /**
   * 若该动作**不可回读**，这里如实说明"为什么最高只能到已交接"；
   * 可回读时为 null。
   */
  readonly cannotConfirmReason: string | null;
}

/**
 * 交接一个系统时钟动作。**永不返回 `confirmed`**：
 * 本批所有系统时钟动作都不可回读（见语义表），因此最高状态是 `handed_off`。
 */
export async function handoffSystemClockAction(
  port: ClockIntentPort,
  action: SystemClockAction,
  params: Readonly<Record<string, string | number>>,
): Promise<SystemHandoffResult> {
  const semantics = SYSTEM_ACTION_SEMANTICS[action];
  const outcome = await port.handoff(action, params);

  if (!outcome.delivered) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'rejected' });
    return {
      action,
      state: transition.to,
      receipt: {
        kind: 'none',
        source: 'system_clock_handoff',
        detail: outcome.detail,
      },
      semantics,
      cannotConfirmReason: '未找到处理应用，动作**未**发生。',
    };
  }

  const transition = assertTransition('prepared', 'handed_off');
  return {
    action,
    state: transition.to,
    receipt: {
      kind: 'none',
      source: outcome.handlerLabel ?? 'system_clock_app',
      detail: outcome.detail,
    },
    semantics,
    cannotConfirmReason: semantics.readable
      ? null
      : '该动作不可回读：只能报告"已交接给系统时钟应用"，不得报告"已完成"（CLK-08）。',
  };
}

// ---------------------------------------------------------------------------
// 系统闹钟的读取（CLK-03）—— 没有接口就**如实说没有**
// ---------------------------------------------------------------------------

export interface SystemAlarmRef {
  readonly id: string;
  readonly label: string;
  readonly hour: number;
  readonly minute: number;
  readonly enabled: boolean;
}

/** 系统闹钟读取端口。**产品基线不提供此端口**（见 not-ready.ts）。 */
export interface SystemAlarmReadPort {
  list(): Promise<readonly SystemAlarmRef[]>;
}

export type SystemAlarmListResult =
  | { readonly status: 'ok'; readonly alarms: readonly SystemAlarmRef[]; readonly source: string }
  | { readonly status: 'not_ready'; readonly reason: string };

/**
 * 读取系统闹钟列表。
 *
 * **`port === null` 是默认情形**：本批没有可用的系统闹钟读取接口。
 * 此时返回 `not_ready` + 原因，**绝不**用自管提醒冒充"手机上的全部闹钟"（CLK-03 / CLK-10）。
 */
export async function listSystemAlarms(
  port: SystemAlarmReadPort | null,
  sourceLabel = 'system_clock_app',
): Promise<SystemAlarmListResult> {
  if (port === null) {
    return {
      status: 'not_ready',
      reason:
        '没有系统闹钟读取接口：本批未接通任何可枚举系统闹钟的通道。' +
        'CLK-03 禁止伪造"手机全部闹钟列表"，故此处只报未就绪；自管提醒另见 AlarmStore.list()。',
    };
  }
  const alarms = await port.list();
  return { status: 'ok', alarms, source: sourceLabel };
}

// ---------------------------------------------------------------------------
// 目标选择（CLK-08「正确处理多个候选、缺目标」）
// ---------------------------------------------------------------------------

export interface TargetCriteria {
  readonly label?: string;
  readonly hour?: number;
  readonly minute?: number;
  readonly id?: string;
}

export type TargetSelection =
  | { readonly kind: 'matched'; readonly target: SystemAlarmRef }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly SystemAlarmRef[] }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * 按条件挑一个系统闹钟目标。
 * **多个命中 ⇒ `ambiguous`**（交给用户选），**不**按"第一个"静默取（CLK-08）。
 */
export function selectAlarmTarget(
  refs: readonly SystemAlarmRef[],
  criteria: TargetCriteria,
): TargetSelection {
  const hasCriteria =
    criteria.label !== undefined ||
    criteria.hour !== undefined ||
    criteria.minute !== undefined ||
    criteria.id !== undefined;
  if (!hasCriteria) {
    return { kind: 'none', reason: '未给出任何目标条件：无法在多个闹钟中定位目标' };
  }

  const matches = refs.filter((ref) => {
    if (criteria.id !== undefined && ref.id !== criteria.id) return false;
    if (criteria.label !== undefined && ref.label !== criteria.label) return false;
    if (criteria.hour !== undefined && ref.hour !== criteria.hour) return false;
    if (criteria.minute !== undefined && ref.minute !== criteria.minute) return false;
    return true;
  });

  if (matches.length === 0) return { kind: 'none', reason: '没有闹钟符合给定条件' };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  const only = matches[0];
  if (only === undefined) return { kind: 'none', reason: '内部错误：匹配结果为空' };
  return { kind: 'matched', target: only };
}

/** 展示用动作描述。 */
export function describeSystemAction(action: SystemClockAction): string {
  return SYSTEM_ACTION_SEMANTICS[action].note;
}
