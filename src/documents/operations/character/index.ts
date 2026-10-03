/**
 * 字符格式操作包入口（design-05 P1：WF-001–016；P8：WF-085 查找替换）。
 *
 * 边界（与协调者的分派一致）：
 * - **不做 XML 读写**（D02 负责 `src/documents/docx/**`）——本包只产出**模型态**属性；
 * - **不做段落属性**（D04 负责 `src/documents/operations/paragraph/**`）——
 *   字符底纹与段落底纹是两个字段，互不越界（R120）；
 * - **不做 UI**（D08）。
 */

export * from './types.js';
export * from './properties.js';
export * from './read.js';
export * from './apply.js';
export * from './replace.js';
