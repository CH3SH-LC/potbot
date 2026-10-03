/**
 * FA-VERIFY-WAVE-2 · 第二轮独立验证：表格域（第一轮**未覆盖**的模块）
 *
 * 覆盖模块：`quantity` / `excel-date` / `sort-filter` / `formula-model` / `conditional-format` /
 * `formula-cache` / `workbook` / `structured-table` / `sheet`。
 *
 * 纪律：全部输入由验证方**自行构造**，不复用实现者的 fixture / 用例 / 结论。
 * 每条给出「正向 + 反向对照」。只复算纯逻辑；真机 / 真实 Excel 一律未实测。
 */

import { describe, expect, it } from 'vitest';

import {
  addQuantities,
  compareQuantities,
  formatQuantity,
  parseQuantity,
  sumQuantities,
} from '../../../src/spreadsheets/quantity.js';
import { fromExcelSerial, isDateFormatCode, isBuiltinDateFormatId, toExcelSerial } from '../../../src/spreadsheets/excel-date.js';
import {
  applyFilter,
  cellSignature,
  compareCellValues,
  dedupeRows,
  filterRowIndices,
  sortRange,
} from '../../../src/spreadsheets/sort-filter.js';
import {
  buildEditableFormulaCellXml,
  createNamedRegionTable,
  formatReferenceModel,
  isValidNamedRegionName,
  normalizeFormula,
  normalizeFormulaText,
  parseReferenceModel,
  resolveNamedRegion,
  shiftFormula,
} from '../../../src/spreadsheets/formula-model.js';
import {
  compileConditionalFormats,
  migrateIntervalRows,
  normalizePriorities,
  validateCfRule,
  type CfRule,
} from '../../../src/spreadsheets/conditional-format.js';
import {
  buildFormulaCacheFromWorkbook,
  blockedFormulaEntries,
  renderFormulaCellXml,
  verifyFormulaCache,
  type FormulaCache,
  type FormulaCacheEntry,
} from '../../../src/spreadsheets/formula-cache.js';
import { cellKey } from '../../../src/spreadsheets/recalc.js';
import {
  activeSheetName,
  addSheet,
  createWorkbook,
  getSheet,
  removeSheet,
  renameSheet,
  sheetNames,
  type WorkbookState,
} from '../../../src/spreadsheets/workbook.js';
import {
  buildTotalsFormulas,
  createStructuredTable,
  isValidTableName,
  migrateTableRange,
  tableDataRange,
  tableHeaderRange,
  tableTotalsRange,
} from '../../../src/spreadsheets/structured-table.js';
import {
  clearCell,
  createSheet,
  getCellValue,
  hasCell,
  insertRows,
  setCellValue,
  type SheetState,
} from '../../../src/spreadsheets/sheet.js';
import {
  blank,
  formulaValue,
  numberValue,
  requireNumericValue,
  textValue,
  valuesEqual,
} from '../../../src/spreadsheets/value.js';

// ---------------------------------------------------------------------------
// 夹具（验证方自造）
// ---------------------------------------------------------------------------

function sheetWithRows(rows: readonly (readonly [string, number])[], name = 'S1'): SheetState {
  let sheet = createSheet(name, { row_count: 50, column_count: 10 });
  rows.forEach(([text, num], index) => {
    const row = index + 1;
    sheet = setCellValue(sheet, `A${String(row)}`, textValue(text));
    sheet = setCellValue(sheet, `B${String(row)}`, numberValue(num));
  });
  return sheet;
}

// ===========================================================================
// 1. quantity —— 定点金额（XLS-17 / R248）
// ===========================================================================

describe('独立验证 · spreadsheets/quantity', () => {
  it('正向：十进制文本精确落到最小单位整数，不经浮点', () => {
    const q = parseQuantity('19.99', 2, 'CNY', 'CNY');
    expect(q.amount_minor).toBe(1999n);
    expect(q.scale).toBe(2);
    expect(formatQuantity(q)).toBe('19.99');
    const sum = addQuantities(parseQuantity('0.1', 2, 'CNY'), parseQuantity('0.2', 2, 'CNY'));
    expect(sum.amount_minor).toBe(30n);
    expect(formatQuantity(sum)).toBe('0.30');
  });

  it('反向对照 A：已在浮点里丢精度的输入 ⇒ 显式失败，不静默四舍五入', () => {
    // 0.1+0.2 = 0.30000000000000004（17 位小数）⇒ 超过 scale=2 ⇒ 拒
    expect(() => parseQuantity(0.1 + 0.2, 2, 'CNY')).toThrow(/精度|小数位/);
    expect(() => parseQuantity('1.999', 2, 'CNY')).toThrow(/精度|小数位/);
  });

  it('反向对照 B：空列表 ⇒ empty（不是 0）；跨单位 / 跨币种 ⇒ unit_mismatch / 抛', () => {
    expect(sumQuantities([])).toEqual({ ok: false, reason: 'empty' });
    const cny = parseQuantity('1', 2, '元', 'CNY');
    const usd = parseQuantity('1', 2, '元', 'USD');
    expect(sumQuantities([cny, usd])).toEqual({ ok: false, reason: 'unit_mismatch' });
    const other = parseQuantity('1', 2, '件');
    expect(() => compareQuantities(cny, other)).toThrow(/跨单位/);
    expect(() => addQuantities(cny, usd)).toThrow(/跨币种/);
  });

  it('反向对照 C：负数格式化与降精度拒绝', () => {
    expect(formatQuantity(parseQuantity('-0.05', 2, '元'))).toBe('-0.05');
    // 把 scale=2 的量降到 scale=1 会丢精度 ⇒ 抛
    const a = parseQuantity('1.25', 2, '元');
    const b = parseQuantity('1.2', 1, '元');
    expect(() => addQuantities(a, b)).not.toThrow(); // 取大精度，不丢精度
    expect(addQuantities(a, b).scale).toBe(2);
  });
});

// ===========================================================================
// 2. excel-date —— 序列号换算与日期格式判定
// ===========================================================================

describe('独立验证 · spreadsheets/excel-date', () => {
  it('正向：1970-01-01 = 25569 天；往返保真', () => {
    expect(toExcelSerial(0)).toBe(25569);
    expect(fromExcelSerial(25569)).toBe(0);
    const ms = 1_700_000_000_000;
    expect(fromExcelSerial(toExcelSerial(ms))).toBe(ms);
    expect(fromExcelSerial(25569.5)).toBe(43_200_000); // 0.5 天 = 12 小时
  });

  it('反向对照：非有限数 ⇒ 抛（墙钟 / NaN 不得悄悄变成日期）', () => {
    expect(() => toExcelSerial(Number.NaN)).toThrow();
    expect(() => fromExcelSerial(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('正向 + 反向：日期格式启发式剥离字面量 / 区段 / 转义', () => {
    expect(isDateFormatCode('yyyy-mm-dd')).toBe(true);
    expect(isDateFormatCode('[h]:mm:ss')).toBe(true);
    // 反向：数字格式与纯字面量 / 转义后的字母都不算日期
    expect(isDateFormatCode('0.00')).toBe(false);
    expect(isDateFormatCode('General')).toBe(false);
    expect(isDateFormatCode('[Red]0.0')).toBe(false);
    expect(isDateFormatCode('\\d')).toBe(false); // 被转义的 d 不是占位符
    expect(isDateFormatCode('"day"')).toBe(false); // 引号字面量整体丢弃
    expect(isBuiltinDateFormatId(14)).toBe(true);
    expect(isBuiltinDateFormatId(44)).toBe(false);
  });
});

// ===========================================================================
// 3. sort-filter —— 整行搬运 / 类型不互冒充
// ===========================================================================

describe('独立验证 · spreadsheets/sort-filter', () => {
  it('正向：排序按整行搬运，列不错配', () => {
    const sheet = sheetWithRows([
      ['b', 2],
      ['a', 1],
      ['c', 3],
    ]);
    const sorted = sortRange(sheet, 'A1:B3', [{ column: 1, direction: 'asc' }]);
    expect(getCellValue(sorted, 'A1')).toEqual(textValue('a'));
    expect(getCellValue(sorted, 'B1')).toEqual(numberValue(1));
    expect(getCellValue(sorted, 'A3')).toEqual(textValue('c'));
    expect(getCellValue(sorted, 'B3')).toEqual(numberValue(3));
  });

  it('反向对照 A：按第二列降序 ⇒ 行整体反转，A 列随之变', () => {
    const sheet = sheetWithRows([
      ['b', 2],
      ['a', 1],
      ['c', 3],
    ]);
    const sorted = sortRange(sheet, 'A1:B3', [{ column: 2, direction: 'desc' }]);
    expect(getCellValue(sorted, 'A1')).toEqual(textValue('c'));
    expect(getCellValue(sorted, 'B1')).toEqual(numberValue(3));
    expect(getCellValue(sorted, 'A3')).toEqual(textValue('a'));
  });

  it('反向对照 B：空键表 ⇒ 抛；文本算子不作用于数值格（类型不互冒充）', () => {
    const sheet = sheetWithRows([['b', 2]]);
    expect(() => sortRange(sheet, 'A1:B1', [])).toThrow(/至少需要一个排序键/);
    // B 列是数值 2，contains "2" 不应命中（不做隐式字符串化）
    const hits = filterRowIndices(sheet, 'A1:B1', {
      op: 'and',
      conditions: [{ column: 2, operator: 'contains', text: '2' }],
    });
    expect(hits).toEqual([]);
    // 而 A 列是文本 'b'，contains 'b' 命中
    const textHits = filterRowIndices(sheet, 'A1:B1', {
      op: 'and',
      conditions: [{ column: 1, operator: 'contains', text: 'b' }],
    });
    expect(textHits).toEqual([1]);
  });

  it('正向 + 反向：判重签名区分 number 1 与 text "1"；去重保留首行', () => {
    expect(cellSignature(numberValue(1))).not.toBe(cellSignature(textValue('1')));
    let sheet = createSheet('D', { row_count: 10, column_count: 5 });
    sheet = setCellValue(sheet, 'A1', textValue('x'));
    sheet = setCellValue(sheet, 'A2', textValue('x'));
    sheet = setCellValue(sheet, 'A3', textValue('y'));
    const deduped = dedupeRows(sheet, 'A1:A3');
    expect(getCellValue(deduped, 'A1')).toEqual(textValue('x'));
    expect(getCellValue(deduped, 'A2')).toEqual(textValue('y'));
    expect(getCellValue(deduped, 'A3')).toEqual(blank);
  });

  it('反向对照 C：applyFilter 删掉不命中行（整行）', () => {
    let sheet = createSheet('F', { row_count: 10, column_count: 5 });
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'A2', numberValue(2));
    sheet = setCellValue(sheet, 'A3', numberValue(3));
    const kept = applyFilter(sheet, 'A1:A3', {
      op: 'and',
      conditions: [{ column: 1, operator: 'greaterThan', value: numberValue(1) }],
    });
    expect(getCellValue(kept, 'A1')).toEqual(numberValue(2));
    expect(getCellValue(kept, 'A2')).toEqual(numberValue(3));
    expect(compareCellValues(numberValue(1), numberValue(2))).toBeLessThan(0);
  });
});

// ===========================================================================
// 4. formula-model —— 引用模型 / 规范化 / 平移
// ===========================================================================

describe('独立验证 · spreadsheets/formula-model', () => {
  it('正向：三类引用互不冒充；规范化书写', () => {
    expect(parseReferenceModel('A1')).toMatchObject({ kind: 'cell', sheet: null });
    expect(parseReferenceModel('A1:B2')).toMatchObject({ kind: 'range' });
    expect(parseReferenceModel('TaxRate')).toMatchObject({ kind: 'name' });
    expect(formatReferenceModel(parseReferenceModel('$a$1'))).toBe('$A$1');
    expect(formatReferenceModel(parseReferenceModel('Sheet1!b2'))).toBe('Sheet1!B2');
  });

  it('反向对照 A：越界形状（XFE1）显式失败，不回落成命名区域', () => {
    expect(() => parseReferenceModel('XFE1')).toThrow(/越出 Excel 网格|网格/);
    // 但形状合法的命名区域名被判非法
    expect(isValidNamedRegionName('A1')).toBe(false);
    expect(isValidNamedRegionName('TRUE')).toBe(false);
    expect(isValidNamedRegionName('data_2024')).toBe(true);
  });

  it('反向对照 B：命名区域表重复（大小写不敏感）⇒ 抛；定义链 ⇒ 抛', () => {
    expect(() =>
      createNamedRegionTable([
        { name: 'Rate', target: 'A1' },
        { name: 'RATE', target: 'B1' },
      ]),
    ).toThrow(/重复定义/);
    expect(() => createNamedRegionTable([{ name: 'A', target: 'B' }])).toThrow(/又是一个名字/);
    const table = createNamedRegionTable([{ name: 'Rate', target: 'Sheet1!$A$1' }]);
    expect(resolveNamedRegion(table, 'rate')).toMatchObject({ kind: 'cell' });
    expect(resolveNamedRegion(table, 'missing')).toBeUndefined();
  });

  it('正向 + 反向：平移只动非绝对轴；越界 ⇒ 具名阻塞', () => {
    expect(shiftFormula('A1+B2', { column: 1, row: 0 })).toEqual({ ok: true, text: 'B1+C2' });
    expect(shiftFormula('$A$1+B2', { column: 1, row: 1 })).toEqual({ ok: true, text: '$A$1+C3' });
    const oob = shiftFormula('A1', { column: 0, row: -1 });
    expect(oob.ok).toBe(false);
    if (!oob.ok) expect(oob.reason).toBe('shifted_out_of_bounds');
    // 命名区域解析不出来 ⇒ 平移必须**阻塞并保留原文**，不静默原样返回
    const named = shiftFormula('TaxRate*2', { column: 1, row: 0 });
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.reason).toBe('parse_error');
  });

  it('反向对照 C：normalizeFormula 去空白 / 去前缀 =；空公式 ⇒ 抛', () => {
    expect(normalizeFormula('= A1 + B2 ')).toEqual({ ok: true, text: 'A1+B2' });
    expect(normalizeFormulaText('=Sheet1!A1')).toBe('Sheet1!A1');
    expect(() => normalizeFormulaText('=')).toThrow(/空/);
    // 可编辑公式格**写不出** <v>
    const xml = buildEditableFormulaCellXml('a1', '1+2');
    expect(xml).toContain('<f>1+2</f>');
    expect(xml).not.toContain('<v>');
  });
});

// ===========================================================================
// 5. conditional-format —— 优先级 / 迁移 / x14
// ===========================================================================

describe('独立验证 · spreadsheets/conditional-format', () => {
  const cellRule: CfRule = { range: 'A1:A5', priority: 1, type: 'cellIs', operator: 'greaterThan', formulas: ['5'] };

  it('正向：编译出标准块与 dxf；空规则集 ⇒ 全 null', () => {
    const compiled = compileConditionalFormats([{ ...cellRule, format: { fill_color: 'FF0000' } }]);
    expect(compiled.conditional_formatting_xml).toContain('conditionalFormatting');
    expect(compiled.conditional_formatting_xml).toContain('sqref="A1:A5"');
    expect(compiled.dxfs_xml).toContain('<dxfs');
    const empty = compileConditionalFormats([]);
    expect(empty.conditional_formatting_xml).toBeNull();
    expect(empty.dxfs_xml).toBeNull();
  });

  it('反向对照 A：cellIs 缺 operator / 非 cellIs 带 operator ⇒ 各自抛', () => {
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'cellIs', formulas: ['5'] })).toThrow(/operator/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'expression', formulas: ['A1>0'], operator: 'equal' })).toThrow(
      /不接受 operator/,
    );
    expect(() => validateCfRule({ range: 'A1', priority: 0, type: 'expression', formulas: ['A1>0'] })).toThrow(/优先级/);
  });

  it('反向对照 B：重复优先级 ⇒ 抛（次序有歧义不猜）；归一化重编号为 1..N', () => {
    const a: CfRule = { range: 'A1', priority: 5, type: 'expression', formulas: ['A1>0'] };
    const b: CfRule = { range: 'A2', priority: 9, type: 'expression', formulas: ['B1>0'] };
    expect(normalizePriorities([a, b]).map((rule) => rule.priority)).toEqual([1, 2]);
    expect(() => normalizePriorities([a, { ...b, priority: 5 }])).toThrow(/重复优先级/);
  });

  it('正向 + 反向：区间迁移；整体删掉 ⇒ deleted', () => {
    expect(migrateIntervalRows('A2:A4', 2, 3, 'delete')).toEqual({ ok: false, reason: 'deleted' });
    expect(migrateIntervalRows('A1:A2', 5, 1, 'delete')).toEqual({ ok: true, range: 'A1:A2' });
    const truncated = migrateIntervalRows('A1:A5', 3, 2, 'delete');
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.range).toBe('A1:A3');
  });

  it('反向对照 C：x14 扩展只收 colorScale/dataBar/iconSet；带 format 的扩展规则 ⇒ 抛', () => {
    const scale: CfRule = {
      range: 'A1:A5',
      priority: 1,
      type: 'colorScale',
      extended: true,
      color_scale: [
        { type: 'min', color: 'FF0000' },
        { type: 'max', color: '00FF00' },
      ],
    };
    const compiled = compileConditionalFormats([scale]);
    expect(compiled.x14_xml).toContain('x14:conditionalFormatting');
    expect(compiled.conditional_formatting_xml).toBeNull();
    expect(() => validateCfRule({ ...scale, format: { fill_color: 'FFFFFF' } })).toThrow(/不接受 format/);
    expect(() => validateCfRule({ ...cellRule, extended: true })).toThrow(/x14 扩展块/);
  });
});

// ===========================================================================
// 6. formula-cache —— <f> + <v> 成对；阻塞不伪造
// ===========================================================================

function cacheWorkbook(): WorkbookState {
  let sheet = createSheet('Sheet1', { row_count: 20, column_count: 10 });
  sheet = setCellValue(sheet, 'A1', numberValue(1));
  sheet = setCellValue(sheet, 'A2', numberValue(2));
  sheet = setCellValue(sheet, 'A3', numberValue(3));
  sheet = setCellValue(sheet, 'D1', formulaValue('SUM(A1:A3)'));
  sheet = setCellValue(sheet, 'D3', formulaValue('FOO(A1)'));
  return createWorkbook([sheet]);
}

describe('独立验证 · spreadsheets/formula-cache', () => {
  it('正向：可算公式写 <f>+<v>；阻塞公式只写 <f>', () => {
    const cache = buildFormulaCacheFromWorkbook(cacheWorkbook());
    const good = cache.by_key.get(cellKey('Sheet1', 'D1')) as FormulaCacheEntry;
    const goodXml = renderFormulaCellXml(good);
    expect(goodXml).toContain('<f>SUM(A1:A3)</f>');
    expect(goodXml).toContain('<v>6</v>');
    const blocked = blockedFormulaEntries(cache);
    expect(blocked.map((entry) => entry.ref)).toEqual(['D3']);
    expect(renderFormulaCellXml(blocked[0] as FormulaCacheEntry)).not.toContain('<v>');
  });

  it('反向对照 A：缓存与工作簿一致 ⇒ consistent；公式被改写 ⇒ formula_text_mismatch', () => {
    const workbook = cacheWorkbook();
    const cache = buildFormulaCacheFromWorkbook(workbook);
    expect(verifyFormulaCache(workbook, cache)).toMatchObject({ consistent: true });
    const sheet = getSheet(workbook, 'Sheet1');
    if (sheet === undefined) throw new Error('no sheet');
    const mutated = createWorkbook([setCellValue(sheet, 'D1', formulaValue('SUM(A1:A2)'))]);
    const check = verifyFormulaCache(mutated, cache);
    expect(check.consistent).toBe(false);
    expect(check.discrepancies.some((d) => d.kind === 'formula_text_mismatch')).toBe(true);
  });

  it('反向对照 B：缓存里有值、重算判定阻塞 ⇒ fabricated_value（不伪造数值）', () => {
    const workbook = cacheWorkbook();
    const cache = buildFormulaCacheFromWorkbook(workbook);
    // 手工把 D3（阻塞）伪造成"有值"的条目 —— 反向对照：闸门必须报 fabricated_value
    const forged: FormulaCacheEntry = { ...(cache.by_key.get(cellKey('Sheet1', 'D3')) as FormulaCacheEntry), outcome: { ok: true, value: { kind: 'number', value: 42 } } };
    const entries = cache.entries.map((entry) => (entry.key === forged.key ? forged : entry));
    const by_key = new Map(entries.map((entry) => [entry.key, entry] as const));
    const tampered: FormulaCache = { sheets: cache.sheets, entries, by_key };
    const check = verifyFormulaCache(workbook, tampered);
    expect(check.discrepancies.some((d) => d.kind === 'fabricated_value')).toBe(true);
  });

  it('反向对照 C：缓存指向不存在的表 / 非公式格 ⇒ unknown_sheet / not_a_formula_cell', () => {
    const workbook = cacheWorkbook();
    const cache = buildFormulaCacheFromWorkbook(workbook);
    const phantom: FormulaCacheEntry = {
      key: cellKey('NoSuchSheet', 'A1'),
      sheet: 'NoSuchSheet',
      ref: 'A1',
      formula: 'A1',
      outcome: { ok: true, value: { kind: 'number', value: 1 } },
    };
    const entries = [...cache.entries, phantom];
    const by_key = new Map(entries.map((entry) => [entry.key, entry] as const));
    const check = verifyFormulaCache(workbook, { sheets: cache.sheets, entries, by_key });
    expect(check.discrepancies.some((d) => d.kind === 'unknown_sheet')).toBe(true);
  });
});

// ===========================================================================
// 7. workbook —— 多表 / 活跃表身份 / 跨表引用
// ===========================================================================

describe('独立验证 · spreadsheets/workbook', () => {
  it('正向：默认一张 Sheet1；加表后活跃表按身份带到新集合', () => {
    let wb = createWorkbook();
    expect(sheetNames(wb)).toEqual(['Sheet1']);
    wb = addSheet(wb, 'Sheet2');
    wb = addSheet(wb, 'Sheet3', 0);
    expect(sheetNames(wb)).toEqual(['Sheet3', 'Sheet1', 'Sheet2']);
    expect(activeSheetName(wb)).toBe('Sheet1');
  });

  it('反向对照 A：删最后一张 ⇒ 抛；重名 ⇒ 抛；被跨表引用指向的表 ⇒ 抛', () => {
    const only = createWorkbook();
    expect(() => removeSheet(only, 'Sheet1')).toThrow(/至少保留一张/);
    const wb = createWorkbook();
    expect(() => addSheet(wb, 'Sheet1')).toThrow(/重名/);
    let two = createWorkbook([createSheet('Sheet1'), createSheet('Sheet2')]);
    const s2 = getSheet(two, 'Sheet2');
    if (s2 === undefined) throw new Error('no Sheet2');
    two = createWorkbook([getSheet(two, 'Sheet1') as SheetState, setCellValue(s2, 'A1', formulaValue('Sheet1!A1*2'))]);
    expect(() => removeSheet(two, 'Sheet1')).toThrow(/跨表引用/);
  });

  it('反向对照 B：改名**重写**跨表限定；改名后删表不再被引用挡住', () => {
    const s1 = createSheet('Sheet1');
    const s2 = setCellValue(createSheet('Sheet2'), 'A1', formulaValue('Sheet1!A1*2'));
    const wb = createWorkbook([s1, s2]);
    const renamed = renameSheet(wb, 'Sheet1', 'Data');
    const data = getSheet(renamed, 'Data');
    expect(data).toBeDefined();
    expect(getCellValue(getSheet(renamed, 'Sheet2') as SheetState, 'A1')).toEqual(formulaValue('Data!A1*2'));
    expect(sheetNames(renamed)).toEqual(['Data', 'Sheet2']);
  });
});

// ===========================================================================
// 8. structured-table —— 身份 / 区域迁移 / OOXML
// ===========================================================================

describe('独立验证 · spreadsheets/structured-table', () => {
  it('正向：标题 / 数据 / 汇总三段区域正确', () => {
    const withTotals = createStructuredTable({
      name: 'SalesTable',
      range: 'A1:C4',
      columns: [{ name: 'X', totals_function: 'sum' }, 'Y', 'Z'],
      totals_row: true,
    });
    expect(tableHeaderRange(withTotals)).toBe('A1:C1');
    expect(tableDataRange(withTotals)).toBe('A2:C3');
    expect(tableTotalsRange(withTotals)).toBe('A4:C4');
    expect(buildTotalsFormulas(withTotals)[0]?.formula).toBe('SUBTOTAL(109,SalesTable[X])');
    expect(buildTotalsFormulas(withTotals)[1]?.formula).toBeNull();
    const noTotals = createStructuredTable({ name: 'Products', range: 'A1:B2', columns: ['X', 'Y'] });
    expect(tableTotalsRange(noTotals)).toBeNull();
  });

  it('反向对照 A：列数与区域宽度不符 / 列名重复 / 表名形如引用 ⇒ 抛', () => {
    expect(() => createStructuredTable({ name: 'Wide', range: 'A1:C4', columns: ['X', 'Y'] })).toThrow(/不一致/);
    expect(() => createStructuredTable({ name: 'Dup', range: 'A1:B2', columns: ['X', 'X'] })).toThrow(/重复/);
    // `T1` / `A1` 形如单元格引用 ⇒ 表名非法（与命名区域同一纪律）
    expect(isValidTableName('A1')).toBe(false);
    expect(isValidTableName('T1')).toBe(false);
    expect(isValidTableName('SalesTable')).toBe(true);
    expect(() => createStructuredTable({ name: 'A1', range: 'A1:B2', columns: ['X', 'Y'] })).toThrow(/表名非法/);
    expect(() => buildTotalsFormulas(createStructuredTable({ name: 'NoTotals', range: 'A1:B2', columns: ['X', 'Y'] }))).toThrow(/没有汇总行/);
  });

  it('反向对照 B：行迁移区分表内 / 表外；删到标题行 ⇒ 阻塞', () => {
    const table = createStructuredTable({ name: 'Orders', range: 'A1:B4', columns: ['X', 'Y'] });
    // 表内插入行 ⇒ 表长大
    const grown = migrateTableRange(table, 'row', 3, 1, 'insert');
    expect(grown.range).toBe('A1:B5');
    // 完全在表上方插入 ⇒ 表整体下移
    const pushed = migrateTableRange(table, 'row', 1, 2, 'insert');
    expect(pushed.range).toBe('A3:B6');
    // 删除触及标题行 ⇒ 显式阻塞
    expect(() => migrateTableRange(table, 'row', 1, 1, 'delete')).toThrow(/标题行|显式阻塞/);
  });
});

// ===========================================================================
// 9. sheet —— 缺失不当零 / 类型不互冒充 / 结构迁移
// ===========================================================================

describe('独立验证 · spreadsheets/sheet', () => {
  it('正向：未设置格读回 blank；插入行后单元格与公式引用一起迁移', () => {
    const empty = createSheet('E');
    expect(getCellValue(empty, 'A1')).toEqual(blank);
    expect(hasCell(empty, 'A1')).toBe(false);
    let sheet = createSheet('S', { row_count: 10, column_count: 5 });
    sheet = setCellValue(sheet, 'A1', numberValue(7));
    sheet = setCellValue(sheet, 'B1', formulaValue('A1*2'));
    const shifted = insertRows(sheet, 1, 1);
    expect(getCellValue(shifted, 'A2')).toEqual(numberValue(7));
    expect(getCellValue(shifted, 'B2')).toEqual(formulaValue('A2*2'));
    expect(getCellValue(shifted, 'A1')).toEqual(blank);
  });

  it('反向对照 A：blank 不得当 0（R248）；类型严格相等，1 ≠ "1"', () => {
    const sheet = createSheet('S');
    expect(() => requireNumericValue(getCellValue(sheet, 'A1'))).toThrow(/不得当作 0|R248/);
    expect(requireNumericValue(numberValue(3))).toBe(3);
    expect(valuesEqual(numberValue(1), textValue('1'))).toBe(false);
    expect(valuesEqual(blank, blank)).toBe(true);
  });

  it('反向对照 B：非法工作表名 / 非法冻结 ⇒ 抛；clearCell 幂等', () => {
    expect(() => createSheet('bad[name]')).toThrow(/工作表名非法/);
    expect(() => createSheet('S', { frozen_rows: -1 })).toThrow(/frozen_rows/);
    const sheet = createSheet('S');
    expect(clearCell(sheet, 'A1')).toBe(sheet); // 本就没有该格 ⇒ 返回原对象
  });
});
