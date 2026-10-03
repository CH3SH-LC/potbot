/**
 * **P09 · 手机侧演示渲染（PPT-13/15 的真实像素路径）**公开出口。
 *
 * ```ts
 * import {
 *   renderSlideToPng, renderPresentationToPngs, decodePng, createBuiltinGlyphPort,
 * } from './rendering/index.js';
 *
 * const one = renderSlideToPng(slide, 0, { slide_size, width_px: 1280 });
 * one.png.subarray(0, 8); // PNG 签名；one.ink_pixels > 0 表示真的画了东西
 * ```
 *
 * 纯计算（PNG/PDF 的压缩走本目录的纯 TS `zlib-store.ts`）：不接 Android、不读文件系统、
 * 零 `node:*` 内建模块依赖、无第三方依赖。
 */

export * from './types.js';
export * from './color.js';
export * from './canvas.js';
export * from './png.js';
export * from './font.js';
export * from './glyph-port.js';
export * from './text-split.js';
export * from './text.js';
export * from './slide-renderer.js';
export * from './pdf.js';
