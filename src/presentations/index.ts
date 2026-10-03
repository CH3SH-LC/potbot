/**
 * `src/presentations` 唯一公开出口（design-06 P9 / PPT-01–16 的演示域）。
 *
 * 分层：
 * - `model.ts` —— 对象模型（文稿 / 幻灯片 / 版式母版引用 / 形状与文本 / 图片与媒体 / 表格与图表 / 备注）；
 * - `operations.ts` —— 不可变操作（增删移页、几何与层级、对齐分布、组合、文本）；
 * - `render.ts` —— 模型 → PPTX 字节（**页数由模型决定**）；
 * - `import.ts` —— 导入既有 PPTX 并**逐部件保留**未改动内容（PPT-03 / R249）；
 * - `xml-parse.ts` —— 最小 XML 读取器（往返路径的"读"的一侧）；
 * - `roundtrip.ts` —— 导入成模型 → 编辑 → 只写回被改部件的完整往返（PPT-14）。
 *
 * 本模块**不**改动 `src/artifacts/templates/pptx.ts` 的既有行为（其字节被 golden 常量钉死）；
 * 只从它复用 `renderFactValue` / `themeXml` 两处纯增量导出，保证"同一套数值口径与主题"。
 */

export * from './model.js';
export * from './operations.js';
export * from './render.js';
export * from './import.js';
export * from './xml-parse.js';
export * from './roundtrip.js';

export * from './slide-ops.js';
export * from './text.js';
export * from './geometry.js';
export * from './media.js';
export * from './shapes.js';
export * from './tables.js';
export * from './charts.js';
export * from './notes.js';
export * from './animation.js';
export * from './layout-check.js';

export * from './export-handoff.js';
export * from './fact-sync.js';

export * from './av-media.js';
export * from './notes-and-links.js';

export * from './undo-history.js';

/**
 * 子目录层再导出（integration，run-20261003-B）：以下五个新增子模块此前只以目录路径可达，
 * 八个工作包请求把它们并入本出口，使消费者 `import { ... } from '../presentations/index.js'`
 * 即可取用：
 * - `annotations/`（P07）备注部件增删 + 失效对象链接审计；
 * - `media-parts/`（P05）媒体来源登记 / `_rels` 关系 / 音视频整包装配；
 * - `slide-structure/`（P02）结构快照 / 差异 + 结构操作机器可读清单；
 * - `timing-parts/`（P08）`p:timing` 时序部件的描述符 / 注入 / 读回；
 * - `table-chart-parts/`（P06）表格与图表部件 / 内嵌工作簿 / 数值一致性。
 */
export * from './annotations/index.js';
export * from './media-parts/index.js';
export * from './slide-structure/index.js';
export * from './timing-parts/index.js';
export * from './table-chart-parts/index.js';

/**
 * 消歧（integration，run-20261003-B）：`text.js`（P03）与 `undo-history.js`（既有）都导出
 * `TextMatch` / `findText`，两个 `export *` 撞名会让本出口报 TS2308。
 * 两者语义确实不同——`undo-history` 的是**整篇文稿级**查找，`text` 的是**段落内**查找。
 * 处理：显式重导出把公共名钉在既有语义上（不破坏既有消费方），P03 的新增用别名保留，不丢能力。
 */
export type { TextMatch } from './undo-history.js';
export { findText } from './undo-history.js';
export type { TextMatch as ParagraphTextMatch } from './text.js';
export { findText as findTextInParagraph } from './text.js';

/**
 * 消歧（integration，run-20261003-B）：并入上面五个子目录后，新增导出与既有出口在 8 个公共名上
 * 撞车（TS2308）。处理口径与上文 `TextMatch` / `findText` 完全一致：公共名钉在**既有**语义上
 * （不破坏既有消费方），新增侧以语义化别名保留，**绝不丢名**。
 *
 * - `REL_IMAGE` / `REL_VIDEO` / `REL_AUDIO` / `REL_P14_MEDIA`：media-parts 与 av-media 是**同值**
 *   （同一条 OOXML 关系 URI 常量），既有 `av-media.js` 保持原名，media-parts 侧加 `MEDIA_PARTS_` 前缀；
 * - `MEDIA_CONTENT_TYPES`：media-parts 与 media 是**同表**（扩展名 → 内容类型），既有 `media.js`
 *   保持原名，新表用 `MEDIA_PARTS_CONTENT_TYPES`；
 * - `referencedMediaPaths`：**语义不同**——`media.js` 的是「整份文稿引用的图片路径」
 *   （`Presentation → readonly string[]`），media-parts 的是「关系条目指向的包内媒体路径集合」
 *   （`readonly MediaRelationship[] → ReadonlySet<string>`），后者改名 `referencedMediaPathsInRelationships`；
 * - `columnLetter`：table-chart-parts 与 charts 算法同口径（0 → A、1 → B），别名 `columnLetterInTableChartParts`；
 * - `MergeRegion`：table-chart-parts 与 tables 同形，别名 `MergeMatrixRegion`。
 */
export { REL_IMAGE, REL_VIDEO, REL_AUDIO, REL_P14_MEDIA } from './av-media.js';
export {
  REL_IMAGE as MEDIA_PARTS_REL_IMAGE,
  REL_VIDEO as MEDIA_PARTS_REL_VIDEO,
  REL_AUDIO as MEDIA_PARTS_REL_AUDIO,
  REL_P14_MEDIA as MEDIA_PARTS_REL_P14_MEDIA,
} from './media-parts/relationships.js';

export { MEDIA_CONTENT_TYPES } from './media.js';
export { MEDIA_CONTENT_TYPES as MEDIA_PARTS_CONTENT_TYPES } from './media-parts/registry.js';

export { referencedMediaPaths } from './media.js';
export { referencedMediaPaths as referencedMediaPathsInRelationships } from './media-parts/relationships.js';

export { columnLetter } from './charts.js';
export { columnLetter as columnLetterInTableChartParts } from './table-chart-parts/consistency.js';

export type { MergeRegion } from './tables.js';
export type { MergeRegion as MergeMatrixRegion } from './table-chart-parts/merge-matrix.js';
