/**
 * 段落属性工厂（WF-034 的复位目标）。
 *
 * 两个工厂的差别就是 R117 语义的差别，不是"两个都行"：
 *
 * - `createDefaultParagraphProperties()` —— **未指定**。用于"新建一个段落"：
 *   它身上本来就没有任何 `pPr` 元素，任何属性都回落到样式（但这不表示用户"清除了"什么）。
 * - `createInheritedParagraphProperties()` —— **清除覆盖**。用于 WF-034「清除段落格式」：
 *   语义是"把这一段此前设过的直接格式**删掉**，回到继承"。写码层对 `inherit` 的动作是
 *   **删除已有元素**，对 `unspecified` 的动作是**不写元素**——对同一份原文档，前者会真的
 *   删掉旧内容，后者不会。
 *
 * 把"清除"实现成"新建一个空对象"是个常见错误：如果模型原样导出，旧元素还在，用户看到
 * "我点了清除，格式没变"。所以这里必须分开。
 */

import { TOGGLE_INHERIT, TOGGLE_UNSPECIFIED } from '../../model/types.js';
import type { IndentProperties, ParagraphProperties } from '../../model/types.js';
import { VALUED_INHERIT, VALUED_UNSPECIFIED } from './states.js';

/** 缩进四槽位：全部未指定。 */
export function createDefaultIndentProperties(): IndentProperties {
  return {
    left: VALUED_UNSPECIFIED,
    right: VALUED_UNSPECIFIED,
    firstLine: VALUED_UNSPECIFIED,
    hanging: VALUED_UNSPECIFIED,
  };
}

/** 缩进四槽位：全部"清除覆盖"。 */
export function createInheritedIndentProperties(): IndentProperties {
  return {
    left: VALUED_INHERIT,
    right: VALUED_INHERIT,
    firstLine: VALUED_INHERIT,
    hanging: VALUED_INHERIT,
  };
}

/**
 * 新建段落用的属性：**全部未指定**。
 *
 * 这不是"把段落格式清空了"——是"这一段还没有任何直接格式"。区分见文件头注释。
 */
export function createDefaultParagraphProperties(): ParagraphProperties {
  return {
    alignment: VALUED_UNSPECIFIED,
    lineSpacing: VALUED_UNSPECIFIED,
    spacingBefore: VALUED_UNSPECIFIED,
    spacingAfter: VALUED_UNSPECIFIED,
    indent: createDefaultIndentProperties(),
    tabStops: VALUED_UNSPECIFIED,
    pageBreakBefore: TOGGLE_UNSPECIFIED,
    keepNext: TOGGLE_UNSPECIFIED,
    keepLines: TOGGLE_UNSPECIFIED,
    widowControl: TOGGLE_UNSPECIFIED,
    borders: VALUED_UNSPECIFIED,
    shading: VALUED_UNSPECIFIED,
    outlineLevel: VALUED_UNSPECIFIED,
  };
}

/**
 * WF-034「清除段落格式」的目标属性：**全部为"清除覆盖"**。
 *
 * 只作用于**段落**直接格式（`pPr`）。**不碰** run 的字符格式——清除段落格式不能顺手
 * 把句子里的加粗、颜色抹掉（WF-034 的"不误清字符局部强调"，R120 的两种清除不同）。
 * 因此本函数的返回类型里根本没有字符属性，从类型上就杜绝了越界。
 */
export function createInheritedParagraphProperties(): ParagraphProperties {
  return {
    alignment: VALUED_INHERIT,
    lineSpacing: VALUED_INHERIT,
    spacingBefore: VALUED_INHERIT,
    spacingAfter: VALUED_INHERIT,
    indent: createInheritedIndentProperties(),
    tabStops: VALUED_INHERIT,
    pageBreakBefore: TOGGLE_INHERIT,
    keepNext: TOGGLE_INHERIT,
    keepLines: TOGGLE_INHERIT,
    widowControl: TOGGLE_INHERIT,
    borders: VALUED_INHERIT,
    shading: VALUED_INHERIT,
    outlineLevel: VALUED_INHERIT,
  };
}
