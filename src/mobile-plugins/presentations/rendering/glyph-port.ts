/**
 * **可注入字形端口**：把「平台真实字形」与「确定性替代字形 + 字体度量」组合起来。
 *
 * ## 为什么需要它
 *
 * `font.ts` 的 `createBuiltinGlyphPort()` 对非 ASCII（含全部中文）只能给**替代**字形——
 * 本仓不打包中文字库。真机上真实汉字笔画来自 APK 内字体 / Android `Paint`。本模块把那条
 * 来源做成一个**可注入**的 {@link GlyphRasterPort}：
 *
 * - 调用方传入一个实现了 {@link GlyphRasterPort} 的 **realSource**（真机字体端口）；
 * - realSource 覆盖到的码点 ⇒ 用**真实**字形像素（`substituted: false`）；
 * - 覆盖不到的码点 ⇒ 落回**确定性替代**字形（`substituted: true`，与内置端口同一位图），
 *   调用方据此如实上报 `glyph_substituted`，**不假装**画出了那个字；
 * - 前进宽度（排版口径）优先由**字体度量表**决定——这正对应「字体缺失后替代会改变版式」。
 *
 * ## 度量契约（与 P-R02 同构，但不 import 测试目录）
 *
 * {@link FontMetricsLike} 的字段与 `tests/mobile-office/presentations/P-R02/font-metrics.ts`
 * 的 `FontMetrics` 逐一对应（`family` / `aliases` / `cjk_width` / `latin_width` / `space_width` /
 * `line_height` / `cjk`）。消费端把该表（如 P-R02 的 `FONT_CATALOG`）注入进来即可；
 * 本模块**不**依赖测试目录，保持 `src` 只依赖 `src`。
 *
 * ## 边界的诚实口径
 *
 * - 替代字形**不是**目标字符的真实笔形——`substituted: true` 是契约，调用方必须上报；
 * - 真实汉字「像不像那个字」取决于注入的 realSource（真机字体），本层只保证「有真字形就用
 *   真字形、没有就如实标注替代」。
 */

import { bitmapFromGlyphRows, BUILTIN_FONT, deterministicSubstituteRows } from './font.js';
import { isCjkCodePoint } from './text-split.js';

import type { GlyphBitmap, GlyphRasterPort, GlyphRequest } from './types.js';

/**
 * 一款字体的**度量**（结构上与 P-R02 `font-metrics.ts` 的 `FontMetrics` 兼容）。
 *
 * 宽度与行高都是「字号的倍数」；`cjk` 表示该字体自带中日韩字形。
 */
export interface FontMetricsLike {
  readonly family: string;
  readonly aliases: readonly string[];
  readonly cjk_width: number;
  readonly latin_width: number;
  readonly space_width: number;
  readonly line_height: number;
  readonly cjk: boolean;
}

export interface InjectedGlyphPortOptions {
  /** 真实字形来源（真机字体端口）。它覆盖到的码点优先用真实字形。 */
  readonly source: GlyphRasterPort;
  /** 确定性字体度量表（结构同 P-R02 `FONT_CATALOG`）；决定前进宽度。 */
  readonly metrics?: readonly FontMetricsLike[];
  /**
   * 真实字形缺失时使用的替代字体族名。缺省 = 度量表里第一款 CJK 字体的族名，
   * 再退到内置字体族（`mono8`）。
   */
  readonly fallbackFamily?: string;
  /** 是否允许对缺失码点产出确定性替代字形；缺省 `true`。置 `false` ⇒ 缺字返回 `null`。 */
  readonly substitute?: boolean;
}

/** 在一个度量表里按族名或别名查一款字体。 */
export function metricsForFamily(
  metrics: readonly FontMetricsLike[] | undefined,
  family: string,
): FontMetricsLike | undefined {
  if (metrics === undefined) return undefined;
  return metrics.find((entry) => entry.family === family || entry.aliases.includes(family));
}

/** 度量表里第一款 CJK 字体（替代字体候选）。 */
function firstCjkFamily(metrics: readonly FontMetricsLike[] | undefined): string | undefined {
  return metrics?.find((entry) => entry.cjk)?.family;
}

/**
 * 用度量表算一个码点的前进宽度（像素）。无度量 / 无可用字号信息 ⇒ `null`（调用方回落）。
 *
 * 口径：空格 = `space_width × size`；CJK = `cjk_width × size`；其余 = `latin_width × size`。
 */
export function advancePxFromMetrics(
  metrics: FontMetricsLike,
  codePoint: number,
  sizePx: number,
): number {
  if (codePoint === 0x20 || codePoint === 0x09) {
    return Math.round(metrics.space_width * sizePx);
  }
  const factor = isCjkCodePoint(codePoint) ? metrics.cjk_width : metrics.latin_width;
  return Math.round(factor * sizePx);
}

/**
 * 造一个**可注入字形端口**：真机字形优先，缺失时确定性替代；前进宽度取自度量表。
 *
 * 用例：
 * ```ts
 * const port = createInjectedGlyphPort({
 *   source: createNativeSlideRasterPort(...), // 真机字体
 *   metrics: FONT_CATALOG,                    // P-R02 的确定性度量表
 *   fallbackFamily: '宋体',
 * });
 * const 中 = port.rasterize({ font: '宋体', codePoint: 0x4e2d, sizePx: 16 });
 * 中?.substituted; // false —— 真实笔画
 * ```
 */
export function createInjectedGlyphPort(options: InjectedGlyphPortOptions): GlyphRasterPort {
  const { source } = options;
  const metrics = options.metrics;
  const substitute = options.substitute ?? true;
  const fallbackFamily = options.fallbackFamily ?? firstCjkFamily(metrics) ?? BUILTIN_FONT;

  const metricsFor = (font: string): FontMetricsLike | undefined =>
    metricsForFamily(metrics, font) ?? metricsForFamily(metrics, fallbackFamily);

  /** 该码点能否给出像素：真机覆盖 / 允许替代。 */
  const canRender = (font: string, codePoint: number): boolean => {
    if (source.hasFont(font) && source.hasGlyph(font, codePoint)) return true;
    return substitute;
  };

  return {
    hasFont(font: string): boolean {
      return source.hasFont(font) || metricsForFamily(metrics, font) !== undefined || substitute;
    },
    hasGlyph(font: string, codePoint: number): boolean {
      return canRender(font, codePoint);
    },
    rasterize(request: GlyphRequest): GlyphBitmap | null {
      const size = Math.max(4, Math.round(request.sizePx));
      const codePoint = request.codePoint;
      // 1) 真机真字形优先。
      if (source.hasFont(request.font) && source.hasGlyph(request.font, codePoint)) {
        const real = source.rasterize({ font: request.font, codePoint, sizePx: size });
        if (real !== null) {
          const m = metricsFor(request.font);
          if (m === undefined) return real;
          // 覆盖前进宽度：像素来自真字形，排版宽度按度量表（替代改变版式）。
          return { ...real, advancePx: advancePxFromMetrics(m, codePoint, size) };
        }
      }
      // 2) 确定性替代。
      if (!substitute) return null;
      const m = metricsFor(request.font);
      const advance = m === undefined ? size : advancePxFromMetrics(m, codePoint, size);
      if (codePoint === 0x20) {
        return {
          widthPx: 0,
          heightPx: size,
          coverage: new Uint8Array(0),
          advancePx: advance,
          substituted: false,
          font: m?.family ?? fallbackFamily,
        };
      }
      const rows = deterministicSubstituteRows(codePoint);
      return bitmapFromGlyphRows(rows, size, {
        font: m?.family ?? fallbackFamily,
        substituted: true,
        advancePx: advance,
      });
    },
  };
}
