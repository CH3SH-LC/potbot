/**
 * 行距换算（R128，WF-022–024）。**唯一权威实现。**
 *
 * ## 两套刻度，绝不许混（这是本文件存在的主要理由）
 *
 * OOXML 用同一对属性 `w:line` + `w:lineRule` 表达六类行距，但 `w:line` 的**单位随 `lineRule` 变**：
 *
 * | 用户说法 | lineRule | `w:line` 的含义 | 值 |
 * |---|---|---|---|
 * | 单倍 | `auto` | 240 = 1 行（倍数刻度） | 240 |
 * | 1.5 倍 | `auto` | 倍数刻度 | **360** |
 * | 双倍 | `auto` | 倍数刻度 | 480 |
 * | 1.25 倍 | `auto` | 倍数刻度 | 300 |
 * | 固定 20pt | `exact` | **twips**（1/20 pt） | **400** |
 * | 最小 18pt | `atLeast` | **twips** | **360** |
 *
 * 注意 1.5 倍与最小 18pt **都产出 360**，但一个是倍数刻度、一个是 twips——`lineRule` 不同，
 * 语义完全不同。所以"自动倍数与固定/最小行距单位不同，不许混"这条判据，在本实现里
 * 由**类型分流**保证：前四类走 `AUTO_LINE_UNIT`，后两类走 `lengthToTwips`。
 */

import type { LineSpacing } from '../model/types.js';
import { AUTO_LINE_UNIT } from './constants.js';
import { lengthToTwips, twipsToLength } from './length.js';

/** `w:lineRule` 的三种取值。 */
export type LineRule = 'auto' | 'exact' | 'atLeast';

/** 行距的 OOXML 属性记录：`w:line` 与 `w:lineRule`。 */
export interface LineSpacingOoxml {
  /** `w:line`。单位取决于 `lineRule`：`auto` 时是 1/240 行，其余是 twips。 */
  readonly line: number;
  readonly lineRule: LineRule;
}

/**
 * 六类行距 → `{line, lineRule}`（R128）。
 *
 * - `single` / `oneAndHalf` / `double` / `multiple` → `lineRule='auto'`，`line = 240 × 倍数`；
 * - `exact` → `lineRule='exact'`，`line = twips(长度)`；
 * - `atLeast` → `lineRule='atLeast'`，`line = twips(长度)`。
 *
 * `multiple` 的取整：`Math.round(240 × v)`。1.25 → 300、1.75 → 420，都是整数；
 * 1.1 → 264。往返用 `lineSpacingFromOoxml` 会得到 264/240 = 1.1，误差在 1/240 行以内
 * （WF-023 要求的"规范取整与往返误差"）。
 */
export function lineSpacingToOoxml(spacing: LineSpacing): LineSpacingOoxml {
  switch (spacing.kind) {
    case 'single':
      return { line: AUTO_LINE_UNIT, lineRule: 'auto' };
    case 'oneAndHalf':
      return { line: AUTO_LINE_UNIT * 1.5, lineRule: 'auto' };
    case 'double':
      return { line: AUTO_LINE_UNIT * 2, lineRule: 'auto' };
    case 'multiple':
      return { line: Math.round(AUTO_LINE_UNIT * spacing.value), lineRule: 'auto' };
    case 'exact':
      return { line: lengthToTwips(spacing.value), lineRule: 'exact' };
    case 'atLeast':
      return { line: lengthToTwips(spacing.value), lineRule: 'atLeast' };
  }
}

/**
 * `{line, lineRule}` → 六类行距（读回方向）。
 *
 * `auto` 分支按 240 基准反推倍数，并**归一化回标准形态**：240 → `single`、360 → `oneAndHalf`、
 * 480 → `double`，其余 → `multiple`。这样"写 1.5 倍、读回 oneAndHalf"能对上，
 * 而不是读回一个 `multiple: 1.5` 的等价但不同形的对象。
 *
 * `exact` / `atLeast` 分支把 twips 还原成 pt 的 `Length`——**固定/最小行距的用户面单位是长度，
 * 不是裸 twips**（R127：twips 只在转换层出现）。
 */
export function lineSpacingFromOoxml(line: number, lineRule: LineRule): LineSpacing {
  if (lineRule === 'auto') {
    if (line === AUTO_LINE_UNIT) return { kind: 'single' };
    if (line === AUTO_LINE_UNIT * 1.5) return { kind: 'oneAndHalf' };
    if (line === AUTO_LINE_UNIT * 2) return { kind: 'double' };
    return { kind: 'multiple', value: line / AUTO_LINE_UNIT };
  }
  const value = twipsToLength(line, 'pt');
  return lineRule === 'exact' ? { kind: 'exact', value } : { kind: 'atLeast', value };
}
