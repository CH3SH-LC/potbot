/**
 * K07 授权与提交账本 —— **手机侧独立实现**（零依赖、纯 TS、可被 fixture 独立驱动）。
 *
 * ## 本模块要关掉的那个洞
 *
 * 现存 P0（外部监督点名、仍未关闭）：`apps/demo/server/adapters-actions.ts` 里
 * `user_approved` 与 `source` **取自请求体**（:673），而执行路径只检查 `revoked`（:875）。
 * 后果是**客户端可以自称"用户已批准"**——批准成了一个无法被第二方反驳的布尔值。
 *
 * 本模块给出的对策是**可信确认根**，三层叠加，任何一层被绕过都还剩两层：
 *
 * 1. **展示数据只来自账本**：`getDisplay()` 的返回值来自账本记录，
 *    `source` 是字面量 `'ledger'`；调用方若另外声明一份摘要，**逐项核对**，不一致即拒
 *    （`confirm_digest_mismatch` + `field`）。模型/JS 传来的展示字符串无法成为事实来源。
 * 2. **凭证只能由账本签发**：`attest()` 生成的 `ConfirmationAttestation` 在模块私有的
 *    `WeakSet` 里登记；`issueGrant()` 只认登记过的实例（`untrusted_attestation`），
 *    形状相同的自造对象无效。签发后账本内容若再变化，旧凭证也失效
 *    （`attestation_binding_mismatch`）。
 * 3. **授权一次性且原子占用**：授权绑定九项 + 期限；`consume()` 是**同步**方法，
 *    在同一段不可插入的代码里完成"标记已占用"与"落账提交记录"，重复占用抛
 *    `grant_already_consumed`，且一个动作至多一条提交记录。
 *
 * ## 三种"发出"的记账语义（结果未知的恢复靠它）
 *
 * `consume()`（同步）→ `send()`（异步）两步是刻意的接缝：
 * - 占用后**没调用** `send()` ⇒ 提交停在 `submitting` + `sendIntentAt === null` ⇒ 本地认为**未发出**；
 * - `send()` 在调用执行器端口**之前**先落账 `sendIntentAt`，端口抛错（模拟进程中途死亡）
 *   ⇒ 记录停在 `submitting` + `sendIntentAt !== null` ⇒ **已发出未知**；
 * - 端口回 `unknown` ⇒ 状态直接是 `unknown`。
 *
 * `recover()` 区分上述情形，并且**只**返回"继续同一条提交"或"查原单"；
 * 它返回的 `mayIssueNewGrant` / `mayCreateNewSubmission` 是字面量 `false`——
 * "另发授权 / 重复下单"在恢复入口的类型层面就不存在。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **未接入** `apps/demo/**` 的任何服务（本包只新建手机侧模块；旧 demo 一行未动）。
 * - **未接原生确认页 / Android 进程**：`attest()` 的调用者边界（"只有原生确认页能调"）
 *   是**架构约定**，本包未验证；把它当事实来源需要真机证据。
 * - **未持久化到手机 DB**：实现是单进程内存台账；崩溃恢复的**判据**已成型，
 *   但"重启后仍能读到同一份记录"依赖 K09 的存储端口，本包未接。
 * - 端口在本包内以**同步夹具**驱动；真机端口是异步的，`send()` 已按异步设计
 *   （发出意图在 `await` 之前落账），但**未在真机验证**。
 *
 * ## 与 `contracts/mobile-v1/` 的关系
 *
 * 字段名与八态词表**逐字一致**；`scope` 取值域、`accountRef` / `paramsDigest` 形状、
 * `grant.consumed`、回执 `verificationMode` 与"fixture 不得 confirmed"已对齐。
 * **编码分歧已由总协调裁决（2026-10-03，`contracts/mobile-v1/README.md`
 * §"金额与时间编码"）**：wire 层用十进制字符串金额与 ISO-8601 时间戳，领域层用整数分
 * 与注入时钟整数值，换算只在边界且必须精确。该换算已落在 `wire-codec.ts`；
 * 本账本的判据**只用整数**，不 import codec、不碰浮点。
 *
 * ## 与 `src/workledger/action-ledger.ts` 的关系（只对齐语义，不复制文件）
 *
 * 既有 `ActionLedger` 是**内核动作台账**：动作用 `(task_id, task_revision, kind, param_digest)`
 * 推导幂等键，核心是"重复点击返回同一对象"（R243）与七态 `prepared/handed_off/submitted/
 * confirmed_complete/result_unknown/user_reported_complete/invalidated_or_failed`。
 * 本模块是**手机侧的授权与提交账本**，关注点不同因而刻意不复用其形状：
 * - 状态词表不同（本包严格用 `prepared/authorized/submitting/submitted/unknown/confirmed/
 *   failed/cancelled`，是六线契约 §5 给 `observedState` 定的词表）；
 * - 身份不同（既有台账的身份是 `param_digest`；本模块的身份是 **(taskId, actionId)** +
 *   九项绑定，并额外绑定**金额/币种/报价/权限范围**——这些是"下单"类外部动作必须钉住的量；
 *   绑上 taskId 后 actionId 是**任务内**键而不是全局键，见 K-R06 B1/B2）；
 * - 新增既有台账没有的一环：**一次性授权对象**与**提交记录的发出意图格**。
 * 相同的是纪律：不猜、不合并状态、只有可信回执能确认完成、内存台账 + 注入时钟、
 * 不引第三方依赖。
 */

import {
  AuthorizationError,
  BINDING_FIELDS,
  type BindingField,
  type ExpiryField,
} from './errors.js';
import type { Clock } from './clock.js';
import {
  CONFIRM_SCOPES,
  RECEIPT_OBSERVED_STATES,
  VERIFICATION_MODES,
  assertCompletionClaimable,
  bindingOf,
  canTransitionSubmission,
  describeExternalOutcome,
  findBindingMismatch,
  isSubmissionState,
  isTerminalSubmissionState,
  type ActionBinding,
  type AuthorizationGrant,
  type ConfirmAction,
  type ConfirmScope,
  type ConfirmationAttestation,
  type ConfirmationDisplay,
  type ConsumeInput,
  type ConsumeOutcome,
  type ExecutorOutcome,
  type ExternalExecutorPort,
  type ExternalOutcomeDescription,
  type ExternalReceipt,
  type ExternalSubmitRequest,
  type OrderQueryPort,
  type ReceiptObservedState,
  type ReconciliationOutcome,
  type RecoveryVerdict,
  type SubmissionRecord,
  type SubmissionState,
  type VerificationMode,
} from './types.js';

// ---------------------------------------------------------------------------
// 受控签发登记（可信根）
// ---------------------------------------------------------------------------

/**
 * 由本模块签发的凭证与回执的登记表。
 *
 * 模块私有的 `WeakSet`，**不导出**：调用方无法枚举、无法伪造。
 * `WeakSet` 而非 `Set`：不给这些短命对象造成额外引用、无需手工清理。
 */
const ISSUED_ATTESTATIONS = new WeakSet<object>();
const TRUSTED_RECEIPTS = new WeakSet<object>();

/** 受控执行器/供应方签发一张回执。**这是可信的唯一入口**——客户端自造的对象不在册。 */
export function createTrustedReceipt(input: {
  readonly actionId: string;
  readonly provider: string;
  readonly requestRef: string;
  readonly externalId: string;
  readonly observedState: ReceiptObservedState;
  readonly observedAt: number;
  readonly evidenceRef: string;
  /** 契约必需。`fixture` 模式的回执不得报 `confirmed`。 */
  readonly verificationMode: VerificationMode;
  readonly detail?: string;
}): ExternalReceipt {
  if (!(RECEIPT_OBSERVED_STATES as readonly string[]).includes(input.observedState)) {
    throw new AuthorizationError(
      'untrusted_receipt',
      `回执回报的状态必须是 ${RECEIPT_OBSERVED_STATES.join(' / ')} 之一，收到 ${String(input.observedState)}`,
    );
  }
  if (!(VERIFICATION_MODES as readonly string[]).includes(input.verificationMode)) {
    throw new AuthorizationError(
      'untrusted_receipt',
      `回执必须标明 verificationMode（${VERIFICATION_MODES.join(' / ')}），收到 ${String(input.verificationMode)}`,
    );
  }
  // 契约不变量（external-receipt.schema.json 的 oneOf/not）：
  // **fixture 产物不得冒充真实订单/支付/手机通过回执**。
  if (input.verificationMode === 'fixture' && input.observedState === 'confirmed') {
    throw new AuthorizationError(
      'fixture_receipt_cannot_confirm',
      'verificationMode=fixture 的回执不得回报 confirmed：假端口不得签发"真实完成"' +
        '（契约 external-receipt.schema.json 的不变量，与 R245 同源）',
    );
  }
  const receipt: ExternalReceipt = Object.freeze({
    actionId: requireText(input.actionId, 'actionId'),
    provider: requireText(input.provider, 'provider'),
    requestRef: requireText(input.requestRef, 'requestRef'),
    externalId: requireText(input.externalId, 'externalId'),
    observedState: input.observedState,
    observedAt: requireInteger(input.observedAt, 'observedAt'),
    evidenceRef: requireText(input.evidenceRef, 'evidenceRef'),
    verificationMode: input.verificationMode,
    detail: input.detail ?? '',
  });
  TRUSTED_RECEIPTS.add(receipt);
  return receipt;
}

// ---------------------------------------------------------------------------
// 字段校验（在**账本入口**做，不在使用点做）
// ---------------------------------------------------------------------------

function requireText(value: unknown, field: BindingField | string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      (BINDING_FIELDS as readonly string[]).includes(field) ? (field as BindingField) : null,
    );
  }
  return value;
}

/** 金额：**整数最小单位（分）**。浮点、NaN、Infinity、负数一律拒——算不准就不放行。 */
function requireMinorUnits(value: unknown, field: BindingField): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `金额 ${field} 必须是非负的整数最小单位（分），禁止浮点；收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

/** 币种：ISO 4217 大写三字母。不做大小写归一——静默归一正是"客户端说了算"的开端。 */
function requireCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `币种 currency 必须是 ISO 4217 大写三字母（如 CNY），收到 ${JSON.stringify(value)}`,
      'currency',
    );
  }
  return value;
}

function requireNonNegativeCount(value: unknown, field: BindingField): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `字段 ${field} 必须是非负安全整数，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

function requireInteger(value: unknown, field: BindingField | ExpiryField | 'observedAt'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `字段 ${field} 必须是安全整数，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

/** 账号引用：契约形状 `^acct:[A-Za-z0-9._:-]+$`（是引用，不是凭据）。 */
function requireAccountRef(value: unknown): string {
  if (typeof value !== 'string' || !/^acct:[A-Za-z0-9._:-]+$/.test(value)) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `accountRef 必须是账号引用（形如 acct:meituan:7788，非凭据），收到 ${JSON.stringify(value)}`,
      'accountRef',
    );
  }
  return value;
}

/** 参数摘要：契约形状 `^sha256:[0-9a-f]{64}$`（本模块只核对形状，不自己算摘要）。 */
function requireParamsDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `paramsDigest 必须是 sha256:<64 位小写十六进制>，收到 ${JSON.stringify(value)}`,
      'paramsDigest',
    );
  }
  return value;
}

/** 权限范围：取值域取自契约 enum，不自由发挥。 */
function requireScope(value: unknown): ConfirmScope {
  if (typeof value !== 'string' || !(CONFIRM_SCOPES as readonly string[]).includes(value)) {
    throw new AuthorizationError(
      'invalid_confirm_action',
      `scope 必须是 ${CONFIRM_SCOPES.join(' / ')} 之一（契约 enum），收到 ${JSON.stringify(value)}`,
      'scope',
    );
  }
  return value as ConfirmScope;
}

/** 校验并冻结一条确认请求（绑定九项 + 期限）。 */
function validateConfirmAction(input: ConfirmAction): ConfirmAction {
  return Object.freeze({
    taskId: requireText(input?.taskId, 'taskId'),
    actionId: requireText(input?.actionId, 'actionId'),
    accountRef: requireAccountRef(input?.accountRef),
    taskRevision: requireNonNegativeCount(input?.taskRevision, 'taskRevision'),
    paramsDigest: requireParamsDigest(input?.paramsDigest),
    quoteRef: requireText(input?.quoteRef, 'quoteRef'),
    amount: requireMinorUnits(input?.amount, 'amount'),
    currency: requireCurrency(input?.currency),
    scope: requireScope(input?.scope),
    expiresAt: requireInteger(input?.expiresAt, 'expiresAt'),
  });
}

/** 逐项核对"调用方声明 vs 账本"；不一致即拒（**这是展示数据可信的关键判据**）。 */
function assertClaimMatchesLedger(
  claim: Partial<ActionBinding> | undefined,
  ledgerValue: ConfirmAction,
  context: string,
): void {
  if (claim === undefined || claim === null) {
    return;
  }
  for (const field of BINDING_FIELDS) {
    const claimed = claim[field as keyof ActionBinding];
    if (claimed === undefined) {
      continue;
    }
    if (claimed !== ledgerValue[field]) {
      throw new AuthorizationError(
        'confirm_digest_mismatch',
        `${context}：调用方声明的 ${field}=${JSON.stringify(claimed)} 与账本里的 ` +
          `${JSON.stringify(ledgerValue[field])} 不一致——展示与授权数据只能来自账本，` +
          `不得采信模型或 JS 传来的字符串`,
        field,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 任务内键
// ---------------------------------------------------------------------------

/**
 * 账本内部一律以 `(taskId, actionId)` 为键（K-R06 B2 的封堵点）。
 *
 * 用 `JSON.stringify([taskId, actionId])` 而不是拼接分隔符：任务 id / 动作 id 的字面形状
 * 本模块不设限（`requireText` 只要求非空），拼接分隔符会有碰撞面（id 里含分隔符即串键）；
 * JSON 数组编码对任意字符串都是**单射**，因此不同 (taskId, actionId) 必得不同键。
 */
function scopeKey(taskId: string, actionId: string): string {
  return JSON.stringify([taskId, actionId]);
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export interface AuthorizationLedgerOptions {
  /** **必须注入**：本模块不持有任何时间源（过期/撤权判据全靠它）。 */
  readonly clock: Clock;
  /** 真实执行器端口。缺省 / `null` ⇒ `send()` 抛 `missing_executor`，且**不会**留下发出痕迹。 */
  readonly executor?: ExternalExecutorPort | null;
  /** 原单查询端口。缺省 / `null` ⇒ 结果未知时抛 `missing_order_query_port`（如实报缺，不猜）。 */
  readonly orderQuery?: OrderQueryPort | null;
  /** 授权 id 生成器（默认 `grant:<taskId>:<actionId>`：任务内一个动作至多一张授权，由 id 结构兜住）。 */
  readonly nextGrantId?: (taskId: string, actionId: string) => string;
  /** 提交 id 生成器（默认 `sub:<taskId>:<actionId>`：任务内一个动作至多一条提交记录）。 */
  readonly nextSubmissionId?: (taskId: string, actionId: string) => string;
}

/**
 * 授权与提交账本（单进程内存实现）。
 *
 * **写者唯一**：所有变更都经本对象的方法；对外只暴露冻结后的记录副本。
 * **原子性**：唯一需要原子的是 `consume()`，它是**同步**方法——
 * 单线程下同步方法不可被插入，因此"查占用标记 + 落账提交记录"不可能被第二条路径观察到中间态。
 * 重入对抗由 `consume({ onConsumed })` 在提交**之后**回调钉住（测试见 `tests/mobile-kernel/K07/`）。
 */
export class AuthorizationLedger {
  readonly #clock: Clock;
  readonly #executor: ExternalExecutorPort | null;
  readonly #orderQuery: OrderQueryPort | null;
  readonly #nextGrantId: (taskId: string, actionId: string) => string;
  readonly #nextSubmissionId: (taskId: string, actionId: string) => string;

  /**
   * 持久账本侧：确认请求（展示与授权的**唯一**事实来源）。
   * 键是 `scopeKey(taskId, actionId)`——**任务内**键，不是全局 actionId（K-R06 B1/B2）。
   */
  readonly #confirms = new Map<string, ConfirmAction>();
  readonly #grants = new Map<string, AuthorizationGrant>();
  readonly #grantIdByAction = new Map<string, string>();
  readonly #submissions = new Map<string, SubmissionRecord>();
  readonly #submissionIdByAction = new Map<string, string>();
  readonly #revokedActions = new Map<string, string>();

  constructor(options: AuthorizationLedgerOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new AuthorizationError('invalid_confirm_action', '构造账本必须注入 clock');
    }
    this.#clock = options.clock;
    this.#executor = options.executor ?? null;
    this.#orderQuery = options.orderQuery ?? null;
    this.#nextGrantId =
      options.nextGrantId ?? ((taskId: string, actionId: string) => `grant:${taskId}:${actionId}`);
    this.#nextSubmissionId =
      options.nextSubmissionId ?? ((taskId: string, actionId: string) => `sub:${taskId}:${actionId}`);
  }

  // -------------------------------------------------------------------------
  // ① 确认请求入账 + 账本读取（原生确认页的数据来源）
  // -------------------------------------------------------------------------

  /**
   * 登记一条确认请求（真机上是"持久账本里已经存在这一条"）。
   *
   * 重复登记**同一任务内**的同一 actionId 即拒；但**不同任务**下的同一 actionId
   * 是不同动作，各自可登记（K-R06 B2：actionId 不再是全局命名空间）。
   */
  recordConfirmAction(input: ConfirmAction): ConfirmAction {
    const confirm = validateConfirmAction(input);
    const key = scopeKey(confirm.taskId, confirm.actionId);
    if (this.#confirms.has(key)) {
      throw new AuthorizationError(
        'confirm_already_recorded',
        `任务 ${confirm.taskId} 的动作 ${confirm.actionId} 已有确认请求：一个动作只有一条确认请求，不得重复登记` +
          `（同一 actionId 在**不同任务**下是不同动作，互不冲突）`,
      );
    }
    this.#confirms.set(key, confirm);
    return confirm;
  }

  getConfirmAction(taskId: string, actionId: string): ConfirmAction | undefined {
    return this.#confirms.get(scopeKey(taskId, actionId));
  }

  /**
   * 账本内容发生变化（参数摘要 / 报价 / 金额 / 任务版本 / 期限被更新）。
   *
   * 真机场景：任务推进或报价刷新后，账本里的待执行参数被改写——**此前签发的确认凭证
   * 必须作废**（`issueGrant` 会以 `attestation_binding_mismatch` 拒绝），这正是
   * "关键条件变化即失效"的落点。已经批过授权的动作不得再改（`grant_already_issued`）。
   */
  amendConfirmAction(taskId: string, actionId: string, next: ConfirmAction): ConfirmAction {
    const key = scopeKey(taskId, actionId);
    const current = this.#requireConfirm(taskId, actionId);
    const amended = validateConfirmAction(next);
    if (amended.taskId !== current.taskId) {
      throw new AuthorizationError(
        'invalid_confirm_action',
        `改写确认请求不得更换任务身份：原 ${current.taskId}，新 ${amended.taskId}`,
        'taskId',
      );
    }
    if (amended.actionId !== current.actionId) {
      throw new AuthorizationError(
        'invalid_confirm_action',
        `改写确认请求不得更换动作身份：原 ${current.actionId}，新 ${amended.actionId}`,
        'actionId',
      );
    }
    if (this.#revokedActions.has(key)) {
      throw new AuthorizationError('grant_revoked', `动作 ${taskId}/${actionId} 已撤权：不得再改写确认请求`);
    }
    if (this.#grantIdByAction.has(key)) {
      throw new AuthorizationError(
        'grant_already_issued',
        `动作 ${taskId}/${actionId} 已发行授权：不得改写确认请求（须先撤权并走新的动作）`,
      );
    }
    this.#confirms.set(key, amended);
    return amended;
  }

  /**
   * 取"原生确认页要展示的载荷"。
   *
   * **返回值逐项来自账本**（`source` 是字面量 `'ledger'`），不是调用方传入的字符串。
   * 传入 `claim` 时做**逐项核对**：任何一项与账本不符即抛 `confirm_digest_mismatch`，
   * 因此"模型编了一个金额/收款方"这条路走不通。
   */
  getDisplay(taskId: string, actionId: string, claim?: Partial<ActionBinding>): ConfirmationDisplay {
    const confirm = this.#requireConfirm(taskId, actionId);
    assertClaimMatchesLedger(claim, confirm, `任务 ${taskId} 的动作 ${actionId} 的确认页展示`);
    return Object.freeze({
      source: 'ledger' as const,
      taskId: confirm.taskId,
      actionId: confirm.actionId,
      accountRef: confirm.accountRef,
      taskRevision: confirm.taskRevision,
      paramsDigest: confirm.paramsDigest,
      quoteRef: confirm.quoteRef,
      amount: confirm.amount,
      currency: confirm.currency,
      scope: confirm.scope,
      expiresAt: confirm.expiresAt,
      claimVerified: claim !== undefined && claim !== null,
    });
  }

  // -------------------------------------------------------------------------
  // ② 可信确认根 → 一次性授权
  // -------------------------------------------------------------------------

  /**
   * 确认页点"确认"：**由账本**签发一张确认凭证。
   *
   * 凭证携带的是账本逐字段拷贝的快照（不是调用方声明的摘要）；账本内容若在签发后被改动，
   * 发行时会被 `attestation_binding_mismatch` 挡下。
   */
  attest(
    taskId: string,
    actionId: string,
    options: { readonly surface: string; readonly claim?: Partial<ActionBinding> },
  ): ConfirmationAttestation {
    const key = scopeKey(taskId, actionId);
    const confirm = this.#requireConfirm(taskId, actionId);
    if (this.#revokedActions.has(key)) {
      throw new AuthorizationError(
        'grant_revoked',
        `动作 ${taskId}/${actionId} 已撤权（${this.#revokedActions.get(key) ?? ''}）：不得签发确认凭证`,
      );
    }
    const surface = requireText(options?.surface, 'surface');
    assertClaimMatchesLedger(options?.claim, confirm, `任务 ${taskId} 的动作 ${actionId} 的确认凭证`);

    const now = this.#clock.now();
    if (now >= confirm.expiresAt) {
      throw new AuthorizationError(
        'confirm_expired',
        `确认请求已过期：当前 ${now} ≥ expiresAt ${confirm.expiresAt}`,
        'expiresAt',
      );
    }

    const attestation: ConfirmationAttestation = Object.freeze({
      actionId,
      binding: confirm,
      surface,
      confirmedAt: now,
    });
    ISSUED_ATTESTATIONS.add(attestation);
    return attestation;
  }

  /**
   * 发行一次性授权。**未登记过的凭证一律拒**（`untrusted_attestation`）——
   * 这就是"客户端可自称用户已批准"的封堵点。
   */
  issueGrant(attestation: ConfirmationAttestation): AuthorizationGrant {
    if (typeof attestation !== 'object' || attestation === null || !ISSUED_ATTESTATIONS.has(attestation)) {
      throw new AuthorizationError(
        'untrusted_attestation',
        '该确认凭证不是本账本签发的：批准必须来自账本登记过的确认凭证，不得由调用方自造（R245 同源纪律）',
      );
    }
    const actionId = attestation.actionId;
    // 任务身份来自账本逐字段拷贝的凭证快照（调用方无法构造凭证，故 taskId 可信）。
    const taskId = attestation.binding.taskId;
    const key = scopeKey(taskId, actionId);
    const confirm = this.#requireConfirm(taskId, actionId);

    // 签发后账本内容又被改动 ⇒ 凭证失效（防止"用旧凭证批新参数"，见 amendConfirmAction）。
    const mismatch = findBindingMismatch(bindingOf(attestation.binding), bindingOf(confirm));
    if (mismatch !== null || confirm.expiresAt !== attestation.binding.expiresAt) {
      throw new AuthorizationError(
        'attestation_binding_mismatch',
        `确认凭证与账本当前内容不一致（首个不一致字段：${mismatch ?? 'expiresAt'}）：` +
          `凭证已失效，须对账本最新内容重新确认`,
        mismatch ?? 'expiresAt',
      );
    }

    if (this.#revokedActions.has(key)) {
      throw new AuthorizationError(
        'grant_revoked',
        `动作 ${taskId}/${actionId} 已撤权（${this.#revokedActions.get(key) ?? ''}）：不得发行授权`,
      );
    }

    const now = this.#clock.now();
    if (now >= confirm.expiresAt) {
      throw new AuthorizationError(
        'grant_expired',
        `确认请求已过期（当前 ${now} ≥ expiresAt ${confirm.expiresAt}）：不得发行授权`,
        'expiresAt',
      );
    }

    if (this.#grantIdByAction.has(key)) {
      throw new AuthorizationError(
        'grant_already_issued',
        `动作 ${taskId}/${actionId} 已发行过授权（${this.#grantIdByAction.get(key) ?? ''}）：` +
          `不得另发授权——结果未知时必须恢复原提交并查原单，而不是再批一次`,
      );
    }

    const grant: AuthorizationGrant = Object.freeze({
      grantId: this.#nextGrantId(taskId, actionId),
      ...bindingOf(confirm),
      expiresAt: confirm.expiresAt,
      issuedAt: now,
      grantedBy: attestation.surface,
      state: 'authorized' as const,
      consumed: false,
      consumedAt: null,
      consumedBySubmissionId: null,
      revokedAt: null,
      revokedReason: null,
    });
    this.#grants.set(grant.grantId, grant);
    this.#grantIdByAction.set(key, grant.grantId);
    return grant;
  }

  getGrant(grantId: string): AuthorizationGrant | undefined {
    return this.#grants.get(grantId);
  }

  grantForAction(taskId: string, actionId: string): AuthorizationGrant | undefined {
    const grantId = this.#grantIdByAction.get(scopeKey(taskId, actionId));
    return grantId === undefined ? undefined : this.#grants.get(grantId);
  }

  // -------------------------------------------------------------------------
  // ③ 原子占用（一键一次性）
  // -------------------------------------------------------------------------

  /**
   * **原子占用**：一次性授权的唯一消耗入口。
   *
   * 判定顺序（顺序即优先级，测试依赖它给出确定性拒因）：
   * 1. 找不到授权 → `grant_not_found`
   * 2. 已撤权 → `grant_revoked`
   * 3. 已过期（`now >= expiresAt`；边界取"到点即失效"）→ `grant_expired`
   * 4. 已被占用（重复点击 / 重放）→ `grant_already_consumed`
   * 5. 逐项复核 8 项绑定，任一项不一致 → `grant_binding_mismatch`（带 `field`）
   * 6. **提交段**：同步标记已占用 + 落账提交记录（`submitting`，`sendIntentAt = null`）
   *
   * 第 6 步整段是同步的、中间不调用任何调用方代码，因此"同一授权并发/重复占用"
   * 在单进程下最多成功一次。`onConsumed` 只在提交**之后**触发。
   */
  consume(input: ConsumeInput): ConsumeOutcome {
    const grant = this.#grants.get(input?.grantId);
    if (grant === undefined) {
      throw new AuthorizationError('grant_not_found', `台账里没有授权 ${String(input?.grantId)}`);
    }
    if (grant.revokedAt !== null) {
      throw new AuthorizationError(
        'grant_revoked',
        `授权 ${grant.grantId} 已撤销（${grant.revokedReason ?? ''}）：撤权即时影响后续调用（R244）`,
      );
    }
    const now = this.#clock.now();
    if (now >= grant.expiresAt) {
      throw new AuthorizationError(
        'grant_expired',
        `授权 ${grant.grantId} 已过期：当前 ${now} ≥ expiresAt ${grant.expiresAt}`,
        'expiresAt',
      );
    }
    if (grant.consumedAt !== null) {
      throw new AuthorizationError(
        'grant_already_consumed',
        `授权 ${grant.grantId} 已于 ${grant.consumedAt} 被占用（提交 ${grant.consumedBySubmissionId ?? ''}）：` +
          `一次性授权只能占用一次，重复点击 / 重放一律拒绝`,
      );
    }

    if (input.actual === null || typeof input.actual !== 'object') {
      throw new AuthorizationError(
        'grant_binding_mismatch',
        '提交时必须给出实际值（九项绑定）：缺省即无法与授权逐项复核，不放行',
      );
    }
    const mismatch = findBindingMismatch(bindingOf(input.actual), bindingOf(grant));
    if (mismatch !== null) {
      throw new AuthorizationError(
        'grant_binding_mismatch',
        `提交时的实际值与授权绑定不一致：字段 ${mismatch} 为 ` +
          `${JSON.stringify(input.actual[mismatch])}，授权绑定的是 ${JSON.stringify(grant[mismatch])}——` +
          `关键条件变化即失效，须重新确认`,
        mismatch,
      );
    }

    // ---- 以下整段同步执行，中间不插入任何调用方代码 = 原子 ----
    const key = scopeKey(grant.taskId, grant.actionId);
    if (this.#submissionIdByAction.has(key)) {
      // 结构上不应到达（任务内一个动作至多一张授权、一项 id 派生），保留为兜底不变量。
      throw new AuthorizationError(
        'duplicate_submission',
        `动作 ${grant.taskId}/${grant.actionId} 已有提交记录 ${this.#submissionIdByAction.get(key) ?? ''}：` +
          `不得重复提交`,
      );
    }
    const submissionId = this.#nextSubmissionId(grant.taskId, grant.actionId);
    const consumedGrant: AuthorizationGrant = Object.freeze({
      ...grant,
      state: 'submitting' as const,
      consumed: true,
      consumedAt: now,
      consumedBySubmissionId: submissionId,
    });
    const submission: SubmissionRecord = Object.freeze({
      submissionId,
      grantId: grant.grantId,
      ...bindingOf(grant),
      state: 'submitting' as const,
      sendIntentAt: null,
      sentAt: null,
      receipt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
    this.#grants.set(grant.grantId, consumedGrant);
    this.#submissions.set(submissionId, submission);
    this.#submissionIdByAction.set(key, submissionId);
    // ---- 原子段结束：此刻起任何代码都只能看到"已占用" ----

    input.onConsumed?.({ grant: consumedGrant, submission });
    return { grant: consumedGrant, submission };
  }

  getSubmission(submissionId: string): SubmissionRecord | undefined {
    return this.#submissions.get(submissionId);
  }

  submissionForAction(taskId: string, actionId: string): SubmissionRecord | undefined {
    const submissionId = this.#submissionIdByAction.get(scopeKey(taskId, actionId));
    return submissionId === undefined ? undefined : this.#submissions.get(submissionId);
  }

  // -------------------------------------------------------------------------
  // ④ 发出（异步端口；意图先落账）
  // -------------------------------------------------------------------------

  /**
   * 把一条已占用的提交交给执行器。
   *
   * **唯一的"对外发出"入口**：它拒绝任何非 `submitting`、或已留下发出意图的提交
   * （`already_sent_query_only`），因此"重复下单"在 API 上不可表达。
   *
   * 顺序（关键）：先落账 `sendIntentAt` → 再 `await` 端口 → 再写回结果。
   * 端口抛错表示**发出途中进程死亡**：异常原样抛出，记录停在
   * `submitting` + `sendIntentAt !== null`，由 `recover()` 判为"已发出未知"。
   */
  async send(submissionId: string): Promise<SubmissionRecord> {
    const submission = this.#requireSubmission(submissionId);

    // 拒因顺序刻意如此：**先报最具体的原因**，调用方才能机读区分
    // "已经发出过（只能查原单）"、"授权被撤/过期"、"状态机不允许"。
    // 1) 发出意图是不可逆的事实：只要留下过，就永远只能查原单。
    if (submission.sendIntentAt !== null) {
      throw new AuthorizationError(
        'already_sent_query_only',
        `提交 ${submissionId} 已于 ${submission.sendIntentAt} 留下发出意图：` +
          `只能查原单，不得重发（重复下单不可表达）`,
      );
    }

    const grant = this.#grants.get(submission.grantId);
    if (grant === undefined) {
      throw new AuthorizationError('grant_not_found', `提交引用的授权不存在：${submission.grantId}`);
    }
    const now = this.#clock.now();

    // 2) 撤权 / 过期：即时影响后续调用（R244），且都不发出任何东西。
    if (grant.revokedAt !== null) {
      this.#writeSubmission({ ...submission, state: 'cancelled', failureReason: grant.revokedReason, updatedAt: now });
      throw new AuthorizationError(
        'grant_revoked',
        `授权 ${grant.grantId} 在发出前被撤销（${grant.revokedReason ?? ''}）：撤权即时影响后续调用（R244）`,
      );
    }
    if (now >= grant.expiresAt) {
      this.#writeSubmission({ ...submission, state: 'cancelled', failureReason: 'grant_expired', updatedAt: now });
      throw new AuthorizationError(
        'grant_expired',
        `授权 ${grant.grantId} 在发出前已过期（当前 ${now} ≥ expiresAt ${grant.expiresAt}）：不得发出`,
        'expiresAt',
      );
    }

    // 3) 状态机：只有"已占用、未发出"的提交可以被发出。
    if (submission.state !== 'submitting') {
      throw new AuthorizationError(
        'illegal_submission_transition',
        `提交 ${submissionId} 处于 ${submission.state}，不是 submitting：不得再发出`,
      );
    }

    const executor = this.#executor;
    if (executor === null) {
      // 缺执行器时**不写发出意图**：否则会把"没发出去"误记成"已发出未知"。
      throw new AuthorizationError(
        'missing_executor',
        `未装配执行器：提交 ${submissionId} 保持未发出，更不得签完成（缺执行器不能签完成令牌）`,
      );
    }

    // ---- 意图先落账（在任何 await 之前，因此并发第二次 send 必然看见它）----
    const intent = this.#writeSubmission({ ...submission, sendIntentAt: now, updatedAt: now });

    const request: ExternalSubmitRequest = Object.freeze({
      submissionId: intent.submissionId,
      ...bindingOf(intent),
      at: now,
    });
    // 端口抛错 = 发出途中死亡：异常继续上抛，记录留在"已发出意图"状态。
    const outcome = await executor.send(request);
    return this.#writeSubmission(this.#applySendOutcome(intent, outcome, this.#clock.now()));
  }

  #applySendOutcome(
    submission: SubmissionRecord,
    outcome: ExecutorOutcome,
    at: number,
  ): SubmissionRecord {
    if (outcome === null || typeof outcome !== 'object') {
      throw new AuthorizationError(
        'illegal_submission_transition',
        `执行器返回了非法的结果对象：${JSON.stringify(outcome)}`,
      );
    }
    if (outcome.outcome === 'accepted') {
      return { ...submission, state: 'submitted', sentAt: at, updatedAt: at };
    }
    if (outcome.outcome === 'failed') {
      const reason = requireText(outcome.reason, 'failureReason');
      return { ...submission, state: 'failed', failureReason: reason, updatedAt: at };
    }
    if (outcome.outcome === 'unknown') {
      return { ...submission, state: 'unknown', failureReason: outcome.detail || null, updatedAt: at };
    }
    throw new AuthorizationError(
      'illegal_submission_transition',
      `执行器返回值非法：${JSON.stringify(outcome)}`,
    );
  }

  // -------------------------------------------------------------------------
  // ⑤ 回执观测 / 查原单 / 恢复
  // -------------------------------------------------------------------------

  /** 收到一份异步回执（推送）。**非受控来源的回执一律拒**。 */
  observe(submissionId: string, receipt: ExternalReceipt): SubmissionRecord {
    return this.#applyReceipt(this.#requireSubmission(submissionId), receipt, this.#clock.now());
  }

  /**
   * **查原单**：结果未知时的唯一合法动作。
   *
   * 查询端口返回 `null` ⇒ 状态不变（仍然是未知，不猜、不改写成失败）。
   * 返回回执 ⇒ 走与 `observe()` 同一套校验与转换。
   */
  async queryOriginalOrder(
    submissionId: string,
  ): Promise<{ readonly queried: boolean; readonly submission: SubmissionRecord }> {
    const submission = this.#requireSubmission(submissionId);
    if (isTerminalSubmissionState(submission.state)) {
      return { queried: false, submission };
    }
    const port = this.#orderQuery;
    if (port === null) {
      throw new AuthorizationError(
        'missing_order_query_port',
        `未装配原单查询端口：提交 ${submissionId} 状态未知时无法查原单（缺端口只能如实报未知，不得重下）`,
      );
    }
    const receipt = await port.query({
      submissionId: submission.submissionId,
      taskId: submission.taskId,
      actionId: submission.actionId,
      requestRef: submission.submissionId,
    });
    if (receipt === null || receipt === undefined) {
      // 查了，但供应方也没给出结论：状态保持未知。
      return { queried: true, submission: this.#requireSubmission(submissionId) };
    }
    return {
      queried: true,
      submission: this.#applyReceipt(this.#requireSubmission(submissionId), receipt, this.#clock.now()),
    };
  }

  /**
   * **崩溃后恢复**：只辨明状态并给出唯一合法动作，**不**新建授权、**不**新建提交、**不**发出调用。
   */
  recover(submissionId: string): RecoveryVerdict {
    const submission = this.#requireSubmission(submissionId);
    const base = {
      submissionId: submission.submissionId,
      state: submission.state,
      mayIssueNewGrant: false as const,
      mayCreateNewSubmission: false as const,
    };

    if (isTerminalSubmissionState(submission.state)) {
      return Object.freeze({
        ...base,
        kind: 'settled' as const,
        allowedAction: 'none' as const,
        detail: `提交已到终态 ${submission.state}（${describeExternalOutcome(submission).summary}）：无需恢复动作`,
      });
    }
    if (submission.state === 'submitting') {
      if (submission.sendIntentAt === null) {
        return Object.freeze({
          ...base,
          kind: 'not_sent' as const,
          allowedAction: 'resume_same_submission' as const,
          detail:
            '占用已完成、尚未留下发出意图：判定为**未发出**。可对同一条提交调用 send() 继续' +
            '（复用同一 submissionId 与同一授权，不新建授权、不产生第二条提交）',
        });
      }
      return Object.freeze({
        ...base,
        kind: 'sent_unknown' as const,
        allowedAction: 'query_original_order' as const,
        detail:
          `已于 ${submission.sendIntentAt} 留下发出意图但未取回结果：判定为**已发出未知**。` +
          '只能查原单（queryOriginalOrder），不得重发',
      });
    }
    if (submission.state === 'submitted') {
      return Object.freeze({
        ...base,
        kind: 'awaiting_receipt' as const,
        allowedAction: 'query_original_order' as const,
        detail: `执行器已于 ${submission.sentAt ?? -1} 受理，尚无回执：查原单取回执`,
      });
    }
    // state === 'unknown'
    return Object.freeze({
      ...base,
      kind: 'sent_unknown' as const,
      allowedAction: 'query_original_order' as const,
      detail: '结果未知：恢复原提交并查询原单；不得另发授权、不得重复下单',
    });
  }

  /**
   * **结果未知时的一步恢复**：`recover()` 判明状态，并**仅在允许时**查原单。
   *
   * 这是"提交结果未知时恢复原 submission 并查询原订单"的落点（README §5）。
   * 与 `recover()` 的分工：`recover()` 只出判据（供 UI 展示"该做什么"），
   * 本方法把判据 + 合法动作串成一次调用；两条路径共用同一判据，不各写一套。
   *
   * - 判为 `query_original_order`（`sent_unknown` / `awaiting_receipt`）⇒ 调 `queryOriginalOrder()`
   *   取回执并收敛，`queried: true`；缺查询端口则如实抛 `missing_order_query_port`；
   * - 判为 `resume_same_submission`（占用后未发出）⇒ **不代发**：发出是对外动作，
   *   必须由调用方显式 `send()`（本方法 `queried: false`）；
   * - 判为 `none`（终态）⇒ 原样返回，`queried: false`。
   *
   * **永不**新建授权、**永不**新建提交、**永不**重发。
   */
  async reconcileUnknown(submissionId: string): Promise<ReconciliationOutcome> {
    const verdict = this.recover(submissionId);
    if (verdict.allowedAction !== 'query_original_order') {
      return Object.freeze({
        verdict,
        submission: this.#requireSubmission(submissionId),
        queried: false,
        mayIssueNewGrant: false as const,
        mayCreateNewSubmission: false as const,
      });
    }
    const queried = await this.queryOriginalOrder(submissionId);
    return Object.freeze({
      verdict,
      submission: queried.submission,
      queried: queried.queried,
      mayIssueNewGrant: false as const,
      mayCreateNewSubmission: false as const,
    });
  }

  #applyReceipt(submission: SubmissionRecord, receipt: ExternalReceipt, at: number): SubmissionRecord {
    if (typeof receipt !== 'object' || receipt === null || !TRUSTED_RECEIPTS.has(receipt)) {
      throw new AuthorizationError(
        'untrusted_receipt',
        '该回执不是受控执行器签发的：客户端/模型自称 "observedState: confirmed" 无效' +
          '（假冒完成与 R245 的假批准同类）',
      );
    }
    if (receipt.actionId !== submission.actionId) {
      throw new AuthorizationError(
        'receipt_action_mismatch',
        `回执指向动作 ${receipt.actionId}，但提交 ${submission.submissionId} 属于 ${submission.actionId}`,
      );
    }

    // ----------------------------------------------------------------------
    // 幂等去重（K-R06 D2 的封堵点，2026-10-03 集成）
    //
    // 真实推送 / 查单可能**重复投递同一份回执**。若同一份回执第二次到达时被当成
    // 新的状态转换，`confirmed → confirmed` 会撞上状态机（confirmed 无出边）而抛
    // `illegal_submission_transition`——把"重复投递"误判成失败。
    //
    // 去重键是 **actionId + requestRef + externalId + observedState**（按此四项判等）；
    // 仅当四项全等时返回**原封不动的当前提交**（no-op，不重写 updatedAt / receipt）。
    // 这里刻意放在可信校验与动作归属校验**之后**：伪造的 / 串单的"重复回执"仍会被
    // `untrusted_receipt` / `receipt_action_mismatch` 挡下，不会被幂等吞掉。
    // 四项之中任一项不同（例如换了 externalId 或 observedState）都**不**算重复，
    // 仍走状态机——因此"终态不可被另一份回执改写"的不变量不受影响。
    // ----------------------------------------------------------------------
    const previous = submission.receipt;
    if (
      previous !== null &&
      previous.actionId === receipt.actionId &&
      previous.requestRef === receipt.requestRef &&
      previous.externalId === receipt.externalId &&
      previous.observedState === receipt.observedState
    ) {
      return submission;
    }

    const observed = receipt.observedState;
    if (!isSubmissionState(observed) || !(RECEIPT_OBSERVED_STATES as readonly string[]).includes(observed)) {
      throw new AuthorizationError(
        'illegal_submission_transition',
        `回执回报的状态 ${String(observed)} 不是可接受的外部观测状态`,
      );
    }
    if (!canTransitionSubmission(submission.state, observed)) {
      throw new AuthorizationError(
        'illegal_submission_transition',
        `非法的提交状态转换：${submission.state} → ${observed}（结果未知不得回退重试）`,
      );
    }

    const next: SubmissionRecord = {
      ...submission,
      state: observed,
      receipt,
      failureReason:
        observed === 'failed' || observed === 'cancelled' ? (receipt.detail || observed) : submission.failureReason,
      updatedAt: at,
    };
    return this.#writeSubmission(next);
  }

  // -------------------------------------------------------------------------
  // ⑥ 撤权
  // -------------------------------------------------------------------------

  /**
   * 撤销一个动作（撤权即时影响后续调用，R244）。
   *
   * **已经发出**的提交记录**不因此被抹掉**：真实世界里的订单不会因为本地撤权而消失，
   * 把"已发出未知"改写成"已取消"就是编造结果。只有尚未发出的提交才被置为 `cancelled`。
   */
  revoke(
    taskId: string,
    actionId: string,
    reason: string,
  ): { readonly taskId: string; readonly actionId: string; readonly grant: AuthorizationGrant | null; readonly submission: SubmissionRecord | null } {
    const confirm = this.#requireConfirm(taskId, actionId);
    const text = requireText(reason, 'revokedReason');
    this.#revokedActions.set(scopeKey(taskId, actionId), text);
    const now = this.#clock.now();

    let grant = this.grantForAction(taskId, actionId) ?? null;
    if (grant !== null) {
      const touched = grant.consumedAt !== null;
      grant = Object.freeze({
        ...grant,
        // 已占用的授权保持 submitting：订单可能已经在路上，状态不因撤权而失真。
        state: touched ? ('submitting' as const) : ('cancelled' as const),
        consumed: touched,
        revokedAt: now,
        revokedReason: text,
      });
      this.#grants.set(grant.grantId, grant);
    }

    const existing = this.submissionForAction(taskId, actionId) ?? null;
    let submission = existing;
    if (existing !== null && !isTerminalSubmissionState(existing.state) && existing.sendIntentAt === null) {
      submission = this.#writeSubmission({
        ...existing,
        state: 'cancelled',
        failureReason: text,
        updatedAt: now,
      });
    }

    return Object.freeze({ taskId: confirm.taskId, actionId: confirm.actionId, grant, submission });
  }

  isRevoked(taskId: string, actionId: string): boolean {
    return this.#revokedActions.has(scopeKey(taskId, actionId));
  }

  // -------------------------------------------------------------------------
  // ⑦ 观测与不变量
  // -------------------------------------------------------------------------

  /**
   * 一条动作当前的可观测状态（八态之一）：
   * 提交记录 > 授权 > 确认请求。找不到动作返回 `null`（**不**编造成 `prepared`）。
   */
  observedStateOf(taskId: string, actionId: string): SubmissionState | null {
    const submission = this.submissionForAction(taskId, actionId);
    if (submission !== undefined) {
      return submission.state;
    }
    const grant = this.grantForAction(taskId, actionId);
    if (grant !== undefined) {
      return grant.state;
    }
    const key = scopeKey(taskId, actionId);
    // 已撤权但还没发行过授权：动作已是"已取消"，不得再报成"已准备"。
    if (this.#revokedActions.has(key)) {
      return 'cancelled';
    }
    if (this.#confirms.has(key)) {
      return 'prepared';
    }
    return null;
  }

  /** 如实描述外部结果（`unknown` 就是"结果未知"，绝不美化）。 */
  describeExternalOutcome(submissionId: string): ExternalOutcomeDescription {
    return describeExternalOutcome(this.#requireSubmission(submissionId));
  }

  /** 判据透出：非 `confirmed` 一律抛 `completion_not_claimable`。 */
  assertCompletionClaimable(submissionId: string): void {
    assertCompletionClaimable(this.#requireSubmission(submissionId));
  }

  /** 计数（证据用；恢复前后比对可证明"没有新建授权 / 没有重复提交"）。 */
  counts(): {
    readonly confirms: number;
    readonly grants: number;
    readonly submissions: number;
    readonly revoked: number;
  } {
    return Object.freeze({
      confirms: this.#confirms.size,
      grants: this.#grants.size,
      submissions: this.#submissions.size,
      revoked: this.#revokedActions.size,
    });
  }

  allConfirmActions(): readonly ConfirmAction[] {
    return Object.freeze([...this.#confirms.values()]);
  }

  allGrants(): readonly AuthorizationGrant[] {
    return Object.freeze([...this.#grants.values()]);
  }

  allSubmissions(): readonly SubmissionRecord[] {
    return Object.freeze([...this.#submissions.values()]);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #requireConfirm(taskId: string, actionId: string): ConfirmAction {
    const confirm = this.#confirms.get(scopeKey(taskId, actionId));
    if (confirm === undefined) {
      throw new AuthorizationError(
        'confirm_not_found',
        `账本里没有任务 ${String(taskId)} 的动作 ${String(actionId)} 的确认请求`,
      );
    }
    return confirm;
  }

  #requireSubmission(submissionId: string): SubmissionRecord {
    const submission = this.#submissions.get(String(submissionId));
    if (submission === undefined) {
      throw new AuthorizationError('submission_not_found', `台账里没有提交 ${String(submissionId)}`);
    }
    return submission;
  }

  /**
   * **唯一写入汇点**：在这里再挡一次"没有可信回执不得 confirmed"。
   * 状态机与端口都已挡过，这里是第三道——不变量写在单一位置，才机器可验。
   */
  #writeSubmission(next: SubmissionRecord): SubmissionRecord {
    if (next.state === 'confirmed' && (next.receipt === null || !TRUSTED_RECEIPTS.has(next.receipt))) {
      throw new AuthorizationError(
        'missing_trusted_receipt',
        `拒绝把提交 ${next.submissionId} 写为 confirmed：没有受控执行器签发的可信回执` +
          `（缺执行器 / 无可信回执 ⇒ 不得 confirmed）`,
      );
    }
    const frozen: SubmissionRecord = Object.freeze({ ...next });
    this.#submissions.set(frozen.submissionId, frozen);
    this.#submissionIdByAction.set(scopeKey(frozen.taskId, frozen.actionId), frozen.submissionId);
    return frozen;
  }
}

/** 便捷构造（等价于 `new AuthorizationLedger(options)`）。 */
export function createAuthorizationLedger(options: AuthorizationLedgerOptions): AuthorizationLedger {
  return new AuthorizationLedger(options);
}
