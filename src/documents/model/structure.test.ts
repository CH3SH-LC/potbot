/**
 * R136 结构操作的原子性，以及 R101 在移动/替换上的表现。
 *
 * 三条核心判据：
 * 1. **失败 = 模型完全不变**：不仅"值相等"，而且调用方手上的对象**引用不变**，
 *    且失败发生时输入模型是**深冻结**的（任何原地改写都会当场抛错）。
 * 2. **复合指令全成功或全不修改**：`applyStructureBatch` 里第一条失败后，
 *    前面那些**本来会成功**的编辑一个都不留。
 * 3. **移动不重新编号**：搬走的行/列/段落连同 id 原样到位（R101）。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from './document.js';
import { cloneDocument, deepFreezeDocument } from './immutable.js';
import { textParagraphNode } from './nodes.js';
import { applyStructureBatch, applyStructureEdit, type StructureEdit } from './structure.js';
import type { CellNode, DocumentModel, Length } from './types.js';
import { collectNodeIds } from './walk.js';
import {
  blockAt,
  cellOf,
  paragraphBlockAt,
  rowAt,
  sampleDocument,
  tableBlockAt,
  twoByTwoTable,
} from './fixtures.js';

const WIDTH: Length = { unit: 'mm', value: 30 };

function docWithTable(): DocumentModel {
  return createDocumentModel({ document_id: 'doc-struct', blocks: [twoByTwoTable()] });
}

function paragraph(text: string): ReturnType<typeof textParagraphNode> {
  return textParagraphNode({ text, source: 'user_request' });
}

/** 给单元格打纵向合并标记（用于造"合并链"场景）。 */
function mergeCell(cell: CellNode, merge: 'restart' | 'continue'): CellNode {
  return { ...cell, vertical_merge: merge };
}

function ok(outcome: ReturnType<typeof applyStructureEdit>): DocumentModel {
  if (!outcome.ok) {
    throw new Error(`期望成功，实际失败：${outcome.code} / ${outcome.detail}`);
  }
  return outcome.model;
}

describe('段落：增 / 删 / 移 / 换', () => {
  it('在中间插入：位置正确、既有 id 不变', () => {
    const before = sampleDocument();
    const after = ok(
      applyStructureEdit(before, {
        kind: 'insert_block',
        container: { kind: 'body' },
        index: 1,
        block: paragraph('插入'),
      }),
    );
    expect(after.blocks.length).toBe(before.blocks.length + 1);
    expect(paragraphBlockAt(after, 1).inlines[0]).toMatchObject({ kind: 'run', text: '插入' });
    for (const id of collectNodeIds(before)) {
      expect(collectNodeIds(after)).toContain(id);
    }
  });

  it('按 id 删除（含表格内部的块）', () => {
    const before = docWithTable();
    const cell = cellOf(tableBlockAt(before, 0), 1, 1);
    const innerId = cell.blocks[0]?.id ?? '';
    expect(innerId).not.toBe('');

    const after = ok(
      applyStructureEdit(before, { kind: 'remove_block', block_id: innerId }),
    );
    expect(cellOf(tableBlockAt(after, 0), 1, 1).blocks).toEqual([]);
    // 其它单元格没被动
    expect(cellOf(tableBlockAt(after, 0), 0, 0).blocks.length).toBe(1);
  });

  it('移动段落：id 跟着走，不重新编号', () => {
    const before = createDocumentModel({
      document_id: 'doc-move',
      blocks: [paragraph('A'), paragraph('B'), paragraph('C')],
    });
    const idA = blockAt(before, 0).id;
    const idC = blockAt(before, 2).id;

    const after = ok(
      applyStructureEdit(before, { kind: 'move_block', block_id: idA, to_index: 2 }),
    );
    expect(after.blocks.map((block) => block.id)).toEqual([blockAt(before, 1).id, idC, idA]);
    expect(after.blocks[2]?.id).toBe(idA);
  });

  it('替换段落：顶层 id 保留（身份不变），内容换成新的', () => {
    const before = sampleDocument();
    const targetId = blockAt(before, 0).id;
    const after = ok(
      applyStructureEdit(before, { kind: 'replace_block', block_id: targetId, block: paragraph('换过') }),
    );
    expect(after.blocks[0]?.id).toBe(targetId);
    expect(paragraphBlockAt(after, 0).inlines[0]).toMatchObject({ text: '换过' });
  });

  it('未受影响的兄弟节点保持同一对象引用（未整篇重建）', () => {
    const before = sampleDocument();
    const tableBefore = blockAt(before, 3);
    const after = ok(
      applyStructureEdit(before, {
        kind: 'insert_block',
        container: { kind: 'body' },
        index: 0,
        block: paragraph('新首段'),
      }),
    );
    expect(blockAt(after, 4)).toBe(tableBefore);
  });
});

describe('表格行：增 / 删 / 移', () => {
  function draftRow(before: DocumentModel, cellCount: number) {
    const template = cellOf(tableBlockAt(before, 0), 0, 0);
    return {
      kind: 'row' as const,
      source: 'user_request' as const,
      opaque: [],
      height: { state: 'unspecified' as const },
      header: false,
      cells: Array.from({ length: cellCount }, () => ({
        kind: 'cell' as const,
        source: 'user_request' as const,
        opaque: [],
        properties: template.properties,
        blocks: [paragraph('新行')],
        grid_span: 1,
        vertical_merge: null,
      })),
    };
  }

  it('插入列数匹配的行：成功', () => {
    const before = docWithTable();
    const after = ok(
      applyStructureEdit(before, {
        kind: 'insert_row',
        table_id: tableBlockAt(before, 0).id,
        index: 1,
        row: draftRow(before, 2),
      }),
    );
    expect(tableBlockAt(after, 0).rows.length).toBe(3);
    expect(rowAt(tableBlockAt(after, 0), 1).cells.length).toBe(2);
  });

  it('插入列数不一致的行 ⇒ 拒绝（原子，模型不变）', () => {
    const before = docWithTable();
    const frozen = deepFreezeDocument(before);
    const outcome = applyStructureEdit(frozen, {
      kind: 'insert_row',
      table_id: tableBlockAt(before, 0).id,
      index: 1,
      row: draftRow(before, 1),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('table_shape_invalid');
    expect(tableBlockAt(frozen, 0).rows.length).toBe(2);
  });

  it('删除行后纵向合并链断裂 ⇒ 拒绝，模型不变', () => {
    const base = docWithTable();
    const table = tableBlockAt(base, 0);
    // 造一张"第 0 行 restart + 第 1 行 continue"的表
    const row0 = rowAt(table, 0);
    const row1 = rowAt(table, 1);
    const merged: DocumentModel = {
      ...base,
      blocks: [
        {
          ...table,
          rows: [
            {
              ...row0,
              cells: [
                mergeCell(cellOf(table, 0, 0), 'restart'),
                cellOf(table, 0, 1),
              ],
            },
            {
              ...row1,
              cells: [
                mergeCell(cellOf(table, 1, 0), 'continue'),
                cellOf(table, 1, 1),
              ],
            },
          ],
        },
      ],
    };
    const frozen = deepFreezeDocument(merged);
    const snapshot = cloneDocument(merged);

    const outcome = applyStructureEdit(frozen, {
      kind: 'remove_row',
      table_id: table.id,
      index: 0,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('table_shape_invalid');
    expect(frozen).toEqual(snapshot);
  });

  it('移动行：行对象连同 id 原样搬运', () => {
    const before = docWithTable();
    const table = tableBlockAt(before, 0);
    const idTop = rowAt(table, 0).id;
    const idBottom = rowAt(table, 1).id;

    const after = ok(
      applyStructureEdit(before, { kind: 'move_row', table_id: table.id, from_index: 0, to_index: 1 }),
    );
    expect(tableBlockAt(after, 0).rows.map((row) => row.id)).toEqual([idBottom, idTop]);
  });

  it('删掉最后一行 ⇒ 拒绝（整表删除请走 remove_block）', () => {
    const before = docWithTable();
    const table = tableBlockAt(before, 0);
    const removed = ok(applyStructureEdit(before, { kind: 'remove_row', table_id: table.id, index: 0 }));
    const outcome = applyStructureEdit(removed, {
      kind: 'remove_row',
      table_id: table.id,
      index: 0,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('table_shape_invalid');
    }
  });
});

describe('表格列：增 / 删 / 移（合并单元格必须明确拒绝）', () => {
  it('插入列：网格同步增长，新单元格各就各位', () => {
    const before = docWithTable();
    const table = tableBlockAt(before, 0);
    const cell = cellOf(table, 0, 0);
    const after = ok(
      applyStructureEdit(before, {
        kind: 'insert_column',
        table_id: table.id,
        index: 1,
        width: WIDTH,
        cells: [0, 1].map(() => ({
          kind: 'cell' as const,
          source: 'user_request' as const,
          opaque: [],
          properties: cell.properties,
          blocks: [paragraph('新列')],
          grid_span: 1,
          vertical_merge: null,
        })),
      }),
    );
    const nextTable = tableBlockAt(after, 0);
    expect(nextTable.grid.length).toBe(3);
    expect(rowAt(nextTable, 0).cells.length).toBe(3);
    expect(rowAt(nextTable, 0).cells[1]?.id).not.toBe(cell.id);
  });

  it('网格存在却不出列宽 ⇒ 拒绝（不悄悄借邻居宽度）', () => {
    const before = docWithTable();
    const table = tableBlockAt(before, 0);
    const outcome = applyStructureEdit(before, {
      kind: 'insert_column',
      table_id: table.id,
      index: 0,
      width: null,
      cells: [0, 1].map(() => ({
        kind: 'cell' as const,
        source: 'user_request' as const,
        opaque: [],
        properties: cellOf(table, 0, 0).properties,
        blocks: [],
        grid_span: 1,
        vertical_merge: null,
      })),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('table_shape_invalid');
    }
  });

  it('列被跨列单元格占着 ⇒ column_span_conflict，模型完全不变', () => {
    const base = docWithTable();
    const table = tableBlockAt(base, 0);
    const row0 = rowAt(table, 0);
    // 第 0 行第 0 个单元格跨 2 列 ⇒ 第 1 列被它占着
    const merged: DocumentModel = {
      ...base,
      blocks: [
        {
          ...table,
          rows: [
            { ...row0, cells: [{ ...cellOf(table, 0, 0), grid_span: 2 }] },
            rowAt(table, 1),
          ],
        },
      ],
    };
    const frozen = deepFreezeDocument(merged);
    const snapshot = cloneDocument(merged);

    const outcome = applyStructureEdit(frozen, {
      kind: 'insert_column',
      table_id: table.id,
      index: 1,
      width: WIDTH,
      cells: [0, 1].map(() => ({
        kind: 'cell' as const,
        source: 'user_request' as const,
        opaque: [],
        properties: cellOf(table, 0, 0).properties,
        blocks: [],
        grid_span: 1,
        vertical_merge: null,
      })),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('column_span_conflict');
    // 输入引用不变 + 值不变（深冻结证明没有任何原地写入）
    expect(frozen).toBe(merged);
    expect(frozen).toEqual(snapshot);
  });

  it('删除被合并覆盖的列 ⇒ column_span_conflict（拒绝切断合并）', () => {
    const base = docWithTable();
    const table = tableBlockAt(base, 0);
    const row0 = rowAt(table, 0);
    const merged: DocumentModel = {
      ...base,
      blocks: [
        {
          ...table,
          rows: [{ ...row0, cells: [{ ...cellOf(table, 0, 0), grid_span: 2 }] }, rowAt(table, 1)],
        },
      ],
    };
    const outcome = applyStructureEdit(merged, {
      kind: 'remove_column',
      table_id: table.id,
      index: 1,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('column_span_conflict');
    }
  });

  it('移动列：单元格 id 集合不变（只是换了位置）', () => {
    const before = docWithTable();
    const table = tableBlockAt(before, 0);
    const idsBefore = table.rows.map((row) => row.cells.map((cell) => cell.id));

    const after = ok(
      applyStructureEdit(before, {
        kind: 'move_column',
        table_id: table.id,
        from_index: 0,
        to_index: 1,
      }),
    );
    const movedTable = tableBlockAt(after, 0);
    expect(movedTable.rows.map((row) => row.cells.map((cell) => cell.id))).toEqual([
      [idsBefore[0]?.[1], idsBefore[0]?.[0]],
      [idsBefore[1]?.[1], idsBefore[1]?.[0]],
    ]);
  });

  it('行列参差不齐的表 ⇒ 列操作拒绝（前置条件，不做猜测）', () => {
    const base = docWithTable();
    const table = tableBlockAt(base, 0);
    const row0 = rowAt(table, 0);
    const ragged: DocumentModel = {
      ...base,
      blocks: [{ ...table, rows: [{ ...row0, cells: [cellOf(table, 0, 0)] }, rowAt(table, 1)] }],
    };
    const outcome = applyStructureEdit(ragged, {
      kind: 'remove_column',
      table_id: table.id,
      index: 0,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('table_shape_invalid');
    }
  });
});

describe('R136 复合指令：全成功或全不修改', () => {
  it('批次里前一条本来会成功、后一条失败 ⇒ 一条都不留', () => {
    const before = sampleDocument();
    const frozen = deepFreezeDocument(before);
    const snapshot = cloneDocument(before);

    const edits: readonly StructureEdit[] = [
      // 这一条单独跑会成功
      { kind: 'insert_block', container: { kind: 'body' }, index: 0, block: paragraph('会被回滚的段') },
      // 这一条必然失败（id 不存在）
      { kind: 'remove_block', block_id: 'n/body:0/paragraph:99' },
    ];
    const outcome = applyStructureBatch(frozen, edits);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.edit_index).toBe(1);
    expect(outcome.code).toBe('unknown_node');
    // 失败分支里**没有 model** —— 调用方只能继续用手上的原模型
    expect(Object.prototype.hasOwnProperty.call(outcome, 'model')).toBe(false);
    expect(frozen).toBe(before);
    expect(frozen).toEqual(snapshot);
    expect(frozen.blocks.length).toBe(snapshot.blocks.length);
  });

  it('失败发生在更早的编辑上时，edit_index 指向第一条失败的', () => {
    const before = sampleDocument();
    const outcome = applyStructureBatch(before, [
      { kind: 'remove_block', block_id: 'n/body:0/table:9' },
      { kind: 'insert_block', container: { kind: 'body' }, index: 0, block: paragraph('x') },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.edit_index).toBe(0);
    }
  });

  it('全成功的批次：所有编辑都生效', () => {
    const before = createDocumentModel({
      document_id: 'doc-batch',
      blocks: [paragraph('A'), paragraph('B')],
    });
    const idB = blockAt(before, 1).id;
    const after = ok(
      applyStructureBatch(before, [
        { kind: 'insert_block', container: { kind: 'body' }, index: 2, block: paragraph('C') },
        { kind: 'move_block', block_id: idB, to_index: 0 },
      ]),
    );
    expect(after.blocks.length).toBe(3);
    expect(after.blocks[0]?.id).toBe(idB);
    expect(paragraphBlockAt(after, 2).inlines[0]).toMatchObject({ text: 'C' });
  });

  it('同一批次重复执行得到同一结果（确定性）', () => {
    const before = sampleDocument();
    const edits: readonly StructureEdit[] = [
      { kind: 'insert_block', container: { kind: 'body' }, index: 1, block: paragraph('X') },
    ];
    const first = ok(applyStructureBatch(before, edits));
    const second = ok(applyStructureBatch(before, edits));
    expect(collectNodeIds(first)).toEqual(collectNodeIds(second));
  });

  it('越界下标 ⇒ invalid_index，不夹紧', () => {
    const before = sampleDocument();
    const outcome = applyStructureEdit(before, {
      kind: 'insert_block',
      container: { kind: 'body' },
      index: 99,
      block: paragraph('越界'),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('invalid_index');
    }
  });

  it('目标容器不存在 ⇒ unknown_node', () => {
    const before = sampleDocument();
    const outcome = applyStructureEdit(before, {
      kind: 'insert_block',
      container: { kind: 'cell', cell_id: 'n/body:0/table:0/row:0/cell:9' },
      index: 0,
      block: paragraph('x'),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('unknown_node');
    }
  });

  it('把 block_id 指向表格（而非段落）时 remove/move 仍然按 id 工作', () => {
    const before = sampleDocument();
    const tableId = blockAt(before, 3).id;
    const after = ok(
      applyStructureEdit(before, { kind: 'move_block', block_id: tableId, to_index: 0 }),
    );
    expect(after.blocks[0]?.id).toBe(tableId);
    expect(after.blocks[0]?.kind).toBe('table');
  });
});
