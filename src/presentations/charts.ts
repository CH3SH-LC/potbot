/**
 * 演示域**图表**（design-06 P9 / PPT-09）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 的 `ChartModel`（类型 + 类别 + 系列 + 标题）已能表达图表数据，
 * `render.ts` 遇到 `chart` 形状**显式报错**（`unsupported_shape_kind`：需要嵌入图表部件与
 * 嵌入工作簿，是它的边界）。本模块补上这两块：
 *
 * 1. **图表部件** `ppt/charts/chart1.xml`：图表类型分支（柱 / 折线 / 饼）、标题、轴与轴标题、
 *    图例、样式、数据标签，以及 `c:ser` 里 `c:cat`/`c:val` 的**缓存点**（`c:strCache`/`c:numCache`）；
 * 2. **嵌入工作簿** `ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx`：一份**真实的 XLSX**
 *    （`xl/workbook.xml` + `xl/worksheets/sheet1.xml`），数值与图表缓存**同源**，
 *    并由 `c:externalData@r:id` 指过去（"数据可编辑"的落点：改工作簿就能改图）；
 * 3. **同步校验**（`verifyChartPackage`）：把两份部件**都读回**，逐点比对
 *    —— 图表 XML 与嵌入工作表必须一致；缺一条关系 / 缺一份部件 / 数字对不上 ⇒ 具名报错。
 *
 * ## 「嵌入数据与图形一致且可编辑」怎么判
 *
 * - **一致**：不是"写的时候用了同一个数组"，而是**读回时逐点相等**：
 *   `c:numCache` 的点位与 `sheet1.xml` 的单元格 `v` 逐个比（数值按数比，类别按串比）；
 * - **可编辑**：嵌入的是真 XLSX（ZIP + SpreadsheetML），不是一段逗号分隔文本，
 *   且 `c:externalData` 指向它 ⇒ Office 打开后"编辑数据"改的是这份工作簿；
 * - **成对**：`c:externalData@r:id` 必须在该图表部件的 `_rels` 里有声明，且目标部件**真实存在**。
 *
 * ## 边界（**未**做的事 / **未验证**）
 *
 * - 本模块产出的是**图表部件容器**（slide → chart → embedded workbook 的部件图 +
 *   真字节），用于读回校验与接线参考；它**不是**完整 PPTX（没有母版 / 版式 / presentation.xml）。
 *   装配进整份演示由协调者在接线时完成（slide 上用本模块的 `slideChartGraphicFrameXml`）。
 * - 图表类型只做 `bar` / `line` / `pie`（与 `ChartModel.chart_type` 同集合）；
 *   堆积、次坐标轴、趋势线、误差线、组合图未做；
 * - **未**在真机 PowerPoint / WPS 里打开验证（本工作包只做字节级 + 解析级校验）。
 */

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  el,
  relationshipIdAt,
  readZip,
  serializeXmlDocument,
  writeZip,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type XmlElement,
} from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import type { ChartModel, ChartSeries, Presentation, Shape, Transform } from './model.js';
import { addShape, nextAvailableShapeId, removeShape } from './operations.js';
import {
  applyDataEdit,
  dataVersionOf,
  verifyChartDataCoherence,
  type ChartDataEdit,
  type ChartDataSnapshot,
  type ExpectedChartData,
} from './table-chart-parts/index.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 命名空间与关系类型
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const REL_PACKAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package';
const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CT_EMBEDDED_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CHART_PATH = 'ppt/charts/chart1.xml';
const EMBEDDED_WORKBOOK_PATH = 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx';
const CHART_SLIDE_PATH = 'ppt/slides/slide1.xml';

const SHEET_NAME = 'Sheet1';

/** 轴 id（同一份图表部件内的稳定标识）。 */
const CATEGORY_AXIS_ID = 111111111;
const VALUE_AXIS_ID = 222222222;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 图表层错误原因（供用例断言与上层分类处理）。 */
export type PresentationChartErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'not_a_chart'
  | 'duplicate_shape_id'
  | 'invalid_chart_type'
  | 'empty_chart_data'
  | 'series_length_mismatch'
  | 'invalid_chart_number'
  | 'invalid_column_index'
  | 'invalid_legend'
  | 'invalid_style'
  | 'chart_part_unpaired'
  | 'chart_data_desync'
  | 'chart_version_mismatch';

/** 图表层在语义不成立时抛出的错误（**不静默**）。 */
export class PresentationChartError extends ValidationError {
  readonly reason: PresentationChartErrorReason;

  constructor(reason: PresentationChartErrorReason, message: string) {
    super(message);
    this.name = 'PresentationChartError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 图表选项（模块自有：轴标题 / 图例 / 样式 / 数据标签）
// ---------------------------------------------------------------------------

/** 图例位置（`none` = 不要图例）。 */
export type ChartLegendPosition = 'none' | 'right' | 'bottom' | 'top' | 'left';

/** 图表选项。 */
export interface ChartOptions {
  readonly legend: ChartLegendPosition;
  /** `c:style@val`（1…48）；`null` = 不写样式。 */
  readonly style_id: number | null;
  readonly category_axis_title: string | null;
  readonly value_axis_title: string | null;
  readonly data_labels: boolean;
}

/** 默认选项：图例在右、无样式覆盖、无轴标题、不显示数据标签。 */
export const DEFAULT_CHART_OPTIONS: ChartOptions = Object.freeze({
  legend: 'right',
  style_id: null,
  category_axis_title: null,
  value_axis_title: null,
  data_labels: false,
});

/** 选项表：`shape_id` → 选项（模型里没有这些字段，故单列一张表）。 */
export type ChartOptionMap = ReadonlyMap<number, ChartOptions>;

/** 空选项表。 */
export const NO_CHART_OPTIONS: ChartOptionMap = new Map<number, ChartOptions>();

/** 取某图表的选项（未设置 ⇒ 默认）。 */
export function chartOptionsOf(options: ChartOptionMap, shapeId: number): ChartOptions {
  return options.get(shapeId) ?? DEFAULT_CHART_OPTIONS;
}

/** 合并式设置某图表的选项。 */
export function setChartOptions(
  options: ChartOptionMap,
  shapeId: number,
  patch: Partial<ChartOptions>,
): ChartOptionMap {
  const current = chartOptionsOf(options, shapeId);
  const next: ChartOptions = { ...current, ...patch };
  validateOptions(next);
  const map = new Map(options);
  map.set(shapeId, Object.freeze(next));
  return map;
}

function validateOptions(options: ChartOptions): void {
  if (!['none', 'right', 'bottom', 'top', 'left'].includes(options.legend)) {
    throw new PresentationChartError('invalid_legend', `图例位置非法：${String(options.legend)}`);
  }
  if (options.style_id !== null && (!Number.isSafeInteger(options.style_id) || options.style_id < 1 || options.style_id > 48)) {
    throw new PresentationChartError('invalid_style', `图表样式 id 必须是 1…48 或 null，收到 ${String(options.style_id)}`);
  }
}

// ---------------------------------------------------------------------------
// 模型操作（引入 / 改数据 / 改标题 / 改类型 / 删除）
// ---------------------------------------------------------------------------

/** 引入图表的参数。 */
export interface InsertChartSpec {
  readonly shape_id?: number;
  readonly name?: string;
  readonly transform: Transform;
  readonly chart: ChartModel;
}

function validateChart(chart: ChartModel): void {
  if (!['bar', 'line', 'pie'].includes(chart.chart_type)) {
    throw new PresentationChartError('invalid_chart_type', `图表类型非法：${String(chart.chart_type)}`);
  }
  if (chart.categories.length === 0) {
    throw new PresentationChartError('empty_chart_data', '图表没有类别（至少 1 个）');
  }
  if (chart.series.length === 0) {
    throw new PresentationChartError('empty_chart_data', '图表没有系列（至少 1 个）');
  }
  chart.series.forEach((series, index) => {
    if (series.values.length !== chart.categories.length) {
      throw new PresentationChartError(
        'series_length_mismatch',
        `第 ${String(index)} 个系列有 ${String(series.values.length)} 个值，类别有 ${String(chart.categories.length)} 个`,
      );
    }
    for (const value of series.values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PresentationChartError('invalid_chart_number', `第 ${String(index)} 个系列里有非有限数：${String(value)}`);
      }
    }
  });
}

/** 在指定页插入一个图表（PPT-09）。 */
export function insertChart(
  presentation: Presentation,
  slideId: number,
  spec: InsertChartSpec,
): { readonly presentation: Presentation; readonly shape_id: number } {
  validateChart(spec.chart);
  const shapeId = spec.shape_id ?? nextAvailableShapeId(presentation, slideId);
  const shape: Shape = {
    kind: 'chart',
    shape_id: shapeId,
    name: spec.name ?? `Chart ${String(shapeId)}`,
    transform: spec.transform,
    chart: spec.chart,
  };
  return { presentation: addShape(presentation, slideId, shape), shape_id: shapeId };
}

/** 取某页上的图表形状（不是图表 ⇒ 报错）。 */
export function requireChart(presentation: Presentation, slideId: number, shapeId: number): Extract<Shape, { kind: 'chart' }> {
  const slide = presentation.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PresentationChartError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  const collect: Shape[] = [];
  const visit = (shapes: readonly Shape[]): void => {
    for (const shape of shapes) {
      collect.push(shape);
      if (shape.kind === 'group') visit(shape.children);
    }
  };
  visit(slide.shapes);
  const found = collect.find((shape) => shape.shape_id === shapeId);
  if (found === undefined) {
    throw new PresentationChartError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  if (found.kind !== 'chart') {
    throw new PresentationChartError('not_a_chart', `对象 shape_id=${String(shapeId)} 是 ${found.kind}，不是图表`);
  }
  return found;
}

function updateChart(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  update: (chart: ChartModel) => ChartModel,
): Presentation {
  const slide = presentation.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PresentationChartError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  requireChart(presentation, slideId, shapeId);
  const walk = (shapes: readonly Shape[]): readonly Shape[] =>
    shapes.map((shape) => {
      if (shape.shape_id === shapeId && shape.kind === 'chart') {
        const next = update(shape.chart);
        validateChart(next);
        return { ...shape, chart: next };
      }
      if (shape.kind === 'group') {
        return { ...shape, children: walk(shape.children) };
      }
      return shape;
    });
  const shapes = walk(slide.shapes);
  return {
    ...presentation,
    slides: presentation.slides.map((current) =>
      current.slide_id === slideId ? { ...current, shapes } : current,
    ),
  };
}

/** 改图表数据（PPT-09「改数据」）。类别与所有系列的值必须等长。 */
export function setChartData(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  data: { readonly categories: readonly string[]; readonly series: readonly ChartSeries[] },
): Presentation {
  return updateChart(presentation, slideId, shapeId, (chart) => ({
    ...chart,
    categories: [...data.categories],
    series: data.series.map((series) => ({ name: series.name, values: [...series.values] })),
  }));
}

/** 改图表标题（`null` = 去掉标题）。 */
export function setChartTitle(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  title: string | null,
): Presentation {
  return updateChart(presentation, slideId, shapeId, (chart) => ({ ...chart, title }));
}

/** 改图表类型（柱 / 折线 / 饼）。 */
export function setChartType(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  chartType: ChartModel['chart_type'],
): Presentation {
  return updateChart(presentation, slideId, shapeId, (chart) => ({ ...chart, chart_type: chartType }));
}

/** 删除图表（PPT-09「删除」）。 */
export function deleteChart(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  requireChart(presentation, slideId, shapeId);
  return removeShape(presentation, slideId, shapeId);
}

// ---------------------------------------------------------------------------
// 图表 XML 与嵌入工作簿
// ---------------------------------------------------------------------------

/** 数字渲染：最短可往返十进制（`Number::toString`，非本地化、确定性）。 */
function chartNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PresentationChartError('invalid_chart_number', `图表数值必须有限，收到 ${String(value)}`);
  }
  return String(value);
}

/** 0 → A，1 → B，…（仅用于嵌入工作簿的单元格地址）。 */
export function columnLetter(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new PresentationChartError('invalid_column_index', `列下标非法：${String(index)}`);
  }
  let remaining = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

function seriesNameCell(seriesIndex: number): string {
  return `${columnLetter(seriesIndex + 1)}1`;
}

function categoryCell(rowIndex: number): string {
  return `A${String(rowIndex + 2)}`;
}

function valueCell(seriesIndex: number, rowIndex: number): string {
  return `${columnLetter(seriesIndex + 1)}${String(rowIndex + 2)}`;
}

function textCache(points: readonly string[]): XmlElement {
  return el('c:strCache', [], [
    el('c:ptCount', [attr('val', String(points.length))]),
    ...points.map((point, index) => el('c:pt', [attr('idx', String(index))], [el('c:v', [], [point])])),
  ]);
}

function numberCache(values: readonly number[]): XmlElement {
  return el('c:numCache', [], [
    el('c:formatCode', [], ['General']),
    el('c:ptCount', [attr('val', String(values.length))]),
    ...values.map((value, index) =>
      el('c:pt', [attr('idx', String(index))], [el('c:v', [], [chartNumber(value)])]),
    ),
  ]);
}

/** 系列名（`c:tx`）——引用嵌入工作簿里写名字的那一格。 */
function seriesTextXml(series: ChartSeries, seriesIndex: number): XmlElement {
  return el('c:tx', [], [
    el('c:strRef', [], [
      el('c:f', [], [`${SHEET_NAME}!$${columnLetter(seriesIndex + 1)}$1`]),
      textCache([series.name]),
    ]),
  ]);
}

function seriesXml(series: ChartSeries, seriesIndex: number, categories: readonly string[]): XmlElement {
  const rows = categories.length;
  const lastRow = rows + 1;
  const column = columnLetter(seriesIndex + 1);
  const categoryRef = `$A$2:$A$${String(lastRow)}`;
  return el('c:ser', [], [
    el('c:idx', [attr('val', String(seriesIndex))]),
    el('c:order', [attr('val', String(seriesIndex))]),
    seriesTextXml(series, seriesIndex),
    el('c:cat', [], [
      el('c:strRef', [], [
        el('c:f', [], [`${SHEET_NAME}!${categoryRef}`]),
        textCache(categories),
      ]),
    ]),
    el('c:val', [], [
      el('c:numRef', [], [
        el('c:f', [], [`${SHEET_NAME}!$${column}$2:$${column}$${String(lastRow)}`]),
        numberCache(series.values),
      ]),
    ]),
  ]);
}

function titleXml(text: string): XmlElement {
  return el('c:title', [], [
    el('c:tx', [], [
      el('c:rich', [], [
        el('a:bodyPr'),
        el('a:lstStyle'),
        el('a:p', [], [
          el('a:r', [], [el('a:rPr', [attr('lang', 'zh-CN')]), el('a:t', [], [text])]),
        ]),
      ]),
    ]),
    el('c:overlay', [attr('val', '0')]),
  ]);
}

function dataLabelsXml(show: boolean): XmlElement {
  return el('c:dLbls', [], [
    el('c:showLegendKey', [attr('val', '0')]),
    el('c:showVal', [attr('val', show ? '1' : '0')]),
    el('c:showCatName', [attr('val', '0')]),
    el('c:showSerName', [attr('val', '0')]),
    el('c:showPercent', [attr('val', '0')]),
  ]);
}

/** 绘图区（按类型分支）。饼图**不**带坐标轴（与 DrawingML 一致）。 */
function plotAreaXml(chart: ChartModel, options: ChartOptions): XmlElement {
  const series = chart.series.map((item, index) => seriesXml(item, index, chart.categories));
  if (chart.chart_type === 'bar') {
    return el('c:plotArea', [], [
      el('c:layout'),
      el('c:barChart', [], [
        el('c:barDir', [attr('val', 'col')]),
        el('c:grouping', [attr('val', 'clustered')]),
        el('c:varyColors', [attr('val', '0')]),
        ...series,
        dataLabelsXml(options.data_labels),
        el('c:gapWidth', [attr('val', '150')]),
        el('c:axId', [attr('val', String(CATEGORY_AXIS_ID))]),
        el('c:axId', [attr('val', String(VALUE_AXIS_ID))]),
      ]),
      categoryAxisXml(options),
      valueAxisXml(options),
    ]);
  }
  if (chart.chart_type === 'line') {
    return el('c:plotArea', [], [
      el('c:layout'),
      el('c:lineChart', [], [
        el('c:grouping', [attr('val', 'standard')]),
        el('c:varyColors', [attr('val', '0')]),
        ...series,
        dataLabelsXml(options.data_labels),
        el('c:marker', [attr('val', '1')]),
        el('c:axId', [attr('val', String(CATEGORY_AXIS_ID))]),
        el('c:axId', [attr('val', String(VALUE_AXIS_ID))]),
      ]),
      categoryAxisXml(options),
      valueAxisXml(options),
    ]);
  }
  return el('c:plotArea', [], [
    el('c:layout'),
    el('c:pieChart', [], [
      el('c:varyColors', [attr('val', '1')]),
      ...series,
      dataLabelsXml(options.data_labels),
      el('c:firstSliceAng', [attr('val', '0')]),
    ]),
  ]);
}

function axisTitleXml(text: string): XmlElement {
  return titleXml(text);
}

function categoryAxisXml(options: ChartOptions): XmlElement {
  return el('c:catAx', [], [
    el('c:axId', [attr('val', String(CATEGORY_AXIS_ID))]),
    el('c:scaling', [], [el('c:orientation', [attr('val', 'minMax')])]),
    el('c:delete', [attr('val', '0')]),
    el('c:axPos', [attr('val', 'b')]),
    ...(options.category_axis_title === null ? [] : [axisTitleXml(options.category_axis_title)]),
    el('c:crossAx', [attr('val', String(VALUE_AXIS_ID))]),
  ]);
}

function valueAxisXml(options: ChartOptions): XmlElement {
  return el('c:valAx', [], [
    el('c:axId', [attr('val', String(VALUE_AXIS_ID))]),
    el('c:scaling', [], [el('c:orientation', [attr('val', 'minMax')])]),
    el('c:delete', [attr('val', '0')]),
    el('c:axPos', [attr('val', 'l')]),
    el('c:majorGridlines'),
    ...(options.value_axis_title === null ? [] : [axisTitleXml(options.value_axis_title)]),
    el('c:crossAx', [attr('val', String(CATEGORY_AXIS_ID))]),
  ]);
}

/**
 * 渲染图表部件 XML（PPT-09）。
 *
 * `externalRelId` 是该图表部件 `_rels` 里指向嵌入工作簿的关系 id；本函数**只写引用**，
 * 关系本身由 `buildChartParts` 声明（成对由 `verifyChartPackage` 读回校验）。
 */
export function renderChartPartXml(
  chart: ChartModel,
  options: ChartOptions = DEFAULT_CHART_OPTIONS,
  externalRelId: string = relationshipIdAt(0),
): string {
  validateChart(chart);
  return serializeXmlDocument(
    el('c:chartSpace', [attr('xmlns:c', NS_C), attr('xmlns:a', NS_A), attr('xmlns:r', NS_R)], [
      ...(options.style_id === null ? [] : [el('c:style', [attr('val', String(options.style_id))])]),
      el('c:chart', [], [
        ...(chart.title === null ? [] : [titleXml(chart.title)]),
        el('c:autoTitleDeleted', [attr('val', chart.title === null ? '1' : '0')]),
        plotAreaXml(chart, options),
        ...(options.legend === 'none'
          ? []
          : [
              el('c:legend', [], [
                el('c:legendPos', [attr('val', options.legend === 'right' ? 'r' : options.legend === 'bottom' ? 'b' : options.legend === 'top' ? 't' : 'l')]),
                el('c:overlay', [attr('val', '0')]),
              ]),
            ]),
        el('c:plotVisOnly', [attr('val', '1')]),
        el('c:dispBlanksAs', [attr('val', 'gap')]),
      ]),
      el('c:externalData', [attr('r:id', externalRelId)], [el('c:autoUpdate', [attr('val', '0')])]),
    ]),
  );
}

/**
 * 渲染**嵌入工作簿**（真 XLSX 字节，PPT-09「数据可编辑」的落点）。
 *
 * 版面（与 PowerPoint 的默认布局一致，图表里的 `c:f` 引用的就是这些格子）：
 * - 第 1 行：`B1`, `C1`, … = 各系列名；
 * - 第 2..n+1 行：`A` 列 = 类别，`B`, `C`, … = 各系列的值。
 */
export function renderEmbeddedWorkbookBytes(chart: ChartModel): Uint8Array {
  validateChart(chart);
  const rows: XmlElement[] = [];

  const headerCells: XmlElement[] = chart.series.map((series, index) =>
    el('c', [attr('r', seriesNameCell(index)), attr('t', 'inlineStr')], [
      el('is', [], [el('t', [], [series.name])]),
    ]),
  );
  rows.push(el('row', [attr('r', '1')], headerCells));

  chart.categories.forEach((category, rowIndex) => {
    const cells: XmlElement[] = [
      el('c', [attr('r', categoryCell(rowIndex)), attr('t', 'inlineStr')], [
        el('is', [], [el('t', [], [category])]),
      ]),
      ...chart.series.map((series, seriesIndex) =>
        el('c', [attr('r', valueCell(seriesIndex, rowIndex))], [
          el('v', [], [chartNumber(series.values[rowIndex] ?? 0)]),
        ]),
      ),
    ];
    rows.push(el('row', [attr('r', String(rowIndex + 2))], cells));
  });

  const sheetXml = serializeXmlDocument(
    el(
      'worksheet',
      [attr('xmlns', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')],
      [el('sheetData', [], rows)],
    ),
  );
  const workbookXml = serializeXmlDocument(
    el(
      'workbook',
      [
        attr('xmlns', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'),
        attr('xmlns:r', NS_R),
      ],
      [el('sheets', [], [el('sheet', [attr('name', SHEET_NAME), attr('sheetId', '1'), attr('r:id', relationshipIdAt(0))])])],
    ),
  );

  const defaults: ContentTypeDefault[] = [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }];
  const assembled = assembleOpcPackage({
    parts: [
      { path: 'xl/workbook.xml', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', data: workbookXml },
      { path: 'xl/worksheets/sheet1.xml', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml', data: sheetXml },
    ],
    content_type_defaults: defaults,
    relationships: [
      { owner_part_path: null, declarations: [{ type: REL_OFFICE_DOCUMENT, target: 'xl/workbook.xml' }] satisfies RelationshipDeclaration[] },
      {
        owner_part_path: 'xl/workbook.xml',
        declarations: [
          { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', target: 'worksheets/sheet1.xml' },
        ] satisfies RelationshipDeclaration[],
      },
    ],
  });
  return writeZip(assembled.entries);
}

// ---------------------------------------------------------------------------
// 部件装配（图表部件 + 嵌入工作簿 + 关系）
// ---------------------------------------------------------------------------

/** 图表部件的装配结果（部件 + 该图表部件自己的关系声明）。 */
export interface ChartParts {
  readonly parts: readonly OpcPart[];
  /** 图表部件 `_rels` 的声明（**顺序即 rId**：第 0 条 = `rId1` = `c:externalData` 指向的目标）。 */
  readonly chart_relationships: readonly RelationshipDeclaration[];
  readonly chart_path: string;
  readonly workbook_path: string;
  readonly external_rel_id: string;
  readonly chart_xml: string;
  readonly workbook_bytes: Uint8Array;
}

/** 装配图表部件 + 嵌入工作簿（不含幻灯片；幻灯片侧的接线见 `slideChartGraphicFrameXml`）。 */
export function buildChartParts(
  chart: ChartModel,
  options: ChartOptions = DEFAULT_CHART_OPTIONS,
  paths?: { readonly chart_path?: string; readonly workbook_path?: string },
): ChartParts {
  const chartPath = paths?.chart_path ?? CHART_PATH;
  const workbookPath = paths?.workbook_path ?? EMBEDDED_WORKBOOK_PATH;
  const externalRelId = relationshipIdAt(0);
  return Object.freeze({
    parts: Object.freeze([
      { path: chartPath, content_type: CT_CHART, data: renderChartPartXml(chart, options, externalRelId) },
      { path: workbookPath, content_type: CT_EMBEDDED_XLSX, data: renderEmbeddedWorkbookBytes(chart) },
    ] satisfies OpcPart[]),
    chart_relationships: Object.freeze([
      { type: REL_PACKAGE, target: `../embeddings/${workbookPath.slice(workbookPath.lastIndexOf('/') + 1)}` },
    ] satisfies RelationshipDeclaration[]),
    chart_path: chartPath,
    workbook_path: workbookPath,
    external_rel_id: externalRelId,
    chart_xml: renderChartPartXml(chart, options, externalRelId),
    workbook_bytes: renderEmbeddedWorkbookBytes(chart),
  });
}

/** 幻灯片侧接线：图表所在的 `p:graphicFrame` 片段（`r:id` = 该页 `_rels` 里指向图表部件的关系）。 */
export function slideChartGraphicFrameXml(
  shape: Extract<Shape, { kind: 'chart' }>,
  chartRelId: string,
): string {
  const t = shape.transform;
  return serializeXmlDocument(
    el('p:graphicFrame', [attr('xmlns:a', NS_A), attr('xmlns:c', NS_C), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:nvGraphicFramePr', [], [
        el('p:cNvPr', [attr('id', String(shape.shape_id)), attr('name', shape.name)]),
        el('p:cNvGraphicFramePr'),
        el('p:nvPr'),
      ]),
      el('p:xfrm', [], [
        el('a:off', [attr('x', String(t.x_emu)), attr('y', String(t.y_emu))]),
        el('a:ext', [attr('cx', String(t.cx_emu)), attr('cy', String(t.cy_emu))]),
      ]),
      el('a:graphic', [], [
        el('a:graphicData', [attr('uri', 'http://schemas.openxmlformats.org/drawingml/2006/chart')], [
          el('c:chart', [attr('r:id', chartRelId)]),
        ]),
      ]),
    ]),
  );
}

/** 幻灯片侧接线：该页 `_rels` 里指向图表部件的关系声明。 */
export function chartSlideRelationship(chartPath: string = CHART_PATH): RelationshipDeclaration {
  return { type: REL_CHART, target: `../charts/${chartPath.slice(chartPath.lastIndexOf('/') + 1)}` };
}

function chartSlideXml(frameXml: string): string {
  return (
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    frameXml +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

/**
 * 组装**图表部件容器**：`slide → chart → embedded workbook` 的部件图（+ 真 ZIP 字节）。
 *
 * ⚠️ 它**不是**完整 PPTX（没有母版 / 版式 / `presentation.xml`）；用途是：
 * ① 让"图表 XML ↔ 嵌入工作表"能被**读回**校验；② 给接线方一份可复制的部件图。
 */
export function buildChartContainer(
  chart: ChartModel,
  options: ChartOptions = DEFAULT_CHART_OPTIONS,
): { readonly bytes: Buffer; readonly chart_path: string; readonly workbook_path: string; readonly chart_xml: string; readonly workbook_bytes: Uint8Array } {
  const built = buildChartParts(chart, options);
  const slideFrame = slideChartGraphicFrameXml(
    {
      kind: 'chart',
      shape_id: 2,
      name: 'Chart 2',
      transform: { x_emu: 838200, y_emu: 457200, cx_emu: 6096000, cy_emu: 4064000, rotation_deg: 0, flip_h: false, flip_v: false },
      chart,
    },
    relationshipIdAt(0),
  );
  const assembled = assembleOpcPackage({
    parts: [
      { path: CHART_SLIDE_PATH, content_type: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml', data: chartSlideXml(slideFrame) },
      ...built.parts,
    ],
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships: [
      { owner_part_path: null, declarations: [{ type: REL_OFFICE_DOCUMENT, target: CHART_SLIDE_PATH }] satisfies RelationshipDeclaration[] },
      { owner_part_path: CHART_SLIDE_PATH, declarations: [chartSlideRelationship(built.chart_path)] satisfies RelationshipDeclaration[] },
      { owner_part_path: built.chart_path, declarations: [...built.chart_relationships] satisfies RelationshipDeclaration[] },
    ],
  });
  return {
    bytes: writeZip(assembled.entries),
    chart_path: built.chart_path,
    workbook_path: built.workbook_path,
    chart_xml: built.chart_xml,
    workbook_bytes: built.workbook_bytes,
  };
}

// ---------------------------------------------------------------------------
// 读回校验：成对 + 同步
// ---------------------------------------------------------------------------

function textOfEntry(entry: { readonly data: Uint8Array }): string {
  return Buffer.from(entry.data).toString('utf8');
}

function relsPartPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : partPath.slice(0, slash);
  const base = partPath.slice(slash + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

function resolveRelativeTarget(ownerPartPath: string, target: string): string {
  const slash = ownerPartPath.lastIndexOf('/');
  const base = target.startsWith('/') ? '' : `${slash < 0 ? '' : ownerPartPath.slice(0, slash + 1)}`;
  const combined = `${base}${target.replace(/^\/+/, '')}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function collect(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) collect(child, name, out);
  return out;
}

/** 图表数据同步报告（供用例直接断言）。 */
export interface ChartSyncReport {
  readonly chart_path: string;
  readonly workbook_path: string;
  readonly categories: number;
  readonly series: number;
}

/**
 * **成对 + 同步**校验（PPT-09 的落点）。
 *
 * 1. `c:externalData@r:id` 必须在该图表部件的 `_rels` 里有声明（否则 `chart_part_unpaired`）；
 * 2. 该关系必须指向包内**真实存在**的嵌入工作簿部件（否则 `chart_part_unpaired`）；
 * 3. 图表缓存（`c:strCache`/`c:numCache`）与嵌入工作表 `sheet1.xml` 的单元格**逐点相等**
 *    （类别按串、数值按数；系列名对第 1 行）——否则 `chart_data_desync`。
 */
export function verifyChartPackage(bytes: Uint8Array): ChartSyncReport {
  const archive = readZip(bytes);
  const chartParts = archive.entries.map((entry) => entry.path).filter((path) => /charts\/chart[0-9]+\.xml$/.test(path));
  if (chartParts.length === 0) {
    throw new PresentationChartError('chart_part_unpaired', '包内没有图表部件');
  }
  const chartPath = chartParts[0] as string;
  const chartEntry = archive.by_path.get(chartPath);
  if (chartEntry === undefined) {
    throw new PresentationChartError('chart_part_unpaired', `包内找不到图表部件 ${chartPath}`);
  }
  const chartRoot = parseXmlDocument(textOfEntry(chartEntry));

  // ① 图表部件的关系（rId → 目标路径）。
  const targets = new Map<string, string>();
  const relsEntry = archive.by_path.get(relsPartPathOf(chartPath));
  if (relsEntry !== undefined) {
    const relsRoot = parseXmlDocument(textOfEntry(relsEntry));
    for (const relationship of collect(relsRoot, 'Relationship')) {
      const id = attributeOf(relationship, 'Id');
      const target = attributeOf(relationship, 'Target');
      if (id !== undefined && target !== undefined) {
        targets.set(id, resolveRelativeTarget(chartPath, target));
      }
    }
  }

  const externalData = collect(chartRoot, 'c:externalData')[0];
  const relId = attributeOf(externalData, 'r:id');
  if (relId === undefined) {
    throw new PresentationChartError(
      'chart_part_unpaired',
      `${chartPath} 没有 c:externalData@r:id —— 图表没有指向嵌入数据（"数据可编辑"落空）`,
    );
  }
  const workbookPath = targets.get(relId);
  if (workbookPath === undefined) {
    throw new PresentationChartError(
      'chart_part_unpaired',
      `${chartPath} 的 ${relId} 在自身 _rels 里没有声明（有 rId 没工作簿）`,
    );
  }
  const workbookEntry = archive.by_path.get(workbookPath);
  if (workbookEntry === undefined) {
    throw new PresentationChartError(
      'chart_part_unpaired',
      `${chartPath} 的 ${relId} 指向 ${workbookPath}，但包内没有这份部件（有关系没部件）`,
    );
  }

  // ③ 逐点比对图表缓存与嵌入工作表。
  const sheet = readEmbeddedSheet(workbookEntry.data);
  const report = compareChartToWorkbook(chartRoot, sheet);

  return Object.freeze({
    chart_path: chartPath,
    workbook_path: workbookPath,
    categories: report.categories,
    series: report.series,
  });
}

/** 嵌入工作表的值网格：`row0` = 系列名（B1 起），`row1..` = [类别, 值…]。 */
interface EmbeddedSheet {
  readonly series_names: readonly string[];
  readonly categories: readonly string[];
  readonly values: readonly (readonly number[])[];
}

function readEmbeddedSheet(bytes: Uint8Array): EmbeddedSheet {
  const inner = readZip(bytes);
  const sheetEntry = inner.by_path.get('xl/worksheets/sheet1.xml');
  if (sheetEntry === undefined) {
    throw new PresentationChartError('chart_data_desync', '嵌入工作簿里没有 xl/worksheets/sheet1.xml');
  }
  const root = parseXmlDocument(textOfEntry(sheetEntry));
  const rows = collect(root, 'row');
  const cellValue = (cell: XmlElementNode): string => {
    const inline = collect(cell, 't')[0];
    if (inline !== undefined) {
      return inline.children.map((child) => (child.kind === 'text' ? child.text : '')).join('');
    }
    const v = collect(cell, 'v')[0];
    return v === undefined ? '' : v.children.map((child) => (child.kind === 'text' ? child.text : '')).join('');
  };
  const grid = rows.map((row) => new Map(collect(row, 'c').map((cell) => [attributeOf(cell, 'r') ?? '', cellValue(cell)])));
  const headerRow = grid[0] ?? new Map<string, string>();
  const seriesNames: string[] = [];
  for (let index = 0; ; index += 1) {
    const name = headerRow.get(`${columnLetter(index + 1)}1`);
    if (name === undefined) break;
    seriesNames.push(name);
  }
  const dataRows = grid.slice(1);
  const categories = dataRows.map((row, index) => row.get(categoryCell(index)) ?? '');
  const values: number[][] = [];
  for (let seriesIndex = 0; seriesIndex < seriesNames.length; seriesIndex += 1) {
    values.push(dataRows.map((row, rowIndex) => Number(row.get(valueCell(seriesIndex, rowIndex)) ?? 'NaN')));
  }
  return { series_names: seriesNames, categories, values };
}

function compareChartToWorkbook(chartRoot: XmlElementNode, sheet: EmbeddedSheet): { categories: number; series: number } {
  const seriesNodes = collect(chartRoot, 'c:ser');
  if (seriesNodes.length !== sheet.series_names.length) {
    throw new PresentationChartError(
      'chart_data_desync',
      `图表有 ${String(seriesNodes.length)} 个系列，嵌入工作表里有 ${String(sheet.series_names.length)} 列数据`,
    );
  }
  let categoryCount = -1;
  seriesNodes.forEach((seriesNode, seriesIndex) => {
    const name = collect(seriesNode, 'c:tx')[0];
    const cachedName = collect(name ?? seriesNode, 'c:v')[0];
    const cachedNameText = cachedName?.children.map((child) => (child.kind === 'text' ? child.text : '')).join('') ?? '';
    const sheetName = sheet.series_names[seriesIndex] ?? '';
    if (cachedNameText !== sheetName) {
      throw new PresentationChartError(
        'chart_data_desync',
        `第 ${String(seriesIndex)} 个系列名不一致：图表 ${JSON.stringify(cachedNameText)}，工作表 ${JSON.stringify(sheetName)}`,
      );
    }

    const catCache = collect(collect(seriesNode, 'c:cat')[0] ?? seriesNode, 'c:v').map((node) =>
      node.children.map((child) => (child.kind === 'text' ? child.text : '')).join(''),
    );
    if (categoryCount < 0) {
      categoryCount = catCache.length;
    }
    if (catCache.length !== sheet.categories.length) {
      throw new PresentationChartError(
        'chart_data_desync',
        `类别个数不一致：图表缓存 ${String(catCache.length)}，工作表 ${String(sheet.categories.length)}`,
      );
    }
    catCache.forEach((value, index) => {
      if (value !== sheet.categories[index]) {
        throw new PresentationChartError(
          'chart_data_desync',
          `第 ${String(index)} 个类别不一致：图表 ${JSON.stringify(value)}，工作表 ${JSON.stringify(sheet.categories[index] ?? '')}`,
        );
      }
    });

    const valCache = collect(collect(seriesNode, 'c:val')[0] ?? seriesNode, 'c:v').map((node) =>
      node.children.map((child) => (child.kind === 'text' ? child.text : '')).join(''),
    );
    const sheetValues = sheet.values[seriesIndex] ?? [];
    if (valCache.length !== sheetValues.length) {
      throw new PresentationChartError(
        'chart_data_desync',
        `第 ${String(seriesIndex)} 个系列的点数不一致：图表 ${String(valCache.length)}，工作表 ${String(sheetValues.length)}`,
      );
    }
    valCache.forEach((value, index) => {
      const chartValue = Number(value);
      const sheetValue = sheetValues[index];
      if (!Number.isFinite(chartValue) || chartValue !== sheetValue) {
        throw new PresentationChartError(
          'chart_data_desync',
          `第 ${String(seriesIndex)} 个系列第 ${String(index)} 点不一致：图表 ${value}，工作表 ${String(sheetValue)}`,
        );
      }
    });
  });
  return { categories: categoryCount < 0 ? sheet.categories.length : categoryCount, series: seriesNodes.length };
}

/** 图表数据网格（第一行 = 类别表头 + 各系列名；其后每行 = 类别 + 各系列值）。供用例断言来源一致。 */
export function chartDataGrid(chart: ChartModel): readonly (readonly string[])[] {
  const header = ['类别', ...chart.series.map((series) => series.name)];
  const rows = chart.categories.map((category, rowIndex) => [
    category,
    ...chart.series.map((series) => chartNumber(series.values[rowIndex] ?? Number.NaN)),
  ]);
  return [header, ...rows].map((row) => Object.freeze(row));
}

/** 便捷入口：造一个图表形状（不放进文稿，供拼接 / 复用）。 */
export function chartShape(
  shapeId: number,
  chart: ChartModel,
  options?: {
    readonly name?: string;
    readonly transform?: Transform;
  },
): Extract<Shape, { kind: 'chart' }> {
  validateChart(chart);
  return Object.freeze({
    kind: 'chart' as const,
    shape_id: shapeId,
    name: options?.name ?? `Chart ${String(shapeId)}`,
    transform:
      options?.transform ?? { x_emu: 838200, y_emu: 457200, cx_emu: 6096000, cy_emu: 4064000, rotation_deg: 0, flip_h: false, flip_v: false },
    chart,
  });
}

// ---------------------------------------------------------------------------
// P-I17 · 真实部件写盘 + 字节读回（数据编辑 → 图与工作簿同版落在**真字节**上）
// ---------------------------------------------------------------------------
//
// P06 的 `data-edit.ts` 只产出**描述符**（图引用 / 工作簿格 / 表字面量 / 指纹），刻意不在
// 运行期接 `charts.ts`；P-I08 补了表侧指纹。本段把这条链**落到真实字节**：由一份 P06 快照
// 装配「图表部件 + 嵌入工作簿 + 幻灯片」的真 ZIP，装配后**读回**校验
// （`verifyChartPackage` + 逐格解码 + 重算指纹），使"改数据 ⇒ 图与工作簿一起变到同一版"
// 在**真字节**上成立，而不是只在描述符对象里成立。
//
// 与 P06 的分工：数据编辑语义（改哪个点 / 合并引用迁移）仍在 `table-chart-parts`；
// 本段只做 **快照 → ChartModel → 真 ZIP → 读回** 的落盘与读数，不复制任何编辑 / 指纹算法。

/** 真实字节层面的图表读数结果（供用例直接断言）。 */
export interface ChartPackageResult {
  /** 装配出的完整图表容器 ZIP 字节（slide + chart + embedded xlsx）。 */
  readonly bytes: Buffer;
  readonly chart_path: string;
  readonly workbook_path: string;
  readonly chart_xml: string;
  readonly workbook_bytes: Uint8Array;
  /** 从**图表部件缓存**（`c:numRef/c:numCache`）独立读回的数据。 */
  readonly chart_data: ExpectedChartData;
  /** 从**嵌入工作簿字节**（真 XLSX）独立读回的数据。 */
  readonly workbook_data: ExpectedChartData;
  /** 真实字节里解码出的 `dc1-*` 指纹（由 `workbook_data` 复算，与 P06 同算法）。 */
  readonly version: string;
  readonly report: ChartSyncReport;
}

/** 装配图表包时的外观选项（图表类型 / 标题 / 图例等；数据来自快照，不在此处）。 */
export interface ChartPackageBuildOptions {
  readonly chart_type?: ChartModel['chart_type'];
  readonly title?: string | null;
  readonly chart_options?: ChartOptions;
}

/** 把图表模型的数据部分投影成 P06 同版层的数据形态（纯投影，不复制算法）。 */
export function chartDataOf(chart: ChartModel): ExpectedChartData {
  validateChart(chart);
  return {
    categories: [...chart.categories],
    series: chart.series.map((series) => ({ name: series.name, values: [...series.values] })),
  };
}

function chartDataEquals(left: ExpectedChartData, right: ExpectedChartData): boolean {
  if (left.categories.length !== right.categories.length || left.series.length !== right.series.length) return false;
  for (let index = 0; index < left.categories.length; index += 1) {
    if (left.categories[index] !== right.categories[index]) return false;
  }
  for (let seriesIndex = 0; seriesIndex < left.series.length; seriesIndex += 1) {
    const leftSeries = left.series[seriesIndex];
    const rightSeries = right.series[seriesIndex];
    if (leftSeries === undefined || rightSeries === undefined) return false;
    if (leftSeries.name !== rightSeries.name || leftSeries.values.length !== rightSeries.values.length) return false;
    for (let point = 0; point < leftSeries.values.length; point += 1) {
      if (leftSeries.values[point] !== rightSeries.values[point]) return false;
    }
  }
  return true;
}

function textValuesUnder(node: XmlElementNode): string[] {
  return collect(node, 'c:v').map((value) =>
    value.children.map((child) => (child.kind === 'text' ? child.text : '')).join(''),
  );
}

/**
 * 从**图表部件 XML**（真字节）独立读回缓存点：`c:tx` 系列名、`c:cat` 类别缓存、
 * `c:val` 数值缓存。缺缓存 / 系列间类别不一致 ⇒ 具名报错（不静默补空）。
 */
export function readChartPartData(bytes: Uint8Array): ExpectedChartData {
  const archive = readZip(bytes);
  const chartPath = archive.entries
    .map((entry) => entry.path)
    .find((path) => /charts\/chart[0-9]+\.xml$/.test(path));
  if (chartPath === undefined) {
    throw new PresentationChartError('chart_part_unpaired', '包内没有图表部件');
  }
  const entry = archive.by_path.get(chartPath);
  if (entry === undefined) {
    throw new PresentationChartError('chart_part_unpaired', `包内找不到图表部件 ${chartPath}`);
  }
  const root = parseXmlDocument(textOfEntry(entry));
  const seriesNodes = collect(root, 'c:ser');
  if (seriesNodes.length === 0) {
    throw new PresentationChartError('chart_data_desync', `${chartPath} 里没有任何 c:ser`);
  }

  let categories: string[] | null = null;
  const series: { name: string; values: number[] }[] = [];
  seriesNodes.forEach((seriesNode, index) => {
    const txNode = collect(seriesNode, 'c:tx')[0];
    const catNode = collect(seriesNode, 'c:cat')[0];
    const valNode = collect(seriesNode, 'c:val')[0];
    if (catNode === undefined || valNode === undefined) {
      throw new PresentationChartError('chart_data_desync', `${chartPath} 第 ${String(index)} 个系列缺 c:cat / c:val 缓存`);
    }
    const name = txNode === undefined ? '' : (textValuesUnder(txNode)[0] ?? '');
    const cats = textValuesUnder(catNode);
    if (categories === null) {
      categories = cats;
    } else if (cats.length !== categories.length || cats.some((value, point) => value !== categories?.[point])) {
      throw new PresentationChartError('chart_data_desync', `${chartPath} 各系列的类别缓存不一致`);
    }
    const values = textValuesUnder(valNode).map((raw) => Number(raw));
    if (values.some((value) => !Number.isFinite(value))) {
      throw new PresentationChartError('chart_data_desync', `${chartPath} 第 ${String(index)} 个系列有非有限数缓存`);
    }
    series.push({ name, values });
  });

  return { categories: categories ?? [], series };
}

/**
 * 从**嵌入工作簿字节**（真 XLSX）独立读回图表数据。
 * 与写入路径无关：改坏工作簿后这里的读数也随之改变（反向对照的判据）。
 */
export function readEmbeddedWorkbookData(bytes: Uint8Array): ExpectedChartData {
  const sheet = readEmbeddedSheet(bytes);
  return {
    categories: sheet.categories,
    series: sheet.series_names.map((name, index) => ({ name, values: [...(sheet.values[index] ?? [])] })),
  };
}

/**
 * 装配**真实字节**的图表包并读回校验：`ChartModel → 真 ZIP → verifyChartPackage + 逐字节解码`。
 *
 * 自校验三件事，任一不成立 ⇒ 具名报错（不返回半个结果）：
 * 1. `verifyChartPackage`：`c:externalData` 成对 + 图表缓存与工作簿逐点相等；
 * 2. 从**图表部件缓存**与从**工作簿字节**各自解码出的数据必须相同（两份部件同源）；
 * 3. 解码数据必须与输入模型逐点相等（写入没丢点）。
 */
export function renderChartPackage(
  chart: ChartModel,
  chartOptions: ChartOptions = DEFAULT_CHART_OPTIONS,
): ChartPackageResult {
  validateChart(chart);
  const container = buildChartContainer(chart, chartOptions);
  const report = verifyChartPackage(container.bytes);
  const workbookData = readEmbeddedWorkbookData(container.workbook_bytes);
  const chartData = readChartPartData(container.bytes);
  const version = dataVersionOf(workbookData);
  const chartVersion = dataVersionOf(chartData);
  if (chartVersion !== version) {
    throw new PresentationChartError(
      'chart_version_mismatch',
      `图表部件指纹 ${chartVersion} 与嵌入工作簿指纹 ${version} 不一致（两份部件不同版）`,
    );
  }
  if (!chartDataEquals(chartData, workbookData)) {
    throw new PresentationChartError('chart_data_desync', '图表缓存解码出的数据与嵌入工作簿不一致');
  }
  if (!chartDataEquals(workbookData, chartDataOf(chart))) {
    throw new PresentationChartError('chart_data_desync', '真字节解码出的数据与图表模型不一致');
  }
  return Object.freeze({
    bytes: container.bytes,
    chart_path: container.chart_path,
    workbook_path: container.workbook_path,
    chart_xml: container.chart_xml,
    workbook_bytes: container.workbook_bytes,
    chart_data: chartData,
    workbook_data: workbookData,
    version,
    report,
  });
}

/** 由**一份数据**（P06 形态）装配真字节图表包；外观（类型 / 标题 / 选项）由此处给定。 */
export function renderChartPackageFromData(
  data: ExpectedChartData,
  options: ChartPackageBuildOptions = {},
): ChartPackageResult {
  const chart: ChartModel = {
    chart_type: options.chart_type ?? 'bar',
    categories: [...data.categories],
    series: data.series.map((series) => ({ name: series.name, values: [...series.values] })),
    title: options.title === undefined ? null : options.title,
  };
  return renderChartPackage(chart, options.chart_options ?? DEFAULT_CHART_OPTIONS);
}

/**
 * 由一份 P06 快照装配真字节图表包，并强制**真实字节里的指纹**等于 `snapshot.version`。
 *
 * 这就是"版本不变式落在真字节上"：装配后从字节解码出数据、复算指纹，与快照的
 * `dc1-*` 版本逐字相等；不等（如快照被改旧 / 数据被篡改）⇒ `chart_version_mismatch`。
 */
export function renderChartPackageFromSnapshot(
  snapshot: ChartDataSnapshot,
  options: ChartPackageBuildOptions = {},
): ChartPackageResult {
  const result = renderChartPackageFromData(snapshot.data, options);
  if (result.version !== snapshot.version) {
    throw new PresentationChartError(
      'chart_version_mismatch',
      `真实字节的指纹 ${result.version} 与快照版本 ${snapshot.version} 不一致`,
    );
  }
  return result;
}

/** 数据编辑落成真字节的结果：新快照 + 已读回校验的真字节包。 */
export interface ChartPackageEditResult {
  readonly snapshot: ChartDataSnapshot;
  readonly package: ChartPackageResult;
}

/**
 * **一次数据编辑 → 真字节**：施加编辑（P06 `applyDataEdit`，整份重派生）→ 描述符同版复核
 * （`verifyChartDataCoherence`）→ 装配真字节包（本模块）并读回校验。
 *
 * 图部件与嵌入工作簿都来自**同一个新快照**的 `data`，因此"改数据 ⇒ 图与工作簿一起变"是
 * 结构上不可能只变一半的；返回的 `package.version` 恒等于 `snapshot.version`。
 */
export function applyChartDataEditToPackage(
  snapshot: ChartDataSnapshot,
  edit: ChartDataEdit,
  options: ChartPackageBuildOptions = {},
): ChartPackageEditResult {
  const next = applyDataEdit(snapshot, edit);
  verifyChartDataCoherence(next);
  const rendered = renderChartPackageFromSnapshot(next, options);
  return Object.freeze({ snapshot: next, package: rendered });
}
