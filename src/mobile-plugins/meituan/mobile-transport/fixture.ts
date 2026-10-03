/**
 * M02 —— 假端口（fixture）。**测试专用**：不接真实网络、不用真实凭证。
 *
 * 三个端口都有可控替身：
 * - {@link createFakeTransport}：按脚本回放响应 / 故障，并**只记录头形状、不记录头值**
 *   （Authorization 的值永不落盘，符合"APK/日志无明文"）。
 * - {@link createFakeCredentialResolver}：返回一段**测试占位材质**；它不是任何真实
 *   密钥，只用于证明"材质只在 RawTransportRequest 边界出现一次"。
 * - {@link createFakeMinter}：确定性铸造 `sessref:` 会话，令牌形如 `fake-token-N`。
 */

import { RawTransportFault } from './types.js';
import type {
  CredentialResolverPort,
  HttpMethod,
  MintedSession,
  NetworkErrorPhase,
  RawTransportFaultKind,
  RawTransportRequest,
  RawTransportResponse,
  SessionMinterPort,
  TransportCredential,
  TransportPort,
} from './types.js';

// ---------------------------------------------------------------------------
// 假传输端口
// ---------------------------------------------------------------------------

/** 一次被记录的调用（**无头值**）。 */
export interface RecordedCall {
  readonly method: HttpMethod;
  readonly host: string;
  readonly path: string;
  readonly bodyJson: string | null;
  readonly timeoutMs: number;
  readonly hasAuthorization: boolean;
  readonly authScheme: 'bearer' | 'none' | 'other';
}

/** 脚本步骤。 */
export type FakeStep =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly bodyText: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'fault';
      readonly fault: RawTransportFaultKind;
      /** `network_error` 时的阶段；缺省 `during_send`（保守＝可能已到达）。 */
      readonly phase?: NetworkErrorPhase;
    }
  | { readonly kind: 'handler'; readonly handle: (request: RawTransportRequest) => RawTransportResponse };

/** 假传输端口。 */
export interface FakeTransport extends TransportPort {
  /** 已记录的调用（每次读取返回快照副本；**无头值**）。 */
  readonly calls: readonly RecordedCall[];
  callCount(): number;
  /** 调用记录的序列化（供"记录里没有明文"断言）。 */
  dump(): string;
}

function authSchemeOf(headerValue: string | undefined): 'bearer' | 'none' | 'other' {
  if (headerValue === undefined) {
    return 'none';
  }
  return headerValue.startsWith('Bearer ') ? 'bearer' : 'other';
}

/** 构造按脚本回放的假传输端口。脚本用尽后抛出网络错误，避免静默空转。 */
export function createFakeTransport(steps: readonly FakeStep[]): FakeTransport {
  const queue: FakeStep[] = [...steps];
  const calls: RecordedCall[] = [];
  let index = 0;

  const transport: TransportPort = {
    async send(request: RawTransportRequest): Promise<RawTransportResponse> {
      const auth = request.headers['Authorization'];
      calls.push(
        Object.freeze({
          method: request.method,
          host: request.host,
          path: request.path,
          bodyJson: request.bodyJson,
          timeoutMs: request.timeoutMs,
          hasAuthorization: auth !== undefined && auth.length > 0,
          authScheme: authSchemeOf(auth),
        }),
      );
      const step = queue[index];
      index += 1;
      if (step === undefined) {
        throw new RawTransportFault('network_error', `假传输脚本已用尽（第 ${index} 次调用）`);
      }
      if (step.kind === 'fault') {
        throw new RawTransportFault(
          step.fault,
          `假故障：${step.fault}（phase=${step.phase ?? 'during_send'}）`,
          step.phase ?? 'during_send',
        );
      }
      if (step.kind === 'handler') {
        return step.handle(request);
      }
      return Object.freeze({
        status: step.status,
        headers: Object.freeze({ ...(step.headers ?? {}) }),
        bodyText: step.bodyText,
      });
    },
  };

  const api = {
    send: transport.send.bind(transport),
    get calls(): readonly RecordedCall[] {
      return Object.freeze([...calls]);
    },
    callCount(): number {
      return calls.length;
    },
    dump(): string {
      return JSON.stringify(calls);
    },
  };
  return Object.freeze(api) as FakeTransport;
}

/** 便捷：`{ code, message?, data? }` 的 2xx 响应。 */
export function jsonResponse(
  status: number,
  body: { readonly code: string; readonly message?: string; readonly data?: unknown },
): FakeStep {
  return { kind: 'respond', status, bodyText: JSON.stringify(body) };
}

/** 便捷：原样文本响应（用于构造非 JSON / 空 body）。 */
export function textResponse(status: number, bodyText: string): FakeStep {
  return { kind: 'respond', status, bodyText };
}

/** 便捷：空 body 的 2xx。 */
export function emptyResponse(status: number): FakeStep {
  return { kind: 'respond', status, bodyText: '' };
}

/** 便捷：网络故障步骤（缺省 `during_send`＝可能已到达）。 */
export function networkFault(phase: NetworkErrorPhase = 'during_send'): FakeStep {
  return { kind: 'fault', fault: 'network_error', phase };
}

/** 便捷：超时故障步骤。 */
export function timeoutFault(): FakeStep {
  return { kind: 'fault', fault: 'timeout' };
}

/** 便捷：离线故障步骤（本地网络不可用，**从未发出**）。 */
export function offlineFault(): FakeStep {
  return { kind: 'fault', fault: 'offline' };
}

/** 便捷：发出前失败（DNS / 连接建立 / TLS）——**可判定未到达平台**。 */
export function notSentFault(): FakeStep {
  return { kind: 'fault', fault: 'network_error', phase: 'before_send' };
}

// ---------------------------------------------------------------------------
// 假凭证解析端口（K03 替身）
// ---------------------------------------------------------------------------

/** 测试占位材质（**不是真实密钥**，仅用于验证边界行为）。 */
export const FAKE_CREDENTIAL_MATERIAL = 'plaintext-test-material-not-a-real-key';

/** 假凭证解析端口；`resolveCalls` 记录被请求的 keyRef 次数。 */
export interface FakeCredentialResolver extends CredentialResolverPort {
  resolveCount(): number;
  readonly resolvedKeyRefs: readonly string[];
}

export function createFakeCredentialResolver(
  options: { readonly material?: string; readonly fail?: boolean } = {},
): FakeCredentialResolver {
  const material = options.material ?? FAKE_CREDENTIAL_MATERIAL;
  const resolved: string[] = [];
  const api = {
    async resolve(keyRef: string): Promise<TransportCredential> {
      if (options.fail === true) {
        throw new Error('假凭证解析失败');
      }
      resolved.push(keyRef);
      return Object.freeze({ keyRef, material });
    },
    resolveCount(): number {
      return resolved.length;
    },
    get resolvedKeyRefs(): readonly string[] {
      return Object.freeze([...resolved]);
    },
  };
  return Object.freeze(api) as FakeCredentialResolver;
}

// ---------------------------------------------------------------------------
// 假会话铸造端口
// ---------------------------------------------------------------------------

/** 铸造脚本步骤：成功铸造 / 抛错。 */
export type MintStep =
  | {
      readonly kind: 'mint';
      readonly scopes: readonly string[];
      readonly ttlMs: number;
      readonly refreshable?: boolean;
      /** 缺省按序号生成 `sessref:s<N>-t<M>`。 */
      readonly tokenRef?: string;
    }
  | { readonly kind: 'fail'; readonly reason: string };

/** 假铸造端口。返回的令牌形如 `fake-token-<n>`，**不是真实令牌**。 */
export interface FakeMinter extends SessionMinterPort {
  mintCount(): number;
}

export function createFakeMinter(steps: readonly MintStep[]): FakeMinter {
  const queue: MintStep[] = [...steps];
  let index = 0;
  let mint = 0;
  return Object.freeze({
    async mint(input: {
      readonly keyRef: string;
      readonly accountRef: string;
      readonly credential: TransportCredential;
      readonly now: number;
      readonly previousTokenRef: string | null;
    }): Promise<MintedSession> {
      const step = queue[index];
      index += 1;
      if (step === undefined) {
        throw new Error(`假铸造脚本已用尽（第 ${index} 次 mint）`);
      }
      if (step.kind === 'fail') {
        throw new Error(`假铸造失败：${step.reason}`);
      }
      mint += 1;
      return Object.freeze({
        tokenRef: step.tokenRef ?? `sessref:s${index}-t${mint}`,
        token: `fake-token-${index}-${mint}`,
        scopes: Object.freeze([...step.scopes]),
        expiresAt: input.now + step.ttlMs,
        refreshable: step.refreshable !== false,
      });
    },
    mintCount(): number {
      return index;
    },
  });
}
