/**
 * M10 manifest 与生产启用闸门。
 */

import { describe, expect, it } from 'vitest';

import {
  assertNotProductionManifest,
  assertProductionActivation,
  buildMeituanFeatureManifest,
  checkProductionActivation,
  validateFeatureManifest,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';

describe('M10 manifest 形状（四态不得合并）', () => {
  it('默认构建（fixture）通过形状校验', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: false });
    expect(validateFeatureManifest(manifest)).toEqual([]);
  });

  it('根对象出现合并字段 ready ⇒ 拒（additionalProperties:false）', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: false });
    const merged = { ...manifest, ready: true };
    const problems = validateFeatureManifest(merged);
    expect(problems.some((p) => p.includes('ready'))).toBe(true);
  });

  it('probe 里把某态写成裸非布尔 ⇒ 拒（四态必须分别上报）', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: false });
    const broken = { ...manifest, probe: { ...manifest.probe, portReady: 'yes' } };
    const problems = validateFeatureManifest(broken);
    expect(problems.some((p) => p.includes('portReady') && p.includes('独立布尔'))).toBe(true);
  });

  it('缺 verificationMode ⇒ 拒', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: false });
    const { verificationMode, ...probe } = manifest.probe;
    void verificationMode;
    const broken = { ...manifest, probe };
    expect(validateFeatureManifest(broken).some((p) => p.includes('verificationMode'))).toBe(true);
  });
});

describe('M10 生产启用闸门：fixture 恒不可达', () => {
  it('fixture manifest 不可激活，阻断原因含 not_real_mode 与 port_not_ready', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: false });
    const check = checkProductionActivation(manifest);
    expect(check.activatable).toBe(false);
    expect(check.blocks).toContain('not_real_mode');
    expect(check.blocks).toContain('port_not_ready');
    expect(() => assertProductionActivation(manifest)).toThrowError(/fixture\/未就绪/);
    expect(() => assertNotProductionManifest(manifest)).not.toThrow();
  });

  it('即便是 fixture 模式，只要 portReady 为 true 仍不可激活（not_real_mode）', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: true });
    const check = checkProductionActivation(manifest);
    expect(check.activatable).toBe(false);
    expect(check.blocks).toEqual(['not_real_mode']);
  });

  it('real + 端口就绪 + 四态齐备 ⇒ 可激活', () => {
    const manifest = buildMeituanFeatureManifest({ verificationMode: 'real', portReady: true });
    const check = checkProductionActivation(manifest);
    expect(check.activatable).toBe(true);
    expect(check.blocks).toEqual([]);
    expect(() => assertProductionActivation(manifest)).not.toThrow();
  });
});
