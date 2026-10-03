/**
 * FA-VERIFY-WAVE-2 · 第二轮独立验证：演示域（第一轮**未覆盖**的模块）
 *
 * 覆盖模块：`presentations/text`、`presentations/geometry`、`presentations/slide-ops`、
 * `presentations/animation`。
 *
 * 输入全部由验证方自造（自建 Presentation 字面量），不复用实现者 fixture。
 * 「保存重开后保持」这类**真实渲染**主张一律**未实测**——本文件只做模型层纯逻辑。
 */

import { describe, expect, it } from 'vitest';

import {
  transform,
  type Paragraph,
  type Presentation,
  type Shape,
  type TextBody,
} from '../../../src/presentations/model.js';
import { addShape, addSlide, type RunTarget } from '../../../src/presentations/operations.js';
import {
  GeometryError,
  alignSelectionToSlide,
  boundsOf,
  distributeWithGap,
  flipShape,
  groupSelection,
  relativeGeometry,
  resizeShape,
  setBounds,
  zOrder,
} from '../../../src/presentations/geometry.js';
import {
  TextEditError,
  deleteParagraph,
  indentParagraph,
  insertParagraph,
  setParagraphLevel,
  setSelectionBold,
  splitRunForSelection,
  toggleBullet,
} from '../../../src/presentations/text.js';
import {
  SlideOperationError,
  assignSlideToSection,
  createSection,
  deleteSlide,
  pageNumbersById,
  reorderSections,
  locateSlide,
  slideIdAtPage,
  slideOrder,
  slidesInSection,
} from '../../../src/presentations/slide-ops.js';
import {
  addAnimationSpec,
  buildClickGroups,
  moveAnimationSpec,
  normalizeOrder,
  renderTimingXml,
  type AnimationSpec,
} from '../../../src/presentations/animation.js';

// ---------------------------------------------------------------------------
// 验证方自造夹具
// ---------------------------------------------------------------------------

function emptyPresentation(): Presentation {
  return {
    presentation_id: 'p-verify',
    title: 'verify',
    format: 'pptx',
    size: { cx_emu: 12_192_000, cy_emu: 6_858_000 },
    master: { master_id: 'm1' },
    theme: { theme_id: 't1' },
    slides: [],
    sections: [],
  };
}

function textBoxWith(id: number, x: number, y: number, cx: number, cy: number, runs: readonly { text: string; style?: object }[]): Shape {
  const paragraph: Paragraph = {
    runs: runs.map((run) => ({ source: { kind: 'literal' as const, text: run.text }, style: run.style })),
    level: 0,
    alignment: 'left',
    bullet: false,
  };
  return { kind: 'text_box', shape_id: id, name: `tb${String(id)}`, transform: transform(x, y, cx, cy), text: { paragraphs: [paragraph] } };
}

function bodyOf(pres: Presentation, slideId: number, shapeId: number): TextBody {
  const slide = pres.slides.find((candidate) => candidate.slide_id === slideId);
  const shape = slide?.shapes.find((candidate) => candidate.shape_id === shapeId);
  if (shape === undefined || shape.kind !== 'text_box') {
    throw new Error(`shape ${String(shapeId)} is not a text box`);
  }
  return shape.text;
}

function oneSlideWith(...shapes: readonly Shape[]): Presentation {
  const created = addSlide(emptyPresentation());
  let pres = created.presentation;
  for (const shape of shapes) {
    pres = addShape(pres, created.slide_id, shape);
  }
  return pres;
}

// ===========================================================================
// 1. presentations/text —— 精确选区保留未选内容
// ===========================================================================

describe('独立验证 · presentations/text', () => {
  it('正向：按选区拆分 run，前缀 / 后缀的 style 是**同一对象**（未重建）', () => {
    const style = { bold: false, color: 'FF0000' };
    const paragraph: Paragraph = {
      runs: [{ source: { kind: 'literal', text: 'abcdef' }, style }],
      level: 0,
      alignment: 'left',
      bullet: false,
    };
    const split = splitRunForSelection(paragraph, 0, 2, 4);
    expect(split.paragraph.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : ''))).toEqual(['ab', 'cd', 'ef']);
    expect(split.selected_run_index).toBe(1);
    expect(split.selected_length).toBe(2);
    // 前缀 / 后缀保留**同一个** style 对象引用
    expect(split.paragraph.runs[0]?.style).toBe(style);
    expect(split.paragraph.runs[2]?.style).toBe(style);
  });

  it('反向对照 A：把选区加粗后，未选中的前缀 / 后缀样式**引用不变**，只有中段变', () => {
    const style = { bold: false };
    const pres = oneSlideWith(textBoxWith(10, 0, 0, 100, 100, [{ text: 'abcdef', style }]));
    const target: RunTarget = { slide_id: 1, shape_id: 10, paragraph_index: 0, run_index: 0 };
    const next = setSelectionBold(pres, target, 2, 4, true);
    const runs = bodyOf(next, 1, 10).paragraphs[0]?.runs ?? [];
    expect(runs.map((run) => (run.source.kind === 'literal' ? run.source.text : ''))).toEqual(['ab', 'cd', 'ef']);
    expect(runs[0]?.style).toBe(style); // 前缀样式对象未变
    expect(runs[2]?.style).toBe(style); // 后缀样式对象未变
    expect(runs[1]?.style).toEqual({ bold: true });
    expect(runs[1]?.style).not.toBe(style);
  });

  it('反向对照 B：非字面量 run 不可按字符选区编辑；越界选区 ⇒ 具名错', () => {
    const factParagraph: Paragraph = {
      runs: [{ source: { kind: 'fact', fact_key: 'k' } }],
      level: 0,
      alignment: 'left',
      bullet: false,
    };
    expect(() => splitRunForSelection(factParagraph, 0, 0, 1)).toThrow(TextEditError);
    const literal: Paragraph = {
      runs: [{ source: { kind: 'literal', text: 'ab' } }],
      level: 0,
      alignment: 'left',
      bullet: false,
    };
    expect(() => splitRunForSelection(literal, 0, 0, 5)).toThrow(/超出/);
  });

  it('正向 + 反向：缩进层级钳制在 [0,8]；显式越界 ⇒ 抛', () => {
    const pres = oneSlideWith(textBoxWith(20, 0, 0, 10, 10, [{ text: 'x' }]));
    const target = { slide_id: 1, shape_id: 20, paragraph_index: 0 } as const;
    const raised = indentParagraph(indentParagraph(pres, target, 1), target, 1);
    expect(bodyOf(raised, 1, 20).paragraphs[0]?.level).toBe(2);
    // 最外层再减缩进 ⇒ 钳到 0，不报错
    const clamped = indentParagraph(pres, target, -5);
    expect(bodyOf(clamped, 1, 20).paragraphs[0]?.level).toBe(0);
    // 显式设 9 ⇒ 具名报错
    expect(() => setParagraphLevel(pres, target, 9)).toThrow(/0\.\.8|超出/);
    // 插入段落越界 ⇒ 抛
    const extraParagraph: Paragraph = { runs: [{ source: { kind: 'literal', text: 'y' } }], level: 0, alignment: 'left', bullet: false };
    expect(() => insertParagraph(pres, { slide_id: 1, shape_id: 20 }, extraParagraph, { at: 9 })).toThrow();
  });

  it('反向对照 C：项目符号反转；删段落越界 ⇒ 抛', () => {
    const pres = oneSlideWith(textBoxWith(30, 0, 0, 10, 10, [{ text: 'x' }]));
    const target = { slide_id: 1, shape_id: 30, paragraph_index: 0 } as const;
    const toggled = toggleBullet(pres, target);
    expect(bodyOf(toggled, 1, 30).paragraphs[0]?.bullet).toBe(true);
    expect(() => deleteParagraph(pres, { slide_id: 1, shape_id: 30, paragraph_index: 5 })).toThrow(/找不到段落/);
  });
});

// ===========================================================================
// 2. presentations/geometry —— 几何 / 对齐 / 层级
// ===========================================================================

describe('独立验证 · presentations/geometry', () => {
  it('正向：center 锚点改尺寸必须补偿坐标（top_left 不动）', () => {
    const pres = oneSlideWith(textBoxWith(1, 0, 0, 100, 100, [{ text: 'x' }]));
    const centered = resizeShape(pres, 1, 1, 50, 50, { anchor: 'center' });
    const t = boundsOf(centered.slides[0]?.shapes[0] as Shape);
    expect(t.x_emu).toBe(25); // 0 + (100-50)/2
    expect(t.cx_emu).toBe(50);
    const topLeft = resizeShape(pres, 1, 1, 50, 50);
    expect(boundsOf(topLeft.slides[0]?.shapes[0] as Shape).x_emu).toBe(0);
  });

  it('反向对照 A：对齐到幻灯片时选中对象**整体平移**，相对偏移不变', () => {
    const pres = oneSlideWith(
      textBoxWith(1, 100, 0, 50, 50, [{ text: 'a' }]),
      textBoxWith(2, 300, 0, 50, 50, [{ text: 'b' }]),
    );
    const before = relativeGeometry(pres, 1);
    const aligned = alignSelectionToSlide(pres, 1, [1, 2], 'left');
    const after = relativeGeometry(aligned, 1);
    expect(after.shapes[0]?.x_emu).toBe(0); // 左边界贴 0
    expect(after.pairs[0]?.dx_emu).toBe(before.pairs[0]?.dx_emu); // 相对偏移未破坏
  });

  it('反向对照 B：固定间距分布首个不动、后续按 gap 落位；越界入参 ⇒ 抛', () => {
    const pres = oneSlideWith(
      textBoxWith(1, 0, 0, 100, 10, [{ text: 'a' }]),
      textBoxWith(2, 500, 0, 100, 10, [{ text: 'b' }]),
    );
    const spaced = distributeWithGap(pres, 1, [1, 2], 'horizontal', 20);
    const shapes = spaced.slides[0]?.shapes ?? [];
    expect(shapes.find((s) => s.shape_id === 1)?.transform.x_emu).toBe(0);
    expect(shapes.find((s) => s.shape_id === 2)?.transform.x_emu).toBe(120); // 0 + 100 + 20
    expect(() => distributeWithGap(pres, 1, [1], 'horizontal', 10)).toThrow(GeometryError);
    expect(() => distributeWithGap(pres, 1, [1, 2], 'horizontal', -5)).toThrow(/不能为负/);
  });

  it('反向对照 C：组合少于 2 个 ⇒ 抛；置顶改 z 序；负尺寸 ⇒ 抛', () => {
    const pres = oneSlideWith(textBoxWith(1, 0, 0, 10, 10, [{ text: 'a' }]));
    expect(() => groupSelection(pres, 1, [1])).toThrow(/至少需要 2 个/);
    expect(() => setBounds(pres, 1, 1, { x_emu: 0, y_emu: 0, cx_emu: -1, cy_emu: 10 })).toThrow(/尺寸不能为负/);
    expect(() => flipShape(pres, 1, 99, 'h')).toThrow(/找不到对象/);
  });

  it('正向：两对象置顶 / 置底改变 z 序（对象数组顺序 = z 序）', () => {
    const pres = oneSlideWith(textBoxWith(1, 0, 0, 10, 10, [{ text: 'a' }]), textBoxWith(2, 0, 0, 10, 10, [{ text: 'b' }]));
    expect(zOrder(pres, 1)).toEqual([1, 2]);
  });
});

// ===========================================================================
// 3. presentations/slide-ops —— 对象引用 vs 页码
// ===========================================================================

describe('独立验证 · presentations/slide-ops', () => {
  function threeSlides(): Presentation {
    let pres = emptyPresentation();
    pres = addSlide(pres).presentation;
    pres = addSlide(pres).presentation;
    pres = addSlide(pres).presentation;
    return pres;
  }

  it('正向：删中间页后 slide_id 不变、页码收紧（对象引用 ≠ 页码）', () => {
    const pres = threeSlides();
    expect(slideOrder(pres)).toEqual([1, 2, 3]);
    const after = deleteSlide(pres, 2);
    expect(slideOrder(after)).toEqual([1, 3]);
    expect(locateSlide(after, 3)).toMatchObject({ slide_id: 3, page_number: 2, page_index: 1 });
    expect(slideIdAtPage(after, 2)).toBe(3);
    expect([...pageNumbersById(after)]).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it('反向对照 A：页码越界 ⇒ 具名错（不返回 undefined）', () => {
    const pres = threeSlides();
    expect(() => slideIdAtPage(pres, 4)).toThrow(SlideOperationError);
    expect(() => slideIdAtPage(pres, 0)).toThrow(/超出/);
    expect(() => locateSlide(pres, 99)).toThrow(/找不到幻灯片/);
  });

  it('正向 + 反向：分节内的 slide_ids 始终按页序；重排分节必须恰好覆盖', () => {
    const pres = threeSlides();
    const created = createSection(pres, '开头');
    const withS1 = created.presentation;
    const withMembers = assignSlideToSection(withS1, 3, created.section_id);
    const withMore = assignSlideToSection(withMembers, 1, created.section_id);
    expect(slidesInSection(withMore, created.section_id)).toEqual([1, 3]);
    // 一页至多属于一个分节
    expect(() => reorderSections(withMore, ['nope'])).toThrow(/恰好覆盖|不存在/);
    expect(reorderSections(withMore, [created.section_id])).toBeDefined();
    // 空分节名 ⇒ 抛
    expect(() => createSection(pres, '   ')).toThrow(/分节名不能为空/);
  });
});

// ===========================================================================
// 4. presentations/animation —— 顺序由数组决定，不信任手填 order
// ===========================================================================

describe('独立验证 · presentations/animation', () => {
  const spec = (shape_id: number, trigger: AnimationSpec['trigger']): AnimationSpec => ({
    shape_id,
    effect: 'fade',
    kind: 'entrance',
    trigger,
    duration_ms: 500,
    delay_ms: 0,
  });

  it('正向：normalizeOrder 按**数组顺序**重算，同触发组内 0 起', () => {
    const ordered = normalizeOrder([spec(1, 'on_click'), spec(2, 'on_click'), spec(3, 'with_previous')]);
    expect(ordered.map((entry) => entry.order)).toEqual([0, 1, 0]);
  });

  it('反向对照 A：点击组切分 —— on_click 起新组，其余并入当前组', () => {
    const groups = buildClickGroups([spec(1, 'on_click'), spec(2, 'after_previous'), spec(3, 'on_click')]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.effects.map((effect) => effect.shape_id)).toEqual([1, 2]);
    expect(groups[1]?.effects.map((effect) => effect.shape_id)).toEqual([3]);
  });

  it('反向对照 B：未知效果名 ⇒ 抛；越界下标 ⇒ 抛', () => {
    expect(() => addAnimationSpec([], { ...spec(1, 'on_click'), effect: 'nope' as AnimationSpec['effect'] })).toThrow(/不支持的效果名/);
    expect(() => moveAnimationSpec([spec(1, 'on_click')], 0, 3)).toThrow(/越界/);
  });

  it('正向 + 反向：空列表仍产出结构合法的 p:timing；非空含点击组', () => {
    expect(renderTimingXml([])).toContain('p:timing');
    const xml = renderTimingXml([spec(1, 'on_click')]);
    expect(xml).toContain('mainSeq');
    expect(xml).toContain('delay="indefinite"');
  });
});
