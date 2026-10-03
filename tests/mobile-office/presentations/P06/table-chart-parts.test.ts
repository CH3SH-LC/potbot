/**
 * P06 · 表格 / 图表**部件与关系描述符**层的定向验收。
 *
 * ## 判据一律走**独立来源**，不复用待测代码自证
 *
 * - **内容类型 / 路径 / 关系类型**：与 `charts.ts` 的 `buildChartParts` 输出**交叉断言**，
 *   而不是看本模块的表"像不像"；
 * - **数值一致性**：从 `charts.ts` 的 `renderEmbeddedWorkbookBytes` 产出的**真 XLSX 字节**里
 *   解压 `xl/worksheets/sheet1.xml`，逐格读回系列名与点值，再交给待测校验器；系列所在的
 *   列号也从工作簿第 1 行**读出来**，而不是拿待测的布局函数自证；
 * - **合并覆盖**：与 `tables.ts` 的 `planTableGrid`（另一套实现）逐格比对"这一格属于哪个源格"。
 *
 * ## 反向对照（不许空壳）
 *
 * 数值与系列不符 / 合并区重叠 / 内嵌工作簿缺失 —— 三条负例都必须**具名报错**；
 * 另有 A1 引用形态、系列名、点数、悬挂关系等负例。正向用例给出可复核的计数。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  buildChartParts,
  chartSlideRelationship,
  renderEmbeddedWorkbookBytes,
} from '../../../../src/presentations/charts.js';
import { planTableGrid } from '../../../../src/presentations/tables.js';
import { transform, type ChartModel, type TableShape } from '../../../../src/presentations/model.js';
import {
  DEFAULT_CHART_PART_PATH,
  DEFAULT_EMBEDDED_WORKBOOK_PATH,
  PART_CONTENT_TYPES,
  RELATIONSHIP_TYPES,
  TableChartPartsError,
  addPart,
  addRelationship,
  buildMergeCoverage,
  columnLetter,
  coverageFromTable,
  embeddedWorkbookManifest,
  isMergedCell,
  makePart,
  mergeRegionsOfTable,
  mergedCellCount,
  outgoingRelationships,
  parseA1Reference,
  partPaths,
  registerChartFrame,
  registerTableFrame,
  relsPartPathOf,
  requireEmbeddedWorkbook,
  resolveRelationshipTarget,
  seriesReferenceFor,
  sourceAt,
  validateEmbeddedWorkbookManifest,
  validatePartGraph,
  verifySeriesConsistency,
  workbookPartByRole,
  EMPTY_PART_GRAPH,
  type ChartSeriesReference,
  type PartGraph,
  type TableChartPartsErrorReason,
} from '../../../../src/presentations/table-chart-parts/index.js';

// ---------------------------------------------------------------------------
// 夹具：一张两步的柱状图（类别 3 个、系列 2 个）
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

const SLIDE_PATH = 'ppt/slides/slide1.xml';

/** 从真 XLSX 字节里解出 `sheet1.xml` 文本。 */
function sheetXmlOf(chart: ChartModel): string {
  const archive = readZip(renderEmbeddedWorkbookBytes(chart));
  const entry = archive.entries.find((candidate) => candidate.path === 'xl/worksheets/sheet1.xml');
  if (entry === undefined) throw new Error('嵌入工作簿里没有 xl/worksheets/sheet1.xml');
  return Buffer.from(entry.data).toString('utf8');
}

interface SheetCellRecord {
  readonly addr: string;
  readonly col: string;
  readonly row: number;
  readonly value?: string;
  readonly inline?: string;
}

/** 极简 SpreadsheetML 单元格读取器（只认 `<c r="..">` 的 `<v>` 与 `<t>`）。 */
function parseSheetCells(xml: string): readonly SheetCellRecord[] {
  const records: SheetCellRecord[] = [];
  for (const chunk of xml.split('<c ').slice(1)) {
    const address = /r="([A-Z]+)([0-9]+)"/.exec(chunk);
    if (address === null) continue;
    const record: SheetCellRecord = {
      addr: `${address[1] as string}${address[2] as string}`,
      col: address[1] as string,
      row: Number.parseInt(address[2] as string, 10),
    };
    const value = /<v>([^<]*)<\/v>/.exec(chunk)?.[1];
    if (value !== undefined) Object.assign(record, { value });
    const inline = /<t>([^<]*)<\/t>/.exec(chunk)?.[1];
    if (inline !== undefined) Object.assign(record, { inline });
    records.push(record);
  }
  return records;
}

/**
 * 从**真工作簿字节**造出系列引用描述符：系列名与点值都读自单元格，
 * 系列所在列号也读自第 1 行（不传待测布局）。
 */
function referencesFromWorkbook(chart: ChartModel): readonly ChartSeriesReference[] {
  const records = parseSheetCells(sheetXmlOf(chart));
  const headerColBy = new Map<string, string>();
  for (const record of records) {
    if (record.row === 1 && record.inline !== undefined) headerColBy.set(record.inline, record.col);
  }
  const categoryByRow = new Map<number, string>();
  for (const record of records) {
    if (record.col === 'A' && record.row >= 2 && record.inline !== undefined) categoryByRow.set(record.row, record.inline);
  }
  const categoryCount = categoryByRow.size;

  return chart.series.map((series, index) => {
    const layout = seriesReferenceFor(index, categoryCount);
    const valueColumn = headerColBy.get(series.name);
    if (valueColumn === undefined) throw new Error(`工作簿第 1 行没有系列名 ${series.name}`);
    const parsed = parseA1Reference(layout.value_ref);
    expect(columnLetter(parsed.col_start)).toBe(valueColumn); // 布局与工作簿**交叉**一致
    const points = Array.from({ length: categoryCount }, (_value, k) => {
      const cell = records.find((record) => record.addr === `${valueColumn}${String(k + 2)}`);
      if (cell?.value === undefined) throw new Error(`工作簿缺少单元格 ${valueColumn}${String(k + 2)}`);
      return Number(cell.value);
    });
    return { name: series.name, ...layout, points };
  });
}

/** 完整登记图：幻灯片 + 图表部件 + 内嵌工作簿（关系按 charts.ts 的口径复用）。 */
function fullGraph(): PartGraph {
  const built = buildChartParts(CHART);
  const slideRel = chartSlideRelationship(built.chart_path);
  let graph = addPart(EMPTY_PART_GRAPH, makePart('slide', SLIDE_PATH));
  graph = addPart(graph, makePart('chart', built.chart_path));
  graph = addPart(graph, makePart('embedded_workbook', built.workbook_path));
  for (const relationship of built.chart_relationships) {
    graph = addRelationship(graph, {
      owner_path: built.chart_path,
      r_id: 'rId1',
      type: relationship.type,
      target: relationship.target,
    });
  }
  graph = addRelationship(graph, {
    owner_path: SLIDE_PATH,
    r_id: 'rId1',
    type: slideRel.type,
    target: slideRel.target,
  });
  return graph;
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

// ---------------------------------------------------------------------------
// A. 部件与关系登记
// ---------------------------------------------------------------------------

describe('A. 部件 / 关系登记', () => {
  it('内容类型、默认路径、关系类型与 charts.ts 输出逐项一致', () => {
    const built = buildChartParts(CHART);
    expect(built.chart_path).toBe(DEFAULT_CHART_PART_PATH);
    expect(built.workbook_path).toBe(DEFAULT_EMBEDDED_WORKBOOK_PATH);

    const chartPart = built.parts.find((part) => part.path === built.chart_path);
    const workbookPart = built.parts.find((part) => part.path === built.workbook_path);
    expect(chartPart?.content_type).toBe(PART_CONTENT_TYPES.chart);
    expect(workbookPart?.content_type).toBe(PART_CONTENT_TYPES.embedded_workbook);
    expect(built.parts).toHaveLength(2);

    expect(built.chart_relationships).toHaveLength(1);
    expect(built.chart_relationships[0]?.type).toBe(RELATIONSHIP_TYPES.package);
    expect(chartSlideRelationship().type).toBe(RELATIONSHIP_TYPES.chart);
  });

  it('相对 Target 解析出的路径 = charts.ts 报出的工作簿路径', () => {
    const built = buildChartParts(CHART);
    const target = built.chart_relationships[0]?.target as string;
    expect(resolveRelationshipTarget(built.chart_path, target)).toBe(built.workbook_path);

    const slideRel = chartSlideRelationship(built.chart_path);
    expect(resolveRelationshipTarget(SLIDE_PATH, slideRel.target)).toBe(built.chart_path);
  });

  it('登记图自带路径/关系，validatePartGraph 解析两条关系都落到真实部件', () => {
    const graph = fullGraph();
    expect(partPaths(graph)).toEqual([SLIDE_PATH, DEFAULT_CHART_PART_PATH, DEFAULT_EMBEDDED_WORKBOOK_PATH]);
    expect(relsPartPathOf(DEFAULT_CHART_PART_PATH)).toBe('ppt/charts/_rels/chart1.xml.rels');
    const resolved = validatePartGraph(graph);
    expect(resolved.map((item) => item.target_path)).toEqual([
      DEFAULT_EMBEDDED_WORKBOOK_PATH,
      DEFAULT_CHART_PART_PATH,
    ]);
  });

  it('帧登记：图表帧带关系 id，表格帧内联无关系', () => {
    const graph = fullGraph();
    const chartFrame = registerChartFrame(graph, {
      slide_path: SLIDE_PATH,
      shape_id: 2,
      chart_path: DEFAULT_CHART_PART_PATH,
      r_id: 'rId1',
    }).frame;
    expect(chartFrame.kind).toBe('chart');
    expect(chartFrame.rel_id).toBe('rId1');
    expect(chartFrame.part_path).toBe(DEFAULT_CHART_PART_PATH);

    const tableFrame = registerTableFrame(graph, { slide_path: SLIDE_PATH, shape_id: 3 }).frame;
    expect(tableFrame.kind).toBe('table');
    expect(tableFrame.rel_id).toBeNull();
    expect(tableFrame.part_path).toBe(SLIDE_PATH); // 内联：就住在幻灯片部件里
  });

  it('反向对照：路径重复 / 悬挂关系 / rId 重复 / 非法路径都具名报错', () => {
    expectReason(() => addPart(fullGraph(), makePart('slide', SLIDE_PATH)), 'duplicate_part_path');
    expectReason(() => makePart('chart', '../escape.xml'), 'invalid_part_path');
    expectReason(() => makePart('chart', '/abs.xml'), 'invalid_part_path');
    expectReason(() => resolveRelationshipTarget('ppt/charts/chart1.xml', '../../../escape.xml'), 'invalid_part_path');
    expectReason(
      () =>
        addRelationship(fullGraph(), {
          owner_path: SLIDE_PATH,
          r_id: 'rId1',
          type: RELATIONSHIP_TYPES.chart,
          target: '../charts/chart1.xml',
        }),
      'duplicate_relationship_id',
    );
    expectReason(
      () =>
        validatePartGraph(
          addRelationship(fullGraph(), {
            owner_path: SLIDE_PATH,
            r_id: 'rId9',
            type: RELATIONSHIP_TYPES.chart,
            target: '../charts/chart9.xml',
          }),
        ),
      'dangling_relationship',
    );
  });

  it('反向对照：图表帧的链缺一环就报错，不自动补', () => {
    const graph = fullGraph();
    expectReason(
      () =>
        registerChartFrame(graph, {
          slide_path: SLIDE_PATH,
          shape_id: 2,
          chart_path: DEFAULT_CHART_PART_PATH,
          r_id: 'rId7',
        }),
      'missing_relationship',
    );
    // 去掉图表部件的 package 关系 ⇒ 缺链
    const withoutPackage: PartGraph = {
      parts: graph.parts,
      relationships: graph.relationships.filter(
        (relationship) => relationship.type !== RELATIONSHIP_TYPES.package,
      ),
    };
    expectReason(
      () =>
        registerChartFrame(withoutPackage, {
          slide_path: SLIDE_PATH,
          shape_id: 2,
          chart_path: DEFAULT_CHART_PART_PATH,
          r_id: 'rId1',
        }),
      'missing_relationship',
    );
  });
});

// ---------------------------------------------------------------------------
// B. 内嵌工作簿部件清单
// ---------------------------------------------------------------------------

describe('B. 内嵌工作簿部件清单', () => {
  it('清单包含工作簿 / 工作表 / 两个 rels 之外的必需角色，顺序稳定', () => {
    const manifest = embeddedWorkbookManifest(DEFAULT_CHART_PART_PATH);
    expect(manifest.workbook_path).toBe(DEFAULT_EMBEDDED_WORKBOOK_PATH);
    expect(manifest.parts.map((part) => part.path)).toEqual([
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/_rels/workbook.xml.rels',
      '[Content_Types].xml',
    ]);
    expect(workbookPartByRole(manifest, 'worksheet')?.content_type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    );
    expect(manifest.root_relationships[0]?.target).toBe('xl/workbook.xml');
    expect(() => validateEmbeddedWorkbookManifest(manifest)).not.toThrow();
  });

  it('requireEmbeddedWorkbook 从登记图里解析出工作簿路径', () => {
    expect(requireEmbeddedWorkbook(fullGraph(), DEFAULT_CHART_PART_PATH)).toBe(DEFAULT_EMBEDDED_WORKBOOK_PATH);
  });

  it('反向对照：内嵌工作簿缺失必须报错', () => {
    // ① 图里没有工作簿部件
    const graph = fullGraph();
    const withoutWorkbook: PartGraph = {
      parts: graph.parts.filter((part) => part.kind !== 'embedded_workbook'),
      relationships: graph.relationships,
    };
    expectReason(() => requireEmbeddedWorkbook(withoutWorkbook, DEFAULT_CHART_PART_PATH), 'missing_embedded_workbook');

    // ② 工作簿登记在非 embeddings 落点
    let misplaced = addPart(
      { parts: graph.parts.filter((part) => part.kind !== 'embedded_workbook'), relationships: graph.relationships },
      makePart('embedded_workbook', 'ppt/media/book.xlsx'),
    );
    expectReason(() => requireEmbeddedWorkbook(misplaced, DEFAULT_CHART_PART_PATH), 'missing_embedded_workbook');
    void misplaced;

    // ③ 清单缺"工作表"角色
    const manifest = embeddedWorkbookManifest(DEFAULT_CHART_PART_PATH);
    const broken = { ...manifest, parts: manifest.parts.filter((part) => part.role !== 'worksheet') };
    expectReason(() => validateEmbeddedWorkbookManifest(broken), 'missing_embedded_workbook');

    // ④ 同一角色登记两次
    const duplicated = { ...manifest, parts: [...manifest.parts, manifest.parts[0]!] };
    expectReason(() => validateEmbeddedWorkbookManifest(duplicated), 'duplicate_workbook_role');
  });
});

// ---------------------------------------------------------------------------
// C. 数值与图形一致性
// ---------------------------------------------------------------------------

describe('C. 数值与图形一致性', () => {
  it('工作簿里读回的点位与模型期望逐点一致（3 类别 × 2 系列 = 6 点）', () => {
    const references = referencesFromWorkbook(CHART);
    expect(references).toHaveLength(2);
    expect(references[0]?.points).toEqual([10, 20, 30]);
    expect(references[1]?.points).toEqual([15, 25, 35]);
    expect(references[1]?.value_ref).toBe('Sheet1!$C$2:$C$4');

    const report = verifySeriesConsistency(references, { categories: CHART.categories, series: CHART.series });
    expect(report.series_count).toBe(2);
    expect(report.points_per_series).toEqual([3, 3]);
    expect(report.total_points).toBe(6);
    expect(report.category_count).toBe(3);
    expect(report.sheet).toBe('Sheet1');
  });

  it('A1 解析器认得区域 / 单格，列号换算正确', () => {
    const range = parseA1Reference('Sheet1!$B$2:$B$4');
    expect(range).toEqual({ sheet: 'Sheet1', col_start: 1, row_start: 1, col_end: 1, row_end: 3 });
    expect(parseA1Reference('$A$1')).toEqual({ sheet: '', col_start: 0, row_start: 0, col_end: 0, row_end: 0 });
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
  });

  it('反向对照：数值与系列不符必须红', () => {
    const references = referencesFromWorkbook(CHART);
    const tampered = references.map((reference, index) =>
      index === 0 ? { ...reference, points: [10, 20, 99] } : reference,
    );
    expectReason(
      () => verifySeriesConsistency(tampered, { categories: CHART.categories, series: CHART.series }),
      'point_value_mismatch',
    );
  });

  it('反向对照：期望序列与工作簿不符、点数不符、系列名不符都报错', () => {
    const references = referencesFromWorkbook(CHART);
    expectReason(
      () =>
        verifySeriesConsistency(references, {
          categories: CHART.categories,
          series: [{ name: '北区', values: [10, 20, 31] }, { name: '南区', values: [15, 25, 35] }],
        }),
      'point_value_mismatch',
    );
    const shortPoints = references.map((reference, index) =>
      index === 1 ? { ...reference, points: [15, 25] } : reference,
    );
    expectReason(
      () => verifySeriesConsistency(shortPoints, { categories: CHART.categories, series: CHART.series }),
      'point_count_mismatch',
    );
    const renamed = references.map((reference, index) =>
      index === 0 ? { ...reference, name: '东区' } : reference,
    );
    expectReason(
      () => verifySeriesConsistency(renamed, { categories: CHART.categories, series: CHART.series }),
      'series_name_mismatch',
    );
    expectReason(
      () => verifySeriesConsistency(references.slice(0, 1), { categories: CHART.categories, series: CHART.series }),
      'series_count_mismatch',
    );
    const dupNames = references.map((reference) => ({ ...reference, name: '北区' }));
    expectReason(
      () => verifySeriesConsistency(dupNames, { categories: CHART.categories, series: CHART.series }),
      'duplicate_series_name',
    );
    const wrongColumn = references.map((reference, index) =>
      index === 0 ? { ...reference, value_ref: 'Sheet1!$D$2:$D$4' } : reference,
    );
    expectReason(
      () => verifySeriesConsistency(wrongColumn, { categories: CHART.categories, series: CHART.series }),
      'category_ref_mismatch',
    );
  });

  it('反向对照：非法 A1 引用不猜、直接报错', () => {
    expectReason(() => parseA1Reference('2B3'), 'invalid_a1_reference');
    expectReason(() => parseA1Reference('Sheet1!$B$4:$B$2'), 'invalid_a1_reference');
    expectReason(() => parseA1Reference('Sheet1!$B$'), 'invalid_a1_reference');
    expectReason(() => parseA1Reference('Sheet1!'), 'invalid_a1_reference');
    expectReason(() => parseA1Reference('Sheet 1!B2!C3'), 'invalid_a1_reference');
  });
});

// ---------------------------------------------------------------------------
// D. 合并单元格覆盖矩阵
// ---------------------------------------------------------------------------

const cell = (col_span: number, row_span: number) => ({ text: null, col_span, row_span });

/** 3×3 网格，(0,0) 起 2×2 合并。 */
const MERGED_TABLE: TableShape = {
  kind: 'table',
  shape_id: 5,
  name: 'Table 5',
  transform: transform(0, 0, 3000000, 2000000),
  column_widths_emu: [1000000, 1000000, 1000000],
  rows: [
    { cells: [cell(2, 2), cell(1, 1), cell(1, 1)] },
    { cells: [cell(1, 1), cell(1, 1), cell(1, 1)] },
    { cells: [cell(1, 1), cell(1, 1), cell(1, 1)] },
  ],
};

describe('D. 合并单元格覆盖矩阵', () => {
  it('覆盖矩阵把 2×2 合并区的 4 格都指向源格 (0,0)', () => {
    const coverage = coverageFromTable(MERGED_TABLE);
    expect(coverage.regions).toEqual([{ row: 0, col: 0, row_span: 2, col_span: 2 }]);
    expect(mergeRegionsOfTable(MERGED_TABLE)).toHaveLength(1);
    expect(sourceAt(coverage, 0, 1)).toEqual({ row: 0, col: 0 });
    expect(sourceAt(coverage, 1, 0)).toEqual({ row: 0, col: 0 });
    expect(sourceAt(coverage, 1, 1)).toEqual({ row: 0, col: 0 });
    expect(isMergedCell(coverage, 1, 1)).toBe(true);
    expect(isMergedCell(coverage, 0, 2)).toBe(false);
    expect(sourceAt(coverage, 2, 2)).toEqual({ row: 2, col: 2 });
    expect(mergedCellCount(coverage)).toBe(3);
  });

  it('与 tables.ts 的 planTableGrid 逐格交叉一致（"这一格属于哪个源格"）', () => {
    const coverage = coverageFromTable(MERGED_TABLE);
    const plan = planTableGrid(MERGED_TABLE);

    const originOf = (row: number, col: number): { row: number; col: number } => {
      const planned = plan[row]?.[col];
      if (planned === undefined) throw new Error(`plan 缺 (${row},${col})`);
      if (planned.v_merge) return originOf(row - 1, col);
      if (planned.h_merge) return originOf(row, col - 1);
      return { row, col };
    };

    for (let row = 0; row < coverage.row_count; row += 1) {
      for (let col = 0; col < coverage.column_count; col += 1) {
        expect(sourceAt(coverage, row, col)).toEqual(originOf(row, col));
      }
    }
  });

  it('反向对照：合并区重叠必须红', () => {
    expectReason(
      () =>
        buildMergeCoverage(3, 3, [
          { row: 0, col: 0, row_span: 2, col_span: 2 },
          { row: 1, col: 1, row_span: 1, col_span: 2 },
        ]),
      'merge_overlap',
    );
    // 两区共源格、方向不同，也算重叠
    expectReason(
      () =>
        buildMergeCoverage(3, 3, [
          { row: 0, col: 0, row_span: 2, col_span: 1 },
          { row: 0, col: 0, row_span: 1, col_span: 2 },
        ]),
      'merge_overlap',
    );
    // 重复登记同一区
    expectReason(
      () =>
        buildMergeCoverage(2, 2, [
          { row: 0, col: 0, row_span: 1, col_span: 2 },
          { row: 0, col: 0, row_span: 1, col_span: 2 },
        ]),
      'merge_overlap',
    );
  });

  it('反向对照：越界 / span 非法 / 网格不符都报错', () => {
    expectReason(() => buildMergeCoverage(3, 3, [{ row: 1, col: 0, row_span: 3, col_span: 1 }]), 'merge_out_of_bounds');
    expectReason(() => buildMergeCoverage(3, 3, [{ row: 0, col: 2, row_span: 1, col_span: 2 }]), 'merge_out_of_bounds');
    expectReason(() => buildMergeCoverage(3, 3, [{ row: 0, col: 0, row_span: 0, col_span: 1 }]), 'merge_span_invalid');
    expectReason(() => buildMergeCoverage(3, 3, [{ row: -1, col: 0, row_span: 1, col_span: 1 }]), 'merge_span_invalid');
    expectReason(() => sourceAt(coverageFromTable(MERGED_TABLE), 3, 0), 'merge_out_of_bounds');

    const ragged: TableShape = {
      ...MERGED_TABLE,
      rows: [{ cells: [cell(1, 1)] }, ...MERGED_TABLE.rows.slice(1)],
    };
    expectReason(() => coverageFromTable(ragged), 'grid_mismatch');
  });
});
