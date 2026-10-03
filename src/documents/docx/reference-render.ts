/**
 * 引用与审阅的**导出侧渲染原语**（design-05-P7 的导出收口；WF-071–079）。
 *
 * ## 本文件为什么存在
 *
 * WCF-D31 交付了 `src/documents/references/**` 与 `src/documents/review/**`（模型 / 操作层）：
 * 书签不漂移、交叉引用不断链、目录只出结构不编页码、批注锚到指定处、修订给局部差异。
 * 但那些模块**一个字节的 OOXML 都不写**——`w:bookmarkStart` / `w:hyperlink` /
 * `w:footnoteReference` / `w:fldSimple` / `w:commentRangeStart` / `w:ins` / `w:del`
 * 全部缺失。本文件补齐"模型态 → OOXML 元素"这一层，`decoration-plan.ts` 负责编排，
 * `export.ts` 负责接线。
 *
 * ## 三条纪律（都能被结构性地复核）
 *
 * 1. **外部目标只写关系，绝不抓取**（R161）：`hyperlinkElement` 只接受一个**已经分配好的**
 *    `r:id` 与一段显示文字；本文件里**不存在**任何 `fetch` / `http` / `fs` 调用，
 *    也没有"验证 URL 可达"这种步骤。外部链接的 `TargetMode="External"` 关系由
 *    `references/hyperlinks.ts` 的 `externalRelationshipFor` 构造——它同样只构造记录。
 * 2. **域只写指令 + 刷新状态，不编造页码**（R158）：`fieldRun` / `crossReferenceFieldElement`
 *    / `tocFieldParagraphs` 三处都只把 `instruction` 与"是否已刷新"写进文件；
 *    `refresh_state !== 'refreshed'` 时统一打 `w:dirty="true"`——**这个标记就是"未刷新"**，
 *    而不是"一个算出来的数字"。本文件里没有任何"页数/页码"计算。
 * 3. **新增部件必须配套关系与内容类型声明**（R106）：本文件只产出**部件字节**；
 *    `.rels` 与 `[Content_Types].xml` 的补写由 `export.ts` 复用既有机制
 *    （`attachNewPart` + `ensureContentTypeEntry`）完成——**既有 rId 的编号与顺序一个不动**。
 *
 * ## 与 Word 自带输出的两处**有意偏离**（都在已知缺口里登记）
 *
 * | 项 | Word 的写法 | 本文件的写法 | 为什么 |
 * |---|---|---|---|
 * | 脚注引用标记的格式 | `w:rStyle w:val="FootnoteReference"` | 直接格式 `w:vertAlign w:val="superscript"` | `FootnoteReference` 是 styles.xml 里的内部样式；改 styles.xml 不在本波次写权内，写一个**指向不存在样式的 `w:rStyle`** 就是造悬空引用。直接格式自洽且不依赖外部部件。 |
 * | 目录条目的样式 | `w:pStyle w:val="TOC1"` | 直接缩进 `w:ind w:left`（按层级） | 同上。 |
 */

import { attr, el, serializeXmlNode, type XmlElement } from '../../artifacts/ooxml/xml.js';
import type { TocCache, TocEntry } from '../references/types.js';
import { flattenToc } from '../references/toc.js';
import { DocxError } from './docx-error.js';
import { R_NS, W_NS } from './word-xml.js';
import { attributeValue, childElements, parseXmlBytes, type ParsedXmlElement } from './xml-parse.js';
import { convertParsedElement } from './xml-patch.js';

// ---------------------------------------------------------------------------
// 部件路径 / 内容类型 / 关系类型
// ---------------------------------------------------------------------------

/** 脚注部件。**原包里可能不存在**——不存在时要新建（复用 D30 的新增部件机制）。 */
export const FOOTNOTES_PART_PATH = 'word/footnotes.xml';
/** 尾注部件。 */
export const ENDNOTES_PART_PATH = 'word/endnotes.xml';
/** 批注部件。 */
export const COMMENTS_PART_PATH = 'word/comments.xml';

export const FOOTNOTES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';
export const ENDNOTES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml';
export const COMMENTS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

const RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const FOOTNOTES_RELATIONSHIP_TYPE = `${RELATIONSHIP_BASE}/footnotes`;
export const ENDNOTES_RELATIONSHIP_TYPE = `${RELATIONSHIP_BASE}/endnotes`;
export const COMMENTS_RELATIONSHIP_TYPE = `${RELATIONSHIP_BASE}/comments`;
/** 与 `references/hyperlinks.ts` 的 `HYPERLINK_RELATIONSHIP_TYPE` **同一个 URI**（两处各写一份常量，值必须一致）。 */
export const HYPERLINK_RELATIONSHIP_TYPE = `${RELATIONSHIP_BASE}/hyperlink`;

/** 默认目录域指令：1–3 级标题、超链接、隐藏页码、使用大纲级别。 */
export const DEFAULT_TOC_INSTRUCTION = 'TOC \\o "1-3" \\h \\z \\u';

// ---------------------------------------------------------------------------
// 行内元素
// ---------------------------------------------------------------------------

/** `w:bookmarkStart`——书签**起点**（`w:id` 为文档内唯一的整数）。 */
export function bookmarkStartElement(id: number, name: string): XmlElement {
  return el('w:bookmarkStart', [attr('w:id', String(id)), attr('w:name', name)]);
}

/** `w:bookmarkEnd`——书签**终点**；与起点**同一个 `w:id`**（配对靠它，不靠位置）。 */
export function bookmarkEndElement(id: number): XmlElement {
  return el('w:bookmarkEnd', [attr('w:id', String(id))]);
}

/** `w:commentRangeStart`——批注锚定范围的起点。 */
export function commentRangeStartElement(id: number): XmlElement {
  return el('w:commentRangeStart', [attr('w:id', String(id))]);
}

/** `w:commentRangeEnd`——批注锚定范围的终点。 */
export function commentRangeEndElement(id: number): XmlElement {
  return el('w:commentRangeEnd', [attr('w:id', String(id))]);
}

/**
 * 批注引用标记（必须紧跟在 `w:commentRangeEnd` 之后的一个 run 里，否则 Word 认为批注**没有被引用**）。
 *
 * 这里**不加**上下标格式：引用标记在 Word 里由 `CommentReference` 字符样式呈现，
 * 而该样式不在本波次写权内（同文件头的偏离说明）。
 */
export function commentReferenceRun(id: number): XmlElement {
  return el('w:r', [], [el('w:commentReference', [attr('w:id', String(id))])]);
}

/** 脚注 / 尾注的正文引用标记（`w:footnoteReference` / `w:endnoteReference`）。 */
export function noteReferenceRun(kind: 'footnote' | 'endnote', id: number): XmlElement {
  const tag = kind === 'footnote' ? 'w:footnoteReference' : 'w:endnoteReference';
  return el('w:r', [], [
    // 直接格式的"上标"（Word 的 FootnoteReference / EndnoteReference 样式核心就是这个）。
    el('w:rPr', [], [el('w:vertAlign', [attr('w:val', 'superscript')])]),
    el(tag, [attr('w:id', String(id))]),
  ]);
}

export interface HyperlinkElementInput {
  /** 外部 / 邮件链接：主部件关系表里的 `r:id`（`TargetMode="External"`）。内部链接为 `null`。 */
  readonly relationship_id: string | null;
  /** 内部链接：目标书签名（`w:anchor`）。外部链接为 `null`。 */
  readonly anchor: string | null;
  readonly tooltip: string | null;
}

/**
 * `w:hyperlink`（**包装元素**：它的子节点是被链接的那几个 run）。
 *
 * 二选一：`r:id`（外部/邮件，走关系，**不抓取**，R161）或 `w:anchor`（内部书签）。
 * 两者都给或都不给都是调用方的错——直接抛错，不写一个指向空气的链接。
 */
export function hyperlinkElement(input: HyperlinkElementInput, children: readonly XmlElement[]): XmlElement {
  const attributes = [];
  if (input.anchor !== null) attributes.push(attr('w:anchor', input.anchor));
  if (input.relationship_id !== null) attributes.push(attr('r:id', input.relationship_id));
  if (input.tooltip !== null && input.tooltip.length > 0) attributes.push(attr('w:tooltip', input.tooltip));
  if (input.anchor === null && input.relationship_id === null) {
    throw new DocxError(
      'unsupported_reference',
      '超链接既没有 r:id（外部目标）也没有 w:anchor（内部书签）：写出去就是一个指向空气的链接。',
    );
  }
  return el('w:hyperlink', attributes, children);
}

/**
 * 交叉引用——以**域**形式产出（WF-075），指令如 ` REF bm0 \h `。
 *
 * `cached` 是上次解析出来的显示文字（模型里的 `cached_text`），可以为 `null`（从未解析）；
 * `dirty` 为真时打 `w:dirty="true"`——**这就是"未刷新"的显式标记**（R158），
 * 而不是替用户算一个引用结果。
 */
export function crossReferenceFieldElement(
  instruction: string,
  cached: string | null,
  dirty: boolean,
): XmlElement {
  const attributes = [attr('w:instr', instruction)];
  if (dirty) attributes.push(attr('w:dirty', 'true'));
  const children =
    cached === null || cached.length === 0
      ? []
      : [el('w:r', [], [el('w:t', [attr('xml:space', 'preserve')], [cached])])];
  return el('w:fldSimple', attributes, children);
}

/** 把一段文字包成 run（`xml:space="preserve"`，空串也保留一个空 `w:t`）。 */
export function textRun(text: string): XmlElement {
  return el('w:r', [], [el('w:t', [attr('xml:space', 'preserve')], [text])]);
}

// ---------------------------------------------------------------------------
// 目录（WF-074）
// ---------------------------------------------------------------------------

/**
 * 目录域——**多个段落**（复杂域跨段落：begin / 条目 / end 各在自己段落里）。
 *
 * R158：`refresh_state !== 'refreshed'` 时**不写任何页码**，并给 begin 打 `w:dirty="true"`。
 * 条目只写标题文字与层级缩进——**结构**，没有页码；页码由消费端更新域时才算。
 */
export function tocFieldParagraphs(cache: TocCache, instruction: string): readonly XmlElement[] {
  const dirty = cache.refresh_state !== 'refreshed';
  const begin = el('w:p', [], [
    el('w:r', [], [
      el('w:fldChar', [
        attr('w:fldCharType', 'begin'),
        ...(dirty ? [attr('w:dirty', 'true')] : []),
      ]),
    ]),
    el('w:r', [], [el('w:instrText', [attr('xml:space', 'preserve')], [instruction])]),
    el('w:r', [], [el('w:fldChar', [attr('w:fldCharType', 'separate')])]),
  ]);
  const entries = flattenToc(cache.entries).map((entry) => tocEntryParagraph(entry));
  const end = el('w:p', [], [
    el('w:r', [], [el('w:fldChar', [attr('w:fldCharType', 'end')])]),
  ]);
  return [begin, ...entries, end];
}

/**
 * 一个目录条目段落。
 *
 * 用**直接缩进**表达层级，不写 `w:pStyle w:val="TOC1"`：TOC 样式是否存在于 styles.xml
 * 本波次管不着，写一个指向不存在样式的引用就是造悬空引用（见文件头）。
 * **不写页码**——`TocEntry` 里本来就没有页码字段（R158）。
 */
function tocEntryParagraph(entry: TocEntry): XmlElement {
  const indent = String((Math.max(1, entry.level) - 1) * 240);
  return el('w:p', [], [
    el('w:pPr', [], [el('w:ind', [attr('w:left', indent)])]),
    textRun(entry.text),
  ]);
}

// ---------------------------------------------------------------------------
// 部件：脚注 / 尾注 / 批注
// ---------------------------------------------------------------------------

/** 一条注记：`id` 为文件内唯一整数，`text` 为注文。 */
export interface NoteEntry {
  readonly id: number;
  readonly text: string;
}

/** 一条批注：`id` 为文件内唯一整数。 */
export interface CommentEntry {
  readonly id: number;
  readonly author: string;
  readonly date: string | null;
  readonly text: string;
}

/**
 * 脚注 / 尾注部件字节。
 *
 * `existing === null` 时**全新建**：除本波次的注以外，还写入 Word 约定的两条分隔符注
 * （`w:type="separator"` id `-1` 与 `w:type="continuationSeparator"` id `0`）——
 * 真实的 `footnotes.xml` 都有它们，缺了会让部分消费端把注文区渲染得很奇怪。
 * `existing !== null` 时**合并**：原根元素的全部子节点**原样保留在原位**（R105），
 * 新注追加在末尾，根元素的命名空间声明也从原件照抄。
 */
export function notesPartXml(
  kind: 'footnote' | 'endnote',
  notes: readonly NoteEntry[],
  existing: Uint8Array | null,
): string {
  const isFootnote = kind === 'footnote';
  const rootLocal = isFootnote ? 'footnotes' : 'endnotes';
  const itemTag = isFootnote ? 'w:footnote' : 'w:endnote';
  const refTag = isFootnote ? 'w:footnoteRef' : 'w:endnoteRef';

  const preserved = existing === null ? [] : rootChildElements(existing, rootLocal);
  const separators =
    existing === null
      ? [
          separatorNote(itemTag, refTag, -1, 'separator'),
          separatorNote(itemTag, refTag, 0, 'continuationSeparator'),
        ]
      : [];
  const added = notes.map((note) => noteElement(itemTag, refTag, note.id, note.text));

  const root =
    existing === null
      ? el(`w:${rootLocal}`, [attr('xmlns:w', W_NS), attr('xmlns:r', R_NS)], [])
      : rootShell(existing, rootLocal);
  return wrapPart(el(root.name, root.attributes, [...preserved, ...separators, ...added]));
}

/**
 * 批注部件字节。语义与 `notesPartXml` 一致（`existing === null` 全新建、否则合并保留）。
 */
export function commentsPartXml(comments: readonly CommentEntry[], existing: Uint8Array | null): string {
  const preserved = existing === null ? [] : rootChildElements(existing, 'comments');
  const added = comments.map((comment) => commentElement(comment));
  const root =
    existing === null
      ? el('w:comments', [attr('xmlns:w', W_NS), attr('xmlns:r', R_NS)], [])
      : rootShell(existing, 'comments');
  return wrapPart(el(root.name, root.attributes, [...preserved, ...added]));
}

function wrapPart(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(root)}`;
}

/** 原根元素的"外壳"（名字 + 属性 → 命名空间声明全部照抄）。 */
function rootShell(bytes: Uint8Array, localName: string): XmlElement {
  const root = parseXmlBytes(bytes);
  if (root.localName !== localName) {
    throw new DocxError(
      'malformed_annotation_part',
      `既有部件 ${localName} 的根元素不是 <${localName}>（实际 <${root.name}>）：不能往里合并内容。`,
    );
  }
  return el(
    root.name,
    root.attributes.map((attribute) => attr(attribute.name, attribute.value)),
    [],
  );
}

/** 既有部件的**全部子元素**（保序、保属性、保文本；命名空间声明在根上已照抄）。 */
function rootChildElements(bytes: Uint8Array, localName: string): readonly XmlElement[] {
  const root = parseXmlBytes(bytes);
  if (root.localName !== localName) {
    throw new DocxError(
      'malformed_annotation_part',
      `既有部件 ${localName} 的根元素不是 <${localName}>（实际 <${root.name}>）：不能往里合并内容。`,
    );
  }
  return childElements(root).map((child) => convertParsedElement(child));
}

/** `w:footnote` / `w:endnote` 的分隔符注（id `-1` / `0`，Word 约定）。 */
function separatorNote(
  itemTag: string,
  _refTag: string,
  id: number,
  type: 'separator' | 'continuationSeparator',
): XmlElement {
  const marker = type === 'separator' ? el('w:separator') : el('w:continuationSeparator');
  return el(itemTag, [attr('w:type', type), attr('w:id', String(id))], [
    el('w:p', [], [el('w:r', [], [marker])]),
  ]);
}

/** 一条注记元素（首段带自动编号标记 `w:footnoteRef` / `w:endnoteRef`，多行拆成多段）。 */
function noteElement(itemTag: string, refTag: string, id: number, text: string): XmlElement {
  const lines = text.split('\n');
  const paragraphs = lines.map((line, index) => {
    const children: XmlElement[] = [];
    if (index === 0) {
      children.push(
        el('w:r', [], [
          el('w:rPr', [], [el('w:vertAlign', [attr('w:val', 'superscript')])]),
          el(refTag, [], []),
        ]),
      );
    }
    if (line.length > 0) children.push(textRun(line));
    return el('w:p', [], children);
  });
  if (paragraphs.length === 0) paragraphs.push(el('w:p', [], []));
  return el(itemTag, [attr('w:id', String(id))], paragraphs);
}

/** 一条批注元素。`w:date` 只在真的给了非空值时写（不编造时间）。 */
function commentElement(comment: CommentEntry): XmlElement {
  const attributes = [attr('w:id', String(comment.id)), attr('w:author', comment.author)];
  if (comment.date !== null && comment.date.length > 0) attributes.push(attr('w:date', comment.date));
  const paragraphs = comment.text.split('\n').map((line) =>
    el('w:p', [], line.length === 0 ? [] : [textRun(line)]),
  );
  if (paragraphs.length === 0) paragraphs.push(el('w:p', [], []));
  return el('w:comment', attributes, paragraphs);
}

// ---------------------------------------------------------------------------
// 既有部件里的 id 扫描（避免新 id 与既有 id 撞号）
// ---------------------------------------------------------------------------

/**
 * 某个部件里已经用掉的 `w:id` 最大值（只看 `elementNames` 里的元素）。
 *
 * 合并进既有部件时，新 id 必须**大于**既有最大值，否则会出现"两条 `w:comment` 同一个 id"——
 * 那会让 `w:commentReference` 指到不确定的一条。找不到（或没有该部件）⇒ `0`。
 */
export function maxNumericIdInPart(
  bytes: Uint8Array | null,
  elementNames: readonly string[],
): number {
  if (bytes === null) return 0;
  let root: ParsedXmlElement;
  try {
    root = parseXmlBytes(bytes);
  } catch {
    return 0;
  }
  let max = 0;
  for (const child of childElements(root)) {
    if (!elementNames.includes(child.localName)) continue;
    const raw = attributeValue(child, W_NS, 'id');
    if (raw === null) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return max;
}

/**
 * 正文里已经用掉的同类 id 最大值（扫未建模片段）。
 *
 * 导入保留的 `w:bookmarkStart` / `w:commentRangeStart` / `w:ins` 等**带着原来的整数 id**
 * 躺在 `opaque` 里，新分配的 id 必须避开它们，否则同一份文档里会出现两组同号标记。
 * **已知缺口**：只扫未建模片段（`raw_at_char` / `raw_before_node` / `raw_before_block`）；
 * 若导入侧将来把这些元素建模，扫描范围要跟着改。
 */
export function maxNumericIdInRawXml(
  xmlFragments: readonly string[],
  elementNames: readonly string[],
): number {
  let max = 0;
  for (const xml of xmlFragments) {
    for (const name of elementNames) {
      const pattern = new RegExp(`<${name}\\b[^>]*?\\sw:id="(-?\\d+)"`, 'g');
      for (const match of xml.matchAll(pattern)) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > max) max = parsed;
      }
    }
  }
  return max;
}
