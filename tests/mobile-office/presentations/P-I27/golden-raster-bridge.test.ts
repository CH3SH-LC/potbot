/**
 * P-I27 · 黄金栅格**桥接验收** —— 独立消费 P-R02 的确定性字体度量 / 字符栅格契约。
 *
 * ## 为什么需要本桥
 *
 * P-R02 交付了 `font-metrics.ts`（字体替代）+ `golden-raster.ts`（字符栅格）并把一份
 * **钉死的黄金摘要**写进自己的用例；但此前**没有任何第二个实现消费它**，摘要因此处于
 * "自证"状态（同一份测试既产生又校验）。本桥做两件 P-R02 自己没有做的事：
 *
 * 1. **第二个夹具实现**：在本文件里**重打**一遍黄金页（形状、坐标、样式逐字段重写，
 *    **不 import** P-R02 的测试夹具），把同一 deck 喂给 P-R02 的栅格器，看它是否复现
 *    同一个钉死摘要。
 * 2. **独立重算摘要**：用 `node:crypto` **直接**对栅格文本取 sha256（不复用栅格器返回的
 *    `digest` 字段，也不复用仓内 `digestBytes`），三者必须相等：
 *    `独立重算 == 栅格器 digest == 钉死常量`。反向对照：换分隔符（`''` 而非 `'\n'`）算出的
 *    摘要**必须不等**——证明摘要确实绑定到"逐行拼接"的栅格文本，不是任意常数。
 *
 * ## 覆盖的契约面（均来自 P-R02 schema/golden-raster 的公开签名）
 *
 * - **钉死摘要复现**：`rasterizeSlide` / `rasterizePresentation` 对重建 deck 给出同一摘要。
 * - **CJK 换行**：长中文在框宽内换行 ⇒ 文本格跨多行；与 `layout-check.ts` 的溢出量**跨实现一致**。
 * - **叠层（z 序）**：互换两个重叠纯色对象的前后顺序 ⇒ 重叠格颜色翻转、digest 变。
 * - **字体替代改变版式且确定性**：装了微软雅黑 vs 只装宋体（触发替代）⇒ digest 不同，
 *   且各自连跑两次逐字符相等。
 *
 * ## 如实登记
 *
 * 本栅格是**字符网格**（coverage/颜色），不是位图 PNG，不是 PowerPoint/WPS/手机渲染截图；
 * `pixel_fidelity_verified` 恒为 `false`。本桥只在本机 vitest 层验证，未上真机、未入 Office。
 */

import { createHash } from 'node:crypto';

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

// 桥接目标：P-R02 的公开契约（只读消费，不改一寸）。
import { rasterizePresentation, rasterizeSlide, RasterError, type Raster } from '../P-R02/golden-raster.js';
import { resolveFont } from '../P-R02/font-metrics.js';

// ---------------------------------------------------------------------------
// 独立夹具（在本文件重打一遍，不从 P-R02 的测试里 import）
// ---------------------------------------------------------------------------

/** 与 P-R02 黄金页同参的设备已装字体：微软雅黑**未装**。 */
const INSTALLED_CN: readonly string[] = ['宋体', '黑体', '等线'];

/** P-R02 钉死的黄金摘要：本桥要独立复现它。 */
const PINNED_GOLDEN_DIGEST = '0e59479359a5fff05f61a5eb8826116bccee2d79e3d20381ad72acfcdc3b4733';

function makeTextBox(
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

function makeSolidRect(
  id: number,
  x: number,
  y: number,
  cx: number,
  cy: number,
  color: string,
): AutoShapeShape {
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

function makePicture(id: number, x: number, y: number, cx: number, cy: number): PictureShape {
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

function slideOf(shapes: readonly Shape[]): Slide {
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

function deckOf(slide: Slide): Presentation {
  return {
    presentation_id: 'p-i27',
    title: 'P-I27',
    format: 'pptx',
    size: SLIDE_SIZE_4_3,
    master: { master_id: 'master1' },
    theme: { theme_id: 'theme1' },
    slides: [slide],
    sections: [],
  };
}

/** 独立重打的黄金页：混合中英文字文本框(宋体 18pt #000000) + 纯色矩形(DDEEFF) + 图片。 */
function goldenSlide(): Slide {
  return slideOf([
    makeTextBox(2, 914400, 548640, 4000000, 1200000, '演示 PptX 2026', {
      size_pt: 18,
      font: '宋体',
      color: '000000',
    }),
    makeSolidRect(3, 5486400, 914400, 2743200, 1828800, 'DDEEFF'),
    makePicture(4, 914400, 3000000, 2286000, 1371600),
  ]);
}

// ---------------------------------------------------------------------------
// 独立摘要重算（不复用栅格器 digest 字段、不复用 digestBytes）
// ---------------------------------------------------------------------------

/** 直接对栅格文本取 sha256（裸小写 hex），与我们期望的"逐行拼接"口径一致。 */
function independentDigest(grid: readonly string[], separator = '\n'): string {
  return createHash('sha256').update(Buffer.from(grid.join(separator), 'utf8')).digest('hex');
}

/** 图例反查：语义键 → 字符。 */
function charOf(raster: Raster, predicate: (key: string) => boolean): string {
  const entry = Object.entries(raster.legend).find(([, key]) => predicate(key));
  if (entry === undefined) throw new Error('图例里找不到该语义键');
  return entry[0];
}

function cellAt(raster: Raster, row: number, col: number): string {
  return raster.grid[row]![col]!;
}

// ---------------------------------------------------------------------------
// A. 钉死摘要：独立重算 + 第二夹具复现
// ---------------------------------------------------------------------------

describe('A. 钉死摘要的独立复现', () => {
  it('第二夹具复现摘要，且独立 sha256(逐行拼接) == 栅格器 digest == 钉死常量', () => {
    const raster = rasterizeSlide(goldenSlide(), { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);

    // 三方对齐：独立重算 / 栅格器自报 / P-R02 钉死常量。
    const recomputed = independentDigest(raster.grid);
    expect(recomputed).toBe(raster.digest);
    expect(recomputed).toBe(PINNED_GOLDEN_DIGEST);

    // 尺寸契约（避免摘要碰巧相等却是别的尺寸）。
    expect(raster.cols).toBe(64);
    expect(raster.rows).toBe(48);
    expect(raster.grid).toHaveLength(48);
    for (const row of raster.grid) expect(row).toHaveLength(64);
  });

  it('反向对照：摘要绑定的是「按 \\n 逐行拼接」，换分隔符必然不同', () => {
    const raster = rasterizeSlide(goldenSlide(), { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);
    // 同一个 grid、不同分隔符 ⇒ 不同文本 ⇒ 不同摘要（证明不是任意常数/自证）。
    expect(independentDigest(raster.grid, '')).not.toBe(PINNED_GOLDEN_DIGEST);
    // 去掉一行的空行也会改变它（长度敏感）。
    expect(independentDigest(raster.grid.slice(1))).not.toBe(PINNED_GOLDEN_DIGEST);
  });

  it('rasterizePresentation 对重建 deck 得到同一钉死摘要', () => {
    const raster = rasterizePresentation(deckOf(goldenSlide()), { installed_fonts: INSTALLED_CN });
    expect(raster.digest).toBe(PINNED_GOLDEN_DIGEST);
    expect(independentDigest(raster.grid)).toBe(PINNED_GOLDEN_DIGEST);
  });

  it('连跑两次逐字符相等：契约确定性（同输入 ⇒ 同栅格 ⇒ 同摘要）', () => {
    const request = { installed_fonts: INSTALLED_CN };
    const first = rasterizeSlide(goldenSlide(), request, SLIDE_SIZE_4_3);
    const second = rasterizeSlide(goldenSlide(), request, SLIDE_SIZE_4_3);
    expect(second.grid).toEqual(first.grid);
    expect(independentDigest(second.grid)).toBe(independentDigest(first.grid));
  });
});

// ---------------------------------------------------------------------------
// B. CJK 换行
// ---------------------------------------------------------------------------

describe('B. CJK 换行（桥接 layout-check 的独立溢出路径）', () => {
  const LONG_CN =
    '这是一段很长的中文文本内容，用来把文本框撑到溢出，验证换行与溢出量可被两条独立路径一致地算出来。';

  it('长中文在框宽内换行 ⇒ 文本格跨多行，且摘要连跑两次一致', () => {
    const slide = slideOf([makeTextBox(2, 914400, 914400, 3000000, 500000, LONG_CN, { font: '宋体' })]);
    const request = { installed_fonts: INSTALLED_CN };
    const raster = rasterizeSlide(slide, request, SLIDE_SIZE_4_3);

    const textChar = charOf(raster, (key) => key.startsWith('text:'));
    const rowsWithText = raster.grid.filter((row) => row.includes(textChar)).length;
    // 单行放不下这么长的中文：必须换成多行。
    expect(rowsWithText).toBeGreaterThan(1);

    // 确定性：同一输入两次完全一致。
    const again = rasterizeSlide(slide, request, SLIDE_SIZE_4_3);
    expect(again.grid).toEqual(raster.grid);
    expect(independentDigest(again.grid)).toBe(independentDigest(raster.grid));
  });

  it('换行导致溢出；溢出量与 layout-check 逐数字一致（跨实现断言）', () => {
    const slide = slideOf([makeTextBox(2, 914400, 914400, 3000000, 500000, LONG_CN, { font: '宋体' })]);
    const raster = rasterizeSlide(slide, { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);

    expect(raster.overflows).toHaveLength(1);
    const mine = raster.overflows[0]!;
    expect(mine.shape_id).toBe(2);
    expect(mine.overflow_emu).toBeGreaterThan(0);

    const findings = checkSlideLayout(slide, { slide_size: SLIDE_SIZE_4_3 });
    const theirs = findings.find((f) => f.code === 'text_overflow' && f.shape_id === 2);
    expect(theirs).toBeDefined();
    expect(mine.required_emu).toBe(Number(theirs!.details.required_emu));
    expect(mine.available_emu).toBe(Number(theirs!.details.available_emu));
    expect(mine.overflow_emu).toBe(Number(theirs!.details.overflow_emu));
  });

  it('长度敏感：加长中文改变换行 ⇒ 摘要改变（栅格确实随内容重排）', () => {
    const render = (text: string): Raster =>
      rasterizeSlide(
        slideOf([makeTextBox(2, 914400, 914400, 4000000, 1200000, text, { font: '宋体' })]),
        { installed_fonts: INSTALLED_CN },
        SLIDE_SIZE_4_3,
      );
    const base = render('演示 PptX 2026');
    const longer = render('演示 PptX 2026 再加一段足够长的中文把这一行挤到换行');
    expect(independentDigest(longer.grid)).not.toBe(independentDigest(base.grid));
  });
});

// ---------------------------------------------------------------------------
// C. 叠层（z 序）
// ---------------------------------------------------------------------------

describe('C. 叠层（z 序）差异', () => {
  it('互换两个重叠纯色对象顺序 ⇒ 重叠格颜色翻转、摘要改变', () => {
    const red = (): AutoShapeShape => makeSolidRect(2, 914400, 914400, 4572000, 2743200, 'FF0000');
    const blue = (): AutoShapeShape => makeSolidRect(3, 1828800, 1371600, 4572000, 2743200, '0000FF');
    const request = { installed_fonts: INSTALLED_CN };

    const redThenBlue = rasterizeSlide(slideOf([red(), blue()]), request, SLIDE_SIZE_4_3);
    const blueThenRed = rasterizeSlide(slideOf([blue(), red()]), request, SLIDE_SIZE_4_3);

    const blueChar = charOf(redThenBlue, (key) => key === 'fill:0000FF');
    const redChar = charOf(blueThenRed, (key) => key === 'fill:FF0000');

    // 重叠中心格：后者压前者。
    expect(cellAt(redThenBlue, 12, 15)).toBe(blueChar);
    expect(cellAt(blueThenRed, 12, 15)).toBe(redChar);
    expect(independentDigest(redThenBlue.grid)).not.toBe(independentDigest(blueThenRed.grid));
  });

  it('文本被后画的图片遮盖 ⇒ 该格为图片；图片在下则露文本', () => {
    const text = (): TextBoxShape => makeTextBox(2, 914400, 914400, 4000000, 1828800, '会被盖住的文字');
    const pic = (): PictureShape => makePicture(3, 914400, 914400, 4000000, 1828800);
    const request = { installed_fonts: INSTALLED_CN };

    const covered = rasterizeSlide(slideOf([text(), pic()]), request, SLIDE_SIZE_4_3);
    const picChar = charOf(covered, (key) => key === 'picture');
    expect(cellAt(covered, 7, 10)).toBe(picChar);

    const exposed = rasterizeSlide(slideOf([pic(), text()]), request, SLIDE_SIZE_4_3);
    const textChar = charOf(exposed, (key) => key.startsWith('text:'));
    expect(cellAt(exposed, 7, 10)).toBe(textChar);

    expect(independentDigest(covered.grid)).not.toBe(independentDigest(exposed.grid));
  });
});

// ---------------------------------------------------------------------------
// D. 字体替代改变版式且确定性
// ---------------------------------------------------------------------------

describe('D. 字体替代改变版式（确定性）', () => {
  const SAMPLE = 'Slide 2026 报告 long latin run';

  it('装了微软雅黑 vs 触发替代到宋体 ⇒ 摘要不同（度量差异改变换行/行高）', () => {
    const slide = slideOf([makeTextBox(2, 914400, 914400, 4000000, 1200000, SAMPLE, { font: '微软雅黑' })]);

    const yahei = rasterizeSlide(slide, { installed_fonts: ['宋体', '微软雅黑'] }, SLIDE_SIZE_4_3);
    const substituted = rasterizeSlide(slide, { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);

    // 装了雅黑 ⇒ 用雅黑度量；未装 ⇒ 替代到宋体。两者度量不同 ⇒ 版式（换行/行高）不同。
    expect(yahei.digest).not.toBe(substituted.digest);
    expect(independentDigest(yahei.grid)).not.toBe(independentDigest(substituted.grid));

    // 替代记录可解释：未装时给出 cjk_fallback。
    expect(substituted.substitutions).toEqual([
      { shape_id: 2, requested: '微软雅黑', resolved: '宋体', reason: 'cjk_fallback' },
    ]);
    // 装了雅黑时无替代。
    expect(yahei.substitutions).toEqual([]);
  });

  it('替代是「度量中立」的：替代到宋体 ⇒ 与直接用宋体逐字符相等', () => {
    const request = { installed_fonts: INSTALLED_CN };
    const direct = rasterizeSlide(
      slideOf([makeTextBox(2, 914400, 914400, 4000000, 1200000, SAMPLE, { font: '宋体' })]),
      request,
      SLIDE_SIZE_4_3,
    );
    const viaSubstitution = rasterizeSlide(
      slideOf([makeTextBox(2, 914400, 914400, 4000000, 1200000, SAMPLE, { font: '微软雅黑' })]),
      request,
      SLIDE_SIZE_4_3,
    );
    expect(viaSubstitution.grid).toEqual(direct.grid);
    expect(independentDigest(viaSubstitution.grid)).toBe(independentDigest(direct.grid));
  });

  it('确定性：同一替代输入连跑两次得到同一摘要', () => {
    const slide = slideOf([makeTextBox(2, 914400, 914400, 4000000, 1200000, SAMPLE, { font: '微软雅黑' })]);
    const request = { installed_fonts: INSTALLED_CN };
    const a = rasterizeSlide(slide, request, SLIDE_SIZE_4_3);
    const b = rasterizeSlide(slide, request, SLIDE_SIZE_4_3);
    expect(a.digest).toBe(b.digest);
    expect(independentDigest(a.grid)).toBe(independentDigest(b.grid));
  });

  it('契约交叉点：解析结果恰为宋体时，resolveFont 的行高为 1.2（与跨实现口径一致）', () => {
    const resolved = resolveFont('微软雅黑', INSTALLED_CN);
    expect(resolved.resolved).toBe('宋体');
    expect(resolved.metrics.line_height).toBeCloseTo(1.2, 6);
    expect(resolved.metrics.cjk_width).toBeCloseTo(1.0, 6);
    expect(resolved.metrics.latin_width).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// E. 保真度边界与错误路径
// ---------------------------------------------------------------------------

describe('E. 保真度边界（不冒充像素）与错误路径', () => {
  it('栅格自报 char_grid，pixel_fidelity_verified 恒 false', () => {
    const raster = rasterizeSlide(goldenSlide(), { installed_fonts: INSTALLED_CN }, SLIDE_SIZE_4_3);
    expect(raster.fidelity).toBe('char_grid');
    expect(raster.pixel_fidelity_verified).toBe(false);
  });

  it('越界页序 ⇒ 具名 RasterError(unknown_slide)，不静默返回空页', () => {
    const deck = deckOf(goldenSlide());
    try {
      rasterizePresentation(deck, { installed_fonts: INSTALLED_CN }, 5);
      throw new Error('期望抛出 RasterError，但没有抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(RasterError);
      expect((error as RasterError).reason).toBe('unknown_slide');
    }
  });
});
