/**
 * 从结构里**读回**语义部件（WF-091 的核心判据）。
 *
 * 判据原文是"分式/根式的表示里能读出分子分母/被开方数，**不是**一个 `DrawingNode` 图片"。
 * 本文件就是那句话的可执行形式：四个存取器直接命中结构树的对应分支，
 * 图片节点（`kind === 'drawing'`）在这里**什么也读不出来**——因为它没有 `kind: 'fraction'`。
 *
 * `mathText` 另给一个**给人看的**线性投影（`(1)/(2)`、`√(x+1)`、`x^2`），
 * 供回执与日志用。它**不是**解析入口（解析在 `parse.ts`）——投影只保证可读，不保证可逆。
 */

import type { MathNode } from './types.js';

/** 分式的分子；不是分式则为 `null`。 */
export function numeratorOf(node: MathNode): MathNode | null {
  return node.kind === 'fraction' ? node.numerator : null;
}

/** 分式的分母；不是分式则为 `null`。 */
export function denominatorOf(node: MathNode): MathNode | null {
  return node.kind === 'fraction' ? node.denominator : null;
}

/** 根式的被开方数；不是根式则为 `null`。 */
export function radicandOf(node: MathNode): MathNode | null {
  return node.kind === 'radical' ? node.radicand : null;
}

/** 根式的次数；不是根式或为平方根则为 `null`。 */
export function degreeOf(node: MathNode): MathNode | null {
  return node.kind === 'radical' ? node.degree : null;
}

/** 上下标的底数；不是上下标则为 `null`。 */
export function baseOf(node: MathNode): MathNode | null {
  return node.kind === 'script' ? node.base : null;
}

/** 上标；没有则为 `null`。 */
export function superscriptOf(node: MathNode): MathNode | null {
  return node.kind === 'script' ? node.sup : null;
}

/** 下标；没有则为 `null`。 */
export function subscriptOf(node: MathNode): MathNode | null {
  return node.kind === 'script' ? node.sub : null;
}

/** run 的文本；不是 run 则为 `null`。 */
export function runTextOf(node: MathNode): string | null {
  return node.kind === 'math_run' ? node.text : null;
}

/** 序列的项；不是序列则为 `null`（`[]` 与非序列要能区分开）。 */
export function sequenceItemsOf(node: MathNode): readonly MathNode[] | null {
  return node.kind === 'sequence' ? node.items : null;
}

/** 复合子结构在需要时加括号（单项序列不加，避免 `(x)^2` 这种噪音）。 */
function bracket(node: MathNode): string {
  if (node.kind === 'sequence' && node.items.length > 1) return `(${mathText(node)})`;
  if (node.kind === 'fraction') return `(${mathText(node)})`;
  return mathText(node);
}

/** 结构的线性可读投影（**仅供人读**，不可逆，不参与任何解析）。 */
export function mathText(node: MathNode): string {
  switch (node.kind) {
    case 'math_run':
      return node.text;
    case 'sequence':
      return node.items.map((item) => mathText(item)).join(' ');
    case 'fraction':
      return `(${mathText(node.numerator)})/(${mathText(node.denominator)})`;
    case 'radical':
      return node.degree === null
        ? `√(${mathText(node.radicand)})`
        : `(${mathText(node.degree)})√(${mathText(node.radicand)})`;
    case 'script': {
      const base = bracket(node.base);
      const sub = node.sub === null ? '' : `_${bracket(node.sub)}`;
      const sup = node.sup === null ? '' : `^${bracket(node.sup)}`;
      return `${base}${sub}${sup}`;
    }
  }
}

/** 结构里的全部文本 run 按出现顺序拼起来（做"公式里有哪些字"这类统计用）。 */
export function mathPlainText(node: MathNode): string {
  switch (node.kind) {
    case 'math_run':
      return node.text;
    case 'sequence':
      return node.items.map((item) => mathPlainText(item)).join('');
    case 'fraction':
      return mathPlainText(node.numerator) + mathPlainText(node.denominator);
    case 'radical':
      return (node.degree === null ? '' : mathPlainText(node.degree)) + mathPlainText(node.radicand);
    case 'script':
      return (
        mathPlainText(node.base) +
        (node.sub === null ? '' : mathPlainText(node.sub)) +
        (node.sup === null ? '' : mathPlainText(node.sup))
      );
  }
}

/** 结构树的节点总数（含自身；用于"这个公式有多复杂"与容量评估）。 */
export function mathNodeCount(node: MathNode): number {
  switch (node.kind) {
    case 'math_run':
      return 1;
    case 'sequence':
      return 1 + node.items.reduce((sum, item) => sum + mathNodeCount(item), 0);
    case 'fraction':
      return 1 + mathNodeCount(node.numerator) + mathNodeCount(node.denominator);
    case 'radical':
      return 1 + mathNodeCount(node.radicand) + (node.degree === null ? 0 : mathNodeCount(node.degree));
    case 'script':
      return (
        1 +
        mathNodeCount(node.base) +
        (node.sub === null ? 0 : mathNodeCount(node.sub)) +
        (node.sup === null ? 0 : mathNodeCount(node.sup))
      );
  }
}

/** 结构树的最大嵌套深度（根为 1）。 */
export function mathDepth(node: MathNode): number {
  switch (node.kind) {
    case 'math_run':
      return 1;
    case 'sequence':
      return 1 + node.items.reduce((max, item) => Math.max(max, mathDepth(item)), 0);
    case 'fraction':
      return 1 + Math.max(mathDepth(node.numerator), mathDepth(node.denominator));
    case 'radical':
      return 1 + Math.max(mathDepth(node.radicand), node.degree === null ? 0 : mathDepth(node.degree));
    case 'script':
      return (
        1 +
        Math.max(
          mathDepth(node.base),
          node.sub === null ? 0 : mathDepth(node.sub),
          node.sup === null ? 0 : mathDepth(node.sup),
        )
      );
  }
}
