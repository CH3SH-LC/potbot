/**
 * 表格内容编辑与文本 ⇄ 表格互转（WF-064）。
 *
 * ## 三条纪律
 *
 * 1. **不伪造数据**：替换只替换**字面上找得到**的文本，找不到就说找到 0 处（`R112`：
 *    不是静默无操作）；互转时单元格里的内容全部来自原文，缺的位置留**空**，
 *    绝不填"（空）""N/A"这类编造的值。
 * 2. **不丢字符格式**：文本 → 表格时按分隔符切分 run，**每个片段继承原 run 的属性**
 *    （加粗的 `a` 转成单元格后仍然加粗），不是把整段拍扁成纯文本再重建。
 * 3. **只管表格自己的字**：`replaceTextInTable` 只在目标表格的单元格里替换，
 *    表格外的正文一个字都不碰（测试用"表外段落对象引用不变"钉住）。
 *
 * ## 互转的确定性规则（写在这里，不在实现里各写各的）
 *
 * - **表格 → 文本**：一行一段；同一行内各单元格的文本用 `separator` 连接；
 *   单元格内多个块（段落）的文本用空格连接。空单元格 ⇒ 空串（不补占位符）。
 * - **文本 → 表格**：一段一行；段内文本按 `separator` 切分成单元格；
 *   列数取各行切分结果的最大值，**短行右侧补空单元格**（补的是空，不是假数据）。
 */

import { DocumentModelError } from '../../model/errors.js';
import { cloneRunProperties } from '../paragraph/clone.js';
import {
  breakNode,
  cellNode,
  equationNode,
  fieldNode,
  drawingNode,
  paragraphNode,
  rowNode,
  runNode,
  tableNode,
  textParagraphNode,
  type DraftInlineNode,
  type DraftTableNode,
} from '../../model/nodes.js';
import { applyStructureBatch, type StructureEdit } from '../../model/structure.js';
import type {
  BlockNode,
  CellNode,
  DocumentModel,
  InlineNode,
  NodeId,
  ParagraphNode,
  SourceKind,
  TableNode,
} from '../../model/types.js';
import { requireCleanGrid, requireTable, withTable } from './edit.js';
import { buildGridMap } from './grid.js';
import { runTableEdit, type TableOutcome } from './types.js';

// ---------------------------------------------------------------------------
// 查找替换（表格内）
// ---------------------------------------------------------------------------

/** 表格内查找替换请求。 */
export interface ReplaceTextRequest {
  readonly table_id: NodeId;
  readonly find: string;
  readonly replace: string;
}

/** 替换结果。 */
export interface ReplaceTextSuccess {
  readonly model: DocumentModel;
  /** 实际替换的次数（0 次不是错误，是事实）。 */
  readonly replaced: number;
  /** 发生替换的单元格 id。 */
  readonly cell_ids: readonly NodeId[];
}

/**
 * 在表格单元格里做字面文本替换（WF-064）。
 *
 * `find` 为空串、或表格里一处都找不到时**返回事实**（`replaced: 0`）而不是抛错——
 * "没找到"是可解释结果，不是失败（调用方可据此提示用户）。
 */
export function replaceTextInTable(
  model: DocumentModel,
  request: ReplaceTextRequest,
): TableOutcome<ReplaceTextSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    if (request.find.length === 0) {
      throw new DocumentModelError('unsupported', '查找文本不能为空串（否则语义是"在每个字符间插入"）');
    }
    let replaced = 0;
    const hitCells: NodeId[] = [];

    const rows = table.rows.map((row) => {
      let rowChanged = false;
      const cells = row.cells.map((cell) => {
        let cellReplaced = 0;
        const blocks = cell.blocks.map((block) => {
          if (block.kind !== 'paragraph') {
            return block;
          }
          let changed = false;
          const inlines = block.inlines.map((inline) => {
            if (inline.kind !== 'run' || !inline.text.includes(request.find)) {
              return inline;
            }
            const occurrences = inline.text.split(request.find).length - 1;
            changed = true;
            cellReplaced += occurrences;
            return { ...inline, text: inline.text.split(request.find).join(request.replace) };
          });
          return changed ? { ...block, inlines } : block;
        });
        if (cellReplaced > 0) {
          replaced += cellReplaced;
          hitCells.push(cell.id);
          rowChanged = true;
        }
        return cellReplaced > 0 ? { ...cell, blocks } : cell;
      });
      return rowChanged ? { ...row, cells } : row;
    });

    if (replaced === 0) {
      return { model, replaced: 0, cell_ids: [] };
    }
    return { model: withTable(model, request.table_id, { ...table, rows }), replaced, cell_ids: hitCells };
  });
}

// ---------------------------------------------------------------------------
// 表格 → 文本
// ---------------------------------------------------------------------------

/** 表格转文本请求。 */
export interface TableToTextRequest {
  readonly table_id: NodeId;
  /** 同一行内单元格之间的连接符（如 `\t` 用于制表符分隔）。 */
  readonly separator: string;
}

/** 表格转文本结果。 */
export interface TableToTextSuccess {
  readonly model: DocumentModel;
  /** 转出的段落数（= 表格行数）。 */
  readonly paragraphs: number;
  /** 转出的文本（供上层回显/核对；与模型里的内容一字不差）。 */
  readonly text: string;
}

function inlineText(inline: InlineNode): string {
  return inline.kind === 'run' ? inline.text : '';
}

/** 一个单元格的可见文本：块之间用空格连接（块内 run 拼接、软换行视作空格）。 */
function cellText(cell: CellNode): string {
  return cell.blocks
    .map((block) =>
      block.kind !== 'paragraph'
        ? ''
        : block.inlines
            .map((inline) => (inline.kind === 'break' ? ' ' : inlineText(inline)))
            .join(''),
    )
    .join(' ');
}

/**
 * 表格 → 文本（WF-064）：一行一段，行内单元格用 `separator` 连接。
 *
 * 转出的段落 `source` 沿用原表格的 `source`（内容是从原文里取出来的，
 * **不冒充**成用户新说的话，R109/R148）。
 */
export function tableToText(model: DocumentModel, request: TableToTextRequest): TableOutcome<TableToTextSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const index = model.blocks.findIndex((block) => block.id === request.table_id);
    if (index === -1) {
      throw new DocumentModelError(
        'unknown_node',
        `表格 ${JSON.stringify(request.table_id)} 不在正文里（嵌套表格暂不支持转文本）`,
      );
    }
    const lines = table.rows.map((row) => row.cells.map((cell) => cellText(cell)).join(request.separator));
    const source: SourceKind = table.source;

    // **一行一段**：R104 禁止把换行塞进 run 文本（`text_contains_break_character`），
    // 所以不能拼成"一个含 \n 的段落"，而是每行各成一段。
    const edits: StructureEdit[] = lines.map(
      (line, offset): StructureEdit => ({
        kind: 'insert_block',
        container: { kind: 'body' },
        // 逐行插在 `index + offset`：同一下标连着插会把顺序插反。
        index: index + offset,
        block: textParagraphNode({ text: line, source }),
      }),
    );
    // 用 id 删除原表（不依赖下标），与上面的插入同批次 ⇒ 全成或全不成。
    edits.push({ kind: 'remove_block', block_id: request.table_id });
    const outcome = applyStructureBatch(model, edits);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '表格转文本失败');
    }
    return {
      model: outcome.model,
      paragraphs: lines.length,
      text: lines.join('\n'),
    };
  });
}

// ---------------------------------------------------------------------------
// 文本 → 表格
// ---------------------------------------------------------------------------

/** 文本转表格请求。 */
export interface TextToTableRequest {
  /** 要转换的正文块区间（含端点）。区间内必须全部是段落。 */
  readonly from_index: number;
  readonly to_index: number;
  readonly separator: string;
  readonly source?: SourceKind;
}

/** 文本转表格结果。 */
export interface TextToTableSuccess {
  readonly model: DocumentModel;
  readonly table_id: NodeId;
  readonly rows: number;
  readonly columns: number;
}

/** 把一段的行内节点按分隔符切成若干组（**保留每个片段的 run 属性**）。 */
export function splitInlinesOnSeparator(
  paragraph: ParagraphNode,
  separator: string,
): readonly (readonly DraftInlineNode[])[] {
  const groups: DraftInlineNode[][] = [[]];
  const current = (): DraftInlineNode[] => groups[groups.length - 1] as DraftInlineNode[];

  for (const inline of paragraph.inlines) {
    if (inline.kind === 'run') {
      const parts = inline.text.split(separator);
      parts.forEach((part, partIndex) => {
        if (partIndex > 0) {
          groups.push([]);
        }
        current().push(
          runNode({
            text: part,
            source: inline.source,
            properties: cloneRunProperties(inline.properties),
            opaque: inline.opaque,
          }),
        );
      });
      continue;
    }
    if (inline.kind === 'break') {
      current().push(breakNode({ breakType: inline.breakType, source: inline.source, opaque: inline.opaque }));
      continue;
    }
    if (inline.kind === 'drawing') {
      // 图形不含分隔符文本，整块留在当前组里（切分只针对 run 的文本）。
      current().push(drawingNode({ ...inline, opaque: inline.opaque }));
      continue;
    }
    if (inline.kind === 'equation') {
      // 公式同样不含分隔符文本，整块留在当前组里——与图形同一处置（design-05-P9）。
      // 漏改这里**不会报编译错**（下面的 `fieldNode` 收窄会把公式误当域读取而抛），
      // 因此必须显式列在前面。
      current().push(
        equationNode({
          equation_id: inline.equation_id,
          content: inline.content,
          source: inline.source,
          opaque: inline.opaque,
        }),
      );
      continue;
    }
    current().push(
      fieldNode({
        instruction: inline.instruction,
        cached_result: inline.cached_result,
        refresh_state: inline.refresh_state,
        source: inline.source,
        opaque: inline.opaque,
      }),
    );
  }
  return groups;
}

/**
 * 文本 → 表格（WF-064）：一段一行，段内按 `separator` 切分成单元格。
 *
 * - 区间里有非段落块（例如另一张表）⇒ `unsupported`（不猜"表格怎么嵌表格"）；
 * - 各行切出的列数不必相同：**取最大值**，短行右侧**补空单元格**（补空，不补假数据）；
 * - 插入的表取代被转换的那批段落：两者在**同一批次**里完成（R136 原子性）。
 */
export function textToTable(model: DocumentModel, request: TextToTableRequest): TableOutcome<TextToTableSuccess> {
  return runTableEdit(() => {
    const { from_index: from, to_index: to } = request;
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to >= model.blocks.length
    ) {
      throw new DocumentModelError(
        'invalid_index',
        `块区间非法：[${String(from)}, ${String(to)}]（正文共 ${String(model.blocks.length)} 块）`,
      );
    }
    if (request.separator.length === 0) {
      throw new DocumentModelError('unsupported', '分隔符不能为空串');
    }
    const source: SourceKind = request.source ?? 'user_request';
    const range: readonly BlockNode[] = model.blocks.slice(from, to + 1);
    const paragraphs: ParagraphNode[] = [];
    for (const block of range) {
      if (block.kind !== 'paragraph') {
        throw new DocumentModelError(
          'unsupported',
          `块区间里含 ${block.kind}（不是段落）——文本转表格不支持把表格/其它块一并转`,
        );
      }
      paragraphs.push(block);
    }

    const splitRows = paragraphs.map((paragraph) => splitInlinesOnSeparator(paragraph, request.separator));
    const columns = Math.max(1, ...splitRows.map((groups) => groups.length));
    const template = paragraphs[0];
    const table: DraftTableNode = tableNode({
      source,
      rows: splitRows.map((groups) =>
        rowNode({
          source,
          cells: Array.from({ length: columns }, (_unused, index) => {
            const inlines = groups[index];
            return cellNode({
              source,
              blocks: [
                paragraphNode({
                  source,
                  inlines: inlines === undefined ? [] : [...inlines],
                  ...(template === undefined ? {} : { properties: template.properties }),
                  ...(template === undefined || template.style_ref === null
                    ? {}
                    : { style_ref: template.style_ref }),
                }),
              ],
            });
          }),
        }),
      ),
    });

    // 一张表替换掉 [from, to] 这批段落：先插表，再按 id 删掉每个段落（同一批次，全成或全不成）。
    const edits: StructureEdit[] = [
      { kind: 'insert_block', container: { kind: 'body' }, index: from, block: table },
      ...paragraphs.map((paragraph): StructureEdit => ({ kind: 'remove_block', block_id: paragraph.id })),
    ];
    const outcome = applyStructureBatch(model, edits);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '文本转表格失败');
    }
    const inserted = outcome.model.blocks[from];
    if (inserted === undefined || inserted.kind !== 'table') {
      throw new DocumentModelError('invalid_block_sequence', '文本转表格后定位不到新表格（实现缺陷）');
    }
    const map = buildGridMap(inserted);
    const problem = map.problems[0];
    if (problem !== undefined) {
      throw new DocumentModelError(
        'table_shape_invalid',
        `文本转表格生成了病态网格（实现缺陷）：${problem.kind}`,
      );
    }
    return {
      model: outcome.model,
      table_id: inserted.id,
      rows: inserted.rows.length,
      columns: map.column_count,
    };
  });
}

/** 供上层核对：表格的逐格文本（只读）。 */
export function tableTexts(table: TableNode): readonly (readonly string[])[] {
  requireCleanGrid(table, '读取表格文本');
  return table.rows.map((row) => row.cells.map((cell) => cellText(cell)));
}
