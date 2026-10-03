/**
 * 演示域**向导入的幻灯片里插入新超链接**时的关系-id 分配与 run 落位（集成增量 I06；
 * 承接 P07 留下的缺口）。
 *
 * ## 缺口是什么
 *
 * `notes.ts` 的 `hyperlinkRunXml` / `renderHyperlinkRun` 只**渲染片段**：给定一个 `rId`，造出
 * 一段带 `a:hlinkClick r:id="…"` 的 `a:r`。它**不**登记关系——片段里引用的那个 `rId` 到底指哪，
 * 由"接线方"负责。对**整份文稿由我们渲染**的场景，接线方是 `render.ts`；但对**导入既有文件之后
 * 往某页插一条新链接**，此前**没有**任何导出函数负责这件事：不分配 `rId`、不写 `_rels`，链接就是
 * 死链（点开报错，正是 PPT-10 明令禁止的"失效"）。
 *
 * 本层补这一段：
 *
 * - `allocateDeckHyperlinkRelId`：在某页 `_rels` 里登记一条链接关系，**自增 `rId(max+1)`**，
 *   并**按目标去重**（同一页、同一类型、同一目标只留一条关系；重复插入只复用同一 `rId`）；
 *   - 外部 URL → `…/hyperlink` 关系 + `TargetMode="External"`；
 *   - 内部跳转到某页 → `…/slide` 关系（与 PowerPoint 的"跳到某张幻灯片"一致），目标按承载页到
 *     目标页部件路径求相对路径；
 * - `insertDeckHyperlinkRun`：分配 `rId` 后，把 `notes.renderHyperlinkRun` 造的 run 片段**真接进**
 *   指定形状的 `p:txBody` 的第 N 个段落（插在段末、`a:endParaRPr` 之前，保持元素顺序合法）。
 *
 * ## 复用而非重写
 *
 * - run 片段字节走 `notes.renderHyperlinkRun`（`a:hlinkClick` / `ppaction://hlinksldjump` 同一口径）；
 * - 页 → 部件定位走 `slide-ops.deckSlides`。
 *
 * ## 已知边界（如实登记）
 *
 * - 只处理**新增**链接；清理失效链接归 `dead-links.ts`（P07），本层不重复。
 * - 段落定位按**限定名** `p:sp` / `p:txBody` / `a:p` 原样匹配（前缀被改写 ⇒ `shape_not_found`，
 *   不静默）；`p:sp` 内含嵌套形状（组合）时按**最外层块**定位，不递归进组内。
 * - `paragraphIndex` 为**0 起**的段落下标。
 */

import { ValidationError } from '../../protocol/index.js';

import { deckSlides, type EditableDeck, type DeckSlideRef } from '../slide-ops.js';
import { renderHyperlinkRun, type HyperlinkTarget as NotesHyperlinkTarget } from '../notes.js';
import type { RunStyle } from '../model.js';

import {
  deckDirectoryOf,
  deckPartTextOf,
  deckRelativeTargetFrom,
  deckResolveTargetFrom,
  deckRelsPathOf,
  deckWithPartText,
  makeDeckRel,
  newDeckRelsXml,
  nextDeckRelId,
  readDeckRelsOf,
  writeDeckRels,
} from './package-io.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const REL_HYPERLINK =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 超链接关系层失败原因（**具名**）。 */
export type HyperlinkPartsErrorReason =
  | 'unknown_slide'
  | 'invalid_target_url'
  | 'empty_hyperlink_text'
  | 'shape_not_found'
  | 'paragraph_not_found'
  | 'missing_slide_part';

/** 超链接关系层错误。 */
export class HyperlinkPartsError extends ValidationError {
  readonly reason: HyperlinkPartsErrorReason;

  constructor(reason: HyperlinkPartsErrorReason, message: string) {
    super(message);
    this.name = 'HyperlinkPartsError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 输入 / 结果类型
// ---------------------------------------------------------------------------

/** 链接目标（**包级**口径：内部跳转按**页码**，页序变化后由调用方重新插入）。 */
export type DeckHyperlinkTarget =
  | { readonly kind: 'url'; readonly url: string; readonly tooltip: string | null }
  | { readonly kind: 'slide'; readonly page_number: number; readonly tooltip: string | null };

/** 关系分配结果。 */
export interface DeckHyperlinkAllocation {
  readonly deck: EditableDeck;
  /** 供 `a:hlinkClick@r:id` 引用的关系 id。 */
  readonly rel_id: string;
  /** 关系类型（`…/hyperlink` 或 `…/slide`）。 */
  readonly type: string;
  /** 写进 `_rels` 的 `Target`。 */
  readonly target: string;
  readonly external: boolean;
  /** 是否**新登记**一条关系；`false` = 命中既有同目标关系并复用其 `rId`（去重）。 */
  readonly added: boolean;
}

/** 插入带链接 run 的结果。 */
export interface DeckHyperlinkInsertResult extends DeckHyperlinkAllocation {
  readonly shape_id: number;
  readonly paragraph_index: number;
}

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------

function requirePage(slides: readonly DeckSlideRef[], pageNumber: number, what: string): DeckSlideRef {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > slides.length) {
    throw new HyperlinkPartsError(
      'unknown_slide',
      `${what} ${String(pageNumber)} 超出 1..${String(slides.length)}`,
    );
  }
  const ref = slides[pageNumber - 1];
  if (ref === undefined) {
    throw new HyperlinkPartsError('unknown_slide', `${what} ${String(pageNumber)} 超出 1..${String(slides.length)}`);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// 关系-id 分配（自增 + 按目标去重）
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  /** 去重判等用的规范化键。 */
  readonly key: string;
}

function resolveDeckHyperlinkTarget(
  deck: EditableDeck,
  baseDir: string,
  target: DeckHyperlinkTarget,
): ResolvedTarget {
  if (target.kind === 'url') {
    if (target.url.trim() === '') {
      throw new HyperlinkPartsError('invalid_target_url', '外部链接地址为空');
    }
    return { type: REL_HYPERLINK, target: target.url, external: true, key: `ext:${target.url}` };
  }
  const ref = requirePage(deckSlides(deck), target.page_number, '内部跳转目标页');
  const relTarget = deckRelativeTargetFrom(baseDir, ref.part_path);
  const resolved = deckResolveTargetFrom(baseDir, relTarget);
  return { type: REL_SLIDE, target: relTarget, external: false, key: `int:${resolved}` };
}

/**
 * 在某页 `_rels` 里登记一条链接关系：`rId(max+1)` 自增，**同目标去重**（命中既有关系则复用其 id）。
 *
 * @throws {HyperlinkPartsError} 页码越界（`unknown_slide`）、外部地址空（`invalid_target_url`）。
 */
export function allocateDeckHyperlinkRelId(
  deck: EditableDeck,
  pageNumber: number,
  target: DeckHyperlinkTarget,
): DeckHyperlinkAllocation {
  const ref = requirePage(deckSlides(deck), pageNumber, '承载页');
  const slidePath = ref.part_path;
  const baseDir = deckDirectoryOf(slidePath);
  const resolved = resolveDeckHyperlinkTarget(deck, baseDir, target);

  const relsPath = deckRelsPathOf(slidePath);
  const relsText = deckPartTextOf(deck, relsPath);
  const rels = relsText === undefined ? [] : readDeckRelsOf(relsText);

  const existing = rels.find((rel) => {
    if (rel.type !== resolved.type || rel.external !== resolved.external) return false;
    if (resolved.external) return rel.target === resolved.target;
    return deckResolveTargetFrom(baseDir, rel.target) === deckResolveTargetFrom(baseDir, resolved.target);
  });
  if (existing !== undefined) {
    return Object.freeze({
      deck,
      rel_id: existing.id,
      type: resolved.type,
      target: existing.target,
      external: resolved.external,
      added: false,
    });
  }

  const relId = nextDeckRelId(rels);
  const newRel = makeDeckRel(relId, resolved.type, resolved.target, resolved.external);
  const nextText = relsText === undefined ? newDeckRelsXml([newRel]) : writeDeckRels(relsText, [...rels, newRel]);
  return Object.freeze({
    deck: deckWithPartText(deck, relsPath, nextText),
    rel_id: relId,
    type: resolved.type,
    target: resolved.target,
    external: resolved.external,
    added: true,
  });
}

// ---------------------------------------------------------------------------
// run 落位
// ---------------------------------------------------------------------------

/** 找 `p:cNvPr id="<shapeId>"` 所在的**最外层** `p:sp` 块（起止下标）。 */
function findShapeBlock(xml: string, shapeId: number): { readonly start: number; readonly block: string } {
  const shapeRe = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g;
  const idTest = new RegExp(`<p:cNvPr\\b[^>]*\\bid="${String(shapeId)}"`);
  for (const match of xml.matchAll(shapeRe)) {
    if (idTest.test(match[0])) {
      return { start: match.index, block: match[0] };
    }
  }
  throw new HyperlinkPartsError('shape_not_found', `幻灯片里找不到 shape_id=${String(shapeId)} 的形状`);
}

/** 把 run 片段插进 `shapeId` 的 `p:txBody` 第 `paragraphIndex`（0 起）个段落的段末。 */
function insertRunIntoParagraph(xml: string, shapeId: number, paragraphIndex: number, runXml: string): string {
  const shape = findShapeBlock(xml, shapeId);
  if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) {
    throw new HyperlinkPartsError('paragraph_not_found', `段落下标 ${String(paragraphIndex)} 非法（须 ≥ 0 的整数）`);
  }
  const txMatch = /<p:txBody\b[^>]*>[\s\S]*?<\/p:txBody>/.exec(shape.block);
  if (txMatch === null) {
    throw new HyperlinkPartsError('shape_not_found', `shape_id=${String(shapeId)} 没有 p:txBody，无法接链接 run`);
  }
  const txStart = shape.start + txMatch.index;
  const tx = txMatch[0];
  const paraRe = /<a:p\b[^>]*\/>|<a:p\b[^>]*>[\s\S]*?<\/a:p>/g;

  let seen = 0;
  for (const para of tx.matchAll(paraRe)) {
    if (seen !== paragraphIndex) {
      seen += 1;
      continue;
    }
    const paraStr = para[0];
    const paraStart = txStart + para.index;
    let replaced: string;
    if (paraStr.endsWith('/>')) {
      // `<a:p .../>` ⇒ `<a:p ...>RUN</a:p>`（丢掉自闭合的 `/`）。
      replaced = `${paraStr.slice(0, -2)}>${runXml}</a:p>`;
    } else {
      const closeIdx = paraStr.lastIndexOf('</a:p>');
      const endPrIdx = paraStr.search(/<a:endParaRPr\b/);
      const insertAt = endPrIdx >= 0 && endPrIdx < closeIdx ? endPrIdx : closeIdx;
      replaced = `${paraStr.slice(0, insertAt)}${runXml}${paraStr.slice(insertAt)}`;
    }
    return `${xml.slice(0, paraStart)}${replaced}${xml.slice(paraStart + paraStr.length)}`;
  }
  throw new HyperlinkPartsError(
    'paragraph_not_found',
    `shape_id=${String(shapeId)} 的文本体里没有第 ${String(paragraphIndex)} 个段落`,
  );
}

/** `notes.ts` 的 `HyperlinkTarget`（run 片段渲染用；内部跳转只需 kind 决定 `action`）。 */
function toNotesTarget(target: DeckHyperlinkTarget, slideIdForJump: number): NotesHyperlinkTarget {
  if (target.kind === 'url') {
    return { kind: 'url', url: target.url, tooltip: target.tooltip };
  }
  return { kind: 'slide', slide_id: slideIdForJump, tooltip: target.tooltip };
}

/**
 * 往某页的某个形状的某个段落**插入一条带链接的 run**：分配 `rId` → 造 run 片段 → 接进 `p:txBody`。
 *
 * @throws {HyperlinkPartsError} 见 `allocateDeckHyperlinkRelId` 与落位失败（`shape_not_found` /
 *   `paragraph_not_found`）。
 */
export function insertDeckHyperlinkRun(
  deck: EditableDeck,
  pageNumber: number,
  shapeId: number,
  paragraphIndex: number,
  text: string,
  target: DeckHyperlinkTarget,
  style?: RunStyle,
): DeckHyperlinkInsertResult {
  if (text.trim() === '') {
    throw new HyperlinkPartsError('empty_hyperlink_text', '链接 run 的文本为空');
  }
  const ref = requirePage(deckSlides(deck), pageNumber, '承载页');
  const allocation = allocateDeckHyperlinkRelId(deck, pageNumber, target);
  const slideIdForJump = target.kind === 'slide' ? requirePage(deckSlides(deck), target.page_number, '内部跳转目标页').slide_id : 0;
  const runXml = renderHyperlinkRun(allocation.rel_id, toNotesTarget(target, slideIdForJump), text, style);

  const slideXml = deckPartTextOf(allocation.deck, ref.part_path);
  if (slideXml === undefined) {
    throw new HyperlinkPartsError('missing_slide_part', `包内缺少幻灯片部件 ${ref.part_path}`);
  }
  const patched = insertRunIntoParagraph(slideXml, shapeId, paragraphIndex, runXml);
  return Object.freeze({
    deck: deckWithPartText(allocation.deck, ref.part_path, patched),
    rel_id: allocation.rel_id,
    type: allocation.type,
    target: allocation.target,
    external: allocation.external,
    added: allocation.added,
    shape_id: shapeId,
    paragraph_index: paragraphIndex,
  });
}
