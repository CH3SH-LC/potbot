/**
 * **引用完整性审阅报告**（design-05-P7 / WF-071–076 的"审阅"侧收口）。
 *
 * ## 这一层解决什么
 *
 * `src/documents/references/**` 交付的是**操作**：建书签、解析交叉引用、定位超链接。
 * 但"这篇文档的引用还指得着吗？断在哪几条？该重建书签还是删掉引用？"——是**一次体检**，
 * 不是一次编辑。本文件只**读**模型与引用侧表，产出一份**可执行**的报告：
 *
 * 1. 逐项检查目标是否存在（`locateBookmark` / `resolveCrossReference` / `resolveHyperlink` /
 *    `checkNoteNumbering` / 目录条目的标题节点）；
 * 2. **悬空引用具名列出**（R110/R112：不静默——书签没了是一个被报告出来的状态，
 *    不是一次消失）；
 * 3. 每条问题带一条**修复建议**（重建书签 / 移除失效链接 / 刷新域 / 补关系声明 / 重排编号），
 *    调用方可直接照做，不必再去猜"该干什么"。
 *
 * ## 只读复用，不重造解析
 *
 * 判定"目标在不在"一律**委托**给既有模块的解析函数（它们已经过 WF-071–076 的用例验证），
 * 本文件不复制一份"书签是否存在"的逻辑——两份实现迟早会发岔（`intact` 语义、`not_found`
 * 的边界都会漂）。
 *
 * ## 外部目标**只记录，不抓取**（R161）
 *
 * 外部超链接只做两件事：确认"它记的是 External 模式"（`hyperlinkTargetMode`），
 * 于是**不会**被当成"需要去访问的目标"；以及检查它引用的 `r:id` 在模型关系表里是否真的存在。
 * 本文件里**没有** `fetch` / `http` / DNS / 本地磁盘访问——"不抓取"因此可被结构性复核。
 *
 * ## 已知边界（未验证项）
 *
 * - **Word 打开核对本轮不做**：本报告是模型层的自查，**未**经任何消费端（Word / WPS）
 *   读回验证 ⇒ 标"未验证（需消费端）"。
 * - 目录条目的**页码**不参与审计：页码需要真实排版证据（R158），本层根本没有数字可比。
 *
 * ## 交付说明（身份标注）
 *
 * 本文件由一个**子智能体**在 worktree `fa/doc-review` 内产出；该子智能体的**模型身份未确认为 DS**。
 * 结论以本文件与同名用例（`reference-audit.test.ts`）的可复算证据为准，不以其模型身份为准。
 */

import type { DocumentId, DocumentModel, NodeId, RelationshipRecord } from './model/types.js';
import { locateBookmark } from './references/bookmarks.js';
import { resolveCrossReference } from './references/crossref.js';
import { hyperlinkTargetMode, resolveHyperlink } from './references/hyperlinks.js';
import { checkNoteNumbering } from './references/notes.js';
import { flattenToc } from './references/toc.js';
import type { HyperlinkTarget, ReferenceIndex, TocCache } from './references/types.js';
import { codePointLength } from './selection/codepoint.js';
import { isHeadingParagraph } from './selection/resolve.js';
import { findParagraphById, paragraphText } from './selection/structure.js';

// ---------------------------------------------------------------------------
// 报告类型
// ---------------------------------------------------------------------------

/** 被审的引用种类。**具名**（不是 `string`），这样 `counts` 能被穷举。 */
export type AuditedKind = 'bookmark' | 'hyperlink' | 'note' | 'cross_reference' | 'toc_entry';

/**
 * 问题码。每一个都能被调用方分支处理（与 `FailureCode` 同一取向：不靠解析 message）。
 *
 * - `missing_target`：目标**不存在**（悬空）。
 * - `broken_bookmark`：书签记录还在、但 `intact:false`——它指向的文字已被整段删除（悬空）。
 * - `range_out_of_bounds`：锚定区间超出所在段落的码位长度（悬空：指到空气上）。
 * - `missing_paragraph`：锚点落在一个不存在的节点上（悬空）。
 * - `duplicate_bookmark_name`：书签名重复——`w:anchor` 会指到不确定的一个（警告）。
 * - `stale_reference`：交叉引用解析得到、但缓存过期（警告；不是错，只是该刷新）。
 * - `needs_layout_evidence`：页码型目标需要真实排版证据，本层给不出（警告）。
 * - `missing_relationship`：外部超链接记的 `r:id` 在模型关系表里找不到（警告）。
 * - `note_numbering_broken`：编号不连续 / 标记落在不存在的段落上（警告）。
 * - `toc_heading_lost`：目录条目指向的标题节点没了（悬空）。
 * - `toc_heading_demoted`：目录条目指向的段落还在、但已不再是标题（警告）。
 * - `external_not_fetched`：外部目标**只记录、不抓取**（信息项，非问题，R161）。
 */
export type AuditCode =
  | 'missing_target'
  | 'broken_bookmark'
  | 'range_out_of_bounds'
  | 'missing_paragraph'
  | 'duplicate_bookmark_name'
  | 'stale_reference'
  | 'needs_layout_evidence'
  | 'missing_relationship'
  | 'note_numbering_broken'
  | 'toc_heading_lost'
  | 'toc_heading_demoted'
  | 'external_not_fetched';

/** 严重度：悬空必须修；警告建议修；信息项无需动作。 */
export type AuditSeverity = 'dangling' | 'warning' | 'info';

/** 一条可执行的修复建议。`action:'none'` 表示"无需动作"（信息项用）。 */
export type AuditFix =
  | { readonly action: 'rebuild_bookmark'; readonly bookmark_id: string; readonly hint: string }
  | { readonly action: 'remove_reference'; readonly reference_id: string; readonly hint: string }
  | { readonly action: 'remove_bookmark'; readonly bookmark_id: string; readonly hint: string }
  | { readonly action: 'refresh_reference'; readonly reference_id: string; readonly hint: string }
  | { readonly action: 'repair_numbering'; readonly note_ids: readonly string[]; readonly hint: string }
  | { readonly action: 'declare_relationship'; readonly relationship_id: string; readonly hint: string }
  | { readonly action: 'recompute_field'; readonly target: string; readonly hint: string }
  | { readonly action: 'none'; readonly hint: string };

/** 一条审阅发现。 */
export interface AuditFinding {
  readonly item_kind: AuditedKind;
  /** 被审项的稳定 id（书签 / 超链接 / 交叉引用 / 注 id；目录条目用节点 id）。 */
  readonly item_id: string;
  /** 人类可读名（书签名 / URL / 注 id / 标题文字）；没有时为 `null`。 */
  readonly name: string | null;
  readonly severity: AuditSeverity;
  readonly code: AuditCode;
  readonly message: string;
  readonly node_id: NodeId | null;
  readonly fix: AuditFix;
}

export interface AuditCheckedCounts {
  readonly bookmarks: number;
  readonly hyperlinks: number;
  readonly notes: number;
  readonly cross_references: number;
  readonly toc_entries: number;
}

export interface ReferenceAuditReport {
  readonly document_id: DocumentId;
  readonly findings: readonly AuditFinding[];
  /** 只含 `severity === 'dangling'` 的发现——**具名**清单，调用方应直接呈现给用户。 */
  readonly dangling: readonly AuditFinding[];
  /** 只含 `severity === 'warning'` 的发现。 */
  readonly warnings: readonly AuditFinding[];
  /** 每个问题码的出现次数（全零当且仅当没有任何发现）。 */
  readonly counts: Readonly<Record<AuditCode, number>>;
  /** 无悬空引用 = `true`（警告不影响"引用还指得着"这一结论）。 */
  readonly healthy: boolean;
  readonly checked: AuditCheckedCounts;
}

export interface AuditReferenceInput {
  readonly model: DocumentModel;
  readonly index: ReferenceIndex;
  /** 目录缓存（可选）。不传 ⇒ 不审目录条目（不假装审过）。 */
  readonly toc?: TocCache | null;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

const EMPTY_COUNTS: Record<AuditCode, number> = {
  missing_target: 0,
  broken_bookmark: 0,
  range_out_of_bounds: 0,
  missing_paragraph: 0,
  duplicate_bookmark_name: 0,
  stale_reference: 0,
  needs_layout_evidence: 0,
  missing_relationship: 0,
  note_numbering_broken: 0,
  toc_heading_lost: 0,
  toc_heading_demoted: 0,
  external_not_fetched: 0,
};

/** 段落码位长度；段落不存在时返回 `null`（与"长度为 0"是两件事）。 */
function paragraphLength(model: DocumentModel, nodeId: NodeId): number | null {
  const paragraph = findParagraphById(model.blocks, nodeId);
  if (paragraph === null) return null;
  return codePointLength(paragraphText(paragraph));
}

/** 区间是否落在某段落的码位长度内。 */
function rangeFits(model: DocumentModel, nodeId: NodeId, start: number, end: number): boolean | null {
  const length = paragraphLength(model, nodeId);
  if (length === null) return null;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= length;
}

function relationshipExists(
  model: DocumentModel,
  ownerPartPath: string | null,
  relationshipId: string,
): boolean {
  return model.relationships.some(
    (record: RelationshipRecord) =>
      record.id === relationshipId &&
      (ownerPartPath === null || record.owner_part_path === ownerPartPath),
  );
}

/**
 * 对模型 + 引用侧表做一次**引用完整性体检**。
 *
 * 纯函数、**零 IO**（不读 URL、不碰磁盘）。发现按 `bookmarks → hyperlinks → notes →
 * cross_references → toc` 的顺序产出，同种类内保持侧表原顺序 ⇒ 同输入同输出（便于复算）。
 */
export function auditReferences(input: AuditReferenceInput): ReferenceAuditReport {
  const { model, index } = input;
  const findings: AuditFinding[] = [];

  // ---- 书签（WF-071）--------------------------------------------------------
  const seenNames = new Set<string>();
  for (const bookmark of index.bookmarks) {
    if (seenNames.has(bookmark.name)) {
      findings.push({
        item_kind: 'bookmark',
        item_id: bookmark.id,
        name: bookmark.name,
        severity: 'warning',
        code: 'duplicate_bookmark_name',
        message: `书签名 "${bookmark.name}" 重复：w:anchor 会指到不确定的一个。`,
        node_id: bookmark.range.node_id,
        fix: {
          action: 'remove_bookmark',
          bookmark_id: bookmark.id,
          hint: `给书签 "${bookmark.name}" 改名或删除重复项，保证书签名唯一。`,
        },
      });
    }
    seenNames.add(bookmark.name);

    if (!bookmark.intact) {
      findings.push({
        item_kind: 'bookmark',
        item_id: bookmark.id,
        name: bookmark.name,
        severity: 'dangling',
        code: 'broken_bookmark',
        message: `书签 "${bookmark.name}" 指向的文字已被整段删除，已失效。`,
        node_id: bookmark.range.node_id,
        fix: {
          action: 'rebuild_bookmark',
          bookmark_id: bookmark.id,
          hint: `在目标文字处重建书签 "${bookmark.name}"，或删除这条失效书签。`,
        },
      });
      continue;
    }
    const fits = rangeFits(model, bookmark.range.node_id, bookmark.range.start, bookmark.range.end);
    if (fits === null) {
      findings.push({
        item_kind: 'bookmark',
        item_id: bookmark.id,
        name: bookmark.name,
        severity: 'dangling',
        code: 'missing_paragraph',
        message: `书签 "${bookmark.name}" 锚在不存在或不存在的段落 "${bookmark.range.node_id}" 上。`,
        node_id: bookmark.range.node_id,
        fix: {
          action: 'remove_bookmark',
          bookmark_id: bookmark.id,
          hint: `删除书签 "${bookmark.name}"（它的锚点段落已经不在了）。`,
        },
      });
      continue;
    }
    if (!fits) {
      findings.push({
        item_kind: 'bookmark',
        item_id: bookmark.id,
        name: bookmark.name,
        severity: 'dangling',
        code: 'range_out_of_bounds',
        message:
          `书签 "${bookmark.name}" 的范围 [${bookmark.range.start}, ${bookmark.range.end}) ` +
          `超出段落 "${bookmark.range.node_id}" 的码位长度。`,
        node_id: bookmark.range.node_id,
        fix: {
          action: 'rebuild_bookmark',
          bookmark_id: bookmark.id,
          hint: `把书签 "${bookmark.name}" 的范围夹回段落实际范围（或重建书签）。`,
        },
      });
    }
  }

  // ---- 超链接（WF-072/073）--------------------------------------------------
  for (const hyperlink of index.hyperlinks) {
    const resolved = resolveHyperlink(index, hyperlink);
    if (!resolved.ok) {
      // 内部目标失效 ⇒ 与"书签失效"是同一件事，修复动作仍是重建目标书签。
      const internal = hyperlink.target.kind === 'internal';
      findings.push({
        item_kind: 'hyperlink',
        item_id: hyperlink.id,
        name: displayNameOfHyperlink(hyperlink.target),
        severity: 'dangling',
        code: internal ? 'missing_target' : 'broken_bookmark',
        message: internal
          ? `内部超链接 "${hyperlink.id}" 指向的书签 "${hyperlink.target.bookmark}" 不存在或已失效。`
          : `超链接 "${hyperlink.id}" 已失效（目标文字被删除）。`,
        node_id: hyperlink.range.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: hyperlink.id,
          hint: internal
            ? `重建书签 "${hyperlink.target.bookmark}"，或移除这条内部链接（保留显示文字）。`
            : `移除已失效的超链接 "${hyperlink.id}"（保留显示文字）。`,
        },
      });
      continue;
    }
    const fits = rangeFits(model, hyperlink.range.node_id, hyperlink.range.start, hyperlink.range.end);
    if (fits === null) {
      findings.push({
        item_kind: 'hyperlink',
        item_id: hyperlink.id,
        name: displayNameOfHyperlink(hyperlink.target),
        severity: 'dangling',
        code: 'missing_paragraph',
        message: `超链接 "${hyperlink.id}" 锚在不存在的段落 "${hyperlink.range.node_id}" 上。`,
        node_id: hyperlink.range.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: hyperlink.id,
          hint: `移除锚点已消失的超链接 "${hyperlink.id}"。`,
        },
      });
      continue;
    }
    if (!fits) {
      findings.push({
        item_kind: 'hyperlink',
        item_id: hyperlink.id,
        name: displayNameOfHyperlink(hyperlink.target),
        severity: 'dangling',
        code: 'range_out_of_bounds',
        message:
          `超链接 "${hyperlink.id}" 的范围 [${hyperlink.range.start}, ${hyperlink.range.end}) ` +
          `超出段落 "${hyperlink.range.node_id}" 的码位长度。`,
        node_id: hyperlink.range.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: hyperlink.id,
          hint: `重建或移除范围越界的超链接 "${hyperlink.id}"。`,
        },
      });
      continue;
    }

    // 外部 / 邮件：**只记录、不抓取**（R161）。这里只登记一条信息项，绝不去访问它。
    if (hyperlinkTargetMode(hyperlink) === 'External') {
      findings.push({
        item_kind: 'hyperlink',
        item_id: hyperlink.id,
        name: displayNameOfHyperlink(hyperlink.target),
        severity: 'info',
        code: 'external_not_fetched',
        message: `外部目标已记录（未抓取、未验证可达）：${displayNameOfHyperlink(hyperlink.target)}。`,
        node_id: hyperlink.range.node_id,
        fix: { action: 'none', hint: '外部目标按 R161 只记录不抓取，无需动作。' },
      });
    }
    if (hyperlink.target.kind === 'external' && hyperlink.target.relationship_id !== null) {
      const relId = hyperlink.target.relationship_id;
      if (!relationshipExists(model, 'word/document.xml', relId)) {
        findings.push({
          item_kind: 'hyperlink',
          item_id: hyperlink.id,
          name: displayNameOfHyperlink(hyperlink.target),
          severity: 'warning',
          code: 'missing_relationship',
          message: `超链接 "${hyperlink.id}" 记的关系 "${relId}" 在模型关系表里找不到。`,
          node_id: hyperlink.range.node_id,
          fix: {
            action: 'declare_relationship',
            relationship_id: relId,
            hint: `补上关系 "${relId}"（TargetMode="External"），或清空它让导出器重新分配。`,
          },
        });
      }
    }
  }

  // ---- 脚注 / 尾注（WF-075）-------------------------------------------------
  for (const note of index.notes) {
    const fits = rangeFits(model, note.marker.node_id, note.marker.start, note.marker.end);
    if (fits === null) {
      findings.push({
        item_kind: 'note',
        item_id: note.id,
        name: note.id,
        severity: 'dangling',
        code: 'missing_paragraph',
        message: `${note.kind === 'footnote' ? '脚注' : '尾注'} "${note.id}" 的标记落在不存在的段落 "${note.marker.node_id}" 上。`,
        node_id: note.marker.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: note.id,
          hint: `删除这条注："${note.id}"（它的正文引用标记已无处安放）。`,
        },
      });
      continue;
    }
    if (!fits) {
      findings.push({
        item_kind: 'note',
        item_id: note.id,
        name: note.id,
        severity: 'dangling',
        code: 'range_out_of_bounds',
        message:
          `${note.kind === 'footnote' ? '脚注' : '尾注'} "${note.id}" 的标记 ` +
          `[${note.marker.start}, ${note.marker.end}) 超出段落 "${note.marker.node_id}" 的码位长度。`,
        node_id: note.marker.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: note.id,
          hint: `重建或删除标记越界的注 "${note.id}"。`,
        },
      });
    }
  }
  const numbering = checkNoteNumbering(model, index.notes);
  for (const problem of numbering.problems) {
    findings.push({
      item_kind: 'note',
      item_id: '<numbering>',
      name: null,
      severity: 'warning',
      code: 'note_numbering_broken',
      message: problem,
      node_id: null,
      fix: {
        action: 'repair_numbering',
        note_ids: index.notes.map((note) => note.id),
        hint: '编号由文档顺序派生（numberNotes），请检查注的标记位置是否落在正确段落上。',
      },
    });
  }

  // ---- 交叉引用（WF-075/076）------------------------------------------------
  for (const reference of index.cross_references) {
    const resolved = resolveCrossReference(model, index, reference);
    if (!resolved.ok) {
      const needsLayout = resolved.code === 'precondition';
      findings.push({
        item_kind: 'cross_reference',
        item_id: reference.id,
        name: targetNameOf(reference.target.kind, reference.target.node_id, reference.target.bookmark_id),
        severity: needsLayout ? 'warning' : 'dangling',
        code: needsLayout ? 'needs_layout_evidence' : 'missing_target',
        message: needsLayout
          ? `交叉引用 "${reference.id}" 是页码型，需要真实排版证据才能解析（R158）。`
          : `交叉引用 "${reference.id}" 的目标（${reference.target.kind}）解析不到：${resolved.message}`,
        node_id: reference.range.node_id,
        fix: needsLayout
          ? {
              action: 'recompute_field',
              target: reference.id,
              hint: '在消费端（Word/WPS）更新域后再读回，或改用"文字/序号"型引用。',
            }
          : {
              action: 'remove_reference',
              reference_id: reference.id,
              hint: `移除失效的交叉引用 "${reference.id}"，或在目标处重建被引对象。`,
            },
      });
      continue;
    }
    const fits = rangeFits(model, reference.range.node_id, reference.range.start, reference.range.end);
    if (fits === false) {
      findings.push({
        item_kind: 'cross_reference',
        item_id: reference.id,
        name: targetNameOf(reference.target.kind, reference.target.node_id, reference.target.bookmark_id),
        severity: 'dangling',
        code: 'range_out_of_bounds',
        message:
          `交叉引用 "${reference.id}" 的范围 [${reference.range.start}, ${reference.range.end}) ` +
          `超出段落 "${reference.range.node_id}" 的码位长度。`,
        node_id: reference.range.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: reference.id,
          hint: `重建或移除范围越界的交叉引用 "${reference.id}"。`,
        },
      });
      continue;
    }
    if (fits === null) {
      findings.push({
        item_kind: 'cross_reference',
        item_id: reference.id,
        name: targetNameOf(reference.target.kind, reference.target.node_id, reference.target.bookmark_id),
        severity: 'dangling',
        code: 'missing_paragraph',
        message: `交叉引用 "${reference.id}" 落在不存在的段落 "${reference.range.node_id}" 上。`,
        node_id: reference.range.node_id,
        fix: {
          action: 'remove_reference',
          reference_id: reference.id,
          hint: `移除锚点已消失的交叉引用 "${reference.id}"。`,
        },
      });
      continue;
    }
    // 能解析、位置也在，唯一可能的问题是缓存旧了——**警告**，不是悬空。
    if (reference.refresh_state !== 'refreshed') {
      findings.push({
        item_kind: 'cross_reference',
        item_id: reference.id,
        name: targetNameOf(reference.target.kind, reference.target.node_id, reference.target.bookmark_id),
        severity: 'warning',
        code: 'stale_reference',
        message: `交叉引用 "${reference.id}" 的显示文字未刷新（缓存状态：${reference.refresh_state}）。`,
        node_id: reference.range.node_id,
        fix: {
          action: 'refresh_reference',
          reference_id: reference.id,
          hint: `刷新交叉引用 "${reference.id}"（写域指令 ≠ 已算好，需消费端更新域）。`,
        },
      });
    }
  }

  // ---- 目录（WF-074）--------------------------------------------------------
  const toc = input.toc ?? null;
  const tocEntries = toc === null ? [] : flattenToc(toc.entries);
  for (const entry of tocEntries) {
    const paragraph = findParagraphById(model.blocks, entry.node_id);
    if (paragraph === null) {
      findings.push({
        item_kind: 'toc_entry',
        item_id: entry.node_id,
        name: entry.text,
        severity: 'dangling',
        code: 'toc_heading_lost',
        message: `目录条目 "${entry.text}" 指向的标题节点 "${entry.node_id}" 已不存在。`,
        node_id: entry.node_id,
        fix: {
          action: 'recompute_field',
          target: entry.node_id,
          hint: `更新目录域（消费端）以移除或重建条目 "${entry.text}"。`,
        },
      });
      continue;
    }
    if (!isHeadingParagraph(paragraph, model.styles)) {
      findings.push({
        item_kind: 'toc_entry',
        item_id: entry.node_id,
        name: entry.text,
        severity: 'warning',
        code: 'toc_heading_demoted',
        message: `目录条目 "${entry.text}" 指向的段落还在，但已不再是标题（样式/大纲级别变了）。`,
        node_id: entry.node_id,
        fix: {
          action: 'recompute_field',
          target: entry.node_id,
          hint: '恢复该段落的标题样式，或在消费端更新目录域。',
        },
      });
    }
  }

  const counts: Record<AuditCode, number> = { ...EMPTY_COUNTS };
  for (const finding of findings) counts[finding.code] += 1;
  const dangling = findings.filter((finding) => finding.severity === 'dangling');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  return {
    document_id: model.document_id,
    findings,
    dangling,
    warnings,
    counts,
    healthy: dangling.length === 0,
    checked: {
      bookmarks: index.bookmarks.length,
      hyperlinks: index.hyperlinks.length,
      notes: index.notes.length,
      cross_references: index.cross_references.length,
      toc_entries: tocEntries.length,
    },
  };
}

/** 只需照做的修复动作（`action:'none'` 的信息项**不**在此列）。 */
export function referenceAuditFixes(report: ReferenceAuditReport): readonly AuditFix[] {
  return report.findings
    .map((finding) => finding.fix)
    .filter((fix) => fix.action !== 'none');
}

/**
 * 人类可读的**具名**报告。
 *
 * 悬空引用**逐条列出**（名字 + 说明 + 建议）——这是"不静默"的落点：
 * 用户读到的是一份带名字的清单，而不是一句"有 N 条问题"。
 */
export function formatReferenceAudit(report: ReferenceAuditReport): string {
  const lines: string[] = [];
  lines.push(`引用审阅报告（${report.document_id}）`);
  lines.push(
    `检查：书签 ${report.checked.bookmarks} / 超链接 ${report.checked.hyperlinks} / ` +
      `脚注尾注 ${report.checked.notes} / 交叉引用 ${report.checked.cross_references} / ` +
      `目录条目 ${report.checked.toc_entries}`,
  );
  if (report.dangling.length === 0) {
    lines.push('悬空引用：无');
  } else {
    lines.push(`悬空引用（${report.dangling.length}）：`);
    for (const finding of report.dangling) {
      const label = finding.name === null ? finding.item_id : `"${finding.name}"`;
      lines.push(` - [${finding.item_kind}] ${label}：${finding.message}（建议：${finding.fix.hint}）`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push(`警告（${report.warnings.length}）：`);
    for (const finding of report.warnings) {
      const label = finding.name === null ? finding.item_id : `"${finding.name}"`;
      lines.push(` - [${finding.item_kind}] ${label}：${finding.message}（建议：${finding.fix.hint}）`);
    }
  }
  const infos = report.findings.filter((finding) => finding.severity === 'info');
  if (infos.length > 0) {
    // 外部目标**只记录、不抓取**（R161）：把它们原样列出来，正是"已记录"这条信息的落点。
    lines.push(`信息（${infos.length}）：`);
    for (const finding of infos) {
      const label = finding.name === null ? finding.item_id : `"${finding.name}"`;
      lines.push(` - [${finding.item_kind}] ${label}：${finding.message}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function displayNameOfHyperlink(target: HyperlinkTarget): string {
  switch (target.kind) {
    case 'external':
      return target.url;
    case 'email':
      return `mailto:${target.address}`;
    case 'internal':
      return `#${target.bookmark}`;
  }
}

function targetNameOf(kind: string, nodeId: NodeId | null, bookmarkId: string | null): string {
  if (kind === 'bookmark') return `#${bookmarkId ?? '<null>'}`;
  return `${kind}:${nodeId ?? '<null>'}`;
}

/** 便捷入口：只问"有没有悬空引用"。 */
export function hasDanglingReferences(report: ReferenceAuditReport): boolean {
  return report.dangling.length > 0;
}

/** 便捷入口：即便全绿也能直接拿到书签解析结果（供调用方二次判定）。 */
export function bookmarkIsResolvable(index: ReferenceIndex, name: string): boolean {
  return locateBookmark(index, name).ok;
}
