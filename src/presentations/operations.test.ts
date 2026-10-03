/**
 * 演示域**操作层**用例（design-06 P9）。
 *
 * 重点：
 * - PPT-01「页数由任务决定，不能固定两页」——页数随操作增减，**没有**写死的页数；
 * - PPT-05「尺寸 / 坐标 / 旋转 / 对齐 / 分布 / 层级 / 组合」；
 * - 全部操作**不可变**：改一处不污染原模型（PPT-03 / PPT-14「失败保旧」的基础）。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation, type Shape, type TableCell, type TextBody } from './model.js';
import {
  PresentationOperationError,
  addShape,
  addSlide,
  alignShapes,
  clearAnimations,
  distributeShapes,
  duplicateSlide,
  findInPresentation,
  groupShapes,
  moveShape,
  moveSlide,
  nextAvailableShapeId,
  removeShape,
  removeSlide,
  reorderShape,
  rotateShape,
  replaceInPresentation,
  replaceInShape,
  replaceTextSelection,
  setParagraphAlignment,
  setShapeText,
  setSlideNotes,
  ungroupShapes,
} from './operations.js';
import { emptyPresentation } from './render.js';

function box(id: number, x: number, y: number, w = 1000, h = 500): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(x, y, w, h),
    text: literalText(`t${String(id)}`),
  };
}

function deckWithSlides(count: number): Presentation {
  let deck = emptyPresentation('p1', '测试文稿');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

describe('PPT-01：页数由任务决定（不是固定两页）', () => {
  it('空文稿 0 页；连加 7 页 ⇒ 恰好 7 页且 id 递增', () => {
    const empty = emptyPresentation('p1', '测试文稿');
    expect(empty.slides).toHaveLength(0);

    const deck = deckWithSlides(7);
    expect(deck.slides).toHaveLength(7);
    expect(deck.slides.map((slide) => slide.slide_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('页数可变：1 / 2 / 3 / 9 页都是同一个模型类型，模型层没有页数上限常量', () => {
    for (const count of [1, 2, 3, 9]) {
      expect(deckWithSlides(count).slides).toHaveLength(count);
    }
  });

  it('删页与移动改变页序，页数随之变化', () => {
    let deck = deckWithSlides(3);
    deck = removeSlide(deck, 2);
    expect(deck.slides.map((slide) => slide.slide_id)).toEqual([1, 3]);

    deck = moveSlide(deck, 3, 0);
    expect(deck.slides.map((slide) => slide.slide_id)).toEqual([3, 1]);
  });

  it('复制一页 ⇒ 页数 +1，副本是新 id 且带同样内容', () => {
    const deck = deckWithSlides(2);
    const result = duplicateSlide(deck, 1);
    expect(result.presentation.slides).toHaveLength(3);
    expect(result.slide_id).toBe(3);
    expect(result.presentation.slides[1]?.slide_id).toBe(3);
  });

  it('在指定位置插入页', () => {
    const deck = deckWithSlides(2);
    const inserted = addSlide(deck, { at: 1 });
    expect(inserted.presentation.slides.map((slide) => slide.slide_id)).toEqual([1, 3, 2]);
  });

  it('删除不存在的页 ⇒ 报错（不静默）', () => {
    expect(() => removeSlide(deckWithSlides(1), 99)).toThrow(PresentationOperationError);
  });
});

describe('PPT-05：对象几何、层级、对齐、分布、组合', () => {
  it('平移与旋转只改目标对象，且角度归一化到 [0,360)', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 100, 200));
    deck = addShape(deck, 1, box(3, 300, 400));
    deck = moveShape(deck, 1, 2, 50, 60);
    deck = rotateShape(deck, 1, 2, 405);

    const shapes = deck.slides[0]?.shapes ?? [];
    expect(shapes[0]?.transform.x_emu).toBe(150);
    expect(shapes[0]?.transform.y_emu).toBe(260);
    expect(shapes[0]?.transform.rotation_deg).toBe(45);
    // 另一个对象纹丝不动。
    expect(shapes[1]?.transform.x_emu).toBe(300);
    expect(shapes[1]?.transform.rotation_deg).toBe(0);
  });

  it('前后层级：数组顺序即 z 序', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 0, 0));
    deck = addShape(deck, 1, box(3, 0, 0));
    deck = addShape(deck, 1, box(4, 0, 0));

    const toFront = reorderShape(deck, 1, 2, 'front');
    expect(toFront.slides[0]?.shapes.map((shape) => shape.shape_id)).toEqual([3, 4, 2]);

    const toBack = reorderShape(deck, 1, 4, 'back');
    expect(toBack.slides[0]?.shapes.map((shape) => shape.shape_id)).toEqual([4, 2, 3]);
  });

  it('左对齐把多个对象对齐到最左边缘', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 100, 0, 1000, 500));
    deck = addShape(deck, 1, box(3, 500, 100, 1000, 500));
    deck = alignShapes(deck, 1, [2, 3], 'left');
    expect(deck.slides[0]?.shapes.map((shape) => shape.transform.x_emu)).toEqual([100, 100]);
  });

  it('水平分布至少需要 3 个对象，否则报错', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 0, 0));
    deck = addShape(deck, 1, box(3, 100, 0));
    expect(() => distributeShapes(deck, 1, [2, 3], 'horizontal')).toThrow(PresentationOperationError);
  });

  it('组合 / 取消组合可逆（子对象回到页面）', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 100, 100));
    deck = addShape(deck, 1, box(3, 300, 200));
    deck = groupShapes(deck, 1, [2, 3], { shape_id: 9 });

    const grouped = deck.slides[0]?.shapes ?? [];
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.kind).toBe('group');
    expect(grouped[0]?.transform).toMatchObject({ x_emu: 100, y_emu: 100, cx_emu: 1200, cy_emu: 600 });

    const ungrouped = ungroupShapes(deck, 1, 9);
    expect(ungrouped.slides[0]?.shapes.map((shape) => shape.shape_id)).toEqual([2, 3]);
  });

  it('对非组合调用取消组合 ⇒ 报错', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 0, 0));
    expect(() => ungroupShapes(deck, 1, 2)).toThrow(PresentationOperationError);
  });

  it('删除对象与自动分配下一个 shape_id', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, box(2, 0, 0));
    deck = addShape(deck, 1, box(3, 0, 0));
    expect(nextAvailableShapeId(deck, 1)).toBe(4);
    deck = removeShape(deck, 1, 2);
    expect(deck.slides[0]?.shapes.map((shape) => shape.shape_id)).toEqual([3]);
  });
});

describe('PPT-04：精确选区只改选中部分', () => {
  function bodyDeck(): Presentation {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, {
      kind: 'text_box',
      shape_id: 2,
      name: 'Body',
      transform: transform(0, 0, 1000, 500),
      text: {
        paragraphs: [
          {
            runs: [
              { source: { kind: 'literal', text: 'ABC-DEF-GHI' }, style: { size_pt: 18, bold: true } },
              { source: { kind: 'literal', text: '尾巴' } },
            ],
            level: 0,
            alignment: 'left',
            bullet: false,
          },
          { runs: [{ source: { kind: 'literal', text: '第二段' } }], level: 1, alignment: 'left', bullet: true },
        ],
      },
    });
    return deck;
  }

  it('替换 [4,7) ⇒ 前缀后缀在，同段另一个 run 与第二段引用相等', () => {
    const deck = bodyDeck();
    const edited = replaceTextSelection(deck, { slide_id: 1, shape_id: 2, paragraph_index: 0, run_index: 0 }, 4, 7, 'XYZ');
    const before = deck.slides[0]?.shapes[0];
    const after = edited.slides[0]?.shapes[0];
    if (before?.kind !== 'text_box' || after?.kind !== 'text_box') throw new Error('应当是文本框');

    expect(after.text.paragraphs[0]?.runs[0]?.source).toEqual({ kind: 'literal', text: 'ABC-XYZ-GHI' });
    expect(after.text.paragraphs[0]?.runs[0]?.style).toBe(before.text.paragraphs[0]?.runs[0]?.style);
    expect(after.text.paragraphs[0]?.runs[1]).toBe(before.text.paragraphs[0]?.runs[1]);
    expect(after.text.paragraphs[1]).toBe(before.text.paragraphs[1]);
    expect(edited.slides[0]?.shapes).toHaveLength(1);
  });

  it('空选区（start===end）等价于纯插入；选区越界 ⇒ 报错', () => {
    const deck = bodyDeck();
    const inserted = replaceTextSelection(deck, { slide_id: 1, shape_id: 2, paragraph_index: 0, run_index: 0 }, 3, 3, '+');
    const after = inserted.slides[0]?.shapes[0];
    if (after?.kind !== 'text_box') throw new Error('应当是文本框');
    expect(after.text.paragraphs[0]?.runs[0]?.source).toEqual({ kind: 'literal', text: 'ABC+-DEF-GHI' });

    expect(() =>
      replaceTextSelection(deck, { slide_id: 1, shape_id: 2, paragraph_index: 0, run_index: 0 }, 99, 100, 'x'),
    ).toThrow(PresentationOperationError);
  });

  it('改段落对齐只动该段，run 与其余段落引用相等', () => {
    const deck = bodyDeck();
    const edited = setParagraphAlignment(deck, { slide_id: 1, shape_id: 2, paragraph_index: 0 }, 'center');
    const before = deck.slides[0]?.shapes[0];
    const after = edited.slides[0]?.shapes[0];
    if (before?.kind !== 'text_box' || after?.kind !== 'text_box') throw new Error('应当是文本框');
    expect(after.text.paragraphs[0]?.alignment).toBe('center');
    expect(after.text.paragraphs[0]?.runs).toBe(before.text.paragraphs[0]?.runs);
    expect(after.text.paragraphs[1]).toBe(before.text.paragraphs[1]);
  });
});

describe('操作层不可变（原模型不被污染）', () => {
  it('改文本 / 加形状 / 加动画都不修改入参', () => {
    const base = deckWithSlides(1);
    const withShape = addShape(base, 1, box(2, 0, 0));
    const withText = setShapeText(withShape, 1, 2, literalText('改过的文本'));
    const withAnim = clearAnimations(withText, 1);

    expect(base.slides[0]?.shapes).toHaveLength(0);
    expect(withShape.slides[0]?.shapes).toHaveLength(1);
    expect(withShape.slides[0]?.shapes[0]).toMatchObject({ kind: 'text_box' });
    expect(withAnim).not.toBe(withText);
    expect(withText.slides[0]?.shapes[0]?.kind === 'text_box').toBe(true);
  });

  it('同一形状 id 重复插入 ⇒ 报错（对象引用必须唯一）', () => {
    const deck = addShape(deckWithSlides(1), 1, box(2, 0, 0));
    expect(() => addShape(deck, 1, box(2, 10, 10))).toThrow(PresentationOperationError);
  });
});

// ---------------------------------------------------------------------------
// P-I10：查找 / 替换递归进表格单元格与演讲备注
// ---------------------------------------------------------------------------

function literalCell(text: string): TableCell {
  return {
    text: { paragraphs: [{ runs: [{ source: { kind: 'literal', text } }], level: 0, alignment: 'left', bullet: false }] },
    col_span: 1,
    row_span: 1,
  };
}

function joinRuns(body: TextBody): string {
  return body.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : '（fact）')).join(''),
    )
    .join('\n');
}

function tableOf(presentation: Presentation, shapeId: number): Extract<Shape, { kind: 'table' }> {
  const shape = presentation.slides[0]?.shapes.find((candidate) => candidate.shape_id === shapeId);
  if (shape?.kind !== 'table') throw new Error('应当是表格');
  return shape;
}

function notesOf(presentation: Presentation): TextBody {
  const notes = presentation.slides[0]?.notes;
  if (notes === null || notes === undefined) throw new Error('应当有备注');
  return notes;
}

/** 一页：正文文本框（shape 2）+ 2×2 表格（shape 3，两个格含 'foo'）+ 两段备注（第二段含 'foo'）。 */
function deckWithTableAndNotes(): Presentation {
  let deck = deckWithSlides(1);
  deck = addShape(deck, 1, {
    kind: 'text_box',
    shape_id: 2,
    name: 'Body',
    transform: transform(0, 0, 1000, 500),
    text: literalText('正文 foo'),
  });
  deck = addShape(deck, 1, {
    kind: 'table',
    shape_id: 3,
    name: 'T',
    transform: transform(0, 2000, 3000, 1000),
    rows: [
      { cells: [literalCell('表内 foo'), literalCell('保持')] },
      { cells: [literalCell('不动'), literalCell('foo 结尾')] },
    ],
    column_widths_emu: [1000000, 1000000],
  });
  return setSlideNotes(deck, 1, {
    paragraphs: [
      { runs: [{ source: { kind: 'literal', text: '备注第一行' } }], level: 0, alignment: 'left', bullet: false },
      { runs: [{ source: { kind: 'literal', text: '备注 foo' } }], level: 0, alignment: 'left', bullet: false },
    ],
  });
}

/** 一页：1×1 表格（shape 2），其唯一单元格含一段带事实引用 run 的文本。 */
function deckWithFactCell(): Presentation {
  const deck = deckWithSlides(1);
  return addShape(deck, 1, {
    kind: 'table',
    shape_id: 2,
    name: 'FT',
    transform: transform(0, 0, 1000, 1000),
    rows: [
      {
        cells: [
          {
            text: {
              paragraphs: [
                {
                  runs: [
                    { source: { kind: 'literal', text: 'ab' } },
                    { source: { kind: 'fact', fact_key: 'k' } },
                  ],
                  level: 0,
                  alignment: 'left',
                  bullet: false,
                },
              ],
            },
            col_span: 1,
            row_span: 1,
          },
        ],
      },
    ],
    column_widths_emu: [1000000],
  });
}

describe('P-I10：查找 / 替换递归进表格单元格与演讲备注', () => {
  it('findInPresentation 命中带位置：正文形状 / 表格单元格（带行列）/ 备注（shape_id=null）', () => {
    const matches = findInPresentation(deckWithTableAndNotes(), 'foo');
    expect(matches).toHaveLength(4);
    expect(matches.map((match) => match.location)).toEqual([
      { kind: 'shape' },
      { kind: 'table_cell', row_index: 0, column_index: 0 },
      { kind: 'table_cell', row_index: 1, column_index: 1 },
      { kind: 'notes' },
    ]);
    expect(matches.map((match) => match.shape_id)).toEqual([2, 3, 3, null]);
    expect(matches.map((match) => match.text)).toEqual(['foo', 'foo', 'foo', 'foo']);
  });

  it('replaceInPresentation 落在表格单元格与备注；未命中的格 / 行 / 备注段引用相等', () => {
    const deck = deckWithTableAndNotes();
    const before = tableOf(deck, 3);
    const result = replaceInPresentation(deck, 'foo', 'BAR');
    expect(result.replaced).toBe(4);

    const table = tableOf(result.presentation, 3);
    expect(joinRuns(table.rows[0]?.cells[0]?.text as TextBody)).toBe('表内 BAR');
    expect(joinRuns(table.rows[1]?.cells[1]?.text as TextBody)).toBe('BAR 结尾');
    // 未命中的格与整行对象引用不变。
    expect(table.rows[0]?.cells[1]).toBe(before.rows[0]?.cells[1]);
    expect(table.rows[1]?.cells[0]).toBe(before.rows[1]?.cells[0]);
    expect(table.rows[0]?.cells[1]?.text).toBe(before.rows[0]?.cells[1]?.text);

    // 备注第一段未命中 ⇒ 引用相等；第二段被改。
    const notes = notesOf(result.presentation);
    expect(joinRuns(notes)).toBe('备注第一行\n备注 BAR');
    expect(notes.paragraphs[0]).toBe(deck.slides[0]?.notes?.paragraphs[0]);
  });

  it('replaceInShape 只改表格：正文文本框与备注引用相等', () => {
    const deck = deckWithTableAndNotes();
    const result = replaceInShape(deck, { slide_id: 1, shape_id: 3 }, 'foo', 'X');
    expect(result.replaced).toBe(2);
    expect(result.presentation.slides[0]?.shapes[0]).toBe(deck.slides[0]?.shapes[0]);
    expect(result.presentation.slides[0]?.notes).toBe(deck.slides[0]?.notes);
    expect(joinRuns(tableOf(result.presentation, 3).rows[0]?.cells[0]?.text as TextBody)).toBe('表内 X');
  });

  it('含事实引用 run 的单元格：替换具名报 paragraph_has_fact_run，模型不变', () => {
    const deck = deckWithFactCell();
    expect(() => replaceInPresentation(deck, 'ab', 'X')).toThrow(PresentationOperationError);
    try {
      replaceInPresentation(deck, 'ab', 'X');
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationOperationError);
      expect((error as PresentationOperationError).reason).toBe('paragraph_has_fact_run');
    }
    // 失败保旧：原表模型一格一段两 run，原样未动。
    const table = tableOf(deck, 2);
    expect(table.rows[0]?.cells[0]?.text?.paragraphs[0]?.runs).toHaveLength(2);
    // 只读查找对事实段返回零命中（不猜位置、不抛错）。
    expect(findInPresentation(deck, 'ab')).toEqual([]);
  });

  it('零命中正则替换返回同一文稿对象（失败保旧）；畸形正则在文稿层具名报 invalid_pattern', () => {
    const deck = deckWithTableAndNotes();
    const none = replaceInPresentation(deck, 'zzz-\\d+', 'X', { mode: 'regex' });
    expect(none.replaced).toBe(0);
    expect(none.presentation).toBe(deck);

    try {
      replaceInPresentation(deck, '(', 'X', { mode: 'regex' });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationOperationError);
      expect((error as PresentationOperationError).reason).toBe('invalid_pattern');
    }
    // 报错后原文稿未被改动。
    expect(joinRuns(deck.slides[0]?.notes as TextBody)).toBe('备注第一行\n备注 foo');
  });

  it('通配符模式在表格与备注里同样生效', () => {
    const result = replaceInPresentation(deckWithTableAndNotes(), 'f?o', 'W', { mode: 'wildcard' });
    expect(result.replaced).toBe(4);
    expect(joinRuns(tableOf(result.presentation, 3).rows[1]?.cells[1]?.text as TextBody)).toBe('W 结尾');
    expect(joinRuns(notesOf(result.presentation))).toBe('备注第一行\n备注 W');
  });
});
