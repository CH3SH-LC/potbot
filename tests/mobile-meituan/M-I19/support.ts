/**
 * M-I19 测试夹具（不是被收集的用例文件）。
 *
 * 全部场景由**显式 fixture** 驱动：确定性逻辑时钟、合成脱敏引用。无网络、无真实凭证、
 * 无系统时间、无随机。官方 host 一律用 `.test` 保留域。
 *
 * `unverifiedMatrix` / `SCOPE_CAPABILITIES` **读自** M10 `mobile-feature`（只读 import），
 * 用来把「M01 的诚实默认（全部 unverified）无法签发真机凭证」这条纪律变成真接口的断言，
 * 而不是本测试自造的近似。
 */

import {
  SCOPE_CAPABILITIES,
  unverifiedMatrix,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import type {
  AttestationCapabilityMatrix,
  AttestationCapabilityVerdict,
  CapabilityAvailability,
  CapabilityMatrixInput,
  OnDeviceDeliveredTransport,
  OnDeviceTransportFact,
} from '../../../src/mobile-plugins/meituan/transport-attestation/index.js';

/** 逻辑时间起点（非零，用来暴露"偷偷按 0 起算"的错误）。 */
export const T0 = 1_700_000_000_000;

/** 合成脱敏引用（不含序列号 / 手机号 / 令牌明文）。 */
export const DEVICE_REF = 'device:honor-fixture-hash';
export const OFFICIAL_HOST = 'api.authorized.test';
export const EVIDENCE_REF = 'net-receipt:fixture-0001';

/**
 * 造一个能力矩阵：未在 `overrides` 中指定的能力一律 `unverified`（诚实默认）。
 * `verified` 带证据引用；`unverified` / `denied` 的引用恒为 `null`。
 */
export function matrixFrom(
  overrides: Partial<Record<string, CapabilityAvailability>> = {},
): AttestationCapabilityMatrix {
  const verdicts: Record<string, AttestationCapabilityVerdict> = {};
  for (const capability of SCOPE_CAPABILITIES) {
    const availability: CapabilityAvailability = overrides[capability] ?? 'unverified';
    verdicts[capability] = Object.freeze({
      capability,
      availability,
      evidenceRef: availability === 'verified' ? `ev-m01-${capability}` : null,
      detail: `fixture matrix: ${capability}=${availability}`,
    });
  }
  return Object.freeze({ verdicts: Object.freeze(verdicts) });
}

/** 只允许一项能力 verified（其余 unverified），用于"有证据即可签发"的正向用例。 */
export function oneVerified(capability = 'search'): AttestationCapabilityMatrix {
  return matrixFrom({ [capability]: 'verified' });
}

/** 全部 denied（没有任何 verified）——同样不得签发。 */
export function deniedOnly(): AttestationCapabilityMatrix {
  const overrides: Partial<Record<string, CapabilityAvailability>> = {};
  for (const capability of SCOPE_CAPABILITIES) overrides[capability] = 'denied';
  return matrixFrom(overrides);
}

/** 标 verified 却**没有**证据引用：无证据不得声明可用 ⇒ 不计数。 */
export function verifiedWithoutEvidence(): AttestationCapabilityMatrix {
  return Object.freeze({
    verdicts: Object.freeze({
      search: Object.freeze({
        capability: 'search',
        availability: 'verified' as const,
        evidenceRef: null,
      }),
    }),
  });
}

/**
 * M01 的诚实默认矩阵（读自 M10 真实现 `unverifiedMatrix()`）。
 *
 * 返回类型故意写成签发器接受的 `CapabilityMatrixInput`：这条赋值能在 tsc 下通过，
 * 正是"任意 M10 `CapabilityMatrix` 可**原样**注入本 seam，无需 as"的编译期证据。
 */
export function honestDefaultMatrix(): CapabilityMatrixInput {
  return unverifiedMatrix();
}

/** 一份标准真机传输事实（脱敏引用）。 */
export function transportFact(overrides: Partial<OnDeviceTransportFact> = {}): OnDeviceTransportFact {
  return {
    deviceRef: DEVICE_REF,
    requestHostRef: `host:${OFFICIAL_HOST}`,
    transportEvidenceRef: EVIDENCE_REF,
    observedAt: T0,
    ...overrides,
  };
}

/** 结构兼容 M02 `TransportDelivered` 的已送达结果（脱敏自证）。 */
export function deliveredTransport(
  overrides: Partial<OnDeviceDeliveredTransport> = {},
): OnDeviceDeliveredTransport {
  return {
    delivered: true,
    ok: true,
    host: OFFICIAL_HOST,
    evidence: { host: OFFICIAL_HOST, redacted: true, plaintextSecretFields: 0 },
    ...overrides,
  };
}

/** 捕获一个同步抛错并返回其错误码（不做静默吞错）。 */
export function catchError(fn: () => unknown): { name: string; code: string | undefined; message: string } {
  try {
    fn();
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string };
    return { name: err.name ?? 'Error', code: err.code, message: err.message ?? '' };
  }
  throw new Error('期望抛错，但没有抛错');
}

export { unverifiedMatrix };
