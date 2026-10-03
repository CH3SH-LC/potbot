/**
 * M-I01：下游消费者契约 —— `assertNoUnverifiedUnlock` 的**失败关闭**与互操作。
 *
 * 对应 M01 集成请求 #2/#3：M02（transport 选型）与 M10（工具暴露）不应各自重新推导
 * "未登录 ⇒ 无法判定能力"，而应 import 本包的边界类型与放行闸门。
 *
 * 断言（a）(d)：
 *   (a) `verified` **同时**需要"官方 host"且"正文可读"的证据，缺一即 `unverified`；
 *   (b) 由外形信号（key 长度/包名/文件大小）不能翻转任何 target（见 no-inference-unlock）；
 *   (c) 非官方页面不具证据资格；
 *   (d) 在诚实的全 unverified 矩阵上，闸门对每个 target 都失败关闭。
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_DISCOVERY_BOUNDARY,
  DISCOVERY_TARGETS,
  MEITUAN_CAPABILITIES,
  assertNoUnverifiedUnlock,
  buildCapabilityMatrix,
  unlockVerdictOf,
  unlockedTargets,
  type CapabilityDiscoveryBoundary,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import { makeEvidence, makeProbe, m10Matrix, NON_OFFICIAL_URL } from './support.js';

describe('M-I01 (a) verified 必须同时具备官方 host 与可读正文', () => {
  it('官方 + 可读 ⇒ verified，闸门放行', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe()],
      evidence: [makeEvidence('search', 'probe-official-readable')],
    });
    expect(matrix.capabilities.search.status).toBe('verified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'search')).not.toThrow();
    expect(unlockVerdictOf(matrix, 'search')).toBe('verified');
  });

  it('官方但正文不可读（空壳/登录墙）⇒ 仍 unverified，闸门抛错', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'shell', readableContent: false })],
      evidence: [makeEvidence('search', 'shell')],
    });
    expect(matrix.capabilities.search.status).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'search')).toThrow(/失败关闭|unverified/);
  });

  it('正文可读但非官方 host ⇒ 仍 unverified，闸门抛错', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'blog', url: NON_OFFICIAL_URL, officialHost: false })],
      evidence: [makeEvidence('menu', 'blog', { evidenceUrl: NON_OFFICIAL_URL })],
    });
    expect(matrix.capabilities.menu.status).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'menu')).toThrow();
  });

  it('证据引用的探针不存在 ⇒ 仍 unverified，闸门抛错', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'other' })],
      evidence: [makeEvidence('address', 'nonexistent')],
    });
    expect(matrix.capabilities.address.status).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'address')).toThrow();
  });
});

describe('M-I01 (c) 非官方页面不构成证据', () => {
  it('非官方页即便给出了 endpoint 文本，也不改变任何 target 结论', () => {
    const matrix = buildCapabilityMatrix({
      probes: [
        makeProbe({
          probeId: 'third-party',
          url: NON_OFFICIAL_URL,
          officialHost: false,
          observedText: 'endpoint /v1/order/submit scope=order.submit',
        }),
      ],
      evidence: [
        makeEvidence('submit', 'third-party', { evidenceUrl: NON_OFFICIAL_URL }),
        makeEvidence('pay', 'third-party', { evidenceUrl: NON_OFFICIAL_URL }),
      ],
    });
    expect(matrix.capabilities.submit.status).toBe('unverified');
    expect(matrix.capabilities.pay.status).toBe('unverified');
    expect(unlockVerdictOf(matrix, 'submit')).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'submit')).toThrow();
    expect(() => assertNoUnverifiedUnlock(matrix, 'pay')).toThrow();
  });
});

describe('M-I01 (d) 诚实全 unverified 矩阵上逐项失败关闭', () => {
  it('默认矩阵（本批真实结论）对全部 10 个 target 都抛错', () => {
    const matrix = buildCapabilityMatrix();
    expect(matrix.allUnverified).toBe(true);
    for (const target of DISCOVERY_TARGETS) {
      expect(unlockVerdictOf(matrix, target)).toBe('unverified');
      expect(() => assertNoUnverifiedUnlock(matrix, target)).toThrow();
    }
    // 没有任何 target 被放行。
    expect(unlockedTargets(matrix, DISCOVERY_TARGETS)).toEqual([]);
  });

  it('仅凭凭证"存在"不放行任何能力（外形不构成证据）', () => {
    const withCredential = buildCapabilityMatrix({
      evidence: [],
      credentialRef: { present: true, contentRead: false, note: '仅存在性' },
    });
    for (const capability of MEITUAN_CAPABILITIES) {
      expect(() => assertNoUnverifiedUnlock(withCredential, capability)).toThrow();
    }
  });

  it('不可识别的来源形状 ⇒ 抛错（不默认放行）', () => {
    expect(unlockVerdictOf({ nothing: true }, 'search')).toBe('missing');
    expect(() => assertNoUnverifiedUnlock({} as never, 'search' as never)).toThrow();
  });

  it('未知裁决词被归一化为不可放行', () => {
    const weird = m10Matrix({ search: { availability: 'probably-fine' } });
    expect(unlockVerdictOf(weird, 'search')).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(weird, 'search')).toThrow();
  });
});

describe('M-I01 M10 风格矩阵 / 自备取裁决函数互操作', () => {
  it('M10 全 unverified 矩阵 ⇒ 抛错；verified ⇒ 放行；denied ⇒ 抛错；缺项 ⇒ 抛错', () => {
    const unverified = m10Matrix({ search: { availability: 'unverified' } });
    expect(() => assertNoUnverifiedUnlock(unverified, 'search')).toThrow();

    const verified = m10Matrix({ search: { availability: 'verified' } });
    expect(() => assertNoUnverifiedUnlock(verified, 'search')).not.toThrow();
    expect(unlockVerdictOf(verified, 'search')).toBe('verified');

    const denied = m10Matrix({ pay: { availability: 'denied' } });
    expect(() => assertNoUnverifiedUnlock(denied, 'pay')).toThrow();

    const missing = m10Matrix({});
    expect(unlockVerdictOf(missing, 'submit')).toBe('missing');
    expect(() => assertNoUnverifiedUnlock(missing, 'submit')).toThrow();
  });

  it('自备取裁决函数：只有返回 verified 才放行', () => {
    const verdicts: Record<string, string | null> = { search: 'verified', menu: 'unverified', pay: null };
    const resolve = (target: string): string | null => verdicts[target] ?? null;
    expect(() => assertNoUnverifiedUnlock(resolve, 'search')).not.toThrow();
    expect(() => assertNoUnverifiedUnlock(resolve, 'menu')).toThrow();
    expect(() => assertNoUnverifiedUnlock(resolve, 'pay')).toThrow();
    expect(unlockedTargets(resolve, ['search', 'menu', 'pay'])).toEqual(['search']);
  });
});

describe('M-I01 边界常量与类型（DEVFORCED）', () => {
  it('CapabilityDiscoveryBoundary 类型的值与运行期常量一致，且恒为只读不变量', () => {
    const boundary: CapabilityDiscoveryBoundary = CAPABILITY_DISCOVERY_BOUNDARY;
    expect(boundary.transmitsCredentials).toBe(false);
    expect(boundary.makesAuthenticatedRequests).toBe(false);
    expect(boundary.submitsOrders).toBe(false);
    expect(boundary.connectsRealPlatform).toBe(false);
    expect(boundary.failsClosedToUnverified).toBe(true);
  });
});
