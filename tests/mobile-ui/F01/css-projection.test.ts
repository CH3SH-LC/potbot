/**
 * F01-I16 验收：**CSS 变量投影（单一来源不漂移）+ 安全区注入钩子 + 200% 字号**。
 *
 * 本用例把 foundation 钉成壳与模块消费的唯一令牌来源：
 *   - `themeSnapshot()` → `themeCssVariables()`，`listControls()` → `controlsCssVariables()`；
 *   - `apps/mobile-ui/foundation.css` 是同一投影的落盘副本，逐变量**字节比对**（含单位，
 *     非数值近似），并断言 CSS 里**没有**投影之外的 `--pb-*` 变量（防两端各写一套）。
 *
 * 另含三块：
 *   - Android 宿主向 `safe-area.ts` 注入真实 inset/IME 的透传钩子（非法值即抛，不静默夹取）；
 *   - 200% 字号（design-07 §12 行 249）：字号/行高精确缩放、行高比保持、非字号令牌不动；
 *   - **如实登记的对比度缺口**：从 CSS 里的 brand/canvas 复算 ≈2.071 且 <3，`pass===false`。
 *
 * 边界（**未验证**，见文件末）：渲染层截断、双列→单列回退、真机 inset 读取均不在本包范围。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ThemeCssError,
  colorCssVariables,
  formatCssNumber,
  renderCssVariables,
  themeCssVariables,
  typeScaleAt,
} from '../../../apps/mobile-ui/src/foundation/theme.js';
import {
  controlsCssVariables,
  getControl,
  listControls,
  resolveControlTheme,
} from '../../../apps/mobile-ui/src/foundation/controls.js';
import { foundationCssVariables } from '../../../apps/mobile-ui/src/foundation/index.js';
import { colors } from '../../../apps/mobile-ui/src/foundation/tokens.js';
import {
  AA_NON_TEXT,
  contrastRatio,
  failingContrastPairs,
  tokenContrastAudit,
} from '../../../apps/mobile-ui/src/foundation/contrast.js';
import {
  SafeAreaError,
  ZERO_INSETS,
  createSafeAreaBridge,
  layoutFromHost,
  type SafeAreaInsets,
} from '../../../apps/mobile-ui/src/foundation/safe-area.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const FOUNDATION_CSS = join(REPO_ROOT, 'apps', 'mobile-ui', 'foundation.css');

/** 统一按 LF 读取，避免 CRLF 让字节比对随平台漂移。 */
function readCssText(): string {
  return readFileSync(FOUNDATION_CSS, 'utf8').replace(/\r\n/g, '\n');
}

/** 解析 CSS 里全部 `--pb-*: value;` 声明（含 `--pb-color-` 与 `--pb-control-`）。 */
function parseCssVars(cssText: string): Map<string, string> {
  const vars = new Map<string, string>();
  const re = /(--pb-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  for (const m of cssText.matchAll(re)) {
    if (m[1] !== undefined && m[2] !== undefined) vars.set(m[1], m[2].trim());
  }
  return vars;
}

const cssText = readCssText();
const cssVars = parseCssVars(cssText);
const expected = foundationCssVariables();

const insets = (partial: Partial<SafeAreaInsets> = {}): SafeAreaInsets => ({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  ...partial,
});

describe('F01-I16 / CSS 投影与 foundation.css 逐字节一致（不漂移）', () => {
  it('foundation.css 覆盖全部投影变量（无遗漏）', () => {
    const missing = Object.keys(expected).filter((name) => !cssVars.has(name));
    expect(missing).toEqual([]);
  });

  it('foundation.css 不含未投影的 --pb-* 变量（单一来源，无孤儿）', () => {
    const orphans = [...cssVars.keys()].filter((name) => !(name in expected));
    expect(orphans).toEqual([]);
  });

  it('每个投影变量在 CSS 里值逐字节一致（含单位，非数值近似）', () => {
    const problems: string[] = [];
    for (const [name, value] of Object.entries(expected)) {
      const cssValue = cssVars.get(name);
      if (cssValue === undefined) problems.push(`缺 ${name}`);
      else if (cssValue !== value) problems.push(`${name}: css "${cssValue}" vs projection "${value}"`);
      if (!cssText.includes(`${name}: ${value};`)) problems.push(`${name}: 缺少逐字节声明 "${name}: ${value};"`);
    }
    expect(problems).toEqual([]);
  });

  it('主题变量 41 个、控件变量 58 个、合计 99 个（数字变动即被人察觉）', () => {
    const theme = themeCssVariables();
    const controls = controlsCssVariables();
    // 14 颜色 + 1 层级 + 12 字号/行高 + 4 字重 + 3 间距 + 1 触区 + 3 圆角 + 2 动效 + 1 选中色
    expect(Object.keys(theme).length).toBe(41);
    // 7 控件 × 公共项 + 非空颜色角色（card 为区间圆角 ⇒ 2 个圆角变量）
    expect(Object.keys(controls).length).toBe(58);
    expect(Object.keys(expected).length).toBe(99);
  });

  it('主题颜色子投影与 colorCssVariables() 同源一致', () => {
    const theme = themeCssVariables();
    const colorVars = colorCssVariables();
    for (const [name, value] of Object.entries(colorVars)) {
      expect(theme[name], name).toBe(value);
    }
    expect(Object.keys(colorVars).length).toBe(14);
  });

  it('缺省 fontScale = 1（100%），与 CSS 声明的字号完全一致', () => {
    const theme = themeCssVariables();
    expect(theme['--pb-font-body-size']).toBe('16sp');
    expect(theme['--pb-font-body-line']).toBe('24dp');
    expect(theme['--pb-font-annotation-minor-size']).toBe('12sp');
    expect(theme['--pb-entry-indicator-color']).toBe(colors.brand.value);
  });
});

describe('F01-I16 / 控件投影与 listControls() 同源', () => {
  it('每个控件的解析值都进了 CSS 变量（不重写色值）', () => {
    const controls = controlsCssVariables();
    for (const spec of listControls()) {
      const resolved = resolveControlTheme(spec);
      const prefix = `--pb-control-${spec.id}`;
      expect(controls[`${prefix}-min-touch`], spec.id).toBe(`${resolved.minTouchDp}dp`);
      expect(controls[`${prefix}-font-size`], spec.id).toBe(`${resolved.fontSizeSp}sp`);
      expect(controls[`${prefix}-line-height`], spec.id).toBe(`${resolved.lineHeightDp}dp`);
      expect(controls[`${prefix}-font-weight-min`], spec.id).toBe(String(resolved.fontWeight.min));
      expect(controls[`${prefix}-font-weight-max`], spec.id).toBe(String(resolved.fontWeight.max));
      if (resolved.background !== null) {
        expect(controls[`${prefix}-background`], spec.id).toBe(resolved.background);
      }
      if (resolved.foreground !== null) {
        expect(controls[`${prefix}-foreground`], spec.id).toBe(resolved.foreground);
      }
      if (resolved.border !== null) {
        expect(controls[`${prefix}-border`], spec.id).toBe(resolved.border);
      }
    }
  });

  it('主按钮投影为 action-primary 底 + action-foreground 字，且无边框变量', () => {
    const controls = controlsCssVariables();
    expect(controls['--pb-control-primary-button-background']).toBe(colors['action-primary'].value);
    expect(controls['--pb-control-primary-button-foreground']).toBe(colors['action-foreground'].value);
    expect('--pb-control-primary-button-border' in controls).toBe(false);
  });

  it('区间圆角（card）投影为 radius-min/radius-max；其它控件为单值 radius', () => {
    const controls = controlsCssVariables();
    expect(controls['--pb-control-card-radius-min']).toBe('12dp');
    expect(controls['--pb-control-card-radius-max']).toBe('20dp');
    expect('--pb-control-card-radius' in controls).toBe(false);
    expect(controls['--pb-control-primary-button-radius']).toBe('12dp');
    expect('--pb-control-primary-button-radius-min' in controls).toBe(false);
  });

  it('非交互控件（card / status-chip）触区 0dp 如实投影，不美化', () => {
    const controls = controlsCssVariables();
    expect(controls['--pb-control-card-min-touch']).toBe('0dp');
    expect(controls['--pb-control-status-chip-min-touch']).toBe('0dp');
    expect(getControl('card').interactive).toBe(false);
  });

  it('图标按钮无背景变量、有前景变量（不伪造透明背景）', () => {
    const controls = controlsCssVariables();
    expect('--pb-control-icon-button-background' in controls).toBe(false);
    expect(controls['--pb-control-icon-button-foreground']).toBe(colors['text-primary'].value);
  });
});

describe('F01-I16 / 200% 字号（design-07 §12 行 249）', () => {
  it('fontScale=2 时字号/行高精确翻倍', () => {
    const scaled = themeCssVariables({ fontScale: 2 });
    expect(scaled['--pb-font-body-size']).toBe('32sp');
    expect(scaled['--pb-font-body-line']).toBe('48dp');
    expect(scaled['--pb-font-page-title-size']).toBe('48sp');
    expect(scaled['--pb-font-page-title-line']).toBe('64dp');
    expect(scaled['--pb-font-annotation-minor-size']).toBe('24sp');
  });

  it('行高比保持不变（行高/字号 = 1.5，缩放不压扁行高）', () => {
    const base = typeScaleAt(1);
    const scaled = typeScaleAt(2);
    for (const name of Object.keys(base)) {
      const baseEntry = base[name];
      const scaledEntry = scaled[name];
      if (baseEntry === undefined || scaledEntry === undefined) continue;
      const baseRatio = baseEntry.lineHeightDp / baseEntry.sizeSp;
      const scaledRatio = scaledEntry.lineHeightDp / scaledEntry.sizeSp;
      expect(scaledRatio, name).toBeCloseTo(baseRatio, 10);
    }
  });

  it('缩放只作用于字号/行高：颜色/间距/触区/圆角/动效不受影响', () => {
    const base = themeCssVariables();
    const scaled = themeCssVariables({ fontScale: 2 });
    for (const [name, value] of Object.entries(base)) {
      if (name.startsWith('--pb-font-')) continue;
      expect(scaled[name], name).toBe(value);
    }
    // 触区不随字体缩放而变形（§3 行 105 的 48dp 是下限，不是被缩放的排版值）。
    expect(scaled['--pb-touch-min-target']).toBe('48dp');
  });

  it('控件字号同样缩放，触区/圆角不变', () => {
    const scaled = controlsCssVariables({ fontScale: 2 });
    expect(scaled['--pb-control-status-chip-font-size']).toBe('24sp');
    expect(scaled['--pb-control-status-chip-line-height']).toBe('36dp');
    expect(scaled['--pb-control-status-chip-min-touch']).toBe('0dp');
    expect(scaled['--pb-control-primary-button-min-touch']).toBe('48dp');
    expect(scaled['--pb-control-primary-button-radius']).toBe('12dp');
  });

  it('formatCssNumber 确定性：整数原样，非整数去尾零（无浮点噪声）', () => {
    expect(formatCssNumber(16)).toBe('16');
    expect(formatCssNumber(20.8)).toBe('20.8');
    expect(formatCssNumber(1.3 * 16)).toBe('20.8');
    expect(formatCssNumber(4 / 3)).toBe('1.333');
  });

  it('非法 fontScale（0 / 负 / NaN / Infinity）抛 invalid-font-scale，不静默回落', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        themeCssVariables({ fontScale: bad });
        throw new Error(`fontScale=${String(bad)} 应当抛错`);
      } catch (e) {
        expect((e as ThemeCssError).code, String(bad)).toBe('invalid-font-scale');
      }
    }
    expect(() => controlsCssVariables({ fontScale: Number.NaN })).toThrowError(ThemeCssError);
  });
});

describe('F01-I16 / 品牌色对比缺口如实登记（不隐藏）', () => {
  it('从 CSS 投影的 brand/canvas 变量复算 ≈2.071 且 < 3:1（非文本下限）', () => {
    const brand = cssVars.get('--pb-color-brand');
    const canvas = cssVars.get('--pb-color-canvas');
    expect(brand).toBeDefined();
    expect(canvas).toBeDefined();
    if (brand === undefined || canvas === undefined) return;
    const ratio = contrastRatio(brand, canvas);
    expect(ratio).toBeCloseTo(2.071, 2);
    expect(ratio).toBeLessThan(AA_NON_TEXT);
    expect(ratio >= AA_NON_TEXT).toBe(false);
  });

  it('对比审计里该配对的 pass===false，且未达标清单恰为 [brand-on-canvas]', () => {
    const pair = tokenContrastAudit().find((r) => r.id === 'brand-on-canvas');
    expect(pair?.pass).toBe(false);
    expect(failingContrastPairs().map((r) => r.id).sort()).toEqual(['brand-on-canvas']);
  });
});

describe('F01-I16 / 安全区注入钩子（Android 宿主喂真实 inset/IME）', () => {
  it('layoutFromHost 透传系统 inset 与 IME 高度（foundation 不自读系统）', () => {
    const layout = layoutFromHost({
      system: insets({ top: 24, bottom: 48 }),
      imeHeightDp: 320,
    });
    expect(layout.keyboardHeightDp).toBe(320);
    expect(layout.inputBarOffset).toBe(320);
    expect(layout.padding.top).toBe(24);
    expect(layout.zones.map((z) => z.id).sort()).toEqual([
      'display-cutout',
      'gesture',
      'navigation-bar',
      'status-bar',
    ]);
  });

  it('键盘收起（IME=0）时输入区仍避开底部手势区', () => {
    const layout = layoutFromHost({ system: insets({ bottom: 48 }), imeHeightDp: 0 });
    expect(layout.inputBarOffset).toBe(48);
  });

  it('extraZones 与由 inset/铰链推导的禁止区合并', () => {
    const layout = layoutFromHost(
      { system: ZERO_INSETS, imeHeightDp: 0 },
      { extraZones: [{ id: 'hinge', edge: 'left', thicknessDp: 36, reason: '测试注入' }] },
    );
    expect(layout.zones.map((z) => z.id)).toEqual(['hinge']);
    expect(layout.padding.left).toBe(36);
  });

  it('桥接：update 推送新值、通知订阅者并返回最新布局', () => {
    const bridge = createSafeAreaBridge({
      system: insets({ top: 24, bottom: 48 }),
      imeHeightDp: 0,
    });
    expect(bridge.layout().inputBarOffset).toBe(48);

    const seen: number[] = [];
    bridge.subscribe((layout) => seen.push(layout.inputBarOffset));
    const next = bridge.update({ imeHeightDp: 320 });
    expect(next.inputBarOffset).toBe(320);
    expect(bridge.current().imeHeightDp).toBe(320);
    expect(bridge.layout().inputBarOffset).toBe(320);
    expect(seen).toEqual([320]);
  });

  it('桥接：退订幂等且退订后不再收到通知', () => {
    const bridge = createSafeAreaBridge({ system: ZERO_INSETS, imeHeightDp: 0 });
    let count = 0;
    const off = bridge.subscribe(() => {
      count += 1;
    });
    bridge.update({ imeHeightDp: 100 });
    off();
    off();
    bridge.update({ imeHeightDp: 200 });
    expect(count).toBe(1);
  });

  it('桥接：非法值抛错且不改变既有状态（不静默夹取）', () => {
    const bridge = createSafeAreaBridge({ system: insets({ bottom: 48 }), imeHeightDp: 48 });
    try {
      bridge.update({ imeHeightDp: -1 });
      throw new Error('负 IME 应当抛错');
    } catch (e) {
      expect((e as SafeAreaError).code).toBe('invalid-keyboard-height');
    }
    try {
      bridge.update({ system: insets({ top: -5 }) });
      throw new Error('负 inset 应当抛错');
    } catch (e) {
      expect((e as SafeAreaError).code).toBe('invalid-insets');
    }
    expect(bridge.current().imeHeightDp).toBe(48);
    expect(bridge.current().system.bottom).toBe(48);
    expect(bridge.layout().inputBarOffset).toBe(48);
  });

  it('桥接：铰链注入抬高对应边 padding；窄屏页边为 16dp', () => {
    const bridge = createSafeAreaBridge(
      { system: ZERO_INSETS, imeHeightDp: 0, hingeDp: 40, hingeEdge: 'right' },
      { narrow: true },
    );
    expect(bridge.layout().padding.right).toBe(40);
    expect(bridge.layout().padding.left).toBe(16);
  });
});

describe('F01-I16 / renderCssVariables 确定性（字节可复现）', () => {
  it('按键排序、行格式固定、同输入恒同输出', () => {
    const a = renderCssVariables({ '--pb-b': '2dp', '--pb-a': '1dp' });
    const b = renderCssVariables({ '--pb-a': '1dp', '--pb-b': '2dp' });
    expect(a).toBe(b);
    expect(a).toBe('  --pb-a: 1dp;\n  --pb-b: 2dp;');
  });
});
