/**
 * 书签（WF-071）——添加 / 定位 / 重命名 / 删除，以及取书签覆盖的文字。
 *
 * ## 三条纪律
 *
 * - **名字唯一**：重名书签会让 `w:anchor` 指向不唯一，属"引用必然指错"，一律拒绝（`precondition`）。
 * - **不静默消失**（R110）：目标文字被整段删除后，书签仍在侧表里、`intact:false`；
 *   `locateBookmark` 对它返回 `not_found`——"书签没了"是一个**被报告出来的**状态。
 * - **删除/重命名按 id**：`name` 会被人改来改去，`id` 才是不漂移的身份（R101 的取向）。
 *
 * 本模块只改引用侧表，**不动正文**——书签是锚在正文上的标记，不是正文的一部分。
 */

import type { DocumentModel } from '../model/types.js';
import { codePointSlice } from '../selection/codepoint.js';
import { paragraphText, requireParagraph } from '../selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import type { Bookmark, ReferenceIndex } from './types.js';

function assertName(name: string, what: string): Result<string> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return fail('precondition', `${what}必须是非空字符串。`, { extra: { value: String(name) } });
  }
  return succeed(name);
}

function assertRange(range: DocumentRange): Result<DocumentRange> {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    return fail('invalid_range', `书签范围非法：[${range.start}, ${range.end})。`, {
      extra: { start: range.start, end: range.end },
    });
  }
  return succeed(range);
}

/** 添加书签（名字重复即拒绝）。 */
export function addBookmark(
  index: ReferenceIndex,
  input: {
    readonly id: string;
    readonly name: string;
    readonly range: DocumentRange;
    readonly hidden?: boolean;
  },
): Result<ReferenceIndex> {
  const name = assertName(input.name, '书签名');
  if (!name.ok) return name;
  if (index.bookmarks.some((bookmark) => bookmark.name === name.value)) {
    return fail('precondition', `已存在名为 "${name.value}" 的书签——书签名必须唯一。`, {
      extra: { name: name.value },
    });
  }
  const range = assertRange(input.range);
  if (!range.ok) return range;
  const bookmark: Bookmark = {
    id: input.id,
    name: name.value,
    range: range.value,
    hidden: input.hidden ?? false,
    intact: true,
  };
  return succeed({ ...index, bookmarks: [...index.bookmarks, bookmark] });
}

/** 定位书签（按名字）。目标文字已被删除 ⇒ `not_found`。 */
export function locateBookmark(index: ReferenceIndex, name: string): Result<Bookmark> {
  const bookmark = index.bookmarks.find((candidate) => candidate.name === name);
  if (bookmark === undefined) {
    return fail('not_found', `文档里没有名为 "${name}" 的书签。`, { expression: name, hitCount: 0 });
  }
  if (!bookmark.intact) {
    return fail('not_found', `书签 "${name}" 指向的文字已被删除，已失效。`, {
      expression: name,
      hitCount: 0,
    });
  }
  return succeed(bookmark);
}

/** 书签覆盖的文字（只读投影，不折叠空白，R104）。 */
export function bookmarkText(model: DocumentModel, bookmark: Bookmark): Result<string> {
  if (!bookmark.intact) {
    return fail('not_found', `书签 "${bookmark.name}" 已失效，无法取文。`, { expression: bookmark.name });
  }
  const paragraph = requireParagraph(model, bookmark.range.node_id);
  if (!paragraph.ok) return paragraph;
  const text = paragraphText(paragraph.value);
  return succeed(codePointSlice(text, bookmark.range.start, bookmark.range.end));
}

/** 重命名书签（按 id）。新名字同样必须唯一。 */
export function renameBookmark(index: ReferenceIndex, id: string, newName: string): Result<ReferenceIndex> {
  const name = assertName(newName, '书签新名');
  if (!name.ok) return name;
  const target = index.bookmarks.find((bookmark) => bookmark.id === id);
  if (target === undefined) {
    return fail('not_found', `不存在 id 为 "${id}" 的书签。`, { extra: { id } });
  }
  if (index.bookmarks.some((bookmark) => bookmark.name === name.value && bookmark.id !== id)) {
    return fail('precondition', `已存在名为 "${name.value}" 的书签——书签名必须唯一。`, {
      extra: { name: name.value },
    });
  }
  return succeed({
    ...index,
    bookmarks: index.bookmarks.map((bookmark) =>
      bookmark.id === id ? { ...bookmark, name: name.value } : bookmark,
    ),
  });
}

/** 删除书签（按 id）。 */
export function removeBookmark(index: ReferenceIndex, id: string): Result<ReferenceIndex> {
  if (!index.bookmarks.some((bookmark) => bookmark.id === id)) {
    return fail('not_found', `不存在 id 为 "${id}" 的书签。`, { extra: { id } });
  }
  return succeed({ ...index, bookmarks: index.bookmarks.filter((bookmark) => bookmark.id !== id) });
}
