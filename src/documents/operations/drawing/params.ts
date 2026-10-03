/**
 * 图片 / 图形的**参数模型**（WF-065–070 的语义层）。
 *
 * ## 为什么图片不是"一个节点"，而是一段未建模 XML
 *
 * `src/documents/model/types.ts` 是**冻结骨架**：它给了 `MediaPart`（包级媒体）与
 * `NodeBase.opaque`（未建模片段原样保留），但没有"图片节点"。OOXML 里图片也确实是
 * **run 的一个子元素**（`w:r/w:drawing`），D02 的导入器正是把它记成
 * `RunNode.opaque` 里的 `{kind:'raw_at_char', xml, offset}`（见 `docx/import.ts`）。
 *
 * 因此本包的表示法**跟着既有约定走**：图片 = run 里的一段 `w:drawing` 片段；
 * 参数（尺寸/旋转/裁剪/环绕/替代文字）由本模块在这段 XML 上**读写**，
 * 而不是另造一套与模型并行的结构。
 *
 * ## 单位：EMU
 *
 * 图形尺寸在 OOXML 里是 **EMU**（English Metric Units）。EMU **不在**
 * `src/documents/units/**` 的 `LengthUnit` 里（那里是 pt/mm/cm/inch/twips）。
 * 本模块用**唯一一个**常量把 `Length` 换算过去：
 *
 * ```text
 * EMU_PER_INCH = 914400（OOXML 规范定义）   twips = 1440/英寸（来自 units 的 TWIPS_PER_INCH）
 * ⇒ EMU = lengthToTwips(length) / TWIPS_PER_INCH * EMU_PER_INCH
 * ```
 *
 * 换算只此一处（`lengthToEmu`），其它文件不得再乘 914400 或 635。
 * **缺口已登记**：更干净的做法是把 EMU 并入 `units` 包，但那超出本包写权（见交付说明）。
 */

import { TWIPS_PER_INCH, lengthToTwips } from '../../units/index.js';
import type { Length } from '../../model/types.js';

/** OOXML 规范定义的 EMU 基准（每英寸）。**全包唯一出现处。** */
export const EMU_PER_INCH = 914400;

/** 旋转角在 OOXML 里是"1/60000 度"。**全包唯一出现处。** */
export const ROTATION_UNITS_PER_DEGREE = 60000;

/** 裁剪参数（`a:srcRect`）在 OOXML 里是"1/1000 百分比"，即 100000 = 100%。 */
export const CROP_UNITS_PER_PERCENT = 1000;

/** `Length` → EMU（四舍五入到整数 EMU）。 */
export function lengthToEmu(length: Length): number {
  const twips = lengthToTwips(length);
  return Math.round((twips * EMU_PER_INCH) / TWIPS_PER_INCH);
}

/** EMU → twips（≤0.5 twip 误差，用于读回显示尺寸）。 */
export function emuToTwips(emu: number): number {
  return Math.round((emu * TWIPS_PER_INCH) / EMU_PER_INCH);
}

/**
 * EMU → `Length`（指定单位）。
 *
 * 换算比例取自 `units` 本身（"该单位的 1000 单位 = 多少 twips"再除 1000），
 * 这样 mm 的 567/10 有理口径不会被本地再抄一份、也不会被 1 mm 的取整放大成 57/10。
 */
export function emuToLength(emu: number, unit: Length['unit']): Length {
  const twips = (emu * TWIPS_PER_INCH) / EMU_PER_INCH;
  const perThousand = lengthToTwips({ unit, value: 1000 });
  return { unit, value: twips / (perThousand / 1000) };
}

/** 图形尺寸（显示尺寸，EMU）。 */
export interface DrawingExtent {
  readonly cx: number;
  readonly cy: number;
}

/** 裁剪参数：**相对原图**的比例（0 = 不裁，0.1 = 裁掉 10%）。 */
export interface CropRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 无裁剪。 */
export const NO_CROP: CropRect = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

/** 环绕方式（WF-068）。 */
export type WrapMode =
  /** 嵌入正文（`wp:inline`），随文字流动。 */
  | 'inline'
  /** 四周环绕（`wp:wrapSquare`）。 */
  | 'square'
  /** 上下环绕（`wp:wrapTopAndBottom`）。 */
  | 'topAndBottom'
  /** 浮于文字上方（`wp:wrapNone` + `behindDoc=0`）。 */
  | 'inFront'
  /** 浮于文字下方（`wp:wrapNone` + `behindDoc=1`）。 */
  | 'behind';

/** 锚点（浮动对象的定位参照）。 */
export interface AnchorSpec {
  readonly horizontal_from: 'column' | 'margin' | 'page' | 'character';
  readonly horizontal_offset: number;
  readonly vertical_from: 'paragraph' | 'margin' | 'page' | 'line';
  readonly vertical_offset: number;
}

/** 默认锚点（相对栏与段落，偏移 0）。 */
export const DEFAULT_ANCHOR: AnchorSpec = Object.freeze({
  horizontal_from: 'column',
  horizontal_offset: 0,
  vertical_from: 'paragraph',
  vertical_offset: 0,
});

/** 替代文字（可及性）+ 图形名称（`wp:docPr`）。 */
export interface AltText {
  readonly name: string;
  readonly description: string;
  readonly title: string | null;
}

/** 一段 `w:drawing` 解析出来的参数。 */
export interface DrawingParams {
  /** `inline` = `wp:inline`；`anchor` = `wp:anchor`。 */
  readonly container: 'inline' | 'anchor';
  readonly extent: DrawingExtent;
  /** 旋转角（度；OOXML 的 60000 分之一度已换算回来）。 */
  readonly rotation_degrees: number;
  readonly crop: CropRect;
  readonly wrap: WrapMode;
  readonly anchor: AnchorSpec | null;
  readonly alt: AltText;
  /** 关系 id（`a:blip@r:embed`）；没有（例如文本框）时为 `null`。 */
  readonly relationship_id: string | null;
  /** 图形种类：`picture` = `pic:pic`；`shape` = 文本框/形状；`unknown` = 不认识。 */
  readonly graphic_kind: 'picture' | 'shape' | 'unknown';
}

/** 判断裁剪是否为空（四边都为 0）。 */
export function cropIsEmpty(crop: CropRect): boolean {
  return crop.left === 0 && crop.top === 0 && crop.right === 0 && crop.bottom === 0;
}

/** 裁剪比例 → OOXML 的 1/1000 百分比整数。 */
export function cropToOoxml(fraction: number): number {
  return Math.round(fraction * CROP_UNITS_PER_PERCENT * 100);
}

/** OOXML 的 1/1000 百分比整数 → 裁剪比例。 */
export function cropFromOoxml(value: number): number {
  return value / (CROP_UNITS_PER_PERCENT * 100);
}

/** 角度 → OOXML `rot` 整数（1/60000 度）。 */
export function rotationToOoxml(degrees: number): number {
  return Math.round(degrees * ROTATION_UNITS_PER_DEGREE);
}

/** OOXML `rot` → 角度。 */
export function rotationFromOoxml(rot: number): number {
  return rot / ROTATION_UNITS_PER_DEGREE;
}

/**
 * 保持纵横比时的换算：给定宽度（EMU）与**已知的原始宽高比**，算出高度。
 *
 * 宽高比来源必须**明说**：调用方给不出原始像素尺寸时，用当前显示尺寸的比值
 * （见 `setImageSize` 的文档），不凭空假设"1:1"。
 */
export function heightForWidth(widthEmu: number, aspectRatio: number): number {
  return Math.round(widthEmu / aspectRatio);
}

/** 裁剪有效性检查：四边非负、且左右（上下）合计 < 1（否则图形被裁没了）。 */
export function cropProblem(crop: CropRect): string | null {
  for (const [name, value] of Object.entries(crop)) {
    if (!Number.isFinite(value) || value < 0) {
      return `裁剪参数 ${name} 必须是非负有限数，收到 ${String(value)}`;
    }
  }
  if (crop.left + crop.right >= 1) {
    return `左右裁剪合计 ${String(crop.left + crop.right)} ≥ 1，会把图形裁得一点不剩`;
  }
  if (crop.top + crop.bottom >= 1) {
    return `上下裁剪合计 ${String(crop.top + crop.bottom)} ≥ 1，会把图形裁得一点不剩`;
  }
  return null;
}
