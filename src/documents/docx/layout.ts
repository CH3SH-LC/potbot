/**
 * **未建模片段的布局映射**（归属 WCF-D02）。
 *
 * ## 问题
 *
 * `NodeBase.opaque: readonly unknown[]`（冻结模型给的字段）要求"未能建模的 XML 片段原样保留"（R105）。
 * 但只留一段裸 XML 是不够的：`<w:bookmarkStart/>` 出现在**哪个 run 之前**、`<w:sdt>` 出现在
 * **第几段之前**，决定了它写回去时落在哪里。位置丢了，"保留"就成了"搬到一个新地方"。
 *
 * ## 表示
 *
 * 每个片段记成一个**带锚点**的对象，锚点是"它排在容器的第几个模型子节点之前"：
 *
 * | 片段所在容器 | 项 | 锚点含义 |
 * |---|---|---|
 * | 段落 | `raw_before_node` | **行内节点**序号（run / 软换行 / 域） |
 * | 单元格 / 表格 / 行 | `raw_before_node` | **块 / 行 / 单元格**序号 |
 * | 段落（承载 body 级片段时） | `raw_before_block` | **文档块**序号 |
 * | run | `raw_at_char` | **文本字符**偏移 |
 *
 * 锚点相同时按数组顺序依次写出，因此"连续三个未建模兄弟"不会被重排。
 *
 * ## 为什么用"第几个模型子节点之前"而不是"原始下标"
 *
 * 原始下标会随"run 被拆成 run + 软换行"这类**一对多**映射而失效（一个 `<w:r>` 可能产出
 * 多个模型节点，原始下标到模型下标的换算就不再是一一对应）。用"模型子节点序号"则天然与
 * 模型数组对齐：导出时按模型顺序走一遍，遇到锚点等于当前序号就把片段插进去。
 */

import type { NodeBase } from '../model/types.js';

/** 片段排在容器的第 `before` 个模型子节点之前（`before` 等于子节点总数即"排在最后"）。 */
export interface RawBeforeNode {
  readonly kind: 'raw_before_node';
  /** 未建模片段的 XML 原文（由 `xml-parse` 序列化，属性顺序与文本原样）。 */
  readonly xml: string;
  readonly before: number;
}

/** 片段排在文档第 `before` 个**块**之前（承载 body 级未建模兄弟元素）。 */
export interface RawBeforeBlock {
  readonly kind: 'raw_before_block';
  readonly xml: string;
  readonly before: number;
}

/** 片段排在 run 文本的第 `offset` 个字符之前（承载 `w:drawing` / `w:fldChar` 等非文本子元素）。 */
export interface RawAtChar {
  readonly kind: 'raw_at_char';
  readonly xml: string;
  readonly offset: number;
}

/** 段落属性里的节引用：`w:pPr/w:sectPr` → `sections[index]`。 */
export interface SectionIndex {
  readonly kind: 'section_index';
  readonly index: number;
}

/** 布局映射项的全部形态。 */
export type LayoutItem = RawBeforeNode | RawBeforeBlock | RawAtChar | SectionIndex;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 只要带 `opaque` 就行——不限定节点种类（run / 段落 / 表格 / 行 / 单元格都用同一套锚点）。 */
export interface OpaqueBearer {
  readonly opaque: readonly unknown[];
}

/** 过滤出某一形态的布局项（**按数组顺序**，即写入顺序）。 */
export function layoutItems<K extends LayoutItem['kind']>(
  node: OpaqueBearer,
  kind: K,
): readonly Extract<LayoutItem, { kind: K }>[] {
  const result: Extract<LayoutItem, { kind: K }>[] = [];
  for (const item of node.opaque) {
    if (isRecord(item) && item['kind'] === kind) {
      result.push(item as unknown as Extract<LayoutItem, { kind: K }>);
    }
  }
  return result;
}

/**
 * 收集文档级未建模片段。
 *
 * body 级片段没有自己的容器（`DocumentModel` 没有文档级 `opaque` 字段，而该文件已冻结），
 * 因此按约定挂在**某个块的 `opaque`** 上，用 `raw_before_block` 标出它在**文档块序列**里的位置。
 * 本函数把所有块上的这些片段收集起来并按锚点稳定排序（同锚点保持收集顺序）。
 */
export function collectDocumentLevelRaws(nodes: readonly OpaqueBearer[]): readonly RawBeforeBlock[] {
  const collected: RawBeforeBlock[] = [];
  for (const node of nodes) collected.push(...layoutItems(node, 'raw_before_block'));
  return collected
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.before - right.item.before || left.index - right.index)
    .map((entry) => entry.item);
}

/** 某个块是否承载了文档级片段（导入时用于判断，导出时不需要）。 */
export function carriesDocumentLevelRaw(node: OpaqueBearer): boolean {
  return layoutItems(node, 'raw_before_block').length > 0;
}
