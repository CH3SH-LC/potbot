/**
 * 交叉引用（WF-075/076）。
 *
 * ## "不断链"是什么意思
 *
 * 交叉引用存的是**目标身份**（标题/题注的稳定节点 id，或书签 id），**不是**目标当时的文字。
 * 因此当被引标题从"第一章"改成"第二章"时，引用**仍指向它**——解析出来的文字会跟着变。
 * 反过来说，如果目标被删掉了，解析返回 `not_found`，**绝不**沿用旧快照伪装成还在
 * （R112/R154 的取向：宁可报"找不到了"，也不给一个假的成功）。
 *
 * ## 为什么 `show: 'page'` 直接拒绝
 *
 * 页码要真实排版（R158）。本层没有排版证据，所以 `show: 'page'` 一律 `precondition`——
 * 这与目录页的处理同一条纪律。
 */

import type { DocumentModel, ParagraphNode } from '../model/types.js';
import { findNodeById } from '../model/walk.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import { isHeadingParagraph } from '../selection/resolve.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import { bookmarkText, locateBookmark } from './bookmarks.js';
import type { CrossRefTarget, CrossReference, ReferenceIndex } from './types.js';

export interface CreateCrossReferenceInput {
  readonly id: string;
  readonly range: DocumentRange;
  readonly target: CrossRefTarget;
  readonly show: 'text' | 'number' | 'page';
}

function paragraphOf(model: DocumentModel, nodeId: string): ParagraphNode | null {
  const node = findNodeById(model, nodeId);
  return node !== null && node.kind === 'paragraph' ? node : null;
}

/** 目标是否存在（创建时的前置检查）。 */
function targetExists(model: DocumentModel, index: ReferenceIndex, target: CrossRefTarget): Result<true> {
  switch (target.kind) {
    case 'heading':
    case 'caption': {
      if (target.node_id === null || paragraphOf(model, target.node_id) === null) {
        return fail('not_found', `交叉引用的目标段落 "${String(target.node_id)}" 不存在。`, {
          extra: { node_id: String(target.node_id), kind: target.kind },
        });
      }
      return succeed(true);
    }
    case 'bookmark': {
      if (target.bookmark_id === null || !index.bookmarks.some((b) => b.id === target.bookmark_id)) {
        return fail('not_found', `交叉引用的目标书签 "${String(target.bookmark_id)}" 不存在。`, {
          extra: { bookmark_id: String(target.bookmark_id) },
        });
      }
      return succeed(true);
    }
  }
}

/** 新建交叉引用（目标必须已存在；否则 `not_found`，绝不留下悬空引用）。 */
export function createCrossReference(
  model: DocumentModel,
  index: ReferenceIndex,
  input: CreateCrossReferenceInput,
): Result<ReferenceIndex> {
  if (!Number.isInteger(input.range.start) || !Number.isInteger(input.range.end) || input.range.start < 0 || input.range.end < input.range.start) {
    return fail('invalid_range', `交叉引用范围非法：[${input.range.start}, ${input.range.end})。`, {
      extra: { start: input.range.start, end: input.range.end },
    });
  }
  const exists = targetExists(model, index, input.target);
  if (!exists.ok) return exists;
  const ref: CrossReference = {
    id: input.id,
    range: input.range,
    target: input.target,
    show: input.show,
    cached_text: null,
    refresh_state: 'unknown',
    intact: true,
  };
  return succeed({ ...index, cross_references: [...index.cross_references, ref] });
}

/** 标题在全部标题里的序号（1 起）；用于 `show:'number'`。 */
function headingOrdinal(model: DocumentModel, nodeId: string): number | null {
  let ordinal = 0;
  for (const paragraph of collectParagraphs(model.blocks)) {
    if (!isHeadingParagraph(paragraph, model.styles)) continue;
    ordinal += 1;
    if (paragraph.id === nodeId) return ordinal;
  }
  return null;
}

/**
 * 解析交叉引用**当前**的显示文字（不改缓存）。
 *
 * - `show:'text'` → 目标当前文字；
 * - `show:'number'` → 标题序号（仅 heading/caption）；
 * - `show:'page'` → `precondition`（无排版证据，R158）；
 * - 目标被删 / 书签失效 ⇒ `not_found`（**不伪造**）。
 */
export function resolveCrossReference(
  model: DocumentModel,
  index: ReferenceIndex,
  ref: CrossReference,
): Result<string> {
  if (!ref.intact) {
    return fail('not_found', `交叉引用 "${ref.id}" 已失效。`, { extra: { id: ref.id } });
  }
  if (ref.show === 'page') {
    return fail('precondition', `页码型交叉引用需要真实排版证据，本层不提供（R158）。`, {
      extra: { id: ref.id },
    });
  }

  switch (ref.target.kind) {
    case 'heading':
    case 'caption': {
      const nodeId = ref.target.node_id;
      if (nodeId === null) {
        return fail('not_found', `交叉引用 "${ref.id}" 没有目标节点 id。`, { extra: { id: ref.id } });
      }
      const paragraph = paragraphOf(model, nodeId);
      if (paragraph === null) {
        return fail('not_found', `交叉引用 "${ref.id}" 的目标段落已被删除。`, {
          extra: { id: ref.id, node_id: nodeId },
        });
      }
      if (ref.show === 'number') {
        const ordinal = headingOrdinal(model, nodeId);
        if (ordinal === null) {
          return fail('not_found', `交叉引用 "${ref.id}" 的目标不再是标题，无法取序号。`, {
            extra: { id: ref.id, node_id: nodeId },
          });
        }
        return succeed(String(ordinal));
      }
      return succeed(paragraphText(paragraph));
    }
    case 'bookmark': {
      const bookmarkId = ref.target.bookmark_id;
      if (bookmarkId === null) {
        return fail('not_found', `交叉引用 "${ref.id}" 没有目标书签 id。`, { extra: { id: ref.id } });
      }
      const bookmark = index.bookmarks.find((candidate) => candidate.id === bookmarkId);
      if (bookmark === undefined) {
        return fail('not_found', `交叉引用 "${ref.id}" 的目标书签已被删除。`, {
          extra: { id: ref.id, bookmark_id: bookmarkId },
        });
      }
      const located = locateBookmark(index, bookmark.name);
      if (!located.ok) return located;
      return bookmarkText(model, located.value);
    }
  }
}

/** 刷新交叉引用缓存：把当前解析结果写进 `cached_text`，并如实标注刷新状态。 */
export function refreshCrossReference(
  model: DocumentModel,
  index: ReferenceIndex,
  ref: CrossReference,
): Result<{ readonly index: ReferenceIndex; readonly ref: CrossReference }> {
  const resolved = resolveCrossReference(model, index, ref);
  if (!resolved.ok) {
    // 解析失败：把引用标记为 stale（但**不**改成 not_found 的成功假象）。
    const stale: CrossReference = { ...ref, refresh_state: 'stale' };
    return succeed({
      index: { ...index, cross_references: index.cross_references.map((item) => (item.id === ref.id ? stale : item)) },
      ref: stale,
    });
  }
  const refreshed: CrossReference = { ...ref, cached_text: resolved.value, refresh_state: 'refreshed' };
  return succeed({
    index: {
      ...index,
      cross_references: index.cross_references.map((item) => (item.id === ref.id ? refreshed : item)),
    },
    ref: refreshed,
  });
}
