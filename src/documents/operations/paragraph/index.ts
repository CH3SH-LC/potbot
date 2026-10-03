/**
 * `src/documents/operations/paragraph` —— 段落排版操作（WF-017–034，合同 R117–R121、R127–R136）。
 *
 * ## 这一层的职责边界
 *
 * - **只做不可变更新**：每个操作收 `ParagraphProperties` / `ParagraphNode`，返回新对象，
 *   绝不原地改（幂等与撤销依赖这一点，R137/R138）。
 * - **不做任何换算**：所有"用户单位 → OOXML 属性"的换算在 `src/documents/units`。
 *   本层只保存语义值（`LineSpacing` / `ParagraphSpacing` / `IndentAmount`）。
 * - **不拼 XML**：`w:jc` / `w:line` 这些名字不该出现在本包（R107 归 D02）。
 * - **不碰字符格式**：run 属性属 D03。本包的清除/复制段落格式在类型上就够不着 `RunProperties`。
 */

export * from './states.js';
export * from './defaults.js';
export * from './clone.js';
export * from './alignment.js';
export * from './line-spacing.js';
export * from './spacing.js';
export * from './indent.js';
export * from './tab-stops.js';
export * from './breaks.js';
export * from './pagination.js';
export * from './borders-shading.js';
export * from './clear-copy.js';
export * from './write-intent.js';
