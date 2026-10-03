/**
 * **X-I13**：把 `retargetChartReferences` / `retargetChartSet` 从"只认 A1 区域"扩展到
 * **结构化表格列引用**（`Table[Column]`）与**定义名引用**（`Tax`）。
 *
 * 判据不照抄实现，而是对齐 Excel 的引用迁移语义与 OOXML 写法：
 *
 * 1. **来源解析**：`structuredTableReference` 把列解析成表**数据体**窗口（跳过标题行 /
 *    汇总行）；`definedNameReference` 把命名引用解析成具体表 + 区域。
 * 2. **同一套迁移规则**：结构化 / 定义名引用与 A1 引用一样——前插下移、内插变长、
 *    删光删系列、跨表不动、非法 edit 抛 `ValidationError`。
 * 3. **原始形态保留**：迁移后 `source` 原样保留，`chartReferenceText` 仍写 `Table[Column]` /
 *    名字；这是 Excel 对表 / 名绑定图表的实际写法。
 * 4. **写进真实 `<c:f>`**：迁移后的 A1 引用把**新区域**写进真实 `.xlsx` 的 `<c:f>`；
 *    结构化 / 定义名引用写它们的原始形态。
 * 5. **反面对照**：不存在的列 / 只有标题行的表 / 非法的原形态都显式抛错。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import {
  addChart,
  chartReferenceText,
  createChart,
  createChartSet,
  definedNameReference,
  retargetChartReferences,
  retargetChartSet,
  structuredTableReference,
  validateChartReference,
  writeChartWorkbookXlsx,
  type ChartState,
} from '../../../../src/spreadsheets/charts.js';
import { createSheet, deleteColumns, deleteRows, insertRows, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createStructuredTable } from '../../../../src/spreadsheets/structured-table.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';

/** Data 表：A 列项目、B 列金额，行 2..5 为数据体；Other 表另有一份。 */
function baseWorkbook() {
  let data = createSheet('Data', { row_count: 60, column_count: 12 });
  let other = createSheet('Other', { row_count: 60, column_count: 12 });
  data = setCellValue(data, 'A1', textValue('项目'));
  data = setCellValue(data, 'B1', textValue('金额'));
  for (let row = 2; row <= 5; row += 1) {
    data = setCellValue(data, `A${row}`, textValue(`项目${String(row - 1)}`));
    data = setCellValue(data, `B${row}`, numberValue(row * 10));
    other = setCellValue(other, `B${row}`, numberValue(row));
  }
  return createWorkbook([data, other]);
}

/** 描述 Data!A1:B5 的结构化表格 Sales（标题行 + 4 行数据，无汇总行）。 */
const SALES = createStructuredTable({
  name: 'Sales',
  range: 'A1:B5',
  columns: ['项目', '金额'],
});

describe('X-I13 来源解析', () => {
  it('structuredTableReference 解析成数据体窗口（B2:B5）并带上表格来源', () => {
    const ref = structuredTableReference(SALES, 'Data', '金额');
    expect(ref.sheet).toBe('Data');
    expect(ref.range).toBe('B2:B5');
    expect(ref.source).toEqual({ kind: 'table', table: 'Sales', column: '金额' });
    expect(chartReferenceText(ref)).toBe('Sales[金额]');
  });

  it('表里没有的列 ⇒ 抛（不静默给个空引用）', () => {
    expect(() => structuredTableReference(SALES, 'Data', '不存在列')).toThrow(ValidationError);
  });

  it('只有标题行的表 ⇒ 抛（图表系列必须有数值来源）', () => {
    const headerOnly = createStructuredTable({ name: 'Empty', range: 'A1:B1', columns: ['A', 'B'] });
    expect(() => structuredTableReference(headerOnly, 'Data', 'A')).toThrow(ValidationError);
  });

  it('带汇总行的表：数据体不含汇总行（B2:B5 而不是 B2:B6）', () => {
    const withTotals = createStructuredTable({
      name: 'T',
      range: 'A1:B6',
      columns: ['项目', '金额'],
      totals_row: true,
    });
    expect(structuredTableReference(withTotals, 'Data', '金额').range).toBe('B2:B5');
  });

  it('definedNameReference 解析成具体表 + 区域并带上名字来源', () => {
    const refL = definedNameReference({ name: 'Price', sheet: 'Data', ref: 'B2:B5' }, 'Data');
    expect(refL.sheet).toBe('Data');
    expect(refL.range).toBe('B2:B5');
    expect(refL.source).toEqual({ kind: 'defined_name', name: 'Price' });
    expect(chartReferenceText(refL)).toBe('Price');
  });

  it('相对定义名（sheet === null）用 default_sheet 绑定', () => {
    const ref = definedNameReference({ name: '本地名', sheet: null, ref: 'B2:B4' }, 'Other');
    expect(ref.sheet).toBe('Other');
    expect(chartReferenceText(ref)).toBe('本地名');
  });
});

describe('X-I13 结构化表格引用随结构迁移', () => {
  function tableChart(workbook: ReturnType<typeof baseWorkbook>): ChartState {
    return createChart(workbook, {
      name: '表格图',
      kind: 'column',
      series: [{ values: structuredTableReference(SALES, 'Data', '金额') }],
    });
  }

  it('范围前插 1 行 ⇒ 数据体窗口下移（B2:B5 → B3:B6），来源保留', () => {
    const before = baseWorkbook();
    const chart = tableChart(before);
    const after = createWorkbook([insertRows(before.sheets[0]!, 1, 1), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    const values = outcome.chart.series[0]!.values;
    expect(values.range).toBe('B3:B6');
    expect(values.source).toEqual({ kind: 'table', table: 'Sales', column: '金额' });
    expect(chartReferenceText(values)).toBe('Sales[金额]');
    expect(outcome.warnings).toEqual([]);
  });

  it('数据体内插 2 行 ⇒ 窗口变长（B2:B5 → B2:B7）', () => {
    const before = baseWorkbook();
    const chart = tableChart(before);
    const after = createWorkbook([insertRows(before.sheets[0]!, 3, 2), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 3, count: 2 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(outcome.chart.series[0]!.values.range).toBe('B2:B7');
  });

  it('数据体全删 ⇒ 系列被删、图表 removed（不留空图）', () => {
    const before = baseWorkbook();
    const chart = tableChart(before);
    const after = createWorkbook([deleteRows(before.sheets[0]!, 2, 4), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_rows', at: 2, count: 4 });
    expect(outcome.kind).toBe('removed');
    if (outcome.kind !== 'removed') return;
    expect(outcome.warnings[0]?.code).toBe('series_dropped');
  });

  it('删掉数值所在列 ⇒ 系列被删', () => {
    const before = baseWorkbook();
    const chart = tableChart(before);
    const after = createWorkbook([deleteColumns(before.sheets[0]!, 2, 1), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_columns', at: 2, count: 1 });
    expect(outcome.kind).toBe('removed');
  });
});

describe('X-I13 定义名引用随结构迁移', () => {
  it('前插下移 + 保留名字来源', () => {
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: '名字图',
      kind: 'column',
      series: [{ values: definedNameReference({ name: 'Price', sheet: 'Data', ref: 'B2:B5' }, 'Data') }],
    });
    const after = createWorkbook([insertRows(before.sheets[0]!, 1, 1), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    const values = outcome.chart.series[0]!.values;
    expect(values.range).toBe('B3:B6');
    expect(values.source).toEqual({ kind: 'defined_name', name: 'Price' });
    expect(chartReferenceText(values)).toBe('Price');
  });

  it('删光名字目标区域 ⇒ 系列被删', () => {
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: '名字图',
      kind: 'column',
      series: [{ values: definedNameReference({ name: 'Price', sheet: 'Data', ref: 'B2:B5' }, 'Data') }],
    });
    const after = createWorkbook([deleteRows(before.sheets[0]!, 2, 4), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'delete_rows', at: 2, count: 4 });
    expect(outcome.kind).toBe('removed');
  });
});

describe('X-I13 跨表 / 集合 / 反面对照', () => {
  it('编辑 Data 时，指向 Other 的表引用不动（跨表不动）', () => {
    const OTHER_TABLE = createStructuredTable({ name: 'OtherSales', range: 'A1:B5', columns: ['项目', '金额'] });
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: '跨表图',
      kind: 'column',
      series: [{ values: structuredTableReference(OTHER_TABLE, 'Other', '金额') }],
    });
    const after = createWorkbook([insertRows(before.sheets[0]!, 1, 3), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 1, count: 3 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    expect(outcome.chart.series[0]!.values.range).toBe('B2:B5');
  });

  it('retargetChartSet 对结构化引用同样生效，并汇总 warnings', () => {
    const before = baseWorkbook();
    let set = createChartSet(before, 'Data');
    set = addChart(
      set,
      createChart(before, {
        name: '存活',
        kind: 'column',
        series: [{ values: structuredTableReference(SALES, 'Data', '金额') }],
      }),
    );
    set = addChart(
      set,
      createChart(before, {
        name: '被删',
        kind: 'column',
        series: [{ values: definedNameReference({ name: 'Gone', sheet: 'Data', ref: 'B3:B5' }, 'Data') }],
      }),
    );
    const after = createWorkbook([deleteRows(before.sheets[0]!, 3, 3), before.sheets[1]!]);
    const outcome = retargetChartSet(after, set, { kind: 'delete_rows', at: 3, count: 3 });
    expect(outcome.removed).toEqual(['被删']);
    expect(outcome.set.charts.map((chart) => chart.name)).toEqual(['存活']);
    expect(outcome.warnings.length).toBeGreaterThan(0);
  });

  it('非法 edit（at=0 / count=0）⇒ 抛，不静默不动', () => {
    const workbook = baseWorkbook();
    const chart = createChart(workbook, {
      name: '名字图',
      kind: 'column',
      series: [{ values: definedNameReference({ name: 'Price', sheet: 'Data', ref: 'B2:B5' }, 'Data') }],
    });
    expect(() =>
      retargetChartReferences(workbook, chart, 'Data', { kind: 'insert_rows', at: 0, count: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      retargetChartReferences(workbook, chart, 'Data', { kind: 'insert_rows', at: 1, count: 0 }),
    ).toThrow(ValidationError);
  });

  it('validateChartReference 保留并校验来源；空的来源字段抛错', () => {
    const workbook = baseWorkbook();
    const normalized = validateChartReference(workbook, structuredTableReference(SALES, 'Data', '金额'), 'series[0].values');
    expect(normalized.source).toEqual({ kind: 'table', table: 'Sales', column: '金额' });
    expect(() =>
      validateChartReference(
        workbook,
        { sheet: 'Data', range: 'B2:B5', source: { kind: 'table', table: '', column: '金额' } },
        'series[0].values',
      ),
    ).toThrow(ValidationError);
  });
});

describe('X-I13 写进真实 .xlsx 的 <c:f>', () => {
  function chartPartText(bytes: ReturnType<typeof writeChartWorkbookXlsx>['bytes']): string {
    const part = readZip(bytes).by_path.get('xl/charts/chart1.xml');
    if (part === undefined) throw new Error('缺少 chart1.xml');
    return new TextDecoder().decode(part.data);
  }

  it('迁移后的 A1 引用把新区域写进 <c:f>', () => {
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: 'A1 图',
      kind: 'column',
      series: [{ values: { sheet: 'Data', range: 'B2:B5' } }],
    });
    const after = createWorkbook([insertRows(before.sheets[0]!, 1, 1), before.sheets[1]!]);
    const outcome = retargetChartReferences(after, chart, 'Data', { kind: 'insert_rows', at: 1, count: 1 });
    if (outcome.kind !== 'retargeted') throw new Error('应当保留');
    const set = addChart(createChartSet(after, 'Data'), outcome.chart);
    const xml = chartPartText(writeChartWorkbookXlsx(after, [set]).bytes);
    expect(xml).toContain("'Data'!$B$3:$B$6");
    expect(xml).not.toContain("'Data'!$B$2:$B$5");
  });

  it('结构化表格列引用写 Table1[Amount]（Excel 实际写法），而不是钉死 A1', () => {
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: '表格图',
      kind: 'column',
      series: [{ values: structuredTableReference(SALES, 'Data', '金额') }],
    });
    const set = addChart(createChartSet(before, 'Data'), chart);
    const xml = chartPartText(writeChartWorkbookXlsx(before, [set]).bytes);
    expect(xml).toContain('Sales[金额]');
  });

  it('定义名引用写名字本身（Price）', () => {
    const before = baseWorkbook();
    const chart = createChart(before, {
      name: '名字图',
      kind: 'column',
      series: [{ values: definedNameReference({ name: 'Price', sheet: 'Data', ref: 'B2:B5' }, 'Data') }],
    });
    const set = addChart(createChartSet(before, 'Data'), chart);
    const xml = chartPartText(writeChartWorkbookXlsx(before, [set]).bytes);
    expect(xml).toContain('>Price<');
  });

  it('列名里的结构化特殊字符按 Excel 口径转义', () => {
    const special = createStructuredTable({ name: 'Special', range: 'A1:B5', columns: ['A', 'Qty]total'] });
    const ref = structuredTableReference(special, 'Data', 'Qty]total');
    expect(chartReferenceText(ref)).toBe("Special[Qty']total]");
  });
});
