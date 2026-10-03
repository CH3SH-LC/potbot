/**
 * **图表 → `word/charts/chartN.xml` + `w:drawing` 引用**（design-05-P9 / WF-092 的导出接线；R106/R107）。
 *
 * ## 一个 DOCX 里的图表**不是一个内联元素**，而是一串零件
 *
 * | 零件 | 落点 | 少写会怎样 |
 * |---|---|---|
 * | 图表本体 | `word/charts/chartN.xml`（DrawingML Chart） | 图形框空着 |
 * | 关系 | `word/_rels/document.xml.rels` 里 `…/chart` → `charts/chartN.xml` | `c:chart@r:id` **悬空**，Word 拒开 |
 * | 内容类型 | `[Content_Types].xml` 里一条 `Override` | 一个没有任何内容类型的部件进了包，也是坏包 |
 * | 正文里的图形框 | 段落里的 `w:drawing` → `c:chart@r:id` | 图表存在但**没人引用它**（孤儿部件） |
 *
 * 本文件产出其中的**纯 XML 两件**（图表本体、图形框）；关系与内容类型由 `export.ts` 走
 * 既有的 `nextRelationshipId` + `ensureContentTypeEntry` 机制追加——既有 `rId` 的编号与
 * 顺序一个不动（R106）。零件清单本身在模型层已经算好（`charts/parts.ts` 的
 * `chartPartsManifest`），本文件不重新发明一遍。
 *
 * ## 数据只来自事实来源
 *
 * 图表里的每个数值都直接抄自 `ChartDefinition.series[].points[].value`——而按 design-02 P3 的
 * 单一来源纪律，那些值在模型层只能来自事实快照（`charts/facts.ts` 的装配入口没有"裸数字"
 * 参数位置）。导出侧再把 `assertChartTraceable` 跑一遍：**没有来源的数据点不写出**（R140），
 * 免得"顺手把 12 写进柱子里"在导出这一环重新长出来。改数据 ⇒ 本文件产出的 XML 跟着变。
 *
 * ## 嵌入工作簿（可选件）**由调用方决定**，本文件不合成
 *
 * 图表用 `c:numLit`/`c:strLit` **字面量缓存**自带数据，缺嵌入件仍能显示
 * （`chartPartsManifest` 也把嵌入件列为可选件）。当调用方**确实**提供了 `.xlsx` 字节时，
 * 本文件负责写出 `c:externalData@r:id` 那一句；工作簿的**字节与关系**由 `export.ts` 装配
 * （部件 + 关系 + 内容类型三件成对）。本模块**不合成电子表格**——凭空造一个 `.xlsx`
 * 只会凭空造出一个数据源，那正是"单一来源纪律"要挡的事。
 *
 * ## 不写主题色 / 渐变 / 数据标签位置等本仓未建模的样式细节；调色板与图例位置按模型给的值写。
 */

import { attr, el, serializeXmlNode, type XmlElement } from '../../artifacts/ooxml/xml.js';
import { assertChartTraceable } from '../charts/build.js';
import type {
  ChartDataTable,
  ChartDefinition,
  ChartSeries,
  ChartStyle,
  LegendPosition,
} from '../charts/types.js';
import { lengthToEmu } from '../operations/drawing/params.js';
import type { Length } from '../model/types.js';
import { DocxError } from './docx-error.js';
import {
  directText,
  findChild,
  findChildren,
  parseXml,
  type ParsedXmlElement,
} from './xml-parse.js';

/** DrawingML Chart 命名空间（`c:` 前缀）。 */
export const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
/** DrawingML 主命名空间（`a:` 前缀）。 */
const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
/** WordprocessingDrawing 命名空间（`wp:` 前缀）。 */
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
/** 关系引用命名空间（`r:` 前缀）。 */
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** 词处理主命名空间（`w:` 前缀）。 */
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** 图例位置 → `c:legendPos@val`（`ST_LegendPos`）。 */
const LEGEND_POSITIONS: Readonly<Record<Exclude<LegendPosition, 'none'>, string>> = Object.freeze({
  right: 'r',
  top: 't',
  bottom: 'b',
  left: 'l',
});

/** 数值 → XML 文本。**非有限数先拒绝**（不让 `NaN` 悄悄进文档）。 */
function numberText(value: number, what: string): string {
  if (!Number.isFinite(value)) {
    throw new DocxError('unsupported_chart_data', `${what} 不是有限数：${String(value)}`);
  }
  return String(value);
}

/** 转义前的文本值元素（`c:v`）。 */
function valueElement(text: string): XmlElement {
  return el('c:v', [], [text]);
}

/** 一个文本序列的**字面量缓存**（`c:strLit`）——类别轴与系列名用它，不依赖嵌入工作簿。 */
function stringLiteral(values: readonly string[]): XmlElement {
  return el('c:strLit', [], [
    el('c:ptCount', [attr('val', String(values.length))]),
    ...values.map((value, index) => el('c:pt', [attr('idx', String(index))], [valueElement(value)])),
  ]);
}

/** 一个数值序列的字面量缓存（`c:numLit`）。 */
function numberLiteral(values: readonly number[], what: string): XmlElement {
  return el('c:numLit', [], [
    el('c:ptCount', [attr('val', String(values.length))]),
    ...values.map((value, index) =>
      el('c:pt', [attr('idx', String(index))], [valueElement(numberText(value, what))]),
    ),
  ]);
}

/** 系列：`c:ser`。`idx`/`order` 按数组顺序，类别与取值取自定义（数据只此一处来源）。 */
function seriesElement(series: ChartSeries, index: number, categories: readonly string[]): XmlElement {
  return el('c:ser', [], [
    el('c:idx', [attr('val', String(index))]),
    el('c:order', [attr('val', String(index))]),
    // 系列名走字面量（`c:v`）：写 `c:strRef` 就要指一个工作簿单元格，而本轮不写嵌入件。
    el('c:tx', [], [valueElement(series.name)]),
    el('c:cat', [], [stringLiteral(categories)]),
    el('c:val', [], [
      numberLiteral(series.points.map((point) => point.value), `系列 "${series.name}" 的数据点`),
    ]),
  ]);
}

/** 标题：`c:title`（富文本，字号走模型给的 pt）。空标题返回 `null`（不写空壳标题）。 */
function titleElement(definition: ChartDefinition): XmlElement | null {
  if (definition.title.length === 0) return null;
  const size = definition.style.title_font_size_pt;
  return el('c:title', [], [
    el('c:tx', [], [
      el('c:rich', [], [
        el('a:bodyPr', [attr('xmlns:a', DRAWINGML_NS)]),
        el('a:lstStyle', [attr('xmlns:a', DRAWINGML_NS)]),
        el('a:p', [attr('xmlns:a', DRAWINGML_NS)], [
          el('a:r', [], [
            el('a:rPr', [attr('lang', 'en-US'), attr('sz', String(Math.round(size * 100)))]),
            el('a:t', [], [definition.title]),
          ]),
        ]),
      ]),
    ]),
    el('c:overlay', [attr('val', '0')]),
  ]);
}

/** 图例：`c:legend`；`legend === 'none'` ⇒ 返回 `null`（不写元素 = 不显示图例）。 */
function legendElement(legend: LegendPosition): XmlElement | null {
  if (legend === 'none') return null;
  return el('c:legend', [], [
    el('c:legendPos', [attr('val', LEGEND_POSITIONS[legend])]),
    el('c:overlay', [attr('val', '0')]),
  ]);
}

/** 一个序列的颜色：调色板按系列序号取模（`palette` 非空由 `mergeChartStyle` 保证）。 */
function seriesColor(palette: readonly string[], index: number): string {
  const color = palette[index % palette.length];
  if (color === undefined) {
    // 调色板为空是构造期的错；走到这里说明输入绕过了 `buildChart`，宁可拒绝。
    throw new DocxError('unsupported_chart_data', '图表调色板为空：无法为系列分配颜色。');
  }
  return color;
}

/** 给每个系列补一个 `c:spPr`（纯色填充）。`ser` 的 `spPr` 是可选件，写在 `ser` 末尾。 */
function withSeriesColor(series: XmlElement, color: string): XmlElement {
  return el(
    series.name,
    series.attributes,
    [
      ...series.children,
      el('c:spPr', [], [
        el('a:solidFill', [attr('xmlns:a', DRAWINGML_NS)], [
          el('a:srgbClr', [attr('val', color)]),
        ]),
      ]),
    ],
  );
}

/** 坐标轴：类别轴 + 数值轴（饼图不写轴）。 */
function axisElements(gridlines: boolean): readonly XmlElement[] {
  return [
    el('c:catAx', [], [
      el('c:axId', [attr('val', '1')]),
      el('c:scaling', [], [el('c:orientation', [attr('val', 'minMax')])]),
      el('c:delete', [attr('val', '0')]),
      el('c:axPos', [attr('val', 'b')]),
      el('c:tickLblPos', [attr('val', 'nextTo')]),
      el('c:crossAx', [attr('val', '2')]),
    ]),
    el('c:valAx', [], [
      el('c:axId', [attr('val', '2')]),
      el('c:scaling', [], [el('c:orientation', [attr('val', 'minMax')])]),
      el('c:delete', [attr('val', '0')]),
      el('c:axPos', [attr('val', 'l')]),
      ...(gridlines ? [el('c:majorGridlines')] : []),
      el('c:tickLblPos', [attr('val', 'nextTo')]),
      el('c:crossAx', [attr('val', '1')]),
    ]),
  ];
}

/** 绘图区：按图表类型选 `c:barChart` / `c:lineChart` / `c:pieChart`。 */
function plotAreaElement(definition: ChartDefinition, style: ChartStyle): XmlElement {
  const series = definition.series.map((item, index) =>
    withSeriesColor(seriesElement(item, index, definition.categories), seriesColor(style.palette, index)),
  );

  if (definition.chart_type === 'pie') {
    return el('c:plotArea', [], [
      el('c:layout'),
      el('c:pieChart', [], [
        el('c:varyColors', [attr('val', '1')]),
        ...series,
        el('c:firstSliceAng', [attr('val', '0')]),
      ]),
    ]);
  }

  if (definition.chart_type === 'line') {
    return el('c:plotArea', [], [
      el('c:layout'),
      el('c:lineChart', [], [
        el('c:grouping', [attr('val', 'standard')]),
        el('c:varyColors', [attr('val', '0')]),
        ...series,
        el('c:marker', [attr('val', '1')]),
        el('c:axId', [attr('val', '1')]),
        el('c:axId', [attr('val', '2')]),
      ]),
      ...axisElements(style.gridlines),
    ]);
  }

  // 柱形（column = 竖直）与条形（bar = 水平）同族，只差 `c:barDir`。
  return el('c:plotArea', [], [
    el('c:layout'),
    el('c:barChart', [], [
      el('c:barDir', [attr('val', definition.chart_type === 'bar' ? 'bar' : 'col')]),
      el('c:grouping', [attr('val', 'clustered')]),
      el('c:varyColors', [attr('val', '0')]),
      ...series,
      el('c:axId', [attr('val', '1')]),
      el('c:axId', [attr('val', '2')]),
    ]),
    ...axisElements(style.gridlines),
  ]);
}

/** 嵌入工作簿引用（`c:externalData@r:id`）：给的是**图表部件自己的**关系表里的 id。 */
export interface ChartExternalDataInput {
  /** `word/charts/_rels/chartN.xml.rels` 里那条 `…/package` 关系的 id。 */
  readonly relationship_id: string;
}

/**
 * `ChartDefinition` → `word/charts/chartN.xml` 的**文本**。
 *
 * @param definition 图表定义（数据只能来自事实来源；本函数会跑一遍可追溯性闸门）。
 * @param external 嵌入工作簿引用；`null`/省略 ⇒ **不写** `c:externalData`（图表只靠字面量缓存）。
 *   给了就必须给**非空** id——写一个空的 `r:id` 是悬空引用。
 * @throws {DocxError} 数据不可追溯 / 含非有限数 ⇒ `unsupported_chart_data`，**不产出半成品**（R140）。
 */
export function chartPartXml(
  definition: ChartDefinition,
  external: ChartExternalDataInput | null = null,
): string {
  if (external !== null && external.relationship_id.length === 0) {
    throw new DocxError(
      'unsupported_chart_part',
      '嵌入工作簿的关系 id 是空串：写出去会是一条 `c:externalData@r:id=""` 的悬空引用。',
    );
  }
  const traceable = assertChartTraceable(definition);
  if (!traceable.ok) {
    throw new DocxError(
      'unsupported_chart_data',
      `图表 "${definition.title}" 的数据点不能全部指认到事实来源，拒绝写出：` +
        `${traceable.message}（单一来源纪律，R48.3/R140）。`,
    );
  }

  const title = titleElement(definition);
  const legend = legendElement(definition.style.legend);

  const chartSpace = el(
    'c:chartSpace',
    [attr('xmlns:c', CHART_NS), attr('xmlns:a', DRAWINGML_NS), attr('xmlns:r', R_NS)],
    [
      el('c:chart', [], [
        ...(title === null ? [] : [title]),
        // 显式"自动标题"=0：标题由 `c:title` 决定，不让消费端另起一个。
        el('c:autoTitleDeleted', [attr('val', title === null ? '1' : '0')]),
        plotAreaElement(definition, definition.style),
        ...(legend === null ? [] : [legend]),
        el('c:plotVisOnly', [attr('val', '1')]),
        el('c:dispBlanksAs', [attr('val', 'gap')]),
      ]),
      // 嵌入工作簿的引用（可选）：`c:externalData` 是 `c:chartSpace` 的子元素，
      // 排在 `c:chart` **之后**（ECMA-376 的 `CT_ChartSpace` 序列）。
      // `c:autoUpdate=0`：打开文档时**不**去覆盖部件里的字面量缓存——缓存里的值才是
      // 本仓写出去的那一份，被 Excel 静默重算等于"导出结果不是我们写的那份"。
      ...(external === null
        ? []
        : [
            el('c:externalData', [attr('r:id', external.relationship_id)], [
              el('c:autoUpdate', [attr('val', '0')]),
            ]),
          ]),
    ],
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(chartSpace)}`;
}

/** 图形框的输入。 */
export interface ChartDrawingInput {
  /** 指向 `word/charts/chartN.xml` 的关系 id（**必须真实存在**，否则是悬空引用，R106）。 */
  readonly relationship_id: string;
  /** 显示尺寸（EMU 走换算层）。 */
  readonly extent: { readonly width: Length; readonly height: Length };
  /** `wp:docPr@id`（文档内唯一；由调用方按"已用最大 id + 1"给出）。 */
  readonly doc_pr_id: number;
  /** 替代文字 / 显示名。 */
  readonly alt_text: string;
}

/**
 * 造一个引用图表的 `<w:drawing>` 元素。
 *
 * `a:graphicData@uri` 是**图表**那一支（`…/drawingml/2006/chart`），`c:chart@r:id` 指关系——
 * 三处取值都来自 OOXML 规范，不是自造。命名空间就地声明（合成语料的根上可能没有 `wp:`/`a:`）。
 */
export function chartDrawingElement(input: ChartDrawingInput): XmlElement {
  const extent = el('wp:extent', [
    attr('cx', String(lengthToEmu(input.extent.width))),
    attr('cy', String(lengthToEmu(input.extent.height))),
  ]);
  const name = input.alt_text.length > 0 ? input.alt_text : 'chart';
  return el('w:drawing', [attr('xmlns:w', W_NS)], [
    el(
      'wp:inline',
      [
        attr('xmlns:wp', WP_NS),
        attr('distT', '0'),
        attr('distB', '0'),
        attr('distL', '0'),
        attr('distR', '0'),
      ],
      [
        extent,
        el('wp:effectExtent', [attr('l', '0'), attr('t', '0'), attr('r', '0'), attr('b', '0')]),
        el('wp:docPr', [attr('id', String(input.doc_pr_id)), attr('name', name), attr('descr', name)]),
        el('wp:cNvGraphicFramePr', [], [
          el('a:graphicFrameLocks', [attr('xmlns:a', DRAWINGML_NS), attr('noChangeAspect', '1')]),
        ]),
        el('a:graphic', [attr('xmlns:a', DRAWINGML_NS)], [
          el('a:graphicData', [attr('uri', CHART_NS)], [
            el('c:chart', [attr('xmlns:c', CHART_NS), attr('xmlns:r', R_NS), attr('r:id', input.relationship_id)]),
          ]),
        ]),
      ],
    ),
  ]);
}

// ---------------------------------------------------------------------------
// 图形缓存（c:numLit）与嵌入数据表的核对（WF-092 判据"图形、数值一致"）
// ---------------------------------------------------------------------------

/** 递归收集指定本地名的 `c:` 元素（文档顺序）。 */
function collectChartElements(
  element: ParsedXmlElement,
  localName: string,
  out: ParsedXmlElement[],
): void {
  for (const child of element.children) {
    if (child.kind !== 'element') continue;
    if (child.namespace === CHART_NS && child.localName === localName) out.push(child);
    collectChartElements(child, localName, out);
  }
}

/**
 * 从**已渲染的** `chartN.xml` 文本里把 `c:numLit` 数值缓存逐系列读回来。
 *
 * ## 为什么是"读回来"而不是"再算一遍"
 *
 * 再算一遍只是把同一个函数调两次——"缓存与数据源一致"就成了同义反复。这里读的是
 * **真的写进字节里的那串 `c:pt`**（按 `c:ser` 的文档顺序，按 `c:pt@idx` 落位）：
 * 渲染若漏写一条系列、写错一个点、或写出读不成有限数的东西，这里都会当场发现。
 * 导出器据此对"图形缓存 vs 嵌入数据表"做 fail-closed 核对（`compareChartNumLitToTable`）。
 *
 * @returns 每条系列的数值数组（顺序 = `c:ser` 文档顺序 = `chart.series` 顺序）。
 * @throws {DocxError} XML 读不回来 / 没有 `c:ser` / 某系列缺 `c:val/c:numLit` /
 *   缓存里有空洞或非有限数——不猜、不静默跳过（R140）。
 */
export function chartNumLitValues(chartXml: string): readonly (readonly number[])[] {
  let root: ParsedXmlElement;
  try {
    root = parseXml(chartXml);
  } catch (error) {
    throw new DocxError(
      'unsupported_chart_data',
      `图表 XML 无法重新读回（核对 c:numLit 缓存用）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const seriesElements: ParsedXmlElement[] = [];
  collectChartElements(root, 'ser', seriesElements);
  if (seriesElements.length === 0) {
    throw new DocxError(
      'unsupported_chart_data',
      '图表 XML 里没有任何 c:ser：没有系列就没有 c:numLit 缓存可核对。',
    );
  }

  const all: number[][] = [];
  for (const [seriesIndex, series] of seriesElements.entries()) {
    const val = findChild(series, CHART_NS, 'val');
    const numLit = findChild(val, CHART_NS, 'numLit');
    if (numLit === null) {
      throw new DocxError(
        'unsupported_chart_data',
        `图表第 ${String(seriesIndex + 1)} 条系列（c:ser）没有 c:val/c:numLit 数值缓存：` +
          '无法核对"图形缓存与嵌入数据表一致"。',
      );
    }
    const points = findChildren(numLit, CHART_NS, 'pt');
    const values: number[] = [];
    for (const point of points) {
      const rawIdx = point.attributes.find((attribute) => attribute.name === 'idx')?.value;
      const idx = rawIdx === undefined ? Number.NaN : Number(rawIdx);
      const valueElement = findChild(point, CHART_NS, 'v');
      const raw = valueElement === null ? null : directText(valueElement);
      const value = raw === null ? Number.NaN : Number(raw);
      if (!Number.isInteger(idx) || idx < 0 || !Number.isFinite(value)) {
        throw new DocxError(
          'unsupported_chart_data',
          `图表第 ${String(seriesIndex + 1)} 条系列的 c:numLit 缓存里有一个读不成有限数的点` +
            `（idx=${String(rawIdx)}，值=${JSON.stringify(raw)}）。`,
        );
      }
      values[idx] = value;
    }
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] === undefined) {
        throw new DocxError(
          'unsupported_chart_data',
          `图表第 ${String(seriesIndex + 1)} 条系列的 c:numLit 缓存缺 idx=${String(index)} 的点（有空洞）。`,
        );
      }
    }
    all.push(values);
  }
  return all;
}

/** 一处"图形缓存（`c:numLit`）≠ 嵌入数据表"的偏差。`point_index < 0` 表示系列数不一致。 */
export interface ChartCacheMismatch {
  readonly series_index: number;
  readonly point_index: number;
  readonly cached: number | null;
  readonly table: number | null;
}

/** `compareChartNumLitToTable` 的结果：一致时给出规模，不一致时给出**全部**偏差（不只第一条）。 */
export type ChartCacheComparison =
  | { readonly ok: true; readonly series_count: number; readonly point_count: number }
  | { readonly ok: false; readonly reason: string; readonly mismatches: readonly ChartCacheMismatch[] };

/**
 * 核对"图形缓存（`c:numLit`）"与"嵌入数据表"是否**逐点一致**（WF-092 判据"图形、数值一致"）。
 *
 * 两侧来源不同，因此这不是同义反复：
 *
 * | 侧 | 从哪来 |
 * |---|---|
 * | 嵌入数据表 | `charts/datatable.ts` 的 `chartEmbeddedTable(chart)`——表的**内容模型**（供"编辑数据"） |
 * | 图形缓存 | 本文件 `chartPartXml` **已经写出的那个字符串**，由 `chartNumLitValues` 读回来 |
 *
 * 不一致 = 消费端会看到"柱高 8、编辑数据看到 3"这种结构层就对不上的产物（正是判据里
 * "非截图"要挡的）。因此导出器拿到 `ok: false` 就**拒绝写出**，不产出半成品（R140）。
 */
export function compareChartNumLitToTable(table: ChartDataTable, chartXml: string): ChartCacheComparison {
  let cached: readonly (readonly number[])[];
  try {
    cached = chartNumLitValues(chartXml);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), mismatches: [] };
  }

  const expected: readonly (readonly (number | null)[])[] = table.series_names.map((_, seriesIndex) =>
    table.rows.map((row) => row.values[seriesIndex] ?? null),
  );

  const mismatches: ChartCacheMismatch[] = [];
  const seriesCount = Math.max(cached.length, expected.length);
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    const cachedSeries = cached[seriesIndex] ?? null;
    const expectedSeries = expected[seriesIndex] ?? null;
    if (cachedSeries === null || expectedSeries === null) {
      mismatches.push({ series_index: seriesIndex, point_index: -1, cached: null, table: null });
      continue;
    }
    const pointCount = Math.max(cachedSeries.length, expectedSeries.length);
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const cachedValue = cachedSeries[pointIndex] ?? null;
      const tableValue = expectedSeries[pointIndex] ?? null;
      if (cachedValue !== tableValue) {
        mismatches.push({
          series_index: seriesIndex,
          point_index: pointIndex,
          cached: cachedValue,
          table: tableValue,
        });
      }
    }
  }

  if (mismatches.length > 0) {
    const first = mismatches[0] as ChartCacheMismatch;
    const where =
      first.point_index < 0
        ? `系列数不一致（缓存 ${String(cached.length)} 条，表 ${String(expected.length)} 条）`
        : `首处在系列 ${String(first.series_index + 1)} 的第 ${String(first.point_index + 1)} 个数据点` +
          `（缓存 ${String(first.cached)}，表 ${String(first.table)}）`;
    return {
      ok: false,
      reason:
        `图表图形缓存（c:numLit）与嵌入数据表不一致：共 ${String(mismatches.length)} 处偏差，${where}。` +
        '图形与数据表必须同源——不一致即拒绝写出（不产出一份"柱高 8、编辑数据看到 3"的图）。',
      mismatches,
    };
  }

  return {
    ok: true,
    series_count: cached.length,
    point_count: cached.reduce((sum, series) => sum + series.length, 0),
  };
}
