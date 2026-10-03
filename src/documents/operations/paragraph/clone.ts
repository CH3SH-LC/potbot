/**
 * 属性深拷贝。
 *
 * ## 为什么要深拷贝而不是浅拷贝
 *
 * 段落属性里有嵌套对象与数组：`indent` 四个槽位、`tabStops` 是数组、`borders` 是键值表、
 * `shading` 是对象。浅拷贝（`{...props}`）复制的只是**外层引用**——拆段后的两个段落会
 * 共享同一个 `indent` 对象与同一个 `tabStops` 数组。之后任何一处修改（本包全部操作都是
 * "返回新对象"的纯函数，但消费方可能不是）会同时改到两段。这类 bug 在测试里很难发现，
 * 因为正常路径下一切"看起来对"。
 *
 * ## 为什么用 `structuredClone`
 *
 * 模型里的属性值全部是纯数据（无函数、无类实例、无 `Map`/`Set`），正好落在
 * `structuredClone` 的能力范围内；它比手写 20 行逐字段拷贝更不容易漏字段——**漏字段**
 * 恰恰是手写拷贝最典型的失败模式（新增一个属性，clone 忘了加，于是拆段后新段落丢格式）。
 * 若将来模型引入了 `structuredClone` 不支持的值，这里会**抛错**而不是静默丢数据，
 * 属于安全失败。
 */

import type {
  BorderEdge,
  ParagraphProperties,
  RunProperties,
  Shading,
  TabStop,
} from '../../model/types.js';

/** 深拷贝段落属性。 */
export function cloneParagraphProperties(props: ParagraphProperties): ParagraphProperties {
  return structuredClone(props);
}

/** 深拷贝字符属性（拆段时需要复制被切开那一半 run 的属性）。 */
export function cloneRunProperties(props: RunProperties): RunProperties {
  return structuredClone(props);
}

/** 深拷贝边框定义。 */
export function cloneBorderEdge(edge: BorderEdge): BorderEdge {
  return structuredClone(edge);
}

/** 深拷贝底纹。 */
export function cloneShading(shading: Shading): Shading {
  return structuredClone(shading);
}

/** 深拷贝制表位。 */
export function cloneTabStop(tab: TabStop): TabStop {
  return structuredClone(tab);
}
