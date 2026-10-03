/**
 * M01 能力矩阵：**失败关闭**（无证据 ⇒ unverified）。
 *
 * 断言的是语义，而不是照抄默认输出：
 *   - 不给证据时，八个能力 + 协议 + 手机直连**全部** unverified；
 *   - `verified` **只**可能来自"官方 host 且可读正文"的探针；
 *   - 三条降级路径（探针不存在 / 非官方 / 正文不可读）各自给出可读原因；
 *   - 凭证"存在"这一事实**不得**改变任何能力结论。
 */

import { describe, expect, it } from 'vitest';

import {
  MEITUAN_CAPABILITIES,
  buildCapabilityMatrix,
  isCapabilityVerified,
  unverifiedTargets,
  type CapabilityEvidence,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import { makeEvidence, makeProbe, NON_OFFICIAL_URL } from './support.js';

describe('M01 能力矩阵：无证据 ⇒ 全 unverified', () => {
  it('默认构造（不给任何证据）时八个能力全部 unverified', () => {
    const matrix = buildCapabilityMatrix({ evidence: [] });
    for (const capability of MEITUAN_CAPABILITIES) {
      expect(matrix.capabilities[capability].status).toBe('unverified');
      expect(matrix.capabilities[capability].evidenceUrl).toBeNull();
    }
    expect(matrix.allUnverified).toBe(true);
  });

  it('协议与手机直连同样默认 unverified，且协议类型为 unknown', () => {
    const matrix = buildCapabilityMatrix({ evidence: [] });
    expect(matrix.protocol.status).toBe('unverified');
    expect(matrix.protocol.kind).toBe('unknown');
    expect(matrix.mobileDirectConnectAllowed.status).toBe('unverified');
    expect(matrix.mobileDirectConnectAllowed.evidenceUrl).toBeNull();
  });

  it('unverifiedTargets 恰为 10 个目标，顺序与 DISCOVERY_TARGETS 一致', () => {
    const matrix = buildCapabilityMatrix({ evidence: [] });
    expect(unverifiedTargets(matrix)).toEqual([
      'search',
      'menu',
      'address',
      'preview',
      'submit',
      'pay',
      'query',
      'cancel',
      'protocol',
      'mobileDirectConnectAllowed',
    ]);
  });
});

describe('M01 能力矩阵：只有官方可读证据才能支撑 verified', () => {
  it('官方且可读的探针 ⇒ 该能力 verified，其余仍 unverified', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe()],
      evidence: [makeEvidence('search', 'probe-official-readable')],
    });
    expect(isCapabilityVerified(matrix, 'search')).toBe(true);
    expect(matrix.capabilities.search.evidenceUrl).toBe('https://developer.meituan.com/zh/v2/dev/token');
    expect(isCapabilityVerified(matrix, 'submit')).toBe(false);
    expect(matrix.allUnverified).toBe(false);
    expect(unverifiedTargets(matrix)).not.toContain('search');
    expect(unverifiedTargets(matrix)).toContain('submit');
  });

  it('证据引用的探针不存在 ⇒ 降级 unverified 且说明原因', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'other' })],
      evidence: [makeEvidence('menu', 'nonexistent-probe')],
    });
    expect(matrix.capabilities.menu.status).toBe('unverified');
    expect(matrix.capabilities.menu.note).toContain('不存在');
    expect(matrix.capabilities.menu.evidenceUrl).toBeNull();
  });

  it('证据来源非官方 host ⇒ 降级 unverified（非官方页面无证据资格）', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'p3rd', url: NON_OFFICIAL_URL, officialHost: false })],
      evidence: [makeEvidence('address', 'p3rd', { evidenceUrl: NON_OFFICIAL_URL })],
    });
    expect(matrix.capabilities.address.status).toBe('unverified');
    expect(matrix.capabilities.address.note).toContain('非官方');
    expect(matrix.capabilities.address.evidenceUrl).toBeNull();
  });

  it('官方但正文不可读（空壳/登录墙）⇒ 降级 unverified', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'shell', readableContent: false })],
      evidence: [makeEvidence('submit', 'shell')],
    });
    expect(matrix.capabilities.submit.status).toBe('unverified');
    expect(matrix.capabilities.submit.note).toContain('无可读正文');
    expect(matrix.capabilities.submit.evidenceUrl).toBeNull();
  });
});

describe('M01 能力矩阵：凭证存在性不影响结论', () => {
  it('传入"凭证存在"的引用，八能力结论不变（不凭外形推断权限）', () => {
    const base = buildCapabilityMatrix({ evidence: [] });
    const withCredential = buildCapabilityMatrix({
      evidence: [],
      credentialRef: { present: true, contentRead: false, note: '凭证存在（仅存在性）' },
    });
    expect(withCredential.credentialRef?.present).toBe(true);
    expect(unverifiedTargets(withCredential)).toEqual(unverifiedTargets(base));
    expect(withCredential.allUnverified).toBe(true);
  });

  it('三条只读不变量在类型与运行期都恒为 false', () => {
    const matrix = buildCapabilityMatrix({ evidence: [] });
    expect(matrix.credentialTransmitted).toBe(false);
    expect(matrix.authenticatedRequestMade).toBe(false);
    expect(matrix.orderOrPaymentSubmitted).toBe(false);
  });
});
