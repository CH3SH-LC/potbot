/**
 * 样式级联解析（R122/R124，配合 R123/R125）。
 *
 * ## 解析顺序（R122）
 *
 * ```
 * 文档默认  →  命名样式（含 basedOn 继承链，根在前）  →  直接格式
 * ```
 *
 * 后层覆盖前层。编号 / 表格上下文的**内容**属其他波次，本文件在层结构上为它留了位置
 * （见 `CascadeInput` 注释），但本批不实现。
 *
 * ## 读回必须标来源层（R124）
 *
 * 这是本文件存在的主要理由。Word 的"有效格式"是算出来的，用户看到"这段是宋体小四"时，
 * 这个结论**可能来自三种完全不同的地方**：文档默认、某个命名样式、或用户手点的一次直接格式。
 * 三者对"改样式会不会影响这一段"的回答完全不同：
 *
 * - 来自命名样式 ⇒ 改那个样式，这段会**跟着变**（R126）；
 * - 来自直接格式 ⇒ 改样式**不会**动这段（直接格式压住它）。
 *
 * 所以每个属性都带一个 `origin`。这**不是**调试信息，是让上层能正确回答
 * "为什么我改了样式这一段没变"的依据。R124 明确要求标出来源层，本实现把它做成返回值的
 * **结构性组成部分**，而不是旁注。
 *
 * ## `unspecified` 与 `inherit` 在解析里等价
 *
 * 两者都**不贡献**值：前者意为"本层不表达"，后者意为"删掉本层的覆盖、继续往下继承"。
 * 结果都是"这一层不改变下层结论"。二者的差别在**写码**（一个不写元素、一个删元素），
 * 不在解析。
 */

import type {
  Alignment,
  BorderEdge,
  IndentAmount,
  LineSpacing,
  ParagraphProperties,
  ParagraphSpacing,
  Shading,
  StyleDefinition,
  StyleTable,
  TabStop,
  ToggleState,
  ValuedState,
} from '../model/types.js';
import { findDefaultStyle, resolveStyleChain } from './chain.js';
import type { StyleProblem } from './chain.js';

/** 属性来源层（R124）。 */
export type OriginLayer = 'document_default' | 'named_style' | 'direct';

/** 单个属性的来源。`direct` 层的 `style_id` / `style_name` 为 `null`。 */
export interface PropertyOrigin {
  readonly layer: OriginLayer;
  /** 命名样式层的样式 id；文档默认与直接格式层为 `null`。 */
  readonly style_id: string | null;
  /** 命名样式层的样式名；文档默认与直接格式层为 `null`。 */
  readonly style_name: string | null;
}

/**
 * 一个**已解析的属性值**。
 *
 * `specified: false` 表示**所有层都没设**这个属性——注意这与"设成了 `null`"不同：
 * `outlineLevel` 可以合法地被"设成 `null`"（显式声明为正文），此时
 * `specified: true, value: null`。
 */
export type ResolvedValue<T> =
  | { readonly specified: false; readonly value: null; readonly origin: null }
  | { readonly specified: true; readonly value: T; readonly origin: PropertyOrigin };

const UNSET: { readonly specified: false; readonly value: null; readonly origin: null } = Object.freeze({
  specified: false,
  value: null,
  origin: null,
} as const);

/** 段落边框集合（四边可选）。 */
export type ParagraphBorders = Partial<Record<'top' | 'left' | 'bottom' | 'right', BorderEdge>>;

/** 逐属性解析结果——每个字段都带来源层。 */
export interface ResolvedParagraphProperties {
  readonly alignment: ResolvedValue<Alignment>;
  readonly lineSpacing: ResolvedValue<LineSpacing>;
  readonly spacingBefore: ResolvedValue<ParagraphSpacing>;
  readonly spacingAfter: ResolvedValue<ParagraphSpacing>;
  readonly indent: {
    readonly left: ResolvedValue<IndentAmount>;
    readonly right: ResolvedValue<IndentAmount>;
    readonly firstLine: ResolvedValue<IndentAmount>;
    readonly hanging: ResolvedValue<IndentAmount>;
  };
  readonly tabStops: ResolvedValue<readonly TabStop[]>;
  readonly pageBreakBefore: ResolvedValue<boolean>;
  readonly keepNext: ResolvedValue<boolean>;
  readonly keepLines: ResolvedValue<boolean>;
  readonly widowControl: ResolvedValue<boolean>;
  readonly borders: ResolvedValue<ParagraphBorders>;
  readonly shading: ResolvedValue<Shading>;
  readonly outlineLevel: ResolvedValue<number | null>;
}

/** 已经参与解析的一个样式（按应用顺序，根在前）。 */
export interface AppliedStyle {
  readonly style_id: string;
  readonly name: string;
  readonly role: 'document_default' | 'named_style';
}

/** 级联输入。 */
export interface CascadeInput {
  readonly styles: StyleTable;
  /** 段落的命名样式引用；`null` = 无命名样式。 */
  readonly style_ref: string | null;
  /** 直接格式；`null` = 无直接格式。 */
  readonly direct: ParagraphProperties | null;
}

/** 级联结果。 */
export interface ParagraphCascadeResult {
  readonly status: 'ok' | 'conflict';
  readonly problems: readonly StyleProblem[];
  readonly applied_chain: readonly AppliedStyle[];
  readonly properties: ResolvedParagraphProperties;
}

// --- 逐字段合并 -------------------------------------------------------------

function applyValued<T>(
  slot: ResolvedValue<T>,
  incoming: ValuedState<T> | undefined,
  origin: PropertyOrigin,
): ResolvedValue<T> {
  if (incoming === undefined || incoming.state !== 'set') return slot;
  return { specified: true, value: incoming.value, origin };
}

function applyToggle(
  slot: ResolvedValue<boolean>,
  incoming: ToggleState | undefined,
  origin: PropertyOrigin,
): ResolvedValue<boolean> {
  if (incoming === undefined) return slot;
  if (incoming.state === 'on') return { specified: true, value: true, origin };
  if (incoming.state === 'off') return { specified: true, value: false, origin };
  return slot;
}

interface MutableResolved {
  alignment: ResolvedValue<Alignment>;
  lineSpacing: ResolvedValue<LineSpacing>;
  spacingBefore: ResolvedValue<ParagraphSpacing>;
  spacingAfter: ResolvedValue<ParagraphSpacing>;
  indentLeft: ResolvedValue<IndentAmount>;
  indentRight: ResolvedValue<IndentAmount>;
  indentFirstLine: ResolvedValue<IndentAmount>;
  indentHanging: ResolvedValue<IndentAmount>;
  tabStops: ResolvedValue<readonly TabStop[]>;
  pageBreakBefore: ResolvedValue<boolean>;
  keepNext: ResolvedValue<boolean>;
  keepLines: ResolvedValue<boolean>;
  widowControl: ResolvedValue<boolean>;
  borders: ResolvedValue<ParagraphBorders>;
  shading: ResolvedValue<Shading>;
  outlineLevel: ResolvedValue<number | null>;
}

function emptyResolved(): MutableResolved {
  return {
    alignment: UNSET,
    lineSpacing: UNSET,
    spacingBefore: UNSET,
    spacingAfter: UNSET,
    indentLeft: UNSET,
    indentRight: UNSET,
    indentFirstLine: UNSET,
    indentHanging: UNSET,
    tabStops: UNSET,
    pageBreakBefore: UNSET,
    keepNext: UNSET,
    keepLines: UNSET,
    widowControl: UNSET,
    borders: UNSET,
    shading: UNSET,
    outlineLevel: UNSET,
  };
}

/** 应用一层的段落属性（可以是命名样式的 `Partial`，也可以是完整的直接格式）。 */
function applyLayer(
  slot: MutableResolved,
  layer: Partial<ParagraphProperties>,
  origin: PropertyOrigin,
): void {
  slot.alignment = applyValued(slot.alignment, layer.alignment, origin);
  slot.lineSpacing = applyValued(slot.lineSpacing, layer.lineSpacing, origin);
  slot.spacingBefore = applyValued(slot.spacingBefore, layer.spacingBefore, origin);
  slot.spacingAfter = applyValued(slot.spacingAfter, layer.spacingAfter, origin);
  slot.tabStops = applyValued(slot.tabStops, layer.tabStops, origin);
  slot.pageBreakBefore = applyToggle(slot.pageBreakBefore, layer.pageBreakBefore, origin);
  slot.keepNext = applyToggle(slot.keepNext, layer.keepNext, origin);
  slot.keepLines = applyToggle(slot.keepLines, layer.keepLines, origin);
  slot.widowControl = applyToggle(slot.widowControl, layer.widowControl, origin);
  slot.borders = applyValued(slot.borders, layer.borders, origin);
  slot.shading = applyValued(slot.shading, layer.shading, origin);
  slot.outlineLevel = applyValued(slot.outlineLevel, layer.outlineLevel, origin);
  if (layer.indent !== undefined) {
    slot.indentLeft = applyValued(slot.indentLeft, layer.indent.left, origin);
    slot.indentRight = applyValued(slot.indentRight, layer.indent.right, origin);
    slot.indentFirstLine = applyValued(slot.indentFirstLine, layer.indent.firstLine, origin);
    slot.indentHanging = applyValued(slot.indentHanging, layer.indent.hanging, origin);
  }
}

function originForStyle(style: StyleDefinition, role: OriginLayer): PropertyOrigin {
  return { layer: role, style_id: style.style_id, style_name: style.name };
}

const DIRECT_ORIGIN: PropertyOrigin = Object.freeze({
  layer: 'direct',
  style_id: null,
  style_name: null,
});

function materialize(slot: MutableResolved): ResolvedParagraphProperties {
  // 对象型值（边框/底纹/制表位）做一次深拷贝，避免读回结果与样式表 / 直接格式共享引用，
  // 后续任一侧被改动时"读回结果跟着变"。
  return {
    alignment: slot.alignment,
    lineSpacing: slot.lineSpacing,
    spacingBefore: slot.spacingBefore,
    spacingAfter: slot.spacingAfter,
    indent: {
      left: slot.indentLeft,
      right: slot.indentRight,
      firstLine: slot.indentFirstLine,
      hanging: slot.indentHanging,
    },
    tabStops: slot.tabStops.specified
      ? { specified: true, value: structuredClone(slot.tabStops.value), origin: slot.tabStops.origin }
      : slot.tabStops,
    pageBreakBefore: slot.pageBreakBefore,
    keepNext: slot.keepNext,
    keepLines: slot.keepLines,
    widowControl: slot.widowControl,
    borders: slot.borders.specified
      ? { specified: true, value: structuredClone(slot.borders.value), origin: slot.borders.origin }
      : slot.borders,
    shading: slot.shading.specified
      ? { specified: true, value: structuredClone(slot.shading.value), origin: slot.shading.origin }
      : slot.shading,
    outlineLevel: slot.outlineLevel,
  };
}

/**
 * 解析段落的有效属性（R122/R124）。
 *
 * 层的顺序：**文档默认（含其 basedOn 链）→ 命名样式（含 basedOn 链）→ 直接格式**。
 * 每层内部都是"根在前"，即祖先先应用、后代后应用（后代覆盖祖先）。
 *
 * 链出问题（成环 / 坏引用 / 类型不符）时**不抛异常**：把问题记进 `problems`、`status` 置
 * `conflict`，并**继续用已解析出的部分**完成级联。这样一份文档里有个坏样式，
 * 不会让用户连"把这一段居中"都做不了。
 */
export function resolveParagraphCascade(input: CascadeInput): ParagraphCascadeResult {
  const slot = emptyResolved();
  const problems: StyleProblem[] = [];
  const applied: AppliedStyle[] = [];

  const applyChain = (
    startStyleId: string,
    role: 'document_default' | 'named_style',
  ): void => {
    const result = resolveStyleChain(input.styles, startStyleId);
    if (!result.ok) problems.push(result.problem);
    for (const style of result.chain) {
      applyLayer(slot, style.paragraph_properties, originForStyle(style, role));
      applied.push({ style_id: style.style_id, name: style.name, role });
    }
  };

  // 层 1：文档默认段落样式。若默认样式本身有 basedOn 链，链根先应用。
  const defaultStyle = findDefaultStyle(input.styles, 'paragraph');
  if (defaultStyle !== null) {
    applyChain(defaultStyle.style_id, 'document_default');
  }

  // 层 2：段落引用的命名样式（含 basedOn 链）。
  if (input.style_ref !== null) {
    applyChain(input.style_ref, 'named_style');
  }

  // 层 3：直接格式。
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
