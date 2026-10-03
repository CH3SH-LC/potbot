/**
 * 测试夹具构造器（**非生产路径**；供本批选区和字符操作的单测复用）。
 *
 * 为什么需要它：`model/types.ts` 是**纯类型 + 少量常量**（冻结 v1，不提供构造器），
 * 而单元测试需要大量"半成品文档"。如果每份测试各自手搓 `RunProperties` 的 16 个字段，
 * 漏一个字段就会让"其余属性不变"的判据变成假绿。因此把构造成本集中到这里，
 * 并让 `unspecified` 成为默认值——这样测试里**只有显式写出**的属性才是"有意见"的属性。
 *
 * 本文件不被 vitest 收集（文件名不是 `*.test.ts`），也不进入任何运行时路径。
 */

import {
  TOGGLE_UNSPECIFIED,
  type BlockNode,
  type CellNode,
  type CellProperties,
  type DocumentModel,
  type FieldNode,
  type IndentProperties,
  type InlineNode,
  type ParagraphNode,
  type ParagraphProperties,
  type RowNode,
  type RunNode,
  type RunProperties,
  type SectionProperties,
  type StyleDefinition,
  type StyleTable,
  type TableNode,
  type TableProperties,
  type ToggleState,
  type ValuedState,
} from '../model/types.js';

/** `ValuedState` 的"未指定"常量（types.ts 未导出对应常量，这里补一个局部版本）。 */
export function unspecified<T>(): ValuedState<T> {
  return { state: 'unspecified' };
}

/** 全 `unspecified` 的 run 属性：**不写任何 rPr 子元素**的模型态（R118）。 */
export function unspecifiedRunProperties(): RunProperties {
  return {
    bold: TOGGLE_UNSPECIFIED,
    italic: TOGGLE_UNSPECIFIED,
    underline: unspecified(),
    strike: TOGGLE_UNSPECIFIED,
    doubleStrike: TOGGLE_UNSPECIFIED,
    vertAlign: unspecified(),
    fonts: unspecified(),
    size: unspecified(),
    scale: unspecified(),
    position: unspecified(),
    color: unspecified(),
    highlight: unspecified(),
    shading: unspecified(),
    spacing: unspecified(),
    caps: TOGGLE_UNSPECIFIED,
    smallCaps: TOGGLE_UNSPECIFIED,
  };
}

/** 以 `unspecifiedRunProperties()` 为底，覆写若干字段。 */
export function runProperties(overrides: Partial<RunProperties> = {}): RunProperties {
  return { ...unspecifiedRunProperties(), ...overrides };
}

/** 显式加粗（`on`）。 */
export function boldOn(): RunProperties {
  return runProperties({ bold: { state: 'on' } });
}

/** 显式关闭加粗（`off`）——写出 `w:b w:val="false"` 的那种状态（R118）。 */
export function boldOff(): RunProperties {
  return runProperties({ bold: { state: 'off' } });
}

export function unspecifiedIndent(): IndentProperties {
  return { left: unspecified(), right: unspecified(), firstLine: unspecified(), hanging: unspecified() };
}

export function unspecifiedParagraphProperties(overrides: Partial<ParagraphProperties> = {}): ParagraphProperties {
  return {
    alignment: unspecified(),
    lineSpacing: unspecified(),
    spacingBefore: unspecified(),
    spacingAfter: unspecified(),
    indent: unspecifiedIndent(),
    tabStops: unspecified(),
    pageBreakBefore: TOGGLE_UNSPECIFIED,
    keepNext: TOGGLE_UNSPECIFIED,
    keepLines: TOGGLE_UNSPECIFIED,
    widowControl: TOGGLE_UNSPECIFIED,
    borders: unspecified(),
    shading: unspecified(),
    outlineLevel: unspecified(),
    ...overrides,
  };
}

export function run(id: string, text: string, properties: RunProperties = unspecifiedRunProperties()): RunNode {
  return { kind: 'run', id, source: 'imported', opaque: [], properties, text };
}

export function field(id: string, instruction: string, cachedResult: string | null = null): FieldNode {
  return {
    kind: 'field',
    id,
    source: 'imported',
    opaque: [],
    instruction,
    cached_result: cachedResult,
    refresh_state: 'unknown',
  };
}

export function breakNode(id: string): InlineNode {
  return { kind: 'break', id, source: 'imported', opaque: [], breakType: 'line' };
}

export function paragraph(
  id: string,
  inlines: readonly InlineNode[],
  overrides: Partial<ParagraphNode> = {},
): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'imported',
    opaque: [],
    properties: unspecifiedParagraphProperties(),
    inlines,
    style_ref: null,
    numbering: null,
    ...overrides,
  };
}

/** 便捷：一段若干 run 的段落。`runs` 形如 `[['a','你好'], ['b','世界']]`。 */
export function paragraphOfRuns(
  id: string,
  runs: readonly (readonly [string, string, RunProperties?])[],
  overrides: Partial<ParagraphNode> = {},
): ParagraphNode {
  return paragraph(
    id,
    runs.map(([runId, text, properties]) => run(runId, text, properties ?? unspecifiedRunProperties())),
    overrides,
  );
}

export function emptyStyles(): StyleTable {
  return { styles: [] };
}

export function style(styleId: string, name: string, overrides: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id: styleId,
    name,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...overrides,
  };
}

export function tableProperties(overrides: Partial<TableProperties> = {}): TableProperties {
  return {
    alignment: unspecified(),
    indent: unspecified(),
    width: unspecified(),
    layout: unspecified(),
    borders: unspecified(),
    shading: unspecified(),
    repeatHeader: false,
    ...overrides,
  };
}

export function cellProperties(overrides: Partial<CellProperties> = {}): CellProperties {
  return {
    verticalAlign: unspecified(),
    shading: unspecified(),
    borders: unspecified(),
    width: unspecified(),
    ...overrides,
  };
}

export function cell(id: string, blocks: readonly BlockNode[], overrides: Partial<CellNode> = {}): CellNode {
  return {
    kind: 'cell',
    id,
    source: 'imported',
    opaque: [],
    properties: cellProperties(),
    blocks,
    grid_span: 1,
    vertical_merge: null,
    ...overrides,
  };
}

export function row(id: string, cells: readonly CellNode[], overrides: Partial<RowNode> = {}): RowNode {
  return {
    kind: 'row',
    id,
    source: 'imported',
    opaque: [],
    height: unspecified(),
    header: false,
    cells,
    ...overrides,
  };
}

export function table(id: string, rows: readonly RowNode[], overrides: Partial<TableNode> = {}): TableNode {
  return {
    kind: 'table',
    id,
    source: 'imported',
    opaque: [],
    properties: tableProperties(),
    rows,
    grid: [],
    ...overrides,
  };
}

export function defaultSection(): SectionProperties {
  return {
    pageSize: unspecified(),
    orientation: unspecified(),
    margins: unspecified(),
    columns: unspecified(),
    titlePage: TOGGLE_UNSPECIFIED,
    evenAndOddHeaders: TOGGLE_UNSPECIFIED,
  };
}

export function document(blocks: readonly BlockNode[], overrides: Partial<DocumentModel> = {}): DocumentModel {
  return {
    document_id: 'doc-1',
    revision: 1,
    blocks,
    sections: [defaultSection()],
    styles: emptyStyles(),
    comments: [],
    content_types: { defaults: [], overrides: [] },
    relationships: [],
    media: [],
    opaque_parts: [],
    ...overrides,
  };
}

/** 类型别名，便于测试里标注期望的开关态。 */
export type ToggleLike = ToggleState;

// ---------------------------------------------------------------------------
// Unicode 样本（用转义写，避免源码编辑链把 ZWJ / 组合标记悄悄换掉）
// ---------------------------------------------------------------------------

/** ZWJ 家庭 emoji：人 + ZWJ + 人 + ZWJ + 人 = **5 个码位**、**8 个 UTF-16 码元**。 */
export const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

/** 分解形 é：`e` + 组合尖音符 U+0301 = **2 个码位**。 */
export const E_ACUTE_DECOMPOSED = 'é';

/** 预组合形 é：1 个码位。 */
export const E_ACUTE_PRECOMPOSED = 'é';

/** 零宽连接符。 */
export const ZWJ = '‍';
