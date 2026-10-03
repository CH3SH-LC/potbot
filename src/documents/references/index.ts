/**
 * 引用包入口（design-05 P7：WF-071–076）。
 *
 * 边界（与协调者分派的写权一致）：
 * - **不碰 `model/types.ts`**：书签/超链接/脚注/交叉引用用本包自带的 `ReferenceIndex` 侧表；
 * - **不做 DOCX 读写**（`src/documents/docx/**` 由 WCF-D30/D02 独占）——本包只产出**模型态**；
 * - **不做 UI / 服务端**。
 *
 * 合同锚点：R102（码位偏移）、R105（未知内容保留）、R110（不静默丢弃）、R115（标题判定）、
 * R158（页码/域缓存需真实证据）、R161（外部目标不抓取）。
 */

export * from './types.js';
export * from './anchors.js';
export * from './bookmarks.js';
export * from './hyperlinks.js';
export * from './toc.js';
export * from './notes.js';
export * from './crossref.js';
export * from './fields.js';
export * from './parse.js';
export * from './layout-resolution.js';
