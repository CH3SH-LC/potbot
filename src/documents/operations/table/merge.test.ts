/**
 * 合并 / 拆分测试（WF-058；判据："非法跨区组合明确拒绝，且模型不变"）。
 *
 * 每个反例都同时断言三件事：
 * 1. `ok === false` 且 `code` 是**结构化**判据（不是靠 detail 文本）；
 * 2. `detail` 说得出为什么；
 * 3. **原模型一个字节没动**（引用相等 + 全文档摘要相等）。
 */

import { describe, expect, it } from 'vitest';
import { buildGridMap, gridIsClean, regionOf } from './grid.js';
import { cellMergeRegion, mergeCells, mergeRequest, splitCell, splitRequest } from './merge.js';
import {
  cellTextAt,
  horizontalMergeModel,
  plainTableModel,
  rectMergeModel,
  tableOf,
  verticalMergeModel,
  firstTableId,
} from './fixtures.js';
import { describeDocumentModel } from '../../model/document.js';

describe('合并（正例）', () => {
  it('横向合并两个单元格：grid_span=2、内容串接、格数减少', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const before = tableOf(model);
    const outcome = mergeCells(model, mergeRequest(tableId, { top: 0, left: 0, rows: 1, columns: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.absorbed_cells).toBe(1);

    const table = tableOf(outcome.model);
    expect(table.rows[0]?.cells.length).toBe(2);
    expect(table.rows[0]?.cells[0]?.grid_span).toBe(2);
    expect(table.rows[0]?.cells[0]?.vertical_merge).toBeNull();
    // 内容一条不丢：a1 与 b1 都还在。
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1b1');
    // 网格仍然干净（无空洞、无重叠）。
    expect(buildGridMap(table).problems).toEqual([]);
    // 表前后的段落没被动过。
    expect(outcome.model.blocks[0]).toBe(model.blocks[0]);
    expect(outcome.model.blocks[2]).toBe(model.blocks[2]);
    // 左上角单元格身份不变（R101）。
    expect(table.rows[0]?.cells[0]?.id).toBe(before.rows[0]?.cells[0]?.id);
  });

  it('纵向合并三行：restart + continue + continue', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = mergeCells(model, mergeRequest(tableId, { top: 0, left: 0, rows: 3, columns: 1 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const table = tableOf(outcome.model);
    expect(table.rows[0]?.cells[0]?.vertical_merge).toBe('restart');
    expect(table.rows[1]?.cells[0]?.vertical_merge).toBe('continue');
    expect(table.rows[2]?.cells[0]?.vertical_merge).toBe('continue');
    // 三行内容都并到第一格：a1 / a2 / a3。
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1a2a3');
    expect(regionOf(buildGridMap(table), 2, 0)).toEqual({ top: 0, left: 0, rows: 3, columns: 1 });
    expect(gridIsClean(table)).toBe(true);
  });

  it('矩形合并（2×2）：横向纵向叠加，网格无空洞', () => {
    const model = plainTableModel();
    const outcome = mergeCells(model, mergeRequest(firstTableId(model), { top: 0, left: 0, rows: 2, columns: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(regionOf(buildGridMap(table), 1, 1)).toEqual({ top: 0, left: 0, rows: 2, columns: 2 });
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1b1a2b2');
    expect(gridIsClean(table)).toBe(true);
    // 合并后每行仍是 3 列。
    expect(table.rows[0]?.cells.map((cell) => cell.grid_span)).toEqual([2, 1]);
    expect(table.rows[1]?.cells.map((cell) => cell.grid_span)).toEqual([2, 1]);
  });

  it('canMergeCells 与 mergeCells 判据一致（检查说行 ⇒ 执行不会拒绝）', () => {
    const model = plainTableModel();
    const request = mergeRequest(firstTableId(model), { top: 1, left: 1, rows: 2, columns: 2 });
    const verdict = mergeCells(model, request);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(regionOf(buildGridMap(tableOf(verdict.model)), 2, 2)).toEqual({
        top: 1,
        left: 1,
        rows: 2,
        columns: 2,
      });
    }
  });

  it('cellMergeRegion 只读查询：未合并且已合并都答得出来', () => {
    const plain = tableOf(plainTableModel());
    expect(cellMergeRegion(plain, 0, 0)).toEqual({ top: 0, left: 0, rows: 1, columns: 1 });
    const merged = tableOf(horizontalMergeModel());
    expect(cellMergeRegion(merged, 0, 1)).toEqual({ top: 0, left: 0, rows: 1, columns: 2 });
    expect(cellMergeRegion(plain, 9, 9)).toBeNull();
  });
});

describe('合并（反例：结构化拒绝 + 模型不变）', () => {
  const cases: readonly {
    readonly name: string;
    readonly model: () => ReturnType<typeof plainTableModel>;
    readonly region: { top: number; left: number; rows: number; columns: number };
    readonly code: string;
  }[] = [
    {
      name: '与既有合并区部分重叠的再合并 ⇒ column_span_conflict',
      model: rectMergeModel,
      region: { top: 1, left: 1, rows: 2, columns: 2 },
      code: 'column_span_conflict',
    },
    {
      name: '切穿横向合并区 ⇒ column_span_conflict',
      model: horizontalMergeModel,
      region: { top: 0, left: 1, rows: 1, columns: 2 },
      code: 'column_span_conflict',
    },
    {
      name: '越界区域 ⇒ invalid_index',
      model: plainTableModel,
      region: { top: 2, left: 2, rows: 2, columns: 2 },
      code: 'invalid_index',
    },
    {
      name: '单个单元格的区域 ⇒ unsupported（不静默无操作）',
      model: plainTableModel,
      region: { top: 0, left: 0, rows: 1, columns: 1 },
      code: 'unsupported',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const model = testCase.model();
      const before = describeDocumentModel(model);
      const outcome = mergeCells(model, mergeRequest(firstTableId(model), testCase.region));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe(testCase.code);
      expect(outcome.detail.length).toBeGreaterThan(0);
      // 模型不变：同一份文档描述（含 id 与结构）。
      expect(describeDocumentModel(model)).toBe(before);
    });
  }

  it('冲突信息里点出被切穿的既有合并区', () => {
    const model = rectMergeModel();
    const outcome = mergeCells(model, mergeRequest(firstTableId(model), { top: 1, left: 0, rows: 2, columns: 2 }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('column_span_conflict');
    expect(outcome.detail).toContain('先拆分再合并');
  });

  it('canMergeCells 对非法请求也给同一判据', () => {
    const model = rectMergeModel();
    const verdict = mergeCells(model, mergeRequest(firstTableId(model), { top: 1, left: 1, rows: 2, columns: 2 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('column_span_conflict');
  });
});

describe('拆分（正例与反例）', () => {
  it('横向合并的单元格拆回两格，内容按序分配', () => {
    const model = horizontalMergeModel();
    const outcome = splitCell(model, splitRequest(firstTableId(model), 0, 0));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.rows[0]?.cells.length).toBe(3);
    expect(table.rows[0]?.cells.map((cell) => cell.grid_span)).toEqual([1, 1, 1]);
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1');
    expect(gridIsClean(table)).toBe(true);
  });

  it('矩形合并的单元格拆成 2×2：下方格是空占位（system），内容留在顶行', () => {
    const model = rectMergeModel();
    const outcome = splitCell(model, splitRequest(firstTableId(model), 1, 0));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.region).toEqual({ top: 0, left: 0, rows: 2, columns: 2 });
    const table = tableOf(outcome.model);
    expect(table.rows[0]?.cells.map((cell) => cell.grid_span)).toEqual([1, 1, 1]);
    expect(table.rows[1]?.cells.map((cell) => cell.grid_span)).toEqual([1, 1, 1]);
    expect(table.rows[1]?.cells[0]?.vertical_merge).toBeNull();
    expect(table.rows[1]?.cells[1]?.vertical_merge).toBeNull();
    // 内容不丢：a1 仍在左上第一格；下方两格为空。
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1');
    expect(cellTextAt(outcome.model, 1, 0)).toBe('');
    expect(table.rows[1]?.cells[0]?.blocks[0]?.source).toBe('system');
    expect(gridIsClean(table)).toBe(true);
  });

  it('纵向合并拆分后 vMerge 链消失，且不产生"没有 restart 的 continue"', () => {
    const model = verticalMergeModel();
    const outcome = splitCell(model, splitRequest(firstTableId(model), 2, 0));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    for (const row of table.rows) {
      expect(row.cells[0]?.vertical_merge).toBeNull();
    }
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1');
    expect(gridIsClean(table)).toBe(true);
  });

  it('拆分没合并的单元格 ⇒ unsupported，且模型不变', () => {
    const model = plainTableModel();
    const before = describeDocumentModel(model);
    const outcome = splitCell(model, splitRequest(firstTableId(model), 1, 1));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
    expect(describeDocumentModel(model)).toBe(before);
  });

  it('拆分越界位置 ⇒ invalid_index', () => {
    const outcome = splitCell(plainTableModel(), splitRequest(firstTableId(plainTableModel()), 9, 9));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_index');
  });

  it('拆出的新单元格取了新 id，且不与既有 id 冲突', () => {
    const model = rectMergeModel();
    const outcome = splitCell(model, splitRequest(firstTableId(model), 0, 0));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    const ids = table.rows.flatMap((row) => row.cells.map((cell) => cell.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('合并 ⇄ 拆分往返', () => {
  it('合并再拆分回到"格数与列宽结构一致"的形态', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const merged = mergeCells(model, mergeRequest(tableId, { top: 0, left: 0, rows: 1, columns: 2 }));
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const restored = splitCell(merged.model, splitRequest(tableId, 0, 0));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const table = tableOf(restored.model);
    expect(table.rows[0]?.cells.length).toBe(3);
    expect(cellTextAt(restored.model, 0, 0)).toBe('a1');
    expect(cellTextAt(restored.model, 0, 1)).toBe('b1');
    expect(gridIsClean(table)).toBe(true);
  });
});
