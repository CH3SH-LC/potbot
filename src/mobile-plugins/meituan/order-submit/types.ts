/**
 * M07 下单提交 —— **状态词表、数据结构与端口**（零依赖、纯类型 + 纯函数）。
 *
 * ## 本包要关掉的那几个洞
 *
 * 下单提交最容易变成"编造成功"的地方有三处，本包在**结构层面**把它们堵住：
 *
 * 1. **HTTP 成功 ≠ 业务成功**。`OrderTransportResult` 把"传输结果"与"业务结果码"
 *    分开保存，二者必须一起交给 {@link classifySubmitResponse}；只有业务码被登记为
 *    成功时才是成功。仅凭 `httpStatus === 200` 判成功在本包**无法表达**——
 *    没有只看状态码的出口。
 * 2. **重复提交**。提交记录以**幂等键**为主键落在一个可注入的
 *    {@link OrderSubmissionStore} 里；同键再次提交**不会**再调执行器（见 `submitter.ts`）。
 *    键是授权的确定性函数（`computeIdempotencyKey`），因此双击 / 超时重试 / 进程重启
 *    都会算出同一个键。
 * 3. **结果未知**。`unknown` 是**非终态**，但再次 `submit` 会被拒
 *    （`already_sent_query_only`）：未知只能 `queryOriginalOrder`，不得重放。
 *
 * ## 与 K07（`apps/mobile-kernel/actions/`）的关系
 *
 * 本包**不 import** K07（跨线耦合会拖垮两条线的独立可测性），而是**照抄其语义**：
 * - 一次性授权引用 = `AuthorizationRef`（对应 K07 的 `AuthorizationGrant`：
 *   `grantId` + 八项绑定 + 期限 + `consumed`/`consumedAt`）；
 * - 授权的**可信根**由一个模块私有的 `WeakSet` 决定（`authorization.ts`）：
 *   形状相同但非本模块签发的引用一律 `untrusted_authorization_ref`——
 *   与 K07 的 `untrusted_attestation` 同源。真机接线上，`AuthorizationRef` 应由
 *   K07 账本签发后经适配层传入；本包只提供同语义的本地签发器用于独立驱动。
 * - 状态映射：本包 `submitting/submitted/rejected/unknown/confirmed/cancelled`
 *   ↔ K07 八态 `submitting/submitted/failed/unknown/confirmed/cancelled`。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **不接真实美团接口**：没有网络、没有 token、没有真实下单/支付。执行器与查询端口
 *   一律**注入**，本包内的实现都是 fixture。
 * - **未接 Android 进程 / 未持久化到手机 DB**：`OrderSubmissionStore` 的内存实现只保证
 *   同一进程；"重启后读到同一份记录"依赖该端口注入真存储，本包未接。
 * - **未验证**任何真实平台行为；`fixture` 回执不得报 `confirmed`（契约不变量）。
 */

// ---------------------------------------------------------------------------
// 状态词表
// ---------------------------------------------------------------------------

/**
 * 下单提交的生命周期（六态，**严格用这六个词，不得合并**）。
 *
 * - `submitting`：已占用授权、意图已落账，等执行器结果；
 * - `submitted`：平台业务码判定为**受理**（传输 + 业务双绿）；
 * - `rejected`：**确定性失败**（业务拒单 / 明确不可重试的客户端错误）；
 * - `unknown`：没有确定性结果（超时 / 5xx / 未登记业务码 / `duplicate_order`）；
 * - `confirmed`：经**查原单**取回可信回执证实已下单（唯一可声称"已下单"的状态）；
 * - `cancelled`：授权在发出前被撤销 / 过期。
 */
export const ORDER_SUBMISSION_STATES = [
  'submitting',
  'submitted',
  'rejected',
  'unknown',
  'confirmed',
  'cancelled',
] as const;

export type OrderSubmissionState = (typeof ORDER_SUBMISSION_STATES)[number];

export const ORDER_STATE_LABELS: Readonly<Record<OrderSubmissionState, string>> = Object.freeze({
  submitting: '提交中',
  submitted: '已受理',
  rejected: '已拒单',
  unknown: '结果未知',
  confirmed: '已确认下单',
  cancelled: '已取消',
});

/** 终态：不再前进（`submitted` / `unknown` **不是**终态——晚到回执仍可收口）。 */
export const ORDER_TERMINAL_STATES = ['rejected', 'confirmed', 'cancelled'] as const;

/** **唯一**可以声称"订单已下达"的状态。`submitted` 只是"平台业务码说受理了"，不算。 */
export const ORDER_PLACED_CLAIMABLE_STATES = ['confirmed'] as const;

export function isOrderSubmissionState(value: unknown): value is OrderSubmissionState {
  return typeof value === 'string' && (ORDER_SUBMISSION_STATES as readonly string[]).includes(value);
}

export function isTerminalOrderState(state: OrderSubmissionState): boolean {
  return (ORDER_TERMINAL_STATES as readonly OrderSubmissionState[]).includes(state);
}

/** 机器化判据：只有 `confirmed` 可以声称订单已下达；`submitted` / `unknown` 一律 false。 */
export function mayClaimOrderPlaced(state: OrderSubmissionState): boolean {
  return (ORDER_PLACED_CLAIMABLE_STATES as readonly OrderSubmissionState[]).includes(state);
}

/**
 * 提交状态转换表。表外一律 `illegal_order_transition`（含未列出的自环）。
 *
 * `submitting → confirmed` 是被**明确允许**的：进程可能在 `sendIntentAt` 落账后、
 * 结果返回前死亡（执行器抛错 / 断电）。此时唯一合法动作是查原单，而平台完全可能
 * 已经受理——若不允许这条转换，崩溃后**真实已生成的订单将永远无法被确认**，
 * 与 `recover()` 给出的 `sent_unknown → query_original_order` 指引自相矛盾。
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderSubmissionState, readonly OrderSubmissionState[]>> =
  Object.freeze({
    submitting: ['submitted', 'rejected', 'unknown', 'confirmed', 'cancelled'],
    submitted: ['confirmed', 'rejected', 'unknown'],
    rejected: [],
    unknown: ['confirmed', 'rejected', 'unknown'],
    confirmed: [],
    cancelled: [],
  });

export function canTransitionOrder(from: OrderSubmissionState, to: OrderSubmissionState): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// 结果分类
// ---------------------------------------------------------------------------

/**
 * 提交结果的**业务分类**（与 `httpStatus` 无关的语义层）。
 * "HTTP 200 但业务失败" 必须落到 `business_failure`，绝不能是 `success`。
 *
 * - `rate_limited`：**可重试限流**（HTTP 429 / 业务码限流）。它**不是**终态拒单——
 *   一次可重试的提交若被判成 `business_failure`，会永久停在"失败"，从而误报"没下单"。
 * - `not_sent`：**可判定从未发出**（离线 / 发出前失败）。它**不是**"已发出未知"——
 *   请求从未离开设备，可安全续发同一条。
 */
export const ORDER_OUTCOME_KINDS = ['success', 'business_failure', 'unknown', 'rate_limited', 'not_sent'] as const;

export type OrderOutcomeKind = (typeof ORDER_OUTCOME_KINDS)[number];

export function isOrderOutcomeKind(value: unknown): value is OrderOutcomeKind {
  return typeof value === 'string' && (ORDER_OUTCOME_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 绑定与一次性授权引用
// ---------------------------------------------------------------------------

/**
 * 下单的**九项可核对绑定**：授权发行时逐项绑定，提交时逐项复核。
 * 任一项变化 ⇒ 旧授权对不上（`authorization_binding_mismatch`）。
 */
export interface OrderBinding {
  readonly actionId: string;
  readonly merchantId: string;
  /** 账号/收款方引用，不是凭据。形状 `^acct:[A-Za-z0-9._:-]+$`。 */
  readonly accountRef: string;
  /** 任务版本：推进后旧授权失效。 */
  readonly taskRevision: number;
  /** 完整参数摘要（M04 结构指纹 `v1-xxxxxxxx` 或 K07 契约 `sha256:<64hex>`）。 */
  readonly paramsDigest: string;
  /** 报价引用：报价变化即失效。 */
  readonly quoteRef: string;
  /** **整数最小单位**（分）。禁止浮点——浮点金额会让"相等"变成不可靠判据。 */
  readonly amount: number;
  /** ISO 4217 大写三字母。 */
  readonly currency: string;
  /** 权限范围：本模块只接受 `submit-order`（契约 enum 值）。 */
  readonly scope: OrderScope;
}

/**
 * 本模块可执行的范围。契约 `confirm-action.schema.json` 的 enum 里有五个值，
 * 但"提交订单"只允许 `submit-order`；`payment` / `purchase` 等**不得**在本模块执行。
 */
export const ORDER_SCOPES = ['submit-order'] as const;

export type OrderScope = (typeof ORDER_SCOPES)[number];

/**
 * **一次性授权引用**（K07 `AuthorizationGrant` 的下单侧投影）。
 *
 * 它必须由可信签发器产生（见 `authorization.ts`）；调用方自造的形状相同对象
 * 一律拒（`untrusted_authorization_ref`）。
 */
export interface AuthorizationRef extends OrderBinding {
  readonly grantId: string;
  readonly issuedAt: number;
  /** 期限（与 `Clock.now()` 同单位）；`now >= expiresAt` 即失效。 */
  readonly expiresAt: number;
  /** 签发它的确认界面标识（可审计）。 */
  readonly grantedBy: string;
  /** 契约 `$defs.grant` 的必需布尔字段；恒等于 `consumedAt !== null`。 */
  readonly consumed: boolean;
  readonly consumedAt: number | null;
  /** 占用它的幂等键（一次授权至多产生一单）。 */
  readonly consumedByKey: string | null;
}

// ---------------------------------------------------------------------------
// 传输结果（**不含**任何网络实现，只是数据）
// ---------------------------------------------------------------------------

/**
 * 执行器交回的**传输层**结果。
 *
 * 刻意把 `httpStatus` 与 `businessCode` 并列保存：任何只读取其一的判据都是错的，
 * 因为"HTTP 200 + 业务失败"恰恰是最常见的假成功来源。
 */
export type OrderTransportResult =
  | {
      readonly transport: 'response';
      /** HTTP 状态码（整数）。 */
      readonly httpStatus: number;
      /** 平台业务结果码（**必须**参与判定；空串视为未登记）。 */
      readonly businessCode: string;
      /** 平台侧订单号（成功时通常有；失败/未知可能为 null）。 */
      readonly providerOrderRef?: string | null;
      /**
       * 原始 `Retry-After` 头（**原样保存**，由判定层解释——端口层不猜）。
       * 429 时用于"等多久再试"；非法 / 缺失 ⇒ 判定层视为"无有效时长"。
       */
      readonly retryAfterHeader?: string | null;
    }
  | { readonly transport: 'timeout'; readonly detail: string }
  | { readonly transport: 'network_error'; readonly detail: string }
  /**
   * **本地网络不可用**：请求**从未发出**（不是"发出后未知"）。
   * 与 M-R04 `NetworkOutcome.transport === 'offline'` 同构。
   */
  | { readonly transport: 'offline'; readonly detail: string }
  /**
   * **发出前失败**（DNS / 连接建立 / TLS）或**发出中失败**。
   * `phase === 'before_send'` ⇒ 可判定未到达平台（可安全续发）；
   * `phase === 'during_send'` ⇒ 可能已到达平台（须查原单）。
   * 与 M-R04 `NetworkOutcome.transport === 'not_sent'` 同构。
   */
  | {
      readonly transport: 'not_sent';
      readonly phase: 'before_send' | 'during_send';
      readonly detail: string;
    };

/**
 * 提交分类结论（纯数据，便于断言）。
 *
 * 不变量：
 * - `kind === 'unknown'` ⇒ `needsQuery === true`（未知必须查原单）；
 * - `kind === 'not_sent'` ⇒ `needsQuery === false` 且 `retryable === true`（未发出，可续发）；
 * - `kind === 'rate_limited'` ⇒ `retryable === true`，`retryAfterMs` 采纳 `Retry-After`。
 */
export interface SubmitClassification {
  readonly kind: OrderOutcomeKind;
  /** 是否必须查原单才能收口（`unknown` / `rate_limited` 为 true；其余 false）。 */
  readonly needsQuery: boolean;
  /**
   * **传输层**是否值得再试一次（`rate_limited` / 超时 / 5xx / 未登记码 / `not_sent` 为 true）。
   * 注意：这不等于"提交可重放"——已到达平台的结果即便可重试，提交侧仍须查原单
   * （重放纪律见 `needsQuery` 与 `recover()`）。
   */
  readonly retryable: boolean;
  /** `429` 采纳的 `Retry-After` 毫秒；其余为 null。 */
  readonly retryAfterMs: number | null;
  /** 是否**可判定从未发出**（离线 / 发出前失败）——绝不是"已发出未知"。 */
  readonly notSent: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 提交请求 / 记录 / 回执
// ---------------------------------------------------------------------------

/**
 * 交给执行器的提交请求。
 *
 * **必须**携带：幂等键（`idempotencyKey`）、K07 语义的一次性授权引用
 * （`authorizationRef`）、参数摘要（`paramsDigest`）。三者同时在场才可能发出。
 */
export interface OrderSubmitRequest extends OrderBinding {
  readonly grantId: string;
  /** 幂等键；同时充当提交记录主键。由 `computeIdempotencyKey` 确定性导出。 */
  readonly idempotencyKey: string;
  /** K07 语义的一次性授权引用（完整绑定 + 期限 + 占用标记）。 */
  readonly authorizationRef: AuthorizationRef;
  readonly attempt: number;
  readonly requestedAt: number;
}

/** 提交记录（幂等键为主键；单进程内存或注入存储）。 */
export interface OrderSubmissionRecord extends OrderBinding {
  readonly grantId: string;
  readonly idempotencyKey: string;
  readonly state: OrderSubmissionState;
  /** 已尝试发出的次数（重启用同一条记录续发时会 +1）。 */
  readonly attempt: number;
  /**
   * 发出意图落账时刻。`null` = 本地认为**尚未发出**（可续发同一条）；
   * 非 `null` = 已留下发出意图（此后**只能查原单**）。
   */
  readonly sendIntentAt: number | null;
  readonly respondedAt: number | null;
  readonly httpStatus: number | null;
  readonly businessCode: string | null;
  readonly outcomeKind: OrderOutcomeKind | null;
  readonly providerOrderRef: string | null;
  readonly receipt: OrderReceipt | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * 查原单取回的回执（**只能**由 `createOrderReceipt` 签发）。
 *
 * 不变量（照契约 `external-receipt.schema.json`）：`verificationMode === 'fixture'`
 * 时 `observedState` **不得**为 `confirmed`——假端口不得签发"真实下单完成"。
 */
export interface OrderReceipt {
  readonly idempotencyKey: string;
  readonly providerOrderRef: string;
  readonly observedState: 'confirmed' | 'rejected' | 'unknown';
  readonly observedAt: number;
  readonly verificationMode: 'fixture' | 'real';
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 提交执行器。**真实网络调用由注入方提供**；本模块自身零网络。 */
export interface OrderExecutorPort {
  readonly identity: string;
  send(request: OrderSubmitRequest): OrderTransportResult | Promise<OrderTransportResult>;
}

/** 查原单请求。 */
export interface OrderQueryRequest {
  readonly idempotencyKey: string;
  readonly actionId: string;
  readonly grantId: string;
}

/** 原单查询端口：结果未知时**只查原单**，不重下。 */
export interface OrderQueryPort {
  readonly identity: string;
  query(request: OrderQueryRequest): OrderReceipt | null | Promise<OrderReceipt | null>;
}

/** 提交记录的持久化端口（内存实现随包提供；重启语义靠它）。 */
export interface OrderSubmissionStore {
  getByKey(idempotencyKey: string): OrderSubmissionRecord | undefined;
  put(record: OrderSubmissionRecord): void;
  all(): readonly OrderSubmissionRecord[];
}

/**
 * 提交前的**网络状态端口**（离线 ⇒ 提交不得发出）。
 *
 * 结构上与 M-R04 的 `NetworkMonitor`（`isOnline(): boolean`）兼容：
 * 把 M-R04 的监视器直接传进来即可，无需适配层。
 *
 * 纪律：设备离线时，"发送"必须是"**没发出**"（可安全续发），
 * 绝不能记成"发出后未知"——那会凭空制造一次"可能已下单"。
 */
export interface OrderNetworkStatePort {
  /** 当前是否在线。`false` ⇒ 提交拒绝发出（`submit_offline_not_sent`）。 */
  isOnline(): boolean;
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

export type OrderRecoveryKind = 'not_sent' | 'sent_unknown' | 'awaiting_receipt' | 'settled';

export type OrderRecoveryAction = 'resume_same_submission' | 'query_original_order' | 'none';

/**
 * 恢复结论。`mayCreateNewOrder` / `mayIssueNewAuthorizationRef` 是**字面量 `false`**：
 * "重复下单 / 另发授权"在恢复入口的类型层面就不存在（与 K07 `RecoveryVerdict` 同纪律）。
 */
export interface OrderRecoveryVerdict {
  readonly idempotencyKey: string;
  readonly state: OrderSubmissionState;
  readonly kind: OrderRecoveryKind;
  readonly allowedAction: OrderRecoveryAction;
  readonly detail: string;
  readonly mayCreateNewOrder: false;
  readonly mayIssueNewAuthorizationRef: false;
}

// ---------------------------------------------------------------------------
// 结果描述
// ---------------------------------------------------------------------------

export interface OrderOutcomeDescription {
  readonly idempotencyKey: string;
  readonly state: OrderSubmissionState;
  readonly summary: string;
  /** 是否可以声称订单已下达：只有 `confirmed` 为 true。 */
  readonly placedClaimable: boolean;
}
