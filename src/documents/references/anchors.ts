/**
 * 锚点偏移传播（design-05 P7；合同 R102/R110/R114）。
 *
 * ## 为什么书签"不漂移"要靠一次显式的平移
 *
 * 书签 / 超链接 / 脚注 / 交叉引用都用 `(node_id, 码位起, 码位止)` 锚定（与选区同一套语义）。
 * 偏移是**对某个版本的具体文本**才成立的数——在书签前插入两个字，原偏移就指到了别的字。
 * 所以每发生一次文本编辑，锚点侧表必须**同步平移**。本模块把这次平移做成纯函数，
 * 于是"在书签前插入文字后，书签仍指向原来那段文字"是一条可断言的等式，而不是口头承诺。
 *
 * ## 平移规则（先删后插）
 *
 * 对区间 `[s, e)` 与编辑 `{ at, inserted, removed }`：
 * 1. 整段落在删除区内（`s ≥ at && e ≤ at+removed`）⇒ `intact:false`，收拢为零长度；
 * 2. 否则逐点映射：`p ≤ at` 不动；`p ≥ at+removed` 左移 `removed`；夹在中间收拢到 `at`；
 * 3. 再叠插入：起点用 `s ≥ at` 判、终点用 `e > at` 判——这样"插入点正好在区间起点"会让整段右移
 *    （插入在书签**之前**），而"插入点正好在区间终点"不会（插入在书签**之后**）。
 *
 * 零长度锚点（脚注标记那种点）统一按起点规则整体平移。
 *
 * ## 与 D03 的分工
 *
 * 文本插入/删除的**落点**复用选区包的 `replaceRangeInInlines`（它负责切 run、保格式）；
 * 本模块只做"改文本 + 同步平移到锚点侧表"这一层组合。**不递增 `revision`**——
 * 与 `operations/character/**` 同约定，递增 revision 是一次用户事务的收口，属上层。
 */

import type { DocumentModel, ParagraphNode } from '../model/types.js';
import { codePointLength } from '../selection/codepoint.js';
import { replaceRangeInInlines } from '../selection/inline-map.js';
import { requireParagraph, replaceParagraph } from '../selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import type { ReferenceIndex, ShiftedAnchor, TextChange } from './types.js';

/** 按一次编辑平移单个区间。返回新范围与是否仍完整覆盖原有文字。 */
export function shiftAnchor(range: DocumentRange, change: TextChange): ShiftedAnchor {
  const { at, inserted, removed } = change;

  // 越界/负数的编辑描述是调用方的错：拒绝而不是猜。
  if (
    !Number.isInteger(change.at) ||
    !Number.isInteger(inserted) ||
    !Number.isInteger(removed) ||
    at < 0 ||
    inserted < 0 ||
    removed < 0
  ) {
    throw new RangeError(
      `非法的文本编辑描述：at=${String(at)} inserted=${String(inserted)} removed=${String(removed)}`,
    );
  }

  const delEnd = at + removed;

  // 1) 整段被删除覆盖 ⇒ 明确标记"不完整"，收拢为零长度（不静默丢弃，R110）。
  if (removed > 0 && range.start >= at && range.end <= delEnd) {
    return { range: { node_id: range.node_id, start: at, end: at }, intact: false };
  }

  const mapDeleted = (p: number): number => {
    if (p <= at) return p;
    if (p >= delEnd) return p - removed;
    return at;
  };

  let start = mapDeleted(range.start);
  let end = mapDeleted(range.end);

  if (inserted > 0) {
    if (start === end) {
      if (start >= at) {
        start += inserted;
        end += inserted;
      }
    } else {
      if (start >= at) start += inserted;
      if (end > at) end += inserted;
    }
  }

  if (end < start) end = start;
  return { range: { node_id: range.node_id, start, end }, intact: true };
}

/** 平移整个引用侧表（书签 / 超链接 / 脚注尾注 / 交叉引用）。 */
export function shiftReferenceIndex(index: ReferenceIndex, change: TextChange): ReferenceIndex {
  const shift = (range: DocumentRange, intact: boolean): ShiftedAnchor => {
    if (!intact || range.node_id !== change.node_id) {
      // 已失效的锚点不再平移；别的段落里的锚点不受本次编辑影响。
      return { range, intact };
    }
    return shiftAnchor(range, change);
  };

  return {
    bookmarks: index.bookmarks.map((bookmark) => ({ ...bookmark, ...shift(bookmark.range, bookmark.intact) })),
    hyperlinks: index.hyperlinks.map((hyperlink) => ({ ...hyperlink, ...shift(hyperlink.range, hyperlink.intact) })),
    // 注的锚点是 `marker`（不是 `range`），单独映射。
    notes: index.notes.map((note) => {
      const shifted = shift(note.marker, note.intact);
      return { ...note, marker: shifted.range, intact: shifted.intact };
    }),
    cross_references: index.cross_references.map((ref) => ({ ...ref, ...shift(ref.range, ref.intact) })),
  };
}

/** 取段落；不存在即 `unknown_node`（供锚定前的前置检查）。 */
function paragraphOrFail(model: DocumentModel, nodeId: string): Result<ParagraphNode> {
  return requireParagraph(model, nodeId);
}

/** 在段落某偏移处插入文字，并**同步平移**锚点侧表。 */
export function insertText(
  index: ReferenceIndex,
  model: DocumentModel,
  input: { readonly node_id: string; readonly offset: number; readonly text: string },
): Result<{ readonly model: DocumentModel; readonly index: ReferenceIndex }> {
  const paragraph = paragraphOrFail(model, input.node_id);
  if (!paragraph.ok) return paragraph;
  const inlines = replaceRangeInInlines(paragraph.value.inlines, input.offset, input.offset, input.text);
  if (!inlines.ok) return inlines;
  const next = replaceParagraph(model, input.node_id, { ...paragraph.value, inlines: inlines.value });
  if (!next.ok) return next;
  const shifted = shiftReferenceIndex(index, {
    node_id: input.node_id,
    at: input.offset,
    inserted: codePointLength(input.text),
    removed: 0,
  });
  return succeed({ model: next.value, index: shifted });
}

/** 删除段落某范围文字，并**同步平移**锚点侧表（被覆盖的锚点标记为不完整）。 */
export function deleteText(
  index: ReferenceIndex,
  model: DocumentModel,
  input: { readonly node_id: string; readonly start: number; readonly end: number },
): Result<{ readonly model: DocumentModel; readonly index: ReferenceIndex }> {
  const paragraph = paragraphOrFail(model, input.node_id);
  if (!paragraph.ok) return paragraph;
  if (input.end < input.start) {
    return fail('invalid_range', `删除范围起止倒置：[${input.start}, ${input.end})。`, {
      extra: { start: input.start, end: input.end },
    });
  }
  const inlines = replaceRangeInInlines(paragraph.value.inlines, input.start, input.end, '');
  if (!inlines.ok) return inlines;
  const next = replaceParagraph(model, input.node_id, { ...paragraph.value, inlines: inlines.value });
  if (!next.ok) return next;
  const shifted = shiftReferenceIndex(index, {
    node_id: input.node_id,
    at: input.start,
    inserted: 0,
    removed: input.end - input.start,
  });
  return succeed({ model: next.value, index: shifted });
}
