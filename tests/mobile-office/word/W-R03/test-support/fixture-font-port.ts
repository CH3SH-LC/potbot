/**
 * **确定性合成字体度量端口**（W-R03 测试用夹具；`verificationMode = fixture`）。
 *
 * ## 它是什么、不是什么
 *
 * - **是**：一个按区间声明字形覆盖、按「em 比例 × 字号」算前进宽度的**纯函数端口**，实现 W09 的
 *   `FontMetricsPort`。它让「缺字 / 整族缺失 / 替代后排版变宽」这些路径可**确定性复现**。
 * - **不是**：真实字体文件解析，也不是任何真机字体表。真机字体覆盖情况在**未验证层**（见 RUNBOOK）。
 *
 * ## 建模口径（写清楚，避免把模型当实测）
 *
 * - 中文（Han/Kana/Hangul/全角形）：前进宽 = **1.0 em**；西文：**0.5 em**。
 * - **缺字形**时前进宽回退到 `.notdef` = **0.5 em**（豆腐块通常窄于汉字），**不为 0**——与 W09
 *   `line-break.ts` 「缺字按 .notdef 宽度排版、不丢字」的口径一致。
 * - 行高 = 上升部 + 下降部，本夹具各字体统一 1.0 em（因此差异主要由**字宽**驱动，便于断言）。
 *
 * ## 字体表（刻意制造四类场景）
 *
 * | 字体 | 存在 | 覆盖 | 用途 |
 * |---|---|---|---|
 * | `Calibri` | 是 | 仅西文 | 被误设为 `eastAsia` 槽 ⇒ 触发 `glyph_absent` 替代 |
 * | `Noto Sans SC` | 是 | 中文 + 西文 | `han` 候选；**不含**扩展 B（U+20000） |
 * | `Source Han Sans` | 是 | 中文 + 谚文 + 西文 | `han`/`hangul` 候选；**不含**扩展 B |
 * | `MS Gothic` | 是 | 假名 + 汉字 + 西文 | `kana` 候选 |
 * | `Batang` | 是 | 谚文 + 西文 | `hangul` 候选 |
 * | `SimSun` | **否** | — | 触发 `font_absent` 替代 / `unresolved_font` |
 */

import type { FontMetricsPort, Twips } from '../../../../../src/mobile-plugins/word/rendering/index.js';

type Range = readonly [number, number];
interface AdvanceBand {
  readonly range: Range;
  /** 前进宽的 em 比例（× 字号 twips）。 */
  readonly em: number;
}
interface FixtureFamily {
  /** 有字形的码点区间。 */
  readonly coverage: readonly Range[];
  /** 有序的前进宽分带；未命中回退到 `.notdef`。 */
  readonly advances: readonly AdvanceBand[];
  readonly ascentEm: number;
  readonly descentEm: number;
}

const LATIN: Range = [0x20, 0x7e];
const HAN: Range = [0x4e00, 0x9fff];
const CJK_PUNCT: Range = [0x3000, 0x303f];
const KANA: Range = [0x3040, 0x30ff];
const HALFWIDTH_KANA: Range = [0xff66, 0xff9d];
const FULLWIDTH: Range = [0xff00, 0xffef];
const HANGUL: Range = [0xac00, 0xd7a3];

/** 缺字形时的 `.notdef` 前进宽（em）。 */
export const NOTDEF_EM = 0.5;

const FAMILIES: Readonly<Record<string, FixtureFamily>> = {
  Calibri: {
    coverage: [LATIN, [0xa0, 0x24f]],
    advances: [{ range: LATIN, em: 0.5 }, { range: [0xa0, 0x24f], em: 0.5 }],
    ascentEm: 0.75,
    descentEm: 0.25,
  },
  'Noto Sans SC': {
    coverage: [LATIN, CJK_PUNCT, KANA, HAN, FULLWIDTH],
    advances: [
      { range: LATIN, em: 0.5 },
      { range: CJK_PUNCT, em: 1.0 },
      { range: KANA, em: 1.0 },
      { range: HAN, em: 1.0 },
      { range: FULLWIDTH, em: 1.0 },
    ],
    ascentEm: 0.88,
    descentEm: 0.12,
  },
  'Source Han Sans': {
    coverage: [LATIN, CJK_PUNCT, KANA, HAN, FULLWIDTH, HANGUL],
    advances: [
      { range: LATIN, em: 0.5 },
      { range: CJK_PUNCT, em: 1.0 },
      { range: KANA, em: 1.0 },
      { range: HAN, em: 1.0 },
      { range: FULLWIDTH, em: 1.0 },
      { range: HANGUL, em: 1.0 },
    ],
    ascentEm: 0.88,
    descentEm: 0.12,
  },
  'MS Gothic': {
    coverage: [LATIN, KANA, HALFWIDTH_KANA, CJK_PUNCT, HAN],
    advances: [
      { range: LATIN, em: 0.5 },
      { range: KANA, em: 1.0 },
      { range: HALFWIDTH_KANA, em: 0.5 },
      { range: CJK_PUNCT, em: 1.0 },
      { range: HAN, em: 1.0 },
    ],
    ascentEm: 0.88,
    descentEm: 0.12,
  },
  Batang: {
    coverage: [LATIN, HANGUL, [0x1100, 0x11ff]],
    advances: [
      { range: LATIN, em: 0.5 },
      { range: HANGUL, em: 1.0 },
      { range: [0x1100, 0x11ff], em: 1.0 },
    ],
    ascentEm: 0.86,
    descentEm: 0.14,
  },
};

/** 本夹具端口「设备上真实存在」的字体族集合。 */
export const FIXTURE_AVAILABLE_FONTS: readonly string[] = Object.keys(FAMILIES).sort();

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function familyOf(family: string): FixtureFamily | undefined {
  return FAMILIES[family];
}

/** 构造一个可复用的夹具端口。无状态，可安全共享。 */
export function createFixtureFontPort(): FontMetricsPort {
  return {
    hasFont(family: string): boolean {
      return familyOf(family) !== undefined;
    },
    hasGlyph(family: string, codePoint: number): boolean {
      const spec = familyOf(family);
      return spec !== undefined && inRanges(codePoint, spec.coverage);
    },
    advanceWidthTwips(family: string, codePoint: number, sizeTwips: Twips): Twips {
      const spec = familyOf(family);
      if (spec === undefined) return NOTDEF_EM * sizeTwips;
      for (const band of spec.advances) {
        if (codePoint >= band.range[0] && codePoint <= band.range[1]) return band.em * sizeTwips;
      }
      return NOTDEF_EM * sizeTwips; // 缺字形 ⇒ .notdef
    },
    ascentTwips(family: string, sizeTwips: Twips): Twips {
      return (familyOf(family)?.ascentEm ?? 0.8) * sizeTwips;
    },
    descentTwips(family: string, sizeTwips: Twips): Twips {
      return (familyOf(family)?.descentEm ?? 0.2) * sizeTwips;
    },
  };
}

/** 本夹具推荐的逐脚本候选链（测试与 runbook 共用的确定性配置）。 */
export const FIXTURE_FALLBACKS = {
  han: ['Source Han Sans', 'Noto Sans SC', 'MS Gothic'],
  kana: ['MS Gothic', 'Source Han Sans', 'Noto Sans SC'],
  hangul: ['Batang', 'Source Han Sans'],
  latin: ['Calibri', 'Source Han Sans'],
  other: ['Source Han Sans', 'Calibri'],
} as const;
