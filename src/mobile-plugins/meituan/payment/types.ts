/**
 * M08 支付 —— 状态词表、数据结构与端口（零依赖、纯类型 + 纯函数）。
 *
 * ## 本包边界（美团线工作书 MEITUAN.md / M08）
 *
 * 「官方支付页/SDK、可信链接/回跳、用户支付/取消/失效」：
 * - 官方支付入口用 {@link PaymentHandoff} 建模（官方页面 / 官方 SDK / 深链到官方 App），
 *   并**结构化地**声明「这是外部支付步骤，须如实显示给用户」；
 * - 官方支付链接必须过**可信域名白名单**（{@link TrustedLinkPolicy}）；
 * - **回跳只触发状态查询**：{@link PaymentCallback} 只把状态推进到
 *   `callback_pending_verification`，**永远不能**直接置 `confirmed_paid`；
 * - **只有平台订单/支付读回才能确认已付款**：{@link PaymentReadback} 只能由可信签发器
 *   （`readback.ts`）产生，且必须与本地 {@link PaymentIntent} 逐项匹配；
 * - 用户**支付 / 取消 / 失效**分别是三条不同的词：`confirmed_paid` / `user_cancelled` /
 *   `expired`，任何合并写法都会让 `user-cancel-expiry.test.ts` 变红。
 *
 * ## 三条结构性纪律（写在类型里，不靠约定）
 *
 * 1. **没有「回跳即成功」这条路**：`PaymentCallback` 结构里只有回跳元数据，
 *    没有任何能直接产出 `confirmed_paid` 的字段；状态推进必须经 {@link PaymentQueryPort} 读回。
 * 2. **不代填支付凭据**：`PaymentHandoff.collectsCredentials` 是字面量 `false`；
 *    任何含 cardNumber / CVV / OTP / PIN 的载荷由 `sensitive.ts` 直接拒绝。
 * 3. **未知不是已付款**：读回状态不在表内或端口未给结论 ⇒ `unknown`，
 *    `mayClaimPaid` 为 false。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **不接真实美团支付接口**：未登录、无 token、无真实支付域名单、无真实读回码表；
 *   本包支付查询端口只有 fixture 实现。
 * - **不持有凭据、不签名、不提交支付**：包内无网络、无加密、无凭据通道。
 * - **未在真机验证**：任何 fixture「已付款」都不构成真实支付成功。
 */

// ---------------------------------------------------------------------------
// 状态词表
// ---------------------------------------------------------------------------

/**
 * 支付生命周期（九态，**严格用这九个词，不得合并**）。
 *
 * - `not_started`：尚未发起；
 * - `awaiting_user`：已向用户展示官方支付入口，等待用户在**外部官方页面**完成支付；
 * - `callback_pending_verification`：已收到回跳/回调，**但这只触发状态查询**，
 *   此时尚未确认已付款（回跳不是付款证据）；
 * - `confirmed_paid`：**只有**平台支付读回明确回报 `paid` 才可进入（唯一可声称已付款的态）；
 * - `failed`：平台明确报告支付失败；
 * - `user_cancelled`：用户取消支付；
 * - `expired`：支付入口/报价已失效（超时）；
 * - `unknown`：平台未给出可判定结果（**不得**计为已付款，也不得计为失败）。
 */
export const PAYMENT_STATES = [
  'not_started',
  'awaiting_user',
  'callback_pending_verification',
  'confirmed_paid',
  'failed',
  'user_cancelled',
  'expired',
  'unknown',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/** 状态的中文标签（只用于说明文字，不参与判定）。 */
export const PAYMENT_STATE_LABELS: Readonly<Record<PaymentState, string>> = Object.freeze({
  not_started: '未发起',
  awaiting_user: '等待用户支付',
  callback_pending_verification: '回跳待核验',
  confirmed_paid: '已付款',
  failed: '支付失败',
  user_cancelled: '用户取消',
  expired: '支付失效',
  unknown: '状态未知',
});

/**
 * 终态：不再前进。
 * 注意 `failed` / `user_cancelled` / `expired` **不是**终态——用户可重试，
 * 因此它们可以回到 `awaiting_user`；但已付款（`confirmed_paid`）不得再变。
 */
export const PAYMENT_TERMINAL_STATES = ['confirmed_paid'] as const;

/** **唯一**可以声称「已付款」的状态。回跳态不在此列。 */
export const PAYMENT_PAID_CLAIMABLE_STATES = ['confirmed_paid'] as const;

export function isPaymentState(value: unknown): value is PaymentState {
  return typeof value === 'string' && (PAYMENT_STATES as readonly string[]).includes(value);
}

export function isTerminalPaymentState(state: PaymentState): boolean {
  return (PAYMENT_TERMINAL_STATES as readonly PaymentState[]).includes(state);
}

/** 机器化判据：只有 `confirmed_paid` 可以声称已付款；回跳/未知一律 false。 */
export function mayClaimPaid(state: PaymentState): boolean {
  return (PAYMENT_PAID_CLAIMABLE_STATES as readonly PaymentState[]).includes(state);
}

/**
 * 状态转换表。表外一律 `illegal_payment_transition`（含未列出的自环）。
 *
 * `callback_pending_verification` **没有**直达 `confirmed_paid` 的捷径以外的东西——
 * 它唯一通向已付款的边是「读回返回 paid」；而它通向 `awaiting_user` 的边对应
 * 「读回返回 unpaid」（回跳了但其实没付）。
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = Object.freeze({
  // `not_started → confirmed_paid` 合法：App 重启后读回发现「其实已支付」，属于恢复语义；
  // 它仍需经 `refresh` + 受控签发读回，不是捷径。
  not_started: ['awaiting_user', 'confirmed_paid', 'user_cancelled', 'expired', 'unknown'],
  awaiting_user: ['callback_pending_verification', 'confirmed_paid', 'failed', 'user_cancelled', 'expired', 'unknown'],
  callback_pending_verification: [
    'confirmed_paid',
    'failed',
    'awaiting_user',
    'user_cancelled',
    'expired',
    'unknown',
  ],
  confirmed_paid: [],
  failed: ['awaiting_user', 'unknown'],
  user_cancelled: ['awaiting_user', 'unknown'],
  expired: ['awaiting_user', 'unknown'],
  unknown: ['awaiting_user', 'confirmed_paid', 'failed', 'user_cancelled', 'expired', 'unknown'],
});

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return (PAYMENT_TRANSITIONS[from] ?? []).includes(to);
}

/** 一次状态转换的判定结果（纯数据，便于断言）。 */
export interface PaymentTransitionCheck {
  readonly legal: boolean;
  readonly kind: TransitionKind;
  readonly detail: string;
}

/** 转换判定的种类。 */
export type TransitionKind =
  /** 同状态重报：幂等，合法。 */
  | 'no_op'
  /** 表内允许的前进/重试。 */
  | 'forward'
  /** 表外：非法。 */
  | 'table_denied'
  /** 终态（`confirmed_paid`）之后不得再变。 */
  | 'terminal'
  /** 不是已知支付状态名。 */
  | 'unknown_state';

/** 纯函数：判定一次支付状态转换是否合法。 */
export function checkPaymentTransition(from: PaymentState, to: PaymentState): PaymentTransitionCheck {
  if (!isPaymentState(from) || !isPaymentState(to)) {
    return Object.freeze({ legal: false, kind: 'unknown_state', detail: `不是已知支付状态：${String(from)} → ${String(to)}` });
  }
  if (from === to) {
    return Object.freeze({ legal: true, kind: 'no_op', detail: `重复报告同一状态 ${from}（幂等）` });
  }
  if (isTerminalPaymentState(from)) {
    return Object.freeze({
      legal: false,
      kind: 'terminal',
      detail: `已付款（${from}）是终态，不得再变为 ${to}；如需退款请走退款/账本流程`,
    });
  }
  if ((PAYMENT_TRANSITIONS[from] ?? []).includes(to)) {
    return Object.freeze({ legal: true, kind: 'forward', detail: `允许 ${from} → ${to}` });
  }
  return Object.freeze({ legal: false, kind: 'table_denied', detail: `转换表不允许 ${from} → ${to}` });
}

/** 状态 → 说明。`pending` / `unknown` 一律不得描述成已完成。 */
export function describePaymentState(state: PaymentState): string {
  switch (state) {
    case 'not_started':
      return '尚未发起支付';
    case 'awaiting_user':
      return '等待用户在官方支付页完成支付（外部步骤，Potbot 不代填任何银行卡/验证码/PIN）';
    case 'callback_pending_verification':
      return '已收到支付回跳，但回跳只触发状态查询，尚未确认已付款';
    case 'confirmed_paid':
      return '平台支付读回确认已付款';
    case 'failed':
      return '平台明确报告支付失败';
    case 'user_cancelled':
      return '用户取消支付';
    case 'expired':
      return '支付已失效（超时/报价过期）';
    case 'unknown':
      return '支付状态未知（平台未给出可判定结果）⇒ 不得计为已付款';
  }
}

// ---------------------------------------------------------------------------
// 本地支付意图与匹配
// ---------------------------------------------------------------------------

/**
 * 匹配失败的具体字段。`external_id` 只在本地意图已持有 externalId 时参与核对。
 */
export type PaymentMismatchField = 'payment_intent' | 'external_id' | 'account' | 'amount' | 'currency';

/** 全部匹配字段（顺序固定，供文档与断言复用）。 */
export const PAYMENT_MISMATCH_FIELDS = ['payment_intent', 'external_id', 'account', 'amount', 'currency'] as const;

/**
 * 本地支付意图：平台读回必须与它逐项对上，否则不得确认已付款。
 *
 * `externalId` 为 `null` 表示「本地还没有可核验的下单回执」——此时
 * 支付读回**无法**凭猜测进行（`refresh` 会直接拒绝）。
 */
export interface PaymentIntent {
  readonly paymentIntentRef: string;
  /** 对应订单的平台 externalId；下单尚未有回执时为 `null`。 */
  readonly externalId: string | null;
  /** 付款账号引用（脱敏引用，不是凭据、不是卡号）。 */
  readonly accountRef: string;
  /** **整数最小单位**（分）。禁止浮点。 */
  readonly amountMinor: number;
  /** ISO 4217 大写三字母。 */
  readonly currency: string;
  /** 支付提供方标识（如官方收银台），非凭据。 */
  readonly provider: string;
}

// ---------------------------------------------------------------------------
// 官方支付入口 / 可信链接
// ---------------------------------------------------------------------------

/**
 * 官方支付入口形态。三种都表示「支付在外部完成」，而不是在 Potbot 内完成。
 */
export const PAYMENT_HANDOFF_MODES = ['official_page', 'official_sdk', 'deeplink_to_official_app'] as const;

export type PaymentHandoffMode = (typeof PAYMENT_HANDOFF_MODES)[number];

/**
 * 可信支付域名策略。**白名单必须由核实方（M01）填入官方域名**；
 * 未核实前只允许用 fixture 合成域名（`.test`），不得把猜测域名当官方。
 */
export interface TrustedLinkPolicy {
  readonly hosts: readonly string[];
  readonly requireHttps: boolean;
  readonly label: string;
}

/** 一次支付链接的可信判定结果（纯数据）。 */
export interface PaymentUrlCheck {
  readonly trusted: boolean;
  readonly host: string | null;
  readonly reason: string;
}

/**
 * 交给用户/渲染层的**官方支付入口**（只能由 `links.ts` 的可信签发器产生）。
 *
 * `collectsCredentials: false` 与 `externalStepRequired: true` 是字面量：
 * 本模块不出于任何路径向用户索要卡号/验证码/PIN。
 */
export interface PaymentHandoff {
  readonly handoffRef: string;
  readonly paymentIntentRef: string;
  readonly mode: PaymentHandoffMode;
  /** 官方支付链接（已通过 {@link TrustedLinkPolicy} 白名单）。 */
  readonly url: string;
  readonly host: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** 本步骤由用户在外部完成，**必须如实显示**，不得伪装成 App 内一键支付。 */
  readonly externalStepRequired: true;
  /** 面向用户的中性说明（描述外部步骤，不含任何凭据填写引导）。 */
  readonly instructionForUser: string;
  /** 本模块不收集支付凭据。 */
  readonly collectsCredentials: false;
  /** 官方链接白名单的可读标签（便于审计是哪份策略放行的）。 */
  readonly linkPolicyLabel: string;
}

/**
 * 支付回跳/回调（只能由 `links.ts` 的可信签发器产生）。
 *
 * **关键纪律**：回跳里带的 `rawOutcome` 是**不可信字符串**（URL 参数可被伪造），
 * 它只能用于展示与排查，**不能**用来判定已付款。回跳的唯一作用是触发一次状态查询。
 */
export interface PaymentCallback {
  readonly callbackRef: string;
  readonly paymentIntentRef: string;
  /** 回跳 URL（已通过可信域名白名单）。 */
  readonly returnUrl: string;
  readonly host: string;
  readonly receivedAt: number;
  /** 平台在 URL 里附带的结果字符串——**不可信**，仅供展示/排查。 */
  readonly rawOutcome: string | null;
}

// ---------------------------------------------------------------------------
// 平台支付读回（唯一可确认已付款的来源）
// ---------------------------------------------------------------------------

/**
 * 平台读回的支付状态。**只可能来自真实读回**（fixture 端口不得回报 `paid`）。
 */
export const PAYMENT_READBACK_STATES = ['paid', 'unpaid', 'failed', 'unknown'] as const;

export type PaymentReadbackState = (typeof PAYMENT_READBACK_STATES)[number];

/** 读回状态 → 追踪器状态。`paid` 是**唯一**能通向 `confirmed_paid` 的输入。 */
export function paymentStateForReadback(state: PaymentReadbackState): PaymentState {
  switch (state) {
    case 'paid':
      return 'confirmed_paid';
    case 'unpaid':
      return 'awaiting_user';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * 平台支付读回（只能由 `readback.ts` 的受控签发器产生）。
 *
 * 契约不变量：`verificationMode === 'fixture'` 时 `paidState` **不得**为 `paid`。
 */
export interface PaymentReadback {
  readonly paymentIntentRef: string;
  readonly externalId: string;
  /** 付款账号引用（脱敏引用）。 */
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** 平台侧支付流水号（脱敏引用，不是凭据）。 */
  readonly providerPaymentRef: string;
  readonly paidState: PaymentReadbackState;
  readonly observedAt: number;
  readonly evidenceRef: string;
  readonly verificationMode: 'fixture' | 'real';
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 查询端口
// ---------------------------------------------------------------------------

/** 发起支付读回的原因。 */
export type PaymentQueryReason = 'after_callback' | 'poll' | 'manual_check';

/** 支付读回请求（**只读回**，不含任何支付参数、不含凭据）。 */
export interface PaymentQueryRequest {
  readonly paymentIntentRef: string;
  /** 必须是本地已核验的原订单 externalId。 */
  readonly externalId: string;
  readonly accountRef: string;
  readonly reason: PaymentQueryReason;
}

/**
 * 支付读回端口。**读回的唯一来源**。
 *
 * 真实实现（美团侧支付/订单查询接口）由 M01/M02 核验后提供；本包只提供 fixture
 * （见 `./fixture.ts`）。端口**不知道**本地意图，因此本地必须自己校验匹配。
 */
export interface PaymentQueryPort {
  readonly identity: string;
  query(request: PaymentQueryRequest): PaymentReadback | null | Promise<PaymentReadback | null>;
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/**
 * 支付视图：**没有** `ok` / `success` 之类的合并字段。
 * 是否已付款只能读 `state === 'confirmed_paid'`（或 `paidClaimable`）。
 */
export interface PaymentView {
  readonly paymentIntentRef: string;
  readonly externalId: string | null;
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly provider: string;
  readonly state: PaymentState;
  /** 是否可以声称已付款：**只有** `confirmed_paid` 为 true。 */
  readonly paidClaimable: boolean;
  /** 是否仍有未落定的支付（等待用户 / 回跳待核验），须继续查询而不能宣称已付款。 */
  readonly needsStatusQuery: boolean;
  readonly handoffRef: string | null;
  readonly lastCallbackRef: string | null;
  readonly lastReadback: PaymentReadback | null;
  readonly note: string;
  readonly observedAt: number;
}
