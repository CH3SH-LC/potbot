/**
 * 节属性的**取值校验**与长度算术（R127–R131、R140、R153）。
 *
 * ## 为什么校验要过 `units/**` 而不是就地写数
 *
 * R131 钉死"不存在一个数字到处复用"；R128 钉死"换算集中一处"。页边距的合法范围
 * 在 Word 里是按 twips 说的（最大 22 英寸 = 31680 twips），所以判断"这个 21cm 边距
 * 越界了吗"必须先**换算**再比。如果本文件自己写 `31680`，就会出现第二份权威；
 * 因此这里一律调用 `units/format-params.ts` 的 `validateFormatParameter`——
 * 它本来就是"格式参数校验域"（R153）的唯一实现，页边距也正是它列出的字段之一
 * （`pageMarginTwips`）。
 *
 * ## 为什么"未指定"不是 0，也不是 null
 *
 * R118：`unspecified`（不写元素）与"设成 0"是两种字节。本文件的校验只作用于
 * **确实要写的值**；`unspecified` 由调用方用 `ValuedState` 表达，不经过这里。
 */

import { DocumentModelError } from '../model/errors.js';
import { specified, stateValue } from '../model/attributes.js';
import type { Length, SectionProperties, ValuedState } from '../model/types.js';
import { lengthToTwips, twipsToLength, isLengthUnit } from '../units/length.js';
import { validateFormatParameter } from '../units/format-params.js';
import type { MarginBox, PageOrientation, PageSize } from './types.js';

// ---------------------------------------------------------------------------
// 长度
// ---------------------------------------------------------------------------

/**
 * 校验一个长度：单位必须是 `LengthUnit`（R127），数值有限，换算成 twips 后落在
 * **格式域**允许的物理范围内（R153）。
 *
 * `allow_negative` 只在"相对量"上有意义；页面的尺寸与边距都是**绝对、非负**的量，
 * 所以默认拒绝负数——"负页边距"不是一个可以悄悄夹到 0 的输入（R136）。
 */
export function requireLength(
  length: Length,
  what: string,
  options: { readonly allow_negative?: boolean } = {},
): Length {
  if (typeof length !== 'object' || length === null) {
    throw new DocumentModelError('invalid_node', `${what} 必须是带单位的长度对象，收到 ${JSON.stringify(length)}`);
  }
  if (!isLengthUnit(length.unit)) {
    throw new DocumentModelError(
      'invalid_node',
      `${what} 的单位非法：${JSON.stringify(length.unit)}（R127：值必须带单位，且单位须是 pt/mm/cm/inch/twips）`,
    );
  }
  if (!Number.isFinite(length.value)) {
    throw new DocumentModelError('invalid_node', `${what} 的数值必须是有限数，收到 ${String(length.value)}`);
  }
  const twips = lengthToTwips(length);
  if (!options.allow_negative && twips < 0) {
    // 浮点允许负零：`-0 < 0` 为 false，故 `-0` 会落到下面的范围校验并通过（-0 === 0）。
    throw new DocumentModelError('invalid_node', `${what} 不能是负数：${length.value}${length.unit}`);
  }
  const bounded = validateFormatParameter('pageMarginTwips', twips);
  if (!bounded.ok) {
    throw new DocumentModelError(
      'invalid_node',
      `${what} 超出可表达范围（格式域 ${'pageMarginTwips'}）：${bounded.reason}`,
    );
  }
  return length;
}

/** 校验纸张尺寸：宽高都必须合法，且**不能是零**（零宽纸张不是可排版页面）。 */
export function requirePageSize(size: PageSize, what = '纸张尺寸'): PageSize {
  requireLength(size.width, `${what}的宽`);
  requireLength(size.height, `${what}的高`);
  if (lengthToTwips(size.width) <= 0 || lengthToTwips(size.height) <= 0) {
    throw new DocumentModelError(
      'invalid_node',
      `${what}的宽高必须为正：${String(size.width.value)}${size.width.unit} × ${String(size.height.value)}${size.height.unit}`,
    );
  }
  return size;
}

/** 校验页边距（四边 + 装订线），并检查**正文区仍然为正**。 */
export function requireMarginBox(box: MarginBox, pageSize: PageSize | null, what = '页边距'): MarginBox {
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    requireLength(box[edge], `${what}的${edge}`);
  }
  requireLength(box.gutter, `${what}的装订线`);
  if (pageSize !== null) {
    const area = textAreaOf(pageSize, box);
    if (lengthToTwips(area.width) <= 0 || lengthToTwips(area.height) <= 0) {
      throw new DocumentModelError(
        'invalid_node',
        `${what}把正文区挤没了：纸张 ${String(pageSize.width.value)}${pageSize.width.unit} × ` +
          `${String(pageSize.height.value)}${pageSize.height.unit}，` +
          `去掉左右 ${String(lengthToTwips(box.left))}+${String(lengthToTwips(box.right))} twips、` +
          `上下 ${String(lengthToTwips(box.top))}+${String(lengthToTwips(box.bottom))} twips 后不为正`,
      );
    }
  }
  return box;
}

// ---------------------------------------------------------------------------
// 长度算术（**走 units，不自己造刻度**）
// ---------------------------------------------------------------------------

/**
 * 两个长度相减，结果用**被减数的单位**表达。
 *
 * 实现是"换算成 twips → 整数相减 → 换回单位"——每一步都调用 `units/**`。
 * 之所以不在本包内做等比缩放：`Length` 的单位可以不同（宽用 mm、边距用 cm），
 * 两套比例相减必须回到共同刻度上，而共同刻度只有 `units/**` 知道。
 */
export function subtractLength(minuend: Length, subtrahend: Length): Length {
  const twips = lengthToTwips(minuend) - lengthToTwips(subtrahend);
  return twipsToLength(twips, minuend.unit);
}

/**
 * 一页的**可排版正文区**（除去四边页边距）。
 *
 * 装订线**不计入**四边（它在 OOXML 里是 `w:pgMar/@w:gutter`，语义是"在左（或内侧）
 * 额外预留的装订空间"，由消费端叠加到某一侧），所以这里只减四边，装订线单独由
 * `gutterOf` 暴露。这样"正文区"的口径是确定的，不会因为装订线而两处不一致。
 */
export function textAreaOf(pageSize: PageSize, box: MarginBox): PageSize {
  const width = subtractLength(subtractLength(pageSize.width, box.left), box.right);
  const height = subtractLength(subtractLength(pageSize.height, box.top), box.bottom);
  return { width, height };
}

// ---------------------------------------------------------------------------
// `ValuedState` 小工具（本包内多处要用）
// ---------------------------------------------------------------------------

/** 取"已设置"的值；未指定 / 已清除返回 `null`（**不是** `0`，R118）。 */
export function setValueOrNull<T>(state: ValuedState<T>): T | null {
  return state.state === 'set' ? state.value : null;
}

/** 构造"已设置"。 */
export function set<T>(value: T): ValuedState<T> {
  return specified(value);
}

/**
 * 节里"已设置的页边距"；未指定时返回 `null`。
 *
 * 之所以不返回一个全 0 的 `MarginBox`：那会把"没设过"变成"设成 0"，正是 R118 禁止的混同。
 */
export function marginsOf(section: SectionProperties): MarginBox | null {
  return setValueOrNull(section.margins);
}

/** 节里"已设置的纸张尺寸"；未指定时返回 `null`。 */
export function pageSizeOf(section: SectionProperties): PageSize | null {
  return setValueOrNull(section.pageSize);
}

/** 节里"已设置的方向"；未指定时返回 `null`。 */
export function orientationOf(section: SectionProperties): PageOrientation | null {
  return stateValue(section.orientation) ?? null;
}
