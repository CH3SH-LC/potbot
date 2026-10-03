/**
 * M02 手机传输层 —— 类型定义（零依赖、纯数据）。
 *
 * ## 本包边界（美团线工作书 MEITUAN.md / M02）
 *
 * 「原生 HTTPS 或经核实 MCP/SDK transport、会话/刷新/撤销」：只拿 K03 keyRef，
 * 凭证只发官方授权 host；手机独立请求，APK/日志无明文；协议错误不变成业务成功。
 *
 * 真实美团协议**尚未核实**（M01 负责脱敏能力矩阵）。因此本包把「官方授权 host」
 * 与「业务码表」都做成**注入**：M01 核实前，任何具体主机名或码值都不在本包里被
 * 当成既成事实。本包只把**纪律**做进类型与状态机。
 *
 * ## 四条结构性纪律（写在类型里，不靠约定）
 *
 * 1. **描述符无秘密**：{@link TransportRequestDescriptor} 只有 `keyRef` /
 *    方法 / host / path / body，没有任何 token/密钥字段。令牌只在
 *    {@link RawTransportRequest} 这一层存在，且由 `client.ts` 从会话内存中取出，
 *    从不经过调用方、日志或证据。
 * 2. **官方 host 唯一出口**：请求在发出前必须过 {@link EndpointPolicy}；不在白名单
 *    内 ⇒ {@link TransportFailure}（`endpoint_not_allowed`），**零网络调用**。
 * 3. **协议错误不可能是业务成功**：{@link TransportOutcome} 是判别联合——
 *    只有 `delivered: true` 才携带 {@link BusinessEnvelope}，而 `delivered: true`
 *    的充要条件是**传输送达 + JSON 可解析 + 信封形状合法**。解析失败 / 形状非法
 *    一律落到 `delivered: false`。所以「协议错误变成业务成功」在本类型下**不可表达**。
 * 4. **两段判定**：送达之后还要看业务码。未登记的业务码一律 `unknown`，
 *    `businessSuccess` 只可能来自业务码登记为 `success`。
 */

// ---------------------------------------------------------------------------
// 端口类型（由 K03 / 原生运行时注入）
// ---------------------------------------------------------------------------

/** HTTP 方法（本包只用这两种；其余在类型层不可表达）。 */
export type HttpMethod = 'GET' | 'POST';

/**
 * 调用方给出的请求描述符。
 *
 * **结构上没有秘密字段**：没有 token、没有 Authorization、没有密钥。它只引用
 * `keyRef`，真正的凭据由 `client.ts` 从注入端口与会话内存中取用。
 */
export interface TransportRequestDescriptor {
  /** K03 提供的凭证引用（`keyref:...`）。**
   * 本包只接受引用；明文会被 `assertKeyRef` 立即拒绝且不回显。 */
  readonly keyRef: string;
  readonly method: HttpMethod;
  /** 目标主机（必须过 {@link EndpointPolicy}）。 */
  readonly host: string;
  /** 目标路径（不含 host）。 */
  readonly path: string;
  /** 可选 JSON 请求体（会被序列化进 {@link RawTransportRequest.bodyJson}）。 */
  readonly body?: unknown;
  /** 该请求所需的会话 scope；缺省表示不额外要求，用会话自带 scope。 */
  readonly scope?: string;
  /** 单次调用超时（毫秒），注入式，不读系统时间。 */
  readonly timeoutMs?: number;
}

/**
 * 凭证材料（K03 提供）。
 *
 * `material` 是**秘密**（原生密钥库解密后的字节）：只允许由 {@link TransportPort}
 * 在构造 Authorization 头的瞬间使用，**不得**写进描述符、日志、证据、返回值。
 */
export interface TransportCredential {
  readonly keyRef: string;
  /** 明文凭证材料。仅请求期间存活；本包不保存、不记录、不回显。 */
  readonly material: string;
}

/** K03 凭证解析端口：`keyRef` ⇒ 请求期可用的凭证材料。 */
export interface CredentialResolverPort {
  resolve(keyRef: string): Promise<TransportCredential>;
}

/**
 * 原生网络端口（真机为受限 HTTPS；测试为假端口）。
 *
 * 收到的 {@link RawTransportRequest} **含 Authorization 头**（秘密）：这是明文
 * 唯一允许出现的边界。实现方负责真正发出请求并返回原始响应。
 */
export interface TransportPort {
  send(request: RawTransportRequest): Promise<RawTransportResponse>;
}

/** 原生端口发出的请求（含秘密头；只在此边界内存在）。 */
export interface RawTransportRequest {
  readonly method: HttpMethod;
  readonly host: string;
  readonly path: string;
  /** 含 `Authorization` 等头；**绝不**记录 / 回显。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyJson: string | null;
  readonly timeoutMs: number;
}

/** 原生端口的原始响应。 */
export interface RawTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

/**
 * 网络错误的两个阶段（对齐 M-R04 `NETWORK_ERROR_PHASES`）。
 *
 * `before_send` = DNS 解析 / TCP 连接 / TLS 握手阶段失败 ⇒ **可判定请求未到达平台**；
 * `during_send` = 请求已开始发送 / 等待响应期间出错 ⇒ **可能已到达平台**。
 * 这个区分是 M-R04 提交恢复的前提：phase 不明时只能保守当作 `during_send`。
 */
export const NETWORK_ERROR_PHASES = ['before_send', 'during_send'] as const;

/** 网络错误阶段。 */
export type NetworkErrorPhase = (typeof NETWORK_ERROR_PHASES)[number];

/**
 * 端口级传输故障（原生层抛出的）。
 *
 * - `offline`：本地网络不可用，**从未发出**；
 * - `network_error`：按 {@link RawTransportFault.phase} 判定是否可能已到达；
 * - `timeout`：请求可能已到达平台。
 */
export type RawTransportFaultKind = 'offline' | 'network_error' | 'timeout';

/**
 * 原生端口的故障（以 reject 形式抛出；本包按类型收窄）。
 *
 * `phase` 让"发出前失败"（DNS/连接建立）与"发出途中失败"可被区分——这是
 * "DNS/连接失败必须判定为 definitely-not-sent，而不是 mayHaveReached"的落点。
 * 缺省 `during_send`：**拿不准时保守当作可能已到达**（宁可多查一次原单，也不误判未发出）。
 */
export class RawTransportFault extends Error {
  readonly kind: RawTransportFaultKind;
  readonly phase: NetworkErrorPhase;
  constructor(kind: RawTransportFaultKind, message: string, phase: NetworkErrorPhase = 'during_send') {
    super(message);
    this.name = 'RawTransportFault';
    this.kind = kind;
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// host 策略
// ---------------------------------------------------------------------------

/** 官方授权 host 策略（白名单，精确匹配 host，不匹配子域后缀）。 */
export interface EndpointPolicy {
  readonly allowedHosts: readonly string[];
  isAllowed(host: string): boolean;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/** 会话状态（严格五态）。 */
export type SessionState = 'idle' | 'active' | 'refreshing' | 'revoked' | 'expired';

/** 会话拒绝 / 不可用原因。 */
export type SessionUnavailableReason =
  | 'absent'
  | 'revoked'
  | 'expired'
  | 'refreshing'
  | 'scope_missing'
  | 'not_refreshable';

/** 令牌铸造端口（真机 = 官方授权 host 的会话交换；测试 = 假铸造器）。 */
export interface SessionMinterPort {
  mint(input: {
    readonly keyRef: string;
    readonly accountRef: string;
    readonly credential: TransportCredential;
    readonly now: number;
    /** 刷新时传入上一枚 tokenRef；首次铸造为 null。 */
    readonly previousTokenRef: string | null;
  }): Promise<MintedSession>;
}

/** 铸造出的会话令牌（`token` 是秘密，`tokenRef` 是可记录引用）。 */
export interface MintedSession {
  /** 可跨日志 / 证据的引用（`sessref:...`），**不是**令牌。 */
  readonly tokenRef: string;
  /** 会话令牌明文（秘密）；只在内存与 Authorization 头之间流转。 */
  readonly token: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  /** 平台是否允许刷新。不可刷新时，到期即 `expired`，不得静默重铸。 */
  readonly refreshable: boolean;
}

/** 对外可见的会话快照 —— **只有引用与状态，没有任何令牌字段**。 */
export interface SessionSnapshot {
  readonly state: SessionState;
  readonly tokenRef: string | null;
  readonly keyRef: string | null;
  readonly accountRef: string | null;
  readonly scopes: readonly string[];
  readonly issuedAt: number | null;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly refreshCount: number;
}

/** 活跃会话的内部门面（只给 `client.ts` 取 Authorization 头用）。 */
export interface ActiveSession {
  readonly tokenRef: string;
  /** 秘密：仅供构造 Authorization 头。 */
  readonly token: string;
  readonly accountRef: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// 协议解码与业务分类
// ---------------------------------------------------------------------------

/** 协议层错误种类（都在 `delivered: false` 一侧）。 */
export type ProtocolErrorKind = 'empty_body' | 'malformed_json' | 'invalid_envelope';

/** 官方业务信封（形状未核实；此处只固定最小必需字段 `code`）。 */
export interface BusinessEnvelope {
  readonly code: string;
  readonly message: string | null;
  readonly data: unknown;
}

/** 业务分类（送达后的第二段判定）。 */
export type BusinessKind = 'success' | 'business_failure' | 'unknown';

/** 业务码登记表（注入；未登记的码一律 `unknown`，绝不猜成功）。 */
export interface BusinessCodeTable {
  lookup(code: string): BusinessKind;
}

// ---------------------------------------------------------------------------
// 调用结果（判别联合 = 纪律）
// ---------------------------------------------------------------------------

/** 未送达的原因（携带 `delivered: false`）。 */
export type TransportFailureKind =
  | 'endpoint_not_allowed'
  | 'session_unavailable'
  | 'credential_missing'
  | 'offline'
  | 'not_sent'
  | 'network_error'
  | 'timeout'
  | 'http_error'
  | 'protocol_error'
  | 'auth_failed';

// ---------------------------------------------------------------------------
// 原始网络结果（NetworkOutcome）—— M-R04 消费的结构
// ---------------------------------------------------------------------------

/**
 * 传输层**原始结果**（不含业务判定）。**结构逐字对齐** M-R04
 * `tests/mobile-meituan/M-R04/types.ts` 的 `NetworkOutcome`（本包不 import tests/，
 * 由结构一致性 + 本包测试钉住），使 M-R04 的处置 / 恢复层可直接消费。
 *
 * 与 `TransportOutcome` 的区别：`NetworkOutcome` 只描述**网络发生了什么**
 * （离线 / 未发出 / 超时 / 网络错误 / 收到响应），不回答"业务成功没有"。
 * `delivered` 的 `TransportOutcome` 映射为 `response`；`endpoint_not_allowed` /
 * `session_unavailable` / `credential_missing` 这类**根本没发出去**的失败映射为
 * `not_sent` + `before_send`，让恢复层可以判定 `mayHaveReachedPlatform === false`。
 */
export type NetworkOutcome =
  /** 本地网络不可用：**从未发出**（不是"发出后未知"）。 */
  | { readonly transport: 'offline'; readonly detail: string }
  /** 在发出前就失败（DNS / 连接建立 / TLS）：**可判定未到达平台**。 */
  | { readonly transport: 'not_sent'; readonly phase: NetworkErrorPhase; readonly detail: string }
  /** 超时：请求可能已到达平台（`mayHaveReachedPlatform` 默认为 true）。 */
  | { readonly transport: 'timeout'; readonly detail: string }
  /** 网络错误：按 `phase` 判定是否可能已到达。 */
  | { readonly transport: 'network_error'; readonly phase: NetworkErrorPhase; readonly detail: string }
  /** 收到 HTTP 响应（业务码 + `Retry-After` **原文**，不在本层解释）。 */
  | {
      readonly transport: 'response';
      readonly httpStatus: number;
      readonly businessCode: string;
      readonly retryAfterHeader?: string | null;
      readonly providerOrderRef?: string | null;
    };

/** 脱敏证据条目：结构上只有引用、主机、路径、状态、时间，**没有秘密落点**。 */
export interface TransportEvidence {
  readonly host: string;
  readonly path: string;
  readonly method: HttpMethod;
  readonly keyRef: string;
  readonly tokenRef: string | null;
  readonly status: number | null;
  readonly outcome: string;
  readonly at: number;
  readonly redacted: true;
  /** 自证：证据里的明文字段数恒为 0。 */
  readonly plaintextSecretFields: 0;
}

/** 已送达且协议合法的结果（仍可能是业务失败 / 未知）。 */
export interface TransportDelivered {
  readonly delivered: true;
  readonly ok: true;
  readonly status: number;
  readonly host: string;
  readonly path: string;
  readonly keyRef: string;
  readonly tokenRef: string;
  readonly businessKind: BusinessKind;
  /** 仅当 `businessKind === 'success'` 为 true。 */
  readonly businessSuccess: boolean;
  readonly businessCode: string;
  readonly data: unknown;
  readonly envelope: BusinessEnvelope;
  readonly evidence: TransportEvidence;
  /** 原始网络结果（M-R04 消费）。此处恒为 `transport: 'response'`。 */
  readonly network: NetworkOutcome;
}

/** 未送达 / 协议失败 / 会话失败的结果。**永远不是业务成功。** */
export interface TransportFailure {
  readonly delivered: false;
  readonly ok: false;
  readonly failureKind: TransportFailureKind;
  readonly status: number | null;
  readonly host: string;
  readonly path: string;
  readonly keyRef: string;
  readonly tokenRef: string | null;
  readonly protocolErrorKind: ProtocolErrorKind | null;
  readonly reason: string;
  readonly evidence: TransportEvidence;
  /**
   * 原始网络结果（M-R04 消费）。**发出前就失败**（策略拒绝 / 无会话 / 无凭证 /
   * DNS 与连接建立失败）⇒ `not_sent` + `before_send`，恢复层据此判定未到达平台。
   */
  readonly network: NetworkOutcome;
}

/** 传输层调用结果。`delivered: true` ⇔ `ok: true` ⇔ 协议已成功解码。 */
export type TransportOutcome = TransportDelivered | TransportFailure;
