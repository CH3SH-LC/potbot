/**
 * **X07**：源表结构变化时同步图表引用（XLS-12「源表变化同步图表」）。
 *
 * 判据来自 Excel 的引用迁移语义（不是照抄实现）。五组：
 *
 * 1. **插入**：范围前插 / 范围内插 / 边界插——端点按 `≥ at` 平移，跨过 `at` 的范围变长；
 * 2. **删除**：区间前不动、区间后上移、部分重叠收缩；
 * 3. **删光 ⇒ 删系列**：数值 / 分类区域被整个删掉 ⇒ 该系列被移除并记 warning，
 *    全部系列没了 ⇒ 图表 `removed`（不留一张没有数据来源的空图）；
 * 4. **只动目标表**：指向别的工作表的引用不被这次编辑波及；
 * 5. **反面对照 + 端到端**：非法 edit 抛错；迁移后的范围写进真实 `.xlsx` 的 `<c:f>`。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../src/protocol/index.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  addChart,
  chartReferenceText,
  createChart,
  createChartSet,
  retargetChartReferences,
  retargetChartSet,
  writeChartWorkbookXlsx,
  type ChartState,
} from '../../../../src/spreadsheets/charts.js';
import {
  createSheet,
  deleteColumns,
  deleteRows,
  insertColumns,
  insertRows,
  setCellValue,
  type SheetState,
} from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, getSheet, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';

/** A 列分类 + B 列数值，行 2..5；另有 'Other' 表（B 列 2..5）。 */
function baseWorkbook(): WorkbookState {
  let data = createSheet('Data', { row_count: 60, column_count: 12 });
  let other = createSheet('Other', { row_count: 60, column_count: 12 });
  for (let row = 2; row <= 5; row += 1) {
    data = setCellValue(data, `A${row}`, textValue(`项目${row - 1}`));
    data = setCellValue(data, `B${row}`, numberValue(row * 10));
    other = setCellValue(other, `B${row}`, numberValue(row));
  }
  return createWorkbook([data, other]);
}

function baseChart(workbook: WorkbookState): ChartState {
  return createChart(workbook, {
    name: '销售图',
    kind: 'column',
    series: [
      { values: { sheet: 'Data', range: 'B2:B5' }, categories: { sheet: 'Data', range: 'A2:A5' } },
    ],
  });
}

/** 用编辑函数改写 'Data' 表，返回编辑后的工作簿（'Other' 表原样带过）。 */
function editData(workbook: WorkbookState, edit: (sheet: SheetState) => SheetState): WorkbookState {
  const data = getSheet(workbook, 'Data');
  const other = getSheet(workbook, 'Other');
  if (data === undefined || other === undefined) throw new Error('缺少 Data / Other 表');
  return createWorkbook([edit(data), other]);
}

function values(chart: ChartState, index = 0): string | undefined {
  return chart.series[index]?.values.range;
}

function categories(chart: ChartState, index = 0): string | undefined {
  return chart.series[index]?.categories?.range;
}

describe('X07 源表同步：插入行列', () => {
  it('范围前插 1 行 ⇒ 整体下移（B2:B5 → B3:B6）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => insertRows(sheet, 1, 1));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(values(outcome.chart)).toBe('B3:B6');
    expect(categories(outcome.chart)).toBe('A3:A6');
    expect(outcome.warnings).toEqual([]);
  });

  it('范围内插 2 行 ⇒ 范围变长（B2:B5 → B2:B7）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => insertRows(sheet, 3, 2));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 3, count: 2 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(values(outcome.chart)).toBe('B2:B7');
  });

  it('范围前插 1 列 ⇒ 整体右移（B2:B5 → C2:C5，仍是单列）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => insertColumns(sheet, 1, 1));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_columns', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(values(outcome.chart)).toBe('C2:C5');
  });
});

describe('X07 源表同步：删除行列', () => {
  it('范围前删 1 行 ⇒ 整体上移（B2:B5 → B1:B4）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => deleteRows(sheet, 1, 1));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_rows', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(values(outcome.chart)).toBe('B1:B4');
  });

  it('范围中删 1 行 ⇒ 收缩（B2:B5 → B2:B4）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => deleteRows(sheet, 3, 1));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_rows', at: 3, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(values(outcome.chart)).toBe('B2:B4');
    expect(categories(outcome.chart)).toBe('A2:A4');
  });

  it('删光数值区域 ⇒ 系列被删、图表 removed（不留空图）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => deleteRows(sheet, 2, 4));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_rows', at: 2, count: 4 });
    expect(outcome.kind).toBe('removed');
    if (outcome.kind !== 'removed') return;
    expect(outcome.chart_name).toBe('销售图');
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.code).toBe('series_dropped');
  });

  it('删掉数值所在列 ⇒ 系列被删、图表 removed', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => deleteColumns(sheet, 2, 1));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_columns', at: 2, count: 1 });
    expect(outcome.kind).toBe('removed');
  });
});

describe('X07 源表同步：只动目标表', () => {
  it('编辑 Data 时指向 Other 的引用不动', () => {
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: '跨表',
      kind: 'line',
      series: [
        { values: { sheet: 'Other', range: 'B2:B5' }, categories: { sheet: 'Data', range: 'A2:A5' } },
      ],
    });
    const after = editData(before, (sheet) => insertRows(sheet, 2, 3));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 2, count: 3 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    // Other 的引用原样；Data 的分类区从起始行起整体下移 3 行
    expect(values(outcome.chart)).toBe('B2:B5');
    expect(categories(outcome.chart)).toBe('A5:A8');
  });
});

describe('X07 源表同步：集合级与端到端', () => {
  it('retargetChartSet 只移除被删光的图、保留其余，并汇总 warnings', () => {
    const before = baseWorkbook();
    const set = addChart(
      addChart(
        createChartSet(before, 'Data'),
        createChart(before, {
          name: '存活图',
          kind: 'column',
          series: [{ values: { sheet: 'Data', range: 'B1:B1' } }],
        }),
      ),
      createChart(before, {
        name: '被删图',
        kind: 'column',
        series: [{ values: { sheet: 'Data', range: 'B3:B5' } }],
      }),
    );
    const after = editData(before, (sheet) => deleteRows(sheet, 3, 3));
    const outcome = retargetChartSet(after, set, { kind: 'delete_rows', at: 3, count: 3 });
    expect(outcome.removed).toEqual(['被删图']);
    expect(outcome.set.charts.map((chart) => chart.name)).toEqual(['存活图']);
    expect(outcome.warnings.length).toBeGreaterThan(0);
  });

  it('迁移后的范围写进真实 .xlsx 的 <c:f>（端到端）', () => {
    const before = baseWorkbook();
    const chart = baseChart(before);
    const after = editData(before, (sheet) => insertRows(sheet, 1, 1));
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(chartReferenceText(outcome.chart.series[0]!.values)).toBe("'Data'!$B$3:$B$6");

    const set = addChart(createChartSet(after, 'Data'), outcome.chart);
    const bytes = writeChartWorkbookXlsx(after, [set]).bytes;
    const chartPart = readZip(bytes).by_path.get('xl/charts/chart1.xml');
    expect(chartPart).toBeDefined();
    const xml = new TextDecoder().decode(chartPart!.data);
    expect(xml).toContain("'Data'!$B$3:$B$6");
    expect(xml).not.toContain("'Data'!$B$2:$B$5");
  });
});

describe('X07 源表同步：反面对照', () => {
  it('非法 edit（at=0 / count=0）⇒ 抛，不静默不动', () => {
    const workbook = baseWorkbook();
    const chart = baseChart(workbook);
    expect(() =>
      retargetChartReferences(workbook, chart, 'Data', { kind: 'insert_rows', at: 0, count: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      retargetChartReferences(workbook, chart, 'Data', { kind: 'delete_rows', at: 1, count: 0 }),
    ).toThrow(ValidationError);
  });
});
