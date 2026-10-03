/**
 * 段落对齐（WF-017–021）。五种对齐**分别表示**，都不靠空格拼。
 *
 * ## 为什么"取消居中"有两个不同的函数
 *
 * - `setAlignment(props, 'left')` —— 写 `<w:jc w:val="left"/>`。这是"**显式**左对齐"：
 *   即使样式（Heading1）本身要求居中，该段也会左对齐。等于 Word 里点"左对齐"按钮。
 * - `unsetAlignment(props)` —— 写 `inherit`（删掉 `<w:jc/>`）。这是"**不再指定**对齐"：
 *   该段回落到样式的对齐方式。等于 Word 里"清除段落格式"后对齐栏变回样式默认。
 *
 * 两者产出的字节不同（一个有 `w:jc`、一个没有），用户体验也不同，故不合并（R117/R118）。
 *
 * ## `justify` 与 `distribute` 不能互换（WF-020/WF-021）
 *
 * 两端对齐（`w:jc=both`）与分散对齐（`w:jc=distribute`）是不同的枚举值。**禁止**用插入空格
 * 拼出分散对齐——那会把空格写进正文，被搜索、字数统计和事实护栏当成内容。模型里
 * `Alignment` 有独立的 `'distribute'` 分支，本函数原样落成 `distribute`，不做任何模仿。
 */

import type { Alignment, ParagraphProperties } from '../../model/types.js';
import { VALUED_INHERIT, valuedSet } from './states.js';

/** 五种对齐的稳定枚举（WF-017–021 全覆盖，供测试遍历断言）。 */
export const ALIGNMENTS: readonly Alignment[] = Object.freeze([
  'left',
  'center',
  'right',
  'justify',
  'distribute',
] as readonly Alignment[]);

/** 设置段落对齐（WF-017–021）。 */
export function setAlignment(props: ParagraphProperties, alignment: Alignment): ParagraphProperties {
  return { ...props, alignment: valuedSet(alignment) };
}

/** 清除对齐的直接格式，回落到样式（不是"设为左对齐"）。 */
export function unsetAlignment(props: ParagraphProperties): ParagraphProperties {
  return { ...props, alignment: VALUED_INHERIT };
}
