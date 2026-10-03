/**
 * M07 一次性授权引用的**可信根**（零依赖）。
 *
 * ## 与 K07 同源的那条纪律
 *
 * K07 关掉的 P0 是"客户端可自称用户已批准"。同一个洞在本层会以另一种面貌出现：
 * "调用方自造一份 `{ grantId, amount: 1, scope: 'submit-order' }` 就算拿到授权"。
 * 对策不是逐字段校验（形状可以照抄），而是**来源登记**：
 *
 * - 只有 {@link createAuthorizationRef} 产生的引用会被登记进模块私有的 `WeakSet`；
 * - {@link submit} 只认登记过的实例，形状相同的自造对象一律
 *   `untrusted_authorization_ref`；
 * - 复制的引用（`{ ...ref }`）也**不是**同一个对象 ⇒ 同样被拒
 *   （"拿一份拷贝当新授权"走不通）。
 *
 * 真机接线上，`AuthorizationRef` 应由 K07 账本签发后经适配层原样传入；
 * 本模块提供同语义的本地签发器，只为让本包**可被 fixture 独立驱动**。
 */

import { OrderSubmitError } from './errors.js';
import {
  ORDER_SCOPES,
  type AuthorizationRef,
  type OrderBinding,
  type OrderScope,
} from './types.js';

/** 由本模块签发的授权引用登记表。私有、不导出 ⇒ 调用方无法枚举、无法伪造。 */
const ISSUED_AUTHORIZATION_REFS = new WeakSet<object>();

/** 参数摘要形状：接受 M04 结构指纹（`v1-xxxxxxxx`）或 K07 契约 sha256 形式。 */
const PARAMS_DIGEST_PATTERN = /^(v1-[0-9a-f]{8}|sha256:[0-9a-f]{64})$/;

/** 账号引用形状（是引用，不是凭据）。 */
const ACCOUNT_REF_PATTERN = /^acct:[A-Za-z0-9._:-]+$/;

/** 九个绑定字段名（逐项核对与报错定位用）。 */
export const ORDER_BINDING_FIELDS = [
  'actionId',
  'merchantId',
  'accountRef',
  'taskRevision',
  'paramsDigest',
  'quoteRef',
  'amount',
  'currency',
  'scope',
] as const;

export type OrderBindingField = (typeof ORDER_BINDING_FIELDS)[number];

function requireText(value: unknown, field: OrderBindingField | string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OrderSubmitError('invalid_submit_request', `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`, field);
  }
  return value;
}

/** 金额：非负整数最小单位（分）。浮点 / NaN / 负数一律拒。 */
function requireMinorUnits(value: unknown, field: OrderBindingField): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderSubmitError(
      'invalid_submit_request',
      `金额 ${field} 必须是非负整数最小单位（分），禁止浮点；收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

function requireNonNegativeCount(value: unknown, field: OrderBindingField): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderSubmitError('invalid_submit_request', `字段 ${field} 必须是非负安全整数，收到 ${JSON.stringify(value)}`, field);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new OrderSubmitError('invalid_submit_request', `字段 ${field} 必须是安全整数，收到 ${JSON.stringify(value)}`, field);
  }
  return value;
}

function requireAccountRef(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT_REF_PATTERN.test(value)) {
    throw new OrderSubmitError(
      'invalid_submit_request',
      `accountRef 必须是账号引用（形如 acct:meituan:7788，非凭据），收到 ${JSON.stringify(value)}`,
      'accountRef',
    );
  }
  return value;
}

function requireParamsDigest(value: unknown): string {
  if (typeof value !== 'string' || !PARAMS_DIGEST_PATTERN.test(value)) {
    throw new OrderSubmitError(
      'invalid_submit_request',
      `paramsDigest 必须是 M04 结构指纹（v1-xxxxxxxx）或 sha256:<64 位小写十六进制>，收到 ${JSON.stringify(value)}`,
      'paramsDigest',
    );
  }
  return value;
}

function requireCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new OrderSubmitError(
      'invalid_submit_request',
      `币种 currency 必须是 ISO 4217 大写三字母（如 CNY），收到 ${JSON.stringify(value)}`,
      'currency',
    );
  }
  return value;
}

function requireScope(value: unknown): OrderScope {
  if (typeof value !== 'string' || !(ORDER_SCOPES as readonly string[]).includes(value)) {
    throw new OrderSubmitError(
      'invalid_submit_request',
      `scope 必须是 ${ORDER_SCOPES.join(' / ')}（下单范围）：payment / purchase 等不得在本模块执行；收到 ${JSON.stringify(value)}`,
      'scope',
    );
  }
  return value as OrderScope;
}

/** 校验并冻结九项绑定。 */
export function validateOrderBinding(input: OrderBinding): OrderBinding {
  return Object.freeze({
    actionId: requireText(input?.actionId, 'actionId'),
    merchantId: requireText(input?.merchantId, 'merchantId'),
    accountRef: requireAccountRef(input?.accountRef),
    taskRevision: requireNonNegativeCount(input?.taskRevision, 'taskRevision'),
    paramsDigest: requireParamsDigest(input?.paramsDigest),
    quoteRef: requireText(input?.quoteRef, 'quoteRef'),
    amount: requireMinorUnits(input?.amount, 'amount'),
    currency: requireCurrency(input?.currency),
    scope: requireScope(input?.scope),
  });
}

/** 从任意绑定形状里取九项（归一比较用）。 */
export function bindingOf(source: OrderBinding): OrderBinding {
  return Object.freeze({
    actionId: source.actionId,
    merchantId: source.merchantId,
    accountRef: source.accountRef,
    taskRevision: source.taskRevision,
    paramsDigest: source.paramsDigest,
    quoteRef: source.quoteRef,
    amount: source.amount,
    currency: source.currency,
    scope: source.scope,
  });
}

/** 逐项找出两份绑定中第一个不一致的字段（无差异返回 null）。 */
export function findOrderBindingMismatch(left: OrderBinding, right: OrderBinding): OrderBindingField | null {
  for (const field of ORDER_BINDING_FIELDS) {
    if (left[field] !== right[field]) {
      return field;
    }
  }
  return null;
}

/**
 * 造一张**可信**一次性授权引用（本模块签发，登记进私有 WeakSet）。
 *
 * `consumed` 三件套只用于**还原一条已持久化的引用**（真机适配层从 K07 存储里读出
 * 一条已被占用的授权时原样带上）。省略即"全新、未占用"。
 */
export function createAuthorizationRef(input: {
  readonly grantId: string;
  readonly grantedBy: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly binding: OrderBinding;
  readonly consumed?: boolean;
  readonly consumedAt?: number | null;
  readonly consumedByKey?: string | null;
}): AuthorizationRef {
  const binding = validateOrderBinding(input?.binding);
  const issuedAt = requireInteger(input?.issuedAt, 'issuedAt');
  const expiresAt = requireInteger(input?.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt) {
    throw new OrderSubmitError(
      'invalid_submit_request',
      `授权期限必须晚于签发时刻：issuedAt ${issuedAt} ≥ expiresAt ${expiresAt}`,
      'expiresAt',
    );
  }
  const consumed = input?.consumed === true;
  const consumedAt = consumed ? (input?.consumedAt ?? issuedAt) : (input?.consumedAt ?? null);
  if (consumed && consumedAt === null) {
    throw new OrderSubmitError('invalid_submit_request', '已占用的授权必须给出 consumedAt', 'consumedAt');
  }
  const ref: AuthorizationRef = Object.freeze({
    ...binding,
    grantId: requireText(input?.grantId, 'grantId'),
    issuedAt,
    expiresAt,
    grantedBy: requireText(input?.grantedBy, 'grantedBy'),
    consumed,
    consumedAt,
    consumedByKey: consumed ? (input?.consumedByKey ?? null) : null,
  });
  ISSUED_AUTHORIZATION_REFS.add(ref);
  return ref;
}

/** 该引用是否是本模块签发的（可信根判据）。 */
export function isTrustedAuthorizationRef(value: unknown): value is AuthorizationRef {
  return typeof value === 'object' && value !== null && ISSUED_AUTHORIZATION_REFS.has(value);
}

/**
 * **硬判据**：没有可信授权引用时必须拒绝提交。
 * 缺省 / 非对象 / 形状相同但未登记 ⇒ 一律抛错（分别给出具体拒因）。
 */
export function assertTrustedAuthorizationRef(value: unknown): AuthorizationRef {
  if (value === undefined || value === null) {
    throw new OrderSubmitError(
      'missing_authorization_ref',
      '提交必须携带一次性授权引用：没有授权不得提交（缺省即拒）',
    );
  }
  if (typeof value !== 'object') {
    throw new OrderSubmitError(
      'untrusted_authorization_ref',
      `授权引用必须是对象，收到 ${JSON.stringify(value)}`,
    );
  }
  if (!ISSUED_AUTHORIZATION_REFS.has(value)) {
    throw new OrderSubmitError(
      'untrusted_authorization_ref',
      '该授权引用不是本模块可信签发器产生的：批准必须来自可信授权链，' +
        '不得由调用方自造或拷贝（与 K07 的 untrusted_attestation 同源纪律）',
    );
  }
  return value as AuthorizationRef;
}
