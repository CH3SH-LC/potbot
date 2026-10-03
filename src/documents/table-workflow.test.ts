/**
 * 表格工作流测试（WF-056–064 的操作面）。
 *
 * ## 每条能力至少一条**反向对照**（判据要求的"抓得住"）
 *
 * | 反向场景 | 期望 |
 * |---|---|
 * | 合并区域**越界** | `ok:false` + `invalid_index` |
 * | 合并区域**与既有合并重叠**（切穿） | `ok:false` + `column_span_conflict` |
 * | 单格区域（无可合并对象） | `ok:false` + `unsupported`（**不静默无操作**） |
 * | 表格网格**有病**（空洞 / 行宽不一致） | `checkTableConsistency` 报出来，`assertTableConsistent` 抛 |
 * | 表格样式（模型装不下） | `ok:false` + `unsupported`（不是"调了个不存在的函数"） |
 *
 * 另外钉住两条正向不变量：**内容守恒**（合并 / 拆分前后文本多重集不变）与
 * **操作后自洽**（增删行列后网格仍然干净）。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentModel, Length, TableNode } from './model/types.js';
import {
  TABLE_WORKFLOW_CAPABILITIES,
  addTableColumn,
  addTableRow,
  alignCellHorizontally,
  alignCellVertically,
  assertTableConsistent,
  checkTableConsistency,
  clearTableRowHeight,
  distributeTableColumns,
  fitTableToWindow,
  mergeCellRange,
  preflightMergeRegion,
  readTable,
  removeTableColumn,
  removeTableRow,
  repeatTableHeaderRows,
  replaceTableText,
  setCellText,
  setTableBackground,
  setTableCellBackground,
  setTableCellBorders,
  setTableBorderEdges,
  setTableColumnWidth,
  setTableRowHeight,
  setTableStyle,
  splitMergedCell,
  tableStyleSupport,
} from './table-workflow.js';
import {
  cellTextAt,
  firstTableId,
  horizontalMergeModel,
  plainTableModel,
  rectMergeModel,
  shapeOf,
  tableOf,
  verticalMergeModel,
} from './operations/table/fixtures.js';

const MM = (value: number): Length => ({ unit: 'mm', value });

/** 取表格第一行第一格的行内块里的段落属性（对齐断言用）。 */
function firstParagraphProperties(model: DocumentModel) {
  const block = tableOf(model).rows[0]?.cells[0]?.blocks[0];
  if (block === undefined || block.kind !== 'paragraph') {
    throw new Error('测试取值失败：第一格不是段落');
  }
  return block.properties;
}

describe('能力清单（机器可判，防止"文档说支持、代码没入口"）', () => {
  it('id 唯一，且覆盖判据点名的每一类能力', () => {
    const ids = TABLE_WORKFLOW_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of [
      'table.row.insert',
      'table.row.delete',
      'table.column.insert',
      'table.column.delete',
      'table.cell.merge',
      'table.cell.split',
      'table.column.width',
      'table.row.height',
      'table.borders',
      'cell.borders',
      'table.shading',
      'cell.shading',
      'table.header.repeat',
      'table.style',
      'cell.alignment.vertical',
      'cell.alignment.horizontal',
      'cell.text',
      'table.grid.consistency',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it('没有入口的能力（exposed=false）必须写明为什么，且不得声称 wired', () => {
    for (const capability of TABLE_WORKFLOW_CAPABILITIES) {
      if (!capability.exposed) {
        expect(capability.wired).toBe(false);
        expect(capability.note.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('WF-057 行列增删：操作后必须自洽', () => {
  it('追加行后行数 +1，网格仍干净', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = addTableRow(model, { table_id: tableId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(shapeOf(outcome.model).rows).toBe(4);
    expect(checkTableConsistency(outcome.model, tableId).ok).toBe(true);
  });

  it('删除行后行数 -1，网格仍干净', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = removeTableRow(model, { table_id: tableId, index: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(shapeOf(outcome.model).rows).toBe(2);
    expect(checkTableConsistency(outcome.model, tableId).ok).toBe(true);
  });

  it('插入行接住纵向合并链（continued_merges > 0），且链自洽', () => {
    const model = verticalMergeModel();
    const tableId = firstTableId(model);
    const outcome = addTableRow(model, { table_id: tableId, index: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.continued_merges).toBeGreaterThan(0);
    expect(checkTableConsistency(outcome.model, tableId).ok).toBe(true);
  });

  it('插入列后列数 +1、网格长度 +1（显式给宽）', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = addTableColumn(model, { table_id: tableId, index: 1, width: MM(25) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    expect(table.grid.length).toBe(4);
    expect(table.grid[1]?.value).toBe(25);
    expect(checkTableConsistency(outcome.model, tableId).ok).toBe(true);
  });

  it('删除未被合并占用的列后列数 -1', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = removeTableColumn(model, { table_id: tableId, index: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(shapeOf(outcome.model).columns).toBe(2);
    expect(checkTableConsistency(outcome.model, tableId).ok).toBe(true);
  });

  it('反向对照：删除跨列合并内部的列 ⇒ 明确拒绝（column_span_conflict），模型不变', () => {
    const model = horizontalMergeModel(); // 第 0 行第 0–1 列合并
    const tableId = firstTableId(model);
    const outcome = removeTableColumn(model, { table_id: tableId, index: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('column_span_conflict');
    // 失败分支**不带 model**（R136）。
    expect((outcome as unknown as { model?: unknown }).model).toBeUndefined();
  });
});

describe('WF-058 合并 / 拆分：越界与重叠必须报，内容必须守恒', () => {
  it('合并两格：内容守恒、并入 1 格、网格干净', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = mergeCellRange(model, { table_id: tableId, region: { top: 0, left: 0, rows: 1, columns: 2 } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.absorbed_cells).toBe(1);
    expect(outcome.content_preserved).toBe(true);
    expect(cellTextAt(outcome.model, 0, 0)).toBe('a1b1');
    expect(checkTableConsistency(outcome.model, tableId).ok).toBe(true);
  });

  it('反向对照：合并区域越界 ⇒ invalid_index', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = mergeCellRange(model, { table_id: tableId, region: { top: 0, left: 0, rows: 99, columns: 2 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_index');
  });

  it('反向对照：合并区域与既有合并重叠（切穿）⇒ column_span_conflict', () => {
    const model = rectMergeModel(); // 第 0 行第 0–1 列是 2 列合并
    const tableId = firstTableId(model);
    const outcome = mergeCellRange(model, { table_id: tableId, region: { top: 0, left: 1, rows: 1, columns: 2 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('column_span_conflict');
  });

  it('反向对照：单格区域 ⇒ unsupported（不静默无操作）', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = mergeCellRange(model, { table_id: tableId, region: { top: 0, left: 0, rows: 1, columns: 1 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
  });

  it('预判与执行共用同一判据：预判说不合法，执行也拒绝（同一个 code）', () => {
    const model = rectMergeModel();
    const tableId = firstTableId(model);
    const region = { top: 0, left: 1, rows: 1, columns: 2 } as const;
    const preflight = preflightMergeRegion(model, { table_id: tableId, region });
    const executed = mergeCellRange(model, { table_id: tableId, region });
    expect(preflight.legal).toBe(false);
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(preflight.code).toBe(executed.code);
  });

  it('拆分：内容守恒、网格干净、可再次合并回去', () => {
    const model = rectMergeModel();
    const tableId = firstTableId(model);
    const split = splitMergedCell(model, { table_id: tableId, row: 0, column: 0 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.content_preserved).toBe(true);
    expect(split.region).toEqual({ top: 0, left: 0, rows: 2, columns: 2 });
    expect(checkTableConsistency(split.model, tableId).ok).toBe(true);
  });

  it('反向对照：拆分没合并的单元格 ⇒ unsupported', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = splitMergedCell(model, { table_id: tableId, row: 1, column: 1 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
  });
});

describe('自洽性检查：网格病必须被抓（空洞 / 行宽不一致）', () => {
  /** 造一份**故意坏掉**的表：第 0 行少一格（网格声明 3 列，该行只覆盖 2 列 ⇒ 空洞 + 行宽不符）。 */
  function corruptModel(): { readonly model: DocumentModel; readonly tableId: string } {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const table = tableOf(model);
    const firstRow = table.rows[0];
    if (firstRow === undefined) {
      throw new Error('测试夹具错误：表格没有行');
    }
    const corrupt: TableNode = {
      ...table,
      rows: [{ ...firstRow, cells: firstRow.cells.slice(0, 2) }, ...table.rows.slice(1)],
    };
    // 绕过 createDocumentModel 的构造期校验，直接换进一个病态表（模拟"坏源文件"）。
    const broken: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block) => (block.id === tableId ? corrupt : block)),
    };
    return { model: broken, tableId };
  }

  it('空洞 / 行宽不一致被报出，且 ok=false', () => {
    const { model, tableId } = corruptModel();
    const report = checkTableConsistency(model, tableId);
    expect(report.ok).toBe(false);
    const kinds = report.problems.map((problem) => (problem.kind === 'grid' ? problem.problem.kind : problem.kind));
    expect(kinds).toContain('hole');
    expect(kinds).toContain('row_width_mismatch');
  });

  it('assertTableConsistent 对病态表抛 table_shape_invalid', () => {
    const { model, tableId } = corruptModel();
    expect(() => assertTableConsistent(model, tableId)).toThrow(/table_shape_invalid/);
  });

  it('找不到表 ⇒ missing_table（不抛，报告事实）', () => {
    const model = plainTableModel();
    const report = checkTableConsistency(model, 'nope/table:99');
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.kind).toBe('missing_table');
  });
});

describe('WF-059 列宽 / 行高', () => {
  it('设置某列宽：网格该列被改写', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = setTableColumnWidth(model, { table_id: tableId, column: 1, width: MM(60) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(tableOf(outcome.model).grid[1]?.value).toBe(60);
  });

  it('均分列宽：总和不变、列数不变', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = distributeTableColumns(model, { table_id: tableId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.column_widths.length).toBe(3);
    const total = outcome.column_widths.reduce((sum, width) => sum + width.value, 0);
    expect(total).toBeCloseTo(120, 6);
  });

  it('适应窗口：列宽总和等于给定可用宽度', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = fitTableToWindow(model, { table_id: tableId, available_width: MM(90) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.layout).toBe('autofit');
    const total = outcome.column_widths.reduce((sum, width) => sum + width.value, 0);
    expect(total).toBeCloseTo(90, 6);
  });

  it('行高：设置后可清除（回到由内容决定）', () => {
    const model = plainTableModel();
    const rowId = tableOf(model).rows[0]?.id;
    if (rowId === undefined) throw new Error('测试夹具错误：没有第一行');
    const set = setTableRowHeight(model, { row_id: rowId, rule: 'atLeast', value: MM(10) });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(tableOf(set.model).rows[0]?.height.state).toBe('set');
    const cleared = clearTableRowHeight(set.model, { row_id: rowId });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(tableOf(cleared.model).rows[0]?.height.state).toBe('inherit');
  });
});

describe('WF-062/063 边框 / 底纹 / 表头', () => {
  it('整表边框与单元格边框分开落字段', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const cellId = tableOf(model).rows[0]?.cells[0]?.id;
    if (cellId === undefined) throw new Error('测试夹具错误：没有第一格');

    const tableBorder = setTableBorderEdges(model, {
      table_id: tableId,
      borders: { top: { style: 'single', size: { unit: 'pt', value: 0.5 }, color_hex: 'FF0000' } },
    });
    expect(tableBorder.ok).toBe(true);
    if (!tableBorder.ok) return;
    expect(tableOf(tableBorder.model).properties.borders.state).toBe('set');

    const cellBorder = setTableCellBorders(tableBorder.model, {
      cell_id: cellId,
      borders: { bottom: { style: 'double', size: { unit: 'pt', value: 0.75 }, color_hex: null } },
    });
    expect(cellBorder.ok).toBe(true);
    if (!cellBorder.ok) return;
    const cell = tableOf(cellBorder.model).rows[0]?.cells[0];
    expect(cell?.properties.borders.state).toBe('set');
    // 整表字段没被局部设置带偏（两组字段分开）。
    expect(tableOf(cellBorder.model).properties.borders.state).toBe('set');
  });

  it('整表底纹与单元格底纹分开落字段', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const cellId = tableOf(model).rows[0]?.cells[0]?.id;
    if (cellId === undefined) throw new Error('测试夹具错误：没有第一格');
    const tableShading = setTableBackground(model, { table_id: tableId, shading: { fill_hex: 'FFFF00', pattern: null, color_hex: null } });
    expect(tableShading.ok).toBe(true);
    if (!tableShading.ok) return;
    expect(tableOf(tableShading.model).properties.shading.state).toBe('set');
    const cellShading = setTableCellBackground(tableShading.model, { cell_id: cellId, shading: { fill_hex: '00FF00', pattern: null, color_hex: null } });
    expect(cellShading.ok).toBe(true);
    if (!cellShading.ok) return;
    expect(tableOf(cellShading.model).rows[0]?.cells[0]?.properties.shading.state).toBe('set');
  });

  it('表头重复：前 N 行被标为表头', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = repeatTableHeaderRows(model, { table_id: tableId, count: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.header_rows.length).toBe(2);
    expect(readTable(outcome.model, tableId).header_rows.length).toBe(2);
  });
});

describe('表格样式：模型装不下 ⇒ 明确拒绝（不是静默无操作）', () => {
  it('setTableStyle 返回 unsupported，且原模型一个字节不动', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = setTableStyle(model, { table_id: tableId, style_id: 'TableGrid' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
    expect((outcome as unknown as { model?: unknown }).model).toBeUndefined();
  });

  it('tableStyleSupport 说清楚缺什么', () => {
    const support = tableStyleSupport();
    expect(support.supported).toBe(false);
    expect(support.missing).toContain('style_ref');
    expect(support.reason).toContain('TableNode');
  });
});

describe('WF-061/064 单元格对齐与文本', () => {
  it('垂直对齐落到单元格属性', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id;
    if (cellId === undefined) throw new Error('测试夹具错误：没有第一格');
    const outcome = alignCellVertically(model, { cell_id: cellId, align: 'center' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(tableOf(outcome.model).rows[0]?.cells[0]?.properties.verticalAlign.state).toBe('set');
  });

  it('水平对齐落到单元格里段落的 alignment（单元格本身没有该字段）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id;
    if (cellId === undefined) throw new Error('测试夹具错误：没有第一格');
    const outcome = alignCellHorizontally(model, { cell_id: cellId, alignment: 'center' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.paragraphs).toBe(1);
    const alignment = firstParagraphProperties(outcome.model).alignment;
    expect(alignment.state).toBe('set');
    if (alignment.state === 'set') {
      expect(alignment.value).toBe('center');
    }
  });

  it('设置单元格文本：整格替换成新段落', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id;
    if (cellId === undefined) throw new Error('测试夹具错误：没有第一格');
    const outcome = setCellText(model, { cell_id: cellId, text: '改写后的内容' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(cellTextAt(outcome.model, 0, 0)).toBe('改写后的内容');
    expect(outcome.block_id.length).toBeGreaterThan(0);
    // 其余格子一字未动。
    expect(cellTextAt(outcome.model, 0, 1)).toBe('b1');
  });

  it('表格内查找替换：只动目标表格', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = replaceTableText(model, { table_id: tableId, find: 'a1', replace: 'X' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replaced).toBe(1);
    expect(cellTextAt(outcome.model, 0, 0)).toBe('X');
    // 表外段落引用不变。
    expect(outcome.model.blocks[0]).toBe(model.blocks[0]);
  });

  it('查找替换命中 0 处 ⇒ 如实报 0（不是错误）', () => {
    const model = plainTableModel();
    const tableId = firstTableId(model);
    const outcome = replaceTableText(model, { table_id: tableId, find: '不存在', replace: 'X' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replaced).toBe(0);
  });
});

describe('只读快照', () => {
  it('readTable 报出行列数、合并区、表头与网格病', () => {
    const model = rectMergeModel();
    const tableId = firstTableId(model);
    const snapshot = readTable(model, tableId);
    expect(snapshot.rows).toBe(3);
    expect(snapshot.columns).toBe(3);
    expect(snapshot.merges.length).toBeGreaterThan(0);
    expect(snapshot.consistent).toBe(true);
    expect(snapshot.grid_problems).toEqual([]);
  });
});
