/**
 * F01 冒烟：**包出口（barrel）可加载、关键符号齐备**。
 *
 * 单独验证 `foundation/index.ts` 的 `export *` 不产生歧义（同名导出会被静默丢弃），
 * 且消费方从单点即可取到令牌、布局壳、控件、对比度、安全区、主题六模块的入口。
 */

import { describe, expect, it } from 'vitest';

import * as foundation from '../../../apps/mobile-ui/src/foundation/index.js';

describe('F01 / barrel 出口', () => {
  it('六个模块的关键符号都存在', () => {
    const expected = [
      // tokens
      'colors',
      'typography',
      'spacing',
      'touch',
      'breakpoints',
      'entries',
      'TEMPLATE_LABEL',
      // layout
      'layoutShell',
      'resolveBreakpoint',
      'APP_TITLE',
      // controls
      'listControls',
      'getControl',
      'validateControlSpec',
      'assertControlSpec',
      'resolveControlTheme',
      'toneTheme',
      'focusRing',
      // contrast
      'contrastRatio',
      'tokenContrastAudit',
      'failingContrastPairs',
      // safe-area
      'forbiddenZones',
      'contentPadding',
      'inputBarOffset',
      // theme
      'themeSnapshot',
      'frozenThemeSnapshot',
      'colorCssVariables',
      'brandAsset',
      'PNG_SIGNATURE',
    ] as const;
    const missing = expected.filter((name) => !(name in foundation));
    expect(missing).toEqual([]);
  });

  it('导出的关键入口是可调用函数', () => {
    for (const fn of ['layoutShell', 'getControl', 'themeSnapshot', 'contrastRatio', 'contentPadding'] as const) {
      expect(typeof foundation[fn], fn).toBe('function');
    }
  });

  it('listControls() 经 barrel 取到 7 个控件', () => {
    expect(foundation.listControls().length).toBe(7);
  });
});
