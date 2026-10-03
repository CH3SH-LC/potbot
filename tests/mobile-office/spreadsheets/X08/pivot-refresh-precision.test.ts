/**
 * **X08** 独立验收：透视 / 分组汇总 / 金额·单位精度（XLS-13、XLS-17）。
 *
 * 本文件回答 EXCEL.md 给 X08 的四句话：
 *   1. **手机刷新结果**——`refreshPivotTable` 在本机把汇总值写回工作表，不需要桌面 Excel；
 *   2. **空值不默认为零**——缺席分组在模型里是 `absent`、在工作表里是**空/清空**，不是 0；
 *   3. **金额用独立算法复算**——`recomputePivotAmounts` 走 `bigint` 定点，与
 *      `computePivotAggregate` 的浮点结果逐格对账，**差异被判出**而不是被容忍；
 *   4. **分组汇总**——`aggregateRange` 在定点域上做 sum/count/average/min/max。
 *
 * 反面对照（本文件的"至少一条反向"）：
 *   - §3 造一组**浮点必然漂移**的数据（十个 `0.1`），断言浮点结果是 `0.9999999999999999`、
 *     定点复算是 `1.00`，且对账判为 `mismatch`——若把复算换成"照抄浮点"，这条必红；
 *   - §2 断言缺席分组的单元格**根本没被写过**（`getCellValue` 读回 blank）。
 */

import { describe, expect, it } from 'vitest';

import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { blank, isBlank, numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import {
  addQuantities,
  averageQuantities,
  compareQuantities,
  divideQuantity,
  formatQuantity,
  maxQuantities,
  minQuantities,
  parseQuantity,
  roundQuantity,
  subtractQuantities,
  type Quantity,
} from '../../../../src/spreadsheets/quantity.js';
import {
  computePivotAggregate,
  createPivotTable,
  refreshPivotTable,
  type PivotTableSpec,
} from '../../../../src/spreadsheets/pivot.js';
import { aggregateRange, recomputePivotAmounts, validateAggregationSpec } from '../../../../src/spreadsheets/aggregation/index.js';

const 元 = (amount: string, scale = 2): Quantity => parseQuantity(amount, scale, '元', 'CNY');

// ---------------------------------------------------------------------------
// 夹具：与 pivot.test.ts 同形的销售表；**技术/二月 的金额是空的**（缺席样本）
// ---------------------------------------------------------------------------

function buildSalesWorkbook(): WorkbookState {
  let sheet = createSheet('销售', { row_count: 30, column_count: 12 });
  sheet = setCellValue(sheet, 'A1', textValue('部门'));
  sheet = setCellValue(sheet, 'B1', textValue('月份'));
  sheet = setCellValue(sheet, 'C1', textValue('金额'));
  sheet = setCellValue(sheet, 'D1', textValue('数量'));
  const rows: readonly (readonly [string, string, number | null, number])[] = [
    ['销售', '一月', 100, 1],
    ['销售', '二月', 200, 2],
    ['技术', '一月', 300, 3],
    ['技术', '一月', 400, 4],
    ['技术', '二月', null, 5],
    ['销售', '一月', 100, 6],
  ];
  rows.forEach((row, index) => {
    const at = index + 2;
    sheet = setCellValue(sheet, `A${String(at)}`, textValue(row[0]));
    sheet = setCellValue(sheet, `B${String(at)}`, textValue(row[1]));
    if (row[2] !== null) {
      sheet = setCellValue(sheet, `C${String(at)}`, numberValue(row[2]));
    }
    sheet = setCellValue(sheet, `D${String(at)}`, numberValue(row[3]));
  });
  return createWorkbook([sheet, createSheet('空表', { row_count: 5, column_count: 5 })]);
}

function salesSpec(): PivotTableSpec {
  return {
    name: '部门月度透视',
    source: { sheet: '销售', range: 'A1:D7' },
    destination: { sheet: '销售', cell: 'F2' },
    rows: ['部门'],
    columns: ['月份'],
    values: [
      { field: '金额', summarize_by: 'sum' },
      { field: '数量', summarize_by: 'count' },
    ],
  };
}

// ---------------------------------------------------------------------------
// §1 quantity：定点聚合原语（减法 / 舍入 / 除法 / 极值 / 平均）
// ---------------------------------------------------------------------------

describe('X08 §1 quantity：定点聚合原语', () => {
  it('减法精确：1.00 - 0.30 = 0.70（不经浮点）', () => {
    expect(formatQuantity(subtractQuantities(元('1.00'), 元('0.30')))).toBe('0.70');
  });

  it('舍入是显式的、逐模式可辨：2.5 → half_even 2 / half_away 3', () => {
    const two_half = parseQuantity('2.5', 1, '元', 'CNY');
    expect(formatQuantity(roundQuantity(two_half, 0, 'half_even'))).toBe('2');
    expect(formatQuantity(roundQuantity(two_half, 0, 'half_away_from_zero'))).toBe('3');
    const one_half = parseQuantity('1.5', 1, '元', 'CNY');
    expect(formatQuantity(roundQuantity(one_half, 0, 'half_even'))).toBe('2');
    expect(formatQuantity(roundQuantity(one_half, 0, 'half_away_from_zero'))).toBe('2');
  });

  it('负数舍入按模式正确：-1.5 → floor -2 / ceil -1 / truncate -1', () => {
    const negative = parseQuantity('-1.5', 1, '元', 'CNY');
    expect(formatQuantity(roundQuantity(negative, 0, 'floor'))).toBe('-2');
    expect(formatQuantity(roundQuantity(negative, 0, 'ceil'))).toBe('-1');
    expect(formatQuantity(roundQuantity(negative, 0, 'truncate'))).toBe('-1');
  });

  it('除法 / 平均：10.00 ÷ 3 到 4 位 = 3.3333；[1,2,2] 平均到 0 位 = 2', () => {
    expect(formatQuantity(divideQuantity(元('10.00'), 3n, 4, 'half_away_from_zero'))).toBe('3.3333');
    const average = averageQuantities(
      [parseQuantity('1', 0, '元', 'CNY'), parseQuantity('2', 0, '元', 'CNY'), parseQuantity('2', 0, '元', 'CNY')],
      0,
      'half_away_from_zero',
    );
    expect(average.ok).toBe(true);
    if (average.ok) {
      expect(formatQuantity(average.quantity)).toBe('2');
    }
  });

  it('极值按最小单位比较，不受 scale 影响', () => {
    const list = [parseQuantity('1.5', 1, '元', 'CNY'), parseQuantity('1.50', 2, '元', 'CNY'), parseQuantity('2', 0, '元', 'CNY')];
    const min = minQuantities(list);
    const max = maxQuantities(list);
    // 极值返回**原元素**（保留它自身的 scale），不是归一化到最大 scale 的值
    expect(min.ok && formatQuantity(min.quantity)).toBe('1.5');
    expect(max.ok && formatQuantity(max.quantity)).toBe('2');
    expect(
      min.ok && compareQuantities(min.quantity, parseQuantity('1.50', 2, '元', 'CNY')),
    ).toBe(0);
    expect(compareQuantities(parseQuantity('1.5', 1, '元', 'CNY'), parseQuantity('1.50', 2, '元', 'CNY'))).toBe(0);
  });

  it('空集合极值 ⇒ empty（不是 0）：min/max/average 一致', () => {
    expect(minQuantities([])).toEqual({ ok: false, reason: 'empty' });
    expect(maxQuantities([])).toEqual({ ok: false, reason: 'empty' });
    expect(averageQuantities([], 2, 'half_away_from_zero')).toEqual({ ok: false, reason: 'empty' });
  });
});

// ---------------------------------------------------------------------------
// §2 aggregateRange：定点分组汇总 + 缺失不当零
// ---------------------------------------------------------------------------

describe('X08 §2 aggregateRange：定点分组汇总，缺失不当零', () => {
  const workbook = buildSalesWorkbook();

  it('sum 精确：销售/一月 = 100 + 100 = 200.00；技术/一月 = 300 + 400 = 700.00', () => {
    const groups = aggregateRange(workbook, {
      name: '部门-月份金额',
      source: { sheet: '销售', range: 'A1:D7' },
      group_by: ['部门', '月份'],
      measure: '金额',
      op: 'sum',
      scale: 2,
      unit: '元',
      currency: 'CNY',
    });
    const byKey = new Map(groups.map((group) => [group.key.join('/'), group]));
    const salesJan = byKey.get('销售/一月');
    expect(salesJan?.outcome.kind).toBe('quantity');
    if (salesJan?.outcome.kind === 'quantity') {
      expect(formatQuantity(salesJan.outcome.quantity)).toBe('200.00');
    }
    const techJan = byKey.get('技术/一月');
    if (techJan?.outcome.kind === 'quantity') {
      expect(formatQuantity(techJan.outcome.quantity)).toBe('700.00');
    }
  });

  it('**缺失不当零**：技术/二月 的 sum ⇒ absent，不是 0；同一组的 count 仍是真结果 1', () => {
    const sumGroups = aggregateRange(workbook, {
      name: '金额sum',
      source: { sheet: '销售', range: 'A1:D7' },
      group_by: ['部门', '月份'],
      measure: '金额',
      op: 'sum',
      scale: 2,
      unit: '元',
      currency: 'CNY',
    });
    const techFebSum = sumGroups.find((group) => group.key.join('/') === '技术/二月');
    expect(techFebSum?.outcome).toEqual({ kind: 'absent', reason: 'no_numeric_values' });
    expect(techFebSum?.numeric_count).toBe(0);
    expect(techFebSum?.row_count).toBe(1);

    const countGroups = aggregateRange(workbook, {
      name: '数量count',
      source: { sheet: '销售', range: 'A1:D7' },
      group_by: ['部门', '月份'],
      measure: '数量',
      op: 'count',
    });
    const techFebCount = countGroups.find((group) => group.key.join('/') === '技术/二月');
    expect(techFebCount?.outcome).toEqual({ kind: 'count', count: 1 });
  });

  it('空 group_by ⇒ 全体一行；min/max/average 在定点域上算', () => {
    const groups = aggregateRange(workbook, {
      name: '全体金额',
      source: { sheet: '销售', range: 'A1:D7' },
      group_by: [],
      measure: '金额',
      op: 'average',
      scale: 2,
      unit: '元',
      currency: 'CNY',
    });
    expect(groups).toHaveLength(1);
    // 五个非空金额：100,200,300,400,100 ⇒ 和 1100，个数 5 ⇒ 平均 220.00
    const only = groups[0];
    expect(only?.key).toEqual([]);
    expect(only?.numeric_count).toBe(5);
    if (only?.outcome.kind === 'quantity') {
      expect(formatQuantity(only.outcome.quantity)).toBe('220.00');
    }
  });

  it('反面对照：请求缺 scale/unit ⇒ 校验列出问题，不静默补默认', () => {
    const issues = validateAggregationSpec({
      name: '缺精度',
      source: { sheet: '销售', range: 'A1:D7' },
      group_by: ['部门'],
      measure: '金额',
      op: 'sum',
    });
    expect(issues.some((issue) => issue.includes('scale'))).toBe(true);
    expect(issues.some((issue) => issue.includes('unit'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 recomputePivotAmounts：独立算法复算 + 浮点漂移必被咬住
// ---------------------------------------------------------------------------

describe('X08 §3 独立复算：与浮点聚合逐格对账', () => {
  it('整数金额夹具：四格 sum 全部 match（复算与浮点一致时也给得出 match）', () => {
    const workbook = buildSalesWorkbook();
    const pivot = createPivotTable(workbook, salesSpec());
    const observed = computePivotAggregate(workbook, pivot);
    const checks = recomputePivotAmounts(workbook, pivot, observed, { scale: 2, unit: '元', currency: 'CNY' });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.value_caption === '求和项:金额')).toBe(true);
    // 三个有金额的分组：销售/一月、销售/二月、技术/一月；技术/二月 两侧都没有 sum 值 ⇒ 不产生条目
    expect(checks.map((check) => check.verdict)).toEqual(['match', 'match', 'match']);
    expect(
      checks.map((check) => [...check.row_key, ...check.column_key].join('/')).sort(),
    ).toEqual(['技术/一月', '销售/一月', '销售/二月']);
    expect(checks.every((check) => check.drift === null)).toBe(true);
  });

  it('**反向对照**：十个 0.1 的浮点 sum 是 0.9999999999999999，定点复算是 1.00 ⇒ mismatch', () => {
    let sheet = createSheet('微额', { row_count: 20, column_count: 4 });
    sheet = setCellValue(sheet, 'A1', textValue('项目'));
    sheet = setCellValue(sheet, 'B1', textValue('金额'));
    for (let index = 0; index < 10; index += 1) {
      const at = index + 2;
      sheet = setCellValue(sheet, `A${String(at)}`, textValue('A'));
      sheet = setCellValue(sheet, `B${String(at)}`, numberValue(0.1));
    }
    const workbook = createWorkbook([sheet]);
    const pivot = createPivotTable(workbook, {
      name: '微额透视',
      source: { sheet: '微额', range: 'A1:B11' },
      destination: { sheet: '微额', cell: 'D2' },
      rows: ['项目'],
      values: [{ field: '金额', summarize_by: 'sum' }],
    });
    const observed = computePivotAggregate(workbook, pivot);
    const floatSum = observed[0]?.values['求和项:金额'];
    expect(floatSum).toBe(0.9999999999999999); // 浮点真的漂了
    expect(floatSum).not.toBe(1);

    const checks = recomputePivotAmounts(workbook, pivot, observed, { scale: 2, unit: '元', currency: 'CNY' });
    expect(checks).toHaveLength(1);
    const only = checks[0];
    expect(only?.verdict).toBe('mismatch');
    expect(only?.exact?.amount_minor).toBe(100n);
    expect(only !== undefined && only.exact !== null).toBe(true);
    if (only !== undefined && only.exact !== null) {
      expect(formatQuantity(only.exact)).toBe('1.00');
    }
    expect(only?.drift).toContain('不可表示');
  });

  it('反面对照：没有 sum 值字段 ⇒ 返回空数组（不凭空造对账条目）', () => {
    const workbook = buildSalesWorkbook();
    const pivot = createPivotTable(workbook, {
      ...salesSpec(),
      values: [{ field: '数量', summarize_by: 'count' }],
    });
    const observed = computePivotAggregate(workbook, pivot);
    expect(recomputePivotAmounts(workbook, pivot, observed, { scale: 2, unit: '元' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §4 refreshPivotTable：手机本机刷新结果写回工作表
// ---------------------------------------------------------------------------

describe('X08 §4 refreshPivotTable：手机刷新结果落到工作表', () => {
  const workbook = buildSalesWorkbook();
  const pivot = createPivotTable(workbook, salesSpec());
  const refreshed = refreshPivotTable(workbook, pivot);
  const sheet = refreshed.workbook.sheets.find((candidate) => candidate.name === '销售');

  it('表头与范围：F2 起，行字段 + 列键×值字段', () => {
    expect(refreshed.range).toBe('F2:J4');
    expect(sheet && getCellValue(sheet, 'F2')).toEqual(textValue('部门'));
    expect(sheet && getCellValue(sheet, 'G2')).toEqual(textValue('一月 / 求和项:金额'));
    expect(sheet && getCellValue(sheet, 'I2')).toEqual(textValue('二月 / 求和项:金额'));
  });

  it('汇总值真的写进了单元格：G3 = 200，G4 = 700，H4 = 2', () => {
    expect(sheet && getCellValue(sheet, 'G3')).toEqual(numberValue(200));
    expect(sheet && getCellValue(sheet, 'G4')).toEqual(numberValue(700));
    expect(sheet && getCellValue(sheet, 'H4')).toEqual(numberValue(2));
  });

  it('**缺失不当零**：技术/二月 的金额格（I4）读回是 blank，没被写成 0', () => {
    const cell = sheet ? getCellValue(sheet, 'I4') : numberValue(-999);
    expect(isBlank(cell)).toBe(true);
    expect(refreshed.absent_cells).toBe(1);
    expect(refreshed.cells_written).toBe(7);
  });

  it('刷新是确定的、可重放的：同一输入两次 ⇒ 相同数值格', () => {
    const again = refreshPivotTable(workbook, pivot);
    const sheetAgain = again.workbook.sheets.find((candidate) => candidate.name === '销售');
    expect(sheetAgain && getCellValue(sheetAgain, 'G3')).toEqual(numberValue(200));
    expect(again.range).toBe(refreshed.range);
    expect(again.absent_cells).toBe(refreshed.absent_cells);
  });

  it('反面对照：未刷新时工作表里没有算好的汇总值（本函数不是恒等变换）', () => {
    const fresh = buildSalesWorkbook();
    const freshSheet = fresh.sheets[0];
    expect(freshSheet && getCellValue(freshSheet, 'G3')).toEqual(blank);
  });
});
