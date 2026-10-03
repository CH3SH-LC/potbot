/**
 * M-I25 / M01 诚实矩阵：逐项 unverified，且**任何外形信号**都不能把它翻成 verified。
 *
 * 这一条是美团线的诚信不变量：key 长度、包名、文件大小、协议猜测都**不是**证据。
 * 本用例既验证"真实只读矩阵全 unverified"，也逐个注入违规推断字段，证明：
 *   1. 注入后所有目标仍 unverified（信号不进裁决）；
 *   2. 完整性护栏 `assertMatrixIntegrity` **抛出**（信号被识别为违规）。
 */

import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_TARGETS,
  FORBIDDEN_INFERENCE_SIGNALS,
  MEITUAN_CAPABILITIES,
  RECORDED_PROBES,
  assertMatrixIntegrity,
  buildCapabilityMatrix,
  findForbiddenInferenceSignals,
  isCapabilityVerified,
  isOfficialMeituanHost,
  unverifiedTargets,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import {
  SCOPE_CAPABILITIES,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';

import {
  NON_OFFICIAL_URL,
  credentialRefWithSignal,
  evidenceFor,
  featureMatrixFromDiscovery,
  honestDiscoveryMatrix,
  officialReadableProbe,
} from './support.js';

describe('M-I25 / M01 诚实矩阵全 unverified', () => {
  it('真实只读矩阵：10 个目标全部 unverified，allUnverified 一致，完整性通过', () => {
    const matrix = honestDiscoveryMatrix();

    expect(matrix.allUnverified).toBe(true);
    expect(unverifiedTargets(matrix)).toHaveLength(DISCOVERY_TARGETS.length);

    expect(matrix.protocol.status).toBe('unverified');
    expect(matrix.protocol.kind).toBe('unknown');
    expect(matrix.mobileDirectConnectAllowed.status).toBe('unverified');

    for (const capability of MEITUAN_CAPABILITIES) {
      expect(matrix.capabilities[capability].status).toBe('unverified');
      expect(isCapabilityVerified(matrix, capability)).toBe(false);
    }

    for (const target of DISCOVERY_TARGETS) {
      if (target === 'protocol') {
        expect(matrix.protocol.status).toBe('unverified');
      } else if (target === 'mobileDirectConnectAllowed') {
        expect(matrix.mobileDirectConnectAllowed.status).toBe('unverified');
      } else {
        expect(matrix.capabilities[target].status).toBe('unverified');
      }
    }

    // 只读不变量 + 无违规推断字段 + 无敏感串。
    expect(() => assertMatrixIntegrity(matrix)).not.toThrow();
  });

  it('凭证"存在"不构成任何能力的证据（present=true 但逐项仍 unverified）', () => {
    const matrix = honestDiscoveryMatrix();
    expect(matrix.credentialRef?.present).toBe(true);
    expect(matrix.credentialRef?.contentRead).toBe(false);
    for (const capability of MEITUAN_CAPABILITIES) {
      expect(matrix.capabilities[capability].status).toBe('unverified');
    }
  });

  it('真实探针的 officialHost 布尔与 isOfficialMeituanHost(url) 一致（不靠手填）', () => {
    for (const probe of RECORDED_PROBES) {
      expect(probe.officialHost).toBe(isOfficialMeituanHost(probe.url));
    }
  });
});

describe('M-I25 / 外形信号不能翻转任何目标', () => {
  it('单独一个 keyLength 字段仍不能让任何目标 verified', () => {
    const matrix = buildCapabilityMatrix({ credentialRef: credentialRefWithSignal('keyLength', 64) });
    expect(matrix.allUnverified).toBe(true);
    for (const capability of MEITUAN_CAPABILITIES) {
      expect(matrix.capabilities[capability].status).toBe('unverified');
    }
  });

  for (const signal of FORBIDDEN_INFERENCE_SIGNALS) {
    it(`违规推断字段 ${signal}：目标仍 unverified，且被完整性护栏拦下`, () => {
      const matrix = buildCapabilityMatrix({ credentialRef: credentialRefWithSignal(signal, 4096) });

      for (const target of DISCOVERY_TARGETS) {
        const status =
          target === 'protocol'
            ? matrix.protocol.status
            : target === 'mobileDirectConnectAllowed'
              ? matrix.mobileDirectConnectAllowed.status
              : matrix.capabilities[target].status;
        expect(status, `目标 ${target} 被外形信号 ${signal} 翻转了`).toBe('unverified');
      }

      const hits = findForbiddenInferenceSignals(matrix);
      expect(hits).toContain(`credentialRef.${signal}`);
      expect(() => assertMatrixIntegrity(matrix)).toThrow();
    });
  }

  it('注入信号后经 M01→M10 桥接仍全 unverified（解锁不了任何 scoped 工具）', () => {
    const signalMatrix = buildCapabilityMatrix({
      credentialRef: credentialRefWithSignal('packageName', 'com.example.not-meituan'),
    });
    const featureMatrix = featureMatrixFromDiscovery(signalMatrix);
    for (const capability of SCOPE_CAPABILITIES) {
      expect(featureMatrix.verdicts[capability].availability).toBe('unverified');
      expect(featureMatrix.verdicts[capability].evidenceRef).toBeNull();
    }
  });

  it('非官方可读探针 + fileSize 信号：目标仍 unverified（非官方页面没有证据资格）', () => {
    const probe = officialReadableProbe({
      probeId: 'p-non-official-readable',
      url: NON_OFFICIAL_URL,
      officialHost: false,
    });
    const matrix = buildCapabilityMatrix({
      probes: [probe],
      evidence: [evidenceFor('submit', probe.probeId, NON_OFFICIAL_URL)],
      credentialRef: credentialRefWithSignal('fileSize', 999_999),
    });

    expect(matrix.capabilities.submit.status).toBe('unverified');
    expect(matrix.allUnverified).toBe(true);
  });

  it('官方但无正文的探针：目标仍 unverified（空壳页/登录墙不算读过）', () => {
    const probe = officialReadableProbe({ probeId: 'p-official-blank', readableContent: false });
    const matrix = buildCapabilityMatrix({
      probes: [probe],
      evidence: [evidenceFor('search', probe.probeId, probe.url)],
    });

    expect(matrix.capabilities.search.status).toBe('unverified');
    expect(matrix.allUnverified).toBe(true);
  });
});

describe('M-I25 / 已知 M01 缺陷 tripwire（不在本单元写区，见 residuals）', () => {
  it('assertMatrixIntegrity 对"部分 verified"的合法矩阵误报不一致（当前行为）', () => {
    // 构造一个**内部自洽**的部分核实矩阵：仅 search 有官方可读证据。
    const probe = officialReadableProbe({ probeId: 'p-partial' });
    const matrix = buildCapabilityMatrix({
      probes: [probe],
      evidence: [evidenceFor('search', probe.probeId)],
    });

    // 逐项结论本身自洽：其余 9 个目标仍 unverified，allUnverified=false。
    expect(matrix.allUnverified).toBe(false);
    expect(unverifiedTargets(matrix)).toHaveLength(DISCOVERY_TARGETS.length - 1);

    // 缺陷：`guard.ts:189` 用 `remaining > 0` 当作 allUnverified 的期望值，
    // 而 `allUnverified` 的语义是"**所有**目标仍 unverified"（应为 `remaining === 总数`）。
    // 于是这个完全合法的矩阵被判为"不一致"并抛错。src 不在本单元写区，故只做行为记录；
    // M01 修复后本 tripwire 应变红，届时改为 `expect(...).not.toThrow()` 并删除本用例。
    expect(() => assertMatrixIntegrity(matrix)).toThrow(/不一致/);
  });
});
