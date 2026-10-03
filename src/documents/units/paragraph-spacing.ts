/**
 * 段前 / 段后间距换算（R131，WF-025/026）。**唯一权威实现。**
 *
 * ## 为什么返回的是"三属性记录"而不是一个数
 *
 * OOXML 用**三个**属性描述一侧间距（段前为例）：
 *
 * | 属性 | 单位 | 何时出现 |
 * |---|---|---|
 * | `w:before` | twips | 按 pt 指定时 |
 * | `w:beforeLines` | 1/100 行 | 按行指定时 |
 * | `w:beforeAutospacing` | 布尔 | 自动间距时 |
 *
 * 三者**语义互斥**。用户在 pt / 行 / 自动之间来回切换时，如果只写新属性而不清旧属性，
 * 文档里就会留下"既有 before 又是 autospacing"的残留——Word 的行为由优先级决定，
 * 于是"我明明设了 12 磅，却渲染成自动"。所以本函数把"该侧的三属性**完整目标状态**"一次给出：
 *
 * - 值为 `number` / `boolean` ⇒ **写**该属性；
 * - 值为 `null` ⇒ **不要有**该属性（有则删除）。
 *
 * 这是"切换时消除冲突属性、不留残留"的实现位置。
 *
 * ## 段前与段后为什么完全独立（WF-026）
 *
 * 本函数**不区分是 before 还是 after**——它只描述"某一侧"的目标状态，`before`/`after` 的名字
 * 由操作层在调用时确定。段前与段后各自求值、各自写入，天然独立：改段前不会碰到段后的任何属性。
 */

import type { ParagraphSpacing } from '../model/types.js';
import { HUNDREDTHS_PER_LINE } from './constants.js';
import { pointsToTwips, twipsToPoints } from './length.js';

/**
 * 一侧间距的三属性目标状态。
 *
 * `null` 的语义是"**该属性不应存在**"，不是"值等于 null"。
 */
export interface SpacingSideAttributes {
  /** `w:before` / `w:after`，单位 twips；`null` = 不应存在。 */
  readonly line: number | null;
  /** `w:beforeLines` / `w:afterLines`，单位 1/100 行；`null` = 不应存在。 */
  readonly lines: number | null;
  /** `w:beforeAutospacing` / `w:afterAutospacing`；非自动时**显式写 false**。 */
  readonly autospacing: boolean;
}

/** 未指定任何间距时的一侧属性：三属性都不应存在、auto 显式关。 */
export const EMPTY_SPACING_SIDE: SpacingSideAttributes = Object.freeze({
  line: null,
  lines: null,
  autospacing: false,
});

/**
 * `ParagraphSpacing` → 一侧三属性目标状态。
 *
 * - `pt n`  → `{line: 20n, lines: null, autospacing: false}`
 * - `lines n` → `{line: null, lines: 100n, autospacing: false}`
 * - `auto`  → `{line: null, lines: null, autospacing: true}`
 *
 * `pt 0`（"取消段前距"）得到 `{line: 0, lines: null, autospacing: false}`——**显式 0**，
 * 与"未指定"（没有任何属性）是两件事（R118 的同一原则应用到段落间距）。
 */
export function paragraphSpacingToOoxml(spacing: ParagraphSpacing): SpacingSideAttributes {
  switch (spacing.kind) {
    case 'pt':
      return { line: pointsToTwips(spacing.value), lines: null, autospacing: false };
    case 'lines':
      return { line: null, lines: Math.round(spacing.value * HUNDREDTHS_PER_LINE), autospacing: false };
    case 'auto':
      return { line: null, lines: null, autospacing: true };
  }
}

/**
 * 一侧三属性 → `ParagraphSpacing`（读回方向）。
 *
 * 判序与写入相反：**先看 autospacing**（自动优先级最高，也是唯一能解释"同时存在"残留的分支），
 * 再看 `beforeLines`，最后看 `before`。这样一个"曾经被污染过"的文档读回时不会撒谎。
 */
export function paragraphSpacingFromOoxml(
  attributes: SpacingSideAttributes,
): ParagraphSpacing | null {
  if (attributes.autospacing) return { kind: 'auto' };
  if (attributes.lines !== null) {
    return { kind: 'lines', value: attributes.lines / HUNDREDTHS_PER_LINE };
  }
  if (attributes.line !== null) {
    return { kind: 'pt', value: twipsToPoints(attributes.line) };
  }
  return null;
}
