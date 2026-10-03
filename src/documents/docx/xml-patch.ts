/**
 * 「**按槽位改写一个既有元素的子节点**」——R105（未知内容保留）在部件重建里的实现核心。
 *
 * ## 为什么不能"按模型重建整棵树"
 *
 * `word/styles.xml` / `word/numbering.xml` 里有大量**模型没有建模**的内容：
 *
 * | 部件 | 未建模的东西（举例） |
 * |---|---|
 * | `styles.xml` | `w:docDefaults`、`w:latentStyles`、每个 `w:style` 里的 `w:uiPriority` / `w:qFormat` / `w:next` / `w:link`、`w:pPr` 里的 `w:numPr`、`w:style` 上的 `w:default` 属性 |
 * | `numbering.xml` | `w:numPicBullet`、`w:numIdMacAtCleanup`、`w:lvl` 里的 `w:legacy` / `w:tentative` / `w:rPr@w:hint` |
 *
 * 若按"模型 → 新树"重建，上面**每一条都会静默消失**——这正是 R105 禁止的事。
 * 因此重建走**补丁**：保留原树的一切，只把"模型确实表达了的槽位"替换成新值。
 *
 * ## 两条纪律
 *
 * 1. **未建模的子节点原样保留在原位**（连顺序一起）。它们的相对次序用"游标"维持：
 *    遇到已知元素就把游标设为它的 schema 位次，遇到未知元素就 `游标 + 微小增量`——
 *    于是"未知元素永远跟在它原来前面那个已知元素之后"，插进来的模型槽位落在正确的 schema 槽。
 * 2. **只认自己命名空间里的元素**：`w:` 前缀是约定，判据是**命名空间 URI**（`xml-parse`
 *    已按作用域解析）。`mc:AlternateContent` 之类的外来元素因此永远不会被误当成模型槽位。
 */

import { attr, el, type XmlElement, type XmlNode } from '../../artifacts/ooxml/xml.js';
import { W_NS } from './word-xml.js';
import type { ParsedXmlElement } from './xml-parse.js';

/** `ParsedXmlElement` → 可写出的 `XmlElement`（名字、属性顺序、文本都保序）。 */
export function convertParsedElement(element: ParsedXmlElement): XmlElement {
  return el(
    element.name,
    element.attributes.map((attribute) => attr(attribute.name, attribute.value)),
    element.children.map((child) =>
      child.kind === 'text' ? child.value : convertParsedElement(child),
    ),
  );
}

/**
 * 一个"模型表达了的槽位"：本地名 + 重建后的元素（`null` = 本次不产出，即删除）+ schema 位次。
 *
 * `rank` 由调用方给（各自部件的 schema 顺序表），**同一份调用里不得重复**。
 */
export interface ModeledSlot {
  /** 本地名（不带前缀），如 `pPr` / `rPr` / `name`。 */
  readonly name: string;
  /** 重建后的元素；`null` 表示"这个槽位在模型里不存在"（原树里有的话要删掉）。 */
  readonly element: XmlElement | null;
  /** schema 顺序位次（小者在前）。 */
  readonly rank: number;
}

/** 位次查询：已知本地名 → 位次；不认识返回 `null`（调用方据此走"游标"分支）。 */
export type ChildRankLookup = (localName: string) => number | null;

/** 未知元素插进游标时用的步长：足够小，保证不会跨过一个整数位次。 */
const CURSOR_STEP = 0.001;

/**
 * 用一个"槽位表"改写既有元素的子节点。
 *
 * - 原树里的槽位名元素 ⇒ 被 `slot.element` **原地替换**（`null` ⇒ 删除）；
 * - 原树里其余元素 ⇒ 原样保留，位次按游标规则给出；
 * - 槽位表里原树**没有**的元素 ⇒ 按 `rank` 插入（只在 `element !== null` 时）；
 * - 最后按位次稳定排序（`Array#sort` 自 ES2019 起是稳定排序）。
 *
 * 返回值即该元素**新的**子节点列表。
 */
export function patchChildren(
  original: ParsedXmlElement,
  slots: readonly ModeledSlot[],
  rankOf: ChildRankLookup,
): XmlNode[] {
  const byName = new Map<string, ModeledSlot>();
  for (const slot of slots) byName.set(slot.name, slot);

  const placed = new Set<string>();
  const ranked: { readonly rank: number; readonly node: XmlNode }[] = [];
  let cursor = 0;

  for (const child of original.children) {
    if (child.kind !== 'element') {
      cursor += CURSOR_STEP;
      ranked.push({ rank: cursor, node: child.value });
      continue;
    }
    const slot = child.namespace === W_NS ? byName.get(child.localName) : undefined;
    if (slot !== undefined) {
      placed.add(slot.name);
      cursor = slot.rank;
      if (slot.element !== null) ranked.push({ rank: slot.rank, node: slot.element });
      continue;
    }
    const known = child.namespace === W_NS ? rankOf(child.localName) : null;
    cursor = known ?? cursor + CURSOR_STEP;
    ranked.push({ rank: cursor, node: convertParsedElement(child) });
  }

  for (const slot of slots) {
    if (!placed.has(slot.name) && slot.element !== null) {
      ranked.push({ rank: slot.rank, node: slot.element });
    }
  }

  ranked.sort((left, right) => left.rank - right.rank);
  return ranked.map((entry) => entry.node);
}

/** 该元素是不是 `w:` 命名空间下、本地名为 `localName` 的元素。 */
export function isWordElement(node: XmlNode, localName: string): boolean {
  return typeof node !== 'string' && node.name === `w:${localName}`;
}

/** 元素是不是 `w:` 命名空间下、本地名为 `localName` 的**解析态**元素。 */
export function isParsedWordElement(element: ParsedXmlElement, localName: string): boolean {
  return element.namespace === W_NS && element.localName === localName;
}
