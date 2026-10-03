/**
 * **X08 增量**：`recomputePivotAmounts` 对 **average / min / max** 值字段的独立定点复算。
 *
 * 原实现只复算 `sum`。本文件把复算范围扩到 `average` / `min` / `max`，并证明：
 *   - 四个口径各自都有**正向对照**（定点与浮点一致 ⇒ `match`）；
 *   - `average` 的**反向对照**：浮点均值落在定点网格之外（`5 / 3 = 1.666…`）⇒ `mismatch`
 *     且给出"不可表示"原因——若把复算换成"照抄浮点"，这条必红；
 *   - `count` **不进入**复算（它没有可复算的精度），混入 sum 也不产生条目；
 *   - 缺席分组两个算法都算不出值 ⇒ **不产生条目**（缺席不是 0，也不算差异）；
 *   - `average_rounding` 被真正尊重（half_even vs half_away 给出不同 `exact`）。
 */

import { describe, expect, it } from 'vitest';

import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { formatQuantity } from '../../../../src/spreadsheets/quantity.js';
import {
  computePivotAggregate,
  createPivotTable,
  type PivotTableSpec,
} from '../../../../src/spreadsheets/pivot.js';
import {
  recomputePivotAmounts,
  type PivotValueRecompute,
} from '../../../../src/spreadsheets/aggregation/index.js';

/**
 * 夹具（标题 + 9 数据行）：四个口径都有正反样本。
 *   销售 [100,200,300] → sum 600 / avg 200 / min 100 / max 300（皆可定点表示 ⇒ match）
 *   技术 [10,20]       → sum 30  / avg 15  / min 10  / max 20（match）
 *   后勤 [1,2,2]       → sum 5   / avg 1.666…（浮点不可定点表示 ⇒ mismatch）/ min 1 / max 2
 *   行政 [空]          → 四个口径都算不出值 ⇒ 不产生对账条目
 */
function buildAmountsWorkbook(): WorkbookState {
  let sheet = createSheet('金额表', { row_count: 20, column_count: 4 });
  sheet = setCellValue(sheet, 'A1', textValue('部门'));
  sheet = setCellValue(sheet, 'B1', textValue('金额'));
  const rows: readonly (readonly [string, number | null])[] = [
    ['销售', 100],
    ['销售', 200],
    ['销售', 300],
    ['技术', 10],
    ['技术', 20],
    ['后勤', 1],
    ['后勤', 2],
    ['后勤', 2],
    ['行政', null],
  ];
  rows.forEach((row, index) => {
    const at = index + 2;
    sheet = setCellValue(sheet, `A${String(at)}`, textValue(row[0]));
    if (row[1] !== null) {
      sheet = setCellValue(sheet, `B${String(at)}`, numberValue(row[1]));
    }
  });
  return createWorkbook([sheet]);
}

function fourOpSpec(overrides: Partial<PivotTableSpec> = {}): PivotTableSpec {
  return {
    name: '四口径透视',
    source: { sheet: '金额表', range: 'A1:B10' },
    destination: { sheet: '金额表', cell: 'D2' },
    rows: ['部门'],
    values: [
      { field: '金额', summarize_by: 'sum' },
      { field: '金额', summarize_by: 'average' },
      { field: '金额', summarize_by: 'min' },
      { field: '金额', summarize_by: 'max' },
    ],
    ...overrides,
  };
}

/** (行键 :: 显示名) → 对账条目，便于按口径断言。 */
function indexChecks(
  checks: readonly PivotValueRecompute[],
): Map<string, PivotValueRecompute> {
  const map = new Map<string, PivotValueRecompute>();
  for (const check of checks) {
    map.set(`${check.row_key.join('/')}::${check.value_caption}`, check);
  }
  return map;
}

describe('X08 §5 recompute：average / min / max 的独立定点复算', () => {
  const workbook = buildAmountsWorkbook();
  const pivot = createPivotTable(workbook, fourOpSpec());
  const observed = computePivotAggregate(workbook, pivot);
  const checks = recomputePivotAmounts(workbook, pivot, observed, {
    scale: 2,
    unit: '元',
    currency: 'CNY',
  });
  const byKey = indexChecks(checks);

  it('四个口径各自都有条目：3 个有金额的分组 × 4 口径 = 12 条', () => {
    expect(checks).toHaveLength(12);
    const captions = new Set(checks.map((check) => check.value_caption));
    expect([...captions].sort()).toEqual([
      '平均值项:金额',
      '最大值项:金额',
      '最小值项:金额',
      '求和项:金额',
    ]);
  });

  it('sum / min / max 在可定点表示的数据上全部 match（正向对照）', () => {
    for (const group of ['销售', '技术', '后勤']) {
      expect(byKey.get(`${group}::求和项:金额`)?.verdict).toBe('match');
      expect(byKey.get(`${group}::最小值项:金额`)?.verdict).toBe('match');
      expect(byKey.get(`${group}::最大值项:金额`)?.verdict).toBe('match');
    }
    // 极值就是原数据：销售 min 100 / max 300，技术 min 10 / max 20，后勤 min 1 / max 2
    expect(byKey.get('销售::最小值项:金额')?.exact).toEqual(
      expect.objectContaining({ amount_minor: 10000n, scale: 2 }),
    );
    expect(byKey.get('销售::最大值项:金额')?.exact).toEqual(
      expect.objectContaining({ amount_minor: 30000n, scale: 2 }),
    );
    expect(byKey.get('技术::最小值项:金额')?.exact).toEqual(
      expect.objectContaining({ amount_minor: 1000n, scale: 2 }),
    );
  });

  it('average：销售 600/3 = 200.00、技术 30/2 = 15.00 ⇒ match（浮点正好落在定点网格上）', () => {
    expect(byKey.get('销售::平均值项:金额')?.verdict).toBe('match');
    expect(byKey.get('销售::平均值项:金额')?.observed).toBe(200);
    expect(byKey.get('技术::平均值项:金额')?.verdict).toBe('match');
    expect(byKey.get('技术::平均值项:金额')?.observed).toBe(15);
  });

  it('**反向对照**：后勤 5/3 的浮点均值 1.666… 不可能定点表示 ⇒ average 判 mismatch 并给原因', () => {
    const avg = byKey.get('后勤::平均值项:金额');
    expect(avg?.verdict).toBe('mismatch');
    expect(avg?.observed).toBe(5 / 3); // 浮点真的不是 1.67
    const exact = avg?.exact ?? null;
    expect(exact !== null && formatQuantity(exact)).toBe('1.67'); // 定点 round half_away 到 2 位
    expect(avg?.drift).toContain('不可表示');
  });

  it('缺席分组不产生对账条目（行政金额全空：两侧都算不出 ⇒ 不报 both_absent 之外的臆造差异）', () => {
    expect(checks.some((check) => check.row_key.join('/') === '行政')).toBe(false);
  });

  it('count 不进入复算：混入 sum 只产出 sum 的口径条目', () => {
    const withCount = createPivotTable(
      workbook,
      fourOpSpec({
        values: [
          { field: '金额', summarize_by: 'sum' },
          { field: '金额', summarize_by: 'count' },
        ],
      }),
    );
    const observedWithCount = computePivotAggregate(workbook, withCount);
    const countChecks = recomputePivotAmounts(workbook, withCount, observedWithCount, {
      scale: 2,
      unit: '元',
      currency: 'CNY',
    });
    expect(countChecks.every((check) => check.value_caption === '求和项:金额')).toBe(true);
    expect(countChecks.some((check) => check.value_caption.includes('计数项'))).toBe(false);
  });
});

describe('X08 §5b recompute：average_rounding 被真正尊重', () => {
  /** 两个值 [2,3] ⇒ 浮点均值 2.5。 */
  function buildTwoValueWorkbook(): WorkbookState {
    let sheet = createSheet('两值', { row_count: 10, column_count: 5 });
    sheet = setCellValue(sheet, 'A1', textValue('组'));
    sheet = setCellValue(sheet, 'B1', textValue('金额'));
    sheet = setCellValue(sheet, 'A2', textValue('G'));
    sheet = setCellValue(sheet, 'B2', numberValue(2));
    sheet = setCellValue(sheet, 'A3', textValue('G'));
    sheet = setCellValue(sheet, 'B3', numberValue(3));
    return createWorkbook([sheet]);
  }

  const workbook = buildTwoValueWorkbook();
  const pivot = createPivotTable(workbook, {
    name: '均值透视',
    source: { sheet: '两值', range: 'A1:B3' },
    destination: { sheet: '两值', cell: 'D2' },
    rows: ['组'],
    values: [{ field: '金额', summarize_by: 'average' }],
  });
  const observed = computePivotAggregate(workbook, pivot);
  const exactOf = (scale: number, rounding: 'half_away_from_zero' | 'half_even'): string => {
    const checks = recomputePivotAmounts(workbook, pivot, observed, {
      scale,
      unit: '元',
      currency: 'CNY',
      average_rounding: rounding,
    });
    const only = checks[0];
    return only?.exact != null ? formatQuantity(only.exact) : '<none>';
  };

  it('scale=0：half_away ⇒ 3，half_even ⇒ 2（舍入口径真的改结果，不是摆设）', () => {
    expect(exactOf(0, 'half_away_from_zero')).toBe('3');
    expect(exactOf(0, 'half_even')).toBe('2');
  });

  it('scale=1：浮点 2.5 恰好可定点表示 ⇒ match（正向对照，证明 mismatch 不是恒判）', () => {
    const checks = recomputePivotAmounts(workbook, pivot, observed, {
      scale: 1,
      unit: '元',
      currency: 'CNY',
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.verdict).toBe('match');
    expect(checks[0]?.observed).toBe(2.5);
    expect(checks[0]?.drift).toBeNull();
  });
});
