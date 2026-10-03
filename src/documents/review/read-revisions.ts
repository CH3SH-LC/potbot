/**
 * **从真实 OOXML 读回修订**（WF-078 的"导入侧"，补 `docx/import` 把 `w:ins`/`w:del`
 * 当未建模片段保留所留下的缺口）。
 *
 * ## 这一层解决什么
 *
 * `docx/import.ts` 对 `w:ins` / `w:del` 的取向是"**保留优先**"：整段留在段落/run 的
 * `opaque` 里原样保存，**不建进段落文字**。这对"导入后未改动就逐字节写回"（R151）是对的，
 * 但代价是——**外部 Word 文件里的修订，进来了却读不出来**：`review/revisions.ts` 只会
 * 记录"你自己开的修订"，`review/accept.ts` 也只能处理这些记录。于是"打开一份带修订的
 * Word 文件，看看谁改了什么、逐条接受/拒绝"这条最常用的审阅链路缺了入口。
 *
 * 本文件补上这个入口：**只读** `word/document.xml` 的文本，把 `w:ins` / `w:del`
 * 解析成 `RevisionRecord[]`（沿用 `review/types.ts` 的冻结类型，不新增平行类型）。
 *
 * ## 坐标空间：渲染文本（rendered text）
 *
 * Word 的修订语义是"改动的**两半都在 XML 里**"：`w:ins` 里是新文字（包在 `w:t`），
 * `w:del` 里是旧文字（包在 `w:delText`），它们**物理上都在段落的内容流里**。因此本文件
 * 定义段落的 **rendered_text = 按文档顺序拼接全部文字**（普通 `w:t` + `w:ins` 的 `w:t`
 * + `w:del` 的 `w:delText`）。每个 `RevisionRecord.range` 就是这段 rendered_text 里的
 * **码位区间**（与全仓的码位口径一致）。
 *
 * 于是它与 `review/accept.ts` 的语义**天然对齐**：
 * - 插入记录：文字已在正文（rendered），拒绝 ⇒ 删掉它；
 * - 删除记录：文字仍在正文（rendered），接受 ⇒ 才真删。
 * 这正是"接受全部 = 只留普通+插入"、"拒绝全部 = 只留普通+删除"的结构原因。
 *
 * ## 未处理范围不损坏
 *
 * `materializeRevisionModel` 把读出的段落物化成一份 `DocumentModel`，其中每段文字**恰好**
 * 等于 rendered_text。喂给 `acceptRevisions` / `rejectRevisions` 后，**未被选中的记录原样在
 * `remaining` 里、其文字一个码位没动**——引擎本身保证（同段按 `start` 降序落地）。本文件
 * 不自造第二套"应用修改"的逻辑。
 *
 * ## 具名、不静默（R110/R112）
 *
 * 读不出来的东西**逐条报进 `warnings`**：`w:moveFrom`/`w:moveTo`（移动修订，本层未建模）、
 * `w:rPrChange`/`w:pPrChange`（格式修订，需要旧属性嵌进 run/段落，本层不建）、嵌套的
 * `w:ins`/`w:del`、以及在 `w:del` 之外出现的 `w:delText`。**不假装它们不存在**。
 *
 * ## 未验证声明
 *
 * 本层是**模型/字节层**：读出的是 XML 语义，**未**经任何消费端（Word / WPS）打开核对
 * "显示的修订 = 读出的记录"。标 **未验证（需消费端）**。
 *
 * ## 只读复用边界
 *
 * 只读复用 `docx/xml-parse`（解析）、`model/nodes` + `model/document`（物化）、
 * `selection/codepoint`（码位长度）。**不修改**任何一个，也不写 `docx/**`。
 */

import { attributeValue, childElements, directText, parseXml, type ParsedXmlElement } from '../docx/xml-parse.js';
import { createDocumentModel } from '../model/document.js';
import { paragraphNode, runNode, type DraftBlockNode } from '../model/nodes.js';
import type { DocumentModel, ParagraphNode } from '../model/types.js';
import { codePointLength } from '../selection/codepoint.js';
import { collectParagraphs } from '../selection/structure.js';
import type { RevisionRecord } from './types.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 片段类别：普通文字 / 插入（`w:ins`） / 删除（`w:del`）。 */
export type RevisionSegmentKind = 'plain' | 'insert' | 'delete';

/** 段落实考里的一个文字片段。相邻同类同 id 的片段已合并。 */
export interface RevisionSegment {
  readonly kind: RevisionSegmentKind;
  /** `w:ins`/`w:del` 的 `w:id`（整数）；普通片段为 `null`。 */
  readonly revision_source_id: number | null;
  /** `w:author`；普通片段或缺失时为 `null`。 */
  readonly author: string | null;
  /** `w:date`；普通片段或缺失时为 `null`。 */
  readonly date: string | null;
  readonly text: string;
  /** 该片段在 `rendered_text` 里的码位起点。 */
  readonly start: number;
  /** 该片段在 `rendered_text` 里的码位终点（开区间）。 */
  readonly end: number;
}

/** 一个读出的段落。 */
export interface ParsedRevisionParagraph {
  /** 全文文档顺序里的段落序号（0 起）。 */
  readonly paragraph_index: number;
  /** 普通 `w:t` + `w:ins` 文字 + `w:del` 文字，按文档顺序拼接。 */
  readonly rendered_text: string;
  readonly segments: readonly RevisionSegment[];
  /** **只读最终文字**（普通 + 插入；删除的部分被去掉）——"接受全部"的结果。 */
  readonly final_text: string;
  /** **只读原始文字**（普通 + 删除；插入的部分被去掉）——"拒绝全部"的结果。 */
  readonly original_text: string;
}

/** 一条读出的修订（range 尚未绑定到某份模型节点的 id）。 */
export interface ParsedRevisionRecord {
  readonly kind: 'insert' | 'delete';
  /** `w:ins`/`w:del` 的 `w:id`；缺失则为 `null`。 */
  readonly source_id: number | null;
  readonly author: string;
  readonly date: string;
  /** 所属段落在 `paragraphs` 里的下标。 */
  readonly paragraph_index: number;
  /** 码位区间（相对该段落的 `rendered_text`）。 */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** 若嵌在另一条 `w:ins`/`w:del` 里，这里是外层 `w:id`；否则 `null`。 */
  readonly nested_in: number | null;
}

export interface RevisionReadResult {
  readonly paragraphs: readonly ParsedRevisionParagraph[];
  readonly records: readonly ParsedRevisionRecord[];
  /** 读不出来 / 未建模的东西，**逐条具名**（R110）。空数组 = 全读出来了。 */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface RawPiece {
  readonly kind: RevisionSegmentKind;
  readonly id: number | null;
  readonly author: string | null;
  readonly date: string | null;
  readonly text: string;
}

interface RevisionContext {
  readonly kind: RevisionSegmentKind;
  readonly id: number | null;
  readonly author: string | null;
  readonly date: string | null;
}

const PLAIN_CONTEXT: RevisionContext = { kind: 'plain', id: null, author: null, date: null };

function numericId(element: ParsedXmlElement): number | null {
  const raw = attributeValue(element, W_NS, 'id');
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function pushPiece(pieces: RawPiece[], context: RevisionContext, text: string): void {
  if (text.length === 0) return;
  pieces.push({ kind: context.kind, id: context.id, author: context.author, date: context.date, text });
}

/**
 * 递归遍历段落内联子树，按文档顺序收集文字片段。
 *
 * - `w:t`：文字归入**当前**上下文（普通 / 插入 / 删除）；
 * - `w:delText`：只应出现在 `w:del` 里；若上下文不是 `delete`，**报警**后仍按删除片段收下
 *   （丢失文字比归类存疑更糟），但把分类存疑如实写进 warnings；
 * - `w:ins`/`w:del`：进入新的修订上下文；嵌套时**报警**并取**最内层**类别；
 * - `w:moveFrom`/`w:moveTo`：移动修订本层不建模，**报警**后按当前上下文继续收下文字，
 *   不静默丢弃；
 * - `w:rPrChange`/`w:pPrChange`：格式修订本层不建（需要旧属性嵌进 run/段落），**报警**。
 */
function walkInline(
  element: ParsedXmlElement,
  context: RevisionContext,
  pieces: RawPiece[],
  warnings: string[],
): void {
  for (const child of childElements(element)) {
    const { localName, namespace } = child;
    if (namespace === W_NS && (localName === 'ins' || localName === 'del')) {
      const nextKind: RevisionSegmentKind = localName === 'ins' ? 'insert' : 'delete';
      const id = numericId(child);
      if (context.kind !== 'plain') {
        warnings.push(
          `嵌套的 w:${localName}（w:id=${String(id)}，嵌在 w:${context.kind === 'insert' ? 'ins' : 'del'} ` +
            `w:id=${String(context.id)} 里）：本层按最内层类别读取，不动外层。`,
        );
      }
      walkInline(
        child,
        {
          kind: nextKind,
          id,
          author: attributeValue(child, W_NS, 'author'),
          date: attributeValue(child, W_NS, 'date'),
        },
        pieces,
        warnings,
      );
      continue;
    }
    if (namespace === W_NS && localName === 'delText') {
      if (context.kind !== 'delete') {
        warnings.push(
          `w:delText 出现在 w:del 之外（当前上下文为 ${context.kind}）：按删除片段收下，但归类存疑。`,
        );
        pushPiece(pieces, { kind: 'delete', id: context.id, author: context.author, date: context.date }, directText(child));
      } else {
        pushPiece(pieces, context, directText(child));
      }
      continue;
    }
    if (namespace === W_NS && localName === 't') {
      pushPiece(pieces, context, directText(child));
      continue;
    }
    if (namespace === W_NS && (localName === 'moveFrom' || localName === 'moveTo')) {
      warnings.push(
        `移动修订 w:${localName}（w:id=${String(numericId(child))}）本层未建模：其中的文字按当前上下文收下，` +
          '但不产生"移动"记录。',
      );
      walkInline(child, context, pieces, warnings);
      continue;
    }
    if (namespace === W_NS && (localName === 'rPrChange' || localName === 'pPrChange')) {
      warnings.push(
        `格式修订 w:${localName} 本层不建（需要把旧属性嵌进 run/段落）：读不到对应 RevisionRecord。`,
      );
      continue;
    }
    // 其余（w:r / w:hyperlink / w:smartTag / w:fldSimple …）：继续下潜，文字不丢。
    walkInline(child, context, pieces, warnings);
  }
}

/** 合并相邻同类同 id 的片段（同一个 `w:del` 跨多个 run、或连续普通文字）。 */
function mergePieces(pieces: readonly RawPiece[]): readonly RawPiece[] {
  const merged: RawPiece[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.kind === piece.kind && last.id === piece.id) {
      merged[merged.length - 1] = { ...last, text: last.text + piece.text };
      continue;
    }
    merged.push(piece);
  }
  return merged;
}

interface BuiltParagraph {
  readonly renderedText: string;
  readonly segments: readonly RevisionSegment[];
}

function buildParagraph(paragraph: ParsedXmlElement, warnings: string[]): BuiltParagraph {
  const pieces = mergePieces((() => {
    const out: RawPiece[] = [];
    walkInline(paragraph, PLAIN_CONTEXT, out, warnings);
    return out;
  })());

  const segments: RevisionSegment[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const start = cursor;
    cursor += codePointLength(piece.text);
    segments.push({
      kind: piece.kind,
      revision_source_id: piece.id,
      author: piece.author,
      date: piece.date,
      text: piece.text,
      start,
      end: cursor,
    });
  }
  const renderedText = segments.map((segment) => segment.text).join('');
  return { renderedText, segments };
}

/** 收集文档顺序里的全部段落（含表格单元里的段落）。 */
function collectParagraphElements(root: ParsedXmlElement): readonly ParsedXmlElement[] {
  const found: ParsedXmlElement[] = [];
  const visit = (element: ParsedXmlElement): void => {
    for (const child of childElements(element)) {
      if (child.namespace === W_NS && child.localName === 'p') {
        found.push(child);
        // 段落里一般不再嵌套 w:p；即便有（文本框），也不在此重复下潜找段落。
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  return found;
}

/**
 * 从**任意** OOXML 部件文本读回修订。
 *
 * 与 `document.xml` **同构**：递归找该部件里的全部 `w:p`——页眉 `w:hdr`、页脚 `w:ftr`、
 * 脚注 `w:footnotes`、尾注 `w:endnotes` 下的段落都走同一条路径。产出的
 * `range` 是该部件自己的 `rendered_text` 空间里的**码位区间**（口径与正文一致）。
 *
 * 纯函数、零 IO。同输入 ⇒ 同输出（记录按文档顺序产出，便于复算）。
 */
export function readRevisionsFromPartXml(xml: string): RevisionReadResult {
  const root = parseXml(xml);
  const warnings: string[] = [];
  const paragraphElements = collectParagraphElements(root);

  const paragraphs: ParsedRevisionParagraph[] = [];
  const records: ParsedRevisionRecord[] = [];

  paragraphElements.forEach((paragraph, paragraphIndex) => {
    const built = buildParagraph(paragraph, warnings);
    const finalText = built.segments
      .filter((segment) => segment.kind !== 'delete')
      .map((segment) => segment.text)
      .join('');
    const originalText = built.segments
      .filter((segment) => segment.kind !== 'insert')
      .map((segment) => segment.text)
      .join('');
    paragraphs.push({
      paragraph_index: paragraphIndex,
      rendered_text: built.renderedText,
      segments: built.segments,
      final_text: finalText,
      original_text: originalText,
    });
    for (const segment of built.segments) {
      if (segment.kind === 'plain') continue;
      records.push({
        kind: segment.kind,
        source_id: segment.revision_source_id,
        author: segment.author ?? '',
        date: segment.date ?? '',
        paragraph_index: paragraphIndex,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        nested_in: null,
      });
    }
  });

  return { paragraphs, records, warnings };
}

/**
 * 从 `word/document.xml` 文本读回修订。
 *
 * 是 `readRevisionsFromPartXml` 的**正文部件别名**；保留此名以兼容既有调用点。
 */
export function readRevisionsFromDocumentXml(xml: string): RevisionReadResult {
  return readRevisionsFromPartXml(xml);
}

// ---------------------------------------------------------------------------
// 物化：读出的段落 → 可直接喂给 accept/reject 引擎的模型
// ---------------------------------------------------------------------------

/** 物化时每个片段对应的 revision 记录在 `records` 里的顺序与 `ParsedRevisionRecord[]` 一致。 */
export interface MaterializedRevisions {
  readonly model: DocumentModel;
  /** 与 `result.records` 一一对应，`range.node_id` 已绑定到物化段落的稳定 id。 */
  readonly records: readonly RevisionRecord[];
  /** 物化后每段的稳定节点 id（下标 = `paragraph_index`）。 */
  readonly paragraph_ids: readonly string[];
}

/** 按"每段一个 run"物化：段落文字恰好等于 `rendered_text`（码位口径一致）。 */
function draftFromParagraph(paragraph: ParsedRevisionParagraph): DraftBlockNode {
  return paragraphNode({
    source: 'imported',
    inlines: paragraph.segments.map((segment) => runNode({ text: segment.text, source: 'imported' })),
  });
}

/**
 * 把读出的修订物化成一份**可编辑模型**，并把每条记录的 range 绑到模型段落 id 上。
 *
 * 用途：让读出的**真实外部修订**能直接进 `acceptRevisions` / `rejectRevisions`，
 * 于是"接受/拒绝"与"未处理范围不损坏"都能在**真实语料的记录**上验证，而不是另造一套。
 *
 * 记录 ID 采用 `rev:<paragraph_index>:<k>`（k 为同段内顺序），确定性、可复算（R101 取向）。
 */
export function materializeRevisionModel(
  result: RevisionReadResult,
  documentId = 'imported-revisions',
): MaterializedRevisions {
  const model = createDocumentModel({
    document_id: documentId,
    blocks: result.paragraphs.map((paragraph) => draftFromParagraph(paragraph)),
  });
  const modelParagraphs: readonly ParagraphNode[] = collectParagraphs(model.blocks);
  const paragraphIds = modelParagraphs.map((paragraph) => paragraph.id);

  const perParagraphCounter = new Map<number, number>();
  const records: RevisionRecord[] = result.records.map((record) => {
    const order = perParagraphCounter.get(record.paragraph_index) ?? 0;
    perParagraphCounter.set(record.paragraph_index, order + 1);
    const nodeId = paragraphIds[record.paragraph_index];
    if (nodeId === undefined) {
      throw new Error(`物化失败：找不到段落 ${String(record.paragraph_index)} 的节点 id。`);
    }
    return {
      id: `rev:${String(record.paragraph_index)}:${String(order)}`,
      kind: record.kind,
      author: record.author,
      date: record.date,
      range: { node_id: nodeId, start: record.start, end: record.end },
      text: record.text,
      format: null,
    };
  });

  return { model, records, paragraph_ids: paragraphIds };
}

/**
 * 纯投影：一份物化段落按"接受 / 拒绝全部"应该变成的文字。
 *
 * - `accept` ⇒ 普通 + 插入（删除的部分被去掉）；
 * - `reject` ⇒ 普通 + 删除（插入的部分被去掉）。
 *
 * 与 `materializeRevisionModel` + 引擎应当给出**同一条结果**——两条路互相印证。
 */
export function projectParagraphText(
  paragraph: ParsedRevisionParagraph,
  decision: 'accept' | 'reject',
): string {
  return decision === 'accept' ? paragraph.final_text : paragraph.original_text;
}

/** 便捷：结果里是否有读不出来的东西。 */
export function hasUnreadableRevisions(result: RevisionReadResult): boolean {
  return result.warnings.length > 0;
}

// ---------------------------------------------------------------------------
// 多部件读取：页眉 / 页脚 + 脚注 / 尾注
// ---------------------------------------------------------------------------

/**
 * 可携带修订的 OOXML 部件类别。
 *
 * `unknown` = 既未在输入里显式给出类别、也无法按路径归类（仍按通用部件读取，不静默丢弃）。
 */
export type RevisionPartKind = 'document' | 'header' | 'footer' | 'footnotes' | 'endnotes' | 'unknown';

/** 路径归类结果。 */
export interface RevisionPartClassification {
  readonly kind: Exclude<RevisionPartKind, 'unknown'>;
  /** 页眉/页脚的序号（`word/header1.xml` ⇒ `1`）；`document`/`footnotes`/`endnotes` 为 `null`。 */
  readonly ordinal: number | null;
}

/**
 * 按部件路径归类（`word/document.xml`、`word/header1.xml`、`word/footer2.xml`、
 * `word/footnotes.xml`、`word/endnotes.xml`）。不认识的路径返回 `null`。
 *
 * 路径匹配是**逐字**的（OPC 部件名大小写敏感）：只接受正斜杠、小写 `word/` 前缀。
 * 页眉/页脚序号与部件名之间的分隔符可省略或为 `_` / `-`（`header1` / `header_1` / `header-1`）。
 */
export function classifyRevisionPartPath(path: string): RevisionPartClassification | null {
  const normalized = path.replace(/^\/+/, '');
  if (normalized === 'word/document.xml') return { kind: 'document', ordinal: null };
  if (normalized === 'word/footnotes.xml') return { kind: 'footnotes', ordinal: null };
  if (normalized === 'word/endnotes.xml') return { kind: 'endnotes', ordinal: null };
  const header = /^word\/header[_-]?(\d+)\.xml$/.exec(normalized);
  if (header !== null && header[1] !== undefined) {
    return { kind: 'header', ordinal: Number(header[1]) };
  }
  const footer = /^word\/footer[_-]?(\d+)\.xml$/.exec(normalized);
  if (footer !== null && footer[1] !== undefined) {
    return { kind: 'footer', ordinal: Number(footer[1]) };
  }
  return null;
}

/** 一个待读部件：路径 + XML 文本；`kind` 缺省时按路径归类。 */
export interface RevisionPartInput {
  /** 部件路径，如 `word/header1.xml`、`word/footnotes.xml`。 */
  readonly path: string;
  /** 显式覆盖归类；缺省时按 `path` 归类。 */
  readonly kind?: RevisionPartKind;
  /** 部件 XML 文本。 */
  readonly xml: string;
}

/** 一个已读部件：它的段落、记录、以及绑定到本部件模型的 `RevisionRecord[]`。 */
export interface RevisionPartRead {
  readonly path: string;
  readonly kind: RevisionPartKind;
  readonly ordinal: number | null;
  /** 在**保留下来的**部件序列里的下标（0 起；重复路径被跳过、不占位）。 */
  readonly part_index: number;
  /** 本部件的原始读取结果（`paragraph_index` 相对本部件）。 */
  readonly parsed: RevisionReadResult;
  /** 本部件物化出的可编辑模型（独立 document_id）。 */
  readonly model: DocumentModel;
  /** 本部件的记录，`range.node_id` 已绑定到 `model` 里的段落 id（码位区间口径同正文）。 */
  readonly records: readonly RevisionRecord[];
  /** `paragraph_index` ⇒ 稳定节点 id。 */
  readonly paragraph_ids: readonly string[];
}

/** 一条带部件归属的告警（保留原始告警文案，附上部件路径）。 */
export interface RevisionPartWarning {
  readonly path: string;
  readonly message: string;
}

export interface RevisionPartsReadResult {
  readonly parts: readonly RevisionPartRead[];
  /** 全部部件的告警，带路径归属（重复路径等聚合告警也在这里）。 */
  readonly warnings: readonly RevisionPartWarning[];
  readonly total_records: number;
  /** 带修订的部件路径（文档顺序）。 */
  readonly files_with_revisions: readonly string[];
  /** 无修订的部件路径——反向对照/审计用（**零记录不等于没读**）。 */
  readonly files_without_revisions: readonly string[];
  /** 有未建模内容（告警）的部件路径。 */
  readonly files_with_warnings: readonly string[];
  /** 便捷：`path => RevisionRecord[]`。 */
  readonly records_by_path: ReadonlyMap<string, readonly RevisionRecord[]>;
}

function partDocumentId(path: string): string {
  return `imported-revisions:${path.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
}

/**
 * 从**一组部件**（正文 + 页眉/页脚 + 脚注/尾注）读回修订。
 *
 * 每个部件独立读取、独立归类、独立物化：产出该部件的 `RevisionRecord[]`，其 `range` 是
 * **该部件自己的 `rendered_text` 空间**里的码位区间（跨部件不混用坐标）。告警逐条带 `path`
 * 归属，未建模的 `w:moveFrom`/`w:moveTo`、`w:rPrChange`/`w:pPrChange`、嵌套 `w:ins`/`w:del`
 * 等**仍然具名报出**（与单部件读取同文案）。
 *
 * 同路径出现多次时：只读第一次，后续**具名告警并跳过**（不重复计入记录）。
 * 未知路径：按通用部件读取，`kind:'unknown'`，并**具名告警**（不静默）。
 *
 * 纯函数、零 IO；同输入 ⇒ 同输出（部件顺序 = 输入顺序）。
 */
export function readRevisionsFromParts(parts: readonly RevisionPartInput[]): RevisionPartsReadResult {
  const seen = new Set<string>();
  const reads: RevisionPartRead[] = [];
  const warnings: RevisionPartWarning[] = [];

  parts.forEach((part, inputIndex) => {
    if (seen.has(part.path)) {
      warnings.push({
        path: part.path,
        message: `重复的部件路径：同一路径只读一次，本次跳过输入里的第 ${String(inputIndex)} 项。`,
      });
      return;
    }
    seen.add(part.path);

    const classification = classifyRevisionPartPath(part.path);
    if (part.kind === undefined && classification === null) {
      warnings.push({
        path: part.path,
        message: `无法按路径归类为正文/页眉/页脚/脚注/尾注，按通用部件读取：${part.path}`,
      });
    }
    const kind: RevisionPartKind = part.kind ?? classification?.kind ?? 'unknown';
    const ordinal = classification?.ordinal ?? null;

    const parsed = readRevisionsFromPartXml(part.xml);
    for (const message of parsed.warnings) warnings.push({ path: part.path, message });

    const materialized = materializeRevisionModel(parsed, partDocumentId(part.path));
    reads.push({
      path: part.path,
      kind,
      ordinal,
      part_index: reads.length,
      parsed,
      model: materialized.model,
      records: materialized.records,
      paragraph_ids: materialized.paragraph_ids,
    });
  });

  const recordsByPath = new Map<string, readonly RevisionRecord[]>();
  for (const read of reads) recordsByPath.set(read.path, read.records);

  return {
    parts: reads,
    warnings,
    total_records: reads.reduce((sum, read) => sum + read.records.length, 0),
    files_with_revisions: reads.filter((read) => read.records.length > 0).map((read) => read.path),
    files_without_revisions: reads.filter((read) => read.records.length === 0).map((read) => read.path),
    files_with_warnings: reads
      .filter((read) => read.parsed.warnings.length > 0)
      .map((read) => read.path),
    records_by_path: recordsByPath,
  };
}

/** 便捷：按路径取某部件的读取结果；不存在时返回 `undefined`。 */
export function revisionPartByPath(
  result: RevisionPartsReadResult,
  path: string,
): RevisionPartRead | undefined {
  return result.parts.find((read) => read.path === path);
}
