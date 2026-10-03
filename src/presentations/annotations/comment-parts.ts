/**
 * 演示域**批注部件在"导入既有文件"之后的登记 / 撤销**（集成增量 I06；承接 P07 留下的缺口）。
 *
 * ## 为什么单开这一层
 *
 * `notes.ts` 已经在**模型层**给了 `renderCommentsPartXml` / `renderCommentAuthorsPartXml`——能造
 * 批注部件与批注作者部件的字节。但那是"整份文稿由我们渲染"口径：它把批注当成一个**数组**读进去，
 * 没有把它登记进**包**。**导入一份既有 PPTX 之后**，一条批注在包里是四样东西，少一样 PowerPoint /
 * WPS 打开时要么看不到批注、要么直接把包判坏：
 *
 * 1. 批注部件本身（`ppt/comments/commentN.xml`，`p:cmLst`）；
 * 2. 批注作者部件（`ppt/commentAuthors.xml`，`p:cmAuthorLst`——**整份文稿共享一份**）；
 * 3. `ppt/_rels/presentation.xml.rels` 里两条关系：`…/comments` → 批注部件、`…/commentAuthors`
 *    → 作者部件（批注归属由**批注部件自己的 `_rels` 指回幻灯片**表达，见第 4 点）；
 * 4. 批注部件自身的 `_rels`：一条 `…/slide` 指回它所属的幻灯片，以及 `[Content_Types].xml` 的
 *    `Override`。
 *
 * 本层把"增 / 删 / 换某页批注"封装成**四样一起登记、一起撤销**的一对可逆动作（删干净后不残留
 * 部件、不残留覆盖、不残留孤儿关系），并对"清空全部批注"时**一并撤掉作者部件**。
 *
 * ## 复用而非重写
 *
 * - 批注部件字节完全走 `notes.renderCommentsPartXml`（模型层同一渲染口径：`idx` / `authorId` /
 *   `p:pos` / `p:text`）；
 * - 页 → 幻灯片部件定位完全走 `slide-ops.deckSlides`（`p:sldIdLst` 是页序的唯一真相源）。
 *
 * ## 已有边界（如实登记）
 *
 * - **作者 id 采用"表内位置"口径**（0 起连续）。标准文件的 `p:cmAuthor@id` 本就等于其位置，
 *   因此读入既有作者表后按文件顺序保留、新作者**追加**，既有批注部件里的 `authorId` 引用保持有效。
 *   若某导入文件里 `cmAuthor@id` 与顺序不符（本就错乱），本层不做修正——这是**既有**损坏。
 * - 作者部件本层只登记 `id` / `name` / `initials` / `lastIdx` / `clrIdx`；`lastIdx` = 该作者在**整份
 *   文稿**里的批注条数（跨页统计），不是本页条数。
 * - 不做批注**回复**（`p:cmLst` 之外的 `…/commentExtended` 扩展）与批注**图标**部件。
 * - 命名空间前缀按 `render.ts` 口径（`a` / `p`）；前缀被改写过的文件在定位处**报错**，不静默。
 */

import { attr, el, formatInteger, serializeXmlDocument } from '../../artifacts/ooxml/index.js';
import { ValidationError } from '../../protocol/index.js';

import { deckSlides, type EditableDeck, type DeckSlideRef } from '../slide-ops.js';
import { renderCommentsPartXml, type SlideComment } from '../notes.js';

import {
  deckAddContentTypeOverride,
  deckDirectoryOf,
  deckPartTextOf,
  deckRelativeTargetFrom,
  deckRemoveContentTypeOverride,
  deckResolveTargetFrom,
  deckRelsPathOf,
  deckWithPartText,
  deckWithoutParts,
  makeDeckRel,
  newDeckRelsXml,
  nextDeckRelId,
  readDeckRelsOf,
  writeDeckRels,
  type DeckRel,
} from './package-io.js';

// ---------------------------------------------------------------------------
// 常量（与 notes.ts / render.ts 同一命名空间口径）
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const REL_COMMENT_AUTHORS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

const CT_COMMENTS =
  'application/vnd.openxmlformats-officedocument.presentationml.comments+xml';
const CT_COMMENT_AUTHORS =
  'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml';

const COMMENT_AUTHORS_PART = 'ppt/commentAuthors.xml';
const PRESENTATION_RELS_PART = 'ppt/_rels/presentation.xml.rels';
const COMMENT_PART_RE = /^ppt\/comments\/comment[^/]*\.xml$/;
const COMMENT_PART_NUMBER_RE = /^ppt\/comments\/comment(\d+)\.xml$/;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 批注部件层失败原因（**具名**，供用例断言与上层分类）。 */
export type CommentPartsErrorReason =
  | 'unknown_slide'
  | 'missing_presentation_rels'
  | 'comments_part_exists'
  | 'comments_part_missing'
  | 'empty_comment_text'
  | 'empty_author_name'
  | 'unresolved_slide_target';

/** 批注部件层错误。 */
export class CommentPartsError extends ValidationError {
  readonly reason: CommentPartsErrorReason;

  constructor(reason: CommentPartsErrorReason, message: string) {
    super(message);
    this.name = 'CommentPartsError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 输入 / 结果类型
// ---------------------------------------------------------------------------

/**
 * 一条待登记的批注（**包级**口径，不引用模型 `slide_id`——归属由页码决定）。
 *
 * 作者身份按 `author_name` 归并：同名作者复用同一个 `authorId`；新名字追加到作者表。
 */
export interface DeckCommentInput {
  readonly author_name: string;
  readonly text: string;
  /** ISO 8601 时刻（写作时刻，本层不读时钟，保持纯函数）。 */
  readonly created_iso: string;
  readonly x_emu: number;
  readonly y_emu: number;
}

/** 作者表里的一位作者（`id` = 表内位置，0 起连续）。 */
export interface DeckCommentAuthor {
  readonly id: number;
  readonly name: string;
  readonly initials: string;
  /** 该作者在**整份文稿**里的批注条数。 */
  readonly last_idx: number;
}

/** 增删换批注的动作（供上层与用例断言）。 */
export type DeckCommentPartAction = 'added' | 'replaced' | 'removed' | 'none';

/** 增删换批注的结果。 */
export interface DeckCommentsResult {
  readonly deck: EditableDeck;
  readonly action: DeckCommentPartAction;
  /** 操作后该页的批注部件路径；`removed` / `none` 时为 `null`。 */
  readonly comments_part_path: string | null;
  /** 操作后包内是否仍存在批注作者部件；没有则 `null`。 */
  readonly comment_authors_path: string | null;
}

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------

function requirePage(slides: readonly DeckSlideRef[], pageNumber: number): DeckSlideRef {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > slides.length) {
    throw new CommentPartsError(
      'unknown_slide',
      `页码 ${String(pageNumber)} 超出 1..${String(slides.length)}`,
    );
  }
  const ref = slides[pageNumber - 1];
  if (ref === undefined) {
    throw new CommentPartsError('unknown_slide', `找不到第 ${String(pageNumber)} 页`);
  }
  return ref;
}

/** 某页的批注部件路径；该页没有批注 ⇒ `null`（按批注部件 `_rels` 指回幻灯片判定）。 */
export function readDeckCommentsPartPath(deck: EditableDeck, pageNumber: number): string | null {
  const slidePath = requirePage(deckSlides(deck), pageNumber).part_path;
  for (const part of deck.parts) {
    if (!COMMENT_PART_RE.test(part.path)) continue;
    const relsText = deckPartTextOf(deck, deckRelsPathOf(part.path));
    if (relsText === undefined) continue;
    const base = deckDirectoryOf(part.path);
    for (const rel of readDeckRelsOf(relsText)) {
      if (rel.external || rel.type !== REL_SLIDE) continue;
      if (deckResolveTargetFrom(base, rel.target) === slidePath) return part.path;
    }
  }
  return null;
}

function nextCommentsPath(deck: EditableDeck): string {
  let max = 0;
  for (const part of deck.parts) {
    const match = COMMENT_PART_NUMBER_RE.exec(part.path);
    if (match !== null) max = Math.max(max, Number(match[1] ?? '0'));
  }
  return `ppt/comments/comment${String(max + 1)}.xml`;
}

// ---------------------------------------------------------------------------
// 作者表
// ---------------------------------------------------------------------------

function initialsOf(name: string): string {
  return name.slice(0, 1);
}

/** 读回作者表（按文件出现顺序；`id` 归一为表内位置）。无作者部件 ⇒ 空表。 */
export function readDeckCommentAuthors(deck: EditableDeck): readonly DeckCommentAuthor[] {
  const text = deckPartTextOf(deck, COMMENT_AUTHORS_PART);
  if (text === undefined) return Object.freeze([]);
  const authors: DeckCommentAuthor[] = [];
  for (const match of text.matchAll(/<p:cmAuthor\b[^>]*\/?>/g)) {
    const raw = match[0] ?? '';
    const name = /\bname\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    if (name === undefined) continue;
    const initials = /\binitials\s*=\s*"([^"]*)"/.exec(raw)?.[1] ?? initialsOf(name);
    const lastIdx = Number(/\blastIdx\s*=\s*"(\d+)"/.exec(raw)?.[1] ?? '0');
    authors.push({ id: authors.length, name, initials, last_idx: lastIdx });
  }
  return Object.freeze(authors);
}

/** 按**表内位置**统计整份文稿里各作者的批注条数（扫描全部批注部件的 `authorId`）。 */
function commentCountsByAuthorId(deck: EditableDeck): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const part of deck.parts) {
    if (!COMMENT_PART_RE.test(part.path)) continue;
    const text = Buffer.from(part.data).toString('utf8');
    for (const match of text.matchAll(/\bauthorId\s*=\s*"(\d+)"/g)) {
      const id = Number(match[1] ?? '0');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** 渲染作者部件（`p:cmAuthorLst`）；`lastIdx` 取整份文稿的条数。 */
function renderDeckCommentAuthorsXml(
  authors: readonly DeckCommentAuthor[],
  counts: ReadonlyMap<number, number>,
): string {
  const root = el('p:cmAuthorLst', [attr('xmlns:a', NS_A), attr('xmlns:p', NS_P)], [
    ...authors.map((author) =>
      el('p:cmAuthor', [
        attr('id', formatInteger(author.id)),
        attr('name', author.name),
        attr('initials', author.initials),
        attr('lastIdx', formatInteger(counts.get(author.id) ?? 0)),
        attr('clrIdx', '0'),
      ]),
    ),
  ]);
  return serializeXmlDocument(root);
}

// ---------------------------------------------------------------------------
// 关系
// ---------------------------------------------------------------------------

function presentationRels(deck: EditableDeck): { readonly text: string; readonly rels: readonly DeckRel[] } {
  const text = deckPartTextOf(deck, PRESENTATION_RELS_PART);
  if (text === undefined) {
    throw new CommentPartsError(
      'missing_presentation_rels',
      `包内缺少部件 ${PRESENTATION_RELS_PART}，无法登记批注关系`,
    );
  }
  return { text, rels: readDeckRelsOf(text) };
}

/** 批注部件自身 `_rels`：一条 `…/slide` 指回所属幻灯片。 */
function commentPartRelsXml(slidePath: string, commentPath: string): string {
  const target = deckRelativeTargetFrom(deckDirectoryOf(commentPath), slidePath);
  return newDeckRelsXml([makeDeckRel('rId1', REL_SLIDE, target)]);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function validateComments(comments: readonly DeckCommentInput[]): void {
  for (const comment of comments) {
    if (comment.text.trim() === '') {
      throw new CommentPartsError('empty_comment_text', '批注文本为空（不许留空批注）');
    }
    if (comment.author_name.trim() === '') {
      throw new CommentPartsError('empty_author_name', '批注作者名为空（作者表必须有名字）');
    }
  }
}

// ---------------------------------------------------------------------------
// 核心：为某页写入批注部件（新建 or 覆盖同一路径），并同步作者表 / 关系 / 内容类型
// ---------------------------------------------------------------------------

function writeCommentsForSlide(
  deck: EditableDeck,
  pageNumber: number,
  commentPath: string,
  comments: readonly DeckCommentInput[],
): { readonly deck: EditableDeck; readonly comment_authors_path: string } {
  const ref = requirePage(deckSlides(deck), pageNumber);
  validateComments(comments);

  // 1) 合并作者表：既有（保留位置） + 新名字（追加）。
  const existingAuthors = readDeckCommentAuthors(deck);
  const authors: DeckCommentAuthor[] = existingAuthors.map((author) => ({ ...author }));
  const nameToId = new Map(authors.map((author) => [author.name, author.id] as const));
  const resolved = comments.map((comment) => {
    let id = nameToId.get(comment.author_name);
    if (id === undefined) {
      id = authors.length;
      authors.push({ id, name: comment.author_name, initials: initialsOf(comment.author_name), last_idx: 0 });
      nameToId.set(comment.author_name, id);
    }
    return { id, comment };
  });
  const authorRefs = authors.map((_author, index) => ({ id: String(index) }));

  // 2) 批注部件字节（走 notes.ts 同一渲染口径）。
  const slideComments: SlideComment[] = resolved.map((entry, index) => ({
    comment_id: `${commentPath}#${String(index + 1)}`,
    slide_id: ref.slide_id,
    author_id: String(entry.id),
    author_name: entry.comment.author_name,
    text: entry.comment.text,
    created_iso: entry.comment.created_iso,
    x_emu: entry.comment.x_emu,
    y_emu: entry.comment.y_emu,
  }));
  const partXml = renderCommentsPartXml(slideComments, authorRefs);

  // 3) 写批注部件 + 它的 `_rels` + 内容类型覆盖。
  let next = deckWithPartText(deck, commentPath, partXml);
  next = deckWithPartText(next, deckRelsPathOf(commentPath), commentPartRelsXml(ref.part_path, commentPath));
  next = deckAddContentTypeOverride(next, commentPath, CT_COMMENTS);

  // 4) presentation.xml.rels：补 `…/comments`（按目标去重）与 `…/commentAuthors`。
  const { text: relsText, rels } = presentationRels(next);
  const commentTarget = deckRelativeTargetFrom('ppt', commentPath);
  let nextRels: DeckRel[] = [...rels];
  const hasCommentsRel = nextRels.some(
    (rel) => !rel.external && rel.type === REL_COMMENTS && deckResolveTargetFrom('ppt', rel.target) === commentPath,
  );
  if (!hasCommentsRel) {
    nextRels.push(makeDeckRel(nextDeckRelId(nextRels), REL_COMMENTS, commentTarget));
  }
  if (!nextRels.some((rel) => rel.type === REL_COMMENT_AUTHORS)) {
    nextRels.push(makeDeckRel(nextDeckRelId(nextRels), REL_COMMENT_AUTHORS, 'commentAuthors.xml'));
  }
  next = deckWithPartText(next, PRESENTATION_RELS_PART, writeDeckRels(relsText, nextRels));

  // 5) 作者部件 + 内容类型覆盖（`lastIdx` 取整份文稿条数；含刚写入的批注部件）。
  const counts = commentCountsByAuthorId(next);
  next = deckWithPartText(next, COMMENT_AUTHORS_PART, renderDeckCommentAuthorsXml(authors, counts));
  next = deckAddContentTypeOverride(next, COMMENT_AUTHORS_PART, CT_COMMENT_AUTHORS);

  return { deck: next, comment_authors_path: COMMENT_AUTHORS_PART };
}

// ---------------------------------------------------------------------------
// 增 / 删 / 换
// ---------------------------------------------------------------------------

/**
 * 给某页**新增**批注部件（导入既有文件之后；该页原本没有批注）。
 *
 * @throws {CommentPartsError} 页码越界（`unknown_slide`）、该页已有批注（`comments_part_exists`）、
 *   批注文本空（`empty_comment_text`）、作者名空（`empty_author_name`）。
 */
export function addDeckComments(
  deck: EditableDeck,
  pageNumber: number,
  comments: readonly DeckCommentInput[],
): DeckCommentsResult {
  requirePage(deckSlides(deck), pageNumber);
  if (readDeckCommentsPartPath(deck, pageNumber) !== null) {
    throw new CommentPartsError(
      'comments_part_exists',
      `第 ${String(pageNumber)} 页已有批注部件，应改用替换 / 先删再加`,
    );
  }
  const commentPath = nextCommentsPath(deck);
  const written = writeCommentsForSlide(deck, pageNumber, commentPath, comments);
  return Object.freeze({
    deck: written.deck,
    action: 'added',
    comments_part_path: commentPath,
    comment_authors_path: written.comment_authors_path,
  });
}

/**
 * **移除**某页的批注部件（连同它的 rels、内容类型覆盖、presentation 上的 `…/comments` 关系）。
 *
 * 删完若包内再无任何批注部件，**一并撤掉**批注作者部件（部件 / 覆盖 / `…/commentAuthors` 关系）——
 * "删干净、不留残留"。该页本就没有批注 ⇒ 动作 `none`，包原样返回（幂等）。
 */
export function removeDeckComments(deck: EditableDeck, pageNumber: number): DeckCommentsResult {
  requirePage(deckSlides(deck), pageNumber);
  const commentPath = readDeckCommentsPartPath(deck, pageNumber);
  if (commentPath === null) {
    return Object.freeze({
      deck,
      action: 'none',
      comments_part_path: null,
      comment_authors_path: deckPartTextOf(deck, COMMENT_AUTHORS_PART) === undefined ? null : COMMENT_AUTHORS_PART,
    });
  }

  let next = deckWithoutParts(deck, [commentPath, deckRelsPathOf(commentPath)]);
  next = deckRemoveContentTypeOverride(next, commentPath);

  const relsText = deckPartTextOf(next, PRESENTATION_RELS_PART);
  if (relsText !== undefined) {
    const kept = readDeckRelsOf(relsText).filter((rel) => {
      if (rel.external || rel.type !== REL_COMMENTS) return true;
      return deckResolveTargetFrom('ppt', rel.target) !== commentPath;
    });
    next = deckWithPartText(next, PRESENTATION_RELS_PART, writeDeckRels(relsText, kept));
  }

  const stillHasComments = next.parts.some((part) => COMMENT_PART_RE.test(part.path));
  if (!stillHasComments) {
    next = deckWithoutParts(next, [COMMENT_AUTHORS_PART]);
    next = deckRemoveContentTypeOverride(next, COMMENT_AUTHORS_PART);
    const authorsRels = deckPartTextOf(next, PRESENTATION_RELS_PART);
    if (authorsRels !== undefined) {
      const kept = readDeckRelsOf(authorsRels).filter((rel) => rel.type !== REL_COMMENT_AUTHORS);
      next = deckWithPartText(next, PRESENTATION_RELS_PART, writeDeckRels(authorsRels, kept));
    }
    return Object.freeze({ deck: next, action: 'removed', comments_part_path: null, comment_authors_path: null });
  }

  return Object.freeze({
    deck: next,
    action: 'removed',
    comments_part_path: null,
    comment_authors_path: COMMENT_AUTHORS_PART,
  });
}

/**
 * 设置某页批注：`null` 删批注部件、非 null 新增或**替换**。这是"导入后增 / 删 / 换批注部件"的
 * 单一入口（内部按当前状态选 `add` / `replace` / `remove`）。
 */
export function setDeckComments(
  deck: EditableDeck,
  pageNumber: number,
  comments: readonly DeckCommentInput[] | null,
): DeckCommentsResult {
  if (comments === null) {
    return removeDeckComments(deck, pageNumber);
  }
  const existing = readDeckCommentsPartPath(deck, pageNumber);
  if (existing === null) {
    return addDeckComments(deck, pageNumber, comments);
  }
  const written = writeCommentsForSlide(deck, pageNumber, existing, comments);
  return Object.freeze({
    deck: written.deck,
    action: 'replaced',
    comments_part_path: existing,
    comment_authors_path: written.comment_authors_path,
  });
}
