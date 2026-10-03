/**
 * **W-R04 — 手机输入法（IME）桥：UTF-16 平台坐标 ⇄ 码位文档坐标。**
 *
 * ## 问题陈述
 *
 * Android 的 `InputConnection` / `AccessibilityNodeInfo` 一律用 **UTF-16 码元**偏移
 * （`setComposingRegion(start,end)`、`getTextSelectionStart()`、`deleteSurroundingText(before,after)`
 * 都以"码元"计），而本文档内核的**所有**偏移是**码位**（R102，见 `selection/types.ts`）。
 * 两者在**非 BMP 字符**（emoji、部分 CJK 扩展字）上不等长：`'😀'` 是 1 码位 / 2 码元。
 *
 * 直接拿平台的 UTF-16 偏移去切文档，会在代理对中间切开——产出的**不是"偏一点"，
 * 而是非法字符串**（孤立代理项）。这类缺陷在中文输入法里高频：输入法删一个字、用户选中
 * emoji、语音输入落点，都可能递来"半个代理对"的边界。本桥的职责就是：
 *
 * 1. 把平台的 UTF-16 选区/组合区**安全**换算成码位坐标；
 * 2. 换算前先检测"边界是否落在代理对内部"——是则 **fail-closed**（`unsupported`），
 *    而不是悄悄取整；
 * 3. 把 `deleteSurroundingText` 的码元长度**向外扩张到码位边界**，保证删掉完整码位，
 *    绝不产生孤立代理项。
 *
 * ## 组合态（composing）不是文档修改
 *
 * 输入法打拼音时，候选串是**未提交**的：它显示在光标处，但**不进文档模型**（不进 revision）。
 * 因此组合态被建模为独立的 `CompositionState`，只有 `commitComposition` 才落到文档并 bumb revision。
 * `finishComposingText` 丢弃候选串、不改文档。
 *
 * ## 复用而非重写
 *
 * 码位换算复用 `selection/codepoint.ts`；落文本用 `selection/inline-map.ts::replaceRangeInInlines`
 * （它负责"未选 run 原引用保留"与"范围含不可编辑对象即拒绝"）；段落替换用
 * `selection/structure.ts::replaceParagraph`。本模块**不重新实现**这些内核逻辑。
 */

import type { DocumentModel, InlineNode, NodeId, Revision } from '../../../../src/documents/model/types.js';
import {
  codePointIndexToUtf16Index,
  codePointLength,
  utf16IndexToCodePointIndex,
} from '../../../../src/documents/selection/codepoint.js';
import { replaceRangeInInlines } from '../../../../src/documents/selection/inline-map.js';
import { paragraphText, replaceParagraph, requireParagraph } from '../../../../src/documents/selection/structure.js';
import { fail, succeed, type CodePointRange, type DocumentRange, type Result, type Selection } from '../../../../src/documents/selection/types.js';

/** 平台给的 UTF-16 区间 `[start, end)`（Android 语义：码元，开区间）。 */
export interface Utf16Selection {
  readonly start: number;
  readonly end: number;
}

/** 元素级判据：判断某个 UTF-16 下标是否**落在代理对内部**（前高后低）。 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 该 UTF-16 下标是否切开了一个代理对：即 `text[i-1]` 是高代理、`text[i]` 是低代理。
 * 端点（0 与 `text.length`）永远不切开。
 *
 * 独立于实现：用 `charCodeAt`（码元）判据，与 `Array.from`（码位）判据互相印证。
 */
export function utf16IndexSplitsSurrogate(text: string, index: number): boolean {
  if (!Number.isInteger(index)) return false;
  if (index <= 0 || index >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

/** 向左扩张到码位边界（若 `index` 落在代理对内部则左移 1）。 */
export function expandLeftToCodePoint(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (i > 0 && i < text.length && isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i))) {
    i -= 1;
  }
  return i;
}

/** 向右扩张到码位边界（若 `index` 落在代理对内部则右移 1）。 */
export function expandRightToCodePoint(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (i > 0 && i < text.length && isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i))) {
    i += 1;
  }
  return i;
}

/**
 * UTF-16 区间 → 码位区间。**严格**：起止必须落在码位边界、必须是整数、必须 `start ≤ end`，
 * 且落在 `[0, text.length]` 内。任何一条不满足都 fail-closed——**绝不静默取整**。
 */
export function utf16RangeToCodePointRange(text: string, selection: Utf16Selection): Result<CodePointRange> {
  const { start, end } = selection;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return fail('invalid_range', `UTF-16 偏移必须是整数，收到 [${start}, ${end})。`, {
      extra: { start: String(start), end: String(end) },
    });
  }
  if (start < 0 || end < start || end > text.length) {
    return fail('invalid_range', `UTF-16 区间 [${start}, ${end}) 超出文本长度 ${text.length}。`, {
      extra: { start, end, length: text.length },
    });
  }
  if (utf16IndexSplitsSurrogate(text, start) || utf16IndexSplitsSurrogate(text, end)) {
    return fail('unsupported', '选区的 UTF-16 边界落在代理对内部，拒绝换算（会切开字符）。', {
      extra: {
        start,
        end,
        // `FailureDetail.extra` 只允许 `number | string`，布尔折算为 1/0。
        startSplits: utf16IndexSplitsSurrogate(text, start) ? 1 : 0,
        endSplits: utf16IndexSplitsSurrogate(text, end) ? 1 : 0,
      },
    });
  }
  return succeed({
    start: utf16IndexToCodePointIndex(text, start),
    end: utf16IndexToCodePointIndex(text, end),
  });
}

/** 码位区间 → 平台 UTF-16 区间（回程，供宿主把光标位置回写平台）。 */
export function codePointRangeToUtf16Range(text: string, range: CodePointRange): Utf16Selection {
  return {
    start: codePointIndexToUtf16Index(text, range.start),
    end: codePointIndexToUtf16Index(text, range.end),
  };
}

/**
 * IME 可编辑视图：一个承载组合/选区的段落快照。
 * `text` 是该段的码位文本（软换行为 `'\n'`，对象字符为 U+FFFC），与内核偏移空间**同源**。
 */
export interface ImeEditableView {
  readonly document_id: string;
  readonly revision: Revision;
  readonly node_id: NodeId;
  readonly text: string;
}

export function imeViewOf(model: DocumentModel, nodeId: NodeId): Result<ImeEditableView> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  return succeed({
    document_id: model.document_id,
    revision: model.revision,
    node_id: nodeId,
    text: paragraphText(paragraph.value),
  });
}

/**
 * 平台选区 → 内核 `Selection`（带 `baseRevision = view.revision`）。
 * 换算严格（见 `utf16RangeToCodePointRange`）；失败**不产出半成品**。
 */
export function selectionFromPlatform(view: ImeEditableView, platform: Utf16Selection): Result<Selection> {
  const range = utf16RangeToCodePointRange(view.text, platform);
  if (!range.ok) return range;
  const documentRange: DocumentRange = { node_id: view.node_id, start: range.value.start, end: range.value.end };
  return succeed({ document_id: view.document_id, base_revision: view.revision, ranges: [documentRange] });
}

// ---------------------------------------------------------------------------
// 组合态
// ---------------------------------------------------------------------------

/**
 * 组合态：`[anchor_start, anchor_end)` 是**已提交文本**里将被候选串替换的区间，
 * `pending` 是当前候选串（未提交）。渲染预览即"用 pending 替换该区间"。
 */
export interface CompositionState {
  readonly active: true;
  readonly node_id: NodeId;
  readonly anchor_start: number;
  readonly anchor_end: number;
  readonly pending: string;
}

export function compositionInactive(): { readonly active: false } {
  return { active: false };
}

/** 以光标（UTF-16）为锚点开始组合：锚为一段零长区间，候选串为空。 */
export function beginComposition(view: ImeEditableView, caretUtf16: number): Result<CompositionState> {
  const caret = utf16RangeToCodePointRange(view.text, { start: caretUtf16, end: caretUtf16 });
  if (!caret.ok) return caret;
  return succeed({
    active: true,
    node_id: view.node_id,
    anchor_start: caret.value.start,
    anchor_end: caret.value.start,
    pending: '',
  });
}

/**
 * `setComposingRegion(start,end)`：把组合锚点挪到既有文本的某区间（平台 UTF-16）。
 * 严格换算；候选串保留。锚区间覆盖不可编辑对象时，留给 `commitComposition` 拒绝。
 */
export function setCompositionRegion(
  view: ImeEditableView,
  state: CompositionState,
  region: Utf16Selection,
): Result<CompositionState> {
  const range = utf16RangeToCodePointRange(view.text, region);
  if (!range.ok) return range;
  return succeed({ ...state, anchor_start: range.value.start, anchor_end: range.value.end });
}

/** `setComposingText(text)`：替换当前候选串，锚区间不变（新候选串在提交时落入锚区间）。 */
export function setComposingText(_view: ImeEditableView, state: CompositionState, text: string): Result<CompositionState> {
  if (typeof text !== 'string') {
    return fail('invalid_query', '组合文本必须是字符串。', {});
  }
  return succeed({ ...state, pending: text });
}

/**
 * 组合预览：用候选串替换锚区间的行内文本，**不修改模型、不 bump revision**。
 * 复算不变式：锚区间未受影响的 run **原引用保留**（由 `replaceRangeInInlines` 保证）。
 */
export function composePreviewInlines(model: DocumentModel, state: CompositionState): Result<readonly InlineNode[]> {
  const paragraph = requireParagraph(model, state.node_id);
  if (!paragraph.ok) return paragraph;
  return replaceRangeInInlines(paragraph.value.inlines, state.anchor_start, state.anchor_end, state.pending);
}

/** 提交结果：新模型（revision 已 +1）与新的光标码位位置（= 锚起点 + 提交串码位数）。 */
export interface CommitResult {
  readonly model: DocumentModel;
  readonly revision: Revision;
  readonly caret: number;
}

/**
 * `commitText(text)`：把锚区间 [anchor_start, anchor_end) 替换为 `text`，落地到文档并 bump revision。
 * 锚区间含软换行/域/图片/公式时，`replaceRangeInInlines` 返回 `unsupported`，本函数原样上抛——
 * 组合不得覆盖不可编辑对象。
 */
export function commitComposition(model: DocumentModel, state: CompositionState, text: string): Result<CommitResult> {
  const paragraph = requireParagraph(model, state.node_id);
  if (!paragraph.ok) return paragraph;
  const replaced = replaceRangeInInlines(paragraph.value.inlines, state.anchor_start, state.anchor_end, text);
  if (!replaced.ok) return replaced;
  const updated = replaceParagraph(model, state.node_id, { ...paragraph.value, inlines: replaced.value });
  if (!updated.ok) return updated;
  const nextRevision = model.revision + 1;
  return succeed({
    model: { ...updated.value, revision: nextRevision },
    revision: nextRevision,
    caret: state.anchor_start + codePointLength(text),
  });
}

/**
 * `finishComposingText()`：结束组合，**丢弃候选串**，文档不变。
 * 返回新的光标码位位置（仍在锚起点）。
 */
export function finishComposingText(state: CompositionState): { readonly caret: number } {
  return { caret: state.anchor_start };
}

// ---------------------------------------------------------------------------
// deleteSurroundingText
// ---------------------------------------------------------------------------

/**
 * `deleteSurroundingText(beforeLength, afterLength)`：两个长度单位都是**UTF-16 码元**。
 * 先把 "光标前 N 码元" 换算成绝对 UTF-16 区间，再**向外扩张到码位边界**，最后按码位切除。
 *
 * 这样 `deleteSurroundingText(1,0)` 在光标前是 emoji 时会删掉**整个 emoji**（其 2 码元），
 * 而不是删掉低代理元留下孤立代理项。这是有意的行为选择：宁可删一个"用户觉得是一个字"
 * 的字符，也不产出非法字符串。BMP 字符（ASCII/常用汉字）仍恰好删 1 个。
 */
export function deleteSurroundingText(
  model: DocumentModel,
  nodeId: NodeId,
  caret: Utf16Selection,
  beforeLength: number,
  afterLength: number,
): Result<CommitResult> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  const text = paragraphText(paragraph.value);

  if (!Number.isInteger(beforeLength) || !Number.isInteger(afterLength) || beforeLength < 0 || afterLength < 0) {
    return fail('invalid_range', `deleteSurroundingText 长度必须是非负整数，收到 (${beforeLength}, ${afterLength})。`, {
      extra: { beforeLength: String(beforeLength), afterLength: String(afterLength) },
    });
  }
  const caretRange = utf16RangeToCodePointRange(text, caret);
  if (!caretRange.ok) return caretRange;

  // 绝对 UTF-16 区间（可能越界，先夹紧再扩张）。
  const rawStart = Math.max(0, caret.start - beforeLength);
  const rawEnd = Math.min(text.length, caret.end + afterLength);
  const startU = expandLeftToCodePoint(text, rawStart);
  const endU = expandRightToCodePoint(text, rawEnd);

  const startCp = utf16IndexToCodePointIndex(text, startU);
  const endCp = utf16IndexToCodePointIndex(text, endU);
  if (startCp === endCp) {
    return fail('empty_range', '要删除的范围为空（光标前/后没有可删的完整码位）。', {
      extra: { startU, endU, startCp, endCp },
    });
  }

  const replaced = replaceRangeInInlines(paragraph.value.inlines, startCp, endCp, '');
  if (!replaced.ok) return replaced;
  const updated = replaceParagraph(model, nodeId, { ...paragraph.value, inlines: replaced.value });
  if (!updated.ok) return updated;
  const nextRevision = model.revision + 1;
  // 删除后光标退回被删区间起点。
  return succeed({
    model: { ...updated.value, revision: nextRevision },
    revision: nextRevision,
    caret: startCp,
  });
}
