/**
 * M08 支付跟踪器：展示官方入口 → 回跳（只触发查询）→ 平台读回确认。
 *
 * ## 本类要关掉的那个洞
 *
 * 「回跳即成功」是本层最典型的假成功：用户在支付页点了完成、浏览器跳回一个
 * `...?result=success` 的 URL，若判据写成「看到 success 就置已付款」，就会把
 * **一次未支付的点击**报成已付款。本类的结构对策：
 *
 * - {@link PaymentTracker.handleReturn} 只把状态推进到
 *   `callback_pending_verification`，并在视图里 `needsStatusQuery = true`；
 *   它**没有任何**通向 `confirmed_paid` 的分支。
 * - `confirmed_paid` **只能**由 {@link PaymentTracker.refresh} 在拿到
 *   **受控签发**且**逐项匹配**的读回 `paid` 时进入。
 * - `rawOutcome`（URL 里的字符串）根本不参与判定，只进视图说明。
 *
 * ## 用户支付 / 取消 / 失效
 *
 * 三条语义各自成立、互不覆盖：`confirmed_paid`（读回说 paid）、`user_cancelled`
 * （用户主动取消）、`expired`（{@link PaymentTracker.checkExpiry} 按注入时钟判超时）。
 * 过期**不**等于支付失败，也**不**等于已付款；`mayClaimPaid` 对三者只在
 * `confirmed_paid` 时为 true。
 *
 * ## 不匹配不得继续
 *
 * 读回的 paymentIntentRef / externalId / 账号 / 金额 / 币种任一不符 ⇒
 * 抛 {@link PaymentError}（`payment_intent_mismatch`）并进入 **blocked**，
 * 之后的 handleReturn / refresh 一律 `payment_tracking_blocked`，直到
 * 调用方显式 `acknowledge()`。
 */

import { PaymentError } from './errors.js';
import { assertTrustedPaymentCallback, assertTrustedPaymentHandoff, checkPaymentUrl } from './links.js';
import { asCurrencyCode, asMinorUnits, asNonEmptyString } from './money.js';
import { assertTrustedPaymentReadback } from './readback.js';
import {
  canTransitionPayment,
  describePaymentState,
  mayClaimPaid,
  paymentStateForReadback,
} from './types.js';
import type {
  PaymentCallback,
  PaymentHandoff,
  PaymentIntent,
  PaymentMismatchField,
  PaymentQueryPort,
  PaymentQueryReason,
  PaymentQueryRequest,
  PaymentReadback,
  PaymentState,
  PaymentView,
  TrustedLinkPolicy,
} from './types.js';

/** 注入时钟。本包**不读系统时钟**，全部时刻由调用方给出，便于确定性验收。 */
export interface PaymentClock {
  now(): number;
}

/** 跟踪器构造参数。 */
export interface PaymentTrackerOptions {
  /** 本地支付意图：读回必须与它逐项对上。 */
  readonly intent: PaymentIntent;
  /** 注入时钟（确定性）。 */
  readonly clock: PaymentClock;
  /** 可信支付域名策略：交接与回跳的链接都要过它。 */
  readonly linkPolicy: TrustedLinkPolicy;
}

/** 规范化并冻结一个意图（非法输入立即抛错）。 */
function normalizeIntent(intent: PaymentIntent): PaymentIntent {
  return Object.freeze({
    paymentIntentRef: asNonEmptyString(intent?.paymentIntentRef, 'paymentIntentRef'),
    externalId: intent?.externalId === null ? null : asNonEmptyString(intent?.externalId, 'externalId'),
    accountRef: asNonEmptyString(intent?.accountRef, 'accountRef'),
    amountMinor: asMinorUnits(intent?.amountMinor, 'intent.amountMinor'),
    currency: asCurrencyCode(intent?.currency, 'intent.currency'),
    provider: asNonEmptyString(intent?.provider, 'intent.provider'),
  });
}

/**
 * 读回与本地意图的匹配核对。返回**全部**不符字段（顺序固定）；全符返回空数组。
 *
 * `external_id` 仅在本地意图已持有 externalId 时参与核对。
 */
export function matchReadbackToIntent(readback: PaymentReadback, intent: PaymentIntent): readonly PaymentMismatchField[] {
  const fields: PaymentMismatchField[] = [];
  if (readback.paymentIntentRef !== intent.paymentIntentRef) {
    fields.push('payment_intent');
  }
  if (intent.externalId !== null && readback.externalId !== intent.externalId) {
    fields.push('external_id');
  }
  if (readback.accountRef !== intent.accountRef) {
    fields.push('account');
  }
  if (readback.amountMinor !== intent.amountMinor) {
    fields.push('amount');
  }
  if (readback.currency !== intent.currency) {
    fields.push('currency');
  }
  return Object.freeze(fields);
}

/** 构造一张支付视图（冻结、纯数据）。 */
function buildPaymentView(
  intent: PaymentIntent,
  state: PaymentState,
  parts: {
    readonly handoffRef: string | null;
    readonly lastCallbackRef: string | null;
    readonly lastReadback: PaymentReadback | null;
    readonly observedAt: number;
    readonly note: string;
  },
): PaymentView {
  return Object.freeze({
    paymentIntentRef: intent.paymentIntentRef,
    externalId: intent.externalId,
    accountRef: intent.accountRef,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    provider: intent.provider,
    state,
    paidClaimable: mayClaimPaid(state),
    needsStatusQuery: state === 'awaiting_user' || state === 'callback_pending_verification',
    handoffRef: parts.handoffRef,
    lastCallbackRef: parts.lastCallbackRef,
    lastReadback: parts.lastReadback,
    note: parts.note,
    observedAt: parts.observedAt,
  });
}

/**
 * 支付跟踪器。
 *
 * 本类**没有**「收取卡号 / 输入验证码 / 输入 PIN / 自动扣款」的方法，也不会有；
 * `boundary.test.ts` 会断言本包导出的符号里不存在这类能力。
 */
export class PaymentTracker {
  readonly #intent: PaymentIntent;
  readonly #clock: PaymentClock;
  readonly #linkPolicy: TrustedLinkPolicy;
  readonly #history: PaymentView[] = [];
  #state: PaymentState = 'not_started';
  #view: PaymentView;
  #handoff: PaymentHandoff | null = null;
  #lastCallbackRef: string | null = null;
  #lastReadback: PaymentReadback | null = null;
  #blockedReason: string | null = null;

  constructor(options: PaymentTrackerOptions) {
    this.#intent = normalizeIntent(options?.intent);
    if (options?.clock === undefined || typeof options.clock.now !== 'function') {
      throw new PaymentError('invalid_payment_request', '跟踪器必须注入时钟（本包不读系统时钟）');
    }
    this.#clock = options.clock;
    if (options?.linkPolicy === undefined || options.linkPolicy === null) {
      throw new PaymentError('invalid_payment_request', '跟踪器必须注入可信支付域名策略');
    }
    this.#linkPolicy = options.linkPolicy;
    this.#view = buildPaymentView(this.#intent, this.#state, {
      handoffRef: null,
      lastCallbackRef: null,
      lastReadback: null,
      observedAt: this.#clock.now(),
      note: describePaymentState(this.#state),
    });
  }

  get intent(): PaymentIntent {
    return this.#intent;
  }

  get state(): PaymentState {
    return this.#state;
  }

  /** 当前视图（构造后恒存在；初始为 `not_started`）。 */
  get view(): PaymentView {
    return this.#view;
  }

  /** 全部通过校验的视图（按时间顺序）。 */
  get history(): readonly PaymentView[] {
    return Object.freeze([...this.#history]);
  }

  get trackable(): boolean {
    return this.#blockedReason === null;
  }

  get blockedReason(): string | null {
    return this.#blockedReason;
  }

  /**
   * 向用户展示官方支付入口，进入 `awaiting_user`。
   *
   * 若交接已过期（注入时钟 >= `expiresAt`）⇒ 直接进入 `expired`（不假装还能支付）。
   *
   * @throws {PaymentError} `untrusted_payment_handoff` / `untrusted_payment_url` /
   *   `payment_intent_mismatch` / `illegal_payment_transition` / `payment_tracking_blocked`。
   */
  begin(handoff: PaymentHandoff): PaymentView {
    this.#requireTrackable();
    const trusted = assertTrustedPaymentHandoff(handoff);
    if (trusted.paymentIntentRef !== this.#intent.paymentIntentRef) {
      throw new PaymentError(
        'payment_intent_mismatch',
        `支付交接指向 ${trusted.paymentIntentRef}，本地意图是 ${this.#intent.paymentIntentRef}`,
        'paymentIntentRef',
        ['payment_intent'],
      );
    }
    // 交接在签发时已过白名单，但跟踪器按自己的策略重核一遍（防御「换策略后旧交接仍可用」）。
    const urlCheck = checkPaymentUrl(trusted.url, this.#linkPolicy);
    if (!urlCheck.trusted) {
      throw new PaymentError('untrusted_payment_url', `支付交接链接未通过跟踪器域名单：${urlCheck.reason}`, 'url');
    }
    const now = this.#clock.now();
    const expired = now >= trusted.expiresAt;
    const target: PaymentState = expired ? 'expired' : 'awaiting_user';
    const note = expired
      ? `支付交接已于 ${trusted.expiresAt} 失效，不得再据此展示可支付入口`
      : `${describePaymentState(target)}（外部步骤，须如实显示）`;
    return this.#commit(target, { handoff: trusted, observedAt: now, note }, false);
  }

  /**
   * 处理一次支付回跳。
   *
   * **回跳只触发状态查询**：本方法把状态推进到 `callback_pending_verification`，
   * **绝不**置 `confirmed_paid`。`rawOutcome` 即便写着 `success` 也不参与判定。
   *
   * @throws {PaymentError} `untrusted_payment_callback` / `untrusted_payment_url` /
   *   `payment_intent_mismatch` / `illegal_payment_transition` / `payment_tracking_blocked`。
   */
  handleReturn(callback: PaymentCallback): PaymentView {
    this.#requireTrackable();
    const trusted = assertTrustedPaymentCallback(callback);
    if (trusted.paymentIntentRef !== this.#intent.paymentIntentRef) {
      throw new PaymentError(
        'payment_intent_mismatch',
        `支付回跳指向 ${trusted.paymentIntentRef}，本地意图是 ${this.#intent.paymentIntentRef}`,
        'paymentIntentRef',
        ['payment_intent'],
      );
    }
    const urlCheck = checkPaymentUrl(trusted.returnUrl, this.#linkPolicy);
    if (!urlCheck.trusted) {
      throw new PaymentError('untrusted_payment_url', `支付回跳链接未通过跟踪器域名单：${urlCheck.reason}`, 'returnUrl');
    }
    const now = this.#clock.now();
    const outcomeText = trusted.rawOutcome === null ? '（未附结果串）' : `（附结果串 ${trusted.rawOutcome}，不可信，仅供参考）`;
    const note =
      `已收到支付回跳${outcomeText}：回跳不是付款证据，只触发一次平台读回，` +
      '在读到 paid 之前不得声称已付款';
    // 回跳把状态推进到「待核验」——它没有通向 confirmed_paid 的分支。
    return this.#commit(
      'callback_pending_verification',
      { callbackRef: trusted.callbackRef, observedAt: now, note },
      false,
    );
  }

  /**
   * 向平台**读回**支付状态（唯一能确认已付款的路径）。
   *
   * @throws {PaymentError} `missing_payment_query_port` / `missing_payment_readback` /
   *   `untrusted_payment_readback` / `payment_intent_mismatch`（并**阻断**）/
   *   `illegal_payment_transition` / `payment_tracking_blocked`。
   */
  async refresh(port: PaymentQueryPort): Promise<PaymentView> {
    this.#requireTrackable();
    if (port === undefined || port === null || typeof port.query !== 'function') {
      throw new PaymentError('missing_payment_query_port', '没有装配支付读回端口：无法读回时不得猜已付款');
    }
    const externalId = this.#intent.externalId;
    if (externalId === null) {
      throw new PaymentError(
        'invalid_payment_request',
        '本地意图没有 externalId（尚未有可核验的下单回执）：不得凭猜测读回支付状态',
        'externalId',
      );
    }
    const reason: PaymentQueryReason = this.#state === 'callback_pending_verification' ? 'after_callback' : 'poll';
    const request: PaymentQueryRequest = Object.freeze({
      paymentIntentRef: this.#intent.paymentIntentRef,
      externalId,
      accountRef: this.#intent.accountRef,
      reason,
    });
    const raw = await port.query(request);
    const readback = assertTrustedPaymentReadback(raw);

    const mismatches = matchReadbackToIntent(readback, this.#intent);
    if (mismatches.length > 0) {
      const detail =
        `支付读回与本地意图不符（${mismatches.join(' / ')}）：` +
        `读回 intent=${readback.paymentIntentRef} ext=${readback.externalId} acct=${readback.accountRef} ` +
        `amount=${readback.amountMinor} ${readback.currency}`;
      this.#blockedReason = detail;
      throw new PaymentError('payment_intent_mismatch', detail, mismatches[0] ?? null, mismatches);
    }

    const target = paymentStateForReadback(readback.paidState);
    const paidClaimed = target === 'confirmed_paid';
    const note = paidClaimed
      ? `平台读回确认已付款（${readback.providerPaymentRef}，${readback.amountMinor} ${readback.currency}）`
      : this.#state === 'callback_pending_verification' && target === 'awaiting_user'
        ? '回跳后读回显示尚未支付（unpaid）：不得声称已付款'
        : `平台读回状态：${describePaymentState(target)}`;

    return this.#commit(target, { readback, observedAt: readback.observedAt, note }, true);
  }

  /**
   * 用户主动取消支付。
   *
   * @throws {PaymentError} `illegal_payment_transition`（已付款后不得取消——那是退款，不属本包）。
   */
  cancel(): PaymentView {
    this.#requireTrackable();
    const now = this.#clock.now();
    return this.#commit('user_cancelled', { observedAt: now, note: describePaymentState('user_cancelled') }, false);
  }

  /**
   * 按注入时钟检查失效：交接期限已过且尚未确认已付款 ⇒ `expired`；
   * 否则返回当前视图（**不改状态**——不得把「没到期」误报成失败或成功）。
   */
  checkExpiry(): PaymentView {
    this.#requireTrackable();
    const now = this.#clock.now();
    const handoff = this.#handoff;
    if (handoff !== null && now >= handoff.expiresAt && this.#state !== 'confirmed_paid') {
      return this.#commit(
        'expired',
        { observedAt: now, note: `支付交接已于 ${handoff.expiresAt} 失效（当前 ${now}）` },
        false,
      );
    }
    return this.#view;
  }

  /**
   * 要求「已付款」的结论。
   *
   * @throws {PaymentError} `payment_not_paid`（当前状态不得声称已付款）。
   */
  requirePaidView(): PaymentView {
    if (this.#state !== 'confirmed_paid') {
      throw new PaymentError(
        'payment_not_paid',
        `当前支付状态为 ${this.#state}（${describePaymentState(this.#state)}）：只有 confirmed_paid 可以声称已付款`,
        'state',
      );
    }
    return this.#view;
  }

  /** 处置一次不匹配，解除阻断（须调用方显式调用）。历史视图保留，不追溯修改。 */
  acknowledge(): void {
    this.#blockedReason = null;
  }

  #requireTrackable(): void {
    if (this.#blockedReason !== null) {
      throw new PaymentError('payment_tracking_blocked', `支付跟踪已因不匹配被阻断，不得继续：${this.#blockedReason}`);
    }
  }

  #commit(
    target: PaymentState,
    parts: {
      readonly handoff?: PaymentHandoff;
      readonly callbackRef?: string;
      readonly readback?: PaymentReadback;
      readonly observedAt: number;
      readonly note: string;
    },
    blockOnIllegal: boolean,
  ): PaymentView {
    if (target !== this.#state && !canTransitionPayment(this.#state, target)) {
      const detail = `支付状态转换 ${this.#state} → ${target} 不合法`;
      if (blockOnIllegal) {
        this.#blockedReason = detail;
      }
      throw new PaymentError('illegal_payment_transition', detail, 'state');
    }
    if (parts.handoff !== undefined) {
      this.#handoff = parts.handoff;
    }
    if (parts.callbackRef !== undefined) {
      this.#lastCallbackRef = parts.callbackRef;
    }
    if (parts.readback !== undefined) {
      this.#lastReadback = parts.readback;
    }
    this.#state = target;
    const view = buildPaymentView(this.#intent, target, {
      handoffRef: this.#handoff?.handoffRef ?? null,
      lastCallbackRef: this.#lastCallbackRef,
      lastReadback: this.#lastReadback,
      observedAt: parts.observedAt,
      note: parts.note,
    });
    this.#view = view;
    this.#history.push(view);
    return view;
  }
}
