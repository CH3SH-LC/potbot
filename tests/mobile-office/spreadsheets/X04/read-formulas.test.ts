/**
 * **X04-read-formulas**：读入侧把共享公式与数组公式还原成一格一公式，并真正参与重算。
 *
 * 判据（「独立预期值」）：
 *
 * 1. **复制平移语义**：相对引用平移、`$` 锁定不动、字符串字面量 / 表名 / 函数名 / 更长标识符
 *    不动，整列 / 整行随复制平移，越界显式报错——每一条都对手工写出的结果字面量；
 * 2. **共享公式还原**：主格 + 无文本从属格 → 从属格继承并平移；
 * 3. **数组公式还原**：`ref` 范围逐格承载同一文本；
 * 4. **从 XML 解析**：`<f t="shared">` / `<f t="array">` / 普通 `<f>` 读成声明；
 * 5. **端到端执行**：共享公式逐格算出数；真数组（区域参与标量运算）**阻塞**而非产出错值，
 *    单格数组（`SUM`）照常算出。
 */

import { describe, expect, it } from 'vitest';

import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import { numberValue, blank, type CellValue } from '../../../../src/spreadsheets/value.js';
import { formatCellAddress, type CellAddress } from '../../../../src/spreadsheets/reference.js';
import type { EvalOutcome } from '../../../../src/spreadsheets/evaluate.js';
import { buildRecalcPlan } from '../../../../src/spreadsheets/recalc-plan/graph.js';
import { cellKey } from '../../../../src/spreadsheets/recalc-plan/keys.js';
import {
  executeRecalcPlan,
  type CellReader,
} from '../../../../src/spreadsheets/recalc-plan/execute.js';
import {
  parseWorksheetFormulaDecls,
  resolveWorksheetFormulas,
  shiftFormulaText,
  worksheetFormulaPlanCells,
  type WorksheetFormulaDecl,
} from '../../../../src/spreadsheets/recalc-plan/read-formulas.js';

function scalarOf(outcome: EvalOutcome): unknown {
  if (!outcome.ok) throw new Error(`期待一个值，实得阻塞 ${outcome.reason}`);
  const value = outcome.value;
  return value.kind === 'error' ? value.code : value.value;
}

/** 扁平数据表 → 读取端口（缺省空白）。 */
function readerFrom(data: Readonly<Record<string, CellValue>>): CellReader {
  return (sheet: string, address: CellAddress) =>
    data[`${sheet}!${formatCellAddress(address)}`] ?? blank;
}

const XMLNS = `xmlns="${SPREADSHEETML_NAMESPACE}"`;

function worksheetXml(sheetDataInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet ${XMLNS}><sheetData>${sheetDataInner}</sheetData></worksheet>`
  );
}

describe('X04：共享公式相对引用复制平移（shiftFormulaText）', () => {
  it('相对引用随偏移平移', () => {
    expect(shiftFormulaText('A1*2', 1, 0)).toBe('A2*2');
    expect(shiftFormulaText('A1*2', 0, 1)).toBe('B1*2');
    expect(shiftFormulaText('SUM(A1:B2)', 2, 3)).toBe('SUM(D3:E4)');
  });

  it('$ 锁定的那半不动', () => {
    expect(shiftFormulaText('$A$1+$A1+A$1', 1, 1)).toBe('$A$1+$A2+B$1');
  });

  it('字符串字面量 / 表名 / 函数名 / 更长标识符不动', () => {
    expect(shiftFormulaText('"A1"&A1', 1, 0)).toBe('"A1"&A2');
    expect(shiftFormulaText('Sheet2!A1', 0, 1)).toBe('Sheet2!B1');
    expect(shiftFormulaText("'My Sheet'!B2", 1, 0)).toBe("'My Sheet'!B3");
    expect(shiftFormulaText('Sheet1:Sheet3!A1', 0, 1)).toBe('Sheet1:Sheet3!B1');
    expect(shiftFormulaText('LOG10(A1)', 0, 1)).toBe('LOG10(B1)');
    expect(shiftFormulaText('A1NAME+A1', 0, 1)).toBe('A1NAME+B1');
  });

  it('整列 / 整行随复制平移（$ 锁定则不动）', () => {
    expect(shiftFormulaText('SUM(A:A)', 0, 1)).toBe('SUM(B:B)');
    expect(shiftFormulaText('SUM($A:$A)', 0, 1)).toBe('SUM($A:$A)');
    expect(shiftFormulaText('SUM(1:1)', 1, 0)).toBe('SUM(2:2)');
  });

  it('平移越界显式报错（不产出错位引用）', () => {
    expect(() => shiftFormulaText('A1', 0, -1)).toThrow(/越界/);
    expect(() => shiftFormulaText('A1', -1, 0)).toThrow(/越界/);
  });

  it('超上限的类引用片段（ZZZ1）被跳过而非误平移 / 误报错', () => {
    expect(shiftFormulaText('ZZZ1+A1', 0, 1)).toBe('ZZZ1+B1');
  });
});

describe('X04：共享 / 数组公式还原为一格一公式', () => {
  it('共享从属格继承主格文本并平移', () => {
    const decls: readonly WorksheetFormulaDecl[] = [
      { ref: 'A1', type: 'shared', text: 'B1*2', si: '0', range: 'A1:A2' },
      { ref: 'A2', type: 'shared', text: null, si: '0', range: null },
    ];
    const resolved = resolveWorksheetFormulas(decls);
    expect(resolved.map((cell) => ({ ref: cell.ref, text: cell.text, origin: cell.origin }))).toEqual([
      { ref: 'A1', text: 'B1*2', origin: 'shared-master' },
      { ref: 'A2', text: 'B2*2', origin: 'shared-dependent' },
    ]);
  });

  it('si 悬空 / 从属格越出主格范围 → 显式报错', () => {
    expect(() =>
      resolveWorksheetFormulas([{ ref: 'A2', type: 'shared', text: null, si: '9', range: null }]),
    ).toThrow(/找不到 si=9/);
    expect(() =>
      resolveWorksheetFormulas([
        { ref: 'A1', type: 'shared', text: 'B1', si: '0', range: 'A1:A2' },
        { ref: 'A9', type: 'shared', text: null, si: '0', range: null },
      ]),
    ).toThrow(/范围/);
  });

  it('数组公式范围逐格承载同一文本', () => {
    const resolved = resolveWorksheetFormulas([
      { ref: 'C1', type: 'array', text: 'SUM(D1:D2)', si: null, range: 'C1:C2' },
    ]);
    expect(resolved.map((cell) => ({ ref: cell.ref, text: cell.text, origin: cell.origin }))).toEqual([
      { ref: 'C1', text: 'SUM(D1:D2)', origin: 'array' },
      { ref: 'C2', text: 'SUM(D1:D2)', origin: 'array' },
    ]);
  });

  it('parseWorksheetFormulaDecls 从工作表 XML 读回三类声明', () => {
    const xml = worksheetXml(
      `<row r="1">` +
        `<c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f></c>` +
        `<c r="C1"><f t="array" ref="C1:C2">D1:D2*2</f></c>` +
        `<c r="E1"><f>1+2</f></c>` +
        `</row>` +
        `<row r="2">` +
        `<c r="A2"><f t="shared" si="0"/></c>` +
        `</row>`,
    );
    const decls = parseWorksheetFormulaDecls(xml);
    expect(decls).toEqual([
      { ref: 'A1', type: 'shared', text: 'B1*2', si: '0', range: 'A1:A2' },
      { ref: 'C1', type: 'array', text: 'D1:D2*2', si: null, range: 'C1:C2' },
      { ref: 'E1', type: 'normal', text: '1+2', si: null, range: null },
      { ref: 'A2', type: 'shared', text: null, si: '0', range: null },
    ]);
  });

  it('无文本的普通 <f> 显式报错（不静默当空白）', () => {
    const xml = worksheetXml(`<row r="1"><c r="A1"><f/></c></row>`);
    expect(() => parseWorksheetFormulaDecls(xml)).toThrow(/无文本/);
  });
});

// ---------------------------------------------------------------------------
// 端到端：读入侧还原的公式真正参与重算
// ---------------------------------------------------------------------------

describe('X04：读入侧还原的公式参与重算', () => {
  it('共享公式逐格算出数（手算：B1=5 ⇒ A1=10；B2=7 ⇒ A2=14）', () => {
    const xml = worksheetXml(
      `<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f></c></row>` +
        `<row r="2"><c r="A2"><f t="shared" si="0"/></c></row>`,
    );
    const cells = worksheetFormulaPlanCells(xml);
    const plan = buildRecalcPlan({ sheets: [{ name: 'S', cells }] });
    const execution = executeRecalcPlan(plan, {
      readCell: readerFrom({ 'S!B1': numberValue(5), 'S!B2': numberValue(7) }),
    });
    expect(scalarOf(execution.values.get(cellKey('S', 'A1'))!)).toBe(10);
    expect(scalarOf(execution.values.get(cellKey('S', 'A2'))!)).toBe(14);
  });

  it('单格数组（SUM）照常算出；真数组（区域参与标量运算）阻塞而非产出错值', () => {
    const xml = worksheetXml(
      `<row r="1">` +
        `<c r="C1"><f t="array" ref="C1:C2">SUM(D1:D2)</f></c>` +
        `<c r="E1"><f t="array" ref="E1:E2">D1:D2*2</f></c>` +
        `</row>`,
    );
    const plan = buildRecalcPlan({ sheets: [{ name: 'S', cells: worksheetFormulaPlanCells(xml) }] });
    const execution = executeRecalcPlan(plan, {
      readCell: readerFrom({ 'S!D1': numberValue(3), 'S!D2': numberValue(4) }),
    });
    // SUM 数组：两格都得标量 7（与 Excel 把标量数组填满范围一致）。
    expect(scalarOf(execution.values.get(cellKey('S', 'C1'))!)).toBe(7);
    expect(scalarOf(execution.values.get(cellKey('S', 'C2'))!)).toBe(7);
    // 区域参与标量运算：本仓不支持，必须阻塞。
    const e1 = execution.values.get(cellKey('S', 'E1'))!;
    expect(e1.ok).toBe(false);
    if (!e1.ok) expect(e1.reason).toBe('unsupported_construct');
  });

  it('从属格里指向主格绝对格的引用不漏算（主格 A1=B1*$C$1 → A2=B2*$C$1）', () => {
    const decls: readonly WorksheetFormulaDecl[] = [
      { ref: 'A1', type: 'shared', text: 'B1*$C$1', si: '0', range: 'A1:A2' },
      { ref: 'A2', type: 'shared', text: null, si: '0', range: null },
    ];
    const plan = buildRecalcPlan({
      sheets: [{ name: 'S', cells: resolveWorksheetFormulas(decls).map((cell) => ({ ref: cell.ref, formula: cell.text })) }],
    });
    const execution = executeRecalcPlan(plan, {
      readCell: readerFrom({ 'S!B1': numberValue(2), 'S!B2': numberValue(3), 'S!C1': numberValue(10) }),
    });
    expect(scalarOf(execution.values.get(cellKey('S', 'A1'))!)).toBe(20);
    expect(scalarOf(execution.values.get(cellKey('S', 'A2'))!)).toBe(30);
  });
});
