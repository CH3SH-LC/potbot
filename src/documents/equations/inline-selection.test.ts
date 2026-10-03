/**
 * **公式行内投影契约**的判据（design-05-P9 的缺口；合同 R102/R104/R105/R140）。
 *
 * ## 本文件在证明什么、**不**在证明什么
 *
 * 冻结骨架的 `InlineNode` 还没有 `equation` 分支（扩展方案见
 * `.task-manifest/outputs/FA-D/inline-equation-plan.md`），因此这里**不能**构造一个
 * 真的 `EquationNode` 丢进 `inlines` 去跑 `buildInlineTextMap`——那样测的是不存在的代码。
 *
 * 本文件证明的是**扩展之后必须成立的语义**，分两层：
 *
 * 1. **投影契约本身**（纯函数）：宽度恒为 1、占位符是 U+FFFC、可编辑性来自 `EquationContent`；
 * 2. **语义等价**：这条契约与既有 `DrawingNode`（同一类"占 1 码位、不可编辑、可整体选中"的
 *    行内对象）在偏移空间里的行为**逐项一致**——用既有的 `splitInlinesAtRange` 演示，
 *    证明"公式一旦接上，选区行为就已经是定下来的"，而不是留给扩展时临时拍脑袋。
 *
 * 一个**如实登记**的边界：第 2 层用 `drawing` 作等价物，不是公式本体。
 * 公式分支落地后，本文件应补一条"真的构造 `EquationNode` 并走 `buildInlineTextMap`"的用例，
 * 那一条在此之前**不可写**（会测空）。
 */

import { describe, expect, it } from 'vitest';

import type { DrawingNode, InlineNode } from '../model/types.js';
import { splitInlinesAtRange } from '../selection/inline-map.js';
import { paragraph, run } from '../selection/testing.js';
import {
  EQUATION_INLINE_CONTRACT,
  EQUATION_INLINE_LENGTH,
  EQUATION_PLACEHOLDER,
  EQUATION_SEGMENT_KIND,
  documentRangeForInline,
  documentRangeForInlineId,
  equationInlineLength,
  equationIsEditable,
  equationTextProjection,
} from './inline-selection.js';
import { fraction, mathRun, superscript } from './build.js';
import type { EquationContent } from './types.js';

const EDITABLE: EquationContent = { kind: 'editable', equation: superscript(mathRun('x'), mathRun('2')) };
const PRESERVED: EquationContent = { kind: 'preserved', reason: '矩阵未建模', omml: { omml: 'm:oMath' } };

/** 一个"占 1 码位、不可编辑"的行内对象（公式分支落地前的等价物）。 */
function drawingInline(id: string): DrawingNode {
  return {
    kind: 'drawing',
    id,
    source: 'imported',
    opaque: [],
    drawing_type: 'picture',
    relationship_id: 'rId9',
    extent: null,
    rotation_deg: 0,
    wrap: null,
    alt_text: null,
  };
}

describe('公式的文本投影契约', () => {
  it('可编辑与保留两种内容的投影**宽度相同**（恒为 1 个 U+FFFC）', () => {
    expect(equationTextProjection(EDITABLE)).toBe(EQUATION_PLACEHOLDER);
    expect(equationTextProjection(PRESERVED)).toBe(EQUATION_PLACEHOLDER);
    expect(EQUATION_PLACEHOLDER).toBe('￼');
    expect(equationInlineLength(EDITABLE)).toBe(1);
    expect(equationInlineLength(PRESERVED)).toBe(1);
    expect(EQUATION_INLINE_LENGTH).toBe(1);
  });

  it('可编辑性只来自 `EquationContent` 的分支，不改变宽度', () => {
    expect(equationIsEditable(EDITABLE)).toBe(true);
    expect(equationIsEditable(PRESERVED)).toBe(false);
    // 复杂公式（分式）也能被"选中"——宽度与结构复杂度无关。
    const complex: EquationContent = { kind: 'editable', equation: fraction(mathRun('a'), mathRun('b')) };
    expect(equationInlineLength(complex)).toBe(1);
  });

  it('单一声明处的契约是冻结的、且 editable 恒为 false（公式整体可选中、光标不进内部）', () => {
    expect(Object.isFrozen(EQUATION_INLINE_CONTRACT)).toBe(true);
    expect(EQUATION_INLINE_CONTRACT).toEqual({
      kind: 'equation',
      inlineLength: 1,
      editable: false,
      placeholder: '￼',
    });
    expect(EQUATION_SEGMENT_KIND).toBe('equation');
  });
});

describe('语义等价：与"占 1 码位、不可编辑"的既有行内对象行为一致', () => {
  const inlines: readonly InlineNode[] = [
    run('r1', 'ab'),
    drawingInline('d1'),
    run('r3', 'cd'),
  ];
  const para = paragraph('p1', inlines);

  it('`documentRangeForInline` 给出行内对象的**精确**码位区间（今天就能用，落地后无需改）', () => {
    expect(documentRangeForInline(para, 0)).toEqual({ node_id: 'p1', start: 0, end: 2 });
    expect(documentRangeForInline(para, 1)).toEqual({ node_id: 'p1', start: 2, end: 3 });
    expect(documentRangeForInline(para, 2)).toEqual({ node_id: 'p1', start: 3, end: 5 });
    // 越界 ⇒ `null`（不猜、不返回空范围）。
    expect(documentRangeForInline(para, 3)).toBeNull();
  });

  it('按 id 定位同样成立；未知 id ⇒ `null`', () => {
    expect(documentRangeForInlineId(para, 'd1')).toEqual({ node_id: 'p1', start: 2, end: 3 });
    expect(documentRangeForInlineId(para, 'nope')).toBeNull();
  });

  it('该区间可被**完整**选中（`containedNonEditable`）——"选中这个公式"的语义就是它', () => {
    const range = documentRangeForInline(para, 1);
    if (range === null) throw new Error('区间应当存在');
    const split = splitInlinesAtRange(inlines, range.start, range.end);
    expect(split.ok).toBe(true);
    if (!split.ok) throw new Error(split.message);
    expect(split.value.containedNonEditable).toBe(true);
    expect(split.value.selected).toEqual([drawingInline('d1')]);
    // 不变式：三段拼回去**逐字等于**原文（切分不改字）。
    expect(split.value.before.map((n) => (n.kind === 'run' ? n.text : '')).join('')).toBe('ab');
    expect(split.value.after.map((n) => (n.kind === 'run' ? n.text : '')).join('')).toBe('cd');
  });

  it('1 码位宽 ⇒ "部分覆盖"在整数偏移下不可能发生（不会出现"把公式切一半"）', () => {
    // 该行内对象只占偏移 2，任何整数区间 [s,e) 要么完全包含它、要么完全不含。
    const fully = splitInlinesAtRange(inlines, 2, 3);
    expect(fully.ok && fully.value.containedNonEditable).toBe(true);
    // 结束在它左边：完全不进 selected。
    const left = splitInlinesAtRange(inlines, 0, 2);
    expect(left.ok && left.value.containedNonEditable).toBe(false);
    // 起始在它右边：同样不进。
    const right = splitInlinesAtRange(inlines, 3, 5);
    expect(right.ok && right.value.containedNonEditable).toBe(false);
  });
});
