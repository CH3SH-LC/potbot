/**
 * 网格几何测试（WF-057/058 的判据基础）。
 *
 * 正例：干净表的占用矩阵、横向/纵向/矩形合并还原成矩形、区域与合并区的关系；
 * 反例：参差行、空洞、重叠必须被**检出**（判据"网格不出现空洞或重叠"）。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel } from '../../model/document.js';
import { cellNode, rowNode, tableNode, textParagraphNode } from '../../model/nodes.js';
import type { DraftCellNode, DraftTableNode } from '../../model/nodes.js';
import type { TableNode } from '../../model/types.js';
import {
  buildGridMap,
  cellAt,
  describeGridProblem,
  gridIsClean,
  mergedRegions,
  regionCells,
  regionCutByMerge,
  regionIsCellAligned,
  regionOf,
  regionWithinTable,
  rowWidths,
} from './grid.js';
import {
  horizontalMergeModel,
  plainTableModel,
  rectMergeModel,
  tableOf,
  verticalMergeModel,
} from './fixtures.js';

const MM40 = { unit: 'mm', value: 40 } as const;

function draftCell(text: string, span = 1): DraftCellNode {
  return cellNode({
    source: 'imported',
    blocks: [textParagraphNode({ text, source: 'imported' })],
    grid_span: span,
  });
}

/** 造一张表模型（表要合法，所以经 `createDocumentModel` 走一遍校验）。 */
function assemble(draft: DraftTableNode): TableNode {
  const model = createDocumentModel({ document_id: 'grid-test', blocks: [draft] });
  const block = model.blocks[0];
  if (block === undefined || block.kind !== 'table') {
    throw new Error('测试装配失败：第一块不是表格');
  }
  return block;
}

describe('占用矩阵（正例）', () => {
  it('干净表的每一格都有归属，无病', () => {
    const table = tableOf(plainTableModel());
    const map = buildGridMap(table);
    expect(map.row_count).toBe(3);
    expect(map.column_count).toBe(3);
    expect(map.problems).toEqual([]);
    expect(gridIsClean(table)).toBe(true);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        expect(cellAt(map, row, column), `${String(row)},${String(column)}`).not.toBeNull();
      }
    }
  });

  it('横向合并：同一单元格的多个列位置共享同一个 slot（按引用相等）', () => {
    const map = buildGridMap(tableOf(horizontalMergeModel()));
    const first = cellAt(map, 0, 0);
    expect(first).not.toBeNull();
    expect(first).toBe(cellAt(map, 0, 1));
    expect(first?.cell.grid_span).toBe(2);
    expect(cellAt(map, 0, 2)?.cell_index).toBe(1);
  });

  it('纵向合并：三行还原成一个 1×3 的矩形', () => {
    const region = regionOf(buildGridMap(tableOf(verticalMergeModel())), 1, 0);
    expect(region).toEqual({ top: 0, left: 0, rows: 3, columns: 1 });
  });

  it('矩形合并：横向纵向叠加还原成 2 列 × 2 行', () => {
    const region = regionOf(buildGridMap(tableOf(rectMergeModel())), 1, 1);
    expect(region).toEqual({ top: 0, left: 0, rows: 2, columns: 2 });
  });

  it('mergedRegions 只报真合并，且不重复', () => {
    expect(mergedRegions(tableOf(rectMergeModel()))).toEqual([{ top: 0, left: 0, rows: 2, columns: 2 }]);
    expect(mergedRegions(tableOf(plainTableModel()))).toEqual([]);
  });

  it('未合并的格子是 1×1 区域', () => {
    expect(regionOf(buildGridMap(tableOf(plainTableModel())), 1, 1)).toEqual({
      top: 1,
      left: 1,
      rows: 1,
      columns: 1,
    });
  });

  it('gridSpan 混排的行列数按 grid_span 累加', () => {
    expect(rowWidths(tableOf(plainTableModel()))).toEqual([3, 3, 3]);
    expect(rowWidths(tableOf(horizontalMergeModel()))).toEqual([3, 3, 3]);
  });
});

describe('区域与合并区的关系', () => {
  it('与既有合并区部分重叠 ⇒ 报出切穿', () => {
    const map = buildGridMap(tableOf(rectMergeModel()));
    const cut = regionCutByMerge(map, { top: 1, left: 0, rows: 2, columns: 2 });
    expect(cut).not.toBeNull();
    expect(cut?.region).toEqual({ top: 0, left: 0, rows: 2, columns: 2 });
    expect(regionIsCellAligned(map, { top: 1, left: 0, rows: 2, columns: 2 })).toBe(false);
  });

  it('完整包住既有合并区 ⇒ 不算切穿', () => {
    const map = buildGridMap(tableOf(rectMergeModel()));
    expect(regionCutByMerge(map, { top: 0, left: 0, rows: 2, columns: 2 })).toBeNull();
    expect(regionIsCellAligned(map, { top: 0, left: 0, rows: 2, columns: 2 })).toBe(true);
  });

  it('区域覆盖的互异单元格不重复计数（模型里纵向合并是 N 个单元格节点）', () => {
    const cells = regionCells(buildGridMap(tableOf(rectMergeModel())), {
      top: 0,
      left: 0,
      rows: 2,
      columns: 2,
    });
    // 2×2 的合并在模型里是"一个 gridSpan=2 的 restart 格 + 一个 gridSpan=2 的 continue 格"，
    // 因此互异**单元格节点**是 2 个；横向多列共享的是同一个 slot，不重复计数。
    expect(cells.length).toBe(2);
    expect(cells.map((slot) => slot.cell.vertical_merge)).toEqual(['restart', 'continue']);
  });

  it('越界判定', () => {
    const map = buildGridMap(tableOf(plainTableModel()));
    expect(regionWithinTable(map, { top: 0, left: 0, rows: 3, columns: 3 })).toBe(true);
    expect(regionWithinTable(map, { top: 0, left: 0, rows: 4, columns: 3 })).toBe(false);
    expect(regionWithinTable(map, { top: 0, left: 0, rows: 0, columns: 3 })).toBe(false);
    expect(regionWithinTable(map, { top: -1, left: 0, rows: 1, columns: 1 })).toBe(false);
    expect(regionWithinTable(map, { top: 0.5, left: 0, rows: 1, columns: 1 })).toBe(false);
  });

  it('越界的格子取不到单元格', () => {
    const map = buildGridMap(tableOf(plainTableModel()));
    expect(cellAt(map, 9, 0)).toBeNull();
    expect(cellAt(map, 0, 9)).toBeNull();
    expect(cellAt(map, -1, 0)).toBeNull();
  });
});

describe('网格病检出（反例）', () => {
  it('参差行 ⇒ row_width_mismatch，且被判为不干净', () => {
    const table = assemble(
      tableNode({
        source: 'imported',
        grid: [MM40, MM40],
        rows: [
          rowNode({ source: 'imported', cells: [draftCell('a'), draftCell('b')] }),
          rowNode({ source: 'imported', cells: [draftCell('c')] }),
        ],
      }),
    );
    const map = buildGridMap(table);
    expect(map.problems.map((problem) => problem.kind)).toContain('row_width_mismatch');
    expect(gridIsClean(table)).toBe(false);
    expect(describeGridProblem(map.problems[0] as never)).toContain('列');
  });

  it('中间行少一格 ⇒ 空洞被检出', () => {
    const map = buildGridMap(
      assemble(
        tableNode({
          source: 'imported',
          grid: [MM40, MM40],
          rows: [
            rowNode({ source: 'imported', cells: [draftCell('a', 2)] }),
            rowNode({ source: 'imported', cells: [draftCell('b'), draftCell('c')] }),
          ],
        }),
      ),
    );
    expect(map.problems).toEqual([]);

    const holed = buildGridMap(
      assemble(
        tableNode({
          source: 'imported',
          grid: [MM40, MM40, MM40],
          rows: [
            rowNode({ source: 'imported', cells: [draftCell('a', 2)] }),
            rowNode({ source: 'imported', cells: [draftCell('b'), draftCell('c'), draftCell('d')] }),
          ],
        }),
      ),
    );
    // 第 0 行只占 2 列，表格声明 3 列 ⇒ 第 2 列无人覆盖。
    expect(holed.problems.map((problem) => problem.kind)).toContain('hole');
  });

  it('describeGridProblem 对三类病都有话说', () => {
    expect(describeGridProblem({ kind: 'row_width_mismatch', row: 0, actual: 1, expected: 2 })).toContain('第 0 行');
    expect(describeGridProblem({ kind: 'hole', row: 1, column: 2 })).toContain('空洞');
    expect(
      describeGridProblem({ kind: 'overlap', row: 0, column: 1, first_cell_index: 0, second_cell_index: 1 }),
    ).toContain('重复覆盖');
  });
});
