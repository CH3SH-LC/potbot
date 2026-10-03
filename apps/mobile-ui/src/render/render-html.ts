/**
 * F-I03 render —— **确定性 HTML 字符串序列化器**。
 *
 * 把 `ViewNode` 树序列化为 HTML 字符串：零依赖、无 DOM、无框架，纯函数。三条硬约束：
 *
 *   1. **转义正确**：文本上下文转义 `& < >`；属性上下文额外转义 `" '`。
 *      任何来自用户的字符串（标题、名称、data）都不能逃出所属上下文。
 *   2. **确定性 / 逐字节可复现**：属性按固定顺序输出，样式声明按固定（字母序）顺序输出，
 *      不依赖对象插入顺序；给定同一棵树，输出字节完全一致（byte-stable）。
 *   3. **fail-closed**：入口先 `assertViewNode`；非法树（未知标签/角色/样式键、
 *      `onclick` 之类属性、不安全 href、text+children 并存）直接抛 `ViewError`，
 *      绝不"尽力渲染"出一个半成品。
 *
 * 色值一律输出为 CSS 变量引用（`var(--pb-color-<name>)`），与 `foundation.css` /
 * F01 `colorCssVariables()` 同源，渲染层不写死任何十六进制颜色。
 */

import { typography } from '../foundation/tokens.js';
import {
  ARIA_ROLE,
  isVoidTag,
  assertViewNode,
  type StyleTokens,
  type ViewNode,
} from './view.js';

/** 字号令牌表（键已由 view.ts 的校验保证）。 */
const TYPO_SCALE: Readonly<Record<string, { readonly sizeSp: number }>> = typography.scale;

/** 序列化选项。默认值固定，保证默认输出稳定。 */
export interface RenderHtmlOptions {
  /** 每层缩进单位，默认两个空格。 */
  readonly indentUnit?: string;
  /** 行分隔符，默认 `\n`。 */
  readonly newline?: string;
}

/**
 * 属性输出顺序（固定）。按属性名字母序，与节点上属性的书写顺序无关。
 * `style` 排最后，避免与其它属性混读。
 */
export const HTML_ATTR_ORDER: readonly string[] = [
  'aria-hidden',
  'aria-label',
  'class',
  'href',
  'id',
  'role',
  'style',
  'title',
];

/**
 * 样式声明输出顺序（固定，按 CSS 属性名字母序）。
 * 同一组样式令牌无论以何种顺序书写，输出一致。
 */
export const CSS_ORDER: readonly string[] = [
  'background-color',
  'border-color',
  'border-radius',
  'color',
  'font-size',
  'font-weight',
  'gap',
  'padding',
];

/** 转义 HTML **文本**上下文：`& < >`。 */
export function escapeHtmlText(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

/** 转义 HTML **属性值**上下文：`& < > " '`。 */
export function escapeHtmlAttr(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

/**
 * 样式令牌 -> CSS 声明串（`; ` 分隔，无尾分号）。
 * 颜色输出 `var(--pb-color-<name>)`；字号输出 `<sizeSp>px`；间距/圆角输出 `<n>px`。
 * 声明顺序由 `CSS_ORDER` 固定。
 */
export function styleToCss(style: StyleTokens): string {
  const decls = new Map<string, string>();
  if (style.background !== undefined) decls.set('background-color', colorVar(style.background));
  if (style.borderColor !== undefined) decls.set('border-color', colorVar(style.borderColor));
  if (style.radiusDp !== undefined) decls.set('border-radius', `${style.radiusDp}px`);
  if (style.color !== undefined) decls.set('color', colorVar(style.color));
  if (style.fontSize !== undefined) decls.set('font-size', `${fontSizePx(style.fontSize)}px`);
  if (style.fontWeight !== undefined) decls.set('font-weight', String(style.fontWeight));
  if (style.gapDp !== undefined) decls.set('gap', `${style.gapDp}px`);
  if (style.paddingDp !== undefined) decls.set('padding', `${style.paddingDp}px`);

  const ordered: string[] = [];
  for (const prop of CSS_ORDER) {
    const value = decls.get(prop);
    if (value !== undefined) ordered.push(`${prop}: ${value}`);
  }
  return ordered.join('; ');
}

/** `--pb-color-<name>` CSS 变量引用。与 F01 `colorCssVariables()` 同源。 */
function colorVar(name: string): string {
  return `var(--pb-color-${name})`;
}

/** 字号角色 -> sp 数值（取自 token，渲染层不写死）。 */
function fontSizePx(name: string): number {
  // 令牌已在校验阶段确认存在；这里直接读取，缺则抛错而不是静默 NaN。
  const scale = TYPO_SCALE[name];
  if (scale === undefined) throw new Error(`未登记的字号角色: ${name}`);
  return scale.sizeSp;
}

/** 收集节点的属性对（已按 `HTML_ATTR_ORDER` 排好，值已转义）。 */
function collectAttrs(node: ViewNode): readonly (readonly [string, string])[] {
  const raw = new Map<string, string>();

  const role = node.role;
  if (role !== undefined) {
    const aria = ARIA_ROLE[role];
    if (aria !== null) raw.set('role', aria);
  }
  if (node.ariaLabel !== undefined) raw.set('aria-label', node.ariaLabel);
  // 装饰性图片默认对读屏隐藏；显式 ariaHidden 优先。
  const hidden = node.ariaHidden ?? (node.role === 'decorative-image');
  if (hidden) raw.set('aria-hidden', 'true');
  if (node.style !== undefined) raw.set('style', styleToCss(node.style));
  if (node.attrs !== undefined) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (value !== undefined) raw.set(key, value);
    }
  }

  const out: (readonly [string, string])[] = [];
  for (const name of HTML_ATTR_ORDER) {
    const value = raw.get(name);
    if (value !== undefined) out.push([name, escapeHtmlAttr(value)]);
  }
  return out;
}

function startTag(node: ViewNode): string {
  const attrs = collectAttrs(node)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  return `<${node.tag}${attrs}>`;
}

/**
 * 把一棵视图树序列化为 HTML 字符串。
 *
 * - 空元素（`img/input/br/hr`）输出 `<tag ...>`，无闭合标签；
 * - 叶子（有 text）输出单行 `<tag ...>转义文本</tag>`；
 * - 空容器输出单行 `<tag ...></tag>`；
 * - 有子节点的容器：开标签、缩进的子节点、闭标签，各占一行。
 * 输出**不含**尾随换行。
 */
export function renderHtml(root: ViewNode, options: RenderHtmlOptions = {}): string {
  assertViewNode(root);
  const indentUnit = options.indentUnit ?? '  ';
  const nl = options.newline ?? '\n';
  const lines: string[] = [];

  const walk = (node: ViewNode, depth: number): void => {
    const pad = indentUnit.repeat(depth);
    const open = startTag(node);
    if (isVoidTag(node.tag)) {
      lines.push(`${pad}${open}`);
      return;
    }
    const children = node.children ?? [];
    if (children.length === 0) {
      const inner = node.text === undefined ? '' : escapeHtmlText(node.text);
      lines.push(`${pad}${open}${inner}</${node.tag}>`);
      return;
    }
    lines.push(`${pad}${open}`);
    for (const child of children) walk(child, depth + 1);
    lines.push(`${pad}</${node.tag}>`);
  };

  walk(root, 0);
  return lines.join(nl);
}
