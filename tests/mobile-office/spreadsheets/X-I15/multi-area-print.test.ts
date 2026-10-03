/**
 * **X-I15 集成：多区域打印区域 + 剩余页眉页脚字段码**。
 *
 * 本包不改 `xlsx-write.ts` / `xlsx-read.ts` / X-R05 的模块，只把 `print-layout.ts` 的
 * 增量**落进真实部件**并**读回来**核对：
 *
 * 1. 多区域 `_xlnm.Print_Area`（逗号分隔，每段带表名前缀）——序列化到 definedNames，
 *    再用 `parsePrintAreaDefinedName` 解析回文本，往返一致；
 * 2. 页眉页脚里 `&D/&T/&F/&A` 等字段码写进 `<oddHeader>` 后**逐字保留**（消费端解析），
 *    并可由码表解析 / 序列化 / 展开成手机预览文本。
 *
 * 每条能力都配**反向对照**：单区域输出与旧实现逐字节一致（不因增量改变既有契约）、
 * 空段 / 非法区域 / 表名前缀不符显式抛错、上下文缺失的字段码**不编造**、未识别的 `&x` 原样保留。
 *
 * **未验证（需真机 / 消费端）**：真实 Excel/WPS 打开本文件后按多区域打印区域与字段码出纸。
 */

import { describe, expect, it } from 'vitest';

import { serializeXmlDocument, type XmlElement } from '../../../../src/artifacts/ooxml/index.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../../../../src/documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import {
  HEADER_FOOTER_FIELD_CODES,
  buildHeaderFooterElement,
  createPrintLayout,
  createPrintPlan,
  expandHeaderFooterFields,
  formatPrintArea,
  insertDefinedNamesXml,
  parsePrintAreaDefinedName,
  parsePrintAreas,
  printDefinedNames,
  serializeHeaderFooterTokens,
  setHeaderFooter,
  setPrintArea,
  setSheetPrint,
  tokenizeHeaderFooter,
  type HeaderFooterToken,
} from '../../../../src/spreadsheets/print-layout.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { buildWorkbookXml } from '../../../../src/spreadsheets/xlsx-write.js';

// ---------------------------------------------------------------------------
// 多区域打印区域
// ---------------------------------------------------------------------------

describe('X-I15 多区域打印区域（_xlnm.Print_Area 列表）', () => {
  it('逗号分隔的多区域被逐段解析为两端绝对区域并去重', () => {
    expect(parsePrintAreas('a1:b2, D1:E5 ,a1:b2')).toEqual(['$A$1:$B$2', '$D$1:$E$5']);
    expect(formatPrintArea(['$A$1:$B$2', '$D$1:$E$5'])).toBe('$A$1:$B$2,$D$1:$E$5');
  });

  it('setPrintArea 归一化多区域；单区域输出与旧口径一致', () => {
    expect(setPrintArea(createPrintLayout(), 'a1:g20').print_area).toBe('$A$1:$G$20');
    expect(setPrintArea(createPrintLayout(), 'a1:g20,e1:e20').print_area).toBe('$A$1:$G$20,$E$1:$E$20');
  });

  it('printDefinedNames 让**每段**各带表名前缀（Excel 的多区域写法）', () => {
    const layout = setPrintArea(createPrintLayout(), 'A1:G20,E1:E20');
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);
    const names = printDefinedNames(plan, ['预算']);
    expect(names).toHaveLength(1);
    expect(names[0]?.text).toBe("'预算'!$A$1:$G$20,'预算'!$E$1:$E$20");
  });

  it('反向对照：单区域 definedName 文本与旧实现逐字节一致（不因增量改变既有契约）', () => {
    const plan = setSheetPrint(createPrintPlan(), '预算', setPrintArea(createPrintLayout(), 'A1:G20'));
    expect(printDefinedNames(plan, ['预算'])[0]?.text).toBe("'预算'!$A$1:$G$20");
  });

  it('落进真实工作簿 XML：读回来的 definedName 正文是带前缀的多区域列表', () => {
    const workbookXml = buildWorkbookXml(createWorkbook());
    const plan = setSheetPrint(
      createPrintPlan(),
      'Sheet1',
      setPrintArea(createPrintLayout(), 'A1:C3, E1:F2'),
    );
    const injected = insertDefinedNamesXml(workbookXml, plan, ['Sheet1']);
    const root = parseXml(injected);
    const definedNames = findChild(root, SPREADSHEETML_NAMESPACE, 'definedNames') as ParsedXmlElement;
    const first = childElements(definedNames)[0] as ParsedXmlElement;
    expect(attributeValue(first, '', 'name')).toBe('_xlnm.Print_Area');
    expect(directText(first)).toBe('Sheet1!$A$1:$C$3,Sheet1!$E$1:$F$2');
  });

  it('parsePrintAreaDefinedName 解析回文本，与归一化打印区域一致（往返）', () => {
    const layout = setPrintArea(createPrintLayout(), 'A1:G20,E1:E20');
    const plan = setSheetPrint(createPrintPlan(), '预算', layout);
    const text = printDefinedNames(plan, ['预算'])[0]?.text as string;
    expect(parsePrintAreaDefinedName(text, '预算')).toBe(layout.print_area);
  });

  it('工作表名含逗号 / 单引号时，引号外的逗号才切分（不劈开表名）', () => {
    const plan = setSheetPrint(createPrintPlan(), "季度,汇总's", setPrintArea(createPrintLayout(), 'A1:B2,D1:E5'));
    const text = printDefinedNames(plan, ["季度,汇总's"])[0]?.text as string;
    expect(parsePrintAreaDefinedName(text, "季度,汇总's")).toBe('$A$1:$B$2,$D$1:$E$5');
  });

  it('反向对照：表名前缀与给定工作表不符 ⇒ 抛错（不静默取末段）', () => {
    expect(() => parsePrintAreaDefinedName("'说明'!$A$1:$B$2", '预算')).toThrow(/不符/);
  });

  it('反向对照：空段 / 非法区域 ⇒ 显式抛错，不静默接受', () => {
    expect(() => parsePrintAreas('A1:B2,,D1:E5')).toThrow(/空段/);
    expect(() => parsePrintAreas('not-a-range')).toThrow();
    expect(() => parsePrintAreaDefinedName("'S'!$A$1:$B$2,")).toThrow(/空段/);
  });

  it('多区域打印区域经 insertDefinedNamesXml 后仍是合法 XML（读回来不抛）', () => {
    const plan = setSheetPrint(createPrintPlan(), 'Sheet1', setPrintArea(createPrintLayout(), 'A1:C3,E1:F2'));
    const injected = insertDefinedNamesXml(buildWorkbookXml(createWorkbook()), plan, ['Sheet1']);
    expect(() => parseXml(injected)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 剩余页眉页脚字段码
// ---------------------------------------------------------------------------

describe('X-I15 页眉页脚字段码（&D/&T/&F/&A 等）', () => {
  it('码表识别 &P/&N/&D/&T/&F/&A/&Z 与分区 &L/&C/&R、字面 &&', () => {
    expect(HEADER_FOOTER_FIELD_CODES.D).toBe('date');
    expect(HEADER_FOOTER_FIELD_CODES.T).toBe('time');
    expect(HEADER_FOOTER_FIELD_CODES.F).toBe('file_name');
    expect(HEADER_FOOTER_FIELD_CODES.A).toBe('sheet_name');
    const tokens = tokenizeHeaderFooter('&L&D &T / &F / &A&&&C&P');
    expect(tokens).toEqual<readonly HeaderFooterToken[]>([
      { kind: 'region', region: 'left' },
      { kind: 'field', field: 'date' },
      { kind: 'text', text: ' ' },
      { kind: 'field', field: 'time' },
      { kind: 'text', text: ' / ' },
      { kind: 'field', field: 'file_name' },
      { kind: 'text', text: ' / ' },
      { kind: 'field', field: 'sheet_name' },
      { kind: 'literal_ampersand' },
      { kind: 'region', region: 'center' },
      { kind: 'field', field: 'page' },
    ]);
  });

  it('解析→序列化把码字母规范为大写（大小写不敏感）', () => {
    expect(serializeHeaderFooterTokens(tokenizeHeaderFooter('&l&d&t&f&a&n&z'))).toBe('&L&D&T&F&A&N&Z');
  });

  it('反向对照：未识别的 &x 原样保留（不猜、不吞）', () => {
    expect(serializeHeaderFooterTokens(tokenizeHeaderFooter('&Q&X'))).toBe('&Q&X');
    expect(expandHeaderFooterFields('&Q', {})).toBe('&Q');
  });

  it('expandHeaderFooterFields 展开已提供值的码；未提供的码原样保留（不编造）', () => {
    const text = '&L&D &T / &F / &A / &P / &N';
    expect(
      expandHeaderFooterFields(text, {
        date: '2026-10-03',
        time: '18:00',
        file_name: '预算.xlsx',
        sheet_name: '预算',
        page: 2,
        total_pages: 5,
      }),
    ).toBe('&L2026-10-03 18:00 / 预算.xlsx / 预算 / 2 / 5');

    // 只给部分：缺的 &D / &T / &F / &A 原样保留，不填假值。
    expect(expandHeaderFooterFields(text, { page: 1, total_pages: 3 })).toBe('&L&D &T / &F / &A / 1 / 3');
    // 反向对照：什么上下文都不给 ⇒ 除 && 外一切原样。
    expect(expandHeaderFooterFields('&D&T&F&A&P&N&&', {})).toBe('&D&T&F&A&P&N&');
  });

  it('反向对照：分区码不是字段，展开时保留（交给分区函数）', () => {
    expect(expandHeaderFooterFields('&L文本&R', { date: 'x' })).toBe('&L文本&R');
  });

  it('落进真实部件：字段码写进 <oddHeader> 后逐字保留，读回来一致', () => {
    const headerText = '&L&D &T&C&A&R&F 第 &P 页';
    const layout = setHeaderFooter(createPrintLayout(), { odd_header: headerText });
    const element = buildHeaderFooterElement(layout) as XmlElement;
    const root = parseXml(serializeXmlDocument(element));
    // 序列化后的元素根即 <headerFooter>（无默认命名空间），按 localName 取子元素。
    const oddHeader = childElements(root).find((child) => child.localName === 'oddHeader');
    expect(oddHeader).toBeDefined();
    expect(directText(oddHeader as ParsedXmlElement)).toBe(headerText);
  });
});
