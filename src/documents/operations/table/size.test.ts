/**
 * 列宽 / 行高测试（WF-059）。
 *
 * 判据："所有尺寸走 `src/documents/units/**`" —— 测试里出现的期望值都按
 * `units` 的口径（1 cm = 567 twips、1 pt = 20 twips）算出来，且断言的是**换算后的一致**
 * （跨列单元格宽度 = 各列之和），不是某个硬编码数字。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel } from '../../model/document.js';
import { cellNode, tableNode, textParagraphNode } from '../../model/nodes.js';
import { lengthToTwips } from '../../units/index.js';
import type { DocumentModel, Length } from '../../model/types.js';
import { validateDocument } from '../../model/validation.js';
import {
  autofitTable,
  clearRowHeight,
  columnWidths,
  distributeColumns,
  setColumnWidth,
  setRowHeight,
  widthConsistency,
} from './size.js';
import { firstTableId, plainTableModel, tableOf } from './fixtures.js';

const MM = (value: number): Length => ({ unit: 'mm', value });
const PT = (value: number): Length => ({ unit: 'pt', value });

function errorCount(model: DocumentModel): number {
  return validateDocument(model).errors.length;
}

/** 一张带显式单元格宽度的 2×2 表（用来验证"网格与单元格首选宽度同步"）。 */
function tableWithCellWidths(): DocumentModel {
  return createDocumentModel({
    document_id: 'doc-cell-widths',
    blocks: [
      tableNode({
        source: 'imported',
        grid: [MM(40), MM(40)],
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
                properties: { verticalAlign: { state: 'unspecified' }, shading: { state: 'unspecified' }, borders: { state: 'unspecified' }, width: { state: 'set', value: MM(40) } },
                blocks: [textParagraphNode({ text: 'l', source: 'imported' })],
              }),
              cellNode({
                source: 'imported',
                properties: { verticalAlign: { state: 'unspecified' }, shading: { state: 'unspecified' }, borders: { state: 'unspecified' }, width: { state: 'set', value: MM(40) } },
                blocks: [textParagraphNode({ text: 'r', source: 'imported' })],
              }),
            ],
          },
        ],
      }),
    ],
  });
}

/** 一张第 0 行是 gridSpan=2 合并格的表（合并格带显式宽度）。 */
function tableWithSpanningWidth(): DocumentModel {
  return createDocumentModel({
    document_id: 'doc-span-width',
    blocks: [
      tableNode({
        source: 'imported',
        grid: [MM(40), MM(40)],
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
                properties: { verticalAlign: { state: 'unspecified' }, shading: { state: 'unspecified' }, borders: { state: 'unspecified' }, width: { state: 'set', value: MM(80) } },
                blocks: [textParagraphNode({ text: 'wide', source: 'imported' })],
              }),
            ],
          },
          {
            kind: 'row',
            source: 'imported',
            opaque: [],
            height: { state: 'unspecified' },
            header: false,
            cells: [
              cellNode({ source: 'imported', blocks: [textParagraphNode({ text: 'a', source: 'imported' })] }),
              cellNode({ source: 'imported', blocks: [textParagraphNode({ text: 'b', source: 'imported' })] }),
            ],
          },
        ],
      }),
    ],
  });
}

describe('列宽（WF-059）', () => {
  it('设置某列宽度只改该列，其余列不变', () => {
    const model = plainTableModel();
    const outcome = setColumnWidth(model, { table_id: firstTableId(model), column: 1, width: MM(25) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(columnWidths(tableOf(outcome.model))).toEqual([MM(40), MM(25), MM(40)]);
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('列号越界 ⇒ invalid_index，模型不变', () => {
    const model = plainTableModel();
    const outcome = setColumnWidth(model, { table_id: firstTableId(model), column: 9, width: MM(10) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_index');
  });

  it('没有网格定义的表格 ⇒ unsupported（列宽无处安放）', () => {
    const model = createDocumentModel({
      document_id: 'doc-no-grid',
      blocks: [
        tableNode({
          source: 'imported',
          grid: [],
          rows: [
            {
              kind: 'row',
              source: 'imported',
              opaque: [],
              height: { state: 'unspecified' },
              header: false,
              cells: [cellNode({ source: 'imported', blocks: [textParagraphNode({ text: 'a', source: 'imported' })] })],
            },
          ],
        }),
      ],
    });
    const outcome = setColumnWidth(model, { table_id: firstTableId(model), column: 0, width: MM(10) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unsupported');
  });

  it('显式宽度随网格同步（改一列 ⇒ 该列上的单元格首选宽度跟着变）', () => {
    const model = tableWithCellWidths();
    const outcome = setColumnWidth(model, { table_id: firstTableId(model), column: 0, width: MM(60) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.synced_cells).toBe(1);
    const table = tableOf(outcome.model);
    expect(table.rows[0]?.cells[0]?.properties.width).toEqual({ state: 'set', value: MM(60) });
    // 没被碰到的列保持原值。
    expect(table.rows[0]?.cells[1]?.properties.width).toEqual({ state: 'set', value: MM(40) });
  });

  it('跨列合并格的宽度 = 各列之和（换算走 units）', () => {
    const model = tableWithSpanningWidth();
    const outcome = setColumnWidth(model, { table_id: firstTableId(model), column: 0, width: MM(30) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    const width = table.rows[0]?.cells[0]?.properties.width;
    if (width?.state !== 'set') {
      throw new Error('合并格的宽度应为 set');
    }
    // 30 mm + 40 mm = 70 mm，按 twips 精确相加后再换算回 mm。
    expect(lengthToTwips(width.value)).toBe(lengthToTwips(MM(70)));
  });

  it('widthConsistency 能读出"声明宽度 vs 网格和"（诊断）', () => {
    const model = tableWithSpanningWidth();
    const before = widthConsistency(tableOf(model));
    expect(before.length).toBe(1);
    expect(before[0]?.from_grid).toEqual(MM(80));
    const outcome = setColumnWidth(model, { table_id: firstTableId(model), column: 1, width: MM(5) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = widthConsistency(tableOf(outcome.model));
    // 声明宽度与网格和**一致**（按 twips 比较：5 mm 落到 284 twips，故 40+5 mm 的和
    // 是 2552 twips，不写死成"45 mm"这种会被取整漂移骗过的期望值）。
    const declared = after[0]?.declared;
    if (declared === undefined) {
      throw new Error('应读到一条一致性记录');
    }
    expect(lengthToTwips(declared)).toBe(lengthToTwips(MM(40)) + lengthToTwips(MM(5)));
    expect(after[0]?.from_grid).toEqual(declared);
  });
});

describe('均分与自适应（WF-059）', () => {
  it('均分：各列相等，且总宽不变（余数摊到前几列）', () => {
    const model = plainTableModel();
    const outcome = distributeColumns(model, { table_id: firstTableId(model) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const widths = outcome.column_widths;
    expect(widths.length).toBe(3);
    const twips = widths.map((width) => lengthToTwips(width));
    // 总宽守恒：原来是 3 × 40 mm。
    expect(twips.reduce((a, b) => a + b, 0)).toBe(lengthToTwips(MM(120)));
    expect(Math.max(...twips) - Math.min(...twips)).toBeLessThanOrEqual(1);
  });

  it('均分到指定总宽：加起来精确等于目标（不因取整缩水）', () => {
    const model = plainTableModel();
    const outcome = distributeColumns(model, { table_id: firstTableId(model), total: MM(100) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const twips = outcome.column_widths.map((width) => lengthToTwips(width));
    expect(twips.reduce((a, b) => a + b, 0)).toBe(lengthToTwips(MM(100)));
  });

  it('均分后显式单元格宽度也同步', () => {
    const model = tableWithCellWidths();
    const outcome = distributeColumns(model, { table_id: firstTableId(model), total: MM(100) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    for (const cell of table.rows[0]?.cells ?? []) {
      const width = cell.properties.width;
      if (width.state !== 'set') {
        throw new Error('显式宽度应保持 set');
      }
      expect(lengthToTwips(width.value)).toBe(lengthToTwips({ unit: 'mm', value: 50 }));
    }
  });

  it('没有网格 ⇒ 均分 unsupported', () => {
    const model = createDocumentModel({
      document_id: 'doc-no-grid2',
      blocks: [tableNode({ source: 'imported', grid: [], rows: [{ kind: 'row', source: 'imported', opaque: [], height: { state: 'unspecified' }, header: false, cells: [cellNode({ source: 'imported' })] }] })],
    });
    const outcome = distributeColumns(model, { table_id: firstTableId(model) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unsupported');
  });
});

describe('自适应（WF-059）', () => {
  it('适应页面：按可用宽度缩放，总宽精确等于可用宽度', () => {
    const model = plainTableModel();
    const outcome = autofitTable(model, {
      table_id: firstTableId(model),
      mode: 'window',
      available_width: MM(150),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.layout).toBe('autofit');
    const total = outcome.column_widths.reduce((sum, width) => sum + lengthToTwips(width), 0);
    expect(total).toBe(lengthToTwips(MM(150)));
    expect(tableOf(outcome.model).properties.layout).toEqual({ state: 'set', value: 'autofit' });
  });

  it('不给可用宽度：只标记 autofit，列宽不动', () => {
    const model = plainTableModel();
    const outcome = autofitTable(model, { table_id: firstTableId(model), mode: 'window' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.column_widths).toEqual([MM(40), MM(40), MM(40)]);
    expect(tableOf(outcome.model).properties.layout).toEqual({ state: 'set', value: 'autofit' });
  });

  it('按内容自适应 ⇒ unsupported（没有排版引擎，不估算冒充）', () => {
    const model = plainTableModel();
    const outcome = autofitTable(model, { table_id: firstTableId(model), mode: 'content' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
    expect(outcome.detail).toContain('排版');
  });
});

describe('行高（WF-059）', () => {
  it('固定行高 / 最小行高分别落到 exact / atLeast', () => {
    const model = plainTableModel();
    const rowId = tableOf(model).rows[0]?.id as string;
    const fixed = setRowHeight(model, { row_id: rowId, rule: 'exact', value: PT(20) });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(tableOf(fixed.model).rows[0]?.height).toEqual({ state: 'set', value: { value: PT(20), rule: 'exact' } });

    const minimum = setRowHeight(model, { row_id: rowId, rule: 'atLeast', value: PT(18) });
    expect(minimum.ok).toBe(true);
    if (!minimum.ok) return;
    expect(tableOf(minimum.model).rows[0]?.height).toEqual({
      state: 'set',
      value: { value: PT(18), rule: 'atLeast' },
    });
  });

  it('清除行高落 inherit（写码层删除 w:trHeight）', () => {
    const model = plainTableModel();
    const rowId = tableOf(model).rows[1]?.id as string;
    const outcome = clearRowHeight(model, rowId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(tableOf(outcome.model).rows[1]?.height).toEqual({ state: 'inherit' });
  });

  it('行 id 不存在 ⇒ unknown_node，模型不变', () => {
    const model = plainTableModel();
    const outcome = setRowHeight(model, { row_id: 'no-such-row', rule: 'exact', value: PT(10) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unknown_node');
  });

  it('行高设置不碰别的行（对象引用不变）', () => {
    const model = plainTableModel();
    const table = tableOf(model);
    const outcome = setRowHeight(model, { row_id: table.rows[0]?.id as string, rule: 'exact', value: PT(20) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const next = tableOf(outcome.model);
    expect(next.rows[1]).toBe(table.rows[1]);
    expect(next.rows[2]).toBe(table.rows[2]);
  });
});
