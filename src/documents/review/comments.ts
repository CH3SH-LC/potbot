/**
 * 批注（WF-077）——添加 / 读取 / 回复 / 解决 / 删除；**锚定到正确文字**。
 *
 * ## "同一段里两处相同文字，锚在指定的那一处"
 *
 * 只给一个词 `"AB"` 是不够的——它在 `"ABAB"` 里出现两次。因此锚定入口 `anchorByText`
 * 要求调用方给出**第几处**（`occurrence`，1 起），并返回那一处的码位区间；命中数不足时
 * 返回 `not_found` 且带上**实际命中数**（R112/R116：可解释，不静默）。
 *
 * ## 锚点身份
 *
 * 批注锚点复用冻结骨架 `CommentNode.anchor = { node_id, start, end }`（R114：随版本失效）。
 * 本模块只**校验**锚点落在存在的段落、且落在码位长度内，再用 `model.comments` 落盘。
 */

import type { CommentNode, DocumentModel, SourceKind } from '../model/types.js';
import { allocateNodeId } from '../model/ids.js';
import { commentPath } from '../model/nodes.js';
import { codePointLength, codePointSlice } from '../selection/codepoint.js';
import { findInInlines } from '../selection/find.js';
import { validateRanges } from '../selection/selection.js';
import { findParagraphById, paragraphText, requireParagraph } from '../selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import type { CommentThread, CommentView, ReviewIndex } from './types.js';

/** 按**序号**把一段文字锚定成码位区间（同名多处的判据）。 */
export function anchorByText(
  model: DocumentModel,
  input: { readonly paragraph_id: string; readonly text: string; readonly occurrence?: number },
): Result<DocumentRange> {
  const paragraph = requireParagraph(model, input.paragraph_id);
  if (!paragraph.ok) return paragraph;
  if (input.text.length === 0) {
    return fail('invalid_query', '锚定文字不能为空。', { expression: input.text });
  }
  const matches = findInInlines(paragraph.value.inlines, input.text);
  const occurrence = input.occurrence ?? 1;
  if (matches.length === 0) {
    return fail('not_found', `段落里没有 "${input.text}"。`, {
      expression: input.text,
      hitCount: 0,
      needsClarification: true,
    });
  }
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > matches.length) {
    return fail('not_found', `"${input.text}" 没有第 ${occurrence} 处（该段共 ${matches.length} 处）。`, {
      expression: input.text,
      hitCount: matches.length,
      needsClarification: true,
      candidates: matches.map((match) => ({
        node_id: input.paragraph_id,
        start: match.start,
        end: match.end,
      })),
    });
  }
  const match = matches[occurrence - 1]!;
  return succeed({ node_id: input.paragraph_id, start: match.start, end: match.end });
}

export interface AddCommentInput {
  readonly author: string;
  readonly text: string;
  readonly anchor: DocumentRange;
  readonly source?: SourceKind;
  /** 不传则按批注序确定性分配（R101）。 */
  readonly id?: string;
}

/** 添加批注。锚点必须落在存在的段落、且范围合法（否则 `unknown_node` / `invalid_range`）。 */
export function addComment(model: DocumentModel, input: AddCommentInput): Result<DocumentModel> {
  const checked = validateRanges(model, [input.anchor]);
  if (!checked.ok) return checked;
  const id =
    input.id ?? allocateNodeId(model.comments.map((comment) => comment.id), commentPath(model.comments.length));
  const comment: CommentNode = {
    kind: 'comment',
    id,
    source: input.source ?? 'user_request',
    opaque: [],
    author: input.author,
    text: input.text,
    anchor: input.anchor,
  };
  return succeed({ ...model, comments: [...model.comments, comment] });
}

/** 读取全部批注及其**当前**锚定文字；锚点失效的如实标 `anchor_valid:false`。 */
export function readComments(model: DocumentModel): readonly CommentView[] {
  return model.comments.map((comment) => {
    if (comment.anchor === null) {
      return { comment, anchored_text: null, anchor_valid: false };
    }
    const paragraph = findParagraphById(model.blocks, comment.anchor.node_id);
    if (paragraph === null) {
      return { comment, anchored_text: null, anchor_valid: false };
    }
    const text = paragraphText(paragraph);
    if (comment.anchor.end > codePointLength(text)) {
      return { comment, anchored_text: null, anchor_valid: false };
    }
    return {
      comment,
      anchored_text: codePointSlice(text, comment.anchor.start, comment.anchor.end),
      anchor_valid: true,
    };
  });
}

export interface AddReplyInput {
  readonly comment_id: string;
  readonly author: string;
  readonly text: string;
  readonly date: string;
  readonly id?: string;
}

/** 回复批注（同一条批注的回复归到同一线程；线程不存在则建立）。 */
export function addReply(index: ReviewIndex, input: AddReplyInput): Result<ReviewIndex> {
  const existing = index.threads.find((thread) => thread.comment_id === input.comment_id);
  const replyId = input.id ?? `${input.comment_id}/reply:${existing?.replies.length ?? 0}`;
  const reply = {
    id: replyId,
    comment_id: input.comment_id,
    author: input.author,
    text: input.text,
    date: input.date,
  };
  if (existing === undefined) {
    const thread: CommentThread = { comment_id: input.comment_id, resolved: false, replies: [reply] };
    return succeed({ threads: [...index.threads, thread] });
  }
  return succeed({
    threads: index.threads.map((thread) =>
      thread.comment_id === input.comment_id ? { ...thread, replies: [...thread.replies, reply] } : thread,
    ),
  });
}

/** 标记批注已解决（线程不存在则建立一条 resolved 线程）。 */
export function resolveComment(index: ReviewIndex, commentId: string): Result<ReviewIndex> {
  const existing = index.threads.find((thread) => thread.comment_id === commentId);
  if (existing === undefined) {
    return succeed({ threads: [...index.threads, { comment_id: commentId, resolved: true, replies: [] }] });
  }
  return succeed({
    threads: index.threads.map((thread) =>
      thread.comment_id === commentId ? { ...thread, resolved: true } : thread,
    ),
  });
}

/**
 * 删除批注：**解决 ≠ 删除**——解决只改线程态（批注与文字都留），删除才从模型里移除批注，
 * 并连带清掉它的线程。找不到批注返回 `not_found`。
 */
export function deleteComment(
  model: DocumentModel,
  index: ReviewIndex,
  commentId: string,
): Result<{ readonly model: DocumentModel; readonly index: ReviewIndex }> {
  if (!model.comments.some((comment) => comment.id === commentId)) {
    return fail('not_found', `不存在 id 为 "${commentId}" 的批注。`, { extra: { id: commentId } });
  }
  return succeed({
    model: { ...model, comments: model.comments.filter((comment) => comment.id !== commentId) },
    index: { threads: index.threads.filter((thread) => thread.comment_id !== commentId) },
  });
}
