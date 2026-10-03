/**
 * F01 验收：**基础控件规格**。
 *
 * 断言 design-07 明文要求落到控件上：触区 ≥48dp（§3 行 105）、无阴影（§3 行 107）、
 * 圆角取自令牌（§3 行 106）、功能性图标须有可访问名称（§3 行 76 / §12 行 251）、
 * 选中态为细橙下划线（§2 行 36）。含**反向对照**：被改坏的规格必须被校验拒绝。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ControlError,
  assertAccessibleName,
  assertControlSpec,
  getControl,
  listControls,
  resolveControlTheme,
  toneTheme,
  validateControlSpec,
  focusRing,
  type ControlSpec,
  type ControlTone,
} from '../../../apps/mobile-ui/src/foundation/controls.js';
import {
  colors,
  entrySelection,
  radius,
  touch,
  typography,
  type ColorTokenName,
} from '../../../apps/mobile-ui/src/foundation/tokens.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DESIGN_07 = 'docs/design/design-07-正式发布版App界面与交互.md';
const designLines = readFileSync(join(REPO_ROOT, DESIGN_07), 'utf8').replace(/\r\n/g, '\n').split('\n');

/** 克隆一份规格用于反向对照。 */
function clone(spec: ControlSpec): ControlSpec {
  return JSON.parse(JSON.stringify(spec)) as ControlSpec;
}

describe('F01 / 控件表自洽', () => {
  it('登记 7 个基础控件，id 唯一', () => {
    const all = listControls();
    expect(all.length).toBe(7);
    expect(new Set(all.map((c) => c.id)).size).toBe(7);
  });

  it('每个控件的规格都通过校验（问题列表为空）', () => {
    const problems = listControls().flatMap((c) => validateControlSpec(c).map((p) => `${c.id}: ${p}`));
    expect(problems).toEqual([]);
  });

  it('全部控件不使用阴影（design-07 §3 行 107）', () => {
    for (const c of listControls()) {
      expect(c.elevation, c.id).toBe('none');
    }
  });

  it('每个控件的出处指向 design-07 且行号在文内', () => {
    for (const c of listControls()) {
      expect(c.origin.doc, c.id).toBe(DESIGN_07);
      const line = designLines[c.origin.line - 1];
      expect(line, `${c.id} origin L${c.origin.line}`).toBeDefined();
      expect((line ?? '').length).toBeGreaterThan(0);
    }
  });

  it('字号角色都取自 typography.scale（未编造）', () => {
    const known = new Set(Object.keys(typography.scale));
    for (const c of listControls()) {
      expect(known.has(c.type), `${c.id} type=${c.type}`).toBe(true);
    }
  });

  it('引用的颜色角色都在 tokens.colors 内（防凭空定色）', () => {
    for (const c of listControls()) {
      for (const role of [c.colors.background, c.colors.foreground, c.colors.border]) {
        if (role === null) continue;
        expect(role in colors, `${c.id} role=${role}`).toBe(true);
      }
    }
  });
});

describe('F01 / 触区（design-07 §3 行 105）', () => {
  it('交互控件触区至少 48dp', () => {
    expect(touch.minTargetDp).toBe(48);
    for (const c of listControls()) {
      if (!c.interactive) continue;
      expect(c.minTouchDp, c.id).toBeGreaterThanOrEqual(48);
    }
  });

  it('非交互控件（card / status-chip）不占触区', () => {
    expect(getControl('card').interactive).toBe(false);
    expect(getControl('card').minTouchDp).toBe(0);
    expect(getControl('status-chip').interactive).toBe(false);
    expect(getControl('status-chip').minTouchDp).toBe(0);
  });

  it('主按钮/图标按钮/输入框均为交互且有触区', () => {
    for (const id of ['primary-button', 'icon-button', 'text-input'] as const) {
      const c = getControl(id);
      expect(c.interactive, id).toBe(true);
      expect(c.minTouchDp, id).toBeGreaterThanOrEqual(48);
    }
  });
});

describe('F01 / 颜色与圆角取自令牌（未重写色值）', () => {
  it('主按钮解析为 action-primary 底 + action-foreground 字', () => {
    const t = resolveControlTheme(getControl('primary-button'));
    expect(t.background).toBe(colors['action-primary'].value);
    expect(t.foreground).toBe(colors['action-foreground'].value);
    expect(t.border).toBeNull();
  });

  it('输入框解析为 input 底 + outline 边', () => {
    const t = resolveControlTheme(getControl('text-input'));
    expect(t.background).toBe(colors.input.value);
    expect(t.border).toBe(colors.outline.value);
    expect(t.foreground).toBe(colors['text-primary'].value);
  });

  it('控件圆角取自 radius 令牌；卡片为 12–20 区间', () => {
    expect(getControl('primary-button').radiusDp).toBe(radius.controlDp);
    expect(getControl('status-chip').radiusDp).toBe(radius.controlDp);
    const card = getControl('card');
    expect(card.radiusDp).toBe('range');
    expect(card.radiusRangeDp).toEqual([radius.cardMinDp, radius.cardMaxDp]);
  });

  it('状态芯片用控件圆角而非全圆 pill（§3 行 106 避免堆叠胶囊）', () => {
    expect(getControl('status-chip').radiusDp).toBe(12);
    expect(getControl('status-chip').radiusDp).not.toBe('range');
  });
});

describe('F01 / 可访问名称（§3 行 76 / §12 行 251）', () => {
  it('功能性图标按钮必须要求可访问名称', () => {
    expect(getControl('icon-button').requiresAccessibleLabel).toBe(true);
  });

  it('输入框要求可访问名称（placeholder 不算标签）', () => {
    expect(getControl('text-input').requiresAccessibleLabel).toBe(true);
  });

  it('有可见文字的按钮/导航/卡片不强制外部名称', () => {
    expect(getControl('primary-button').requiresAccessibleLabel).toBe(false);
    expect(getControl('text-entry').requiresAccessibleLabel).toBe(false);
    expect(getControl('card').requiresAccessibleLabel).toBe(false);
  });

  it('assertAccessibleName：图标按钮缺名称/空白名即抛 missing-accessible-name', () => {
    const icon = getControl('icon-button');
    expect(() => assertAccessibleName(icon, undefined)).toThrowError(ControlError);
    expect(() => assertAccessibleName(icon, '   ')).toThrowError(ControlError);
    try {
      assertAccessibleName(icon, '');
    } catch (e) {
      expect((e as ControlError).code).toBe('missing-accessible-name');
    }
    expect(() => assertAccessibleName(icon, '返回')).not.toThrow();
  });

  it('对不要求名称的控件，缺名称不报错', () => {
    expect(() => assertAccessibleName(getControl('card'), undefined)).not.toThrow();
  });
});

describe('F01 / 选中态细橙下划线（§2 行 36）', () => {
  it('导航入口选中态为下划线、颜色为 brand、粗细为细', () => {
    expect(getControl('text-entry').states).toContain('selected');
    expect(entrySelection.indicator).toBe('underline');
    expect(entrySelection.color).toBe(colors.brand.value);
    expect(entrySelection.weight).toBe('fine');
    expect('unresolved' in entrySelection.weightPx).toBe(true);
  });

  it('导航入口不填充背景（非整块橙底）', () => {
    expect(getControl('text-entry').colors.background).toBeNull();
  });
});

describe('F01 / 焦点环（§3 行 95）', () => {
  it('至少 2dp、颜色为 focus-ring、不可被裁剪', () => {
    expect(focusRing.minWidthDp).toBe(2);
    expect(focusRing.color).toBe(colors['focus-ring'].value);
    expect(focusRing.mustNotBeClipped).toBe(true);
  });

  it('交互控件都声明 focused 态', () => {
    for (const c of listControls()) {
      if (!c.interactive) continue;
      expect(c.states, c.id).toContain('focused');
    }
  });
});

describe('F01 / 色调映射（§3 行 91–94、§9 行 200）', () => {
  it('accent 用轻强调面，success/danger 只换文字色', () => {
    expect(toneTheme('accent')).toEqual({ background: 'accent-surface', foreground: 'accent-text', border: null });
    expect(toneTheme('success').foreground).toBe('success');
    expect(toneTheme('danger').foreground).toBe('danger');
    expect(toneTheme('unknown').foreground).toBe('text-secondary');
  });

  it('未知色调抛 invalid-tone（不静默回落）', () => {
    try {
      toneTheme('bogus' as ControlTone);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as ControlError).code).toBe('invalid-tone');
    }
  });
});

describe('F01 / 反向对照：坏规格必须被拒绝', () => {
  it('触区不足 48dp ⇒ invalid-control-spec', () => {
    const bad: ControlSpec = { ...clone(getControl('primary-button')), minTouchDp: 40 };
    expect(validateControlSpec(bad).some((p) => p.includes('触区'))).toBe(true);
    expect(() => assertControlSpec(bad)).toThrowError(ControlError);
    try {
      assertControlSpec(bad);
    } catch (e) {
      expect((e as ControlError).code).toBe('invalid-control-spec');
    }
  });

  it('引用未登记颜色角色 ⇒ 报错（防凭空定色）', () => {
    const bad = clone(getControl('primary-button'));
    const mutated = { ...bad, colors: { ...bad.colors, background: 'neon-pink' as ColorTokenName } };
    expect(validateControlSpec(mutated).some((p) => p.includes('未在 tokens.colors 登记'))).toBe(true);
  });

  it('使用阴影 ⇒ 报错（§3 行 107 不使用阴影）', () => {
    const bad = { ...clone(getControl('card')), elevation: 'shadow' as unknown as 'none' };
    expect(validateControlSpec(bad).some((p) => p.includes('elevation'))).toBe(true);
  });

  it('交互控件缺 focused 态 ⇒ 报错', () => {
    const base = clone(getControl('list-row'));
    const bad: ControlSpec = { ...base, states: base.states.filter((s) => s !== 'focused') };
    expect(validateControlSpec(bad).some((p) => p.includes('focused'))).toBe(true);
  });

  it('图标按钮不要求名称 ⇒ 报错', () => {
    const bad = { ...clone(getControl('icon-button')), requiresAccessibleLabel: false };
    expect(validateControlSpec(bad).some((p) => p.includes('可访问名称'))).toBe(true);
  });

  it('未知控件 id ⇒ unknown-control', () => {
    try {
      getControl('nope' as never);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as ControlError).code).toBe('unknown-control');
    }
  });
});

describe('F01 / resolveControlTheme 输出', () => {
  it('字号/行高直接来自 type scale，无阴影，纯数据可序列化', () => {
    const t = resolveControlTheme(getControl('primary-button'));
    expect(t.fontSizeSp).toBe(typography.scale.button.sizeSp);
    expect(t.lineHeightDp).toBe(typography.scale.button.lineHeightDp);
    expect(t.elevation).toBe('none');
    expect(() => JSON.stringify(t)).not.toThrow();
  });

  it('纯函数：同控件两次解析结果相等', () => {
    expect(resolveControlTheme(getControl('card'))).toEqual(resolveControlTheme(getControl('card')));
  });

  it('getControl/listControls 返回副本，外部改写不污染内部表', () => {
    const a = getControl('card');
    (a as { minTouchDp: number }).minTouchDp = 999;
    expect(getControl('card').minTouchDp).toBe(0);
  });
});
