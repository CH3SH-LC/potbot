/**
 * 状态流转的合法性检查（阶段流转 + 退款流转）。
 *
 * ## 阶段流转（线性部分）
 *
 * `placed(1) → paid(2) → merchant_accepted(3) → delivering(4) → completed(5)`
 *
 * - 前进一格：合法；
 * - 同阶段重报：幂等（`no_op`），合法——平台轮询会重复给同一状态；
 * - 回退：非法（状态不得倒退）；
 * - 跳级：非法（如 `placed → delivering`，中间态缺失，说明本地漏采或平台异常）；
 * - 终态（`completed` / `cancelled`）之后再变：非法；
 * - `cancelled` 可从任一非终态进入（取消是分支，不是线性后端）。
 *
 * `refund` **不是**线性阶段：退款走下面的独立检查。
 *
 * ## 退款流转
 *
 * `not_requested → applied → settled`（`applied → rejected` 亦合法）。
 * **`not_requested → settled` 非法**：没有「已申请」就不可能有「已到账」，
 * 这是本包最要紧的一条——它让「把已申请当成已到账」在本地就撞墙。
 */

import { IllegalTransitionError } from './errors.js';
import { LINEAR_STAGES, ORDER_STAGES } from './types.js';
import type {
  LinearStage,
  OrderLifecycleView,
  OrderStage,
  RefundState,
  RefundTransitionCheck,
  TransitionCheck,
  TransitionKind,
} from './types.js';

/** 线性阶段的推进序号。 */
const RANK: Readonly<Record<LinearStage, number>> = Object.freeze({
  placed: 1,
  paid: 2,
  merchant_accepted: 3,
  delivering: 4,
  completed: 5,
});

function isLinearStage(stage: OrderStage): stage is LinearStage {
  return (LINEAR_STAGES as readonly OrderStage[]).includes(stage);
}

function isKnownStage(value: string): value is OrderStage {
  return (ORDER_STAGES as readonly string[]).includes(value);
}

/**
 * 检查一次阶段流转是否合法。
 */
export function checkStageTransition(from: OrderStage, to: OrderStage): TransitionCheck {
  if (!isKnownStage(from) || !isKnownStage(to)) {
    return Object.freeze({ legal: false, kind: 'unknown_stage' as TransitionKind, detail: '不是已知阶段名' });
  }
  if (from === to) {
    return Object.freeze({ legal: true, kind: 'no_op' as TransitionKind, detail: '同一阶段重复报告（轮询常见），幂等接受' });
  }
  if (from === 'refund' || to === 'refund') {
    return Object.freeze({
      legal: false,
      kind: 'refund_separate' as TransitionKind,
      detail: '退款不是线性阶段流转，必须走 checkRefundTransition（已申请 / 已到账 / 被拒）',
    });
  }
  if (from === 'completed' || from === 'cancelled') {
    return Object.freeze({
      legal: false,
      kind: 'terminal' as TransitionKind,
      detail: `订单已是终态 ${from}，不得再变为 ${to}`,
    });
  }
  if (to === 'cancelled') {
    return Object.freeze({ legal: true, kind: 'forward' as TransitionKind, detail: `从 ${from} 取消（取消是分支，不算回退）` });
  }
  // 到这里 from / to 都是线性阶段。
  const fromRank = RANK[from as LinearStage];
  const toRank = RANK[to as LinearStage];
  if (toRank < fromRank) {
    return Object.freeze({
      legal: false,
      kind: 'backward' as TransitionKind,
      detail: `状态回退：${from}(${fromRank}) → ${to}(${toRank})`,
    });
  }
  if (toRank === fromRank + 1) {
    return Object.freeze({ legal: true, kind: 'forward' as TransitionKind, detail: `${from} → ${to}，线性前进一格` });
  }
  return Object.freeze({
    legal: false,
    kind: 'skip' as TransitionKind,
    detail: `跨越了中间阶段：${from}(${fromRank}) → ${to}(${toRank})，中间态缺失`,
  });
}

/** 同上，但非法即抛 {@link IllegalTransitionError}。 */
export function assertStageTransition(from: OrderStage, to: OrderStage): void {
  const check = checkStageTransition(from, to);
  if (!check.legal) {
    throw new IllegalTransitionError(check.kind, from, to, check.detail);
  }
}

/** 视图中线性阶段的最高名次（全部为 absent/unknown 时为 0）。 */
export function highestConfirmedRank(view: OrderLifecycleView): number {
  let best = 0;
  for (const stage of LINEAR_STAGES) {
    const report = view.stages.find((entry) => entry.stage === stage);
    if (report !== undefined && report.state === 'confirmed') {
      best = Math.max(best, RANK[stage]);
    }
  }
  return best;
}

/** 终态判定：`completed` 优先于 `cancelled`。 */
export function terminalStageOf(view: OrderLifecycleView): 'completed' | 'cancelled' | null {
  const stateOf = (stage: OrderStage): string | undefined =>
    view.stages.find((entry) => entry.stage === stage)?.state;
  if (stateOf('completed') === 'confirmed') return 'completed';
  if (stateOf('cancelled') === 'confirmed') return 'cancelled';
  return null;
}

/**
 * 检查两次观测之间的**推进**是否合法（同一 externalId 的前提下）。
 *
 * 用「线性最高名次」比较：名次不得下降；终态之后不得改变。
 * 跳级在一次观测里是允许的（平台可能一步跳到配送中），因此这里只查回退与终态。
 */
export function checkProgression(previous: OrderLifecycleView, next: OrderLifecycleView): TransitionCheck {
  if (previous.externalId !== next.externalId) {
    return Object.freeze({
      legal: false,
      kind: 'different_order' as TransitionKind,
      detail: `两次观测指向不同订单：${previous.externalId} vs ${next.externalId}`,
    });
  }
  const previousTerminal = terminalStageOf(previous);
  const nextTerminal = terminalStageOf(next);
  if (previousTerminal !== null && nextTerminal !== previousTerminal) {
    return Object.freeze({
      legal: false,
      kind: 'terminal' as TransitionKind,
      detail: `订单已处于终态 ${previousTerminal}，后续观测却给出 ${nextTerminal ?? '(非终态)'}`,
    });
  }
  const previousRank = highestConfirmedRank(previous);
  const nextRank = highestConfirmedRank(next);
  if (nextRank < previousRank) {
    return Object.freeze({
      legal: false,
      kind: 'backward' as TransitionKind,
      detail: `推进名次回退：先前 ${previousRank} → 现在 ${nextRank}（平台状态不得倒退）`,
    });
  }
  return Object.freeze({
    legal: true,
    kind: nextRank === previousRank ? ('no_op' as TransitionKind) : ('forward' as TransitionKind),
    detail: `推进名次 ${previousRank} → ${nextRank}`,
  });
}

/** 同上，但非法即抛 {@link IllegalTransitionError}。 */
export function assertProgression(previous: OrderLifecycleView, next: OrderLifecycleView): void {
  const check = checkProgression(previous, next);
  if (!check.legal) {
    throw new IllegalTransitionError(check.kind, previous.rawStatusCode, next.rawStatusCode, check.detail);
  }
}

/** 退款流转表：`from` → 允许到达的 `to` 集合。 */
const REFUND_TRANSITIONS: Readonly<Record<RefundState, readonly RefundState[]>> = Object.freeze({
  not_requested: Object.freeze(['applied', 'rejected', 'unknown'] as RefundState[]),
  // 已申请 → 已到账 / 被拒；不得回到「未发起」。
  applied: Object.freeze(['settled', 'rejected', 'unknown'] as RefundState[]),
  // 已到账 = 终态。
  settled: Object.freeze([] as RefundState[]),
  // 被拒可重新申请。
  rejected: Object.freeze(['applied', 'unknown'] as RefundState[]),
  // 未知状态不得被推定为任何确定状态。
  unknown: Object.freeze([] as RefundState[]),
});

/**
 * 检查一次退款状态流转是否合法。
 *
 * 最要紧的一条：`not_requested → settled` **非法**——没有「已申请」，
 * 就绝不能出现「已到账」。
 */
export function checkRefundTransition(from: RefundState, to: RefundState): RefundTransitionCheck {
  if (from === to) {
    return Object.freeze({ legal: true, kind: 'no_op', detail: `退款状态保持 ${from}（重复报告，幂等接受）` });
  }
  if (!(from in REFUND_TRANSITIONS)) {
    return Object.freeze({ legal: false, kind: 'illegal', detail: `未知的退款起始状态 ${String(from)}` });
  }
  const allowed = REFUND_TRANSITIONS[from];
  if (allowed.includes(to)) {
    return Object.freeze({ legal: true, kind: 'legal', detail: `退款状态 ${from} → ${to}` });
  }
  const hint =
    from === 'not_requested' && to === 'settled'
      ? '：没有「已申请」就不可能有「已到账」，不得把已申请显示成已到账'
      : from === 'settled'
        ? '：已到账是退款终态，不得再变'
        : from === 'unknown'
          ? '：未知状态不得被推定为任何确定状态'
          : '：不是允许的退款流转';
  return Object.freeze({ legal: false, kind: 'illegal', detail: `退款状态 ${from} → ${to} 非法${hint}` });
}

/** 同上，但非法即抛 {@link IllegalTransitionError}。 */
export function assertRefundTransition(from: RefundState, to: RefundState): void {
  const check = checkRefundTransition(from, to);
  if (!check.legal) {
    throw new IllegalTransitionError('unknown_stage', from, to, check.detail);
  }
}
