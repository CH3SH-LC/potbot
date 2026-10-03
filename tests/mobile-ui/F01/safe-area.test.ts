/**
 * F01 验收：**安全区换算**（design-07 §0 行 15 / §4 行 117 / §12 行 255–256）。
 *
 * 覆盖：输入区避让键盘与手势、页边随窄屏收窄、铰链/挖孔区不可放关键控制、
 * 非法输入必须报错。全部为纯函数断言，不读系统 inset。
 */

import { describe, expect, it } from 'vitest';

import {
  SafeAreaError,
  ZERO_INSETS,
  contentPadding,
  criticalControlFits,
  forbiddenZones,
  inputBarOffset,
  minInsetForEdge,
  validateInsets,
  type SafeAreaInsets,
} from '../../../apps/mobile-ui/src/foundation/safe-area.js';
import { spacing } from '../../../apps/mobile-ui/src/foundation/tokens.js';

const insets = (partial: Partial<SafeAreaInsets> = {}): SafeAreaInsets => ({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  ...partial,
});

describe('F01 / 输入非法', () => {
  it('负 inset 抛 invalid-insets', () => {
    try {
      validateInsets(insets({ top: -1 }));
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as SafeAreaError).code).toBe('invalid-insets');
    }
  });

  it('NaN inset 抛 invalid-insets', () => {
    expect(() => validateInsets(insets({ bottom: Number.NaN }))).toThrowError(SafeAreaError);
  });

  it('负键盘高抛 invalid-keyboard-height', () => {
    try {
      inputBarOffset('above-keyboard-fixed', ZERO_INSETS, -10);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as SafeAreaError).code).toBe('invalid-keyboard-height');
    }
  });
});

describe('F01 / 禁止区（§12 行 256：铰链/挖孔/手势不可放关键控制）', () => {
  it('无 inset 且无铰链 ⇒ 无禁止区', () => {
    expect(forbiddenZones(ZERO_INSETS)).toEqual([]);
  });

  it('顶部 inset 生成状态栏与挖孔区（edge=top）', () => {
    const zones = forbiddenZones(insets({ top: 24 }));
    const ids = zones.map((z) => z.id).sort();
    expect(ids).toEqual(['display-cutout', 'status-bar']);
    expect(zones.every((z) => z.edge === 'top' && z.thicknessDp === 24)).toBe(true);
  });

  it('底部 inset 生成导航栏与手势区（edge=bottom）', () => {
    const zones = forbiddenZones(insets({ bottom: 48 }));
    expect(zones.map((z) => z.id).sort()).toEqual(['gesture', 'navigation-bar']);
  });

  it('铰链按指定边生成禁止带', () => {
    const zones = forbiddenZones(insets(), { hingeDp: 40, hingeEdge: 'right' });
    expect(zones).toEqual([
      { id: 'hinge', edge: 'right', thicknessDp: 40, reason: '折叠铰链' },
    ]);
  });

  it('铰链缺省靠左；厚度 0 不生成', () => {
    expect(forbiddenZones(insets(), { hingeDp: 30 }).at(0)?.edge).toBe('left');
    expect(forbiddenZones(insets(), { hingeDp: 0 })).toEqual([]);
  });

  it('minInsetForEdge 取该边最大厚度', () => {
    const zones = [
      ...forbiddenZones(insets({ top: 20 })),
      ...forbiddenZones(insets(), { hingeDp: 60, hingeEdge: 'top' }),
    ];
    expect(minInsetForEdge(zones, 'top')).toBe(60);
    expect(minInsetForEdge(zones, 'bottom')).toBe(0);
  });
});

describe('F01 / 内容 padding（§3 行 104）', () => {
  it('常规页边 20dp，窄屏 16dp', () => {
    expect(spacing.pageInlineDp).toBe(20);
    expect(contentPadding(ZERO_INSETS).left).toBe(20);
    expect(contentPadding(ZERO_INSETS, { narrow: true }).left).toBe(16);
  });

  it('铰链抬升对应方向的边距（不把关键内容压到铰链上）', () => {
    const zones = forbiddenZones(insets(), { hingeDp: 48, hingeEdge: 'left' });
    const pad = contentPadding(insets(), { zones });
    expect(pad.left).toBe(48);
    expect(pad.right).toBe(20);
  });

  it('不变量：每个方向 padding ≥ 该边禁止区厚度', () => {
    const zones = [
      ...forbiddenZones(insets({ top: 24, bottom: 48 })),
      ...forbiddenZones(insets(), { hingeDp: 36, hingeEdge: 'right' }),
    ];
    const pad = contentPadding(insets({ top: 24, bottom: 48 }), { zones });
    expect(pad.top).toBeGreaterThanOrEqual(minInsetForEdge(zones, 'top'));
    expect(pad.bottom).toBeGreaterThanOrEqual(minInsetForEdge(zones, 'bottom'));
    expect(pad.left).toBeGreaterThanOrEqual(minInsetForEdge(zones, 'left'));
    expect(pad.right).toBeGreaterThanOrEqual(minInsetForEdge(zones, 'right'));
  });

  it('顶部 padding 跟随状态栏高度', () => {
    expect(contentPadding(insets({ top: 32 })).top).toBe(32);
  });
});

describe('F01 / 输入区偏移（§0 行 15 / §4 行 117）', () => {
  it('正式 App：无键盘时避开底部手势区（取底部 inset）', () => {
    expect(inputBarOffset('above-keyboard-fixed', insets({ bottom: 48 }), 0)).toBe(48);
  });

  it('正式 App：键盘高于手势区时取键盘高', () => {
    expect(inputBarOffset('above-keyboard-fixed', insets({ bottom: 48 }), 320)).toBe(320);
  });

  it('正式 App：键盘低于手势区时仍避开手势区', () => {
    expect(inputBarOffset('above-keyboard-fixed', insets({ bottom: 60 }), 24)).toBe(60);
  });

  it('内联原型：文档流，偏移恒为 0（不承诺固定于屏幕）', () => {
    expect(inputBarOffset('document-flow-bottom', insets({ bottom: 48 }), 320)).toBe(0);
  });
});

describe('F01 / 关键控制可用高度', () => {
  it('≥48dp 才算放得下（§3 行 105）', () => {
    expect(criticalControlFits(48)).toBe(true);
    expect(criticalControlFits(52)).toBe(true);
    expect(criticalControlFits(47)).toBe(false);
  });
});
