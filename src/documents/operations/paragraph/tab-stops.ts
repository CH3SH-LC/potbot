/**
 * 制表位操作（WF-030）：新增、删除、清空、整组替换。
 *
 * ## 为什么"删除"按位置而按索引
 *
 * 制表位的身份是**位置**（OOXML 里 `w:pos` 就是主键，同位置后者覆盖前者）。
 * 按数组下标删除是脆弱接口：UI 上看到的顺序是排序后的，模型里的顺序可能是导入顺序，
 * 两者不一致时"删第 3 个"会删错。所以 `removeTabStop(props, position)` 收 `Length` 位置，
 * 内部走 `lengthToTwips`（唯一换算点）比较。—— 这也保证了删除与写入用的是同一套换算，
 * 不会出现"写入落在 1134、删除去找 1133"的对不上。
 *
 * ## 排序与去重
 *
 * 模型里保存的制表位保持**按位置升序、同位置唯一**。规范化函数在
 * `src/documents/units/tab-stop.ts`（`tabStopsToOoxml`）；本文件在写入时同步做一次同样的
 * 规范化，让模型态与写码态一致，避免"模型里两个同位置、导出后一个"的往返差异。
 */

import type { Length, ParagraphProperties, TabStop } from '../../model/types.js';
import { lengthToTwips } from '../../units/length.js';
import { cloneTabStop } from './clone.js';
import { VALUED_INHERIT, valuedSet } from './states.js';

/** 按位置升序排序并去重（同位置后写覆盖先写）。返回新数组。 */
export function normalizeTabStops(tabs: readonly TabStop[]): readonly TabStop[] {
  const byPos = new Map<number, TabStop>();
  for (const tab of tabs) byPos.set(lengthToTwips(tab.position), tab);
  return [...byPos.entries()].sort((a, b) => a[0] - b[0]).map(([, tab]) => tab);
}

/** 读取当前制表位列表（未指定 → 空数组）。 */
export function getTabStops(props: ParagraphProperties): readonly TabStop[] {
  return props.tabStops.state === 'set' ? props.tabStops.value : [];
}

/** 新增一个制表位（WF-030）。同位置覆盖。 */
export function addTabStop(props: ParagraphProperties, tab: TabStop): ParagraphProperties {
  return setTabStops(props, [...getTabStops(props), tab]);
}

/**
 * 删除指定**位置**的制表位（WF-030）。
 *
 * 位置比较走 twips 换算，与写入同一套刻度。若删除后列表为空，落 `unspecified`
 * （而不是"空数组的 set"）——文档里没有制表位、与"明确声明一个制表位都没有"是两件事，
 * 前者是默认状态。
 */
export function removeTabStop(props: ParagraphProperties, position: Length): ParagraphProperties {
  const target = lengthToTwips(position);
  const remaining = getTabStops(props).filter((tab) => lengthToTwips(tab.position) !== target);
  return setTabStops(props, remaining);
}

/** 整组替换制表位（排序去重后写入，并对制表位做深拷贝）。 */
export function setTabStops(props: ParagraphProperties, tabs: readonly TabStop[]): ParagraphProperties {
  const normalized = normalizeTabStops(tabs).map(cloneTabStop);
  if (normalized.length === 0) {
    return { ...props, tabStops: VALUED_INHERIT };
  }
  return { ...props, tabStops: valuedSet(normalized) };
}

/** 清空全部制表位（WF-030 的"删除"的极端情况）。 */
export function clearTabStops(props: ParagraphProperties): ParagraphProperties {
  return { ...props, tabStops: VALUED_INHERIT };
}

/** 便捷构造制表位。 */
export function tabStop(
  position: Length,
  alignment: TabStop['alignment'] = 'left',
  leader: TabStop['leader'] = 'none',
): TabStop {
  return { position, alignment, leader };
}
