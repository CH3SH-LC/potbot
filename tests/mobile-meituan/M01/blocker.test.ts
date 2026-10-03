/**
 * M01：阻塞报告必须**精确**——卡在什么、需要用户做什么、影响谁、谁不受影响。
 */

import { describe, expect, it } from 'vitest';

import {
  buildBlockedOnAuthorizationReport,
  buildCapabilityMatrix,
  isOfficialMeituanHost,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import { makeEvidence, makeProbe } from './support.js';

describe('M01 阻塞报告', () => {
  it('默认矩阵 ⇒ blocked=true，10 个目标全未核实', () => {
    const report = buildBlockedOnAuthorizationReport(buildCapabilityMatrix());
    expect(report.blocked).toBe(true);
    expect(report.unverifiedTargets.length).toBe(10);
  });

  it('证据 URL 全部指向官方页面，且与探针一一对应', () => {
    const matrix = buildCapabilityMatrix();
    const report = buildBlockedOnAuthorizationReport(matrix);
    expect(report.evidenceProbeIds.length).toBe(matrix.probes.length);
    expect(report.evidenceUrls.length).toBe(matrix.probes.length);
    for (const url of report.evidenceUrls) {
      expect(isOfficialMeituanHost(url)).toBe(true);
    }
  });

  it('needFromUser 逐条可执行，并要求脱敏、不得贴出密钥值', () => {
    const report = buildBlockedOnAuthorizationReport(buildCapabilityMatrix());
    expect(report.needFromUser.length).toBeGreaterThanOrEqual(3);
    expect(report.needFromUser.join('\n')).toMatch(/脱敏/);
    expect(report.needFromUser.join('\n')).toMatch(/手机端直连|手机直连/);
  });

  it('影响范围只到 M01/M02，且明确其余包不被阻塞', () => {
    const report = buildBlockedOnAuthorizationReport(buildCapabilityMatrix());
    expect(report.impact).toMatch(/M0[12]/);
    expect(report.notBlocking).toMatch(/M03|五线/);
  });

  it('仍有任一目标未核实 ⇒ blocked 保持 true', () => {
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'p', readableContent: true })],
      evidence: [makeEvidence('search', 'p')],
    });
    const report = buildBlockedOnAuthorizationReport(matrix);
    expect(report.blocked).toBe(true);
    expect(report.unverifiedTargets).not.toContain('search');
    expect(report.unverifiedTargets.length).toBe(9);
  });
});
