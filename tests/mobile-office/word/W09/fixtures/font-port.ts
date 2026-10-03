/**
 * **W09 独立测试用的确定性字体度量端口**（`verificationMode = fixture`）。
 *
 * 与 W-R03 的夹具**刻意分开**：W09 的测试要能独立跑，不依赖别的包的 test-support。
 * 口径与 W-R03 一致（Han=1.0em、Latin=0.5em、缺字回退 `.notdef`=0.5em、行高=ascent+descent），
 * 但字体表按 W09 需要裁剪成最少三族 + 一个"不存在"的族。
 *
 * 它**不是**真实字体解析，也不代表任何真机字体覆盖——真机字体在**未验证层**。
 */

import type { FontMetricsPort, Twips } from '../../../../../src/mobile-plugins/word/rendering/index.js';

type Range = readonly [number, number];

interface Band {
  readonly range: Range;
  readonly em: number;
}

interface Family {
  readonly coverage: readonly Range[];
  readonly bands: readonly Band[];
  readonly ascentEm: number;
  readonly descentEm: number;
}

const LATIN: Range = [0x20, 0x7e];
const HAN: Range = [0x4e00, 0x9fff];
const CJK_PUNCT: Range = [0x3000, 0x303f];

/** 缺字形时的 `.notdef` 前进宽（em）。 */
export const NOTDEF_EM = 0.5;

/** 字体表：`Test Mono` **不含**汉字（用于缺字路径）。 */
const FAMILIES: Readonly<Record<string, Family>> = {
  'Test Serif': {
    coverage: [LATIN, HAN, CJK_PUNCT],
    bands: [
      { range: LATIN, em: 0.5 },
      { range: HAN, em: 1.0 },
      { range: CJK_PUNCT, em: 1.0 },
    ],
    ascentEm: 0.8,
    descentEm: 0.2,
  },
  'Test Mono': {
    coverage: [LATIN],
    bands: [{ range: LATIN, em: 0.6 }],
    ascentEm: 0.75,
    descentEm: 0.25,
  },
  'Fallback Sans': {
    coverage: [LATIN, HAN, CJK_PUNCT],
    bands: [
      { range: LATIN, em: 0.5 },
      { range: HAN, em: 1.0 },
      { range: CJK_PUNCT, em: 1.0 },
    ],
    ascentEm: 0.88,
    descentEm: 0.12,
  },
};

/** 本夹具"设备上存在"的字体族。 */
export const AVAILABLE_FONTS: readonly string[] = Object.keys(FAMILIES).sort();

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** 构造夹具端口（无状态，可共享）。 */
export function createFixtureFontPort(): FontMetricsPort {
  return {
    hasFont(family: string): boolean {
      return FAMILIES[family] !== undefined;
    },
    hasGlyph(family: string, codePoint: number): boolean {
      const f = FAMILIES[family];
      return f !== undefined && inRanges(codePoint, f.coverage);
    },
    advanceWidthTwips(family: string, codePoint: number, sizeTwips: Twips): Twips {
      const f = FAMILIES[family];
      if (f === undefined) return NOTDEF_EM * sizeTwips;
      for (const band of f.bands) {
        if (codePoint >= band.range[0] && codePoint <= band.range[1]) return band.em * sizeTwips;
      }
      return NOTDEF_EM * sizeTwips;
    },
    ascentTwips(family: string, sizeTwips: Twips): Twips {
      return (FAMILIES[family]?.ascentEm ?? 0.8) * sizeTwips;
    },
    descentTwips(family: string, sizeTwips: Twips): Twips {
      return (FAMILIES[family]?.descentEm ?? 0.2) * sizeTwips;
    },
  };
}

/** A4 纵向几何：11906 × 16838 twips，四边 1440，无页眉页脚带。 */
export const A4_GEOMETRY = {
  widthTwips: 11906,
  heightTwips: 16838,
  marginsTwips: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
  headerHeightTwips: 0,
  footerHeightTwips: 0,
} as const;
