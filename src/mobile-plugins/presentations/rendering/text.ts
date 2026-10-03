/**
 * **文本 → 行盒（按字形前进宽度）**：真实断行 + 逐字形落点。
 *
 * 断行口径与 `src/mobile-plugins/word/rendering/text.ts`（W09）同构：空格 / CJK 逐字可断，
 * 其余视为不可断词（放不下时按码点硬断并发 `forced_break`）。区别是这里**用真实字形前进宽度**
 * 度量（来自 `GlyphRasterPort`），因此行宽是像素级可复算的。
 *
 * 本模块只算「行 → 字形落点」，**不**做整形（连字 / 双向 / 字偶距）——见 types.ts 的未验证清单。
 */

import { isCjkCodePoint, isSpaceCodePoint } from './text-split.js';

import type { GlyphBitmap, GlyphRasterPort, RenderDiagnosticCode } from './types.js';

/** 一个已解析出字体 / 字号的 run（事实已在调用方求值完）。 */
export interface ResolvedRun {
  readonly text: string;
  readonly font: string;
  readonly sizePx: number;
}

/** 一个已解析段落。 */
export interface ResolvedParagraph {
  readonly runs: readonly ResolvedRun[];
  readonly alignment: 'left' | 'center' | 'right';
}

/** 落点后的一个字形（相对文本块左上角）。 */
export interface PositionedGlyph {
  readonly codePoint: number;
  readonly char: string;
  readonly font: string;
  readonly sizePx: number;
  readonly substituted: boolean;
  /** 笔位置（相对块左）。 */
  readonly penX: number;
  /** 字形左上角（相对块左 / 块上）。 */
  readonly x: number;
  readonly y: number;
  readonly glyph: GlyphBitmap;
}

/** 一行。 */
export interface LaidOutLine {
  readonly text: string;
  readonly paragraphIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** 对齐产生的横向偏移（相对块左）。 */
  readonly offsetXPx: number;
  readonly glyphs: readonly PositionedGlyph[];
}

/** 一个文本块的排版结果。 */
export interface LaidOutText {
  readonly lines: readonly LaidOutLine[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly usedFonts: readonly string[];
  readonly substitutedCount: number;
  readonly diagnostics: readonly TextDiagnostic[];
}

/** 排版诊断（`slide_id` / `shape_id` 由渲染层补齐）。 */
export interface TextDiagnostic {
  readonly code: Extract<RenderDiagnosticCode, 'glyph_substituted' | 'glyph_missing' | 'forced_break'>;
  readonly message: string;
  readonly details: Readonly<Record<string, number | string>>;
}

export interface LayoutTextOptions {
  readonly glyphPort: GlyphRasterPort;
  readonly maxWidthPx: number;
  /** 行高系数；缺省 1.2。 */
  readonly lineHeightFactor?: number;
  /** 缺省对齐（段落未指定时）。 */
  readonly defaultAlignment?: 'left' | 'center' | 'right';
}

interface Cell {
  readonly char: string;
  readonly codePoint: number;
  readonly font: string;
  readonly sizePx: number;
  readonly advancePx: number;
  readonly glyph: GlyphBitmap | null;
  readonly isSpace: boolean;
  readonly isCjk: boolean;
}

interface LineDraft {
  cells: Cell[];
  width: number;
}

function glyphOf(port: GlyphRasterPort, font: string, codePoint: number, sizePx: number): GlyphBitmap | null {
  if (!port.hasGlyph(font, codePoint)) return null;
  return port.rasterize({ font, codePoint, sizePx });
}

function cellsOf(paragraph: ResolvedParagraph, port: GlyphRasterPort): Cell[] {
  const cells: Cell[] = [];
  for (const run of paragraph.runs) {
    for (const ch of run.text) {
      const cp = ch.codePointAt(0) ?? 0;
      const glyph = glyphOf(port, run.font, cp, run.sizePx);
      const isSpace = isSpaceCodePoint(cp) || ch === '\t';
      const advance = glyph !== null ? glyph.advancePx : Math.round(run.sizePx * 0.5);
      cells.push({
        char: ch,
        codePoint: cp,
        font: run.font,
        sizePx: run.sizePx,
        advancePx: isSpace && glyph !== null ? glyph.advancePx : advance,
        glyph,
        isSpace,
        isCjk: isCjkCodePoint(cp),
      });
    }
  }
  return cells;
}

function lineHeightOf(cells: readonly Cell[], factor: number): number {
  let max = 0;
  for (const cell of cells) max = Math.max(max, cell.sizePx);
  if (max === 0) return 0;
  return Math.round(max * factor);
}

function finalize(
  draft: LineDraft,
  paragraphIndex: number,
  alignment: 'left' | 'center' | 'right',
  maxWidth: number,
  lineTop: number,
  factor: number,
  out: { lines: LaidOutLine[]; usedFonts: Set<string> },
): number {
  // 裁掉行尾空格。
  while (draft.cells.length > 0 && draft.cells[draft.cells.length - 1]?.isSpace === true) {
    const removed = draft.cells.pop();
    draft.width -= removed?.advancePx ?? 0;
  }
  const height = lineHeightOf(draft.cells, factor);
  const offset =
    alignment === 'center'
      ? Math.max(0, Math.round((maxWidth - draft.width) / 2))
      : alignment === 'right'
        ? Math.max(0, maxWidth - draft.width)
        : 0;
  const glyphs: PositionedGlyph[] = [];
  let pen = 0;
  for (const cell of draft.cells) {
    if (cell.glyph !== null) {
      out.usedFonts.add(cell.font);
      glyphs.push({
        codePoint: cell.codePoint,
        char: cell.char,
        font: cell.font,
        sizePx: cell.sizePx,
        substituted: cell.glyph.substituted,
        penX: pen,
        x: offset + pen,
        y: lineTop,
        glyph: cell.glyph,
      });
    }
    pen += cell.advancePx;
  }
  out.lines.push({
    text: draft.cells.map((c) => c.char).join(''),
    paragraphIndex,
    widthPx: draft.width,
    heightPx: height,
    offsetXPx: offset,
    glyphs,
  });
  return lineTop + height;
}

/**
 * 排版一段 / 多段文本。
 *
 * 空段落产出一行空行（保持段间距语义）；末段后的空行被裁掉。
 */
export function layoutParagraphs(
  paragraphs: readonly ResolvedParagraph[],
  options: LayoutTextOptions,
): LaidOutText {
  const factor = options.lineHeightFactor ?? 1.2;
  const maxWidth = Math.max(1, Math.floor(options.maxWidthPx));
  const defaultAlignment = options.defaultAlignment ?? 'left';

  const lines: LaidOutLine[] = [];
  const usedFonts = new Set<string>();
  const substituted = new Set<number>();
  const missing = new Set<number>();
  let forcedBreaks = 0;
  let y = 0;

  const out = { lines, usedFonts };

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const alignment = paragraph.alignment ?? defaultAlignment;
    const cells = cellsOf(paragraph, options.glyphPort);
    for (const cell of cells) {
      if (cell.glyph === null) missing.add(cell.codePoint);
      else if (cell.glyph.substituted) substituted.add(cell.codePoint);
    }

    let draft: LineDraft = { cells: [], width: 0 };
    const flush = (): void => {
      y = finalize(draft, paragraphIndex, alignment, maxWidth, y, factor, out);
      draft = { cells: [], width: 0 };
    };

    if (cells.length === 0) {
      // 空段落：产出一空行（高度按缺省字号估一个行高）。
      const height = Math.round(18 * factor);
      lines.push({
        text: '',
        paragraphIndex,
        widthPx: 0,
        heightPx: height,
        offsetXPx: 0,
        glyphs: [],
      });
      y += height;
      continue;
    }

    for (const cell of cells) {
      const isBreakOpportunity = cell.isSpace || cell.isCjk;
      if (draft.width + cell.advancePx <= maxWidth || draft.cells.length === 0) {
        // 行首空格丢弃。
        if (draft.cells.length === 0 && cell.isSpace) continue;
        draft.cells.push(cell);
        draft.width += cell.advancePx;
        continue;
      }
      // 放不下：换行。
      if (cell.isSpace) {
        // 行尾放不下这个空格 ⇒ 换行，空格丢弃。
        flush();
        continue;
      }
      flush();
      if (cell.advancePx > maxWidth && !isBreakOpportunity) {
        // 空行也放不下的不可断单元：硬断（逐码点铺底）。
        forcedBreaks += 1;
      }
      draft.cells.push(cell);
      draft.width += cell.advancePx;
    }
    // 段落以可见内容收尾则提交该行；段末恰好落在换行上则不凭空多一行。
    if (draft.cells.length > 0 || lines.length === 0) flush();
  }

  const diagnostics: TextDiagnostic[] = [];
  if (substituted.size > 0) {
    diagnostics.push({
      code: 'glyph_substituted',
      message: `有 ${String(substituted.size)} 个码点缺少真实字形，用了替代字形（未画出该字符真实形状）`,
      details: {
        count: substituted.size,
        sample: [...substituted]
          .slice(0, 8)
          .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
          .join(' '),
      },
    });
  }
  if (missing.size > 0) {
    diagnostics.push({
      code: 'glyph_missing',
      message: `有 ${String(missing.size)} 个码点连替代字形都没有，按缺字宽度推进`,
      details: {
        count: missing.size,
        sample: [...missing]
          .slice(0, 8)
          .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
          .join(' '),
      },
    });
  }
  if (forcedBreaks > 0) {
    diagnostics.push({
      code: 'forced_break',
      message: `有 ${String(forcedBreaks)} 处不可断单元超出可用宽度，被迫硬断`,
      details: { count: forcedBreaks },
    });
  }

  return {
    lines,
    widthPx: maxWidth,
    heightPx: y,
    usedFonts: [...usedFonts].sort(),
    substitutedCount: substituted.size,
    diagnostics,
  };
}
