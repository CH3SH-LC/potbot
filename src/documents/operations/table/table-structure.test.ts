/**
 * 表格增删与行列增删测试（WF-056 / WF-057）。
 *
 * 判据对应：
 * - "插入 / 删除表格：行列数明确；表前后段落不损坏" → 段落对象引用不变 + 相邻表格被隔开；
 * - "增删行列：首 / 中 / 尾插入删除，相关合并关系保持" → 纵向链在插入行后**仍然自洽**
 *   （用 `validateDocument` 的 error 集合断言，而不是只看某个字段）。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel, describeDocumentModel } from '../../model/document.js';
import { cellNode, tableNode, textParagraphNode, paragraphNode, runNode } from '../../model/nodes.js';
import type { DraftTableNode } from '../../model/nodes.js';
import { validateDocument } from '../../model/validation.js';
import type { DocumentModel, TableNode } from '../../model/types.js';
import { buildGridMap, cellAt, gridIsClean } from './grid.js';
import {
  tableGridIsClean,
  deleteTable,
  insertColumn,
  insertRow,
  insertTable,
  neighboringColumnWidth,
  normalizeVerticalMergeChains,
  removeColumn,
  removeRow,
} from './table-structure.js';
import {
  COL,
  blankCell,
  cellTextAt,
  firstTableId,
  plainTableDraft,
  plainTableModel,
  tableOf,
  textCell,
  verticalMergeModel,
} from './fixtures.js';

/** 文档必须有零 error（warning 允许——例如导入语料的既有告警）。 */
function errorCount(model: DocumentModel): number {
  return validateDocument(model).errors.length;
}

describe('插入表格（WF-056）', () => {
  const draft = plainTableDraft([
    ['x', 'y'],
    ['z', 'w'],
  ]);

  /** 两个段落、没有表的基础文档（用于"插在两段之间"这类干净起点）。 */
  function twoParagraphs(): DocumentModel {
    return createDocumentModel({
      document_id: 'doc-two-paragraphs',
      blocks: [
        paragraphNode({ source: 'user_request', inlines: [runNode({ text: '上', source: 'user_request' })] }),
        paragraphNode({ source: 'user_request', inlines: [runNode({ text: '下', source: 'user_request' })] }),
      ],
    });
  }

  it('插在两个段落之间：段落对象引用不变，不需要额外段落', () => {
    const model = twoParagraphs();
    const outcome = insertTable(model, { index: 1, table: draft });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.separator_inserted).toBe(false);
    expect(outcome.trailing_paragraph_added).toBe(false);
    expect(outcome.model.blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    // 表前后段落仍是同一批对象（"表前后段落不损坏"的对象层证据）。
    expect(outcome.model.blocks[0]).toBe(model.blocks[0]);
    expect(outcome.model.blocks[2]).toBe(model.blocks[1]);
    expect(outcome.model.blocks[outcome.block_index]?.id).toBe(outcome.table_id);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('插在既有表格旁：自动插一个隔离段落（避免 Word 把两张表并成一张）', () => {
    const model = plainTableModel(); // [段, 表, 段]
    const outcome = insertTable(model, { index: 1, table: draft });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.separator_inserted).toBe(true);
    const kinds = outcome.model.blocks.map((block) => block.kind);
    // 不允许出现相邻的两个 'table'。
    for (let index = 1; index < kinds.length; index += 1) {
      expect(`${kinds[index - 1]}+${kinds[index]}`).not.toBe('table+table');
    }
    expect(outcome.model.blocks[outcome.block_index]?.kind).toBe('table');
  });

  it('插到末尾：补一个尾随空段落（表后仍可继续编辑）', () => {
    const model = twoParagraphs();
    const outcome = insertTable(model, { index: model.blocks.length, table: draft });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.trailing_paragraph_added).toBe(true);
    const kinds = outcome.model.blocks.map((block) => block.kind);
    expect(kinds).toEqual(['paragraph', 'paragraph', 'table', 'paragraph']);
    expect(outcome.model.blocks[outcome.block_index]?.kind).toBe('table');
  });

  it('位置越界 ⇒ invalid_index，模型不变', () => {
    const model = twoParagraphs();
    const before = describeDocumentModel(model);
    const outcome = insertTable(model, { index: 99, table: draft });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_index');
    expect(describeDocumentModel(model)).toBe(before);
  });

  it('可以关掉自动隔开（调用方自担相邻表格的后果）', () => {
    const model = plainTableModel(); // [段, 表, 段]
    const outcome = insertTable(model, {
      index: 1,
      table: draft,
      separate_adjacent_tables: false,
      ensure_trailing_paragraph: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.separator_inserted).toBe(false);
    expect(outcome.trailing_paragraph_added).toBe(false);
    expect(outcome.model.blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'table', 'paragraph']);
  });
});

describe('删除表格（WF-056）', () => {
  it('删表不动段落（引用不变），且模型仍然合法', () => {
    const model = plainTableModel();
    const outcome = deleteTable(model, { table_id: firstTableId(model) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
    expect(outcome.model.blocks[0]).toBe(model.blocks[0]);
    expect(outcome.model.blocks[1]).toBe(model.blocks[2]);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('删掉夹在两表之间的表 ⇒ 补隔离段落，避免两表相邻', () => {
    const middle = plainTableDraft([['m']]);
    const model = createDocumentModel({
      document_id: 'doc-three-tables',
      blocks: [tableNode({ source: 'imported', grid: [COL], rows: [] }), middle, tableNode({ source: 'imported', grid: [COL], rows: [] })],
    });
    const middleId = model.blocks[1]?.id;
    expect(middleId).toBeDefined();
    const outcome = deleteTable(model, { table_id: middleId as string });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.separator_inserted).toBe(true);
    const kinds = outcome.model.blocks.map((block) => block.kind);
    for (let index = 1; index < kinds.length; index += 1) {
      expect(`${kinds[index - 1]}+${kinds[index]}`).not.toBe('table+table');
    }
  });

  it('删不存在的表 ⇒ unknown_node，模型不变', () => {
    const model = plainTableModel();
    const before = describeDocumentModel(model);
    const outcome = deleteTable(model, { table_id: 'nope' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unknown_node');
    expect(describeDocumentModel(model)).toBe(before);
  });
});

describe('插入行（WF-057）', () => {
  it('干净表：自动生成的行列数与表格一致，内容是空占位', () => {
    const model = plainTableModel();
    const outcome = insertRow(model, { table_id: firstTableId(model), index: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.rows.length).toBe(4);
    expect(gridIsClean(table)).toBe(true);
    expect(cellTextAt(outcome.model, 1, 0)).toBe('');
    // 模板行的属性被复制（结构与列数一致）。
    expect(table.rows[1]?.cells.length).toBe(3);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('首 / 中 / 尾三个位置都能插，且每行都保持 3 列', () => {
    for (const index of [0, 1, 3]) {
      const model = plainTableModel();
      const outcome = insertRow(model, { table_id: firstTableId(model), index });
      expect(outcome.ok, `index=${String(index)}`).toBe(true);
      if (!outcome.ok) continue;
      const table = tableOf(outcome.model);
      expect(table.rows.length, `index=${String(index)}`).toBe(4);
      expect(buildGridMap(table).problems, `index=${String(index)}`).toEqual([]);
    }
  });

  it('插进纵向合并链的中间：新行接住链（continue），链仍自洽', () => {
    const model = verticalMergeModel();
    const outcome = insertRow(model, { table_id: firstTableId(model), index: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.continued_merges).toBe(1);
    const table = tableOf(outcome.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual([
      'restart',
      'continue',
      'continue',
      'continue',
    ]);
    expect(errorCount(outcome.model)).toBe(0);
    expect(tableGridIsClean(table)).toBe(true);
    // 合并区确实变高了：4 行。
    expect(buildGridMap(table).row_count).toBe(4);
  });

  it('插在合并链顶端之前：新行不接链，链起点仍在原处', () => {
    const model = verticalMergeModel();
    const outcome = insertRow(model, { table_id: firstTableId(model), index: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual([
      null,
      'restart',
      'continue',
      'continue',
    ]);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('明确给了 cells：列数不符 ⇒ table_shape_invalid', () => {
    const model = plainTableModel();
    const before = describeDocumentModel(model);
    const outcome = insertRow(model, {
      table_id: firstTableId(model),
      index: 0,
      cells: [textCell('only-one')],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('table_shape_invalid');
    expect(describeDocumentModel(model)).toBe(before);
  });

  it('明确给了 cells 却没接住合并链 ⇒ column_span_conflict，模型不变', () => {
    const model = verticalMergeModel();
    const before = describeDocumentModel(model);
    const outcome = insertRow(model, {
      table_id: firstTableId(model),
      index: 1,
      cells: [blankCell(), textCell('new')],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('column_span_conflict');
    expect(outcome.detail).toContain('continue');
    expect(describeDocumentModel(model)).toBe(before);
  });

  it('明确给了 cells 且接住链 ⇒ 成功，链保持', () => {
    const model = verticalMergeModel();
    const outcome = insertRow(model, {
      table_id: firstTableId(model),
      index: 2,
      cells: [blankCell({ vertical_merge: 'continue' }), textCell('new')],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual([
      'restart',
      'continue',
      'continue',
      'continue',
    ]);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('位置越界 ⇒ invalid_index', () => {
    const model = plainTableModel();
    const outcome = insertRow(model, { table_id: firstTableId(model), index: 9 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_index');
  });
});

describe('删除行（WF-057）', () => {
  it('删中间行：链保持自洽（restart 还在）', () => {
    const model = verticalMergeModel();
    const outcome = removeRow(model, { table_id: firstTableId(model), index: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.repaired_continues).toBe(0);
    const table = tableOf(outcome.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual(['restart', 'continue']);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('删掉链的起点行 ⇒ 下一行就地升格为 restart（修复次数如实报出）', () => {
    const model = verticalMergeModel();
    const outcome = removeRow(model, { table_id: firstTableId(model), index: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.repaired_continues).toBe(1);
    const table = tableOf(outcome.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual(['restart', 'continue']);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('删完链尾行：链条变短但不断', () => {
    const model = verticalMergeModel();
    const outcome = removeRow(model, { table_id: firstTableId(model), index: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual(['restart', 'continue']);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('最后一行不能删 ⇒ table_shape_invalid', () => {
    const model = createDocumentModel({
      document_id: 'doc-single-row',
      blocks: [plainTableDraft([['only']])],
    });
    const outcome = removeRow(model, { table_id: firstTableId(model), index: 0 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('table_shape_invalid');
  });

  it('normalizeVerticalMergeChains 能独立使用（自顶向下修复）', () => {
    const table = tableOf(verticalMergeModel());
    const broken: TableNode = {
      ...table,
      rows: table.rows.slice(1),
    };
    const repaired = normalizeVerticalMergeChains(broken);
    expect(repaired.repaired).toBe(1);
    expect(repaired.table.rows[0]?.cells[0]?.vertical_merge).toBe('restart');
  });
});

describe('插入 / 删除列（WF-057）', () => {
  it('插入列：所有行同位置加一格，网格仍然干净，列宽取左邻', () => {
    const model = plainTableModel();
    const outcome = insertColumn(model, { table_id: firstTableId(model), index: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.grid.length).toBe(4);
    expect(table.rows.every((row) => row.cells.length === 4)).toBe(true);
    expect(outcome.width).toEqual(COL);
    expect(tableGridIsClean(table)).toBe(true);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('插到跨列合并格内部 ⇒ column_span_conflict（列插入会切断合并）', () => {
    // 造一张"第 0 行是一个 gridSpan=2 的格子"的表。
    const withSpan = createDocumentModel({
      document_id: 'doc-span',
      blocks: [
        tableNode({
          source: 'imported',
          grid: [COL, COL],
          rows: [
            {
              kind: 'row',
              source: 'imported',
              opaque: [],
              height: { state: 'unspecified' },
              header: false,
              cells: [
                cellNode({
                  source: 'imported',
                  grid_span: 2,
                  blocks: [textParagraphNode({ text: 'wide', source: 'imported' })],
                }),
              ],
            },
          ],
        }),
      ],
    });
    const outcome = insertColumn(withSpan, { table_id: firstTableId(withSpan), index: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('column_span_conflict');
  });

  it('删除干净表的列：列数与网格同步减少', () => {
    const model = plainTableModel();
    const outcome = removeColumn(model, { table_id: firstTableId(model), index: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.grid.length).toBe(2);
    expect(table.rows.every((row) => row.cells.length === 2)).toBe(true);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('删除纵向合并所在列 ⇒ 明确拒绝（先取消合并）', () => {
    const model = verticalMergeModel();
    const before = describeDocumentModel(model);
    const outcome = removeColumn(model, { table_id: firstTableId(model), index: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('column_span_conflict');
    expect(outcome.detail).toContain('先取消合并');
    expect(describeDocumentModel(model)).toBe(before);
  });

  it('neighboringColumnWidth 的取宽规则', () => {
    const table = tableOf(plainTableModel());
    expect(neighboringColumnWidth(table, 1)).toEqual(COL);
    expect(neighboringColumnWidth(table, 0)).toEqual(COL);
    expect(neighboringColumnWidth({ ...table, grid: [] }, 0)).toBeNull();
  });
});

describe('行列增删后合并与网格的一致性（综合）', () => {
  it('链中插行 → 再删该行：回到原状（可逆）', () => {
    const model = verticalMergeModel();
    const tableId = firstTableId(model);
    const inserted = insertRow(model, { table_id: tableId, index: 1 });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const removed = removeRow(inserted.model, { table_id: tableId, index: 1 });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const table = tableOf(removed.model);
    expect(table.rows.map((row) => row.cells[0]?.vertical_merge)).toEqual(['restart', 'continue', 'continue']);
    expect(cellTextAt(removed.model, 0, 0)).toBe('a1');
    expect(cellTextAt(removed.model, 1, 1)).toBe('b2');
    expect(errorCount(removed.model)).toBe(0);
  });

  it('插入列后纵向链仍在同一列（列区间整体右移）', () => {
    const model = verticalMergeModel();
    const tableId = firstTableId(model);
    const outcome = insertColumn(model, { table_id: tableId, index: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    const map = buildGridMap(table);
    // 原来的第 0 列（合并链）现在在第 1 列。
    expect(cellAt(map, 0, 1)?.cell.vertical_merge).toBe('restart');
    expect(cellAt(map, 2, 1)?.cell.vertical_merge).toBe('continue');
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('段落写作夹具：段落 + 表格 + 段落 的三块文档在所有行操作后段落不变', () => {
    const model = createDocumentModel({
      document_id: 'doc-with-paragraphs',
      blocks: [
        paragraphNode({ source: 'user_request', inlines: [runNode({ text: '前', source: 'user_request' })] }),
        plainTableDraft([
          ['1', '2'],
          ['3', '4'],
        ]),
        paragraphNode({ source: 'user_request', inlines: [runNode({ text: '后', source: 'user_request' })] }),
      ],
    });
    const tableId = firstTableId(model);
    const afterInsert = insertRow(model, { table_id: tableId, index: 2 });
    expect(afterInsert.ok).toBe(true);
    if (!afterInsert.ok) return;
    const afterRemove = removeRow(afterInsert.model, { table_id: tableId, index: 0 });
    expect(afterRemove.ok).toBe(true);
    if (!afterRemove.ok) return;
    expect(afterRemove.model.blocks[0]).toBe(model.blocks[0]);
    expect(afterRemove.model.blocks[2]).toBe(model.blocks[2]);
    expect(errorCount(afterRemove.model)).toBe(0);
  });
});
