/**
 * P08 · **时序块描述符**（`p:timing` descriptor）。
 *
 * ## `p:timing` 不是独立部件——它内联在幻灯片里
 *
 * 与 P06 的表格同理：`p:timing` **没有**自己的包内路径、**没有**内容类型、**没有**关系条目，
 * 它就地写在 `ppt/slides/slideN.xml` 的 `<p:sld>` 里（schema 里排在 `p:transition` 之后、
 * `p:extLst` 之前）。因此本层的"描述符"不是"新部件 + 新关系"，而是**一个页 × 一块时序**
 * 的绑定：告诉 P01 装配者"这一页的时序 XML 是什么、有几个效果"，由 P01 在写幻灯片部件时
 * 把它按 schema 位置注入（注入器见 `inject.ts`，本模块只造描述符）。
 *
 * 这样 P01 的装配路径不必自己拼时序 XML，也不必猜内联块的位置；而 `animation.ts` 仍是
 * **唯一**的时序 XML 生产者（描述符只是它的产物 + 目标页）。
 */

import { buildClickGroups, type AnimationSpec } from '../animation.js';

import { TimingPartsError } from './errors.js';
import { renderTimingXmlLossless } from './render.js';

/** 包内幻灯片部件路径的校验（POSIX、无 `..`、无前导 `/`）。 */
export function assertSlidePartPath(path: string): void {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TimingPartsError('invalid_slide_path', '幻灯片部件路径不能为空');
  }
  if (path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
    throw new TimingPartsError('invalid_slide_path', `幻灯片部件路径 ${path} 必须是 POSIX 包内相对路径`);
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TimingPartsError('invalid_slide_path', `幻灯片部件路径 ${path} 含非法段 "${segment}"`);
    }
  }
}

/** 时序块在幻灯片里的**目标**：哪一页。 */
export interface TimingTarget {
  readonly slide_part_path: string;
  readonly slide_id: number;
}

/** 一个时序块描述符：目标页 + 真实 `p:timing` XML + 计数。 */
export interface TimingDescriptor {
  readonly target: TimingTarget;
  /** `p:timing` 根元素文本（单根片段，可被 `parseXmlDocument` 回读）。 */
  readonly xml: string;
  readonly effect_count: number;
  readonly click_group_count: number;
  /** 无任何效果（清空后）恒 `true`；此时 `xml` 仍是结构合法的空时序树。 */
  readonly empty: boolean;
}

/** 造一个目标。`slide_id` 必须正整数。 */
export function makeTimingTarget(slidePartPath: string, slideId: number): TimingTarget {
  assertSlidePartPath(slidePartPath);
  if (!Number.isSafeInteger(slideId) || slideId <= 0) {
    throw new TimingPartsError('invalid_slide_path', `幻灯片 id 必须是正整数，收到 ${String(slideId)}`);
  }
  return Object.freeze({ slide_part_path: slidePartPath, slide_id: slideId });
}

/**
 * 由动画规格造**时序块描述符**：XML 走本层**无损写侧** `renderTimingXmlLossless`
 * （`appear` 写真实时长、`after_previous` 写组内绝对延迟由读侧反推相对），
 * 计数走 `buildClickGroups`（与写侧同一套分组口径），保证描述符里的数字与 XML 对得上。
 */
export function buildTimingDescriptor(target: TimingTarget, specs: readonly AnimationSpec[]): TimingDescriptor {
  assertSlidePartPath(target.slide_part_path);
  const xml = renderTimingXmlLossless(specs);
  return Object.freeze({
    target,
    xml,
    effect_count: specs.length,
    click_group_count: buildClickGroups(specs).length,
    empty: specs.length === 0,
  });
}

/** 便捷：由页路径 + id + 规格直接造描述符。 */
export function timingDescriptorFor(
  slidePartPath: string,
  slideId: number,
  specs: readonly AnimationSpec[],
): TimingDescriptor {
  return buildTimingDescriptor(makeTimingTarget(slidePartPath, slideId), specs);
}
