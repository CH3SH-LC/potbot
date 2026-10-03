/**
 * M-I25 / 正对照：**只有**"官方 host + 有可读正文"的探针能翻转目标，且**恰好**解锁
 * 对应的那一个工具。
 *
 * 这是失败关闭套件的反向控制——若诚实矩阵"永远全 blocked"只是因为桥接写死，那上面的
 * 负用例就是空的。这里证明桥接是**真的**：喂一条官方可读探针，目标真的会变 verified，
 * 对应的 M10 工具真的会 enabled，而其它工具**仍然** blocked。
 */

import { describe, expect, it } from 'vitest';

import {
  MEITUAN_CAPABILITIES,
  buildCapabilityMatrix,
  isCapabilityVerified,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import {
  enabledToolContracts,
  resolveExposedTools,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import {
  createEndpointPolicy,
  createEndpointPolicyFromDiscovery,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  CONFIRM_TOOL_ID,
  HYPOTHETICAL_ORDERING_HOSTS,
  NON_OFFICIAL_URL,
  OFFICIAL_READABLE_URL,
  TARGET_TOOLS,
  evidenceFor,
  featureMatrixFromDiscovery,
  officialReadableProbe,
  verifiedHostsFromDiscovery,
} from './support.js';

describe('M-I25 / 单个目标：官方+可读探针恰好解锁对应工具', () => {
  for (const { target, toolId } of TARGET_TOOLS) {
    it(`仅 ${target} 有官方可读证据 ⇒ 恰好解锁 ${toolId}`, () => {
      const probe = officialReadableProbe({ probeId: `p-${target}` });
      const matrix = buildCapabilityMatrix({
        probes: [probe],
        evidence: [evidenceFor(target, probe.probeId)],
      });

      // 目标真的翻成 verified（桥接不是写死全 blocked）。
      expect(isCapabilityVerified(matrix, target)).toBe(true);
      expect(matrix.allUnverified).toBe(false);
      for (const capability of MEITUAN_CAPABILITIES) {
        if (capability !== target) {
          expect(matrix.capabilities[capability].status).toBe('unverified');
        }
      }
      // 注意：此处**不**调用 `assertMatrixIntegrity`——M01 的该护栏对"部分 verified 矩阵"
      // 有已知缺陷（见 honesty.test.ts 的 defect tripwire 与 residuals）。

      const tools = resolveExposedTools(featureMatrixFromDiscovery(matrix));
      const enabled = tools
        .filter((tool) => tool.exposure === 'enabled')
        .map((tool) => tool.toolId)
        .sort();
      expect(enabled).toEqual([CONFIRM_TOOL_ID, toolId].sort());
      expect(enabledToolContracts(tools).map((contract) => contract.toolId).sort()).toEqual(
        [CONFIRM_TOOL_ID, toolId].sort(),
      );

      // 其它 scoped 工具仍然 blocked。
      for (const tool of tools) {
        if (tool.capability !== null && tool.capability !== target) {
          expect(tool.exposure).toBe('blocked');
          expect(tool.reason).toBe('scope_unverified');
        }
      }
    });
  }

  it('全部 8 个能力都有官方可读证据 ⇒ 7 个 scoped 工具 + 本地确认全部解锁（pay 无工具）', () => {
    const probe = officialReadableProbe({ probeId: 'p-all' });
    const matrix = buildCapabilityMatrix({
      probes: [probe],
      evidence: MEITUAN_CAPABILITIES.map((capability) => evidenceFor(capability, probe.probeId)),
    });

    expect(matrix.allUnverified).toBe(false);
    for (const capability of MEITUAN_CAPABILITIES) {
      expect(matrix.capabilities[capability].status).toBe('verified');
    }

    const tools = resolveExposedTools(featureMatrixFromDiscovery(matrix));
    const enabled = tools
      .filter((tool) => tool.exposure === 'enabled')
      .map((tool) => tool.toolId)
      .sort();
    const expected = [...TARGET_TOOLS.map((entry) => entry.toolId), CONFIRM_TOOL_ID].sort();
    expect(enabled).toEqual(expected);
    // pay 有 scope 但**没有**工具：工具集里不得出现挂在 pay 上的工具。
    expect(tools.every((tool) => tool.capability !== 'pay')).toBe(true);
    expect(tools.some((tool) => tool.toolId === 'cap.meituan.submitOrder')).toBe(true);
  });
});

describe('M-I25 / 单目标负对照：探针不满足"官方+可读"就不解锁', () => {
  const labelOf: readonly [string, () => ReturnType<typeof buildCapabilityMatrix>][] = [
    [
      '非官方可读探针',
      () => {
        const probe = officialReadableProbe({
          probeId: 'p-neg-nonofficial',
          url: NON_OFFICIAL_URL,
          officialHost: false,
        });
        return buildCapabilityMatrix({
          probes: [probe],
          evidence: [evidenceFor('submit', probe.probeId, NON_OFFICIAL_URL)],
        });
      },
    ],
    [
      '官方但无可读正文',
      () => {
        const probe = officialReadableProbe({ probeId: 'p-neg-blank', readableContent: false });
        return buildCapabilityMatrix({
          probes: [probe],
          evidence: [evidenceFor('submit', probe.probeId, probe.url)],
        });
      },
    ],
    [
      '证据引用不存在的探针',
      () =>
        buildCapabilityMatrix({
          probes: [officialReadableProbe({ probeId: 'p-present' })],
          evidence: [evidenceFor('submit', 'p-missing')],
        }),
    ],
    [
      '证据挂到 pay（有 scope 但无工具）',
      () =>
        buildCapabilityMatrix({
          probes: [officialReadableProbe({ probeId: 'p-other' })],
          evidence: [evidenceFor('pay', 'p-other')],
        }),
    ],
  ];

  for (const [label, build] of labelOf) {
    it(`${label} ⇒ submit 仍 unverified，submitOrder 仍 blocked`, () => {
      const matrix = build();
      expect(matrix.capabilities.submit.status).toBe('unverified');

      const tools = resolveExposedTools(featureMatrixFromDiscovery(matrix));
      const enabled = tools.filter((tool) => tool.exposure === 'enabled').map((tool) => tool.toolId);
      expect(enabled).toEqual([CONFIRM_TOOL_ID]);

      const submit = tools.find((tool) => tool.toolId === 'cap.meituan.submitOrder');
      expect(submit?.exposure).toBe('blocked');
      expect(submit?.reason).toBe('scope_unverified');
    });
  }
});

describe('M-I25 / 正对照下单 host 仍不被放行', () => {
  it('只核实一个读能力 ⇒ 派生策略只放行证据 host，不放行任何下单 host', () => {
    const probe = officialReadableProbe({ probeId: 'p-preview-only' });
    const matrix = buildCapabilityMatrix({
      probes: [probe],
      evidence: [evidenceFor('preview', probe.probeId)],
    });

    const hosts = verifiedHostsFromDiscovery(matrix);
    expect(hosts.map((entry) => entry.host)).toEqual(['developer.meituan.com']);

    const policy = createEndpointPolicyFromDiscovery([...hosts]);
    const evidenceHost = new URL(OFFICIAL_READABLE_URL).hostname.toLowerCase();
    expect(policy.isAllowed(evidenceHost)).toBe(true);

    for (const ordering of HYPOTHETICAL_ORDERING_HOSTS) {
      expect(policy.isAllowed(ordering), `下单 host ${ordering} 被误放行`).toBe(false);
    }
    // 精确匹配：后缀伪装也不放行。
    expect(createEndpointPolicy([evidenceHost]).isAllowed(`${evidenceHost}.evil.com`)).toBe(false);
  });
});
