/**
 * M08 可信支付链接 / 回跳 —— **官方域名白名单 + 受控签发器**（零依赖）。
 *
 * ## 两个洞
 *
 * 1. **非官方支付页**：把用户引到一个非官方域名去「付款」，等于把支付交给钓鱼站。
 *    对策：{@link TrustedLinkPolicy} 白名单 + {@link checkPaymentUrl} 判据
 *    （必须 https、域名精确命中白名单、URL 不得内嵌 `user:pass@`）。
 * 2. **自造回跳**：调用方拼一个 `{ rawOutcome: 'success' }` 当「平台已付款」。
 *    对策：{@link PaymentHandoff} / {@link PaymentCallback} **只能**由本模块的
 *    受控签发器产生（模块私有 `WeakSet` 登记）；形状相同的自造对象一律
 *    `untrusted_payment_handoff` / `untrusted_payment_callback`。
 *
 * 即便回跳来自可信域名，`rawOutcome` 依然**不可信**（URL 参数可被伪造），
 * 它只能触发一次状态查询，不能判定已付款——该纪律由 `tracker.ts` 落实。
 */

import { PaymentError } from './errors.js';
import { asNonEmptyString, asSafeInteger } from './money.js';
import { PAYMENT_HANDOFF_MODES } from './types.js';
import type {
  PaymentCallback,
  PaymentHandoff,
  PaymentHandoffMode,
  PaymentUrlCheck,
  TrustedLinkPolicy,
} from './types.js';

/** 由本模块签发的交接登记表。私有、不导出 ⇒ 调用方无法枚举、无法伪造。 */
const TRUSTED_HANDOFFS = new WeakSet<object>();

/** 由本模块签发的回跳登记表。私有、不导出。 */
const TRUSTED_CALLBACKS = new WeakSet<object>();

// ---------------------------------------------------------------------------
// 可信域名策略
// ---------------------------------------------------------------------------

/**
 * 造一份可信支付域名策略。
 *
 * **白名单里的域名必须是核实过的官方支付域名**（M01 职责）；本函数不做核实，
 * 只做形状校验。fixture 场景请用 `fixture.ts` 的 `.test` 合成域名，勿写入猜测域名。
 */
export function createTrustedLinkPolicy(input: {
  readonly hosts: readonly string[];
  readonly requireHttps?: boolean;
  readonly label: string;
}): TrustedLinkPolicy {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.hosts)) {
    throw new PaymentError('invalid_payment_request', '可信链接策略必须给出 hosts 数组');
  }
  const hosts = input.hosts.map((host) => {
    const text = asNonEmptyString(host, 'policy.hosts[]');
    return text.toLowerCase();
  });
  if (hosts.length === 0) {
    throw new PaymentError('invalid_payment_request', '可信链接策略的 hosts 不能为空：空白名单会放行一切或拒绝一切');
  }
  return Object.freeze({
    hosts: Object.freeze([...new Set(hosts)]),
    requireHttps: input.requireHttps !== false,
    label: asNonEmptyString(input.label, 'policy.label'),
  });
}

/**
 * 判定一个支付 URL 是否可信。**纯函数**，不读时钟、不触网。
 *
 * 拒绝规则（顺序）：
 * 1. 非字符串 / 空 / 无法解析 ⇒ 不可信；
 * 2. `requireHttps` 且协议不是 `https:` ⇒ 不可信；
 * 3. URL 内嵌 `user:pass@` ⇒ 不可信（用于伪装主机）；
 * 4. 主机名不在白名单（**精确**匹配，不做后缀包含）⇒ 不可信。
 */
export function checkPaymentUrl(rawUrl: unknown, policy: TrustedLinkPolicy): PaymentUrlCheck {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return Object.freeze({ trusted: false, host: null, reason: 'URL 为空或非字符串' });
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return Object.freeze({ trusted: false, host: null, reason: 'URL 无法解析' });
  }
  if (policy.requireHttps && parsed.protocol !== 'https:') {
    return Object.freeze({
      trusted: false,
      host: parsed.hostname,
      reason: `必须使用 https，收到 ${parsed.protocol === '' ? '(空)' : parsed.protocol}`,
    });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return Object.freeze({
      trusted: false,
      host: parsed.hostname,
      reason: 'URL 不得内嵌凭据（user:pass@）：常用于把真实主机伪装成白名单域名',
    });
  }
  if (!policy.hosts.includes(parsed.hostname.toLowerCase())) {
    return Object.freeze({
      trusted: false,
      host: parsed.hostname,
      reason: `主机 ${parsed.hostname} 不在可信支付域名白名单（${policy.label}）内`,
    });
  }
  return Object.freeze({ trusted: true, host: parsed.hostname, reason: `可信支付域名（${policy.label}）` });
}

// ---------------------------------------------------------------------------
// 官方支付交接
// ---------------------------------------------------------------------------

/** 支付交接签发入参。 */
export interface CreatePaymentHandoffInput {
  readonly handoffRef: string;
  readonly paymentIntentRef: string;
  readonly mode: PaymentHandoffMode;
  readonly url: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly instructionForUser: string;
  readonly linkPolicy: TrustedLinkPolicy;
}

/**
 * 签发一张**可信**官方支付交接（登记进私有 WeakSet）。
 *
 * @throws {PaymentError} `invalid_payment_request`（形状）/ `untrusted_payment_url`（域名单）。
 */
export function createPaymentHandoff(input: CreatePaymentHandoffInput): PaymentHandoff {
  if (input === null || typeof input !== 'object') {
    throw new PaymentError('invalid_payment_request', '支付交接入参必须是对象');
  }
  if (!(PAYMENT_HANDOFF_MODES as readonly string[]).includes(input.mode)) {
    throw new PaymentError(
      'invalid_payment_request',
      `交接模式必须是 ${PAYMENT_HANDOFF_MODES.join(' / ')} 之一，收到 ${String(input.mode)}`,
      'mode',
    );
  }
  if (input.linkPolicy === undefined || input.linkPolicy === null || typeof input.linkPolicy !== 'object') {
    throw new PaymentError('invalid_payment_request', '支付交接必须给出可信链接策略', 'linkPolicy');
  }
  const issuedAt = asSafeInteger(input.issuedAt, 'issuedAt');
  const expiresAt = asSafeInteger(input.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt) {
    throw new PaymentError('invalid_payment_request', `交接期限必须晚于签发时刻：${issuedAt} ≥ ${expiresAt}`, 'expiresAt');
  }
  const check = checkPaymentUrl(input.url, input.linkPolicy);
  if (!check.trusted) {
    throw new PaymentError('untrusted_payment_url', `支付交接的链接未通过可信域名单：${check.reason}`, 'url');
  }
  const handoff: PaymentHandoff = Object.freeze({
    handoffRef: asNonEmptyString(input.handoffRef, 'handoffRef'),
    paymentIntentRef: asNonEmptyString(input.paymentIntentRef, 'paymentIntentRef'),
    mode: input.mode,
    url: input.url,
    host: check.host as string,
    issuedAt,
    expiresAt,
    externalStepRequired: true,
    instructionForUser: asNonEmptyString(input.instructionForUser, 'instructionForUser'),
    collectsCredentials: false,
    linkPolicyLabel: input.linkPolicy.label,
  });
  TRUSTED_HANDOFFS.add(handoff);
  return handoff;
}

/** 该交接是否由本模块受控签发器产生。 */
export function isTrustedPaymentHandoff(value: unknown): value is PaymentHandoff {
  return typeof value === 'object' && value !== null && TRUSTED_HANDOFFS.has(value);
}

/** **硬判据**：非受控签发的交接一律拒。 */
export function assertTrustedPaymentHandoff(value: unknown): PaymentHandoff {
  if (value === undefined || value === null) {
    throw new PaymentError('missing_payment_readback', '缺少支付交接：未向用户展示官方支付入口就不能推进支付状态');
  }
  if (typeof value !== 'object' || !TRUSTED_HANDOFFS.has(value)) {
    throw new PaymentError(
      'untrusted_payment_handoff',
      '该支付交接不是本模块可信签发器产生的：官方入口必须来自可信链接链，不得由调用方自造',
    );
  }
  return value as PaymentHandoff;
}

// ---------------------------------------------------------------------------
// 回跳 / 回调
// ---------------------------------------------------------------------------

/** 支付回跳签发入参。 */
export interface CreatePaymentCallbackInput {
  readonly callbackRef: string;
  readonly paymentIntentRef: string;
  readonly returnUrl: string;
  readonly receivedAt: number;
  /** 平台在 URL 里附带的结果字符串——**不可信**，仅用于展示/排查。 */
  readonly rawOutcome?: string | null;
  readonly linkPolicy: TrustedLinkPolicy;
}

/**
 * 签发一份**可信来源**的支付回跳（登记进私有 WeakSet）。
 *
 * 「可信来源」只保证**回跳来自官方域名**，不保证「已付款」——`rawOutcome` 依然不可信。
 */
export function createPaymentCallback(input: CreatePaymentCallbackInput): PaymentCallback {
  if (input === null || typeof input !== 'object') {
    throw new PaymentError('invalid_payment_request', '支付回跳入参必须是对象');
  }
  if (input.linkPolicy === undefined || input.linkPolicy === null || typeof input.linkPolicy !== 'object') {
    throw new PaymentError('invalid_payment_request', '支付回跳必须给出可信链接策略', 'linkPolicy');
  }
  const check = checkPaymentUrl(input.returnUrl, input.linkPolicy);
  if (!check.trusted) {
    throw new PaymentError('untrusted_payment_url', `支付回跳链接未通过可信域名单：${check.reason}`, 'returnUrl');
  }
  const callback: PaymentCallback = Object.freeze({
    callbackRef: asNonEmptyString(input.callbackRef, 'callbackRef'),
    paymentIntentRef: asNonEmptyString(input.paymentIntentRef, 'paymentIntentRef'),
    returnUrl: input.returnUrl,
    host: check.host as string,
    receivedAt: asSafeInteger(input.receivedAt, 'receivedAt'),
    rawOutcome: input.rawOutcome === undefined || input.rawOutcome === null ? null : String(input.rawOutcome),
  });
  TRUSTED_CALLBACKS.add(callback);
  return callback;
}

/** 该回跳是否由本模块受控签发器产生。 */
export function isTrustedPaymentCallback(value: unknown): value is PaymentCallback {
  return typeof value === 'object' && value !== null && TRUSTED_CALLBACKS.has(value);
}

/** **硬判据**：非受控签发的回跳一律拒。 */
export function assertTrustedPaymentCallback(value: unknown): PaymentCallback {
  if (value === undefined || value === null) {
    throw new PaymentError('untrusted_payment_callback', '缺少支付回跳凭据');
  }
  if (typeof value !== 'object' || !TRUSTED_CALLBACKS.has(value)) {
    throw new PaymentError(
      'untrusted_payment_callback',
      '该回跳不是本模块可信签发器产生的：回跳来源与内容必须可核，不得由调用方自造',
    );
  }
  return value as PaymentCallback;
}

/**
 * **如实描述外部支付步骤**。
 *
 * 工作书要求「外部支付步骤如实显示」。本函数把这件事变成一句可断言的话：
 * 明确写出支付在外部官方页面完成、Potbot 不代填凭据，而不是「点击即支付」。
 */
export function describeExternalStep(handoff: PaymentHandoff): string {
  const modeText =
    handoff.mode === 'official_page'
      ? '官方支付页'
      : handoff.mode === 'official_sdk'
        ? '官方支付 SDK'
        : '跳转到官方 App 支付';
  return `支付将在${modeText}（${handoff.host}）由你本人完成：Potbot 不代填银行卡、验证码或 PIN，也不会自动收款。完成或取消后请回到 Potbot，由平台读回确认支付结果。`;
}
