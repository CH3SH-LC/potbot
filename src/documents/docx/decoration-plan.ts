/**
 * **引用侧表 / 审阅记录 → 段落级装饰计划**（design-05-P7 的导出收口；WF-071–079）。
 *
 * ## 这一层解决什么
 *
 * `src/documents/references/**` 与 `src/documents/review/**` 用
 * `(node_id, 码位起, 码位止)` 锚定（R102，与选区同一套语义），而 OOXML 里
 * 书签 / 批注 / 超链接 / 修订是**插在段落的行内序列中间**的元素。两者之间缺的就是本文件：
 * 把"某个段落的第 3–7 个码位"翻译成"在哪个偏移处开、哪个偏移处闭、开闭的是什么元素"。
 *
 * ## 产出与"未涉及即逐字节不变"（R151）
 *
 * `DecorationPlan.marks` 里**没有**某段落的条目 ⇒ 导出器走**原来的**序列化路径，
 * 一个字节都不多写。因此不传 `references` / `review` / `toc` 时，导出与今天**逐字节相同**；
 * 既有 `roundtrip.test.ts` 全绿正是这条判据。
 *
 * ## 域为什么总有落点（"不断链"）
 *
 * `REF` 域只能按**书签名**取目标（OOXML 没有"按段落 id 引用"这种域）。而 `CrossReference`
 * 的目标可能是稳定 `node_id`（标题 / 题注）。因此当目标不是书签时，本层**在目标段落上
 * 补一个书签**（名字由 `node_id` 确定性派生，形如 `_Ref_b3`），域再指向它——
 * 于是"域指令指向一个真实存在的书签"是**算出来的**，不是靠调用方先手动建书签。
 * 目标段落已被删除 ⇒ 该引用记入 `skipped`，**不伪造**一个引用（R112/R154）。
 *
 * ## 失效锚点不写出（一条必须写清的策略）
 *
 * `Bookmark.intact === false`/`Hyperlink.intact === false` 表示"它指向的文字已被整段删除"——
 * `locateBookmark` 对它**返回 `not_found`**。既然如此，导出器**不再把它写进文件**：
 * 写一个零长度书签会让消费端认为"这个书签还在"，与模型层报告的状态**互相矛盾**。
 * `CommentNode.anchor === null` 同理（无处安放）。被跳过的项**逐条记进 `skipped`**
 * （不是静默丢弃，R110），调用方可据此给用户解释。
 *
 * ## 格式类修订（`kind:'format'`）**明确拒绝**
 *
 * OOXML 表达格式变更要靠 `w:rPrChange` / `w:pPrChange`（把**旧的** rPr/pPr 嵌进 run/段落里），
 * 而 `FormatChange.before/after` 是 `unknown`——导出器无法在不知道类型的情况下把它写成一个
 * 合法的属性元素。跳过它 = 静默丢掉一条用户可见的审阅记录（R110 禁止），
 * 因此按 R140 的取向**操作前拒绝**（`DocxError('unsupported_revision')`）。
 */

import type { XmlElement } from '../../artifacts/ooxml/xml.js';
import { createRelationship, nextRelationshipId } from '../model/preservation.js';
import type { BlockNode, DocumentModel, NodeId, RelationshipRecord } from '../model/types.js';
import { externalRelationshipFor } from '../references/hyperlinks.js';
import type { CrossRefTarget, CrossReference, ReferenceIndex, TocCache } from '../references/types.js';
import type { RevisionRecord } from '../review/types.js';
import type { EquationContent } from '../equations/types.js';
import { findParagraphById, paragraphText } from '../selection/structure.js';
import { DocxError } from './docx-error.js';
import { importedCommentOriginOf } from './import.js';
import { equationElement } from './equation-render.js';
import {
  COMMENTS_CONTENT_TYPE,
  COMMENTS_PART_PATH,
  COMMENTS_RELATIONSHIP_TYPE,
  DEFAULT_TOC_INSTRUCTION,
  ENDNOTES_CONTENT_TYPE,
  ENDNOTES_PART_PATH,
  ENDNOTES_RELATIONSHIP_TYPE,
  FOOTNOTES_CONTENT_TYPE,
  FOOTNOTES_PART_PATH,
  FOOTNOTES_RELATIONSHIP_TYPE,
  commentsPartXml,
  maxNumericIdInPart,
  maxNumericIdInRawXml,
  notesPartXml,
  tocFieldParagraphs,
} from './reference-render.js';

// ---------------------------------------------------------------------------
// 标记
// ---------------------------------------------------------------------------

/** `w:bookmarkStart` / `w:bookmarkEnd` 一对。 */
export interface BookmarkMark {
  readonly kind: 'bookmark';
  readonly start: number;
  readonly end: number;
  readonly id: number;
  readonly name: string;
}

/** `w:commentRangeStart` / `w:commentRangeEnd` + `w:commentReference`。 */
export interface CommentMark {
  readonly kind: 'comment';
  readonly start: number;
  readonly end: number;
  readonly id: number;
}

/**
 * `w:hyperlink` **包装**区间。
 *
 * `relationship_id` 与 `anchor` **二选一**（外部走关系、内部走书签）；两者都为 `null`
 * 是调用方的错，渲染时抛 `unsupported_reference`。
 */
export interface HyperlinkMark {
  readonly kind: 'hyperlink';
  readonly start: number;
  readonly end: number;
  readonly relationship_id: string | null;
  readonly anchor: string | null;
  readonly tooltip: string | null;
}

/** `w:ins` **包装**区间（被插入的文字已在正文里）。 */
export interface InsertMark {
  readonly kind: 'insert';
  readonly start: number;
  readonly end: number;
  readonly id: number;
  readonly author: string;
  readonly date: string;
}

/** `w:del` **包装**区间（被标记删除的文字**仍在**正文里，区间内的文字写成 `w:delText`）。 */
export interface DeleteMark {
  readonly kind: 'delete';
  readonly start: number;
  readonly end: number;
  readonly id: number;
  readonly author: string;
  readonly date: string;
}

/** 正文里的脚注 / 尾注引用标记（一个 run）。 */
export interface NoteMark {
  readonly kind: 'note';
  readonly start: number;
  readonly end: number;
  readonly note_kind: 'footnote' | 'endnote';
  readonly id: number;
}

/** 交叉引用域（**替换**区间内的文字）。 */
export interface CrossRefMark {
  readonly kind: 'crossref';
  readonly start: number;
  readonly end: number;
  readonly instruction: string;
  readonly cached: string | null;
  readonly dirty: boolean;
}

/**
 * 行内公式（design-05-P9 / WF-091）：把**已经渲染好的** `<m:oMath>` 插在该偏移处。
 *
 * ## 为什么复用"装饰标记"这条通道
 *
 * 公式在段落里的位置语义与书签 / 批注**完全一样**：`(node_id, 码位偏移)` 的一个插入点
 * （R102），而落成字节时要**切开它所在的 run**。那台切分机器（边界驱动的帧栈）已经写在
 * `serializeDecoratedParagraph` 里，且经过既有引用 / 审阅用例的验证；再造一台"公式专用
 * 切分器"就是第二份实现，两边迟早发岔。因此公式作为一个**点元素标记**接进来。
 *
 * 它不是"引用"也不是"审阅"——名字里的"装饰"只表示"插在段落行内序列中间的东西"。
 *
 * `element` 在**计划期**就已渲染好：它只依赖公式结构本身，与文档其余部分无关。
 */
export interface EquationMark {
  readonly kind: 'equation';
  readonly start: number;
  readonly end: number;
  readonly element: XmlElement;
}

export type DecorationMark =
  | BookmarkMark
  | CommentMark
  | HyperlinkMark
  | InsertMark
  | DeleteMark
  | NoteMark
  | CrossRefMark
  | EquationMark;

/** 包装型标记（`w:hyperlink` / `w:ins` / `w:del`）——它们**包住**子元素，不是兄弟元素。 */
export type WrappingMark = HyperlinkMark | InsertMark | DeleteMark;

export function isWrappingMark(mark: DecorationMark): mark is WrappingMark {
  return mark.kind === 'hyperlink' || mark.kind === 'insert' || mark.kind === 'delete';
}

// ---------------------------------------------------------------------------
// 输入 / 产出
// ---------------------------------------------------------------------------

export interface ReviewExportInput {
  /**
   * 待写出的修订记录。
   *
   * **传什么就写什么**：接受 / 拒绝之后 `acceptRevisions` / `rejectRevisions` 返回的
   * `remaining`（未处理记录）正是应该传进来的那一份——于是"接受一条 ⇒ 文字并入正文、
   * 其余仍在文件里被标为修订"是结构上成立的。
   */
  readonly revisions?: readonly RevisionRecord[];
}

export interface TocExportInput {
  /** 目录域落在**哪个段落**上：该段落的原有行内内容被 TOC 域**替换**（域拥有那段文字）。 */
  readonly node_id: NodeId;
  readonly cache: TocCache;
  /** 域指令；省略用 `TOC \o "1-3" \h \z \u`。 */
  readonly instruction?: string;
}

/** 一条待写出的行内公式（design-05-P9 / WF-091）。 */
export interface EquationExportInput {
  /** 公式落在**哪个段落**（`ParagraphNode.id`；公式只能锚在段落里）。 */
  readonly node_id: NodeId;
  /** 插入点在段落里的**码位**偏移（R102）。 */
  readonly offset: number;
  /**
   * 公式内容。`editable` 走 OMML 渲染；`preserved`（导入保留的复杂公式）**拒绝**——
   * 它的字节已经在 run 的未建模片段里、由"保留优先"路径原样写回，走这条通道等于
   * "把没看懂的公式重写一遍"，正是 R105 要挡的事。
   */
  readonly content: EquationContent;
}

/** 导出侧接受的引用 / 审阅 / 公式输入。全空 ⇒ 计划为空 ⇒ 导出逐字节不变。 */
export interface ReferenceExportInput {
  readonly references?: ReferenceIndex;
  readonly review?: ReviewExportInput;
  readonly toc?: TocExportInput;
  /** 行内公式（WF-091）。省略 ⇒ 不写任何一个 `m:oMath`（逐字节不变，R151）。 */
  readonly equations?: readonly EquationExportInput[];
}

/** 一个需要新增 / 改写的部件（关系与内容类型声明由 `export.ts` 补）。 */
export interface NewPartRequest {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly relationship_type: string;
  readonly content_type: string;
}

export interface DecorationPlan {
  /** 段落 id → 该段落的标记（未排序，渲染时按偏移分派）。 */
  readonly marks: ReadonlyMap<NodeId, readonly DecorationMark[]>;
  /** 新增的**关系**（只含超链接一条通道；部件关系由 `export.ts` 走既有机制追加）。 */
  readonly appended_records: readonly RelationshipRecord[];
  /** 需要新增 / 改写的部件。 */
  readonly part_requests: readonly NewPartRequest[];
  readonly toc_node_id: NodeId | null;
  readonly toc_paragraphs: readonly XmlElement[];
  /** 被跳过的锚点（失效 / 无处安放），逐条说明原因——不是静默丢弃（R110）。 */
  readonly skipped: readonly string[];
}

export const EMPTY_DECORATION_PLAN: DecorationPlan = {
  marks: new Map(),
  appended_records: [],
  part_requests: [],
  toc_node_id: null,
  toc_paragraphs: [],
  skipped: [],
};

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

/**
 * 由模型 + 引用侧表 + 审阅记录算出装饰计划。
 *
 * @param originals 包内既有部件（`opaque_parts` 的路径 → 字节）；用于读既有
 *   `word/comments.xml` 等的**已用 id**，以及决定"合并"还是"新建"。
 * @param baseRecords 已经解析过（并可能已补过节引用）的**完整**关系表。
 *   新分配的关系 id 一定大于其中任何既有编号（`nextRelationshipId`），且**追加在末尾**（R106）。
 */
export function planDecorations(
  model: DocumentModel,
  input: ReferenceExportInput,
  mainPartPath: string,
  originals: ReadonlyMap<string, Uint8Array>,
  baseRecords: readonly RelationshipRecord[],
): DecorationPlan {
  const marks = new Map<NodeId, DecorationMark[]>();
  const skipped: string[] = [];
  const push = (nodeId: NodeId, mark: DecorationMark): void => {
    const list = marks.get(nodeId);
    if (list === undefined) marks.set(nodeId, [mark]);
    else list.push(mark);
  };

  const appended: RelationshipRecord[] = [];
  const allRecords = (): readonly RelationshipRecord[] => [...baseRecords, ...appended];
  const allocateRelationshipId = (): string =>
    nextRelationshipId(allRecords().filter((record) => record.owner_part_path === mainPartPath));

  const rawFragments = collectRawXmlFragments(model.blocks);

  // ---- 书签（WF-071/072）----------------------------------------------------
  let nextBookmarkId =
    maxNumericIdInRawXml(rawFragments, ['w:bookmarkStart', 'w:bookmarkEnd']) + 1;
  const usedBookmarkNames = new Set<string>();
  const bookmarks = input.references?.bookmarks ?? [];
  for (const bookmark of bookmarks) {
    if (!bookmark.intact) {
      skipped.push(`书签 "${bookmark.name}" 已失效（目标文字被删除）⇒ 不写出。`);
      continue;
    }
    usedBookmarkNames.add(bookmark.name);
    push(bookmark.range.node_id, {
      kind: 'bookmark',
      start: bookmark.range.start,
      end: bookmark.range.end,
      id: nextBookmarkId,
      name: bookmark.name,
    });
    nextBookmarkId += 1;
  }

  // ---- 超链接（WF-071）------------------------------------------------------
  for (const hyperlink of input.references?.hyperlinks ?? []) {
    if (!hyperlink.intact) {
      skipped.push(`超链接 "${hyperlink.id}" 已失效 ⇒ 不写出。`);
      continue;
    }
    const target = hyperlink.target;
    if (target.kind === 'internal') {
      const bookmark = bookmarks.find((candidate) => candidate.name === target.bookmark);
      if (bookmark === undefined || !bookmark.intact) {
        skipped.push(
          `超链接 "${hyperlink.id}" 的内部目标书签 "${target.bookmark}" 不存在或已失效 ⇒ 不写出。`,
        );
        continue;
      }
      push(hyperlink.range.node_id, {
        kind: 'hyperlink',
        start: hyperlink.range.start,
        end: hyperlink.range.end,
        relationship_id: null,
        anchor: target.bookmark,
        tooltip: hyperlink.screen_tip,
      });
      continue;
    }
    // 外部 / 邮件：写一条 `TargetMode="External"` 的关系；**不做任何取**（R161）。
    let relationshipId: string | null = null;
    if (target.kind === 'external' && target.relationship_id !== null) {
      const reusable = allRecords().find(
        (record) =>
          record.owner_part_path === mainPartPath &&
          record.id === target.relationship_id &&
          record.target_mode === 'External',
      );
      if (reusable !== undefined) relationshipId = reusable.id;
    }
    if (relationshipId === null) {
      relationshipId = allocateRelationshipId();
      const record = externalRelationshipFor(hyperlink, relationshipId, mainPartPath);
      if (record === null) {
        // 只有 internal 才返回 null，上面已经处理过；走到这里说明形状变了。
        throw new DocxError(
          'unsupported_reference',
          `超链接 "${hyperlink.id}" 的目标类型与关系构造不一致：${target.kind}。`,
        );
      }
      appended.push(createRelationship(record));
    }
    push(hyperlink.range.node_id, {
      kind: 'hyperlink',
      start: hyperlink.range.start,
      end: hyperlink.range.end,
      relationship_id: relationshipId,
      anchor: null,
      tooltip: hyperlink.screen_tip,
    });
  }

  // ---- 交叉引用（WF-075）----------------------------------------------------
  const referenceIndex: ReferenceIndex = input.references ?? {
    bookmarks: [],
    hyperlinks: [],
    notes: [],
    cross_references: [],
  };
  /** 目标 `node_id` → 已补出来的书签名（同一个标题被引用多次只补一个书签）。 */
  const referenceBookmarks = new Map<NodeId, string>();
  const ensureBookmarkName = (target: CrossRefTarget): string | null => {
    if (target.kind === 'bookmark') {
      const bookmark = referenceIndex.bookmarks.find((candidate) => candidate.id === target.bookmark_id);
      if (bookmark === undefined || !bookmark.intact) return null;
      return bookmark.name;
    }
    const nodeId = target.node_id;
    if (nodeId === null) return null;
    const existing = referenceBookmarks.get(nodeId);
    if (existing !== undefined) return existing;
    const paragraph = findParagraphById(model.blocks, nodeId);
    if (paragraph === null) return null;
    const name = uniqueBookmarkName(`_Ref_${sanitizeBookmarkName(nodeId)}`, usedBookmarkNames);
    usedBookmarkNames.add(name);
    referenceBookmarks.set(nodeId, name);
    push(nodeId, {
      kind: 'bookmark',
      start: 0,
      end: paragraphText(paragraph).length,
      id: nextBookmarkId,
      name,
    });
    nextBookmarkId += 1;
    return name;
  };
  for (const reference of input.references?.cross_references ?? []) {
    const mark = crossReferenceMark(reference, ensureBookmarkName, skipped);
    if (mark !== null) push(reference.range.node_id, mark);
  }

  // ---- 脚注 / 尾注（WF-074）-------------------------------------------------
  const footnoteEntries: { id: number; text: string }[] = [];
  const endnoteEntries: { id: number; text: string }[] = [];
  let nextFootnoteId = maxNumericIdInPart(originals.get(FOOTNOTES_PART_PATH) ?? null, ['footnote']) + 1;
  let nextEndnoteId = maxNumericIdInPart(originals.get(ENDNOTES_PART_PATH) ?? null, ['endnote']) + 1;
  for (const note of input.references?.notes ?? []) {
    if (note.kind === 'footnote') {
      footnoteEntries.push({ id: nextFootnoteId, text: note.text });
      push(note.marker.node_id, {
        kind: 'note',
        start: note.marker.start,
        end: note.marker.end,
        note_kind: 'footnote',
        id: nextFootnoteId,
      });
      nextFootnoteId += 1;
    } else {
      endnoteEntries.push({ id: nextEndnoteId, text: note.text });
      push(note.marker.node_id, {
        kind: 'note',
        start: note.marker.start,
        end: note.marker.end,
        note_kind: 'endnote',
        id: nextEndnoteId,
      });
      nextEndnoteId += 1;
    }
  }

  // ---- 批注（WF-077）--------------------------------------------------------
  const commentEntries: { id: number; author: string; date: string | null; text: string }[] = [];
  let nextCommentId = maxNumericIdInPart(originals.get(COMMENTS_PART_PATH) ?? null, ['comment']) + 1;
  for (const comment of model.comments) {
    // **导入批注：保留优先**（R151）。导入时批注的两半都还在包里——正文里
    // `w:commentRangeStart/End` + `w:commentReference` 作为未建模片段原样保留，
    // `word/comments.xml` 整份在 `opaque_parts` 里逐字节保留。这里若照常补标记 + 重写部件，
    // 就会写出**第二份**标记、并用**新分配的 id** 覆盖原注释体 → 同一份文档导出后字节变了，
    // 且新引用指向的 id 在原注释体里并不存在。因此导入批注**不重写**，如实记进 `skipped`。
    const origin = importedCommentOriginOf(comment);
    if (origin !== null) {
      if (comment.author !== origin.author || comment.text !== origin.text) {
        // 改过的导入批注**不能**静默按原样保留（等于把用户的修改丢掉，R110），
        // 也不能只写一半（正文引用配对的是原 `w:id`）。按 R140 在写出前**具名拒绝**。
        throw new DocxError(
          'unsupported_reference',
          `批注 "${comment.id}" 是从包里导入的（原 w:id=${String(origin.ooxml_id)}）且已被修改：` +
            '导入批注的正文引用与注释体都按原字节保留，本批还不能把"改过的导入批注"写回。' +
            '请先删除该批注再以新批注的身份重建。',
        );
      }
      skipped.push(
        `批注 "${comment.id}" 是导入批注（原 w:id=${String(origin.ooxml_id)}）：` +
          '正文标记与 word/comments.xml 都已在原包里逐字节保留，不二次写出。',
      );
      continue;
    }
    if (comment.anchor === null) {
      skipped.push(`批注 "${comment.id}" 没有锚点 ⇒ 无法定位置，不写出。`);
      continue;
    }
    commentEntries.push({ id: nextCommentId, author: comment.author, date: null, text: comment.text });
    push(comment.anchor.node_id, {
      kind: 'comment',
      start: comment.anchor.start,
      end: comment.anchor.end,
      id: nextCommentId,
    });
    nextCommentId += 1;
  }

  // ---- 修订（WF-078/079）----------------------------------------------------
  let nextRevisionId = maxNumericIdInRawXml(rawFragments, ['w:ins', 'w:del']) + 1;
  for (const record of input.review?.revisions ?? []) {
    if (record.kind === 'format') {
      throw new DocxError(
        'unsupported_revision',
        `格式类修订 "${record.id}" 还不能写出：OOXML 要用 w:rPrChange / w:pPrChange 把**旧的**` +
          '属性嵌进 run/段落，而 FormatChange.before/after 是 unknown，导出器写不出合法属性元素。' +
          '跳过等于静默丢掉一条审阅记录（R110），因此按 R140 在写出前拒绝。',
      );
    }
    if (record.range.end < record.range.start) {
      throw new DocxError(
        'unsupported_revision',
        `修订 "${record.id}" 的范围起止倒置：[${record.range.start}, ${record.range.end})。`,
      );
    }
    push(record.range.node_id, {
      kind: record.kind === 'insert' ? 'insert' : 'delete',
      start: record.range.start,
      end: record.range.end,
      id: nextRevisionId,
      author: record.author,
      date: record.date,
    });
    nextRevisionId += 1;
  }

  // ---- 部件（脚注 / 尾注 / 批注）--------------------------------------------
  const partRequests: NewPartRequest[] = [];
  if (footnoteEntries.length > 0) {
    partRequests.push({
      path: FOOTNOTES_PART_PATH,
      bytes: utf8(notesPartXml('footnote', footnoteEntries, originals.get(FOOTNOTES_PART_PATH) ?? null)),
      relationship_type: FOOTNOTES_RELATIONSHIP_TYPE,
      content_type: FOOTNOTES_CONTENT_TYPE,
    });
  }
  if (endnoteEntries.length > 0) {
    partRequests.push({
      path: ENDNOTES_PART_PATH,
      bytes: utf8(notesPartXml('endnote', endnoteEntries, originals.get(ENDNOTES_PART_PATH) ?? null)),
      relationship_type: ENDNOTES_RELATIONSHIP_TYPE,
      content_type: ENDNOTES_CONTENT_TYPE,
    });
  }
  if (commentEntries.length > 0) {
    partRequests.push({
      path: COMMENTS_PART_PATH,
      bytes: utf8(commentsPartXml(commentEntries, originals.get(COMMENTS_PART_PATH) ?? null)),
      relationship_type: COMMENTS_RELATIONSHIP_TYPE,
      content_type: COMMENTS_CONTENT_TYPE,
    });
  }

  // ---- 目录（WF-073）--------------------------------------------------------
  let tocNodeId: NodeId | null = null;
  let tocParagraphs: readonly XmlElement[] = [];
  if (input.toc !== undefined) {
    if (findParagraphById(model.blocks, input.toc.node_id) === null) {
      throw new DocxError(
        'unsupported_reference',
        `目录要落在的段落 "${input.toc.node_id}" 在文档里不存在：不能把目录写到一个空气段落上。`,
      );
    }
    tocNodeId = input.toc.node_id;
    tocParagraphs = tocFieldParagraphs(input.toc.cache, input.toc.instruction ?? DEFAULT_TOC_INSTRUCTION);
  }

  // ---- 行内公式（WF-091 / design-05-P9）-------------------------------------
  for (const equation of input.equations ?? []) {
    if (equation.content.kind === 'preserved') {
      throw new DocxError(
        'unsupported_equation',
        `公式（段落 "${equation.node_id}"）是"导入保留"的复杂结构，不能走公式导出通道：` +
          '它的字节已在 run 的未建模片段里、由"保留优先"路径原样写回；经由这里重写一遍，' +
          '就是把没看懂的结构重新拼一次，正是 R105 要挡的事。',
      );
    }
    const paragraph = findParagraphById(model.blocks, equation.node_id);
    if (paragraph === null) {
      throw new DocxError(
        'unsupported_equation',
        `公式要落的段落 "${equation.node_id}" 在文档里不存在：公式只能锚在真实段落上。`,
      );
    }
    const total = paragraphText(paragraph).length;
    if (
      !Number.isInteger(equation.offset) ||
      equation.offset < 0 ||
      equation.offset > total
    ) {
      throw new DocxError(
        'unsupported_equation',
        `公式插入偏移 ${String(equation.offset)} 超出段落 "${equation.node_id}" 的码位长度 ` +
          `${String(total)}：越界偏移不得夹紧到边界（R136 的同一取向）。`,
      );
    }
    let element;
    try {
      element = equationElement(equation.content.equation);
    } catch (error) {
      throw new DocxError(
        'unsupported_equation',
        error instanceof Error ? error.message : `公式渲染失败：${String(error)}`,
      );
    }
    push(equation.node_id, {
      kind: 'equation',
      start: equation.offset,
      end: equation.offset,
      element,
    });
  }

  return {
    marks,
    appended_records: appended,
    part_requests: partRequests,
    toc_node_id: tocNodeId,
    toc_paragraphs: tocParagraphs,
    skipped,
  };
}

/**
 * 交叉引用 → 域标记。
 *
 * `show:'page'` 已经被模型层按 R158 拒绝过（`createCrossReference` 允许建但 `resolve` 拒绝；
 * 这里仍然照 `show` 选择指令开关）。目标解析不到 ⇒ `skipped`，**不伪造**。
 */
function crossReferenceMark(
  reference: CrossReference,
  bookmarkNameOf: (target: CrossRefTarget) => string | null,
  skipped: string[],
): CrossRefMark | null {
  if (!reference.intact) {
    skipped.push(`交叉引用 "${reference.id}" 已失效 ⇒ 不写出。`);
    return null;
  }
  const name = bookmarkNameOf(reference.target);
  if (name === null) {
    skipped.push(
      `交叉引用 "${reference.id}" 的目标（${reference.target.kind}）解析不到落点 ⇒ 不写出（不伪造引用）。`,
    );
    return null;
  }
  // `\n` = 取目标段落的序号（show:'number'）；`\h` = 生成超链接。
  const switches = reference.show === 'number' ? '\\n \\h' : '\\h';
  return {
    kind: 'crossref',
    start: reference.range.start,
    end: reference.range.end,
    instruction: ` REF ${name} ${switches} `,
    cached: reference.cached_text,
    // 只有"已刷新"才不是 dirty——写入指令 ≠ 已计算（R158）。
    dirty: reference.refresh_state !== 'refreshed',
  };
}

/** 由稳定 `node_id` 派生一个合法的书签名片段（OOXML 书签名限字母/数字/下划线，≤40 字符）。 */
function sanitizeBookmarkName(nodeId: string): string {
  const cleaned = nodeId.replace(/[^A-Za-z0-9_]/g, '_');
  return cleaned.length === 0 ? 'x' : cleaned.slice(0, 30);
}

/** 保证书签名唯一（重名书签会让 `w:anchor` 指到不确定的一个）。 */
function uniqueBookmarkName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** 把模型块里所有未建模片段的 XML 文本收集出来（用于扫既有 id）。 */
function collectRawXmlFragments(blocks: readonly BlockNode[]): readonly string[] {
  const out: string[] = [];
  const scanOpaque = (opaque: readonly unknown[]): void => {
    for (const item of opaque) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const kind = record['kind'];
      if (kind !== 'raw_at_char' && kind !== 'raw_before_node' && kind !== 'raw_before_block') {
        continue;
      }
      const xml = record['xml'];
      if (typeof xml === 'string') out.push(xml);
    }
  };
  const visit = (list: readonly BlockNode[]): void => {
    for (const block of list) {
      scanOpaque(block.opaque);
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) scanOpaque(inline.opaque);
        continue;
      }
      for (const row of block.rows) {
        scanOpaque(row.opaque);
        for (const cell of row.cells) {
          scanOpaque(cell.opaque);
          visit(cell.blocks);
        }
      }
    }
  };
  visit(blocks);
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
