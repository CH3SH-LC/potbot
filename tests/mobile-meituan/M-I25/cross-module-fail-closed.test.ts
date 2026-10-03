/**
 * M-I25 / 跨 M01→M10 与 M01→M02：诚实矩阵**失败关闭**。
 *
 * 把 M01 真实的"全 unverified"矩阵（`buildCapabilityMatrix()`，真实只读探针 + 零证据）
 * 分别喂给：
 *   - M10 `resolveExposedTools`（经 {@link featureMatrixFromDiscovery} 桥接）——
 *     断言 **没有任何 scoped/下单工具被解锁**；唯一 enabled 的是无 scope 的本地确认工具
 *     `cap.meituan.confirm`（它不发出任何外部写入，设计上不因 scope 被阻断）。
 *   - M02 `createEndpointPolicyFromDiscovery`（经 {@link verifiedHostsFromDiscovery} 桥接）——
 *     断言 **一个官方 host 都派生不出来**，空列表派生即抛错，绝不退化成"空 = 全放行"，
 *     因此**没有任何下单 host 被放行**。
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_DISCOVERY_BOUNDARY,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import {
  SCOPE_CAPABILITIES,
  enabledToolContracts,
  resolveExposedTools,
  validateCapabilityMatrix,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import {
  ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY,
  createEndpointPolicy,
  createEndpointPolicyFromDiscovery,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  CONFIRM_TOOL_ID,
  HYPOTHETICAL_ORDERING_HOSTS,
  TARGET_TOOLS,
  enabledToolIds,
  featureMatrixFromDiscovery,
  honestDiscoveryMatrix,
  verifiedHostsFromDiscovery,
} from './support.js';

describe('M-I25 / M01→M10：诚实矩阵不解锁任何 scoped 工具', () => {
  it('resolveExposedTools 只放行无 scope 的本地确认工具', () => {
    const tools = resolveExposedTools(featureMatrixFromDiscovery(honestDiscoveryMatrix()));

    // 唯一 enabled 的是本地 `cap.meituan.confirm`（capability === null）。
    expect(enabledToolIds(tools)).toEqual([CONFIRM_TOOL_ID]);
    expect(enabledToolContracts(tools).map((contract) => contract.toolId)).toEqual([CONFIRM_TOOL_ID]);

    for (const tool of tools) {
      if (tool.capability === null) {
        expect(tool.exposure).toBe('enabled');
        expect(tool.reason).toBe('no_scope_capability');
      } else {
        expect(tool.exposure, `工具 ${tool.toolId} 在诚实矩阵下竟然 enabled`).toBe('blocked');
        expect(tool.reason).toBe('scope_unverified');
      }
    }
  });

  it('每个 scope 能力对应的工具都被 scope_unverified 阻断', () => {
    const tools = resolveExposedTools(featureMatrixFromDiscovery(honestDiscoveryMatrix()));
    for (const { target, toolId } of TARGET_TOOLS) {
      const tool = tools.find((entry) => entry.toolId === toolId);
      expect(tool, `缺少工具 ${toolId}`).toBeDefined();
      if (tool !== undefined) {
        expect(tool.capability).toBe(target);
        expect(tool.exposure).toBe('blocked');
        expect(tool.reason).toBe('scope_unverified');
      }
    }
  });

  it('桥接矩阵通过 M10 自身的完整性校验（不是绕过形状）', () => {
    const featureMatrix = featureMatrixFromDiscovery(honestDiscoveryMatrix());
    expect(validateCapabilityMatrix(featureMatrix)).toEqual([]);
    for (const capability of SCOPE_CAPABILITIES) {
      expect(featureMatrix.verdicts[capability].availability).toBe('unverified');
      expect(featureMatrix.verdicts[capability].evidenceRef).toBeNull();
    }
  });
});

describe('M-I25 / M01→M02：诚实矩阵不放行任何 host', () => {
  it('未核实 ⇒ 派生不出任何官方 host（含无任何下单 host）', () => {
    const hosts = verifiedHostsFromDiscovery(honestDiscoveryMatrix());
    expect(hosts).toEqual([]);
    for (const ordering of HYPOTHETICAL_ORDERING_HOSTS) {
      expect(hosts.some((entry) => entry.host === ordering)).toBe(false);
    }
  });

  it('空列表派生即抛错，不退化成"空 = 全放行"', () => {
    const hosts = verifiedHostsFromDiscovery(honestDiscoveryMatrix());
    expect(() => createEndpointPolicyFromDiscovery([...hosts])).toThrow(TypeError);
    expect(() => createEndpointPolicy([])).toThrow(TypeError);
  });

  it('M02 声明的发现边界正是 M01 的失败关闭边界', () => {
    expect(CAPABILITY_DISCOVERY_BOUNDARY.failsClosedToUnverified).toBe(true);
    expect(CAPABILITY_DISCOVERY_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.source).toBe('capability-discovery');
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.failsClosedToUnverified).toBe(true);
    expect(ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY.connectsRealPlatform).toBe(false);
  });
});
