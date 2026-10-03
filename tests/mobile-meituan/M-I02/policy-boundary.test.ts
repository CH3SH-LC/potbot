/**
 * M-I02 ②：端点白名单 + 消费 M01 能力发现的失败关闭边界。
 *
 * 两条结构性纪律：
 * 1. **空 allowlist 构建即抛错**（杜绝"空 = 全放行"）；
 * 2. 官方 host 只能来自 M01 的**已核实**结论——未核实的 host 在类型层面传不进来，
 *    本包**永不预置**未核实 host；一个已核实 host 都没有时，派生结果为空 ⇒ 抛错。
 *
 * 以及"非官方 host 在**任何端口调用之前**被拒"这一条（`callCount()===0`）。
 */

import { describe, expect, it } from 'vitest';

import { CAPABILITY_DISCOVERY_BOUNDARY } from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import {
  ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY,
  MOBILE_TRANSPORT_BOUNDARY,
  createEndpointPolicy,
  createEndpointPolicyFromDiscovery,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  OFFICIAL_HOST,
  SUFFIX_ATTACK_HOST,
  T0,
  UNAUTHORIZED_HOST,
  buildClient,
  createCapturingTransport,
  descriptor,
} from './support.js';

describe('M-I02 端点策略：空 allowlist 抛错', () => {
  it('createEndpointPolicy([]) / 全空白项 构建即抛错', () => {
    expect(() => createEndpointPolicy([])).toThrow(TypeError);
    expect(() => createEndpointPolicy(['', '  '])).toThrow(TypeError);
  });

  it('精确匹配 host，后缀伪装不放行', () => {
    const policy = createEndpointPolicy([OFFICIAL_HOST]);
    expect(policy.isAllowed(OFFICIAL_HOST)).toBe(true);
    expect(policy.isAllowed(OFFICIAL_HOST.toUpperCase())).toBe(true);
    expect(policy.isAllowed(SUFFIX_ATTACK_HOST)).toBe(false);
    expect(policy.isAllowed(UNAUTHORIZED_HOST)).toBe(false);
    expect(policy.isAllowed('')).toBe(false);
  });
});

describe('M-I02 消费 M01 能力发现边界：失败关闭，永不预置未核实 host', () => {
  it('无任何已核实 host ⇒ 派生即抛错（不退化成全放行）', () => {
    expect(() => createEndpointPolicyFromDiscovery([])).toThrow(TypeError);
  });

  it('已核实 host ⇒ 正常放行；后缀伪装仍被拒', () => {
    const policy = createEndpointPolicyFromDiscovery([{ host: OFFICIAL_HOST, status: 'verified' }]);
    expect(policy.isAllowed(OFFICIAL_HOST)).toBe(true);
    expect(policy.isAllowed(SUFFIX_ATTACK_HOST)).toBe(false);
  });

  it('未核实 host 在类型层面无法传入（结构性保证，tsc 钉住）', () => {
    // @ts-expect-error status 必须是字面量 'verified'：'unverified' 的 host 不得预置进白名单
    const attempt = () => createEndpointPolicyFromDiscovery([{ host: OFFICIAL_HOST, status: 'unverified' }]);
    void attempt;
    expect(typeof attempt).toBe('function');
  });

  it('派生函数读取并声明所消费的 discovery 失败关闭边界', () => {
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.source).toBe('capability-discovery');
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.failsClosedToUnverified).toBe(
      CAPABILITY_DISCOVERY_BOUNDARY.failsClosedToUnverified,
    );
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.failsClosedToUnverified).toBe(true);
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.connectsRealPlatform).toBe(false);
  });

  it('传输层边界常量声明已消费 discovery 边界、不预置未核实 host', () => {
    expect(MOBILE_TRANSPORT_BOUNDARY.consumesCapabilityDiscoveryBoundary).toBe(true);
    expect(MOBILE_TRANSPORT_BOUNDARY.preSeedsUnverifiedHosts).toBe(false);
  });
});

describe('M-I02 非官方 host：任何端口调用之前被拒', () => {
  for (const [label, host] of [
    ['非授权 host', UNAUTHORIZED_HOST],
    ['后缀伪装 host', SUFFIX_ATTACK_HOST],
  ] as const) {
    it(`${label} ⇒ endpoint_not_allowed 且 transport.callCount()===0、凭证未解析`, async () => {
      const transport = createCapturingTransport([]);
      const { client, resolver } = buildClient({ transport });
      const outcome = await client.invoke(descriptor({ host }), T0);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failureKind).toBe('endpoint_not_allowed');
      }
      expect(transport.callCount()).toBe(0);
      expect(resolver.resolveCount()).toBe(0);
    });
  }

  it('由 discovery 派生的策略，非官方 host 同样零调用', async () => {
    const policy = createEndpointPolicyFromDiscovery([{ host: OFFICIAL_HOST, status: 'verified' }]);
    const transport = createCapturingTransport([]);
    const { client } = buildClient({ transport, policy });
    const outcome = await client.invoke(descriptor({ host: UNAUTHORIZED_HOST }), T0);
    expect(outcome.ok).toBe(false);
    expect(transport.callCount()).toBe(0);
  });
});
