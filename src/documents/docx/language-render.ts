/**
 * **校对语言范围 → run 切分**（design-05-P9 / WF-096 的导出接线）。
 *
 * ## 为什么语言不能挂在 `RunProperties` 上
 *
 * `w:lang` 是 run 属性，但模型冻结骨架的 `RunProperties` **没有** `lang` 字段——它属"校对
 * 语言"，与字体 / 字号那一组不是一类（`proofing/language.ts` 的头部把这条缺口写清楚了）。
 * 因此语言只能由调用方按**范围**（`node_id + 码位起止`，R102 的定位单位）给到导出器，
 * 由导出器在写 `w:rPr` 时补一个 `w:lang`。
 *
 * ## 为什么必须切 run，而不是"整段一个语言"
 *
 * WF-096 的设置单位是**选区**。选区可以只覆盖一个 run 的中间几个字（"把这一句里的英文词
 * 标成 en-US"）。若只在**整 run 范围内**套语言，那种选区就会**静默变成整段**——
 * 那是"看起来做了、其实扩大了范围"，与 R116/R136 的取向相反。所以本模块按语言边界把 run
 * **切开**，每个子段各带自己的语言，**没被覆盖的子段不带 `w:lang`**。
 *
 * ## 未建模片段必须跟着走
 *
 * run 里可能有 `raw_at_char` 的未建模片段（导入保留的 `w:drawing` 等）。切 run 时这些片段的
 * 字符锚点要**跟着平移**到它所属的子段，否则"设个语言"会把图形挪位置甚至丢掉——R105 的
 * 逐字节保留会当场破功。`shiftRawFragments` 就是干这件事的。
 */

import type { RunNode } from '../model/types.js';
import { layoutItems } from './layout.js';

/**
 * 一个 run 要写的 `w:lang` 三槽位（OOXML `CT_Lang`）。
 *
 * - `val` ⇒ `w:lang@w:val`（**必写**，西文/界面语言）；
 * - `east_asia` ⇒ `w:lang@w:eastAsia`（**东亚文字**的校对语言）——省略/`null` = 不写该属性；
 * - `bidi` ⇒ `w:lang@w:bidi`（复杂文种）——省略/`null` = 不写该属性。
 *
 * **为什么三个槽位分开**：`CT_Lang` 本来就是三个独立属性。中文文档里常见
 * "西文用 en-US、中文用 zh-CN"——只写 `@w:val` 表达不了这层区分，Word 自己会两个都写。
 * 省略可选槽位时**不写那个属性**，因此"不设 eastAsia"的旧调用产出与从前**逐字节相同**（R151）。
 */
export interface RunLanguage {
  readonly val: string;
  readonly east_asia?: string | null;
  readonly bidi?: string | null;
}

/** 一段语言范围（码位，止偏移开区间——与 `DocumentRange` 同一口径）。 */
export interface LanguageRange {
  readonly start: number;
  readonly end: number;
  readonly tag: string;
  /** `w:lang@w:eastAsia`；省略/`null` = 不写。 */
  readonly east_asia?: string | null;
  /** `w:lang@w:bidi`；省略/`null` = 不写。 */
  readonly bidi?: string | null;
}

/** run 按语言边界切开后的一个子段。`tag === null` = 这一段没被任何语言范围覆盖。 */
export interface RunSegment {
  readonly from: number;
  readonly to: number;
  readonly tag: RunLanguage | null;
}

/** 一个未建模片段在**子段坐标系**里的位置（原 offset 减去子段起点）。 */
export interface ShiftedRawFragment {
  readonly kind: 'raw_at_char';
  readonly xml: string;
  readonly offset: number;
}

/**
 * `[from, to)` 是否整段落在某个语言范围里；是则给出该范围的标签。
 *
 * 多个范围重叠时取**数组里第一个**匹配（确定性；重叠本身是调用方给输入时该避免的，
 * 但导出器不因此中断——取第一个至少是"可复现"的，不会随遍历顺序漂移）。
 */
export function languageAt(
  ranges: readonly LanguageRange[],
  from: number,
  to: number,
): RunLanguage | null {
  for (const range of ranges) {
    if (range.start <= from && to <= range.end) {
      // 可选槽位**归一成 `null`**（不是 `undefined`）：写出侧据此决定"写不写这个属性"，
      // 两种"没给"在字节上必须同义，否则同一份输入会因写法不同产出不同字节。
      return { val: range.tag, east_asia: range.east_asia ?? null, bidi: range.bidi ?? null };
    }
  }
  return null;
}

/**
 * 把一个 run 的 `[0, length)` 按语言边界切成子段。
 *
 * `base` 是 run 起点在**段落码位坐标**里的位置（语言范围用的是段落坐标）。
 * 没有语言范围 ⇒ 单个子段 `[0, length)`、`tag` 为 `null`（调用方据此走未经切分的原路径）。
 */
export function segmentRunByLanguage(
  length: number,
  base: number,
  ranges: readonly LanguageRange[],
): readonly RunSegment[] {
  const cuts = new Set<number>([0, length]);
  for (const range of ranges) {
    for (const boundary of [range.start - base, range.end - base]) {
      if (boundary > 0 && boundary < length) cuts.add(boundary);
    }
  }
  const sorted = [...cuts].sort((left, right) => left - right);
  const segments: RunSegment[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const from = sorted[index] as number;
    const to = sorted[index + 1] as number;
    segments.push({ from, to, tag: languageAt(ranges, base + from, base + to) });
  }
  return segments;
}

/**
 * 取某个子段里的未建模片段，并把字符锚点平移到子段坐标系。
 *
 * `isLast` 为真时也收 `offset >= to` 的片段——它们原本排在 run 文本**之后**
 * （`serializeRun` 收尾时用 `drainRaws(Number.MAX_SAFE_INTEGER)` 写出去），切分后必须
 * 跟着**最后一段**走，否则会被静默丢掉。
 */
export function shiftRawFragments(
  run: RunNode,
  from: number,
  to: number,
  isLast: boolean,
): readonly ShiftedRawFragment[] {
  const out: ShiftedRawFragment[] = [];
  for (const item of layoutItems(run, 'raw_at_char')) {
    if (item.offset < from) continue;
    if (!isLast && item.offset >= to) continue;
    out.push({ kind: 'raw_at_char', xml: item.xml, offset: item.offset - from });
  }
  return out;
}
