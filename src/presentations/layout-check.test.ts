/**
 * 演示域**统一排版与版面体检**用例（design-06 P9；PPT-13）。
 *
 * 重点：
 * - **不同内容长度下结论不同**：同一文本框，短文本不溢出、长文本溢出（基于文本长度与字号的估算）；
 * - 溢出 / 遮挡 / 越界 / 对比 / 字体替代五类结论都可解释（带具体数字）；
 * - 统一排版只改文本对象：图片 / 表格等**引用不变**（反向对照）。
 *
 * 注：本模块是"可计算的渲染替身"（字符宽度模型），**不是**经 PowerPoint 实测的渲染结论。
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
  type TableRow,
  type TableShape,
} from './model.js';
import {
  DEFAULT_UNIFORM_LAYOUT,
  charWidthPt,
  checkSlideLayout,
  contrastRatio,
  estimateTextHeightEmu,
  isRtlCodePoint,
  isZeroWidthCodePoint,
  resolveInheritedTransform,
  rotatedBounds,
  uniformLayout,
  type InheritedPlaceholder,
  type LayoutFinding,
} from './layout-check.js';

/** 与渲染器一致的默认行高（`tables.DEFAULT_ROW_HEIGHT_EMU`）。 */
const ROW_HEIGHT_EMU = 457200;
/** 文本体内边距（EMU）。 */
const INSET_LR = 91440;

function textBox(id: number, x: number, y: number, cx: number, cy: number, text: string, style?: Parameters<typeof literalText>[1]): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(x, y, cx, cy),
    text: literalText(text, style),
  };
}

function picture(id: number, x: number, y: number, cx: number, cy: number): Shape {
  return {
    kind: 'picture',
    shape_id: id,
    name: `Pic ${String(id)}`,
    transform: transform(x, y, cx, cy),
    media_path: 'ppt/media/image1.png',
    alt_text: '示例图',
    crop: null,
  };
}

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

function deckWithSlide(slide: Slide): Presentation {
  return {
    presentation_id: 'p1',
    title: '测试',
    format: 'pptx',
    size: SLIDE_SIZE_4_3,
    master: { master_id: 'master1' },
    theme: { theme_id: 'theme1' },
    slides: [slide],
    sections: [],
  };
}

function has(findings: readonly LayoutFinding[], code: LayoutFinding['code']): boolean {
  return findings.some((finding) => finding.code === code);
}

/** 命名文本框（用于占位符继承按 name 匹配）。 */
function namedTextBox(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name,
    transform: transform(x, y, cx, cy),
    text: literalText(text, { size_pt: 18 }),
  };
}

/** 旋转图片：非零 `rotation_deg` 时外接矩形会变化。 */
function rotatedPicture(id: number, x: number, y: number, cx: number, cy: number, rotationDeg: number): Shape {
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

function cell(text: string | null, colSpan: number, rowSpan: number): TableCell {
  return { text: text === null ? null : literalText(text, { size_pt: 18 }), col_span: colSpan, row_span: rowSpan };
}

function tableShape(id: number, columnWidths: readonly number[], rows: readonly (readonly TableCell[])[]): TableShape {
  const width = columnWidths.reduce((sum, item) => sum + item, 0);
  return {
    kind: 'table',
    shape_id: id,
    name: `Table ${String(id)}`,
    transform: transform(100000, 100000, width, ROW_HEIGHT_EMU * rows.length),
    rows: rows.map((cells): TableRow => ({ cells })),
    column_widths_emu: columnWidths,
  };
}

describe('PPT-13：不同内容长度下检查真实渲染（溢出判定随长度翻转）', () => {
  it('短文本不溢出、长文本溢出——同一框、同一字号，仅文本长度不同', () => {
    const short = checkSlideLayout(slideWith([textBox(2, 914400, 914400, 3000000, 500000, '你好')]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(short, 'text_overflow')).toBe(false);

    const long = checkSlideLayout(
      slideWith([textBox(2, 914400, 914400, 3000000, 500000, '这是一段很长的中文文本内容啊')]),
      { slide_size: SLIDE_SIZE_4_3 },
    );
    expect(has(long, 'text_overflow')).toBe(true);
    const finding = long.find((item) => item.code === 'text_overflow')!;
    expect(Number(finding.details.required_emu)).toBeGreaterThan(Number(finding.details.available_emu));
  });

  it('估算：字号越大 / 文本越长 ⇒ 估算高度越大（单调）', () => {
    const base = literalText('这是一段中文', { size_pt: 18 });
    const bigger = literalText('这是一段中文', { size_pt: 36 });
    expect(estimateTextHeightEmu(bigger, 3000000)).toBeGreaterThan(estimateTextHeightEmu(base, 3000000));
    const longer = literalText('这是一段中文，而且明显更长更长更长更长更长更长', { size_pt: 18 });
    expect(estimateTextHeightEmu(longer, 3000000)).toBeGreaterThan(estimateTextHeightEmu(base, 3000000));
  });
});

describe('PPT-13：越界 / 遮挡 / 对比 / 字体替代', () => {
  it('越界：对象越出页面被报；反面：贴边但在界内不报', () => {
    const outside = checkSlideLayout(slideWith([textBox(2, -1, 914400, 1000000, 400000, 'x')]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(outside, 'out_of_bounds')).toBe(true);

    const inside = checkSlideLayout(slideWith([textBox(2, 0, 0, 1000000, 400000, 'x')]), { slide_size: SLIDE_SIZE_4_3 });
    expect(has(inside, 'out_of_bounds')).toBe(false);
  });

  it('遮挡：上层不透明对象盖住文本被报；反面：不重叠不报', () => {
    const text = textBox(2, 914400, 914400, 3000000, 1000000, '会被盖住的文字');
    const overlapping = checkSlideLayout(slideWith([text, picture(3, 1000000, 1000000, 2000000, 800000)]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(overlapping, 'occlusion')).toBe(true);

    const faraway = checkSlideLayout(slideWith([text, picture(3, 6000000, 4000000, 2000000, 800000)]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(faraway, 'occlusion')).toBe(false);
  });

  it('对比：黑字白底通过；浅灰字白底不通过——反向对照同一背景', () => {
    const dark = checkSlideLayout(slideWith([textBox(2, 914400, 914400, 3000000, 1000000, '清晰', { color: '000000' })]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(dark, 'low_contrast')).toBe(false);

    const light = checkSlideLayout(
      slideWith([textBox(2, 914400, 914400, 3000000, 1000000, '看不清', { color: 'CCCCCC' })]),
      { slide_size: SLIDE_SIZE_4_3 },
    );
    expect(has(light, 'low_contrast')).toBe(true);
    expect(contrastRatio('000000', 'FFFFFF')).toBeCloseTo(21, 1);
  });

  it('字体替代：不在可用清单的字体被报并给出回退；在清单内的不报', () => {
    const missing = checkSlideLayout(
      slideWith([textBox(2, 914400, 914400, 3000000, 1000000, '标题', { font: '阿里巴巴普惠体' })]),
      { slide_size: SLIDE_SIZE_4_3, available_fonts: ['宋体', '微软雅黑'], fallback_font: '宋体' },
    );
    const finding = missing.find((item) => item.code === 'font_substitution')!;
    expect(finding.details.font).toBe('阿里巴巴普惠体');
    expect(finding.details.fallback_font).toBe('宋体');

    const present = checkSlideLayout(slideWith([textBox(2, 914400, 914400, 3000000, 1000000, '标题', { font: '宋体' })]), {
      slide_size: SLIDE_SIZE_4_3,
      available_fonts: ['宋体', '微软雅黑'],
    });
    expect(has(present, 'font_substitution')).toBe(false);
  });
});

describe('PPT-13：统一排版（只改文本对象）', () => {
  it('文本对象统一到同一边距 / 内容宽度 / 字号 / 字体；图片引用不变', () => {
    const image = picture(9, 100, 200, 500000, 500000);
    const presentation = deckWithSlide(
      slideWith([textBox(2, 100, 200, 500000, 400000, '第一段'), image, textBox(3, 800000, 900000, 600000, 300000, '第二段')]),
    );
    const unified = uniformLayout(presentation);
    const shapes = unified.slides[0]!.shapes;

    const box1 = shapes[0]!;
    const box3 = shapes[2]!;
    expect(box1.transform.x_emu).toBe(DEFAULT_UNIFORM_LAYOUT.margin_left_emu);
    expect(box3.transform.x_emu).toBe(DEFAULT_UNIFORM_LAYOUT.margin_left_emu);
    expect(box1.transform.cx_emu).toBe(box3.transform.cx_emu);
    // 垂直堆叠：第二个文本对象在第一个之下，间隔 = gap。
    expect(box3.transform.y_emu).toBe(
      DEFAULT_UNIFORM_LAYOUT.margin_top_emu + box1.transform.cy_emu + DEFAULT_UNIFORM_LAYOUT.gap_emu,
    );

    // 统一样式：字号 / 字体。
    const run = box1.kind === 'text_box' ? box1.text.paragraphs[0]!.runs[0]! : undefined;
    expect(run?.style?.size_pt).toBe(DEFAULT_UNIFORM_LAYOUT.body_size_pt);
    expect(run?.style?.font).toBe(DEFAULT_UNIFORM_LAYOUT.body_font);

    // 反向对照：图片**引用不变**（统一排版不该动一张已摆好的图）。
    expect(shapes[1]).toBe(image);
  });

  it('vertical=keep：只统一样式，不动位置', () => {
    const presentation = deckWithSlide(slideWith([textBox(2, 123456, 654321, 500000, 400000, 'x')]));
    const unified = uniformLayout(presentation, { ...DEFAULT_UNIFORM_LAYOUT, vertical: 'keep' });
    expect(unified.slides[0]!.shapes[0]!.transform.y_emu).toBe(654321);
  });
});

describe('P-I15：旋转对象按真实外接框参与遮挡 / 越界判定', () => {
  it('旋转 90° 后外接框变大：原本不相交的邻居被如实报为遮挡；不旋转则不报', () => {
    const text = textBox(2, 914400, 914400, 3000000, 1000000, '会被压住的文字');
    // 未旋转时：图片 left=4000000 > 文本框 right=3914400，二者不相交。
    const unrotated = checkSlideLayout(slideWith([text, rotatedPicture(3, 4000000, 800000, 600000, 2000000, 0)]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(unrotated, 'occlusion')).toBe(false);
    // 旋转 90°：宽高互换，外接框左边界扩到 3300000，压到文本框。
    const rotated = checkSlideLayout(slideWith([text, rotatedPicture(3, 4000000, 800000, 600000, 2000000, 90)]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(rotated, 'occlusion')).toBe(true);
  });

  it('rotatedBounds：0° 与 a:xfrm 同框；90° 宽高互换；45° 外接框面积最大', () => {
    const base = transform(1000, 2000, 400000, 200000);
    expect(rotatedBounds(base)).toEqual({ left: 1000, top: 2000, right: 401000, bottom: 202000 });

    const r90 = rotatedBounds(transform(0, 0, 400000, 200000, { rotation_deg: 90 }));
    // 绕中心 (200000, 100000)：宽 200000、高 400000。
    expect(Math.round(r90.right - r90.left)).toBe(200000);
    expect(Math.round(r90.bottom - r90.top)).toBe(400000);

    const r45 = rotatedBounds(transform(0, 0, 400000, 200000, { rotation_deg: 45 }));
    const area45 = (r45.right - r45.left) * (r45.bottom - r45.top);
    const area0 = 400000 * 200000;
    expect(area45).toBeGreaterThan(area0);
  });

  it('旋转的文本框越出页面时按外接框报越界（旧模型只看未旋转框）', () => {
    // 未旋转：right = 9144000 - 500000 + 1000000 = 9644000？ 否 —— 放在页内、贴右下但不出界。
    const inside0 = checkSlideLayout(slideWith([textBox(2, 8000000, 6000000, 1000000, 800000, 'x')]), {
      slide_size: SLIDE_SIZE_4_3,
    });
    expect(has(inside0, 'out_of_bounds')).toBe(false);
    // 绕中心旋转 45°：外接框半宽 = (1000000*cos45 + 800000*sin45)/2 ≈ 636396 > 余量，越界。
    const tilted = checkSlideLayout(
      slideWith([
        {
          kind: 'text_box',
          shape_id: 2,
          name: 'Tilted',
          transform: transform(8000000, 6000000, 1000000, 800000, { rotation_deg: 45 }),
          text: literalText('x'),
        },
      ]),
      { slide_size: SLIDE_SIZE_4_3 },
    );
    expect(has(tilted, 'out_of_bounds')).toBe(true);
  });
});

describe('P-I15：合并单元格表格按所跨列宽判溢出', () => {
  const longText = '很长的中文文本内容啊';

  it('跨 2 列的合并格：可用宽度 = 两列之和，跨行格可用高度 = 行高 × 行数', () => {
    const merged = tableShape(
      2,
      [1000000, 1000000, 1000000],
      [[cell(longText, 2, 1), cell(null, 1, 1), cell(null, 1, 1)]],
    );
    const findings = checkSlideLayout(slideWith([merged]), { slide_size: SLIDE_SIZE_4_3 });
    const overflow = findings.find((item) => item.code === 'text_overflow');
    expect(overflow).toBeDefined();
    expect(overflow!.details.col_span).toBe(2);
    expect(overflow!.details.cell_width_emu).toBe(2000000);
    expect(overflow!.details.available_width_emu).toBe(2000000 - INSET_LR * 2);
    expect(overflow!.details.available_emu).toBe(ROW_HEIGHT_EMU - 45720 * 2);
  });

  it('同样的文本在单列（未合并）格里可用宽度更窄 —— 合并确实放宽了边界', () => {
    const single = tableShape(2, [1000000], [[cell(longText, 1, 1)]]);
    const findings = checkSlideLayout(slideWith([single]), { slide_size: SLIDE_SIZE_4_3 });
    const overflow = findings.find((item) => item.code === 'text_overflow')!;
    expect(overflow.details.col_span).toBe(1);
    expect(overflow.details.available_width_emu).toBe(1000000 - INSET_LR * 2);
  });

  it('跨 2 行的合并格：同一文本在单行溢出、跨 2 行时可用高度翻倍而不溢出（反向对照）', () => {
    const singleRow = tableShape(2, [2000000], [[cell(longText, 1, 1)]]);
    expect(has(checkSlideLayout(slideWith([singleRow]), { slide_size: SLIDE_SIZE_4_3 }), 'text_overflow')).toBe(true);

    const acrossTwoRows = tableShape(
      3,
      [2000000, 1000000],
      [[cell(longText, 1, 2), cell(null, 1, 1)], [cell(null, 1, 1), cell(null, 1, 1)]],
    );
    expect(has(checkSlideLayout(slideWith([acrossTwoRows]), { slide_size: SLIDE_SIZE_4_3 }), 'text_overflow')).toBe(false);
  });

  it('跨 2 行的合并格：足够长的文本仍溢出，details 报 row_span=2 与双倍可用高度', () => {
    const veryLong = '很长的中文文本内容啊'.repeat(3); // 30 字 ⇒ 5 行，超出两行格高
    const table = tableShape(
      2,
      [2000000, 1000000],
      [[cell(veryLong, 1, 2), cell(null, 1, 1)], [cell(null, 1, 1), cell(null, 1, 1)]],
    );
    const overflow = checkSlideLayout(slideWith([table]), { slide_size: SLIDE_SIZE_4_3 }).find(
      (item) => item.code === 'text_overflow',
    )!;
    expect(overflow.details.row_span).toBe(2);
    expect(overflow.details.available_emu).toBe(ROW_HEIGHT_EMU * 2 - 45720 * 2);
  });

  it('table_row_height_emu 可覆盖行高，从而移动溢出边界', () => {
    // 高行（充足）不溢出；低行溢出 —— 同一文本，仅行高不同。
    const shortText = '八个汉字左右的';
    const table = tableShape(2, [3000000], [[cell(shortText, 1, 1)]]);
    const tall = checkSlideLayout(slideWith([table]), { slide_size: SLIDE_SIZE_4_3, table_row_height_emu: 900000 });
    const short = checkSlideLayout(slideWith([table]), { slide_size: SLIDE_SIZE_4_3, table_row_height_emu: 200000 });
    expect(has(tall, 'text_overflow')).toBe(false);
    expect(has(short, 'text_overflow')).toBe(true);
  });
});

describe('P-I15：版式 / 母版占位符几何继承移动溢出边界', () => {
  const titleText = '这是一段中等长度的标题文本';

  it('自身几何未解析的占位符继承母版几何后不再溢出；不传继承则按未解析几何溢出', () => {
    const slide = slideWith([namedTextBox(2, 'Title 1', 914400, 500000, 0, 0, titleText)]);
    const without = checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3 });
    expect(has(without, 'text_overflow')).toBe(true);

    const placeholders: readonly InheritedPlaceholder[] = [
      { placement: 'master', name: 'Title 1', transform: transform(914400, 500000, 8000000, 1000000) },
    ];
    const withInherited = checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: placeholders });
    expect(has(withInherited, 'text_overflow')).toBe(false);
  });

  it('自身几何已解析的形状不被继承覆盖（真实几何优先）', () => {
    const resolved = namedTextBox(2, 'Title 1', 914400, 500000, 3000000, 500000, titleText);
    const placeholders: readonly InheritedPlaceholder[] = [
      { placement: 'layout', name: 'Title 1', transform: transform(0, 0, 100000, 100000) },
    ];
    expect(resolveInheritedTransform(resolved, slideWith([resolved]), { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: placeholders })).toBe(
      resolved.transform,
    );
  });

  it('layout_id 限定作用域：版式不匹配的占位符不生效', () => {
    const slide = slideWith([namedTextBox(2, 'Title 1', 914400, 500000, 0, 0, titleText)]);
    const scoped: readonly InheritedPlaceholder[] = [
      { placement: 'layout', layout_id: 'other_layout', name: 'Title 1', transform: transform(0, 0, 8000000, 1000000) },
    ];
    // slide.layout.layout_id === 'blank'，与 other_layout 不符 ⇒ 退回未解析几何，仍溢出。
    expect(has(checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: scoped }), 'text_overflow')).toBe(true);
    // 匹配 blank 时生效 ⇒ 不溢出。
    const matching: readonly InheritedPlaceholder[] = [
      { placement: 'layout', layout_id: 'blank', name: 'Title 1', transform: transform(0, 0, 8000000, 1000000) },
    ];
    expect(has(checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3, inherited_placeholders: matching }), 'text_overflow')).toBe(false);
  });
});

describe('P-I15：BiDi / 组合字符前进宽度', () => {
  it('组合附加符号 / 双向控制符 / 连接符记零宽 —— 每个都不再各算半角', () => {
    for (const cp of [0x0301 /* 组合锐音符 */, 0x200d /* ZWJ */, 0x202b /* RLE */, 0x200f /* RLM */, 0xfe0f /* VS16 */]) {
      expect(isZeroWidthCodePoint(cp)).toBe(true);
      expect(charWidthPt(String.fromCodePoint(cp), 18)).toBe(0);
    }
    // 反面：普通半角字母不是零宽。
    expect(isZeroWidthCodePoint(0x61)).toBe(false);
    expect(charWidthPt('a', 18)).toBeCloseTo(9, 6);
  });

  it('组合符不推进：4 个「基符+组合符」在一个刚好容下 4 个 a 的框里仍是一行', () => {
    // 内宽 500000 EMU 只容 4 个 a（4×114300）；若把组合符也算半角，就会排成 2 行。
    const boxWidth = 500000 + 91440 * 2;
    const plain = literalText('aaaa');
    const combined = literalText('a\u0301'.repeat(4));
    expect(estimateTextHeightEmu(combined, boxWidth)).toBe(estimateTextHeightEmu(plain, boxWidth));
    // 反向对照证明这里的换行边界是真实的：8 个普通 a 在同一框里确实更多行。
    expect(estimateTextHeightEmu(literalText('a'.repeat(8)), boxWidth)).toBeGreaterThan(estimateTextHeightEmu(plain, boxWidth));
  });

  it('RTL 字母按半角前进（非表意全角），双向嵌入符零宽不占位', () => {
    expect(isRtlCodePoint(0x05d0)).toBe(true); // 希伯来 alef
    expect(isRtlCodePoint(0x0627)).toBe(true); // 阿拉伯 alef
    expect(charWidthPt('\u05d0', 18)).toBeCloseTo(9, 6);
    // 内宽 1000000 EMU：8 个希伯来字母（8×114300）排一行；RLE/PDF 若各占半角则变 2 行。
    const boxWidth = 1000000 + 91440 * 2;
    const bare = literalText('\u05d0\u05d1\u05d2\u05d4\u05d5\u05d6\u05d7\u05d8');
    const withControls = literalText('\u202b\u05d0\u05d1\u05d2\u05d4\u05d5\u05d6\u05d7\u05d8\u202c');
    expect(estimateTextHeightEmu(withControls, boxWidth)).toBe(estimateTextHeightEmu(bare, boxWidth));
    // 反向对照：若把两个嵌入符当普通字符，宽度会跨过换行边界。
    expect(estimateTextHeightEmu(literalText('\u05d0'.repeat(10)), boxWidth)).toBeGreaterThan(
      estimateTextHeightEmu(bare, boxWidth),
    );
  });
});
