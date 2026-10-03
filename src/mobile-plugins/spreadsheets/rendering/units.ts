/**
 * **X09 手机侧表格打印/分页——单位与纸张几何**。
 *
 * 本包用 **twips**（1/1440 英寸）作内部几何单位，与 `src/documents/units/constants.ts`
 * 及 Word 排版包（`src/mobile-plugins/word/rendering`）保持同一口径，便于两条 Office 线
 * 共用一套"物理长度"心智。Excel 原生单位与 twips 的换算见下（**列宽换算是近似**，见注释）。
 */

import {
  PAPER_DIMENSIONS_INCHES,
  type PageOrientation,
  type PaperSizeName,
} from '../../../spreadsheets/print-layout.js';

/** OOXML 长度内部单位。1 英寸 = 1440 twips。 */
export type Twips = number;

/** 1 英寸 = 1440 twips（全项目统一换算来源）。 */
export const TWIPS_PER_INCH = 1440;

/** 1 点 = 20 twips。 */
export const TWIPS_PER_POINT = 20;

/** 1 英寸 = 72 点（PostScript 点）。 */
export const POINTS_PER_INCH = 72;

/** Excel 默认字号（Calibri 11）下"最大数字宽度"的像素值（96 dpi）。 */
export const DEFAULT_MAX_DIGIT_WIDTH_PX = 7;

export function inchesToTwips(inches: number): Twips {
  return inches * TWIPS_PER_INCH;
}

export function twipsToInches(twips: Twips): number {
  return twips / TWIPS_PER_INCH;
}

export function pointsToTwips(points: number): Twips {
  return points * TWIPS_PER_POINT;
}

export function twipsToPoints(twips: Twips): number {
  return twips / TWIPS_PER_POINT;
}

/** 像素（96 dpi）→ twips。 */
export function pixelsToTwips(pixels: number): Twips {
  return (pixels * TWIPS_PER_INCH) / 96;
}

/**
 * Excel 列宽（"字符宽度"单位，即 OOXML `<col width>` 的值）→ twips。
 *
 * 换算按 Excel 的公开口径：`px = round(widthChars × MDW) + 5`，再按 96 dpi 折成 twips，
 * 其中 `MDW` 是默认字体最大数字宽度（Calibri 11 = 7 px）。
 *
 * **这是近似**：真实像素宽度取决于工作簿的默认字体（`xl/styles.xml` 的 `fonts[0]`）与
 * 其数字宽度；调用方若知道真实 MDW 可传入 `maxDigitWidthPx`。**未验证**在非默认字体下
 * 与真实 Excel 的渲染逐像素一致（那属真机/消费端）。
 */
export function excelColumnWidthToTwips(widthChars: number, maxDigitWidthPx = DEFAULT_MAX_DIGIT_WIDTH_PX): Twips {
  const pixels = Math.round(widthChars * maxDigitWidthPx) + 5;
  return pixelsToTwips(pixels);
}

/**
 * Excel 行高（点，即 OOXML `<row ht>` 的值）→ twips。行高在文件里本就是点，直接换算。
 */
export function excelRowHeightToTwips(points: number): Twips {
  return pointsToTwips(points);
}

/** 纸张物理尺寸（twips）。`orientation` 为横向时交换宽高。 */
export function paperSizeTwips(
  paper: PaperSizeName,
  orientation: PageOrientation,
): { readonly widthTwips: Twips; readonly heightTwips: Twips } {
  const [wIn, hIn] = PAPER_DIMENSIONS_INCHES[paper];
  const portraitW = inchesToTwips(wIn);
  const portraitH = inchesToTwips(hIn);
  return orientation === 'landscape'
    ? { widthTwips: portraitH, heightTwips: portraitW }
    : { widthTwips: portraitW, heightTwips: portraitH };
}
