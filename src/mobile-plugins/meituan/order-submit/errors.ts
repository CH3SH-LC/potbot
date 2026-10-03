/**
 * M07 下单提交 —— **错误类型与拒因词表**（零依赖）。
 *
 * ## 为什么拒因必须是可机读错误码
 *
 * "提交被拒绝"与"提交没成功"是两件事：前者是**本地判据拦住了一次不该发生的调用**，
 * 后者是**平台说了算**。若拒因退化成 `false`，上层会把二者混为一谈，
 * 从而把"没提交"当成"提交失败"，或更糟——把被拒当成成功。
 * 本模块所有拒绝都抛 {@link OrderSubmitError}，验收按 `code` 断言。
 */

/** 下单提交链路上**全部**可机读拒因（新增必须在此登记）。 */
export const ORDER_SUBMIT_ERROR_CODES = [
  // --- 入参 / 授权引用 ---
  /** 入参形状不合法（空串 / 非整数金额 / 非法摘要 / 非法范围 / 非法期限）。 */
  'invalid_submit_request',
  /** 没有携带授权引用（缺省即拒——"没有授权不得提交"是硬判据）。 */
  'missing_authorization_ref',
  /** 授权引用不是由可信签发器产生的（调用方自造的"我批准了"）。 */
  'untrusted_authorization_ref',
  /** 该授权已被占用：一次性授权不得第二次占用（重复点击 / 重放）。 */
  'authorization_already_consumed',
  /** 授权已过期（注入时钟已到 / 过 `expiresAt`）。 */
  'authorization_expired',
  /** 提交时的实际绑定与授权绑定的某一项不一致。 */
  'authorization_binding_mismatch',
  /** 传入的幂等键与由授权确定性导出的键不一致（键必须可复现）。 */
  'idempotency_key_mismatch',

  // --- 执行器与发出 ---
  /** 没有装配执行器：缺执行器时**不得**留下"已发出"痕迹，更不得判成功。 */
  'missing_executor',
  /** 设备离线：提交**拒绝发出**（未发出 ≠ 已发出未知）；记录保持 not-sent，可续发同一条。 */
  'submit_offline_not_sent',
  /** 提交记录快照不合法（版本不符 / 字段缺失或类型错）——恢复必须拒，不得猜。 */
  'invalid_submission_snapshot',
  /** 该幂等键已留下发出意图：**只能查原单，不得重发**（结果未知态下再次 submit 即此因）。 */
  'already_sent_query_only',
  /** 台账里没有这个幂等键对应的提交记录。 */
  'submission_not_found',

  // --- 查询与回执 ---
  /** 没有装配原单查询端口：结果未知时无法查原单（如实报缺，不猜）。 */
  'missing_order_query_port',
  /** 回执不是受控签发器签发的（客户端自称 `observedState: 'confirmed'` 无效）。 */
  'untrusted_order_receipt',
  /** 回执指向的幂等键与提交记录不符。 */
  'receipt_key_mismatch',
  /** `verificationMode: 'fixture'` 的回执不得报 `confirmed`（契约不变量）。 */
  'fixture_receipt_cannot_confirm',
  /** 非法的状态转换（含不被允许的自环）。 */
  'illegal_order_transition',

  // --- 完成口径 ---
  /** 该状态**不得**声称订单已下达（只有 `confirmed` 可以）。 */
  'order_not_placed',
] as const;

export type OrderSubmitErrorCode = (typeof ORDER_SUBMIT_ERROR_CODES)[number];

/** 下单链路唯一的错误类型。所有拒绝都抛它。 */
export class OrderSubmitError extends Error {
  readonly code: OrderSubmitErrorCode;
  /** 逐项核对失败时指出是哪一项（非此类错误为 null）。 */
  readonly field: string | null;

  constructor(code: OrderSubmitErrorCode, detail: string, field: string | null = null) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'OrderSubmitError';
    this.code = code;
    this.field = field;
  }
}

/** 便于测试识别的守卫（`instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isOrderSubmitError(value: unknown): value is OrderSubmitError {
  return (
    value instanceof OrderSubmitError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (ORDER_SUBMIT_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}
