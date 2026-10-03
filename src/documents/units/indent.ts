/**
 * 缩进换算（R128/R130，WF-027–029）。**唯一权威实现。**
 *
 * ## "首行缩进 2 字" ≠ "2 cm"——这是本文件的核心
 *
 * R130 钉死：字符与长度**分开表达、分开写属性**，且**禁止**用两个全角空格冒充缩进。
 * OOXML 恰好给了两套属性：
 *
 * | 用户说法 | 属性 | 单位 | 值 |
 * |---|---|---|---|
 * | 首行缩进 **2 字** | `w:firstLineChars` | 1/100 字 | **200** |
 * | 首行缩进 **2 cm** | `w:firstLine` | twips | **1134** |
 *
 * 两者是**不同属性**，不可互换：`firstLineChars` 随字号缩放（用户改字号，缩进跟着变），
 * `firstLine` 是死长度。用全角空格冒充更糟——那不是缩进，是文本内容，会被搜索、替换、
 * 字数统计和事实护栏当成正文。
 *
 * 实现上由 `IndentAmount` 的类型分流保证：`{unit:'chars'}` 只能落到 `*Chars` 属性，
 * `Length` 只能落到长度属性。**不存在一条路径能让字符值写进长度属性。**
 *
 * ## 八属性的完整目标状态
 *
 * 每侧（左右）与首行/悬挂各有两个变体（字符 / 长度），共 8 个属性。与段间距同理，
 * 返回"完整目标状态"（`null` = 不应存在），以便在字符↔长度、首行↔悬挂之间切换时**一次清干净**。
 */

import type { IndentAmount, IndentProperties } from '../model/types.js';
import { HUNDREDTHS_PER_CHAR } from './constants.js';
import { lengthToTwips } from './length.js';

/**
 * 缩进八属性的目标状态。`null` 的语义是"**该属性不应存在**"。
 *
 * 互斥关系（OOXML 语义，本实现主动维护）：
 * - `firstLine*` 与 `hanging*` **互斥**——首行缩进与悬挂缩进不能同时生效；
 * - 每组的"字符变体"与"长度变体"**互斥**——同一个量不可能既是 2 字又是 2 cm。
 */
export interface IndentAttributes {
  readonly left: number | null;
  readonly leftChars: number | null;
  readonly right: number | null;
  readonly rightChars: number | null;
  readonly firstLine: number | null;
  readonly firstLineChars: number | null;
  readonly hanging: number | null;
  readonly hangingChars: number | null;
}

/** 无缩进：八属性都不应存在。 */
export const EMPTY_INDENT_ATTRIBUTES: IndentAttributes = Object.freeze({
  left: null,
  leftChars: null,
  right: null,
  rightChars: null,
  firstLine: null,
  firstLineChars: null,
  hanging: null,
  hangingChars: null,
});

/** 缩进的四个槽位。 */
export type IndentSlot = 'left' | 'right' | 'firstLine' | 'hanging';

/** 每个槽位的字符属性名与长度属性名。 */
const SLOT_ATTRS: Readonly<Record<IndentSlot, { readonly chars: keyof IndentAttributes; readonly length: keyof IndentAttributes }>> = {
  left: { chars: 'leftChars', length: 'left' },
  right: { chars: 'rightChars', length: 'right' },
  firstLine: { chars: 'firstLineChars', length: 'firstLine' },
  hanging: { chars: 'hangingChars', length: 'hanging' },
};

/**
 * 单个缩进量 → 该槽位的两属性目标状态片段。
 *
 * `{unit:'chars'}` → `{<slot>Chars: round(v*100), <slot>: null}`
 * `Length`         → `{<slot>: twips, <slot>Chars: null}`
 *
 * 这条分流就是 R128 与 R130 的执行点：字符值**没有任何路径**能进入长度属性。
 */
export function indentAmountToSlotAttributes(
  slot: IndentSlot,
  amount: IndentAmount,
): { readonly chars: number | null; readonly length: number | null } {
  if (amount.unit === 'chars') {
    return { chars: Math.round(amount.value * HUNDREDTHS_PER_CHAR), length: null };
  }
  return { chars: null, length: lengthToTwips(amount) };
}

/** 单个槽位 → 完整八属性（其余槽位为空）。 */
export function indentAmountToOoxml(slot: IndentSlot, amount: IndentAmount): IndentAttributes {
  const empty = EMPTY_INDENT_ATTRIBUTES;
  switch (slot) {
    case 'left':
      return { ...empty, left: amount.unit === 'chars' ? null : lengthToTwips(amount), leftChars: amount.unit === 'chars' ? Math.round(amount.value * HUNDREDTHS_PER_CHAR) : null };
    case 'right':
      return { ...empty, right: amount.unit === 'chars' ? null : lengthToTwips(amount), rightChars: amount.unit === 'chars' ? Math.round(amount.value * HUNDREDTHS_PER_CHAR) : null };
    case 'firstLine':
      return { ...empty, firstLine: amount.unit === 'chars' ? null : lengthToTwips(amount), firstLineChars: amount.unit === 'chars' ? Math.round(amount.value * HUNDREDTHS_PER_CHAR) : null };
    case 'hanging':
      return { ...empty, hanging: amount.unit === 'chars' ? null : lengthToTwips(amount), hangingChars: amount.unit === 'chars' ? Math.round(amount.value * HUNDREDTHS_PER_CHAR) : null };
  }
}

/**
 * `IndentProperties`（模型态）→ 八属性目标状态。
 *
 * 只处理 `state === 'set'` 的槽位；`unspecified` / `inherit` 都产出"该属性不应存在"
 * （`inherit` 在写码层的动作是**删除**元素，效果同为"不存在"，故此处等价处理）。
 *
 * **超出合同的防御分支**：若首行与悬挂**同时**为 `set`（操作层保证不会发生，但 JSON 反序列化
 * 回来的脏数据可能有），本函数采取确定性取舍——**悬挂优先**（按 ECMA-376，`w:hanging` 在
 * 两者并存时生效），并让首行两属性归 `null`。取舍只有这一处，要改只改这里。
 */
export function indentToOoxml(indent: IndentProperties): IndentAttributes {
  const result: {
    left: number | null;
    leftChars: number | null;
    right: number | null;
    rightChars: number | null;
    firstLine: number | null;
    firstLineChars: number | null;
    hanging: number | null;
    hangingChars: number | null;
  } = { ...EMPTY_INDENT_ATTRIBUTES };

  const apply = (slot: IndentSlot, state: IndentProperties[IndentSlot]): void => {
    if (state.state !== 'set') return;
    const attrs = indentAmountToSlotAttributes(slot, state.value);
    result[SLOT_ATTRS[slot].chars] = attrs.chars;
    result[SLOT_ATTRS[slot].length] = attrs.length;
  };

  apply('left', indent.left);
  apply('right', indent.right);

  const firstLineSet = indent.firstLine.state === 'set';
  const hangingSet = indent.hanging.state === 'set';

  if (firstLineSet && hangingSet) {
    // 防御分支：悬挂优先，首行让位（见上方文档注释）。
    apply('hanging', indent.hanging);
  } else {
    apply('firstLine', indent.firstLine);
    apply('hanging', indent.hanging);
  }

  return result;
}
