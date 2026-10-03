/**
 * M06 **一次性原生确认** —— 购买授权链的消费与出口。
 *
 * ## 本模块要关的洞：「模型不能伪造用户确认」
 *
 * 对策是**信任来源**，不是逐字段校验（形状可以照抄）。两层叠加：
 *
 * 1. **消费 K07 账本**：{@link consumeNativePurchaseConfirmation} 收到的 `grant` 只有 `grantId`
 *    等字段；真正的确认动作是调用 **K07 账本**的 `consume()`——K07 在自己私有的登记表里
 *    核对这张授权，找不到就抛 `grant_not_found`。于是「模型自造一张
 *    `{ grantId: 'x', amount: 1 }`」在本包**不可表达**：那个 `grantId` 在账本里根本不存在。
 *    K07 的 `consume()` 同时是**原子占用**：第二次占用抛 `grant_already_consumed` ⇒ 一次性。
 * 2. **本包可信根**：`consume` 成功后产出的 {@link NativeConfirmationReceipt} 登记进本模块私有的
 *    `WeakSet`。下游 {@link authorizePurchase} **只认登记过的实例**；形状相同但未登记的对象
 *    （含 `{ ...receipt }` 拷贝）一律 `untrusted_native_confirmation`。
 *
 * 因此「用户确认」不是一个能被写死的布尔值，而是**一串有来源、有绑定、有一次性命的凭证**。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - 本模块**不 import K07**：`K07LedgerView` 是 K07 `AuthorizationLedger` 的**结构投影**，
 *   真机由适配层把账本传入（`tests/mobile-meituan/M06/` 用**真实 K07 账本**做端到端验证）。
 * - **未接原生确认页 / Android 进程**：`surface` 只是可审计的界面标识，
 *   「只有原生确认页能调 `consume`」是架构约定，本包未在真机验证。
 * - **未持久化**：一次性命由 K07 账本保证；本包不持有存储。
 */

import { isValidMinorUnits } from '../cart/index.js';
import { assertWithinCeiling } from './ceiling.js';
import { PurchaseConfirmationError } from './errors.js';
import { PURCHASE_BINDING_FIELDS, type PurchaseBindingField } from './errors.js';
import {
  CONFIRM_SCOPES,
  type AmountCeiling,
  type AuthorizedPurchase,
  type ConfirmScope,
  type K07LedgerView,
  type K07GrantView,
  type NativeConfirmationReceipt,
  type PurchaseBinding,
  type PurchaseConfirmationViewModel,
} from './types.js';

/** 由本模块签发的确认回执登记表。私有、不导出 ⇒ 调用方无法枚举、无法伪造。 */
const ISSUED_NATIVE_CONFIRMATIONS = new WeakSet<object>();

/** 参数摘要形状：与 K07 `ConfirmAction` 一致（`sha256:<64 位小写十六进制>`）。 */
const PARAMS_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 账号引用形状（是引用，不是凭据）。 */
const ACCOUNT_REF_PATTERN = /^acct:[A-Za-z0-9._:-]+$/;

/** 八项绑定（不含期限）——传给 K07 `consume()` 的 `actual`。 */
const BINDING_WITHOUT_EXPIRY: readonly PurchaseBindingField[] = [
  'actionId',
  'accountRef',
  'taskRevision',
  'paramsDigest',
  'quoteRef',
  'amount',
  'currency',
  'scope',
];

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

function requireMinorUnits(value: unknown, field: string): number {
  if (!isValidMinorUnits(value)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `金额 ${field} 必须是非负整数最小单位（分），禁止浮点；收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `字段 ${field} 必须是非负安全整数，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `字段 ${field} 必须是安全整数，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

function requireAccountRef(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT_REF_PATTERN.test(value)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `accountRef 必须是账号引用（形如 acct:meituan:7788，非凭据），收到 ${JSON.stringify(value)}`,
      'accountRef',
    );
  }
  return value;
}

function requireParamsDigest(value: unknown): string {
  if (typeof value !== 'string' || !PARAMS_DIGEST_PATTERN.test(value)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `paramsDigest 必须是 sha256:<64 位小写十六进制>，收到 ${JSON.stringify(value)}`,
      'paramsDigest',
    );
  }
  return value;
}

function requireScope(value: unknown): ConfirmScope {
  if (typeof value !== 'string' || !(CONFIRM_SCOPES as readonly string[]).includes(value)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `scope 必须是 ${CONFIRM_SCOPES.join(' / ')} 之一，收到 ${JSON.stringify(value)}`,
      'scope',
    );
  }
  return value as ConfirmScope;
}

function requireCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `币种 currency 必须是 ISO 4217 大写三字母（如 CNY），收到 ${JSON.stringify(value)}`,
      'currency',
    );
  }
  return value;
}

/** 校验并冻结八项绑定 + 期限。 */
export function validatePurchaseBinding(input: PurchaseBinding): PurchaseBinding {
  return Object.freeze({
    actionId: requireText(input?.actionId, 'actionId'),
    accountRef: requireAccountRef(input?.accountRef),
    taskRevision: requireNonNegativeInteger(input?.taskRevision, 'taskRevision'),
    paramsDigest: requireParamsDigest(input?.paramsDigest),
    quoteRef: requireText(input?.quoteRef, 'quoteRef'),
    amount: requireMinorUnits(input?.amount, 'amount'),
    currency: requireCurrency(input?.currency),
    scope: requireScope(input?.scope),
    expiresAt: requireInteger(input?.expiresAt, 'expiresAt'),
  });
}

/** 逐项找出两份绑定中**第一个**不一致的字段（无差异返回 null）。 */
export function findPurchaseBindingMismatch(
  left: PurchaseBinding,
  right: PurchaseBinding,
): PurchaseBindingField | null {
  for (const field of PURCHASE_BINDING_FIELDS) {
    if (left[field] !== right[field]) {
      return field;
    }
  }
  return null;
}

function grantViewAsBinding(grant: K07GrantView): PurchaseBinding {
  return {
    actionId: grant.actionId,
    accountRef: grant.accountRef,
    taskRevision: grant.taskRevision,
    paramsDigest: grant.paramsDigest,
    quoteRef: grant.quoteRef,
    amount: grant.amount,
    currency: grant.currency,
    scope: grant.scope as ConfirmScope,
    expiresAt: grant.expiresAt,
  };
}

/**
 * **消费 K07 一次性原生确认**：把一张 K07 授权经账本原子占用后，换成本包可信的确认回执。
 *
 * 判定顺序（顺序即优先级，测试依赖它给出确定性拒因）：
 * 1. 未传账本 / 未传授权 ⇒ `missing_native_confirmation`；
 * 2. 授权已占用 ⇒ `native_confirmation_already_consumed`；
 * 3. 授权已过期（`now >= expiresAt`，到点即失效）⇒ `native_confirmation_expired`；
 * 4. 授权绑定与预期不符 ⇒ `native_confirmation_binding_mismatch`（带 `field`）；
 * 5. 调 **K07 账本** `consume()` 原子占用——**这是唯一的确认落地动作**：
 *    - 自造的 `grantId` 在账本里不存在 ⇒ K07 抛 `grant_not_found`；
 *    - 并发/重复占用 ⇒ K07 抛 `grant_already_consumed`；
 *    - 绑定不符 ⇒ K07 抛 `grant_binding_mismatch`。
 *
 * @returns 登记进本模块可信根的一次性确认回执。
 */
export function consumeNativePurchaseConfirmation(input: {
  readonly ledger: K07LedgerView | null | undefined;
  readonly grant: K07GrantView | null | undefined;
  /** 期望被确认的绑定（由确认 ViewModel 的订单参数构造）。 */
  readonly expected: PurchaseBinding;
  /** 确认界面标识（可审计）。 */
  readonly surface: string;
  /** 注入时钟的当前时刻。 */
  readonly now: number;
}): NativeConfirmationReceipt {
  const ledger = input?.ledger;
  const grant = input?.grant;
  if (ledger === null || ledger === undefined || typeof ledger.consume !== 'function') {
    throw new PurchaseConfirmationError(
      'missing_native_confirmation',
      '未装配 K07 账本：没有可核对的账本，不得确认购买（缺账本即拒，不默认放行）',
    );
  }
  if (grant === null || grant === undefined) {
    throw new PurchaseConfirmationError(
      'missing_native_confirmation',
      '未携带一次性原生确认：没有 K07 授权不得确认购买（缺省即拒）',
    );
  }

  const expected = validatePurchaseBinding(input.expected);
  const surface = requireText(input.surface, 'surface');
  const now = requireInteger(input.now, 'now');

  if (grant.consumed === true || grant.consumedAt !== null) {
    throw new PurchaseConfirmationError(
      'native_confirmation_already_consumed',
      `授权 ${String(grant.grantId)} 已被占用（${String(grant.consumedAt)}）：` +
        `一次性确认只能使用一次，重复点击 / 重放一律拒绝`,
      'actionId',
    );
  }
  if (now >= grant.expiresAt) {
    throw new PurchaseConfirmationError(
      'native_confirmation_expired',
      `授权 ${String(grant.grantId)} 已过期：当前 ${now} ≥ expiresAt ${String(grant.expiresAt)}`,
      'expiresAt',
    );
  }

  const mismatch = findPurchaseBindingMismatch(expected, grantViewAsBinding(grant));
  if (mismatch !== null) {
    throw new PurchaseConfirmationError(
      'native_confirmation_binding_mismatch',
      `确认的绑定与当前订单参数不一致：字段 ${mismatch} 预期 ${JSON.stringify(
        expected[mismatch],
      )}，授权绑定的是 ${JSON.stringify(grantViewAsBinding(grant)[mismatch])}——关键条件变化即失效，须重新确认`,
      mismatch,
    );
  }

  // ---- 唯一的确认落地动作：调用 K07 账本原子占用（K07 抛错原样上抛，不吞）----
  const actual: Record<string, unknown> = {};
  for (const field of BINDING_WITHOUT_EXPIRY) {
    actual[field] = expected[field];
  }
  const outcome = ledger.consume({
    grantId: grant.grantId,
    actual: actual as unknown as PurchaseBinding,
  });

  const receipt: NativeConfirmationReceipt = Object.freeze({
    actionId: outcome.grant.actionId,
    grantId: outcome.grant.grantId,
    submissionId: outcome.submission.submissionId,
    binding: Object.freeze({ ...grantViewAsBinding(outcome.grant) }),
    paramsDigest: outcome.grant.paramsDigest,
    amountMinor: outcome.grant.amount,
    currency: outcome.grant.currency,
    confirmedAt: now,
    surface,
    consumed: true as const,
  });
  ISSUED_NATIVE_CONFIRMATIONS.add(receipt);
  return receipt;
}

/** 该回执是否是本模块可信签发器签发的（可信根判据）。 */
export function isTrustedNativeConfirmation(value: unknown): value is NativeConfirmationReceipt {
  return typeof value === 'object' && value !== null && ISSUED_NATIVE_CONFIRMATIONS.has(value);
}

/**
 * **硬判据**：没有可信确认回执时必须拒绝。
 * 缺省 / 非对象 / 形状相同但未登记（含拷贝）⇒ 一律抛错。
 */
export function assertTrustedNativeConfirmation(value: unknown): NativeConfirmationReceipt {
  if (value === undefined || value === null) {
    throw new PurchaseConfirmationError(
      'missing_native_confirmation',
      '必须携带一次性原生确认回执：没有用户确认不得购买（缺省即拒）',
    );
  }
  if (typeof value !== 'object') {
    throw new PurchaseConfirmationError(
      'untrusted_native_confirmation',
      `确认回执必须是对象，收到 ${JSON.stringify(value)}`,
    );
  }
  if (!ISSUED_NATIVE_CONFIRMATIONS.has(value)) {
    throw new PurchaseConfirmationError(
      'untrusted_native_confirmation',
      '该确认回执不是本模块可信签发器产生的：用户确认必须来自可信授权链，' +
        '不得由调用方自造或拷贝（与 K07 的 untrusted_attestation 同源纪律）',
    );
  }
  return value as NativeConfirmationReceipt;
}

/**
 * **购买出口**：拿一份可信确认回执 + 金额上限 + 确认 ViewModel，核对一致后产出授权购买。
 *
 * 这一层做的核对是**展示与授权是否一致**：回执确认的摘要/金额/币种/范围必须与
 * ViewModel 逐项相等（防「展示一份、批另一份」），且在金额上限之内。
 *
 * @throws {PurchaseConfirmationError} 缺确认 / 非可信 / 过期 /
 *   `view_model_binding_mismatch` / 超上限。
 */
export function authorizePurchase(input: {
  readonly receipt: NativeConfirmationReceipt | null | undefined;
  readonly ceiling: AmountCeiling;
  readonly viewModel: PurchaseConfirmationViewModel;
  readonly now: number;
}): AuthorizedPurchase {
  const receipt = assertTrustedNativeConfirmation(input?.receipt);
  const now = requireInteger(input?.now, 'now');

  if (now >= receipt.binding.expiresAt) {
    throw new PurchaseConfirmationError(
      'native_confirmation_expired',
      `确认回执已过期：当前 ${now} ≥ expiresAt ${receipt.binding.expiresAt}`,
      'expiresAt',
    );
  }

  const viewModel = input.viewModel;
  if (receipt.paramsDigest !== viewModel.paramsDigest) {
    throw new PurchaseConfirmationError(
      'view_model_binding_mismatch',
      `确认回执的 paramsDigest（${receipt.paramsDigest}）与 ViewModel（${viewModel.paramsDigest}）不一致：` +
        `被批准的订单参数与展示给用户的不符`,
      'paramsDigest',
    );
  }
  if (receipt.amountMinor !== viewModel.amounts.totalMinor) {
    throw new PurchaseConfirmationError(
      'view_model_binding_mismatch',
      `确认回执的金额（${receipt.amountMinor}）与 ViewModel 总价（${viewModel.amounts.totalMinor}）不一致`,
      'amount',
    );
  }
  if (receipt.currency !== viewModel.amounts.currency) {
    throw new PurchaseConfirmationError(
      'view_model_binding_mismatch',
      `确认回执的币种（${receipt.currency}）与 ViewModel（${viewModel.amounts.currency}）不一致`,
      'currency',
    );
  }
  if (receipt.binding.scope !== viewModel.scope) {
    throw new PurchaseConfirmationError(
      'view_model_binding_mismatch',
      `确认回执的范围（${receipt.binding.scope}）与 ViewModel（${viewModel.scope}）不一致`,
      'scope',
    );
  }

  // 金额上限（缺上限即拒）。
  assertWithinCeiling(receipt.amountMinor, receipt.currency, input.ceiling);

  return Object.freeze({
    actionId: receipt.actionId,
    grantId: receipt.grantId,
    submissionId: receipt.submissionId,
    paramsDigest: receipt.paramsDigest,
    amountMinor: receipt.amountMinor,
    ceilingMinor: input.ceiling.ceilingMinor,
    currency: receipt.currency,
    scope: receipt.binding.scope,
    authorizedAt: now,
    requiresNativeConfirmation: true as const,
  });
}
