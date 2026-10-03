/**
 * F01 验收：**设计令牌一致性**。
 *
 * 本用例不把色值硬编码为期望值，而是**直接解析设计原件**
 * `docs/design/design-07-正式发布版App界面与交互.md`（v6）与
 * `docs/design/release-ui/README.md`，再与 `apps/mobile-ui/src/foundation/tokens.ts`
 * 和 `apps/mobile-ui/foundation.css` 比对。这样：
 *   - 设计改了色值、令牌没跟 ⇒ 红；
 *   - 令牌自己编了一个设计里没有的颜色 ⇒ 红（防"凭空定色"）；
 *   - 令牌标注的出处行号对不上原文 ⇒ 红（防出处造假）。
 *
 * 出处行号可人工复核：`sed -n '<line>p' docs/design/design-07-正式发布版App界面与交互.md`。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  colors,
  entries,
  entrySelection,
  brand,
  breakpoints,
  spacing,
  radius,
  touch,
  motion,
  typography,
  theme,
  TEMPLATE_LABEL,
  type ColorTokenName,
} from '../../../apps/mobile-ui/src/foundation/tokens.js';

/** 仓库根（`tests/mobile-ui/F01/` 向上三级）。 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const DESIGN_07_PATH = join(REPO_ROOT, 'docs', 'design', 'design-07-正式发布版App界面与交互.md');
const RELEASE_UI_README_PATH = join(REPO_ROOT, 'docs', 'design', 'release-ui', 'README.md');
const TOKENS_TS_PATH = join(REPO_ROOT, 'apps', 'mobile-ui', 'src', 'foundation', 'tokens.ts');
const FOUNDATION_CSS_PATH = join(REPO_ROOT, 'apps', 'mobile-ui', 'foundation.css');

/** 统一按 LF 切行：设计原件在工作区是 CRLF，行号不能随平台漂移。 */
function readLines(path: string): readonly string[] {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

interface ParsedColorToken {
  readonly name: string;
  /** 六位大写十六进制。 */
  readonly value: string;
  /** 1 起行号。 */
  readonly line: number;
  readonly usage: string;
}

/**
 * 解析 design-07 §3 令牌表。行格式（原文带反引号）：
 *   | `brand` | `#E9A66D` | 品牌、文字导航选中下划线 |
 */
function parseDesignColorTable(lines: readonly string[]): readonly ParsedColorToken[] {
  const rowRe = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*`(#[0-9a-fA-F]{6})`\s*\|\s*(.+?)\s*\|\s*$/;
  const parsed: ParsedColorToken[] = [];
  lines.forEach((text, index) => {
    const m = rowRe.exec(text);
    if (m === null) return;
    const [, name, hex, usage] = m;
    if (name === undefined || hex === undefined || usage === undefined) return;
    parsed.push({ name, value: hex.toUpperCase(), line: index + 1, usage });
  });
  return parsed;
}

const design07Lines = readLines(DESIGN_07_PATH);
const design07Text = design07Lines.join('\n');
const readmeText = readText(RELEASE_UI_README_PATH);
const parsedColors = parseDesignColorTable(design07Lines);

const parsedByName = new Map(parsedColors.map((t) => [t.name, t]));

describe('F01 / 解析器自证（判别力）', () => {
  it('确实从 design-07 §3 令牌表解出了 14 条颜色令牌', () => {
    expect(parsedColors.length).toBe(14);
  });

  it('解析器对合成样本有判别力（改一个色值即能被读出）', () => {
    const synthetic = ['| `brand` | `#123456` | 品牌、文字导航选中下划线 |'];
    const out = parseDesignColorTable(synthetic);
    expect(out).toEqual([
      { name: 'brand', value: '#123456', line: 1, usage: '品牌、文字导航选中下划线' },
    ]);
  });

  it('解析器对非表格行不误报（正文里的行内色值不算令牌）', () => {
    const prose = [
      '页面背景改为白色，主题色调浅、提亮为杏橙色 `#E9A66D`。',
      '四入口继续使用文字导航，以细橙色下划线标示当前页。',
    ];
    expect(parseDesignColorTable(prose)).toEqual([]);
  });
});

describe('F01 / 颜色令牌与设计原文逐条一致', () => {
  it('design-07 §3 令牌表的每个色值都进了 tokens.ts，且数值相同', () => {
    const mismatches: string[] = [];
    for (const parsed of parsedColors) {
      const token = (colors as Record<string, { value: string } | undefined>)[parsed.name];
      if (token === undefined) {
        mismatches.push(`${parsed.name}: 设计有 (${parsed.value} @L${parsed.line})，tokens.ts 没有`);
        continue;
      }
      if (token.value.toUpperCase() !== parsed.value) {
        mismatches.push(`${parsed.name}: 设计 ${parsed.value} vs tokens.ts ${token.value}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('tokens.ts 不得有设计表里没有的颜色（防凭空定色）', () => {
    const designNames = new Set(parsedColors.map((t) => t.name));
    const invented = Object.keys(colors).filter((name) => !designNames.has(name));
    expect(invented).toEqual([]);
  });

  it('每条颜色的出处行号指向的原文行确实写着该色值', () => {
    const problems: string[] = [];
    for (const [name, token] of Object.entries(colors) as [
      ColorTokenName,
      { value: string; origin: { doc: string; line: number } },
    ][]) {
      if (token.origin.doc !== 'docs/design/design-07-正式发布版App界面与交互.md') {
        problems.push(`${name}: 出处文档不是 design-07（${token.origin.doc}）`);
        continue;
      }
      const line = design07Lines[token.origin.line - 1];
      if (line === undefined) {
        problems.push(`${name}: 出处行 L${token.origin.line} 超出文档范围`);
        continue;
      }
      if (!line.includes(token.value)) {
        problems.push(`${name}: L${token.origin.line} 不含 ${token.value}`);
      }
      const parsed = parsedByName.get(name);
      if (parsed === undefined) continue;
      if (parsed.line !== token.origin.line) {
        problems.push(`${name}: 出处行 L${token.origin.line} ≠ 设计表实际行 L${parsed.line}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('正文/README 里出现的行内色值也必须是已登记令牌（设计加了色我们得跟）', () => {
    const known = new Set(Object.values(colors).map((t) => t.value.toUpperCase()));
    const unregistered: string[] = [];
    for (const [doc, text] of [
      ['design-07', design07Text],
      ['release-ui/README', readmeText],
    ] as const) {
      for (const m of text.matchAll(/`(#[0-9a-fA-F]{6})`/g)) {
        const hex = m[1];
        if (hex === undefined) continue;
        if (!known.has(hex.toUpperCase())) unregistered.push(`${doc}: ${hex}`);
      }
    }
    expect([...new Set(unregistered)]).toEqual([]);
  });
});

describe('F01 / v6 明文约束（白底、杏橙、轻强调、图标）', () => {
  it('design-07 明文写「白底 / 白色背景」，且 canvas 令牌为 #FFFFFF', () => {
    expect(design07Text).toMatch(/页面背景改为白色/);
    expect(design07Text).toMatch(/本轮固定白色主题/);
    expect(colors.canvas.value).toBe('#FFFFFF');
    expect(colors.surface.value).toBe('#FFFFFF');
  });

  it('主题色杏橙 #E9A66D 与轻强调 #FFF0E2 与设计原文一致', () => {
    const brandMatch = /杏橙色\s*`(#[0-9A-Fa-f]{6})`/.exec(design07Text);
    expect(brandMatch?.[1]?.toUpperCase()).toBe(colors.brand.value);
    expect(design07Text).toMatch(/轻强调底\s*`#FFF0E2`/);
    expect(colors['accent-surface'].value).toBe('#FFF0E2');
    expect(readmeText).toMatch(/轻强调底为\s*`#FFF0E2`/);
  });

  it('黑白火锅图标按设计引用原图，不重绘', () => {
    expect(design07Text).toMatch(/黑白火锅图标/);
    expect(design07Text).toMatch(/brand-user\.png/);
    expect(brand.assetPath).toBe('docs/design/release-ui/brand-user.png');
    expect(brand.allowRedraw).toBe(false);
    expect(brand.preserveAspect).toBe(true);
  });

  it('固定白色主题：系统深色偏好不切换底色', () => {
    expect(design07Text).toMatch(/系统深色偏好也不切换页面底色/);
    expect(theme.colorScheme).toBe('light-only');
  });
});

describe('F01 / 四入口、选中态与「模版」用词', () => {
  /** 从 `四个主入口固定命名为 **…**` 抽出入口名列表。 */
  function parseEntryNames(text: string, anchor: RegExp): readonly string[] {
    const m = anchor.exec(text);
    if (m?.[1] === undefined) return [];
    return m[1]
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const designEntries = parseEntryNames(design07Text, /四个主入口固定命名为\s*\*\*([^*]+)\*\*/);
  const readmeEntries = parseEntryNames(readmeText, /四个文字导航固定为\s*\*\*([^*]+)\*\*/);

  it('能从两份设计原件解析出四个入口名', () => {
    expect(designEntries).toEqual(['对话', '群组', '文件', '我的']);
    expect(readmeEntries).toEqual(['对话', '群组', '文件', '我的']);
  });

  it('tokens.entries 与设计原文四个入口逐一对应（顺序一致）', () => {
    expect(entries.map((e) => e.label)).toEqual(designEntries);
    expect(entries.length).toBe(4);
  });

  it('选中态是「细橙色下划线」，不是整块橙底', () => {
    expect(design07Text).toMatch(/细橙色选中下划线/);
    expect(design07Text).toMatch(/以细橙色下划线标示当前页/);
    expect(entrySelection.indicator).toBe('underline');
    expect(entrySelection.color).toBe(colors.brand.value);
    expect(entrySelection.weight).toBe('fine');
  });

  it('下划线粗细 dp 设计未写死 ⇒ 令牌必须标 unresolved 而非编造数值', () => {
    expect(design07Text).not.toMatch(/下划线\s*\d+\s*dp/);
    expect('unresolved' in entrySelection.weightPx).toBe(true);
  });

  it('界面入口用词为「模版」（非「模板」字形）', () => {
    expect(design07Text).toMatch(/界面入口统一采用用户指定字形[“"]模版[”"]/);
    expect(TEMPLATE_LABEL).toBe('模版');
  });
});

describe('F01 / 尺寸类令牌与设计原文一致', () => {
  it('间距：基础 4dp、常用 8/12/16/24/32、页边 20dp、窄屏 16dp', () => {
    expect(design07Text).toMatch(/基础 4dp；常用 8\/12\/16\/24\/32dp；手机页面左右 20dp，窄屏允许 16dp/);
    expect(spacing.baseDp).toBe(4);
    expect(spacing.commonDp).toEqual([8, 12, 16, 24, 32]);
    expect(spacing.pageInlineDp).toBe(20);
    expect(spacing.pageInlineNarrowDp).toBe(16);
  });

  it('触区：正式产品至少 48×48dp', () => {
    expect(design07Text).toMatch(/有效触区至少 48×48dp/);
    expect(touch.minTargetDp).toBe(48);
  });

  it('圆角：控件约 12dp；成果卡/输入容器 12–20dp（区间，不编造单值）', () => {
    expect(design07Text).toMatch(/控件采用约 12dp/);
    expect(design07Text).toMatch(/12–20dp/);
    expect(radius.controlDp).toBe(12);
    expect(radius.cardMinDp).toBe(12);
    expect(radius.cardMaxDp).toBe(20);
    expect('unresolved' in radius.cardExact).toBe(true);
  });

  it('动效：普通过渡 160–220ms，尊重减少动态效果', () => {
    expect(design07Text).toMatch(/普通过渡 160–220ms/);
    expect(design07Text).toMatch(/尊重减少动态效果/);
    expect(motion.durationMinMs).toBe(160);
    expect(motion.durationMaxMs).toBe(220);
    expect(motion.respectReducedMotion).toBe(true);
    expect('unresolved' in motion.exactDuration).toBe(true);
  });

  it('字体族设计只给语义、未给具体字体名 ⇒ 令牌标 unresolved', () => {
    expect(design07Text).toMatch(/Android 系统中文无衬线字体/);
    expect(design07Text).not.toMatch(/font-family\s*:/);
    expect('unresolved' in typography.family).toBe(true);
  });

  it('字号阶梯与设计明文一致', () => {
    expect(design07Text).toMatch(/页面标题 24sp\/32/);
    expect(typography.scale['page-title']).toEqual({ sizeSp: 24, lineHeightDp: 32 });
    expect(typography.scale['section-title']).toEqual({ sizeSp: 20, lineHeightDp: 28 });
    expect(typography.scale.body).toEqual({ sizeSp: 16, lineHeightDp: 24 });
    expect(typography.scale.button).toEqual({ sizeSp: 16, lineHeightDp: 24 });
    expect(typography.scale.auxiliary).toEqual({ sizeSp: 14, lineHeightDp: 20 });
    expect(typography.scale['annotation-minor']).toEqual({ sizeSp: 12, lineHeightDp: 18 });
  });

  it('响应式断点与设计明文一致（<600 / 600–839 / ≥840）', () => {
    expect(design07Text).toMatch(/紧凑窗口\s*`<600dp`/);
    expect(design07Text).toMatch(/中等窗口\s*`600–839dp`/);
    expect(design07Text).toMatch(/展开窗口\s*`≥840dp`/);
    expect(breakpoints.map((b) => [b.minDp, b.maxDp])).toEqual([
      [0, 600],
      [600, 840],
      [840, null],
    ]);
  });
});

describe('F01 / CSS 变量投影与 tokens.ts 不漂移', () => {
  const cssText = readText(FOUNDATION_CSS_PATH);

  function readCssVar(name: string): string | undefined {
    return new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(cssText)?.[1]?.trim();
  }

  it('每个颜色令牌都有同名 CSS 变量且取值相同', () => {
    const problems: string[] = [];
    for (const [name, token] of Object.entries(colors) as [string, { value: string }][]) {
      const cssValue = readCssVar(`pb-color-${name}`);
      if (cssValue === undefined) {
        problems.push(`${name}: 缺少 --pb-color-${name}`);
      } else if (cssValue.toUpperCase() !== token.value) {
        problems.push(`${name}: css ${cssValue} vs ts ${token.value}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('CSS 变量总数与颜色令牌数一致（没有多写的颜色）', () => {
    const cssColorVars = [...cssText.matchAll(/--pb-color-([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(cssColorVars.length).toBe(Object.keys(colors).length);
  });

  it('关键尺寸变量与令牌数值一致（含单位）', () => {
    expect(readCssVar('pb-space-base')).toBe('4dp');
    expect(readCssVar('pb-space-page-inline')).toBe('20dp');
    expect(readCssVar('pb-space-page-inline-narrow')).toBe('16dp');
    expect(readCssVar('pb-touch-min-target')).toBe('48dp');
    expect(readCssVar('pb-radius-control')).toBe('12dp');
    expect(readCssVar('pb-motion-duration-min')).toBe('160ms');
    expect(readCssVar('pb-motion-duration-max')).toBe('220ms');
  });

  it('CSS 里不出现设计未写死的下划线粗细 dp（不编造）', () => {
    expect(/--pb-entry-indicator-(width|thickness|dp)\s*:/.test(cssText)).toBe(false);
  });
});

describe('F01 / tokens.ts 自述：unresolved 项带原因、出处可回溯', () => {
  const tokensSrc = readText(TOKENS_TS_PATH);

  it('tokens.ts 不写任何 CSS 字体族串（设计没给，不得编造）', () => {
    expect(tokensSrc).not.toMatch(/font-family\s*:/);
    expect(tokensSrc).not.toMatch(/family:\s*'/);
    expect(tokensSrc).not.toMatch(/sans-serif/);
  });

  it('tokens.ts 内出现的十六进制色值都能在设计原文里找到', () => {
    const known = new Set(Object.values(colors).map((t) => t.value.toUpperCase()));
    const found = [...tokensSrc.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]?.toUpperCase());
    const unknown = [...new Set(found.filter((v) => v !== undefined && !known.has(v)))];
    expect(unknown).toEqual([]);
  });

  it('unresolved 都必须带非空 note（缺口要有据可查）', () => {
    const notes: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record['unresolved'] === true) {
        const note = record['note'];
        if (typeof note !== 'string' || note.trim().length === 0) notes.push(path);
        expect(Object.keys(record).sort()).toEqual(['note', 'unresolved']);
        return;
      }
      for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`);
    };
    visit({ colors, theme, brand, entrySelection, typography, spacing, touch, radius, motion, breakpoints }, 'tokens');
    expect(notes).toEqual([]);
  });
});
