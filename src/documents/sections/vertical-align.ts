/**
 * 页内垂直对齐（WF-055）：顶端 / 居中 / 底端 / 两端。
 *
 * ## 作用范围是**节**（WF-055 明写）
 *
 * 这个属性容易被人当成"段落属性"（和段落的垂直对齐、或者表格单元格的垂直对齐混起来），
 * 于是被写进 `w:pPr`——那是错的：`w:vAlign` 是 `w:sectPr` 的子元素，**整节**的正文
 * 在页面里的位置由它决定。本模块的入口全部收 `SectionProperties` / 节范围，
 * 在类型上就够不着段落。
 *
 * ## 四个取值互斥，不是开关的组合
 *
 * `both`（两端对齐）是 `ST_VerticalJc` 的第四个取值，**不是**"顶端 + 底端两个开关都打开"。
 * 用两个布尔凑会用三种状态去表达四种取值，必然出现一个表达不出来的组合。
 */

import { DocumentModelError } from '../model/errors.js';
import type { DocumentModel, SectionProperties } from '../model/types.js';
import { UNSPECIFIED_VALUE, specified } from '../model/attributes.js';
import { updateSections } from './targets.js';
import { SECTION_VERTICAL_ALIGNS, type SectionScope, type SectionVerticalAlign } from './types.js';

/** 校验垂直对齐取值（跨 JSON 边界进来的字符串需要它）。 */
export function requireVerticalAlign(value: string): SectionVerticalAlign {
  if (!(SECTION_VERTICAL_ALIGNS as readonly string[]).includes(value)) {
    throw new DocumentModelError(
      'unsupported',
      `未知的页内垂直对齐：${JSON.stringify(value)}（可用：${SECTION_VERTICAL_ALIGNS.join(' / ')}）`,
    );
  }
  return value as SectionVerticalAlign;
}

/** 某节的页内垂直对齐；没设过返回 `null`（**不是** `top`——默认值 ≠ 设过，R118）。 */
export function verticalAlignOf(section: SectionProperties): SectionVerticalAlign | null {
  const state = section.verticalAlign;
  return state === undefined || state.state !== 'set' ? null : state.value;
}

/** 设置页内垂直对齐（作用范围为**节**）。 */
export function setVerticalAlign(
  section: SectionProperties,
  align: SectionVerticalAlign,
): SectionProperties {
  requireVerticalAlign(align);
  return { ...section, verticalAlign: specified(align) };
}

/** 清除页内垂直对齐设置（回落到消费端默认）。 */
export function unsetVerticalAlign(section: SectionProperties): SectionProperties {
  return { ...section, verticalAlign: UNSPECIFIED_VALUE };
}

/** 给范围内的节设置页内垂直对齐。 */
export function applyVerticalAlign(
  model: DocumentModel,
  scope: SectionScope,
  align: SectionVerticalAlign,
): DocumentModel {
  requireVerticalAlign(align);
  return updateSections(model, scope, (section) => setVerticalAlign(section, align));
}
