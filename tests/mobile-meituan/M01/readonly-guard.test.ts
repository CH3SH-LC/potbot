/**
 * M01：发现阶段**只读**——认证、发凭证、下单、支付一律越界。
 *
 * 用词表 + 抛错把边界钉死：即使将来有人给发现流程"顺手"接上一个登录或下单动作，
 * 也会在 `assertReadOnlyDiscovery` 处当场失败。
 */

import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_ALLOWED_ACTIONS,
  DISCOVERY_FORBIDDEN_ACTIONS,
  assertMatrixIntegrity,
  assertReadOnlyDiscovery,
  buildCapabilityMatrix,
  type CapabilityMatrix,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';

describe('M01 只读护栏：动作词表', () => {
  it('允许的四个动作全部放行', () => {
    for (const action of DISCOVERY_ALLOWED_ACTIONS) {
      expect(() => assertReadOnlyDiscovery(action)).not.toThrow();
    }
  });

  it('禁止的七类动作全部抛错', () => {
    for (const action of DISCOVERY_FORBIDDEN_ACTIONS) {
      expect(() => assertReadOnlyDiscovery(action)).toThrow(/只读/);
    }
  });

  it('未知动作失败关闭', () => {
    expect(() => assertReadOnlyDiscovery('do-something-unlisted')).toThrow(/只读/);
  });

  it('允许与禁止两个词表不相交', () => {
    const allowed = new Set(DISCOVERY_ALLOWED_ACTIONS as readonly string[]);
    for (const action of DISCOVERY_FORBIDDEN_ACTIONS) {
      expect(allowed.has(action)).toBe(false);
    }
  });
});

describe('M01 只读护栏：矩阵不变量', () => {
  it('默认矩阵通过完整性校验', () => {
    expect(() => assertMatrixIntegrity(buildCapabilityMatrix())).not.toThrow();
  });

  it('被篡改成"已发送凭证"的矩阵被拒绝', () => {
    const tampered = { ...buildCapabilityMatrix(), credentialTransmitted: true } as unknown as CapabilityMatrix;
    expect(() => assertMatrixIntegrity(tampered)).toThrow(/只读不变量/);
  });

  it('allUnverified 与逐项结论不一致时被拒绝', () => {
    const tampered = { ...buildCapabilityMatrix(), allUnverified: false } as CapabilityMatrix;
    expect(() => assertMatrixIntegrity(tampered)).toThrow(/不一致/);
  });
});
