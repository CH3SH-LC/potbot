/**
 * M-I24 测试夹具（不是被收集的用例文件）。
 *
 * 本单元是**凭证隔离 ↔ 传输脱敏的端到端集成切片**：把
 *  - M-R05 / M-I14 的凭证库 `CredentialVault`（只发 `keyRef` 引用、绝不收明文），
 * 经一个桥接 `CredentialResolverPort`（`createVaultCredentialResolver`）接到
 *  - M02 / M-I02 的 `TransportClient`（官方 host 白名单 / 会话 / 协议 / 业务四段）。
 *
 * 断言主题是「APK/日志无明文」在**模块层**成立：
 *  - 桥上只放行已授权 keyRef；撤销 / 过期 / 跨账号一律拒绝（材料不流到端口）；
 *  - 传输端口只记录请求头的**形状**（是否有 Authorization / 方案），从不记录值；
 *  - 明文形 keyRef 被拒且不回显；非官方 host 在端口调用前即拒（零调用）。
 *
 * 全部由显式 fixture 驱动：进程内凭证库、假传输端口、确定性逻辑时钟。无网络、
 * 无真实凭证、无系统时间、无随机。官方 host 用 `.test` 保留域。
 *
 * ## 关于 `SECRET_SHAPED` / `SYNTHETIC_MATERIAL` / `SYNTHETIC_TOKEN`
 *
 * 三者都是**形状像凭据的假值**（含 DO-NOT-LOG 标记），**不是任何真实密钥**，
 * 只存在于测试面（K-R04 密钥泄露审计明确排除测试树）。用它们证明"值到不了
 * 日志 / 证据 / 结果"。生产源码面刻意不含任何 `sk-` 形状字面量。
 */

import { CredentialError, CredentialVault } from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  ACCOUNT_A,
  INSTALL_1,
  KEY_A,
  SCOPE_READ,
  T0,
  TTL_MS,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import type {
  CredentialProvider,
  DenyReason,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  createBusinessCodeTable,
  createEndpointPolicy,
  createFakeTransport,
  jsonResponse,
  SessionManager,
  TransportClient,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type {
  BusinessCodeTable,
  CredentialResolverPort,
  EndpointPolicy,
  FakeStep,
  FakeTransport,
  RawTransportResponse,
  SessionMinterPort,
  TransportClientOptions,
  TransportCredential,
  TransportDelivered,
  TransportFailure,
  TransportOutcome,
  TransportRequestDescriptor,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

/** 逻辑时间起点（非零，用来暴露"偷偷按 0 起算"的错误）。 */
export { T0, TTL_MS, ACCOUNT_A, KEY_A, SCOPE_READ };

/** 假官方 host（**非真实域名**，`.test` 保留域）。 */
export const OFFICIAL_HOST = 'api.example-authorized.test';

/** 非授权 host。 */
export const UNAUTHORIZED_HOST = 'api.attacker.example';

/** 子域伪装：以官方 host 结尾，用于后缀匹配绕过测试（精确匹配才放行）。 */
export const SUFFIX_ATTACK_HOST = `evil.${OFFICIAL_HOST}`;

/**
 * 形状像真实凭据的假字符串（不匹配 `keyref:`），**不是**真实密钥。
 * 用于证明：误把明文当 keyRef 传入时，既不通过、也不进入错误消息 / 审计 / 记录。
 */
export const SECRET_SHAPED = 'sk-live-DO-NOT-LOG-0123456789abcdef';

/**
 * 合成凭证材质（`sk-` 形状，**非真实密钥**）。桥接解析成功后返回给传输层，
 * 只在 mint 的入参里出现；用来证明"材质不会落进端口记录 / 结果 / 证据"。
 */
export const SYNTHETIC_MATERIAL = 'sk-material-DO-NOT-LOG-0123456789abcdef';

/**
 * 合成会话令牌（`sk-` 形状，**非真实密钥**）。这是真正进入 `Authorization` 头的
 * 秘密；用来证明"端口只记形状、不记值"。
 */
export const SYNTHETIC_TOKEN = 'sk-session-DO-NOT-LOG-0123456789abcdef';

// ---------------------------------------------------------------------------
// 桥接：凭证库 keyRef ⇒ 传输层 CredentialResolverPort
// ---------------------------------------------------------------------------

/** 解析时读取的上下文（可变更，供"换账号"场景在传输路径上复现）。 */
export interface ResolverContext {
  accountRef: string;
  now: number;
}

/** 桥接解析端口：成功返回材质，失败抛错（传输层据此判 `credential_missing`）。 */
export interface VaultCredentialResolver extends CredentialResolverPort {
  resolveCount(): number;
  denyCount(): number;
  lastDenyReason(): DenyReason | null;
  /** 桥接成功放行的 keyRef（引用，允许跨日志）。 */
  resolvedKeyRefs(): readonly string[];
}

/**
 * 把凭证库的授权判定接到传输层的凭证解析端口上。
 *
 * `resolve(keyRef)` 每次都用当前逻辑时钟向 {@link CredentialVault.authorize} 重新
 * 判定；被拒（撤销 / 过期 / 未知 / 跨账号 / 用途不符 / 明文形状）时**抛错**，
 * 传输层把它映射为 `credential_missing`（发出前失败，零端口调用）。
 * 通过时只返回 `{ keyRef, material }`，keyRef 是与库中一致的引用。
 */
export function createVaultCredentialResolver(options: {
  readonly vault: CredentialVault;
  readonly context: ResolverContext;
  readonly provider: CredentialProvider;
  readonly requiredScope: string;
  readonly material?: string;
}): VaultCredentialResolver {
  const material = options.material ?? SYNTHETIC_MATERIAL;
  let count = 0;
  let denied = 0;
  let lastReason: DenyReason | null = null;
  const refs: string[] = [];
  const api = {
    async resolve(keyRef: string): Promise<TransportCredential> {
      count += 1;
      const decision = options.vault.authorize({
        keyRef,
        accountRef: options.context.accountRef,
        provider: options.provider,
        requiredScope: options.requiredScope,
        now: options.context.now,
      });
      if (!decision.allowed) {
        denied += 1;
        lastReason = decision.reason;
        // 只带原因码；即便 keyRef 是明文，也不回显原值。
        throw new CredentialError(
          'credential_not_authorized',
          `凭证库拒绝（${decision.reason}）：桥接不返回材料`,
        );
      }
      refs.push(keyRef);
      return Object.freeze({ keyRef, material });
    },
    resolveCount: (): number => count,
    denyCount: (): number => denied,
    lastDenyReason: (): DenyReason | null => lastReason,
    resolvedKeyRefs: (): readonly string[] => Object.freeze([...refs]),
  };
  return Object.freeze(api) as VaultCredentialResolver;
}

// ---------------------------------------------------------------------------
// 合成会话铸造器（令牌 = SYNTHETIC_TOKEN）
// ---------------------------------------------------------------------------

export interface SyntheticMinterOptions {
  readonly token?: string;
  readonly ttlMs?: number;
  readonly scopes?: readonly string[];
  readonly refreshable?: boolean;
}

/** 确定性铸造器：返回可控令牌（默认 `SYNTHETIC_TOKEN`），便于断言"值不落记录"。 */
export function createSyntheticMinter(options: SyntheticMinterOptions = {}): SessionMinterPort {
  const token = options.token ?? SYNTHETIC_TOKEN;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const scopes = options.scopes ?? [SCOPE_READ];
  const refreshable = options.refreshable ?? true;
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
        tokenRef: `sessref:mi24-t${n}`,
        token,
        scopes: Object.freeze([...scopes]),
        expiresAt: input.now + ttlMs,
        refreshable,
      });
    },
  }) as SessionMinterPort;
}

// ---------------------------------------------------------------------------
// 策略 / 码表 / 场景
// ---------------------------------------------------------------------------

/** 官方授权策略（只放 OFFICIAL_HOST）。 */
export function officialPolicy(): EndpointPolicy {
  return createEndpointPolicy([OFFICIAL_HOST]);
}

/** 业务码表（fixture 口径：ok=成功，sold_out=业务失败，其余 unknown）。 */
export function businessTable(): BusinessCodeTable {
  return createBusinessCodeTable([
    { code: 'ok', kind: 'success' },
    { code: 'sold_out', kind: 'business_failure' },
  ]);
}

/** 默认脚本：一次 2xx 成功信封。 */
export const DEFAULT_STEPS: readonly FakeStep[] = Object.freeze([
  jsonResponse(200, { code: 'ok', data: { ok: true } }),
]);

/** 造一个已选 ACCOUNT_A + 已导入 KEY_A 的凭证库。 */
export function makeVault(options: {
  readonly keyRef?: string;
  readonly accountRef?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
} = {}): CredentialVault {
  const accountRef = options.accountRef ?? ACCOUNT_A;
  const vault = new CredentialVault({ installId: INSTALL_1 });
  vault.switchAccount(accountRef, T0);
  vault.importCredential({
    keyRef: options.keyRef ?? KEY_A,
    accountRef,
    provider: 'meituan',
    scopes: [SCOPE_READ],
    issuedAt: options.issuedAt ?? T0,
    expiresAt: options.expiresAt ?? T0 + TTL_MS,
  });
  return vault;
}

// ---------------------------------------------------------------------------
// 组装：凭证库 → 桥接解析 → 传输客户端 + 假端口
// ---------------------------------------------------------------------------

export interface BuiltStack {
  readonly vault: CredentialVault;
  readonly client: TransportClient;
  readonly transport: FakeTransport;
  readonly resolver: VaultCredentialResolver;
  readonly session: SessionManager;
  readonly context: ResolverContext;
}

export function buildStack(options: {
  readonly vault?: CredentialVault;
  readonly steps?: readonly FakeStep[];
  readonly policy?: EndpointPolicy;
  readonly context?: ResolverContext;
  readonly provider?: CredentialProvider;
  readonly requiredScope?: string;
  readonly sessionTtlMs?: number;
  readonly token?: string;
  readonly material?: string;
} = {}): BuiltStack {
  const vault = options.vault ?? makeVault();
  const context: ResolverContext = options.context ?? { accountRef: ACCOUNT_A, now: T0 + 1 };
  const transport = createFakeTransport(options.steps ?? DEFAULT_STEPS);
  const session = new SessionManager(
    createSyntheticMinter({ token: options.token, ttlMs: options.sessionTtlMs ?? TTL_MS }),
  );
  const resolver = createVaultCredentialResolver({
    vault,
    context,
    provider: options.provider ?? 'meituan',
    requiredScope: options.requiredScope ?? SCOPE_READ,
    material: options.material,
  });
  const client = new TransportClient({
    policy: options.policy ?? officialPolicy(),
    session,
    credentialResolver: resolver,
    transport,
    businessCodes: businessTable(),
    defaultTimeoutMs: 10_000,
  } satisfies TransportClientOptions);
  return { vault, client, transport, resolver, session, context };
}

/** 打开一个标准会话（会话引用的 keyRef / accountRef 与库中 KEY_A 一致）。 */
export async function openStackSession(stack: BuiltStack, now = T0): Promise<void> {
  await stack.session.open({
    keyRef: KEY_A,
    accountRef: ACCOUNT_A,
    credential: Object.freeze({ keyRef: KEY_A, material: SYNTHETIC_MATERIAL }),
    now,
  });
}

/** 标准请求描述符（默认指向官方 host）。 */
export function descriptor(overrides: Partial<TransportRequestDescriptor> = {}): TransportRequestDescriptor {
  return {
    keyRef: KEY_A,
    method: 'POST',
    host: OFFICIAL_HOST,
    path: '/v1/catalog',
    body: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 断言结果未送达并收窄类型（失败时抛错，不用非空断言）。 */
export function expectFailure(outcome: TransportOutcome): TransportFailure {
  if (outcome.delivered) {
    throw new Error('预期失败（delivered:false），但结果为已送达');
  }
  return outcome;
}

/** 断言结果已送达并收窄类型。 */
export function expectDelivered(outcome: TransportOutcome): TransportDelivered {
  if (!outcome.delivered) {
    throw new Error('预期已送达（delivered:true），但结果为失败');
  }
  return outcome;
}

/** 深度收集对象图里所有字符串（用于断言"秘密没有出现"）。 */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
  return out;
}

/** 一次网络响应步骤（供 handler 探针构造返回）。 */
export function plainResponse(status: number, body: unknown): RawTransportResponse {
  return { status, headers: {}, bodyText: JSON.stringify(body) };
}
