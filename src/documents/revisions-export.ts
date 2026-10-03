/**
 * **修订与批注的导出片段 + 成对性校验**（design-05-P7 / WF-077–079 的"可导出 / 可读回"接口）。
 *
 * ## 与 `docx/**` 的分工（本文件不越界）
 *
 * `docx/reference-render.ts` + `docx/decoration-plan.ts` + `docx/export.ts` 已经能把
 * `w:ins` / `w:del` / 批注区间写进真实包。本文件**不重写那条链路**，而是给"模型层 → 可导出"之间
 * 补两件它没有的东西：
 *
 * 1. **导出片段**：把一条 `RevisionRecord` 变成一个**独立可检视**的 OOXML 片段
 *    （`w:ins` / `w:del`），并给出批注部件的完整导出计划（`word/comments.xml` 字节 +
 *    关系记录 + 内容类型覆盖项）——调用方不必自己拼 "关系要不要补、内容类型写哪一条"。
 * 2. **成对性校验**：`w:commentReference` ↔ `w:comment` 是否**一一对应**。OOXML 里批注由
 *    **两处**共同成立（正文里的引用标记 + `comments.xml` 里的注释体），缺任何一边，
 *    消费端要么显示"悬空引用"，要么把注释体当孤儿丢弃——**而且不会报错**。
 *    这正是"看起来写对了、其实坏了"的典型，因此要有一条能独立跑、能定向复核的校验。
 *
 * ## 三条纪律
 *
 * 1. **格式类修订明确拒绝，不静默丢弃**（R140/R110）：`kind:'format'` 写不出合法 OOXML
 *    （`FormatChange.before/after` 是 `unknown`，无法合成 `w:rPrChange`），导出计划里把它
 *    放进 `rejected` 并**具名**，调用方必须看到它。
 * 2. **批注体按数字 id 落盘**：`w:commentReference@w:id` 与 `w:comment@w:id` 对的是**整数**，
 *    而模型里批注 id 是稳定字符串。本文件负责这次映射，并保证不与既有部件里的 id 撞号
 *    （用 `maxNumericIdInPart` 从既有 `word/comments.xml` 续号）。
 * 3. **未验证声明**：本文件只产出片段与计划，**未**经消费端（Word / WPS）读回核对，
 *    因此"消费端能正确显示这些修订/批注"标**未验证（需消费端）**。真实字节往返由
 *    `accept-reject.ts` 的用例在**部件级**验证。
 *
 * ## 外部依赖边界
 *
 * 只读复用：`artifacts/ooxml/xml`（XML 元素）、`docx/index`（既有的批注部件渲染与常量）、
 * `review/types`、`model/types`、`selection/types`。**不修改**任何一个。
 *
 * ## 交付说明（身份标注）
 *
 * 本文件由一个**子智能体**在 worktree `fa/doc-review` 内产出；该子智能体的**模型身份未确认为 DS**。
 * 结论以本文件与同名用例（`revisions-export.test.ts`）的可复算证据为准。
 */

import { attr, el, serializeXmlNode, type XmlElement } from '../artifacts/ooxml/xml.js';
import {
  COMMENTS_CONTENT_TYPE,
  COMMENTS_PART_PATH,
  COMMENTS_RELATIONSHIP_TYPE,
  DocxError,
  commentsPartXml,
  importedCommentOriginOf,
  maxNumericIdInPart,
  parseXml,
  type CommentEntry,
  type ParsedXmlElement,
} from './docx/index.js';
import type { DocumentModel, RelationshipRecord } from './model/types.js';
import { readComments } from './review/comments.js';
import type { RevisionKind, RevisionRecord } from './review/types.js';
import { fail, succeed, type Result } from './selection/types.js';

/** 批注部件在包内的路径与持有者（关系目标的相对基址）。 */
export const COMMENTS_OWNER_PART_PATH = 'word/document.xml';
/** 关系 `Target` 相对持有部件的写法。 */
export const COMMENTS_RELATIONSHIP_TARGET = 'comments.xml';

// ---------------------------------------------------------------------------
// 修订片段（WF-078）
// ---------------------------------------------------------------------------

const XML_SPACE = attr('xml:space', 'preserve');

function runOf(tag: 'w:t' | 'w:delText', text: string): XmlElement {
  return el('w:r', [], [el(tag, [XML_SPACE], [text])]);
}

/** `w:ins`——被插入的文字**已经在正文里**，接受 = 保留，拒绝 = 删掉它。 */
export function insertRevisionElement(record: RevisionRecord, id: number): XmlElement {
  return el(
    'w:ins',
    [attr('w:id', String(id)), attr('w:author', record.author), attr('w:date', record.date)],
    [runOf('w:t', record.text ?? '')],
  );
}

/** `w:del`——被标记删除的文字**仍在正文里**（写成 `w:delText`），接受 = 真删，拒绝 = 保留。 */
export function deleteRevisionElement(record: RevisionRecord, id: number): XmlElement {
  return el(
    'w:del',
    [attr('w:id', String(id)), attr('w:author', record.author), attr('w:date', record.date)],
    [runOf('w:delText', record.text ?? '')],
  );
}

/**
 * 单条修订 → 导出片段。
 *
 * `kind:'format'` 返回 `unsupported`（**具名拒绝**，不是返回一个空片段假装写过了）。
 */
export function revisionFragment(record: RevisionRecord, id: number): Result<XmlElement> {
  if (record.range.end < record.range.start) {
    return fail('invalid_range', `修订 "${record.id}" 的范围起止倒置：[${record.range.start}, ${record.range.end})。`, {
      extra: { id: record.id, start: record.range.start, end: record.range.end },
    });
  }
  switch (record.kind) {
    case 'insert':
      return succeed(insertRevisionElement(record, id));
    case 'delete':
      return succeed(deleteRevisionElement(record, id));
    case 'format':
      return fail(
        'unsupported',
        `格式类修订 "${record.id}" 无法导出：OOXML 需要 w:rPrChange / w:pPrChange 把**旧属性**嵌进 ` +
          'run/段落，而 FormatChange.before/after 是 unknown，写不出合法元素。跳过 = 静默丢一条审阅记录（R110）。',
        { extra: { id: record.id } },
      );
  }
}

export interface RevisionExportFragment {
  readonly record_id: string;
  readonly kind: 'insert' | 'delete';
  readonly author: string;
  /** 分配给该片段的数字 id（与既有 `w:ins`/`w:del` 不撞号）。 */
  readonly id: number;
  readonly element: XmlElement;
  /** 序列化后的 XML（便于直接写进主线、或落盘留证）。 */
  readonly xml: string;
}

export interface RejectedRevision {
  readonly record_id: string;
  readonly kind: RevisionKind;
  readonly reason: string;
}

export interface RevisionExportPlan {
  readonly fragments: readonly RevisionExportFragment[];
  /** **具名**拒绝的修订（当前只有格式类）。不静默丢弃（R110）。 */
  readonly rejected: readonly RejectedRevision[];
}

/**
 * 把一批修订记录规划成导出片段。
 *
 * `startId` 默认 1；合并进既有部件时应传入"既有最大值 + 1"（调用方可用
 * `docx/reference-render` 的 `maxNumericIdInRawXml` 得到）。
 */
export function planRevisionExport(records: readonly RevisionRecord[], startId = 1): RevisionExportPlan {
  const fragments: RevisionExportFragment[] = [];
  const rejected: RejectedRevision[] = [];
  let nextId = startId;
  for (const record of records) {
    const built = revisionFragment(record, nextId);
    if (!built.ok) {
      rejected.push({ record_id: record.id, kind: record.kind, reason: built.message });
      continue;
    }
    fragments.push({
      record_id: record.id,
      kind: record.kind === 'delete' ? 'delete' : 'insert',
      author: record.author,
      id: nextId,
      element: built.value,
      xml: serializeXmlNode(built.value),
    });
    nextId += 1;
  }
  return { fragments, rejected };
}

// ---------------------------------------------------------------------------
// 批注导出（WF-077）
// ---------------------------------------------------------------------------

export interface CommentsExportPlan {
  readonly entries: readonly CommentEntry[];
  readonly part_path: string;
  readonly content_type: string;
  readonly relationship_type: string;
  /** `word/comments.xml` 的完整文本（与既有部件合并；无既有部件则全新建）。 */
  readonly part_xml: string;
  /** 要追加到 `word/_rels/document.xml.rels` 的关系记录。无批注时为 `null`（不凭空建关系）。 */
  readonly relationship: RelationshipRecord | null;
  /** 要补进 `[Content_Types].xml` 的覆盖项。无批注时为 `null`。 */
  readonly content_type_entry: { readonly part_name: string; readonly content_type: string } | null;
  /** 未写出的批注（如 `anchor === null`），**具名**列出。 */
  readonly skipped: readonly string[];
}

export interface CommentsExportOptions {
  /** 包内既有的 `word/comments.xml` 字节（用于续号并保留既有注释体，R105）。 */
  readonly existing_comments_xml?: Uint8Array | null;
  /** 分配给 `word/comments.xml` 的关系 id。省略 ⇒ 调用方自行分配（此处记为 `rIdComments`）。 */
  readonly relationship_id?: string;
}

/**
 * 规划批注导出：部件字节 + 关系 + 内容类型，三件**成套**产出。
 *
 * 三件必须同进同退——只写部件不写关系（或反之）就是一个坏包；这里用一个函数把
 * "成套"约束在结构上固定下来（不提供"只写其中一部分"的入口）。
 *
 * `anchor === null` 的批注无处安放 ⇒ **不写出**，并逐条记进 `skipped`。
 *
 * **导入批注同样不写出**（与 `docx/decoration-plan.ts` 同一取向）：它们的两半
 * （正文 `w:commentReference` + `word/comments.xml` 注释体）都已在原包里按原 `w:id` 逐字节保留，
 * 再写一遍会产出重复标记 / 重复注释体。想改文字就先删掉再以新批注重建。
 */
export function planCommentsExport(
  model: DocumentModel,
  options: CommentsExportOptions = {},
): CommentsExportPlan {
  const existing = options.existing_comments_xml ?? null;
  const startId = maxNumericIdInPart(existing, ['comment']) + 1;

  const entries: CommentEntry[] = [];
  const skipped: string[] = [];
  let nextId = startId;
  for (const comment of model.comments) {
    const origin = importedCommentOriginOf(comment);
    if (origin !== null) {
      if (comment.author !== origin.author || comment.text !== origin.text) {
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
    entries.push({ id: nextId, author: comment.author, date: null, text: comment.text });
    nextId += 1;
  }

  const partXml = commentsPartXml(entries, existing);
  const relationship: RelationshipRecord | null =
    entries.length === 0
      ? null
      : {
          id: options.relationship_id ?? 'rIdComments',
          type: COMMENTS_RELATIONSHIP_TYPE,
          target: COMMENTS_RELATIONSHIP_TARGET,
          target_mode: 'Internal',
          owner_part_path: COMMENTS_OWNER_PART_PATH,
        };
  const content_type_entry =
    entries.length === 0 ? null : { part_name: `/${COMMENTS_PART_PATH}`, content_type: COMMENTS_CONTENT_TYPE };

  return {
    entries,
    part_path: COMMENTS_PART_PATH,
    content_type: COMMENTS_CONTENT_TYPE,
    relationship_type: COMMENTS_RELATIONSHIP_TYPE,
    part_xml: partXml,
    relationship,
    content_type_entry,
    skipped,
  };
}

/**
 * 批注的模型侧锚点问题（写不出去的那批），**具名**列出。
 *
 * 复用 `review/comments` 的 `readComments`（它已经算过"锚点是否仍有效"）——
 * 本文件不重造一遍"锚点在不在"的判定，避免两份实现发岔。
 */
export function commentAnchorProblems(model: DocumentModel): readonly string[] {
  return readComments(model)
    .filter((view) => !view.anchor_valid)
    .map((view) => {
      const anchor = view.comment.anchor;
      const where = anchor === null ? '<null>' : `[${anchor.node_id} ${anchor.start}, ${anchor.end})`;
      return `批注 "${view.comment.id}" 的锚点 ${where} 已失效（段落不存在或范围越界）。`;
    });
}

// ---------------------------------------------------------------------------
// 成对性校验（w:commentReference ↔ w:comment）
// ---------------------------------------------------------------------------

export interface CommentPairingReport {
  readonly ok: boolean;
  /** 正文里的 `w:commentReference@w:id`（**引用标记**——"有引用必须有注释体"的判据）。 */
  readonly reference_marker_ids: readonly number[];
  readonly range_start_ids: readonly number[];
  readonly range_end_ids: readonly number[];
  /** `word/comments.xml` 里的 `w:comment@w:id`（注释体）。 */
  readonly body_ids: readonly number[];
  /** 引用标记有、注释体没有 ⇒ **悬空引用**。 */
  readonly dangling_references: readonly number[];
  /** 注释体有、引用标记没有 ⇒ **孤儿注释体**。 */
  readonly orphan_bodies: readonly number[];
  /** 区间起点/终点不成对（或起了没落引用标记）的 id。 */
  readonly unclosed_ranges: readonly number[];
  readonly problems: readonly string[];
}

function collectIds(root: ParsedXmlElement, localNames: readonly string[]): readonly number[] {
  const wanted = new Set(localNames);
  const out: number[] = [];
  const visit = (element: ParsedXmlElement): void => {
    if (wanted.has(element.localName)) {
      const raw = attributeValueBySuffix(element, 'id');
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed)) out.push(parsed);
      }
    }
    for (const child of element.children) {
      if (child.kind === 'element') visit(child);
    }
  };
  visit(root);
  return out;
}

/** 按"后缀 `:id` 或裸 `id`"取属性值（两处 XML 都用 `w:id`，不依赖命名空间解析结果）。 */
function attributeValueBySuffix(element: ParsedXmlElement, local: string): string | null {
  for (const attribute of element.attributes) {
    if (attribute.name === local || attribute.name.endsWith(`:${local}`)) return attribute.value;
  }
  return null;
}

function sortedUnique(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 校验 `word/document.xml` 与 `word/comments.xml` 的批注**成对性**。
 *
 * 四条判据（任一不满足 ⇒ `ok:false`，并**具名**列出问题 id）：
 * 1. 每个 `w:commentReference` 都有对应 `w:comment`；
 * 2. 每个 `w:comment` 都被至少一个 `w:commentReference` 引用；
 * 3. 每个 `w:commentRangeStart` 都有配对的 `w:commentRangeEnd`（反之亦然）；
 * 4. 区间 id 集合 ⊆ 引用的 id 集合（起了区间却没落引用标记，Word 会认批注未被引用）。
 *
 * 这是**读回**侧的校验：喂给它的就是导出产物的真实字节文本，因此它能独立于导出器复核
 * "写出来的东西是不是自洽的"——这正是"可读回"的落点。
 */
export function validateCommentPairing(documentXml: string, commentsXml: string): CommentPairingReport {
  const documentRoot = parseXml(documentXml);
  const commentsRoot = parseXml(commentsXml);

  const referenceMarkerIds = sortedUnique(collectIds(documentRoot, ['commentReference']));
  const rangeStartIds = sortedUnique(collectIds(documentRoot, ['commentRangeStart']));
  const rangeEndIds = sortedUnique(collectIds(documentRoot, ['commentRangeEnd']));
  const bodyIds = sortedUnique(collectIds(commentsRoot, ['comment']));

  const referenced = new Set(referenceMarkerIds);
  const bodies = new Set(bodyIds);

  const danglingReferences = referenceMarkerIds.filter((id) => !bodies.has(id));
  const orphanBodies = bodyIds.filter((id) => !referenced.has(id));

  const startSet = new Set(rangeStartIds);
  const endSet = new Set(rangeEndIds);
  const unclosedRanges = sortedUnique([
    ...[...startSet].filter((id) => !endSet.has(id)),
    ...[...endSet].filter((id) => !startSet.has(id)),
    ...[...startSet].filter((id) => !referenced.has(id)),
  ]);

  const problems: string[] = [];
  for (const id of danglingReferences) {
    problems.push(`w:commentReference 指向 id=${id}，但 word/comments.xml 里没有对应的 w:comment（悬空引用）。`);
  }
  for (const id of orphanBodies) {
    problems.push(`word/comments.xml 里有 id=${id} 的 w:comment，但正文里没有任何 w:commentReference 引用它（孤儿注释体）。`);
  }
  for (const id of unclosedRanges) {
    problems.push(`批注区间 id=${id} 不成对（起点/终点缺失，或起了区间却没有引用标记）。`);
  }

  return {
    ok: problems.length === 0,
    reference_marker_ids: referenceMarkerIds,
    range_start_ids: rangeStartIds,
    range_end_ids: rangeEndIds,
    body_ids: bodyIds,
    dangling_references: danglingReferences,
    orphan_bodies: orphanBodies,
    unclosed_ranges: unclosedRanges,
    problems,
  };
}

// ---------------------------------------------------------------------------
// 汇总：一次给全"审阅导出包"
// ---------------------------------------------------------------------------

export interface ReviewExportBundle {
  readonly revisions: RevisionExportPlan;
  readonly comments: CommentsExportPlan;
  /** 批注锚点问题（模型侧，**具名**）。 */
  readonly comment_anchor_problems: readonly string[];
}

/**
 * 汇总审阅（修订 + 批注）的完整导出计划。
 *
 * 只做规划，**不写盘**——把片段 / 部件 / 关系 / 内容类型交给调用方（或 `docx/export.ts`）
 * 决定怎么写。这样"可导出"是**可检视**的：全部产物都在返回值里，不需要去翻文件。
 */
export function planReviewExport(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  options: { readonly existing_comments_xml?: Uint8Array | null; readonly relationship_id?: string } = {},
): ReviewExportBundle {
  return {
    revisions: planRevisionExport(records),
    comments: planCommentsExport(model, options),
    comment_anchor_problems: commentAnchorProblems(model),
  };
}

// 内部无自有遍历：段落查找 / 文本长度 / 锚点有效性一律复用既有模块
// （`selection/structure`、`review/comments`）——同一份判定只应有一处实现。
