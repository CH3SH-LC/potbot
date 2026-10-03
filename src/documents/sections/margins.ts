/**
 * 页边距与装订线（WF-047）。
 *
 * ## 为什么四边是**一套**而不是四个独立开关
 *
 * OOXML 的 `w:pgMar` 把 `w:top/@w:right/@w:bottom/@w:left` 都定成**必填属性**，
 * 模型侧也是 `margins: ValuedState<{top,right,bottom,left,gutter}>` 一整个盒子。
 * 因此：
 *
 * - **未设置** = 整个盒子"未指定"（不写 `w:pgMar`，四边由消费端默认决定）；
 * - **已设置** = 五条边都有具体值。
 *
 * 这带来一个**故意**的取舍：`setMarginEdge` 在"这一节还从未设过页边距"时会**拒绝**，
 * 而不是替没给出的三条边填 0。填 0 会把"这两条边没设过"变成"这两条边是 0 厘米"，
 * 那是两份不同的字节与两种不同的版式（R118 的同一条纪律：0 不是"未指定"）。
 * 调用方要么给全 `setMargins(section, box)`，要么先给出基数。
 *
 * ## 装订线（gutter）为什么单独一条
 *
 * `w:gutter` 是"在排版区外**额外**预留的装订空间"，语义上不占用四边之一：它由消费端
 * 叠加到内侧（或左边）。所以本包既**不**把它并进 `textAreaOf` 的四边减法，也**不**在
 * 切方向时挪动它——它和四边一样是"命名边"的量。
 */

import { DocumentModelError } from '../model/errors.js';
import type { SectionProperties, Length } from '../model/types.js';
import { UNSPECIFIED_VALUE, specified } from '../model/attributes.js';
import { lengthToTwips } from '../units/length.js';
import type { MarginBox, MarginEdge } from './types.js';
import { marginsOf, pageSizeOf, requireLength, requireMarginBox } from './values.js';

/**
 * 设置整套页边距。
 *
 * 若该节已设置纸张尺寸，顺带校验**正文区仍然为正**（`requireMarginBox` 会算
 * 宽 − 左 − 右、高 − 上 − 下）——"边距比纸还大"是要在操作前拒绝的输入（R140），
 * 而不是等到消费端排版时才发现。
 */
export function setMargins(section: SectionProperties, box: MarginBox): SectionProperties {
  requireMarginBox(box, pageSizeOf(section));
  return { ...section, margins: specified(box) };
}

/**
 * 改**一条**边（保留其余各边）。
 *
 * 该节尚未设置过页边距时**拒绝**：OOXML 的四条边是必填属性，而"给没设过的三条边
 * 填 0"就是把未指定混成 0（R118）。要先设整套，或先用 `setMargins` 给出基数。
 */
export function setMarginEdge(
  section: SectionProperties,
  edge: MarginEdge,
  length: Length,
): SectionProperties {
  const current = marginsOf(section);
  if (current === null) {
    throw new DocumentModelError(
      'unsupported',
      `这一节还没有设置过页边距，无法只改「${edge}」一条边：` +
        'OOXML 的 w:pgMar 四条边是必填属性，给没给出的边填 0 会把"未指定"混成"0 厘米"（R118）。' +
        '请先用 setMargins 给出整套四边值。',
    );
  }
  requireLength(length, `页边距的${edge}`);
  const next: MarginBox = { ...current, [edge]: length };
  requireMarginBox(next, pageSizeOf(section));
  return { ...section, margins: specified(next) };
}

/**
 * 设置装订线（其余各边不动）。
 *
 * 与 `setMarginEdge` 同样的前置条件：装订线是 `w:pgMar` 的一个属性，
 * 整条 `w:pgMar` 没写过时也就不存在"只改装订线"这件事。
 */
export function setGutter(section: SectionProperties, gutter: Length): SectionProperties {
  const current = marginsOf(section);
  if (current === null) {
    throw new DocumentModelError(
      'unsupported',
      '这一节还没有设置过页边距，无法只设置装订线：' +
        'w:gutter 是 w:pgMar 的一个属性，整条 w:pgMar 没写过时不存在"只改装订线"（R118/R140）。',
    );
  }
  requireLength(gutter, '装订线');
  return { ...section, margins: specified({ ...current, gutter }) };
}

/** 清除页边距设置（整条 `w:pgMar` 不写，四边回落到消费端默认）。 */
export function unsetMargins(section: SectionProperties): SectionProperties {
  return { ...section, margins: UNSPECIFIED_VALUE };
}

/**
 * 四边是否对称（用于"对称页边距"这类界面态的读回判断）。
 *
 * 判定在 twips 上做：上下用 mm、左右用 cm 时数值不可比，必须回到共同刻度。
 */
export function marginsSymmetric(box: MarginBox): { readonly horizontal: boolean; readonly vertical: boolean } {
  return {
    horizontal: lengthToTwips(box.left) === lengthToTwips(box.right),
    vertical: lengthToTwips(box.top) === lengthToTwips(box.bottom),
  };
}
