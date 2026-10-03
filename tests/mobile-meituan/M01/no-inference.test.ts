/**
 * M01：**禁止由 key 长度 / 包名推断权限**。
 *
 * 工作书明令"不凭 key 长度或非官方包名称推断权限，不默认为企业版或商家 API"。
 * 本用例把这条从口头约定变成机器可查：一旦产物里出现这类字段，护栏当场报出路径。
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_INFERENCE_SIGNALS,
  assertNoPermissionInference,
  buildCapabilityMatrix,
  findForbiddenInferenceSignals,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';

describe('M01 禁止凭证外形推断', () => {
  it('真实能力矩阵不含任何"由外形推断"的字段', () => {
    const matrix = buildCapabilityMatrix();
    expect(findForbiddenInferenceSignals(matrix)).toEqual([]);
    expect(() => assertNoPermissionInference(matrix)).not.toThrow();
  });

  it('扫出嵌套的违规字段并给出完整路径', () => {
    const dirty = {
      ok: true,
      credential: { keyLength: 64, nested: { packageName: 'com.example.mt' } },
      token_length: 32,
    };
    const hits = findForbiddenInferenceSignals(dirty);
    expect(hits).toContain('credential.keyLength');
    expect(hits).toContain('credential.nested.packageName');
    expect(hits).toContain('token_length');
  });

  it('数组元素里的违规字段也能定位到下标', () => {
    const hits = findForbiddenInferenceSignals({ list: [{ keySize: 16 }] });
    expect(hits).toContain('list[0].keySize');
  });

  it('含违规字段的矩阵会被 assertNoPermissionInference 拒绝', () => {
    const matrix = buildCapabilityMatrix() as unknown as Record<string, unknown>;
    const dirty = { ...matrix, keyType: 'enterprise' };
    expect(() => assertNoPermissionInference(dirty as never)).toThrow(/推断权限/);
  });

  it('信号词表覆盖 key 长度与包名两大类', () => {
    const lowered = FORBIDDEN_INFERENCE_SIGNALS.map((name) => name.toLowerCase());
    expect(lowered.some((name) => name.includes('keylength') || name.includes('keylength'))).toBe(true);
    expect(lowered.some((name) => name.includes('packagename'))).toBe(true);
  });
});
