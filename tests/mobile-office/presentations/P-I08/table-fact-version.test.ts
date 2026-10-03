/**
 * P-I08 · **表格侧同版事实**（table-side fact fingerprint）的定向验收。
 *
 * 补 P06 留下的表侧缺口：图引用 / 内嵌工作簿格 / **表字面量（含合并单元格）**必须盖
 * **同一枚** `dc1-*` 指纹（PPT-16「文本 / 图表 / 表格一致」）。
 *
 * ## 判据走独立来源
 *
 * - **布局**：表字面量（地址 / 文本 / 数值）与 `charts.ts` 的 `renderEmbeddedWorkbookBytes`
 *   产出的**真 XLSX 字节**交叉断言——从 ZIP 解出 `xl/worksheets/sheet1.xml`，逐格读回，
 *   地址集合相等、逐格值相等；并与 `chartDataGrid` 逐行交叉。不拿待测代码自证。
 * - **三处同版**：一次编辑后，图引用、工作簿格、表字面量各自**反解**出的数据必须都等于
 *   新数据，三者反算出的指纹必须**只有一枚**（= 快照版本），且与原版不同——指纹**只变一次**。
 * - **合并**：合并覆盖与事实引用迁移与 `merge-matrix.ts` 的覆盖口径交叉；合并把两个事实
 *   压成一格 / 事实不在源格 ⇒ **具名红**（`table_merge_conflict`），不静默取其一。
 *
 * ## 反向对照（必须红）
 *
 * 表没跟上（字面量旧 / 指纹旧 / 格指纹错 / 来源未迁移）⇒ `table_fact_desync` /
 * `version_mismatch`；合并事实不安全 ⇒ `table_merge_conflict`；装饰格 / 类型不符 /
 * 越界格编辑 ⇒ `unknown_table_cell`。P06 的既有负例（半更新图 / 半更新表 / 旧指纹 /
 * 缺格 / 越界编辑 / 非法数据）在本文件里**重放**，证明仍然红。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { chartDataGrid, renderEmbeddedWorkbookBytes } from '../../../../src/presentations/charts.js';
import type { ChartModel } from '../../../../src/presentations/model.js';
import {
  TableChartPartsError,
  applyDataEdit,
  applyTableCellEdit,
  chartDataFromTableLiterals,
  chartDataFromWorkbookCells,
  chartEditForTableCell,
  dataVersionOf,
  snapshotChartData,
  tableCellAt,
  tableFactCells,
  tableFactVersionOf,
  tableMirrorFromChartData,
  validateChartData,
  verifyChartDataCoherence,
  verifyTableFactCoherence,
  workbookVersionOf,
  type ChartDataSnapshot,
  type ExpectedChartData,
  type TableChartPartsErrorReason,
  type TableFactMirror,
} from '../../../../src/presentations/table-chart-parts/index.js';

// ---------------------------------------------------------------------------
// 夹具：两步柱状图（类别 3、系列 2）——与 P06 同形，便于交叉
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

const TITLE = '季度销量';

/** 从真 XLSX 字节里解出 `sheet1.xml` 的单元格记录（独立于待测代码）。 */
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

/** 系统里所有能读到的指纹（图由工作簿/快照承载，表/工作簿各自独立反算）。 */
function fingerprintsOf(snapshot: ChartDataSnapshot): readonly string[] {
  return [
    snapshot.version,
    dataVersionOf(snapshot.data),
    workbookVersionOf(snapshot.cells),
    tableFactVersionOf(snapshot.table),
  ];
}

// ---------------------------------------------------------------------------
// A. 表字面量 ↔ 真 XLSX 字节 / charts.ts 布局
// ---------------------------------------------------------------------------

describe('A. 表字面量与真 XLSX 字节、charts.ts 布局交叉一致', () => {
  it('地址集合相等、逐格文本与数值相等（2 系列名 + 3 类别 + 6 值 = 11 事实格）', () => {
    const mirror = tableMirrorFromChartData(DATA);
    const real = realWorkbookCells(CHART);
    const facts = tableFactCells(mirror);

    expect(facts).toHaveLength(11);
    expect(new Set(facts.map((cell) => cell.a1))).toEqual(new Set(real.map((cell) => cell.addr)));

    for (const cell of facts) {
      const actual = real.find((candidate) => candidate.addr === cell.a1);
      expect(actual, `真工作簿缺格 ${cell.a1}`).toBeDefined();
      if (cell.role === 'value') {
        expect(Number(actual?.numeric)).toBe(cell.value);
        expect(cell.text).toBeNull();
      } else {
        expect(actual?.inline).toBe(cell.text);
        expect(cell.value).toBeNull();
      }
    }
  });

  it('布局与 charts.ts 的 chartDataGrid 逐行交叉：角格 + 各系列列', () => {
    const mirror = tableMirrorFromChartData(DATA);
    const grid = chartDataGrid(CHART);
    expect(grid[0]).toEqual(['类别', '北区', '南区']);

    // 角格与各系列名在表上第 0 行
    expect(tableCellAt(mirror, 0, 0).text).toBe(grid[0]?.[0]);
    expect(tableCellAt(mirror, 0, 1).text).toBe(grid[0]?.[1]);
    expect(tableCellAt(mirror, 0, 2).text).toBe(grid[0]?.[2]);

    DATA.categories.forEach((_category, rowIndex) => {
      const gridRow = grid[rowIndex + 1] as readonly string[];
      expect(tableCellAt(mirror, rowIndex + 1, 0).text).toBe(gridRow[0]);
      expect(tableCellAt(mirror, rowIndex + 1, 1).value).toBe(Number(gridRow[1]));
      expect(tableCellAt(mirror, rowIndex + 1, 2).value).toBe(Number(gridRow[2]));
    });
  });

  it('反解回数据 = 原数据；指纹 = dataVersionOf(DATA) 且形如 dc1-*', () => {
    const mirror = tableMirrorFromChartData(DATA);
    expect(chartDataFromTableLiterals(mirror)).toEqual(DATA);
    expect(tableFactVersionOf(mirror)).toBe(dataVersionOf(DATA));
    expect(mirror.version).toMatch(/^dc1-[0-9a-f]{8}$/);
    expect(mirror.row_count).toBe(4);
    expect(mirror.column_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// B. 三处同版：图引用 / 工作簿格 / 表字面量一起动，指纹只变一次
// ---------------------------------------------------------------------------

describe('B. 改数据后图、工作簿、表三处同版，指纹只变一次', () => {
  it('改南区的 Q1 值为 99：表 C2、工作簿 C2、图第二系列第 0 点一起变，指纹只变一次', () => {
    const before = snapshotChartData(DATA);
    const after = applyDataEdit(before, { kind: 'set_value', series_index: 1, category_index: 0, value: 99 });

    // ① 表字面量：C2 变 99
    expect(tableCellAt(after.table, 1, 2).value).toBe(99);
    // ② 工作簿格：C2 变 99
    expect(chartDataFromWorkbookCells(after.cells).series[1]?.values[0]).toBe(99);
    // ③ 图引用：第二系列（C 列）第 0 点变 99
    expect(after.references[1]?.points[0]).toBe(99);
    expect(after.references[1]?.value_ref).toBe('Sheet1!$C$2:$C$4');

    // 指纹只变一次：四处反算出的指纹**只有一枚**，就是新版本；与原版不同。
    const versions = new Set(fingerprintsOf(after));
    expect(versions.size).toBe(1);
    expect([...versions][0]).toBe(after.version);
    expect(after.version).not.toBe(before.version);
    // 同一份编辑后的数据再派生一次，仍是**同一枚**指纹（不漂移）
    expect(snapshotChartData(after.data).version).toBe(after.version);

    // 原快照未被就地改（不可变）
    expect(tableCellAt(before.table, 1, 2).value).toBe(15);
    expect(before.version).not.toBe(after.version);

    // 复核仍过，且表侧计数可复核
    expect(verifyChartDataCoherence(after).version).toBe(after.version);
    expect(verifyTableFactCoherence(after.table, after.data)).toEqual({
      version: after.version,
      series_count: 2,
      category_count: 3,
      literal_cell_count: 11,
      merged_cell_count: 0,
    });
  });

  it('表侧编辑经 applyTableCellEdit 走同一条"整份重派生"路径：三处一起动', () => {
    const before = snapshotChartData(DATA);
    const after = applyTableCellEdit(before, { kind: 'set_value', row: 1, col: 1, value: 7 }); // B2 = 北区 Q1
    expect(after.data.series[0]?.values[0]).toBe(7);
    expect(after.references[0]?.points[0]).toBe(7);
    expect(tableCellAt(after.table, 1, 1).value).toBe(7);
    expect(new Set(fingerprintsOf(after)).size).toBe(1);
    expect(after.version).not.toBe(before.version);
    expect(verifyChartDataCoherence(after).version).toBe(after.version);
  });

  it('合并表格（标题横幅）编辑数据格后，合并区与事实引用仍随新版本走', () => {
    const before = snapshotChartData(DATA, { table: { title: TITLE } });
    // 标题横幅：第 0 行跨 3 列，延续格迁移到源格 (0,0)
    const banner = tableCellAt(before.table, 0, 2);
    expect(banner.role).toBe('title');
    expect(banner.merged_away).toBe(true);
    expect(banner.source).toEqual({ row: 0, col: 0 });
    expect(banner.version).toBe(before.version);

    // 有标题 ⇒ 角格/数据整体下移一行：B3 = 北区 Q1
    const after = applyTableCellEdit(before, { kind: 'set_value', row: 2, col: 1, value: 42 });
    expect(after.data.series[0]?.values[0]).toBe(42);
    expect(tableCellAt(after.table, 2, 1).value).toBe(42);
    // 布局（标题 / 合并）在编辑后保留
    expect(after.table.title).toBe(TITLE);
    // 表内每格（含被合并吞掉的延续格）都盖同一枚新指纹
    expect(new Set(after.table.cells.map((cell) => cell.version))).toEqual(new Set([after.version]));
    expect(after.version).not.toBe(before.version);
    expect(verifyChartDataCoherence(after).version).toBe(after.version);
    expect(verifyTableFactCoherence(after.table, after.data).merged_cell_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C. 表侧复核确实覆盖表：半更新 / 篡改必须具名红
// ---------------------------------------------------------------------------

describe('C. 表侧同版复核：半更新 / 篡改必须具名红', () => {
  const before = snapshotChartData(DATA);
  const after = applyDataEdit(before, { kind: 'set_value', series_index: 1, category_index: 0, value: 99 });

  it('表没跟上（整个表镜还是旧版）⇒ verifyChartDataCoherence 报 version_mismatch', () => {
    const staleTable: ChartDataSnapshot = { ...after, table: before.table };
    expectReason(() => verifyChartDataCoherence(staleTable), 'version_mismatch');
    expectReason(() => verifyTableFactCoherence(before.table, after.data), 'version_mismatch');
  });

  it('表指纹新、但某格字面量还是旧值 ⇒ table_fact_desync', () => {
    const tampered: TableFactMirror = {
      ...after.table,
      cells: after.table.cells.map((cell) => (cell.a1 === 'C2' ? { ...cell, value: 15 } : cell)),
    };
    expectReason(() => verifyTableFactCoherence(tampered, after.data), 'table_fact_desync');
    // 独立反算也看得出来：表字面量反解的指纹回到了旧版
    expect(tableFactVersionOf(tampered)).toBe(before.version);
  });

  it('单格指纹戳被篡改 ⇒ version_mismatch', () => {
    const tampered: TableFactMirror = {
      ...after.table,
      cells: after.table.cells.map((cell) => (cell.a1 === 'C2' ? { ...cell, version: before.version } : cell)),
    };
    expectReason(() => verifyTableFactCoherence(tampered, after.data), 'version_mismatch');
  });

  it('合并延续格的事实引用未迁移到源格 ⇒ table_fact_desync', () => {
    const titled = snapshotChartData(DATA, { table: { title: TITLE } }).table;
    expect(verifyTableFactCoherence(titled, DATA).merged_cell_count).toBe(2);
    const tampered: TableFactMirror = {
      ...titled,
      cells: titled.cells.map((cell) =>
        cell.row === 0 && cell.col === 1 ? { ...cell, source: { row: 0, col: 1 } } : cell,
      ),
    };
    expectReason(() => verifyTableFactCoherence(tampered, DATA), 'table_fact_desync');
  });

  it('合并把两个事实压成一格 ⇒ 构造即 table_merge_conflict（不静默取其一）', () => {
    expectReason(
      () => tableMirrorFromChartData(DATA, { merges: [{ row: 1, col: 1, row_span: 1, col_span: 2 }] }),
      'table_merge_conflict',
    );
    // 唯一事实格不在左上角源格（角格 + 类别格）
    expectReason(
      () => tableMirrorFromChartData(DATA, { merges: [{ row: 0, col: 0, row_span: 2, col_span: 1 }] }),
      'table_merge_conflict',
    );
  });

  it('即使绕过构造器篡改 merges，复核也会具名报冲突', () => {
    const plain = tableMirrorFromChartData(DATA);
    const tampered: TableFactMirror = { ...plain, merges: [{ row: 1, col: 1, row_span: 1, col_span: 2 }] };
    expectReason(() => verifyTableFactCoherence(tampered, DATA), 'table_merge_conflict');
  });
});

// ---------------------------------------------------------------------------
// D. 表格格编辑 → 图表事实的引用迁移；合并变更后的重核
// ---------------------------------------------------------------------------

describe('D. 表格格编辑 → 图表事实迁移；合并变更重核', () => {
  it('数据格 / 类别格 / 系列名格分别迁移到正确的图表事实', () => {
    const mirror = tableMirrorFromChartData(DATA);
    expect(chartEditForTableCell(mirror, { kind: 'set_value', row: 2, col: 2, value: 1 })).toEqual({
      kind: 'set_value',
      series_index: 1,
      category_index: 1,
      value: 1,
    });
    expect(chartEditForTableCell(mirror, { kind: 'set_text', row: 3, col: 0, text: 'Q4' })).toEqual({
      kind: 'set_category',
      category_index: 2,
      text: 'Q4',
    });
    expect(chartEditForTableCell(mirror, { kind: 'set_text', row: 0, col: 1, text: '东区' })).toEqual({
      kind: 'set_series_name',
      series_index: 0,
      name: '东区',
    });
  });

  it('装饰格 / 合并延续的装饰格 / 类型不符 / 越界都具名 unknown_table_cell', () => {
    const mirror = tableMirrorFromChartData(DATA);
    expectReason(() => chartEditForTableCell(mirror, { kind: 'set_text', row: 0, col: 0, text: 'x' }), 'unknown_table_cell');
    expectReason(() => chartEditForTableCell(mirror, { kind: 'set_text', row: 1, col: 1, text: 'x' }), 'unknown_table_cell');
    expectReason(() => chartEditForTableCell(mirror, { kind: 'set_value', row: 1, col: 0, value: 1 }), 'unknown_table_cell');
    expectReason(() => chartEditForTableCell(mirror, { kind: 'set_text', row: 9, col: 9, text: 'x' }), 'unknown_table_cell');

    // 标题横幅的延续格迁移到标题源格 ⇒ 同样是装饰格
    const titled = tableMirrorFromChartData(DATA, { title: TITLE });
    expectReason(() => chartEditForTableCell(titled, { kind: 'set_text', row: 0, col: 2, text: 'x' }), 'unknown_table_cell');
  });

  it('合并变更重核：纯装饰横幅允许；任何盖住 ≥2 个数据事实的合并被拒', () => {
    // 纯装饰（标题横幅）合法，数据格来源不受影响
    const titled = tableMirrorFromChartData(DATA, { title: TITLE });
    expect(tableCellAt(titled, 2, 1).source).toEqual({ row: 2, col: 1 }); // B3 仍是自身源格
    expect(tableCellAt(titled, 2, 1).merged_away).toBe(false);
    expect(verifyTableFactCoherence(titled, DATA).literal_cell_count).toBe(11);

    // 盖住两个系列名（第 0 行的两格）⇒ 冲突，不迁移
    expectReason(
      () => tableMirrorFromChartData(DATA, { merges: [{ row: 0, col: 1, row_span: 1, col_span: 2 }] }),
      'table_merge_conflict',
    );
    // 盖住同一列两个类别 ⇒ 冲突
    expectReason(
      () => tableMirrorFromChartData(DATA, { merges: [{ row: 1, col: 0, row_span: 2, col_span: 1 }] }),
      'table_merge_conflict',
    );
  });
});

// ---------------------------------------------------------------------------
// E. P06 既有负例重放：仍然红
// ---------------------------------------------------------------------------

describe('E. P06 既有反向对照重放（仍然红-capable）', () => {
  const before = snapshotChartData(DATA);
  const after = applyDataEdit(before, { kind: 'set_value', series_index: 1, category_index: 0, value: 99 });

  it('半更新：图没跟上 ⇒ point_value_mismatch；表没跟上 ⇒ chart_data_desync', () => {
    const halfReferences: ChartDataSnapshot = { ...after, references: before.references };
    expectReason(() => verifyChartDataCoherence(halfReferences), 'point_value_mismatch');

    const halfCells: ChartDataSnapshot = { ...after, cells: before.cells };
    expectReason(() => verifyChartDataCoherence(halfCells), 'chart_data_desync');
  });

  it('旧指纹 ⇒ version_mismatch；缺格 ⇒ incomplete_workbook_cells', () => {
    const stale: ChartDataSnapshot = { ...after, version: before.version };
    expectReason(() => verifyChartDataCoherence(stale), 'version_mismatch');

    const missing: ChartDataSnapshot = { ...after, cells: after.cells.filter((cell) => cell.address !== 'C2') };
    expectReason(() => verifyChartDataCoherence(missing), 'incomplete_workbook_cells');
  });

  it('越界编辑 / 非法数据 ⇒ unknown_edit_target / invalid_chart_data', () => {
    expectReason(
      () => applyDataEdit(before, { kind: 'set_value', series_index: 9, category_index: 0, value: 1 }),
      'unknown_edit_target',
    );
    expectReason(() => validateChartData({ categories: [], series: DATA.series }), 'invalid_chart_data');
    expectReason(
      () => validateChartData({ categories: DATA.categories, series: [{ name: 'x', values: [1] }] }),
      'invalid_chart_data',
    );
    expectReason(
      () => validateChartData({ categories: DATA.categories, series: [{ name: 'x', values: [1, Number.NaN, 3] }] }),
      'invalid_chart_data',
    );
  });
});
