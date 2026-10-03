/**
 * F01 验收：**对比度**（WCAG 2.1 相对亮度/对比度比）。
 *
 * 设计原件未写死对比度阈值（§3 行 97），本测试用 WCAG 2.1 AA 作为**工程下限**，
 * 并对 token 配对做**实测**。断言的是"我们算出来的数"，不是引用旧数字。
 *
 * 含一条**如实登记的缺口**：品牌色 `#E9A66D` 在白底上的非文本对比度 < 3:1。
 * 该缺口设计文档自身声明待验收（§3 行 97），此处不隐藏、不调阈值凑通过。
 */

import { describe, expect, it } from 'vitest';

import {
  AA_LARGE_TEXT,
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastPairs,
  contrastRatio,
  failingContrastPairs,
  parseHexColor,
  relativeLuminance,
  thresholdFor,
  tokenContrastAudit,
} from '../../../apps/mobile-ui/src/foundation/contrast.js';
import { colors } from '../../../apps/mobile-ui/src/foundation/tokens.js';

describe('F01 / 对比度算法自证（判别力）', () => {
  it('黑白对比度为 21.0（WCAG 参考值）', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 3);
  });

  it('相同颜色对比度为 1.0', () => {
    expect(contrastRatio('#E9A66D', '#E9A66D')).toBeCloseTo(1, 6);
  });

  it('对比度可交换（前景/背景调换结果不变）', () => {
    expect(contrastRatio('#28231F', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#28231F'),
      10,
    );
  });

  it('相对亮度：白=1、黑=0', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
  });

  it('非法色值必须抛错，不静默当成合法', () => {
    expect(() => parseHexColor('red')).toThrow();
    expect(() => parseHexColor('#FFF')).toThrow();
    expect(() => parseHexColor('#GGGGGG')).toThrow();
  });

  it('类别到下限的映射', () => {
    expect(thresholdFor('normal-text')).toBe(AA_NORMAL_TEXT);
    expect(thresholdFor('large-text')).toBe(AA_LARGE_TEXT);
    expect(thresholdFor('non-text')).toBe(AA_NON_TEXT);
  });
});

describe('F01 / token 配对实测（数值随令牌变化即可被捕获）', () => {
  const audit = tokenContrastAudit();
  const byId = new Map(audit.map((r) => [r.id, r]));

  it('审计覆盖全部配对，id 唯一', () => {
    expect(audit.length).toBe(contrastPairs.length);
    expect(byId.size).toBe(contrastPairs.length);
  });

  it('正文/标题 与 白底 ≈ 15.55:1', () => {
    expect(byId.get('body-on-canvas')?.ratio).toBeCloseTo(15.551, 2);
  });

  it('辅助信息 与 白底 ≈ 4.82:1（勉强过 AA 正文）', () => {
    expect(byId.get('secondary-on-canvas')?.ratio).toBeCloseTo(4.818, 2);
  });

  it('主按钮文字 与 主按钮底 ≈ 8.23:1', () => {
    expect(byId.get('button-label-on-primary')?.ratio).toBeCloseTo(8.225, 2);
  });

  it('轻强调文字 与 轻强调底 ≈ 5.98:1', () => {
    expect(byId.get('accent-on-accent-surface')?.ratio).toBeCloseTo(5.98, 2);
  });

  it('成功/危险/焦点环 与 白底 均 ≥4.5', () => {
    for (const id of ['success-on-canvas', 'danger-on-canvas', 'focus-ring-on-canvas']) {
      expect(byId.get(id)?.ratio ?? 0, id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('F01 / AA 判定', () => {
  it('全部正文类配对达到 AA 4.5:1', () => {
    const normalText = tokenContrastAudit().filter((r) => r.kind === 'normal-text');
    const failing = normalText.filter((r) => !r.pass).map((r) => `${r.id}=${r.ratio.toFixed(3)}`);
    expect(failing).toEqual([]);
  });

  it('每项 pass 与其 ratio/threshold 自洽', () => {
    for (const r of tokenContrastAudit()) {
      expect(r.pass, r.id).toBe(r.ratio >= r.threshold);
    }
  });
});

describe('F01 / 如实登记的对比度缺口', () => {
  it('品牌色 #E9A66D 在白底上 < 3:1（非文本下限），不得伪装通过', () => {
    const brand = tokenContrastAudit().find((r) => r.id === 'brand-on-canvas');
    expect(brand).toBeDefined();
    expect(brand?.ratio).toBeLessThan(3);
    expect(brand?.pass).toBe(false);
  });

  it('未达标清单当前恰为 [brand-on-canvas]（如实、可追踪）', () => {
    const failing = failingContrastPairs().map((r) => r.id).sort();
    expect(failing).toEqual(['brand-on-canvas']);
  });
});
