/**
 * **字体替代的排版差异量化**——直接调用 W09 的 `layoutDocument` 跑两次真实排版。
 *
 * - `before`：**朴素基线**。每个 run 只用一个字体（`eastAsia ?? ascii`，即手机上"整段套一个中文字体"
 *   的常见做法）。若该字体在端口上不存在，朴素基线**根本排不出来**——这不是被掩盖的错误，而是
 *   `skippedReasons` 里的一条真实结论（W09 `FontResolver` 会抛 `font_missing`）。
 * - `after`：**逐码点解析后**的排版。把每个 run 按实际使用字体切成子 run 交给 W09；只要有一个码点
 *   `unresolved_font`（连可用替代都没有），after 就不产出，原因记入 `skippedReasons`。
 *
 * 两者都产出时，`diff` 给出**真实**的页数 / 行数 / 首行宽度差异——不是断言出来的常量。
 */

import {
  layoutDocument,
  type FontMetricsPort,
  type LayoutDocumentSpec,
  type LayoutOptions,
  type LayoutResult,
  type LineBox,
  type PageGeometry,
  type ParagraphSpec,
  type RunSpec,
} from '../../../../../src/mobile-plugins/word/rendering/index.js';
import { resolveCjkFonts, type CjkRunInput } from './policy.js';
import type {
  CharFontDecision,
  CjkFontResolution,
  CjkLayoutImpact,
  CjkSubstitutionOptions,
  LayoutDiff,
  ParagraphLayoutDelta,
  Twips,
} from './types.js';

/** 默认页面几何：A4 纵向，四边 1440 twips（=2.54cm）页边距，无页眉页脚带。 */
export const DEFAULT_PAGE_GEOMETRY: PageGeometry = {
  widthTwips: 11906,
  heightTwips: 16838,
  marginsTwips: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
  headerHeightTwips: 0,
  footerHeightTwips: 0,
};

/** 把一串「已解析码点决策」按**实际使用字体**切成连续子 run。 */
export function splitDecisionsByFont(decisions: readonly CharFontDecision[]): Array<{ fontFamily: string; text: string }> {
  const out: Array<{ fontFamily: string; text: string }> = [];
  for (const d of decisions) {
    if (d.effectiveFont === null) continue; // 调用方应先判断是否可排
    const last = out[out.length - 1];
    if (last !== undefined && last.fontFamily === d.effectiveFont) {
      out[out.length - 1] = { fontFamily: last.fontFamily, text: last.text + d.char };
    } else {
      out.push({ fontFamily: d.effectiveFont, text: d.char });
    }
  }
  return out;
}

/** 朴素基线：每个输入 run 单字体（`eastAsia ?? ascii`）。 */
function naiveRun(run: CjkRunInput): RunSpec | null {
  const family = run.fonts.eastAsia ?? run.fonts.ascii;
  if (family === null) return null;
  return { text: run.text, fontFamily: family, sizePt: run.sizePt };
}

function linesOf(result: LayoutResult): readonly LineBox[] {
  return result.pages.flatMap((page) => page.lines);
}

/** 计算两份排版结果的差异。 */
export function diffLayout(before: LayoutResult, after: LayoutResult): LayoutDiff {
  const beforeLines = linesOf(before).filter((l) => l.paragraphIndex >= 0);
  const afterLines = linesOf(after).filter((l) => l.paragraphIndex >= 0);

  const index = (lines: readonly LineBox[]): Map<number, { count: number; firstWidth: Twips }> => {
    const map = new Map<number, { count: number; firstWidth: Twips }>();
    for (const line of lines) {
      const entry = map.get(line.paragraphIndex);
      if (entry === undefined) {
        map.set(line.paragraphIndex, { count: 1, firstWidth: line.widthTwips });
      } else {
        entry.count += 1;
        if (line.lineIndexInParagraph === 0) entry.firstWidth = line.widthTwips;
      }
    }
    // firstWidth 取该段 lineIndexInParagraph===0 的行；上面按出现顺序，第 0 行先出现，已正确。
    return map;
  };

  const bIndex = index(beforeLines);
  const aIndex = index(afterLines);
  const paraIds = [...new Set([...bIndex.keys(), ...aIndex.keys()])].sort((a, b) => a - b);

  const paragraphs: ParagraphLayoutDelta[] = paraIds.map((paragraphIndex) => {
    const b = bIndex.get(paragraphIndex) ?? { count: 0, firstWidth: 0 };
    const a = aIndex.get(paragraphIndex) ?? { count: 0, firstWidth: 0 };
    return {
      paragraphIndex,
      lineCountBefore: b.count,
      lineCountAfter: a.count,
      lineCountDelta: a.count - b.count,
      firstLineWidthDeltaTwips: a.firstWidth - b.firstWidth,
    };
  });

  const changedParagraphs = paragraphs
    .filter((p) => p.lineCountDelta !== 0 || p.firstLineWidthDeltaTwips !== 0)
    .map((p) => p.paragraphIndex);

  return {
    pageCountBefore: before.pages.length,
    pageCountAfter: after.pages.length,
    pageCountDelta: after.pages.length - before.pages.length,
    totalLinesBefore: beforeLines.length,
    totalLinesAfter: afterLines.length,
    totalLineDelta: afterLines.length - beforeLines.length,
    paragraphs,
    changedParagraphs,
    identical:
      before.pages.length === after.pages.length &&
      beforeLines.length === afterLines.length &&
      changedParagraphs.length === 0,
  };
}

/**
 * 测量「朴素基线 vs 逐码点替代」的排版差异。
 *
 * @param runs 输入 run（顺序即段落顺序；本包一个 run 当一个段落）。
 */
export function measureCjkLayoutImpact(
  runs: readonly CjkRunInput[],
  port: FontMetricsPort,
  options: CjkSubstitutionOptions,
  geometry: PageGeometry = DEFAULT_PAGE_GEOMETRY,
): CjkLayoutImpact {
  const resolution: CjkFontResolution = resolveCjkFonts(runs, port, options);
  const skippedReasons: string[] = [];

  // --- before：朴素基线 ---
  const naiveRuns: RunSpec[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const spec = naiveRun(runs[i] as CjkRunInput);
    if (spec === null) {
      skippedReasons.push(`paragraph ${i}: 字体槽未设置，朴素基线无法取字体`);
      continue;
    }
    if (!port.hasFont(spec.fontFamily)) {
      skippedReasons.push(`paragraph ${i}: 请求字体「${spec.fontFamily}」在端口不存在，朴素基线排不出来`);
      continue;
    }
    naiveRuns.push(spec);
  }

  let before: LayoutResult | null = null;
  if (naiveRuns.length === runs.length && runs.length > 0) {
    const beforeSpec: LayoutDocumentSpec = {
      geometry,
      paragraphs: naiveRuns.map((run): ParagraphSpec => ({ runs: [run], alignment: 'left' })),
    };
    const layoutOptions: LayoutOptions = {}; // 不传 substituteFont：基线就是"用请求字体硬排"。
    before = layoutDocument(beforeSpec, port, layoutOptions);
  }

  // --- after：逐码点替代 ---
  let cursor = 0;
  let afterBlocked = false;
  const afterParagraphs: ParagraphSpec[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i] as CjkRunInput;
    let cpCount = 0;
    for (const _ of run.text) cpCount += 1;
    const slice = resolution.decisions.slice(cursor, cursor + cpCount);
    cursor += cpCount;
    if (slice.some((d) => d.effectiveFont === null)) {
      skippedReasons.push(`paragraph ${i}: 存在 unresolved_font（无可用替代），替代后排版不产出`);
      afterBlocked = true;
      break;
    }
    const subRuns = splitDecisionsByFont(slice).map(
      (s): RunSpec => ({ text: s.text, fontFamily: s.fontFamily, sizePt: run.sizePt }),
    );
    afterParagraphs.push({ runs: subRuns, alignment: 'left' });
  }

  let after: LayoutResult | null = null;
  if (!afterBlocked && afterParagraphs.length === runs.length && runs.length > 0) {
    after = layoutDocument({ geometry, paragraphs: afterParagraphs }, port, {});
  }

  const diff = before !== null && after !== null ? diffLayout(before, after) : null;
  return { resolution, before, after, diff, skippedReasons };
}
