/**
 * F-I03 render —— **文本 / 可访问性序列化器**。
 *
 * 把 `ViewNode` 树转成两层东西，供 a11y（读屏/审计）与 shell 的文本快照消费：
 *
 *   1. `accessibilityTree(view)` —— 与 `view` 同构的可访问性节点树，每个节点带
 *      确定性 `path`（形如 `0.2.1`）、推导后的 `role`、可访问名称 `label`、以及
 *      是否对读屏隐藏 `hidden`。角色推导只在 `view.ts` 里定义一次，避免两处漂移。
 *   2. `renderText(view)` —— 上述树的**逐行文本**表示（每节点一行、按深度缩进）。
 *      这是 `render-html.ts` 之外的、不看 HTML 的可读快照，也是 a11y 的"朗读顺序"
 *      近似：文档顺序、装饰性元素跳过。
 *
 * 与 HTML 序列化器的关键差别：**文本层不做 HTML 转义**——它输出的是给人和读屏看的
 * 纯文本，`<b>` 会原样出现，而不是 `&lt;b&gt;`。
 *
 * 确定性：名称里的空白折叠为单个空格并去除首尾，保证一行一节点、可逐字节复现。
 */

import { assertViewNode, defaultRoleForTag, type ViewNode, type ViewRole } from './view.js';

/** 可访问性节点：`ViewNode` 在"读屏视角"下的投影。 */
export interface AccessNode {
  /** 从根起的确定性路径，形如 `0.2.1`（根为 `0`）。 */
  readonly path: string;
  /** 深度（根为 0）。 */
  readonly depth: number;
  /** 语义角色（显式 `role` 优先，否则由标签推导）。 */
  readonly role: ViewRole;
  /** 可访问名称：`ariaLabel` 优先，否则 `text`，再折叠空白；无则空串。 */
  readonly label: string;
  /** 是否对读屏隐藏（装饰性）：`ariaHidden === true` 或角色为 `decorative-image`。 */
  readonly hidden: boolean;
  readonly children: readonly AccessNode[];
}

/** 折叠空白并去首尾，保证一行一节点、输出确定。 */
export function normalizeLabel(value: string | undefined): string {
  if (value === undefined) return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** 节点是否对读屏隐藏。 */
export function isHidden(node: ViewNode): boolean {
  return node.ariaHidden === true || node.role === 'decorative-image';
}

/** 把视图树投影为可访问性节点树（纯函数，不改输入）。 */
export function accessibilityTree(root: ViewNode): AccessNode {
  assertViewNode(root);

  const walk = (node: ViewNode, path: string, depth: number): AccessNode => {
    const children = node.children ?? [];
    return {
      path,
      depth,
      role: node.role ?? defaultRoleForTag(node.tag),
      label: normalizeLabel(node.ariaLabel ?? node.text),
      hidden: isHidden(node),
      children: children.map((child, i) => walk(child, `${path}.${i}`, depth + 1)),
    };
  };

  return walk(root, '0', 0);
}

/** 文本序列化选项。 */
export interface RenderTextOptions {
  /** 每层缩进单位，默认两个空格。 */
  readonly indentUnit?: string;
  /** 行分隔符，默认 `\n`。 */
  readonly newline?: string;
}

/**
 * 把视图树序列化为逐行可访问性文本。
 *
 * 行格式：`<缩进><role>` 或 `<缩进><role>: <label>`（label 为空时省略冒号）。
 * 文档顺序输出；`hidden` 的节点及其子树整体跳过（读屏不朗读装饰元素）。
 * 输出**不含**尾随换行。
 */
export function renderText(root: ViewNode, options: RenderTextOptions = {}): string {
  const indentUnit = options.indentUnit ?? '  ';
  const nl = options.newline ?? '\n';
  const tree = accessibilityTree(root);
  const lines: string[] = [];

  const walk = (node: AccessNode): void => {
    if (node.hidden) return;
    const pad = indentUnit.repeat(node.depth);
    lines.push(node.label.length > 0 ? `${pad}${node.role}: ${node.label}` : `${pad}${node.role}`);
    for (const child of node.children) walk(child);
  };
  walk(tree);

  return lines.join(nl);
}
