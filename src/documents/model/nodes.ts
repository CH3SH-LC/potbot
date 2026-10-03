/**
 * 节点工厂、默认属性、以及**草稿 → 带稳定 id 的节点**的物化（R100/R101/R104）。
 *
 * ## 为什么要区分"草稿节点"与"节点"
 *
 * R101 要求 id 在**导入时分配一次**、之后跨读—改—写往返不变。若工厂直接产出带 id 的节点，
 * 调用方就得自己编 id（各编各的，无法保证确定性），或者依赖一个全局计数器
 * （那就不是"同输入 ⇒ 同 id"了）。因此：
 *
 * - **草稿节点**（`DraftXxxNode`）= 少了 `id` 的节点，字段与冻结类型一一对应；
 * - 物化（`materializeBlockNode` 等）在**给定路径 + 分配器**下补上 id，路径由文档结构唯一决定
 *   （规则见 `ids.ts`）。
 *
 * 于是"同一份草稿 ⇒ 同一串 id"是可以断言的，而"往既有文档里插一段"只用**追加**新 id、
 * 从不重算旧 id。
 *
 * ## `source` 为什么不给默认值
 *
 * R109 要求四种来源不得混同，R148 明确 `imported` 不得被当成"用户已确认"。
 * 给 `source` 配一个默认值，就等于让"我忘了这是导入的还是生成的"这一个疏忽
 * 悄悄变成一份来源声明——所以**必须显式传**。
 */

import { UNSPECIFIED_VALUE } from './attributes.js';
import { DocumentModelError, assertModel, kindLabel, valueLabel } from './errors.js';
import {
  nodePathSegment,
  withSegment,
  type NodeIdAllocator,
  type NodePath,
} from './ids.js';
import { TOGGLE_UNSPECIFIED } from './types.js';
import type { EquationContent } from '../equations/types.js';
import type {
  BlockNode,
  BreakNode,
  CellNode,
  CellProperties,
  CommentNode,
  DrawingNode,
  EquationNode,
  FieldNode,
  IndentProperties,
  InlineNode,
  Length,
  NodeId,
  ParagraphNode,
  ParagraphProperties,
  RowNode,
  RunNode,
  RunProperties,
  SectionProperties,
  SourceKind,
  TableNode,
  TableProperties,
} from './types.js';

// ---------------------------------------------------------------------------
// 默认属性（每个字段都落在"未指定"，即"不写该元素"）
// ---------------------------------------------------------------------------

export function defaultRunProperties(): RunProperties {
  return {
    bold: TOGGLE_UNSPECIFIED,
    italic: TOGGLE_UNSPECIFIED,
    underline: UNSPECIFIED_VALUE,
    strike: TOGGLE_UNSPECIFIED,
    doubleStrike: TOGGLE_UNSPECIFIED,
    vertAlign: UNSPECIFIED_VALUE,
    fonts: UNSPECIFIED_VALUE,
    size: UNSPECIFIED_VALUE,
    scale: UNSPECIFIED_VALUE,
    position: UNSPECIFIED_VALUE,
    color: UNSPECIFIED_VALUE,
    highlight: UNSPECIFIED_VALUE,
    shading: UNSPECIFIED_VALUE,
    spacing: UNSPECIFIED_VALUE,
    caps: TOGGLE_UNSPECIFIED,
    smallCaps: TOGGLE_UNSPECIFIED,
  };
}

export function defaultIndentProperties(): IndentProperties {
  return {
    left: UNSPECIFIED_VALUE,
    right: UNSPECIFIED_VALUE,
    firstLine: UNSPECIFIED_VALUE,
    hanging: UNSPECIFIED_VALUE,
  };
}

export function defaultParagraphProperties(): ParagraphProperties {
  return {
    alignment: UNSPECIFIED_VALUE,
    lineSpacing: UNSPECIFIED_VALUE,
    spacingBefore: UNSPECIFIED_VALUE,
    spacingAfter: UNSPECIFIED_VALUE,
    indent: defaultIndentProperties(),
    tabStops: UNSPECIFIED_VALUE,
    pageBreakBefore: TOGGLE_UNSPECIFIED,
    keepNext: TOGGLE_UNSPECIFIED,
    keepLines: TOGGLE_UNSPECIFIED,
    widowControl: TOGGLE_UNSPECIFIED,
    borders: UNSPECIFIED_VALUE,
    shading: UNSPECIFIED_VALUE,
    outlineLevel: UNSPECIFIED_VALUE,
  };
}

export function defaultCellProperties(): CellProperties {
  return {
    verticalAlign: UNSPECIFIED_VALUE,
    shading: UNSPECIFIED_VALUE,
    borders: UNSPECIFIED_VALUE,
    width: UNSPECIFIED_VALUE,
  };
}

export function defaultTableProperties(): TableProperties {
  return {
    alignment: UNSPECIFIED_VALUE,
    indent: UNSPECIFIED_VALUE,
    width: UNSPECIFIED_VALUE,
    layout: UNSPECIFIED_VALUE,
    borders: UNSPECIFIED_VALUE,
    shading: UNSPECIFIED_VALUE,
    repeatHeader: false,
  };
}

/** 默认节：A4 纵向 + 常用页边距**全部为 `unspecified`**（不臆造页面设置，R108/R127）。 */
export function defaultSectionProperties(): SectionProperties {
  const unset = UNSPECIFIED_VALUE;
  return {
    pageSize: unset,
    orientation: unset,
    margins: unset,
    columns: unset,
    titlePage: TOGGLE_UNSPECIFIED,
    evenAndOddHeaders: TOGGLE_UNSPECIFIED,
  };
}

/** 标准 A4 尺寸（210 × 297 mm）——显式设置节尺寸时用，避免各处硬编码数字。 */
export const A4_PAGE_SIZE: { readonly width: Length; readonly height: Length } = Object.freeze({
  width: Object.freeze({ unit: 'mm', value: 210 }),
  height: Object.freeze({ unit: 'mm', value: 297 }),
});

// ---------------------------------------------------------------------------
// 草稿节点类型
// ---------------------------------------------------------------------------

/** 草稿节点共有的可选字段。 */
interface NodeDraftExtras {
  /** 未能建模的 XML 片段（R105）；省略即"没有需要保留的片段"。 */
  readonly opaque?: readonly unknown[];
}

export type DraftRunNode = Omit<RunNode, 'id' | 'opaque'> & NodeDraftExtras;
export type DraftBreakNode = Omit<BreakNode, 'id' | 'opaque'> & NodeDraftExtras;
export type DraftFieldNode = Omit<FieldNode, 'id' | 'opaque'> & NodeDraftExtras;
export type DraftDrawingNode = Omit<DrawingNode, 'id' | 'opaque'> & NodeDraftExtras;
/** 行内公式草稿（WF-091 / design-05-P9）。 */
export type DraftEquationNode = Omit<EquationNode, 'id' | 'opaque'> & NodeDraftExtras;
export type DraftInlineNode =
  | DraftRunNode
  | DraftBreakNode
  | DraftFieldNode
  | DraftDrawingNode
  | DraftEquationNode;

export type DraftParagraphNode = Omit<ParagraphNode, 'id' | 'opaque' | 'inlines'> &
  NodeDraftExtras & { readonly inlines: readonly DraftInlineNode[] };
export type DraftCellNode = Omit<CellNode, 'id' | 'opaque' | 'blocks'> &
  NodeDraftExtras & { readonly blocks: readonly DraftBlockNode[] };
export type DraftRowNode = Omit<RowNode, 'id' | 'opaque' | 'cells'> &
  NodeDraftExtras & { readonly cells: readonly DraftCellNode[] };
export type DraftTableNode = Omit<TableNode, 'id' | 'opaque' | 'rows'> &
  NodeDraftExtras & { readonly rows: readonly DraftRowNode[] };
export type DraftBlockNode = DraftParagraphNode | DraftTableNode;

/** 批注草稿：锚点用**路径**（id 由分配时刻决定，草稿阶段还没有 id）。 */
export type DraftCommentNode = Omit<CommentNode, 'id' | 'opaque' | 'anchor'> &
  NodeDraftExtras & {
    readonly anchor: { readonly path: NodePath; readonly start: number; readonly end: number } | null;
  };

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

const SOURCE_KINDS: readonly SourceKind[] = [
  'user_request',
  'imported',
  'model_generated',
  'system',
];

/** 校验并收窄 `source`（R109）。 */
export function assertSourceKind(value: unknown, detail: string): SourceKind {
  assertModel(
    typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value),
    'invalid_node',
    `${detail}：source 必须是 ${SOURCE_KINDS.join(' / ')} 之一，收到 ${valueLabel(value)}`,
  );
  return value as SourceKind;
}

function normalizeOpaque(opaque: readonly unknown[] | undefined, detail: string): readonly unknown[] {
  if (opaque === undefined) {
    return [];
  }
  assertModel(Array.isArray(opaque), 'invalid_node', `${detail}：opaque 必须是数组`);
  return [...opaque];
}

export function runNode(input: {
  readonly text: string;
  readonly source: SourceKind;
  readonly properties?: RunProperties;
  readonly opaque?: readonly unknown[];
}): DraftRunNode {
  assertModel(typeof input.text === 'string', 'invalid_node', 'run 文本必须是字符串');
  return {
    kind: 'run',
    source: assertSourceKind(input.source, 'run'),
    opaque: normalizeOpaque(input.opaque, 'run'),
    properties: input.properties ?? defaultRunProperties(),
    text: input.text,
  };
}

export function breakNode(input: {
  readonly breakType: BreakNode['breakType'];
  readonly source: SourceKind;
  readonly opaque?: readonly unknown[];
}): DraftBreakNode {
  assertModel(
    input.breakType === 'line' || input.breakType === 'page' || input.breakType === 'column',
    'invalid_node',
    `breakType 非法：${valueLabel(input.breakType)}`,
  );
  return {
    kind: 'break',
    source: assertSourceKind(input.source, 'break'),
    opaque: normalizeOpaque(input.opaque, 'break'),
    breakType: input.breakType,
  };
}

/**
 * 内联图形草稿（WF-065–070）。
 *
 * `relationship_id` 的**存在性**由本工厂把关，而不是等到导出才炸：`picture` 必须带关系
 * （没有关系的图片部件是悬空引用，R106 要挡的正是这个）；形状/文本框可以不带。
 */
export function drawingNode(input: {
  readonly drawing_type: DrawingNode['drawing_type'];
  readonly source: SourceKind;
  readonly relationship_id?: string | null;
  readonly extent?: DrawingNode['extent'];
  readonly rotation_deg?: number;
  readonly wrap?: DrawingNode['wrap'];
  readonly alt_text?: string | null;
  readonly opaque?: readonly unknown[];
}): DraftDrawingNode {
  const relationshipId = input.relationship_id ?? null;
  assertModel(
    input.drawing_type !== 'picture' || (typeof relationshipId === 'string' && relationshipId.length > 0),
    'invalid_node',
    'picture 类型的内联图形必须带 relationship_id（悬空的图片引用会让消费者拒绝整个包）',
  );
  return Object.freeze({
    kind: 'drawing',
    drawing_type: input.drawing_type,
    relationship_id: relationshipId,
    extent: input.extent ?? null,
    rotation_deg: input.rotation_deg ?? 0,
    wrap: input.wrap ?? null,
    alt_text: input.alt_text ?? null,
    source: input.source,
    opaque: Object.freeze([...(input.opaque ?? [])]),
  });
}

/**
 * 校验公式内容的两分支形态（R105：**未解析的那一半绝不冒充已解析**）。
 *
 * `preserved` 分支刻意**只**要求"有说明、有原样数据"，不检查 `omml` 的内部结构——
 * 那正是"保留不解析"的意思；一旦这里开始读懂它，"保留"就名存实亡。
 */
function assertEquationContent(value: unknown, detail: string): EquationContent {
  assertModel(
    typeof value === 'object' && value !== null,
    'invalid_node',
    `${detail}：content 必须是对象（{kind:'editable'|'preserved', …}）`,
  );
  const content = value as { kind?: unknown };
  if (content.kind === 'editable') {
    assertModel(
      typeof (value as { equation?: unknown }).equation === 'object' &&
        (value as { equation?: unknown }).equation !== null,
      'invalid_node',
      `${detail}：editable 分支必须带方程结构树 equation（对象）`,
    );
    return value as EquationContent;
  }
  if (content.kind === 'preserved') {
    assertModel(
      typeof (value as { reason?: unknown }).reason === 'string',
      'invalid_node',
      `${detail}：preserved 分支必须带非空说明 reason（说清为什么没解析）`,
    );
    return value as EquationContent;
  }
  throw new DocumentModelError(
    'invalid_node',
    `${detail}：content.kind 只允许 editable/preserved，收到 ${valueLabel(content.kind)}`,
  );
}

/**
 * 行内公式草稿（WF-091 / design-05-P9）。
 *
 * `equation_id` 的**非空**由本工厂把关（它是"按 id 找公式"的锚，空串会让
 * `documentRangeForInlineId` 之类的定位变成不可靠的匹配）；内容形态由
 * `assertEquationContent` 把关。宽度与可编辑性**不由**工厂决定——那是
 * `equations/inline-selection.ts` 里冻结的投影契约（恒 1 码位、不可编辑）。
 */
export function equationNode(input: {
  readonly equation_id: string;
  readonly content: EquationContent;
  readonly source: SourceKind;
  readonly opaque?: readonly unknown[];
}): DraftEquationNode {
  assertModel(
    typeof input.equation_id === 'string' && input.equation_id.length > 0,
    'invalid_node',
    '公式节点必须带非空的 equation_id（空 id 无法被稳定定位）',
  );
  return Object.freeze({
    kind: 'equation',
    equation_id: input.equation_id,
    content: assertEquationContent(input.content, `公式 ${input.equation_id}`),
    source: assertSourceKind(input.source, 'equation'),
    opaque: Object.freeze([...(input.opaque ?? [])]),
  });
}

export function fieldNode(input: {
  readonly instruction: string;
  readonly source: SourceKind;
  readonly cached_result?: string | null;
  readonly refresh_state?: FieldNode['refresh_state'];
  readonly opaque?: readonly unknown[];
}): DraftFieldNode {
  assertModel(
    typeof input.instruction === 'string' && input.instruction.length > 0,
    'invalid_node',
    '域指令必须是非空字符串',
  );
  const refreshState = input.refresh_state ?? 'unknown';
  assertModel(
    refreshState === 'unknown' || refreshState === 'stale' || refreshState === 'refreshed',
    'invalid_node',
    `域刷新状态非法：${valueLabel(refreshState)}`,
  );
  return {
    kind: 'field',
    source: assertSourceKind(input.source, 'field'),
    opaque: normalizeOpaque(input.opaque, 'field'),
    instruction: input.instruction,
    cached_result: input.cached_result ?? null,
    refresh_state: refreshState,
  };
}

export function paragraphNode(input: {
  readonly source: SourceKind;
  readonly inlines?: readonly DraftInlineNode[];
  readonly properties?: ParagraphProperties;
  readonly style_ref?: string | null;
  readonly numbering?: ParagraphNode['numbering'];
  readonly opaque?: readonly unknown[];
}): DraftParagraphNode {
  return {
    kind: 'paragraph',
    source: assertSourceKind(input.source, 'paragraph'),
    opaque: normalizeOpaque(input.opaque, 'paragraph'),
    properties: input.properties ?? defaultParagraphProperties(),
    inlines: input.inlines ?? [],
    style_ref: input.style_ref ?? null,
    numbering: input.numbering ?? null,
  };
}

/** 便捷：一段只有一个 run 的段落。 */
export function textParagraphNode(input: {
  readonly text: string;
  readonly source: SourceKind;
  readonly properties?: ParagraphProperties;
  readonly runProperties?: RunProperties;
  readonly style_ref?: string | null;
}): DraftParagraphNode {
  return paragraphNode({
    source: input.source,
    properties: input.properties,
    style_ref: input.style_ref,
    inlines: [
      runNode({ text: input.text, source: input.source, properties: input.runProperties }),
    ],
  });
}

export function cellNode(input: {
  readonly source: SourceKind;
  readonly blocks?: readonly DraftBlockNode[];
  readonly properties?: CellProperties;
  readonly grid_span?: number;
  readonly vertical_merge?: CellNode['vertical_merge'];
  readonly opaque?: readonly unknown[];
}): DraftCellNode {
  const gridSpan = input.grid_span ?? 1;
  assertModel(
    Number.isInteger(gridSpan) && gridSpan >= 1,
    'table_shape_invalid',
    `grid_span 必须是 ≥1 的整数，收到 ${valueLabel(gridSpan)}`,
  );
  const verticalMerge = input.vertical_merge ?? null;
  assertModel(
    verticalMerge === null || verticalMerge === 'restart' || verticalMerge === 'continue',
    'table_shape_invalid',
    `vertical_merge 非法：${valueLabel(verticalMerge)}`,
  );
  return {
    kind: 'cell',
    source: assertSourceKind(input.source, 'cell'),
    opaque: normalizeOpaque(input.opaque, 'cell'),
    properties: input.properties ?? defaultCellProperties(),
    blocks: input.blocks ?? [],
    grid_span: gridSpan,
    vertical_merge: verticalMerge,
  };
}

export function rowNode(input: {
  readonly source: SourceKind;
  readonly cells: readonly DraftCellNode[];
  readonly height?: RowNode['height'];
  readonly header?: boolean;
  /** 禁止跨页断行（WF-063）。省略即 `false`。 */
  readonly cant_split?: boolean;
  readonly opaque?: readonly unknown[];
}): DraftRowNode {
  return {
    kind: 'row',
    source: assertSourceKind(input.source, 'row'),
    opaque: normalizeOpaque(input.opaque, 'row'),
    height: input.height ?? UNSPECIFIED_VALUE,
    header: input.header ?? false,
    cant_split: input.cant_split ?? false,
    cells: input.cells,
  };
}

export function tableNode(input: {
  readonly source: SourceKind;
  readonly rows: readonly DraftRowNode[];
  readonly grid?: readonly Length[];
  readonly properties?: TableProperties;
  readonly opaque?: readonly unknown[];
}): DraftTableNode {
  return {
    kind: 'table',
    source: assertSourceKind(input.source, 'table'),
    opaque: normalizeOpaque(input.opaque, 'table'),
    properties: input.properties ?? defaultTableProperties(),
    rows: input.rows,
    grid: input.grid ?? [],
  };
}

export function commentNode(input: {
  readonly author: string;
  readonly text: string;
  readonly source: SourceKind;
  readonly anchor?: DraftCommentNode['anchor'];
  readonly opaque?: readonly unknown[];
}): DraftCommentNode {
  assertModel(typeof input.author === 'string', 'invalid_node', '批注作者必须是字符串');
  assertModel(typeof input.text === 'string', 'invalid_node', '批注文本必须是字符串');
  return {
    kind: 'comment',
    source: assertSourceKind(input.source, 'comment'),
    opaque: normalizeOpaque(input.opaque, 'comment'),
    author: input.author,
    text: input.text,
    anchor: input.anchor ?? null,
  };
}

// ---------------------------------------------------------------------------
// 物化（草稿 + 路径 + 分配器 ⇒ 带稳定 id 的节点）
// ---------------------------------------------------------------------------

/** 文档正文所在路径（`n/body:0/...`）。 */
export function bodyPath(): NodePath {
  return [nodePathSegment('body', 0)];
}

/** 批注所在路径（`n/comment:i`）。 */
export function commentPath(index: number): NodePath {
  return [nodePathSegment('comment', index)];
}

function materializeInline(draft: DraftInlineNode, path: NodePath, allocator: NodeIdAllocator): InlineNode {
  switch (draft.kind) {
    case 'run': {
      assertModel(typeof draft.text === 'string', 'invalid_node', 'run 文本必须是字符串');
      return {
        id: allocator.allocate(path),
        kind: 'run',
        source: assertSourceKind(draft.source, 'run'),
        opaque: normalizeOpaque(draft.opaque, 'run'),
        properties: draft.properties,
        text: draft.text,
      };
    }
    case 'break': {
      return {
        id: allocator.allocate(path),
        kind: 'break',
        source: assertSourceKind(draft.source, 'break'),
        opaque: normalizeOpaque(draft.opaque, 'break'),
        breakType: draft.breakType,
      };
    }
    case 'field': {
      return {
        id: allocator.allocate(path),
        kind: 'field',
        source: assertSourceKind(draft.source, 'field'),
        opaque: normalizeOpaque(draft.opaque, 'field'),
        instruction: draft.instruction,
        cached_result: draft.cached_result,
        refresh_state: draft.refresh_state,
      };
    }
    case 'drawing': {
      return {
        id: allocator.allocate(path),
        kind: 'drawing',
        source: assertSourceKind(draft.source, 'drawing'),
        opaque: normalizeOpaque(draft.opaque, 'drawing'),
        drawing_type: draft.drawing_type,
        relationship_id: draft.relationship_id,
        extent: draft.extent,
        rotation_deg: draft.rotation_deg,
        wrap: draft.wrap,
        alt_text: draft.alt_text,
      };
    }
    case 'equation': {
      assertModel(
        typeof draft.equation_id === 'string' && draft.equation_id.length > 0,
        'invalid_node',
        '公式节点必须带非空的 equation_id（空 id 无法被稳定定位）',
      );
      return {
        id: allocator.allocate(path),
        kind: 'equation',
        source: assertSourceKind(draft.source, 'equation'),
        opaque: normalizeOpaque(draft.opaque, 'equation'),
        equation_id: draft.equation_id,
        content: assertEquationContent(draft.content, `公式 ${draft.equation_id}`),
      };
    }
    default:
      throw new DocumentModelError(
        'invalid_node',
        `行内节点只允许 run/break/field/drawing/equation，收到 ${kindLabel(draft)}`,
      );
  }
}

/**
 * 物化一个块节点。`path` 必须已是**该节点自身**的路径（父路径 + 自己的 `kind:index` 段）。
 */
export function materializeBlockNode(
  draft: DraftBlockNode,
  path: NodePath,
  allocator: NodeIdAllocator,
): BlockNode {
  switch (draft.kind) {
    case 'paragraph': {
      const inlines = draft.inlines.map((inline, index) =>
        materializeInline(inline, withSegment(path, inlineKindOf(inline), index), allocator),
      );
      return {
        id: allocator.allocate(path),
        kind: 'paragraph',
        source: assertSourceKind(draft.source, 'paragraph'),
        opaque: normalizeOpaque(draft.opaque, 'paragraph'),
        properties: draft.properties,
        inlines,
        style_ref: draft.style_ref,
        numbering: draft.numbering,
      };
    }
    case 'table': {
      const rows = draft.rows.map((row, rowIndex) => {
        const rowPath = withSegment(path, 'row', rowIndex);
        const cells = row.cells.map((cell, cellIndex) => {
          const cellPath = withSegment(rowPath, 'cell', cellIndex);
          const blocks = cell.blocks.map((block, blockIndex) =>
            materializeBlockNode(block, withSegment(cellPath, blockKindOf(block), blockIndex), allocator),
          );
          return {
            id: allocator.allocate(cellPath),
            kind: 'cell' as const,
            source: assertSourceKind(cell.source, 'cell'),
            opaque: normalizeOpaque(cell.opaque, 'cell'),
            properties: cell.properties,
            blocks,
            grid_span: cell.grid_span,
            vertical_merge: cell.vertical_merge,
          };
        });
        return {
          id: allocator.allocate(rowPath),
          kind: 'row' as const,
          source: assertSourceKind(row.source, 'row'),
          opaque: normalizeOpaque(row.opaque, 'row'),
          height: row.height,
          header: row.header,
          cant_split: row.cant_split ?? false,
          cells,
        };
      });
      return {
        id: allocator.allocate(path),
        kind: 'table',
        source: assertSourceKind(draft.source, 'table'),
        opaque: normalizeOpaque(draft.opaque, 'table'),
        properties: draft.properties,
        rows,
        grid: draft.grid,
      };
    }
    default:
      throw new DocumentModelError(
        'invalid_block_sequence',
        `块节点只允许 paragraph/table，收到 ${kindLabel(draft)}`,
      );
  }
}

/** 物化一个表格行（`path` 必须已是该行自己的路径）。 */
export function materializeRowNode(
  draft: DraftRowNode,
  path: NodePath,
  allocator: NodeIdAllocator,
): RowNode {
  const cells = draft.cells.map((cell, index) =>
    materializeCellNode(cell, withSegment(path, 'cell', index), allocator),
  );
  return {
    id: allocator.allocate(path),
    kind: 'row',
    source: assertSourceKind(draft.source, 'row'),
    opaque: normalizeOpaque(draft.opaque, 'row'),
    height: draft.height,
    header: draft.header,
    cant_split: draft.cant_split ?? false,
    cells,
  };
}

/** 物化一个单元格（`path` 必须已是该单元格自己的路径）。 */
export function materializeCellNode(
  draft: DraftCellNode,
  path: NodePath,
  allocator: NodeIdAllocator,
): CellNode {
  const blocks = draft.blocks.map((block, index) =>
    materializeBlockNode(block, withSegment(path, blockKindOf(block), index), allocator),
  );
  return {
    id: allocator.allocate(path),
    kind: 'cell',
    source: assertSourceKind(draft.source, 'cell'),
    opaque: normalizeOpaque(draft.opaque, 'cell'),
    properties: draft.properties,
    blocks,
    grid_span: draft.grid_span,
    vertical_merge: draft.vertical_merge,
  };
}

/** 物化一条批注；锚点路径由 `resolveAnchor` 换成已分配好的节点 id。 */
export function materializeCommentNode(
  draft: DraftCommentNode,
  path: NodePath,
  allocator: NodeIdAllocator,
  resolveAnchor: (path: NodePath) => NodeId,
): CommentNode {
  assertModel(draft.anchor === null || draft.anchor !== undefined, 'invalid_node', '批注锚点非法');
  const anchor = draft.anchor;
  return {
    id: allocator.allocate(path),
    kind: 'comment',
    source: assertSourceKind(draft.source, 'comment'),
    opaque: normalizeOpaque(draft.opaque, 'comment'),
    author: draft.author,
    text: draft.text,
    anchor:
      anchor === null
        ? null
        : { node_id: resolveAnchor(anchor.path), start: anchor.start, end: anchor.end },
  };
}

/** 取块节点的 `kind` 文本（用于路径段与运行时校验）。 */
export function blockKindOf(block: DraftBlockNode | BlockNode): string {
  const kind: unknown = (block as { kind?: unknown }).kind;
  if (kind !== 'paragraph' && kind !== 'table') {
    throw new DocumentModelError(
      'invalid_block_sequence',
      `块节点只允许 paragraph/table，收到 ${kindLabel(block)}`,
    );
  }
  return kind;
}

/** 取行内节点的 `kind` 文本（用于路径段与运行时校验）。 */
export function inlineKindOf(inline: DraftInlineNode | InlineNode): string {
  const kind: unknown = (inline as { kind?: unknown }).kind;
  if (
    kind !== 'run' &&
    kind !== 'break' &&
    kind !== 'field' &&
    kind !== 'drawing' &&
    kind !== 'equation'
  ) {
    throw new DocumentModelError(
      'invalid_node',
      `行内节点只允许 run/break/field/drawing/equation，收到 ${kindLabel(inline)}`,
    );
  }
  return kind;
}
