/**
 * P-I17 · **真实部件写盘 + 字节读回**（图表数据编辑落在真字节上；合并表 span 往返）。
 *
 * ## 这一批解决什么
 *
 * P06 的 `data-edit.ts` 只产出**描述符**（图引用 / 工作簿格 / 表字面量 / 指纹），刻意不在
 * 运行期接 `charts.ts`；P-I08 补了表侧指纹。本批把这条链**落到真字节**：
 * `P06 快照 → charts.renderChartPackageFromSnapshot` 装配「幻灯片 + 图表部件 + 嵌入工作簿」
 * 的真 ZIP，装配后**读回校验**（`verifyChartPackage` + 逐格解码 + 重算指纹）；
 * 并给表格补上 render → import 的 span 往返（`tables.verifyTableMergeRoundTrip`）。
 *
 * ## 判据走**独立解码**（不复用待测模块的解码器自证）
 *
 * 本文件自实现：
 * - `decodeXlsxCells`：从真 XLSX 字节解出 `xl/worksheets/sheet1.xml`，逐格读地址 / 文本 / 数值；
 * - `decodeChartCache`：从图表部件 XML 里独立读 `c:ser` 的 `c:tx`/`c:cat`/`c:val` 缓存；
 * - `rawSpanGrid`：自己包一层命名空间，从渲染出的 `p:graphicFrame` 直读 `gridSpan`/`rowSpan`/
 *   `hMerge`/`vMerge`（不看待测 `readTableFrameSpans`）。
 * 待测函数（`readEmbeddedWorkbookData` / `readChartPartData` / `readTableFrameSpans`）只作**额外**对照。
 *
 * ## 反向对照（必须红）
 *
 * 篡改嵌入工作簿 / 图表缓存里的一个数 ⇒ `verifyChartPackage` 具名 `chart_data_desync`，
 * 且两个独立解码出的指纹不再相等；伪造快照版本 ⇒ `chart_version_mismatch`；
 * 篡改渲染 XML 的 `hMerge` ⇒ 表格往返具名 `merge_readback_mismatch`。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import { transform, type Presentation, type TableShape } from '../../../../src/presentations/model.js';
import { addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import {
  PresentationTableError,
  addTable,
  mergeCells,
  planTableGrid,
  renderTableFrameXml,
  requireTable,
  readTableFrameSpans,
  verifyTableMergeRoundTrip,
} from '../../../../src/presentations/tables.js';
import {
  PresentationChartError,
  applyChartDataEditToPackage,
  readChartPartData,
  readEmbeddedWorkbookData,
  renderChartPackageFromSnapshot,
  verifyChartPackage,
} from '../../../../src/presentations/charts.js';
import {
  dataVersionOf,
  snapshotChartData,
  tableFactCells,
  tableFactVersionOf,
  type ChartDataSnapshot,
  type ExpectedChartData,
  type TableFactMirror,
} from '../../../../src/presentations/table-chart-parts/index.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from '../../../../src/presentations/xml-parse.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const DATA: ExpectedChartData = {
  categories: ['一月', '二月', '三月'],
  series: [
    { name: '收入', values: [1.5, 2.25, 3] },
    { name: '支出', values: [0.5, 1.25, 2] },
  ],
};

function columnLetter(index: number): string {
  let remaining = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

function collectAll(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) collectAll(child, name, out);
  return out;
}

function nodeText(node: XmlElementNode | undefined): string {
  if (node === undefined) return '';
  return node.children.map((child) => (child.kind === 'text' ? child.text : '')).join('');
}

// ---------------------------------------------------------------------------
// 独立解码器（不 import 待测模块的语义）
// ---------------------------------------------------------------------------

interface DecodedCell {
  readonly text: string | null;
  readonly value: number | null;
}

/** 从真 XLSX 字节独立读回逐格（地址 → 文本 / 数值）。 */
function decodeXlsxCells(workbookBytes: Uint8Array): Map<string, DecodedCell> {
  const inner = readZip(workbookBytes);
  const sheetEntry = inner.by_path.get('xl/worksheets/sheet1.xml');
  if (sheetEntry === undefined) throw new Error('嵌入工作簿里没有 xl/worksheets/sheet1.xml');
  const root = parseXmlDocument(Buffer.from(sheetEntry.data).toString('utf8'));
  const cells = new Map<string, DecodedCell>();
  for (const cell of collectAll(root, 'c')) {
    const ref = attributeOf(cell, 'r') ?? '';
    const inline = collectAll(cell, 't')[0];
    const raw = collectAll(cell, 'v')[0];
    if (inline !== undefined) {
      cells.set(ref, { text: nodeText(inline), value: null });
    } else {
      const text = nodeText(raw);
      cells.set(ref, { text: null, value: text === '' ? null : Number(text) });
    }
  }
  return cells;
}

/** 从工作簿格**独立反拼**回数据（按与图表同格的布局）。 */
function dataFromXlsx(cells: Map<string, DecodedCell>): ExpectedChartData {
  const names: string[] = [];
  for (let index = 0; ; index += 1) {
    const cell = cells.get(`${columnLetter(index + 1)}1`);
    if (cell?.text === null || cell?.text === undefined) break;
    names.push(cell.text);
  }
  const categories: string[] = [];
  for (let row = 2; ; row += 1) {
    const cell = cells.get(`A${String(row)}`);
    if (cell?.text === null || cell?.text === undefined) break;
    categories.push(cell.text);
  }
  const series = names.map((name, seriesIndex) => ({
    name,
    values: categories.map((_unused, rowIndex) => cells.get(`${columnLetter(seriesIndex + 1)}${String(rowIndex + 2)}`)?.value ?? Number.NaN),
  }));
  return { categories, series };
}

/** 从图表部件 XML 独立读回 `c:ser` 缓存。 */
function decodeChartCache(containerBytes: Uint8Array): ExpectedChartData {
  const archive = readZip(containerBytes);
  const chartPath = archive.entries.map((entry) => entry.path).find((path) => /charts\/chart[0-9]+\.xml$/.test(path));
  if (chartPath === undefined) throw new Error('包内没有图表部件');
  const entry = archive.by_path.get(chartPath);
  if (entry === undefined) throw new Error(`找不到 ${chartPath}`);
  const root = parseXmlDocument(Buffer.from(entry.data).toString('utf8'));

  const cachedText = (node: XmlElementNode | undefined): string[] =>
    collectAll(node ?? root, 'c:v').map(nodeText);
  const seriesNodes = collectAll(root, 'c:ser');
  let categories: string[] = [];
  const series = seriesNodes.map((node, index) => {
    const name = cachedText(collectAll(node, 'c:tx')[0])[0] ?? '';
    const cats = cachedText(collectAll(node, 'c:cat')[0]);
    if (index === 0) categories = cats;
    const values = cachedText(collectAll(node, 'c:val')[0]).map((raw) => Number(raw));
    return { name, values };
  });
  return { categories, series };
}

/** 自己包一层命名空间，从渲染出的 graphicFrame 直读每格 span（独立于 tables.readTableFrameSpans）。 */
function rawSpanGrid(frameXml: string): { gridSpan: number; rowSpan: number; hMerge: boolean; vMerge: boolean }[][] {
  const doc =
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    frameXml +
    '</p:sld>';
  const root = parseXmlDocument(doc);
  const table = collectAll(root, 'a:tbl')[0];
  if (table === undefined) throw new Error('片段里没有 a:tbl');
  return collectAll(table, 'a:tr').map((tr) =>
    childElements(tr, 'a:tc').map((tc) => ({
      gridSpan: Number(attributeOf(tc, 'gridSpan') ?? '1'),
      rowSpan: Number(attributeOf(tc, 'rowSpan') ?? '1'),
      hMerge: (attributeOf(tc, 'hMerge') ?? '') === '1',
      vMerge: (attributeOf(tc, 'vMerge') ?? '') === '1',
    })),
  );
}

/** 篡改容器里嵌入工作簿的一处文本（做"数据不同步"的反向对照）。 */
function patchEmbeddedWorkbook(container: Uint8Array, from: string, to: string): Buffer {
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

/** 篡改图表部件缓存里的一个数（工作簿不动）。 */
function patchChartCache(container: Uint8Array, from: string, to: string): Buffer {
  const archive = readZip(container);
  return writeZip(
    archive.entries.map((entry) =>
      entry.path === 'ppt/charts/chart1.xml'
        ? { path: entry.path, data: utf8Bytes(Buffer.from(entry.data).toString('utf8').replace(from, to)) }
        : { path: entry.path, data: entry.data },
    ),
  );
}

/** 表字面量与解码出的工作簿逐格交叉（fact 源格才有字面量）。 */
function expectTableLiteralsMatchWorkbook(mirror: TableFactMirror, cells: Map<string, DecodedCell>): void {
  const facts = tableFactCells(mirror);
  expect(facts.length).toBeGreaterThan(0);
  for (const cell of facts) {
    const decoded = cells.get(cell.a1);
    expect(decoded).toBeDefined();
    if (cell.value !== null) {
      expect(decoded?.value).toBe(cell.value);
    } else {
      expect(decoded?.text).toBe(cell.text);
    }
  }
}

function mergedTableDeck(): TableShape {
  let deck: Presentation = emptyPresentation('p-i17', 'P-I17');
  deck = addSlide(deck).presentation;
  const added = addTable(deck, 1, {
    transform: transform(838200, 457200, 4000000, 2000000),
    rows: 3,
    columns: 3,
  });
  const merged = mergeCells(added.presentation, 1, added.shape_id, { row: 0, col: 0, row_span: 2, col_span: 2 });
  return requireTable(merged, 1, added.shape_id);
}

// ---------------------------------------------------------------------------
// A. 快照 → 真字节：xlsx 格 / 图表缓存 / 表字面量三者同版，verifyChartPackage 通过
// ---------------------------------------------------------------------------

describe('A. 快照落成真字节：cells / c:numCache / 表字面量一致，verifyChartPackage 通过', () => {
  it('初版数据装配：真 XLSX 逐格、图表 c:val 缓存与独立解码一致，指纹 = 快照版本', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(DATA);
    const pkg = renderChartPackageFromSnapshot(snapshot, { chart_type: 'bar', title: '季度对比' });

    // 真实字节被 verifyChartPackage 接受（成对 + 逐点同步）。
    const report = verifyChartPackage(pkg.bytes);
    expect(report.series).toBe(2);
    expect(report.categories).toBe(3);
    expect(report.chart_path).toBe('ppt/charts/chart1.xml');

    // 独立解码工作簿：值来自 DATA 的独立映射。
    const cells = decodeXlsxCells(pkg.workbook_bytes);
    expect(cells.get('B1')?.text).toBe('收入');
    expect(cells.get('C1')?.text).toBe('支出');
    expect(cells.get('A2')?.text).toBe('一月');
    expect(cells.get('B2')?.value).toBe(1.5);
    expect(cells.get('C2')?.value).toBe(0.5);
    expect(cells.get('B4')?.value).toBe(3);
    expect(cells.get('C4')?.value).toBe(2);

    // 独立解码图表缓存：与工作簿逐点一致。
    const chartCache = decodeChartCache(pkg.bytes);
    expect(chartCache.series.map((s) => s.name)).toEqual(['收入', '支出']);
    expect(chartCache.categories).toEqual(['一月', '二月', '三月']);
    expect(chartCache.series[0]?.values).toEqual([1.5, 2.25, 3]);

    // 表字面量与解码出的工作簿逐格一致。
    expectTableLiteralsMatchWorkbook(snapshot.table, cells);

    // 指纹不变式：三个独立来源都反算成同一枚 dc1-*。
    expect(dataFromXlsx(cells)).toEqual(DATA);
    expect(dataVersionOf(dataFromXlsx(cells))).toBe(snapshot.version);
    expect(dataVersionOf(chartCache)).toBe(snapshot.version);
    expect(tableFactVersionOf(snapshot.table)).toBe(snapshot.version);

    // 待测读回器与独立解码器一致（额外对照，不作唯一判据）。
    expect(readEmbeddedWorkbookData(pkg.workbook_bytes)).toEqual(DATA);
    expect(readChartPartData(pkg.bytes)).toEqual(DATA);
  });

  it('三张图类型（bar/line/pie）都装配成真字节并读回通过', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(DATA);
    for (const chart_type of ['bar', 'line', 'pie'] as const) {
      const pkg = renderChartPackageFromSnapshot(snapshot, { chart_type });
      expect(pkg.version).toBe(snapshot.version);
      expect(verifyChartPackage(pkg.bytes).series).toBe(2);
      expect(decodeChartCache(pkg.bytes).series[0]?.values).toEqual([1.5, 2.25, 3]);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 数据编辑 → 真字节：三处一起变，指纹只变一次
// ---------------------------------------------------------------------------

describe('B. 数据编辑落成真字节：图表 / 工作簿 / 表字面量同版', () => {
  it('set_value(系列1, 类别0)=99：xlsx C2、图表缓存第 2 系列第 0 点、表字面量一起变', () => {
    const before: ChartDataSnapshot = snapshotChartData(DATA);
    const { snapshot: after, package: pkg } = applyChartDataEditToPackage(
      before,
      { kind: 'set_value', series_index: 1, category_index: 0, value: 99 },
      { chart_type: 'bar' },
    );

    expect(after.version).not.toBe(before.version);
    expect(pkg.version).toBe(after.version);
    expect(verifyChartPackage(pkg.bytes).series).toBe(2);

    const cells = decodeXlsxCells(pkg.workbook_bytes);
    expect(cells.get('C2')?.value).toBe(99);
    const chartCache = decodeChartCache(pkg.bytes);
    expect(chartCache.series[1]?.values[0]).toBe(99);

    // 表字面量（含合并来源迁移）与解码出的工作簿一致，且指纹同为 after.version。
    expectTableLiteralsMatchWorkbook(after.table, cells);
    expect(tableFactVersionOf(after.table)).toBe(after.version);
    expect(dataVersionOf(dataFromXlsx(cells))).toBe(after.version);

    // 原快照未被修改。
    expect(before.data.series[1]?.values[0]).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// C. 合并表 render → import：span 真读回往返
// ---------------------------------------------------------------------------

describe('C. 合并表 render → import 往返（独立读回 span）', () => {
  it('2×2 合并：独立读回的 gridSpan/rowSpan/hMerge/vMerge 与模型规划逐格相等', () => {
    const table = mergedTableDeck();
    const frame = renderTableFrameXml(table);
    const raw = rawSpanGrid(frame);
    const plan = planTableGrid(table);

    expect(raw).toHaveLength(3);
    plan.forEach((plannedRow, rowIndex) => {
      expect(raw[rowIndex]).toHaveLength(plannedRow.length);
      plannedRow.forEach((planned, col) => {
        expect(raw[rowIndex]?.[col]).toEqual({
          gridSpan: planned.grid_span,
          rowSpan: planned.row_span,
          hMerge: planned.h_merge,
          vMerge: planned.v_merge,
        });
      });
    });

    // 待测读回器与独立读回一致；往返报告合并区正确。
    const imported = readTableFrameSpans(frame);
    expect(imported.merges).toEqual([{ row: 0, col: 0, row_span: 2, col_span: 2 }]);
    const report = verifyTableMergeRoundTrip(table);
    expect(report.merge_count).toBe(1);
    expect(report.merges).toEqual([{ row: 0, col: 0, row_span: 2, col_span: 2 }]);
  });

  it('反向对照：篡改渲染 XML 的 hMerge ⇒ merge_readback_mismatch（读回不是回显输入）', () => {
    const table = mergedTableDeck();
    const frame = renderTableFrameXml(table);
    const tampered = frame.replace('hMerge="1"', 'hMerge="0"');
    expect(tampered).not.toBe(frame);
    try {
      verifyTableMergeRoundTrip(table, { frame_xml: tampered });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationTableError);
      expect((error as PresentationTableError).reason).toBe('merge_readback_mismatch');
    }
  });
});

// ---------------------------------------------------------------------------
// D. 反向对照：篡改字节必须具名红
// ---------------------------------------------------------------------------

describe('D. 反向对照：篡改真字节 / 伪造版本必须具名红', () => {
  it('偷改嵌入工作簿的一处数值 ⇒ verifyChartPackage 报 chart_data_desync，指纹也对不上', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(DATA);
    const pkg = renderChartPackageFromSnapshot(snapshot);
    const tampered = patchEmbeddedWorkbook(pkg.bytes, '<v>2.25</v>', '<v>9.99</v>');
    try {
      verifyChartPackage(tampered);
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationChartError);
      expect((error as PresentationChartError).reason).toBe('chart_data_desync');
    }
    // 独立解码：工作簿变了，图表缓存没变 ⇒ 两个指纹不再相等。
    const tamperedWorkbook = readZip(tampered).by_path.get('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    const workbookVersion = dataVersionOf(decodeXlsxToData(tamperedWorkbook?.data ?? new Uint8Array()));
    const chartVersion = dataVersionOf(decodeChartCache(tampered));
    expect(workbookVersion).not.toBe(chartVersion);
    // 原件仍通过。
    expect(verifyChartPackage(pkg.bytes).series).toBe(2);
  });

  it('偷改图表缓存的一个值（工作簿没变）⇒ verifyChartPackage 报 chart_data_desync', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(DATA);
    const pkg = renderChartPackageFromSnapshot(snapshot);
    const tampered = patchChartCache(pkg.bytes, '<c:v>1.5</c:v>', '<c:v>7.5</c:v>');
    try {
      verifyChartPackage(tampered);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationChartError).reason).toBe('chart_data_desync');
    }
    expect(decodeChartCache(tampered).series[0]?.values[0]).toBe(7.5);
  });

  it('伪造快照版本 ⇒ renderChartPackageFromSnapshot 报 chart_version_mismatch', () => {
    const snapshot: ChartDataSnapshot = snapshotChartData(DATA);
    const forged: ChartDataSnapshot = { ...snapshot, version: 'dc1-00000000' };
    try {
      renderChartPackageFromSnapshot(forged);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationChartError).reason).toBe('chart_version_mismatch');
    }
  });
});

/** 独立解码工作簿字节 → 数据（供反向对照算指纹）。 */
function decodeXlsxToData(workbookBytes: Uint8Array): ExpectedChartData {
  return dataFromXlsx(decodeXlsxCells(workbookBytes));
}
