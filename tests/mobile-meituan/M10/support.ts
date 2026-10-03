/**
 * M10 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景由**显式 fixture** 驱动：可控时钟 + 脚本化报价/提交/查询端口。
 * 这里没有真实美团接口、没有网络、没有系统时间。
 */

import {
  SCOPE_CAPABILITIES,
  issueRealTransportAttestation,
  unverifiedMatrix,
  type CapabilityMatrix,
  type RealTransportAttestation,
  type ScopeAvailability,
  type ScopeCapability,
  type ScopeVerdict,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';

/** 逻辑时间起点（非零，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 1_700_000_000_000;

export const JOURNEY_ID = 'journey-m10-1';

/**
 * 造一个能力矩阵：未在 `overrides` 中指定的能力一律 `unverified`（诚实默认）。
 * `verified` 会带上证据引用，`unverified` 的引用恒为 `null`（否则校验器会拒）。
 */
export function matrixFrom(
  overrides: Partial<Record<ScopeCapability, ScopeAvailability>> = {},
): CapabilityMatrix {
  const verdicts = {} as Record<ScopeCapability, ScopeVerdict>;
  for (const capability of SCOPE_CAPABILITIES) {
    const availability: ScopeAvailability = overrides[capability] ?? 'unverified';
    verdicts[capability] = Object.freeze({
      capability,
      availability,
      evidenceRef: availability === 'verified' ? `ev-m01-${capability}` : null,
      detail: `fixture matrix: ${capability}=${availability}`,
    });
  }
  return Object.freeze({ verdicts: Object.freeze(verdicts) });
}

/**
 * 签发一枚**已登记**的可信真机传输凭证（脱敏引用；不含设备序列号 / 手机号 / 密钥）。
 *
 * `createRealFeatureHost` 的当前契约要求配置里必须携带它；本测试用它模拟 M-I19 / M02 的
 * 真机凭证生产者，从而走通「真机宿主构造」这条路径。
 */
export function realAttestation(): RealTransportAttestation {
  return issueRealTransportAttestation(
    {
      verificationMode: 'real',
      deviceRef: 'device:honor-m10-test',
      requestHostRef: 'host:api.meituan.example',
      transportEvidenceRef: 'net-receipt-m10',
      observedAt: T0,
    },
    T0,
  );
}

/** 全部核实为可用的矩阵（用于正例：工具应当全部 enabled）。 */
export function fullyVerifiedMatrix(): CapabilityMatrix {
  const overrides: Partial<Record<ScopeCapability, ScopeAvailability>> = {};
  for (const capability of SCOPE_CAPABILITIES) {
    overrides[capability] = 'verified';
  }
  return matrixFrom(overrides);
}

export { unverifiedMatrix };
