/**
 * 表格测试夹具（**仅供测试**，不从 `index.ts` 导出）。
 *
 * 命名不以 `.test.ts` 结尾，因此 vitest 不会把它当测试文件收集（沿用
 * `src/documents/model/fixtures.ts` 的做法）。
 *
 * 三张样例表覆盖判据要求的三种形态：
 *
 * | 夹具 | 形态 |
 * |---|---|
 * | `plainTableModel` | 无合并的干净表（增删行列、宽高、对齐的基线） |
 * | `horizontalMergeModel` | 横向合并（第 0 行前两列并成一格） |
 * | `verticalMergeModel` | 纵向合并（第 0 列三行并成一格：restart / continue / continue） |
 * | `rectMergeModel` | 2 列 × 2 行矩形合并（横向与纵向叠加） |
 */

import { createDocumentModel } from '../../model/document.js';
import type { DocumentModel, Length, NodeId } from '../../model/types.js';
import {
  cellNode,
  paragraphNode,
  rowNode,
  runNode,
  tableNode,
  textParagraphNode,
  type DraftBlockNode,
  type DraftCellNode,
  type DraftTableNode,
} from '../../model/nodes.js';
import { findTableById } from '../../model/walk.js';

/** 统一的列宽：40 mm（夹具内部一致，避免与单位换算纠缠）。 */
export const COL: Length = { unit: 'mm', value: 40 };

/** 一个带文字的单元格。 */
export function textCell(text: string, extra: Partial<DraftCellNode> = {}): DraftCellNode {
  return cellNode({
    source: 'imported',
    blocks: [textParagraphNode({ text, source: 'imported' })],
    ...extra,
  });
}

/** 一个空单元格。 */
export function blankCell(extra: Partial<DraftCellNode> = {}): DraftCellNode {
  return cellNode({ source: 'imported', blocks: [textParagraphNode({ text: '', source: 'imported' })], ...extra });
}

/** 用二维文字矩阵造一张干净表（`grid_span` 全 1、无合并）。 */
export function plainTableDraft(values: readonly (readonly string[])[]): DraftTableNode {
  const columns = Math.max(...values.map((line) => line.length));
  return tableNode({
    source: 'imported',
    grid: new Array<Length>(columns).fill(COL),
    rows: values.map((line) =>
      rowNode({
        source: 'imported',
        cells: line.map((text) => textCell(text)),
      }),
    ),
  });
}

/** 一张 3 行 3 列的干净表：`a1..c3`。 */
export function plainTableModel(): DocumentModel {
  return tableDocument(
    plainTableDraft([
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
      ['a3', 'b3', 'c3'],
    ]),
  );
}

/** 横向合并：第 0 行 = [跨 2 列 | c1]，其余两行各 3 格。 */
export function horizontalMergeModel(): DocumentModel {
  return tableDocument(
    tableNode({
      source: 'imported',
      grid: [COL, COL, COL],
      rows: [
        rowNode({
          source: 'imported',
          cells: [textCell('a1', { grid_span: 2 }), textCell('c1')],
        }),
        rowNode({ source: 'imported', cells: [textCell('a2'), textCell('b2'), textCell('c2')] }),
        rowNode({ source: 'imported', cells: [textCell('a3'), textCell('b3'), textCell('c3')] }),
      ],
    }),
  );
}

/** 纵向合并：第 0 列跨 3 行（restart + continue + continue），其余列各自独立。 */
export function verticalMergeModel(): DocumentModel {
  return tableDocument(
    tableNode({
      source: 'imported',
      grid: [COL, COL],
      rows: [
        rowNode({
          source: 'imported',
          cells: [textCell('a1', { vertical_merge: 'restart' }), textCell('b1')],
        }),
        rowNode({
          source: 'imported',
          cells: [blankCell({ vertical_merge: 'continue' }), textCell('b2')],
        }),
        rowNode({
          source: 'imported',
          cells: [blankCell({ vertical_merge: 'continue' }), textCell('b3')],
        }),
      ],
    }),
  );
}

/** 矩形合并：2 列 × 2 行（第 0 行 gridSpan 2 且 restart，第 1 行 gridSpan 2 且 continue）。 */
export function rectMergeModel(): DocumentModel {
  return tableDocument(
    tableNode({
      source: 'imported',
      grid: [COL, COL, COL],
      rows: [
        rowNode({
          source: 'imported',
          cells: [
            textCell('a1', { grid_span: 2, vertical_merge: 'restart' }),
            textCell('c1'),
          ],
        }),
        rowNode({
          source: 'imported',
          cells: [blankCell({ grid_span: 2, vertical_merge: 'continue' }), textCell('c2')],
        }),
        rowNode({ source: 'imported', cells: [textCell('a3'), textCell('b3'), textCell('c3')] }),
      ],
    }),
  );
}

/** 把一张表格草稿放进文档正文（前后各留一段文字，用来验证"表前后段落不损坏"）。 */
export function tableDocument(table: DraftTableNode): DocumentModel {
  const blocks: DraftBlockNode[] = [
    paragraphNode({ source: 'user_request', inlines: [runNode({ text: '表前一段', source: 'user_request' })] }),
    table,
    paragraphNode({ source: 'user_request', inlines: [runNode({ text: '表后一段', source: 'user_request' })] }),
  ];
  return createDocumentModel({ document_id: 'doc-table-fixture', blocks });
}

/** 文档里第一张表的 id。 */
export function firstTableId(model: DocumentModel): NodeId {
  const table = model.blocks.find((block) => block.kind === 'table');
  if (table === undefined) {
    throw new Error('夹具使用错误：文档里没有表格');
  }
  return table.id;
}

/** 文档里第一张表（找不到即抛）。 */
export function tableOf(model: DocumentModel): NonNullable<ReturnType<typeof findTableById>> {
  const table = findTableById(model, firstTableId(model));
  if (table === null) {
    throw new Error('夹具使用错误：找不到表格');
  }
  return table;
}

/** 取某行某列文件格里的**全部**文字（多个块串接，越界即抛，避免测试里到处写 `!`）。 */
export function cellTextAt(model: DocumentModel, row: number, column: number): string {
  const table = tableOf(model);
  const line = table.rows[row];
  if (line === undefined) {
    throw new Error(`夹具取值失败：第 ${String(row)} 行不存在`);
  }
  const cell = line.cells[column];
  if (cell === undefined) {
    throw new Error(`夹具取值失败：第 ${String(row)} 行第 ${String(column)} 格不存在`);
  }
  return cell.blocks
    .map((block) =>
      block.kind !== 'paragraph'
        ? ''
        : block.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '')).join(''),
    )
    .join('');
}

/** 行数 / 列数速览。 */
export function shapeOf(model: DocumentModel): { readonly rows: number; readonly columns: number } {
  const table = tableOf(model);
  return { rows: table.rows.length, columns: table.grid.length };
}
