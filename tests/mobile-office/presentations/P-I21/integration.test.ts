/**
 * P-I21 · **真实字形端口 / 旋转包围盒 / 合并单元格** 定向验收。
 *
 * ## 判据独立于实现
 *
 * - 「真实汉字笔画」用手写的 `中` 点阵（本文件自带）注入端口判定像素，不复用被实现；
 * - 「旋转后的包围盒」由本文件**自己**算四角旋转取 AABB，不复用 `rotatedBoxSizePx`
 *   （只把它当交叉断言点）；
 * - 「合并单元格画成一格」用**边界线上有没有网格线像素**判定（合并行的内部竖线必须消失，
 *   非合并行的同一竖线必须存在），而不是看诊断码；
 * - 字体前进宽度与 P-R02 的 `fontCharWidthPt` **逐数字交叉核对**（消费同一份度量契约）。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 未覆盖码点 ⇒ 必须 `substituted: true`（**不假装**有真字形）；
 * - `substitute: false` ⇒ 缺字返回 `null`（不静默画替代）；
 * - 旋转 0° ⇒ 墨不越出原始框；旋转 45° ⇒ 墨存在原始框之外（证明真的转了）；
 * - 旋转矩形 AABB 的四角必须空白（证明不是把整个 AABB 涂满）。
 */

import { describe, expect, it } from 'vitest';

import {
  createBuiltinGlyphPort,
  createFixedGlyphPort,
  createInjectedGlyphPort,
  renderSlide,
  rotatedBoxSizePx,
  type Rgb,
} from '../../../../src/mobile-plugins/presentations/rendering/index.js';
import {
  SLIDE_SIZE_16_9,
  literalText,
  transform,
  type Presentation,
  type Shape,
  type Transform,
} from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import { addTable, mergeCells, setCellText } from '../../../../src/presentations/tables.js';
import {
  FONT_CATALOG,
  fontCharWidthPt,
  type FontMetrics,
} from '../P-R02/font-metrics.js';

// ---------------------------------------------------------------------------
// 独立工具（不看实现）
// ---------------------------------------------------------------------------

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const RENDER = { slide_size: SLIDE_SIZE_16_9, width_px: 640 } as const;

/** 手写的**真实**汉字点阵（16×16）：中。 */
const ZHONG_16: readonly string[] = [
  '.......##.......',
  '.......##.......',
  '.......##.......',
  '...##########...',
  '...#....##..#...',
  '...#....##..#...',
  '...#....##..#...',
  '...##########...',
  '...#....##..#...',
  '...#....##..#...',
  '...#....##..#...',
  '...##########...',
  '.......##.......',
  '.......##.......',
  '.......##.......',
  '.......##.......',
];

function blankPresentation(id: string): Presentation {
  return emptyPresentation(id, 'P-I21');
}

function withSlide(presentation: Presentation): { presentation: Presentation; slideId: number } {
  const added = addSlide(presentation);
  return { presentation: added.presentation, slideId: added.slide_id };
}

/** 独立算一个 transform 的像素框。 */
function boxPx(t: Transform, widthPx: number): { x: number; y: number; w: number; h: number } {
  const sx = widthPx / SLIDE_SIZE_16_9.cx_emu;
  const sy = widthPx / SLIDE_SIZE_16_9.cx_emu; // 16:9 等比如 P09 一致（用同一 x 缩放）
  return { x: t.x_emu * sx, y: t.y_emu * sy, w: t.cx_emu * sx, h: t.cy_emu * sy };
}

const isRed = (p: Rgb | null): boolean => p !== null && p.r > 180 && p.g < 90 && p.b < 90;
const isGray = (p: Rgb | null): boolean =>
  p !== null && Math.abs(p.r - 0x88) <= 40 && Math.abs(p.g - 0x88) <= 40 && Math.abs(p.b - 0x88) <= 40;

/** 独立算一批像素点的旋转 AABB（输入为主画布坐标的四角）。 */
function rotatedAabb(
  box: { x: number; y: number; w: number; h: number },
  deg: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ]) {
    const rx = cx + ((x ?? 0) - cx) * cos - ((y ?? 0) - cy) * sin;
    const ry = cy + ((x ?? 0) - cx) * sin + ((y ?? 0) - cy) * cos;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// 1. 可注入字形端口：真机真字形优先，缺字确定性替代；前进宽度取自度量契约
// ---------------------------------------------------------------------------

describe('P-I21 可注入 GlyphRasterPort', () => {
  const realSource = createFixedGlyphPort({ 中: ZHONG_16 }, { font: 'cjk16' });

  function metricsOf(family: string): FontMetrics {
    const entry = FONT_CATALOG.find((m) => m.family === family);
    if (entry === undefined) throw new Error(`字体表缺少 ${family}`);
    return entry;
  }

  it('注入的 realSource 覆盖到「中」⇒ 返回真字形（substituted=false）且笔画落到覆盖度', () => {
    const port = createInjectedGlyphPort({ source: realSource, metrics: FONT_CATALOG, fallbackFamily: '宋体' });
    const glyph = port.rasterize({ font: 'cjk16', codePoint: 0x4e2d, sizePx: 16 });
    expect(glyph).not.toBeNull();
    expect(glyph?.substituted).toBe(false);
    expect(glyph?.font).toBe('cjk16');
    // 「中」第 3 行是 `...##########...`：中段 10 列有墨、左右各 3 列空。
    const row = 3;
    const cols = [...glyph!.coverage.subarray(row * glyph!.widthPx, (row + 1) * glyph!.widthPx)];
    expect(cols.slice(3, 13).every((c) => c === 255)).toBe(true);
    expect(cols.slice(0, 3).every((c) => c === 0)).toBe(true);
    expect(cols.slice(13).every((c) => c === 0)).toBe(true);
    // 且确有墨（不是空白字形冒充）。
    expect(cols.some((c) => c > 0)).toBe(true);
  });

  it('realSource 未覆盖的码点 ⇒ 落回确定性替代（substituted=true，font=替代字体）', () => {
    const port = createInjectedGlyphPort({ source: realSource, metrics: FONT_CATALOG, fallbackFamily: '宋体' });
    const glyph = port.rasterize({ font: '宋体', codePoint: 0x6587, sizePx: 16 }); // 文
    expect(glyph).not.toBeNull();
    expect(glyph?.substituted).toBe(true);
    expect(glyph?.font).toBe('宋体');
    // 同一码点两次替代必须逐字节相同（确定性）。
    const again = port.rasterize({ font: '宋体', codePoint: 0x6587, sizePx: 16 });
    expect([...(again?.coverage ?? [])]).toEqual([...glyph!.coverage]);
  });

  it('前进宽度消费 P-R02 度量契约，与 fontCharWidthPt 逐数字一致', () => {
    const port = createInjectedGlyphPort({ source: realSource, metrics: FONT_CATALOG, fallbackFamily: '宋体' });
    const song = metricsOf('宋体');
    const sizePx = 24;
    // 已被真字形覆盖的「中」
    const zhong = port.rasterize({ font: 'cjk16', codePoint: 0x4e2d, sizePx });
    expect(zhong?.advancePx).toBe(Math.round(fontCharWidthPt('中', sizePx, song))); // 1.0 × 24
    // 未被覆盖的 ASCII（走替代），但宽度仍按度量表 latin 宽度
    const ascii = port.rasterize({ font: '宋体', codePoint: 0x41, sizePx }); // A
    expect(ascii?.advancePx).toBe(Math.round(fontCharWidthPt('A', sizePx, song))); // 0.5 × 24
    // 空白
    const space = port.rasterize({ font: '宋体', codePoint: 0x20, sizePx });
    expect(space?.advancePx).toBe(Math.round(fontCharWidthPt(' ', sizePx, song))); // 0.25 × 24
  });

  it('substitute=false ⇒ 缺字返回 null（不静默画替代）', () => {
    const port = createInjectedGlyphPort({ source: realSource, metrics: FONT_CATALOG, substitute: false });
    expect(port.hasGlyph('宋体', 0x6587)).toBe(false);
    expect(port.rasterize({ font: '宋体', codePoint: 0x6587, sizePx: 16 })).toBeNull();
    // 真字形仍可用。
    expect(port.rasterize({ font: 'cjk16', codePoint: 0x4e2d, sizePx: 16 })?.substituted).toBe(false);
  });

  it('渲染闭环：注入端口下「中」不报替代且真有墨；内置端口必须报替代', () => {
    const shape: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Han',
      transform: transform(0, 0, 6096000, 2743200),
      text: literalText('中', { size_pt: 18 }),
    };

    const { presentation: base, slideId } = withSlide(blankPresentation('p-inj'));
    const withHan = addShape(base, slideId, shape);
    const slide = withHan.slides[0]!;

    const injected = createInjectedGlyphPort({ source: realSource, metrics: FONT_CATALOG, fallbackFamily: '宋体' });
    const good = renderSlide(slide, 0, { ...RENDER, glyph_port: injected, default_font: 'cjk16' });
    expect(good.diagnostics.find((d) => d.code === 'glyph_substituted')).toBeUndefined();
    expect(good.canvas.countNonBackground(WHITE)).toBeGreaterThan(0);

    const builtin = renderSlide(slide, 0, { ...RENDER, glyph_port: createBuiltinGlyphPort(), default_font: 'mono8' });
    expect(builtin.diagnostics.find((d) => d.code === 'glyph_substituted')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 旋转感知包围盒
// ---------------------------------------------------------------------------

describe('P-I21 旋转感知包围盒', () => {
  function slideWithRotatedRect(deg: number): { slide: ReturnType<typeof withSlide>['presentation']['slides'][number]; t: Transform } {
    const t = transform(2000000, 1000000, 3000000, 1500000, { rotation_deg: deg });
    const shape: Shape = {
      kind: 'auto_shape',
      shape_id: 2,
      name: 'Rot',
      transform: t,
      preset: 'rect',
      text: null,
      fill: { kind: 'solid', color: 'FF0000' },
      outline: null,
    };
    const { presentation, slideId } = withSlide(blankPresentation('p-rot'));
    const built = addShape(presentation, slideId, shape);
    return { slide: built.slides[0]!, t };
  }

  function redPixels(canvas: ReturnType<typeof renderSlide>['canvas']): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (isRed(canvas.getPixel(x, y))) out.push({ x, y });
      }
    }
    return out;
  }

  it('45° 旋转：墨全部落在旋转后的 AABB 内，且越出原始框、AABB 四角空白', () => {
    const { slide, t } = slideWithRotatedRect(45);
    const canvas = renderSlide(slide, 0, RENDER).canvas;
    const box = boxPx(t, RENDER.width_px);
    const aabb = rotatedAabb(box, 45);
    const reds = redPixels(canvas);
    expect(reds.length).toBeGreaterThan(0);

    // (a) 墨不越出旋转 AABB（±2px 容差）。
    for (const p of reds) {
      expect(p.x).toBeGreaterThanOrEqual(aabb.minX - 2);
      expect(p.x).toBeLessThanOrEqual(aabb.maxX + 2);
      expect(p.y).toBeGreaterThanOrEqual(aabb.minY - 2);
      expect(p.y).toBeLessThanOrEqual(aabb.maxY + 2);
    }

    // (b) 墨确实越出了原始（未旋转）框 —— 证明真的旋转了，而不是把整框涂满。
    const outsideOriginal = reds.filter(
      (p) => p.x < box.x - 1 || p.x > box.x + box.w + 1 || p.y < box.y - 1 || p.y > box.y + box.h + 1,
    );
    expect(outsideOriginal.length).toBeGreaterThan(0);

    // (c) 旋转矩形 AABB 的四角（对角菱形之外）必须空白 —— 证明不是涂满 AABB。
    let cornerInk = 0;
    for (const p of reds) {
      const nearLeft = Math.abs(p.x - aabb.minX) <= 4 || Math.abs(p.x - aabb.maxX) <= 4;
      const nearTop = Math.abs(p.y - aabb.minY) <= 4 || Math.abs(p.y - aabb.maxY) <= 4;
      if (nearLeft && nearTop) cornerInk += 1;
    }
    expect(cornerInk).toBe(0);

    // (d) 交叉断言：导出的包围盒尺寸 == 独立算的 AABB 尺寸。
    const size = rotatedBoxSizePx(box.w, box.h, 45);
    expect(Math.abs(size.w - (aabb.maxX - aabb.minX))).toBeLessThan(1);
    expect(Math.abs(size.h - (aabb.maxY - aabb.minY))).toBeLessThan(1);
  });

  it('反向对照：0° 时墨不越出原始框', () => {
    const { slide, t } = slideWithRotatedRect(0);
    const canvas = renderSlide(slide, 0, RENDER).canvas;
    const box = boxPx(t, RENDER.width_px);
    const reds = redPixels(canvas);
    expect(reds.length).toBeGreaterThan(0);
    const outside = reds.filter(
      (p) => p.x < box.x - 1 || p.x > box.x + box.w + 1 || p.y < box.y - 1 || p.y > box.y + box.h + 1,
    );
    expect(outside.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 合并单元格渲染
// ---------------------------------------------------------------------------

describe('P-I21 合并单元格渲染', () => {
  function buildMergedTable(): { presentation: Presentation; slideId: number; shapeId: number; t: Transform } {
    const { presentation: base, slideId } = withSlide(blankPresentation('p-merge'));
    const t = transform(914400, 914400, 6096000, 2743200);
    const added = addTable(base, slideId, {
      transform: t,
      rows: 2,
      columns: 2,
      column_width_emu: 3048000,
    });
    const merged = mergeCells(added.presentation, slideId, added.shape_id, {
      row: 0,
      col: 0,
      row_span: 1,
      col_span: 2,
    });
    return { presentation: merged, slideId, shapeId: added.shape_id, t };
  }

  it('合并行内部竖线消失、非合并行同一竖线存在，并发出合并诊断', () => {
    const { presentation, t } = buildMergedTable();
    const slide = presentation.slides[0]!;
    const canvas = renderSlide(slide, 0, RENDER).canvas;
    const box = boxPx(t, RENDER.width_px);
    const colW = box.w / 2;
    const rowH = box.h / 2;
    const boundaryX = Math.round(box.x + colW);

    // 非合并行（第 1 行）内部竖线必须存在。
    let grayRow1 = 0;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let y = Math.round(box.y + rowH) + 3; y < Math.round(box.y + 2 * rowH) - 3; y += 1) {
        if (isGray(canvas.getPixel(boundaryX + dx, y))) grayRow1 += 1;
      }
    }
    expect(grayRow1).toBeGreaterThan(0);

    // 合并行（第 0 行）内部竖线必须消失（画成一格）。
    let grayRow0 = 0;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let y = Math.round(box.y) + 3; y < Math.round(box.y + rowH) - 3; y += 1) {
        if (isGray(canvas.getPixel(boundaryX + dx, y))) grayRow0 += 1;
      }
    }
    expect(grayRow0).toBe(0);

    const mergeDiag = renderSlide(slide, 0, RENDER).diagnostics.find((d) => d.code === 'table_merge_rendered');
    expect(mergeDiag).toBeDefined();
    expect(mergeDiag?.details.col_span).toBe(2);
  });

  it('合并格内文字按整块合并区宽度排版（单行跨过原内部列边界）', () => {
    const { presentation, slideId, shapeId, t } = buildMergedTable();
    // 一段 ASCII（mono8 真实字形）：宽度 48×5px=240px，单列放不下（会折行），合并区（310px）放得下。
    const withText = setCellText(presentation, slideId, shapeId, 0, 0, literalText('M'.repeat(48)));
    const slide = withText.slides[0]!;
    const canvas = renderSlide(slide, 0, RENDER).canvas;
    const box = boxPx(t, RENDER.width_px);

    // 若把合并格当成未合并（只用第 0 列宽 ~150px 排版）时，这一行的墨不会超过 x≈210；
    // 用整块合并区宽度排版则单行墨一直铺到 ~290。故取 x>240 有墨作判据。
    let inkFarRight = 0;
    for (let y = Math.round(box.y) + 3; y < Math.round(box.y + box.h / 2) - 3; y += 1) {
      for (let x = 240; x < Math.round(box.x + box.w) - 1; x += 1) {
        const p = canvas.getPixel(x, y);
        if (p !== null && p.r < 100 && p.g < 100 && p.b < 100) inkFarRight += 1;
      }
    }
    expect(inkFarRight).toBeGreaterThan(0);
  });
});
