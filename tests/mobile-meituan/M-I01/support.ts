/**
 * M-I01 测试夹具（不是被收集的用例文件）。
 *
 * 这里造的探针/证据都是**假设**，只用于验证"消费者面在任何输入下都失败关闭"，
 * 不代表真实页面。真实证据在 `src/.../capability-discovery/evidence.ts`。
 */

import type {
  CapabilityEvidence,
  DiscoveryTarget,
  EvidenceProbe,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';

/** 造一条探针。默认：官方 host 且正文可读（唯一可能支撑 verified 的组合）。 */
export function makeProbe(overrides: Partial<EvidenceProbe> = {}): EvidenceProbe {
  return Object.freeze({
    probeId: 'probe-official-readable',
    url: 'https://developer.meituan.com/zh/v2/dev/token',
    officialHost: true,
    method: 'unauthenticated-readonly-fetch' as const,
    reachable: true,
    readableContent: true,
    observedTitle: '美团技术服务合作中心',
    observedText: 'search endpoint /v1/search scope=order.submit',
    conclusion: '假设探针：用于裁决测试，不代表真实页面。',
    ...overrides,
  });
}

/** 把 target 挂到指定探针上的证据。 */
export function makeEvidence(
  target: DiscoveryTarget,
  probeId: string,
  overrides: Partial<CapabilityEvidence> = {},
): CapabilityEvidence {
  return Object.freeze({
    target,
    probeId,
    evidenceUrl: 'https://developer.meituan.com/zh/v2/dev/token',
    note: '假设证据：仅用于裁决测试。',
    ...overrides,
  });
}

/** 非官方 host 的 URL。 */
export const NON_OFFICIAL_URL = 'https://third-party-blog.example.com/meituan/api';

/**
 * 一个 M10（mobile-feature）风格的矩阵：`verdicts[target].availability`。
 * 只包含被显式覆盖的 target；缺项即"无结论"（消费者面应视为不可放行）。
 */
export function m10Matrix(
  overrides: Record<string, { availability: string }> = {},
): { verdicts: Record<string, { availability: string }> } {
  return { verdicts: { ...overrides } };
}
