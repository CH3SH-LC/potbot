/**
 * F-I03 render —— 独立验收测试。
 *
 * 目标：证明渲染底座（ViewNode 模型 + 两个确定性序列化器）行为正确且**失败时大声失败**。
 * 关键断言：HTML 转义（`< > & "`）、逐字节稳定的快照、跨书写顺序的确定性、
 * fail-closed 校验，以及文本/可访问性序列化与 HTML 序列化的语义差别。
 */

import { describe, expect, it } from 'vitest';

import {
  ARIA_ROLE,
  FONT_WEIGHTS,
  SPACING_STEPS,
  VIEW_ROLES,
  VOID_TAGS,
  ViewError,
  assertViewNode,
  defaultRoleForTag,
  isSafeHref,
  isVoidTag,
  validateViewNode,
  type StyleTokens,
  type ViewNode,
} from '../../../apps/mobile-ui/src/render/view.js';
import {
  CSS_ORDER,
  HTML_ATTR_ORDER,
  escapeHtmlAttr,
  escapeHtmlText,
  renderHtml,
  styleToCss,
} from '../../../apps/mobile-ui/src/render/render-html.js';
import {
  accessibilityTree,
  normalizeLabel,
  renderText,
} from '../../../apps/mobile-ui/src/render/render-text.js';
import * as barrel from '../../../apps/mobile-ui/src/render/index.js';

// ---------------------------------------------------------------------------
// 代表性视图树（快照与结构测试共用）
// ---------------------------------------------------------------------------

const representative: ViewNode = {
  tag: 'section',
  role: 'container',
  ariaLabel: '对话',
  style: { background: 'surface', paddingDp: 16, gapDp: 8 },
  children: [
    { tag: 'h2', role: 'heading', text: '最近会话' },
    {
      tag: 'ul',
      role: 'list',
      children: [
        { tag: 'li', role: 'list-item', text: '群组 A' },
        { tag: 'li', role: 'list-item', text: '群组 B' },
      ],
    },
    { tag: 'button', role: 'button', ariaLabel: '发送', text: '发送' },
  ],
};

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

describe('F-I03 / HTML 转义', () => {
  it('文本上下文转义 & < >，引号在文本中无需转义（上下文正确）', () => {
    expect(escapeHtmlText('<>&"')).toBe('&lt;&gt;&amp;"');
    expect(escapeHtmlText(`<>&"'`)).toBe(`&lt;&gt;&amp;"'`);
  });

  it('属性上下文转义 & < > " 与单引号', () => {
    expect(escapeHtmlAttr('<>&"')).toBe('&lt;&gt;&amp;&quot;');
    expect(escapeHtmlAttr(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('文本节点里的四个字符都按规则处理', () => {
    const html = renderHtml({ tag: 'p', text: 'a < b & c > d "e"' });
    expect(html).toBe('<p>a &lt; b &amp; c &gt; d "e"</p>');
  });

  it('属性值里的引号被转义，无法逃出属性上下文', () => {
    const html = renderHtml({
      tag: 'button',
      role: 'button',
      ariaLabel: 'a < b & c > d "e"',
      text: 'x',
    });
    expect(html).toBe(
      '<button aria-label="a &lt; b &amp; c &gt; d &quot;e&quot;" role="button">x</button>',
    );
    // 只有一个 aria-label 属性，注入的引号没有生成新属性。
    expect((html.match(/aria-label=/g) ?? []).length).toBe(1);
  });

  it('文本序列化器不做 HTML 转义（输出给人/读屏看的纯文本）', () => {
    expect(renderText({ tag: 'p', text: '<b>加粗</b> & 更多' })).toBe('text: <b>加粗</b> & 更多');
  });
});

// ---------------------------------------------------------------------------
// 逐字节稳定快照
// ---------------------------------------------------------------------------

describe('F-I03 / 字节稳定快照', () => {
  it('代表性树输出与固定字面量逐字节一致', () => {
    const expected =
      '<section aria-label="对话" role="group" style="background-color: var(--pb-color-surface); gap: 8px; padding: 16px">\n' +
      '  <h2 role="heading">最近会话</h2>\n' +
      '  <ul role="list">\n' +
      '    <li role="listitem">群组 A</li>\n' +
      '    <li role="listitem">群组 B</li>\n' +
      '  </ul>\n' +
      '  <button aria-label="发送" role="button">发送</button>\n' +
      '</section>';
    expect(renderHtml(representative)).toBe(expected);
  });

  it('两次渲染结果相同；输出无尾随换行', () => {
    const a = renderHtml(representative);
    const b = renderHtml(representative);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(false);
  });

  it('文本序列化与固定字面量逐字节一致', () => {
    const expected =
      'container: 对话\n' +
      '  heading: 最近会话\n' +
      '  list\n' +
      '    list-item: 群组 A\n' +
      '    list-item: 群组 B\n' +
      '  button: 发送';
    expect(renderText(representative)).toBe(expected);
  });

  it('样式书写顺序不影响输出（跨插入顺序确定性）', () => {
    const s1: StyleTokens = { color: 'brand', paddingDp: 8 };
    const s2: StyleTokens = { paddingDp: 8, color: 'brand' };
    expect(styleToCss(s1)).toBe(styleToCss(s2));
    expect(styleToCss(s1)).toBe('color: var(--pb-color-brand); padding: 8px');
    const n1: ViewNode = { tag: 'div', style: s1 };
    const n2: ViewNode = { tag: 'div', style: s2 };
    expect(renderHtml(n1)).toBe(renderHtml(n2));
  });

  it('属性输出顺序由 HTML_ATTR_ORDER 固定', () => {
    const html = renderHtml({
      tag: 'a',
      role: 'link',
      ariaLabel: '文档',
      attrs: { title: '提示', class: 'link', id: 'a1', href: '/doc' },
      text: '打开',
    });
    expect(html).toBe(
      '<a aria-label="文档" class="link" href="/doc" id="a1" role="link" title="提示">打开</a>',
    );
    expect(HTML_ATTR_ORDER).toEqual([
      'aria-hidden',
      'aria-label',
      'class',
      'href',
      'id',
      'role',
      'style',
      'title',
    ]);
  });

  it('色值以 CSS 变量输出，无写死的十六进制', () => {
    const css = styleToCss({ color: 'text-primary', background: 'canvas', borderColor: 'outline' });
    expect(css).toContain('var(--pb-color-text-primary)');
    expect(css).toContain('var(--pb-color-canvas)');
    expect(css).toContain('var(--pb-color-outline)');
    expect(css).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('CSS 声明顺序常量按字母序固定', () => {
    expect([...CSS_ORDER].sort()).toEqual([...CSS_ORDER]);
  });
});

// ---------------------------------------------------------------------------
// HTML 结构
// ---------------------------------------------------------------------------

describe('F-I03 / HTML 结构', () => {
  it('空元素无闭合标签', () => {
    expect(renderHtml({ tag: 'input', role: 'input', ariaLabel: '输入框' })).toBe(
      '<input aria-label="输入框" role="textbox">',
    );
    expect(renderHtml({ tag: 'br' })).toBe('<br>');
    expect(VOID_TAGS.every((t) => isVoidTag(t))).toBe(true);
  });

  it('空容器输出单行空标签对，不产生多余缩进行', () => {
    expect(renderHtml({ tag: 'div', children: [] })).toBe('<div></div>');
  });

  it('装饰性图片自动 role=presentation 且 aria-hidden', () => {
    expect(renderHtml({ tag: 'img', role: 'decorative-image' })).toBe(
      '<img aria-hidden="true" role="presentation">',
    );
  });

  it('显式 ariaHidden 优先', () => {
    expect(renderHtml({ tag: 'div', ariaHidden: true, children: [] })).toBe(
      '<div aria-hidden="true"></div>',
    );
  });

  it('唯一自然语言入口等自定义属性在白名单内可透传', () => {
    const html = renderHtml({ tag: 'div', attrs: { id: 'nl-entry' }, children: [] });
    expect(html).toBe('<div id="nl-entry"></div>');
  });

  it('缩进单位可配置', () => {
    const html = renderHtml(representative, { indentUnit: '\t' });
    expect(html.split('\n')[1]).toBe('\t<h2 role="heading">最近会话</h2>');
  });
});

// ---------------------------------------------------------------------------
// 角色与可访问性树
// ---------------------------------------------------------------------------

describe('F-I03 / 可访问性树', () => {
  it('标签 -> 默认角色', () => {
    expect(defaultRoleForTag('h3')).toBe('heading');
    expect(defaultRoleForTag('li')).toBe('list-item');
    expect(defaultRoleForTag('a')).toBe('link');
    expect(defaultRoleForTag('div')).toBe('container');
  });

  it('每个语义角色都有合法 ARIA role 或显式 null', () => {
    for (const role of VIEW_ROLES) {
      const aria = ARIA_ROLE[role];
      expect(aria === null || /^[a-z]+$/.test(aria)).toBe(true);
    }
    expect(ARIA_ROLE['screen']).toBeNull();
    expect(ARIA_ROLE['text']).toBeNull();
    expect(ARIA_ROLE['list-item']).toBe('listitem');
    expect(ARIA_ROLE['icon-button']).toBe('button');
  });

  it('path/depth 确定性；可选 role 由标签推导', () => {
    const tree = accessibilityTree({ tag: 'ul', children: [{ tag: 'li', text: 'A' }] });
    expect(tree.path).toBe('0');
    expect(tree.role).toBe('list');
    expect(tree.depth).toBe(0);
    expect(tree.children[0]?.path).toBe('0.0');
    expect(tree.children[0]?.role).toBe('list-item');
    expect(tree.children[0]?.depth).toBe(1);
    expect(tree.children[0]?.label).toBe('A');
  });

  it('隐藏节点从文本输出中整体跳过', () => {
    const text = renderText({
      tag: 'div',
      role: 'container',
      children: [
        { tag: 'img', role: 'decorative-image' },
        { tag: 'span', text: '可见' },
      ],
    });
    expect(text).toBe('container\n  text: 可见');
  });

  it('名称空白折叠为单空格', () => {
    expect(normalizeLabel('  a\n\tb   c ')).toBe('a b c');
    expect(renderText({ tag: 'span', text: '多   空白\n行' })).toBe('text: 多 空白 行');
  });
});

// ---------------------------------------------------------------------------
// fail-closed 校验
// ---------------------------------------------------------------------------

describe('F-I03 / fail-closed 校验', () => {
  const codesOf = (node: unknown): readonly string[] => validateViewNode(node).map((p) => p.code);

  it('未登记的标签被拒', () => {
    expect(codesOf({ tag: 'blink', text: 'x' })).toContain('unknown-tag');
  });

  it('未登记的角色被拒', () => {
    expect(codesOf({ tag: 'div', role: 'marquee' })).toContain('unknown-role');
  });

  it('未登记的样式键被拒', () => {
    expect(codesOf({ tag: 'div', style: { shadow: 'lg' } })).toContain('unknown-style-key');
  });

  it('样式值必须在令牌表内', () => {
    expect(codesOf({ tag: 'div', style: { color: '#ff0000' } })).toContain('invalid-style-value');
    expect(codesOf({ tag: 'div', style: { fontSize: '48px' } })).toContain('invalid-style-value');
    expect(codesOf({ tag: 'div', style: { paddingDp: 10 } })).toContain('invalid-style-value');
    expect(codesOf({ tag: 'div', style: { radiusDp: 5 } })).toContain('invalid-style-value');
    expect(codesOf({ tag: 'div', style: { fontWeight: 700 } })).toContain('invalid-style-value');
  });

  it('合法样式值通过', () => {
    expect(
      codesOf({
        tag: 'div',
        style: { color: 'brand', fontSize: 'body', fontWeight: 600, paddingDp: 16, gapDp: 8, radiusDp: 12 },
      }),
    ).toEqual([]);
    expect(SPACING_STEPS).toEqual([4, 8, 12, 16, 24, 32]);
    expect(FONT_WEIGHTS).toEqual([400, 500, 600, 600]);
  });

  it('非法属性名（如 onclick）被拒', () => {
    expect(codesOf({ tag: 'div', attrs: { onclick: 'alert(1)' } })).toContain('invalid-attrs');
  });

  it('不安全 href 被拒', () => {
    expect(codesOf({ tag: 'a', attrs: { href: 'javascript:alert(1)' } })).toContain('unsafe-href');
    expect(codesOf({ tag: 'a', attrs: { href: 'data:text/html,x' } })).toContain('unsafe-href');
    expect(isSafeHref('/doc')).toBe(true);
    expect(isSafeHref('#top')).toBe(true);
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
  });

  it('text 与 children 并存被拒', () => {
    expect(
      codesOf({ tag: 'div', text: 'x', children: [{ tag: 'span', text: 'y' }] }),
    ).toContain('text-and-children');
  });

  it('非对象节点被拒', () => {
    expect(codesOf(null)).toContain('invalid-node');
    expect(codesOf([])).toContain('invalid-node');
  });

  it('assertViewNode 抛出 ViewError 并带全部问题与路径', () => {
    let caught: unknown;
    try {
      assertViewNode({ tag: 'blink', role: 'nope' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ViewError);
    const err = caught as ViewError;
    expect(err.problems.length).toBeGreaterThanOrEqual(2);
    expect(err.problems.map((p) => p.code)).toContain('unknown-tag');
    expect(err.problems.map((p) => p.code)).toContain('unknown-role');
    expect(err.problems.every((p) => p.path.length > 0)).toBe(true);
  });

  it('序列化器对非法树拒绝渲染', () => {
    const bad = { tag: 'div', style: { paddingDp: 999 } } as unknown as ViewNode;
    expect(() => renderHtml(bad)).toThrow(ViewError);
    expect(() => accessibilityTree(bad)).toThrow(ViewError);
  });

  it('深层路径定位到具体字段', () => {
    const problems = validateViewNode({
      tag: 'div',
      children: [{ tag: 'div', style: { paddingDp: 3 } }],
    });
    expect(problems[0]?.path).toBe('root.children[0].style.paddingDp');
  });
});

// ---------------------------------------------------------------------------
// barrel
// ---------------------------------------------------------------------------

describe('F-I03 / barrel', () => {
  it('三块模块经 index.js 导出且无名字冲突', () => {
    expect(typeof barrel.renderHtml).toBe('function');
    expect(typeof barrel.renderText).toBe('function');
    expect(typeof barrel.accessibilityTree).toBe('function');
    expect(typeof barrel.assertViewNode).toBe('function');
    expect(typeof barrel.styleToCss).toBe('function');
    // export * 若有两处同名，后者会覆盖前者；这里抽查关键符号仍来自预期模块。
    expect(barrel.escapeHtmlAttr('<')).toBe('&lt;');
    expect(barrel.escapeHtmlText('&')).toBe('&amp;');
  });
});
