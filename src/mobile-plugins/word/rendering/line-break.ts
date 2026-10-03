/**
 * **段落 → 行盒**：度量 + 贪心断行。
 *
 * 输入一个 `ParagraphSpec` 与可用宽度（twips），输出该段的**已测量行**列表
 * （每行含文本、宽度、行高、上升部与逐 run 片段）。分页在 `paginate.ts` 里做，
 * 二者分离是为了让「断行」与「分页」各自可被独立断言。
 *
 * 断行判据见 `text.ts` 顶部；硬断（超长不可断词）会产 `forced_break` 诊断。
 */

import { TWIPS_PER_POINT } from '../../../documents/units/constants.js';

import type { FontResolver } from './fonts.js';
import type { Twips, LayoutDiagnostic, ParagraphSpec, RunSpec, LineBoxRun } from './types.js';
import { atomsOf, codePointsOf, isCjkCodePoint, isSpaceCodePoint, type CharMetric } from './text.js';

/** 一行断行的原因（可复算，用于测试与观测）。 */
export type LineBreakReason = 'paragraph-end' | 'wrap' | 'space' | 'forced';

export interface MeasuredLine {
  text: string;
  widthTwips: Twips;
  heightTwips: Twips;
  ascentTwips: Twips;
  descentTwips: Twips;
  runs: LineBoxRun[];
  breakReason: LineBreakReason;
  /** 段内字符偏移（按码点，含被裁掉的行尾空格）。 */
  startOffset: number;
  endOffset: number;
}

export interface MeasuredParagraph {
  paragraphIndex: number;
  lines: MeasuredLine[];
  spaceBeforeTwips: Twips;
  spaceAfterTwips: Twips;
  lineSpacing: number;
  indentLeftTwips: Twips;
  indentRightTwips: Twips;
  indentFirstLineTwips: Twips;
  alignment: 'left' | 'center' | 'right' | 'justify';
  keepWithNext: boolean;
  pageBreakBefore: boolean;
}

export interface MeasureContext {
  port: import('./types.js').FontMetricsPort;
  resolver: FontResolver;
  diagnostics: LayoutDiagnostic[];
  /** 页面内容区宽度（twips）；缩进在其内扣除。 */
  contentWidthTwips: Twips;
}

function ptToTwips(pt: number): Twips {
  return pt * TWIPS_PER_POINT;
}

/** 把一个 run 展开成逐码点度量，并在缺字时发诊断。 */
function measureRun(run: RunSpec, ctx: MeasureContext, paraIndex: number): CharMetric[] {
  const resolution = ctx.resolver.resolve(run.fontFamily);
  const sizeTwips = ptToTwips(run.sizePt);
  const out: CharMetric[] = [];
  for (const { char, codePoint } of codePointsOf(run.text)) {
    if (!ctx.port.hasGlyph(resolution.family, codePoint)) {
      ctx.diagnostics.push({
        code: 'glyph_missing',
        severity: 'warning',
        message: `字体「${resolution.family}」缺码点 U+${codePoint.toString(16).toUpperCase()}（按 .notdef 宽度排版，未丢字）`,
        paragraphIndex: paraIndex,
        requestedFont: run.fontFamily,
        substitutedFont: resolution.substituted ? resolution.family : undefined,
        codePoint,
      });
    }
    out.push({
      char,
      codePoint,
      offset: 0, // 占位，稍后统一编号
      fontFamily: resolution.family,
      requestedFont: run.fontFamily,
      sizePt: run.sizePt,
      sizeTwips,
      widthTwips: Math.max(0, ctx.port.advanceWidthTwips(resolution.family, codePoint, sizeTwips)),
      isSpace: isSpaceCodePoint(codePoint),
      isCjk: isCjkCodePoint(codePoint),
      breakAfter: isSpaceCodePoint(codePoint) || isCjkCodePoint(codePoint),
    });
  }
  return out;
}

/** 段落全文字符度量（逐 run 拼接，统一编号 offset）。 */
function measureParagraphChars(para: ParagraphSpec, ctx: MeasureContext, paraIndex: number): CharMetric[] {
  const all: CharMetric[] = [];
  let offset = 0;
  for (const run of para.runs) {
    for (const c of measureRun(run, ctx, paraIndex)) {
      c.offset = offset;
      offset += 1;
      all.push(c);
    }
  }
  return all;
}

/** 把逐字符切成行盒 run 片段（按 字体族 / 请求字体 / 字号 归并连续段）。 */
function toRuns(chars: readonly CharMetric[]): LineBoxRun[] {
  const runs: LineBoxRun[] = [];
  for (const c of chars) {
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last.fontFamily === c.fontFamily &&
      last.requestedFont === c.requestedFont &&
      last.sizePt === c.sizePt &&
      last.endOffset === c.offset
    ) {
      last.text += c.char;
      last.endOffset = c.offset + 1;
      last.widthTwips += c.widthTwips;
    } else {
      runs.push({
        text: c.char,
        fontFamily: c.fontFamily,
        requestedFont: c.requestedFont,
        sizePt: c.sizePt,
        startOffset: c.offset,
        endOffset: c.offset + 1,
        widthTwips: c.widthTwips,
      });
    }
  }
  return runs;
}

interface PackedLine {
  chars: CharMetric[];
  breakReason: LineBreakReason;
}

/**
 * 贪心打包：原子（词 / 空格 / 单 CJK 字）逐个尝试放入当前行。
 *
 * - 放不下且当前行非空 ⇒ 换行（`wrap` / `space`）。
 * - 放不下且当前行空、且原子是不可断长词 ⇒ 逐码点**硬断**（`forced` 诊断）。
 * - 行尾空格裁掉（不渲染）。
 *
 * **必然推进**：任何一步要么放入至少一个码点，要么行空时逐码点铺底，
 * 因此不会出现零宽度死循环。
 */
function packLines(
  chars: readonly CharMetric[],
  firstAvail: Twips,
  otherAvail: Twips,
  diagnostics: LayoutDiagnostic[],
  paraIndex: number,
): PackedLine[] {
  const atoms = atomsOf(chars);
  const lines: PackedLine[] = [];
  let cur: CharMetric[] = [];
  let curWidth = 0;
  let avail = firstAvail;

  const push = (reason: LineBreakReason): void => {
    const trimmed = trimTrailingSpacesCp(cur);
    cur = [];
    curWidth = 0;
    avail = otherAvail;
    // 全是行尾空格 ⇒ 不产出一行空行（Word 行为：行末空格被吞，不另起一行）。
    if (trimmed.length === 0 && lines.length > 0) return;
    lines.push({ chars: trimmed, breakReason: reason });
  };

  for (const atom of atoms) {
    if (atom.isSpace) {
      if (cur.length > 0 && curWidth + atom.widthTwips > avail) {
        push('space'); // 行尾放不下这个空格 ⇒ 换行，空格丢弃（Word 行为）
        continue;
      }
      cur.push(...atom.chars);
      curWidth += atom.widthTwips;
      continue;
    }
    if (curWidth + atom.widthTwips <= avail) {
      cur.push(...atom.chars);
      curWidth += atom.widthTwips;
      continue;
    }
    if (cur.length > 0) push('wrap');
    if (atom.widthTwips <= avail) {
      cur.push(...atom.chars);
      curWidth = atom.widthTwips;
      continue;
    }
    // 原子自己就超出整行 ⇒ 逐码点硬断
    for (const c of atom.chars) {
      if (cur.length > 0 && curWidth + c.widthTwips > avail) {
        diagnostics.push({
          code: 'forced_break',
          severity: 'warning',
          message: `不可断词超出可用宽度（${avail} twips），第 ${paraIndex} 段发生硬断`,
          paragraphIndex: paraIndex,
        });
        push('forced');
      }
      cur.push(c);
      curWidth += c.widthTwips;
    }
  }
  if (cur.length > 0) {
    push('paragraph-end');
  } else if (lines.length === 0) {
    // 空段（或全空格）：产出一个**空行**，行高由段落的第一个 run 决定。
    lines.push({ chars: [], breakReason: 'paragraph-end' });
  } else {
    // 上一行以换行结束但还有内容末尾无字符：把最后一行的原因改成段末。
    const lastIndex = lines.length - 1;
    const lastLine = lines[lastIndex];
    if (lastLine !== undefined) {
      lines[lastIndex] = { ...lastLine, breakReason: 'paragraph-end' };
    }
  }
  return lines;
}

function trimTrailingSpacesCp(chars: readonly CharMetric[]): CharMetric[] {
  let end = chars.length;
  while (end > 0) {
    const last = chars[end - 1];
    if (last === undefined || !last.isSpace) break;
    end -= 1;
  }
  return chars.slice(0, end);
}

/** 段落的**基准**行度量（用于空行 / 行内缺字时的兜底）：取第一个 run。 */
function baseMetrics(para: ParagraphSpec, ctx: MeasureContext): { ascent: Twips; descent: Twips } {
  const first = para.runs.find((r) => r !== undefined);
  if (first === undefined) return { ascent: 0, descent: 0 };
  const family = ctx.resolver.resolve(first.fontFamily).family;
  const sizeTwips = ptToTwips(first.sizePt);
  return {
    ascent: ctx.port.ascentTwips(family, sizeTwips),
    descent: ctx.port.descentTwips(family, sizeTwips),
  };
}

/** 度量一个段落：断行 + 行高。 */
export function measureParagraph(para: ParagraphSpec, paraIndex: number, ctx: MeasureContext): MeasuredParagraph {
  const chars = measureParagraphChars(para, ctx, paraIndex);
  const indentLeft = ptToTwips(para.indentLeftPt ?? 0);
  const indentRight = ptToTwips(para.indentRightPt ?? 0);
  const indentFirst = ptToTwips(para.indentFirstLinePt ?? 0);
  const spacing = para.lineSpacing ?? 1;
  const base = baseMetrics(para, ctx);

  const usable = ctx.contentWidthTwips - indentLeft - indentRight;
  const firstAvail = usable - indentFirst;
  const otherAvail = usable;

  const packed = packLines(chars, firstAvail, otherAvail, ctx.diagnostics, paraIndex);

  const lines: MeasuredLine[] = packed.map((p) => {
    let ascent = 0;
    let descent = 0;
    for (const c of p.chars) {
      ascent = Math.max(ascent, ctx.port.ascentTwips(c.fontFamily, c.sizeTwips));
      descent = Math.max(descent, ctx.port.descentTwips(c.fontFamily, c.sizeTwips));
    }
    if (p.chars.length === 0) {
      ascent = base.ascent;
      descent = base.descent;
    }
    const width = p.chars.reduce((sum, c) => sum + c.widthTwips, 0);
    return {
      text: p.chars.map((c) => c.char).join(''),
      widthTwips: width,
      ascentTwips: ascent,
      descentTwips: descent,
      heightTwips: (ascent + descent) * spacing,
      runs: toRuns(p.chars),
      breakReason: p.breakReason,
      startOffset: p.chars[0]?.offset ?? 0,
      endOffset: p.chars.length > 0 ? (p.chars[p.chars.length - 1]?.offset ?? 0) + 1 : 0,
    };
  });

  return {
    paragraphIndex: paraIndex,
    lines,
    spaceBeforeTwips: ptToTwips(para.spaceBeforePt ?? 0),
    spaceAfterTwips: ptToTwips(para.spaceAfterPt ?? 0),
    lineSpacing: spacing,
    indentLeftTwips: indentLeft,
    indentRightTwips: indentRight,
    indentFirstLineTwips: indentFirst,
    alignment: para.alignment ?? 'left',
    keepWithNext: para.keepWithNext ?? false,
    pageBreakBefore: para.pageBreakBefore ?? false,
  };
}
