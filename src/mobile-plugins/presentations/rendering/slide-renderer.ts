/**
 * **幻灯片模型 → 真实像素画布**。
 *
 * 覆盖对象：文本（文本框 / 自选图形，含事实求值）、自选图形填充与描边、图片（PNG 解码后
 * 缩放贴图）、图表（柱 / 折线 / 饼，画成真实图元）、表格（网格 + 单元格文本）、连接符、
 * 组合（递归）、音视频（占位标记 + 诊断）。
 *
 * 关键口径：
 * - **数组顺序 = z 序**：后一个对象画在前一个之上，叠层因此是像素可见的；
 * - 文本溢出按**真实字形度量**判定（`layoutParagraphs` 的像素高度 vs 框内可用高）；
 * - 图片引用的媒体缺失 / 解不开**如实报诊断**，不静默画错图；
 * - 中文等非 ASCII 若无真实字形，字形被替代并报 `glyph_substituted`（见 `font.ts`）；
 * - **旋转 / 翻转**对象先画进局部画布，再绕对象中心逆映射合成（只有被写过的像素贴回，
 *   旋转四角空白不盖底下内容）——包围盒见 {@link rotatedBoxSizePx}；
 * - **合并单元格**按跨格区域画成一格（内部网格线抑制、文字按整块合并区宽度排版），并发
 *   `table_merge_rendered` 如实记录（底纹 / 斜线边框仍未还原）。
 */

import { resolveRunText, type FactSnapshot, type Paragraph, type Presentation, type Shape, type Slide, type TextBody } from '../../../presentations/model.js';
import { planTableGrid, type PlannedCell } from '../../../presentations/tables.js';

import { RasterCanvas, type SourceImage } from './canvas.js';
import { contrastRatio, parseColor, BLACK, DARK_GRAY, WHITE, type Rgb } from './color.js';
import { createBuiltinGlyphPort, BUILTIN_FONT } from './font.js';
import { decodePng, encodePng, isPng } from './png.js';
import { layoutParagraphs, type ResolvedParagraph } from './text.js';
import { RENDER_UNVERIFIED } from './types.js';
import type {
  EmuSlideSize,
  GlyphRasterPort,
  RenderDiagnostic,
  RenderSlideOptions,
  RenderedPresentationPng,
  RenderedSlide,
  RenderedSlidePng,
} from './types.js';

const EMU_PER_PT = 12700;
const INSET_LR_EMU = 91440;
const INSET_TB_EMU = 45720;

/** 图表配色（与主题无关的固定调色板，够区分系列即可）。 */
const CHART_PALETTE: readonly Rgb[] = Object.freeze([
  { r: 0x2b, g: 0x6c, b: 0xb0 },
  { r: 0xe8, g: 0x77, b: 0x22 },
  { r: 0x2c, g: 0xa0, b: 0x2c },
  { r: 0xd6, g: 0x27, b: 0x28 },
  { r: 0x94, g: 0x67, b: 0xbd },
  { r: 0x17, g: 0xbe, b: 0xcf },
]);

interface Scale {
  readonly sx: number;
  readonly sy: number;
}

interface DrawContext {
  readonly slide_id: number;
  readonly glyphPort: GlyphRasterPort;
  readonly font: string;
  readonly defaultSizePt: number;
  readonly scale: Scale;
  readonly snapshot: FactSnapshot;
  readonly media: ReadonlyMap<string, Uint8Array>;
  readonly diagnostics: RenderDiagnostic[];
  /** 画布底色（旋转对象画进局部画布时用它起底，掩码区分真画与底色）。 */
  readonly background: Rgb;
  /** 局部画布的坐标平移（绘制旋转对象时把对象平移到局部画布原点）。 */
  readonly originX: number;
  readonly originY: number;
}

function pxX(emu: number, s: Scale): number {
  return emu * s.sx;
}
function pxY(emu: number, s: Scale): number {
  return emu * s.sy;
}

function diag(
  ctx: DrawContext,
  code: RenderDiagnostic['code'],
  severity: 'warning' | 'error',
  message: string,
  shapeId: number | null,
  details: Readonly<Record<string, number | string>> = {},
): void {
  ctx.diagnostics.push({ code, severity, message, slide_id: ctx.slide_id, shape_id: shapeId, details });
}

/** 一个形状的像素矩形（`ox/oy` 为局部画布平移；默认主画布无平移）。 */
function rectOf(shape: Shape, s: Scale, ox = 0, oy = 0): { x: number; y: number; w: number; h: number } {
  return {
    x: pxX(shape.transform.x_emu, s) + ox,
    y: pxY(shape.transform.y_emu, s) + oy,
    w: pxX(shape.transform.cx_emu, s),
    h: pxY(shape.transform.cy_emu, s),
  };
}

/** 取文本体第一个显式颜色，缺省黑。 */
function bodyColor(body: TextBody): Rgb {
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.style?.color !== undefined) return parseColor(run.style.color);
    }
  }
  return BLACK;
}

function toResolvedParagraphs(body: TextBody, ctx: DrawContext): ResolvedParagraph[] {
  return body.paragraphs.map((paragraph: Paragraph) => ({
    alignment: paragraph.alignment === 'justify' ? 'left' : paragraph.alignment,
    runs: paragraph.runs.map((run) => {
      const sizePt = run.style?.size_pt ?? ctx.defaultSizePt;
      return {
        text: resolveRunText(run.source, ctx.snapshot),
        font: run.style?.font ?? ctx.font,
        sizePx: Math.max(6, Math.round(sizePt * EMU_PER_PT * ctx.scale.sy)),
      };
    }),
  }));
}

interface TextBoxRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 在给定框内排版并绘制文本体；返回是否溢出。
 * `vertical: 'middle'` 时整体垂直居中（自选图形常用）。
 */
function drawTextBody(
  canvas: RasterCanvas,
  body: TextBody,
  box: TextBoxRect,
  ctx: DrawContext,
  shapeId: number,
  options?: { readonly vertical?: 'top' | 'middle'; readonly sizePtOverride?: number },
): void {
  const insetL = pxX(INSET_LR_EMU, ctx.scale);
  const insetT = pxY(INSET_TB_EMU, ctx.scale);
  const innerW = Math.max(1, box.w - insetL * 2);
  const innerH = Math.max(1, box.h - insetT * 2);

  const localCtx: DrawContext =
    options?.sizePtOverride === undefined ? ctx : { ...ctx, defaultSizePt: options.sizePtOverride };
  const paragraphs = toResolvedParagraphs(body, localCtx);
  const laid = layoutParagraphs(paragraphs, {
    glyphPort: ctx.glyphPort,
    maxWidthPx: Math.floor(innerW),
    defaultAlignment: 'left',
  });

  const offsetY =
    options?.vertical === 'middle' ? Math.max(0, Math.floor((innerH - laid.heightPx) / 2)) : 0;

  const color = bodyColor(body);
  for (const line of laid.lines) {
    for (const positioned of line.glyphs) {
      if (positioned.glyph.widthPx === 0) continue;
      canvas.drawCoverage(
        positioned.glyph.coverage,
        positioned.glyph.widthPx,
        positioned.glyph.heightPx,
        Math.round(box.x + insetL + positioned.x),
        Math.round(box.y + insetT + offsetY + positioned.y),
        color,
      );
    }
  }

  // 把排版诊断（缺字 / 替代 / 硬断）搬进渲染诊断。
  for (const d of laid.diagnostics) {
    diag(ctx, d.code, 'warning', d.message, shapeId, d.details);
  }

  if (laid.heightPx > innerH + 0.5) {
    diag(
      ctx,
      'text_overflow',
      'error',
      `文本溢出：实测 ${String(laid.heightPx)} px，框内可用 ${String(Math.round(innerH))} px`,
      shapeId,
      { measured_px: laid.heightPx, available_px: Math.round(innerH), overflow_px: Math.round(laid.heightPx - innerH) },
    );
  }
}

// ---------------------------------------------------------------------------
// 图表
// ---------------------------------------------------------------------------

function seriesColor(index: number): Rgb {
  return CHART_PALETTE[index % CHART_PALETTE.length] ?? CHART_PALETTE[0]!;
}

function drawChart(
  canvas: RasterCanvas,
  chart: Shape & { kind: 'chart' },
  box: TextBoxRect,
  ctx: DrawContext,
): void {
  const model = chart.chart;
  const pad = Math.max(4, box.w * 0.06);
  const plotX = box.x + pad;
  const plotY = box.y + pad;
  const plotW = Math.max(1, box.w - pad * 2);
  const plotH = Math.max(1, box.h - pad * 2);

  // 坐标框
  canvas.strokeRect(plotX, plotY, plotW, plotH, DARK_GRAY, 1);

  if (model.chart_type === 'pie') {
    const values = model.series[0]?.values ?? [];
    const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
    if (total <= 0) return;
    const cx = plotX + plotW / 2;
    const cy = plotY + plotH / 2;
    const rx = Math.min(plotW, plotH) / 2 - 1;
    const TAU = Math.PI * 2;
    let start = Math.PI * 1.5; // 从 12 点方向起，归一化到 [0, 2π)
    values.forEach((value, index) => {
      const sweep = (Math.max(0, value) / total) * TAU;
      const end = start + sweep;
      const color = seriesColor(index);
      const sNorm = ((start % TAU) + TAU) % TAU;
      const eNorm = ((end % TAU) + TAU) % TAU;
      const full = sweep >= TAU - 1e-9;
      const y0 = Math.floor(cy - rx);
      const y1 = Math.ceil(cy + rx);
      const x0 = Math.floor(cx - rx);
      const x1 = Math.ceil(cx + rx);
      for (let py = y0; py <= y1; py += 1) {
        for (let px = x0; px <= x1; px += 1) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          if (dx * dx + dy * dy > rx * rx) continue;
          let angle = Math.atan2(dy, dx);
          if (angle < 0) angle += TAU;
          const inside = full
            ? true
            : sNorm <= eNorm
              ? angle >= sNorm && angle <= eNorm
              : angle >= sNorm || angle <= eNorm;
          if (inside) canvas.setPixel(px, py, color);
        }
      }
      start = end;
    });
    return;
  }

  const categories = model.categories;
  const categoriesCount = Math.max(1, categories.length);
  const maxValue = Math.max(
    1,
    ...model.series.flatMap((s) => s.values.map((v) => Math.abs(v))),
  );

  if (model.chart_type === 'bar') {
    const groupW = plotW / categoriesCount;
    const seriesCount = Math.max(1, model.series.length);
    const barW = Math.max(1, (groupW * 0.8) / seriesCount);
    model.series.forEach((series, si) => {
      series.values.forEach((value, ci) => {
        const barH = (Math.abs(value) / maxValue) * (plotH - 4);
        const bx = plotX + groupW * ci + groupW * 0.1 + barW * si;
        const by = plotY + plotH - barH;
        canvas.fillRect(bx, by, barW, barH, seriesColor(si));
      });
    });
    return;
  }

  // line
  model.series.forEach((series, si) => {
    const color = seriesColor(si);
    const n = Math.max(1, series.values.length);
    const stepX = n > 1 ? plotW / (n - 1) : 0;
    let prev: { x: number; y: number } | null = null;
    series.values.forEach((value, ci) => {
      const x = plotX + stepX * ci;
      const y = plotY + plotH - (Math.abs(value) / maxValue) * (plotH - 4);
      if (prev !== null) canvas.drawLine(prev.x, prev.y, x, y, color, 2);
      canvas.fillEllipse(x, y, 2.5, 2.5, color);
      prev = { x, y };
    });
  });
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

const TABLE_BORDER_COLOR: Rgb = { r: 0x88, g: 0x88, b: 0x88 };

function drawTable(canvas: RasterCanvas, shape: Shape & { kind: 'table' }, box: TextBoxRect, ctx: DrawContext): void {
  const rows = shape.rows;
  if (rows.length === 0) return;
  const rowH = box.h / rows.length;
  const widthsEmu = shape.column_widths_emu;
  const totalEmu = widthsEmu.reduce((sum, w) => sum + w, 0);
  const colCount = Math.max(1, ...rows.map((r) => r.cells.length));
  // 每列左边界（像素，相对 box 左边）。
  const colX: number[] = [0];
  for (let c = 0; c < colCount; c += 1) {
    const emu = widthsEmu[c];
    const width = emu !== undefined && totalEmu > 0 ? pxX(emu, ctx.scale) : box.w / colCount;
    colX.push((colX[c] ?? 0) + width);
  }

  // 合并规划：复用 tables.ts 的**唯一**合并口径（源格带 span，被覆盖格是沿用格）。
  let plan: readonly (readonly PlannedCell[])[] | null = null;
  try {
    plan = planTableGrid(shape);
  } catch (error) {
    diag(
      ctx,
      'unsupported_shape',
      'warning',
      `表格合并结构无法规划（${error instanceof Error ? error.message : String(error)}），按未合并逐格绘制`,
      shape.shape_id,
    );
  }

  rows.forEach((row, ri) => {
    const y = box.y + rowH * ri;
    row.cells.forEach((cell, ci) => {
      const planned = plan?.[ri]?.[ci];
      // 延续格（hMerge / vMerge）：已被源格覆盖，**不再**单独画边框。
      if (planned !== undefined && (planned.h_merge || planned.v_merge)) return;

      const colSpan = planned === undefined ? Math.max(1, cell.col_span) : Math.max(1, planned.grid_span);
      const rowSpan = planned === undefined ? Math.max(1, cell.row_span) : Math.max(1, planned.row_span);
      // 规划失败时退回逐格（忽略 span），避免半张表重叠。
      const useSpan = plan !== null;
      const effColSpan = useSpan ? colSpan : 1;
      const effRowSpan = useSpan ? rowSpan : 1;

      const x = box.x + (colX[ci] ?? 0);
      const w = (colX[ci + effColSpan] ?? box.w) - (colX[ci] ?? 0);
      const h = rowH * effRowSpan;
      canvas.strokeRect(x, y, w, h, TABLE_BORDER_COLOR, 1);

      if (useSpan && (colSpan > 1 || rowSpan > 1)) {
        diag(
          ctx,
          'table_merge_rendered',
          'warning',
          `表格第 ${String(ri)} 行第 ${String(ci)} 列合并 ${String(colSpan)}×${String(rowSpan)}，按跨格区域绘制（内部网格线已抑制）`,
          shape.shape_id,
          {
            row: ri,
            col: ci,
            col_span: colSpan,
            row_span: rowSpan,
            spanned_w_px: Math.round(w),
            spanned_h_px: Math.round(h),
          },
        );
      }

      const text = planned === undefined ? cell.text : planned.text;
      if (text !== null) {
        drawTextBody(canvas, text, { x, y, w, h }, ctx, shape.shape_id, {
          vertical: 'middle',
          sizePtOverride: 12,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 旋转 / 翻转（P-I21）
// ---------------------------------------------------------------------------

/**
 * 旋转后对象的**轴对齐外接框**尺寸（像素）。供上层与测试独立复算包围盒。
 */
export function rotatedBoxSizePx(
  widthPx: number,
  heightPx: number,
  rotationDeg: number,
): { readonly w: number; readonly h: number } {
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { w: widthPx * c + heightPx * s, h: widthPx * s + heightPx * c };
}

/** 该形状是否带旋转 / 翻转（需要走旋转合成路径）。 */
function isRotated(shape: Shape): boolean {
  const t = shape.transform;
  return t.rotation_deg % 360 !== 0 || t.flip_h || t.flip_v;
}

/**
 * 把局部画布 `sub` 按 `deg`（顺时针度）/ 翻转，绕对象中心**逆映射**合成到主画布。
 * 只贴**被写过**的像素（`writtenMask`）：旋转四角的空白不会盖住底下的内容。
 */
function rotateBlit(
  canvas: RasterCanvas,
  sub: RasterCanvas,
  destX: number,
  destY: number,
  deg: number,
  flipH: boolean,
  flipV: boolean,
): void {
  const theta = (deg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const w = sub.width;
  const h = sub.height;
  const cx = destX + w / 2;
  const cy = destY + h / 2;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const corners: readonly (readonly [number, number])[] = [
    [destX, destY],
    [destX + w, destY],
    [destX, destY + h],
    [destX + w, destY + h],
  ];
  for (const [x, y] of corners) {
    const rx = cx + (x - cx) * cos - (y - cy) * sin;
    const ry = cy + (x - cx) * sin + (y - cy) * cos;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  const px0 = Math.max(0, Math.floor(minX));
  const py0 = Math.max(0, Math.floor(minY));
  const px1 = Math.min(canvas.width, Math.ceil(maxX) + 1);
  const py1 = Math.min(canvas.height, Math.ceil(maxY) + 1);

  // 逆旋转：把目的像素映回局部坐标。
  const sinI = -sin;
  for (let py = py0; py < py1; py += 1) {
    for (let px = px0; px < px1; px += 1) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      const sx = cx + dx * cos - dy * sinI;
      const sy = cy + dx * sinI + dy * cos;
      let lx = Math.floor(sx - destX);
      let ly = Math.floor(sy - destY);
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
      if (flipH) lx = w - 1 - lx;
      if (flipV) ly = h - 1 - ly;
      if (!sub.wasWritten(lx, ly)) continue;
      const pixel = sub.getPixel(lx, ly);
      if (pixel !== null) canvas.setPixel(px, py, pixel);
    }
  }
}

/**
 * 旋转 / 翻转对象：先画进一块**局部画布**，再绕对象中心逆映射合成回主画布。
 *
 * 局部画布底色不置「已写」掩码 ⇒ 只有真被画过的像素贴回，旋转矩形四角的空白保持原样。
 */
function drawRotatedShape(canvas: RasterCanvas, shape: Shape, ctx: DrawContext): void {
  const box = rectOf(shape, ctx.scale, ctx.originX, ctx.originY);
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const sub = new RasterCanvas(w, h, ctx.background);
  const subCtx: DrawContext = {
    ...ctx,
    originX: -Math.round(box.x),
    originY: -Math.round(box.y),
  };
  drawShapePlain(sub, shape, subCtx);
  rotateBlit(canvas, sub, box.x, box.y, shape.transform.rotation_deg, shape.transform.flip_h, shape.transform.flip_v);
}

// ---------------------------------------------------------------------------
// 形状派发
// ---------------------------------------------------------------------------

/** 形状派发（带旋转 / 翻转的对象先走局部画布合成路径）。 */
function drawShape(canvas: RasterCanvas, shape: Shape, ctx: DrawContext): void {
  if (isRotated(shape)) {
    drawRotatedShape(canvas, shape, ctx);
    return;
  }
  drawShapePlain(canvas, shape, ctx);
}

function drawShapePlain(canvas: RasterCanvas, shape: Shape, ctx: DrawContext): void {
  const box = rectOf(shape, ctx.scale, ctx.originX, ctx.originY);
  switch (shape.kind) {
    case 'text_box': {
      drawTextBody(canvas, shape.text, box, ctx, shape.shape_id);
      break;
    }
    case 'auto_shape': {
      if (shape.fill.kind === 'solid') {
        const fill = parseColor(shape.fill.color);
        if (shape.preset === 'ellipse') canvas.fillEllipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, fill);
        else canvas.fillRect(box.x, box.y, box.w, box.h, fill);
      }
      if (shape.outline !== null && shape.outline.color !== null) {
        canvas.strokeRect(box.x, box.y, box.w, box.h, parseColor(shape.outline.color), Math.max(1, shape.outline.width_emu === null ? 1 : pxX(shape.outline.width_emu, ctx.scale)));
      }
      if (shape.text !== null) {
        drawTextBody(canvas, shape.text, box, ctx, shape.shape_id, { vertical: 'middle' });
      }
      break;
    }
    case 'connector': {
      const color = shape.outline !== null && shape.outline.color !== null ? parseColor(shape.outline.color) : DARK_GRAY;
      canvas.drawLine(box.x, box.y + box.h / 2, box.x + box.w, box.y + box.h / 2, color, 2);
      break;
    }
    case 'picture': {
      const bytes = ctx.media.get(shape.media_path);
      if (bytes === undefined) {
        diag(ctx, 'missing_media', 'error', `图片引用的媒体 ${shape.media_path} 不在输入里`, shape.shape_id, { media_path: shape.media_path });
        drawMissingImage(canvas, box);
        break;
      }
      if (!isPng(bytes)) {
        diag(ctx, 'undecodable_image', 'error', `媒体 ${shape.media_path} 不是 PNG（当前只解码 PNG）`, shape.shape_id, { media_path: shape.media_path });
        drawMissingImage(canvas, box);
        break;
      }
      try {
        const image: SourceImage = decodePng(bytes);
        canvas.blit(image, box.x, box.y, box.w, box.h);
      } catch (error) {
        diag(ctx, 'undecodable_image', 'error', `媒体 ${shape.media_path} 解码失败：${error instanceof Error ? error.message : String(error)}`, shape.shape_id, { media_path: shape.media_path });
        drawMissingImage(canvas, box);
      }
      break;
    }
    case 'table': {
      drawTable(canvas, shape, box, ctx);
      break;
    }
    case 'chart': {
      drawChart(canvas, shape, box, ctx);
      break;
    }
    case 'group': {
      for (const child of shape.children) drawShape(canvas, child, ctx);
      break;
    }
    case 'media': {
      canvas.fillRect(box.x, box.y, box.w, box.h, { r: 0x33, g: 0x33, b: 0x33 });
      // 播放三角
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const r = Math.min(box.w, box.h) * 0.2;
      for (let dy = -r; dy <= r; dy += 1) {
        const half = ((r - Math.abs(dy)) / r) * r * 0.8;
        for (let dx = -r * 0.4; dx <= half; dx += 1) canvas.setPixel(Math.round(cx + dx), Math.round(cy + dy), WHITE);
      }
      diag(ctx, 'media_placeholder', 'warning', `${shape.media_type} 媒体（${shape.media_path}）画成占位标记，未渲染真实播放画面`, shape.shape_id, { media_path: shape.media_path });
      break;
    }
  }
}

function drawMissingImage(canvas: RasterCanvas, box: { x: number; y: number; w: number; h: number }): void {
  canvas.fillRect(box.x, box.y, box.w, box.h, { r: 0xee, g: 0xee, b: 0xee });
  canvas.drawLine(box.x, box.y, box.x + box.w, box.y + box.h, { r: 0xcc, g: 0x00, b: 0x00 }, 2);
  canvas.drawLine(box.x + box.w, box.y, box.x, box.y + box.h, { r: 0xcc, g: 0x00, b: 0x00 }, 2);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function scaleFor(size: EmuSlideSize, widthPx: number, heightPx: number): Scale {
  return { sx: widthPx / size.cx_emu, sy: heightPx / size.cy_emu };
}

function resolvePort(options: RenderSlideOptions): GlyphRasterPort {
  return options.glyph_port ?? createBuiltinGlyphPort();
}

function mediaMap(options: RenderSlideOptions): ReadonlyMap<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const entry of options.media ?? []) map.set(entry.path, entry.bytes);
  return map;
}

/** 渲染一张幻灯片到画布。 */
export function renderSlide(slide: Slide, index: number, options: RenderSlideOptions): RenderedSlide {
  const widthPx = Math.max(1, Math.round(options.width_px));
  const heightPx = Math.max(1, Math.round(options.height_px ?? (widthPx * options.slide_size.cy_emu) / options.slide_size.cx_emu));
  const background = options.background ?? WHITE;
  const canvas = new RasterCanvas(widthPx, heightPx, background);
  const ctx: DrawContext = {
    slide_id: slide.slide_id,
    glyphPort: resolvePort(options),
    font: options.default_font ?? BUILTIN_FONT,
    defaultSizePt: options.default_size_pt ?? 18,
    scale: scaleFor(options.slide_size, widthPx, heightPx),
    snapshot: options.fact_snapshot ?? [],
    media: mediaMap(options),
    diagnostics: [],
    background,
    originX: 0,
    originY: 0,
  };
  // 逐对象按 z 序绘制。
  for (const shape of slide.shapes) drawShape(canvas, shape, ctx);
  return {
    slide_id: slide.slide_id,
    index,
    canvas,
    width_px: widthPx,
    height_px: heightPx,
    diagnostics: ctx.diagnostics,
  };
}

/** 渲染一张幻灯片成 PNG 字节。 */
export function renderSlideToPng(slide: Slide, index: number, options: RenderSlideOptions): RenderedSlidePng {
  const background = options.background ?? WHITE;
  const rendered = renderSlide(slide, index, options);
  const image = rendered.canvas.toRgbImage();
  const png = encodePng(image);
  return {
    slide_id: slide.slide_id,
    index,
    png,
    width_px: rendered.width_px,
    height_px: rendered.height_px,
    ink_pixels: rendered.canvas.countNonBackground(background),
    diagnostics: rendered.diagnostics,
  };
}

/** 渲染整份演示到逐页 PNG（`slide_size` 取自演示本身）。 */
export function renderPresentationToPngs(
  presentation: Presentation,
  options: Omit<RenderSlideOptions, 'slide_size'>,
): RenderedPresentationPng {
  const slides: RenderedSlidePng[] = [];
  const diagnostics: RenderDiagnostic[] = [];
  presentation.slides.forEach((slide, index) => {
    const png = renderSlideToPng(slide, index, { ...options, slide_size: presentation.size });
    slides.push(png);
    diagnostics.push(...png.diagnostics);
  });
  return {
    presentation_id: presentation.presentation_id,
    slide_count: slides.length,
    slides,
    diagnostics,
    unverified: RENDER_UNVERIFIED,
  };
}

/** 对比度是否满足最低比值（供测试与上游核对文本可读性）。 */
export function textContrastRatio(foreground: Rgb, background: Rgb): number {
  return contrastRatio(foreground, background);
}
