/**
 * M-I02 测试夹具（不是被收集的用例文件）。
 *
 * 本单元是**集成切片**：把 M02 手机传输层接上
 *  - M-R04 需要的 `NetworkOutcome`（含 before_send / during_send 阶段 + Retry-After 原文）；
 *  - M01 能力发现的失败关闭边界（只在有已核实 host 时才允许构造端点策略）。
 *
 * 全部场景由**显式 fixture** 驱动：捕获式假传输端口、计数凭证解析、确定性铸造器。
 * 无网络、无真实凭证、无系统时间、无随机。官方 host 用 `.test` 保留域。
 *
 * 捕获式端口**记录完整请求头值**（含 Authorization）——这是"令牌只在该头出现"这条
 * 断言的唯一途径。记录只存在于测试进程内存，绝不落盘 / 打印；断言全部写成布尔，
 * 失败时不会把令牌值回显进测试输出。
 */

import {
  createBusinessCodeTable,
  createEndpointPolicy,
  RawTransportFault,
  SessionManager,
  TransportClient,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type {
  BusinessCodeTable,
  CredentialResolverPort,
  EndpointPolicy,
  NetworkErrorPhase,
  RawTransportFaultKind,
  RawTransportRequest,
  RawTransportResponse,
  SessionMinterPort,
  TransportClientOptions,
  TransportCredential,
  TransportPort,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

/** 逻辑时间起点（非零，用来暴露"偷偷按 0 起始"的错误）。 */
export const T0 = 1_700_000_000_000;

/** 假官方 host（**非真实域名**，`.test` 保留域）。 */
export const OFFICIAL_HOST = 'api.example-authorized.test';

/** 非授权 host。 */
export const UNAUTHORIZED_HOST = 'api.attacker.example';

/** 子域伪装：以官方 host 结尾，用于后缀匹配绕过测试。 */
export const SUFFIX_ATTACK_HOST = `evil.${OFFICIAL_HOST}`;

export const TEST_KEY_REF = 'keyref:meituan-demo-primary';
export const TEST_ACCOUNT_REF = 'acct:test-user';

/**
 * **合成**令牌：刻意做成 `sk-` 形状，好让脱敏扫描器能命中——它不是任何真实密钥，
 * 只是用来证明"令牌只在 Authorization 头出现、绝不进证据 / 结果 / 日志"。
 */
export const SYNTHETIC_TOKEN = 'sk-0123456789abcdef0123456789abcdef';

/** 官方授权策略（只放 OFFICIAL_HOST）。 */
export function officialPolicy(): EndpointPolicy {
  return createEndpointPolicy([OFFICIAL_HOST]);
}

/** 业务码表（fixture 口径：ok=成功，其余按登记）。 */
export function businessTable(): BusinessCodeTable {
  return createBusinessCodeTable([
    { code: 'ok', kind: 'success' },
    { code: 'sold_out', kind: 'business_failure' },
  ]);
}

// ---------------------------------------------------------------------------
// 捕获式传输端口（记录完整请求，供"令牌只在 Authorization 头"断言）
// ---------------------------------------------------------------------------

/** 被捕获的一次请求（**测试进程内存内**，含头值）。 */
export interface CapturedRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly bodyJson: string | null;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** 一次脚本化发送结果。 */
export type SendPlan =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly bodyText: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'fault'; readonly fault: RawTransportFaultKind; readonly phase?: NetworkErrorPhase };

/** 捕获式传输端口。 */
export interface CapturingTransport extends TransportPort {
  readonly requests: readonly CapturedRequest[];
  callCount(): number;
}

export function createCapturingTransport(plan: readonly SendPlan[]): CapturingTransport {
  const requests: CapturedRequest[] = [];
  let index = 0;
  return Object.freeze({
    async send(request: RawTransportRequest): Promise<RawTransportResponse> {
      requests.push(
        Object.freeze({
          method: request.method,
          host: request.host,
          path: request.path,
          bodyJson: request.bodyJson,
          timeoutMs: request.timeoutMs,
          headers: Object.freeze({ ...request.headers }),
        }),
      );
      const step = plan[index];
      index += 1;
      if (step === undefined) {
        throw new RawTransportFault('network_error', `捕获端口脚本已用尽（第 ${index} 次）`, 'during_send');
      }
      if (step.kind === 'fault') {
        throw new RawTransportFault(step.fault, `假故障：${step.fault}`, step.phase ?? 'during_send');
      }
      return Object.freeze({
        status: step.status,
        headers: Object.freeze({ ...(step.headers ?? {}) }),
        bodyText: step.bodyText,
      });
    },
    get requests(): readonly CapturedRequest[] {
      return Object.freeze([...requests]);
    },
    callCount(): number {
      return requests.length;
    },
  }) as CapturingTransport;
}

/** 便捷：JSON 响应步骤。 */
export function jsonStep(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): SendPlan {
  return { kind: 'respond', status, bodyText: JSON.stringify(body), headers };
}

/** 便捷：文本响应步骤。 */
export function textStep(status: number, bodyText: string, headers?: Readonly<Record<string, string>>): SendPlan {
  return { kind: 'respond', status, bodyText, headers };
}

// ---------------------------------------------------------------------------
// 计数凭证解析端口
// ---------------------------------------------------------------------------

export interface CountingResolver extends CredentialResolverPort {
  resolveCount(): number;
}

export function createCountingResolver(): CountingResolver {
  let count = 0;
  return Object.freeze({
    async resolve(keyRef: string): Promise<TransportCredential> {
      count += 1;
      return Object.freeze({ keyRef, material: 'test-material-not-a-real-key' });
    },
    resolveCount(): number {
      return count;
    },
  }) as CountingResolver;
}

// ---------------------------------------------------------------------------
// 确定性铸造器（令牌 = SYNTHETIC_TOKEN）
// ---------------------------------------------------------------------------

export function createTokenMinter(token: string = SYNTHETIC_TOKEN): SessionMinterPort {
  let n = 0;
  return Object.freeze({
    async mint(input: {
      readonly keyRef: string;
      readonly accountRef: string;
      readonly credential: TransportCredential;
      readonly now: number;
      readonly previousTokenRef: string | null;
    }) {
      n += 1;
      return Object.freeze({
        tokenRef: `sessref:mi02-t${n}`,
        token,
        scopes: Object.freeze(['meituan.query', 'meituan.order']),
        expiresAt: input.now + 60 * 60 * 1000,
        refreshable: true,
      });
    },
  }) as SessionMinterPort;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface BuiltClient {
  readonly client: TransportClient;
  readonly transport: CapturingTransport;
  readonly resolver: CountingResolver;
  readonly session: SessionManager;
}

export function buildClient(options: {
  readonly transport?: CapturingTransport;
  readonly policy?: EndpointPolicy;
  readonly token?: string;
  readonly defaultTimeoutMs?: number;
  readonly refreshOnAuthFailure?: boolean;
} = {}): BuiltClient {
  const transport = options.transport ?? createCapturingTransport([]);
  const resolver = createCountingResolver();
  const session = new SessionManager(createTokenMinter(options.token ?? SYNTHETIC_TOKEN));
  const client = new TransportClient({
    policy: options.policy ?? officialPolicy(),
    session,
    credentialResolver: resolver,
    transport,
    businessCodes: businessTable(),
    defaultTimeoutMs: options.defaultTimeoutMs ?? 10_000,
    refreshOnAuthFailure: options.refreshOnAuthFailure,
  } satisfies TransportClientOptions);
  return { client, transport, resolver, session };
}

/** 打开一个标准会话。 */
export async function openSession(session: SessionManager, now = T0): Promise<void> {
  await session.open({
    keyRef: TEST_KEY_REF,
    accountRef: TEST_ACCOUNT_REF,
    credential: { keyRef: TEST_KEY_REF, material: 'test-material-not-a-real-key' },
    now,
  });
}

/** 标准请求描述符。 */
export function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    keyRef: TEST_KEY_REF,
    method: 'POST' as const,
    host: OFFICIAL_HOST,
    path: '/v1/x',
    body: {},
    ...overrides,
  };
}
