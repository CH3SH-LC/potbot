/**
 * **X-I20 集成验收（结构层引用）**：改名 / 删表不得留下**悬空引用**。
 *
 * 悬空引用 = 公式指向一张不存在的工作表（删表后旧名消失、改名后旧名消失都属于这一类）。
 * 本仓口径（R250 / XLS-08「不返回伪造结果」）：**宁阻塞，不写悬空引用**。
 *
 * 判据：
 * 1. `findDanglingSheetReferences` 是唯一诊断口径——它按**解码后**的表名（引号无关、大小写不敏感）
 *    逐处限定核对真实表名；
 * 2. 删表：被其它表引用 ⇒ 显式抛（含 X-I06 的裸非 ASCII 引用形式）；
 * 3. 改名：改写后**不得**再有公式指向旧名（后置条件）；正常改名改写到新名、零悬空；
 * 4. 反向对照：与本次操作**无关**的、早已存在的悬空引用，**不得**误伤一次无关改名
 *    （否则会把"别处的历史遗留"错算成"这次操作造成的"）。
 */

import { describe, expect, it } from 'vitest';

import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { formulaValue, isFormula, numberValue } from '../../../../src/spreadsheets/value.js';
import {
  createWorkbook,
  findDanglingSheetReferences,
  removeSheet,
  renameSheet,
} from '../../../../src/spreadsheets/workbook.js';

/** 两张表：`明细`（数据表）+ `报表`（公式表），公式由调用方给出。 */
function twoSheet(
  reportFormulas: readonly (readonly [string, string])[],
  detailName = '明细',
): ReturnType<typeof createWorkbook> {
  let detail = createSheet(detailName);
  detail = setCellValue(detail, 'A1', numberValue(9));
  let report = createSheet('报表');
  for (const [address, formula] of reportFormulas) {
    report = setCellValue(report, address, formulaValue(formula));
  }
  return createWorkbook([detail, report]);
}

function formulaTextAt(
  workbook: ReturnType<typeof createWorkbook>,
  sheetName: string,
  ref: string,
): string {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (sheet === undefined) return '';
  const value = getCellValue(sheet, ref);
  return isFormula(value) ? value.text : '';
}

describe('X-I20：findDanglingSheetReferences 指认指向不存在表的引用', () => {
  it('指向不存在的表 ⇒ 被指认；指向存在的表（裸名 / 引号名）⇒ 不算悬空', () => {
    const wb = twoSheet([
      ['A1', '幽灵!A1'], // 不存在
      ['A2', '明细!A1'], // 存在（裸名，X-I06）
      ['A3', "'明细'!A2"], // 存在（引号名）
    ]);
    const dangling = findDanglingSheetReferences(wb);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toEqual({
      sheet: '报表',
      ref: 'A1',
      formula: '幽灵!A1',
      missing_sheet: '幽灵',
    });
  });

  it('大小写不敏感：`source!A1` 指向已存在的 `Source` 不算悬空', () => {
    let source = createSheet('Source');
    source = setCellValue(source, 'A1', numberValue(1));
    let user = createSheet('User');
    user = setCellValue(user, 'A1', formulaValue('source!A1')); // 小写变体
    expect(findDanglingSheetReferences(createWorkbook([source, user]))).toEqual([]);
  });
});

describe('X-I20：删表挡住悬空引用（含裸非 ASCII 形式）', () => {
  it('被其它表引用 ⇒ 显式抛，不静默删', () => {
    const wb = twoSheet([['A1', '明细!A1']]);
    expect(() => removeSheet(wb, '明细')).toThrow(/跨表引用|悬空/);
  });

  it('不被任何表引用 ⇒ 正常删除', () => {
    const wb = twoSheet([['A1', 'A2']]); // 本表引用，不指向 明细
    const after = removeSheet(wb, '明细');
    expect(after.sheets.map((sheet) => sheet.name)).toEqual(['报表']);
  });
});

describe('X-I20：改名不留悬空引用（后置条件）+ 无关悬空不误伤', () => {
  it('正常改名：引用改写到新名，零悬空', () => {
    let source = createSheet('Source');
    source = setCellValue(source, 'A1', numberValue(5));
    let user = createSheet('User');
    user = setCellValue(user, 'A1', formulaValue('Source!A1+1'));
    const renamed = renameSheet(createWorkbook([source, user]), 'Source', 'Budget');
    expect(findDanglingSheetReferences(renamed)).toEqual([]);
    expect(formulaTextAt(renamed, 'User', 'A1')).toBe('Budget!A1+1');
  });

  it('改名到非 ASCII 名：引用改写后零悬空', () => {
    let source = createSheet('Source');
    source = setCellValue(source, 'A1', numberValue(5));
    let user = createSheet('User');
    user = setCellValue(user, 'A1', formulaValue('Source!A1+1'));
    const renamed = renameSheet(createWorkbook([source, user]), 'Source', '预算表');
    expect(findDanglingSheetReferences(renamed)).toEqual([]);
    const text = formulaTextAt(renamed, 'User', 'A1');
    expect(text.endsWith('!A1+1')).toBe(true);
  });

  it('反向对照：别处早已存在的悬空引用，不得误伤一次无关改名', () => {
    // 表A 里有一条指向不存在的 `别的!A1` 的历史遗留
    let sheetA = createSheet('表A');
    sheetA = setCellValue(sheetA, 'A2', formulaValue('IF(B1=1,别的!A1,0)'));
    // 与本次改名无关：把 表A 改名为 表B 应当成功
    const renamed = renameSheet(createWorkbook([sheetA]), '表A', '表B');
    expect(renamed.sheets.map((sheet) => sheet.name)).toEqual(['表B']);
    // 那条历史遗留仍是悬空（本单元只报告、不擅自改写）
    expect(findDanglingSheetReferences(renamed).map((item) => item.missing_sheet)).toEqual(['别的']);
  });
});
