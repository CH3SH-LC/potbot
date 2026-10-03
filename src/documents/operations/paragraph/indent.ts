/**
 * 缩进操作（WF-027–029）：首行 / 悬挂 / 左 / 右。
 *
 * ## 首行与悬挂**互斥**——本文件的核心职责
 *
 * 段落不可能同时"首行缩进 2 字"又"悬挂缩进 2 字"。用户在界面上点"悬挂"，Word 会**取消**
 * 首行缩进。因此：
 *
 * - `setFirstLineIndent` 除了设 `firstLine`，还把 `hanging` 置为 **`inherit`**（删除）；
 * - `setHangingIndent` 除了设 `hanging`，还把 `firstLine` 置为 **`inherit`**（删除）。
 *
 * 为什么用 `inherit` 而不是 `unspecified`：`unspecified` 只表示"本层不表达"，写码层对它的
 * 动作是"不写元素"；若 D02 对未改动部件走**局部重建**（R151），旧位置的 `<w:hanging/>`
 * 可能仍在原地——于是"取消悬挂"没生效。`inherit` 在模型里被定义为"**删除**已有元素、
 * 回落到继承"（R117/R120），语义上正是我们要的动作。这个区分不是洁癖，是"用户点了没反应"
 * 与"点了就生效"的区别。
 *
 * ## 字符域与长度域不可互换（R130）
 *
 * 本文件**不做任何换算**：`IndentAmount` 原样存进 `ValuedState`。字符域（`{unit:'chars'}`）
 * 与长度域（`Length`）的落属性分流在 `src/documents/units/indent.ts`——那才是唯一的换算点。
 * 这里若"顺手"把 2 字换算成 twips，就会在同一处代码里出现两套刻度，正是 R128/R131 禁止的。
 */

import type { IndentAmount, IndentProperties, ParagraphProperties } from '../../model/types.js';
import { VALUED_INHERIT, valuedSet } from './states.js';

/** 便捷构造：按**字符**指定缩进（"首行缩进 2 字"）——落 `*Chars` 属性。 */
export function indentChars(value: number): IndentAmount {
  return { unit: 'chars', value };
}

/** 便捷构造：按**长度**指定缩进（"首行缩进 2 cm"）——落长度属性（twips）。 */
export function indentLength(value: number, unit: 'pt' | 'mm' | 'cm' | 'inch'): IndentAmount {
  return { unit, value };
}

/** 设置**首行缩进**（WF-027）。同时**取消悬挂缩进**（互斥）。 */
export function setFirstLineIndent(props: ParagraphProperties, amount: IndentAmount): ParagraphProperties {
  return {
    ...props,
    indent: {
      ...props.indent,
      firstLine: valuedSet(amount),
      hanging: VALUED_INHERIT,
    },
  };
}

/** 设置**悬挂缩进**（WF-028）。同时**取消首行缩进**（互斥）。 */
export function setHangingIndent(props: ParagraphProperties, amount: IndentAmount): ParagraphProperties {
  return {
    ...props,
    indent: {
      ...props.indent,
      hanging: valuedSet(amount),
      firstLine: VALUED_INHERIT,
    },
  };
}

/** 设置**左**缩进（WF-029）。不影响右侧与首行/悬挂。 */
export function setLeftIndent(props: ParagraphProperties, amount: IndentAmount): ParagraphProperties {
  return { ...props, indent: { ...props.indent, left: valuedSet(amount) } };
}

/** 设置**右**缩进（WF-029）。不影响左侧与首行/悬挂。 */
export function setRightIndent(props: ParagraphProperties, amount: IndentAmount): ParagraphProperties {
  return { ...props, indent: { ...props.indent, right: valuedSet(amount) } };
}

/** 清除左缩进的直接格式。 */
export function clearLeftIndent(props: ParagraphProperties): ParagraphProperties {
  return { ...props, indent: { ...props.indent, left: VALUED_INHERIT } };
}

/** 清除右缩进的直接格式。 */
export function clearRightIndent(props: ParagraphProperties): ParagraphProperties {
  return { ...props, indent: { ...props.indent, right: VALUED_INHERIT } };
}

/**
 * 清除全部缩进的直接格式（WF-029 的"恢复零"）。
 *
 * 四槽位一起置 `inherit`，所以无论此前是字符域还是长度域、是首行还是悬挂，都一并删干净——
 * **不会**留下"我把首行设回 0 了，但旧的 2 字属性还在"这种残留。
 */
export function clearIndent(props: ParagraphProperties): ParagraphProperties {
  return {
    ...props,
    indent: {
      left: VALUED_INHERIT,
      right: VALUED_INHERIT,
      firstLine: VALUED_INHERIT,
      hanging: VALUED_INHERIT,
    },
  };
}

/** 判断当前缩进是否"首行与悬挂同时被显式设置"（正常操作路径下恒为 false；供不变量断言用）。 */
export function hasConflictingIndent(indent: IndentProperties): boolean {
  return indent.firstLine.state === 'set' && indent.hanging.state === 'set';
}
