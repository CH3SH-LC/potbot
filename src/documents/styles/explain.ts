/**
 * "有效属性可解释"（WF-038，合同 R117–R124）。
 *
 * ## 为什么"可解释"是合同要求而不是调试功能
 *
 * 用户在文档里看到的"这段是宋体小四、居中、段前 12 磅"，可能是四种完全不同的来源：
 * 文档默认、某个命名样式、`basedOn` 链上的祖先样式、或用户手点的一次直接格式。
 * 这四种对"我改样式它会不会跟着变"的回答完全不同（R126）。所以 `cascade.ts` 才把
 * `origin` 做成返回值的**结构性组成部分**。本文件做的事，是把它摊平成一张
 * **逐属性、可断言、可展示**的清单：每一个属性值 + "它从哪来"。
 *
 * ## 四种状态在这里怎么落
 *
 * - `set`（显式设置）⇒ `specified: true`，`origin` 指向具体层（R124 的"标明来源层"）；
 * - `unspecified` / `inherit` ⇒ `specified: false`，`origin: null`。
 *   两者在**解析**上等价（`cascade.ts` 的注释已说明）：前者是"本层不表达"，
 *   后者是"删掉本层的覆盖、继续往下继承"。差别在**写码**（不写元素 / 删元素），
 *   不在读。所以解释里它们都表现为"这一层没有贡献值"。
 * - `off`（显式关闭）⇒ `specified: true, value: false`——**不是** `unspecified`（R118）。
 *   这正是解释功能的价值：用户看到"加粗已关闭"，能分清"我手动关的"还是"样式里就没规定"。
 */

import type { ParagraphNode, ParagraphProperties, RunProperties, StyleTable } from '../model/types.js';
import { inheritedParagraphProperties } from './apply.js';
import {
  resolveParagraphCascade,
  type AppliedStyle,
  type PropertyOrigin,
  type ResolvedParagraphProperties,
  type ResolvedValue,
} from './cascade.js';
import { resolveRunCascade, type ResolvedRunProperties } from './run-cascade.js';
import type { StyleProblem } from './chain.js';

/** 一条属性的解释。 */
export interface EffectiveEntry {
  /** 属性路径（如 `indent.firstLine` / `size`）。 */
  readonly property: string;
  /** 是否有任何层贡献了值。`false` = 全部层未设置（由消费端默认决定）。 */
  readonly specified: boolean;
  /** 解析出的值；`specified === false` 时为 `null`。 */
  readonly value: unknown;
  /** 来源层（R124）；`specified === false` 时为 `null`。 */
  readonly origin: PropertyOrigin | null;
  /** 人类可读的一句话（可直接展示给用户）。 */
  readonly description: string;
}

export interface EffectiveExplanation {
  readonly status: 'ok' | 'conflict';
  readonly problems: readonly StyleProblem[];
  /** 参与解析的样式，**根在前**（祖先在前、后代在后）。 */
  readonly applied_chain: readonly AppliedStyle[];
  readonly entries: readonly EffectiveEntry[];
}

/** 把来源层渲染成一句可展示的话。 */
export function describeOrigin(origin: PropertyOrigin | null): string {
  if (origin === null) {
    return '未在任何层设置（由消费端默认决定）';
  }
  switch (origin.layer) {
    case 'document_default':
      return `来自文档默认样式「${origin.style_name ?? origin.style_id ?? '未知'}」`;
    case 'named_style':
      return `来自命名样式「${origin.style_name ?? origin.style_id ?? '未知'}」`;
    case 'direct':
      return '来自直接格式（局部覆盖）';
    default:
      return '来源未知';
  }
}

function entry(property: string, slot: ResolvedValue<unknown>): EffectiveEntry {
  if (!slot.specified) {
    return { property, specified: false, value: null, origin: null, description: describeOrigin(null) };
  }
  return {
    property,
    specified: true,
    value: slot.value,
    origin: slot.origin,
    description: describeOrigin(slot.origin),
  };
}

function paragraphEntries(properties: ResolvedParagraphProperties): readonly EffectiveEntry[] {
  return [
    entry('alignment', properties.alignment),
    entry('lineSpacing', properties.lineSpacing),
    entry('spacingBefore', properties.spacingBefore),
    entry('spacingAfter', properties.spacingAfter),
    entry('indent.left', properties.indent.left),
    entry('indent.right', properties.indent.right),
    entry('indent.firstLine', properties.indent.firstLine),
    entry('indent.hanging', properties.indent.hanging),
    entry('tabStops', properties.tabStops),
    entry('pageBreakBefore', properties.pageBreakBefore),
    entry('keepNext', properties.keepNext),
    entry('keepLines', properties.keepLines),
    entry('widowControl', properties.widowControl),
    entry('borders', properties.borders),
    entry('shading', properties.shading),
    entry('outlineLevel', properties.outlineLevel),
  ];
}

function runEntries(properties: ResolvedRunProperties): readonly EffectiveEntry[] {
  return [
    entry('bold', properties.bold),
    entry('italic', properties.italic),
    entry('underline', properties.underline),
    entry('strike', properties.strike),
    entry('doubleStrike', properties.doubleStrike),
    entry('vertAlign', properties.vertAlign),
    entry('fonts', properties.fonts),
    entry('size', properties.size),
    entry('scale', properties.scale),
    entry('position', properties.position),
    entry('color', properties.color),
    entry('highlight', properties.highlight),
    entry('shading', properties.shading),
    entry('spacing', properties.spacing),
    entry('caps', properties.caps),
    entry('smallCaps', properties.smallCaps),
  ];
}

/** 段落有效属性逐条解释（WF-038）。 */
export function explainParagraphProperties(
  table: StyleTable,
  paragraph: ParagraphNode,
): EffectiveExplanation {
  const cascade = resolveParagraphCascade({
    styles: table,
    style_ref: paragraph.style_ref,
    direct: paragraph.properties,
  });
  return {
    status: cascade.status,
    problems: cascade.problems,
    applied_chain: cascade.applied_chain,
    entries: paragraphEntries(cascade.properties),
  };
}

/**
 * **清除直接格式之后**的有效属性解释（WF-038 的"清除后"一档）。
 *
 * 清除把段落属性全部置为 `inherit`（= 删除这些元素），于是所有有效值只能来自
 * 命名样式 / 文档默认。这条用例的意义是证明"清除不是把属性变成空，而是**交还给样式**"。
 */
export function explainParagraphAfterClearing(
  table: StyleTable,
  paragraph: ParagraphNode,
): EffectiveExplanation {
  return explainParagraphProperties(table, {
    ...paragraph,
    properties: inheritedParagraphProperties(),
  });
}

/** 字符属性逐条解释（WF-038）。`direct` 为该 run 的直接格式。 */
export function explainRunProperties(
  table: StyleTable,
  styleRef: string | null,
  direct: Partial<RunProperties> | null,
): EffectiveExplanation {
  const cascade = resolveRunCascade({ styles: table, style_ref: styleRef, direct });
  return {
    status: cascade.status,
    problems: cascade.problems,
    applied_chain: cascade.applied_chain,
    entries: runEntries(cascade.properties),
  };
}

/** 取某一条属性的解释（没这条属性名则 `null`）。 */
export function findEntry(explanation: EffectiveExplanation, property: string): EffectiveEntry | null {
  return explanation.entries.find((item) => item.property === property) ?? null;
}

/** 把解释压成 `属性名 → 值` 的映射，便于断言与展示。 */
export function specifiedValues(explanation: EffectiveExplanation): ReadonlyMap<string, unknown> {
  const map = new Map<string, unknown>();
  for (const item of explanation.entries) {
    if (item.specified) {
      map.set(item.property, item.value);
    }
  }
  return map;
}

/** 便捷：段落里"哪些属性是直接格式（局部覆盖）压出来的"——用于回答"改样式为何不动它"。 */
export function directOverrides(explanation: EffectiveExplanation): readonly string[] {
  return explanation.entries
    .filter((item) => item.origin?.layer === 'direct')
    .map((item) => item.property);
}

/** 便捷：段落里"哪些属性来自命名样式"——改样式会动这些（R126）。 */
export function styleDrivenProperties(explanation: EffectiveExplanation): readonly string[] {
  return explanation.entries
    .filter((item) => item.origin?.layer === 'named_style')
    .map((item) => item.property);
}

/** 段落属性被清除的判定（全 `inherit`/`unspecified`）——供 evidence 断言用。 */
export function isCleared(properties: ParagraphProperties): boolean {
  const neutral = (state: { readonly state: string }): boolean =>
    state.state === 'inherit' || state.state === 'unspecified';
  return (
    neutral(properties.alignment) &&
    neutral(properties.lineSpacing) &&
    neutral(properties.spacingBefore) &&
    neutral(properties.spacingAfter) &&
    neutral(properties.indent.left) &&
    neutral(properties.indent.right) &&
    neutral(properties.indent.firstLine) &&
    neutral(properties.indent.hanging) &&
    neutral(properties.tabStops) &&
    neutral(properties.pageBreakBefore) &&
    neutral(properties.keepNext) &&
    neutral(properties.keepLines) &&
    neutral(properties.widowControl) &&
    neutral(properties.borders) &&
    neutral(properties.shading) &&
    neutral(properties.outlineLevel)
  );
}
