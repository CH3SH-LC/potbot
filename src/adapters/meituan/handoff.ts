/**
 * 目标页**交接**与"**不直接购买/支付**"（MT-07 / MT-08；合同 R242 / R246）。
 *
 * ## 三条硬约束（都落在代码路径上，不只是注释）
 *
 * 1. **打开页面不等于写入**（R246）：{@link handoffToTarget} 成功时最高状态是
 *    `handed_off`（已交接），**永不**返回 `confirmed`。
 * 2. **外部最终结果不可读 ⇒ 保留未知**（MT-08）：{@link recordExternalOutcome}
 *    在无法读回时给 `unknown`，**不**记为购买成功，也**不**触发盲目重试（R217）。
 * 3. **不直接购买/支付**（MT-08 / R246）：本模块没有、也不接受任何支付类动作
 *    （见 `contract.ts` 的 {@link ./contract.js} `assertNotPurchaseAction`）。
 */

import {
  assertTransition,
  type ActionReceipt,
  type ActionState,
} from '../clock/action-contract.js';

export interface HandoffTarget {
  readonly kind: 'deeplink' | 'app_scheme';
  readonly uri: string;
  readonly candidateId: string;
  /** 生成该目标时的**选择版本**（MT-07：参数与当前选择绑定）。 */
  readonly selectionRevision: number;
  /** 失效时刻；null = 不过期。 */
  readonly expiresAtMs: number | null;
}

export interface TargetCheck {
  readonly appInstalled: boolean;
  readonly linkValid: boolean;
  readonly targetMatches: boolean;
}

export type HandoffReadiness =
  | { readonly kind: 'ready'; readonly target: HandoffTarget }
  | {
      readonly kind: 'failure';
      readonly code: 'app_not_installed' | 'link_expired' | 'target_mismatch' | 'stale_selection';
      readonly reason: string;
    };

/**
 * 交接前的**校验**（MT-07：App 未安装 / 链接过期 / 目标不符**分别处理**）。
 * 四种失败各有独立 code，不合并成一个笼统的"失败"。
 */
export function classifyHandoffTarget(
  target: HandoffTarget,
  check: TargetCheck,
  currentSelectionRevision: number,
  nowMs: number,
): HandoffReadiness {
  if (target.selectionRevision !== currentSelectionRevision) {
    return {
      kind: 'failure',
      code: 'stale_selection',
      reason:
        `交接参数绑定在版本 ${String(target.selectionRevision)}，当前选择已是 ` +
        `${String(currentSelectionRevision)}：该气泡已过期，必须重新生成目标（MT-07）。`,
    };
  }
  if (!check.linkValid || (target.expiresAtMs !== null && nowMs > target.expiresAtMs)) {
    return {
      kind: 'failure',
      code: 'link_expired',
      reason: '目标链接无效或已过期：应重新获取受控链接，而不是打开一个可能的旧页面。',
    };
  }
  if (!check.appInstalled) {
    return {
      kind: 'failure',
      code: 'app_not_installed',
      reason: '目标 App 未安装：不能声称已交接；应提供网页回退或提示用户安装。',
    };
  }
  if (!check.targetMatches) {
    return {
      kind: 'failure',
      code: 'target_mismatch',
      reason: '链接指向的目标与当前选择不符：拒绝交接，避免把用户带到错误的页面。',
    };
  }
  return { kind: 'ready', target };
}

export interface MeituanHandoffPort {
  open(uri: string): Promise<{
    readonly delivered: boolean;
    readonly handlerLabel: string | null;
    readonly detail: string;
  }>;
}

export interface HandoffResult {
  readonly state: ActionState;
  readonly receipt: ActionReceipt;
  readonly notes: readonly string[];
}

/**
 * 执行交接。**永不返回 `confirmed`**：目标页交接没有可信回执（R246）。
 */
export async function handoffToTarget(
  port: MeituanHandoffPort,
  readiness: HandoffReadiness,
): Promise<HandoffResult> {
  if (readiness.kind === 'failure') {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'rejected' });
    return {
      state: transition.to,
      receipt: { kind: 'none', source: 'meituan_handoff', detail: readiness.reason },
      notes: [readiness.reason, `失败分类：${readiness.code}`],
    };
  }

  const outcome = await port.open(readiness.target.uri);
  if (!outcome.delivered) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'error' });
    return {
      state: transition.to,
      receipt: { kind: 'none', source: 'meituan_handoff', detail: outcome.detail },
      notes: [outcome.detail],
    };
  }

  const transition = assertTransition('prepared', 'handed_off');
  return {
    state: transition.to,
    receipt: {
      kind: 'none',
      source: outcome.handlerLabel ?? 'meituan_target_app',
      detail: outcome.detail,
    },
    notes: [
      '已把参数交接给目标页面。**打开页面不等于写入**，更不等于下单成功（R246）。',
      '我们**没有**该页面的可信回执：在用户或外部系统给出证据前，最高状态就是"已交接"。',
    ],
  };
}

/** 用户返回后发现的外部结果（可读 / 不可读）。 */
export type ExternalOutcome =
  | { readonly readable: true; readonly detail: string; readonly observed: Readonly<Record<string, string>> }
  | { readonly readable: false; readonly detail: string };

/**
 * 依据外部结果结算状态。
 *
 * - 可读且**有具体观测** ⇒ `confirmed`（唯一能到达该状态的路径，且要求 readback 回执）；
 * - 不可读 ⇒ `unknown`（**保留未知**，不记为购买成功，也不盲目重试）。
 */
export function recordExternalOutcome(
  from: ActionState,
  outcome: ExternalOutcome,
): HandoffResult {
  if (outcome.readable) {
    const transition = assertTransition(from, 'confirmed', {
      receipt: {
        kind: 'readback',
        source: 'meituan_external',
        detail: outcome.detail,
        observed: outcome.observed,
      },
    });
    return {
      state: transition.to,
      receipt: transition.receipt,
      notes: ['外部结果**可读回**且与意图一致，才记为"已确认完成"。'],
    };
  }
  const transition = assertTransition(from, 'unknown');
  return {
    state: transition.to,
    receipt: { kind: 'none', source: 'meituan_external', detail: outcome.detail },
    notes: [
      '外部结果**不可读** ⇒ 保留「结果未知」：不记为购买成功，也不盲目重试（MT-08 / R217）。',
    ],
  };
}

/** 用户口头说"已完成" ⇒ 记为 `user_reported`，**不**升级为系统确认。 */
export function recordUserReport(from: ActionState, userWords: string): HandoffResult {
  const transition = assertTransition(from, 'user_reported');
  return {
    state: transition.to,
    receipt: { kind: 'none', source: 'user_report', detail: userWords },
    notes: ['用户报告完成**不是**系统回执：展示时必须标明证据级别（R242）。'],
  };
}

/** 外部后续被废止（如订单被取消）⇒ 从已确认走到 failed，且**只能**以 expired 为由。 */
export function recordExternalInvalidation(from: ActionState, detail: string): HandoffResult {
  const transition = assertTransition(from, 'failed', { failureKind: 'expired' });
  return {
    state: transition.to,
    receipt: { kind: 'none', source: 'meituan_external', detail },
    notes: ['已确认完成的事实在外部被废止：保留历史，标为"已失效"（R242）。'],
  };
}
