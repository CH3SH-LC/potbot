/**
 * P08 · **时序登记表**（每页至多一块 `p:timing`）。
 *
 * 装配者（P01）在把各页写进包之前，先把"这一页有多少动画"收集成一张登记表，
 * 再逐页注入。登记表的硬约束：
 *
 * 1. **一页一块**：同一 `slide_part_path` 只能有一条时序；重复 `add` ⇒ 抛错，
 *    要覆盖请显式用 `setTiming`（语义清楚，不靠"后写覆盖前写"的隐式行为）；
 * 2. **清除即空块**：`clearTiming` 不是"删条目"，而是把该页替换成**空时序树描述符**
 *    （`empty=true`）——`p:timing` 必须留在文件里表示"这页没有动画"，而不是"没写"；
 * 3. **不可变**：每次操作返回新登记表，不改入参。
 */

import { buildTimingDescriptor, makeTimingTarget, type TimingDescriptor } from './descriptor.js';
import { TimingPartsError } from './errors.js';
import { renderTimingXmlLossless } from './render.js';

/** 时序登记表（不可变）。 */
export interface TimingRegistry {
  readonly entries: readonly TimingDescriptor[];
}

export const EMPTY_TIMING_REGISTRY: TimingRegistry = Object.freeze({ entries: Object.freeze([]) });

/** 按页路径取条目；不存在 ⇒ `undefined`。 */
export function findTiming(registry: TimingRegistry, slidePartPath: string): TimingDescriptor | undefined {
  return registry.entries.find((entry) => entry.target.slide_part_path === slidePartPath);
}

/** 全部已登记页路径（登记顺序）。 */
export function timingPaths(registry: TimingRegistry): readonly string[] {
  return registry.entries.map((entry) => entry.target.slide_part_path);
}

/** 新增一条；该页已有条目 ⇒ `duplicate_timing_entry`（不覆盖、不静默忽略）。 */
export function addTiming(registry: TimingRegistry, descriptor: TimingDescriptor): TimingRegistry {
  if (findTiming(registry, descriptor.target.slide_part_path) !== undefined) {
    throw new TimingPartsError(
      'duplicate_timing_entry',
      `幻灯片 ${descriptor.target.slide_part_path} 已登记过时序；覆盖请用 setTiming`,
    );
  }
  return Object.freeze({ entries: Object.freeze([...registry.entries, descriptor]) });
}

/** 覆盖或新增（明确覆盖语义）。 */
export function setTiming(registry: TimingRegistry, descriptor: TimingDescriptor): TimingRegistry {
  const rest = registry.entries.filter((entry) => entry.target.slide_part_path !== descriptor.target.slide_part_path);
  return Object.freeze({ entries: Object.freeze([...rest, descriptor]) });
}

/**
 * **清除某页动画**（PPT-11 的"清除"）：换成空时序树描述符，条目仍在（表示"有块但无效果"）。
 *
 * @throws {TimingPartsError} 该页未登记。
 */
export function clearTiming(registry: TimingRegistry, slidePartPath: string): TimingRegistry {
  const existing = findTiming(registry, slidePartPath);
  if (existing === undefined) {
    throw new TimingPartsError('unknown_timing_entry', `幻灯片 ${slidePartPath} 没有可清除的时序条目`);
  }
  const cleared = buildTimingDescriptor(makeTimingTarget(slidePartPath, existing.target.slide_id), []);
  return setTiming(registry, cleared);
}

/** 移除某页条目（真正删掉，不再注入）。 */
export function removeTiming(registry: TimingRegistry, slidePartPath: string): TimingRegistry {
  const next = registry.entries.filter((entry) => entry.target.slide_part_path !== slidePartPath);
  if (next.length === registry.entries.length) {
    throw new TimingPartsError('unknown_timing_entry', `幻灯片 ${slidePartPath} 不在时序登记表里`);
  }
  return Object.freeze({ entries: Object.freeze(next) });
}

/** 全部清除：把每一条都换成空时序树（保留条目，表示"这些页有块但无效果"）。 */
export function clearAllTiming(registry: TimingRegistry): TimingRegistry {
  return Object.freeze({
    entries: Object.freeze(
      registry.entries.map((entry) =>
        buildTimingDescriptor(makeTimingTarget(entry.target.slide_part_path, entry.target.slide_id), []),
      ),
    ),
  });
}

/**
 * 校验登记表自洽：每条的 `xml` 必须是合法 `p:timing`，且 `effect_count` 与 XML 里
 * 效果条数一致（描述符数字不得与产物打架）。返回总效果数。
 *
 * 走 `parseTimingXml` 独立读回，**不**采信描述符自报的数字。
 */
export function validateTimingRegistry(
  registry: TimingRegistry,
  parseTimingXml: (xml: string) => readonly unknown[],
): number {
  let total = 0;
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    if (seen.has(entry.target.slide_part_path)) {
      throw new TimingPartsError('duplicate_timing_entry', `幻灯片 ${entry.target.slide_part_path} 在登记表里重复`);
    }
    seen.add(entry.target.slide_part_path);
    const parsed = parseTimingXml(entry.xml);
    if (parsed.length !== entry.effect_count) {
      throw new TimingPartsError(
        'invalid_timing_xml',
        `幻灯片 ${entry.target.slide_part_path} 描述符报 ${entry.effect_count} 个效果，读回为 ${parsed.length} 个`,
      );
    }
    total += parsed.length;
  }
  return total;
}

/** 空时序树的 XML（`clearTiming` 用的就是它）。 */
export function emptyTimingXml(): string {
  return renderTimingXmlLossless([]);
}
