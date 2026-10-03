/**
 * **X02 补验（真实字节层）**：把 `copyRows` / `moveRows` / `copyColumns` / `moveColumns`
 * 产出的公式文本经 `xlsx-write` 组装成**真实 .xlsx 字节**，再用 `xlsx-read` **独立读回**，
 * 断言读回后的公式引用与模型层一致——把"模型层正确"升级为"真实字节可往返"。
 *
 * 这是 X02 遗留项 (b)：此前 `copyRows` / `moveRows` 的新公式文本只经过结构化断言，
 * 未写出、未读回。本文件补上这一步：**模型 → 真实容器字节 → 独立读回 → 逐引用核对**。
 *
 * 样式迁移（X02 遗留项 (a)）另用 `style-parts/styled-xlsx.ts` 的 `buildStyledXlsx` 打出
 * 真实容器，用 `readZip` **独立读回** `xl/worksheets/sheet1.xml`，断言复制 / 移动后的
 * `s=` 索引落在预期地址——不拿生成器自己的字符串自证。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  copyCellStylesRows,
  moveCellStylesRows,
  cellStyleKeys,
} from '../../../../src/spreadsheets/ranges.js';
import {
  copyColumns,
  copyRows,
  createSheet,
  getCellValue,
  moveColumns,
  moveRows,
  setCellValue,
  type SheetState,
} from '../../../../src/spreadsheets/sheet.js';
import { buildStyledXlsx } from '../../../../src/spreadsheets/style-parts/styled-xlsx.js';
import { setCellStyle, type CellStyle, type CellStyles } from '../../../../src/spreadsheets/styles.js';
import { isFormula, numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook, getSheet } from '../../../../src/spreadsheets/workbook.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';

/** 取公式文本（非公式返回带 kind 的占位，便于断言失败时定位）。 */
function formulaText(sheet: SheetState, ref: string): string {
  const value = getCellValue(sheet, ref);
  return isFormula(value) ? value.text : `<not-formula:${value.kind}>`;
}

/**
 * 模型 → 真实 .xlsx 字节 → 独立读回 → 取回同一张工作表。
 *
 * 走**生产写侧** `writeWorkbookXlsx`（含公式求值 / 真实 OPC 组装）与**生产读侧**
 * `readWorkbookXlsx`，中途不传任何自建结构——因此"读回一致"不是自证。
 */
function roundTripThroughFile(sheet: SheetState): SheetState {
  const written = writeWorkbookXlsx(createWorkbook([sheet]));
  expect(written.bytes.length).toBeGreaterThan(0);
  const reread = readWorkbookXlsx(written.bytes);
  const reopened = getSheet(reread.workbook, sheet.name);
  if (reopened === undefined) {
    throw new Error(`读回工作簿缺少工作表 ${JSON.stringify(sheet.name)}`);
  }
  return reopened;
}

/** 一张含整行记录 + 行内公式 + 汇总公式的水果表（名称 / 数量 / 单价 / 小计）。 */
function fruitSheet(): SheetState {
  let sheet = createSheet('数据');
  sheet = setCellValue(sheet, 'A1', textValue('名称'));
  sheet = setCellValue(sheet, 'B1', textValue('数量'));
  sheet = setCellValue(sheet, 'A2', textValue('苹果'));
  sheet = setCellValue(sheet, 'B2', numberValue(10));
  sheet = setCellValue(sheet, 'C2', numberValue(2.5));
  sheet = setCellValue(sheet, 'D2', { kind: 'formula', text: 'B2*C2' } as const);
  sheet = setCellValue(sheet, 'D10', { kind: 'formula', text: 'SUM(B2:B9)' } as const);
  return sheet;
}

describe('X02 真实字节：复制行后的公式引用经 .xlsx 往返一致', () => {
  it('copyRows 的副本公式写进真实字节、读回仍指向副本行', () => {
    const after = copyRows(fruitSheet(), 2, 1, 10);
    expect(formulaText(after, 'D10')).toBe('B10*C10'); // 模型层：副本平移 delta=8
    expect(getCellValue(after, 'A10')).toEqual(textValue('苹果'));

    const reopened = roundTripThroughFile(after);
    // 读写往返后：值 / 公式文本 / 引用一字不差
    expect(getCellValue(reopened, 'A2')).toEqual(textValue('苹果'));
    expect(getCellValue(reopened, 'A10')).toEqual(textValue('苹果'));
    expect(formulaText(reopened, 'D2')).toBe('B2*C2'); // 源公式保留
    expect(formulaText(reopened, 'D10')).toBe('B10*C10'); // 副本公式指向副本行
  });
});

describe('X02 真实字节：移动行后的公式引用经 .xlsx 往返一致', () => {
  it('moveRows 的分段引用写进真实字节、读回仍跟被移动行', () => {
    let sheet = createSheet('移动');
    sheet = setCellValue(sheet, 'A1', textValue('一'));
    sheet = setCellValue(sheet, 'A2', textValue('二'));
    sheet = setCellValue(sheet, 'A3', textValue('三'));
    sheet = setCellValue(sheet, 'A4', textValue('四'));
    sheet = setCellValue(sheet, 'A5', textValue('五'));
    sheet = setCellValue(sheet, 'C1', { kind: 'formula', text: 'A2' } as const);

    const after = moveRows(sheet, 2, 1, 5); // "二" 移到 "五" 之前
    expect(formulaText(after, 'C1')).toBe('A4'); // 模型层：A2（二）现落在第 4 行

    const reopened = roundTripThroughFile(after);
    expect(getCellValue(reopened, 'A4')).toEqual(textValue('二'));
    expect(formulaText(reopened, 'C1')).toBe('A4'); // 读回后引用仍指向被移动行
    expect(getCellValue(reopened, 'A2')).toEqual(textValue('三')); // 原位置已由压缩段占据
  });
});

describe('X02 真实字节：复制 / 移动列后的公式引用经 .xlsx 往返一致', () => {
  it('copyColumns 的副本公式读回仍指向副本列', () => {
    let sheet = createSheet('列');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', numberValue(2));
    sheet = setCellValue(sheet, 'C1', { kind: 'formula', text: 'A1+B1' } as const);
    const after = copyColumns(sheet, 3, 1, 5); // C 列复制到 E 列
    expect(formulaText(after, 'E1')).toBe('C1+D1');

    const reopened = roundTripThroughFile(after);
    expect(formulaText(reopened, 'E1')).toBe('C1+D1');
    expect(getCellValue(reopened, 'A1')).toEqual(numberValue(1));
  });

  it('moveColumns 的公式引用读回跟被移动列', () => {
    let sheet = createSheet('列移');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', numberValue(2));
    sheet = setCellValue(sheet, 'C1', numberValue(3));
    sheet = setCellValue(sheet, 'E1', { kind: 'formula', text: 'A1' } as const);
    const after = moveColumns(sheet, 1, 1, 4); // A 列移到 D 之前 ⇒ 落到第 3 列
    expect(formulaText(after, 'E1')).toBe('C1');

    const reopened = roundTripThroughFile(after);
    expect(formulaText(reopened, 'E1')).toBe('C1');
    expect(getCellValue(reopened, 'E1')).toBeDefined();
  });
});

describe('X02 真实字节：复制 / 移动后的样式经 .xlsx 往返落在预期地址', () => {
  const BOLD: CellStyle = { bold: true };

  function styledSheet(): SheetState {
    let sheet = createSheet('样式');
    sheet = setCellValue(sheet, 'A1', textValue('表头'));
    sheet = setCellValue(sheet, 'A2', textValue('苹果'));
    sheet = setCellValue(sheet, 'A3', textValue('香蕉'));
    return sheet;
  }

  function styleMap(): CellStyles {
    let styles: CellStyles = new Map();
    styles = setCellStyle(styles, 'A2', BOLD);
    return styles;
  }

  /** 把一份样式表写成带 `s=` 索引的真实容器，读回工作表 XML 文本。 */
  function styledWorksheetXml(styles: CellStyles): string {
    const cells = [...styles].map(([ref, style]) => ({
      ref,
      value: { kind: 'number', value: 1 } as const,
      style,
    }));
    const build = buildStyledXlsx({ sheet_name: '样式', cells });
    const archive = readZip(build.bytes);
    const entry = archive.by_path.get('xl/worksheets/sheet1.xml');
    if (entry === undefined) {
      throw new Error('真实容器缺少 xl/worksheets/sheet1.xml');
    }
    return Buffer.from(entry.data).toString('utf8');
  }

  /** 从工作表 XML 里取某地址的 `s` 索引（不存在 ⇒ `undefined`）。 */
  function styleIndexAt(worksheetXml: string, ref: string): string | undefined {
    const match = new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(worksheetXml);
    return match?.[1];
  }

  it('复制行：源与副本的样式索引相同且非默认（0）', () => {
    const after = copyCellStylesRows(styleMap(), 2, 1, 10);
    // 模型层：源保留、副本落在第 10 行，且描述符键一致
    expect(cellStyleKeys(after).get('A2')).toBe(cellStyleKeys(after).get('A10'));
    const xml = styledWorksheetXml(after);
    const source = styleIndexAt(xml, 'A2');
    const copy = styleIndexAt(xml, 'A10');
    expect(source).toBeDefined();
    expect(copy).toBe(source); // 副本用的是同一份样式
    expect(copy).not.toBe('0'); // 且不是默认 xf（加粗真的生效）
  });

  it('移动行：样式索引随值落到新地址，原地址不再带样式', () => {
    const after = moveCellStylesRows(styleMap(), 2, 1, 5); // 第 2 行 → 第 4 行
    expect(after.has('A2')).toBe(false);
    expect(after.has('A4')).toBe(true);
    const xml = styledWorksheetXml(after);
    expect(styleIndexAt(xml, 'A4')).toBeDefined();
    expect(styleIndexAt(xml, 'A4')).not.toBe('0');
    expect(styleIndexAt(xml, 'A2')).toBeUndefined();
  });

  it('反向对照：未迁移的默认格读回是 s="0"（证明非默认索引来自这次迁移）', () => {
    // 不给 A2 设样式时，写入的格是默认 xf
    const plainCells = [{ ref: 'A2', value: { kind: 'number', value: 1 } as const, style: {} }];
    const build = buildStyledXlsx({ sheet_name: '样式', cells: plainCells });
    const archive = readZip(build.bytes);
    const entry = archive.by_path.get('xl/worksheets/sheet1.xml');
    const xml = entry === undefined ? '' : Buffer.from(entry.data).toString('utf8');
    expect(styleIndexAt(xml, 'A2')).toBe('0');
  });
});
