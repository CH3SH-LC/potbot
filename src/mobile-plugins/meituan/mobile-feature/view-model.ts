/**
 * M10 旅程 ViewModel —— 供前端（F 线）渲染的**只读、诚实**的聚合视图。
 *
 * ## 纪律
 *
 * - **没有合并的 ok**：每一步各自带 `status` 与原因；"整体成功"不是一个字段。
 * - **只有 `submission.state === 'confirmed'` 才 `placedClaimable === true`**；
 *   `submitted`（平台说受理了）与 `unknown` 一律 false——与 M07 同口径。
 * - **`canPay` 恒为字面量 `false`**：本包没有支付通道（支付归 M08 + 用户）。
 * - **`canSubmit` 由工具暴露决定**：若 `cap.meituan.submitOrder` 在该能力矩阵下是
 *   `blocked`，即便参数齐全也 `canSubmit === false`。这把"工具按实际 scope 暴露"传导到 UI。
 *
 * ## 输入从哪来
 *
 * 每一步的输入都是**已经算好的**模型输出（M04 报价、M05 地址解析、M07 提交记录、
 * M09 生命周期观测量）。本模块**不重算价格、不重新判定订单**，只做聚合与可读化。
 */

import type { ExposedTool } from './types.js';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface StoreView {
  readonly merchantId: string;
  readonly name: string;
  /** 候选来源引用（脱敏）：候选必须能指回来源。 */
  readonly sourceRef: string;
}

export interface CartLineView {
  readonly lineId: string;
  readonly dishName: string;
  readonly skuLabel: string;
  readonly quantity: number;
}

export interface QuoteView {
  readonly quoteRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt: number;
  /** 报价失效原因；`null` = 当前有效。 */
  readonly staleReason: string | null;
}

export interface ConfirmationView {
  readonly actionId: string;
  readonly paramsDigest: string;
  readonly authorization: 'draft' | 'authorized' | 'expired' | 'consumed';
}

export interface SubmissionView {
  readonly state: 'submitting' | 'submitted' | 'rejected' | 'unknown' | 'confirmed' | 'cancelled';
  readonly externalOrderId: string | null;
}

export interface OrderTrackingView {
  readonly externalId: string;
  readonly statusRecognized: boolean;
  /** 七阶段观测量（名称 + 状态），分别报告。 */
  readonly stages: readonly { readonly name: string; readonly state: string }[];
}

export interface AddressResolutionView {
  readonly status: 'ready' | 'needs_explicit_selection' | 'invalid_selection';
  readonly addressRef: string | null;
}

export interface JourneyViewModelInput {
  readonly tools: readonly ExposedTool[];
  readonly store: StoreView | null;
  readonly cart: readonly CartLineView[];
  readonly address: AddressResolutionView | null;
  readonly quote: QuoteView | null;
  readonly confirmation: ConfirmationView | null;
  readonly submission: SubmissionView | null;
  readonly tracking: OrderTrackingView | null;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export const VIEW_STEPS = [
  'scope',
  'store',
  'menu',
  'cart',
  'address',
  'quote',
  'confirm',
  'submit',
  'track',
] as const;
export type ViewStep = (typeof VIEW_STEPS)[number];

export const STEP_STATUSES = ['todo', 'active', 'done', 'blocked', 'stale'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface JourneyStepView {
  readonly step: ViewStep;
  readonly label: string;
  readonly status: StepStatus;
  readonly detail: string;
}

export interface JourneyViewModel {
  readonly steps: readonly JourneyStepView[];
  readonly quoteAmountMinor: number | null;
  readonly quoteCurrency: string | null;
  readonly canSubmit: boolean;
  /** 恒为 `false`：本包没有支付通道。 */
  readonly canPay: false;
  /** 只有提交状态为 `confirmed` 才为 `true`。 */
  readonly placedClaimable: boolean;
  readonly blockedReason: string | null;
  readonly notes: readonly string[];
}

const STEP_LABELS: Readonly<Record<ViewStep, string>> = Object.freeze({
  scope: '能力核实',
  store: '选店',
  menu: '选餐',
  cart: '购物车',
  address: '地址与配送',
  quote: '报价',
  confirm: '确认',
  submit: '提交下单',
  track: '订单跟踪',
});

function submitToolExposed(tools: readonly ExposedTool[]): boolean {
  const tool = tools.find((entry) => entry.toolId === 'cap.meituan.submitOrder');
  return tool?.exposure === 'enabled';
}

function step(stepName: ViewStep, status: StepStatus, detail: string): JourneyStepView {
  return Object.freeze({ step: stepName, label: STEP_LABELS[stepName], status, detail });
}

/**
 * 构建旅程视图模型。所有 `status` 都由输入**确定性地**导出，不含随机/时间推导
 * （除了报价是否过期用注入的 `now` 比较 `expiresAt`）。
 */
export function buildJourneyViewModel(input: JourneyViewModelInput): JourneyViewModel {
  const notes: string[] = [];
  const steps: JourneyStepView[] = [];

  // 1. scope
  const blockedTools = input.tools.filter((tool) => tool.exposure === 'blocked');
  const submitExposed = submitToolExposed(input.tools);
  if (blockedTools.length > 0) {
    notes.push(`${blockedTools.length} 个工具因 scope 未核实/被拒而未暴露`);
    steps.push(step('scope', 'active', `${blockedTools.length} 个工具待核实/被拒：${blockedTools.map((t) => t.toolId).join('、')}`));
  } else {
    steps.push(step('scope', 'done', '全部能力已核实'));
  }

  // 2. store
  steps.push(
    input.store === null
      ? step('store', 'active', '尚未选店')
      : step('store', 'done', `已选店：${input.store.name}（来源 ${input.store.sourceRef}）`),
  );

  // 3. menu
  steps.push(
    input.store === null
      ? step('menu', 'todo', '选店后才可看菜单')
      : step('menu', 'done', '菜单已读取（具体菜品见 cart）'),
  );

  // 4. cart
  steps.push(
    input.cart.length === 0
      ? step('cart', 'todo', '购物车为空')
      : step('cart', 'done', `购物车 ${input.cart.length} 条：${input.cart.map((line) => `${line.dishName}×${line.quantity}`).join('、')}`),
  );

  // 5. address
  if (input.address === null) {
    steps.push(step('address', 'todo', '尚未解析收货地址'));
  } else if (input.address.status === 'ready') {
    steps.push(step('address', 'done', `地址就绪：${input.address.addressRef ?? '(无引用)'}`));
  } else if (input.address.status === 'needs_explicit_selection') {
    steps.push(step('address', 'active', '需要用户显式选择地址（不自动替换）'));
  } else {
    steps.push(step('address', 'blocked', '显式选择的地址不存在，请重新选择'));
  }

  // 6. quote
  let quoteBlocked = false;
  if (input.quote === null) {
    steps.push(step('quote', 'todo', '尚未取价'));
  } else if (input.quote.staleReason !== null) {
    quoteBlocked = true;
    steps.push(step('quote', 'stale', `报价失效：${input.quote.staleReason}`));
  } else if (input.now >= input.quote.expiresAt) {
    quoteBlocked = true;
    steps.push(step('quote', 'stale', '报价已过期（注入时钟）'));
  } else {
    steps.push(step('quote', 'done', `报价有效：${input.quote.amountMinor} ${input.quote.currency}`));
  }

  // 7. confirm
  let confirmBlocked = false;
  if (input.confirmation === null) {
    steps.push(step('confirm', 'todo', '尚未生成待确认参数'));
  } else if (input.confirmation.authorization === 'authorized') {
    steps.push(step('confirm', 'done', `用户已确认（action ${input.confirmation.actionId}）`));
  } else if (input.confirmation.authorization === 'draft') {
    steps.push(step('confirm', 'active', '等待用户本次真实确认'));
    confirmBlocked = true;
  } else {
    steps.push(step('confirm', 'stale', `确认不可用：授权 ${input.confirmation.authorization}`));
    confirmBlocked = true;
  }

  // 8. submit
  if (!submitExposed) {
    steps.push(step('submit', 'blocked', '提交工具因 scope 未核实/被拒而未暴露'));
  } else if (input.submission === null) {
    steps.push(step('submit', 'todo', quoteBlocked || confirmBlocked ? '上游未就绪' : '待提交'));
  } else if (input.submission.state === 'confirmed') {
    steps.push(step('submit', 'done', `已确认下单：${input.submission.externalOrderId ?? '(无单号)'}`));
  } else if (input.submission.state === 'unknown') {
    steps.push(step('submit', 'stale', '提交结果未知：只能查原单，不得重放'));
  } else if (input.submission.state === 'rejected' || input.submission.state === 'cancelled') {
    steps.push(step('submit', 'blocked', `提交${input.submission.state === 'rejected' ? '被拒' : '已取消'}`));
  } else {
    steps.push(step('submit', 'active', `提交中：${input.submission.state}`));
  }

  // 9. track
  if (input.tracking === null) {
    steps.push(step('track', 'todo', '尚无订单可跟踪'));
  } else if (!input.tracking.statusRecognized) {
    steps.push(step('track', 'stale', '平台状态码未识别——全部按 unknown 上报'));
  } else {
    steps.push(
      step('track', 'done', `跟踪 ${input.tracking.externalId}：${input.tracking.stages.length} 个阶段`),
    );
  }

  const placedClaimable = input.submission?.state === 'confirmed';
  const canSubmit =
    submitExposed &&
    !quoteBlocked &&
    !confirmBlocked &&
    input.quote !== null &&
    input.confirmation?.authorization === 'authorized' &&
    (input.submission === null ||
      input.submission.state === 'rejected' ||
      input.submission.state === 'cancelled');

  let blockedReason: string | null = null;
  if (!submitExposed) {
    blockedReason = '提交工具未暴露（scope 未核实/被拒）';
  } else if (quoteBlocked) {
    blockedReason = '报价失效或过期';
  } else if (confirmBlocked) {
    blockedReason = '等待用户本次确认';
  }

  return Object.freeze({
    steps: Object.freeze(steps),
    quoteAmountMinor: input.quote?.amountMinor ?? null,
    quoteCurrency: input.quote?.currency ?? null,
    canSubmit,
    canPay: false,
    placedClaimable,
    blockedReason,
    notes: Object.freeze(notes),
  });
}
