/**
 * M-I01 (b)：**key 长度 / 包名 / 文件大小等外形信号不能翻转任何 target**。
 *
 * 工作书明令"不凭 key 长度或非官方包名称推断权限"。本用例把三类信号
 * （key 长度、包名、文件大小）一并钉死：它们既被信号词表捕获，也**不改变**
 * 消费者闸门的裁决——闸门只看 `'verified'`，而 `'verified'` 只能来自官方可读证据。
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_INFERENCE_SIGNALS,
  assertMatrixIntegrity,
  assertNoPermissionInference,
  assertNoUnverifiedUnlock,
  buildCapabilityMatrix,
  findForbiddenInferenceSignals,
  unlockVerdictOf,
  type CapabilityMatrix,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import { makeEvidence, makeProbe } from './support.js';

const lowered = (): readonly string[] => FORBIDDEN_INFERENCE_SIGNALS.map((n) => n.toLowerCase());

describe('M-I01 (b) 外形信号词表覆盖 key 长度 / 包名 / 文件大小', () => {
  it('词表同时含 key 长度、包名、文件大小三类', () => {
    const names = lowered();
    expect(names.some((n) => n.includes('keylength') || n.includes('keysize'))).toBe(true);
    expect(names.some((n) => n.includes('packagename'))).toBe(true);
    expect(names.some((n) => n.includes('filesize') || n.includes('filebytes'))).toBe(true);
  });

  it('三类信号都能被递归扫出并定位到路径', () => {
    const hits = findForbiddenInferenceSignals({
      credential: { keyLength: 64 },
      app: { packageName: 'com.example.mt' },
      blob: { fileSize: 2048 },
    });
    expect(hits).toContain('credential.keyLength');
    expect(hits).toContain('app.packageName');
    expect(hits).toContain('blob.fileSize');
  });

  it('矩阵被塞入外形信号字段 ⇒ assertMatrixIntegrity 抛错（无法据此放行）', () => {
    const matrix = buildCapabilityMatrix();
    const polluted = { ...matrix, evidenceSignals: { fileSize: 1024, keyLength: 32 } } as unknown as CapabilityMatrix;
    expect(() => assertNoPermissionInference(polluted)).toThrow(/推断权限/);
    expect(() => assertMatrixIntegrity(polluted)).toThrow();
  });
});

describe('M-I01 (b) 外形信号不翻转裁决', () => {
  it('凭证存在 + 外形字段齐全，任何能力都不会变成 verified', () => {
    // 诚实矩阵：探针官方但正文不可读 ⇒ 证据无效。
    const matrix = buildCapabilityMatrix({
      probes: [makeProbe({ probeId: 'shell', readableContent: false })],
      evidence: [makeEvidence('submit', 'shell')],
      credentialRef: {
        present: true,
        contentRead: false,
        note: '存在性：key 长度=64、包名=com.example.mt、文件大小=2048',
      },
    });
    // 即便 note 里写满外形特征，裁决仍是 unverified，闸门仍抛错。
    expect(unlockVerdictOf(matrix, 'submit')).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'submit')).toThrow();
  });

  it('核心构造器即便收到"官方可读"探针，也要求证据真挂在有效的探针上（不能靠外形伪造）', () => {
    // 仅凭 key 外形（无任何证据条目）⇒ 全部 unverified。
    const matrix = buildCapabilityMatrix({ evidence: [] });
    expect(unlockVerdictOf(matrix, 'search')).toBe('unverified');
    expect(() => assertNoUnverifiedUnlock(matrix, 'search')).toThrow();
  });
});
