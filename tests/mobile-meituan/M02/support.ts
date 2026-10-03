/**
 * M02 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景由**显式 fixture** 驱动：假传输端口、假凭证解析、假会话铸造。没有网络、
 * 没有真实凭证、没有系统时间、没有随机。
 *
 * 官方 host 使用**明显的假域名** `api.example-authorized.test`：真实 host 由 M01
 * 核实，本测试不把任何猜测当官方。
 */

import {
  createBusinessCodeTable,
  createEndpointPolicy,
  createFakeCredentialResolver,
  createFakeMinter,
  createFakeTransport,
  emptyResponse,
  jsonResponse,
  networkFault,
  SessionManager,
  textResponse,
  timeoutFault,
  TransportClient,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type {
  BusinessCodeTable,
  EndpointPolicy,
  FakeCredentialResolver,
  FakeMinter,
  FakeTransport,
  MintStep,
  TransportClientOptions,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

/** 逻辑时间起点（非零，用来暴露"偷偷按 0 起始"的错误）。 */
export const T0 = 1_700_000_000_000;

/** 假官方 host（**非真实域名**，`.test` 保留域）。 */
export const OFFICIAL_HOST = 'api.example-authorized.test';

/** 非授权 host（子域伪装：以官方 host 结尾，用于后缀匹配绕过测试）。 */
export const SUFFIX_ATTACK_HOST = `evil.${OFFICIAL_HOST}`;

/** 另一个非授权 host。 */
export const UNAUTHORIZED_HOST = 'api.attacker.example';

export const TEST_KEY_REF = 'keyref:meituan-demo-primary';
export const TEST_ACCOUNT_REF = 'acct:test-user';

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

/** 标准会话铸造脚本：1 次换会话 + 1 次刷新。 */
export function standardMintSteps(): readonly MintStep[] {
  return [
    { kind: 'mint', scopes: ['meituan.query', 'meituan.order'], ttlMs: 60 * 60 * 1000, refreshable: true },
    { kind: 'mint', scopes: ['meituan.query', 'meituan.order'], ttlMs: 60 * 60 * 1000, refreshable: true },
  ];
}

export interface BuiltClient {
  readonly client: TransportClient;
  readonly transport: FakeTransport;
  readonly resolver: FakeCredentialResolver;
  readonly minter: FakeMinter;
  readonly session: SessionManager;
}

/** 组装一个完整注入链的客户端（默认：官方策略 + 标准码表 + 假端口）。 */
export function buildClient(
  overrides: Partial<TransportClientOptions> & {
    readonly mintSteps?: readonly MintStep[];
    readonly resolverFail?: boolean;
  } = {},
): BuiltClient {
  const transport = createFakeTransport([]);
  const resolver = createFakeCredentialResolver({ fail: overrides.resolverFail === true });
  const minter = createFakeMinter(overrides.mintSteps ?? standardMintSteps());
  const session = new SessionManager(minter);
  const client = new TransportClient({
    policy: overrides.policy ?? officialPolicy(),
    session,
    credentialResolver: overrides.credentialResolver ?? resolver,
    transport: overrides.transport ?? transport,
    businessCodes: overrides.businessCodes ?? businessTable(),
    defaultTimeoutMs: overrides.defaultTimeoutMs ?? 10_000,
    refreshOnAuthFailure: overrides.refreshOnAuthFailure,
  });
  return { client, transport, resolver, minter, session };
}

export {
  createEndpointPolicy,
  createBusinessCodeTable,
  createFakeCredentialResolver,
  createFakeMinter,
  createFakeTransport,
  emptyResponse,
  jsonResponse,
  networkFault,
  textResponse,
  timeoutFault,
  SessionManager,
  TransportClient,
};
