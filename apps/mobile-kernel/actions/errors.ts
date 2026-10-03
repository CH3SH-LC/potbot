/**
 * K07 授权与提交账本 —— **错误类型与拒因词表**（零依赖）。
 *
 * ## 为什么拒因必须是显式错误码，而不是 `false`
 *
 * 本项目现存的一处 P0（`apps/demo/server/adapters-actions.ts` 的 `user_approved` / `source`
 * 取自请求体）之所以难以在事后发现，是因为"批准"这件事在那里退化成**一个布尔值**：
 * 调用方说 true 就是 true，没有第二方可以反驳。K07 的对策是把"批准"变成**有来源、有绑定、
 * 有一次性命的一次性凭证**，任何不匹配都必须**当场抛出可机读的拒因**——静默返回 `false`
 * 会让上层把"被拒绝"和"没批准过"混为一谈，从而把失败的判据当成通过的判据。
 *
 * 本文件只放词表与错误类型；字段绑定与状态机在 `types.ts` / `ledger.ts`。
 */

/** 授权链路上**全部**可机读拒因。新增拒因必须同时在此登记（测试逐条对照）。 */
export const AUTHORIZATION_ERROR_CODES = [
  // --- 确认请求（ConfirmAction，持久账本侧） ---
  /** 账本里没有这条确认请求。 */
  'confirm_not_found',
  /** 同一个 actionId 已在账本里登记过（一个动作只有一条确认请求）。 */
  'confirm_already_recorded',
  /** 确认请求的字段本身不合法（金额非整数最小单位 / 币种非大写三字母 / 空串 / 非法期限）。 */
  'invalid_confirm_action',
  /** 调用方传入的展示摘要与账本里的值不一致——**展示数据只能来自账本**。 */
  'confirm_digest_mismatch',
  /** 确认请求已过期（注入时钟已到 / 过 `expiresAt`）。 */
  'confirm_expired',

  // --- 可信确认根（ConfirmationAttestation） ---
  /** 凭证不是由本模块账本签发的（调用方自造的"我批准了"）。 */
  'untrusted_attestation',
  /** 凭证签发之后账本内容又被改动——凭证不得再用于发行。 */
  'attestation_binding_mismatch',

  // --- 授权（AuthorizationGrant） ---
  /** 该动作已经发行过授权；**不得另发**（结果未知时尤其禁止）。 */
  'grant_already_issued',
  /** 台账里没有这张授权。 */
  'grant_not_found',
  /** 授权已过期（注入时钟已到 / 过 `expiresAt`）。 */
  'grant_expired',
  /** 授权已被撤销（撤权后发行、占用、发出全部拒绝）。 */
  'grant_revoked',
  /** 提交时的实际值与授权绑定的某一项不一致（拒因带 `field`）。 */
  'grant_binding_mismatch',
  /** 该授权已被占用：一次性授权**不得**被第二次占用（重复点击 / 重放）。 */
  'grant_already_consumed',

  // --- 提交（Submission） ---
  /** 台账里没有这条提交记录。 */
  'submission_not_found',
  /** 该动作已有提交记录：**重复提交在语义上不可表达**。 */
  'duplicate_submission',
  /** 非法状态转换（含自环；`unknown` 不得回到 `submitted` 重试）。 */
  'illegal_submission_transition',
  /** 该提交已经发出（或已留下发出意图）：**只能查原单，不得重发**。 */
  'already_sent_query_only',
  /** 没有装配真实执行器：缺执行器时**不得**留下"已发出"痕迹，更不得签完成。 */
  'missing_executor',
  /** 没有装配原单查询端口：结果未知时无法查原单（如实报缺，不猜结果）。 */
  'missing_order_query_port',

  // --- 回执与"完成"口径 ---
  /** 回执不是由受控执行器签发的（客户端自称 `observedState: 'confirmed'` 无效）。 */
  'untrusted_receipt',
  /** 想写 `confirmed` 却没有可信回执（缺执行器 / 端口没给回执）。 */
  'missing_trusted_receipt',
  /**
   * `verificationMode: 'fixture'` 的回执不得报 `confirmed`
   * （`contracts/mobile-v1/schemas/external-receipt.schema.json` 的 oneOf/not 不变量：
   * fixture 产物不得冒充真实订单/支付/手机通过回执）。
   */
  'fixture_receipt_cannot_confirm',
  /** 回执指向的动作与提交记录不符。 */
  'receipt_action_mismatch',
  /** 该状态**不得**声称外部动作已完成（只有 `confirmed` 可以）。 */
  'completion_not_claimable',

  // --- wire/领域边界换算（`wire-codec.ts`；总协调 2026-10-03 编码裁决） ---
  /**
   * 币种不在最小单位位数表里：**不猜**位数（猜错就是把金额算错）。
   * 裁决要求"小数位数由币种决定"，未知币种只能如实报缺，不得默认 2 位。
   */
  'unsupported_currency',
  /** wire 金额字符串形状非法（不符契约 `^[0-9]+(\.[0-9]{1,4})?$`）或领域值非法。 */
  'wire_amount_invalid',
  /** wire 金额的精度超出该币种的最小单位（如 CNY 的 `1.2345`）⇒ 不能精确表示，拒绝而非四舍五入。 */
  'wire_amount_not_representable',
  /** wire 时间戳形状非法 / 不是合法日历时刻（如 `2026-02-30T…`）。 */
  'wire_timestamp_invalid',
  /** wire 时间戳精度超出毫秒且低位非零 ⇒ 注入时钟（整数毫秒）无法精确表示，拒绝而非截断。 */
  'wire_timestamp_not_representable',
] as const;

export type AuthorizationErrorCode = (typeof AUTHORIZATION_ERROR_CODES)[number];

/**
 * 授权绑定的可逐项核对的字段名。
 * 与 `ActionBinding`（`types.ts`）一一对应；报错时带上它，验收才能断言"是哪一项变了"。
 *
 * `taskId` 于 2026-10-03 集成加入（K-R06 B1/B2）：它是**任务身份**，参与逐项复核，
 * 因此跨任务的占用会以 `grant_binding_mismatch` + `field === 'taskId'` 被机器拒绝。
 */
export const BINDING_FIELDS = [
  'taskId',
  'actionId',
  'accountRef',
  'taskRevision',
  'paramsDigest',
  'quoteRef',
  'amount',
  'currency',
  'scope',
] as const;

/** 逐项核对的 9 个绑定字段（不含 `expiresAt`——那是**期限**，与注入时钟比较，不由调用方声明）。 */
export type BindingField = (typeof BINDING_FIELDS)[number];

/** 期限字段名（单独列出：它只与时钟比较，不参与"调用方声明 vs 账本"的逐项核对）。 */
export type ExpiryField = 'expiresAt';

/** K07 链路唯一的错误类型。所有拒绝都抛它，验收按 `code` / `field` 断言。 */
export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;

  /** 逐项核对失败时，指出是**哪一项**不一致（非此类错误为 null）。 */
  readonly field: BindingField | ExpiryField | 'observedAt' | null;

  constructor(code: AuthorizationErrorCode, detail: string, field: BindingField | ExpiryField | 'observedAt' | null = null) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'AuthorizationError';
    this.code = code;
    this.field = field;
  }
}

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isAuthorizationError(value: unknown): value is AuthorizationError {
  return (
    value instanceof AuthorizationError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (AUTHORIZATION_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}
