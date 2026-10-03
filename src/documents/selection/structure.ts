/**
 * 文档结构遍历（只读定位 + 最小重建）。
 *
 * ## 文档顺序
 *
 * "第 N 段"里的 **N 按文档顺序**数，**含表格单元格内的段落**——否则"第 12 段"在含表格的
 * 文档里会指到别处。表格按行列顺序递归展开：`blocks → table → rows → cells → blocks → …`。
 *
 * ## 最小重建
 *
 * `replaceParagraphById` 只在**命中路径**上新建对象；未命中的分支返回**原引用**。
 * 这样"只改一段"时，其余块对象在 JS 层也保持同一性，便于上层做变更检测与缓存失效；
 * 对应到 XML 层就是 R151 的"未修改部件尽量字节级不变"（真正的字节保留由 D02 负责）。
 */

import type {
  BlockNode,
  CellNode,
  DocumentModel,
  NodeId,
  ParagraphNode,
  RowNode,
  TableNode,
} from '../model/types.js';
import { buildInlineTextMap } from './inline-map.js';
import { fail, succeed, type DocumentRange, type Result } from './types.js';

/** 按文档顺序收集全部段落（含表格单元格内段落）。 */
export function collectParagraphs(blocks: readonly BlockNode[]): readonly ParagraphNode[] {
  const out: ParagraphNode[] = [];
  const visitBlocks = (list: readonly BlockNode[]): void => {
    for (const block of list) {
      if (block.kind === 'paragraph') {
        out.push(block);
      } else {
        visitTable(block);
      }
    }
  };
  const visitTable = (table: TableNode): void => {
    for (const row of table.rows) {
      for (const cell of row.cells) visitBlocks(cell.blocks);
    }
  };
  visitBlocks(blocks);
  return out;
}

/** 按文档顺序收集全部表格（不含嵌套表格——本模型单元格内可再含表，但这里只取顶层顺序）。 */
export function collectTables(blocks: readonly BlockNode[]): readonly TableNode[] {
  const out: TableNode[] = [];
  for (const block of blocks) {
    if (block.kind === 'table') out.push(block);
  }
  return out;
}

/** 段落内行内序列拼出的文本（码位；软换行为 `'\n'`）。 */
export function paragraphText(paragraph: ParagraphNode): string {
  return buildInlineTextMap(paragraph.inlines).text;
}

/** 整段的完整范围。 */
export function paragraphFullRange(paragraph: ParagraphNode): DocumentRange {
  return {
    node_id: paragraph.id,
    start: 0,
    end: buildInlineTextMap(paragraph.inlines).total,
  };
}

/** 按稳定 id 找段落（含表格内）；找不到返回 `null`。 */
export function findParagraphById(blocks: readonly BlockNode[], id: NodeId): ParagraphNode | null {
  for (const paragraph of collectParagraphs(blocks)) {
    if (paragraph.id === id) return paragraph;
  }
  return null;
}

function replaceInCells(
  cells: readonly CellNode[],
  id: NodeId,
  next: ParagraphNode,
): readonly CellNode[] | null {
  let changed = false;
  const mapped = cells.map((cell) => {
    const replaced = replaceParagraphInBlocks(cell.blocks, id, next);
    if (replaced === null) return cell;
    changed = true;
    return { ...cell, blocks: replaced };
  });
  return changed ? mapped : null;
}

function replaceInRows(
  rows: readonly RowNode[],
  id: NodeId,
  next: ParagraphNode,
): readonly RowNode[] | null {
  let changed = false;
  const mapped = rows.map((row) => {
    const cells = replaceInCells(row.cells, id, next);
    if (cells === null) return row;
    changed = true;
    return { ...row, cells };
  });
  return changed ? mapped : null;
}

/**
 * 用 `next` 替换 id 匹配的段落。命中返回新块数组；**未命中返回 `null`**（调用方据此报
 * `unknown_node`，而不是"悄悄没改"）。
 */
export function replaceParagraphInBlocks(
  blocks: readonly BlockNode[],
  id: NodeId,
  next: ParagraphNode,
): readonly BlockNode[] | null {
  let changed = false;
  const mapped = blocks.map((block) => {
    if (block.kind === 'paragraph') {
      if (block.id !== id) return block;
      changed = true;
      return next;
    }
    const rows = replaceInRows(block.rows, id, next);
    if (rows === null) return block;
    changed = true;
    return { ...block, rows, grid: block.grid };
  });
  return changed ? mapped : null;
}

/** 模型级替换：改不了就报 `unknown_node`，绝不静默失败（R136 的原子性由此保住）。 */
export function replaceParagraph(model: DocumentModel, id: NodeId, next: ParagraphNode): Result<DocumentModel> {
  const blocks = replaceParagraphInBlocks(model.blocks, id, next);
  if (blocks === null) {
    return fail('unknown_node', `文档中不存在 id 为 "${id}" 的段落。`, { extra: { node_id: id } });
  }
  return succeed({ ...model, blocks });
}

/** 取段落；不存在时报 `unknown_node`。 */
export function requireParagraph(model: DocumentModel, id: NodeId): Result<ParagraphNode> {
  const found = findParagraphById(model.blocks, id);
  if (found === null) {
    return fail('unknown_node', `文档中不存在 id 为 "${id}" 的段落。`, { extra: { node_id: id } });
  }
  return succeed(found);
}

/** 表格第 R 行第 C 列（均 1 起）。 */
export function tableCell(table: TableNode, row: number, column: number): CellNode | null {
  const rowNode = table.rows[row - 1];
  if (rowNode === undefined) return null;
  const cell = rowNode.cells[column - 1];
  return cell ?? null;
}

/** 单元格内全部段落（按文档顺序）。 */
export function cellParagraphs(cell: CellNode): readonly ParagraphNode[] {
  return collectParagraphs(cell.blocks);
}

/** 表格内全部段落（按文档顺序）。 */
export function tableParagraphs(table: TableNode): readonly ParagraphNode[] {
  const out: ParagraphNode[] = [];
  for (const row of table.rows) {
    for (const cell of row.cells) out.push(...collectParagraphs(cell.blocks));
  }
  return out;
}
