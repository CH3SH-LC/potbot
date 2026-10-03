/**
 * 清除 / 复制段落格式（WF-034）。
 *
 * ## 「清除段落格式」清什么、不清什么
 *
 * 清：段落**直接格式**（`pPr`）——对齐、行距、段距、缩进、制表位、分页控制、边框、底纹、
 * 大纲级别。清完这一段回落到**它自己的命名样式**。
 *
 * **不清**：
 * - **命名样式引用**（`style_ref`）。用户要的是"恢复段落样式"，不是"变成无样式的正文"。
 *   把 `style_ref` 一起清掉，标题就变正文了——那是另一种操作。
 * - **正文内容**（R120：两种清除都不删正文）。
 * - **字符直接格式**（run 的加粗、颜色、字号）。这是 WF-034 明确要求的"不误清字符局部强调"，
 *   也是 R120"清字符格式与清段落格式作用域不同"。本函数的返回值类型里**没有 run**，
 *   所以它在类型层面就不可能碰到字符格式。
 *
 * ## 「复制段落格式」= 段落格式刷
 *
 * 语义对齐 Word 的格式刷：把源段落的段落格式复制到目标段落，**目标段落的正文内容不变**。
 * 默认**连同命名样式引用一起复制**（Word 的格式刷确实会连样式一起刷过去）；
 * 只想复制直接格式时传 `{ includeStyleRef: false }`。
 *
 * 复制的是**深拷贝**：复制之后两段的 `indent` / `tabStops` 不再共享对象，
 * 改一段不会影响另一段。
 */

import type { ParagraphNode, ParagraphProperties } from '../../model/types.js';
import { createInheritedParagraphProperties } from './defaults.js';
import { cloneParagraphProperties } from './clone.js';

export { cloneParagraphProperties } from './clone.js';

/**
 * 清除段落的直接格式（WF-034）。
 *
 * 返回新段落：属性全部为"清除覆盖"（`inherit`），正文 run **原样保留**（同一个数组引用），
 * `style_ref` 与 `numbering` 保持——列表段清完格式后仍在列表里，不会丢编号（WF-028 同类要求）。
 */
export function clearParagraphFormat(paragraph: ParagraphNode): ParagraphNode {
  return { ...paragraph, properties: createInheritedParagraphProperties() };
}

/** 复制段落格式的选项。 */
export interface CopyParagraphFormatOptions {
  /**
   * 是否连**命名样式引用**一起复制。默认 `true`（对齐 Word 格式刷）。
   * 设 `false` 时只复制直接格式，目标段落保留自己的 `style_ref`。
   */
  readonly includeStyleRef?: boolean;
  /** 是否连**列表上下文**一起复制。默认 `false`——把正文段落刷成列表项通常是意外。 */
  readonly includeNumbering?: boolean;
}

/**
 * 复制段落格式（WF-034）：源 → 目标。
 *
 * 目标段落的 `inlines`（正文）与 `id` 均**不变**；只有格式相关的字段被替换。
 * 传入的 `properties` 是**深拷贝**，因此两段之后各自独立。
 */
export function copyParagraphFormat(
  source: ParagraphNode,
  target: ParagraphNode,
  options: CopyParagraphFormatOptions = {},
): ParagraphNode {
  const includeStyleRef = options.includeStyleRef ?? true;
  const includeNumbering = options.includeNumbering ?? false;
  return {
    ...target,
    properties: cloneParagraphProperties(source.properties),
    style_ref: includeStyleRef ? source.style_ref : target.style_ref,
    numbering: includeNumbering ? source.numbering : target.numbering,
  };
}

/** 只复制**直接格式**、不带样式引用的快捷入口（`includeStyleRef: false` 的简写）。 */
export function copyDirectParagraphFormat(source: ParagraphNode, target: ParagraphNode): ParagraphNode {
  return copyParagraphFormat(source, target, { includeStyleRef: false });
}

/**
 * 判断段落是否处于"已清除直接格式"状态（属性全为 `inherit` 或 `unspecified`）。
 *
 * 供 WF-034 的"操作后状态"断言用：清除后再清除，结果应当稳定（幂等，R137）。
 */
export function hasNoDirectParagraphFormat(properties: ParagraphProperties): boolean {
  const isNeutral = (state: { readonly state: string }): boolean =>
    state.state === 'inherit' || state.state === 'unspecified';
  return (
    isNeutral(properties.alignment) &&
    isNeutral(properties.lineSpacing) &&
    isNeutral(properties.spacingBefore) &&
    isNeutral(properties.spacingAfter) &&
    isNeutral(properties.indent.left) &&
    isNeutral(properties.indent.right) &&
    isNeutral(properties.indent.firstLine) &&
    isNeutral(properties.indent.hanging) &&
    isNeutral(properties.tabStops) &&
    isNeutral(properties.pageBreakBefore) &&
    isNeutral(properties.keepNext) &&
    isNeutral(properties.keepLines) &&
    isNeutral(properties.widowControl) &&
    isNeutral(properties.borders) &&
    isNeutral(properties.shading) &&
    isNeutral(properties.outlineLevel)
  );
}
