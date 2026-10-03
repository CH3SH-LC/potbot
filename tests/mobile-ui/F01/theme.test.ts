/**
 * F01 验收：**主题快照与品牌素材**。
 *
 * 主题快照是渲染适配层消费的扁平契约；品牌素材核验做**真实文件 IO**：确认
 * design-07 指定的 `brand-user.png` 存在、是真正的 PNG（魔数），且令牌声明不重绘。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PNG_SIGNATURE,
  brandAsset,
  colorCssVariables,
  deepFreeze,
  frozenThemeSnapshot,
  themeSnapshot,
} from '../../../apps/mobile-ui/src/foundation/theme.js';
import { colors } from '../../../apps/mobile-ui/src/foundation/tokens.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const FOUNDATION_CSS = join(REPO_ROOT, 'apps', 'mobile-ui', 'foundation.css');

describe('F01 / 主题快照契约', () => {
  const snap = themeSnapshot();

  it('固定白色主题、无阴影', () => {
    expect(snap.colorScheme).toBe('light-only');
    expect(snap.elevation).toBe('none');
  });

  it('颜色表含全部 14 个令牌且取值与 tokens 一致', () => {
    const expected = Object.fromEntries(
      Object.entries(colors).map(([k, v]) => [k, v.value]),
    );
    expect(snap.colors).toEqual(expected);
    expect(Object.keys(snap.colors).length).toBe(14);
  });

  it('字体阶梯/间距/触区/圆角/动效都投影自令牌', () => {
    expect(snap.typeScale.body).toEqual({ sizeSp: 16, lineHeightDp: 24 });
    expect(snap.spacing.baseDp).toBe(4);
    expect(snap.touch.minTargetDp).toBe(48);
    expect(snap.radius.cardMaxDp).toBe(20);
    expect(snap.motion.durationMinMs).toBe(160);
  });

  it('四入口与选中态、模版字形', () => {
    expect(snap.entries.map((e) => e.label)).toEqual(['对话', '群组', '文件', '我的']);
    expect(snap.entrySelection.indicator).toBe('underline');
    expect(snap.entrySelection.weight).toBe('fine');
    expect(snap.templateLabel).toBe('模版');
  });

  it('纯函数：两次快照结果相等；可 JSON 往返', () => {
    const a = themeSnapshot();
    const b = themeSnapshot();
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('深冻结后不可改写（渲染层不得就地改主题）', () => {
    const frozen = frozenThemeSnapshot();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.colors)).toBe(true);
    expect(() => {
      (frozen.colors as Record<string, string>).brand = '#000000';
    }).toThrow();
    expect(frozen.colors.brand).toBe(colors.brand.value);
  });

  it('deepFreeze 对嵌套对象递归生效', () => {
    const obj = deepFreeze({ a: { b: [1, 2, 3] } });
    expect(Object.isFrozen(obj.a)).toBe(true);
    expect(Object.isFrozen(obj.a.b)).toBe(true);
  });
});

describe('F01 / CSS 变量投影不漂移', () => {
  const cssText = readFileSync(FOUNDATION_CSS, 'utf8').replace(/\r\n/g, '\n');
  const cssVars = colorCssVariables();

  it('每个颜色令牌生成的 CSS 变量名/值都与 foundation.css 一致', () => {
    const problems: string[] = [];
    for (const [name, value] of Object.entries(cssVars)) {
      // `colorCssVariables()` 的键已含 `--` 前缀（形如 `--pb-color-brand`）。
      const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(cssText);
      if (m === null) problems.push(`缺 ${name}`);
      else if (m[1]?.trim().toUpperCase() !== value.toUpperCase()) {
        problems.push(`${name}: css ${m[1]?.trim()} vs snapshot ${value}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('生成的变量名与颜色令牌数一致（无多写）', () => {
    expect(Object.keys(cssVars).length).toBe(Object.keys(colors).length);
  });
});

describe('F01 / 品牌素材真实核验（§3 行 76）', () => {
  it('设计指定引用原图 brand-user.png，不重绘、保持比例', () => {
    expect(brandAsset.path).toBe('docs/design/release-ui/brand-user.png');
    expect(brandAsset.allowRedraw).toBe(false);
    expect(brandAsset.preserveAspect).toBe(true);
    expect('unresolved' in brandAsset.renderSize).toBe(true);
  });

  it('该文件在仓库内真实存在且确为 PNG（读真实字节核验魔数）', () => {
    const bytes = readFileSync(join(REPO_ROOT, brandAsset.path));
    const head = [...bytes.subarray(0, 8)];
    expect(head).toEqual([...PNG_SIGNATURE]);
    // 非空且像样大小（原图 >100KB）。
    expect(bytes.byteLength).toBeGreaterThan(100_000);
  });

  it('未内联 SVG、未在 foundation 源码里嵌入品牌图形', () => {
    // 品牌只能通过引用原图使用；源码不得内联 <svg> 或 data: 图片。
    const src = readFileSync(join(REPO_ROOT, 'apps', 'mobile-ui', 'src', 'foundation', 'theme.ts'), 'utf8');
    expect(src).not.toMatch(/<svg/i);
    expect(src).not.toMatch(/data:image/i);
  });
});
