/**
 * 演示域**统一排版与版面体检**层（design-06 P9；PPT-13）。
 *
 * ## 这一层解决什么
 *
 * PPT-13 要求"统一排版、文本溢出 / 遮挡 / 越界检查、对比和字体替代；**不同内容长度下检查真实渲染**"。
 * 前四项是"读"（体检），第一项是"写"（统一）。本模块给出：
 *
 * - `checkSlideLayout` / `checkPresentationLayout`：**可解释**的体检——每条结论都带
 *   `code` / `shape_id` 与**具体数字**（估算高度、可用高度、对比度比值…），不是一个布尔；
 * - `uniformLayout`：把一页（或整份）的文本对象统一到同一套边距、同一内容宽度、统一字号与字体；
 * - `estimateTextHeightEmu`：**按文本长度与字号估算框高**——这是"真实渲染"的可计算替身：
 *   内容变长 ⇒ 估算行数变多 ⇒ 框高估算变大 ⇒ 溢出判定随之翻转（不同长度下结论不同）。
 *
 * ## "真实渲染"到什么程度（**如实登记**）
 *
 * 本模块**不做像素级排版**（那需要真实字体度量与渲染引擎）。它用**字符宽度模型**估算：
 * 全角字符按 1.0×字号、半角按约 0.5×字号、空格按 0.25×字号，再按贪心换行累计行数，
 * 行高按 1.2×字号。结论因此是**可解释的近似**，用于"会不会溢出"这类量级判断。
 * 它**不是**"经 PowerPoint 实测的渲染结论"——真机 / 消费端实测本轮**未验证**。
 *
 * ## 已补的边界（本增量）
 *
 * - **旋转感知包围盒**：`rotation_deg != 0` 的对象按绕中心旋转后的**轴对齐外接矩形**判定越界 /
 *   遮挡（{@link rotatedBounds}），不再漏报"转了个角就压到邻居"。
 * - **合并单元格**：表格源格按 `col_span` 把所跨各列宽求和作为可用宽度、`row_span × 行高`
 *   作为可用高度，溢出如实上报（旧模型整张表跳过）。
 * - **版式/母版继承**：调用方传 `inherited_placeholders` 时，自身几何未解析（`cx/cy <= 0`）的
 *   占位符按名字继承版式/母版几何后再体检（{@link resolveInheritedTransform}）。
 * - **BiDi / 组合字符前进**：组合附加符号、双向控制符、连接符、变体选择符记**零宽**，RTL 字母按
 *   半角计（{@link isZeroWidthCodePoint} / {@link isRtlCodePoint}），不再高估混排文本宽度。
 *
 * ## 仍然的边界（如实登记）
 *
 * - 版式/母版几何**不由本层读取**：模型不携带 `p:sp` 继承链，需调用方解析后经
 *   `inherited_placeholders` 传入；不传即退化为"只用幻灯片自身几何"。
 * - 逐行行高：模型无逐行高度，表格用 `table_row_height_emu`（缺省渲染器常量）。
 * - 对比度按 WCAG 相对亮度公式；纯色背景取 `auto_shape` 的填充色，文本框按白底（可用
 *   `slide_background_color` 覆盖）。渐变 / 图片背景不参与计算。
 * - 文本高度仍是**字符宽度模型**的可计算替身，非像素级排版；真机 / 消费端实测仍未验证。
 */

import { ValidationError } from '../protocol/index.js';

import { createBuiltinGlyphPort } from '../mobile-plugins/presentations/rendering/index.js';
import {
  layoutParagraphs,
  type GlyphRasterPort,
  type ResolvedParagraph,
} from '../mobile-plugins/presentations/rendering/index.js';

import type {
  Paragraph,
  Presentation,
  Shape,
  Slide,
  SlideSize,
  TableShape,
  TextBody,
  TextRun,
  Transform,
} from './model.js';

import { DEFAULT_ROW_HEIGHT_EMU } from './tables.js';

/** EMU / pt 换算（1 pt = 12700 EMU）。 */
export const EMU_PER_PT = 12700;

/** 文本体内边距（左右 0.1 英寸、上下 0.05 英寸，与 PowerPoint 默认一致）。 */
const INSET_LR_EMU = 91440;
const INSET_TB_EMU = 45720;

/** 行高系数（单倍行距）。 */
const LINE_HEIGHT_FACTOR = 1.2;

/** 每级缩进（0.5 英寸）。 */
const LEVEL_INDENT_EMU = 457200;

/** 默认正文字号（未在 run 上显式指定时）。 */
const DEFAULT_BODY_SIZE_PT = 18;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 版面体检层失败原因（具名）。 */
export type LayoutCheckErrorReason = 'unknown_slide' | 'invalid_slide_size' | 'invalid_options';

/** 版面体检层错误：语义不成立时抛出，**不静默**。 */
export class LayoutCheckError extends ValidationError {
  readonly reason: LayoutCheckErrorReason;

  constructor(reason: LayoutCheckErrorReason, message: string) {
    super(message);
    this.name = 'LayoutCheckError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 文本度量（"真实渲染"的可计算替身）
// ---------------------------------------------------------------------------

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * 零宽码点：**组合附加符号 / 双向与格式控制符 / 连接符 / 变体选择符 / 零宽空白**。
 *
 * 这些字符渲染时**不前进横向光标**（与基字符合成同一个字形簇，或仅控制双向排序）。
 * 旧模型把每个码点都算 0.5×字号，会把 `é` 记成两个字符、把 `‫` 之类的
 * 双向嵌入符记成一个全角字，从而**高估**文本宽度、掩盖真实的溢出行数——这是真实稿件上
 * 溢出被少报的一个来源。此处按零宽处理（PPT-13 的"真实渲染"替身向前一步）。
 */
export function isZeroWidthCodePoint(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // 组合用变音符号
    (code >= 0x0483 && code <= 0x0489) || // 西里尔组合符
    (code >= 0x0591 && code <= 0x05bd) || // 希伯来元音点（含 05BF/05C1-05C2）
    (code >= 0x05bf && code <= 0x05c2) ||
    (code >= 0x0610 && code <= 0x061a) || // 阿拉伯符号
    (code >= 0x064b && code <= 0x065f) ||
    (code === 0x0670) ||
    (code >= 0x06d6 && code <= 0x06dc) ||
    (code >= 0x06df && code <= 0x06e4) ||
    (code >= 0x06e7 && code <= 0x06e8) ||
    (code >= 0x06ea && code <= 0x06ed) ||
    (code >= 0x1ab0 && code <= 0x1aff) || // 组合附加符号扩展
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x200b && code <= 0x200f) || // 零宽空白 / 连接符 / 方向标记
    (code >= 0x202a && code <= 0x202e) || // LRE/RLE/PDF/LRO/RLO 双向嵌入
    (code >= 0x2060 && code <= 0x2064) || // 词连接符 / 不可见运算符
    (code >= 0x2066 && code <= 0x206f) || // LRI/RLI/FSI/PDI 等双向隔离
    (code >= 0x20d0 && code <= 0x20ff) || // 符号用组合符
    (code >= 0xfe00 && code <= 0xfe0f) || // 变体选择符
    (code >= 0xfe20 && code <= 0xfe2f) || // 组合用半符号
    (code === 0xfeff) ||                  // BOM / ZWNBSP
    (code >= 0xe0100 && code <= 0xe01ef)  // 变体选择符补充
  );
}

/**
 * 双向文字（RTL）字母码点：希伯来 / 阿拉伯 / 叙利亚 / 它拿 / 撒玛利亚 / 曼达 / 部分扩展。
 *
 * 这些**字母**不是表意全角字，横向前进约 0.5×字号（与拉丁字母同量级）；而 RTL 串里夹的
 * 双向控制符由 {@link isZeroWidthCodePoint} 记零宽。两者合起来，RTL 混排（BiDi）文本的
 * 前进宽度才不会被系统性高估或低估。
 */
export function isRtlCodePoint(code: number): boolean {
  return (
    (code >= 0x0590 && code <= 0x05ff) || // 希伯来
    (code >= 0x0600 && code <= 0x06ff) || // 阿拉伯
    (code >= 0x0700 && code <= 0x074f) || // 叙利亚
    (code >= 0x0750 && code <= 0x077f) || // 阿拉伯补充
    (code >= 0x0780 && code <= 0x07bf) || // 它拿
    (code >= 0x07c0 && code <= 0x07ff) || // 西非书面文字
    (code >= 0x0800 && code <= 0x083f) || // 撒玛利亚
    (code >= 0x0840 && code <= 0x085f) || // 曼达
    (code >= 0xfb1d && code <= 0xfb4f) || // 希伯来呈现形式
    (code >= 0xfb50 && code <= 0xfdff) || // 阿拉伯呈现形式
    (code >= 0xfe70 && code <= 0xfeff)    // 阿拉伯呈现形式 B
  );
}

/**
 * 单字符宽度（pt）。全角 1.0×字号，半角约 0.5×字号，空白 0.25×字号，**零宽字符 0**。
 *
 * `for…of` 按**码点**迭代，代理对（星平面字符）在这里是**一个** `ch`；组合序列在此模型里
 * 表现为"基字符占宽 + 后续组合符 0 宽"（即一个字形簇只算一次前进）。
 */
export function charWidthPt(ch: string, sizePt: number): number {
  if (ch === ' ' || ch === '\t') return 0.25 * sizePt;
  const code = ch.codePointAt(0) ?? 0;
  if (isZeroWidthCodePoint(code)) return 0;
  return (isWideChar(code) ? 1.0 : 0.5) * sizePt;
}

function runPlainText(run: TextRun): string {
  return run.source.kind === 'literal' ? run.source.text : '（未提供）';
}

/** 一个段落在给定可用宽度下的估算高度（EMU）与最大字号。 */
export interface ParagraphMetrics {
  readonly lines: number;
  readonly max_size_pt: number;
  readonly height_emu: number;
}

/**
 * 估算一个段落的行数与高度（贪心换行；**内容长度直接决定行数**）。
 *
 * @param availableWidthEmu 该段落可用的横向像素（已扣掉文本体内边距与该级缩进）。
 */
export function estimateParagraphMetrics(
  paragraph: Paragraph,
  availableWidthEmu: number,
  defaultSizePt: number = DEFAULT_BODY_SIZE_PT,
): ParagraphMetrics {
  const width = Math.max(1, availableWidthEmu);
  let maxSize = defaultSizePt;
  let lines = 1;
  let cursor = 0;
  for (const run of paragraph.runs) {
    const size = run.style?.size_pt ?? defaultSizePt;
    if (size > maxSize) maxSize = size;
    for (const ch of runPlainText(run)) {
      const w = charWidthPt(ch, size) * EMU_PER_PT;
      if (cursor + w > width && cursor > 0) {
        lines += 1;
        cursor = 0;
      }
      cursor += w;
    }
  }
  const lineHeight = maxSize * LINE_HEIGHT_FACTOR * EMU_PER_PT;
  return {
    lines,
    max_size_pt: maxSize,
    height_emu: Math.round(lines * lineHeight),
  };
}

/** 一个文本体在给定框宽下的估算总高（EMU）。段落之间按 0.2×字号留间距。 */
export function estimateTextHeightEmu(
  body: TextBody,
  boxWidthEmu: number,
  defaultSizePt: number = DEFAULT_BODY_SIZE_PT,
): number {
  let total = 0;
  let first = true;
  for (const paragraph of body.paragraphs) {
    const available = boxWidthEmu - INSET_LR_EMU * 2 - paragraph.level * LEVEL_INDENT_EMU;
    const metrics = estimateParagraphMetrics(paragraph, available, defaultSizePt);
    if (!first) {
      total += Math.round(0.2 * metrics.max_size_pt * EMU_PER_PT);
    }
    total += metrics.height_emu;
    first = false;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 颜色与对比度（PPT-13「对比」）
// ---------------------------------------------------------------------------

/** `RRGGBB` → 相对亮度（WCAG）。非法颜色抛错，不猜。 */
export function relativeLuminance(color: string): number {
  const hex = color.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new LayoutCheckError('invalid_options', `颜色 ${color} 不是 RRGGBB`);
  }
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** 两色的 WCAG 对比度（1…21）。 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// 体检（PPT-13「溢出 / 遮挡 / 越界 / 对比 / 字体替代」）
// ---------------------------------------------------------------------------

/** 体检结论代码。 */
export type LayoutFindingCode =
  | 'out_of_bounds'
  | 'text_overflow'
  | 'occlusion'
  | 'low_contrast'
  | 'font_substitution';

/** 一条体检结论（可解释：带数字）。 */
export interface LayoutFinding {
  readonly code: LayoutFindingCode;
  readonly severity: 'error' | 'warning';
  readonly slide_id: number;
  readonly shape_id: number | null;
  readonly message: string;
  readonly details: Readonly<Record<string, number | string>>;
}

/** 体检选项。 */
export interface LayoutCheckOptions {
  readonly slide_size: SlideSize;
  /** 安全边距（EMU）；对象越出 [margin, size-margin] 记为越界。缺省 0。 */
  readonly margin_emu?: number;
  /** 可用字体清单；run 上指定的字体不在此列 ⇒ 报字体替代。缺省：不检查。 */
  readonly available_fonts?: readonly string[];
  /** 字体替代时的回退字体（写进结论，实际替换由调用方决定）。 */
  readonly fallback_font?: string;
  /** 最低对比度（WCAG）；缺省 4.5（正文级）。 */
  readonly min_contrast_ratio?: number;
  /** 文本框背景色（`RRGGBB`）；缺省白底 `FFFFFF`。 */
  readonly slide_background_color?: string;
  /**
   * 版式 / 母版上的占位符几何（PPT-03 的继承）。幻灯片上**自身几何未解析**
   * （`cx_emu <= 0` 或 `cy_emu <= 0`）的占位符形状，按名字继承这里声明的几何再参与体检。
   * 缺省不启用——给了才生效，不去猜真实稿件的继承。
   */
  readonly inherited_placeholders?: readonly InheritedPlaceholder[];
  /**
   * 表格行高（EMU）；模型不携带逐行行高，缺省用渲染器的 {@link DEFAULT_ROW_HEIGHT_EMU}。
   * 仅影响表格单元格溢出的"可用高度"。
   */
  readonly table_row_height_emu?: number;
}

/**
 * 一张版式 / 母版上的占位符几何声明。
 *
 * 幻灯片上的占位符形状与版式/母版上的同名占位符**共享几何**（PowerPoint 的继承）。本层不读
 * 包内 `p:sp`，由调用方（导入/渲染层）把已解析的版式/母版几何传进来；匹配规则见
 * {@link resolveInheritedTransform}。
 */
export interface InheritedPlaceholder {
  /** 几何来自版式还是母版（同名时版式更具体、优先）。 */
  readonly placement: 'layout' | 'master';
  /** 版式 id；给定则仅当幻灯片引用的 `layout.layout_id` 相同才生效（限定作用域，避免串版）。 */
  readonly layout_id?: string;
  /** 占位符名，与 `shape.name` 匹配（忽略首尾空白与大小写）。 */
  readonly name: string;
  /** 该占位符在版式/母版上的几何（EMU）。 */
  readonly transform: Transform;
}

/** 屏幕坐标系下的轴对齐矩形（EMU）。 */
export interface ShapeBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Rect extends ShapeBounds {}

function rectOf(transform: Transform): Rect {
  return {
    left: transform.x_emu,
    top: transform.y_emu,
    right: transform.x_emu + transform.cx_emu,
    bottom: transform.y_emu + transform.cy_emu,
  };
}

/**
 * **旋转感知**的轴对齐外接矩形：把未旋转的 `a:xfrm` 框绕其中心旋转 `rotation_deg` 后，取
 * 其最小外接矩形。
 *
 * 未旋转（0°）时与 {@link rectOf} 完全相同，因此不改变既有判定。旋转 90° 会把宽高互换、
 * 45° 时外接框面积最大——这正是"旋转对象压到邻居 / 越出页面"被旧模型漏报的地方。
 */
export function rotatedBounds(transform: Transform): ShapeBounds {
  if (transform.rotation_deg === 0 || transform.cx_emu === 0 || transform.cy_emu === 0) {
    return rectOf(transform);
  }
  const rad = (transform.rotation_deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const width = transform.cx_emu * cos + transform.cy_emu * sin;
  const height = transform.cx_emu * sin + transform.cy_emu * cos;
  const centerX = transform.x_emu + transform.cx_emu / 2;
  const centerY = transform.y_emu + transform.cy_emu / 2;
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    right: centerX + width / 2,
    bottom: centerY + height / 2,
  };
}

/**
 * 解析一个幻灯片形状**实际生效**的几何：自身几何未解析（`cx/cy <= 0`）且能在
 * `options.inherited_placeholders` 里按名字找到占位符时，返回继承的几何；否则返回自身几何。
 *
 * 匹配规则：名字（忽略首尾空白/大小写）相等；条目带 `layout_id` 时必须与 `slide.layout.layout_id`
 * 相同（通配条目 `layout_id` 缺省则不限）；多条命中时优先"限定版式 > 通配"、"layout > master"。
 */
export function resolveInheritedTransform(
  shape: Shape,
  slide: Slide,
  options: LayoutCheckOptions,
): Transform {
  const placeholders = options.inherited_placeholders;
  if (placeholders === undefined || placeholders.length === 0) return shape.transform;
  // 仅当自身几何"未解析"（占位符尚未落位）时才继承；明确的真实几何不被覆盖。
  if (shape.transform.cx_emu > 0 && shape.transform.cy_emu > 0) return shape.transform;

  const name = shape.name.trim().toLowerCase();
  const layoutId = slide.layout.layout_id;
  let best: InheritedPlaceholder | null = null;
  let bestRank = -1;
  for (const placeholder of placeholders) {
    if (placeholder.name.trim().toLowerCase() !== name) continue;
    if (placeholder.layout_id !== undefined && placeholder.layout_id !== layoutId) continue;
    const rank = (placeholder.layout_id !== undefined ? 2 : 0) + (placeholder.placement === 'layout' ? 1 : 0);
    if (rank > bestRank) {
      best = placeholder;
      bestRank = rank;
    }
  }
  return best === null ? shape.transform : best.transform;
}

/** 形状生效几何的**旋转感知**外接矩形（继承先于旋转）。 */
export function shapeBoundsOf(shape: Shape, slide: Slide, options: LayoutCheckOptions): ShapeBounds {
  return rotatedBounds(resolveInheritedTransform(shape, slide, options));
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 形状是否**不透明**（会遮挡下方的文本）：图片、或纯色填充的自选图形。 */
function isOpaque(shape: Shape): boolean {
  if (shape.kind === 'picture') return true;
  if (shape.kind === 'auto_shape') return shape.fill.kind === 'solid';
  return false;
}

function textBodyOf(shape: Shape): TextBody | null {
  if (shape.kind === 'text_box') return shape.text;
  if (shape.kind === 'auto_shape') return shape.text;
  return null;
}

function firstRunWithStyle(body: TextBody, pick: (style: NonNullable<TextRun['style']>) => string | number | undefined): string | number | undefined {
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.style === undefined) continue;
      const value = pick(run.style);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function backgroundColorOf(shape: Shape, options: LayoutCheckOptions): string {
  if (shape.kind === 'auto_shape' && shape.fill.kind === 'solid') return shape.fill.color;
  return options.slide_background_color ?? 'FFFFFF';
}

/**
 * 对一张幻灯片做体检，返回**全部**结论（按对象顺序）。
 *
 * 纯函数；不读时钟、不读文件系统。
 */
export function checkSlideLayout(
  slide: Slide,
  options: LayoutCheckOptions,
): readonly LayoutFinding[] {
  if (!Number.isSafeInteger(options.slide_size.cx_emu) || !Number.isSafeInteger(options.slide_size.cy_emu)) {
    throw new LayoutCheckError('invalid_slide_size', 'slide_size 必须是整数 EMU');
  }
  const margin = options.margin_emu ?? 0;
  const minContrast = options.min_contrast_ratio ?? 4.5;
  const findings: LayoutFinding[] = [];

  const allowed: Rect = {
    left: margin,
    top: margin,
    right: options.slide_size.cx_emu - margin,
    bottom: options.slide_size.cy_emu - margin,
  };

  slide.shapes.forEach((shape, index) => {
    // 生效几何：先解析版式/母版继承（自身几何未解析的占位符），再做旋转外接。
    const effective = resolveInheritedTransform(shape, slide, options);
    const rect = rotatedBounds(effective);
    const outOfBounds = rect.left < allowed.left || rect.top < allowed.top || rect.right > allowed.right || rect.bottom > allowed.bottom;
    if (outOfBounds) {
      findings.push({
        code: 'out_of_bounds',
        severity: 'error',
        slide_id: slide.slide_id,
        shape_id: shape.shape_id,
        message: `对象越出可打印区域：left=${String(Math.round(rect.left))}, top=${String(Math.round(rect.top))}, right=${String(Math.round(rect.right))}, bottom=${String(Math.round(rect.bottom))}`,
        details: {
          left_emu: Math.round(rect.left),
          top_emu: Math.round(rect.top),
          right_emu: Math.round(rect.right),
          bottom_emu: Math.round(rect.bottom),
          allowed_left_emu: allowed.left,
          allowed_top_emu: allowed.top,
          allowed_right_emu: allowed.right,
          allowed_bottom_emu: allowed.bottom,
        },
      });
    }

    const body = textBodyOf(shape);
    if (body !== null) {
      const required = estimateTextHeightEmu(body, effective.cx_emu);
      const available = effective.cy_emu - INSET_TB_EMU * 2;
      if (required > available) {
        findings.push({
          code: 'text_overflow',
          severity: 'error',
          slide_id: slide.slide_id,
          shape_id: shape.shape_id,
          message: `文本溢出：估算需要 ${String(required)} EMU，框内可用 ${String(available)} EMU（超出 ${String(required - available)}）`,
          details: { required_emu: required, available_emu: available, overflow_emu: required - available },
        });
      }

      // 对比度：取第一个显式颜色的 run；没有则按黑字。
      const textColor = firstRunWithStyle(body, (style) => style.color);
      const foreground = typeof textColor === 'string' ? textColor : '000000';
      const background = backgroundColorOf(shape, options);
      const ratio = contrastRatio(foreground, background);
      if (ratio < minContrast) {
        findings.push({
          code: 'low_contrast',
          severity: 'warning',
          slide_id: slide.slide_id,
          shape_id: shape.shape_id,
          message: `对比度不足：${foreground} 对 ${background} = ${ratio.toFixed(2)}（低于 ${String(minContrast)}）`,
          details: { ratio: Number(ratio.toFixed(2)), foreground, background, min_ratio: minContrast },
        });
      }

      // 字体替代：run 上指定了字体且不在可用清单里。
      if (options.available_fonts !== undefined) {
        const available = new Set(options.available_fonts);
        const fonts = new Set<string>();
        for (const paragraph of body.paragraphs) {
          for (const run of paragraph.runs) {
            if (run.style?.font !== undefined) fonts.add(run.style.font);
          }
        }
        for (const font of fonts) {
          if (!available.has(font)) {
            const fallback = options.fallback_font ?? options.available_fonts[0] ?? '';
            findings.push({
              code: 'font_substitution',
              severity: 'warning',
              slide_id: slide.slide_id,
              shape_id: shape.shape_id,
              message: `字体 ${font} 不在可用清单，将替代为 ${fallback}`,
              details: { font, fallback_font: fallback },
            });
          }
        }
      }
    }

    // 遮挡：本对象有文本，且被**更高层**的不透明对象盖住（两者都用旋转感知外接框）。
    if (body !== null) {
      for (let above = index + 1; above < slide.shapes.length; above += 1) {
        const occluder = slide.shapes[above]!;
        if (!isOpaque(occluder)) continue;
        if (!intersects(rect, shapeBoundsOf(occluder, slide, options))) continue;
        findings.push({
          code: 'occlusion',
          severity: 'error',
          slide_id: slide.slide_id,
          shape_id: shape.shape_id,
          message: `对象被上层的不透明对象（shape_id=${String(occluder.shape_id)}）遮挡`,
          details: { occluder_shape_id: occluder.shape_id },
        });
        break;
      }
    }

    // 表格：单元格（含合并跨列 / 跨行）文本溢出。合并格的可用宽度 = 所跨各列宽之和，
    // 可用高度 = 行高 × 所跨行数；旧模型完全跳过表格，导致真实表格里的溢出被漏报。
    if (shape.kind === 'table') {
      findings.push(...tableCellOverflowFindings(shape, slide, options));
    }
  });

  return Object.freeze(findings);
}

/**
 * 表格各**源格**（非合并延续格）的文本溢出判定。
 *
 * 网格列号 == `row.cells` 下标：模型的合并表示里每个网格列恰好对应一个格（源格带
 * `col_span`/`row_span`，被覆盖的列是同行的延续格），与 `tables.planTableGrid` 的规则一致，
 * 因此跨列宽度可直接对 `column_widths_emu` 求和。
 */
function tableCellOverflowFindings(
  table: TableShape,
  slide: Slide,
  options: LayoutCheckOptions,
): readonly LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const rowHeight = options.table_row_height_emu ?? DEFAULT_ROW_HEIGHT_EMU;
  const columns = table.column_widths_emu.length;
  table.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, colIndex) => {
      if (cell.text === null) return;
      const span = Math.max(1, cell.col_span);
      let cellWidth = 0;
      for (let k = 0; k < span && colIndex + k < columns; k += 1) {
        cellWidth += table.column_widths_emu[colIndex + k] ?? 0;
      }
      const rowSpan = Math.max(1, cell.row_span);
      const available = rowHeight * rowSpan - INSET_TB_EMU * 2;
      const required = estimateTextHeightEmu(cell.text, cellWidth);
      if (required > available) {
        findings.push({
          code: 'text_overflow',
          severity: 'error',
          slide_id: slide.slide_id,
          shape_id: table.shape_id,
          message: `表格第 ${String(rowIndex)} 行第 ${String(colIndex)} 列文本溢出：估算需要 ${String(required)} EMU，格内可用 ${String(available)} EMU（跨 ${String(span)} 列 × ${String(rowSpan)} 行）`,
          details: {
            row_index: rowIndex,
            col_index: colIndex,
            col_span: span,
            row_span: rowSpan,
            cell_width_emu: cellWidth,
            available_width_emu: cellWidth - INSET_LR_EMU * 2,
            required_emu: required,
            available_emu: available,
            overflow_emu: required - available,
            row_height_emu: rowHeight,
          },
        });
      }
    });
  });
  return findings;
}

/** 对整份文稿逐页体检。 */
export function checkPresentationLayout(
  presentation: Presentation,
  options: Omit<LayoutCheckOptions, 'slide_size'> & { readonly slide_size?: SlideSize },
): readonly LayoutFinding[] {
  const slideSize = options.slide_size ?? presentation.size;
  const findings: LayoutFinding[] = [];
  for (const slide of presentation.slides) {
    findings.push(...checkSlideLayout(slide, { ...options, slide_size: slideSize }));
  }
  return Object.freeze(findings);
}

// ---------------------------------------------------------------------------
// 统一排版（PPT-13「统一排版」）
// ---------------------------------------------------------------------------

/** 统一排版参数。 */
export interface UniformLayoutOptions {
  readonly margin_left_emu: number;
  readonly margin_top_emu: number;
  readonly margin_right_emu: number;
  readonly margin_bottom_emu: number;
  /** 垂直堆叠时对象之间的间距。 */
  readonly gap_emu: number;
  /** 统一正文字号。 */
  readonly body_size_pt: number;
  /** 统一正文字体。 */
  readonly body_font: string;
  /** 统一段落对齐。 */
  readonly alignment: Paragraph['alignment'];
  /** `stack` = 自上而下等距重排文本对象；`keep` = 只统一样式，不动位置。 */
  readonly vertical: 'stack' | 'keep';
}

/** 默认统一排版：1 英寸页边距、0.2 英寸间距、18pt 正文、宋体、左对齐、垂直堆叠。 */
export const DEFAULT_UNIFORM_LAYOUT: UniformLayoutOptions = Object.freeze({
  margin_left_emu: 914400,
  margin_top_emu: 914400,
  margin_right_emu: 914400,
  margin_bottom_emu: 914400,
  gap_emu: 182880,
  body_size_pt: 18,
  body_font: '宋体',
  alignment: 'left',
  vertical: 'stack',
});

function isTextBearing(shape: Shape): boolean {
  return shape.kind === 'text_box' || shape.kind === 'auto_shape';
}

function restyleBody(body: TextBody, options: UniformLayoutOptions): TextBody {
  return {
    paragraphs: body.paragraphs.map((paragraph) => ({
      ...paragraph,
      alignment: options.alignment,
      runs: paragraph.runs.map((run) => ({
        source: run.source,
        style: { ...(run.style ?? {}), size_pt: options.body_size_pt, font: options.body_font },
      })),
    })),
  };
}

/**
 * 统一排版（纯函数）：对文本对象套用同一套边距 / 内容宽度 / 字号 / 字体 / 对齐。
 *
 * - 文本对象（`text_box` / `auto_shape`）的 `x` = 左边距、`cx` = 内容宽度（= 页宽 − 左右边距）；
 * - `vertical: 'stack'` 时自上而下等距重排（保持各自高度），`'keep'` 时保持原 `y`；
 * - **非文本对象（图片 / 表格 / 图表 / 连接符 / 组）与无文本的自选图形**一律**引用不变**——
 *   统一排版不该移动一张已摆好的图，这是"只改该改的"的结构性保证。
 */
export function uniformLayout(
  presentation: Presentation,
  options: UniformLayoutOptions = DEFAULT_UNIFORM_LAYOUT,
): Presentation {
  if (!Number.isSafeInteger(options.margin_top_emu) || !Number.isSafeInteger(options.gap_emu)) {
    throw new LayoutCheckError('invalid_options', 'margin_top_emu / gap_emu 必须是整数 EMU');
  }
  const contentWidth = presentation.size.cx_emu - options.margin_left_emu - options.margin_right_emu;
  if (contentWidth <= 0) {
    throw new LayoutCheckError('invalid_options', '左右边距大于页宽，内容宽度为负');
  }
  const slides = presentation.slides.map((slide) => {
    let cursor = options.margin_top_emu;
    const shapes = slide.shapes.map((shape) => {
      if (!isTextBearing(shape)) {
        return shape; // 图片 / 表格 / 图表 / 组：引用不变
      }
      const body = textBodyOf(shape);
      if (body === null) {
        return shape; // 无文本的自选图形：引用不变
      }
      const y = options.vertical === 'stack' ? cursor : shape.transform.y_emu;
      if (options.vertical === 'stack') {
        cursor += shape.transform.cy_emu + options.gap_emu;
      }
      const nextTransform: Transform = {
        ...shape.transform,
        x_emu: options.margin_left_emu,
        y_emu: y,
        cx_emu: contentWidth,
      };
      const nextBody = restyleBody(body, options);
      return { ...shape, transform: nextTransform, text: nextBody } as Shape;
    });
    return { ...slide, shapes };
  });
  return { ...presentation, slides };
}

// ---------------------------------------------------------------------------
// 基于**真实字形度量**的溢出检查（PPT-13「不同内容长度下检查真实渲染」）
// ---------------------------------------------------------------------------
//
// 上面的 `checkSlideLayout` 用**字符宽度模型**估算高度（`estimateTextHeightEmu`）。本增量补一条
// **按字形前进宽度**度量的路径：给定一个渲染像素宽度与 `GlyphRasterPort`，文本高度由
// `layoutParagraphs` 真排出来，再换算回 EMU。两套结论可能略有差异，这是**有意**的：
// 字符模型无端口也能跑；字形度量需要端口（内置端口给 ASCII 真字形 / 非 ASCII 替代字形）。

export interface RenderedLayoutCheckOptions extends Omit<LayoutCheckOptions, 'slide_size'> {
  readonly slide_size?: SlideSize;
  /** 参与渲染的像素宽度（用于把 pt / EMU 换成像素做字形度量）。 */
  readonly render_width_px: number;
  /** 字形来源；缺省内置位图字体端口。 */
  readonly glyph_port?: GlyphRasterPort;
  readonly default_font?: string;
  readonly default_size_pt?: number;
}

function paragraphTextOf(run: TextRun): string {
  return run.source.kind === 'literal' ? run.source.text : '（未提供）';
}

/** 用字形度量一个文本体在给定框宽（EMU）下占用的高度（EMU）。 */
export function renderedTextHeightEmu(
  body: TextBody,
  boxWidthEmu: number,
  options: { readonly scale: number; readonly glyph_port: GlyphRasterPort; readonly default_font: string; readonly default_size_pt: number },
): number {
  const innerWidthEmu = boxWidthEmu - INSET_LR_EMU * 2;
  const innerWidthPx = Math.max(1, innerWidthEmu * options.scale);
  const paragraphs: ResolvedParagraph[] = body.paragraphs.map((paragraph) => ({
    alignment: paragraph.alignment === 'justify' ? 'left' : paragraph.alignment,
    runs: paragraph.runs.map((run) => ({
      text: paragraphTextOf(run),
      font: run.style?.font ?? options.default_font,
      sizePx: Math.max(6, Math.round((run.style?.size_pt ?? options.default_size_pt) * EMU_PER_PT * options.scale)),
    })),
  }));
  const laid = layoutParagraphs(paragraphs, {
    glyphPort: options.glyph_port,
    maxWidthPx: Math.floor(innerWidthPx),
    defaultAlignment: 'left',
  });
  return laid.heightPx / options.scale;
}

/**
 * 与 {@link checkSlideLayout} 同口径的体检，但文本溢出一条改用**字形度量**：
 * 先取结构体检的结论，剔除其中的 `text_overflow`，再用真实排版高度重新判定。
 */
export function checkSlideLayoutRendered(
  slide: Slide,
  options: RenderedLayoutCheckOptions,
): readonly LayoutFinding[] {
  const slideSizeResolved: SlideSize = options.slide_size ?? { cx_emu: 0, cy_emu: 0 };
  const scale = options.render_width_px / (slideSizeResolved.cx_emu || 1);
  const port = options.glyph_port ?? createBuiltinGlyphPort();
  const defaultFont = options.default_font ?? 'mono8';
  const defaultSizePt = options.default_size_pt ?? 18;

  const base = checkSlideLayout(slide, { ...options, slide_size: slideSizeResolved }).filter(
    (finding) => finding.code !== 'text_overflow',
  );

  const rendered: LayoutFinding[] = [];
  slide.shapes.forEach((shape) => {
    const body = textBodyOf(shape);
    if (body === null) return;
    const required = renderedTextHeightEmu(body, shape.transform.cx_emu, {
      scale,
      glyph_port: port,
      default_font: defaultFont,
      default_size_pt: defaultSizePt,
    });
    const available = shape.transform.cy_emu - INSET_TB_EMU * 2;
    if (required > available) {
      rendered.push({
        code: 'text_overflow',
        severity: 'error',
        slide_id: slide.slide_id,
        shape_id: shape.shape_id,
        message: `文本溢出（字形度量）：需要 ${String(Math.round(required))} EMU，框内可用 ${String(available)} EMU`,
        details: {
          required_emu: Math.round(required),
          available_emu: available,
          overflow_emu: Math.round(required - available),
          measured_by: 'glyph_advance',
        },
      });
    }
  });

  return Object.freeze([...base, ...rendered]);
}
