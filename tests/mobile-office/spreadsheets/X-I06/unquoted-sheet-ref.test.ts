/**
 * **X-I06-a**：裸（未加引号）非 ASCII 工作表引用的支持与边界。
 *
 * 背景：X-R05 / X-R04 登记的边界是"`formula-parse.ts` 只接受带引号的表名前缀
 * （`'表名'!A1`）；`=明细!A1` 这样的裸非 ASCII 表名会按 `parse_error` 阻塞"。
 *
 * **本单元的决定：支持裸非 ASCII 表名**。依据是 Excel 自身的引用规则——只有当表名**含空格 /
 * 标点 / 以数字或 `.` 开头 / 形如单元格引用或 `TRUE`/`FALSE`** 时才必须加单引号；
 * 纯字母（含汉字等非 ASCII 字母）的表名可以裸写。因此 `=明细!A1` 在真实 Excel 里合法，
 * 本仓解析器不应把它当作超出子集的构造阻塞。
 *
 * 本用例组逐层验证"支持"是真的、且**没有**顺手放行真正需要引号的表名：
 * 1. 词法 / 语法（`formula-parse.ts`）；
 * 2. 引用模型（`formula-model.ts` 的解析 / 规范化 / 平移 / 表名前缀书写）；
 * 3. 保守字符串迁移（`formula.ts` 的 4 条安全规则，路径不变、照常迁移引用）；
 * 4. 重算端到端 + 真实 .xlsx 字节读回；
 * 5. 负面对照：含空格的裸表名、无 `!` 的裸标识符仍解析失败。
 *
 * ## 未验证（不得由本文件绿灯替代）
 *
 * - **真实 Excel / WPS / 真机打开**产出的 .xlsx：未做；`consumer-reopen` 层未验证。
 * - 本文件不声称"Excel 一定接受某表名"——只声称本仓解析器接受了 Excel 规则下**应当**接受的裸名，
 *   并保留了 Excel 规则下**必然**失败的负例。
 */

import { describe, expect, it } from 'vitest';

import { FormulaParseError, parseFormula } from '../../../../src/spreadsheets/formula-parse.js';
import {
  formatReferenceModel,
  formatSheetQualifier,
  normalizeFormula,
  parseReferenceModel,
  shiftFormula,
} from '../../../../src/spreadsheets/formula-model.js';
import { extractFormulaReferences, mapFormulaColumns, mapFormulaRows } from '../../../../src/spreadsheets/formula.js';
import { recalcWorkbook, type CellKey } from '../../../../src/spreadsheets/recalc.js';
import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { formulaValue, numberValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook, getSheet } from '../../../../src/spreadsheets/workbook.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';

describe('X-I06 词法 / 语法：裸非 ASCII 表名走与 ASCII 表名同一条路径', () => {
  it('单元格 / 区域 / 函数参数里的裸汉字表名都解析成跨表引用', () => {
    expect(parseFormula('明细!A1')).toEqual({
      kind: 'reference',
      sheet: '明细',
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
    expect(parseFormula('明细!A1:B3')).toMatchObject({ kind: 'range', sheet: '明细' });
    const call = parseFormula('SUM(明细!A1:A3)');
    expect(call).toMatchObject({ kind: 'call', name: 'SUM' });
    if (call.kind !== 'call') throw new Error('unreachable');
    expect(call.args[0]).toMatchObject({ kind: 'range', sheet: '明细' });
    // ASCII + 汉字混排、以及绝对引用，同样裸写。
    expect(parseFormula('Sheet明细!$A$1')).toMatchObject({
      kind: 'reference',
      sheet: 'Sheet明细',
      reference: { column: 1, row: 1, abs_column: true, abs_row: true },
    });
  });

  it('对照：带引号的同一表名解析结果**逐字段相同**（引号只是书写层）', () => {
    expect(parseFormula("'明细'!A1")).toEqual(parseFormula('明细!A1'));
  });

  it('负面对照：含空格的裸表名、无 `!` 的裸标识符仍解析失败（不猜）', () => {
    expect(() => parseFormula('预算 表!A1')).toThrow(FormulaParseError);
    expect(() => parseFormula('明细')).toThrow(FormulaParseError);
  });
});

describe('X-I06 引用模型：非 ASCII 裸名的规范化 / 平移 / 表名前缀书写', () => {
  it('规范化保留裸非 ASCII 表名（不额外加引号），逐字往返', () => {
    expect(normalizeFormula('明细!a1*2')).toEqual({ ok: true, text: '明细!A1*2' });
    const model = parseReferenceModel('明细!A1');
    expect(model).toEqual({
      kind: 'cell',
      sheet: '明细',
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
    expect(formatReferenceModel(model)).toBe('明细!A1');
    expect(formatSheetQualifier('明细')).toBe('明细!');
    // 反向对照：含空格的汉字表名**必须**加引号——与上面一条不能混为一谈。
    expect(formatSheetQualifier('预算 表')).toBe("'预算 表'!");
  });

  it('平移走 AST：裸非 ASCII 表名前缀只是一个限定词，引用照常随位移', () => {
    expect(shiftFormula('明细!A1*2', { column: 1, row: 0 })).toEqual({ ok: true, text: '明细!B1*2' });
    expect(shiftFormula('明细!$A$1', { column: 1, row: 0 })).toEqual({ ok: true, text: '明细!$A$1' });
    // 反面对照：若把 `明细` 当成命名区域（旧行为），上面两条会是 parse_error。
    expect(normalizeFormula('预算 表!A1')).toMatchObject({ ok: false, reason: 'parse_error' });
  });
});

describe('X-I06 保守字符串迁移：4 条安全规则不变，裸非 ASCII 前缀照常迁移', () => {
  it('行 / 列迁移只改引用、不动表名前缀', () => {
    expect(mapFormulaRows('明细!A1', 1, 1, 'insert')).toEqual({ ok: true, text: '明细!A2' });
    expect(mapFormulaColumns('明细!A1+B1', 2, 1, 'insert')).toEqual({ ok: true, text: '明细!A1+C1' });
  });

  it('引用抽取把裸非 ASCII 前缀后的引用抽出来（前缀不是引用的一部分）', () => {
    const refs = extractFormulaReferences('明细!A1:B2');
    expect(refs?.map((item) => `${item.column},${item.row}`)).toEqual(['1,1', '2,2']);
  });
});

// ---------------------------------------------------------------------------
// 端到端：重算 + 真实 .xlsx 字节读回
// ---------------------------------------------------------------------------

/** 两张表：`明细` 放数据，`报表` 用裸非 ASCII 前缀跨表引用它。 */
function crossSheetWorkbook(): ReturnType<typeof createWorkbook> {
  let detail = createSheet('明细');
  detail = setCellValue(detail, 'A1', numberValue(9));
  detail = setCellValue(detail, 'A2', numberValue(30));
  let report = createSheet('报表');
  report = setCellValue(report, 'A1', formulaValue('明细!A1*2'));
  report = setCellValue(report, 'A2', formulaValue('SUM(明细!A1:A2)'));
  return createWorkbook([detail, report]);
}

function outcomeOf(report: ReturnType<typeof recalcWorkbook>, key: CellKey) {
  const outcome = report.values.get(key);
  if (outcome === undefined) throw new Error(`缺少 ${key} 的求值结论`);
  return outcome;
}

describe('X-I06 端到端：裸非 ASCII 跨表引用真的算得出、并能在真实字节里往返', () => {
  it('重算：跨表引用解析到正确工作表，值 = 18 / SUM = 39', () => {
    const report = recalcWorkbook(crossSheetWorkbook());
    expect(outcomeOf(report, '报表!A1')).toEqual({ ok: true, value: { kind: 'number', value: 18 } });
    expect(outcomeOf(report, '报表!A2')).toEqual({ ok: true, value: { kind: 'number', value: 39 } });
  });

  it('真实 .xlsx：写 → 读回，公式原文与表名逐字保留，重算值不变', () => {
    const bytes = writeWorkbookXlsx(crossSheetWorkbook()).bytes;
    expect(bytes.byteLength).toBeGreaterThan(0);
    const read = readWorkbookXlsx(bytes).workbook;
    const report = getSheet(read, '报表');
    if (report === undefined) throw new Error('读回的工作簿缺少 报表');
    expect(getCellValue(report, 'A1')).toEqual({ kind: 'formula', text: '明细!A1*2' });
    expect(getCellValue(report, 'A2')).toEqual({ kind: 'formula', text: 'SUM(明细!A1:A2)' });
    // 读回后重算仍是 18 / 39——证明裸非 ASCII 前缀不只是"文本被存下来了"。
    const recount = recalcWorkbook(read);
    expect(outcomeOf(recount, '报表!A1')).toEqual({ ok: true, value: { kind: 'number', value: 18 } });
    expect(outcomeOf(recount, '报表!A2')).toEqual({ ok: true, value: { kind: 'number', value: 39 } });
  });
});
