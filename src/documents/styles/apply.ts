/**
 * 应用命名样式（R125）与修改命名样式（R126）。
 *
 * ## R125：应用样式**只写引用**，不硬化外观
 *
 * 用户点"标题 1"，正确做法是让这一段**指向** Heading1 样式（`w:pStyle`），而不是把
 * "黑体 + 二号 + 加粗 + 段前段后"抄进这一段的直接格式。差别在后果：
 *
 * - 写引用 ⇒ 以后改 Heading1 样式，所有标题**跟着变**（R126）；
 * - 抄外观 ⇒ 文档里留下几百段"长得像标题但不是标题"的段落，改样式一动不动，
 *   而且它们也不进导航窗格/目录（大纲级别来自样式）。
 *
 * 所以 `applyParagraphStyle` 只做一件事：设 `style_ref`。它**不写**任何 `run_properties` /
 * `paragraph_properties`——返回值里根本没有改 `properties` 的那行代码。
 *
 * 顺带一个正确的默认：应用样式时**清除已有的直接格式**（`clearDirectFormat` 默认 `true`）。
 * 否则"这条段落之前手点过居中"，应用"标题 1"后仍然居中，用户会以为样式没生效。
 * 但需注意：这**只清段落直接格式**，不碰字符格式——用户手打的加粗应当保留（WF-034 同类边界）。
 *
 * ## R126：改样式 → 引用段落一致更新
 *
 * 因为段落只存 `style_ref`，改样式表自然就影响所有引用段落——**前提是解析走 cascade**。
 * `updateNamedStyle` 返回新样式表；对同一段落重新跑 `resolveParagraphCascade`，
 * 结果会反映新值。直接格式层依旧压在最上面（R126 的"直接格式覆盖仍生效"）。
 */

import type { StyleDefinition, StyleTable } from '../model/types.js';
import type { ParagraphNode } from '../model/types.js';
import { findStyle } from './chain.js';

/** 应用样式的选项。 */
export interface ApplyStyleOptions {
  /**
   * 是否清除段落已有的**直接格式**。默认 `true`——否则旧的手动格式会压住新样式，
   * 用户看见"应用了样式但没变化"。**只清段落格式，不清字符格式。**
   */
  readonly clearDirectFormat?: boolean;
}

/**
 * 把命名样式应用到段落（R125）。
 *
 * **只设置 `style_ref`。** 不把样式的外观写进段落的直接格式——外观由 cascade 在读取时算。
 *
 * `clearDirectFormat` 为 `true`（默认）时，段落的直接段落格式被清成"未指定"，
 * 让样式能透出来；字符格式与正文内容一律不动。
 */
export function applyParagraphStyle(
  paragraph: ParagraphNode,
  styleId: string,
  options: ApplyStyleOptions = {},
): ParagraphNode {
  const clearDirectFormat = options.clearDirectFormat ?? true;
  return {
    ...paragraph,
    style_ref: styleId,
    properties: clearDirectFormat ? inheritedParagraphProperties() : paragraph.properties,
  };
}

/**
 * "清除覆盖"态的段落属性：每个字段都是 `inherit`。
 *
 * 用 `inherit`（写码层动作 = **删除**已有元素）而不是 `unspecified`（动作 = 不写元素）：
 * 应用样式时这段段落**此前很可能已经有** `<w:jc/>`、`<w:spacing/>` 等直接格式元素，
 * 必须真的删掉，否则用户会看到"应用了标题 1 但这一段还是居中"。
 *
 * 本函数与 `operations/paragraph/defaults.ts` 的 `createInheritedParagraphProperties` 同义。
 * **刻意不跨包 import**：`styles` 包是解析层，不应依赖 `operations` 包（否则层次倒置）。
 * 两处都是"把一个已知的固定结构填满 `inherit`"，语义由模型定义，不存在两套换算。
 */
export function inheritedParagraphProperties(): ParagraphNode['properties'] {
  const inherit = { state: 'inherit' } as const;
  return {
    alignment: inherit,
    lineSpacing: inherit,
    spacingBefore: inherit,
    spacingAfter: inherit,
    indent: { left: inherit, right: inherit, firstLine: inherit, hanging: inherit },
    tabStops: inherit,
    pageBreakBefore: inherit,
    keepNext: inherit,
    keepLines: inherit,
    widowControl: inherit,
    borders: inherit,
    shading: inherit,
    outlineLevel: inherit,
  };
}

/** 修改命名样式的结果。 */
export type StyleUpdateResult =
  | { readonly ok: true; readonly table: StyleTable }
  | { readonly ok: false; readonly reason: string };

/**
 * 修改一个命名样式（R126）。返回**新样式表**（不可变更新），原表不动。
 *
 * 不校验 `patch` 里的样式语义（如 `basedOn` 是否成环）——那是 `resolveStyleChain` 在读时
 * 负责检出的（R123）。这里只保证：改一定成功或明确失败，且**不产生第二个同名样式**。
 */
export function updateNamedStyle(
  table: StyleTable,
  styleId: string,
  patch: Partial<Omit<StyleDefinition, 'style_id'>>,
): StyleUpdateResult {
  const target = findStyle(table, styleId);
  if (target === null) {
    return { ok: false, reason: `样式 '${styleId}' 不存在，无法修改` };
  }
  const updated: StyleDefinition = { ...target, ...patch, style_id: styleId };
  return {
    ok: true,
    table: {
      ...table,
      styles: table.styles.map((style) => (style.style_id === styleId ? updated : style)),
    },
  };
}

/** 列出样式（可按类型过滤）。顺序保持样式表原序（导入顺序）。 */
export function listStyles(
  table: StyleTable,
  type?: StyleDefinition['type'],
): readonly StyleDefinition[] {
  return type === undefined ? table.styles : table.styles.filter((style) => style.type === type);
}

/**
 * 找出引用了某样式的段落数（R126 的影响面）。
 *
 * 只是查询——用于"改这个样式会影响 N 段"的提示。引用靠 `style_ref`，**不看外观**。
 */
export function countParagraphsUsingStyle(blocks: readonly ParagraphNode[], styleId: string): number {
  return blocks.filter((block) => block.style_ref === styleId).length;
}
