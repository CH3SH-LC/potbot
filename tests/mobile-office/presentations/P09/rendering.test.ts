/**
 * P09 · **真实像素渲染**（PPT-13/15）定向验收。
 *
 * ## 判据独立于实现
 *
 * - PNG 用测试自带的 chunk 解析 + `zlib.inflateSync` **独立解出扫描行**再与画布像素比对，
 *   不复用被 `decodePng`；
 * - CRC32 用公开已知向量（`"123456789"` → `0xCBF43926`）核对，不拿实现算实现；
 * - 汉字笔画是否可见，用**注入的真实字形位图**（本文件手写的 `中` 点阵）判定像素。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 空幻灯片 ⇒ `ink_pixels === 0`（不会凭空有墨）；
 * - 缺媒体图片 ⇒ `missing_media` 且画成带叉占位（不是悄悄跳过，也不是假图）；
 * - 非 ASCII 用内置端口 ⇒ 必须报 `glyph_substituted`（**不假装**画出中文）；
 * - 长文本 ⇒ 溢出；短文本 ⇒ 不溢出（不同内容长度结论不同）；
 * - 未与外部渲染器比对 ⇒ `external_visual_match_verified === false`。
 */

import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  RasterCanvas,
  bitmapFromGlyphRows,
  createBuiltinGlyphPort,
  createFixedGlyphPort,
  crc32,
  decodePng,
  encodePng,
  isPng,
  layoutParagraphs,
  renderPresentationToPngs,
  renderSlideToPng,
  renderSlide,
} from '../../../../src/mobile-plugins/presentations/rendering/index.js';
import {
  buildVisualPreview,
  createNativeSlideRasterPort,
  exportPresentationImages,
  exportPresentationImagesNative,
  exportPresentationPdf,
  exportPresentationPdfVisual,
  reopenEditablePptx,
} from '../../../../src/presentations/export-handoff.js';
import {
  checkSlideLayoutRendered,
  renderedTextHeightEmu,
} from '../../../../src/presentations/layout-check.js';
import {
  SLIDE_SIZE_16_9,
  literalText,
  transform,
  type Presentation,
  type Shape,
  type Slide,
} from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';

// ---------------------------------------------------------------------------
// 独立工具（不看实现）
// ---------------------------------------------------------------------------

interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
}

/** 独立解析 PNG 块（不用被 decodePng）。 */
function chunksOf(png: Uint8Array): PngChunk[] {
  const buf = Buffer.from(png);
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data: Buffer.from(data) });
    offset += 12 + length;
  }
  return chunks;
}

/** 独立解出 PNG 的首行原始像素（filter 必须为 0 = None，因为本编码器每行都用 None）。 */
function firstRowOfPng(png: Uint8Array, width: number, channels: 3 | 4): number[] {
  const chunks = chunksOf(png);
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  expect(raw[0]).toBe(0); // filter = None
  const stride = width * channels;
  return [...raw.subarray(1, 1 + stride)];
}

function blankPresentation(id: string): Presentation {
  return emptyPresentation(id, '像素测试');
}

function withSlide(presentation: Presentation): { presentation: Presentation; slideId: number } {
  const added = addSlide(presentation);
  return { presentation: added.presentation, slideId: added.slide_id };
}

const RENDER = { slide_size: SLIDE_SIZE_16_9, width_px: 640 };

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
  '...#....##..#...',
  '...#....##..#...',
  '...##########...',
  '.......##.......',
  '.......##.......',
];

// ---------------------------------------------------------------------------
// 1. PNG 编解码（真实字节）
// ---------------------------------------------------------------------------

describe('P09 PNG：真实编码 / 解码 / CRC', () => {
  it('CRC32 命中公开已知向量', () => {
    expect(crc32(Buffer.from('123456789', 'latin1'))).toBe(0xcbf43926);
  });

  it('编码 → 独立解出扫描行 → 逐像素一致', () => {
    const data = new Uint8Array(2 * 2 * 3);
    data.set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const png = encodePng({ width: 2, height: 2, channels: 3, data });
    expect(isPng(png)).toBe(true);

    const chunks = chunksOf(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks[0]?.data.readUInt32BE(0)).toBe(2); // width
    expect(chunks[0]?.data.readUInt8(9)).toBe(2); // color type 2 = RGB
    // 独立 inflate 出的第一行 = filter 0 + 前两个像素
    expect(firstRowOfPng(png, 2, 3)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('解码回来与原像素一致；CRC 被破坏则抛 bad_crc', () => {
    const data = new Uint8Array(3 * 1 * 3);
    data.set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const png = encodePng({ width: 3, height: 1, channels: 3, data });
    const round = decodePng(png);
    expect([...round.data]).toEqual([...data]);
    expect(round.channels).toBe(3);

    const broken = Buffer.from(png);
    broken[20] = (broken[20] ?? 0) ^ 0xff; // 踩坏 IDAT 数据 → CRC 不符
    expect(() => decodePng(broken)).toThrowError(/CRC/);
  });

  it('长度不符的位图编码即抛（不产半张图）', () => {
    expect(() => encodePng({ width: 2, height: 2, channels: 3, data: new Uint8Array(3) })).toThrowError();
  });
});

// ---------------------------------------------------------------------------
// 2. 画布：叠层与裁剪
// ---------------------------------------------------------------------------

describe('P09 画布：后画盖先画，越界被裁剪', () => {
  it('叠层：重叠处是上层颜色，非重叠处保留下层颜色', () => {
    const canvas = new RasterCanvas(20, 20, { r: 255, g: 255, b: 255 });
    canvas.fillRect(0, 0, 20, 20, { r: 200, g: 0, b: 0 }); // 底：红
    canvas.fillRect(10, 10, 10, 10, { r: 0, g: 0, b: 200 }); // 上：蓝
    expect(canvas.getPixel(5, 5)).toEqual({ r: 200, g: 0, b: 0 });
    expect(canvas.getPixel(15, 15)).toEqual({ r: 0, g: 0, b: 200 });
    expect(canvas.getPixel(9, 9)).toEqual({ r: 200, g: 0, b: 0 });
  });

  it('越界写入被裁剪，不抛也不踩坏', () => {
    const canvas = new RasterCanvas(8, 8, { r: 0, g: 0, b: 0 });
    canvas.fillRect(-5, -5, 6, 6, { r: 255, g: 255, b: 255 });
    expect(canvas.getPixel(0, 0)).toEqual({ r: 255, g: 255, b: 255 });
    expect(canvas.getPixel(7, 7)).toEqual({ r: 0, g: 0, b: 0 });
    expect(canvas.getPixel(-1, -1)).toBeNull();
    expect(canvas.countNonBackground({ r: 0, g: 0, b: 0 })).toBe(1);
  });

  it('alpha 合成：半透明盖在底色上按比例混合', () => {
    const canvas = new RasterCanvas(1, 1, { r: 0, g: 0, b: 0 });
    canvas.setPixel(0, 0, { r: 255, g: 255, b: 255 }, 0.5);
    const px = canvas.getPixel(0, 0);
    expect(px?.r).toBeGreaterThan(120);
    expect(px?.r).toBeLessThan(136);
  });
});

// ---------------------------------------------------------------------------
// 3. 字形端口与断行
// ---------------------------------------------------------------------------

describe('P09 字形与断行', () => {
  it('内置端口：ASCII 是真实字形（非替代），非 ASCII 是替代字形', () => {
    const port = createBuiltinGlyphPort();
    const a = port.rasterize({ font: 'mono8', codePoint: 0x41, sizePx: 16 }); // 'A'
    expect(a).not.toBeNull();
    expect(a?.substituted).toBe(false);
    expect(a?.coverage.some((v) => v > 0)).toBe(true);

    const han = port.rasterize({ font: 'mono8', codePoint: 0x4e2d, sizePx: 16 }); // 中
    expect(han?.substituted).toBe(true);
    expect(han?.coverage.some((v) => v > 0)).toBe(true);
  });

  it('bitmapFromGlyphRows：真实点阵逐像素成比例（宽=高，正方形）', () => {
    const glyph = bitmapFromGlyphRows(ZHONG_16, 16);
    expect(glyph.widthPx).toBe(16);
    expect(glyph.heightPx).toBe(16);
    expect(glyph.substituted).toBe(false);
    // 第 0 行的第 7、8 列有墨（中 的竖）
    expect(glyph.coverage[0 * 16 + 7]).toBe(255);
    expect(glyph.coverage[0 * 16 + 0]).toBe(0);
  });

  it('长中文按字形宽度断成多行；内容越长行数越多', () => {
    const port = createBuiltinGlyphPort();
    const make = (text: string) =>
      layoutParagraphs([{ alignment: 'left', runs: [{ text, font: 'mono8', sizePx: 16 }] }], {
        glyphPort: port,
        maxWidthPx: 160,
      });
    const short = make('中文');
    const long = make('中文长文本用于验证断行中文长文本用于验证断行中文长文本用于验证断行');
    expect(short.lines).toHaveLength(1);
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.heightPx).toBeGreaterThan(short.heightPx);
    // 每行都在宽度约束内（硬断除外，这里没有不可断长词）
    for (const line of long.lines) expect(line.widthPx).toBeLessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// 4. renderSlideToPng：文本 / 图片 / 图表 / 叠层 / 反向
// ---------------------------------------------------------------------------

function slideWithText(text: string, box = { cx: 5486400, cy: 1371600 }): Slide {
  const { presentation, slideId } = withSlide(blankPresentation('p1'));
  const shape: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: 'Title',
    transform: transform(914400, 914400, box.cx, box.cy),
    text: literalText(text, { size_pt: 18 }),
  };
  const built = addShape(presentation, slideId, shape);
  return built.slides[0]!;
}

describe('P09 renderSlideToPng：真实像素', () => {
  it('中文长文：产出合法 PNG、有墨，并如实报 glyph_substituted', () => {
    const slide = slideWithText('中文长文本用于验证像素输出中文长文本用于验证像素输出中文长文本');
    const result = renderSlideToPng(slide, 0, RENDER);
    expect(isPng(result.png)).toBe(true);
    expect(result.ink_pixels).toBeGreaterThan(0);
    const substituted = result.diagnostics.find((d) => d.code === 'glyph_substituted');
    expect(substituted).toBeDefined();
    expect(substituted?.severity).toBe('warning');
  });

  it('注入真实字形端口：不报替代，且汉字笔画真的落到像素', () => {
    const port = createFixedGlyphPort({ 中: ZHONG_16 }, { font: 'cjk16' });
    const { presentation, slideId } = withSlide(blankPresentation('p2'));
    const built = addShape(presentation, slideId, {
      kind: 'text_box',
      shape_id: 2,
      name: 'Han',
      transform: transform(0, 0, 6096000, 2743200),
      text: literalText('中', { size_pt: 18 }),
    } satisfies Shape);
    const slide = built.slides[0]!;

    const result = renderSlide(slide, 0, { ...RENDER, glyph_port: port, default_font: 'cjk16' });
    expect(result.diagnostics.find((d) => d.code === 'glyph_substituted')).toBeUndefined();
    expect(result.canvas.countNonBackground({ r: 255, g: 255, b: 255 })).toBeGreaterThan(0);

    // 计算字形单元左上角（单字符、offset 0）：inset 与 scale 与实现同式但独立算出。
    const scale = 640 / SLIDE_SIZE_16_9.cx_emu;
    const cellX = Math.round(91440 * scale);
    const cellY = Math.round(45720 * scale);
    const sizePx = Math.round(18 * 12700 * scale);
    // 中 的竖在 col 7..8、行 0..15；取单元中心附近应有墨。
    const cx = cellX + Math.round((8 / 16) * sizePx);
    const cy = cellY + Math.round((8 / 16) * sizePx);
    let dark = false;
    for (let dy = -1; dy <= 1 && !dark; dy += 1) {
      for (let dx = -1; dx <= 1 && !dark; dx += 1) {
        const px = result.canvas.getPixel(cx + dx, cy + dy);
        if (px !== null && px.r < 128) dark = true;
      }
    }
    expect(dark).toBe(true);
    // 单元左上角应无墨（中 的四角是空的）。
    const corner = result.canvas.getPixel(cellX + 1, cellY + 1);
    expect(corner?.r).toBeGreaterThan(200);
  });

  it('图片：真字节被解码并贴到像素（中心是图片颜色）', () => {
    const imgData = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i += 1) imgData.set([10, 200, 30], i * 3);
    const imgPng = encodePng({ width: 4, height: 4, channels: 3, data: imgData });

    const { presentation, slideId } = withSlide(blankPresentation('p3'));
    const built = addShape(presentation, slideId, {
      kind: 'picture',
      shape_id: 2,
      name: 'Pic',
      transform: transform(914400, 914400, 2743200, 2743200),
      media_path: 'ppt/media/image1.png',
      alt_text: 'swatch',
      crop: null,
    } satisfies Shape);
    const slide = built.slides[0]!;

    const result = renderSlide(slide, 0, { ...RENDER, media: [{ path: 'ppt/media/image1.png', bytes: imgPng }] });
    expect(result.diagnostics.find((d) => d.code === 'missing_media')).toBeUndefined();
    // 图片矩形中心
    const scale = 640 / SLIDE_SIZE_16_9.cx_emu;
    const px = result.canvas.getPixel(Math.round((914400 + 1371600) * scale), Math.round((914400 + 1371600) * scale));
    expect(px).toEqual({ r: 10, g: 200, b: 30 });
  });

  it('反向：缺媒体 ⇒ missing_media（error），并画带叉占位而非静默跳过', () => {
    const { presentation, slideId } = withSlide(blankPresentation('p4'));
    const built = addShape(presentation, slideId, {
      kind: 'picture',
      shape_id: 2,
      name: 'Pic',
      transform: transform(914400, 914400, 2743200, 2743200),
      media_path: 'ppt/media/missing.png',
      alt_text: '',
      crop: null,
    } satisfies Shape);
    const result = renderSlide(built.slides[0]!, 0, RENDER);
    const missing = result.diagnostics.find((d) => d.code === 'missing_media');
    expect(missing?.severity).toBe('error');
    // 占位底是浅灰 0xEE（取一个不在两条对角叉线上的点）
    const scale = 640 / SLIDE_SIZE_16_9.cx_emu;
    const px = result.canvas.getPixel(
      Math.round((914400 + 0.15 * 2743200) * scale),
      Math.round((914400 + 0.5 * 2743200) * scale),
    );
    expect(px).toEqual({ r: 0xee, g: 0xee, b: 0xee });
  });

  it('图表：柱状图真的画出调色板颜色的柱', () => {
    const { presentation, slideId } = withSlide(blankPresentation('p5'));
    const built = addShape(presentation, slideId, {
      kind: 'chart',
      shape_id: 2,
      name: 'Chart',
      transform: transform(914400, 914400, 5486400, 3657600),
      chart: { chart_type: 'bar', categories: ['A', 'B'], series: [{ name: 's', values: [3, 7] }], title: null },
    } satisfies Shape);
    const result = renderSlide(built.slides[0]!, 0, RENDER);
    let found = false;
    const target = { r: 0x2b, g: 0x6c, b: 0xb0 };
    for (let y = 0; y < result.height_px && !found; y += 1) {
      for (let x = 0; x < result.width_px && !found; x += 1) {
        const px = result.canvas.getPixel(x, y);
        if (px !== null && px.r === target.r && px.g === target.g && px.b === target.b) found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('叠层：上层自选图形盖住下层', () => {
    const { presentation, slideId } = withSlide(blankPresentation('p6'));
    let built = addShape(presentation, slideId, {
      kind: 'auto_shape',
      shape_id: 2,
      name: 'base',
      transform: transform(0, 0, 4572000, 4572000),
      preset: 'rect',
      text: null,
      fill: { kind: 'solid', color: 'C00000' },
      outline: null,
    } satisfies Shape);
    built = addShape(built, slideId, {
      kind: 'auto_shape',
      shape_id: 3,
      name: 'top',
      transform: transform(1000000, 1000000, 2000000, 2000000),
      preset: 'rect',
      text: null,
      fill: { kind: 'solid', color: '0000C0' },
      outline: null,
    } satisfies Shape);
    const result = renderSlide(built.slides[0]!, 0, RENDER);
    const scale = 640 / SLIDE_SIZE_16_9.cx_emu;
    expect(result.canvas.getPixel(Math.round(2000000 * scale), Math.round(2000000 * scale))).toEqual({ r: 0, g: 0, b: 0xc0 });
    expect(result.canvas.getPixel(Math.round(200000 * scale), Math.round(200000 * scale))).toEqual({ r: 0xc0, g: 0, b: 0 });
  });

  it('反向：空幻灯片 ink_pixels === 0（不凭空有墨）', () => {
    const { presentation, slideId } = withSlide(blankPresentation('p7'));
    void slideId;
    const result = renderSlideToPng(presentation.slides[0]!, 0, RENDER);
    expect(result.ink_pixels).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 接入 export-handoff：视觉预览 / 图片 / 视觉 PDF
// ---------------------------------------------------------------------------

function deck(): Presentation {
  let presentation = blankPresentation('deck');
  const added = addSlide(presentation);
  presentation = added.presentation;
  presentation = addShape(presentation, added.slide_id, {
    kind: 'text_box',
    shape_id: 2,
    name: 'Title',
    transform: transform(914400, 914400, 5486400, 1371600),
    text: literalText('季度汇报：中文长标题测试文本', { size_pt: 24 }),
  });
  return presentation;
}

describe('P09 接入 export-handoff：真实像素预览与 PDF', () => {
  it('buildVisualPreview：fidelity=raster_png、每页 PNG 合法、有墨、外部比对未做', () => {
    const preview = buildVisualPreview(deck(), { width_px: 640 });
    expect(preview.fidelity).toBe('raster_png');
    expect(preview.pixels_are_real).toBe(true);
    expect(preview.external_visual_match_verified).toBe(false);
    expect(preview.slide_count).toBe(1);
    const slide = preview.slides[0]!;
    expect(isPng(slide.png)).toBe(true);
    expect(slide.ink_pixels).toBeGreaterThan(0);
    expect(preview.unverified.length).toBeGreaterThan(0);
  });

  it('exportPresentationImagesNative：每页出 PNG（取代"无端口 not_ready"）', async () => {
    const result = await exportPresentationImagesNative(deck(), { width_px: 320 });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.image.mime).toBe('image/png');
    expect(isPng(result.images[0]!.image.bytes)).toBe(true);
  });

  it('createNativeSlideRasterPort 可直接喂给 exportPresentationImages', async () => {
    const port = createNativeSlideRasterPort(SLIDE_SIZE_16_9);
    const result = await exportPresentationImages(deck(), port, { width_px: 256 });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.images[0]?.image.width_px).toBe(256);
  });

  it('视觉 PDF：每页嵌入真实位图（/Subtype /Image + /FlateDecode），同时交付可编辑 PPTX', () => {
    const result = exportPresentationPdfVisual({ presentation: deck(), width_px: 480 });
    const text = result.pdf.bytes.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/Filter /FlateDecode');
    expect(text).toContain('/Count 1');
    expect(result.pdf.fidelity).toBe('raster_images');
    expect(result.pdf.page_count).toBe(1);

    const reopened = reopenEditablePptx(result.editable_pptx.bytes);
    expect(reopened.openable).toBe(true);
    expect(reopened.slide_count).toBe(1);
    expect(result.preview.fidelity).toBe('raster_png');
  });

  it('视觉 PDF 内嵌的图片流能被独立 inflate（长度 = 页像素 × 3）', () => {
    const result = exportPresentationPdfVisual({ presentation: deck(), width_px: 480 });
    const pdf = result.pdf.bytes;
    const at = pdf.indexOf(Buffer.from('/Subtype /Image'));
    expect(at).toBeGreaterThan(-1);
    const streamAt = pdf.indexOf(Buffer.from('stream\n'), at);
    const endAt = pdf.indexOf(Buffer.from('\nendstream'), streamAt);
    const compressed = pdf.subarray(streamAt + 'stream\n'.length, endAt);
    const raw = inflateSync(compressed);
    // emptyPresentation 是 4:3（9144000×6858000）：宽 480 ⇒ 高 360；RGB ⇒ 长度 480×360×3。
    expect(raw.length).toBe(480 * 360 * 3);
  });

  it('回归：旧的文字大纲 PDF 仍在、保真级别不变（新路径是新增，不破坏旧契约）', () => {
    const result = exportPresentationPdf({ presentation: deck() });
    expect(result.pdf.fidelity).toBe('text_outline');
    expect(result.pdf.visual_fidelity_verified).toBe(false);
  });

  it('整份渲染：renderPresentationToPngs 页数 = 演示页数', () => {
    const rendered = renderPresentationToPngs(deck(), { width_px: 200 });
    expect(rendered.slide_count).toBe(1);
    expect(rendered.slides[0]?.png.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. layout-check：字形度量的溢出（不同长度结论不同）
// ---------------------------------------------------------------------------

describe('P09 layout-check 字形度量溢出', () => {
  it('长文本溢出、短文本不溢出（measured_by=glyph_advance）', () => {
    // 小框（0.5 英寸高）以便长文本必然溢出。
    const shortSlide = slideWithText('短', { cx: 5486400, cy: 457200 });
    const longSlide = slideWithText('中文长文本用于验证溢出检查中文长文本用于验证溢出检查中文长文本用于验证溢出检查', {
      cx: 5486400,
      cy: 457200,
    });
    const opts = { render_width_px: 1280, slide_size: SLIDE_SIZE_16_9 };

    const longFindings = checkSlideLayoutRendered(longSlide, opts).filter((f) => f.code === 'text_overflow');
    expect(longFindings.length).toBeGreaterThan(0);
    expect(longFindings[0]?.details.measured_by).toBe('glyph_advance');

    const shortFindings = checkSlideLayoutRendered(shortSlide, opts).filter((f) => f.code === 'text_overflow');
    expect(shortFindings).toHaveLength(0);
  });

  it('renderedTextHeightEmu：内容越长估高越大', () => {
    const bodyOf = (t: string) => literalText(t, { size_pt: 18 });
    const opts = { scale: 1280 / SLIDE_SIZE_16_9.cx_emu, glyph_port: createBuiltinGlyphPort(), default_font: 'mono8', default_size_pt: 18 };
    const short = renderedTextHeightEmu(bodyOf('中'), 5486400, opts);
    const long = renderedTextHeightEmu(bodyOf('中文长文本中文长文本中文长文本中文长文本中文长文本'), 5486400, opts);
    expect(long).toBeGreaterThan(short);
  });
});

// ---------------------------------------------------------------------------
// 7. decodePng 与我们自己编码的一致性（交叉）
// ---------------------------------------------------------------------------

describe('P09 编解码交叉一致性', () => {
  it('encodePng → decodePng → 再 encodePng 逐字节一致', () => {
    const data = new Uint8Array(5 * 3 * 3);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 7) % 256;
    const png = encodePng({ width: 5, height: 3, channels: 3, data });
    const decoded = decodePng(png);
    const again = encodePng({ width: decoded.width, height: decoded.height, channels: 3, data: decoded.data });
    expect(again.equals(png)).toBe(true);
  });
});
