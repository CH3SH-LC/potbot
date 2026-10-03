/**
 * **中文字体替代策略 + 缺字/字体缺失的显式反馈**（纯计算）。
 *
 * 逐码点做两件事：
 *
 * 1. 按脚本从 `FontSlotSet` 选槽（Han/Kana/Hangul→`eastAsia`，其余→`ascii`），得到**请求字体**。
 * 2. 请求字体在端口上存在且覆盖该字形 → `kept`；否则沿该脚本的候选链找一个**端口确认存在**
 *    且**覆盖该字形**的替代 → `substituted`；候选存在但都不覆盖 → `unresolved_glyph`（出豆腐块，
 *    但**明确登记**）；连候选都没有 → `unresolved_font`（严格模式下抛错）。**全程无静默换字体。**
 *
 * 与 W09 `FontResolver` 的分工：W09 的替代是**单一回调 + 单字体**，粒度是「一个 run 一个字体」；
 * 本包是**逐码点 + 槽感知 + 逐脚本候选链**，粒度到「一个码点」。因此本包**不改 W09**，
 * 而是给它喂**已切好的 run**（见 `layout-impact.ts`）。
 */

import { codePointsOf, type FontMetricsPort } from '../../../../../src/mobile-plugins/word/rendering/index.js';
import { scriptOf, slotOf } from './scripts.js';
import {
  CjkFontError,
  type CharFontDecision,
  type CjkFallbackChains,
  type CjkFontResolution,
  type CjkSubstitutionOptions,
  type FontSlotSet,
  type FontSubstitutionReport,
  type MissingGlyphRecord,
  type MissingGlyphReport,
  type ScriptClass,
  type SubstitutionRecord,
} from './types.js';

/** 一个 run 的输入：文本 + 字号（pt）+ 字体槽。 */
export interface CjkRunInput {
  readonly text: string;
  readonly sizePt: number;
  readonly fonts: FontSlotSet;
}

/** 从槽集合取出该槽的字体族（槽未设置返回 `null`）。 */
export function slotFamily(fonts: FontSlotSet, slot: 'ascii' | 'eastAsia'): string | null {
  return slot === 'eastAsia' ? fonts.eastAsia : fonts.ascii;
}

/** 空槽（两槽都未设置）时的说明字符串，保证 `missingFonts` 里不出现字面 `null` 歧义。 */
const UNSET_FONT_LABEL = '(未设置)';

interface AggregatedSubstitution extends SubstitutionRecord {
  affectedOccurrences: number;
}

/** 内部可变聚合器。 */
class ReportBuilder {
  private readonly subs = new Map<string, { rec: AggregatedSubstitution }>();
  private readonly glyphs = new Map<string, { rec: MissingGlyphRecord }>();
  private readonly missingFonts = new Set<string>();
  private readonly usedFonts = new Set<string>();
  private totalMissingOccurrences = 0;

  noteUsed(font: string | null): void {
    if (font !== null) this.usedFonts.add(font);
  }

  noteMissingFont(font: string | null): void {
    this.missingFonts.add(font ?? UNSET_FONT_LABEL);
  }

  noteSubstitution(requested: string, substitutedBy: string, script: ScriptClass, reason: 'font_absent' | 'glyph_absent'): void {
    const key = `${requested}\u0000${script}\u0000${reason}`;
    const existing = this.subs.get(key);
    if (existing) {
      existing.rec = { ...existing.rec, affectedOccurrences: existing.rec.affectedOccurrences + 1 };
      return;
    }
    this.subs.set(key, { rec: { requestedFont: requested, substitutedBy, script, reason, affectedOccurrences: 1 } });
  }

  noteMissingGlyph(
    font: string,
    char: string,
    codePoint: number,
    script: ScriptClass,
    recoveredBySubstitution: boolean,
    substitutedBy: string | null,
  ): void {
    this.totalMissingOccurrences += 1;
    const key = `${font}\u0000${codePoint}`;
    const existing = this.glyphs.get(key);
    if (existing) {
      existing.rec = {
        ...existing.rec,
        occurrences: existing.rec.occurrences + 1,
        // 只要有一次没被恢复，整体就按未恢复计（宁可更严格）。
        recoveredBySubstitution: existing.rec.recoveredBySubstitution && recoveredBySubstitution,
        substitutedBy: existing.rec.substitutedBy ?? substitutedBy,
      };
      return;
    }
    this.glyphs.set(key, {
      rec: { font, codePoint, char, script, occurrences: 1, recoveredBySubstitution, substitutedBy },
    });
  }

  fonts(): FontSubstitutionReport {
    return {
      substitutions: [...this.subs.values()]
        .map((v) => v.rec)
        .sort((a, b) =>
          a.requestedFont === b.requestedFont
            ? a.script === b.script
              ? a.reason.localeCompare(b.reason)
              : a.script.localeCompare(b.script)
            : a.requestedFont.localeCompare(b.requestedFont),
        ),
      missingFonts: [...this.missingFonts].sort(),
      usedFonts: [...this.usedFonts].sort(),
      explicit: true,
    };
  }

  glyphReport(): MissingGlyphReport {
    const records = [...this.glyphs.values()]
      .map((v) => v.rec)
      .sort((a, b) => (a.font === b.font ? a.codePoint - b.codePoint : a.font.localeCompare(b.font)));
    const unresolved = records.filter((r) => !r.recoveredBySubstitution).length;
    return {
      records,
      totalMissingOccurrences: this.totalMissingOccurrences,
      distinctMissingCodePoints: records.length,
      unresolvedCodePoints: unresolved,
      fontsWithMissingGlyphs: [...new Set(records.map((r) => r.font))].sort(),
      complete: unresolved === 0,
    };
  }
}

/**
 * 解析一组 run 的字体替代。
 *
 * @throws CjkFontError('invalid_input') 当某个 run 的 `sizePt <= 0` 或文本为空。
 * @throws CjkFontError('font_missing') 当 `options.strict` 且出现 `unresolved_font`。
 */
export function resolveCjkFonts(
  runs: readonly CjkRunInput[],
  port: FontMetricsPort,
  options: CjkSubstitutionOptions,
): CjkFontResolution {
  if (runs.length === 0) {
    throw new CjkFontError('invalid_input', { field: 'runs（至少一个 run）' });
  }
  const available = new Set(options.availableFonts);
  const usableCandidate = (family: string): boolean => available.has(family) && port.hasFont(family);

  const builder = new ReportBuilder();
  const decisions: CharFontDecision[] = [];

  runs.forEach((run, runIndex) => {
    if (run.text.length === 0) {
      throw new CjkFontError('invalid_input', { field: `runs[${runIndex}].text（空 run）` });
    }
    if (!(run.sizePt > 0)) {
      throw new CjkFontError('invalid_input', { field: `runs[${runIndex}].sizePt（必须 > 0）` });
    }
    for (const { char, codePoint } of codePointsOf(run.text)) {
      const script = scriptOf(codePoint);
      const slot = slotOf(script);
      const requested = slotFamily(run.fonts, slot);
      const chain = options.fallbacks[script];

      // 0) 槽未设置：没有「请求的字体」可替代。不凭空发明字体（继承级联是 W03 的事）。
      if (requested === null) {
        if (options.strict) throw new CjkFontError('font_missing', { requestedFont: undefined, script });
        decisions.push({
          char, codePoint, script, slot,
          requestedFont: null, effectiveFont: null,
          status: 'unresolved_font', reason: 'no_candidate',
        });
        builder.noteMissingFont(null);
        continue;
      }

      // 1) 请求字体存在且覆盖该字形 —— 原样保留。
      if (requested !== null && port.hasFont(requested) && port.hasGlyph(requested, codePoint)) {
        decisions.push({
          char, codePoint, script, slot,
          requestedFont: requested, effectiveFont: requested,
          status: 'kept', reason: 'none',
        });
        builder.noteUsed(requested);
        continue;
      }

      // 2) 沿候选链找替代：firstPresent 记「存在但缺字形」的兜底，covering 记「存在且覆盖」的最优。
      let firstPresent: string | null = null;
      let covering: string | null = null;
      for (const cand of chain) {
        if (cand === requested) continue; // 请求字体本身不算替代
        if (!usableCandidate(cand)) continue;
        if (firstPresent === null) firstPresent = cand;
        if (port.hasGlyph(cand, codePoint)) {
          covering = cand;
          break;
        }
      }

      if (covering !== null) {
        // 2a) 成功替代。
        const reason: 'font_absent' | 'glyph_absent' = port.hasFont(requested) ? 'glyph_absent' : 'font_absent';
        decisions.push({
          char, codePoint, script, slot,
          requestedFont: requested, effectiveFont: covering,
          status: 'substituted', reason,
        });
        builder.noteUsed(covering);
        builder.noteSubstitution(requested, covering, script, reason);
        if (reason === 'glyph_absent') {
          // 原始字体确实缺这个字形，被替代恢复了 —— 登记为「已恢复的缺字」。
          builder.noteMissingGlyph(requested, char, codePoint, script, true, covering);
        }
        continue;
      }

      if (firstPresent !== null) {
        // 2b) 有候选但都不覆盖该字形 —— 出豆腐块，但**显式登记**（不丢字、不假装完整）。
        decisions.push({
          char, codePoint, script, slot,
          requestedFont: requested, effectiveFont: firstPresent,
          status: 'unresolved_glyph', reason: 'candidate_lacks_glyph',
        });
        builder.noteUsed(firstPresent);
        builder.noteMissingGlyph(firstPresent, char, codePoint, script, false, null);
        continue;
      }

      // 2c) 连可用候选都没有 —— 整族缺失。
      if (options.strict) {
        throw new CjkFontError('font_missing', { requestedFont: requested ?? undefined, script });
      }
      decisions.push({
        char, codePoint, script, slot,
        requestedFont: requested, effectiveFont: null,
        status: 'unresolved_font', reason: 'no_candidate',
      });
      builder.noteMissingFont(requested);
    }
  });

  const fonts = builder.fonts();
  const glyphs = builder.glyphReport();
  return { decisions, fonts, glyphs, fontsComplete: fonts.missingFonts.length === 0 };
}

/** 从候选链里取该脚本的一条链；缺失即返回空数组（不编造默认链）。 */
export function chainFor(chains: CjkFallbackChains, script: ScriptClass): readonly string[] {
  return chains[script];
}
