/**
 * `charts.ts` 的验收用例（XLS-12）。
 *
 * **判据不是"函数没抛错"，而是"产出的字节里是什么"**：全部断言都先把
 * {@link writeChartWorkbookXlsx} 的产物用仓内 `readZip` 打开，再逐部件核对——
 * 图表部件是否存在、`<c:f>` 是不是**工作簿区域引用**、绘图锚点/关系 id 是否对得上、
 * 工作表里是不是真的多了 `<drawing r:id>`。
 *
 * 反向对照（本文件的"至少一条反向"）：见 describe「反向对照」——既包括**拒绝非法绑定**
 * （不存在的表 / 越界区域 / 引用了工作簿外的想象区域），也包括**读回后的否定断言**
 * （图表部件里不得出现任何数值缓存副本）。
 */

import { describe, expect, it } from 'vitest';

import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { XLSX_WORKBOOK_PART_PATH } from '../artifacts/templates/xlsx.js';
import { readZip, type ReadZipArchive } from '../artifacts/ooxml/zip-read.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook } from './workbook.js';
import { formulaValue, numberValue, textValue } from './value.js';
import {
  CHART_RELATIONSHIP_TYPE,
  DRAWING_RELATIONSHIP_TYPE,
  XLSX_CHART_CONTENT_TYPE,
  XLSX_DRAWING_CONTENT_TYPE,
  addChart,
  buildChartXml,
  chartPartPath,
  chartPartPaths,
  chartReferenceText,
  composeWorkbookPackage,
  createChart,
  createChartSet,
  deleteChart,
  drawingPartPath,
  findChart,
  replaceChart,
  setChartAnchor,
  setChartAxis,
  setChartData,
  setChartKind,
  setChartLegend,
  setChartStyle,
  setChartTitle,
  validateChartReference,
  workbookRelationshipCount,
  workbookRelationshipId,
  writeChartWorkbookXlsx,
  type ChartSeries,
} from './charts.js';

const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function buildWorkbook() {
  let budget = createSheet('预算', { row_count: 10, column_count: 5 });
  budget = setCellValue(budget, 'A1', textValue('项目'));
  budget = setCellValue(budget, 'B1', textValue('金额'));
  budget = setCellValue(budget, 'A2', textValue('餐饮'));
  budget = setCellValue(budget, 'B2', numberValue(120.5));
  budget = setCellValue(budget, 'A3', textValue('交通'));
  budget = setCellValue(budget, 'B3', numberValue(80));
  budget = setCellValue(budget, 'A4', textValue('住宿'));
  budget = setCellValue(budget, 'B4', numberValue(200));
  budget = setCellValue(budget, 'A5', textValue('合计'));
  budget = setCellValue(budget, 'B5', formulaValue('SUM(B2:B4)'));

  let detail = createSheet('明细', { row_count: 10, column_count: 5 });
  detail = setCellValue(detail, 'A1', textValue('X'));
  detail = setCellValue(detail, 'B1', textValue('Y'));
  detail = setCellValue(detail, 'A2', numberValue(1));
  detail = setCellValue(detail, 'B2', numberValue(2));
  detail = setCellValue(detail, 'A3', numberValue(2));
  detail = setCellValue(detail, 'B3', numberValue(4));
  detail = setCellValue(detail, 'A4', numberValue(3));
  detail = setCellValue(detail, 'B4', numberValue(9));

  return createWorkbook([budget, detail]);
}

const BUDGET_SERIES: ChartSeries = Object.freeze({
  name: { sheet: '预算', range: 'B1' },
  categories: { sheet: '预算', range: 'A2:A4' },
  values: { sheet: '预算', range: 'B2:B4' },
});

const SCATTER_SERIES: ChartSeries = Object.freeze({
  name: { sheet: '明细', range: 'B1' },
  categories: { sheet: '明细', range: 'A2:A4' },
  values: { sheet: '明细', range: 'B2:B4' },
});

/** 五种图表各一张，挂在 `预算` 表上。 */
function buildChartSet() {
  const workbook = buildWorkbook();
  let set = createChartSet(workbook, '预算');
  set = addChart(
    set,
    createChart(workbook, {
      name: '柱状图',
      kind: 'column',
      title: '分类支出',
      series: [BUDGET_SERIES],
      anchor: { from_column: 4, from_row: 1, to_column: 11, to_row: 16 },
    }),
  );
  set = addChart(set, createChart(workbook, { name: '条形图', kind: 'bar', series: [BUDGET_SERIES] }));
  set = addChart(set, createChart(workbook, { name: '折线图', kind: 'line', series: [BUDGET_SERIES] }));
  set = addChart(set, createChart(workbook, { name: '饼图', kind: 'pie', series: [BUDGET_SERIES] }));
  const scatterSet = createChartSet(workbook, '明细');
  return {
    workbook,
    set,
    scatterSet: addChart(
      scatterSet,
      createChart(workbook, { name: '散点图', kind: 'scatter', series: [SCATTER_SERIES] }),
    ),
  };
}

function textOfPart(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function rootOfPart(archive: ReadZipArchive, path: string): ParsedXmlElement {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return parseXmlBytes(entry.data);
}

function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

/** 递归找一个后代元素（`c:chart` 埋在 `xdr:graphicFrame/a:graphic/a:graphicData` 里）。 */
function findDeep(
  element: ParsedXmlElement,
  namespace: string,
  localName: string,
): ParsedXmlElement | null {
  for (const child of childrenOf(element)) {
    if (child.namespace === namespace && child.localName === localName) return child;
    const nested = findDeep(child, namespace, localName);
    if (nested !== null) return nested;
  }
  return null;
}

/** 图表 XML 里所有的 `<c:f>` 文本（按出现顺序）。 */
function formulasOf(root: ParsedXmlElement): readonly string[] {
  const found: string[] = [];
  const walk = (element: ParsedXmlElement): void => {
    if (element.localName === 'f' && element.namespace === CHART_NS) {
      found.push(directText(element));
    }
    for (const child of childrenOf(element)) walk(child);
  };
  walk(root);
  return found;
}

describe('charts：部件清单与容器（XLS-12 产出物）', () => {
  const { workbook, set, scatterSet } = buildChartSet();
  const result = writeChartWorkbookXlsx(workbook, [set, scatterSet]);
  const archive = readZip(result.bytes);
  const paths = archive.entries.map((entry) => entry.path);

  it('图表 / 绘图 / 双方关系部件都真实落在包里', () => {
    expect(paths).toContain(chartPartPath(0));
    expect(paths).toContain(chartPartPath(4));
    expect(paths).toContain(drawingPartPath(0));
    expect(paths).toContain(drawingPartPath(1));
    expect(paths).toContain('xl/drawings/_rels/drawing1.xml.rels');
    expect(paths).toContain('xl/drawings/_rels/drawing2.xml.rels');
    expect(paths).toContain('xl/worksheets/_rels/sheet1.xml.rels');
    expect(paths).toContain('xl/worksheets/_rels/sheet2.xml.rels');
    expect(chartPartPaths([set, scatterSet])).toEqual([
      chartPartPath(0),
      chartPartPath(1),
      chartPartPath(2),
      chartPartPath(3),
      drawingPartPath(0),
      chartPartPath(4),
      drawingPartPath(1),
    ]);
  });

  it('内容类型表里有图表与绘图的 Override', () => {
    const types = textOfPart(archive, '[Content_Types].xml');
    expect(types).toContain(`PartName="/xl/charts/chart1.xml" ContentType="${XLSX_CHART_CONTENT_TYPE}"`);
    expect(types).toContain(`PartName="/xl/drawings/drawing1.xml" ContentType="${XLSX_DRAWING_CONTENT_TYPE}"`);
  });

  it('确定性：同一 (工作簿, 图表集合) 连跑两次 ⇒ 字节相等、摘要相等', () => {
    const again = writeChartWorkbookXlsx(workbook, [set, scatterSet]);
    expect(Buffer.compare(result.bytes, again.bytes)).toBe(0);
    expect(again.content_digest).toBe(result.content_digest);
    expect(result.content_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('基础部件一个不少（既有写入器的产出仍完整：样式 / 公式缓存 / 第二张表）', () => {
    expect(paths).toContain('xl/styles.xml');
    expect(paths).toContain('xl/worksheets/sheet1.xml');
    expect(paths).toContain('xl/worksheets/sheet2.xml');
    const sheet1 = textOfPart(archive, 'xl/worksheets/sheet1.xml');
    // 公式缓存仍由既有求值器写入（B5 = 400.5），说明扩展没有破坏基础写入路径
    expect(sheet1).toContain('<c r="B5"><f>SUM(B2:B4)</f><v>400.5</v></c>');
  });
});

describe('charts：工作表接线（工作表里真的多了 <drawing>）', () => {
  const { workbook, set, scatterSet } = buildChartSet();
  const archive = readZip(writeChartWorkbookXlsx(workbook, [set, scatterSet]).bytes);

  it('工作表根元素补了 xmlns:r，末尾追加 <drawing r:id="rId1"/>', () => {
    const sheet1 = textOfPart(archive, 'xl/worksheets/sheet1.xml');
    expect(sheet1).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    expect(sheet1).toContain('<drawing r:id="rId1"/></worksheet>');
    expect(sheet1.endsWith('</worksheet>')).toBe(true);
    // 既有子元素顺序没被打乱：mergeCells/dimension 之类照旧在前
    expect(sheet1.indexOf('<sheetData>')).toBeLessThan(sheet1.indexOf('<drawing'));
  });

  it('没有图表的表**不**被追加 <drawing>（避免声明一条指不到东西的关系）', () => {
    const clean = createWorkbook([createSheet('空表', { row_count: 3, column_count: 3 })]);
    const bytes = writeChartWorkbookXlsx(clean, []).bytes;
    expect(textOfPart(readZip(bytes), 'xl/worksheets/sheet1.xml')).not.toContain('<drawing');
    expect(readZip(bytes).by_path.has('xl/worksheets/_rels/sheet1.xml.rels')).toBe(false);
  });

  it('工作表 → 绘图的关系声明指向 drawing1，类型是 drawing', () => {
    const rels = rootOfPart(archive, 'xl/worksheets/_rels/sheet1.xml.rels');
    const declarations = childrenOf(rels);
    expect(declarations.length).toBe(1);
    const relation = declarations[0] as ParsedXmlElement;
    expect(attributeValue(relation, '', 'Id')).toBe('rId1');
    expect(attributeValue(relation, '', 'Type')).toBe(DRAWING_RELATIONSHIP_TYPE);
    expect(attributeValue(relation, '', 'Target')).toBe('../drawings/drawing1.xml');
  });

  it('绘图 → 图表的关系数目与图表数一致，且目标落在 chartN.xml 上', () => {
    const rels = rootOfPart(archive, 'xl/drawings/_rels/drawing1.xml.rels');
    const declarations = childrenOf(rels);
    expect(declarations.length).toBe(4);
    expect(declarations.map((entry) => attributeValue(entry, '', 'Type'))).toEqual([
      CHART_RELATIONSHIP_TYPE,
      CHART_RELATIONSHIP_TYPE,
      CHART_RELATIONSHIP_TYPE,
      CHART_RELATIONSHIP_TYPE,
    ]);
    expect(declarations.map((entry) => attributeValue(entry, '', 'Target'))).toEqual([
      '../charts/chart1.xml',
      '../charts/chart2.xml',
      '../charts/chart3.xml',
      '../charts/chart4.xml',
    ]);
    expect(declarations.map((entry) => attributeValue(entry, '', 'Id'))).toEqual([
      'rId1',
      'rId2',
      'rId3',
      'rId4',
    ]);
  });

  it('绘图部件里的 <c:chart r:id> 与关系 id 对得上，锚点行列号按 0 起换算', () => {
    const drawing = rootOfPart(archive, 'xl/drawings/drawing1.xml');
    const anchors = childrenOf(drawing).filter((child) => child.localName === 'twoCellAnchor');
    expect(anchors.length).toBe(4);

    const first = anchors[0] as ParsedXmlElement;
    const from = findChild(first, 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'from');
    const to = findChild(first, 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'to');
    // 显式锚点 (4,1) → (11,16)（1 起）⇒ 0 起 3 / 0 → 10 / 15
    expect(from === null ? null : directText(childrenOf(from)[0] as ParsedXmlElement)).toBe('3');
    expect(to === null ? null : directText(childrenOf(to)[0] as ParsedXmlElement)).toBe('10');

    const chartElement = findDeep(first, CHART_NS, 'chart');
    expect(chartElement === null ? null : attributeValue(chartElement, REL_NS, 'id')).toBe('rId1');
  });
});

describe('charts：数值绑定工作簿来源（XLS-12 的核心判据）', () => {
  const { workbook, set, scatterSet } = buildChartSet();
  const archive = readZip(writeChartWorkbookXlsx(workbook, [set, scatterSet]).bytes);

  it('系列数值写成 <c:f> 区域引用，且引用文本是工作表限定 + 绝对地址', () => {
    const chart1 = rootOfPart(archive, chartPartPath(0));
    expect(formulasOf(chart1)).toEqual([
      "'预算'!$B$1",
      "'预算'!$A$2:$A$4",
      "'预算'!$B$2:$B$4",
    ]);
  });

  it('**反向对照**：图表部件里没有任何数值缓存副本（`numCache` / `strCache` / `<c:pt`）', () => {
    for (const path of [chartPartPath(0), chartPartPath(1), chartPartPath(2), chartPartPath(3)]) {
      const xml = textOfPart(archive, path);
      expect(xml).not.toContain('numCache');
      expect(xml).not.toContain('strCache');
      expect(xml).not.toContain('<c:pt');
      // 任何一个缓存的数字都会以 <c:v> 出现；图表部件里连 <c:v> 都不该有
      expect(xml).not.toContain('<c:v>');
    }
  });

  it('引用文本工具本身：表名一律加引号，单引号转义为两个', () => {
    expect(chartReferenceText({ sheet: '预算', range: 'B2:B4' })).toBe("'预算'!$B$2:$B$4");
    expect(chartReferenceText({ sheet: "It's", range: 'A1' })).toBe("'It''s'!$A$1");
  });

  it('区域文本被归一化（小写 / 反序输入同样得到左上到右下的绝对引用）', () => {
    const normalized = validateChartReference(buildWorkbook(), { sheet: '预算', range: 'b4:b2' }, 'test');
    expect(normalized).toEqual({ sheet: '预算', range: 'B2:B4' });
  });
});

describe('charts：五种图表的类型差异', () => {
  const { workbook, set, scatterSet } = buildChartSet();
  const archive = readZip(writeChartWorkbookXlsx(workbook, [set, scatterSet]).bytes);

  it('柱 vs 条：同一 barChart 元素，barDir 分别是 col / bar', () => {
    const column = textOfPart(archive, chartPartPath(0));
    const bar = textOfPart(archive, chartPartPath(1));
    expect(column).toContain('<c:barDir val="col"/>');
    expect(bar).toContain('<c:barDir val="bar"/>');
  });

  it('折线：lineChart + 折线系列带 marker；且带分类轴与数值轴', () => {
    const line = textOfPart(archive, chartPartPath(2));
    expect(line).toContain('<c:lineChart>');
    expect(line).toContain('<c:marker><c:symbol val="none"/></c:marker>');
    expect(line).toContain('<c:catAx>');
    expect(line).toContain('<c:valAx>');
  });

  it('饼图：pieChart，且**没有坐标轴**（饼图没有轴）', () => {
    const pie = textOfPart(archive, chartPartPath(3));
    expect(pie).toContain('<c:pieChart>');
    expect(pie).not.toContain('<c:catAx>');
    expect(pie).not.toContain('<c:valAx>');
  });

  it('散点：scatterChart + 两对 xVal/yVal，两条数值轴', () => {
    const scatter = textOfPart(archive, chartPartPath(4));
    expect(scatter).toContain('<c:scatterChart>');
    expect(scatter).toContain('<c:xVal>');
    expect(scatter).toContain('<c:yVal>');
    expect(formulasOf(rootOfPart(archive, chartPartPath(4)))).toEqual([
      "'明细'!$B$1",
      "'明细'!$A$2:$A$4",
      "'明细'!$B$2:$B$4",
    ]);
    expect((scatter.match(/<c:valAx>/g) ?? []).length).toBe(2);
  });
});

describe('charts：标题 / 轴 / 图例 / 样式 / 锚点', () => {
  const workbook = buildWorkbook();

  function xmlOf(chart: Parameters<typeof buildChartXml>[0]): string {
    return buildChartXml(chart);
  }

  it('标题：有标题写 c:title，无标题写 autoTitleDeleted', () => {
    const chart = createChart(workbook, { name: 'C', kind: 'column', title: '分类支出', series: [BUDGET_SERIES] });
    expect(xmlOf(chart)).toContain('<c:title>');
    expect(xmlOf(chart)).toContain('<a:t>分类支出</a:t>');
    expect(xmlOf(setChartTitle(chart, null))).toContain('<c:autoTitleDeleted val="1"/>');
  });

  it('轴：标题与网格线进入 catAx / valAx', () => {
    const chart = setChartAxis(
      createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES] }),
      { category_title: '项目', value_title: '金额', show_value_gridlines: true },
    );
    const xml = xmlOf(chart);
    expect(xml).toContain('<a:t>项目</a:t>');
    expect(xml).toContain('<a:t>金额</a:t>');
    // 网格线必须挂在 valAx 里（分类轴不该有）
    const valAxAt = xml.indexOf('<c:valAx>');
    expect(xml.slice(valAxAt, xml.indexOf('</c:valAx>'))).toContain('<c:majorGridlines/>');
    const catAxAt = xml.indexOf('<c:catAx>');
    expect(xml.slice(catAxAt, xml.indexOf('</c:catAx>'))).not.toContain('majorGridlines');
  });

  it('图例：四个位置各有代码；null 时整体不写 legend', () => {
    const base = createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES] });
    expect(base.legend).toBe('right'); // 缺省
    expect(xmlOf(base)).toContain('<c:legendPos val="r"/>');
    expect(xmlOf(setChartLegend(base, 'bottom'))).toContain('<c:legendPos val="b"/>');
    expect(xmlOf(setChartLegend(base, 'left'))).toContain('<c:legendPos val="l"/>');
    expect(xmlOf(setChartLegend(base, 'top'))).toContain('<c:legendPos val="t"/>');
    const noLegend = setChartLegend(base, null);
    expect(xmlOf(noLegend)).not.toContain('<c:legend>');
  });

  it('样式：variant 写在 chartSpace 上、颜色写在系列 spPr 里、数据标签写 dLbls', () => {
    const chart = setChartStyle(
      createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES] }),
      { variant: 12, series_colors: ['ff0000'], show_data_labels: true },
    );
    const xml = xmlOf(chart);
    expect(xml).toContain('<c:style val="12"/>');
    expect(xml).toContain('<a:srgbClr val="FF0000"/>');
    expect(xml).toContain('<c:dLbls><c:showVal val="1"/></c:dLbls>');
    // 样式号必须在 chart 之前（CT_ChartSpace 的序列要求）
    expect(xml.indexOf('<c:style')).toBeLessThan(xml.indexOf('<c:chart>'));
  });

  it('锚点：改锚点改变绘图里的行列号（0 起）', () => {
    const chart = setChartAnchor(
      createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES] }),
      { from_column: 1, from_row: 1, to_column: 6, to_row: 11 },
    );
    const drawingXml = textOfPart(
      readZip(writeChartWorkbookXlsx(workbook, [addChart(createChartSet(workbook, '预算'), chart)]).bytes),
      drawingPartPath(0),
    );
    expect(drawingXml).toContain('<xdr:col>0</xdr:col>');
    expect(drawingXml).toContain('<xdr:row>10</xdr:row>');
  });

  it('**反向对照**：锚点右下不大于左上 ⇒ 抛（不许产出零尺寸图表）', () => {
    expect(() =>
      createChart(workbook, {
        name: 'C',
        kind: 'column',
        series: [BUDGET_SERIES],
        anchor: { from_column: 5, from_row: 5, to_column: 5, to_row: 9 },
      }),
    ).toThrow(/锚点必须右下大于左上/);
  });
});

describe('charts：改数据 / 删除', () => {
  const workbook = buildWorkbook();

  it('改数据：系列引用换掉后，图表 XML 里是新区域（旧区域消失）', () => {
    const chart = createChart(workbook, { name: 'C', kind: 'line', series: [BUDGET_SERIES] });
    const updated = setChartData(workbook, chart, [
      { name: { sheet: '预算', range: 'B1' }, categories: { sheet: '预算', range: 'A2:A4' }, values: { sheet: '预算', range: 'B2:B4' } },
      { values: { sheet: '预算', range: 'B2:B4' } },
    ]);
    const xml = buildChartXml(updated);
    expect(xml).toContain('<c:idx val="1"/>');
    expect((xml.match(/<c:order val=/g) ?? []).length).toBe(2);

    const narrowed = setChartData(workbook, chart, [{ values: { sheet: '预算', range: 'B3:B4' } }]);
    expect(buildChartXml(narrowed)).toContain("<c:f>'预算'!$B$3:$B$4</c:f>");
    expect(buildChartXml(chart)).not.toContain('$B$3:$B$4');
  });

  it('删除：删掉一张图后它的部件不再出现在包里，其余图表的编号与关系重排', () => {
    let set = createChartSet(workbook, '预算');
    set = addChart(set, createChart(workbook, { name: 'A', kind: 'column', series: [BUDGET_SERIES] }));
    set = addChart(set, createChart(workbook, { name: 'B', kind: 'line', series: [BUDGET_SERIES] }));

    const before = readZip(writeChartWorkbookXlsx(workbook, [set]).bytes);
    expect(before.by_path.has(chartPartPath(1))).toBe(true);

    const after = deleteChart(set, 'A');
    expect(findChart(after, 'A')).toBeUndefined();
    const bytes = writeChartWorkbookXlsx(workbook, [after]).bytes;
    const archive = readZip(bytes);
    expect(archive.by_path.has(chartPartPath(1))).toBe(false);
    // 剩下的唯一一张图现在是 chart1.xml，绘图关系只有一条
    expect(textOfPart(archive, chartPartPath(0))).toContain('<c:lineChart>');
    expect(childrenOf(rootOfPart(archive, 'xl/drawings/_rels/drawing1.xml.rels')).length).toBe(1);
  });

  it('**反向对照**：删不存在的图表 ⇒ 抛（不静默成功）', () => {
    const set = createChartSet(workbook, '预算');
    expect(() => deleteChart(set, '不存在')).toThrow(/没有图表/);
  });

  it('**反向对照**：同名图表不许加两次', () => {
    let set = createChartSet(workbook, '预算');
    const chart = createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES] });
    set = addChart(set, chart);
    expect(() => addChart(set, chart)).toThrow(/拒绝重名/);
  });

  it('替换：replaceChart 保留原顺序；不存在则抛', () => {
    let set = createChartSet(workbook, '预算');
    set = addChart(set, createChart(workbook, { name: 'A', kind: 'column', series: [BUDGET_SERIES] }));
    set = addChart(set, createChart(workbook, { name: 'B', kind: 'column', series: [BUDGET_SERIES] }));
    const target = findChart(set, 'B');
    expect(target).toBeDefined();
    const replaced = replaceChart(set, setChartKind(target as NonNullable<typeof target>, 'line'));
    expect(replaced.charts.map((chart) => chart.name)).toEqual(['A', 'B']);
    expect(replaced.charts[1]?.kind).toBe('line');
    expect(() =>
      replaceChart(set, createChart(workbook, { name: 'Z', kind: 'column', series: [BUDGET_SERIES] })),
    ).toThrow(/没有图表/);
  });
});

describe('charts：反向对照——拒绝不绑定工作簿来源的图表', () => {
  const workbook = buildWorkbook();

  it('引用不存在的表 ⇒ 抛', () => {
    expect(() =>
      createChart(workbook, {
        name: 'C',
        kind: 'column',
        series: [{ values: { sheet: '查无此表', range: 'B2:B4' } }],
      }),
    ).toThrow(/不存在的工作表/);
  });

  it('引用越出工作表声明范围的区域 ⇒ 抛', () => {
    expect(() =>
      createChart(workbook, {
        name: 'C',
        kind: 'column',
        series: [{ values: { sheet: '预算', range: 'F2:F4' } }],
      }),
    ).toThrow(/超出工作表/);
  });

  it('二维区域（成块）不能当系列 ⇒ 抛（图表系列的取值必须是一维的）', () => {
    expect(() =>
      createChart(workbook, {
        name: 'C',
        kind: 'column',
        series: [{ values: { sheet: '预算', range: 'A2:B4' } }],
      }),
    ).toThrow(/不是一维区域/);
  });

  it('分类与数值长度不一致 ⇒ 抛', () => {
    expect(() =>
      createChart(workbook, {
        name: 'C',
        kind: 'column',
        series: [{ categories: { sheet: '预算', range: 'A2:A4' }, values: { sheet: '预算', range: 'B2:B3' } }],
      }),
    ).toThrow(/长度不一致/);
  });

  it('没有任何系列 ⇒ 抛（"图表"必须绑定来源，不是一张空画布）', () => {
    expect(() => createChart(workbook, { name: 'C', kind: 'column', series: [] })).toThrow(/没有任何数据系列/);
  });

  it('饼图多个系列 ⇒ 抛', () => {
    expect(() =>
      createChart(workbook, { name: 'C', kind: 'pie', series: [BUDGET_SERIES, BUDGET_SERIES] }),
    ).toThrow(/饼图只能有一个数据系列/);
  });

  it('散点缺 X 值 ⇒ 抛', () => {
    expect(() =>
      createChart(workbook, { name: 'C', kind: 'scatter', series: [{ values: { sheet: '明细', range: 'B2:B4' } }] }),
    ).toThrow(/缺少 X 值/);
  });

  it('改数据时同样校验：换成越界区域 ⇒ 抛，原对象不被改写', () => {
    const chart = createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES] });
    expect(() => setChartData(workbook, chart, [{ values: { sheet: '预算', range: 'B2:B99' } }])).toThrow(
      /超出工作表/,
    );
    expect(chart.series[0]?.values.range).toBe('B2:B4');
  });

  it('未知图表类型 / 未知图例位置 / 系列颜色非 RRGGBB ⇒ 抛', () => {
    expect(() =>
      createChart(workbook, { name: 'C', kind: 'radar' as unknown as 'column', series: [BUDGET_SERIES] }),
    ).toThrow(/未知的图表类型/);
    expect(() =>
      createChart(workbook, {
        name: 'C',
        kind: 'column',
        series: [BUDGET_SERIES],
        legend: 'center' as unknown as 'right',
      }),
    ).toThrow(/未知的图例位置/);
    expect(() =>
      createChart(workbook, { name: 'C', kind: 'column', series: [BUDGET_SERIES], style: { series_colors: ['#ff0000'] } }),
    ).toThrow(/RRGGBB/);
  });
});

describe('charts：composeWorkbookPackage 的接线契约', () => {
  const workbook = buildWorkbook();

  it('未知的变换目标 ⇒ 抛（不静默忽略一个写错的部件路径）', () => {
    expect(() =>
      composeWorkbookPackage(workbook, {
        transforms: [{ part_path: 'xl/worksheets/sheet9.xml', children: ['<x/>'] }],
      }),
    ).toThrow(/不是本组装器生成的部件/);
  });

  it('空扩展 ⇒ 与既有写入器同部件清单（不引入任何额外部件）', () => {
    const result = composeWorkbookPackage(workbook);
    const paths = result.part_paths;
    expect(paths).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      XLSX_WORKBOOK_PART_PATH,
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/_rels/workbook.xml.rels',
    ]);
  });

  it('工作簿级扩展关系的 r:id 由 workbookRelationshipId 决定（两个工作表 + 样式 ⇒ 从 rId3 起）', () => {
    expect(workbookRelationshipCount(workbook)).toBe(3);
    expect(workbookRelationshipId(workbook, 0)).toBe('rId4');
    expect(workbookRelationshipId(workbook, 1)).toBe('rId5');
  });
});
