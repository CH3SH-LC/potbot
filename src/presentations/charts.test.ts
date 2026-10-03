/**
 * 图表用例（design-06 P9 / PPT-09）。
 *
 * 硬判据是「**嵌入数据与图形一致且可编辑**」：
 *
 * - **一致**：把图表部件里的 `c:numCache`/`c:strCache` 与嵌入工作簿 `sheet1.xml` 的单元格
 *   **都读回**来逐点比（不是"写的时候用了同一个数组"）；
 * - **可编辑**：嵌入的是**真 XLSX**（能再解压出 `xl/workbook.xml` + `xl/worksheets/sheet1.xml`），
 *   且 `c:externalData@r:id` 指向它 ⇒ Office 里"编辑数据"改的就是这份工作簿；
 * - **成对**：`rId` 必须在该图表部件 `_rels` 里且目标部件真实存在；
 * - **反向对照**：偷偷改掉工作簿里的一个数 ⇒ `chart_data_desync`；抽掉嵌入工作簿部件 ⇒
 *   `chart_part_unpaired`。两条都必须被具名捕获。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../artifacts/ooxml/index.js';
import { transform, type ChartModel, type Presentation, type Shape } from './model.js';
import { addShape, addSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import {
  DEFAULT_CHART_OPTIONS,
  PresentationChartError,
  applyChartDataEditToPackage,
  buildChartContainer,
  buildChartParts,
  chartDataGrid,
  chartDataOf,
  chartOptionsOf,
  chartShape,
  chartSlideRelationship,
  columnLetter,
  deleteChart,
  insertChart,
  readChartPartData,
  readEmbeddedWorkbookData,
  renderChartPackage,
  renderChartPackageFromData,
  renderChartPackageFromSnapshot,
  renderChartPartXml,
  renderEmbeddedWorkbookBytes,
  requireChart,
  setChartData,
  setChartOptions,
  setChartTitle,
  setChartType,
  slideChartGraphicFrameXml,
  verifyChartPackage,
} from './charts.js';
import {
  dataVersionOf,
  snapshotChartData,
  type ChartDataSnapshot,
  type ExpectedChartData,
} from './table-chart-parts/index.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

const CHART: ChartModel = {
  chart_type: 'bar',
  categories: ['一月', '二月', '三月'],
  series: [
    { name: '收入', values: [1.5, 2.25, 3] },
    { name: '支出', values: [0.5, 1.25, 2] },
  ],
  title: '季度对比',
};

function deckWithSlides(count: number) {
  let deck = emptyPresentation('p1', '图表测试');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function chartDeck(): { presentation: Presentation; chart_id: number } {
  const added = insertChart(deckWithSlides(1), 1, {
    transform: transform(838200, 457200, 6096000, 4064000),
    chart: CHART,
  });
  return { presentation: added.presentation, chart_id: added.shape_id };
}

function elements(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) elements(child, name, out);
  return out;
}

function textOf(node: XmlElementNode | undefined): string {
  return node === undefined ? '' : node.children.map((child) => (child.kind === 'text' ? child.text : '')).join('');
}

/** 改掉**嵌入工作簿**里的一处文本（用来做"数据不同步"的反向对照）。 */
function patchEmbeddedWorkbook(container: Buffer, from: string, to: string): Buffer {
  const outside = readZip(container);
  const workbookEntry = outside.by_path.get('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
  if (workbookEntry === undefined) throw new Error('容器里没有嵌入工作簿');
  const inside = readZip(workbookEntry.data);
  const patchedInner = writeZip(
    inside.entries.map((entry) =>
      entry.path === 'xl/worksheets/sheet1.xml'
        ? { path: entry.path, data: utf8Bytes(Buffer.from(entry.data).toString('utf8').replace(from, to)) }
        : { path: entry.path, data: entry.data },
    ),
  );
  return writeZip(
    outside.entries.map((entry) =>
      entry.path === 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'
        ? { path: entry.path, data: patchedInner }
        : { path: entry.path, data: entry.data },
    ),
  );
}

describe('PPT-09：图表部件 XML（类型 / 标题 / 轴 / 图例 / 样式 / 数据标签）', () => {
  it('柱状图：c:barChart + 每系列 c:cat/c:val 缓存 + 外部数据引用', () => {
    const xml = renderChartPartXml(CHART, DEFAULT_CHART_OPTIONS, 'rId1');
    const root = parseXmlDocument(xml);

    expect(root.name).toBe('c:chartSpace');
    expect(elements(root, 'c:barChart')).toHaveLength(1);
    expect(elements(root, 'c:ser')).toHaveLength(2);
    expect(elements(root, 'c:catAx')).toHaveLength(1);
    expect(elements(root, 'c:valAx')).toHaveLength(1);

    // 类别缓存 = 模型里的类别；数值缓存 = 模型里的值。
    const catCache = elements(elements(root, 'c:cat')[0] as XmlElementNode, 'c:v').map(textOf);
    expect(catCache).toEqual(['一月', '二月', '三月']);
    const valCache = elements(elements(root, 'c:val')[0] as XmlElementNode, 'c:v').map(textOf);
    expect(valCache).toEqual(['1.5', '2.25', '3']);

    // 标题与外部数据引用。
    expect(elements(root, 'a:t').map(textOf)).toContain('季度对比');
    const external = elements(root, 'c:externalData')[0];
    expect(attributeOf(external, 'r:id')).toBe('rId1');
    // 图例默认在右。
    expect(attributeOf(elements(root, 'c:legendPos')[0], 'val')).toBe('r');
  });

  it('折线 / 饼图分支：饼图不带坐标轴', () => {
    const line = parseXmlDocument(renderChartPartXml({ ...CHART, chart_type: 'line' }, DEFAULT_CHART_OPTIONS, 'rId1'));
    expect(elements(line, 'c:lineChart')).toHaveLength(1);
    expect(elements(line, 'c:catAx')).toHaveLength(1);

    const pie = parseXmlDocument(renderChartPartXml({ ...CHART, chart_type: 'pie', title: null }, DEFAULT_CHART_OPTIONS, 'rId1'));
    expect(elements(pie, 'c:pieChart')).toHaveLength(1);
    expect(elements(pie, 'c:catAx')).toHaveLength(0);
    expect(elements(pie, 'c:valAx')).toHaveLength(0);
    expect(elements(pie, 'c:title')).toHaveLength(0);
  });

  it('图例 / 轴标题 / 样式 / 数据标签都落在 XML 上；图例为 none 时不写图例', () => {
    const options = {
      legend: 'bottom' as const,
      style_id: 10,
      category_axis_title: '月份',
      value_axis_title: '万元',
      data_labels: true,
    };
    const root = parseXmlDocument(renderChartPartXml(CHART, options, 'rId1'));
    expect(attributeOf(elements(root, 'c:legendPos')[0], 'val')).toBe('b');
    expect(attributeOf(elements(root, 'c:style')[0], 'val')).toBe('10');
    expect(elements(root, 'a:t').map(textOf)).toEqual(expect.arrayContaining(['月份', '万元']));
    expect(attributeOf(elements(root, 'c:showVal')[0], 'val')).toBe('1');

    const withoutLegend = parseXmlDocument(
      renderChartPartXml(CHART, { ...DEFAULT_CHART_OPTIONS, legend: 'none' }, 'rId1'),
    );
    expect(elements(withoutLegend, 'c:legend')).toHaveLength(0);
  });
});

describe('PPT-09：模型操作（改数据 / 标题 / 类型 / 删除）', () => {
  it('改数据 / 标题 / 类型都是不可变操作，原模型不受影响', () => {
    const { presentation, chart_id } = chartDeck();
    const retitled = setChartTitle(presentation, 1, chart_id, '新标题');
    const retyped = setChartType(retitled, 1, chart_id, 'line');
    const redata = setChartData(retyped, 1, chart_id, {
      categories: ['Q1', 'Q2'],
      series: [{ name: '净利', values: [10, 20] }],
    });

    expect(requireChart(presentation, 1, chart_id).chart.title).toBe('季度对比');
    expect(requireChart(presentation, 1, chart_id).chart.series).toHaveLength(2);
    expect(requireChart(redata, 1, chart_id).chart).toMatchObject({ chart_type: 'line', title: '新标题' });
    expect(requireChart(redata, 1, chart_id).chart.categories).toEqual(['Q1', 'Q2']);
    expect(requireChart(redata, 1, chart_id).chart.series[0]?.values).toEqual([10, 20]);
  });

  it('删除图表后对象消失；对非图表对象操作 ⇒ 报错', () => {
    const { presentation, chart_id } = chartDeck();
    const removed = deleteChart(presentation, 1, chart_id);
    expect(removed.slides[0]?.shapes).toHaveLength(0);

    const box: Shape = {
      kind: 'text_box',
      shape_id: 7,
      name: 'Box',
      transform: transform(0, 0, 100, 100),
      text: { paragraphs: [{ runs: [{ source: { kind: 'literal', text: 'x' } }], level: 0, alignment: 'left', bullet: false }] },
    };
    const withBox = addShape(presentation, 1, box);
    try {
      requireChart(withBox, 1, 7);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationChartError).reason).toBe('not_a_chart');
    }
    expect(() => setChartTitle(withBox, 1, 999, 'x')).toThrow(PresentationChartError);
  });

  it('数据校验：系列长度与类别不符 / 空数据 / 非法类型 / 非有限数 ⇒ 各自具名报错', () => {
    expect(() =>
      insertChart(deckWithSlides(1), 1, {
        transform: transform(0, 0, 1, 1),
        chart: { ...CHART, series: [{ name: 's', values: [1] }] },
      }),
    ).toThrow(PresentationChartError);
    expect(() =>
      insertChart(deckWithSlides(1), 1, { transform: transform(0, 0, 1, 1), chart: { ...CHART, categories: [] } }),
    ).toThrow(PresentationChartError);
    expect(() =>
      insertChart(deckWithSlides(1), 1, {
        transform: transform(0, 0, 1, 1),
        chart: { ...CHART, chart_type: 'radar' as never },
      }),
    ).toThrow(PresentationChartError);
    expect(() =>
      insertChart(deckWithSlides(1), 1, {
        transform: transform(0, 0, 1, 1),
        chart: { ...CHART, series: [{ name: 's', values: [1, Number.NaN, 3] }] },
      }),
    ).toThrow(PresentationChartError);

    const { presentation, chart_id } = chartDeck();
    expect(() =>
      setChartData(presentation, 1, chart_id, { categories: ['a'], series: [{ name: 's', values: [1, 2] }] }),
    ).toThrow(PresentationChartError);
  });

  it('选项表校验：图例位置与样式 id 越界 ⇒ 报错；合法值合并生效', () => {
    let options = setChartOptions(new Map(), 2, { legend: 'top' });
    options = setChartOptions(options, 2, { style_id: 12 });
    expect(chartOptionsOf(options, 2)).toMatchObject({ legend: 'top', style_id: 12, data_labels: false });
    expect(() => setChartOptions(options, 2, { legend: 'middle' as never })).toThrow(PresentationChartError);
    expect(() => setChartOptions(options, 2, { style_id: 99 })).toThrow(PresentationChartError);
  });
});

describe('PPT-09：嵌入数据与图形一致且可编辑', () => {
  it('部件装配：图表部件 + 嵌入工作簿成对，读回校验通过', () => {
    const container = buildChartContainer(CHART);
    const report = verifyChartPackage(container.bytes);
    expect(report.chart_path).toBe('ppt/charts/chart1.xml');
    expect(report.workbook_path).toBe('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    expect(report.categories).toBe(3);
    expect(report.series).toBe(2);

    // 图表部件自带 _rels，指向嵌入工作簿。
    const archive = readZip(container.bytes);
    const rels = archive.by_path.get('ppt/charts/_rels/chart1.xml.rels');
    expect(rels).toBeDefined();
    expect(Buffer.from(rels?.data ?? []).toString('utf8')).toContain(
      'Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"',
    );
    // 幻灯片部件里引用图表部件（p:graphicFrame + c:chart@r:id）。
    const slide = Buffer.from(archive.by_path.get('ppt/slides/slide1.xml')?.data ?? []).toString('utf8');
    expect(slide).toContain('p:graphicFrame');
    expect(slide).toContain('<c:chart r:id="rId1"/>');
  });

  it('嵌入的是**真 XLSX**：能再解压出 workbook 与 sheet，单元格数值与图表数据同源', () => {
    const workbookBytes = renderEmbeddedWorkbookBytes(CHART);
    const inner = readZip(workbookBytes);
    expect(inner.by_path.has('xl/workbook.xml')).toBe(true);
    expect(inner.by_path.has('xl/worksheets/sheet1.xml')).toBe(true);

    const sheet = Buffer.from(inner.by_path.get('xl/worksheets/sheet1.xml')?.data ?? []).toString('utf8');
    const root = parseXmlDocument(sheet);
    const cells = elements(root, 'c');
    const byRef = new Map(cells.map((cell) => [attributeOf(cell, 'r') ?? '', textOf(elements(cell, 'v')[0]) || textOf(elements(cell, 't')[0])]));
    // B1/C1 = 系列名；A2..A4 = 类别；B2..B4 / C2..C4 = 值。
    expect(byRef.get('B1')).toBe('收入');
    expect(byRef.get('C1')).toBe('支出');
    expect(byRef.get('A2')).toBe('一月');
    expect(byRef.get('B2')).toBe('1.5');
    expect(byRef.get('C4')).toBe('2');
    expect(cells).toHaveLength(2 + 3 * 3);

    // 与"图形侧"的数据网格一致（列字母换算也一并验证）。
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    const grid = chartDataGrid(CHART);
    expect(grid[0]).toEqual(['类别', '收入', '支出']);
    expect(grid[2]).toEqual(['二月', '2.25', '1.25']);
  });

  it('折线 / 饼图同样成对可读回', () => {
    for (const chartType of ['bar', 'line', 'pie'] as const) {
      const built = buildChartParts({ ...CHART, chart_type: chartType });
      expect(built.chart_relationships).toHaveLength(1);
      expect(verifyChartPackage(buildChartContainer({ ...CHART, chart_type: chartType }).bytes).series).toBe(2);
    }
  });

  it('接线片段：slide → chart 的关系声明与 graphicFrame 的 r:id 是同一套 id 约定', () => {
    const { presentation, chart_id } = chartDeck();
    const shape = requireChart(presentation, 1, chart_id);
    const frame = slideChartGraphicFrameXml(shape, 'rId2');
    expect(frame).toContain('uri="http://schemas.openxmlformats.org/drawingml/2006/chart"');
    expect(frame).toContain('<c:chart r:id="rId2"/>');
    expect(chartSlideRelationship()).toEqual({
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
      target: '../charts/chart1.xml',
    });
    const declared = slideChartGraphicFrameXml(shape, 'rId1');
    expect(parseXmlDocument(declared).name).toBe('p:graphicFrame');
  });
});

describe('PPT-09 反向对照：数据不同步 / 部件不成对必须被捕获', () => {
  it('偷改嵌入工作簿里的一处数值 ⇒ chart_data_desync', () => {
    const container = buildChartContainer(CHART);
    const tampered = patchEmbeddedWorkbook(container.bytes, '<v>2.25</v>', '<v>9.99</v>');
    try {
      verifyChartPackage(tampered);
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationChartError);
      expect((error as PresentationChartError).reason).toBe('chart_data_desync');
    }
    // 未篡改的原件仍然通过（证明报错来自那处篡改，不是"永远报错"）。
    expect(verifyChartPackage(container.bytes).series).toBe(2);
  });

  it('偷改图表缓存里的一个值（工作表没变）⇒ 同样 chart_data_desync', () => {
    const container = buildChartContainer(CHART);
    const archive = readZip(container.bytes);
    const tampered = writeZip(
      archive.entries.map((entry) =>
        entry.path === 'ppt/charts/chart1.xml'
          ? {
              path: entry.path,
              data: utf8Bytes(Buffer.from(entry.data).toString('utf8').replace('<c:v>1.5</c:v>', '<c:v>7.5</c:v>')),
            }
          : { path: entry.path, data: entry.data },
      ),
    );
    try {
      verifyChartPackage(tampered);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationChartError).reason).toBe('chart_data_desync');
    }
  });

  it('抽掉嵌入工作簿部件（rId 还在）⇒ chart_part_unpaired', () => {
    const container = buildChartContainer(CHART);
    const archive = readZip(container.bytes);
    const stripped = writeZip(
      archive.entries
        .filter((entry) => entry.path !== 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx')
        .map((entry) => ({ path: entry.path, data: entry.data })),
    );
    try {
      verifyChartPackage(stripped);
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationChartError);
      expect((error as PresentationChartError).reason).toBe('chart_part_unpaired');
    }
  });

  it('图表部件缺 c:externalData ⇒ chart_part_unpaired（数据不可编辑）', () => {
    const container = buildChartContainer(CHART);
    const archive = readZip(container.bytes);
    const stripped = writeZip(
      archive.entries.map((entry) =>
        entry.path === 'ppt/charts/chart1.xml'
          ? {
              path: entry.path,
              data: utf8Bytes(
                Buffer.from(entry.data)
                  .toString('utf8')
                  .replace(/<c:externalData[\s\S]*?<\/c:externalData>/, ''),
              ),
            }
          : { path: entry.path, data: entry.data },
      ),
    );
    try {
      verifyChartPackage(stripped);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationChartError).reason).toBe('chart_part_unpaired');
    }
  });
});

describe('PPT-09：便捷构造', () => {
  it('chartShape 造图并校验数据；chartDataGrid 与模型一致', () => {
    const shape = chartShape(3, CHART, { name: '销售' });
    expect(shape.kind).toBe('chart');
    expect(shape.name).toBe('销售');
    expect(() => chartShape(3, { ...CHART, series: [] })).toThrow(PresentationChartError);
    expect(chartDataGrid(CHART)[3]).toEqual(['三月', '3', '2']);
  });
});

// ---------------------------------------------------------------------------
// P-I17：描述符 → 真实字节；数据编辑落在真字节上、读回校验
// ---------------------------------------------------------------------------

/** 从真 XLSX 字节里读单元格（地址 → 文本 / 数值），独立于 charts.ts 的解码器。 */
function workbookCellTexts(workbookBytes: Uint8Array): Map<string, string> {
  const inner = readZip(workbookBytes);
  const sheetEntry = inner.by_path.get('xl/worksheets/sheet1.xml');
  if (sheetEntry === undefined) throw new Error('嵌入工作簿没有 sheet1.xml');
  const root = parseXmlDocument(Buffer.from(sheetEntry.data).toString('utf8'));
  const out = new Map<string, string>();
  for (const cell of elements(root, 'c')) {
    const ref = attributeOf(cell, 'r') ?? '';
    const inline = elements(cell, 't')[0];
    const value = elements(cell, 'v')[0];
    out.set(ref, textOf(inline) || textOf(value));
  }
  return out;
}

describe('P-I17：数据编辑 → 真字节（图部件 + 嵌入工作簿同版，读回校验）', () => {
  it('renderChartPackage：装配真 ZIP，verifyChartPackage 通过，逐格解码与模型一致', () => {
    const pkg = renderChartPackage(CHART);
    expect(pkg.report.chart_path).toBe('ppt/charts/chart1.xml');
    expect(pkg.report.workbook_path).toBe('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    expect(pkg.report.series).toBe(2);
    expect(pkg.report.categories).toBe(3);

    // 从图表部件缓存读回 = 从工作簿读回 = 模型数据（两条独立解码路径一致）。
    expect(pkg.chart_data).toEqual(chartDataOf(CHART));
    expect(pkg.workbook_data).toEqual(chartDataOf(CHART));
    expect(pkg.version).toBe(dataVersionOf(chartDataOf(CHART)));

    // 真 XLSX 字节独立读回：B1/C1 系列名、A 列类别、B/C 列数值。
    const cells = workbookCellTexts(pkg.workbook_bytes);
    expect(cells.get('B1')).toBe('收入');
    expect(cells.get('C1')).toBe('支出');
    expect(cells.get('A2')).toBe('一月');
    expect(cells.get('B2')).toBe('1.5');
    expect(cells.get('C4')).toBe('2');
    // 真字节里的指纹 == 快照版本（无快照时等于数据自身指纹）。
    expect(dataVersionOf(readEmbeddedWorkbookData(pkg.workbook_bytes))).toBe(pkg.version);
  });

  it('readChartPartData / readEmbeddedWorkbookData 是**真读回**：篡改字节后读数随之改变', () => {
    const pkg = renderChartPackage(CHART);
    expect(readChartPartData(pkg.bytes)).toEqual(chartDataOf(CHART));
    expect(readEmbeddedWorkbookData(pkg.workbook_bytes)).toEqual(chartDataOf(CHART));

    // 篡改嵌入工作簿里的一处数值：真 XLSX 读数必须跟着变（不是回显输入）。
    const container = buildChartContainer(CHART);
    const tampered = patchEmbeddedWorkbook(container.bytes, '<v>2.25</v>', '<v>9.99</v>');
    const tamperedWorkbook = readZip(tampered).by_path.get('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    expect(tamperedWorkbook).toBeDefined();
    const decoded = readEmbeddedWorkbookData(tamperedWorkbook?.data ?? new Uint8Array());
    expect(decoded.series[0]?.values[1]).toBe(9.99);
    expect(dataVersionOf(decoded)).not.toBe(pkg.version);
  });

  it('版本不变式：快照 → 真字节，字节解码的指纹 == 快照 version；伪造版本 ⇒ chart_version_mismatch', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(chartDataOf(CHART));
    const pkg = renderChartPackageFromSnapshot(snapshot, { chart_type: 'bar', title: '季度对比' });
    expect(pkg.version).toBe(snapshot.version);
    expect(dataVersionOf(pkg.workbook_data)).toBe(snapshot.version);
    expect(dataVersionOf(pkg.chart_data)).toBe(snapshot.version);

    const forged: ChartDataSnapshot = { ...snapshot, version: 'dc1-deadbeef' };
    try {
      renderChartPackageFromSnapshot(forged);
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationChartError);
      expect((error as PresentationChartError).reason).toBe('chart_version_mismatch');
    }
  });

  it('applyChartDataEditToPackage：改一个点 ⇒ 图缓存 / 工作簿 / 指纹一起变，且真字节读回通过', () => {
    const before: ChartDataSnapshot = snapshotChartData(chartDataOf(CHART));
    const { snapshot: after, package: pkg } = applyChartDataEditToPackage(before, {
      kind: 'set_value',
      series_index: 1,
      category_index: 0,
      value: 99,
    });

    expect(after.version).not.toBe(before.version);
    expect(pkg.version).toBe(after.version);
    expect(pkg.report.series).toBe(2);

    // 图缓存第二系列第 0 点 = 99；工作簿 C2 = 99（两条独立路径）。
    expect(pkg.chart_data.series[1]?.values[0]).toBe(99);
    expect(pkg.workbook_data.series[1]?.values[0]).toBe(99);
    const cells = workbookCellTexts(pkg.workbook_bytes);
    expect(cells.get('C2')).toBe('99');

    // 改数据后的真字节仍被 verifyChartPackage 接受（成对 + 逐点同步）。
    expect(() => verifyChartPackage(pkg.bytes)).not.toThrow();
    // 原件不受影响。
    expect(before.data.series[1]?.values[0]).toBe(0.5);
  });

  it('renderChartPackageFromData 拒绝非法数据（系列长度与类别不符）', () => {
    const bad: ExpectedChartData = { categories: ['a', 'b'], series: [{ name: 's', values: [1] }] };
    expect(() => renderChartPackageFromData(bad)).toThrow(PresentationChartError);
  });

  it('反向对照：篡改嵌入工作簿 ⇒ verifyChartPackage 报 chart_data_desync，指纹也对不上', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(chartDataOf(CHART));
    const pkg = renderChartPackageFromSnapshot(snapshot);
    const tampered = patchEmbeddedWorkbook(pkg.bytes, '<v>3</v>', '<v>8</v>');
    try {
      verifyChartPackage(tampered);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationChartError).reason).toBe('chart_data_desync');
    }
    // 未篡改的原件仍然通过（报错来自那处篡改，不是"永远报错"）。
    expect(verifyChartPackage(pkg.bytes).series).toBe(2);
  });
});
