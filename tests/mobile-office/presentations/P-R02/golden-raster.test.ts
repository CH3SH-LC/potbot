/**
 * P-R02 · 中文字体替代 / 黄金栅格 / 叠层 / 溢出差异的**独立验收**。
 *
 * ## 判据来源（不复用待测代码自证）
 *
 * - **字体替代**：断言既看 `resolveFont` 的结论，也看**替代后栅格是否与已装同款字体逐字符相等**
 *   （替代是"度量中立"的：替代到宋体 ⇒ 与直接用宋体的栅格一模一样）；
 * - **溢出量**：与 `src/presentations/layout-check.ts` 的 `checkSlideLayout` **交叉断言**——
 *   两条独立实现（本栅格器的逐字符贪心 vs layout-check 的段落估算）必须给出**同一个数**；
 * - **叠层**：互换两个纯色对象的前后顺序，看重叠格子的**颜色是否翻转**；
 * - **黄金**：同一输入连跑两次逐字符相等，且 `digest` 钉死为一个常量。
 *
 * ## 反向对照（不许空壳）
 *
 * 分辨率 ≤ 0 / 页尺寸 ≤ 0 / 字号 ≤ 0 / 空字体清单 —— 四条非法输入都必须**具名报错**，
 * 不许被静默改成默认值。
 *
 * ## 如实登记
 *
 * 本栅格是**字符网格**，不是位图截图；真实像素渲染（PowerPoint / WPS / 手机放映）
 * **未实现、未验证**。
 */

import { describe, expect, it } from 'vitest';

import { checkSlideLayout } from '../../../../src/presentations/layout-check.js';
import {
  SLIDE_SIZE_4_3,
  transform,
  type AutoShapeShape,
  type PictureShape,
  type Presentation,
  type Shape,
  type Slide,
  type TextBoxShape,
} from '../../../../src/presentations/model.js';

import { FontResolutionError, resolveFont } from './font-metrics.js';
import { rasterizePresentation, rasterizeSlide, type Raster } from './golden-raster.js';
import { RasterSchemaError, validateRasterRequest } from './schema.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const INSTALLED_CN = ['宋体', '黑体', '等线'] as const; // 微软雅黑「未装」

function textBox(
  id: number,
  x: number,
  y: number,
  cx: number,
  cy: number,
  text: string,
  style?: { size_pt?: number; font?: string; color?: string },
): TextBoxShape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(x, y, cx, cy),
    text: {
      paragraphs: [
        {
          runs: [{ source: { kind: 'literal', text }, style }],
          level: 0,
          alignment: 'left',
          bullet: false,
        },
      ],
    },
  };
}

function solidRect(id: number, x: number, y: number, cx: number, cy: number, color: string): AutoShapeShape {
  return {
    kind: 'auto_shape',
    shape_id: id,
    name: `Rect ${String(id)}`,
    transform: transform(x, y, cx, cy),
    preset: 'rect',
    text: null,
    fill: { kind: 'solid', color },
    outline: null,
  };
}

function picture(id: number, x: number, y: number, cx: number, cy: number): PictureShape {
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

function deck(slide: Slide): Presentation {
  return {
    presentation_id: 'pr02',
    title: 'P-R02',
    format: 'pptx',
    size: SLIDE_SIZE_4_3,
    master: { master_id: 'master1' },
    theme: { theme_id: 'theme1' },
    slides: [slide],
    sections: [],
  };
}

/** 黄金页：一条混合中英文字文本框 + 一个纯色矩形 + 一张图片。 */
function goldenSlide(): Slide {
  return slideWith([
    textBox(2, 914400, 548640, 4000000, 1200000, '演示 PptX 2026', { size_pt: 18, font: '宋体', color: '000000' }),
    solidRect(3, 5486400, 914400, 2743200, 1828800, 'DDEEFF'),
    picture(4, 914400, 3000000, 2286000, 1371600),
  ]);
}

/** 从图例反查某语义键对应的字符。 */
function charOf(raster: Raster, predicate: (key: string) => boolean): string {
  const entry = Object.entries(raster.legend).find(([, key]) => predicate(key));
  if (entry === undefined) throw new Error('图例里找不到该语义键');
  return entry[0];
}

function cellAt(raster: Raster, row: number, col: number): string {
  return raster.grid[row]![col]!;
}

// ---------------------------------------------------------------------------
// A. 中文字体替代
// ---------------------------------------------------------------------------

describe('A. 中文字体替代', () => {
  it('未指定字体 → 正文字体；指定的 CJK 字体缺失 → 替代到已装 CJK 并给出原因', () => {
    const body = resolveFont(undefined, INSTALLED_CN);
    expect(body.resolved).toBe('宋体');
    expect(body.reason).toBe('default');

    const installed = resolveFont('黑体', INSTALLED_CN);
    expect(installed.resolved).toBe('黑体');
    expect(installed.reason).toBe('installed');

    // 微软雅黑未装 ⇒ 替代到目录里靠前的已装 CJK（宋体），且度量取自宋体（1.2 行高）。
    const fallback = resolveFont('微软雅黑', INSTALLED_CN);
    expect(fallback.resolved).toBe('宋体');
    expect(fallback.reason).toBe('cjk_fallback');
    expect(fallback.metrics.line_height).toBeCloseTo(1.2, 6);

    // 目录未知的用户商业字体。
    const unknown = resolveFont('阿里巴巴普惠体', INSTALLED_CN);
    expect(unknown.resolved).toBe('宋体');
    expect(unknown.reason).toBe('unknown_family_fallback');

    // 纯拉丁字体缺失 → 走任意已装字体。
    const latin = resolveFont('Calibri', INSTALLED_CN);
    expect(latin.reason).toBe('latin_fallback');
  });

  it('别名等价：SimSun 与 宋体 视为同一族', () => {
    expect(resolveFont('SimSun', INSTALLED_CN).resolved).toBe('宋体');
    expect(resolveFont('SimSun', INSTALLED_CN).reason).toBe('installed');
  });

  it('替代是「度量中立」的：替代到宋体 ⇒ 栅格与直接用宋体逐字符相等、digest 相等', () => {
    const request = { installed_fonts: INSTALLED_CN };
    const asSong = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 4000000, 1200000, 'Slide 2026 报告', { font: '宋体' })]),
      request,
      SLIDE_SIZE_4_3,
    );
    const substituted = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 4000000, 1200000, 'Slide 2026 报告', { font: '微软雅黑' })]),
      request,
      SLIDE_SIZE_4_3,
    );
    expect(substituted.digest).toBe(asSong.digest);
    expect(substituted.grid).toEqual(asSong.grid);
    expect(substituted.substitutions).toEqual([
      { shape_id: 2, requested: '微软雅黑', resolved: '宋体', reason: 'cjk_fallback' },
    ]);
  });

  it('字体替代会改变版式：宋体 vs 微软雅黑（都装机）→ 栅格不同', () => {
    const installed = ['宋体', '微软雅黑'];
    const request = { installed_fonts: installed };
    const song = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 4000000, 1200000, 'Slide 2026 报告 long latin run', { font: '宋体' })]),
      request,
      SLIDE_SIZE_4_3,
    );
    const yahei = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 4000000, 1200000, 'Slide 2026 报告 long latin run', { font: '微软雅黑' })]),
      request,
      SLIDE_SIZE_4_3,
    );
    expect(yahei.digest).not.toBe(song.digest);
    expect(yahei.substitutions).toEqual([]); // 都装机，无替代
  });

  it('反向对照：空字体清单必须报错，不静默用默认字体', () => {
    expect(() => resolveFont('宋体', [])).toThrow(FontResolutionError);
    try {
      resolveFont('宋体', []);
    } catch (error) {
      expect((error as FontResolutionError).reason).toBe('empty_installed_list');
    }
  });
});

// ---------------------------------------------------------------------------
// B. 黄金栅格（确定性 + 钉死摘要）
// ---------------------------------------------------------------------------

/** 钉死的黄金摘要（由首次实跑得出，见 RUNBOOK）。 */
const GOLDEN_DIGEST = '0e59479359a5fff05f61a5eb8826116bccee2d79e3d20381ad72acfcdc3b4733';

describe('B. 黄金栅格', () => {
  it('同一输入连跑两次逐字符相等（确定性），且 grid 尺寸正确', () => {
    const request = { installed_fonts: INSTALLED_CN };
    const first = rasterizeSlide(goldenSlide(), request, SLIDE_SIZE_4_3);
    const second = rasterizeSlide(goldenSlide(), request, SLIDE_SIZE_4_3);
    expect(first.grid).toEqual(second.grid);
    expect(first.digest).toBe(second.digest);
    expect(first.grid).toHaveLength(48);
    for (const row of first.grid) expect(row).toHaveLength(64);
    expect(first.fidelity).toBe('char_grid');
    expect(first.pixel_fidelity_verified).toBe(false);
  });

  it('黄金截图摘要与钉死常量一致', () => {
    const raster = rasterizeSlide(goldenSlide(), { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);
    // eslint-disable-next-line no-console
    console.log('P-R02 GOLDEN DIGEST =', raster.digest, '\n' + raster.grid.join('\n'));
    expect(raster.digest).toBe(GOLDEN_DIGEST);
  });

  it('会改变版式的改动 → 栅格改变（字符网格对覆盖/换行敏感）', () => {
    // 注意：本栅格每格只记**颜色/占位**，不记字形。因此对栅格敏感的改动是"改变覆盖或换行"的：
    // ① 内容长度变化；② 半角↔全角（宽度变化）。二者都必须让 digest 变。
    const request = { installed_fonts: INSTALLED_CN };
    const render = (text: string): Raster =>
      rasterizeSlide(
        slideWith([textBox(2, 914400, 914400, 4000000, 1200000, text, { font: '宋体' })]),
        request,
        SLIDE_SIZE_4_3,
      );
    const base = render('演示 PptX 2026');
    expect(render('演示 PptX 2026 追加一段更长的文字').digest).not.toBe(base.digest); // 长度变化
    expect(render('演示 Ppt中 2026').digest).not.toBe(base.digest); // 半角 X → 全角 中（宽度变化）
  });

  it('rasterizePresentation 走文稿尺寸；越界页序具名报错', () => {
    const raster = rasterizePresentation(deck(goldenSlide()), { installed_fonts: INSTALLED_CN });
    expect(raster.digest).toBe(rasterizeSlide(goldenSlide(), { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3).digest);
    expect(() => rasterizePresentation(deck(goldenSlide()), { installed_fonts: INSTALLED_CN }, 5)).toThrow(/第 5 页/);
  });
});

// ---------------------------------------------------------------------------
// C. 叠层（z 序）差异
// ---------------------------------------------------------------------------

describe('C. 叠层 / 遮挡', () => {
  it('互换两个纯色矩形的前后顺序 → 重叠格颜色翻转', () => {
    const request = { installed_fonts: INSTALLED_CN };
    const red = () => solidRect(2, 914400, 914400, 4572000, 2743200, 'FF0000');
    const blue = () => solidRect(3, 1828800, 1371600, 4572000, 2743200, '0000FF');

    const redThenBlue = rasterizeSlide(slideWith([red(), blue()]), request, SLIDE_SIZE_4_3);
    const blueThenRed = rasterizeSlide(slideWith([blue(), red()]), request, SLIDE_SIZE_4_3);

    const blueChar = charOf(redThenBlue, (key) => key === 'fill:0000FF');
    const redChar = charOf(blueThenRed, (key) => key === 'fill:FF0000');

    // 重叠区中心一格：前者蓝胜（后画），后者红胜。
    expect(cellAt(redThenBlue, 12, 15)).toBe(blueChar);
    expect(cellAt(blueThenRed, 12, 15)).toBe(redChar);
    expect(redThenBlue.digest).not.toBe(blueThenRed.digest);
  });

  it('图片压住文本框：文本被不透明图片覆盖，layout-check 也报遮挡（两条独立路径一致）', () => {
    const text = () => textBox(2, 914400, 914400, 4000000, 1828800, '会被盖住的文字');
    const pic = () => picture(3, 914400, 914400, 4000000, 1828800);
    const request = { installed_fonts: INSTALLED_CN };

    // 文本在下、图片在上 ⇒ 图片格盖掉文本框。
    const occluded = rasterizeSlide(slideWith([text(), pic()]), request, SLIDE_SIZE_4_3);
    const picChar = charOf(occluded, (key) => key === 'picture');
    expect(cellAt(occluded, 7, 10)).toBe(picChar);

    const findings = checkSlideLayout(slideWith([text(), pic()]), { slide_size: SLIDE_SIZE_4_3 });
    expect(findings.some((f) => f.code === 'occlusion' && f.shape_id === 2)).toBe(true);

    // 文本框在上 ⇒ 同一格变成文本色，且 layout-check 不再报该框被遮。
    const textOnTop = rasterizeSlide(slideWith([pic(), text()]), request, SLIDE_SIZE_4_3);
    const textChar = charOf(textOnTop, (key) => key.startsWith('text:'));
    expect(cellAt(textOnTop, 7, 10)).toBe(textChar);
    const findingsTop = checkSlideLayout(slideWith([pic(), text()]), { slide_size: SLIDE_SIZE_4_3 });
    expect(findingsTop.some((f) => f.code === 'occlusion' && f.shape_id === 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. 溢出差异（与 layout-check 交叉断言）
// ---------------------------------------------------------------------------

describe('D. 溢出差异', () => {
  const LONG = '这是一段很长的中文文本内容，用来把文本框撑到溢出，验证溢出量可被两条独立路径一致地算出来。';

  it('溢出量、可用高、所需高与 layout-check 逐数字一致（宋体口径）', () => {
    const slide = slideWith([textBox(2, 914400, 914400, 3000000, 500000, LONG, { font: '宋体' })]);
    const raster = rasterizeSlide(slide, { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);
    expect(raster.overflows).toHaveLength(1);
    const mine = raster.overflows[0]!;

    const findings = checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3 });
    const theirs = findings.find((f) => f.code === 'text_overflow' && f.shape_id === 2);
    expect(theirs).toBeDefined();
    expect(mine.required_emu).toBe(Number(theirs!.details.required_emu));
    expect(mine.available_emu).toBe(Number(theirs!.details.available_emu));
    expect(mine.overflow_emu).toBe(Number(theirs!.details.overflow_emu));
    expect(mine.overflow_emu).toBeGreaterThan(0);
  });

  it('溢出在栅格中「越出框底」可见：框底之下仍有文本色格子', () => {
    const boxY = 914400;
    const boxCy = 500000;
    const raster = rasterizeSlide(
      slideWith([textBox(2, 914400, boxY, 3000000, boxCy, LONG, { font: '宋体' })]),
      { installed_fonts: INSTALLED_CN },
      SLIDE_SIZE_4_3,
    );
    const textChar = charOf(raster, (key) => key.startsWith('text:'));
    const rowEmu = SLIDE_SIZE_4_3.cy_emu / raster.rows;
    const boxBottomRow = Math.floor((boxY + boxCy) / rowEmu); // 框底所在行
    let spillRows = 0;
    for (let r = boxBottomRow + 1; r < raster.rows; r += 1) {
      if (raster.grid[r]!.includes(textChar)) spillRows += 1;
    }
    expect(spillRows).toBeGreaterThan(0);
  });

  it('短文本不溢出：overflows 为空，框底之下无文本色', () => {
    const raster = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 3000000, 500000, '短', { font: '宋体' })]),
      { installed_fonts: INSTALLED_CN },
      SLIDE_SIZE_4_3,
    );
    expect(raster.overflows).toEqual([]);
  });

  it('反向对照：溢出量随字号放大而变大（同文本、同框）', () => {
    const request = { installed_fonts: INSTALLED_CN };
    const small = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 3000000, 500000, '这是一段中文', { font: '宋体', size_pt: 18 })]),
      request,
      SLIDE_SIZE_4_3,
    );
    const big = rasterizeSlide(
      slideWith([textBox(2, 914400, 914400, 3000000, 500000, '这是一段中文', { font: '宋体', size_pt: 40 })]),
      request,
      SLIDE_SIZE_4_3,
    );
    const smallOverflow = small.overflows[0]?.overflow_emu ?? 0;
    const bigOverflow = big.overflows[0]?.overflow_emu ?? 0;
    expect(bigOverflow).toBeGreaterThan(smallOverflow);
  });
});

// ---------------------------------------------------------------------------
// E. schema 负例
// ---------------------------------------------------------------------------

describe('E. 输入 schema 负例', () => {
  function expectReason(fn: () => unknown, reason: string): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(RasterSchemaError);
      expect((error as RasterSchemaError).reason).toBe(reason);
      return;
    }
    throw new Error(`期望抛出 ${reason}，但没有抛错`);
  }

  it('分辨率 / 页尺寸 / 字号 / 字体清单四条非法输入都具名报错', () => {
    expectReason(
      () => validateRasterRequest({ installed_fonts: ['宋体'], resolution: { cols: 0, rows: 48 } }, SLIDE_SIZE_4_3),
      'invalid_resolution',
    );
    expectReason(
      () => validateRasterRequest({ installed_fonts: ['宋体'], slide_size: { cx_emu: -1, cy_emu: 10 } }, SLIDE_SIZE_4_3),
      'invalid_slide_size',
    );
    expectReason(
      () => validateRasterRequest({ installed_fonts: ['宋体'], default_body_size_pt: 0 }, SLIDE_SIZE_4_3),
      'invalid_body_size',
    );
    expectReason(() => validateRasterRequest({ installed_fonts: [] }, SLIDE_SIZE_4_3), 'invalid_installed_fonts');
    expectReason(
      () => validateRasterRequest({ installed_fonts: ['宋体', '  '] }, SLIDE_SIZE_4_3),
      'invalid_installed_fonts',
    );
  });

  it('合法输入补全默认值', () => {
    const normalized = validateRasterRequest({ installed_fonts: ['宋体'] }, SLIDE_SIZE_4_3);
    expect(normalized.resolution).toEqual({ cols: 64, rows: 48 });
    expect(normalized.default_body_size_pt).toBe(18);
    expect(normalized.slide_size).toEqual(SLIDE_SIZE_4_3);
  });
});
