/**
 * M-R04 网络韧性层 —— **类型与词表**（零依赖、纯类型 + 纯数据）。
 *
 * ## 本包要关掉的那几个洞（MEITUAN.md M-R04 行）
 *
 * 「网络切换、429/5xx/超时、提交结果未知恢复」。源码复核（`src/mobile-plugins/meituan/
 * order-submit/codes.ts`）确认：
 *
 * - 超时 / 5xx 已由 M07 归为 `unknown`（须查原单）——本包**复用**该口径，不重造；
 * - 但 **`httpStatus >= 400` 一律 `business_failure`，把 `429 Too Many Requests` 也
 *   判成"确定性拒单"**。这不是本包的重复劳动，而是一条**必须被纠正的判据**：
 *   429 是可重试的限流，不是终态拒单；把它判成 `rejected` 会让一次可重试的提交
 *   永久停在"失败"，从而误报"没下单"。本包在**传输韧性层**给出正确处置，
 *   并把纠正建议作为 integrationRequest 提给 M07（本包不改 M07 源码）。
 * - **网络切换**（掉线 / 换网 / 回网）没有任何模块处理：掉线时不得发出、回网后
 *   不是"重发一单"而是"先查原单"。本包建模。
 * - **提交与只读的重试纪律不同**：只读可自由重试；提交在"请求可能已到平台"时
 *   **不得盲目重放**（与 README §5 / K07 同纪律）。
 *
 * ## 结构性边界（与 M07 一致，靠类型与端口保证）
 *
 * - **零网络**：`RawTransportPort` 一律注入；本包自身不 import `node:*`、不触网、
 *   不读系统时间、不使用随机数。
 * - **不声称真实下单**：本包只处置"传输结果"，不产生 `externalId`、不签发回执。
 * - `mayCreateNewOrder` / `mayIssueNewAuthorization` 是**字面量 `false`**：
 *   "重复下单 / 另发授权"在恢复入口的类型层面就不存在。
 */

// ---------------------------------------------------------------------------
// 网络状态
// ---------------------------------------------------------------------------

/** 手机网络类型。`none` 即离线。 */
export const NETWORK_KINDS = ['none', 'wifi', 'cellular', 'ethernet'] as const;

export type NetworkKind = (typeof NETWORK_KINDS)[number];

export function isNetworkKind(value: unknown): value is NetworkKind {
  return typeof value === 'string' && (NETWORK_KINDS as readonly string[]).includes(value);
}

/**
 * 网络状态快照（不可变）。
 *
 * `generation` 每次**类型切换**（含离线↔在线）自增——它是"发生了一次网络切换"的
 * 可机读证据：`snapshot.generation !== before.generation` 就说明中间切过网。
 */
export interface NetworkSnapshot {
  readonly kind: NetworkKind;
  /** `kind !== 'none'`。 */
  readonly online: boolean;
  /** 是否按流量计费（蜂窝为 true）。仅作提示，不参与是否允许发送。 */
  readonly metered: boolean;
  /** 切换代数（每次 `setKind` 变更 +1）。 */
  readonly generation: number;
  /** 切到当前状态的逻辑时刻（注入时钟域）。 */
  readonly changedAt: number;
}

// ---------------------------------------------------------------------------
// 操作类别
// ---------------------------------------------------------------------------

/** 操作类别：只读查询可自由重试；提交（有副作用）重放纪律不同。 */
export const OPERATION_KINDS = ['read', 'submit'] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

// ---------------------------------------------------------------------------
// 原始传输结果（**数据**，不含任何网络实现）
// ---------------------------------------------------------------------------

/** 网络错误发生的阶段——决定"请求是否可能已到平台"。 */
export const NETWORK_ERROR_PHASES = ['before_send', 'during_send'] as const;

export type NetworkErrorPhase = (typeof NETWORK_ERROR_PHASES)[number];

/**
 * 执行器 / 原始传输端口交回的**原始结果**（传输层事实，不含业务判定）。
 *
 * 刻意把 `httpStatus` 与 `businessCode` 并列；`retryAfterHeader` 原样保存，
 * 由解析层（`parseRetryAfter`）解释——不在端口层猜。
 */
export type NetworkOutcome =
  /** 本地网络不可用：**从未发出**（不是"发出后未知"）。 */
  | { readonly transport: 'offline'; readonly detail: string }
  /** 在发出前就失败（DNS / 连接建立 / TLS）：**可判定未到达平台**。 */
  | { readonly transport: 'not_sent'; readonly phase: NetworkErrorPhase; readonly detail: string }
  /** 超时：请求可能已到达平台（默认 `mayHaveReached = true`）。 */
  | { readonly transport: 'timeout'; readonly detail: string }
  /** 网络错误：按 `phase` 判定是否可能已到达。 */
  | { readonly transport: 'network_error'; readonly phase: NetworkErrorPhase; readonly detail: string }
  /** 收到 HTTP 响应（业务码 + 可选 `Retry-After` 原文）。 */
  | {
      readonly transport: 'response';
      readonly httpStatus: number;
      readonly businessCode: string;
      readonly retryAfterHeader?: string | null;
      readonly providerOrderRef?: string | null;
    };

// ---------------------------------------------------------------------------
// 处置结论
// ---------------------------------------------------------------------------

/** 传输层处置分类（与"是否成功"无关的语义层）。 */
export const DISPOSITION_KINDS = [
  'success',
  'business_failure',
  'rate_limited',
  'server_error',
  'client_error',
  'timeout',
  'network_error',
  'offline',
  'unknown',
] as const;

export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/**
 * 重试建议（**传输层可重试性**，与"是否成功"无关）。
 *
 * 注意：本建议**只回答"这次结果值不值得再发一次"**，不回答"提交能不能重放"——
 * 后者是 `recovery.ts` 的判据（看 `mayHaveReachedPlatform` + 服务端幂等）。
 * 因此 5xx / 超时这类"对只读可重试、对提交可能已到达"的结果，建议一律是
 * `after_delay`；提交侧是否采纳由恢复策略另外把关。
 *
 * - `no`：不重试（成功 / 确定性拒单 / 确定性客户端拒绝 / 终态）。
 * - `immediate`：可立即重试（请求可判定未到达平台，无需等待）。
 * - `after_delay`：等待一段时间后重试（429 采纳 `Retry-After`；5xx / 超时走退避）。
 * - `wait_for_network`：离线，等网络恢复（**不是**重发）。
 */
export const RETRY_ADVICES = ['no', 'immediate', 'after_delay', 'wait_for_network'] as const;

export type RetryAdvice = (typeof RETRY_ADVICES)[number];

/** 一次传输结果的**处置结论**（纯数据）。 */
export interface TransportDisposition {
  readonly kind: DispositionKind;
  readonly retry: RetryAdvice;
  /** 建议等待毫秒（`after_delay` 时非 null；429 时来自 `Retry-After`）。 */
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;
  readonly businessCode: string | null;
  /** 这次请求**是否可能已经到达平台**（决定提交能否盲目重放）。 */
  readonly mayHaveReachedPlatform: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 重试策略
// ---------------------------------------------------------------------------

/** 有界重试策略（确定性；抖动由注入函数提供，见 `planRetry`）。 */
export interface RetryPolicy {
  /** 总尝试次数上限（含首次）。`1` 表示不重试。 */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** 退避倍率（指数）。 */
  readonly factor: number;
  /** 单次等待上限。 */
  readonly maxDelayMs: number;
  /** 是否采纳服务端 `Retry-After`（取"至少等这么久"）。 */
  readonly honorRetryAfter: boolean;
  /** 抖动比例 0..1（0 = 无抖动）。需要注入 `jitterFn` 才生效。 */
  readonly jitterRatio: number;
}

/** 重试计划的动作词表（`query_first` 不在此列：它是恢复策略的动作，不是重试动作）。 */
export const RETRY_ACTIONS = [
  'stop',
  'give_up',
  'retry_immediate',
  'retry_after_delay',
  'wait_for_network',
] as const;

export type RetryAction = (typeof RETRY_ACTIONS)[number];

export interface RetryPlan {
  readonly action: RetryAction;
  readonly delayMs: number;
  /** 已完成的传输尝试次数（本次计划基于它做出）。 */
  readonly attemptsMade: number;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 提交恢复
// ---------------------------------------------------------------------------

/** 提交结果未知/可疑时的**唯一合法动作集**。 */
export const SUBMIT_RECOVERY_ACTIONS = [
  /** 未到达平台（或已有可核验服务端幂等）：可续发**同一**请求（同幂等键，不新建）。 */
  'resume_same_request',
  /** 可能已到达：改查原单，**不得重放**。 */
  'query_original_order',
  /** 离线：等网络恢复（恢复本身不等于重发）。 */
  'wait_for_network',
  /** 已到终态（受理/拒单），无需恢复动作。 */
  'stop_settled',
  /** 已达尝试上限且无法安全续发：如实放弃，不伪造成功。 */
  'give_up_no_retry',
] as const;

export type SubmitRecoveryAction = (typeof SUBMIT_RECOVERY_ACTIONS)[number];

export interface SubmitRecoveryInput {
  readonly network: NetworkSnapshot;
  readonly disposition: TransportDisposition;
  /** 已完成的发送尝试次数。 */
  readonly attemptsMade: number;
  readonly maxAttempts: number;
  /**
   * 服务端是否提供**可核验**的幂等保障（同幂等键不会重复下单，且我们能证实）。
   * 未核实时为 `false` ⇒ "可能已到达"的提交**一律查原单**。
   */
  readonly serverIdempotencyVerified: boolean;
}

/**
 * 恢复计划。`mayCreateNewOrder` / `mayIssueNewAuthorization` 恒为字面量 `false`：
 * "重建一单 / 另发一张授权"在本层类型上不存在（与 K07 `RecoveryVerdict` 同纪律）。
 */
export interface SubmitRecoveryPlan {
  readonly action: SubmitRecoveryAction;
  readonly reason: string;
  /** 是否允许**自动**续发同一请求（同幂等键）。`query_original_order` 恒 false。 */
  readonly autoResendAllowed: boolean;
  /** 是否必须先查原单。 */
  readonly requiresOriginalOrderQuery: boolean;
  readonly mayCreateNewOrder: false;
  readonly mayIssueNewAuthorization: false;
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 只读时钟端口（与 M04 `QuoteClock` 结构兼容）。 */
export interface ResilienceClock {
  now(): number;
}

/** 等待端口（**注入**；本包不用 `setTimeout`，保证可重现与可测）。 */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** 原始传输端口：真实手机 HTTPS 客户端由注入方提供。本包自身零网络。 */
export interface RawTransportPort {
  readonly identity: string;
  /** `ref` 是不透明的操作引用（脱敏，不含凭据/地址/手机号）。 */
  send(ref: string): NetworkOutcome | Promise<NetworkOutcome>;
  /** 该端口**真实收到**的调用 ref（按顺序）。 */
  readonly calls: readonly string[];
}
