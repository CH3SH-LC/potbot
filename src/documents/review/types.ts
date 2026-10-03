/**
 * 审阅包（design-05 P7 / WF-077–080）自有的类型。
 *
 * ## 批注正文挂在模型上，线程态挂在侧表
 *
 * `model/types.ts` 已有 `CommentNode`（挂在 `DocumentModel.comments` 上），**不改它**。
 * 但"回复"与"是否已解决"在冻结骨架里没有位置，也不该塞进 `CommentNode.text`（那会污染正文语义）。
 * 因此用本包自带的 `ReviewIndex` 侧表存**线程态**（回复列表 + resolved 标记），
 * 批注本身的插入/删除仍通过重写 `model.comments` 完成。
 *
 * ## 修订记录描述"意图"，不是"已落地的结果"
 *
 * `RevisionRecord` 描述一次被跟踪的改动：插入（文字已在正文里）、删除（文字**仍在**正文里、
 * 只是被标为待删）、格式（属性从 before 变到 after）。接受/拒绝时按这条意图去算结果模型——
 * 于是"保留未处理记录"是自然结果：没被选中的记录原样还在。
 *
 * ## 比较结果必须**定位**到"哪一段的哪几个字"
 *
 * `ParagraphTextDiff` 用起止偏移 + 前后子串定位；`FormatDiff` 单独分类。
 * 整个 `DocumentComparison` **不是**一个布尔或 hash——那正是"不能只比整文件 hash"的落点。
 */

import type { CommentNode, DocumentId, NodeId } from '../model/types.js';
import type { DocumentRange } from '../selection/types.js';

// ---------------------------------------------------------------------------
// 批注线程（WF-077）
// ---------------------------------------------------------------------------

export interface CommentReply {
  readonly id: string;
  readonly comment_id: NodeId;
  readonly author: string;
  readonly text: string;
  /** ISO 8601。 */
  readonly date: string;
}

export interface CommentThread {
  readonly comment_id: NodeId;
  readonly resolved: boolean;
  readonly replies: readonly CommentReply[];
}

export interface ReviewIndex {
  readonly threads: readonly CommentThread[];
}

export function emptyReviewIndex(): ReviewIndex {
  return { threads: [] };
}

/** 读取视图：批注 + 当前锚定文字 + 锚点是否仍有效。 */
export interface CommentView {
  readonly comment: CommentNode;
  /** 锚点覆盖的当前文字；锚点无效时为 `null`。 */
  readonly anchored_text: string | null;
  readonly anchor_valid: boolean;
}

// ---------------------------------------------------------------------------
// 修订（WF-078）
// ---------------------------------------------------------------------------

export type RevisionKind = 'insert' | 'delete' | 'format';

/** 一次格式变更。`run_index` 仅在 `target:'run'` 时有意义（段内第几个 run，0 起）。 */
export interface FormatChange {
  readonly target: 'run' | 'paragraph';
  readonly node_id: NodeId;
  readonly run_index: number | null;
  /** 属性名，如 `bold` / `italic` / `underline` / `alignment`。 */
  readonly property: string;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * 一条修订记录。
 *
 * - `kind:'insert'`：`text` = 被插入的文字（**已在正文里**）；
 * - `kind:'delete'`：`text` = 被标记删除的文字（**仍在正文里**，接受后才真正删）；
 * - `kind:'format'`：`format` = 属性变更。
 */
export interface RevisionRecord {
  readonly id: string;
  readonly kind: RevisionKind;
  readonly author: string;
  /** ISO 8601。 */
  readonly date: string;
  readonly range: DocumentRange;
  readonly text: string | null;
  readonly format: FormatChange | null;
}

/** 修订开关状态（含作者，供后续记录署名）。 */
export interface TrackChangesState {
  readonly enabled: boolean;
  readonly author: string;
}

// ---------------------------------------------------------------------------
// 版本比较（WF-080）
// ---------------------------------------------------------------------------

/** 文字变化定位：`[start, end)` 是**变更前文本**里的变化段，`after` 是替换后的文字。 */
export interface ParagraphTextDiff {
  readonly start: number;
  readonly end: number;
  readonly before: string;
  readonly after: string;
}

export interface FormatDiff {
  readonly scope: 'run' | 'paragraph';
  readonly run_index: number | null;
  readonly property: string;
  readonly before: unknown;
  readonly after: unknown;
}

export type ParagraphDiffKind = 'unchanged' | 'modified' | 'inserted' | 'removed';

export interface ParagraphDiff {
  readonly node_id: NodeId;
  readonly kind: ParagraphDiffKind;
  readonly before_text: string;
  readonly after_text: string;
  /** 文字变化（`null` = 文字未变）。 */
  readonly text_diff: ParagraphTextDiff | null;
  /** 格式变化（与文字变化**分开**分类）。 */
  readonly format_changes: readonly FormatDiff[];
}

export interface DocumentComparison {
  readonly document_id: DocumentId;
  readonly paragraphs: readonly ParagraphDiff[];
  readonly summary: {
    readonly unchanged: number;
    readonly modified: number;
    readonly inserted: number;
    readonly removed: number;
    readonly text_changes: number;
    readonly format_changes: number;
  };
}
