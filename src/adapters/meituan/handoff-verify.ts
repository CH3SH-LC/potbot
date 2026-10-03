/**
 * MT-07 / MT-08：目标页面交接的**生成、校验与结算**（在 `handoff.ts` 之上的编排层）。
 *
 * ## 生成端：链接必须来自**受控 / 已核实**来源
 *
 * {@link generateHandoffBubble} **必须**注入 {@link HandoffLinkPort}。没有受控链接来源时
 * 结果结构化标 `not_ready`、`bubble === null`——**不**拼一个 `meituan://` 前缀冒充深链。
 *
 * ## 参数与**当前选择**绑定
 *
 * 气泡生成时把 `selection.revision` 写进目标；{@link verifyAndHandoff} 再拿
 * `currentSelection.revision` 复核。两者不一致 ⇒ 气泡已过期（`stale_selection`），
 * **不触碰外部**、也不重新打开旧页面。
 *
 * ## 四种失败**分别处理**（MT-07）
 *
 * `app_not_installed` / `link_expired` / `target_mismatch` / `stale_selection`
 * 各有独立 code（分类逻辑复用 `handoff.ts`），不合并成一个笼统的"失败"。
 *
 * ## 重复点击与返回（MT-08）
 *
 * 重复点击由动作台账（`requestId` 幂等键）挡下：第二次点击**不重新打开**外部页面，
 * 直接复用既有条目。用户从外部返回后由 {@link settleOnReturn} 结算：
 * **外部结果不可读 ⇒ 结果未知**，`purchase_confirmed` **恒为 false**——
 * 交接**永不**被记成购买成功。
 *
 * ## 不直接购买 / 支付（MT-08 / R246）
 *
 * 本模块在入口调用 `assertNotPurchaseAction`：任何把动作名写成 `pay`/`purchase`/`下单`
 * 的改动都会当场抛出；且本模块没有任何支付类端口的入参。
 */

import { createActionLedger, type ActionLedger, type ActionState } from '../clock/action-contract.js';
// I-5：默认台账改为**版本敏感**——同 requestId、不同 revision 不是同一动作（R213）。
// 权威推导在 workledger（`deriveClockLedgerKey`），此处只**注入**，不另立算法。
import { versionAwareClockLedgerOptions } from '../../workledger/action-state-alignment.js';
import { assertNotPurchaseAction, externalResultWithoutReadback } from './contract.js';
import {
  classifyHandoffTarget,
  handoffToTarget,
  recordExternalOutcome,
  type ExternalOutcome,
  type HandoffReadiness,
  type HandoffResult,
  type HandoffTarget,
  type MeituanHandoffPort,
  type TargetCheck,
} from './handoff.js';

/** 当前选择（候选 + 版本）。 */
export interface SelectionState {
  readonly candidateId: string;
  readonly revision: number;
}

/** 受控 / 已核实的链接来源。未装配为 null —— 那时不产出任何交接目标。 */
export interface HandoffLinkPort {
  readonly sourceId: string;
  buildTarget(selection: SelectionState): Promise<
    | { readonly ok: true; readonly kind: 'deeplink' | 'app_scheme'; readonly uri: string; readonly expiresAtMs: number | null }
    | { readonly ok: false; readonly reason: string }
  >;
}

/** 决策气泡（携带生成时的选择快照）。 */
export interface HandoffBubble {
  readonly bubbleId: string;
  readonly selection: SelectionState;
  readonly target: HandoffTarget;
}

export type BubbleGeneration =
  | { readonly status: 'ok'; readonly bubble: HandoffBubble }
  | { readonly status: 'not_ready' | 'unavailable'; readonly reason: string; readonly bubble: null };

const LINK_NOT_READY =
  '未接通受控 / 已核实的链接来源（MT-07 未就绪）：**不**自造 `meituan://` 深链冒充，' +
  '也不把未经核实的网址当作目标页面。';

/**
 * 生成交接气泡。目标参数**构造即绑定**到 `selection`：
 * `candidateId` 与 `revision` 不一致时**当场抛错**，不产出错绑的气泡。
 */
export async function generateHandoffBubble(
  linkSource: HandoffLinkPort | null,
  selection: SelectionState,
  bubbleId: string,
): Promise<BubbleGeneration> {
  if (linkSource === null) {
    return { status: 'not_ready', reason: LINK_NOT_READY, bubble: null };
  }

  const built = await linkSource.buildTarget(selection);
  if (!built.ok) {
    return { status: 'unavailable', reason: `受控链接来源未能返回目标：${built.reason}`, bubble: null };
  }

  const target: HandoffTarget = {
    kind: built.kind,
    uri: built.uri,
    candidateId: selection.candidateId,
    selectionRevision: selection.revision,
    expiresAtMs: built.expiresAtMs,
  };
  return { status: 'ok', bubble: { bubbleId, selection, target } };
}

/** 参数绑定自检：目标必须与生成时的选择逐项一致。 */
export function assertTargetBoundToSelection(bubble: HandoffBubble): void {
  if (bubble.target.candidateId !== bubble.selection.candidateId) {
    throw new Error(
      `交接目标绑定到候选「${bubble.target.candidateId}」，气泡却属于「${bubble.selection.candidateId}」：` +
        '参数与当前选择不一致，拒绝使用（MT-07）。',
    );
  }
  if (bubble.target.selectionRevision !== bubble.selection.revision) {
    throw new Error(
      `交接目标绑定在选择版本 ${String(bubble.target.selectionRevision)}，` +
        `气泡记录的是 ${String(bubble.selection.revision)}：绑定不一致（MT-07）。`,
    );
  }
}

export interface HandoffAttempt {
  readonly bubble: HandoffBubble;
  /** 点击这一刻的当前选择（可能与气泡生成时不同 ⇒ 气泡过期）。 */
  readonly currentSelection: SelectionState;
  readonly check: TargetCheck;
  readonly nowMs: number;
}

export interface HandoffVerification {
  /** 交接前校验结果；仅"返回后结算"（无新的对外动作）时为 null。 */
  readonly readiness: HandoffReadiness | null;
  readonly result: HandoffResult | null;
  /** 重复点击：为 true 时**没有**再次打开外部页面。 */
  readonly duplicate: boolean;
  /** 台账里该请求的最终状态；未执行（重复/未就绪）时沿用既有条目状态。 */
  readonly state: ActionState | null;
  /**
   * **恒为 false**：交接**永不**记为购买成功（MT-08 / R246）。
   * 写成字面量类型，使"把交接当购买完成"在类型层面不成立。
   */
  readonly purchase_confirmed: false;
  readonly notes: readonly string[];
}

/** 交接动作名（**必须**不是购买/支付类；由 assertNotPurchaseAction 把关）。 */
export const HANDOFF_ACTION_NAME = 'handoff';

/**
 * **生产默认台账**（{@link verifyAndHandoff} 未显式传 `ledger` 时使用的那一个）。
 *
 * I-5：注入**版本敏感**的幂等键推导 ⇒ 同 `requestId`、不同 `revision` 视为**两个动作**
 * （R213「旧版本动作不得被复用」），而不是旧口径下"命中旧条目"。
 *
 * 独立拎成具名工厂，是为了让这条**生产配置**可被**直接观测/复现**（测试拿它跑对照），
 * 而不是藏在默认参数里无法取值。语义与 `createActionLedger(versionAwareClockLedgerOptions())`
 * 逐字段一致。
 *
 * ⚠️ 如实说明：本模块自造的 `requestId` **已含** `selection.revision`
 * （`${bubbleId}:${revision}`），因此这里的注入是**纵深防御**——即便日后调用方改用
 * 不含版本的 requestId，也不会退回"版本盲判"。
 */
export function createHandoffLedger(): ActionLedger {
  return createActionLedger(versionAwareClockLedgerOptions());
}

/**
 * 校验并执行一次交接。
 *
 * 顺序（每一步都可能**提前退出**，且都留下可读原因）：
 * 1. 动作名过购买闸；
 * 2. 气泡过期（选择版本或候选变了）⇒ `stale_selection`，**不触碰外部**；
 * 3. 重复点击（台账命中）⇒ 直接返回既有条目，**不重新打开**；
 * 4. 目标校验（App 未安装 / 链接过期 / 目标不符）⇒ 分类失败；
 * 5. 全部通过 ⇒ 打开目标页面，最高状态 `handed_off`。
 */
export async function verifyAndHandoff(
  port: MeituanHandoffPort,
  attempt: HandoffAttempt,
  // I-5 生产接线：默认台账带**版本敏感**的幂等键推导（显式传 ledger 的调用方不受影响）。
  ledger: ActionLedger = createHandoffLedger(),
): Promise<HandoffVerification> {
  // 1. 购买/支付闸：任何支付类动作名在此抛出。
  assertNotPurchaseAction(HANDOFF_ACTION_NAME);
  assertTargetBoundToSelection(attempt.bubble);

  const requestId = `${attempt.bubble.bubbleId}:${String(attempt.bubble.selection.revision)}`;
  const request = { requestId, toolId: 'cap.meituan.handoff', revision: attempt.bubble.selection.revision };
  const begun = ledger.begin(request, attempt.nowMs);

  // 3. 重复点击：台账已记过 ⇒ 不重新打开。
  if (begun.duplicate) {
    return {
      // 重复点击**不**走校验、也不打开外部：没有新的对外动作，故 readiness 为 null。
      readiness: null,
      result: null,
      duplicate: true,
      state: begun.entry.state,
      purchase_confirmed: false,
      notes: [
        '检测到**重复点击**（同一 requestId）：复用既有动作条目，**不重新打开**外部页面（MT-08 / R243）。',
      ],
    };
  }

  // 2. 气泡过期：气泡的选择快照与当前选择不一致。
  if (
    attempt.bubble.selection.revision !== attempt.currentSelection.revision ||
    attempt.bubble.selection.candidateId !== attempt.currentSelection.candidateId
  ) {
    ledger.settle(requestId, 'failed', attempt.nowMs);
    return {
      readiness: {
        kind: 'failure',
        code: 'stale_selection',
        reason:
          '气泡已过期（选择已变）：该气泡的参数绑定在旧版本，**不**打开旧页面，请按新选择重新生成（MT-07 / MT-08）。',
      },
      result: null,
      duplicate: false,
      state: 'failed',
      purchase_confirmed: false,
      notes: ['气泡过期：未触碰外部，也未把过期气泡记成链接失效（两者原因不同）。'],
    };
  }

  // 4. 目标校验：四种失败分类复用 handoff.ts。
  const readiness = classifyHandoffTarget(
    attempt.bubble.target,
    attempt.check,
    attempt.currentSelection.revision,
    attempt.nowMs,
  );

  // 5. 执行（含失败分支）。
  const result = await handoffToTarget(port, readiness);
  ledger.settle(requestId, result.state, attempt.nowMs);

  return {
    readiness,
    result,
    duplicate: false,
    state: result.state,
    purchase_confirmed: false,
    notes: [
      ...result.notes,
      '交接的最高状态是「已交接」：**打开页面不等于下单成功**（MT-08 / R246）。',
    ],
  };
}

/** 用户从目标页面**返回**后的结算：外部结果不可读 ⇒ 结果未知（不记为购买成功）。 */
export function settleOnReturn(from: ActionState, outcome: ExternalOutcome): HandoffVerification {
  const result = recordExternalOutcome(from, outcome);
  const notes = [...result.notes, '返回后按外部可读性结算；不可读时保留「结果未知」，**不**记为购买成功。'];
  if (!outcome.readable) {
    notes.push(externalResultWithoutReadback().note);
  }
  return {
    readiness: null,
    result,
    duplicate: false,
    state: result.state,
    purchase_confirmed: false,
    notes,
  };
}
