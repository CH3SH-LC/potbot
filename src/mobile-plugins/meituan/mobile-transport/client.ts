/**
 * M02 —— 传输客户端：把白名单、会话、协议、业务四段串成同一条调用链。
 *
 * ## 调用顺序（每一步的否定都在此收口，绝不越过下一段）
 *
 * 1. **keyRef 形状**：不合形状（尤其误传明文）⇒ `credential_missing`，且 keyRef
 *    字段用占位符 `«invalid-key-ref»`，**明文不进入结果 / 证据**。
 * 2. **host 白名单**：非官方授权 host ⇒ `endpoint_not_allowed`，**在 resolv 凭证与
 *    发出网络调用之前**返回（凭证不会流到非官方 host）。
 * 3. **会话**：`ensureActive` 每次重新判定；`revoked` / `expired` / 缺 scope ⇒
 *    `session_unavailable`（含具体 reason），不自动重登。
 * 4. **凭证解析**：K03 `CredentialResolverPort`。
 * 5. **原生端口**：把令牌放进 Authorization 头后调用 {@link TransportPort}。
 * 6. **协议 + 业务**：只有 2xx 才进入解码；解码失败 ⇒ `protocol_error`；
 *    解码成功才 `delivered:true`，业务码未登记 ⇒ `businessKind:'unknown'`。
 * 7. **401 刷新重试一次**：仅在 401 且会话可刷新时；重试仍 401 ⇒ `auth_failed`。
 *
 * ## 关键不变量（测试断言）
 *
 * - `delivered === true` �⇔ `ok === true` �⇔ 传输 2xx 且信封可解析。
 * - `businessSuccess === true` ⇔ `delivered===true && businessKind==='success'`。
 * - 协议错误（空 body / 非 JSON / 缺 code）**只能**出现在 `delivered:false` 一侧。
 */

import { isKeyRef } from './keyref.js';
import { classifyBusiness, decodeEnvelope } from './protocol.js';
import { buildEvidence, assertEvidenceClean } from './redact.js';
import { SessionUnavailableError } from './errors.js';
import {
  faultToNetworkOutcome,
  makeNotSentOutcome,
  makeResponseOutcome,
  readRetryAfter,
} from './network.js';
import type { SessionManager } from './session.js';
import type {
  ActiveSession,
  BusinessCodeTable,
  CredentialResolverPort,
  EndpointPolicy,
  NetworkErrorPhase,
  NetworkOutcome,
  RawTransportRequest,
  RawTransportFault,
  RawTransportResponse,
  SessionSnapshot,
  TransportCredential,
  TransportFailure,
  TransportFailureKind,
  TransportOutcome,
  TransportPort,
  TransportRequestDescriptor,
} from './types.js';
import { RawTransportFault as RawTransportFaultCtor } from './types.js';

/** 注入项。 */
export interface TransportClientOptions {
  readonly policy: EndpointPolicy;
  readonly session: SessionManager;
  readonly credentialResolver: CredentialResolverPort;
  readonly transport: TransportPort;
  readonly businessCodes: BusinessCodeTable;
  /** 默认超时（毫秒）。 */
  readonly defaultTimeoutMs?: number;
  /** 401 时是否尝试刷新一次再重试（默认 true）。 */
  readonly refreshOnAuthFailure?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const INVALID_KEY_PLACEHOLDER = '«invalid-key-ref»';

/** 传输客户端。所有外部能力均由构造参数注入，包内不含任何真实网络调用。 */
export class TransportClient {
  readonly #opts: TransportClientOptions;

  constructor(options: TransportClientOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('TransportClient 需要注入配置对象');
    }
    this.#opts = options;
  }

  /**
   * 执行一次传输调用。**对可预期失败不抛异常**，一律编码进 {@link TransportOutcome}，
   * 使调用方无法把"没有结果"当成成功。
   */
  async invoke(descriptor: TransportRequestDescriptor, now: number): Promise<TransportOutcome> {
    const host = typeof descriptor?.host === 'string' ? descriptor.host : '';
    const path = typeof descriptor?.path === 'string' ? descriptor.path : '';
    const method = descriptor?.method === 'GET' ? 'GET' : 'POST';
    const rawKeyRef = (descriptor as { keyRef?: unknown })?.keyRef;

    // 1) keyRef 形状（不回显明文）
    if (!isKeyRef(rawKeyRef)) {
      return this.#failure({
        failureKind: 'credential_missing',
        host,
        path,
        method,
        keyRef: INVALID_KEY_PLACEHOLDER,
        tokenRef: null,
        status: null,
        reason: 'keyRef 形状非法（须为 keyref:...）：拒绝发出请求',
        now,
      });
    }
    const keyRef = rawKeyRef;

    // 2) host 白名单（在解析凭证 / 网络调用之前）
    if (!this.#opts.policy.isAllowed(host)) {
      return this.#failure({
        failureKind: 'endpoint_not_allowed',
        host,
        path,
        method,
        keyRef,
        tokenRef: null,
        status: null,
        reason: `目标 host 不在官方授权列表内：${host || '（空）'}（发出前拒绝，凭证未流出）`,
        now,
      });
    }

    // 3) 会话（每次重新判定）
    let active: ActiveSession;
    try {
      active = this.#opts.session.ensureActive(now, descriptor?.scope);
    } catch (error) {
      if (error instanceof SessionUnavailableError) {
        return this.#failure({
          // 会话的所有否定都归入 session_unavailable；具体原因写进 reason 与证据 outcome。
          failureKind: 'session_unavailable',
          host,
          path,
          method,
          keyRef,
          tokenRef: this.#opts.session.snapshot().tokenRef,
          status: null,
          reason: `会话不可用（${error.reason}）：${error.message}`,
          now,
          outcome: `session:${error.reason}`,
        });
      }
      throw error;
    }

    const timeoutMs =
      typeof descriptor?.timeoutMs === 'number' && Number.isSafeInteger(descriptor.timeoutMs) && descriptor.timeoutMs > 0
        ? descriptor.timeoutMs
        : this.#opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 4) 凭证解析（失败也绝不把 keyRef 之外的东西带进结果）
    let credential: TransportCredential;
    try {
      credential = await this.#opts.credentialResolver.resolve(keyRef);
    } catch {
      return this.#failure({
        failureKind: 'credential_missing',
        host,
        path,
        method,
        keyRef,
        tokenRef: active.tokenRef,
        status: null,
        reason: 'K03 凭证解析失败：无可用凭据材料',
        now,
      });
    }

    // 5) 发出（把秘密令牌放进 Authorization 头——明文唯一允许出现的边界）
    const first = await this.#sendOnce(descriptor, host, path, method, active.token, timeoutMs, now, keyRef, active.tokenRef);
    if (first.kind !== 'retry_auth') {
      return first.outcome;
    }

    // 6) 401：刷新一次再重试一次（仅此一次）
    const refreshOnAuth = this.#opts.refreshOnAuthFailure !== false;
    if (!refreshOnAuth) {
      return first.outcome;
    }
    let refreshed: SessionSnapshot;
    try {
      refreshed = await this.#opts.session.refresh({ credential, now });
    } catch (error) {
      const reason = error instanceof SessionUnavailableError ? error.reason : 'absent';
      return this.#failure({
        failureKind: 'auth_failed',
        host,
        path,
        method,
        keyRef,
        tokenRef: this.#opts.session.snapshot().tokenRef,
        status: first.status,
        reason: `401 后刷新失败（${reason}）：不得重试，不得视为成功`,
        now,
        outcome: 'auth_failed:refresh_failed',
        network: first.outcome.network,
      });
    }
    let retryToken: string;
    try {
      retryToken = this.#opts.session.ensureActive(now, descriptor?.scope).token;
    } catch (error) {
      const reason = error instanceof SessionUnavailableError ? error.reason : 'absent';
      return this.#failure({
        failureKind: 'auth_failed',
        host,
        path,
        method,
        keyRef,
        tokenRef: refreshed.tokenRef,
        status: first.status,
        reason: `刷新后会话不可用（${reason}）：不得重试，不得视为成功`,
        now,
        outcome: 'auth_failed:refresh_unusable',
        network: first.outcome.network,
      });
    }
    const second = await this.#sendOnce(
      descriptor,
      host,
      path,
      method,
      retryToken,
      timeoutMs,
      now,
      keyRef,
      refreshed.tokenRef ?? first.outcome.evidence.tokenRef ?? null,
    );
    if (second.kind === 'retry_auth') {
      return this.#failure({
        failureKind: 'auth_failed',
        host,
        path,
        method,
        keyRef,
        tokenRef: refreshed.tokenRef,
        status: second.status,
        reason: '401 刷新后重试仍 401：认证失败',
        now,
        outcome: 'auth_failed:retry_401',
        network: second.outcome.network,
      });
    }
    return second.outcome;
  }

  /**
   * 只返回 M-R04 消费的 {@link NetworkOutcome}（网络事实），丢弃业务判定。
   * 供 `tests/mobile-meituan/M-R04` 的 `RawTransportPort` 适配器一行接线。
   */
  async invokeNetwork(descriptor: TransportRequestDescriptor, now: number): Promise<NetworkOutcome> {
    return (await this.invoke(descriptor, now)).network;
  }

  /** 发出一次请求并解读。返回 `retry_auth` 表示调用方应尝试"刷新 + 重试"。 */
  async #sendOnce(
    descriptor: TransportRequestDescriptor,
    host: string,
    path: string,
    method: 'GET' | 'POST',
    token: string,
    timeoutMs: number,
    now: number,
    keyRef: string,
    tokenRef: string | null,
  ): Promise<{ readonly kind: 'outcome'; readonly outcome: TransportFailure } | { readonly kind: 'done'; readonly outcome: TransportOutcome } | { readonly kind: 'retry_auth'; readonly status: number; readonly outcome: TransportFailure }> {
    const bodyJson = descriptor?.body === undefined ? null : JSON.stringify(descriptor.body);
    const headers: Record<string, string> = {
      // 秘密令牌：仅在请求期间存在于该头；从不写入日志 / 证据 / 返回值。
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const request: RawTransportRequest = Object.freeze({
      method,
      host,
      path,
      headers: Object.freeze(headers),
      bodyJson,
      timeoutMs,
    });

    let response: RawTransportResponse;
    try {
      response = await this.#opts.transport.send(request);
    } catch (error) {
      const fault = error as RawTransportFault;
      const faultKind = fault instanceof RawTransportFaultCtor ? fault.kind : 'network_error';
      const phase: NetworkErrorPhase = fault instanceof RawTransportFaultCtor ? fault.phase : 'during_send';
      const failureKind: TransportFailureKind =
        faultKind === 'offline'
          ? 'offline'
          : faultKind === 'timeout'
            ? 'timeout'
            : phase === 'before_send'
              ? 'not_sent'
              : 'network_error';
      const reason =
        faultKind === 'offline'
          ? '原生端口离线：请求未发出'
          : faultKind === 'timeout'
            ? '原生端口超时：结果未知（可能已到达平台）'
            : phase === 'before_send'
              ? '发出前失败（DNS / 连接建立 / TLS）：请求未到达平台'
              : '原生端口网络错误：结果未知（可能已到达平台）';
      return {
        kind: 'outcome',
        outcome: this.#failure({
          failureKind,
          host,
          path,
          method,
          keyRef,
          tokenRef,
          status: null,
          reason,
          now,
          outcome: failureKind,
          network: faultToNetworkOutcome({ kind: faultKind, phase }, reason),
        }),
      };
    }

    const status = typeof response?.status === 'number' ? response.status : 0;
    // `Retry-After` 原文透传（大小写不敏感）；解析交给 M-R04，不在本层猜。
    const retryAfterHeader = readRetryAfter(response?.headers);

    // 认证失败：交给调用方决定是否刷新
    if (status === 401) {
      const failure = this.#failure({
        failureKind: 'auth_failed',
        host,
        path,
        method,
        keyRef,
        tokenRef,
        status,
        reason: '401 未认证',
        now,
        outcome: 'auth_failed:401',
        network: makeResponseOutcome({ httpStatus: status, retryAfterHeader }),
      });
      return { kind: 'retry_auth', status, outcome: failure };
    }

    // 非 2xx 一律不进入业务判定（避免把 HTTP 错误当成业务成功）
    if (status < 200 || status >= 300) {
      const failureKind: TransportFailureKind = status === 403 ? 'auth_failed' : 'http_error';
      return {
        kind: 'outcome',
        outcome: this.#failure({
          failureKind,
          host,
          path,
          method,
          keyRef,
          tokenRef,
          status,
          reason: `HTTP ${status}：非 2xx 不进入业务判定`,
          now,
          outcome: `http:${status}`,
          network: makeResponseOutcome({ httpStatus: status, retryAfterHeader }),
        }),
      };
    }

    // 2xx：进入协议解码
    const decoded = decodeEnvelope(response?.bodyText);
    if (!decoded.ok) {
      return {
        kind: 'outcome',
        outcome: this.#failure({
          failureKind: 'protocol_error',
          host,
          path,
          method,
          keyRef,
          tokenRef,
          status,
          reason: `${decoded.reason}（协议错误绝不判为业务成功）`,
          now,
          protocolErrorKind: decoded.protocolErrorKind,
          outcome: `protocol_error:${decoded.protocolErrorKind}`,
          network: makeResponseOutcome({ httpStatus: status, retryAfterHeader }),
        }),
      };
    }

    const businessKind = classifyBusiness(decoded.envelope, this.#opts.businessCodes);
    const evidence = buildEvidence({
      host,
      path,
      method,
      keyRef,
      tokenRef,
      status,
      outcome: `business:${businessKind}`,
      at: now,
    });
    assertEvidenceClean(evidence);
    return {
      kind: 'done',
      outcome: Object.freeze({
        delivered: true as const,
        ok: true as const,
        status,
        host,
        path,
        keyRef,
        tokenRef: tokenRef ?? '',
        businessKind,
        businessSuccess: businessKind === 'success',
        businessCode: decoded.envelope.code,
        data: decoded.envelope.data,
        envelope: decoded.envelope,
        evidence,
        network: makeResponseOutcome({
          httpStatus: status,
          businessCode: decoded.envelope.code,
          retryAfterHeader,
        }),
      }),
    };
  }

  #failure(input: {
    failureKind: TransportFailureKind;
    host: string;
    path: string;
    method: 'GET' | 'POST';
    keyRef: string;
    tokenRef: string | null;
    status: number | null;
    reason: string;
    now: number;
    protocolErrorKind?: 'empty_body' | 'malformed_json' | 'invalid_envelope' | null;
    outcome?: string;
    /**
     * 原始网络结果。**缺省 = `not_sent` + `before_send`**：所有走缺省的调用点都是
     * "根本没发出"的失败（策略拒绝 / 无会话 / 无凭证）。发出后的失败（HTTP / 协议 /
     * 网络故障）必须显式传入，避免把"可能已到达"误报成"未发出"。
     */
    network?: NetworkOutcome;
  }): TransportFailure {
    const evidence = buildEvidence({
      host: input.host,
      path: input.path,
      method: input.method,
      keyRef: input.keyRef,
      tokenRef: input.tokenRef,
      status: input.status,
      outcome: input.outcome ?? input.failureKind,
      at: input.now,
    });
    assertEvidenceClean(evidence);
    return Object.freeze({
      delivered: false as const,
      ok: false as const,
      failureKind: input.failureKind,
      status: input.status,
      host: input.host,
      path: input.path,
      keyRef: input.keyRef,
      tokenRef: input.tokenRef,
      protocolErrorKind: input.protocolErrorKind ?? null,
      reason: input.reason,
      evidence,
      network: input.network ?? makeNotSentOutcome(input.reason, 'before_send'),
    });
  }
}

/** 便捷构造。 */
export function createTransportClient(options: TransportClientOptions): TransportClient {
  return new TransportClient(options);
}
