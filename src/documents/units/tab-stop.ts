/**
 * 制表位换算（WF-030）。**唯一权威实现。**
 *
 * 制表位在 OOXML 里是 `w:tab`，`w:pos` 单位 twips；对齐与前导符是**枚举**，取值与模型
 * 一致（无需改名），但位置必须走 `lengthToTwips`——不许在制表位代码里另写一份换算。
 *
 * 本文件同时承担"制表位排序与去重"这一确定性规则：Word 按位置升序渲染制表位，
 * 同位置后来者覆盖前者。把这条规则放在换算层，操作层与写码层就不必各判一次。
 */

import type { TabStop } from '../model/types.js';
import { lengthToTwips } from './length.js';

/** 制表位对齐（OOXML `w:val`）。 */
export type TabAlignment = 'left' | 'center' | 'right' | 'decimal' | 'bar';

/** 制表位前导符（OOXML `w:leader`）。 */
export type TabLeader = 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot';

/** 制表位的 OOXML 属性记录。 */
export interface TabStopOoxml {
  /** `w:pos`，单位 twips。 */
  readonly pos: number;
  readonly val: TabAlignment;
  readonly leader: TabLeader;
}

/** 单个制表位 → 属性记录。 */
export function tabStopToOoxml(tab: TabStop): TabStopOoxml {
  return { pos: lengthToTwips(tab.position), val: tab.alignment, leader: tab.leader };
}

/**
 * 一组制表位 → 规范化的属性记录列表。
 *
 * 规范化规则（确定性，测试钉死）：
 * 1. 按 `pos` **升序**排列；
 * 2. **同位置只保留最后一个**（后写覆盖先写，与 Word 的覆盖语义一致）。
 */
export function tabStopsToOoxml(tabs: readonly TabStop[]): readonly TabStopOoxml[] {
  const mapped = tabs.map(tabStopToOoxml);
  const byPos = new Map<number, TabStopOoxml>();
  for (const tab of mapped) byPos.set(tab.pos, tab);
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}
