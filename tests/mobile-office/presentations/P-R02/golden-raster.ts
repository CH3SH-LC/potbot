/**
 * P-R02 · 确定性**字符栅格**（"黄金截图"的可计算替身）+ **叠层**与**溢出**差异。
 *
 * ## 它证明什么、不证明什么
 *
 * 手机端"真实视觉预览"需要一个像素级渲染器（P09 的宿主）。在渲染器就位前，本模块给出一个
 * **确定性、可哈希、可回归**的**字符栅格**：把一页切成 `cols × rows` 个字符格，按 **z 序**
 * （`slide.shapes` 顺序，后者压前者）涂色，文本按**字体的真实度量**估算换行与行高后落格。
 * 于是三类差异都变成**可比较的产物**：
 *
 * - **字体替代差异**：同一段文字，`宋体 → 微软雅黑` 会改变拉丁宽度与行高 ⇒ 行数/落格变 ⇒ 栅格变；
 * - **叠层差异**：互换两个重叠对象的前后顺序，可见格子的颜色随之翻转；
 * - **溢出差异**：文本框内容超出框高时，文本落格**越出框底**（在页内可见），并可量化为溢出 EMU。
 *
 * **不声称**：这不是位图 PNG，不是 PowerPoint / WPS 渲染结果，不验证字形、字距、抗锯齿、
 * 图片像素或动画。真实像素截图 = **未验证**。
 *
 * ## 与既有代码的交叉点
 *
 * - 字宽度量走 `font-metrics.ts`；当解析字体为宋体时与 `src/presentations/layout-check.ts`
 *   的 `charWidthPt` / 行高 1.2 口径**逐数字一致**（供跨实现断言）。
 * - 文本溢出量同时可由 `checkSlideLayout` 独立算出 —— 两条路径互相印证，不是自证。
 *
 * 零 IO / 零墙钟 / 零随机；`digest` 复用仓内唯一摘要实现 `src/artifacts/digest.ts`。
 */

import { digestBytes } from '../../../../src/artifacts/digest.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import {
  resolveRunText,
  type FactSnapshot,
  type Paragraph,
  type Presentation,
  type Shape,
  type Slide,
  type SlideSize,
  type TextBody,
} from '../../../../src/presentations/model.js';

import {
  EMU_PER_PT,
  fontCharWidthPt,
  resolveFont,
  type FontMetrics,
  type ResolvedFont,
  type SubstitutionReason,
} from './font-metrics.js';
import {
  DEFAULT_BODY_SIZE_PT,
  DEFAULT_RESOLUTION,
  validateRasterRequest,
  type RasterRequest,
  type RasterResolution,
} from './schema.js';

// 与 `src/presentations/layout-check.ts` 同值（该文件未导出这几个常量，故此处显式复刻并注释来源）。
const INSET_LR_EMU = 91440; // 0.1 英寸左右内边距
const INSET_TB_EMU = 45720; // 0.05 英寸上下内边距
const LEVEL_INDENT_EMU = 457200; // 每级缩进 0.5 英寸
const PARAGRAPH_GAP_FACTOR = 0.2;

const EMPTY_CHAR = '.';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 栅格层错误（具名）。 */
export type RasterErrorReason = 'unknown_slide';

/** 栅格层错误。 */
export class RasterError extends ValidationError {
  readonly reason: RasterErrorReason;

  constructor(reason: RasterErrorReason, message: string) {
    super(message);
    this.name = 'RasterError';
    this.reason = reason;
  }
}

/** 一次字体替代记录（可解释）。 */
export interface FontSubstitutionRecord {
  readonly shape_id: number;
  readonly requested: string | null;
  readonly resolved: string;
  readonly reason: SubstitutionReason;
}

/** 一个文本框的溢出记录（EMU）。 */
export interface TextOverflowRecord {
  readonly shape_id: number;
  readonly required_emu: number;
  readonly available_emu: number;
  /** `required - available` 且不小于 0。 */
  readonly overflow_emu: number;
}

/** 栅格产物。 */
export interface Raster {
  readonly cols: number;
  readonly rows: number;
  /** `rows` 行，每行 `cols` 个字符。 */
  readonly grid: readonly string[];
  /** 字符 → 语义键（`fill:RRGGBB` / `text:RRGGBB` / `picture` / `table` / `chart` / `media` / `empty`）。 */
  readonly legend: Readonly<Record<string, string>>;
  readonly substitutions: readonly FontSubstitutionRecord[];
  readonly overflows: readonly TextOverflowRecord[];
  /** 本批栅格未绘制、只登记的种类（如 `connector`）。 */
  readonly skipped_shape_kinds: readonly string[];
  /** 栅格文本的 sha256（黄金比对用）。 */
  readonly digest: string;
  readonly fidelity: 'char_grid';
  readonly pixel_fidelity_verified: false;
}

// ---------------------------------------------------------------------------
// 单元格算术
// ---------------------------------------------------------------------------

interface CellRange {
  readonly c0: number;
  readonly c1: number;
  readonly r0: number;
  readonly r1: number;
}

/** 一个 EMU 矩形覆盖的格子范围（含端点；已按页裁剪）；空/越界返回 `null`。 */
function cellsForRect(
  x: number,
  y: number,
  cx: number,
  cy: number,
  cols: number,
  rows: number,
  slide: SlideSize,
): CellRange | null {
  if (cx <= 0 || cy <= 0) return null;
  const cw = slide.cx_emu / cols;
  const ch = slide.cy_emu / rows;
  const c0 = Math.max(0, Math.floor(x / cw));
  const c1 = Math.min(cols - 1, Math.ceil((x + cx) / cw) - 1);
  const r0 = Math.max(0, Math.floor(y / ch));
  const r1 = Math.min(rows - 1, Math.ceil((y + cy) / ch) - 1);
  if (c1 < c0 || r1 < r0) return null;
  return { c0, c1, r0, r1 };
}

// ---------------------------------------------------------------------------
// 栅格器
// ---------------------------------------------------------------------------

class RasterBuilder {
  private readonly cells: string[][];
  private readonly substitutions: FontSubstitutionRecord[] = [];
  private readonly overflows: TextOverflowRecord[] = [];
  private readonly skipped = new Set<string>();
  private readonly slide: SlideSize;
  private readonly cols: number;
  private readonly rows: number;
  private readonly installed: readonly string[];
  private readonly bodySize: number;
  private readonly snapshot: FactSnapshot;

  constructor(
    sliderSize: SlideSize,
    resolution: RasterResolution,
    installed: readonly string[],
    bodySize: number,
    snapshot: FactSnapshot,
  ) {
    this.slide = sliderSize;
    this.cols = resolution.cols;
    this.rows = resolution.rows;
    this.installed = installed;
    this.bodySize = bodySize;
    this.snapshot = snapshot;
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ''));
  }

  private paint(range: CellRange, key: string): void {
    for (let r = range.r0; r <= range.r1; r += 1) {
      const row = this.cells[r]!;
      for (let c = range.c0; c <= range.c1; c += 1) {
        row[c] = key; // z 序：后画者覆盖先画者
      }
    }
  }

  private resolve(font: string | undefined): ResolvedFont {
    return resolveFont(font ?? null, this.installed);
  }

  private recordSubstitution(shapeId: number, resolved: ResolvedFont): void {
    if (resolved.reason === 'installed' || resolved.reason === 'default') return;
    if (
      !this.substitutions.some(
        (item) => item.shape_id === shapeId && item.requested === resolved.requested,
      )
    ) {
      this.substitutions.push({
        shape_id: shapeId,
        requested: resolved.requested,
        resolved: resolved.resolved,
        reason: resolved.reason,
      });
    }
  }

  /** 段落首 run 的字体（决定行高度量）；无 run ⇒ 正文字体度量。 */
  private paragraphFont(paragraph: Paragraph): FontMetrics {
    for (const run of paragraph.runs) {
      if (run.style?.font !== undefined) return this.resolve(run.style.font).metrics;
    }
    return this.resolve(undefined).metrics;
  }

  /** 段落最高字号。 */
  private paragraphMaxSize(paragraph: Paragraph): number {
    let size = this.bodySize;
    for (const run of paragraph.runs) {
      const runSize = run.style?.size_pt ?? this.bodySize;
      if (runSize > size) size = runSize;
    }
    return size;
  }

  /**
   * 绘制一个文本体；返回**估算总高**（EMU），并把每个字符落到栅格（可能越出框底 = 溢出可见）。
   */
  private paintText(body: TextBody, boxX: number, boxY: number, boxCx: number, boxCy: number, shapeId: number): number {
    let cursorY = boxY + INSET_TB_EMU;
    let first = true;
    let totalHeight = 0;
    for (const paragraph of body.paragraphs) {
      const metrics = this.paragraphFont(paragraph);
      const maxSize = this.paragraphMaxSize(paragraph);
      const lineHeight = Math.round(maxSize * metrics.line_height * EMU_PER_PT);
      const lineStartX = boxX + INSET_LR_EMU + paragraph.level * LEVEL_INDENT_EMU;
      const availableWidth = boxCx - INSET_LR_EMU * 2 - paragraph.level * LEVEL_INDENT_EMU;
      if (!first) {
        totalHeight += Math.round(PARAGRAPH_GAP_FACTOR * maxSize * EMU_PER_PT);
        cursorY += Math.round(PARAGRAPH_GAP_FACTOR * maxSize * EMU_PER_PT);
      }
      let lines = 1;
      let cursorX = lineStartX;
      const lineTop = cursorY;
      for (const run of paragraph.runs) {
        const resolved = this.resolve(run.style?.font);
        this.recordSubstitution(shapeId, resolved);
        const size = run.style?.size_pt ?? this.bodySize;
        const key = `text:${(run.style?.color ?? '000000').toUpperCase()}`;
        for (const ch of resolveRunText(run.source, this.snapshot)) {
          const w = fontCharWidthPt(ch, size, resolved.metrics) * EMU_PER_PT;
          if (cursorX + w > lineStartX + availableWidth && cursorX > lineStartX) {
            lines += 1;
            cursorX = lineStartX;
          }
          const charTop = lineTop + (lines - 1) * lineHeight;
          const range = cellsForRect(cursorX, charTop, w, lineHeight, this.cols, this.rows, this.slide);
          if (range !== null) this.paint(range, key);
          cursorX += w;
        }
      }
      const block = lines * lineHeight;
      totalHeight += block;
      cursorY += block;
      first = false;
    }
    return Math.round(totalHeight);
  }

  /** 非文本对象的纯色/占位填充键。 */
  private regionKey(shape: Shape): string | null {
    switch (shape.kind) {
      case 'picture':
        return 'picture';
      case 'table':
        return 'table';
      case 'chart':
        return 'chart';
      case 'media':
        return 'media';
      case 'connector':
        this.skipped.add('connector');
        return null;
      default:
        return null;
    }
  }

  private drawShape(shape: Shape): void {
    const t = shape.transform;
    if (shape.kind === 'group') {
      for (const child of shape.children) this.drawShape(child);
      return;
    }
    // 底：非文本占位或纯色填充。
    if (shape.kind === 'auto_shape' && shape.fill.kind === 'solid') {
      const range = cellsForRect(t.x_emu, t.y_emu, t.cx_emu, t.cy_emu, this.cols, this.rows, this.slide);
      if (range !== null) this.paint(range, `fill:${shape.fill.color.toUpperCase()}`);
    } else {
      const key = this.regionKey(shape);
      if (key !== null) {
        const range = cellsForRect(t.x_emu, t.y_emu, t.cx_emu, t.cy_emu, this.cols, this.rows, this.slide);
        if (range !== null) this.paint(range, key);
      }
    }
    // 顶：文本（若有）。
    const body = shape.kind === 'text_box' ? shape.text : shape.kind === 'auto_shape' ? shape.text : null;
    if (body !== null) {
      const required = this.paintText(body, t.x_emu, t.y_emu, t.cx_emu, t.cy_emu, shape.shape_id);
      const available = t.cy_emu - INSET_TB_EMU * 2;
      if (required > available) {
        this.overflows.push({
          shape_id: shape.shape_id,
          required_emu: required,
          available_emu: available,
          overflow_emu: required - available,
        });
      }
    }
  }

  rasterize(slide: Slide): Omit<Raster, 'digest' | 'fidelity' | 'pixel_fidelity_verified'> {
    for (const shape of slide.shapes) this.drawShape(shape);

    // 语义键 → 字符图例：按行优先首现顺序分配，保证确定性。
    const legend: Record<string, string> = { '': EMPTY_CHAR, empty: EMPTY_CHAR };
    const charFor = new Map<string, string>();
    charFor.set('', EMPTY_CHAR);
    let next = 0;
    const grid = this.cells.map((row) =>
      row
        .map((key) => {
          if (key === '') return EMPTY_CHAR;
          let ch = charFor.get(key);
          if (ch === undefined) {
            ch = ALPHABET[next] ?? '?';
            next += 1;
            charFor.set(key, ch);
            legend[ch] = key;
          }
          return ch;
        })
        .join(''),
    );

    return {
      cols: this.cols,
      rows: this.rows,
      grid,
      legend: Object.freeze({ ...legend }),
      substitutions: Object.freeze([...this.substitutions]),
      overflows: Object.freeze([...this.overflows]),
      skipped_shape_kinds: Object.freeze([...this.skipped].sort()),
    };
  }
}

/** 渲染一页为字符栅格。 */
export function rasterizeSlide(
  slide: Slide,
  request: RasterRequest,
  fallbackSlideSize: SlideSize,
  snapshot: FactSnapshot = [],
): Raster {
  const normalized = validateRasterRequest(request, fallbackSlideSize);
  const builder = new RasterBuilder(
    normalized.slide_size,
    normalized.resolution,
    normalized.installed_fonts,
    normalized.default_body_size_pt,
    snapshot,
  );
  const partial = builder.rasterize(slide);
  const text = partial.grid.join('\n');
  const digest = digestBytes(new TextEncoder().encode(text));
  return Object.freeze({
    ...partial,
    digest,
    fidelity: 'char_grid' as const,
    pixel_fidelity_verified: false as const,
  });
}

/** 渲染整份文稿的第一页（多页时可用 `slideIndex` 指定）。 */
export function rasterizePresentation(
  presentation: Presentation,
  request: RasterRequest,
  slideIndex = 0,
  snapshot: FactSnapshot = [],
): Raster {
  const slide = presentation.slides[slideIndex];
  if (slide === undefined) {
    throw new RasterError('unknown_slide', `文稿没有第 ${String(slideIndex)} 页`);
  }
  return rasterizeSlide(slide, request, presentation.size, snapshot);
}

/** 便捷常量再导出（供用例断言默认值）。 */
export { DEFAULT_RESOLUTION, DEFAULT_BODY_SIZE_PT };
