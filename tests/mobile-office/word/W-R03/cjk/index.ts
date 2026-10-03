/**
 * **W-R03 — 中文字体替代 / 缺字反馈 / 排版差异**公开出口。
 *
 * 纯计算，无第三方依赖，不读文件系统；度量从 W09 的 `FontMetricsPort` 注入。
 *
 * ```ts
 * import { resolveCjkFonts, measureCjkLayoutImpact } from './cjk/index.js';
 * const res = resolveCjkFonts(runs, port, { availableFonts, fallbacks });
 * res.glyphs.complete; // false ⇒ 有未恢复缺字，必须反馈给用户
 * ```
 */

export { resolveCjkFonts, slotFamily, chainFor } from './policy.js';
export type { CjkRunInput } from './policy.js';

export { isKana, isHangul, isHan, isLatin, scriptOf, slotOf } from './scripts.js';

export { diffLayout, measureCjkLayoutImpact, splitDecisionsByFont, DEFAULT_PAGE_GEOMETRY } from './layout-impact.js';

export {
  CjkFontError,
  describeCjkFontError,
  CJK_FONT_SUBSTITUTION_OPERATION,
} from './types.js';
export type {
  CharFontDecision,
  CjkFallbackChains,
  CjkFontErrorCode,
  CjkFontErrorDetail,
  CjkFontResolution,
  CjkLayoutImpact,
  CjkOperationDescriptor,
  CjkSubstitutionOptions,
  FontSlotSet,
  FontSubstitutionReport,
  LayoutDiff,
  MissingGlyphRecord,
  MissingGlyphReport,
  ParagraphLayoutDelta,
  ScriptClass,
  SubstitutionRecord,
  Twips,
} from './types.js';
