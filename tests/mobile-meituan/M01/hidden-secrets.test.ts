/**
 * M01：脱敏扫描——产物里**不得**出现密钥/手机号形状的串。
 *
 * 关键点：扫描器**只报种类与位置，绝不回显命中的串**（否则扫描本身就成了泄漏渠道）。
 * 这里的"假密钥/假号码"是构造出来的哨兵，不是任何真实凭据。
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoSecretsInMatrix,
  buildCapabilityMatrix,
  findSecretLikeStrings,
  type CapabilityMatrix,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import { FAKE_HEX_TOKEN_SAMPLE, FAKE_PHONE_SAMPLE } from './support.js';

describe('M01 脱敏：扫描器本身不泄漏', () => {
  it('识别 hex token 形状，且结果里不含命中串', () => {
    const findings = findSecretLikeStrings(`prefix ${FAKE_HEX_TOKEN_SAMPLE} suffix`);
    expect(findings.length).toBe(1);
    expect(findings[0]?.kind).toBe('hex-token');
    expect(findings[0]?.length).toBe(FAKE_HEX_TOKEN_SAMPLE.length);
    expect(JSON.stringify(findings)).not.toContain(FAKE_HEX_TOKEN_SAMPLE);
  });

  it('识别 base64 形状（含非 hex 字符）', () => {
    const base64ish = `${'A'.repeat(47)}z`;
    const findings = findSecretLikeStrings(base64ish);
    expect(findings.some((finding) => finding.kind === 'base64-token')).toBe(true);
  });

  it('识别手机号形状', () => {
    const findings = findSecretLikeStrings(`联系电话 ${FAKE_PHONE_SAMPLE} 谢谢`);
    expect(findings.some((finding) => finding.kind === 'phone-number')).toBe(true);
  });

  it('干净文本不误报', () => {
    expect(findSecretLikeStrings('美团技术服务合作中心 https://developer.meituan.com/zh/v2/dev/token')).toEqual([]);
  });
});

describe('M01 脱敏：真实能力矩阵不含敏感串', () => {
  it('默认构造的矩阵通过脱敏检查', () => {
    const matrix = buildCapabilityMatrix();
    expect(() => assertNoSecretsInMatrix(matrix)).not.toThrow();
    expect(findSecretLikeStrings(JSON.stringify(matrix))).toEqual([]);
  });

  it('一旦凭证引用里被塞入 token 形状的串，立即被拒绝', () => {
    const dirty = {
      ...buildCapabilityMatrix(),
      credentialRef: {
        present: true,
        contentRead: false as const,
        note: `key=${FAKE_HEX_TOKEN_SAMPLE}`,
      },
    } as CapabilityMatrix;
    expect(() => assertNoSecretsInMatrix(dirty)).toThrow(/疑似敏感串/);
  });

  it('抛错信息不回显命中内容', () => {
    const dirty = {
      ...buildCapabilityMatrix(),
      credentialRef: { present: true, contentRead: false as const, note: FAKE_HEX_TOKEN_SAMPLE },
    } as CapabilityMatrix;
    let message = '';
    try {
      assertNoSecretsInMatrix(dirty);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('疑似敏感串');
    expect(message).not.toContain(FAKE_HEX_TOKEN_SAMPLE);
  });
});
