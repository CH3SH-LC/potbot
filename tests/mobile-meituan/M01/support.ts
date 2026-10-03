/**
 * M01 测试夹具（不是被收集的用例文件）。
 *
 * 这里的 `makeProbe` 造的是**假设**探针，只用于验证"构造器在面对不同证据时如何裁决"，
 * **不是**声称那些页面真的存在。真实证据在 `src/.../capability-discovery/evidence.ts`。
 */

import type {
  CapabilityEvidence,
  DiscoveryTarget,
  EvidenceProbe,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';

/** 造一条探针（默认：官方、可读，便于验证"只有这种探针才可能支撑 verified"）。 */
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
    conclusion: '假设探针：用于验证构造器裁决，不代表真实页面。',
    ...overrides,
  });
}

/** 一条把 target 挂到指定探针上的证据。 */
export function makeEvidence(
  target: DiscoveryTarget,
  probeId: string,
  overrides: Partial<CapabilityEvidence> = {},
): CapabilityEvidence {
  return Object.freeze({
    target,
    probeId,
    evidenceUrl: 'https://developer.meituan.com/zh/v2/dev/token',
    note: '假设证据：仅用于构造器裁决测试。',
    ...overrides,
  });
}

/** 非官方 host 的探针。 */
export const NON_OFFICIAL_URL = 'https://third-party-blog.example.com/meituan/api';

/** 一个明显是"手机号"形状的串（**不是**真实号码，随机数，仅用于脱敏扫描用例）。 */
export const FAKE_PHONE_SAMPLE = '19900000000';

/** 一个明显是"hex token"形状的串（**不是**真实密钥，全 0，仅用于脱敏扫描用例）。 */
export const FAKE_HEX_TOKEN_SAMPLE = '0'.repeat(48);
