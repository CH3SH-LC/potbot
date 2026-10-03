/**
 * K07 授权与提交账本 —— **wire/领域边界换算**（零依赖、纯函数）。
 *
 * ## 为什么需要本文件
 *
 * 总协调 2026-10-03 对编码分歧的裁决（`contracts/mobile-v1/README.md`
 * §"金额与时间编码"）定下两条硬规则，本模块是其实体化：
 *
 * 1. **wire（JSON / schema / fixtures）层**：`amount` 是十进制字符串
 *    （契约 `^[0-9]+(\.[0-9]{1,4})?$`）、时间戳是 ISO-8601 UTC 字符串
 *    （`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$`）。
 * 2. **领域（实现）层**：金额一律**整数最小单位**（`amountMinor: number`），
 *    小数位数**由币种决定**（`CNY`=2 位 ⇒ 分）；时间一律经**注入时钟**的整数。
 * 3. **换算只在边界发生，且必须精确**：wire → 领域按字符串逐位解析
 *    （**禁止** `parseFloat(str) * 100`）；领域 → wire 定点格式化。
 *
 * `types.ts` / `ledger.ts` 的授权判据全程只碰整数（金额、时钟），
 * 因此"金额相等"是可判定的整数比较，不受浮点误差影响。本文件是那条边界；
 * **判据里不得出现本文件的函数**（换算进去就等于把浮点带回判据）。
 *
 * ## 三条 fail-closed 纪律（与 K07 主线一致）
 *
 * - **不猜币种位数**：不在表里的币种抛 `unsupported_currency`，不默认 2 位。
 * - **不四舍五入金额**：精度超出币种位数且低位非零（`CNY` 的 `1.2345`）⇒
 *   抛 `wire_amount_not_representable`，绝不静默截断或进位。
 * - **不截断亚毫秒时间**：wire 允许到微秒，注入时钟是毫秒整数；
 *   微秒位非零（`…:00.123456Z`）⇒ 抛 `wire_timestamp_not_representable`，
 *   而不是丢掉精度。
 *
 * 未做（不得当成已完成）：本文件**只**做编码换算，不参与授权判定，不读写端口，
 * 不落持久化；未在真机桥/原生确认页上验证（那是集成人的活）。
 */

import { AuthorizationError } from './errors.js';
import type {
  ConfirmAction,
  ExternalReceipt,
  ReceiptObservedState,
  VerificationMode,
} from './types.js';
import { RECEIPT_OBSERVED_STATES, VERIFICATION_MODES } from './types.js';

// ---------------------------------------------------------------------------
// 币种 → 最小单位位数表
// ---------------------------------------------------------------------------

/**
 * ISO 4217 小数位数表（覆盖本项目的常见币种；**不是全集**）。
 * 表外币种一律 `unsupported_currency`——见文件头"不猜币种位数"。
 *
 * 数据来源：ISO 4217 的小数位定义（如 JPY / KRW 为 0 位，BHD / KWD 为 3 位）。
 */
export const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  MOP: 2,
  TWD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
  IQD: 3,
  LYD: 3,
});

/** 十的幂（整数常量），避免 `Math.pow` 的浮点实现差异；位数表只到 3。 */
const POW10 = [1, 10, 100, 1000] as const;

/** 取 `10 ** digits`；位数超出常量表即抛（fail-closed，不给 `undefined` 参与运算）。 */
function pow10(digits: number): number {
  const value: number | undefined = POW10[digits];
  if (value === undefined) {
    throw new AuthorizationError(
      'unsupported_currency',
      `最小单位位数 ${digits} 超出支持范围（0–3）：不猜，拒绝`,
      'currency',
    );
  }
  return value;
}

/** 取币种的最小单位位数。表外 / 形状不符 ⇒ `unsupported_currency`（不猜）。 */
export function minorDigitsOf(currency: unknown): number {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new AuthorizationError(
      'unsupported_currency',
      `币种必须是 ISO 4217 大写三字母，收到 ${JSON.stringify(currency)}`,
      'currency',
    );
  }
  const digits = CURRENCY_MINOR_DIGITS[currency];
  if (digits === undefined) {
    throw new AuthorizationError(
      'unsupported_currency',
      `币种 ${currency} 不在最小单位位数表里：不猜位数（猜错即把金额算错），` +
        `请在 CURRENCY_MINOR_DIGITS 明确登记后再用`,
      'currency',
    );
  }
  return digits;
}

// ---------------------------------------------------------------------------
// 金额：wire 十进制字符串 ⇄ 领域整数最小单位
// ---------------------------------------------------------------------------

const WIRE_AMOUNT_RE = /^[0-9]+(\.[0-9]{1,4})?$/;

/**
 * wire 十进制字符串 → 整数最小单位。
 *
 * **逐位字符串解析，绝不 `parseFloat(str) * 100`**（裁决明文禁止）：
 * 整数部分与小数部分分别取子串，纯整数运算合成。
 */
export function parseWireAmount(wire: unknown, currency: unknown): number {
  const digits = minorDigitsOf(currency);
  if (typeof wire !== 'string' || !WIRE_AMOUNT_RE.test(wire)) {
    throw new AuthorizationError(
      'wire_amount_invalid',
      `wire 金额必须是十进制字符串（契约 ^[0-9]+(\\.[0-9]{1,4})?$），收到 ${JSON.stringify(wire)}`,
      'amount',
    );
  }
  const dot = wire.indexOf('.');
  const intPart = dot === -1 ? wire : wire.slice(0, dot);
  const fracPart = dot === -1 ? '' : wire.slice(dot + 1);
  if (fracPart.length > digits && /[^0]/.test(fracPart.slice(digits))) {
    throw new AuthorizationError(
      'wire_amount_not_representable',
      `${currency} 的最小单位是 ${digits} 位小数，但 wire 金额 ${wire} 的更低位的非零：` +
        `不能精确表示，拒绝（不四舍五入、不截断）`,
      'amount',
    );
  }
  const fracPadded = fracPart.slice(0, digits).padEnd(digits, '0');
  const value = Number(intPart) * pow10(digits) + (fracPadded === '' ? 0 : Number(fracPadded));
  if (!Number.isSafeInteger(value)) {
    throw new AuthorizationError(
      'wire_amount_not_representable',
      `wire 金额 ${wire} 换算后超出安全整数范围：${String(value)}`,
      'amount',
    );
  }
  return value;
}

/** 整数最小单位 → wire 十进制字符串（定点，位数与币种一致）。 */
export function formatWireAmount(minorUnits: unknown, currency: unknown): string {
  const digits = minorDigitsOf(currency);
  if (typeof minorUnits !== 'number' || !Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new AuthorizationError(
      'wire_amount_invalid',
      `领域金额必须是非负整数最小单位（分），收到 ${JSON.stringify(minorUnits)}`,
      'amount',
    );
  }
  const unit = pow10(digits);
  const intPart = Math.floor(minorUnits / unit);
  const fracPart = minorUnits % unit;
  if (digits === 0) {
    return String(intPart);
  }
  return `${intPart}.${String(fracPart).padStart(digits, '0')}`;
}

// ---------------------------------------------------------------------------
// 时间戳：wire ISO-8601 UTC 字符串 ⇄ 领域整数毫秒
// ---------------------------------------------------------------------------

const WIRE_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/**
 * wire ISO-8601 UTC 字符串 → 领域整数毫秒。
 *
 * 用 `setUTCFullYear`（而非 `Date.UTC`）以正确处理四位年份里的 `0000`–`0099`；
 * 之后**回读各分量复核**，因此 `2026-02-30T…` 这类非法日历时刻会被拒，
 * 而不是被静默归一成 3 月 2 日。
 *
 * **不读墙钟**：只解析调用方给出的字符串，结果对同一输入恒定。
 */
export function parseWireTimestamp(wire: unknown): number {
  if (typeof wire !== 'string') {
    throw new AuthorizationError(
      'wire_timestamp_invalid',
      `wire 时间戳必须是 ISO-8601 UTC 字符串，收到 ${JSON.stringify(wire)}`,
      'expiresAt',
    );
  }
  const match = WIRE_TIMESTAMP_RE.exec(wire);
  if (match === null) {
    throw new AuthorizationError(
      'wire_timestamp_invalid',
      `wire 时间戳形状不符（期望 YYYY-MM-DDThh:mm:ss[.f{1,6}]Z），收到 ${JSON.stringify(wire)}`,
      'expiresAt',
    );
  }
  const [, y, mo, d, h, mi, s, frac = ''] = match;
  if (frac.length > 3 && /[^0]/.test(frac.slice(3))) {
    throw new AuthorizationError(
      'wire_timestamp_not_representable',
      `注入时钟精度是毫秒（3 位小数），但 ${wire} 的微秒位非零：不能精确表示，拒绝（不截断）`,
      'expiresAt',
    );
  }
  const ms = frac === '' ? 0 : Number(frac.slice(0, 3).padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi), Number(s), ms);
  const epoch = date.getTime();
  if (
    !Number.isFinite(epoch) ||
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d) ||
    date.getUTCHours() !== Number(h) ||
    date.getUTCMinutes() !== Number(mi) ||
    date.getUTCSeconds() !== Number(s) ||
    date.getUTCMilliseconds() !== ms
  ) {
    throw new AuthorizationError(
      'wire_timestamp_invalid',
      `${wire} 不是合法的 UTC 日历时刻（含 02-30 之类的越界日期）`,
      'expiresAt',
    );
  }
  return epoch;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 领域整数毫秒 → wire ISO-8601 UTC 字符串（毫秒精度，恒以 `Z` 收尾）。 */
export function formatWireTimestamp(epochMs: unknown): string {
  if (typeof epochMs !== 'number' || !Number.isSafeInteger(epochMs)) {
    throw new AuthorizationError(
      'wire_timestamp_invalid',
      `领域时间戳必须是安全整数（毫秒），收到 ${JSON.stringify(epochMs)}`,
      'expiresAt',
    );
  }
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) {
    throw new AuthorizationError(
      'wire_timestamp_invalid',
      `领域时间戳 ${epochMs} 无法表示为四位年份的 ISO-8601 时刻`,
      'expiresAt',
    );
  }
  return (
    `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
    `.${pad(date.getUTCMilliseconds(), 3)}Z`
  );
}

// ---------------------------------------------------------------------------
// 对象级：ConfirmAction / ExternalReceipt 的 wire 形态
// ---------------------------------------------------------------------------

/** `ConfirmAction` 的 wire 形态（金额为十进制字符串、期限为 ISO-8601 字符串）。 */
export interface WireConfirmAction {
  readonly actionId: string;
  readonly accountRef: string;
  readonly taskRevision: number;
  readonly paramsDigest: string;
  readonly quoteRef: string;
  readonly amount: string;
  readonly currency: string;
  readonly expiresAt: string;
  readonly scope: string;
}

/** 领域 `ConfirmAction` → wire（金额与期限在边界换算）。 */
export function toWireConfirmAction(confirm: ConfirmAction): WireConfirmAction {
  return Object.freeze({
    actionId: confirm.actionId,
    accountRef: confirm.accountRef,
    taskRevision: confirm.taskRevision,
    paramsDigest: confirm.paramsDigest,
    quoteRef: confirm.quoteRef,
    amount: formatWireAmount(confirm.amount, confirm.currency),
    currency: confirm.currency,
    expiresAt: formatWireTimestamp(confirm.expiresAt),
    scope: confirm.scope,
  });
}

/**
 * wire → 领域 `ConfirmAction`。
 *
 * **只做编码换算**（金额、期限）；其余字段原样透传，由账本入口
 * `recordConfirmAction()` 做完整字段校验——校验只有一处，避免两套判据漂移。
 *
 * ## `taskId` 为何由调用方给，而不是从 wire 读（K-I28 修复）
 *
 * 领域 `ConfirmAction` 要求必填 `taskId`（K-I02 集成加入九项绑定，见 `types.ts` 的
 * `ActionBinding`），但 **wire / 冻结契约层不承载任务身份**：
 * `contracts/mobile-v1/schemas/confirm-action.schema.json` 是 `additionalProperties: false`
 * 且 `required` 里**没有** `taskId`——把 `taskId` 写进 wire 会被冻结契约判为"不允许的字段"
 * （K-I15 已实测并记录为集成残差）。所以任务身份只能由**账本绑定** `(taskId, actionId)`
 * 提供，由调用方在换算时显式传入。
 *
 * **默认值为 `''` 不是"猜一个任务"**：本模块**不校验** `taskId`（校验只有账本一处），
 * 未传时得到一个空串 `ConfirmAction`，它会被 `recordConfirmAction()` 的 `requireText`
 * 当场拒因——不会静默通过、也不会被误当成真实任务。调用方（账本/适配层）必须传入真实
 * `taskId`；本函数不读墙钟、不猜身份。
 *
 * 该修复不改变 wire 形状（对 `toWireConfirmAction` 零影响），因此冻结契约与既有冻结
 * fixture 仍逐字节成立；`taskId` 落在**领域回程**而非 wire 上。
 */
export function fromWireConfirmAction(wire: WireConfirmAction, taskId: string = ''): ConfirmAction {
  const amount = parseWireAmount(wire?.amount, wire?.currency);
  const expiresAt = parseWireTimestamp(wire?.expiresAt);
  return Object.freeze({
    taskId,
    actionId: wire.actionId,
    accountRef: wire.accountRef,
    taskRevision: wire.taskRevision,
    paramsDigest: wire.paramsDigest,
    quoteRef: wire.quoteRef,
    amount,
    currency: wire.currency,
    scope: wire.scope as ConfirmAction['scope'],
    expiresAt,
  });
}

/**
 * `ExternalReceipt` 的 wire 形态（`observedAt` 为 ISO-8601 字符串）。
 *
 * 注意：契约 `external-receipt.schema.json` 的根对象是 `additionalProperties: false`，
 * 允许的键是 7 个必需字段 + `verificationMode` + `cancellation` + `metadata`——
 * **没有** `detail`。因此领域侧的自由文本 `detail` 在 wire 层收进 `metadata.detail`
 * （`metadata` 是契约允许的 object）；这一点必须由本边界模块负责，否则写出的 wire
 * 会被契约校验器判为"不允许的字段"。
 */
export interface WireExternalReceipt {
  readonly actionId: string;
  readonly provider: string;
  readonly requestRef: string;
  readonly externalId: string;
  readonly observedState: ReceiptObservedState;
  readonly observedAt: string;
  readonly evidenceRef: string;
  readonly verificationMode: VerificationMode;
  readonly metadata?: { readonly detail?: string };
}

/** 领域回执 → wire。`observedAt` 在边界换算；`detail` 收进 `metadata.detail`。 */
export function toWireExternalReceipt(receipt: ExternalReceipt): WireExternalReceipt {
  const base = {
    actionId: receipt.actionId,
    provider: receipt.provider,
    requestRef: receipt.requestRef,
    externalId: receipt.externalId,
    observedState: receipt.observedState,
    observedAt: formatWireTimestamp(receipt.observedAt),
    evidenceRef: receipt.evidenceRef,
    verificationMode: receipt.verificationMode,
  };
  return Object.freeze(
    receipt.detail === '' ? base : { ...base, metadata: Object.freeze({ detail: receipt.detail }) },
  );
}

/**
 * wire → 领域回执。
 *
 * 只做 `observedAt` 换算；`observedState` / `verificationMode` 做**词表合法性**检查
 * （不换算、不归一），好让调用方拿到可机读的 `untrusted_receipt` 而不是一个
 * 形状对但取值越界的对象。
 */
export function fromWireExternalReceipt(wire: WireExternalReceipt): {
  readonly actionId: string;
  readonly provider: string;
  readonly requestRef: string;
  readonly externalId: string;
  readonly observedState: ReceiptObservedState;
  readonly observedAt: number;
  readonly evidenceRef: string;
  readonly verificationMode: VerificationMode;
  readonly detail: string;
} {
  if (
    typeof wire?.observedState !== 'string' ||
    !(RECEIPT_OBSERVED_STATES as readonly string[]).includes(wire.observedState)
  ) {
    throw new AuthorizationError(
      'untrusted_receipt',
      `回执 observedState 必须是 ${RECEIPT_OBSERVED_STATES.join(' / ')} 之一，收到 ${String(wire?.observedState)}`,
    );
  }
  if (
    typeof wire?.verificationMode !== 'string' ||
    !(VERIFICATION_MODES as readonly string[]).includes(wire.verificationMode)
  ) {
    throw new AuthorizationError(
      'untrusted_receipt',
      `回执 verificationMode 必须是 ${VERIFICATION_MODES.join(' / ')} 之一，收到 ${String(wire?.verificationMode)}`,
    );
  }
  return Object.freeze({
    actionId: wire.actionId,
    provider: wire.provider,
    requestRef: wire.requestRef,
    externalId: wire.externalId,
    observedState: wire.observedState,
    observedAt: parseWireTimestamp(wire.observedAt),
    evidenceRef: wire.evidenceRef,
    verificationMode: wire.verificationMode,
    detail: wire.metadata?.detail ?? '',
  });
}
