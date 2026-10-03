/**
 * 系统时钟动作的**交接派发**（CLK-08 / CLK-09）。
 *
 * ## 与 `handoff.ts` 的分工
 *
 * `handoff.ts` 定死**语义**（七态、`dismiss ≠ 删除`、不可回读只报交接）。本模块在其上加一层
 * **派发策略**，把 CLK-08 / CLK-09 里那些"必须先判断再动手"的条件落成代码：
 *
 * | 条件 | 结果 |
 * |---|---|
 * | 没有**已验证**的交接口 | `unverified_interface`——**不**假装交出去了 |
 * | 权限被拒 / 未知 | `permission_denied` / `permission_unverified` |
 * | 目标有歧义 / 缺目标 | `ambiguous_candidates`（交用户选）/ `missing_target` |
 * | 目标版本不符 | `revision_conflict`（气泡与执行读同一对象，R243） |
 * | 需要用户确认的动作未确认 | `needs_confirmation` |
 * | 目标**已触发**（已发生）再取消 | `already_fired`——保留事实，**不**改写成"没发生过" |
 * | 同一 `requestId` 重复点击 | `duplicate_click`——不再执行第二次 |
 * | 动作**不可回读** | 最高只到「已交接」（`unreadable_handoff_only`），**永不** `confirmed` |
 *
 * ## `dismiss` 不是删除（CLK-08 的核心）
 *
 * {@link isStopRingingAction} 与 {@link isDeleteAlarmAction} 是**两个不同的问题**：
 * 前者问"是不是在关本次响铃"，后者问"会不会删掉闹钟条目"。对 `dismiss_ringing_alarm`，
 * 前者为 `true`、后者恒为 `false`；{@link assertNotDeleteAction} 把"想当然当成删除"钉成异常。
 * 本批**没有**任何合法的系统闹钟删除通道（{@link actionsThatDeleteAlarms} 为空）。
 *
 * ## 未验证（需真机）
 *
 * 真实的 Intent 发送、厂商处理应用、权限授予状态都需要设备；本模块只保证**策略与报告**正确。
 */

import {
  assertTransition,
  label as stateLabel,
  type ActionLedger,
  type ActionReceipt,
  type ActionState,
} from './action-contract.js';
import {
  SYSTEM_ACTION_SEMANTICS,
  actionsThatDeleteAlarms,
  selectAlarmTarget,
  type ClockIntentPort,
  type SystemAlarmRef,
  type SystemClockAction,
  type TargetCriteria,
} from './handoff.js';

export { actionsThatDeleteAlarms };

// ---------------------------------------------------------------------------
// 一、语义判别（CLK-08：dismiss ≠ 删除）
// ---------------------------------------------------------------------------

/** 该动作是不是在**停止本次响铃**（与"删除闹钟"是两回事）。 */
export function isStopRingingAction(action: SystemClockAction): boolean {
  return SYSTEM_ACTION_SEMANTICS[action].effect === 'stop_ringing';
}

/** 该动作会不会**删除闹钟条目**。本批所有动作恒为 `false`。 */
export function isDeleteAlarmAction(action: SystemClockAction): boolean {
  return SYSTEM_ACTION_SEMANTICS[action].deletesAlarm;
}

/**
 * 拒绝把动作当成删除。**反向对照**：`assertNotDeleteAction('dismiss_ringing_alarm', true)` 抛错。
 */
export function assertNotDeleteAction(action: SystemClockAction, assumeDelete: boolean): void {
  if (assumeDelete) {
    throw new Error(
      `不得把 ${action} 当作删除闹钟：CLK-08 明令 dismiss 只关本次响铃，` +
        '不删除闹钟条目；本批也没有合法的系统闹钟删除通道。',
    );
  }
  if (isDeleteAlarmAction(action)) {
    throw new Error(`内部错误：${action} 竟然被判为删除闹钟，语义表被改坏`);
  }
}

/** 该动作是否需要一次用户确认（写入型 / 取消型；纯打开页面与关闭响铃不需要）。 */
export function requiresConfirmation(action: SystemClockAction): boolean {
  const effect = SYSTEM_ACTION_SEMANTICS[action].effect;
  return effect === 'create' || effect === 'cancel';
}

/** 该动作需要的 Android 权限；纯 `open_only` 不需要（打开页面不等于写入，R246）。 */
export function permissionFor(action: SystemClockAction): string | null {
  return SYSTEM_ACTION_SEMANTICS[action].effect === 'open_only' ? null : 'android.permission.SET_ALARM';
}

/** 该动作是否必须先定位一个目标闹钟 / 计时器。 */
export function requiresTarget(action: SystemClockAction): boolean {
  const effect = SYSTEM_ACTION_SEMANTICS[action].effect;
  return effect === 'stop_ringing' || effect === 'postpone' || effect === 'cancel';
}

// ---------------------------------------------------------------------------
// 二、派发输入 / 上下文 / 结果
// ---------------------------------------------------------------------------

export type IntentPermissionState = 'granted' | 'denied' | 'unknown';

export interface DispatchRequest {
  /** 幂等键：**同一次用户意图**的重复提交必须复用同一个值（CLK-09 重复点击）。 */
  readonly requestId: string;
  readonly action: SystemClockAction;
  readonly params: Readonly<Record<string, string | number>>;
  /** 发起时绑定的目标版本（CLK-09 参数版本绑定）。 */
  readonly targetRevision?: number;
  /** 需要确认的动作：用户在气泡里确认后为 true。 */
  readonly confirmed?: boolean;
  /** 目标条件（多候选时用于选择）。 */
  readonly target?: TargetCriteria;
}

export interface DispatchContext {
  /** 交接口；`null` = 未装配。 */
  readonly port: ClockIntentPort | null;
  /**
   * 该 port 是否来自**已验证**的接口。
   * 未验证 ⇒ **不得**使用（CLK-08「使用已验证接口」）。
   */
  readonly portVerified: boolean;
  /** 处理应用是否存在。 */
  readonly handlerAvailable: boolean;
  readonly permissions: Readonly<Record<string, IntentPermissionState>>;
  /** 当前可候选的系统闹钟（用于目标选择）。 */
  readonly candidates: readonly SystemAlarmRef[];
  /** 目标的当前版本；用于与 `targetRevision` 对账。 */
  readonly currentRevision: number | null;
  /** **已触发**的目标 id —— 取消这类目标必须显冲突，不得改写已发生事实。 */
  readonly firedTargetIds: readonly string[];
  readonly ledger: ActionLedger;
  readonly nowMs: number;
}

export type DispatchOutcome =
  | 'handed_off'
  | 'unreadable_handoff_only'
  | 'unverified_interface'
  | 'handler_missing'
  | 'permission_denied'
  | 'permission_unverified'
  | 'needs_confirmation'
  | 'ambiguous_candidates'
  | 'missing_target'
  | 'revision_conflict'
  | 'duplicate_click'
  | 'already_fired';

export interface DispatchResult {
  readonly requestId: string;
  readonly action: SystemClockAction;
  readonly outcome: DispatchOutcome;
  readonly state: ActionState;
  /** 动作是否**真的**交给了外部（`false` 时不能报告"已交接"）。 */
  readonly dispatched: boolean;
  readonly receipt: ActionReceipt;
  readonly message: string;
  /** 该动作会不会删除闹钟条目（供展示层如实显示）。 */
  readonly deletesAlarm: boolean;
}

function receipt(kind: ActionReceipt['kind'], source: string, detail: string): ActionReceipt {
  return { kind, source, detail };
}

function failureState(detail: string): { readonly state: ActionState; readonly receipt: ActionReceipt } {
  const transition = assertTransition('prepared', 'failed', {
    failureKind: 'rejected',
    receipt: receipt('none', 'clock_intent', detail),
  });
  return { state: transition.to, receipt: transition.receipt };
}

function prepared(detail: string): { readonly state: ActionState; readonly receipt: ActionReceipt } {
  return { state: 'prepared', receipt: receipt('none', 'clock_intent', detail) };
}

function result(
  request: DispatchRequest,
  outcome: DispatchOutcome,
  state: ActionState,
  dispatched: boolean,
  actionReceipt: ActionReceipt,
  message: string,
): DispatchResult {
  return {
    requestId: request.requestId,
    action: request.action,
    outcome,
    state,
    dispatched,
    receipt: actionReceipt,
    message,
    deletesAlarm: isDeleteAlarmAction(request.action),
  };
}

// ---------------------------------------------------------------------------
// 三、派发（按上述顺序逐关判定）
// ---------------------------------------------------------------------------

/**
 * 派发一个系统时钟动作。**先判定、后动手**：任何一关不过就如实报告，绝不在条件不满足时
 * 假装已经交出去（更不会到 `confirmed`——本批所有系统动作都不可回读）。
 */
export async function dispatchClockIntent(
  context: DispatchContext,
  request: DispatchRequest,
): Promise<DispatchResult> {
  const semantics = SYSTEM_ACTION_SEMANTICS[request.action];

  // 关 1：接口必须**已验证**，否则不假装。
  if (context.port === null || !context.portVerified) {
    const { state, receipt: r } = prepared(
      '未装配已验证的系统时钟交接口：动作**未发生**，不得报告"已交接"。',
    );
    return result(
      request,
      'unverified_interface',
      state,
      false,
      r,
      '没有已验证的交接口（ClockIntentPort），本次不派发——系统时钟动作只允许走已验证接口（CLK-08）。',
    );
  }

  // 关 2：权限。
  const permission = permissionFor(request.action);
  if (permission !== null) {
    const state = context.permissions[permission] ?? 'unknown';
    if (state === 'denied') {
      const failure = failureState(`权限被拒：${permission}`);
      return result(
        request,
        'permission_denied',
        failure.state,
        false,
        failure.receipt,
        `缺少权限 ${permission}：动作被拒，未派发。`,
      );
    }
    if (state !== 'granted') {
      const { state: s, receipt: r } = prepared(`权限状态未知：${permission}`);
      return result(
        request,
        'permission_unverified',
        s,
        false,
        r,
        `权限 ${permission} 状态**未知**：无设备无法确认，不派发（未验证，需真机）。`,
      );
    }
  }

  // 关 3：目标（多候选 / 缺目标）。
  let targetId: string | null = null;
  if (requiresTarget(request.action)) {
    const selection = selectAlarmTarget(context.candidates, request.target ?? {});
    if (selection.kind === 'ambiguous') {
      const { state, receipt: r } = prepared('目标有多个候选');
      return result(
        request,
        'ambiguous_candidates',
        state,
        false,
        r,
        `有 ${String(selection.candidates.length)} 个候选闹钟，请用户指定目标后重试（不替用户猜）。`,
      );
    }
    if (selection.kind === 'none') {
      const { state, receipt: r } = prepared(selection.reason);
      return result(request, 'missing_target', state, false, r, `找不到目标：${selection.reason}`);
    }
    targetId = selection.target.id;
  }

  // 关 4：触发竞态 —— 已发生的事实不得被改写。
  if (targetId !== null && context.firedTargetIds.includes(targetId)) {
    const failure = failureState(`目标 ${targetId} 已触发`);
    return result(
      request,
      'already_fired',
      failure.state,
      false,
      failure.receipt,
      `目标 ${targetId} 已经触发过：本次 ${request.action} 未执行；已发生的事实保留，不改写成"未发生"。`,
    );
  }

  // 关 5：版本绑定（CLK-09）。
  if (
    request.targetRevision !== undefined &&
    context.currentRevision !== null &&
    request.targetRevision !== context.currentRevision
  ) {
    const { state, receipt: r } = prepared('版本不符');
    return result(
      request,
      'revision_conflict',
      state,
      false,
      r,
      `参数版本 ${String(request.targetRevision)} 与当前 ${String(context.currentRevision)} 不一致：` +
        '目标已被改动，本次不派发（避免用陈旧参数打到新对象）。',
    );
  }

  // 关 6：需要用户确认。
  if (requiresConfirmation(request.action) && request.confirmed !== true) {
    const { state, receipt: r } = prepared('等待用户确认');
    return result(
      request,
      'needs_confirmation',
      state,
      false,
      r,
      `${request.action} 属于需要确认的动作：尚未确认，不派发。`,
    );
  }

  // 关 7：处理应用存在（预判；端口若仍失败则按下述处理）。
  if (semantics.needsHandlerApp && !context.handlerAvailable) {
    const failure = failureState('没有可处理该动作的应用');
    return result(
      request,
      'handler_missing',
      failure.state,
      false,
      failure.receipt,
      '系统里没有能处理该动作的时钟应用：动作**未发生**（不是"结果未知"）。',
    );
  }

  // 关 8：重复点击 —— 到这里才登记台账，避免"等待确认"的一来一回被误判为重复。
  const begun = context.ledger.begin(
    {
      requestId: request.requestId,
      toolId: `clock.${request.action}`,
      revision: request.targetRevision ?? context.currentRevision ?? 0,
    },
    context.nowMs,
  );
  if (begun.duplicate) {
    return result(
      request,
      'duplicate_click',
      begun.entry.state,
      false,
      receipt('none', 'action_ledger', '重复点击：复用既有台账条目'),
      `同一 requestId 已登记（当前「${stateLabel(begun.entry.state)}」）：重复点击不再执行第二次。`,
    );
  }

  // 动手。
  const params: Record<string, string | number> = { ...request.params };
  if (targetId !== null) params['targetId'] = targetId;
  const outcome = await context.port.handoff(request.action, params);

  if (!outcome.delivered) {
    const detail = `交接口未送达：${outcome.detail}`;
    const failure = failureState(detail);
    context.ledger.settle(request.requestId, failure.state, context.nowMs);
    return result(request, 'handler_missing', failure.state, false, failure.receipt, detail);
  }

  // 已交给外部；**不可回读** ⇒ 最高只到「已交接」（CLK-08）。
  const transition = assertTransition('prepared', 'handed_off', {
    receipt: receipt('none', outcome.handlerLabel ?? 'system_clock_app', outcome.detail),
  });
  context.ledger.settle(request.requestId, transition.to, context.nowMs);
  const unreadable = !semantics.readable;
  return result(
    request,
    unreadable ? 'unreadable_handoff_only' : 'handed_off',
    transition.to,
    true,
    transition.receipt,
    unreadable
      ? '已交接给系统时钟应用；该动作**不可回读**，只能报告"已交接"，不得报告"已完成"（CLK-08）。'
      : '已交接给系统时钟应用。',
  );
}

/** 展示用：动作 + 七态标签。 */
export function describeDispatch(result: DispatchResult): string {
  return `${result.action} → ${stateLabel(result.state)}（${result.outcome}）：${result.message}`;
}
