/**
 * M08×M09 桥接：**支付回跳 → 订单生命周期 resumeAfterDisconnect（query-first）→ paid 阶段报告**。
 *
 * ## 这条桥要关掉的洞
 *
 * M09 的接线请求（M09 integrationRequests 第 3 条）与 M08 的 nextIncrement 都写到同一件事：
 * 「支付回跳只触发状态查询，**不得**假设支付成功」。本模块把这件事落成一条真实调用链，
 * 而不是一句约定：
 *
 * 1. 收到支付回跳（{@link PaymentCallback}）⇒ 先 `PaymentTracker.handleReturn`，
 *    只推进到 `callback_pending_verification`（回跳**不是**付款证据）；
 * 2. **随后用原单 externalId 调 M09 `OrderLifecycleTracker.resumeAfterDisconnect(port)`**
 *    —— 这是 query-first：断线/回跳后先查原单，绝不凭回跳或金额猜一单、也绝不重下；
 * 3. 只有再经 `PaymentTracker.refresh(paymentPort)` 拿到**受控签发**且**逐项匹配**的
 *    `PaymentReadback.paidState === 'paid'` 才可能进入 `confirmed_paid`；
 * 4. 把 `confirmed_paid` **接到** M09 的 `paid` 阶段报告
 *    （{@link buildPaidStageReport}）：只有 `confirmed_paid` 才产出 `stage: 'paid' / state: 'confirmed'`。
 *
 * ## 为什么 paid 阶段由**支付读回**驱动，而不是由回跳驱动
 *
 * 回跳 URL 是用户可见、可伪造的字符串；订单查询结果虽来自平台，但它表达的是
 * 「订单到了哪一步」，**不**等于「我方那笔支付已被平台读回确认收款」。因此本桥的
 * `paid` 阶段报告只在 `payment.state === 'confirmed_paid'` 时为 `confirmed`：
 * - 回跳后**未读回** ⇒ `pending`（`needsStatusQuery` 仍为 true），**绝不** `confirmed`；
 * - 订单状态码显示已支付、但支付侧尚未读回 ⇒ 仍记为 `pending`，并把两侧是否一致
 *   如实写进 `consistentWithLifecycle` / `note`（`false`），而不是替它圆场成已付款。
 *
 * ## 边界（与 M08 一致，不放松）
 *
 * - **只读依赖 M09**：本模块 import `../order-lifecycle/`，不修改其任何文件，不重下、不提交；
 * - **零网络、零凭据**：端口一律注入；桥不收集、不构造任何银行卡 / 验证码 / PIN 字段；
 *   桥自己构造的查询请求（订单查询、支付读回）都会被 `assertNoCredentialFields` 复核；
 * - **spread-copy 读回/交接一律拒**：桥不绕过 M08 的受控签发判据；把读回或交接展开拷贝
 *   （`{ ...readback }` / `{ ...handoff }`）再喂进来会被 `untrusted_payment_readback` /
 *   `untrusted_payment_handoff` 挡下（由 M08 原判据负责，桥不新增旁路）。
 */

import { PaymentError } from './errors.js';
import { assertNoCredentialFields } from './sensitive.js';
import type { PaymentTracker } from './tracker.js';
import type {
  PaymentCallback,
  PaymentHandoff,
  PaymentQueryPort,
  PaymentState,
  PaymentView,
} from './types.js';

import { stageReport } from '../order-lifecycle/status-map.js';
import type { OrderLifecycleTracker } from '../order-lifecycle/lifecycle.js';
import type {
  OrderIntent,
  OrderLifecycleView,
  OrderQueryPort,
  OrderQueryRequest,
  StageReport,
  StageState,
} from '../order-lifecycle/index.js';

// ---------------------------------------------------------------------------
// paid 阶段报告
// ---------------------------------------------------------------------------

/**
 * 支付态 → M09 paid 阶段态。**只有 `confirmed_paid` 映射到 `confirmed`**。
 *
 * `awaiting_user` / `callback_pending_verification` ⇒ `pending`（仍在推进、尚未确认）；
 * `user_cancelled` / `expired` / `not_started` ⇒ `absent`（支付未发生，非失败）；
 * `failed` ⇒ `failed`；`unknown` ⇒ `unknown`（不得计为成功）。
 */
export const PAYMENT_STATE_TO_LIFECYCLE_PAID_STAGE: Readonly<Record<PaymentState, StageState>> = Object.freeze({
  not_started: 'absent',
  awaiting_user: 'pending',
  callback_pending_verification: 'pending',
  confirmed_paid: 'confirmed',
  failed: 'failed',
  user_cancelled: 'absent',
  expired: 'absent',
  unknown: 'unknown',
});

/**
 * 接到 M09 生命周期上的 `paid` 阶段报告。
 *
 * 除 M09 `StageReport` 的四个字段外，额外如实写出两侧来源：
 * - `lifecyclePaidState`：M09 视图里 `paid` 阶段自己的状态（来自订单状态码）；
 * - `confirmedBy`：唯一能产出 `confirmed` 的来源，只可能是 `'payment_readback'`；
 * - `consistentWithLifecycle`：支付侧结论与订单侧 `paid` 阶段是否一致（不一致时如实为 `false`）。
 */
export interface PaidStageReport extends StageReport {
  readonly stage: 'paid';
  readonly paymentState: PaymentState;
  readonly lifecyclePaidState: StageState;
  readonly confirmedBy: 'payment_readback' | 'none';
  readonly consistentWithLifecycle: boolean;
}

/** 由支付视图与 M09 生命周期视图构造 `paid` 阶段报告（纯函数，不触网）。 */
export function buildPaidStageReport(paymentView: PaymentView, orderView: OrderLifecycleView): PaidStageReport {
  const state = PAYMENT_STATE_TO_LIFECYCLE_PAID_STAGE[paymentView.state];
  const lifecyclePaidState = stageReport(orderView, 'paid').state;
  const paymentConfirmed = state === 'confirmed';
  const lifecycleConfirmed = lifecyclePaidState === 'confirmed';
  const consistentWithLifecycle = paymentConfirmed === lifecycleConfirmed;

  const noteParts: string[] = [];
  if (paymentConfirmed) {
    noteParts.push('支付侧受控读回确认已付款（confirmed_paid）');
  } else {
    noteParts.push(`支付侧尚未读回确认（payment=${paymentView.state}）：不得声称已付款`);
  }
  noteParts.push(`订单侧 paid 阶段=${lifecyclePaidState}（原单 ${orderView.externalId}，状态码 ${orderView.rawStatusCode}）`);
  if (!consistentWithLifecycle) {
    noteParts.push('两侧结论不一致：已如实标出，未替任何一侧圆场');
  }

  return Object.freeze({
    stage: 'paid' as const,
    state,
    sourceCode: `payment:${paymentView.state}`,
    note: noteParts.join('；'),
    paymentState: paymentView.state,
    lifecyclePaidState,
    confirmedBy: paymentConfirmed ? ('payment_readback' as const) : ('none' as const),
    consistentWithLifecycle,
  });
}

// ---------------------------------------------------------------------------
// 回跳 → 生命周期恢复
// ---------------------------------------------------------------------------

/** {@link resumeOrderAfterPaymentReturn} 的入参。 */
export interface PaymentReturnResumeInput {
  /** 本地支付跟踪器（M08）。 */
  readonly payment: PaymentTracker;
  /** 收到的支付回跳（受控签发）。 */
  readonly callback: PaymentCallback;
  /** 本地订单生命周期跟踪器（M09），只读使用。 */
  readonly orderLifecycle: OrderLifecycleTracker;
  /** 订单查询端口（M09 注入）；桥保证 `query` **恰好被调用一次**。 */
  readonly orderPort: OrderQueryPort;
  /**
   * 支付读回端口（M08 注入）。**可省略**：省略即表示「只登记了回跳，尚未读回」，
   * 此时 `paid` 阶段只能是 `pending`，**绝不** `confirmed`（回跳不是付款证据）。
   */
  readonly paymentPort?: PaymentQueryPort;
  /**
   * 可选：若调用方尚未向用户展示官方支付入口，可在此补一次 `begin`。
   * 已 `begin` 过（状态为 `awaiting_user`）时不要重复传入。
   */
  readonly handoff?: PaymentHandoff;
}

/** {@link resumeOrderAfterPaymentReturn} 的结果（全部为冻结纯数据）。 */
export interface PaymentReturnResumeResult {
  /** 回跳登记后的支付视图（恒为 `callback_pending_verification`，`needsStatusQuery === true`）。 */
  readonly returnView: PaymentView;
  /** query-first 恢复后的 M09 订单生命周期视图。 */
  readonly orderView: OrderLifecycleView;
  /** 读回后的支付视图；未提供 `paymentPort` 时为 `null`（尚未读回）。 */
  readonly paymentView: PaymentView | null;
  /** 接在 M09 生命周期上的 `paid` 阶段报告。 */
  readonly paidStage: PaidStageReport;
  /** 订单查询端口实际被调用的次数（本桥保证恒为 `1`）。 */
  readonly orderQueryCount: number;
}

/**
 * 校验支付意图与订单意图在共享字段上一致——两条链若指向不同的单/账号/金额，
 * 「桥接」本身就没有意义。
 *
 * 比较 externalId（仅当支付意图持有非空值）/ accountRef / amountMinor / currency。
 *
 * @throws {PaymentError} `invalid_payment_request`（意图不一致）。
 */
function assertIntentsAligned(payment: PaymentTracker, orderIntent: OrderIntent): void {
  const paymentIntent = payment.intent;
  const mismatches: string[] = [];
  if (paymentIntent.accountRef !== orderIntent.accountRef) {
    mismatches.push(`accountRef(${paymentIntent.accountRef}≠${orderIntent.accountRef})`);
  }
  if (paymentIntent.amountMinor !== orderIntent.amountMinor) {
    mismatches.push(`amountMinor(${paymentIntent.amountMinor}≠${orderIntent.amountMinor})`);
  }
  if (paymentIntent.currency !== orderIntent.currency) {
    mismatches.push(`currency(${paymentIntent.currency}≠${orderIntent.currency})`);
  }
  if (paymentIntent.externalId !== null && paymentIntent.externalId !== orderIntent.externalId) {
    mismatches.push(`externalId(${paymentIntent.externalId}≠${String(orderIntent.externalId)})`);
  }
  if (mismatches.length > 0) {
    throw new PaymentError(
      'invalid_payment_request',
      `支付意图与订单意图不一致（${mismatches.join(' / ')}）：两条链指向不同的单，桥接无意义`,
    );
  }
}

/** 复核一个桥自己构造的载荷不含任何支付凭据字段（硬闸门，命中即抛）。 */
function assertBridgePayloadClean(payload: unknown): void {
  assertNoCredentialFields(payload);
}

/**
 * 支付回跳 → **先查原单**（M09 `resumeAfterDisconnect`）→ 再读回 → 产出 `paid` 阶段报告。
 *
 * 执行顺序（每一步都在下一次之前完成）：
 * 1. （可选）`begin(handoff)`；
 * 2. `payment.handleReturn(callback)` —— 只到 `callback_pending_verification`；
 * 3. `orderLifecycle.resumeAfterDisconnect(orderPort)` —— **恰好一次** 原单查询（query-first）；
 * 4. （若给了 `paymentPort`）`payment.refresh(paymentPort)` —— 受控读回才可能到 `confirmed_paid`；
 * 5. `buildPaidStageReport` —— 把 `confirmed_paid` 接到 M09 `paid` 阶段报告。
 *
 * @throws {PaymentError} 回跳不可信 / 意图不一致 / 读回不可信 / 匹配失败等（M08 原判据）。
 * @throws {OrderLifecycleError} 原单查询结果与本地意图不匹配等（M09 原判据）。
 */
export async function resumeOrderAfterPaymentReturn(
  input: PaymentReturnResumeInput,
): Promise<PaymentReturnResumeResult> {
  const { payment, callback, orderLifecycle, orderPort } = input;

  assertIntentsAligned(payment, orderLifecycle.intent);

  if (input.handoff !== undefined) {
    payment.begin(input.handoff);
  }

  // 1) 回跳：只触发查询，绝不置已付款。
  const returnView = payment.handleReturn(callback);

  // 2) query-first：用原单 externalId 查一次（计数端口保证可观测且恰好一次）。
  let orderQueryCount = 0;
  const countingOrderPort: OrderQueryPort = Object.freeze({
    query: (request: OrderQueryRequest) => {
      orderQueryCount += 1;
      assertBridgePayloadClean(request);
      return orderPort.query(request);
    },
  });
  const orderView = await orderLifecycle.resumeAfterDisconnect(countingOrderPort);

  // 3) 读回（可选）：只有受控读回才可能确认已付款。
  let paymentView: PaymentView | null = null;
  if (input.paymentPort !== undefined) {
    paymentView = await payment.refresh(input.paymentPort);
  }

  const paidStage = buildPaidStageReport(paymentView ?? returnView, orderView);

  return Object.freeze({
    returnView,
    orderView,
    paymentView,
    paidStage,
    orderQueryCount,
  });
}

/**
 * 桥的边界常量（**结构性声明，不是开关**）。
 */
export const PAYMENT_LIFECYCLE_BRIDGE_BOUNDARY = Object.freeze({
  /** 是否把「收到回跳」当成已付款。 */
  assumesPaidFromReturn: false,
  /** paid 阶段是否**必须**有受控支付读回才可能 confirmed。 */
  requiresTrustedReadbackForPaid: true,
  /** 是否用原单 externalId 做 query-first（不猜单、不重下）。 */
  queriesOriginalOrderOnly: true,
  /** 是否收集任何支付凭据。 */
  collectsPaymentCredentials: false,
  /** 是否自带真实网络调用（端口一律注入）。 */
  hasRealNetworkCall: false,
  note:
    'M08×M09 桥：回跳只触发查询；先按原单 externalId 走 M09 resumeAfterDisconnect，' +
    '再经受控支付读回才可能 confirmed_paid；confirmed_paid 才接到 M09 paid 阶段报告。',
} as const);
