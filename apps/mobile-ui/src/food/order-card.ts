/**
 * F10 food / 订单卡 —— 消费 M09 七阶段视图与 M07 提交状态，**未付 / 未知 / 取消各自的态准确**。
 *
 * ## 为什么不能只有一个「状态」
 *
 * M09 把订单拆成七个阶段（下单 / 支付 / 商家接单 / 配送 / 完成 / 取消 / 退款）分别报告，
 * 且退款「已申请」与「已到账」是两个值。本卡做的事情是**把这七条收敛成一张卡的展示态**，
 * 但收敛规则必须让以下三件事各自可辨、且**互不冒充**：
 *
 * - **未付**：订单已创建、支付阶段未发生 ⇒ `payment: 'unpaid'`、`status: 'awaiting_payment'`；
 * - **未知**：状态码本地不认识 ⇒ `status: 'unknown'`、`isUnknown: true`，**任何阶段都不得显示为成功**；
 * - **取消**：取消阶段被平台确认 ⇒ `isCancelled: true`、`status: 'cancelled'`，且**不是**完成。
 *
 * 另外，「订单已下达」只有一个可声称的来源：M07 的 `mayClaimOrderPlaced`（仅 `confirmed`）。
 * 本卡不提供任何合并的 `success` 字段。
 */

import type {
  OrderLifecycleView,
  OrderStage,
  RefundReport,
  StageState,
} from '../../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import {
  ORDER_STATE_LABELS,
  isTerminalOrderState,
  mayClaimOrderPlaced,
  type OrderSubmissionState,
} from '../../../../src/mobile-plugins/meituan/order-submit/index.js';

import { toFoodMoneyView, type FoodMoneyView } from './money.js';
import type { FoodCardBase } from './types.js';

/** 支付阶段的三态（另加一个「未知」）。 */
export type FoodOrderPaymentState = 'unpaid' | 'paid' | 'failed' | 'unknown';

/** 订单卡总状态。 */
export type FoodOrderCardStatus =
  | 'awaiting_payment'
  | 'paid'
  | 'merchant_accepted'
  | 'delivering'
  | 'completed'
  | 'cancelled'
  | 'payment_failed'
  | 'unknown';

export interface FoodOrderStageView {
  readonly stage: OrderStage;
  readonly label: string;
  readonly state: StageState;
  readonly note: string;
  readonly sourceCode: string;
}

export interface FoodOrderCardView extends FoodCardBase {
  readonly kind: 'order';
  readonly externalId: string;
  readonly accountRef: string;
  readonly amount: FoodMoneyView;
  readonly status: FoodOrderCardStatus;
  readonly payment: FoodOrderPaymentState;
  /** 取消阶段被平台确认。 */
  readonly isCancelled: boolean;
  /** 状态码本地不认识（或支付阶段未知）⇒ 不得显示为成功。 */
  readonly isUnknown: boolean;
  /** 是否可声称「订单已下达」：只有 M07 `confirmed` 为真；本视图恒为 `false`。 */
  readonly placedClaimable: false;
  readonly stages: readonly FoodOrderStageView[];
  readonly refund: RefundReport;
  readonly observedAt: number;
  readonly evidenceRef: string;
  readonly statusRecognized: boolean;
  readonly summary: string;
}

const STAGE_LABEL: Readonly<Record<OrderStage, string>> = Object.freeze({
  placed: '下单',
  paid: '支付',
  merchant_accepted: '商家接单',
  delivering: '配送',
  completed: '完成',
  cancelled: '取消',
  refund: '退款',
});

const STATUS_LABEL: Readonly<Record<FoodOrderCardStatus, string>> = Object.freeze({
  awaiting_payment: '待支付',
  paid: '已支付',
  merchant_accepted: '商家已接单',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消',
  payment_failed: '支付失败',
  unknown: '状态未知',
});

function stageState(view: OrderLifecycleView, stage: OrderStage): StageState {
  return view.stages.find((entry) => entry.stage === stage)?.state ?? 'unknown';
}

function derivePaymentState(view: OrderLifecycleView): FoodOrderPaymentState {
  if (!view.statusRecognized) return 'unknown';
  const paid = stageState(view, 'paid');
  switch (paid) {
    case 'confirmed':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'absent':
      return 'unpaid';
    // pending / unknown 都不是「已付」，归为未知，绝不显示为已支付。
    case 'pending':
    case 'unknown':
      return 'unknown';
  }
}

function deriveStatus(view: OrderLifecycleView): FoodOrderCardStatus {
  if (!view.statusRecognized) return 'unknown';
  const cancelled = stageState(view, 'cancelled');
  if (cancelled === 'confirmed') return 'cancelled';
  const paid = stageState(view, 'paid');
  if (paid === 'failed') return 'payment_failed';
  if (stageState(view, 'completed') === 'confirmed') return 'completed';
  if (stageState(view, 'delivering') === 'confirmed') return 'delivering';
  if (stageState(view, 'merchant_accepted') === 'confirmed') return 'merchant_accepted';
  if (paid === 'confirmed') return 'paid';
  if (stageState(view, 'placed') === 'confirmed') return 'awaiting_payment';
  return 'unknown';
}

/** 由 M09 七阶段视图构造订单卡。 */
export function buildOrderCardFromLifecycle(view: OrderLifecycleView): FoodOrderCardView {
  const payment = derivePaymentState(view);
  const status = deriveStatus(view);
  const isCancelled = status === 'cancelled';
  const isUnknown = status === 'unknown' || payment === 'unknown';

  const stages: FoodOrderStageView[] = view.stages.map((entry) =>
    Object.freeze({
      stage: entry.stage,
      label: STAGE_LABEL[entry.stage],
      state: entry.state,
      note: entry.note,
      sourceCode: entry.sourceCode,
    }),
  );

  const summary = [
    STATUS_LABEL[status],
    `支付：${payment === 'paid' ? '已支付' : payment === 'unpaid' ? '未支付' : payment === 'failed' ? '失败' : '未知'}`,
    view.refund.state === 'not_requested' ? '未发起退款' : `退款：${view.refund.state}`,
  ].join(' · ');

  return Object.freeze({
    kind: 'order',
    title: `订单 ${view.externalId}`,
    externalId: view.externalId,
    accountRef: view.accountRef,
    amount: toFoodMoneyView(view.amountMinor, view.currency),
    status,
    payment,
    isCancelled,
    isUnknown,
    // 本卡从生命周期查询得出，**不**携带平台可信下单回执 ⇒ 恒不可声称已下达。
    placedClaimable: false,
    stages: Object.freeze(stages),
    refund: view.refund,
    observedAt: view.observedAt,
    evidenceRef: view.evidenceRef,
    statusRecognized: view.statusRecognized,
    summary,
  });
}

// ---------------------------------------------------------------------------
// M07 提交状态 → 卡片展示
// ---------------------------------------------------------------------------

export interface FoodOrderSubmitView {
  readonly kind: 'order-submit';
  readonly state: OrderSubmissionState;
  readonly label: string;
  /** 是否可声称订单已下达：只有 M07 `confirmed` 为真。 */
  readonly placedClaimable: boolean;
  /** 结果未知 ⇒ 唯一合法后续是查原单，不得重下。 */
  readonly needsQuery: boolean;
  readonly terminal: boolean;
  readonly summary: string;
}

/** 由 M07 提交状态构造展示视图（不合并、不冒充成功）。 */
export function buildOrderSubmitView(state: OrderSubmissionState): FoodOrderSubmitView {
  const placedClaimable = mayClaimOrderPlaced(state);
  const needsQuery = state === 'unknown';
  const terminal = isTerminalOrderState(state);
  return Object.freeze({
    kind: 'order-submit',
    state,
    label: ORDER_STATE_LABELS[state],
    placedClaimable,
    needsQuery,
    terminal,
    summary: `${ORDER_STATE_LABELS[state]}（${placedClaimable ? '可声称已下单' : '不可声称已下单'}）`,
  });
}
