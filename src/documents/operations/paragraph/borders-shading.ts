/**
 * 段落边框与底纹（WF-033）。
 *
 * ## 段落底纹 ≠ 字符底纹 ≠ 高亮
 *
 * 三者是**三个不同属性**，分别落在 `pPr/w:shd`、`rPr/w:shd`、`rPr/w:highlight`：
 *
 * - 段落底纹铺满整段行宽（含空行尾），文字底纹只裹文字；
 * - 高亮是 Word 的"荧光笔"，只有固定十六色且**打印可选**，与底纹的任意 RGB 不是一回事。
 *
 * 因此本文件只写 `ParagraphProperties.shading`（段落底纹），**根本不接触** run 的
 * `shading` / `highlight`——字符那两样属 D03 的包。类型上就够不着，杜绝了"给段落加底纹
 * 顺手把文字也染了"。
 *
 * ## 边框是四边**分别**指定
 *
 * `borders` 是 `Partial<Record<'top'|'left'|'bottom'|'right', BorderEdge>>`：可以只加左边框。
 * "取消边框"分两级：`clearParagraphBorder(props, edge)` 取消一边；
 * `clearParagraphBorders(props)` 取消四边（落 `inherit`，写码层删除整个 `w:pBdr`）。
 */

import type { BorderEdge, ParagraphProperties, Shading } from '../../model/types.js';
import { cloneBorderEdge, cloneShading } from './clone.js';
import { VALUED_INHERIT, valuedSet } from './states.js';

/** 四边的稳定序列。 */
export type BorderEdgeName = 'top' | 'left' | 'bottom' | 'right';

/** 四边名称的稳定序列（供测试遍历断言）。 */
export const BORDER_EDGES: readonly BorderEdgeName[] = Object.freeze([
  'top',
  'left',
  'bottom',
  'right',
] as readonly BorderEdgeName[]);

type ParagraphBorders = Partial<Record<BorderEdgeName, BorderEdge>>;

function currentBorders(props: ParagraphProperties): ParagraphBorders {
  return props.borders.state === 'set' ? props.borders.value : {};
}

/** 设置**单边**段落边框（WF-033）。其余三边不变。 */
export function setParagraphBorder(
  props: ParagraphProperties,
  edge: BorderEdgeName,
  border: BorderEdge,
): ParagraphProperties {
  return {
    ...props,
    borders: valuedSet({ ...currentBorders(props), [edge]: cloneBorderEdge(border) }),
  };
}

/** 一次设置**多边**边框（传入的部分边覆盖，其余保持）。 */
export function setParagraphBorders(
  props: ParagraphProperties,
  borders: ParagraphBorders,
): ParagraphProperties {
  const merged: ParagraphBorders = { ...currentBorders(props) };
  for (const edge of BORDER_EDGES) {
    const edgeValue = borders[edge];
    if (edgeValue !== undefined) merged[edge] = cloneBorderEdge(edgeValue);
  }
  return { ...props, borders: valuedSet(merged) };
}

/**
 * 取消**单边**边框（WF-033）。
 *
 * 注意这里的取舍：取消一边后如果**其余三边还在**，落"去掉该边的 set"；
 * 若取消后**一边不剩**，落 `inherit`（写码层删除整个 `w:pBdr` 元素，而不是留一个空的）。
 * 这样"取消最后一边"会真的把边框元素从文档里清掉，不残留空壳。
 */
export function clearParagraphBorder(props: ParagraphProperties, edge: BorderEdgeName): ParagraphProperties {
  const merged = currentBorders(props);
  delete merged[edge];
  if (Object.keys(merged).length === 0) {
    return { ...props, borders: VALUED_INHERIT };
  }
  return { ...props, borders: valuedSet(merged) };
}

/** 取消**四边**边框（WF-033）。 */
export function clearParagraphBorders(props: ParagraphProperties): ParagraphProperties {
  return { ...props, borders: VALUED_INHERIT };
}

/** 设置段落底纹（WF-033）。与字符底纹、高亮无关。 */
export function setParagraphShading(props: ParagraphProperties, shading: Shading): ParagraphProperties {
  return { ...props, shading: valuedSet(cloneShading(shading)) };
}

/** 取消段落底纹（WF-033）。 */
export function clearParagraphShading(props: ParagraphProperties): ParagraphProperties {
  return { ...props, shading: VALUED_INHERIT };
}

/** 便捷构造边框定义。`size` 为线宽长度（转换由 `units` 负责）。 */
export function borderEdge(style: string, size: BorderEdge['size'], color_hex: string | null = 'auto'): BorderEdge {
  return { style, size, color_hex };
}
