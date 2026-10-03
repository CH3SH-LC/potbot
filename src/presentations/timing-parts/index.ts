/**
 * P08 · 时序部件层公开出口（`src/presentations/timing-parts`）。
 *
 * **零依赖、不接入 `src/presentations/index.ts`**（那是 P01 / 集成人的写区）。
 * P01 装配幻灯片部件时 import 本模块：
 *
 * ```
 * const desc = timingDescriptorFor(`ppt/slides/slide1.xml`, 1, specs);
 * const slideXml = applyTimingDescriptor(renderSlidePartXml(slide, ctx), desc);
 * ```
 *
 * 读侧（导入路径）用 `parseTimingXml` 把页里的 `p:timing` 读回规格。
 *
 * P-I05 起：描述符走**无损写侧** `renderTimingXmlLossless`（`appear` 写真时长、`after_previous`
 * 的相对延迟由读侧反推），并补上媒体自动播放 seam（`renderMediaAutoplayTimingXml` /
 * `renderTimingTreeXml` / `parseMediaTimingXml`）。模型页桥 `renderSlideTimingXmlLossless`
 * 供 `render.ts` / `roundtrip.ts` 把整份文件的时序切到无损写侧。
 */

export * from './errors.js';
export * from './render.js';
export * from './parse.js';
export * from './descriptor.js';
export * from './registry.js';
export * from './inject.js';
