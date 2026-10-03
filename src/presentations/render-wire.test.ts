/**
 * FA-PPT-WIRE：把"模型层有、导出发不出"的三处接到渲染链的用例。
 *
 * 覆盖（每条都带**反向对照**，既证"新输入能发出"，又证"旧输入的字节没被改动"）：
 *
 * 1. **隐藏页** → `p:sld@show="0"`；导入读回 `hidden` 仍为真；不隐藏的页字节不变；
 * 2. **段落行距 / 显式缩进** → `a:lnSpc`（`a:spcPct` / `a:spcPts`）与 `a:pPr@marL`；
 *    XML 读回与模型一致；不设时产物零变化；
 * 3. **合并单元格表格** → `a:gridSpan` / `a:rowSpan` / `a:hMerge` / `a:vMerge`；
 *    span 越界**仍必须抛错**；无合并时产物零变化；
 * 4. **图表接线** → `slide → chart → embedded workbook` 完整部件图 + 关系 + `[Content_Types].xml`；
 *    缺嵌入工作簿被 `verifyChartPackage` 抓到。
 *
 * 边界：本文件只做**字节级 + 解析级**校验；真机 PowerPoint / WPS 与桌面 Office 打开播放
 * **未验证**（本工作包不触设备）。
 */

import { describe, expect, it } from 'vitest';

import { readZip, writeZip, type ReadZipArchive } from '../artifacts/ooxml/index.js';
import { insertChart, verifyChartPackage, PresentationChartError } from './charts.js';
import { transform, type Presentation, type Shape } from './model.js';
import { addSlide, addShape, setSlideHidden } from './operations.js';
import {
  PresentationRenderError,
  emptyPresentation,
  renderPresentation,
} from './render.js';
import { comparePresentationFiles, importPresentation } from './roundtrip.js';
import { addTable, mergeCells } from './tables.js';
import { setIndentEmu, setLineSpacing } from './text.js';
import { attributeOf, childElements, firstElement, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function deckWithSlides(count: number): Presentation {
  let deck = emptyPresentation('p1', '接线测试');
  for (let index = 0; index < count; index += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function textOf(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return Buffer.from(entry.data).toString('utf8');
}

/** 递归收集某限定名的元素（文档顺序）。 */
function collect(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) collect(child, name, out);
  return out;
}

/** 给某页插一个两段文本框（供行距 / 缩进用例）。 */
function withBodyBox(deck: Presentation): Presentation {
  const slideId = deck.slides[0]?.slide_id ?? 0;
  const body: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: 'Body',
    transform: transform(838200, 457200, 7772400, 3076575),
    text: {
      paragraphs: [
        { runs: [{ source: { kind: 'literal', text: '第一段' } }], level: 0, alignment: 'left', bullet: true },
        { runs: [{ source: { kind: 'literal', text: '第二段' } }], level: 0, alignment: 'left', bullet: true },
      ],
    },
  };
  return addShape(deck, slideId, body);
}

// ---------------------------------------------------------------------------
// 1. 隐藏幻灯片
// ---------------------------------------------------------------------------

describe('PPT-02：隐藏页 ⇒ p:sld@show="0"，往返读回 hidden 仍为真', () => {
  it('隐藏的页写 show="0"，未隐藏的页不写；导入读回 hidden 保真', () => {
    let deck = deckWithSlides(2);
    const firstSlide = deck.slides[0];
    if (firstSlide === undefined) throw new Error('应有第 1 页');
    deck = setSlideHidden(deck, firstSlide.slide_id, true);

    const rendered = renderPresentation(deck);
    const archive = readZip(rendered.bytes);
    const slide1 = textOf(archive, 'ppt/slides/slide1.xml');
    const slide2 = textOf(archive, 'ppt/slides/slide2.xml');

    expect(slide1).toContain('show="0"');
    expect(slide2).not.toContain('show="0"');

    // 属性确实落在 p:sld 根元素上（不是别的元素）。
    const root = parseXmlDocument(slide1);
    expect(root.name).toBe('p:sld');
    expect(attributeOf(root, 'show')).toBe('0');
    const root2 = parseXmlDocument(slide2);
    expect(attributeOf(root2, 'show')).toBeUndefined();

    // 往返：导入侧读 p:sld@show ⇒ hidden 为真。
    const reread = importPresentation(rendered.bytes);
    expect(reread.presentation.slides[0]?.hidden).toBe(true);
    expect(reread.presentation.slides[1]?.hidden).toBe(false);
  });

  it('反向对照：不隐藏时产物不含 show 属性；隐藏只改动那一页部件', () => {
    const visible = renderPresentation(deckWithSlides(2));
    const visibleSlide = textOf(readZip(visible.bytes), 'ppt/slides/slide1.xml');
    expect(visibleSlide).not.toContain('show=');

    let deck = deckWithSlides(2);
    const firstSlide = deck.slides[0];
    if (firstSlide === undefined) throw new Error('应有第 1 页');
    deck = setSlideHidden(deck, firstSlide.slide_id, true);
    const hidden = renderPresentation(deck);

    const comparison = comparePresentationFiles(visible.bytes, hidden.bytes);
    expect(comparison.changed_part_paths).toEqual(['ppt/slides/slide1.xml']);
    expect(comparison.added_part_paths).toEqual([]);
    expect(comparison.removed_part_paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 段落行距 / 显式缩进
// ---------------------------------------------------------------------------

describe('PPT-04：段落行距 / 显式缩进 ⇒ a:lnSpc 与 a:pPr@marL', () => {
  it('倍数行距 ⇒ a:spcPct；固定行距 ⇒ a:spcPts；缩进 ⇒ marL；XML 读回一致', () => {
    let deck = withBodyBox(deckWithSlides(1));
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const target0 = { slide_id: slideId, shape_id: 2, paragraph_index: 0 };
    deck = setLineSpacing(deck, target0, { kind: 'percent', value: 150 });
    deck = setIndentEmu(deck, target0, 457200);
    deck = setLineSpacing(deck, { ...target0, paragraph_index: 1 }, { kind: 'points', value: 20 });

    const slide = textOf(readZip(renderPresentation(deck).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('<a:lnSpc><a:spcPct val="150000"/></a:lnSpc>');
    expect(slide).toContain('<a:lnSpc><a:spcPts val="2000"/></a:lnSpc>');
    expect(slide).toContain('marL="457200"');

    // 读回（真 XML 解析器）：marL 与 lnSpc 的取值与模型一致。
    const root = parseXmlDocument(slide);
    const pPrs = collect(root, 'a:pPr');
    const withIndent = pPrs.find((p) => attributeOf(p, 'marL') !== undefined);
    expect(withIndent).toBeDefined();
    expect(attributeOf(withIndent, 'marL')).toBe('457200');
    const percent = firstElement(firstElement(withIndent, 'a:lnSpc'), 'a:spcPct');
    expect(attributeOf(percent, 'val')).toBe('150000');

    const withPoints = pPrs.find((p) => firstElement(firstElement(p, 'a:lnSpc'), 'a:spcPts') !== undefined);
    expect(withPoints).toBeDefined();
    expect(attributeOf(firstElement(firstElement(withPoints, 'a:lnSpc'), 'a:spcPts'), 'val')).toBe('2000');
  });

  it('反向对照：不设行距 / 缩进 ⇒ 不写 a:lnSpc / marL，且只改这一页部件', () => {
    const plain = renderPresentation(withBodyBox(deckWithSlides(1)));
    const plainSlide = textOf(readZip(plain.bytes), 'ppt/slides/slide1.xml');
    expect(plainSlide).not.toContain('a:lnSpc');
    expect(plainSlide).not.toContain('marL=');
    expect(plainSlide).not.toContain('a:spcPct');
    expect(plainSlide).not.toContain('a:spcPts');

    let deck = withBodyBox(deckWithSlides(1));
    const slideId = deck.slides[0]?.slide_id ?? 0;
    deck = setLineSpacing(deck, { slide_id: slideId, shape_id: 2, paragraph_index: 0 }, { kind: 'percent', value: 120 });
    const spaced = renderPresentation(deck);

    const comparison = comparePresentationFiles(plain.bytes, spaced.bytes);
    expect(comparison.changed_part_paths).toEqual(['ppt/slides/slide1.xml']);
    expect(comparison.added_part_paths).toEqual([]);
    expect(comparison.removed_part_paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 合并单元格表格
// ---------------------------------------------------------------------------

describe('PPT-08：合并单元格表格 ⇒ gridSpan / rowSpan / hMerge / vMerge', () => {
  it('横向 + 纵向合并都渲染出合并属性，续格为空体', () => {
    let deck = deckWithSlides(1);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const added = addTable(deck, slideId, {
      shape_id: 2,
      name: 'T',
      transform: transform(0, 0, 5000000, 2000000),
      rows: 2,
      columns: 3,
      texts: [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
      ],
    });
    let withTable = mergeCells(added.presentation, slideId, added.shape_id, { row: 0, col: 0, row_span: 1, col_span: 2 });
    withTable = mergeCells(withTable, slideId, added.shape_id, { row: 0, col: 2, row_span: 2, col_span: 1 });

    const slide = textOf(readZip(renderPresentation(withTable).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('<a:tc gridSpan="2">');
    expect(slide).toContain('<a:tc hMerge="1">');
    expect(slide).toContain('<a:tc rowSpan="2">');
    expect(slide).toContain('<a:tc vMerge="1">');
    // 6 个网格格（2 行 × 3 列）；合并只改属性，不改格数（`<a:tc>` / `<a:tc …>`，排除 `<a:tcPr…>`）。
    expect((slide.match(/<a:tc[ >]/g) ?? []).length).toBe(6);
    // 源格文本仍在，且没有被搬到续格。
    expect(slide).toContain('<a:t>a</a:t>');
    expect(slide).toContain('<a:t>d</a:t>');

    // 读回：gridSpan 单元格的 gridSpan 值为 2。
    const root = parseXmlDocument(slide);
    const gridSpanCell = collect(root, 'a:tc').find((tc) => attributeOf(tc, 'gridSpan') !== undefined);
    expect(attributeOf(gridSpanCell, 'gridSpan')).toBe('2');
  });

  it('span 越界 ⇒ 仍抛 unsupported_merge_span（不产出半张表）', () => {
    let deck = deckWithSlides(1);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const table: Shape = {
      kind: 'table',
      shape_id: 2,
      name: 'Bad',
      transform: transform(0, 0, 5000000, 2000000),
      column_widths_emu: [1000000, 1000000],
      rows: [{ cells: [{ text: null, col_span: 3, row_span: 1 }, { text: null, col_span: 1, row_span: 1 }] }],
    };
    deck = addShape(deck, slideId, table);

    expect(() => renderPresentation(deck)).toThrow(PresentationRenderError);
    try {
      renderPresentation(deck);
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_merge_span');
    }
  });

  it('行格数与列数不符（网格规划失败）⇒ 同样抛 unsupported_merge_span', () => {
    let deck = deckWithSlides(1);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const table: Shape = {
      kind: 'table',
      shape_id: 2,
      name: 'Mismatch',
      transform: transform(0, 0, 5000000, 2000000),
      column_widths_emu: [1000000, 1000000, 1000000],
      rows: [{ cells: [{ text: null, col_span: 2, row_span: 1 }, { text: null, col_span: 1, row_span: 1 }] }],
    };
    deck = addShape(deck, slideId, table);

    try {
      renderPresentation(deck);
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_merge_span');
    }
  });

  it('反向对照：无合并的表格不写任何合并属性，且并合并后只改这一页部件', () => {
    let deck = deckWithSlides(1);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const added = addTable(deck, slideId, {
      shape_id: 2,
      name: 'Plain',
      transform: transform(0, 0, 5000000, 2000000),
      rows: 2,
      columns: 2,
      texts: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    });

    const plain = renderPresentation(added.presentation);
    const plainSlide = textOf(readZip(plain.bytes), 'ppt/slides/slide1.xml');
    for (const attribute of ['gridSpan', 'rowSpan', 'hMerge', 'vMerge']) {
      expect(plainSlide).not.toContain(attribute);
    }

    const merged = mergeCells(added.presentation, slideId, added.shape_id, { row: 0, col: 0, row_span: 1, col_span: 2 });
    const mergedBytes = renderPresentation(merged);
    const comparison = comparePresentationFiles(plain.bytes, mergedBytes.bytes);
    expect(comparison.changed_part_paths).toEqual(['ppt/slides/slide1.xml']);
    expect(comparison.added_part_paths).toEqual([]);
    expect(comparison.removed_part_paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 图表接线
// ---------------------------------------------------------------------------

function deckWithChart(): Presentation {
  let deck = deckWithSlides(1);
  const slideId = deck.slides[0]?.slide_id ?? 0;
  const inserted = insertChart(deck, slideId, {
    transform: transform(838200, 457200, 6096000, 4064000),
    chart: {
      chart_type: 'bar',
      categories: ['一月', '二月', '三月'],
      series: [{ name: '销量', values: [1, 2, 3] }],
      title: '季度销量',
    },
  });
  return inserted.presentation;
}

describe('PPT-09：图表接通 slide → chart → embedded workbook', () => {
  it('产出图表部件 + 嵌入工作簿 + _rels 关系 + [Content_Types].xml 覆盖项', () => {
    const rendered = renderPresentation(deckWithChart());
    const archive = readZip(rendered.bytes);

    expect(archive.by_path.has('ppt/charts/chart1.xml')).toBe(true);
    expect(archive.by_path.has('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx')).toBe(true);

    // Content_Types：两份部件都拿到 Override。
    const contentTypes = textOf(archive, '[Content_Types].xml');
    expect(contentTypes).toContain('<Override PartName="/ppt/charts/chart1.xml"');
    expect(contentTypes).toContain('drawingml.chart+xml');
    expect(contentTypes).toContain('<Override PartName="/ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"');
    expect(contentTypes).toContain('spreadsheetml.sheet');

    // 幻灯片侧：图表帧 + 指向图表部件的关系（rId1 = 版式，rId2 = 图表）。
    const slide = textOf(archive, 'ppt/slides/slide1.xml');
    expect(slide).toContain('<p:graphicFrame');
    expect(slide).toContain('uri="http://schemas.openxmlformats.org/drawingml/2006/chart"');
    expect(slide).toContain('<c:chart r:id="rId2"/>');

    const slideRels = textOf(archive, 'ppt/slides/_rels/slide1.xml.rels');
    expect(slideRels).toContain('relationships/chart');
    expect(slideRels).toContain('../charts/chart1.xml');

    // 图表侧：指向嵌入工作簿的 package 关系。
    const chartRels = textOf(archive, 'ppt/charts/_rels/chart1.xml.rels');
    expect(chartRels).toContain('relationships/package');
    expect(chartRels).toContain('../embeddings/Microsoft_Excel_Worksheet1.xlsx');

    // 读回校验：成对 + 缓存与嵌入工作表逐点一致。
    const report = verifyChartPackage(rendered.bytes);
    expect(report.chart_path).toBe('ppt/charts/chart1.xml');
    expect(report.workbook_path).toBe('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    expect(report.categories).toBe(3);
    expect(report.series).toBe(1);
  });

  it('缺嵌入工作簿 ⇒ verifyChartPackage 抓到（chart_part_unpaired）', () => {
    const rendered = renderPresentation(deckWithChart());
    const archive = readZip(rendered.bytes);
    const entries = archive.entries
      .filter((entry) => entry.path !== 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx')
      .map((entry) => ({ path: entry.path, data: entry.data }));
    const broken = writeZip(entries);

    expect(() => verifyChartPackage(broken)).toThrow(PresentationChartError);
    try {
      verifyChartPackage(broken);
      throw new Error('应当抛出 PresentationChartError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationChartError);
      expect((error as PresentationChartError).reason).toBe('chart_part_unpaired');
    }
  });

  it('两个图表各得一份部件（chart1 / chart2），关系各自指对', () => {
    let deck = deckWithSlides(2);
    const firstSlideId = deck.slides[0]?.slide_id ?? 0;
    const secondSlideId = deck.slides[1]?.slide_id ?? 0;
    deck = insertChart(deck, firstSlideId, {
      shape_id: 2,
      transform: transform(838200, 457200, 6096000, 4064000),
      chart: { chart_type: 'bar', categories: ['A'], series: [{ name: 's', values: [1] }], title: null },
    }).presentation;
    deck = insertChart(deck, secondSlideId, {
      shape_id: 2,
      transform: transform(838200, 457200, 6096000, 4064000),
      chart: { chart_type: 'pie', categories: ['甲', '乙'], series: [{ name: '占比', values: [4, 6] }], title: null },
    }).presentation;

    const archive = readZip(renderPresentation(deck).bytes);
    expect(archive.by_path.has('ppt/charts/chart1.xml')).toBe(true);
    expect(archive.by_path.has('ppt/charts/chart2.xml')).toBe(true);
    expect(archive.by_path.has('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx')).toBe(true);
    expect(archive.by_path.has('ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx')).toBe(true);
    expect(textOf(archive, 'ppt/slides/_rels/slide2.xml.rels')).toContain('../charts/chart2.xml');
  });

  it('反向对照：无图表的文稿不产出任何图表 / 嵌入工作簿部件', () => {
    const archived = readZip(renderPresentation(deckWithSlides(1)).bytes);
    expect(archived.by_path.has('ppt/charts/chart1.xml')).toBe(false);
    expect(archived.entries.some((entry) => entry.path.startsWith('ppt/charts/'))).toBe(false);
    expect(archived.entries.some((entry) => entry.path.startsWith('ppt/embeddings/'))).toBe(false);
  });
});
