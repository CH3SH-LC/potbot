/**
 * **X04-defined-names**：把真实 XLSX 的 `<definedNames>` 读成命名引用并**真正算出数**。
 *
 * 判据（「独立预期值」）：
 *
 * 1. **解析 + 归一化**：`Data!$A$1` / `'Rates'!$B$1` / 区域 / `localSheetId` 表级名 /
 *    整列 `$A:$A` / 整行 `$2:$2` 各自映射成手算的 `{ sheet, ref }` 字面量；
 * 2. **明确 skip**：内置名 `_xlnm.*`、常量 / 公式、联合区域、3D 引用、`#REF!` 各带原因，
 *    绝不静默丢（对照 `skipped` 的 reason 字面量）；
 * 3. **端到端**：用**从 XML 读出的**命名引用（不是手填）喂给 `executeWorkbookWithNames`，
 *    `=Price*Tax`、`SUM(Total)`、表级名跨表解析都得到手算值；
 * 4. **作用域边界**：表级名被同名工作簿级名遮蔽 → 保留工作簿级、表级记 `shadowed-by-global`；
 *    `localSheetId` 越界 → `invalid-local-sheet-id`。
 */

import { describe, expect, it } from 'vitest';

import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import { numberValue } from '../../../../src/spreadsheets/value.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import type { EvalOutcome } from '../../../../src/spreadsheets/evaluate.js';
import { cellKey } from '../../../../src/spreadsheets/recalc-plan/keys.js';
import { executeWorkbookWithNames } from '../../../../src/spreadsheets/recalc-plan/execute.js';
import type { NamedReference } from '../../../../src/spreadsheets/recalc-plan/names.js';
import {
  definedNamesToNamedReferences,
  namedReferencesFromWorkbookXml,
  parseDefinedNamesXml,
  type DefinedNameEntry,
  type DefinedNameSkipReason,
} from '../../../../src/spreadsheets/recalc-plan/defined-names.js';

const XMLNS = `xmlns="${SPREADSHEETML_NAMESPACE}"`;

/** 造一个只含 `<definedNames>` 的工作簿 XML（工作表清单只为占位，解析不依赖 r:id）。 */
function workbookXml(definedNamesInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook ${XMLNS}>` +
    `<sheets>` +
    `<sheet name="Data" sheetId="1"/>` +
    `<sheet name="Rates" sheetId="2"/>` +
    `<sheet name="Calc" sheetId="3"/>` +
    `</sheets>` +
    `<definedNames>${definedNamesInner}</definedNames>` +
    `</workbook>`
  );
}

const SHEETS = ['Data', 'Rates', 'Calc'] as const;

const FULL_DEFINED_NAMES = workbookXml(
  `<definedName name="Price">Data!$A$1</definedName>` +
    `<definedName name="Tax">'Rates'!$B$1</definedName>` +
    `<definedName name="Total">Data!$A$1:$A$3</definedName>` +
    `<definedName name="LocalBox" localSheetId="2">$C$1</definedName>` +
    `<definedName name="WholeCol">Data!$A:$A</definedName>` +
    `<definedName name="WholeRow">Data!$2:$2</definedName>` +
    `<definedName name="Hidden2" hidden="1">Data!$A$2</definedName>` +
    `<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$Z$99</definedName>` +
    `<definedName name="MyConst">=42</definedName>` +
    `<definedName name="MyText">"hello"</definedName>` +
    `<definedName name="MyFormula">SUM(Data!$A$1:$A$3)</definedName>` +
    `<definedName name="Unioned">Data!$A$1,Data!$B$1</definedName>` +
    `<definedName name="ThreeD">Data:Rates!$A$1</definedName>` +
    `<definedName name="Broken">#REF!$A$1</definedName>`,
);

describe('X04：definedNames → 命名引用（解析 + 归一化）', () => {
  it('引用型定义映射成手算的 { sheet, ref }', () => {
    const { names } = namedReferencesFromWorkbookXml(FULL_DEFINED_NAMES, SHEETS);
    expect(names.map((name) => ({ name: name.name, sheet: name.sheet, ref: name.ref }))).toEqual([
      { name: 'Price', sheet: 'Data', ref: '$A$1' },
      { name: 'Tax', sheet: 'Rates', ref: '$B$1' },
      { name: 'Total', sheet: 'Data', ref: '$A$1:$A$3' },
      { name: 'LocalBox', sheet: 'Calc', ref: '$C$1' },
      { name: 'WholeCol', sheet: 'Data', ref: 'A1:A1048576' },
      { name: 'WholeRow', sheet: 'Data', ref: 'A2:XFD2' },
      { name: 'Hidden2', sheet: 'Data', ref: '$A$2' },
    ]);
  });

  it('非引用 / 内置名逐条 skip 且带原因（绝不静默丢）', () => {
    const { skipped } = namedReferencesFromWorkbookXml(FULL_DEFINED_NAMES, SHEETS);
    const byName = new Map<string, DefinedNameSkipReason>(
      skipped.map((entry) => [entry.name, entry.reason]),
    );
    expect(byName.get('_xlnm.Print_Area')).toBe('builtin-name');
    expect(byName.get('MyConst')).toBe('constant-or-formula');
    expect(byName.get('MyText')).toBe('constant-or-formula');
    expect(byName.get('MyFormula')).toBe('constant-or-formula');
    expect(byName.get('Unioned')).toBe('union-reference');
    expect(byName.get('ThreeD')).toBe('3d-reference');
    expect(byName.get('Broken')).toBe('error-reference');
    // 引用型定义不进 skipped。
    expect(skipped.map((entry) => entry.name)).not.toContain('Price');
  });

  it('parseDefinedNamesXml 读回 hidden / localSheetId / value 原文', () => {
    const entries = parseDefinedNamesXml(FULL_DEFINED_NAMES);
    const local = entries.find((entry) => entry.name === 'LocalBox');
    expect(local).toEqual({ name: 'LocalBox', localSheetId: 2, hidden: false, value: '$C$1' });
    const hidden = entries.find((entry) => entry.name === 'Hidden2');
    expect(hidden?.hidden).toBe(true);
  });

  it('读模型入口与 XML 入口等价（definedNamesToNamedReferences）', () => {
    const entries: readonly DefinedNameEntry[] = [
      { name: 'Price', localSheetId: null, hidden: false, value: 'Data!$A$1' },
      { name: 'Rates2', localSheetId: 1, hidden: false, value: 'B1' },
    ];
    const { names, skipped } = definedNamesToNamedReferences(entries, SHEETS);
    expect(names.map((name) => ({ name: name.name, sheet: name.sheet, ref: name.ref }))).toEqual([
      { name: 'Price', sheet: 'Data', ref: '$A$1' },
      { name: 'Rates2', sheet: 'Rates', ref: 'B1' },
    ]);
    expect(skipped).toEqual([]);
  });

  it('作用域边界：同名工作簿级遮蔽表级；localSheetId 越界被 skip', () => {
    const xml = workbookXml(
      `<definedName name="Tax" localSheetId="1">$B$1</definedName>` +
        `<definedName name="Tax">Data!$A$1</definedName>` +
        `<definedName name="Far" localSheetId="9">$A$1</definedName>`,
    );
    const { names, skipped } = namedReferencesFromWorkbookXml(xml, SHEETS);
    // 保留工作簿级（Data!$A$1），表级记 shadowed-by-global。
    expect(names.map((name) => ({ name: name.name, sheet: name.sheet, ref: name.ref }))).toEqual([
      { name: 'Tax', sheet: 'Data', ref: '$A$1' },
    ]);
    expect(skipped).toEqual([
      { name: 'Tax', reason: 'shadowed-by-global' },
      { name: 'Far', reason: 'invalid-local-sheet-id' },
    ]);
  });

  it('缺 name 属性的 <definedName> 显式报错（不静默跳过）', () => {
    expect(() => parseDefinedNamesXml(workbookXml(`<definedName>Data!$A$1</definedName>`))).toThrow(
      /缺少 name/,
    );
  });
});

// ---------------------------------------------------------------------------
// 端到端：从 XML 读出的名字真正参与重算
// ---------------------------------------------------------------------------

/** Data!A1=10 A2=20 A3=30；Rates!B1=0.5；Calc!C1=100（表级名 LocalBox 指向它）。 */
function namedWorkbook() {
  let data = createSheet('Data');
  data = setCellValue(data, 'A1', numberValue(10));
  data = setCellValue(data, 'A2', numberValue(20));
  data = setCellValue(data, 'A3', numberValue(30));

  let rates = createSheet('Rates');
  rates = setCellValue(rates, 'B1', numberValue(0.5));

  let calc = createSheet('Calc');
  calc = setCellValue(calc, 'C1', numberValue(100));
  calc = setCellValue(calc, 'A1', { kind: 'formula', text: 'Price*2' }); // 20
  calc = setCellValue(calc, 'A2', { kind: 'formula', text: 'Price*Tax' }); // 5
  calc = setCellValue(calc, 'A3', { kind: 'formula', text: 'SUM(Total)' }); // 60
  calc = setCellValue(calc, 'A4', { kind: 'formula', text: 'LocalBox+1' }); // 101（表级名 → Calc!C1）

  return createWorkbook([data, rates, calc]);
}

function scalarOf(outcome: EvalOutcome): unknown {
  if (!outcome.ok) throw new Error(`期待一个值，实得阻塞 ${outcome.reason}`);
  const value = outcome.value;
  return value.kind === 'error' ? value.code : value.value;
}

describe('X04：从真实 definedNames 读出的命名引用参与执行', () => {
  it('符号来自 XML（非手填）也能算出数', () => {
    const { names } = namedReferencesFromWorkbookXml(FULL_DEFINED_NAMES, SHEETS);
    const { execution } = executeWorkbookWithNames(namedWorkbook(), names);
    const at = (ref: string) => scalarOf(execution.values.get(cellKey('Calc', ref))!);
    expect(at('A1')).toBe(20);
    expect(at('A2')).toBe(5);
    expect(at('A3')).toBe(60);
    expect(at('A4')).toBe(101);
  });

  it('对照：不传名字时，命名引用公式因裸标识符无法解析而被阻塞（不是猜）', () => {
    const { execution } = executeWorkbookWithNames(namedWorkbook());
    const a2 = execution.values.get(cellKey('Calc', 'A2'))!;
    expect(a2.ok).toBe(false);
    if (!a2.ok) expect(a2.reason).toBe('parse_error');
  });

  it('手填的名字仍走同一条路（向后兼容）', () => {
    const names: readonly NamedReference[] = [
      { name: 'Price', sheet: 'Data', ref: 'A1' },
      { name: 'Tax', sheet: 'Rates', ref: 'B1' },
      { name: 'Total', sheet: 'Data', ref: 'A1:A3' },
      { name: 'LocalBox', sheet: 'Calc', ref: 'C1' },
    ];
    const { execution } = executeWorkbookWithNames(namedWorkbook(), names);
    expect(scalarOf(execution.values.get(cellKey('Calc', 'A2'))!)).toBe(5);
  });
});
