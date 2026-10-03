/**
 * 测试夹具（**仅供测试**，不从 `index.ts` 导出）。
 *
 * 放在本目录而不是 `tests/`，是因为本包的写权范围就只有 `src/documents/model/**`；
 * 文件名不以 `.test.ts` 结尾，故 vitest 不会把它当测试文件收集。
 */

import { createDocumentModel } from './document.js';
import type { ValidationReport } from './validation.js';
import type {
  BlockNode,
  CellNode,
  ParagraphNode,
  RowNode,
  TableNode,
} from './types.js';
import {
  breakNode,
  cellNode,
  commentNode,
  paragraphNode,
  rowNode,
  runNode,
  tableNode,
  textParagraphNode,
  type DraftBlockNode,
  type DraftTableNode,
} from './nodes.js';
import type { DocumentModel, Length } from './types.js';

export const COLUMN_WIDTH: Length = { unit: 'mm', value: 40 };

/** 一张 2×2 的干净表格（两行两列，无合并，带网格定义）。 */
export function twoByTwoTable(): DraftTableNode {
  return tableNode({
    source: 'imported',
    grid: [COLUMN_WIDTH, COLUMN_WIDTH],
    rows: [0, 1].map((row) =>
      rowNode({
        source: 'imported',
        cells: [0, 1].map((column) =>
          cellNode({
            source: 'imported',
            blocks: [textParagraphNode({ text: `r${String(row)}c${String(column)}`, source: 'imported' })],
          }),
        ),
      }),
    ),
  });
}

/**
 * 一段刻意"难看"的文本：行首空格、连续两个空格、tab。
 *
 * R104 的判据就是"读回来必须逐字符还是这一串"。
 */
export const AWKWARD_TEXT = '  保留   空白\t与 tab  ';

/** 默认正文：两段文字 + 一段含软换行 + 一张表。 */
export function sampleBlocks(): readonly DraftBlockNode[] {
  return [
    textParagraphNode({ text: '第一段', source: 'user_request' }),
    textParagraphNode({ text: '第二段', source: 'user_request' }),
    paragraphNode({
      source: 'imported',
      inlines: [
        runNode({ text: '软换行前', source: 'imported' }),
        breakNode({ breakType: 'line', source: 'imported' }),
        runNode({ text: AWKWARD_TEXT, source: 'imported' }),
      ],
    }),
    twoByTwoTable(),
  ];
}

// ---------------------------------------------------------------------------
// 取值辅助（越界即抛，避免测试里到处写 `!`）
// ---------------------------------------------------------------------------

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`夹具取值失败：${what} 不存在`);
  }
  return value;
}

export function blockAt(model: DocumentModel, index: number): BlockNode {
  return must(model.blocks[index], `第 ${String(index)} 块`);
}

export function paragraphBlockAt(model: DocumentModel, index: number): ParagraphNode {
  const block = blockAt(model, index);
  if (block.kind !== 'paragraph') {
    throw new Error(`夹具取值失败：第 ${String(index)} 块不是段落（${block.kind}）`);
  }
  return block;
}

export function tableBlockAt(model: DocumentModel, index: number): TableNode {
  const block = blockAt(model, index);
  if (block.kind !== 'table') {
    throw new Error(`夹具取值失败：第 ${String(index)} 块不是表格（${block.kind}）`);
  }
  return block;
}

export function rowAt(table: TableNode, index: number): RowNode {
  return must(table.rows[index], `第 ${String(index)} 行`);
}

export function cellOf(table: TableNode, row: number, column: number): CellNode {
  return must(rowAt(table, row).cells[column], `第 ${String(row)} 行第 ${String(column)} 个单元格`);
}

export function errorCodes(report: ValidationReport): readonly string[] {
  return report.errors.map((problem) => problem.code);
}

export function warningCodes(report: ValidationReport): readonly string[] {
  return report.warnings.map((problem) => problem.code);
}

/** 本文档模型：含正文、一张表与一条已锚定的批注。 */
export function sampleDocument(blocks?: readonly DraftBlockNode[]): DocumentModel {
  return createDocumentModel({
    document_id: 'doc-fixture',
    blocks: blocks ?? sampleBlocks(),
    comments: [
      commentNode({
        author: '诚哥',
        text: '这段要改',
        source: 'user_request',
        // 锚到第 1 段（`n/body:0/paragraph:0`）
        anchor: { path: [{ kind: 'body', index: 0 }, { kind: 'paragraph', index: 0 }], start: 0, end: 2 },
      }),
    ],
  });
}
