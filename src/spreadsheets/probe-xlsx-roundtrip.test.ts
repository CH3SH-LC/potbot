/**
 * **能力探针**（FA-E / design-06-P8 第一增量，H0 要求）。
 *
 * 这不是我的模型层的单元测试，而是一次**可运行的证据采集**：
 * 回答"要读写真实 XLSX，是否必须引入成熟第三方库"。
 *
 * 结论所依赖的事实不能用库的宣传能力来支撑，因此这里**实读**一次：
 * 用项目**已有的自研读栈**（`readZip` 走 DEFLATE 解压 + `parseXmlBytes` 解析 XML）
 * 读回**已有的模板层**产出的真实 .xlsx 字节，并解析出单元格与公式节点。
 *
 * 读回成功 = 读路径所需原语在库内已齐备（**不需要**第三方库）；
 * 读回失败 = 探针失败，结论必须改写（因此本文件是**可证伪的**）。
 *
 * 只读使用既有模块，不修改它们。
 */

import { describe, expect, it } from 'vitest';

import { asFactRef, type FactSource, type KnownFactValue } from '../protocol/index.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  writeZip,
} from '../artifacts/ooxml/index.js';
import { readZip } from '../artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../artifacts/ooxml/xml.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
  buildXlsxTemplate,
  type XlsxFactEntry,
  type XlsxFactValue,
  type XlsxSheetSpec,
} from '../artifacts/templates/xlsx.js';
import { childElements, directText, parseXmlBytes, type ParsedXmlElement } from '../documents/docx/xml-parse.js';

const SOURCE: FactSource = { kind: 'user_confirmation', detail: '探针夹具' };

function numberFact(factKey: string, amount: number, unit = '元', currency: string | null = null): XlsxFactEntry {
  const value: KnownFactValue = Object.freeze({ type: 'number', amount, unit, currency });
  return Object.freeze({ fact_ref: asFactRef(`fact-${factKey}`), fact_key: factKey, value, source: SOURCE });
}

function unknownFact(factKey: string, reason = '探针：未提供'): XlsxFactEntry {
  const value: XlsxFactValue = { kind: 'unknown', reason };
  return Object.freeze({ fact_ref: asFactRef(`fact-${factKey}`), fact_key: factKey, value, source: SOURCE });
}

const SPEC: XlsxSheetSpec = {
  sheet_name: '预算',
  label_header: '项目',
  value_header: '金额',
  unit: '元',
  lines: [
    { label: '餐饮', fact_key: 'budget.food' },
    { label: '交通', fact_key: 'budget.transport' },
    { label: '住宿', fact_key: 'budget.lodging' },
  ],
  total_label: '合计',
  scale: 2,
};

const FACTS: readonly XlsxFactEntry[] = [
  numberFact('budget.food', 120),
  unknownFact('budget.transport'),
  numberFact('budget.lodging', 300),
];

function childByLocal(element: ParsedXmlElement, localName: string): ParsedXmlElement | undefined {
  return childElements(element).find((child) => child.localName === localName);
}

function attributeOf(element: ParsedXmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

describe('探针 A：项目自研读栈能否读回真实 .xlsx（不借任何第三方库）', () => {
  it('readZip 能解析模板层产出的容器并列出工作簿/工作表部件', () => {
    const built = buildXlsxTemplate(SPEC, FACTS);
    const archive = readZip(built.bytes);
    const paths = archive.entries.map((entry) => entry.path);
    expect(paths).toContain('xl/workbook.xml');
    expect(paths).toContain('xl/worksheets/sheet1.xml');
    expect(archive.by_path.size).toBe(paths.length);
  });

  it('parseXmlBytes 能解析工作表 XML：文本是 inlineStr、数值无 t、空白**整体不写**', () => {
    const built = buildXlsxTemplate(SPEC, FACTS);
    const archive = readZip(built.bytes);
    const sheetEntry = archive.by_path.get('xl/worksheets/sheet1.xml');
    expect(sheetEntry).toBeDefined();
    if (sheetEntry === undefined) {
      return;
    }
    const root = parseXmlBytes(sheetEntry.data);
    expect(root.localName).toBe('worksheet');

    const sheetData = childByLocal(root, 'sheetData');
    expect(sheetData).toBeDefined();
    if (sheetData === undefined) {
      return;
    }
    const rows = childElements(sheetData);
    expect(rows.map((row) => attributeOf(row, 'r'))).toEqual(['1', '2', '3', '4', '5']);

    // 第 1 行：两个文本单元格（表头），t=inlineStr
    const headerCells = childElements(rows[0] as ParsedXmlElement);
    expect(headerCells.map((cell) => attributeOf(cell, 't'))).toEqual(['inlineStr', 'inlineStr']);

    // 第 2 行（餐饮 120）：值列是数值单元格（**没有 t**），<v> 精确为 120.00
    const foodCells = childElements(rows[1] as ParsedXmlElement);
    expect(foodCells.length).toBe(2);
    const foodValueCell = foodCells[1] as ParsedXmlElement;
    expect(attributeOf(foodValueCell, 't')).toBeUndefined();
    const foodV = childByLocal(foodValueCell, 'v');
    expect(foodV === undefined ? undefined : directText(foodV)).toBe('120.00');

    // 第 3 行（交通 unknown）：值列**整体不写** ⇒ 该行只有 1 个单元格，且全文无 "<v>0</v>"
    const transportCells = childElements(rows[2] as ParsedXmlElement);
    expect(transportCells.length).toBe(1);
    expect(attributeOf(transportCells[0] as ParsedXmlElement, 'r')).toBe('A3');
    expect(utf8Decode(sheetEntry.data)).not.toContain('<v>0</v>');

    // 第 5 行（合计）：任一分项缺失 ⇒ 合计留空（不写 0、不写部分和）
    const totalCells = childElements(rows[4] as ParsedXmlElement);
    expect(totalCells.length).toBe(1);
  });
});

describe('探针 B：公式节点 `<f>` 的读路径不需要第三方库', () => {
  it('parseXmlBytes 能解析 <c><f>…</f><v>…</v></c> 并取回公式原文', () => {
    const fragment = '<c r="A1"><f>SUM(B1:B3)</f><v>6</v></c>';
    const root = parseXmlBytes(utf8Bytes(fragment));
    expect(root.localName).toBe('c');
    const formula = childByLocal(root, 'f');
    expect(formula).toBeDefined();
    expect(formula === undefined ? undefined : directText(formula)).toBe('SUM(B1:B3)');
    const cached = childByLocal(root, 'v');
    expect(cached === undefined ? undefined : directText(cached)).toBe('6');
  });
});

describe('探针 C：外部 sharedStrings 的读路径同样不需要第三方库', () => {
  /** 一份用 `t="s"` + `xl/sharedStrings.xml` 的外部形状包（真实 ZIP 字节）。 */
  function sharedStringsPackage(): Uint8Array {
    const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const assembled = assembleOpcPackage({
      parts: [
        {
          path: XLSX_WORKBOOK_PART_PATH,
          content_type: XLSX_MAIN_CONTENT_TYPE,
          data:
            header +
            `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${relNs}">` +
            '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          path: 'xl/worksheets/sheet1.xml',
          content_type: XLSX_WORKSHEET_CONTENT_TYPE,
          data:
            header +
            `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>` +
            '<row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>',
        },
        {
          path: 'xl/sharedStrings.xml',
          content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
          data:
            header +
            `<sst xmlns="${SPREADSHEETML_NAMESPACE}" count="2" uniqueCount="2">` +
            '<si><t>忽略</t></si><si><t>项目</t></si></sst>',
        },
      ],
      content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
      relationships: [
        {
          owner_part_path: null,
          declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
        },
        {
          owner_part_path: XLSX_WORKBOOK_PART_PATH,
          declarations: [
            { type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' },
            { type: `${relNs}/sharedStrings`, target: 'sharedStrings.xml' },
          ],
        },
      ],
    });
    return writeZip(assembled.entries);
  }

  it('readZip + parseXmlBytes 能取回 sst 下标所指的文本（下标 1 → "项目"）', () => {
    const archive = readZip(sharedStringsPackage());
    expect(archive.by_path.has('xl/sharedStrings.xml')).toBe(true);

    const sst = parseXmlBytes(archive.by_path.get('xl/sharedStrings.xml')?.data ?? new Uint8Array());
    expect(sst.localName).toBe('sst');
    expect(childElements(sst).map((si) => directText(childByLocal(si, 't') ?? si))).toEqual(['忽略', '项目']);

    const sheet = parseXmlBytes(archive.by_path.get('xl/worksheets/sheet1.xml')?.data ?? new Uint8Array());
    const sheetData = childByLocal(sheet, 'sheetData');
    const firstRow = sheetData === undefined ? undefined : childElements(sheetData)[0];
    const firstCell = firstRow === undefined ? undefined : childElements(firstRow)[0];
    expect(firstCell === undefined ? undefined : attributeOf(firstCell, 't')).toBe('s');
    const index = firstCell === undefined ? undefined : directText(childByLocal(firstCell, 'v') ?? firstCell);
    expect(index).toBe('1');
    // 下标指到 sst 的第 2 个 si，即"项目"——下标解析在库内原语上可行，无需第三方库。
    const values = childElements(sst).map((si) => directText(childByLocal(si, 't') ?? si));
    expect(values[Number(index)]).toBe('项目');
  });
});

function utf8Decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
