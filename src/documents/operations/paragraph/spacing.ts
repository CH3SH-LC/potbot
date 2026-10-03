/**
 * 段前 / 段后间距（WF-025/026）。
 *
 * ## 段前与段后**完全独立**（WF-026）
 *
 * 这是本文件唯一的要点：`setSpacingBefore` 只写 `spacingBefore`，`setSpacingAfter` 只写
 * `spacingAfter`。**没有**任何"同时设置两侧"的函数——因为合同要求二者独立，
 * 提供合并入口就等于给"顺手把段后也改了"留了门。
 *
 * 如果调用方确实要一次改两侧，它应该显式调两次。多敲一行，换来"改段前绝不动段后"能被
 * 测试直接断言：`setSpacingBefore(p, X).spacingAfter` 与 `p.spacingAfter` **必须是同一个
 * 对象引用**（不只是相等）——连引用都没换过。
 *
 * ## pt / 行 / 自动的切换与残留
 *
 * 三者的**属性清理**在 `src/documents/units/paragraph-spacing.ts`：那里返回"该侧三属性的
 * 完整目标状态"（写哪个、删哪个）。操作层只保存 `ParagraphSpacing` 这一份语义值，
 * 因此"从自动切到 12 磅"在模型里就是一次整块替换，**不可能残留**旧的自动标记——
 * 残留问题只可能出现在写码层，而写码层拿到的是一份完整目标状态，不是增量。
 */

import type { ParagraphProperties, ParagraphSpacing } from '../../model/types.js';
import { VALUED_INHERIT, valuedSet } from './states.js';

/** 设置段**前**间距（WF-025）。不触碰段后。 */
export function setSpacingBefore(props: ParagraphProperties, spacing: ParagraphSpacing): ParagraphProperties {
  return { ...props, spacingBefore: valuedSet(spacing) };
}

/** 设置段**后**间距（WF-026）。不触碰段前。 */
export function setSpacingAfter(props: ParagraphProperties, spacing: ParagraphSpacing): ParagraphProperties {
  return { ...props, spacingAfter: valuedSet(spacing) };
}

/** 清除段前间距的直接格式，回落到样式。 */
export function unsetSpacingBefore(props: ParagraphProperties): ParagraphProperties {
  return { ...props, spacingBefore: VALUED_INHERIT };
}

/** 清除段后间距的直接格式，回落到样式。 */
export function unsetSpacingAfter(props: ParagraphProperties): ParagraphProperties {
  return { ...props, spacingAfter: VALUED_INHERIT };
}

/** 便捷构造：按 pt 指定段前/段后（用户最常见的说法，如"段前 12 磅"）。 */
export function spacingPt(value: number): ParagraphSpacing {
  return { kind: 'pt', value };
}

/** 便捷构造：按行指定段前/段后（"段前空一行"）。 */
export function spacingLines(value: number): ParagraphSpacing {
  return { kind: 'lines', value };
}

/** 便捷构造：自动间距（"自动"）。 */
export function spacingAuto(): ParagraphSpacing {
  return { kind: 'auto' };
}
