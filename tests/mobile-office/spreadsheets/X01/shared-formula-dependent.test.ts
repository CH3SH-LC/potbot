/**
 * **X01-shared-formula**：真实 XLSX 字节里的**共享公式从属格**还原（Excel 线）。
 *
 * 判据来自 OOXML 语义：从属格 `<f t="shared" si="N"/>`（无文本）继承同一 `si` 主格
 * `<f t="shared" ref="范围" si="N">公式文本</f>` 的公式，并把**相对引用按主格 → 从属格的
 * 偏移平移**。五组判据：
 *
 * 1. **纯相对**：2×2 / 2×3 网格里逐格偏移正确；
 * 2. **绝对 / 混合**：`$A$1` 不动，`$A1` / `A$1` 只动非 `$` 的一半；
 * 3. **字符串字面量**：里面的 `A1` 样子文本**不得**被改写；
 * 4. **表名限定**：按 Excel 复制语义，**单元格部分照常平移**（`Sheet2!A1` 右移一列 ⇒
 *    `Sheet2!B1`、`'My Sheet'!B2` ⇒ `'My Sheet'!B3`、`Sheet1:Sheet3!A1` ⇒ `…!B1`），
 *    而**表名本身绝不平移**（`'A1'!B2` 的 `A1` 是表名，不是坐标）；整列 / 整行（`A:A`、`1:1`）
 *    同样随复制平移；
 *    函数名（`LOG10`）与自定义名（`A1NAME`）不得被误当引用；
 * 5. **反面对照**：从属格落在 `ref` 范围外 / `si` 悬空 ⇒ **必须报错**（不是静默成功）。
 *
 * 夹具用**真实 XLSX 字节**（`assembleOpcPackage` + `writeZip` 手装最小包，手法同
 * `src/spreadsheets/xlsx-read.test.ts`），读回经公开入口 `readWorkbookXlsx`。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';
import { getCellValue, type SheetState } from '../../../../src/spreadsheets/sheet.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';

function worksheetXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>${body}</sheetData></worksheet>`
  );
}

/** 手装一个单表最小包（`<sheetData>` 里放给定 body）。 */
function singleSheetPackage(body: string): Uint8Array {
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const parts: OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
    { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: worksheetXml(body) },
  ];
  const relationships: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
    },
  ];
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });
  return writeZip(assembled.entries);
}

/** 读回单表包里的工作表 `S`（读不回来直接失败，避免非空断言掩盖问题）。 */
function readSheet(body: string): SheetState {
  const sheet = getSheet(readWorkbookXlsx(singleSheetPackage(body)).workbook, 'S');
  if (sheet === undefined) throw new Error('工作表 S 未读回');
  return sheet;
}

/** 该格的公式原文（非公式格失败）。 */
function formulaAt(sheet: SheetState, ref: string): string {
  const value = getCellValue(sheet, ref);
  if (value.kind !== 'formula') throw new Error(`${ref} 不是公式格：${JSON.stringify(value)}`);
  return value.text;
}

describe('X01 共享公式从属格：纯相对引用按偏移平移', () => {
  it('2×2 主格 A1 / ref=A1:B2：四格偏移逐格正确', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B2" si="0">A1+1</f><v>2</v></c>' +
        '<c r="B1"><f t="shared" si="0"/><v>3</v></c>' +
        '</row>' +
        '<row r="2">' +
        '<c r="A2"><f t="shared" si="0"/><v>3</v></c>' +
        '<c r="B2"><f t="shared" si="0"/><v>4</v></c>' +
        '</row>',
    );
    // 主格自己原样读回（既有行为不变）
    expect(formulaAt(sheet, 'A1')).toBe('A1+1');
    expect(formulaAt(sheet, 'B1')).toBe('B1+1');
    expect(formulaAt(sheet, 'A2')).toBe('A2+1');
    expect(formulaAt(sheet, 'B2')).toBe('B2+1');
  });

  it('2×3 主格 A1 / ref=A1:C2：区间引用整体平移', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:C2" si="0">SUM(A2:A3)</f></c>' +
        '<c r="B1"><f t="shared" si="0"/></c>' +
        '<c r="C1"><f t="shared" si="0"/></c>' +
        '</row>' +
        '<row r="2">' +
        '<c r="A2"><f t="shared" si="0"/></c>' +
        '<c r="B2"><f t="shared" si="0"/></c>' +
        '<c r="C2"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'A1')).toBe('SUM(A2:A3)');
    expect(formulaAt(sheet, 'B1')).toBe('SUM(B2:B3)');
    expect(formulaAt(sheet, 'C1')).toBe('SUM(C2:C3)');
    expect(formulaAt(sheet, 'A2')).toBe('SUM(A3:A4)');
    expect(formulaAt(sheet, 'B2')).toBe('SUM(B3:B4)');
    expect(formulaAt(sheet, 'C2')).toBe('SUM(C3:C4)');
  });

  it('主格不在左上角（B2 起，ref=A1:B2）：负偏移也正确', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" si="0"/></c>' +
        '<c r="B1"><f t="shared" si="0"/></c>' +
        '</row>' +
        '<row r="2">' +
        '<c r="A2"><f t="shared" si="0"/></c>' +
        '<c r="B2"><f t="shared" ref="A1:B2" si="0">C3+1</f></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'B2')).toBe('C3+1');
    expect(formulaAt(sheet, 'A1')).toBe('B2+1'); // (-1, -1)
    expect(formulaAt(sheet, 'B1')).toBe('C2+1'); // (-1, 0)
    expect(formulaAt(sheet, 'A2')).toBe('B3+1'); // (0, -1)
  });

  it('两个不同的 si 各自继承各自的主格', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:A2" si="0">A1*2</f></c>' +
        '<c r="B1"><f t="shared" ref="B1:B2" si="1">B1+100</f></c>' +
        '</row>' +
        '<row r="2">' +
        '<c r="A2"><f t="shared" si="0"/></c>' +
        '<c r="B2"><f t="shared" si="1"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'A2')).toBe('A2*2');
    expect(formulaAt(sheet, 'B2')).toBe('B2+100');
  });
});

describe('X01 共享公式从属格：$ 绝对 / 混合引用只平移非 $ 的部分', () => {
  it('$A$1 不动，$A1 只移行，A$1 只移列（偏移 +2/+2）', () => {
    const sheet = readSheet(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:C3" si="0">$A$1+$A1+A$1</f></c></row>' +
        '<row r="3"><c r="C3"><f t="shared" si="0"/></c></row>',
    );
    expect(formulaAt(sheet, 'A1')).toBe('$A$1+$A1+A$1');
    expect(formulaAt(sheet, 'C3')).toBe('$A$1+$A3+C$1');
  });

  it('全绝对引用与函数内绝对引用一律不动', () => {
    const sheet = readSheet(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:B2" si="0">SUM($B$2,$C1,SUM(A1))</f></c></row>' +
        '<row r="2"><c r="B2"><f t="shared" si="0"/></c></row>',
    );
    // 偏移 (+1, +1)：$B$2 不动；$C1 行 +1 ⇒ $C2；SUM(A1) ⇒ SUM(B2)
    expect(formulaAt(sheet, 'B2')).toBe('SUM($B$2,$C2,SUM(B2))');
  });
});

describe('X01 共享公式从属格：字符串字面量不动、跨表引用平移单元格部分', () => {
  it('字符串字面量里的 A1 样子文本保持原文', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B1" si="0">IF(A1&gt;0,"A1",B1)</f></c>' +
        '<c r="B1"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'A1')).toBe('IF(A1>0,"A1",B1)');
    expect(formulaAt(sheet, 'B1')).toBe('IF(B1>0,"A1",C1)');
  });

  it('跨工作表引用的单元格部分随复制平移（Sheet2!A1 右移一列 ⇒ Sheet2!B1）', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B1" si="0">Sheet2!A1+C1</f></c>' +
        '<c r="B1"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'A1')).toBe('Sheet2!A1+C1');
    expect(formulaAt(sheet, 'B1')).toBe('Sheet2!B1+D1');
  });

  it("带引号表名的单元格部分同样平移（'My Sheet'!B2 下移一行 ⇒ 'My Sheet'!B3）", () => {
    const sheet = readSheet(
      '<row r="1">' +
        "<c r=\"A1\"><f t=\"shared\" ref=\"A1:A2\" si=\"0\">'My Sheet'!B2+A1</f></c>" +
        '</row>' +
        '<row r="2"><c r="A2"><f t="shared" si="0"/></c></row>',
    );
    expect(formulaAt(sheet, 'A2')).toBe("'My Sheet'!B3+A2");
  });

  it("表名本身绝不平移：'A1'!B2 里的 A1 是表名（反向对照）", () => {
    const sheet = readSheet(
      '<row r="1">' +
        "<c r=\"A1\"><f t=\"shared\" ref=\"A1:B2\" si=\"0\">'A1'!B2+A1</f></c>" +
        '<c r="B2"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    // 从属格 B2 偏移 (+1, +1)：表名 'A1' 一字不动；B2 ⇒ C3；A1 ⇒ B2
    expect(formulaAt(sheet, 'B2')).toBe("'A1'!C3+B2");
  });

  it('3D 引用（Sheet1:Sheet3!A1）只平移单元格部分', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B1" si="0">SUM(Sheet1:Sheet3!A1)</f></c>' +
        '<c r="B1"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'B1')).toBe('SUM(Sheet1:Sheet3!B1)');
  });

  it('跨表绝对 / 混合引用：Sheet2!$A$1 不动，Sheet2!$A1 只移行', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B2" si="0">Sheet2!$A$1+Sheet2!$A1</f></c>' +
        '<c r="B2"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'B2')).toBe('Sheet2!$A$1+Sheet2!$A2');
  });

  it('整列引用按列平移，$A:$A 锁定不动', () => {
    const sheet = readSheet(
      '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:B2" si="0">SUM(A:A)+SUM($A:$A)</f></c>' +
        '<c r="B2"><f t="shared" si="0"/></c>' +
        '</row>',
    );
    expect(formulaAt(sheet, 'B2')).toBe('SUM(B:B)+SUM($A:$A)');
  });

  it('整行引用按行平移，$1:$1 锁定不动', () => {
    const sheet = readSheet(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">SUM(1:1)+SUM($1:$1)</f></c></row>' +
        '<row r="2"><c r="A2"><f t="shared" si="0"/></c></row>',
    );
    expect(formulaAt(sheet, 'A2')).toBe('SUM(2:2)+SUM($1:$1)');
  });

  it('函数名 LOG10 与自定义名 A1NAME 不被误当引用', () => {
    const sheet = readSheet(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">LOG10(100)+A1NAME+A1</f></c></row>' +
        '<row r="2"><c r="A2"><f t="shared" si="0"/></c></row>',
    );
    expect(formulaAt(sheet, 'A2')).toBe('LOG10(100)+A1NAME+A2');
  });
});

describe('X01 共享公式从属格：无法安全还原 ⇒ 显式报错', () => {
  it('从属格落在主格 ref 范围外 ⇒ 报错（不静默猜偏移）', () => {
    const bytes = singleSheetPackage(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">A1+1</f></c></row>' +
        '<row r="5"><c r="C5"><f t="shared" si="0"/></c></row>',
    );
    expect(() => readWorkbookXlsx(bytes)).toThrow(/共享公式的从属格/);
    expect(() => readWorkbookXlsx(bytes)).toThrow(/ref 范围/);
  });

  it('si 悬空（找不到主格）⇒ 报错', () => {
    const bytes = singleSheetPackage(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:B1" si="0">A1+1</f></c></row>' +
        '<row r="2"><c r="A2"><f t="shared" si="7"/></c></row>',
    );
    expect(() => readWorkbookXlsx(bytes)).toThrow(/共享公式的从属格/);
    expect(() => readWorkbookXlsx(bytes)).toThrow(/找不到 si=7 的主格/);
  });

  it('全表没有主格、只有一个悬空从属格 ⇒ 报错（既有反面对照的延续）', () => {
    const bytes = singleSheetPackage('<row r="1"><c r="A1"><f t="shared" si="0"/><v>1</v></c></row>');
    expect(() => readWorkbookXlsx(bytes)).toThrow(/共享公式的从属格/);
  });

  it('平移后越界（列 / 行 < 1）⇒ 报错，不写一个错位的公式', () => {
    const bytes = singleSheetPackage(
      '<row r="2"><c r="B2"><f t="shared" ref="A1:B2" si="0">A1+1</f></c></row>' +
        '<row r="1"><c r="A1"><f t="shared" si="0"/></c></row>',
    );
    expect(() => readWorkbookXlsx(bytes)).toThrow(/越界/);
  });

  it('整列引用左移越界（A:A 已在 A 列）⇒ 报错', () => {
    const bytes = singleSheetPackage(
      '<row r="1">' +
        '<c r="A1"><f t="shared" si="0"/></c>' +
        '<c r="B1"><f t="shared" ref="A1:B1" si="0">SUM(A:A)</f></c>' +
        '</row>',
    );
    expect(() => readWorkbookXlsx(bytes)).toThrow(/越界/);
  });
});
