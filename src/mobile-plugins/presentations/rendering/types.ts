/**
 * **P09 · 手机侧演示渲染（纯 TS 软件光栅）——类型面。**
 *
 * ## 这一层解决什么
 *
 * 既有 `src/presentations/export-handoff.ts` 的预览是 `structural_text`（结构 + 文字），
 * PDF 是 `text_outline`（每页一张 PDF 页 + 该页文字，不还原版式）。两者都**不是像素结果**。
 * 本包把「幻灯片模型 → 真实像素缓冲 → 真实 PNG 字节」这条链补齐：
 *
 * | 是 | 不是 |
 * |---|---|
 * | 一个真正的 RGBA/RGB 像素画布（`canvas.ts`，含 alpha 合成 / 裁剪 / 叠层） | Android `Canvas` / Skia 绑定 |
 * | 真正的 PNG 编码与解码（`png.ts`，zlib + CRC32，逐字节可校验） | 第三方图片库 |
 * | 段落 → **按字形前进宽度**断行 → 逐字形落点（`text.ts`） | 完整 Unicode 双向 / 复杂文种整形 |
 * | 模型对象（文本 / 图片 / 图表 / 表格 / 叠层）→ 画布（`slide-renderer.ts`） | 母版 / 版式继承的完整还原 |
 * | **字形**由可注入端口提供（`GlyphRasterPort`：内置 8×8 位图字体或平台字体） | 内置一套完整中文字库 |
 *
 * ## 字形为什么是端口
 *
 * 手机侧真实字形来自平台（Android `Paint`/`Canvas` 或 APK 内字体文件）；本仓**不打包**中文字库
 * （体量与许可都不合适）。因此本包把**字形到位**与**像素合成**分开：
 *
 * - 内置 `createBuiltinGlyphPort()`：ASCII（0x20–0x7E）用**真实 8×8 位图字形**；
 *   非 ASCII（含中文）在**没有真实字形**时给出**确定性替代字形**，并**显式**发
 *   `glyph_substituted` 诊断——**不假装**画出了那个汉字。
 * - 调用方可注入实现了 {@link GlyphRasterPort} 的平台端口（真机字体）以得到真实汉字像素。
 *
 * 换言之：**合成管线是真的**；字符形是否「像那个字」取决于注入的字形来源，如实上报。
 */

import type { Rgb } from './color.js';

// ---------------------------------------------------------------------------
// 字形
// ---------------------------------------------------------------------------

/** 一个已光栅化的字形：`coverage` 是按行的 0..255 覆盖度（近似 alpha）。 */
export interface GlyphBitmap {
  readonly widthPx: number;
  readonly heightPx: number;
  /** 行优先覆盖度，长度必须 = `widthPx × heightPx`；0 = 无墨，255 = 全墨。 */
  readonly coverage: Uint8Array;
  /** 画完该字形后笔前进的像素数（含字间距）。 */
  readonly advancePx: number;
  /**
   * 该字形是否是**替代**（不是目标字符的真实字形）。`true` 时调用方必须能据此上报，
   * 不得当作"画出了那个字"。
   */
  readonly substituted: boolean;
  /** 实际参与光栅的字体族名（可能是替代字体）。 */
  readonly font: string;
}

/** 字形请求。`sizePx` 是字号（像素，约等于 em 高）。 */
export interface GlyphRequest {
  readonly font: string;
  readonly codePoint: number;
  readonly sizePx: number;
}

/**
 * 字形光栅端口。由平台或内置字体实现。
 *
 * 契约：`rasterize` 返回 `null` 表示**该码点无字形可用**——调用方必须发 `glyph_missing`
 * 并按 `missingGlyphs` 的兜底宽度推进，**不得**把它当成空白静默吞掉。
 */
export interface GlyphRasterPort {
  /** 该字体族是否在本端口可用。 */
  hasFont(font: string): boolean;
  /** 该字体族是否有该码点的字形。 */
  hasGlyph(font: string, codePoint: number): boolean;
  /** 光栅一个字形；无字形返回 `null`。 */
  rasterize(request: GlyphRequest): GlyphBitmap | null;
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

/** 渲染诊断码（可复算，供测试与上游转述）。 */
export type RenderDiagnosticCode =
  /** 缺少真实字形，用了替代字形（**不是**画出了那个字）。 */
  | 'glyph_substituted'
  /** 连替代字形都给不出（端口返回 null）。 */
  | 'glyph_missing'
  /** 文本按真实字形度量后**超出**文本框可用高度。 */
  | 'text_overflow'
  /** 单个不可断单元超出可用宽度，被迫硬断。 */
  | 'forced_break'
  /** 图片引用的媒体部件不在本次输入里。 */
  | 'missing_media'
  /** 媒体字节存在但**解不开**（当前只支持 8 位非隔行 PNG）。 */
  | 'undecodable_image'
  /** 音视频等无渲染内容的媒体，画了占位标记而不是假装播放画面。 */
  | 'media_placeholder'
  /** 该形状种类本层不渲染（如实报，不静默丢）。 */
  | 'unsupported_shape'
  /**
   * 表格合并单元格按**跨格区域**绘制：跨列/跨行的内部网格线被抑制，文字居中于合并区；
   * 但底纹 / 斜线 / 非矩形边框等仍**未**还原，故如实记录一条。
   */
  | 'table_merge_rendered';

/** 一条渲染诊断。 */
export interface RenderDiagnostic {
  readonly code: RenderDiagnosticCode;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly slide_id: number | null;
  readonly shape_id: number | null;
  readonly details: Readonly<Record<string, number | string>>;
}

// ---------------------------------------------------------------------------
// 渲染选项 / 结果
// ---------------------------------------------------------------------------

/** 画布尺寸来源：幻灯片几何（EMU）。 */
export interface EmuSlideSize {
  readonly cx_emu: number;
  readonly cy_emu: number;
}

/** 媒体来源：包内路径 → 字节。 */
export interface MediaBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface RenderSlideOptions {
  /** 幻灯片几何（EMU）。用它与目标像素尺寸算出缩放。 */
  readonly slide_size: EmuSlideSize;
  /** 目标画布宽（像素）。 */
  readonly width_px: number;
  /** 目标画布高（像素）。缺省 = 按 `slide_size` 等比推出。 */
  readonly height_px?: number;
  /** 背景色；缺省白（`FFFFFF`）。 */
  readonly background?: Rgb;
  /** 字形来源；缺省 `createBuiltinGlyphPort()`。 */
  readonly glyph_port?: GlyphRasterPort;
  /** 事实快照：求值文本里的 `fact` 引用（缺失 ⇒ `（未提供）` 占位，见模型层）。 */
  readonly fact_snapshot?: import('../../../presentations/model.js').FactSnapshot;
  /** 媒体部件（图片等）。缺失的引用会发 `missing_media`，**不静默跳过**。 */
  readonly media?: readonly MediaBytes[];
  /** 默认可选字体族；缺省 `'mono8'`。 */
  readonly default_font?: string;
  /** 缺省正文字号 pt（run 未指定时）；缺省 18。 */
  readonly default_size_pt?: number;
}

/** 一页的渲染结果。 */
export interface RenderedSlide {
  readonly slide_id: number;
  readonly index: number;
  readonly canvas: import('./canvas.js').RasterCanvas;
  readonly width_px: number;
  readonly height_px: number;
  readonly diagnostics: readonly RenderDiagnostic[];
}

/** 一页渲染成 PNG 的结果。 */
export interface RenderedSlidePng {
  readonly slide_id: number;
  readonly index: number;
  readonly png: Buffer;
  readonly width_px: number;
  readonly height_px: number;
  /** 非背景像素数（用于"真画了东西"的可断言证据）。 */
  readonly ink_pixels: number;
  readonly diagnostics: readonly RenderDiagnostic[];
}

/** 演示渲染成 PNG 的结果。 */
export interface RenderedPresentationPng {
  readonly presentation_id: string;
  readonly slide_count: number;
  readonly slides: readonly RenderedSlidePng[];
  readonly diagnostics: readonly RenderDiagnostic[];
  /** 本层**不做**像素断言的外部一致性（如与 PowerPoint 观感一致）一律在此列明。 */
  readonly unverified: readonly string[];
}

/** 本包对**外部消费端**无法验证的观感断言（如实登记）。 */
export const RENDER_UNVERIFIED: readonly string[] = Object.freeze([
  '渲染结果与 PowerPoint / WPS 的实际观感是否一致（本层只保证像素由本渲染器真实产出，未与任何外部渲染器比对）。',
  'ASCII 之外（含中文）的字形是否为目标字符的真实字形，取决于注入的 GlyphRasterPort；内置端口对非 ASCII 只给替代字形。',
  '字体族未在画布上做字形选择 / 连字 / 双向排版（本层是逐码点落点）。',
  '对象旋转按「先画进局部画布、再绕中心逆映射合成」实现；旋转后边沿的**半透明像素**会按局部底色合成后整体贴回，若其正下方叠了别的对象，边缘抗锯齿的混色可能略有偏差（未被外部渲染器验证）。',
  '合并单元格只抑制内部网格线并把文字居中于合并区；单元格底纹、斜线边框、不规则边框与跨行高度的不等高行**未**还原。',
]);
