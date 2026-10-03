/**
 * **W-R04 — 手机输入法/选区/无障碍与编辑对象定位的独立验证**
 * （`tests/mobile-office/word/W-R04/`）。
 *
 * 本文件验证同目录下的三个**源模块**：
 * - `ime-bridge.ts`（UTF-16 平台坐标 ⇄ 码位文档坐标；组合态；deleteSurroundingText）
 * - `accessibility.ts`（无障碍视图、粒度移动、触摸目标审计）
 * - `edit-targeting.ts`（触摸点 → 编辑目标；布局 fixture）
 * 以及 `operations.ts`（命令/事件 schema 校验）。
 *
 * ## 独立判据（防"判据是空壳"）
 *
 * - 期望值**用 `Array.from`（码位）独立复算**，不复用被测模块的换算函数。
 * - 代理对安全用**独立正则**扫描产物里是否有孤立代理项——这是本包最关键的不变量：
 *   输入法/读屏递来的码元边界一旦切开 emoji，产物就是非法字符串。
 * - 每条"操作成功"都配一条**边界邻位/反向对照**（如 `[1,0)` 删 BMP 与删 emoji 的差异、
 *   word 前进/后退、extend/不 extend）。
 * - 断言追溯到合同语义（R102 码位偏移）与 Android 无障碍语义（码元 vs 码位、48dp 目标）。
 *
 * ## 诚实边界（本文件覆盖不到的层，见 RUNBOOK 与结构化回报）
 *
 * 本节只到 **unit 层**：不接真实输入法、不接 TalkBack、不接真机、不做真实排版。
 * 布局用记录 fixture（`verificationMode:'fixture'`），不产生页码（W04 领域）。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel, DrawingNode, EquationNode, InlineNode, RunNode } from '../../../../src/documents/model/types.js';
import { paragraphText, requireParagraph } from '../../../../src/documents/selection/structure.js';
import { breakNode, document, paragraph, paragraphOfRuns, run } from '../../../../src/documents/selection/testing.js';

import {
  accessibleViewFromModel,
  accessibleViewOf,
  auditTouchTargets,
  lineBoundaries,
  meetsTouchTargetMinimum,
  MIN_TOUCH_TARGET_DP,
  moveSelection,
  setAccessibleSelection,
  spokenText,
  wordBoundaries,
  type AccessibleTextView,
  type TouchTarget,
} from './accessibility.js';
import {
  lineIndexOfOffset,
  accessibilityFocusOrder,
  hitTest,
  type LayoutFixture,
} from './edit-targeting.js';
import {
  beginComposition,
  codePointRangeToUtf16Range,
  commitComposition,
  composePreviewInlines,
  deleteSurroundingText,
  finishComposingText,
  imeViewOf,
  setCompositionRegion,
  setComposingText,
  utf16IndexSplitsSurrogate,
  utf16RangeToCodePointRange,
} from './ime-bridge.js';
import {
  OPERATION_NAMES,
  validateEvent,
  validateOperation,
  WORD_INPUT_SCHEMA_VERSION,
} from './operations.js';

// ---------------------------------------------------------------------------
// 独立工具（不 import 生产判定逻辑）
// ---------------------------------------------------------------------------

/** 按码位切分（独立复算用）。 */
function points(text: string): string[] {
  return Array.from(text);
}

/** 孤立代理项（成对者会被整体匹配掉）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

function runsOf(inlines: readonly InlineNode[]): RunNode[] {
  return inlines.filter((node): node is RunNode => node.kind === 'run');
}

function concatenatedRunText(inlines: readonly InlineNode[]): string {
  return runsOf(inlines).map((node) => node.text).join('');
}

function pText(model: DocumentModel, id: string): string {
  const found = requireParagraph(model, id);
  if (!found.ok) throw new Error(`缺少段落 ${id}`);
  return paragraphText(found.value);
}

function pInlines(model: DocumentModel, id: string): readonly InlineNode[] {
  const found = requireParagraph(model, id);
  if (!found.ok) throw new Error(`缺少段落 ${id}`);
  return found.value.inlines;
}

function drawing(id: string, altText: string | null): DrawingNode {
  return {
    kind: 'drawing',
    id,
    source: 'imported',
    opaque: [],
    drawing_type: 'picture',
    relationship_id: null,
    extent: null,
    rotation_deg: 0,
    wrap: 'inline',
    alt_text: altText,
  };
}

function equation(id: string): EquationNode {
  return {
    kind: 'equation',
    id,
    source: 'imported',
    opaque: [],
    equation_id: id,
    content: { kind: 'preserved', reason: 'w-r04 fixture', omml: '<m:oMath/>' },
  };
}

const EMOJI = '\u{1F600}'; // 😀 = 1 码位 / 2 UTF-16 码元
const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 5 码位 / 11 码元

function singleRunModel(id: string, text: string): DocumentModel {
  return document([paragraphOfRuns(id, [['r1', text]])]);
}

// ===========================================================================
// §A UTF-16 → 码位严格换算
// ===========================================================================

describe('W-R04 §A UTF-16 → 码位严格换算（R102）', () => {
  it('A1 emoji：UTF-16 [2,3] → 码位 [1,2]（独立复算）', () => {
    const text = `${EMOJI}B`;
    expect(text.length).toBe(3); // UTF-16 码元数
    expect(points(text).length).toBe(2); // 码位数

    const result = utf16RangeToCodePointRange(text, { start: 2, end: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 独立复算：切掉前 2 个码元再数剩余码位。
    const expectedStart = points(text.slice(0, 2)).length;
    const expectedEnd = points(text.slice(0, 3)).length;
    expect(result.value).toEqual({ start: expectedStart, end: expectedEnd });
    expect(result.value).toEqual({ start: 1, end: 2 });
  });

  it('A2 BMP：UTF-16 与码位一致（对照 emoji）', () => {
    const text = 'abc';
    const result = utf16RangeToCodePointRange(text, { start: 1, end: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ start: 1, end: 3 });
  });

  it('A3 边界切代理对 ⇒ fail-closed unsupported（不静默取整）', () => {
    const text = EMOJI; // len 2 utf16
    const mid = utf16RangeToCodePointRange(text, { start: 1, end: 1 });
    expect(mid.ok).toBe(false);
    if (mid.ok) return;
    expect(mid.code).toBe('unsupported');
    expect(mid.detail.extra?.startSplits).toBe(1);

    // 端点不切代理对 ⇒ 成功（对照）。
    const atEnd = utf16RangeToCodePointRange(text, { start: 2, end: 2 });
    expect(atEnd.ok).toBe(true);
    if (!atEnd.ok) return;
    expect(atEnd.value).toEqual({ start: 1, end: 1 });
  });

  it('A4 倒置 / 越界 / 非整数 ⇒ invalid_range', () => {
    const reversed = utf16RangeToCodePointRange('abc', { start: 3, end: 1 });
    expect(reversed.ok).toBe(false);
    if (reversed.ok) return;
    expect(reversed.code).toBe('invalid_range');

    const overflow = utf16RangeToCodePointRange('abc', { start: 0, end: 4 });
    expect(overflow.ok).toBe(false);

    const fractional = utf16RangeToCodePointRange('abc', { start: 0.5, end: 1 });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.code).toBe('invalid_range');
  });

  it('A5 码位区间 → UTF-16 回程', () => {
    const text = `${EMOJI}B`;
    const back = codePointRangeToUtf16Range(text, { start: 1, end: 2 });
    expect(back).toEqual({ start: 2, end: 3 });
  });

  it('A6 独立判据与 charCodeAt 判据一致（ZWJ 家庭 5 码位 / 8 码元）', () => {
    expect(points(ZWJ_FAMILY).length).toBe(5);
    // 独立复算码元数 = 2(人) + 1(ZWJ U+200D) + 2(人) + 1(ZWJ) + 2(人) = 8。
    // 注意：`src/documents/selection/types.ts` 开头的注释写作 11，与实测不符（本文件据实为 8）。
    const recomputed = 2 + 1 + 2 + 1 + 2;
    expect(ZWJ_FAMILY.length).toBe(recomputed);
    expect(recomputed).toBe(8);
    // 逐个码元下标核对"是否切开代理对"：只有落在高代理之后的那个下标才是 true。
    for (let i = 0; i <= ZWJ_FAMILY.length; i += 1) {
      const manual =
        i > 0 &&
        i < ZWJ_FAMILY.length &&
        ZWJ_FAMILY.charCodeAt(i - 1) >= 0xd800 &&
        ZWJ_FAMILY.charCodeAt(i - 1) <= 0xdbff &&
        ZWJ_FAMILY.charCodeAt(i) >= 0xdc00 &&
        ZWJ_FAMILY.charCodeAt(i) <= 0xdfff;
      expect(utf16IndexSplitsSurrogate(ZWJ_FAMILY, i)).toBe(manual);
    }
  });
});

// ===========================================================================
// §B 组合态生命周期（候选串不进文档，提交才 bump revision）
// ===========================================================================

describe('W-R04 §B 输入法组合态', () => {
  it('B1 在 emoji 之后开始组合：锚在码位 1', () => {
    const model = singleRunModel('p1', `${EMOJI}B`);
    const view = imeViewOf(model, 'p1');
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.text).toBe(`${EMOJI}B`);

    const state = beginComposition(view.value, 2); // 平台光标在 emoji 之后
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value).toEqual({ active: true, node_id: 'p1', anchor_start: 1, anchor_end: 1, pending: '' });
  });

  it('B2 候选串预览不改模型、不 bump revision，且未选 run 引用保留', () => {
    const model = singleRunModel('p1', `${EMOJI}B`);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    const begin = beginComposition(view.value, 2);
    if (!begin.ok) throw new Error('begin');
    const typed = setComposingText(view.value, begin.value, 'ni');
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;

    const beforeInlines = pInlines(model, 'p1');
    const preview = composePreviewInlines(model, typed.value);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(concatenatedRunText(preview.value)).toBe(`${EMOJI}niB`);

    // 模型与 revision 未变；原对象引用保留（不重建整段）。
    expect(model.revision).toBe(1);
    expect(pInlines(model, 'p1')).toBe(beforeInlines);
    expect(pText(model, 'p1')).toBe(`${EMOJI}B`);
  });

  it('B3 提交：落地文本、revision+1、光标 = 锚 + 提交串码位数', () => {
    const model = singleRunModel('p1', `${EMOJI}B`);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    const begin = beginComposition(view.value, 2);
    if (!begin.ok) throw new Error('begin');

    const committed = commitComposition(model, begin.value, 'ni');
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.revision).toBe(2);
    expect(committed.value.model.revision).toBe(2);
    expect(pText(committed.value.model, 'p1')).toBe(`${EMOJI}niB`);
    expect(committed.value.caret).toBe(3); // cp: 😀(1) + ni(2)
    // 提交串里含 emoji 时，光标按码位计（不是码元）。
    const committed2 = commitComposition(model, begin.value, `${EMOJI}${EMOJI}`);
    if (!committed2.ok) throw new Error('commit2');
    expect(committed2.value.caret).toBe(3); // 1 + 2 码位
  });

  it('B4 finishComposingText 丢弃候选串、文档不变', () => {
    const model = singleRunModel('p1', `${EMOJI}B`);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    const begin = beginComposition(view.value, 2);
    if (!begin.ok) throw new Error('begin');
    const typed = setComposingText(view.value, begin.value, 'pinyin');
    if (!typed.ok) throw new Error('typed');

    const done = finishComposingText(typed.value);
    expect(done.caret).toBe(1);
    expect(pText(model, 'p1')).toBe(`${EMOJI}B`);
    expect(model.revision).toBe(1);
  });

  it('B5 setCompositionRegion 严格换算：切代理对 ⇒ unsupported', () => {
    const model = singleRunModel('p1', EMOJI);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    const begin = beginComposition(view.value, 0);
    if (!begin.ok) throw new Error('begin');

    const bad = setCompositionRegion(view.value, begin.value, { start: 1, end: 2 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('unsupported');

    const good = setCompositionRegion(view.value, begin.value, { start: 0, end: 2 });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value).toMatchObject({ anchor_start: 0, anchor_end: 1 });
  });

  it('B6 组合覆盖不可编辑对象（图片）⇒ 提交被拒 unsupported', () => {
    const model = document([
      paragraph('p1', [run('r1', 'A'), drawing('dr1', '一张图'), run('r2', 'B')]),
    ]);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    // 文本 'A' + U+FFFC + 'B'，对象占位在码位 1。
    expect(points(view.value.text).length).toBe(3);

    const begin = beginComposition(view.value, 1);
    if (!begin.ok) throw new Error('begin');
    const region = setCompositionRegion(view.value, begin.value, { start: 1, end: 2 });
    if (!region.ok) throw new Error('region');

    const committed = commitComposition(model, region.value, 'X');
    expect(committed.ok).toBe(false);
    if (committed.ok) return;
    expect(committed.code).toBe('unsupported');
    // 原模型未受影响。
    expect(pText(model, 'p1')).toBe(`A￼B`);
  });
});

// ===========================================================================
// §C deleteSurroundingText：码元长度 → 码位安全删除
// ===========================================================================

describe('W-R04 §C deleteSurroundingText 码位安全', () => {
  it('C1 删 1 码元且前字是 emoji ⇒ 删掉整个 emoji，绝不产生孤立代理项', () => {
    const model = singleRunModel('p1', `x${EMOJI}`);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    const caret = view.value.text.length; // 3 码元

    const result = deleteSurroundingText(model, 'p1', { start: caret, end: caret }, 1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = pText(result.value.model, 'p1');
    expect(text).toBe('x');
    expect(hasLoneSurrogate(concatenatedRunText(pInlines(result.value.model, 'p1')))).toBe(false);
    expect(result.value.revision).toBe(2);
  });

  it('C2 对照：前字是 BMP ⇒ 恰好删 1 个字符', () => {
    const model = singleRunModel('p1', 'abc');
    const result = deleteSurroundingText(model, 'p1', { start: 3, end: 3 }, 1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pText(result.value.model, 'p1')).toBe('ab');
    expect(result.value.caret).toBe(2);
  });

  it('C3 afterLength：光标在段首删后 1 码元', () => {
    const model = singleRunModel('p1', 'abc');
    const result = deleteSurroundingText(model, 'p1', { start: 0, end: 0 }, 0, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pText(result.value.model, 'p1')).toBe('bc');
    expect(result.value.caret).toBe(0);
  });

  it('C4 删 1 码元且后字是 emoji ⇒ 删整个 emoji（不劈代理对）', () => {
    const model = singleRunModel('p1', `${EMOJI}x`);
    const result = deleteSurroundingText(model, 'p1', { start: 0, end: 0 }, 0, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pText(result.value.model, 'p1')).toBe('x');
    expect(hasLoneSurrogate(pText(result.value.model, 'p1'))).toBe(false);
  });

  it('C5 负长度 ⇒ invalid_range；空范围（段首向前删）⇒ empty_range', () => {
    const model = singleRunModel('p1', 'abc');
    const neg = deleteSurroundingText(model, 'p1', { start: 1, end: 1 }, -1, 0);
    expect(neg.ok).toBe(false);
    if (neg.ok) return;
    expect(neg.code).toBe('invalid_range');

    const empty = deleteSurroundingText(model, 'p1', { start: 0, end: 0 }, 3, 0);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe('empty_range');
  });
});

// ===========================================================================
// §D 无障碍视图、粒度移动、触摸目标
// ===========================================================================

describe('W-R04 §D 无障碍', () => {
  function viewOf(model: DocumentModel, id: string, sel = { start: 0, end: 0 }): AccessibleTextView {
    const view = accessibleViewFromModel(model, id, sel);
    if (!view.ok) throw new Error(`view: ${view.message}`);
    return view.value;
  }

  it('D1 无障碍视图携带码元选区 + 码位选区 + editable/composing', () => {
    const model = singleRunModel('p1', `${EMOJI}B`);
    const v = viewOf(model, 'p1', { start: 2, end: 3 });
    expect(v.selectionUtf16).toEqual({ start: 2, end: 3 });
    expect(v.selectionCp).toEqual({ start: 1, end: 2 });
    expect(v.editable).toBe(true);
    expect(v.composing).toBe(false);
    expect(v.revision).toBe(1);
  });

  it('D2 平台选区切代理对 ⇒ unsupported', () => {
    const model = singleRunModel('p1', EMOJI);
    const view = imeViewOf(model, 'p1');
    if (!view.ok) throw new Error('view');
    const bad = accessibleViewOf(view.value, { start: 1, end: 1 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('unsupported');
  });

  it('D3 character 前进跨 emoji 只走 1 码位（码元 +2）', () => {
    const v = viewOf(singleRunModel('p1', `${EMOJI}B`), 'p1', { start: 0, end: 0 });
    const moved = moveSelection(v, { granularity: 'character', direction: 'forward' });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.selectionCp).toEqual({ start: 1, end: 1 });
    expect(moved.value.selectionUtf16).toEqual({ start: 2, end: 2 });
  });

  it('D4 character 后退（对照前进）', () => {
    const v = viewOf(singleRunModel('p1', `${EMOJI}B`), 'p1', { start: 3, end: 3 });
    const moved = moveSelection(v, { granularity: 'character', direction: 'backward' });
    if (!moved.ok) throw new Error('move');
    expect(moved.value.selectionCp).toEqual({ start: 1, end: 1 });
    expect(moved.value.selectionUtf16).toEqual({ start: 2, end: 2 });
  });

  it('D5 word 边界：CJK 与拉丁按类别分界（前进/后退成对）', () => {
    const model = singleRunModel('p1', '你好 world');
    expect(wordBoundaries('你好 world')).toEqual([0, 2, 3, 8]);

    const v = viewOf(model, 'p1', { start: 0, end: 0 });
    const f1 = moveSelection(v, { granularity: 'word', direction: 'forward' });
    if (!f1.ok) throw new Error('f1');
    expect(f1.value.selectionCp.start).toBe(2); // 跳过 "你好"

    const v2 = viewOf(model, 'p1', f1.value.selectionUtf16);
    const f2 = moveSelection(v2, { granularity: 'word', direction: 'forward' });
    if (!f2.ok) throw new Error('f2');
    expect(f2.value.selectionCp.start).toBe(3); // 跳过空格

    const b1 = moveSelection(v2, { granularity: 'word', direction: 'backward' });
    if (!b1.ok) throw new Error('b1');
    expect(b1.value.selectionCp.start).toBe(0); // 退回边界 0
  });

  it('D6 line 用软换行作界（视觉行需 W09，本节不假装）', () => {
    const model = document([paragraph('p1', [run('r1', 'ab'), breakNode('b1'), run('r2', 'cd')])]);
    expect(lineBoundaries('ab\ncd')).toEqual([0, 3, 5]);

    const v = viewOf(model, 'p1', { start: 0, end: 0 });
    const moved = moveSelection(v, { granularity: 'line', direction: 'forward' });
    if (!moved.ok) throw new Error('move');
    expect(moved.value.selectionCp.start).toBe(3); // 第二行行首
  });

  it('D7 paragraph 档：段首/段尾', () => {
    const v = viewOf(singleRunModel('p1', 'hello'), 'p1', { start: 2, end: 2 });
    const f = moveSelection(v, { granularity: 'paragraph', direction: 'forward' });
    const b = moveSelection(v, { granularity: 'paragraph', direction: 'backward' });
    if (!f.ok || !b.ok) throw new Error('move');
    expect(f.value.selectionCp).toEqual({ start: 5, end: 5 });
    expect(b.value.selectionCp).toEqual({ start: 0, end: 0 });
  });

  it('D8 extend 保留锚点形成范围（对照不 extend 折叠）', () => {
    const v = viewOf(singleRunModel('p1', 'abc'), 'p1', { start: 1, end: 1 });
    const collapsed = moveSelection(v, { granularity: 'character', direction: 'backward' });
    if (!collapsed.ok) throw new Error('c');
    expect(collapsed.value.selectionCp).toEqual({ start: 0, end: 0 });

    const extended = moveSelection(v, { granularity: 'character', direction: 'backward', extend: true });
    if (!extended.ok) throw new Error('e');
    expect(extended.value.selectionCp).toEqual({ start: 0, end: 1 });
  });

  it('D9 setAccessibleSelection 严格换算', () => {
    const v = viewOf(singleRunModel('p1', EMOJI), 'p1', { start: 0, end: 0 });
    const bad = setAccessibleSelection(v, { start: 1, end: 2 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('unsupported');

    const good = setAccessibleSelection(v, { start: 0, end: 2 });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.selectionCp).toEqual({ start: 0, end: 1 });
  });

  it('D10 触摸目标审计：48dp 达标，47dp 报 too_small', () => {
    const ok: TouchTarget = { id: 'a', label: '确定', role: 'command', widthDp: 48, heightDp: 48 };
    const small: TouchTarget = { id: 'b', label: '图片', role: 'edit-object', widthDp: 47, heightDp: 48 };
    expect(MIN_TOUCH_TARGET_DP).toBe(48);
    expect(auditTouchTargets([ok])).toEqual([]);
    const issues = auditTouchTargets([ok, small]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: 'b', code: 'too_small', widthDp: 47 });
    expect(meetsTouchTargetMinimum(ok)).toBe(true);
    expect(meetsTouchTargetMinimum(small)).toBe(false);
  });

  it('D11 spokenText 原样返回（含对象占位符）', () => {
    const model = document([paragraph('p1', [run('r1', 'ab'), drawing('dr1', null), run('r2', 'cd')])]);
    const v = viewOf(model, 'p1', { start: 0, end: 0 });
    expect(spokenText(v)).toBe('ab￼cd');
  });
});

// ===========================================================================
// §E 编辑对象定位（hit-test, fixture 布局）
// ===========================================================================

function fixture(paragraphs: LayoutFixture['paragraphs']): LayoutFixture {
  return { verificationMode: 'fixture', note: 'W-R04 recorded line boxes（非真实排版）', paragraphs };
}

describe('W-R04 §E 编辑对象定位', () => {
  it('E1 行内左右端取整到行盒起止（码位）', () => {
    const model = singleRunModel('p1', 'Hello');
    const fx = fixture([
      { node_id: 'p1', source: 'fixture', lines: [{ start: 0, end: 5, x0Dp: 0, x1Dp: 250, topDp: 0, bottomDp: 20 }] },
    ]);

    const left = hitTest(model, fx, { xDp: 0, yDp: 10 });
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.value).toMatchObject({ kind: 'caret', node_id: 'p1', offset: 0, lineIndex: 0 });

    const right = hitTest(model, fx, { xDp: 250, yDp: 10 });
    if (!right.ok) throw new Error('right');
    expect(right.value).toMatchObject({ kind: 'caret', offset: 5 });
  });

  it('E2 emoji 行：偏移是码位下标，不是 UTF-16', () => {
    const model = singleRunModel('p1', `${EMOJI}B`); // 2 码位 / 3 码元
    const fx = fixture([
      { node_id: 'p1', source: 'fixture', lines: [{ start: 0, end: 2, x0Dp: 0, x1Dp: 100, topDp: 0, bottomDp: 20 }] },
    ]);
    const right = hitTest(model, fx, { xDp: 100, yDp: 5 });
    if (!right.ok) throw new Error('right');
    // 若误用码元，这里会是 3；正确是码位 2。
    expect(right.value).toMatchObject({ kind: 'caret', offset: 2 });
  });

  it('E3 点到图片 ⇒ 对象目标（覆盖整个占位码位，editable=false，带 alt 标签）', () => {
    const model = document([paragraph('p1', [run('r1', 'A'), drawing('dr1', '一张图'), run('r2', 'B')])]);
    const fx = fixture([
      { node_id: 'p1', source: 'fixture', lines: [{ start: 0, end: 3, x0Dp: 0, x1Dp: 90, topDp: 0, bottomDp: 20 }] },
    ]);
    // 宽 90、跨 3 码位；x=30 ⇒ fraction 1/3 ⇒ round(1) = 1（图片占位）。
    const hit = hitTest(model, fx, { xDp: 30, yDp: 5 });
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value).toMatchObject({ kind: 'object', objectKind: 'drawing', editable: false, label: '一张图' });
    if (hit.value.kind !== 'object') return;
    expect(hit.value.range).toEqual({ node_id: 'p1', start: 1, end: 2 });
  });

  it('E4 点到公式 ⇒ 对象标签固定；点到文字 ⇒ caret', () => {
    const model = document([paragraph('p1', [run('r1', 'X'), equation('eq1'), run('r2', 'Y')])]);
    const fx = fixture([
      { node_id: 'p1', source: 'fixture', lines: [{ start: 0, end: 3, x0Dp: 0, x1Dp: 90, topDp: 0, bottomDp: 20 }] },
    ]);
    const onEq = hitTest(model, fx, { xDp: 45, yDp: 5 }); // fraction 0.5 ⇒ round(1.5)=2 ⇒ 公式?
    expect(onEq.ok).toBe(true);
    if (!onEq.ok) return;
    // offset = round(0.5*3)=round(1.5)=2 ⇒ 落在 run 'Y'（码位 2）⇒ caret；对象在码位 1。
    expect(onEq.value.kind).toBe('caret');

    const onEq2 = hitTest(model, fx, { xDp: 30, yDp: 5 }); // fraction 1/3 ⇒ offset 1 ⇒ 公式占位
    if (!onEq2.ok) throw new Error('eq');
    expect(onEq2.value).toMatchObject({ kind: 'object', objectKind: 'equation', label: '(公式)', editable: false });
    if (onEq2.value.kind !== 'object') return;
    expect(onEq2.value.range).toEqual({ node_id: 'p1', start: 1, end: 2 });

    const onText = hitTest(model, fx, { xDp: 0, yDp: 5 });
    if (!onText.ok) throw new Error('text');
    expect(onText.value).toMatchObject({ kind: 'caret', offset: 0 });
  });

  it('E5 fixture 段落不在模型中 ⇒ unknown_node', () => {
    const model = singleRunModel('p1', 'abc');
    const fx = fixture([
      { node_id: 'ghost', source: 'fixture', lines: [{ start: 0, end: 3, x0Dp: 0, x1Dp: 30, topDp: 0, bottomDp: 20 }] },
    ]);
    const hit = hitTest(model, fx, { xDp: 5, yDp: 5 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('unknown_node');
  });

  it('E6 无行盒 ⇒ not_found；非有限坐标 ⇒ invalid_range', () => {
    const model = singleRunModel('p1', 'abc');
    const empty = hitTest(model, fixture([]), { xDp: 1, yDp: 1 });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe('not_found');

    const fx = fixture([
      { node_id: 'p1', source: 'fixture', lines: [{ start: 0, end: 3, x0Dp: 0, x1Dp: 30, topDp: 0, bottomDp: 20 }] },
    ]);
    const nan = hitTest(model, fx, { xDp: Number.NaN, yDp: 5 });
    expect(nan.ok).toBe(false);
    if (nan.ok) return;
    expect(nan.code).toBe('invalid_range');
  });

  it('E7 诚实边界：fixture 标 verificationMode=fixture，返回目标不含页码', () => {
    const model = singleRunModel('p1', 'abc');
    const fx = fixture([
      { node_id: 'p1', source: 'fixture', lines: [{ start: 0, end: 3, x0Dp: 0, x1Dp: 30, topDp: 0, bottomDp: 20 }] },
    ]);
    expect(fx.verificationMode).toBe('fixture');
    const hit = hitTest(model, fx, { xDp: 5, yDp: 5 });
    if (!hit.ok) throw new Error('hit');
    expect('page_number' in hit.value).toBe(false);
    expect('pageNumber' in hit.value).toBe(false);
    expect(lineIndexOfOffset(fx, 'p1', 1)).toBe(0);
    expect(lineIndexOfOffset(fx, 'p1', 99)).toBe(-1);
  });

  it('E8 无障碍焦点顺序：文本目标 + 对象目标按文档顺序', () => {
    const model = document([
      paragraph('p1', [run('r1', 'A'), drawing('dr1', '图'), equation('eq1'), run('r2', 'B')]),
    ]);
    const order = accessibilityFocusOrder(model, 'p1');
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.value.map((t) => t.kind)).toEqual(['text', 'drawing', 'equation']);
    expect(order.value.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(order.value[1]!.label).toBe('图');
    expect(order.value[2]!.label).toBe('(公式)');
    expect(order.value[0]!.editable).toBe(true);
    expect(order.value[1]!.editable).toBe(false);
  });
});

// ===========================================================================
// §F 操作/事件 schema 校验
// ===========================================================================

describe('W-R04 §F schema 校验', () => {
  const valid = {
    schemaVersion: WORD_INPUT_SCHEMA_VERSION,
    commandId: 'cmd-1',
    operation: 'word.ime.beginComposition',
    idempotencyKey: 'idem-1',
    payload: { nodeId: 'p1', caretUtf16: 2 },
  };

  it('F1 合法命令通过', () => {
    expect(validateOperation(valid)).toEqual({ ok: true, issues: [] });
  });

  it('F2 缺 commandId / 版本不符 ⇒ 逐项 issue', () => {
    const result = validateOperation({ ...valid, schemaVersion: 'wrong', commandId: '' });
    expect(result.ok).toBe(false);
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain('schemaVersion');
    expect(paths).toContain('commandId');
  });

  it('F3 未知操作名 ⇒ 立即返回 issue（不继续校验 payload）', () => {
    const result = validateOperation({ ...valid, operation: 'word.bogus' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.path)).toContain('operation');
  });

  it('F4 payload 字段类型错 / 缺字段 ⇒ issue', () => {
    const wrongType = validateOperation({ ...valid, payload: { nodeId: 'p1', caretUtf16: 'two' } });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.issues.map((i) => i.path)).toContain('payload.caretUtf16');

    const missing = validateOperation({ ...valid, payload: { nodeId: 'p1' } });
    expect(missing.ok).toBe(false);
    expect(missing.issues.map((i) => i.path)).toContain('payload.caretUtf16');
  });

  it('F5 非负整数约束：负偏移被拒', () => {
    const result = validateOperation({ ...valid, payload: { nodeId: 'p1', caretUtf16: -1 } });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.path)).toContain('payload.caretUtf16');
  });

  it('F6 操作名覆盖十个已声明操作', () => {
    expect(OPERATION_NAMES).toHaveLength(10);
    for (const name of OPERATION_NAMES) {
      const envelope = { ...valid, operation: name, payload: buildPayload(name) };
      const result = validateOperation(envelope);
      expect(result.ok, `${name}: ${JSON.stringify(result.issues)}`).toBe(true);
    }
  });

  it('F7 事件校验：failed 必带 error，ok 不得带 error', () => {
    const base = { eventId: 'e1', seq: 0, commandId: 'cmd-1', revision: 2, status: 'ok' };
    expect(validateEvent(base).ok).toBe(true);

    const okWithError = validateEvent({ ...base, error: { code: 'x', message: 'y' } });
    expect(okWithError.ok).toBe(false);
    expect(okWithError.issues.map((i) => i.path)).toContain('error');

    const failedNoError = validateEvent({ ...base, status: 'failed' });
    expect(failedNoError.ok).toBe(false);
    expect(failedNoError.issues.map((i) => i.path)).toContain('error');
  });
});

function buildPayload(name: string): Record<string, unknown> {
  switch (name) {
    case 'word.ime.beginComposition':
      return { nodeId: 'p1', caretUtf16: 0 };
    case 'word.ime.setComposingText':
      return { nodeId: 'p1', text: 'x' };
    case 'word.ime.setCompositionRegion':
      return { nodeId: 'p1', startUtf16: 0, endUtf16: 1 };
    case 'word.ime.commitText':
      return { nodeId: 'p1', text: 'x' };
    case 'word.ime.finishComposingText':
      return { nodeId: 'p1' };
    case 'word.ime.deleteSurroundingText':
      return { nodeId: 'p1', beforeLength: 1, afterLength: 0 };
    case 'word.selection.set':
      return { nodeId: 'p1', startUtf16: 0, endUtf16: 2 };
    case 'word.a11y.moveSelection':
      return { nodeId: 'p1', granularity: 'word', direction: 'forward', extend: false };
    case 'word.a11y.setSelection':
      return { nodeId: 'p1', startUtf16: 0, endUtf16: 1 };
    case 'word.target.hitTest':
      return { nodeId: 'p1', xDp: 10, yDp: 20 };
    default:
      return {};
  }
}
