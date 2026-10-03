/**
 * P-I15 集成验收：`layout-check.ts` 的四个此前被标为 STUBBED 的缺口。
 *
 * P09 的交付说明明确写着「merged table cells, rotated bbox, master/layout inheritance,
 * BiDi/ligatures」未处理，因此真实稿件上的溢出会被**少报**。本套用例逐条验收这四项，并对每一条
 * 给出**独立复算**的期望值（不复用被测实现来判断自己）：
 *
 * - **旋转外接框**：用例自带一份绕中心的轴对齐外接矩形公式，与 `rotatedBounds` 在多个角度上比对；
 * - **合并单元格**：期望可用宽度由用例自行对 `column_widths_emu` 求和得出；
 * - **版式/母版继承**：同一文本框，仅"传/不传占位符几何"之差，溢出结论必须翻转；
 * - **BiDi / 组合字符**：零宽控制符与组合符不推进；RTL 字母按半角。为免断言空转，换行边界取在
 *   "计入 / 不计入这些字符"恰好跨线的宽度上，并用反向对照证明该边界是真实的。
 *
 * 边界（如实登记）：文本高度仍是字符宽度模型（非像素渲染）；版式几何由调用方传入，本层不读包；
 * 逐行行高用常量。真机 / 消费端实测不在本包内。
 */

import { describe, expect, it } from 'vitest';

import {
  literalText,
  transform,
  SLIDE_SIZE_4_3,
  type Presentation,
  type Shape,
  type Slide,
  type TableCell,
} from '../../../../src/presentations/model.js';
import {
  charWidthPt,
  checkPresentationLayout,
  checkSlideLayout,
  estimateTextHeightEmu,
  isRtlCodePoint,
  isZeroWidthCodePoint,
  resolveInheritedTransform,
  rotatedBounds,
  type InheritedPlaceholder,
  type LayoutFinding,
} from '../../../../src/presentations/layout-check.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const ROW_HEIGHT_EMU = 457200;
const INSET_LR = 91440;

function slideWith(shapes: readonly Shape[]): Slide {
  return {
    slide_id: 1,
    layout: { master_id: 'master1', layout_id: 'blank' },
    hidden: false,
    shapes,
    transition: null,
    animations: [],
    notes: null,
  };
}

function deckOf(slides: readonly Slide[]): Presentation {
  return {
    presentation_id: 'p-i15',
    title: 'P-I15',
    format: 'pptx',
    size: SLIDE_SIZE_4_3,
    master: { master_id: 'master1' },
    theme: { theme_id: 'theme1' },
    slides,
    sections: [],
  };
}

function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string, rotationDeg = 0): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name,
    transform: transform(x, y, cx, cy, { rotation_deg: rotationDeg }),
    text: literalText(text, { size_pt: 18 }),
  };
}

function picture(id: number, x: number, y: number, cx: number, cy: number, rotationDeg = 0): Shape {
  return {
    kind: 'picture',
    shape_id: id,
    name: `Pic ${String(id)}`,
    transform: transform(x, y, cx, cy, { rotation_deg: rotationDeg }),
    media_path: 'ppt/media/image1.png',
    alt_text: '示例图',
    crop: null,
  };
}

function cell(text: string | null, colSpan = 1, rowSpan = 1): TableCell {
  return { text: text === null ? null : literalText(text, { size_pt: 18 }), col_span: colSpan, row_span: rowSpan };
}

function table(id: number, columnWidths: readonly number[], rows: readonly (readonly TableCell[])[]): Shape {
  const width = columnWidths.reduce((sum, item) => sum + item, 0);
  return {
    kind: 'table',
    shape_id: id,
    name: `Table ${String(id)}`,
    transform: transform(100000, 100000, width, ROW_HEIGHT_EMU * rows.length),
    rows: rows.map((cells) => ({ cells })),
    column_widths_emu: columnWidths,
  };
}

function has(findings: readonly LayoutFinding[], code: LayoutFinding['code']): boolean {
  return findings.some((finding) => finding.code === code);
}

/** 用例自带的独立实现：绕中心旋转后的轴对齐外接矩形（不复用被测代码）。 */
function independentRotatedBounds(x: number, y: number, cx: number, cy: number, deg: number): readonly number[] {
  const rad = (deg * Math.PI) / 180;
  const w = Math.abs(cx * Math.cos(rad)) + Math.abs(cy * Math.sin(rad));
  const h = Math.abs(cx * Math.sin(rad)) + Math.abs(cy * Math.cos(rad));
  const centerX = x + cx / 2;
  const centerY = y + cy / 2;
  return [centerX - w / 2, centerY - h / 2, centerX + w / 2, centerY + h / 2];
}

// ---------------------------------------------------------------------------
// 1. 旋转外接框
// ---------------------------------------------------------------------------

describe('P-I15-1：旋转外接框（rotated bbox）', () => {
  it('rotatedBounds 与独立复算在 0/30/45/90/135/180/270 度逐值一致（±1 EMU）', () => {
    const x = 111111;
    const y = 222222;
    const cx = 3000000;
    const cy = 1200000;
    for (const deg of [0, 30, 45, 90, 135, 180, 270]) {
      const got = rotatedBounds(transform(x, y, cx, cy, { rotation_deg: deg }));
      const want = independentRotatedBounds(x, y, cx, cy, deg);
      expect(Math.abs(got.left - want[0]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(got.top - want[1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(got.right - want[2]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(got.bottom - want[3]!)).toBeLessThanOrEqual(1);
    }
  });

  it('0 度时与未旋转 a:xfrm 完全同框（不改变既有判定）', () => {
    const b = rotatedBounds(transform(5, 6, 7, 8, { rotation_deg: 0 }));
    expect(b).toEqual({ left: 5, top: 6, right: 12, bottom: 14 });
  });

  it('旋转让"本来不相交"的邻居被报为遮挡；未旋转时不报', () => {
    const text = textBox(2, 'Body', 914400, 914400, 3000000, 1000000, '会被压住的文字');
    // 未旋转：图片 left=4000000 > 文本框 right=3914400。
    expect(has(checkSlideLayout(slideWith([text, picture(3, 4000000, 800000, 600000, 2000000, 0)]), { slide_size: SLIDE_SIZE_4_3 }), 'occlusion')).toBe(false);
    // 旋转 90°：外接框左边界扩到 3300000，压住文本框。
    expect(has(checkSlideLayout(slideWith([text, picture(3, 4000000, 800000, 600000, 2000000, 90)]), { slide_size: SLIDE_SIZE_4_3 }), 'occlusion')).toBe(true);
  });

  it('旋转对象越界按外接框判定（贴边未旋转在界内，旋转后越界）', () => {
    const inBounds = checkSlideLayout(slideWith([textBox(2, 'T', 8000000, 6000000, 1000000, 800000, 'x', 0)]), { slide_size: SLIDE_SIZE_4_3 });
    expect(has(inBounds, 'out_of_bounds')).toBe(false);
    const tilted = checkSlideLayout(slideWith([textBox(2, 'T', 8000000, 6000000, 1000000, 800000, 'x', 45)]), { slide_size: SLIDE_SIZE_4_3 });
    expect(has(tilted, 'out_of_bounds')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 合并单元格
// ---------------------------------------------------------------------------

describe('P-I15-2：合并单元格可用宽度 / 高度', () => {
  // 在 2000000+ 宽度里也会排成多行的长文本，确保合并/单列两种情形都会溢出。
  const LONG = '很长很长的中文内容需要换行而且还要明显更长一些才行';

  it('跨 2 列合并格：可用宽度 = 所跨两列宽之和 − 内边距（期望值用例自行求和）', () => {
    const columns = [1234000, 2345000, 1000000];
    const merged = table(2, columns, [[cell(LONG, 2, 1), cell(null, 1, 1), cell(null, 1, 1)]]);
    const overflow = checkSlideLayout(slideWith([merged]), { slide_size: SLIDE_SIZE_4_3 }).find((f) => f.code === 'text_overflow')!;
    expect(overflow).toBeDefined();
    const expectedCellWidth = columns[0]! + columns[1]!;
    expect(overflow.details.cell_width_emu).toBe(expectedCellWidth);
    expect(overflow.details.available_width_emu).toBe(expectedCellWidth - INSET_LR * 2);
    expect(overflow.details.col_span).toBe(2);
  });

  it('同一文本在单列里边界更窄：合并的可用宽度严格更大', () => {
    const columns = [1234000, 2345000];
    const mergedW = checkSlideLayout(slideWith([table(2, columns, [[cell(LONG, 2, 1), cell(null, 1, 1)]])]), { slide_size: SLIDE_SIZE_4_3 }).find((f) => f.code === 'text_overflow')!.details.available_width_emu;
    const singleW = checkSlideLayout(slideWith([table(3, [columns[0]!], [[cell(LONG, 1, 1)]])]), { slide_size: SLIDE_SIZE_4_3 }).find((f) => f.code === 'text_overflow')!.details.available_width_emu;
    expect(Number(mergedW)).toBe(columns[0]! + columns[1]! - INSET_LR * 2);
    expect(Number(singleW)).toBe(columns[0]! - INSET_LR * 2);
    expect(Number(mergedW)).toBeGreaterThan(Number(singleW));
  });

  it('跨 2 行的合并格可用高度 = 行高 × 2；同一文本单行溢出、跨两行不溢出（反向对照）', () => {
    const text = '很长的中文文本内容啊'; // 在 2000000 宽里 7 字/行 ⇒ 2 行
    const singleRow = table(2, [2000000], [[cell(text, 1, 1)]]);
    expect(has(checkSlideLayout(slideWith([singleRow]), { slide_size: SLIDE_SIZE_4_3 }), 'text_overflow')).toBe(true);

    const twoRows = table(3, [2000000, 1000000], [[cell(text, 1, 2), cell(null, 1, 1)], [cell(null, 1, 1), cell(null, 1, 1)]]);
    expect(has(checkSlideLayout(slideWith([twoRows]), { slide_size: SLIDE_SIZE_4_3 }), 'text_overflow')).toBe(false);
  });

  it('table_row_height_emu 覆盖行高后，details.row_height_emu 随之改变并移动边界', () => {
    const table0 = table(2, [3000000], [[cell('八个汉字左右的', 1, 1)]]);
    const tall = checkSlideLayout(slideWith([table0]), { slide_size: SLIDE_SIZE_4_3, table_row_height_emu: 900000 });
    const short = checkSlideLayout(slideWith([table0]), { slide_size: SLIDE_SIZE_4_3, table_row_height_emu: 200000 });
    expect(has(tall, 'text_overflow')).toBe(false);
    const shortOverflow = short.find((f) => f.code === 'text_overflow')!;
    expect(shortOverflow.details.row_height_emu).toBe(200000);
    expect(shortOverflow.details.available_emu).toBe(200000 - 45720 * 2);
  });
});

// ---------------------------------------------------------------------------
// 3. 版式 / 母版继承
// ---------------------------------------------------------------------------

describe('P-I15-3：版式 / 母版占位符几何继承', () => {
  const title = '这是一段中等长度的标题文本';

  it('未解析几何的占位符：不传继承 ⇒ 溢出；传了版式几何 ⇒ 不溢出（边界随之移动）', () => {
    const slide = slideWith([textBox(2, 'Title 1', 914400, 500000, 0, 0, title)]);
    expect(has(checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3 }), 'text_overflow')).toBe(true);
    const placeholders: readonly InheritedPlaceholder[] = [
      { placement: 'layout', layout_id: 'blank', name: 'Title 1', transform: transform(914400, 500000, 8000000, 1000000) },
    ];
    expect(has(checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: placeholders }), 'text_overflow')).toBe(false);
  });

  it('继承几何同时移动越界边界：占位符几何把框推出页外即报越界', () => {
    const slide = slideWith([textBox(2, 'Title 1', 0, 0, 0, 0, 'x')]);
    const placeholders: readonly InheritedPlaceholder[] = [
      { placement: 'master', name: 'Title 1', transform: transform(9000000, 0, 3000000, 500000) },
    ];
    expect(has(checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: placeholders }), 'out_of_bounds')).toBe(true);
  });

  it('自身几何已解析则不继承（真实几何优先）；layout_id 不匹配则不生效', () => {
    const resolved = textBox(2, 'Title 1', 0, 0, 3000000, 500000, 'x');
    const placeholders: readonly InheritedPlaceholder[] = [
      { placement: 'layout', name: 'Title 1', transform: transform(0, 0, 100, 100) },
    ];
    expect(resolveInheritedTransform(resolved, slideWith([resolved]), { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: placeholders })).toBe(resolved.transform);

    const unresolved = textBox(4, 'Title 1', 0, 0, 0, 0, 'x');
    const scoped: readonly InheritedPlaceholder[] = [
      { placement: 'layout', layout_id: 'other', name: 'Title 1', transform: transform(0, 0, 100, 100) },
    ];
    expect(resolveInheritedTransform(unresolved, slideWith([unresolved]), { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: scoped })).toBe(unresolved.transform);
  });

  it('checkPresentationLayout 把继承选项透传到每一页', () => {
    const title2 = '这是一段中等长度的标题文本';
    const deck = deckOf([
      slideWith([textBox(2, 'Title 1', 914400, 500000, 0, 0, title2)]),
      { ...slideWith([textBox(3, 'Title 1', 914400, 500000, 0, 0, title2)]), slide_id: 2 },
    ]);
    const placeholders: readonly InheritedPlaceholder[] = [
      { placement: 'layout', layout_id: 'blank', name: 'Title 1', transform: transform(914400, 500000, 8000000, 1000000) },
    ];
    expect(has(checkPresentationLayout(deck, { inherited_placeholders: placeholders }), 'text_overflow')).toBe(false);
    expect(has(checkPresentationLayout(deck, {}), 'text_overflow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. BiDi / 组合字符前进
// ---------------------------------------------------------------------------

describe('P-I15-4：BiDi / 组合字符前进宽度', () => {
  it('零宽类码点判定独立复算一致；普通半角字母不是零宽', () => {
    for (const cp of [0x0301, 0x0308, 0x200d, 0x200b, 0x202b, 0x202c, 0x200f, 0x2066, 0xfe0f, 0xfeff]) {
      expect(isZeroWidthCodePoint(cp)).toBe(true);
      expect(charWidthPt(String.fromCodePoint(cp), 18)).toBe(0);
    }
    for (const cp of [0x61, 0x4e2d, 0x30, 0x20]) {
      expect(isZeroWidthCodePoint(cp)).toBe(false);
    }
  });

  it('组合符不推进：4 个「基符+组合符」在恰好容 4 个 a 的框里仍是一行（含反向对照）', () => {
    const boxWidth = 500000 + INSET_LR * 2; // 内宽 500000 ⇒ 4 个 a（4×114300）正好一行
    const plain = literalText('aaaa');
    const combined = literalText('a\u0301'.repeat(4));
    expect(estimateTextHeightEmu(combined, boxWidth)).toBe(estimateTextHeightEmu(plain, boxWidth));
    // 反向对照：8 个普通 a 在同一框里确实更多行 ⇒ 换行边界真实存在。
    expect(estimateTextHeightEmu(literalText('a'.repeat(8)), boxWidth)).toBeGreaterThan(estimateTextHeightEmu(plain, boxWidth));
  });

  it('RTL 字母半角前进；RLE/PDF 双向嵌入符零宽（含反向对照）', () => {
    expect(isRtlCodePoint(0x05d0)).toBe(true);
    expect(isRtlCodePoint(0x0627)).toBe(true);
    expect(charWidthPt('א', 18)).toBeCloseTo(9, 6);
    const boxWidth = 1000000 + INSET_LR * 2; // 8 个希伯来字母一行；多算两个嵌入符即越线
    const bare = literalText('אבגהוזחט');
    const withControls = literalText('\u202b\u05d0\u05d1\u05d2\u05d4\u05d5\u05d6\u05d7\u05d8\u202c');
    expect(estimateTextHeightEmu(withControls, boxWidth)).toBe(estimateTextHeightEmu(bare, boxWidth));
    expect(estimateTextHeightEmu(literalText('א'.repeat(10)), boxWidth)).toBeGreaterThan(estimateTextHeightEmu(bare, boxWidth));
  });

  it('星平面字符按码点单算（代理对不重复计数）', () => {
    // U+1F600 不在全角区间，按半角；且 for…of 只迭代到一个码点。
    expect(charWidthPt('\u{1F600}', 18)).toBeCloseTo(9, 6);
  });
});
