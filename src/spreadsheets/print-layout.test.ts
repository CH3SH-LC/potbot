/**
 * `print-layout.ts` 的验收用例（design-06-P8 / XLS-16）。
 *
 * **判据不是"函数返回了东西"，而是"写进部件的 XML 里有什么"**：用例把产出的元素
 * 序列化后用仓内的 `parseXml` **读回来**逐项核对；注入函数则直接作用在
 * `xlsx-write.ts` 真实产出的工作表 / 工作簿 XML 上。
 *
 * 每个能力都配一条**反向对照**：打印分页不能"只导出可见首屏"、无意义的页眉页脚字段
 * 不能静默丢弃、越界设置不能静默接受。
 *
 * **未验证（需真机 / 消费端）**：真实打印机 / PDF 端按这些设置出纸，本轮**没有消费端**。
 */

import { describe, expect, it } from 'vitest';

import { serializeXmlDocument, serializeXmlNode, type XmlElement } from '../artifacts/ooxml/index.js';
import { SPREADSHEETML_NAMESPACE } from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  findChild,
  parseXml,
  directText,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import {
  DEFAULT_MARGINS,
  HEADER_FOOTER_FIELD_CODES,
  PAPER_SIZES,
  buildDefinedNamesElement,
  buildHeaderFooterElement,
  buildPageMarginsElement,
  buildPageSetupElement,
  createPrintLayout,
  createPrintPlan,
  expandHeaderFooterFields,
  formatPrintArea,
  getSheetPrint,
  insertDefinedNamesXml,
  insertSheetPrintXml,
  isDefaultPrintLayout,
  parsePrintAreaDefinedName,
  parsePrintAreas,
  printDefinedNames,
  quoteSheetName,
  serializeHeaderFooterTokens,
  setFitToPages,
  setHeaderFooter,
  setMargins,
  setOrientation,
  setPageBreaks,
  setPaperSize,
  setPrintArea,
  setPrintOptions,
  setPrintTitles,
  setScalePercent,
  setSheetPrint,
  sheetPrintElements,
  tokenizeHeaderFooter,
  type PrintLayout,
} from './print-layout.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook } from './workbook.js';
import { textValue } from './value.js';
import { buildSheetXml, buildWorkbookXml } from './xlsx-write.js';

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

function roundTrip(element: XmlElement): ParsedXmlElement {
  return parseXml(serializeXmlDocument(element));
}

function childNames(root: ParsedXmlElement): readonly string[] {
  return childElements(root).map((child) => child.localName);
}

function baseSheetXml(): string {
  const sheet = setCellValue(createSheet('预算', { row_count: 4, column_count: 7 }), 'A1', textValue('项目'));
  return buildSheetXml(sheet, new Map(), true);
}

// ---------------------------------------------------------------------------
// 默认布局：什么都没设 ⇒ 不往文件里写多余字节
// ---------------------------------------------------------------------------

describe('默认布局', () => {
  it('空布局不产出任何打印元素，也不产出 definedNames', () => {
    const layout = createPrintLayout();
    expect(isDefaultPrintLayout(layout)).toBe(true);
    expect(sheetPrintElements(layout)).toHaveLength(0);
    expect(buildDefinedNamesElement(setSheetPrint(createPrintPlan(), '预算', layout), ['预算'])).toBeNull();
  });

  it('反向对照：只设方向也**不**凭空生成 definedNames（definedName 只管打印区域 / 重复标题）', () => {
    const layout = setOrientation(createPrintLayout(), 'landscape');
    expect(buildDefinedNamesElement(setSheetPrint(createPrintPlan(), '预算', layout), ['预算'])).toBeNull();
  });

  it('注入函数对默认布局是恒等的（文件字节不变）', () => {
    const xml = baseSheetXml();
    expect(insertSheetPrintXml(xml, createPrintLayout())).toBe(xml);
    const workbookXml = buildWorkbookXml(createWorkbook());
    const plan = setSheetPrint(createPrintPlan(), 'Sheet1', createPrintLayout());
    expect(insertDefinedNamesXml(workbookXml, plan, ['Sheet1'])).toBe(workbookXml);
  });
});

// ---------------------------------------------------------------------------
// 打印区域 / 重复标题 → definedNames
// ---------------------------------------------------------------------------

describe('打印区域与重复标题（definedNames）', () => {
  it('打印区域被归一化为两端绝对区域', () => {
    const layout = setPrintArea(createPrintLayout(), 'a1:g20');
    expect(layout.print_area).toBe('$A$1:$G$20');
  });

  it('_xlnm.Print_Area 带 localSheetId 与 工作表!区域', () => {
    const plan = setSheetPrint(createPrintPlan(), '预算', setPrintArea(createPrintLayout(), 'A1:G20'));
    const names = printDefinedNames(plan, ['说明', '预算']);
    expect(names).toHaveLength(1);
    expect(names[0]?.name).toBe('_xlnm.Print_Area');
    expect(names[0]?.local_sheet_id).toBe(1); // 第二张表
    expect(names[0]?.text).toBe("'预算'!$A$1:$G$20");
  });

  it('_xlnm.Print_Titles 固定列在前、行在后', () => {
    const layout = createPrintLayout({ repeat_columns: 'a:b', repeat_rows: '1:3' });
    expect(layout.repeat_columns).toBe('A:B');
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);
    const names = printDefinedNames(plan, ['预算']);
    expect(names.map((entry) => entry.name)).toEqual(['_xlnm.Print_Titles']);
    expect(names[0]?.text).toBe("'预算'!$A:$B,'预算'!$1:$3");
  });

  it('读回来：definedNames 里两条 definedName 的属性与文本都对', () => {
    const layout = createPrintLayout({ print_area: 'A1:G20', repeat_rows: '1:1' });
    const element = buildDefinedNamesElement(setSheetPrint(createPrintPlan(), 'Sheet1', layout), ['Sheet1']);
    expect(element).not.toBeNull();
    const root = roundTrip(element as XmlElement);
    const names = childElements(root);
    expect(names).toHaveLength(2);
    expect(attributeValue(names[0] as ParsedXmlElement, '', 'name')).toBe('_xlnm.Print_Area');
    expect(attributeValue(names[0] as ParsedXmlElement, '', 'localSheetId')).toBe('0');
    expect(directText(names[0] as ParsedXmlElement)).toBe('Sheet1!$A$1:$G$20');
    expect(attributeValue(names[1] as ParsedXmlElement, '', 'name')).toBe('_xlnm.Print_Titles');
    expect(directText(names[1] as ParsedXmlElement)).toBe('Sheet1!$1:$1');
  });

  it('工作表名含空格 / 中文 / 单引号时加引号并翻倍', () => {
    expect(quoteSheetName('Sheet1')).toBe('Sheet1');
    expect(quoteSheetName('预算 表')).toBe("'预算 表'");
    expect(quoteSheetName("O'Brien")).toBe("'O''Brien'");
  });

  it('反向对照：计划引用了不存在的工作表 ⇒ 显式抛错，不静默丢弃打印设置', () => {
    const plan = setSheetPrint(createPrintPlan(), '幽灵表', setPrintArea(createPrintLayout(), 'A1:B2'));
    expect(() => printDefinedNames(plan, ['预算'])).toThrow(/不存在的工作表/);
  });
});

// ---------------------------------------------------------------------------
// 分页：必须落进文件（不能只导出可见首屏）
// ---------------------------------------------------------------------------

describe('分页（不能只导出可见首屏）', () => {
  it('手工分页符去重并排序，写进 rowBreaks / colBreaks', () => {
    const layout = setPageBreaks(createPrintLayout(), { rows: [50, 10, 10], columns: [3] });
    expect(layout.row_breaks).toEqual([10, 50]);

    const elements = sheetPrintElements(layout).map((element) => serializeXmlNode(element)).join('');
    expect(elements).toContain('<rowBreaks count="2" manualBreakCount="2">');
    const parsed = roundTrip(sheetPrintElements(layout).find((el) => el.name === 'rowBreaks') as XmlElement);
    const breaks = childElements(parsed);
    expect(breaks.map((brk) => attributeValue(brk, '', 'id'))).toEqual(['10', '50']);
    expect(breaks.every((brk) => attributeValue(brk, '', 'man') === '1')).toBe(true);
  });

  it('落进真实部件：注入既有工作表 XML 后 sheetData 原样保留、分页信息新增', () => {
    const layout = setPageBreaks(createPrintLayout(), { rows: [50] });
    const injected = insertSheetPrintXml(baseSheetXml(), layout);
    const root = parseXml(injected);
    expect(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetData')).not.toBeNull();
    const rowBreaks = findChild(root, SPREADSHEETML_NAMESPACE, 'rowBreaks');
    expect(rowBreaks).not.toBeNull();
    expect(attributeValue(rowBreaks as ParsedXmlElement, '', 'count')).toBe('1');
  });

  it('幂等：重复注入不会产生两个 rowBreaks', () => {
    const layout = setPageBreaks(createPrintLayout(), { rows: [50] });
    const once = insertSheetPrintXml(baseSheetXml(), layout);
    const twice = insertSheetPrintXml(once, layout);
    const root = parseXml(twice);
    expect(childNames(root).filter((name) => name === 'rowBreaks')).toHaveLength(1);
  });

  it('反向对照：只导出"可见首屏"会丢掉分页信息，本模块不会', () => {
    // 表里只有 A1 有内容（可见首屏 = A1），但打印设置要求打到第 100 行、并在第 50 行分页。
    const layout = createPrintLayout({ print_area: 'A1:G100', row_breaks: [50], orientation: 'portrait' });
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);

    // 朴素"可见首屏导出"：只看 sheet.dimension，既无分页符也无全区域打印区域。
    const naiveVisibleArea = '$A$1';
    const naiveXml = serializeXmlNode(buildPageSetupElement(layout) as XmlElement);

    const names = printDefinedNames(plan, ['预算']);
    expect(names[0]?.text).toBe("'预算'!$A$1:$G$100");
    expect(names[0]?.text).not.toContain(naiveVisibleArea + '!'); // 没被截成 A1
    expect(naiveXml).not.toContain('rowBreaks');
    expect(
      sheetPrintElements(layout)
        .map((element) => serializeXmlNode(element))
        .join(''),
    ).toContain('rowBreaks');
  });
});

// ---------------------------------------------------------------------------
// 方向 / 纸张 / 边距 / 缩放 / 打印选项
// ---------------------------------------------------------------------------

describe('页面设置元素', () => {
  it('方向、纸张、百分比缩放写进 pageSetup', () => {
    let layout = setOrientation(createPrintLayout(), 'landscape');
    layout = setPaperSize(layout, 'a4');
    layout = setScalePercent(layout, 80);
    const setup = buildPageSetupElement(layout);
    expect(setup).not.toBeNull();
    const parsed = roundTrip(setup as XmlElement);
    expect(attributeValue(parsed, '', 'orientation')).toBe('landscape');
    expect(attributeValue(parsed, '', 'paperSize')).toBe(String(PAPER_SIZES.a4));
    expect(attributeValue(parsed, '', 'scale')).toBe('80');
    expect(attributeValue(parsed, '', 'fitToWidth')).toBeNull();
  });

  it('适配页宽高：写 fitToWidth / fitToHeight，且补 sheetPr/pageSetUpPr fitToPage（否则不生效）', () => {
    const layout = setFitToPages(createPrintLayout(), 1, 0);
    const setup = roundTrip(buildPageSetupElement(layout) as XmlElement);
    expect(attributeValue(setup, '', 'fitToWidth')).toBe('1');
    expect(attributeValue(setup, '', 'fitToHeight')).toBe('0');
    const elements = sheetPrintElements(layout);
    expect(elements[0]?.name).toBe('sheetPr');
    const injected = parseXml(insertSheetPrintXml(baseSheetXml(), layout));
    const pageSetUpPr = findChild(findChild(injected, SPREADSHEETML_NAMESPACE, 'sheetPr'), SPREADSHEETML_NAMESPACE, 'pageSetUpPr');
    expect(attributeValue(pageSetUpPr as ParsedXmlElement, '', 'fitToPage')).toBe('1');
  });

  it('百分比缩放**不**补 pageSetUpPr（只按比例，不需要 fitToPage）', () => {
    const layout = setScalePercent(createPrintLayout(), 75);
    expect(sheetPrintElements(layout).some((element) => element.name === 'sheetPr')).toBe(false);
    const injected = parseXml(insertSheetPrintXml(baseSheetXml(), layout));
    expect(findChild(injected, SPREADSHEETML_NAMESPACE, 'sheetPr')).toBeNull();
  });

  it('边距按英寸写出六项', () => {
    const parsed = roundTrip(buildPageMarginsElement(setMargins(createPrintLayout(), DEFAULT_MARGINS)) as XmlElement);
    expect(attributeValue(parsed, '', 'left')).toBe('0.7');
    expect(attributeValue(parsed, '', 'top')).toBe('0.75');
    expect(attributeValue(parsed, '', 'header')).toBe('0.3');
  });

  it('打印选项只写显式给出的项', () => {
    const layout = setPrintOptions(createPrintLayout(), { grid_lines: true, horizontal_centered: true });
    const parsed = roundTrip(sheetPrintElements(layout).find((el) => el.name === 'printOptions') as XmlElement);
    expect(attributeValue(parsed, '', 'gridLines')).toBe('1');
    expect(attributeValue(parsed, '', 'horizontalCentered')).toBe('1');
    expect(attributeValue(parsed, '', 'headings')).toBeNull();
  });

  it('反向对照：越界 / 非法设置显式抛错，不静默接受', () => {
    expect(() => setOrientation(createPrintLayout(), 'sideways' as never)).toThrow();
    expect(() => setPaperSize(createPrintLayout(), 'b0' as never)).toThrow();
    expect(() => setMargins(createPrintLayout(), { ...DEFAULT_MARGINS, left: -1 })).toThrow(/非负/);
    expect(() => setPrintArea(createPrintLayout(), 'not-a-range')).toThrow();
    expect(() => setPrintTitles(createPrintLayout(), { rows: '5:2' })).toThrow();
    expect(() => setPageBreaks(createPrintLayout(), { rows: [0] })).toThrow();
    expect(() => setScalePercent(createPrintLayout(), 5)).toThrow();
    expect(() => setFitToPages(createPrintLayout(), 0, 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 页眉页脚
// ---------------------------------------------------------------------------

describe('页眉页脚', () => {
  it('奇偶页不同：写 differentOddEven 与 oddHeader / evenHeader', () => {
    const layout = setHeaderFooter(createPrintLayout(), {
      different_odd_even: true,
      odd_header: '&L预算表&C第 &P 页 / 共 &N 页',
      even_header: '&R偶页',
      odd_footer: '&C机密',
    });
    const parsed = roundTrip(buildHeaderFooterElement(layout) as XmlElement);
    expect(attributeValue(parsed, '', 'differentOddEven')).toBe('1');
    expect(childNames(parsed)).toEqual(['oddHeader', 'oddFooter', 'evenHeader']);
    const header = childElements(parsed).find((child) => child.localName === 'oddHeader');
    expect(directText(header as ParsedXmlElement)).toBe('&L预算表&C第 &P 页 / 共 &N 页');
  });

  it('反向对照：给了 even_header 却没开 different_odd_even ⇒ 抛错（不静默丢弃）', () => {
    expect(() =>
      setHeaderFooter(createPrintLayout(), { even_header: '&C偶页', odd_header: '&C奇页' }),
    ).toThrow(/different_odd_even/);
    expect(() =>
      setHeaderFooter(createPrintLayout(), { different_odd_even: true, first_header: '&C首页' }),
    ).toThrow(/different_first/);
    expect(() => setHeaderFooter(createPrintLayout(), {})).toThrow(/未给出任何页眉/);
  });

  it('headerFooter 排在 pageSetup 之后、rowBreaks 之前（CT_Worksheet 序列）', () => {
    let layout = setOrientation(createPrintLayout(), 'portrait');
    layout = setHeaderFooter(layout, { odd_footer: '&C页脚' });
    layout = setPageBreaks(layout, { rows: [3] });
    expect(sheetPrintElements(layout).map((element) => element.name)).toEqual([
      'pageSetup',
      'headerFooter',
      'rowBreaks',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 注入既有部件：位置与幂等
// ---------------------------------------------------------------------------

describe('注入既有部件 XML', () => {
  it('打印元素按 CT_Worksheet 序列插到 mergeCells 之后、drawing 之前', () => {
    const sheet = createSheet('预算', { merged: ['A1:B1'] });
    const source = buildSheetXml(sheet, new Map(), true);
    let layout = setPrintOptions(createPrintLayout(), { grid_lines: true });
    layout = setOrientation(layout, 'landscape');
    layout = setHeaderFooter(layout, { odd_footer: '&C页脚' });
    layout = setPageBreaks(layout, { columns: [2] });
    const names = childNames(parseXml(insertSheetPrintXml(source, layout)));
    expect(names).toEqual([
      'dimension',
      'sheetViews',
      'sheetData',
      'mergeCells',
      'printOptions',
      'pageSetup',
      'headerFooter',
      'colBreaks',
    ]);
  });

  it('definedNames 插在 <sheets> 与 <calcPr> 之间', () => {
    const workbookXml = buildWorkbookXml(createWorkbook());
    const plan = setSheetPrint(createPrintPlan(), 'Sheet1', setPrintArea(createPrintLayout(), 'A1:C9'));
    const names = childNames(parseXml(insertDefinedNamesXml(workbookXml, plan, ['Sheet1'])));
    expect(names).toEqual(['bookViews', 'sheets', 'definedNames', 'calcPr']);
  });

  it('既有 sheetPr 被保留，pageSetUpPr 并进末尾（不覆盖 tabColor 等）', () => {
    const source =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
      '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>' +
      '<dimension ref="A1:B2"/><sheetData/></worksheet>';
    const layout = setFitToPages(createPrintLayout(), 1, 1);
    const root = parseXml(insertSheetPrintXml(source, layout));
    const sheetPr = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetPr');
    expect(childNames(sheetPr as ParsedXmlElement)).toEqual(['tabColor', 'pageSetUpPr']);
    expect(childNames(root)[0]).toBe('sheetPr');
  });

  it('计划查询：同名覆盖并保留顺序', () => {
    let plan = setSheetPrint(createPrintPlan(), '预算', setPrintArea(createPrintLayout(), 'A1:B2'));
    plan = setSheetPrint(plan, '说明', createPrintLayout());
    plan = setSheetPrint(plan, '预算', setPrintArea(createPrintLayout(), 'A1:C3'));
    expect(plan.entries.map((entry) => entry.sheet)).toEqual(['说明', '预算']);
    expect(getSheetPrint(plan, '预算')?.print_area).toBe('$A$1:$C$3');
  });

  it('全部元素一起序列化后仍是合法 XML（读回来不抛）', () => {
    const layout = createPrintLayout({
      print_area: 'A1:G20',
      orientation: 'landscape',
      paper_size: 'a3',
      margins: DEFAULT_MARGINS,
      repeat_rows: '1:2',
      repeat_columns: 'A:A',
      scaling: { kind: 'fit_to_pages', width: 1, height: 0 },
      header_footer: { different_first: true, odd_header: '&L表', first_header: '&C首页' },
      options: { grid_lines: true, vertical_centered: true },
      row_breaks: [10],
      column_breaks: [4],
    });
    const injected = insertSheetPrintXml(baseSheetXml(), layout);
    expect(() => parseXml(injected)).not.toThrow();
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);
    expect(() => parseXml(insertDefinedNamesXml(buildWorkbookXml(createWorkbook()), plan, ['预算']))).not.toThrow();
  });

  it('打印元素可序列化且顺序稳定（确定性：两次调用字节相同）', () => {
    const layout: PrintLayout = createPrintLayout({ orientation: 'portrait', row_breaks: [4, 7] });
    const once = insertSheetPrintXml(baseSheetXml(), layout);
    const twice = insertSheetPrintXml(baseSheetXml(), layout);
    expect(once).toBe(twice);
  });
});

// ---------------------------------------------------------------------------
// 多区域打印区域（X-I15 增量）
// ---------------------------------------------------------------------------

describe('多区域打印区域', () => {
  it('parsePrintAreas 逐段解析并去重，formatPrintArea 序列化', () => {
    expect(parsePrintAreas('a1:b2,D1:E5,a1:b2')).toEqual(['$A$1:$B$2', '$D$1:$E$5']);
    expect(formatPrintArea(['$A$1:$B$2', '$D$1:$E$5'])).toBe('$A$1:$B$2,$D$1:$E$5');
  });

  it('setPrintArea 归一化多区域（逗号分隔、两端绝对）', () => {
    expect(setPrintArea(createPrintLayout(), 'A1:G20 , E1:E20').print_area).toBe('$A$1:$G$20,$E$1:$E$20');
  });

  it('多区域的 Print_Area 每段各带表名前缀', () => {
    const layout = setPrintArea(createPrintLayout(), 'A1:G20,E1:E20');
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);
    expect(printDefinedNames(plan, ['预算'])[0]?.text).toBe("'预算'!$A$1:$G$20,'预算'!$E$1:$E$20");
  });

  it('反向对照：单区域 definedName 文本不变（旧契约逐字节保持）', () => {
    const plan = setSheetPrint(createPrintPlan(), '预算', setPrintArea(createPrintLayout(), 'A1:G20'));
    expect(printDefinedNames(plan, ['预算'])[0]?.text).toBe("'预算'!$A$1:$G$20");
  });

  it('parsePrintAreaDefinedName 与 printDefinedNames 往返一致', () => {
    const layout = setPrintArea(createPrintLayout(), 'A1:G20,E1:E20');
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);
    const text = printDefinedNames(plan, ['预算'])[0]?.text as string;
    expect(parsePrintAreaDefinedName(text, '预算')).toBe('$A$1:$G$20,$E$1:$E$20');
  });

  it('引号内的逗号不是区域分隔符（工作表名含逗号）', () => {
    expect(parsePrintAreaDefinedName("'季度,汇总'!$A$1:$B$2,'季度,汇总'!$D$1:$E$5", '季度,汇总')).toBe(
      '$A$1:$B$2,$D$1:$E$5',
    );
  });

  it('反向对照：表名前缀不符 / 空段 / 非法区域 ⇒ 抛错', () => {
    expect(() => parsePrintAreaDefinedName("'说明'!$A$1:$B$2", '预算')).toThrow(/不符/);
    expect(() => parsePrintAreas('A1:B2,,D1:E5')).toThrow(/空段/);
    expect(() => parsePrintAreas('nope')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 页眉页脚字段码（X-I15 增量）
// ---------------------------------------------------------------------------

describe('页眉页脚字段码', () => {
  it('码表覆盖 &D/&T/&F/&A（及 &P/&N/&Z）', () => {
    expect(HEADER_FOOTER_FIELD_CODES).toMatchObject({
      P: 'page',
      N: 'total_pages',
      D: 'date',
      T: 'time',
      F: 'file_name',
      A: 'sheet_name',
      Z: 'file_path',
    });
  });

  it('tokenize → serialize 往返，码字母规范为大写', () => {
    expect(serializeHeaderFooterTokens(tokenizeHeaderFooter('&l&d &C已生成'))).toBe('&L&D &C已生成');
  });

  it('expandHeaderFooterFields 展开已提供值的字段码', () => {
    expect(
      expandHeaderFooterFields('&L&D&T&F&A&P/&N', {
        date: 'd',
        time: 't',
        file_name: 'f',
        sheet_name: 'a',
        page: 1,
        total_pages: 9,
      }),
    ).toBe('&Ldtfa1/9');
  });

  it('反向对照：上下文缺失的字段码原样保留（不编造），未知 &x 也保留', () => {
    expect(expandHeaderFooterFields('&D&Q', {})).toBe('&D&Q');
    expect(expandHeaderFooterFields('&P', {})).toBe('&P');
  });
});
