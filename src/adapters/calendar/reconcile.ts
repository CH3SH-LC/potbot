/**
 * CAL-08 / CAL-09 / CAL-10：**事实变化后的对账**、**两条写路径的区分**，以及
 * **离线 / 同步延迟 / 外部修改 / 重启 / 重复请求 / 取消竞态 / 权限撤回**的处置。
 *
 * ## CAL-08：只动"登记过关联"的日程
 *
 * 复用 `links.createEventLinkIndex`：**关联必须显式建立**，因此独立日程（哪怕标题相似）
 * **结构上**不会被顺带刷新；事实版本推进后，旧版本上的确认气泡被标**已失效**
 * （保留历史，不冒充当前结果）。{@link reconcileFactChange} 只是把它包成可展示的结论。
 *
 * ## CAL-09：**授权直写**与**打开系统编辑页**的上限不同
 *
 * {@link creationPathProfile} 把两条路径的上限**写成数据**：`direct_write` 可到
 * `confirmed`（需回读），`open_editor` **最高只能到** `handed_off`——**没有读回证据
 * 不得自动标创建完成**。
 *
 * ## CAL-10：七种"非理想路径"的处置
 *
 * ⚠️ **同进程模拟，如实标注**：{@link createReconcileJournal} 的全部结论都带
 * `simulated: true` 与 {@link RECONCILE_SIMULATION_NOTE}，**不代表**真机 / 真实 provider
 * 的行为。真机侧（真实断网、真实 provider 同步延迟、真实进程重启、真实权限撤回）
 * **未验证（需真机）**。
 *
 * ## 交付说明
 *
 * 子智能体模型身份**未确认为 DS**；本文件为在 `fa/calendar-core` 工作树内**新增**。
 */

import {
  assertTransition,
  createActionLedger,
  type ActionRequest,
  type ActionState,
  type ActionLedger,
  type TransitionContext,
} from '../clock/action-contract.js';
// I-5：让 `revision` 进入幂等键——同 requestId、不同 revision 不再是同一动作（R213）。
// 权威推导在 workledger（`deriveClockLedgerKey`），适配器只**注入**，不另立算法。
import { versionAwareClockLedgerOptions } from '../../workledger/action-state-alignment.js';
import { checkCalendarAccess, type CalendarAccess, type CalendarPermission } from './handoff.js';
import type { EventFactLink, EventLinkIndex, EventReference } from './links.js';

/**
 * 模拟声明：**每个** CAL-10 结论都必须带上它。
 *
 * 真实断网 / 真实同步延迟 / 真实重启 / 真实权限撤回的行为只能在设备上核实。
 */
export const RECONCILE_SIMULATION_NOTE =
  '同进程模拟：不是真机 / 真实 provider 实测；真机侧未验证（需真机）。';

// ---------------------------------------------------------------------------
// CAL-08：事实变化对账
// ---------------------------------------------------------------------------

export interface ReconcileOutcome {
  readonly factRef: string;
  readonly newRevision: number;
  /** 需要更新的日程（去重、稳定排序）。 */
  readonly needsUpdate: readonly string[];
  /** 随事实推进而**失效**的确认气泡。 */
  readonly expiredBubbles: readonly string[];
  /** 与该事实**无关**的日程（CAL-08：独立日程不被误合并）。 */
  readonly untouched: readonly string[];
  /** 是否存在失效气泡（调用方据此刷新界面）。 */
  readonly hasExpiredBubbles: boolean;
  readonly note: string;
}

/** 建立"日程 ↔ 事实"的显式关联（`bubbleId` 缺省为 null）。 */
export function registerFactLink(
  index: EventLinkIndex,
  link: { readonly eventId: string; readonly factRef: string; readonly factRevision: number; readonly bubbleId?: string | null },
): void {
  const entry: EventFactLink = {
    eventId: link.eventId,
    factRef: link.factRef,
    factRevision: link.factRevision,
    bubbleId: link.bubbleId ?? null,
  };
  index.link(entry);
}

/**
 * 事实变化后的对账结论（CAL-08）。
 *
 * **不按标题相似度合并**：只有 `index` 里**登记过**该 `factRef` 的日程会进入
 * `needsUpdate`；其余一律进 `untouched`。
 */
export function reconcileFactChange(
  index: EventLinkIndex,
  factRef: string,
  newRevision: number,
  events: readonly EventReference[],
): ReconcileOutcome {
  const outcome = index.onFactChanged(factRef, newRevision, events);
  return {
    factRef,
    newRevision,
    needsUpdate: outcome.affectedEventIds,
    expiredBubbles: outcome.expiredBubbleIds,
    untouched: outcome.untouchedEventIds,
    hasExpiredBubbles: outcome.expiredBubbleIds.length > 0,
    note:
      '旧确认气泡已失效（保留历史，不冒充当前结果）；未被显式关联的日程**不受影响**' +
      '（独立日程不按相似度被误合并）。',
  };
}

// ---------------------------------------------------------------------------
// CAL-09：两条写路径的上限（写成数据，而不是注释）
// ---------------------------------------------------------------------------

export type CreationPath = 'direct_write' | 'open_editor';

export interface CreationPathProfile {
  readonly path: CreationPath;
  /** 该路径**最高**能到达的状态。 */
  readonly maxState: ActionState;
  /** 能否到达"已确认完成"。 */
  readonly canReachConfirmed: boolean;
  /** 是否依赖**外部读回**才能确认。 */
  readonly requiresReadback: boolean;
  readonly note: string;
}

/** 两条路径的上限画像（CAL-09）。 */
export function creationPathProfile(path: CreationPath): CreationPathProfile {
  if (path === 'direct_write') {
    return {
      path,
      maxState: 'confirmed',
      canReachConfirmed: true,
      requiresReadback: true,
      note: '授权直写：**必须读回**与意图一致才可报"已确认完成"；读不回 ⇒ 结果未知（不得报完成）。',
    };
  }
  return {
    path,
    maxState: 'handed_off',
    canReachConfirmed: false,
    requiresReadback: false,
    note:
      '打开系统编辑页：我们无法知道用户是否保存 ⇒ **最高只能报"已交接"**。' +
      '没有读回证据**不得**自动标"创建完成"（CAL-09；用户口述也只是"用户报告完成"）。',
  };
}

// ---------------------------------------------------------------------------
// CAL-10：非理想路径
// ---------------------------------------------------------------------------

export type ReconcileScenario =
  | 'offline'
  | 'sync_delay'
  | 'external_modification'
  | 'restart'
  | 'duplicate_request'
  | 'cancel_race'
  | 'permission_revoked';

export interface ReconcileFinding {
  readonly scenario: ReconcileScenario;
  /** 该情形下**允许**报出的状态。 */
  readonly state: ActionState;
  /** 是否命中"重复请求"（幂等键复用）。 */
  readonly duplicate: boolean;
  /** **恒为 true**：本结论来自同进程模拟。 */
  readonly simulated: true;
  /** 是否**如实**（未把不确定说成完成）。 */
  readonly honest: boolean;
  readonly detail: string;
  /** 模拟声明（恒等于 {@link RECONCILE_SIMULATION_NOTE}）。 */
  readonly note: string;
}

function finding(
  scenario: ReconcileScenario,
  state: ActionState,
  detail: string,
  duplicate = false,
): ReconcileFinding {
  const claimsCompleted = state === 'confirmed';
  return {
    scenario,
    state,
    duplicate,
    simulated: true,
    // 模拟里若把不确定报成"已确认完成"，即视为不如实（本模块任何分支都不这样做）。
    honest: !claimsCompleted || scenario === 'cancel_race',
    detail,
    note: RECONCILE_SIMULATION_NOTE,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AdvanceResult = { readonly ok: boolean; readonly state: ActionState; readonly problem: string | null };

function advance(
  ledger: ActionLedger,
  requestId: string,
  to: ActionState,
  atMs: number,
  context: TransitionContext = {},
): AdvanceResult {
  const entry = ledger.get(requestId);
  if (entry === null) {
    return { ok: false, state: 'unknown', problem: `未知 requestId：${requestId}` };
  }
  try {
    // 先按合同校验转换是否合法（构造即校验），再落台账。
    assertTransition(entry.state, to, context);
  } catch (error) {
    return { ok: false, state: entry.state, problem: messageOf(error) };
  }
  try {
    const settled = ledger.settle(requestId, to, atMs);
    return { ok: true, state: settled.state, problem: null };
  } catch (error) {
    return { ok: false, state: entry.state, problem: messageOf(error) };
  }
}

export interface ReconcileJournal {
  /** 离线：请求只进待发队列 ⇒ 停在 `prepared`，**不冒充已发出**。 */
  goOffline(request: ActionRequest, atMs: number): ReconcileFinding;
  /** 同步延迟：受理了但读不回 ⇒ `unknown`。 */
  markSyncDelayed(requestId: string, atMs: number, reason?: string): ReconcileFinding;
  /** 外部修改：读回版本与期望不符 ⇒ `unknown`（不覆盖外部）。 */
  observeExternalChange(
    requestId: string,
    expectedRevision: number,
    observedRevision: number,
    atMs: number,
  ): ReconcileFinding;
  /** 重启：进程内进行中的动作不假定完成 ⇒ `unknown`。 */
  reloadAfterRestart(requestId: string, atMs: number): ReconcileFinding;
  /** 重复请求：同幂等键 ⇒ `duplicate:true`，**不重复执行**。 */
  submitDuplicate(request: ActionRequest, atMs: number): ReconcileFinding;
  /** 取消竞态：已终态**不得**被改写 ⇒ 保持原状态并如实报冲突。 */
  cancelAfterSettle(requestId: string, atMs: number): ReconcileFinding;
  /** 权限撤回：后续写入被拒 ⇒ `failed`（不追溯否定已确认的历史）。 */
  revokePermission(access: CalendarAccess, calendarId: string, need: CalendarPermission): ReconcileFinding;
  /** 未终结的动作数（离线队列长度）。 */
  pendingCount(): number;
  /** 已产生的结论（供断言 / 审计）。 */
  findings(): readonly ReconcileFinding[];
}

/**
 * CAL-10 的同进程模拟台账。
 *
 * **所有**结论都带 `simulated: true` 与模拟声明；不要把它当作真机证据。
 */
export function createReconcileJournal(): ReconcileJournal {
  // I-5 生产接线：版本敏感台账 —— 同 requestId、不同 revision 不再被判为同一动作。
  const ledger = createActionLedger(versionAwareClockLedgerOptions());
  const log: ReconcileFinding[] = [];

  const record = (entry: ReconcileFinding): ReconcileFinding => {
    log.push(entry);
    return entry;
  };

  return {
    goOffline(request, atMs) {
      const begun = ledger.begin(request, atMs);
      return record(
        finding(
          'offline',
          begun.entry.state,
          `离线：请求进入待发队列（requestId=${request.requestId}），停在「已准备」；` +
            '**未对外发出**，也不冒充已创建。恢复网络后需重新提交或对账。',
          begun.duplicate,
        ),
      );
    },

    markSyncDelayed(requestId, atMs, reason = 'provider 已受理但读不回') {
      const submitted = advance(ledger, requestId, 'submitted', atMs, {
        receipt: { kind: 'acknowledgement', source: 'calendar_provider', detail: '插入/更新已受理' },
      });
      if (!submitted.ok) {
        return record(finding('sync_delay', submitted.state, `无法标记为已提交：${submitted.problem ?? ''}`));
      }
      const unknown = advance(ledger, requestId, 'unknown', atMs);
      return record(
        finding(
          'sync_delay',
          unknown.state,
          `同步延迟（${reason}）：已受理但读不回 ⇒ 「结果未知」；**不**盲目重试、**不**报完成。`,
        ),
      );
    },

    observeExternalChange(requestId, expectedRevision, observedRevision, atMs) {
      const submitted = advance(ledger, requestId, 'submitted', atMs, {
        receipt: { kind: 'acknowledgement', source: 'calendar_provider', detail: '写入已受理' },
      });
      if (!submitted.ok) {
        return record(
          finding('external_modification', submitted.state, `无法进入已提交：${submitted.problem ?? ''}`),
        );
      }
      const unknown = advance(ledger, requestId, 'unknown', atMs);
      return record(
        finding(
          'external_modification',
          unknown.state,
          `读回版本 ${String(observedRevision)} 与期望 ${String(expectedRevision)} 不符（外部已改）：` +
            '⇒ 「结果未知」，**不**用本地意图覆盖外部修改；需重新读取后再决定。',
        ),
      );
    },

    reloadAfterRestart(requestId, atMs) {
      const entry = ledger.get(requestId);
      if (entry === null) {
        return record(
          finding(
            'restart',
            'unknown',
            `重启后进程内台账里没有 ${requestId}：无法确认它是否完成 ⇒ 「结果未知」。` +
              '真实持久化 / 恢复行为**未验证（需真机）**。',
          ),
        );
      }
      const unknown = advance(ledger, requestId, 'unknown', atMs);
      return record(
        finding('restart', unknown.state, '重启：进行中的动作不假定完成 ⇒ 「结果未知」。'),
      );
    },

    submitDuplicate(request, atMs) {
      const begun = ledger.begin(request, atMs);
      return record(
        finding(
          'duplicate_request',
          begun.entry.state,
          begun.duplicate
            ? `幂等键 ${request.requestId} 已存在 ⇒ 复用既有动作（duplicate），**不重复执行**。`
            : `首次登记 ${request.requestId}（未重复）。`,
          begun.duplicate,
        ),
      );
    },

    cancelAfterSettle(requestId, atMs) {
      const current = ledger.get(requestId);
      if (current === null) {
        return record(finding('cancel_race', 'unknown', `未知 requestId：${requestId}`));
      }
      // 先把动作推进到终态（已确认完成：需 readback 回执），模拟"取消来晚了"。
      let state: ActionState = current.state;
      if (state === 'prepared') {
        const submitted = advance(ledger, requestId, 'submitted', atMs, {
          receipt: { kind: 'acknowledgement', source: 'calendar_provider', detail: '已受理' },
        });
        state = submitted.state;
      }
      if (state === 'submitted' || state === 'handed_off') {
        const confirmed = advance(ledger, requestId, 'confirmed', atMs, {
          receipt: {
            kind: 'readback',
            source: 'calendar_provider',
            detail: '已读回',
            observed: { eventId: requestId },
          },
        });
        state = confirmed.state;
      }

      // 现在尝试"取消"（改写成 failed）——终态保护应拒绝覆盖已确认的事实。
      const cancel = advance(ledger, requestId, 'failed', atMs, { failureKind: 'cancelled' });
      if (cancel.ok) {
        return record(finding('cancel_race', cancel.state, '取消竞态：取消已受理（动作尚未确认完成）。'));
      }
      return record(
        finding(
          'cancel_race',
          state,
          `取消竞态被拒（${cancel.problem ?? ''}）：已确认完成只能因外部废止失效，` +
            '**不**改写成"当初就取消"——已发生的事实被保留。',
        ),
      );
    },

    revokePermission(access, calendarId, need) {
      const check = checkCalendarAccess(access, calendarId, need);
      if (check.ok) {
        return record(
          finding('permission_revoked', 'prepared', `权限仍在：${calendarId} 的 ${need} 仍被允许（未撤回）。`),
        );
      }
      return record(
        finding(
          'permission_revoked',
          'failed',
          `权限撤回：${check.reason} ⇒ 后续写入/读取被拒（动作失败）。` +
            '**已确认完成的历史不被追溯否定**；真实 provider 撤回后的行为**未验证（需真机）**。',
        ),
      );
    },

    pendingCount() {
      return ledger.activeCount();
    },

    findings() {
      return [...log];
    },
  };
}
