/**
 * 段落直接格式的**写意图读回**（R117–R120/R122 的段落侧出口）。
 *
 * ## 为什么需要这一层
 *
 * `model/attributes.ts` 已把"四态 → 写意图"固化成 `toggleWriteIntent` / `valuedWriteIntent`：
 *
 * | 模型状态 | 写意图 |
 * |---|---|
 * | `unspecified` | `omit`（不写元素） |
 * | `set` / `on` | `write_value` / `write_true` |
 * | `off` | `write_false`（`<… w:val="false"/>`） |
 * | `inherit` | `remove`（**删除**已存在的该元素 = 清除直接格式） |
 *
 * 但那两个函数一次只看**一个**属性。段落有 16 个字段，`ParagraphProperties` 又是嵌套的
 * （`indent` 四个槽位）。于是"这一段清除格式后，写码层到底会删哪些元素？"必须在
 * 上层手动展开——展开过程一旦漏了某个字段（或把 `indent.hanging` 当成不存在的属性），
 * "清除没生效"这类缺陷就会在**没有测试覆盖的字段**上潜伏。
 *
 * 本模块把这个展开做成**唯一、完备**的路径：`paragraphWriteIntents` 遍历全部字段，
 * 逐字段给出 `state` 与 `intent`。它不重新定义任何语义（`state`/`intent` 都来自
 * `model/attributes.ts`），只负责"一个字段都不漏地摊平"。
 *
 * ## 验收用途
 *
 * WF-032/WF-034 的判据"显式关闭/清除格式不被继承覆盖"在**写**侧的形态是：
 * 清除（`clear*` / `unset*`）必须产出 `remove`，显式关必须产出 `write_false`，
 * 未指定必须产出 `omit`——三者**必须互不冒充**（R118）。本模块让这条判据可以逐字段断言，
 * 而不是只看某一个字段。
 *
 * 注意：本模块只描述**直接格式**（`pPr`）的写意图；命名样式链的写意图另论（样式部件
 * 是整表重写，不做逐元素删除）。这不影响"某一段的直接格式清除是否表达为删除"这条判据。
 */

import type { ParagraphProperties, ToggleState, ValuedState } from '../../model/types.js';
import {
  attributeStateKind,
  toggleWriteIntent,
  valuedWriteIntent,
  type AttributeStateKind,
  type ToggleWriteIntent,
  type ValuedWriteIntent,
} from '../../model/attributes.js';

/** 段落直接格式里一个属性槽位的稳定路径名（与 OOXML 一一对应，供逐字段断言/展示）。 */
export type ParagraphWriteIntentField =
  | 'alignment'
  | 'lineSpacing'
  | 'spacingBefore'
  | 'spacingAfter'
  | 'indent.left'
  | 'indent.right'
  | 'indent.firstLine'
  | 'indent.hanging'
  | 'tabStops'
  | 'pageBreakBefore'
  | 'keepNext'
  | 'keepLines'
  | 'widowControl'
  | 'borders'
  | 'shading'
  | 'outlineLevel';

/** 一个槽位的写意图读回。 */
export interface ParagraphFieldWriteIntent {
  readonly field: ParagraphWriteIntentField;
  /** R117 五态归类（`unspecified` / `set` / `off` / `inherit`；段落直接格式不会出现 `mixed`）。 */
  readonly state: AttributeStateKind;
  /** OOXML 写动作：`omit` / `write_value` / `write_true` / `write_false` / `remove`。 */
  readonly intent: ToggleWriteIntent | ValuedWriteIntent;
}

/** 16 个字段的稳定遍历顺序（测试与展示都按它走，避免顺序漂移）。 */
export const PARAGRAPH_WRITE_INTENT_FIELDS: readonly ParagraphWriteIntentField[] = Object.freeze([
  'alignment',
  'lineSpacing',
  'spacingBefore',
  'spacingAfter',
  'indent.left',
  'indent.right',
  'indent.firstLine',
  'indent.hanging',
  'tabStops',
  'pageBreakBefore',
  'keepNext',
  'keepLines',
  'widowControl',
  'borders',
  'shading',
  'outlineLevel',
] as readonly ParagraphWriteIntentField[]);

function intentOfValued<T>(state: ValuedState<T>): ParagraphFieldWriteIntent['intent'] {
  return valuedWriteIntent(state);
}

function intentOfToggle(state: ToggleState): ParagraphFieldWriteIntent['intent'] {
  return toggleWriteIntent(state);
}

/**
 * 把一个段落的直接格式摊成**逐字段写意图**（顺序 = `PARAGRAPH_WRITE_INTENT_FIELDS`）。
 *
 * 纯投影，不修改输入。返回数组长度恒为 16。
 */
export function paragraphWriteIntents(
  properties: ParagraphProperties,
): readonly ParagraphFieldWriteIntent[] {
  return [
    { field: 'alignment', state: attributeStateKind(properties.alignment), intent: intentOfValued(properties.alignment) },
    { field: 'lineSpacing', state: attributeStateKind(properties.lineSpacing), intent: intentOfValued(properties.lineSpacing) },
    { field: 'spacingBefore', state: attributeStateKind(properties.spacingBefore), intent: intentOfValued(properties.spacingBefore) },
    { field: 'spacingAfter', state: attributeStateKind(properties.spacingAfter), intent: intentOfValued(properties.spacingAfter) },
    { field: 'indent.left', state: attributeStateKind(properties.indent.left), intent: intentOfValued(properties.indent.left) },
    { field: 'indent.right', state: attributeStateKind(properties.indent.right), intent: intentOfValued(properties.indent.right) },
    { field: 'indent.firstLine', state: attributeStateKind(properties.indent.firstLine), intent: intentOfValued(properties.indent.firstLine) },
    { field: 'indent.hanging', state: attributeStateKind(properties.indent.hanging), intent: intentOfValued(properties.indent.hanging) },
    { field: 'tabStops', state: attributeStateKind(properties.tabStops), intent: intentOfValued(properties.tabStops) },
    { field: 'pageBreakBefore', state: attributeStateKind(properties.pageBreakBefore), intent: intentOfToggle(properties.pageBreakBefore) },
    { field: 'keepNext', state: attributeStateKind(properties.keepNext), intent: intentOfToggle(properties.keepNext) },
    { field: 'keepLines', state: attributeStateKind(properties.keepLines), intent: intentOfToggle(properties.keepLines) },
    { field: 'widowControl', state: attributeStateKind(properties.widowControl), intent: intentOfToggle(properties.widowControl) },
    { field: 'borders', state: attributeStateKind(properties.borders), intent: intentOfValued(properties.borders) },
    { field: 'shading', state: attributeStateKind(properties.shading), intent: intentOfValued(properties.shading) },
    { field: 'outlineLevel', state: attributeStateKind(properties.outlineLevel), intent: intentOfValued(properties.outlineLevel) },
  ];
}

/** 便捷索引：字段路径 → 该字段的写意图。 */
export function paragraphWriteIntentMap(
  properties: ParagraphProperties,
): ReadonlyMap<ParagraphWriteIntentField, ParagraphFieldWriteIntent['intent']> {
  const map = new Map<ParagraphWriteIntentField, ParagraphFieldWriteIntent['intent']>();
  for (const entry of paragraphWriteIntents(properties)) {
    map.set(entry.field, entry.intent);
  }
  return map;
}

/** 取单个字段的写意图；字段名未知时抛（不猜）。 */
export function writeIntentOfField(
  properties: ParagraphProperties,
  field: ParagraphWriteIntentField,
): ParagraphFieldWriteIntent['intent'] {
  const found = paragraphWriteIntents(properties).find((entry) => entry.field === field);
  if (found === undefined) {
    throw new Error(`未知的段落写意图字段：${JSON.stringify(field)}`);
  }
  return found.intent;
}

/** 该段落的直接格式里，**哪些字段会被删除元素**（写意图 = `remove`）。 */
export function removedFields(properties: ParagraphProperties): readonly ParagraphWriteIntentField[] {
  return paragraphWriteIntents(properties)
    .filter((entry) => entry.intent === 'remove')
    .map((entry) => entry.field);
}

/** 该段落的直接格式里，**哪些字段会被显式写出值**（`write_*` 三种之一）。 */
export function writtenFields(properties: ParagraphProperties): readonly ParagraphWriteIntentField[] {
  return paragraphWriteIntents(properties)
    .filter((entry) => entry.intent !== 'omit' && entry.intent !== 'remove')
    .map((entry) => entry.field);
}
