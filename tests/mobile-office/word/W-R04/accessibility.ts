/**
 * **W-R04 — 无障碍（TalkBack 类读屏）文本视图与移动语义。**
 *
 * ## 对齐 Android 无障碍语义
 *
 * Android 的 `AccessibilityNodeInfo` 对可编辑文本框暴露：`getText()`、
 * `getTextSelectionStart()/getTextSelectionEnd()`（**UTF-16 码元**）、`isEditable()`，
 * 以及 `ACTION_SET_SELECTION`（参数 `ACTION_ARGUMENT_SELECTION_START_INT` / `..._END_INT`，码元）
 * 和粒度移动动作 `ACTION_NEXT_CHARACTER/WORD/LINE/PARAGRAPH`（及 PREVIOUS 变体）。
 *
 * 本节把这些动作映射到**码位**选区，并对两类真实缺陷做 fail-closed：
 *
 * 1. **代理对内部的选区**：读屏递来的码元偏移可能落在 emoji 中间 → `setAccessibleSelection`
 *    返回 `unsupported`（复用 `ime-bridge.ts` 的严格换算）。
 * 2. **移动后的非法落点**：按码位移动，emoji 无论向左向右都是"整体跨一个码位"，
 *    不可能停在代理对中间。
 *
 * ## 词/行边界的诚实边界
 *
 * - **词**：用本模块**自定义**的"同类字符合并"规则（拉丁/数字、CJK、假名、谚文为词字符，
 *   其余为分隔），**不是** UAX#29 的 Unicode 词边界，也不调用 ICU。规则写死、可测、
 *   文档化；真实输入法/读屏的词边界由平台 ICU 决定，本节只保证行为**确定**且不变。
 * - **行**：只用模型里的**软换行**（`w:br`，`'\n'`）作行界，**不是**自动换行后的视觉行。
 *   视觉行需要真实排版（W09），本节不伪造。
 * - **段**：单段节点内退化为段首/段尾。
 *
 * ## 触摸目标尺寸
 *
 * Android 最小触摸目标为 48dp × 48dp。`auditTouchTargets` 做纯几何审计，
 * 只报告不修改（可见 UI 调整归 F 线；本节只给数据）。
 */

import type { DocumentModel, NodeId } from '../../../../src/documents/model/types.js';
import { codePointIndexToUtf16Index } from '../../../../src/documents/selection/codepoint.js';
import { BREAK_TEXT } from '../../../../src/documents/selection/inline-map.js';
import { succeed, type Result } from '../../../../src/documents/selection/types.js';
import { imeViewOf, utf16RangeToCodePointRange, type ImeEditableView, type Utf16Selection } from './ime-bridge.js';

/** Android 无障碍文本框视图快照。 */
export interface AccessibleTextView {
  readonly document_id: string;
  readonly revision: number;
  readonly node_id: NodeId;
  readonly text: string;
  /** 平台选区（UTF-16，码元）。 */
  readonly selectionUtf16: Utf16Selection;
  /** 选区对应的码位范围（严格换算，切代理对即 fail）。 */
  readonly selectionCp: { readonly start: number; readonly end: number };
  readonly editable: true;
  readonly composing: boolean;
}

/** 由内核视图 + 平台选区构造无障碍视图；平台选区切代理对时返回 `unsupported`。 */
export function accessibleViewOf(
  view: ImeEditableView,
  selectionUtf16: Utf16Selection,
  composing = false,
): Result<AccessibleTextView> {
  const cp = utf16RangeToCodePointRange(view.text, selectionUtf16);
  if (!cp.ok) return cp;
  return succeed({
    document_id: view.document_id,
    revision: view.revision,
    node_id: view.node_id,
    text: view.text,
    selectionUtf16,
    selectionCp: { start: cp.value.start, end: cp.value.end },
    editable: true,
    composing,
  });
}

export function accessibleViewFromModel(
  model: DocumentModel,
  nodeId: NodeId,
  selectionUtf16: Utf16Selection,
  composing = false,
): Result<AccessibleTextView> {
  const view = imeViewOf(model, nodeId);
  if (!view.ok) return view;
  return accessibleViewOf(view.value, selectionUtf16, composing);
}

/** `ACTION_SET_SELECTION`：平台码元区间 → 校验后的码位选区。 */
export function setAccessibleSelection(
  view: AccessibleTextView,
  selectionUtf16: Utf16Selection,
): Result<{ readonly selectionUtf16: Utf16Selection; readonly selectionCp: { readonly start: number; readonly end: number } }> {
  const cp = utf16RangeToCodePointRange(view.text, selectionUtf16);
  if (!cp.ok) return cp;
  return succeed({ selectionUtf16, selectionCp: { start: cp.value.start, end: cp.value.end } });
}

// ---------------------------------------------------------------------------
// 粒度移动
// ---------------------------------------------------------------------------

export type Granularity = 'character' | 'word' | 'line' | 'paragraph';
export type Direction = 'forward' | 'backward';

/** 码位归类：`word` = 词字符，`sep` = 分隔。规则写死、与 ICU 无关（见文件头）。 */
function charClass(cp: string): 'word' | 'sep' {
  const code = cp.codePointAt(0);
  if (code === undefined) return 'sep';
  if (code >= 0x30 && code <= 0x39) return 'word'; // 0-9
  if (code >= 0x41 && code <= 0x5a) return 'word'; // A-Z
  if (code >= 0x61 && code <= 0x7a) return 'word'; // a-z
  if (code >= 0x4e00 && code <= 0x9fff) return 'word'; // CJK 统一表意
  if (code >= 0x3040 && code <= 0x30ff) return 'word'; // 平/片假名
  if (code >= 0xac00 && code <= 0xd7a3) return 'word'; // 谚文音节
  return 'sep';
}

/** 词边界（码位下标）：0、长度、以及相邻字符类别变化处。 */
export function wordBoundaries(text: string): readonly number[] {
  const points = Array.from(text);
  const out: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    if (charClass(points[i]!) !== charClass(points[i - 1]!)) out.push(i);
  }
  out.push(points.length);
  return out;
}

/** 行边界（码位下标）：软换行 `'\n'` 之后各自成界。 */
export function lineBoundaries(text: string): readonly number[] {
  const points = Array.from(text);
  const out: number[] = [0];
  for (let i = 0; i < points.length; i += 1) {
    if (points[i] === BREAK_TEXT) out.push(i + 1);
  }
  if (out[out.length - 1] !== points.length) out.push(points.length);
  return out;
}

function nextBoundary(boundaries: readonly number[], index: number, direction: Direction): number {
  if (direction === 'forward') {
    for (const b of boundaries) if (b > index) return b;
    return boundaries[boundaries.length - 1] ?? index;
  }
  for (let i = boundaries.length - 1; i >= 0; i -= 1) if (boundaries[i]! < index) return boundaries[i]!;
  return boundaries[0] ?? index;
}

export interface MoveRequest {
  readonly granularity: Granularity;
  readonly direction: Direction;
  /** 是否扩展选区（保留锚点）。默认 false = 折叠为光标。 */
  readonly extend?: boolean;
}

export interface MoveResult {
  readonly selectionUtf16: Utf16Selection;
  readonly selectionCp: { readonly start: number; readonly end: number };
}

/**
 * 粒度移动。character/word/line/paragraph 四档。
 * - character：码位 ±1（emoji 整体移动）。
 * - word：见 `wordBoundaries`。
 * - line：软换行界（视觉行需 W09，本节不假装有）。
 * - paragraph：单段节点内 = 段首/段尾。
 *
 * 移动量以**码位**计算，最终回写为 UTF-16 选区。
 */
export function moveSelection(view: AccessibleTextView, request: MoveRequest): Result<MoveResult> {
  const { start, end } = view.selectionCp;
  const anchor = start;
  const points = Array.from(view.text).length;
  const direction = request.direction;
  const extend = request.extend === true;

  // 移动基点是"方向上的活动端"：向前取 end，向后取 start。
  const base = direction === 'forward' ? end : start;
  let target: number;
  switch (request.granularity) {
    case 'character':
      target = direction === 'forward' ? Math.min(points, base + 1) : Math.max(0, base - 1);
      break;
    case 'word':
      target = nextBoundary(wordBoundaries(view.text), base, direction);
      break;
    case 'line':
      target = nextBoundary(lineBoundaries(view.text), base, direction);
      break;
    case 'paragraph':
      target = direction === 'forward' ? points : 0;
      break;
  }

  const cpStart = extend ? Math.min(anchor, target) : target;
  const cpEnd = extend ? Math.max(anchor, target) : target;
  return succeed({
    selectionUtf16: {
      start: codePointIndexToUtf16Index(view.text, cpStart),
      end: codePointIndexToUtf16Index(view.text, cpEnd),
    },
    selectionCp: { start: cpStart, end: cpEnd },
  });
}

// ---------------------------------------------------------------------------
// 触摸目标审计
// ---------------------------------------------------------------------------

/** Android 无障碍最小触摸目标（dp）。 */
export const MIN_TOUCH_TARGET_DP = 48;

export interface TouchTarget {
  readonly id: string;
  readonly label: string;
  readonly role: 'edit-object' | 'command' | 'text';
  readonly widthDp: number;
  readonly heightDp: number;
}

export interface TouchTargetIssue {
  readonly id: string;
  readonly code: 'too_small';
  readonly message: string;
  readonly widthDp: number;
  readonly heightDp: number;
}

/**
 * 触摸目标几何审计：小于 48×48 dp 的目标逐项报 `too_small`。
 * **只读**：不返回修改建议的 UI 实现，也不改任何 UI（可见 UI 归 F 线）。
 */
export function auditTouchTargets(targets: readonly TouchTarget[]): readonly TouchTargetIssue[] {
  const issues: TouchTargetIssue[] = [];
  for (const target of targets) {
    if (target.widthDp < MIN_TOUCH_TARGET_DP || target.heightDp < MIN_TOUCH_TARGET_DP) {
      issues.push({
        id: target.id,
        code: 'too_small',
        message: `触摸目标 "${target.label}" 为 ${target.widthDp}×${target.heightDp} dp，小于最小 ${MIN_TOUCH_TARGET_DP}×${MIN_TOUCH_TARGET_DP} dp。`,
        widthDp: target.widthDp,
        heightDp: target.heightDp,
      });
    }
  }
  return issues;
}

/** 便捷：布尔判定（审计为零问题即达标）。 */
export function meetsTouchTargetMinimum(target: TouchTarget): boolean {
  return target.widthDp >= MIN_TOUCH_TARGET_DP && target.heightDp >= MIN_TOUCH_TARGET_DP;
}

/** 读屏一次性可朗读的段落文本（软换行转为真实换行符；对象字符保留 U+FFFC 占位）。 */
export function spokenText(view: AccessibleTextView): string {
  return Array.from(view.text).join('');
}
