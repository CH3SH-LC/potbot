/**
 * 字符（run）属性的级联解析（R122/R124 的字符侧补齐，服务 WF-037/038）。
 *
 * ## 为什么 D04 的 `cascade.ts` 之外还需要这一个
 *
 * `cascade.ts` 解析的是**段落**属性。但"命名样式"最常见的用法之一是**字符样式**
 * （"强调"、"引用"、"代码"），它们只带 `rPr`。若没有字符级联，WF-037 的"改一个命名样式
 * 后所有引用它的段落读回都变"就只能对段落属性成立，一跳进字符样式就断了——
 * 于是"改'强调'样式的颜色"到底影响哪些文字，谁也答不上来。
 *
 * ## 与 `cascade.ts` 的关系：**同构**，不是第二套规则
 *
 * 层的概念、顺序、`PropertyOrigin` 的语义、`unspecified` 与 `inherit` 的等价性
 * 全部沿用 `cascade.ts`（这里直接复用它的 `ResolvedValue` / `PropertyOrigin` 类型与
 * `PropertyOrigin` 构造口径）。差别只有一个：字段清单是 run 的。
 * `basedOn` 链解析同样复用 `chain.ts` 的 `resolveStyleChain`，因此**成环/坏引用
 * 依然是有限终止**（R123），不存在"字符样式这一侧没有防环"的缺口。
 *
 * ## 与 `RunProperties` 一一对应
 *
 * 输入是段落文本的"有效字符格式"的来源集合：文档默认**字符**样式（`is_default` 且
 * `type='character'`，可能不存在）→ 段落引用的字符样式链 → run 的直接格式。
 * 文档默认**段落**样式里的 `rPr` 不在这里重复处理——它由段落级联决定"这一段的基准字符格式"，
 * 两者是不同来源，合并口径见 `explain.ts` 的注释。
 */

import type {
  RunProperties,
  StyleDefinition,
  StyleTable,
  ToggleState,
  ValuedState,
  ColorValue,
  FontSet,
  FontSize,
  HighlightColor,
  Length,
  Shading,
  UnderlineStyle,
  VerticalAlign,
  CharacterSpacing,
} from '../model/types.js';
import { findDefaultStyle, resolveStyleChain, type StyleProblem } from './chain.js';
import type { AppliedStyle, PropertyOrigin, ResolvedValue } from './cascade.js';

/** 逐属性解析结果（字符侧）。每个字段都带来源层（R124）。 */
export interface ResolvedRunProperties {
  readonly bold: ResolvedValue<boolean>;
  readonly italic: ResolvedValue<boolean>;
  readonly underline: ResolvedValue<UnderlineStyle>;
  readonly strike: ResolvedValue<boolean>;
  readonly doubleStrike: ResolvedValue<boolean>;
  readonly vertAlign: ResolvedValue<VerticalAlign>;
  readonly fonts: ResolvedValue<FontSet>;
  readonly size: ResolvedValue<FontSize>;
  readonly scale: ResolvedValue<number>;
  readonly position: ResolvedValue<Length>;
  readonly color: ResolvedValue<ColorValue>;
  readonly highlight: ResolvedValue<HighlightColor>;
  readonly shading: ResolvedValue<Shading>;
  readonly spacing: ResolvedValue<CharacterSpacing>;
  readonly caps: ResolvedValue<boolean>;
  readonly smallCaps: ResolvedValue<boolean>;
}

export interface RunCascadeInput {
  readonly styles: StyleTable;
  /** 段落引用的命名**字符**样式；`null` = 无。 */
  readonly style_ref: string | null;
  /** run 的直接格式；`null` = 无。 */
  readonly direct: Partial<RunProperties> | null;
}

export interface RunCascadeResult {
  readonly status: 'ok' | 'conflict';
  readonly problems: readonly StyleProblem[];
  readonly applied_chain: readonly AppliedStyle[];
  readonly properties: ResolvedRunProperties;
}

const UNSET: ResolvedValue<never> = Object.freeze({ specified: false, value: null, origin: null } as const);

function applyValued<T>(
  slot: ResolvedValue<T>,
  incoming: ValuedState<T> | undefined,
  origin: PropertyOrigin,
): ResolvedValue<T> {
  if (incoming === undefined || incoming.state !== 'set') {
    return slot;
  }
  return { specified: true, value: incoming.value, origin };
}

function applyToggle(
  slot: ResolvedValue<boolean>,
  incoming: ToggleState | undefined,
  origin: PropertyOrigin,
): ResolvedValue<boolean> {
  if (incoming === undefined) {
    return slot;
  }
  if (incoming.state === 'on') {
    return { specified: true, value: true, origin };
  }
  if (incoming.state === 'off') {
    return { specified: true, value: false, origin };
  }
  return slot;
}

interface MutableResolved {
  bold: ResolvedValue<boolean>;
  italic: ResolvedValue<boolean>;
  underline: ResolvedValue<UnderlineStyle>;
  strike: ResolvedValue<boolean>;
  doubleStrike: ResolvedValue<boolean>;
  vertAlign: ResolvedValue<VerticalAlign>;
  fonts: ResolvedValue<FontSet>;
  size: ResolvedValue<FontSize>;
  scale: ResolvedValue<number>;
  position: ResolvedValue<Length>;
  color: ResolvedValue<ColorValue>;
  highlight: ResolvedValue<HighlightColor>;
  shading: ResolvedValue<Shading>;
  spacing: ResolvedValue<CharacterSpacing>;
  caps: ResolvedValue<boolean>;
  smallCaps: ResolvedValue<boolean>;
}

function emptyResolved(): MutableResolved {
  return {
    bold: UNSET,
    italic: UNSET,
    underline: UNSET,
    strike: UNSET,
    doubleStrike: UNSET,
    vertAlign: UNSET,
    fonts: UNSET,
    size: UNSET,
    scale: UNSET,
    position: UNSET,
    color: UNSET,
    highlight: UNSET,
    shading: UNSET,
    spacing: UNSET,
    caps: UNSET,
    smallCaps: UNSET,
  };
}

function applyLayer(slot: MutableResolved, layer: Partial<RunProperties>, origin: PropertyOrigin): void {
  slot.bold = applyToggle(slot.bold, layer.bold, origin);
  slot.italic = applyToggle(slot.italic, layer.italic, origin);
  slot.strike = applyToggle(slot.strike, layer.strike, origin);
  slot.doubleStrike = applyToggle(slot.doubleStrike, layer.doubleStrike, origin);
  slot.caps = applyToggle(slot.caps, layer.caps, origin);
  slot.smallCaps = applyToggle(slot.smallCaps, layer.smallCaps, origin);
  slot.underline = applyValued(slot.underline, layer.underline, origin);
  slot.vertAlign = applyValued(slot.vertAlign, layer.vertAlign, origin);
  slot.fonts = applyValued(slot.fonts, layer.fonts, origin);
  slot.size = applyValued(slot.size, layer.size, origin);
  slot.scale = applyValued(slot.scale, layer.scale, origin);
  slot.position = applyValued(slot.position, layer.position, origin);
  slot.color = applyValued(slot.color, layer.color, origin);
  slot.highlight = applyValued(slot.highlight, layer.highlight, origin);
  slot.shading = applyValued(slot.shading, layer.shading, origin);
  slot.spacing = applyValued(slot.spacing, layer.spacing, origin);
}

function cloneIfObject<T>(slot: ResolvedValue<T>): ResolvedValue<T> {
  if (!slot.specified) {
    return slot;
  }
  if (typeof slot.value === 'object' && slot.value !== null) {
    return { specified: true, value: structuredClone(slot.value), origin: slot.origin };
  }
  return slot;
}

function materialize(slot: MutableResolved): ResolvedRunProperties {
  return {
    bold: slot.bold,
    italic: slot.italic,
    underline: slot.underline,
    strike: slot.strike,
    doubleStrike: slot.doubleStrike,
    vertAlign: slot.vertAlign,
    fonts: cloneIfObject(slot.fonts),
    size: slot.size,
    scale: slot.scale,
    position: cloneIfObject(slot.position),
    color: slot.color,
    highlight: slot.highlight,
    shading: cloneIfObject(slot.shading),
    spacing: cloneIfObject(slot.spacing),
    caps: slot.caps,
    smallCaps: slot.smallCaps,
  };
}

function originForStyle(style: StyleDefinition, layer: 'document_default' | 'named_style'): PropertyOrigin {
  return { layer, style_id: style.style_id, style_name: style.name };
}

const DIRECT_ORIGIN: PropertyOrigin = Object.freeze({ layer: 'direct', style_id: null, style_name: null });

/**
 * 解析 run 的有效字符属性（R122/R124）。
 *
 * 顺序：文档默认**字符**样式链 → 引用的字符样式链 → 直接格式。后层覆盖前层。
 * 链出问题时不抛异常：记进 `problems`、`status` 置 `conflict`，并**继续用已解析出的部分**完成级联
 * （与 `cascade.ts` 同一取向：一个坏样式不该让整次编辑失败）。
 */
export function resolveRunCascade(input: RunCascadeInput): RunCascadeResult {
  const slot = emptyResolved();
  const problems: StyleProblem[] = [];
  const applied: AppliedStyle[] = [];

  const applyChain = (startStyleId: string, role: 'document_default' | 'named_style'): void => {
    const result = resolveStyleChain(input.styles, startStyleId);
    if (!result.ok) {
      problems.push(result.problem);
    }
    for (const style of result.chain) {
      applyLayer(slot, style.run_properties, originForStyle(style, role));
      applied.push({ style_id: style.style_id, name: style.name, role });
    }
  };

  const defaultStyle = findDefaultStyle(input.styles, 'character');
  if (defaultStyle !== null) {
    applyChain(defaultStyle.style_id, 'document_default');
  }
  if (input.style_ref !== null) {
    applyChain(input.style_ref, 'named_style');
  }
  if (input.direct !== null) {
    applyLayer(slot, input.direct, DIRECT_ORIGIN);
  }

  return {
    status: problems.length === 0 ? 'ok' : 'conflict',
    problems,
    applied_chain: applied,
    properties: materialize(slot),
  };
}
