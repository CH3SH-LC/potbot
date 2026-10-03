/**
 * 分页控制（WF-032）：段前分页、与下段同页、段中不分页、孤行控制。
 *
 * 四个属性都是**开关**（`ToggleState`），因此各自有"开 / 关 / 未指定 / 清除覆盖"四态。
 *
 * ## 为什么"关"和"未指定"不能混（R118）
 *
 * - `keepNext = off` → 写 `<w:keepNext w:val="false"/>`：**明确要求**本段不要与下段同页。
 *   样式里若要求同页，这一个"关"要压得住它。
 * - `keepNext = unspecified` → **不写** `<w:keepNext/>`：让样式决定。
 *
 * 界面上"取消勾选与下段同页"到底该落哪个？——落 `off`（用户明确要求），
 * 所以这里提供 `setKeepNext(props, false)` 而不是只提供 `unsetKeepNext`。
 * `unset*` 系列是给"清除段落格式"（WF-034）用的内部路径。
 */

import type { ParagraphProperties, ToggleState } from '../../model/types.js';
import { TOGGLE_INHERIT, TOGGLE_OFF, TOGGLE_ON } from '../../model/types.js';

/** 分页控制四开关的字段名。 */
export type PaginationField = 'pageBreakBefore' | 'keepNext' | 'keepLines' | 'widowControl';

/** 分页控制四开关的稳定序列（供测试遍历断言）。 */
export const PAGINATION_FIELDS: readonly PaginationField[] = Object.freeze([
  'pageBreakBefore',
  'keepNext',
  'keepLines',
  'widowControl',
] as readonly PaginationField[]);

/** 按 `ToggleState` 原样设置某个分页开关（需要精确控制四态时用）。 */
export function setPaginationState(
  props: ParagraphProperties,
  field: PaginationField,
  state: ToggleState,
): ParagraphProperties {
  return { ...props, [field]: state };
}

/** 布尔便捷入口：`true` → 显式开，`false` → **显式关**（不是"未指定"）。 */
export function setPaginationEnabled(
  props: ParagraphProperties,
  field: PaginationField,
  enabled: boolean,
): ParagraphProperties {
  return setPaginationState(props, field, enabled ? TOGGLE_ON : TOGGLE_OFF);
}

/**
 * 清除某个分页开关的直接格式，回落到样式（WF-032 的"取消"）。
 *
 * 落 **`inherit`（写意图 = `remove`）**，不是 `unspecified`（写意图 = `omit`）。
 * 两者在"读"上等价（`cascade.ts` 都不贡献值），差别在**写**：段落此前很可能已经有
 * 一个 `<w:pageBreakBefore/>` 元素，清除必须**删掉它**；若落 `unspecified`，写码层的动作是
 * "不写元素"，局部重建时旧元素会留在原地——用户点了"取消分页控制"却看不出变化。
 *
 * 这与 WF-034 的清除目标 `createInheritedParagraphProperties()` 对同四个字段用的
 * `TOGGLE_INHERIT` 一致，也与本包其余清除入口（`unsetAlignment` / `unsetSpacingBefore` /
 * `unsetLineSpacing` / `clearIndent` / `clearTabStops` / `clearParagraphBorders`）一致。
 */
export function unsetPagination(props: ParagraphProperties, field: PaginationField): ParagraphProperties {
  return setPaginationState(props, field, TOGGLE_INHERIT);
}

/** 段前分页（WF-032）。 */
export function setPageBreakBefore(props: ParagraphProperties, enabled: boolean): ParagraphProperties {
  return setPaginationEnabled(props, 'pageBreakBefore', enabled);
}

/** 与下段同页（WF-032）。 */
export function setKeepNext(props: ParagraphProperties, enabled: boolean): ParagraphProperties {
  return setPaginationEnabled(props, 'keepNext', enabled);
}

/** 段中不分页（WF-032）。 */
export function setKeepLines(props: ParagraphProperties, enabled: boolean): ParagraphProperties {
  return setPaginationEnabled(props, 'keepLines', enabled);
}

/** 孤行控制（WF-032）。 */
export function setWidowControl(props: ParagraphProperties, enabled: boolean): ParagraphProperties {
  return setPaginationEnabled(props, 'widowControl', enabled);
}
