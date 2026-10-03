/**
 * 节点与整篇的不变量检查（R100–R110、R159–R162）。
 *
 * ## 严重度判据（**先看这一条再看代码**）
 *
 * - **error** = 结构上不可能正确写出、或引用必然指不到东西。例：id 重复、块槽位里放了 run、
 *   内容类型表自相矛盾、关系指向不存在的部件（悬空 rId）。
 * - **warning** = 语义可疑但**可表示**，能原样写出，应由上层操作归一化。例：首行缩进与悬挂
 *   缩进同时设置（`types.ts` 说二者互斥，但导入的历史文件里真的会出现）、相邻两表
 *   （Word 会合并）、run 文本里出现换行字符（应改用 `BreakNode`）。
 *
 * 这条分界的意图是：**导入不得因为"文件长得不规范"就被拒**，但**"写出去必然是坏文件"
 * 必须挡死**。R160 的"导入检查"要的就是后者。
 *
 * ## 包范围（scope）与悬空检查
 *
 * "关系目标存在"要求知道包里**有哪些部件**。模型自带的部件是 `opaque_parts` / `media`，
 * 加上关系声明自己指认的 `owner_part_path`；其余部件（`word/document.xml`、`word/styles.xml`…）
 * 只有**读过 ZIP 的调用方**（D02）知道，因此要它显式声明 `known_part_paths`。
 *
 * 于是三种结局互不混淆：
 * - 目标落在已知范围 ⇒ 通过；
 * - 调用方**声明了**范围而目标不在其中 ⇒ error `dangling_relationship_target`（真悬空）；
 * - 调用方**没声明**范围且目标不在已知范围 ⇒ error `package_scope_undeclared`
 *   （**拒绝而不是"检查通过"**：不能把"没查"记成"查过了"，见 R155/R166 的取向）。
 */

import { isMixedState } from './attributes.js';
import { DocumentModelError, kindLabel, type DocumentModelProblemCode } from './errors.js';
import { isNodeId } from './ids.js';
import {
  relationshipTypeHasSuffix,
  resolveRelationshipTarget,
  isExternalTarget,
  isSafePartPath,
  findContentType,
} from './preservation.js';
import { rowCellSpans, tableColumnCount } from './table-grid.js';
import { breakCharacterOffsets } from './whitespace.js';
import type {
  BlockNode,
  CellNode,
  DocumentModel,
  InlineNode,
  NodeId,
  ParagraphNode,
  RelationshipRecord,
  RowNode,
  SectionProperties,
  SourceKind,
  TableNode,
} from './types.js';

export type ValidationSeverity = 'error' | 'warning';

/** 一条具体问题。`code` 是判据，`detail` 是说明（含路径/索引）。 */
export interface ValidationProblem {
  readonly code: DocumentModelProblemCode;
  readonly severity: ValidationSeverity;
  readonly detail: string;
  readonly node_id?: NodeId;
  readonly part_path?: string;
}

/** 检查结果。`ok` 等价于"没有 error"（warning 不影响 `ok`）。 */
export interface ValidationReport {
  readonly ok: boolean;
  readonly problems: readonly ValidationProblem[];
  readonly errors: readonly ValidationProblem[];
  readonly warnings: readonly ValidationProblem[];
}

export interface ValidationOptions {
  /**
   * 包里**全部**部件的路径（不含前导斜杠）。读过 ZIP 的一方必须给出；
   * 不给则悬空检查退化为 `package_scope_undeclared`（error，拒绝）。
   */
  readonly known_part_paths?: readonly string[];
  /** 主文档部件路径（`word/document.xml`），R162 的 `officeDocument` 目标校验需要它。 */
  readonly main_document_part_path?: string | null;
}

const SOURCE_KINDS: readonly string[] = [
  'user_request',
  'imported',
  'model_generated',
  'system',
];

// ---------------------------------------------------------------------------
// 报告构造
// ---------------------------------------------------------------------------

export class ProblemCollector {
  private readonly items: ValidationProblem[] = [];

  push(
    code: DocumentModelProblemCode,
    severity: ValidationSeverity,
    detail: string,
    extra?: { readonly node_id?: NodeId; readonly part_path?: string },
  ): void {
    const problem: ValidationProblem = {
      code,
      severity,
      detail,
      ...(extra?.node_id === undefined ? {} : { node_id: extra.node_id }),
      ...(extra?.part_path === undefined ? {} : { part_path: extra.part_path }),
    };
    this.items.push(problem);
  }

  error(code: DocumentModelProblemCode, detail: string, extra?: { node_id?: NodeId; part_path?: string }): void {
    this.push(code, 'error', detail, extra);
  }

  warn(code: DocumentModelProblemCode, detail: string, extra?: { node_id?: NodeId; part_path?: string }): void {
    this.push(code, 'warning', detail, extra);
  }

  report(): ValidationReport {
    const problems = [...this.items];
    const errors = problems.filter((problem) => problem.severity === 'error');
    const warnings = problems.filter((problem) => problem.severity === 'warning');
    return { ok: errors.length === 0, problems, errors, warnings };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------------------
// 节点级检查
// ---------------------------------------------------------------------------

function checkSource(
  collector: ProblemCollector,
  source: unknown,
  id: NodeId | null,
  where: string,
): void {
  if (typeof source !== 'string' || !SOURCE_KINDS.includes(source)) {
    collector.error(
      'invalid_node',
      `${where} 的 source 必须是 ${SOURCE_KINDS.join(' / ')} 之一，收到 ${JSON.stringify(source)}（R109）`,
      id === null ? undefined : { node_id: id },
    );
  }
}

function checkOpaque(collector: ProblemCollector, opaque: unknown, id: NodeId | null, where: string): void {
  if (!Array.isArray(opaque)) {
    collector.error(
      'invalid_node',
      `${where} 的 opaque 必须是数组（未建模 XML 片段的保留位，R105）`,
      id === null ? undefined : { node_id: id },
    );
  }
}

function checkId(collector: ProblemCollector, id: unknown, where: string): NodeId | null {
  if (typeof id !== 'string' || id.length === 0) {
    collector.error('invalid_id', `${where} 的 id 必须是非空字符串，收到 ${JSON.stringify(id)}`);
    return null;
  }
  if (!isNodeId(id)) {
    collector.warn(
      'non_canonical_id',
      `${where} 的 id 不是本模块的规范形态（应来自 ids.ts 的分配器）：${JSON.stringify(id)}`,
      { node_id: id },
    );
  }
  return id;
}

function checkInline(collector: ProblemCollector, inline: InlineNode): void {
  if (!isRecord(inline)) {
    collector.error('invalid_node', `行内节点必须是对象，收到 ${JSON.stringify(inline)}`);
    return;
  }
  const id = checkId(collector, inline.id, '行内节点');
  checkSource(collector, inline.source, id, `行内节点 ${String(inline.id)}`);
  checkOpaque(collector, inline.opaque, id, `行内节点 ${String(inline.id)}`);

  switch (inline.kind) {
    case 'run': {
      if (typeof inline.text !== 'string') {
        collector.error('invalid_node', `run 文本必须是字符串（id=${String(inline.id)}）`, {
          node_id: id ?? undefined,
        });
        return;
      }
      const offsets = breakCharacterOffsets(inline.text);
      if (offsets.length > 0) {
        collector.warn(
          'text_contains_break_character',
          `run 文本含换行类字符（码位偏移 ${offsets.join(', ')}）——换行应表示为 BreakNode，` +
            '否则会被当成段落边界（R104）',
          { node_id: id ?? undefined },
        );
      }
      return;
    }
    case 'break': {
      if (inline.breakType !== 'line' && inline.breakType !== 'page' && inline.breakType !== 'column') {
        collector.error('invalid_node', `BreakNode.breakType 非法：${JSON.stringify(inline.breakType)}`, {
          node_id: id ?? undefined,
        });
      }
      return;
    }
    case 'field': {
      if (typeof inline.instruction !== 'string' || inline.instruction.length === 0) {
        collector.error('invalid_node', `FieldNode.instruction 必须是非空字符串`, {
          node_id: id ?? undefined,
        });
      }
      if (inline.cached_result !== null && typeof inline.cached_result !== 'string') {
        collector.error('invalid_node', 'FieldNode.cached_result 必须是字符串或 null', {
          node_id: id ?? undefined,
        });
      }
      if (
        inline.refresh_state !== 'unknown' &&
        inline.refresh_state !== 'stale' &&
        inline.refresh_state !== 'refreshed'
      ) {
        collector.error('invalid_node', `FieldNode.refresh_state 非法：${JSON.stringify(inline.refresh_state)}`, {
          node_id: id ?? undefined,
        });
      }
      if (inline.refresh_state === 'refreshed' && inline.cached_result === null) {
        collector.warn(
          'invalid_node',
          'FieldNode 标记为已刷新但没有缓存显示值——"已刷新"缺少可读回的结果（R158）',
          { node_id: id ?? undefined },
        );
      }
      return;
    }
    case 'drawing': {
      const allowed: readonly string[] = ['picture', 'shape', 'textbox', 'chart'];
      if (!allowed.includes(inline.drawing_type)) {
        collector.error(
          'invalid_node',
          `DrawingNode.drawing_type 非法：${JSON.stringify(inline.drawing_type)}`,
          { node_id: id ?? undefined },
        );
      }
      // R106：图片必须带关系（悬空引用会让消费者拒绝整个包）；形状/文本框可以不带。
      if (
        inline.drawing_type === 'picture' &&
        (typeof inline.relationship_id !== 'string' || inline.relationship_id.length === 0)
      ) {
        collector.error(
          'invalid_node',
          'picture 类型的内联图形缺少 relationship_id（悬空的图片引用，R106）',
          { node_id: id ?? undefined },
        );
      }
      return;
    }
    case 'equation': {
      // design-05-P9：漏掉这条 `case` 不会报编译错，但会让**合法**的公式节点被判 `invalid_node`
      // （default 分支把 equation 当未知种类）——是本包登记的三处"静默出错"之一，必须显式处理。
      if (typeof inline.equation_id !== 'string' || inline.equation_id.length === 0) {
        collector.error(
          'invalid_node',
          'EquationNode.equation_id 必须是非空字符串（空 id 无法被稳定定位，R101）',
          { node_id: id ?? undefined },
        );
      }
      const content: unknown = inline.content;
      if (!isRecord(content)) {
        collector.error('invalid_node', 'EquationNode.content 必须是对象（R105）', {
          node_id: id ?? undefined,
        });
        return;
      }
      if (content['kind'] === 'editable') {
        if (!isRecord(content['equation'])) {
          collector.error(
            'invalid_node',
            'EquationNode.content 为 editable 时必须带方程结构树 equation（对象）',
            { node_id: id ?? undefined },
          );
        }
        return;
      }
      if (content['kind'] === 'preserved') {
        // "保留不解析"只要求说清原因 + 带着原样数据；**不**去读懂它（R105 的取向）。
        if (typeof content['reason'] !== 'string' || content['reason'].length === 0) {
          collector.error(
            'invalid_node',
            'EquationNode.content 为 preserved 时必须带非空说明 reason（未解析不得冒充已解析，R155）',
            { node_id: id ?? undefined },
          );
        }
        return;
      }
      collector.error(
        'invalid_node',
        `EquationNode.content.kind 非法：${JSON.stringify(content['kind'])}（只允许 editable / preserved）`,
        { node_id: id ?? undefined },
      );
      return;
    }
    default:
      collector.error(
        'invalid_node',
        `行内槽位只允许 run/break/field/drawing/equation，收到 ${kindLabel(inline)}`,
      );
  }
}

function checkStateFields(collector: ProblemCollector, node: ParagraphNode): void {
  const indent = node.properties.indent;
  if (!isRecord(indent)) {
    collector.error('invalid_node', '段落 indent 必须是对象', { node_id: node.id });
    return;
  }
  const firstLine = indent.firstLine;
  const hanging = indent.hanging;
  if (
    isRecord(firstLine) &&
    firstLine['state'] === 'set' &&
    isRecord(hanging) &&
    hanging['state'] === 'set'
  ) {
    collector.warn(
      'conflicting_indent',
      '首行缩进与悬挂缩进同时被显式设置——二者在 OOXML 里是冲突属性，应由段落操作归一化（R130）',
      { node_id: node.id },
    );
  }
  if (isMixedState(indent.left) || isMixedState(indent.right)) {
    collector.warn(
      'non_writable_state',
      '段落缩进里出现了 mixed（读回值）——mixed 只应出现在读取结果里，写入前必须收窄（R119）',
      { node_id: node.id },
    );
  }
}

function checkParagraph(collector: ProblemCollector, node: ParagraphNode): void {
  if (!Array.isArray(node.inlines)) {
    collector.error('invalid_node', '段落 inlines 必须是数组', { node_id: node.id });
    return;
  }
  for (const inline of node.inlines) {
    checkInline(collector, inline);
  }
  if (isRecord(node.properties)) {
    checkStateFields(collector, node);
  } else {
    collector.error('invalid_node', '段落 properties 必须是对象', { node_id: node.id });
  }
  if (node.style_ref !== null && typeof node.style_ref !== 'string') {
    collector.error('invalid_node', '段落 style_ref 必须是字符串或 null', { node_id: node.id });
  }
  const numbering = node.numbering;
  if (numbering !== null) {
    if (
      !isRecord(numbering) ||
      typeof numbering['num_id'] !== 'string' ||
      !Number.isInteger(numbering['level'])
    ) {
      collector.error('invalid_node', '段落 numbering 必须是 { num_id, level } 或 null', {
        node_id: node.id,
      });
    }
  }
}

function checkCell(collector: ProblemCollector, cell: CellNode): void {
  const id = checkId(collector, cell.id, '单元格');
  checkSource(collector, cell.source, id, `单元格 ${String(cell.id)}`);
  checkOpaque(collector, cell.opaque, id, `单元格 ${String(cell.id)}`);
  if (!Number.isInteger(cell.grid_span) || cell.grid_span < 1) {
    collector.error('table_shape_invalid', `grid_span 必须是 ≥1 的整数，收到 ${String(cell.grid_span)}`, {
      node_id: id ?? undefined,
    });
  }
  if (cell.vertical_merge !== null && cell.vertical_merge !== 'restart' && cell.vertical_merge !== 'continue') {
    collector.error('table_shape_invalid', `vertical_merge 非法：${JSON.stringify(cell.vertical_merge)}`, {
      node_id: id ?? undefined,
    });
  }
  if (!Array.isArray(cell.blocks)) {
    collector.error('invalid_block_sequence', '单元格 blocks 必须是数组', { node_id: id ?? undefined });
    return;
  }
  for (const block of cell.blocks) {
    checkBlock(collector, block);
  }
}

function checkRow(collector: ProblemCollector, row: RowNode): void {
  const id = checkId(collector, row.id, '表格行');
  checkSource(collector, row.source, id, `表格行 ${String(row.id)}`);
  checkOpaque(collector, row.opaque, id, `表格行 ${String(row.id)}`);
  if (typeof row.header !== 'boolean') {
    collector.error('invalid_node', '表格行 header 必须是布尔值', { node_id: id ?? undefined });
  }
  if (!Array.isArray(row.cells) || row.cells.length === 0) {
    collector.error('table_shape_invalid', '表格行必须至少有一个单元格', { node_id: id ?? undefined });
    return;
  }
  for (const cell of row.cells) {
    checkCell(collector, cell);
  }
}

function checkVerticalMergeChain(collector: ProblemCollector, table: TableNode): void {
  const open = new Map<number, boolean>();
  for (const row of table.rows) {
    for (const span of rowCellSpans(row)) {
      if (span.span > 1) {
        // 跨列 + 纵向合一的组合语义复杂，本批不判定（留 D05 表格子包）。
        continue;
      }
      const key = span.start;
      if (span.cell.vertical_merge === 'restart') {
        open.set(key, true);
        continue;
      }
      if (span.cell.vertical_merge === 'continue') {
        if (open.get(key) !== true) {
          collector.error(
            'table_shape_invalid',
            `第 ${String(key)} 列出现 vertical_merge="continue" 但没有上方的 "restart" 起点（行 id=${row.id}）`,
            { node_id: row.id },
          );
        }
        continue;
      }
      open.set(key, false);
    }
  }
}

function checkTable(collector: ProblemCollector, table: TableNode): void {
  const id = checkId(collector, table.id, '表格');
  checkSource(collector, table.source, id, `表格 ${String(table.id)}`);
  checkOpaque(collector, table.opaque, id, `表格 ${String(table.id)}`);
  if (!Array.isArray(table.rows)) {
    collector.error('invalid_block_sequence', '表格 rows 必须是数组', { node_id: id ?? undefined });
    return;
  }
  if (table.rows.length === 0) {
    collector.warn('table_shape_invalid', '表格没有任何行——写出后不是可用的表格', {
      node_id: id ?? undefined,
    });
  }
  for (const row of table.rows) {
    checkRow(collector, row);
  }
  if (!Array.isArray(table.grid)) {
    collector.error('table_shape_invalid', '表格 grid 必须是长度数组', { node_id: id ?? undefined });
  } else {
    const columnCount = tableColumnCount(table);
    if (table.grid.length > 0 && table.rows.length > 0) {
      for (const row of table.rows) {
        const rowCount = rowCellSpans(row).reduce((total, span) => total + span.span, 0);
        if (rowCount !== columnCount) {
          collector.warn(
            'table_shape_invalid',
            `行 ${row.id} 占 ${String(rowCount)} 列，与表格的 ${String(columnCount)} 列不一致——` +
              '列操作会拒绝这种表（见 structure.ts 的前置条件）',
            { node_id: row.id },
          );
        }
      }
    }
  }
  checkVerticalMergeChain(collector, table);
}

/** 单个块节点的形态检查（**不含** id 唯一性，那是整篇级的事）。 */
export function checkBlock(collector: ProblemCollector, block: BlockNode): void {
  if (!isRecord(block)) {
    collector.error('invalid_node', `块节点必须是对象，收到 ${JSON.stringify(block)}`);
    return;
  }
  switch (block.kind) {
    case 'paragraph':
      checkId(collector, block.id, '段落');
      checkSource(collector, block.source, block.id, `段落 ${String(block.id)}`);
      checkOpaque(collector, block.opaque, block.id, `段落 ${String(block.id)}`);
      checkParagraph(collector, block);
      return;
    case 'table':
      checkTable(collector, block);
      return;
    default:
      collector.error(
        'invalid_block_sequence',
        `块槽位只允许 paragraph/table，收到 ${kindLabel(block)}`,
      );
  }
}

/**
 * 单块形态断言：形状不合法即抛。`structure.ts` 在**提交前**调用它，
 * 使"新节点不合法 ⇒ 整条操作失败且模型不变"（R136）。
 */
export function assertBlockShape(block: BlockNode, detail: string): void {
  const collector = new ProblemCollector();
  checkBlock(collector, block);
  const report = collector.report();
  const first = report.errors[0];
  if (first !== undefined) {
    throw new DocumentModelError(first.code, `${detail}：${first.detail}`);
  }
}

/**
 * 单表形态断言：`structure.ts` 的表格结构操作在**提交前**用它复核结果表
 * （纵向合并链断裂、空行、grid_span 非法等都会在这里被挡下，R136）。
 */
export function assertTableShape(table: TableNode, detail: string): void {
  const collector = new ProblemCollector();
  checkTable(collector, table);
  const first = collector.report().errors[0];
  if (first !== undefined) {
    throw new DocumentModelError(first.code, `${detail}：${first.detail}`);
  }
}

// ---------------------------------------------------------------------------
// 包级检查
// ---------------------------------------------------------------------------

function derivedScope(model: DocumentModel, options: ValidationOptions): {
  readonly parts: ReadonlySet<string>;
  readonly declared: boolean;
} {
  const parts = new Set<string>();
  for (const part of model.opaque_parts) {
    parts.add(part.path);
  }
  for (const part of model.media) {
    parts.add(part.path);
  }
  for (const relationship of model.relationships) {
    if (relationship.owner_part_path !== null) {
      parts.add(relationship.owner_part_path);
    }
  }
  const declared = options.known_part_paths !== undefined;
  for (const path of options.known_part_paths ?? []) {
    parts.add(path);
  }
  const main = options.main_document_part_path ?? null;
  if (main !== null) {
    parts.add(main);
  }
  return { parts, declared };
}

function checkPartsAndRelationships(
  collector: ProblemCollector,
  model: DocumentModel,
  options: ValidationOptions,
): void {
  // 部件路径安全与去重
  const seen = new Set<string>();
  const allParts = [...model.opaque_parts.map((part) => part.path), ...model.media.map((part) => part.path)];
  for (const path of allParts) {
    if (!isSafePartPath(path)) {
      collector.error('invalid_part_path', `部件路径不安全（R160）：${JSON.stringify(path)}`, {
        part_path: path,
      });
      continue;
    }
    if (seen.has(path)) {
      collector.error('duplicate_part_path', `部件路径重复：${path}`, { part_path: path });
      continue;
    }
    seen.add(path);
  }

  // 内容类型覆盖（warning：缺内容类型写出去是坏包，但导入时常有整表缺失的情形，
  // 由 D02 的导入边界负责补齐；模型层只如实报出）
  for (const path of allParts) {
    if (isSafePartPath(path) && findContentType(model.content_types, path) === null) {
      collector.warn('missing_content_type', `部件没有内容类型声明：${path}`, { part_path: path });
    }
  }

  // 关系 id 唯一与形态。
  //
  // **作用域是「每个 `.rels` 部件」而不是「整个包」**：OOXML 的 `Relationship/@Id` 只在它所属的
  // `.rels` 里唯一（`_rels/.rels` 的 `rId1` 与 `word/_rels/document.xml.rels` 的 `rId1` 可以并存）。
  // 早先这里把所有关系塞进一个全局集合，于是任何**多 `.rels`** 的真实文档（例如 Word 自产的
  // `corpus-c`：包级 rId1/rId2/rId3 + 主部件自己的 rId1…）都会被判成"关系 id 重复"而拒绝导入——
  // 这不是文档的问题，是这条检查把作用域搞错了（WCF-D41 发现）。
  const idsByOwner = new Map<string | null, Set<string>>();
  for (const relationship of model.relationships) {
    const owner = relationship.owner_part_path;
    let seenIds = idsByOwner.get(owner);
    if (seenIds === undefined) {
      seenIds = new Set<string>();
      idsByOwner.set(owner, seenIds);
    }
    if (seenIds.has(relationship.id)) {
      collector.error('duplicate_relationship_id', `关系 id 在同一 .rels 内重复：${relationship.id}`, {
        part_path: owner ?? undefined,
      });
    }
    seenIds.add(relationship.id);
    checkRelationshipTargetMode(collector, relationship);
  }

  // 目标存在性（悬空 rId）
  const scope = derivedScope(model, options);
  const mainDocumentPart = options.main_document_part_path ?? null;
  for (const relationship of model.relationships) {
    if (relationship.target_mode !== 'Internal') {
      continue;
    }
    // R162：错误的 officeDocument 指向必须明确拒绝
    if (
      mainDocumentPart !== null &&
      relationshipTypeHasSuffix(relationship.type, 'officeDocument') &&
      relationship.owner_part_path === null
    ) {
      let resolved: string | null = null;
      try {
        resolved = resolveRelationshipTarget(null, relationship.target);
      } catch {
        resolved = null;
      }
      if (resolved !== null && resolved !== mainDocumentPart) {
        collector.error(
          'invalid_relationship',
          `包级 officeDocument 关系指向 ${resolved}，但主文档部件是 ${mainDocumentPart}（R162）`,
        );
      }
    }

    if (isExternalTarget(relationship.target)) {
      continue;
    }
    let resolved: string;
    try {
      resolved = resolveRelationshipTarget(relationship.owner_part_path, relationship.target);
    } catch (error) {
      collector.error(
        'invalid_relationship_target',
        `关系 ${relationship.id} 的目标无法解析：${relationship.target}` +
          `（${error instanceof Error ? error.message : String(error)}）`,
      );
      continue;
    }
    if (scope.parts.has(resolved)) {
      continue;
    }
    if (scope.declared) {
      collector.error(
        'dangling_relationship_target',
        `关系 ${relationship.id}（owner=${String(relationship.owner_part_path)}）的目标 ${resolved} ` +
          '不在声明的部件集合里——悬空引用必须拒绝（R160）',
        { part_path: resolved },
      );
    } else {
      collector.error(
        'package_scope_undeclared',
        `关系 ${relationship.id} 的目标 ${resolved} 无法确认存在：调用方未声明 known_part_paths，` +
          '无法判定是否悬空。**不把"没查"记成"查过了"**（R160/R166）',
        { part_path: resolved },
      );
    }
  }

  // 媒体 ↔ 关系的双向一致
  for (const media of model.media) {
    const relationship = model.relationships.find((entry) => entry.id === media.relationship_id);
    if (relationship === undefined) {
      collector.error(
        'media_relationship_mismatch',
        `媒体 ${media.path} 绑定的关系 ${media.relationship_id} 不存在（悬空 rId）`,
        { part_path: media.path },
      );
      continue;
    }
    if (relationship.target_mode !== 'Internal') {
      collector.error(
        'media_relationship_mismatch',
        `媒体 ${media.path} 的关系 ${relationship.id} 是 External——媒体必须经由内部关系引用`,
        { part_path: media.path },
      );
      continue;
    }
    let resolved: string | null = null;
    try {
      resolved = resolveRelationshipTarget(relationship.owner_part_path, relationship.target);
    } catch {
      resolved = null;
    }
    if (resolved !== media.path) {
      collector.error(
        'media_relationship_mismatch',
        `媒体 ${media.path} 与其关系 ${relationship.id} 的目标 ${String(resolved)} 不一致`,
        { part_path: media.path },
      );
    }
    if (!media.content_type.startsWith('image/')) {
      collector.warn(
        'invalid_node',
        `媒体 ${media.path} 的内容类型不是 image/*：${media.content_type}`,
        { part_path: media.path },
      );
    }
  }
}

function checkRelationshipTargetMode(collector: ProblemCollector, relationship: RelationshipRecord): void {
  if (relationship.target_mode !== 'Internal' && relationship.target_mode !== 'External') {
    collector.error(
      'invalid_relationship',
      `关系 ${relationship.id} 的 target_mode 非法：${JSON.stringify(relationship.target_mode)}`,
    );
    return;
  }
  if (relationship.target_mode === 'External' && !isExternalTarget(relationship.target)) {
    collector.warn(
      'invalid_relationship',
      `关系 ${relationship.id} 标为 External，但目标没有 URI 方案：${JSON.stringify(relationship.target)}` +
        '（外部关系不抓取，R161）',
    );
  }
  if (relationship.owner_part_path !== null && !isSafePartPath(relationship.owner_part_path)) {
    collector.error(
      'invalid_part_path',
      `关系 ${relationship.id} 的归属部件路径不安全：${JSON.stringify(relationship.owner_part_path)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 整篇检查
// ---------------------------------------------------------------------------

function checkSections(collector: ProblemCollector, sections: readonly SectionProperties[]): void {
  if (!Array.isArray(sections)) {
    collector.error('invalid_document', 'sections 必须是数组');
    return;
  }
  if (sections.length === 0) {
    collector.warn('invalid_document', '文档没有任何节——写出时需要至少一个 sectPr（R108）');
  }
}

/** 全量检查。不抛错——拒绝由 `assertDocumentInvariants` / `createDocumentModel` 负责。 */
export function validateDocument(
  model: DocumentModel,
  options: ValidationOptions = {},
): ValidationReport {
  const collector = new ProblemCollector();

  if (!isRecord(model)) {
    collector.error('invalid_document', '文档模型必须是对象');
    return collector.report();
  }
  if (typeof model.document_id !== 'string' || model.document_id.length === 0) {
    collector.error('invalid_document', 'document_id 必须是非空字符串');
  }
  if (!Number.isInteger(model.revision) || model.revision < 0) {
    collector.error('invalid_document', 'revision 必须是非负整数（R141）');
  }

  if (!Array.isArray(model.blocks)) {
    collector.error('invalid_block_sequence', 'model.blocks 必须是数组');
  } else {
    for (const block of model.blocks) {
      checkBlock(collector, block);
    }
    for (let index = 0; index + 1 < model.blocks.length; index += 1) {
      const current = model.blocks[index];
      const next = model.blocks[index + 1];
      if (current?.kind === 'table' && next?.kind === 'table') {
        collector.warn(
          'adjacent_tables',
          `第 ${String(index)} 与 ${String(index + 1)} 块都是表格且相邻——OOXML 语义下会被合并为一张表`,
          { node_id: current.id },
        );
      }
    }
  }

  // id 唯一性（整篇，含表格内部与批注）
  const seenIds = new Map<NodeId, number>();
  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      if (typeof block.id === 'string') {
        seenIds.set(block.id, (seenIds.get(block.id) ?? 0) + 1);
      }
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) {
          if (typeof inline.id === 'string') {
            seenIds.set(inline.id, (seenIds.get(inline.id) ?? 0) + 1);
          }
        }
        continue;
      }
      if (block.kind !== 'table') {
        // 非法块槽位（例如把 run 放进 blocks）已由 checkBlock 报出，这里跳过以免二次崩。
        continue;
      }
      for (const row of block.rows) {
        if (typeof row.id === 'string') {
          seenIds.set(row.id, (seenIds.get(row.id) ?? 0) + 1);
        }
        for (const cell of row.cells) {
          if (typeof cell.id === 'string') {
            seenIds.set(cell.id, (seenIds.get(cell.id) ?? 0) + 1);
          }
          visitBlocks(cell.blocks);
        }
      }
    }
  };
  if (Array.isArray(model.blocks)) {
    visitBlocks(model.blocks);
  }
  for (const comment of model.comments ?? []) {
    if (typeof comment.id === 'string') {
      seenIds.set(comment.id, (seenIds.get(comment.id) ?? 0) + 1);
    }
  }
  for (const [id, count] of seenIds) {
    if (count > 1) {
      collector.error('duplicate_id', `节点 id 在文档里出现 ${String(count)} 次：${id}`, { node_id: id });
    }
  }

  // 批注锚点
  for (const comment of model.comments ?? []) {
    if (comment.anchor !== null) {
      if (!seenIds.has(comment.anchor.node_id)) {
        collector.error(
          'dangling_comment_anchor',
          `批注 ${comment.id} 锚定到不存在的节点 ${comment.anchor.node_id}（R114：锚随版本失效）`,
          { node_id: comment.id },
        );
      }
    }
  }

  checkSections(collector, model.sections);
  checkPartsAndRelationships(collector, model, options);

  return collector.report();
}

/**
 * 断言整篇不变量；有任何 **error** 即抛 `DocumentModelError`（detail 汇总前若干条）。
 *
 * 只报 error：warning 是"可表示但可疑"，把它升级成拒绝就等于让导入拒绝真实文件。
 */
export function assertDocumentInvariants(
  model: DocumentModel,
  options: ValidationOptions = {},
): void {
  const report = validateDocument(model, options);
  const first = report.errors[0];
  if (first === undefined) {
    return;
  }
  const summary = report.errors
    .slice(0, 5)
    .map((problem) => `${problem.code}(${problem.detail})`)
    .join('；');
  const more = report.errors.length > 5 ? `；另有 ${String(report.errors.length - 5)} 条` : '';
  throw new DocumentModelError(first.code, `${first.detail}｜共 ${String(report.errors.length)} 条错误：${summary}${more}`);
}

/** 一行式报告（证据文本用）。 */
export function describeValidationReport(report: ValidationReport): string {
  const head = report.ok
    ? `通过（0 error，${String(report.warnings.length)} warning）`
    : `拒绝（${String(report.errors.length)} error，${String(report.warnings.length)} warning）`;
  const details = report.problems.map((problem) => `  - [${problem.severity}] ${problem.code}: ${problem.detail}`);
  return [head, ...details].join('\n');
}

/** 供外部判断某个 `source` 是否合法（R109）。 */
export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && SOURCE_KINDS.includes(value);
}
