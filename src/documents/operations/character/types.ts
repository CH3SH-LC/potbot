/**
 * 字符格式操作的类型（WF-001–016；合同 R117–R121、R132–R136）。
 *
 * ## 为什么是"操作对象"而不是"函数一大堆"
 *
 * R133：操作要能以**确定性操作计划**表达并存储、可持久化、可复算。因此格式改动描述成
 * **可序列化的数据**（`CharacterFormatOperation`），执行器是纯函数。这样"把第二段的'天气'加粗"
 * 这条指令可以原样存进操作日志（R139），也能在幂等重试时逐字段复算（R137）。
 *
 * ## 三种动作对应三种语义（R117/R118/R121）
 *
 * | 动作 | 开关型属性结果 | 带值属性结果 |
 * |---|---|---|
 * | `setToggle(..., true/false)` | `on` / **`off`**（写 `w:val="false"`） | —— |
 * | `unsetValue(...)` | —— | 取该属性的**规范取消值**（下划线 `none`、位置 0pt…），没有规范值的（字号/字体）回落 `inherit` |
 * | `inherit(...)` | `inherit`（**删除**该元素，回落到样式级联） | 同左 |
 * | `toggle(...)` | 选区**全部 `on` ⇒ `off`；否则 ⇒ `on`**（R121 钉死） | —— |
 *
 * **关键区别**：`unsetValue('underline')` 产出的 `none` 与 `inherit('underline')` 产出的"删元素"
 * 是**两种不同字节**。取消加粗走的是 `setToggle('bold', false)` ⇒ `off`，**不是**删元素——
 * 删元素会让加粗回落到（可能加粗的）样式，语义完全不同。
 */

import type {
  ColorValue,
  CharacterSpacing,
  FontSet,
  FontSize,
  HighlightColor,
  Length,
  RunProperties,
  Shading,
  UnderlineStyle,
  VerticalAlign,
} from '../../model/types.js';

/** 开关型（四态，可 `off`）的字符属性。 */
export type TogglePropertyKey =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'doubleStrike'
  | 'caps'
  | 'smallCaps';

/** 带值型（三态）的字符属性。 */
export type ValuedPropertyKey =
  | 'underline'
  | 'vertAlign'
  | 'fonts'
  | 'size'
  | 'scale'
  | 'position'
  | 'color'
  | 'highlight'
  | 'shading'
  | 'spacing';

export type CharacterPropertyKey = TogglePropertyKey | ValuedPropertyKey;

/** 每个带值属性的值类型（`setValue` 的 `value` 按 `property` 精确对应）。 */
export interface ValuedPropertyValueMap {
  readonly underline: UnderlineStyle;
  readonly vertAlign: VerticalAlign;
  readonly fonts: FontSet;
  readonly size: FontSize;
  readonly scale: number;
  readonly position: Length;
  readonly color: ColorValue;
  readonly highlight: HighlightColor;
  readonly shading: Shading;
  readonly spacing: CharacterSpacing;
}

export const TOGGLE_PROPERTY_KEYS: readonly TogglePropertyKey[] = [
  'bold',
  'italic',
  'strike',
  'doubleStrike',
  'caps',
  'smallCaps',
];

export const VALUED_PROPERTY_KEYS: readonly ValuedPropertyKey[] = [
  'underline',
  'vertAlign',
  'fonts',
  'size',
  'scale',
  'position',
  'color',
  'highlight',
  'shading',
  'spacing',
];

export const CHARACTER_PROPERTY_KEYS: readonly CharacterPropertyKey[] = [
  ...TOGGLE_PROPERTY_KEYS,
  ...VALUED_PROPERTY_KEYS,
];

export function isTogglePropertyKey(key: CharacterPropertyKey): key is TogglePropertyKey {
  return (TOGGLE_PROPERTY_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/** `on` / `off` 显式设置（R118）。取消加粗**走这条**，不走"删元素"。 */
export interface SetToggleOperation {
  readonly kind: 'setToggle';
  readonly property: TogglePropertyKey;
  readonly value: boolean;
}

/** 开关翻转（R121 语义固定）。 */
export interface ToggleOperation {
  readonly kind: 'toggle';
  readonly property: TogglePropertyKey;
}

export type SetValueOperation = {
  readonly [K in ValuedPropertyKey]: {
    readonly kind: 'setValue';
    readonly property: K;
    readonly value: ValuedPropertyValueMap[K];
  };
}[ValuedPropertyKey];

/** 取消该属性的直接格式，取"规范取消值"（见 `CANONICAL_UNSET`）。 */
export interface UnsetValueOperation {
  readonly kind: 'unsetValue';
  readonly property: ValuedPropertyKey;
}

/** 删除该属性元素、回落到样式级联（R117 的 `inherit`）。 */
export interface InheritOperation {
  readonly kind: 'inherit';
  readonly property: CharacterPropertyKey;
}

/** 清除字符直接格式（WF-015；R120：只清 `rPr`，不删正文、不动段落属性）。 */
export interface ClearDirectFormatOperation {
  readonly kind: 'clearDirectFormat';
}

/** 格式刷（WF-016）：把来源 run 的直接字符格式整份复制到目标范围。 */
export interface FormatBrushOperation {
  readonly kind: 'formatBrush';
  readonly source: RunProperties;
}

/**
 * 增大 / 减小字号（WF-008），相对增减 `deltaPt` 磅。
 *
 * **只对已显式设定为 `pt` 的字号生效**：中文名字号 → pt 的映射表归
 * `src/documents/units/**`（R128/R129「转换集中一处」），本包**不复制**该表；
 * 需要相对调整中文名字号时由 `OperationContext.resolveFontSizePt` 注入换算。
 */
export interface AdjustFontSizeOperation {
  readonly kind: 'adjustFontSize';
  readonly deltaPt: number;
}

export type CharacterFormatOperation =
  | SetToggleOperation
  | ToggleOperation
  | SetValueOperation
  | UnsetValueOperation
  | InheritOperation
  | ClearDirectFormatOperation
  | FormatBrushOperation
  | AdjustFontSizeOperation;

// ---------------------------------------------------------------------------
// 构造器（调用方不手写字面量，避免各写各的）
// ---------------------------------------------------------------------------

export function setToggle(property: TogglePropertyKey, value: boolean): SetToggleOperation {
  return { kind: 'setToggle', property, value };
}

export function toggleProperty(property: TogglePropertyKey): ToggleOperation {
  return { kind: 'toggle', property };
}

export function setValue<K extends ValuedPropertyKey>(
  property: K,
  value: ValuedPropertyValueMap[K],
): SetValueOperation {
  // 单个受控断言：`property` 与 `value` 的对应关系已由签名保证，但联合分支的收窄
  // TypeScript 无法在对象字面量里自行完成。
  return { kind: 'setValue', property, value } as SetValueOperation;
}

export function unsetValue(property: ValuedPropertyKey): UnsetValueOperation {
  return { kind: 'unsetValue', property };
}

export function inherit(property: CharacterPropertyKey): InheritOperation {
  return { kind: 'inherit', property };
}

/** 清除字符直接格式（WF-015）。 */
export const CLEAR_DIRECT_FORMAT: ClearDirectFormatOperation = Object.freeze({ kind: 'clearDirectFormat' });

/** 格式刷（WF-016，字符格式侧）。 */
export function formatBrush(source: RunProperties): FormatBrushOperation {
  return { kind: 'formatBrush', source };
}

/** 增大 / 减小字号（WF-008）。 */
export function adjustFontSize(deltaPt: number): AdjustFontSizeOperation {
  return { kind: 'adjustFontSize', deltaPt };
}

/** WF 编号 → 操作的对照，便于能力账本与测试命名对齐。 */
export const WF_CHARACTER_OPERATION_MAP = Object.freeze({
  'WF-001': 'setToggle(bold) / toggle(bold)',
  'WF-002': 'setToggle(italic) / toggle(italic)',
  'WF-003': "setValue(underline) / unsetValue(underline) ⇒ 'none'",
  'WF-004': 'setToggle(strike) / setToggle(doubleStrike)',
  'WF-005': 'setValue(vertAlign)',
  'WF-006': 'setValue(fonts)',
  'WF-007': 'setValue(size)',
  'WF-008': 'adjustFontSize（见 adjust.ts）',
  'WF-009': 'setValue(color)',
  'WF-010': 'setValue(highlight)',
  'WF-011': 'setValue(shading)',
  'WF-012': 'setValue(spacing)',
  'WF-013': 'setValue(scale) / setValue(position)',
  'WF-014': 'setToggle(caps) / setToggle(smallCaps)',
  'WF-015': 'clearDirectFormat',
  'WF-016': 'formatBrush',
} as const);
