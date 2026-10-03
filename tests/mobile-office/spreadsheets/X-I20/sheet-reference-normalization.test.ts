/**
 * **X-I20 集成验收（引用模型）**：工作表名的规范化与 X-I06 的解析口径一致。
 *
 * X-I06 的决定（`formula-parse.ts`）：Excel 只对含空格 / 标点 / 以数字或 `.` 开头 /
 * 形如引用或 `TRUE`/`FALSE` 的表名强制加引号；**纯字母（含汉字等非 ASCII）可裸写**，
 * 且 `'明细'!A1` 与 `明细!A1` 解析出**同一个**表名。
 *
 * 本文件验证 `reference.ts` 的规范化（`normalizeSheetName` / `sheetNameKey` /
 * `parseSheetQualifiedReference`）与解析器（`formula-parse.ts`）、引用模型
 * （`formula-model.ts`）在**解析 / 解析一致**这件事上口径相同：引号只是书写层，
 * 解出的**表名身份**必须一致（这样才能让引用解析到处都落到同一张表）。
 *
 * ## 未验证（不得由本文件绿灯替代）
 *
 * - 真实 Excel / WPS / 真机打开：未做。
 * - 工作簿改名**写出**的引号风格与 `formula-model.formatSheetQualifier` 尚未统一
 *   （见下方"书写风格"用例）：两边的**解析结果一致**，但裸 / 引号的书写选择不同；
 *   这是 `workbook.ts` 与 `formula-model.ts` 的协调残留，不在本单元闭合。
 */

import { describe, expect, it } from 'vitest';

import { parseFormula } from '../../../../src/spreadsheets/formula-parse.js';
import {
  formatReferenceModel,
  formatSheetQualifier,
  parseReferenceModel,
} from '../../../../src/spreadsheets/formula-model.js';
import {
  normalizeSheetName,
  parseSheetQualifiedReference,
  sheetNameKey,
} from '../../../../src/spreadsheets/reference.js';
import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { formulaValue, isFormula, numberValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook, getSheet, renameSheet } from '../../../../src/spreadsheets/workbook.js';

describe('X-I20 / X-I06：裸名与引号名解出同一个表名', () => {
  it('reference.ts 与 formula-parse 对同一条跨表引用解出相同的表名', () => {
    const bare = parseFormula('明细!A1');
    const quoted = parseFormula("'明细'!A1");
    expect(bare).toEqual(quoted); // X-I06 的核心：引号只是书写层
    expect(bare).toMatchObject({ kind: 'reference', sheet: '明细' });

    expect(parseSheetQualifiedReference('明细!A1').sheet).toBe('明细');
    expect(parseSheetQualifiedReference("'明细'!A1")).toEqual(parseSheetQualifiedReference('明细!A1'));
    // 两边解出的表名逐字符相同（== 解析一致）
    const parserSheet = bare.kind === 'reference' ? bare.sheet : null;
    expect(parseSheetQualifiedReference('明细!A1').sheet).toBe(parserSheet);
  });

  it('引用模型往返：非 ASCII 裸名不额外加引号，且解析回同一表名', () => {
    expect(formatSheetQualifier('明细')).toBe('明细!');
    expect(formatReferenceModel(parseReferenceModel('明细!A1'))).toBe('明细!A1');
    // 反向对照：含空格的表名必须加引号——与裸名不能混为一谈
    expect(formatSheetQualifier('预算 表')).toBe("'预算 表'!");
    expect(parseSheetQualifiedReference("'预算 表'!A1").sheet).toBe('预算 表');
  });

  it('sheetNameKey：Excel 表名不区分大小写，规范化后键相等', () => {
    expect(sheetNameKey('明细')).toBe(sheetNameKey("'明细'"));
    expect(sheetNameKey('Sheet1')).toBe(sheetNameKey('sheet1'));
    expect(normalizeSheetName("'it''s'")).toBe("it's");
  });
});

describe('X-I20：改名后引用仍然解析到新表名（解析一致，与书写风格无关）', () => {
  function referencing(): ReturnType<typeof createWorkbook> {
    let source = createSheet('Source', { row_count: 3, column_count: 3 });
    source = setCellValue(source, 'A1', numberValue(5));
    let user = createSheet('User', { row_count: 3, column_count: 3 });
    user = setCellValue(user, 'A1', formulaValue('Source!A1+1'));
    return createWorkbook([source, user]);
  }

  it('改名到非 ASCII 名：改写后的引用仍解出**新**表名', () => {
    const renamed = renameSheet(referencing(), 'Source', '预算表');
    const user = getSheet(renamed, 'User');
    if (user === undefined) throw new Error('缺少 User 表');
    const value = getCellValue(user, 'A1');
    const text = isFormula(value) ? value.text : '';
    expect(text.length).toBeGreaterThan(0);
    // 去掉尾巴的 `+1`，得到纯限定 + 引用（例如 `'预算表'!A1` 或 `预算表!A1`）
    const resolved = parseSheetQualifiedReference(text.replace(/\+1$/, ''));
    expect(resolved.sheet).not.toBeNull();
    expect(sheetNameKey(resolved.sheet ?? '')).toBe(sheetNameKey('预算表'));
    expect(sheetNameKey(resolved.sheet ?? '')).toBe(sheetNameKey("'预算表'"));
  });

  it('书写风格差异不影响解析：formula-model 写裸名、workbook 可写引号名，两者解出同一键', () => {
    // formula-model 的书写口径（X-I06）：非 ASCII 纯字母表名裸写
    const modelQualifier = formatSheetQualifier('预算表');
    expect(modelQualifier).toBe('预算表!');
    // workbook 改名写出的是引号形式；两种写法经 reference.ts 解出**同一个**表名键
    const renamed = renameSheet(referencing(), 'Source', '预算表');
    const user = getSheet(renamed, 'User');
    if (user === undefined) throw new Error('缺少 User 表');
    const value = getCellValue(user, 'A1');
    const text = isFormula(value) ? value.text : '';
    const workbookResolved = parseSheetQualifiedReference(text.replace(/\+1$/, ''));
    const modelResolved = parseSheetQualifiedReference(`${modelQualifier}A1`);
    expect(sheetNameKey(workbookResolved.sheet ?? '')).toBe(sheetNameKey(modelResolved.sheet ?? ''));
    // 正面对照：两侧都真的解析到"预算表"，而不是 null
    expect(workbookResolved.sheet).not.toBeNull();
    expect(modelResolved.sheet).toBe('预算表');
  });
});
