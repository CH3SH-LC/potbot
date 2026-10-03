/**
 * 演示域**页脚 / 日期 / 页码占位符注入导入幻灯片**（集成增量 I06；承接 P07 留下的缺口）。
 *
 * ## 缺口是什么
 *
 * `notes.ts` 的 `renderFooterShapesXml` 能造出页脚 / 日期 / 页码三个 `p:sp` 的 XML **片段**，
 * 但它只返回字符串——**把片段接进哪一页幻灯片的 `p:spTree`、接在什么位置、形状 id 怎么避让既有
 * 形状**，此前没有任何导出函数负责。对"整份文稿由我们渲染"的场景，接线方是 `render.ts`；对
 * **导入既有文件之后的某页要显示页脚 / 页码**，这一段是空的。
 *
 * 本层补这一段：`injectDeckFooterPlaceholders` 把片段写进指定幻灯片部件，做到：
 *
 * - **位置合法**：追加在根 `p:spTree` 收尾之前（形状树前导 `p:nvGrpSpPr` / `p:grpSpPr` 保持不变）；
 * - **id 唯一**：分配 `p:cNvPr@id = 当前页最大 id + 1…`，不与既有形状撞号；
 * - **可重复**：注入前先撤掉本页既有的 `dt` / `ftr` / `sldNum` 占位符，同一配置重复注入结果稳定
 *   （`removeDeckFooterPlaceholders` 即"全撤"）。
 *
 * ## 复用而非重写
 *
 * - 三个占位符的 `p:sp` 片段完全走 `notes.renderFooterShapesXml`（同一几何 / 域口径：日期与页码
 *   是 `a:fld` **域**，不是写死文本，换页 / 跨天不留错误数据）；
 * - 页码取当前**页码**（`slideNumber = pageNumber`）。
 *
 * ## 已知边界（如实登记）
 *
 * - 只改**根** `p:spTree`；组合形状内部的占位符不处理（组合不承载页脚）。
 * - 幻灯片尺寸取 `ppt/presentation.xml` 的 `p:sldSz@cx/@cy`；缺失即 `missing_slide_size` 报错，
 *   不默认某个尺寸。
 * - 命名空间前缀按 `render.ts` 口径（`a` / `p`）；前缀被改写过的文件定位不到 `p:spTree` 即报错。
 */

import { ValidationError } from '../../protocol/index.js';

import { deckSlides, type EditableDeck, type DeckSlideRef } from '../slide-ops.js';
import { NO_FOOTER, renderFooterShapesXml, type SlideFooterConfig } from '../notes.js';

import { deckPartTextOf, deckWithPartText } from './package-io.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PRESENTATION_PART = 'ppt/presentation.xml';

/** 页脚族占位符的 `p:ph@type`。 */
const FOOTER_PH_TYPES = new Set(['dt', 'ftr', 'sldNum']);

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 占位符注入层失败原因（**具名**）。 */
export type PlaceholderPartsErrorReason =
  | 'unknown_slide'
  | 'missing_slide_part'
  | 'missing_slide_size'
  | 'missing_sp_tree';

/** 占位符注入层错误。 */
export class PlaceholderPartsError extends ValidationError {
  readonly reason: PlaceholderPartsErrorReason;

  constructor(reason: PlaceholderPartsErrorReason, message: string) {
    super(message);
    this.name = 'PlaceholderPartsError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 结果 / 读取类型
// ---------------------------------------------------------------------------

/** 本次注入了哪几项。 */
export interface DeckPlaceholderInjection {
  readonly date: boolean;
  readonly footer: boolean;
  readonly slide_number: boolean;
}

/** 注入结果。 */
export interface DeckPlaceholderResult {
  readonly deck: EditableDeck;
  readonly injected: DeckPlaceholderInjection;
  /** 注入前撤掉的既有页脚族占位符个数。 */
  readonly removed_existing: number;
  /** 新注入的占位符形状 id（文档顺序；`p:cNvPr@id`）。 */
  readonly shape_ids: readonly number[];
}

/** 页内一个占位符（供读回断言）。 */
export interface DeckPlaceholderInfo {
  /** `p:ph@type`；无该属性时按 OOXML 默认 `obj`。 */
  readonly type: string;
  readonly shape_id: number;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// 定位 / 小工具
// ---------------------------------------------------------------------------

function requireSlide(deck: EditableDeck, pageNumber: number): DeckSlideRef {
  const slides = deckSlides(deck);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > slides.length) {
    throw new PlaceholderPartsError(
      'unknown_slide',
      `页码 ${String(pageNumber)} 超出 1..${String(slides.length)}`,
    );
  }
  const ref = slides[pageNumber - 1];
  if (ref === undefined) {
    throw new PlaceholderPartsError('unknown_slide', `找不到第 ${String(pageNumber)} 页`);
  }
  return ref;
}

function slidePartXml(deck: EditableDeck, slidePath: string): string {
  const xml = deckPartTextOf(deck, slidePath);
  if (xml === undefined) {
    throw new PlaceholderPartsError('missing_slide_part', `包内缺少幻灯片部件 ${slidePath}`);
  }
  return xml;
}

function deckSlideSize(deck: EditableDeck): { readonly cx_emu: number; readonly cy_emu: number } {
  const text = deckPartTextOf(deck, PRESENTATION_PART);
  if (text === undefined) {
    throw new PlaceholderPartsError('missing_slide_size', `包内缺少部件 ${PRESENTATION_PART}`);
  }
  const tag = /<p:sldSz\b([^>]*)\/?>/.exec(text)?.[1];
  const cx = tag === undefined ? undefined : /\bcx="(\d+)"/.exec(tag)?.[1];
  const cy = tag === undefined ? undefined : /\bcy="(\d+)"/.exec(tag)?.[1];
  if (cx === undefined || cy === undefined) {
    throw new PlaceholderPartsError('missing_slide_size', 'ppt/presentation.xml 没有 p:sldSz 的 cx/cy，无法定位页脚');
  }
  return { cx_emu: Number(cx), cy_emu: Number(cy) };
}

interface PlaceholderBlock {
  readonly start: number;
  readonly end: number;
  readonly type: string;
  readonly shape_id: number;
  readonly name: string;
}

/** 逐个 `p:sp` 块解析出带 `p:ph` 的占位符（文档顺序）。 */
function placeholderBlocks(xml: string): readonly PlaceholderBlock[] {
  const blocks: PlaceholderBlock[] = [];
  const shapeRe = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g;
  for (const match of xml.matchAll(shapeRe)) {
    const block = match[0];
    const phTag = /<p:ph\b([^>]*)\/?>/.exec(block);
    if (phTag === null) continue;
    const type = /\btype="([^"]+)"/.exec(phTag[1] ?? '')?.[1] ?? 'obj';
    const idStr = /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(block)?.[1];
    const nameStr = /<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(block)?.[1];
    blocks.push({
      start: match.index,
      end: match.index + block.length,
      type,
      shape_id: idStr === undefined ? 0 : Number(idStr),
      name: nameStr ?? '',
    });
  }
  return blocks;
}

/** 读回某页所有占位符（`p:ph`）；供上层 / 用例断言。 */
export function readDeckPlaceholders(deck: EditableDeck, pageNumber: number): readonly DeckPlaceholderInfo[] {
  const ref = requireSlide(deck, pageNumber);
  return Object.freeze(
    placeholderBlocks(slidePartXml(deck, ref.part_path)).map((block) =>
      Object.freeze({ type: block.type, shape_id: block.shape_id, name: block.name }),
    ),
  );
}

/** 去掉页脚族占位符块；返回新 XML 与撤掉的个数。 */
function stripFooterPlaceholders(xml: string): { readonly xml: string; readonly removed: number } {
  const doomed = placeholderBlocks(xml).filter((block) => FOOTER_PH_TYPES.has(block.type));
  if (doomed.length === 0) return { xml, removed: 0 };
  // 从后往前删，避免下标位移。
  let out = xml;
  for (const block of [...doomed].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, block.start) + out.slice(block.end);
  }
  return { xml: out, removed: doomed.length };
}

function maxShapeId(xml: string): number {
  let max = 1;
  for (const match of xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)) {
    max = Math.max(max, Number(match[1] ?? '0'));
  }
  return max;
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

/**
 * 往某页注入页脚 / 日期 / 页码占位符（先撤本页既有页脚族占位符，再按 `config` 写新的）。
 *
 * @throws {PlaceholderPartsError} 页码越界 / 缺幻灯片部件 / 缺 `p:sldSz` / 缺 `p:spTree`。
 */
export function injectDeckFooterPlaceholders(
  deck: EditableDeck,
  pageNumber: number,
  config: SlideFooterConfig,
): DeckPlaceholderResult {
  const ref = requireSlide(deck, pageNumber);
  const original = slidePartXml(deck, ref.part_path);
  const stripped = stripFooterPlaceholders(original);

  const size = deckSlideSize(deck);
  const fragment = renderFooterShapesXml(config, pageNumber, size);

  const injected: DeckPlaceholderInjection = Object.freeze({
    date: config.show_date,
    footer: config.footer_text !== null,
    slide_number: config.show_slide_number,
  });

  if (fragment === '') {
    return Object.freeze({
      deck: deckWithPartText(deck, ref.part_path, stripped.xml),
      injected,
      removed_existing: stripped.removed,
      shape_ids: Object.freeze([]),
    });
  }

  // id 唯一：从当前页最大 id 起顺延。
  const base = maxShapeId(stripped.xml);
  let counter = 0;
  const remapped = fragment.replace(/(<p:cNvPr\b[^>]*\bid=")(\d+)(")/g, (_whole, head: string, _num: string, tail: string) => {
    counter += 1;
    return `${head}${String(base + counter)}${tail}`;
  });
  const shapeIds = Object.freeze(
    [...remapped.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1] ?? '0')),
  );

  const treeClose = stripped.xml.lastIndexOf('</p:spTree>');
  if (treeClose < 0) {
    throw new PlaceholderPartsError('missing_sp_tree', `幻灯片 ${ref.part_path} 没有 </p:spTree>`);
  }
  const patched = `${stripped.xml.slice(0, treeClose)}${remapped}${stripped.xml.slice(treeClose)}`;

  return Object.freeze({
    deck: deckWithPartText(deck, ref.part_path, patched),
    injected,
    removed_existing: stripped.removed,
    shape_ids: shapeIds,
  });
}

/** 撤掉某页全部页脚族占位符（`NO_FOOTER` 注入）。 */
export function removeDeckFooterPlaceholders(deck: EditableDeck, pageNumber: number): DeckPlaceholderResult {
  return injectDeckFooterPlaceholders(deck, pageNumber, NO_FOOTER);
}
