/**
 * P06 · **数据变更同版更新**的定向验收（PPT-09「数据可编辑」）。
 *
 * ## 判据走独立来源
 *
 * - **工作簿格描述符**：与 `charts.ts` 的 `renderEmbeddedWorkbookBytes` 产出的**真 XLSX 字节**
 *   交叉断言——从 ZIP 里解出 `xl/worksheets/sheet1.xml`，逐格读回地址 / 文本 / 数值，
 *   与描述符**地址集合相等、逐格值相等**；不拿待测代码自证。
 * - **布局**：与 `charts.ts` 的 `chartDataGrid` 逐行交叉（类别列 / 系列列）。
 * - **同版更新**：`applyDataEdit` 改一个点后，**图上的引用**与**工作簿的格**必须都指向新值、
 *   版本指纹必须变；再把"只更新一半"的快照喂给 `verifyChartDataCoherence`，必须**具名报红**。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { chartDataGrid, renderEmbeddedWorkbookBytes } from '../../../../src/presentations/charts.js';
import type { ChartModel } from '../../../../src/presentations/model.js';
import {
  TableChartPartsError,
  applyDataEdit,
  chartDataFromWorkbookCells,
  dataVersionOf,
  snapshotChartData,
  validateChartData,
  verifyChartDataCoherence,
  workbookCellsFromChartData,
  type ChartDataSnapshot,
  type ExpectedChartData,
  type TableChartPartsErrorReason,
  type WorkbookCell,
} from '../../../../src/presentations/table-chart-parts/index.js';

// ---------------------------------------------------------------------------
// 夹具：两步柱状图（类别 3、系列 2）
// ---------------------------------------------------------------------------

const CHART: ChartModel = {
  chart_type: 'bar',
  title: '季度销量',
  categories: ['Q1', 'Q2', 'Q3'],
  series: [
    { name: '北区', values: [10, 20, 30] },
    { name: '南区', values: [15, 25, 35] },
  ],
};

const DATA: ExpectedChartData = { categories: CHART.categories, series: CHART.series };

/** 从真 XLSX 字节里解出 `sheet1.xml` 的单元格记录。 */
interface SheetCell {
  readonly addr: string;
  readonly inline: string | null;
  readonly numeric: string | null;
}

function realWorkbookCells(chart: ChartModel): readonly SheetCell[] {
  const archive = readZip(renderEmbeddedWorkbookBytes(chart));
  const entry = archive.entries.find((candidate) => candidate.path === 'xl/worksheets/sheet1.xml');
  if (entry === undefined) throw new Error('嵌入工作簿里没有 xl/worksheets/sheet1.xml');
  const xml = Buffer.from(entry.data).toString('utf8');
  const cells: SheetCell[] = [];
  for (const chunk of xml.split('<c ').slice(1)) {
    const address = /r="([A-Z]+[0-9]+)"/.exec(chunk);
    if (address === null) continue;
    cells.push({
      addr: address[1] as string,
      inline: /<t>([^<]*)<\/t>/.exec(chunk)?.[1] ?? null,
      numeric: /<v>([^<]*)<\/v>/.exec(chunk)?.[1] ?? null,
    });
  }
  return cells;
}

function expectReason(fn: () => unknown, reason: TableChartPartsErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TableChartPartsError);
    expect((error as TableChartPartsError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ${reason}，但没有抛错`);
}

function cellAt(cells: readonly WorkbookCell[], address: string): WorkbookCell {
  const cell = cells.find((candidate) => candidate.address === address);
  if (cell === undefined) throw new Error(`描述符里没有格 ${address}`);
  return cell;
}

// ---------------------------------------------------------------------------
// A. 描述符 ↔ 真工作簿字节
// ---------------------------------------------------------------------------

describe('A. 工作簿格描述符与真 XLSX 字节一致', () => {
  it('地址集合相等、逐格文本与数值相等（2 系列名 + 3 类别 + 6 值 = 11 格）', () => {
    const descriptor = workbookCellsFromChartData(DATA);
    const real = realWorkbookCells(CHART);

    expect(descriptor).toHaveLength(11);
    expect(new Set(descriptor.map((cell) => cell.address))).toEqual(new Set(real.map((cell) => cell.addr)));

    for (const cell of descriptor) {
      const actual = real.find((candidate) => candidate.addr === cell.address);
      expect(actual, `真工作簿缺格 ${cell.address}`).toBeDefined();
      if (cell.role === 'value') {
        expect(Number(actual?.numeric)).toBe(cell.value);
        expect(cell.text).toBeNull();
      } else {
        expect(actual?.inline).toBe(cell.text);
        expect(cell.value).toBeNull();
      }
    }
  });

  it('布局与 charts.ts 的 chartDataGrid 逐行交叉：类别列 + 各系列列', () => {
    const descriptor = workbookCellsFromChartData(DATA);
    const grid = chartDataGrid(CHART);
    expect(grid[0]).toEqual(['类别', '北区', '南区']);

    DATA.categories.forEach((_category, rowIndex) => {
      const gridRow = grid[rowIndex + 1] as readonly string[];
      expect(cellAt(descriptor, `A${String(rowIndex + 2)}`).text).toBe(gridRow[0]);
      DATA.series.forEach((_series, seriesIndex) => {
        const column = String.fromCharCode(66 + seriesIndex); // B / C
        expect(cellAt(descriptor, `${column}${String(rowIndex + 2)}`).value).toBe(Number(gridRow[seriesIndex + 1]));
      });
    });
  });

  it('反解回图表数据 = 原数据（格 → 数据 的逆映射无损）', () => {
    expect(chartDataFromWorkbookCells(workbookCellsFromChartData(DATA))).toEqual(DATA);
  });
});

// ---------------------------------------------------------------------------
// B. 快照一致性（正向）
// ---------------------------------------------------------------------------

describe('B. 快照同版复核（正向）', () => {
  it('snapshotChartData 的三样同源，复核通过并给出可复核计数', () => {
    const snapshot = snapshotChartData(DATA);
    expect(snapshot.version).toBe(dataVersionOf(DATA));
    expect(snapshot.version).toMatch(/^dc1-[0-9a-f]{8}$/);
    expect(snapshot.references[1]?.value_ref).toBe('Sheet1!$C$2:$C$4');

    const report = verifyChartDataCoherence(snapshot);
    expect(report).toEqual({
      version: snapshot.version,
      series_count: 2,
      category_count: 3,
      cell_count: 11,
      reference_point_count: 6,
    });
  });

  it('版本指纹确定：同数据同串，改一个值即变', () => {
    const copy: ExpectedChartData = {
      categories: [...DATA.categories],
      series: DATA.series.map((series) => ({ name: series.name, values: [...series.values] })),
    };
    expect(dataVersionOf(DATA)).toBe(dataVersionOf(copy));
    const changed: ExpectedChartData = {
      categories: DATA.categories,
      series: [
        { name: DATA.series[0]!.name, values: [10, 20, 31] },
        { name: DATA.series[1]!.name, values: [...DATA.series[1]!.values] },
      ],
    };
    expect(dataVersionOf(changed)).not.toBe(dataVersionOf(DATA));
  });
});

// ---------------------------------------------------------------------------
// C. 数据变更 → 图与表一起更新
// ---------------------------------------------------------------------------

describe('C. 改数据后图与表同版更新', () => {
  it('改南区的 Q1 值为 99：工作簿 C2 格、图上第二个系列第 0 点、版本三者一起变', () => {
    const before = snapshotChartData(DATA);
    const after = applyDataEdit(before, { kind: 'set_value', series_index: 1, category_index: 0, value: 99 });

    // 表：C2 变 99
    expect(cellAt(after.cells, 'C2').value).toBe(99);
    // 图：第二个系列（C 列）第 0 点变 99
    expect(after.references[1]?.points[0]).toBe(99);
    expect(after.references[1]?.value_ref).toBe('Sheet1!$C$2:$C$4');
    // 版本变了
    expect(after.version).not.toBe(before.version);
    // 原快照未被就地改（不可变）
    expect(cellAt(before.cells, 'C2').value).toBe(15);
    expect(before.references[1]?.points[0]).toBe(15);
    // 校验仍过
    expect(verifyChartDataCoherence(after).version).toBe(after.version);
  });

  it('改系列名 / 类别后，工作簿对应格与图上引用同步', () => {
    const renamed = applyDataEdit(snapshotChartData(DATA), { kind: 'set_series_name', series_index: 0, name: '东区' });
    expect(cellAt(renamed.cells, 'B1').text).toBe('东区');
    expect(renamed.references[0]?.name).toBe('东区');

    const recat = applyDataEdit(snapshotChartData(DATA), { kind: 'set_category', category_index: 2, text: 'Q4' });
    expect(cellAt(recat.cells, 'A4').text).toBe('Q4');
    expect(verifyChartDataCoherence(recat)).toBeDefined();
  });

  it('replace 整份数据后仍然同版通过', () => {
    const next = applyDataEdit(snapshotChartData(DATA), {
      kind: 'replace',
      data: { categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] },
    });
    expect(next.cells).toHaveLength(1 + 2 + 2);
    expect(verifyChartDataCoherence(next).reference_point_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D. 反向对照：半更新 / 篡改必须具名报红
// ---------------------------------------------------------------------------

describe('D. 反向对照（半更新必须红）', () => {
  const after = applyDataEdit(snapshotChartData(DATA), { kind: 'set_value', series_index: 1, category_index: 0, value: 99 });

  it('只更新了工作簿、没更新图上引用 ⇒ chart_data_desync / point_value_mismatch', () => {
    // 表是新的、图是旧的（图没跟上）
    const halfReferences: ChartDataSnapshot = { ...after, references: snapshotChartData(DATA).references };
    expectReason(() => verifyChartDataCoherence(halfReferences), 'point_value_mismatch');

    // 图是新的、表是旧的（表没跟上）
    const halfCells: ChartDataSnapshot = { ...after, cells: snapshotChartData(DATA).cells };
    expectReason(() => verifyChartDataCoherence(halfCells), 'chart_data_desync');
  });

  it('版本指纹与数据不符 ⇒ version_mismatch', () => {
    const stale: ChartDataSnapshot = { ...after, version: snapshotChartData(DATA).version };
    expectReason(() => verifyChartDataCoherence(stale), 'version_mismatch');
  });

  it('篡改工作簿格：删一格 / 改地址错位 ⇒ incomplete_workbook_cells', () => {
    const missing: ChartDataSnapshot = { ...after, cells: after.cells.filter((cell) => cell.address !== 'C2') };
    expectReason(() => verifyChartDataCoherence(missing), 'incomplete_workbook_cells');

    const misfiled: ChartDataSnapshot = {
      ...after,
      cells: after.cells.map((cell) => (cell.address === 'C2' ? { ...cell, address: 'D2' } : cell)),
    };
    expectReason(() => verifyChartDataCoherence(misfiled), 'incomplete_workbook_cells');
  });

  it('越界编辑 / 非法数据都具名报错', () => {
    const snapshot = snapshotChartData(DATA);
    expectReason(() => applyDataEdit(snapshot, { kind: 'set_value', series_index: 9, category_index: 0, value: 1 }), 'unknown_edit_target');
    expectReason(() => applyDataEdit(snapshot, { kind: 'set_category', category_index: 5, text: 'x' }), 'unknown_edit_target');
    // 改成与另一系列同名 ⇒ 数据形态非法
    expectReason(
      () => applyDataEdit(snapshot, { kind: 'set_series_name', series_index: 0, name: '南区' }),
      'invalid_chart_data',
    );
    expectReason(() => validateChartData({ categories: [], series: DATA.series }), 'invalid_chart_data');
    expectReason(() => validateChartData({ categories: DATA.categories, series: [{ name: 'x', values: [1] }] }), 'invalid_chart_data');
    expectReason(() => validateChartData({ categories: DATA.categories, series: [{ name: 'x', values: [1, Number.NaN, 3] }] }), 'invalid_chart_data');
  });
});
