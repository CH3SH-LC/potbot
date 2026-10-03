/**
 * 演示域**同版事实同步**用例（PPT-16）。
 *
 * 覆盖：
 * - 正向：「修改人数 / 预算后文本、图表、表格一致」——三处都从**同一个**事实版本取数，
 *   `syncPresentationFacts` 报 `ok`，且三处的数值逐条相等；
 * - 反向（每类冲突至少一条）：图表用了**旧版**事实而正文用新版 ⇒ `stale_fact_version`；
 *   表格字面量与事实对不上 ⇒ `value_mismatch`；目标版本缺键 ⇒ `missing_fact`；
 *   文本事实进数值位 ⇒ `non_numeric_fact`；绑定目标缺失 / 数据点个数不符 / 格内无数值；
 *   同一版本同键两条 ⇒ 构造即抛；
 * - 未验证：「手机关闭重开无修复提示」「目标软件打开无修复提示」必须**如实标未验证**，
 *   并随每份报告带出（本仓无消费端）。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type ChartModel, type ChartShape, type Presentation, type Shape, type TableCell, type TableShape } from './model.js';
import { addShape, addSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import {
  FACT_DATA_SERIES_NAME,
  FactSyncError,
  applyFactVersion,
  asFactSnapshot,
  bodyText,
  chartFromFacts,
  describeFactVersion,
  factCell,
  factChartData,
  factDataVersionOf,
  factTextBody,
  lookupVersionedFact,
  parseNumericLiteral,
  setFactValue,
  syncPresentationFacts,
  versionedSnapshot,
  type FactBindings,
  type FactVersion,
  type VersionedFactEntry,
} from './fact-sync.js';
import { dataVersionOf } from './table-chart-parts/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const R1: FactVersion = { task_id: 't1', task_revision: 1 };
const R2: FactVersion = { task_id: 't1', task_revision: 2 };

/**
 * **V-7：独立来源的期望值。**
 *
 * 修复前写的是 `expect(report.unverified).toEqual(FACT_SYNC_UNVERIFIED_CLAIMS)` —— 期望值就是
 * 源码里**原样赋给 `report.unverified` 的同一个常量**，对任何自产报告恒真（源码把那串清单
 * 清空也照样绿）。下面这串期望在**本文件里独立写出**：源码侧的 claim / requires 一改，这里就红。
 */
const EXPECTED_UNVERIFIED: readonly { readonly claim: string; readonly requires_token: string }[] = [
  { claim: '手机关闭重开演示文稿后没有修复提示', requires_token: '真机' },
  { claim: '目标软件打开演示文稿没有修复提示', requires_token: 'Office' },
  { claim: '图表 / 表格 / 正文在目标软件中显示为同一个数', requires_token: '消费端' },
];

/** 逐条对独立期望做核对（claim 文案 + requires 里必须点名需要什么 + detail 非空）。 */
function assertUnverifiedMatchesIndependentExpectation(
  actual: readonly { readonly claim: string; readonly status: string; readonly requires: string; readonly detail: string }[],
): void {
  expect(actual.map((entry) => entry.claim)).toEqual(EXPECTED_UNVERIFIED.map((entry) => entry.claim));
  for (const [index, expected] of EXPECTED_UNVERIFIED.entries()) {
    const entry = actual[index];
    expect(entry?.status).toBe('unverified');
    expect(entry?.requires).toContain(expected.requires_token);
    expect(entry?.detail.length).toBeGreaterThan(0);
  }
}

function headcount(amount: number): VersionedFactEntry {
  return { fact_key: 'headcount', fact_ref: `fact.headcount.${String(amount)}`, value: { type: 'number', amount, unit: '人', currency: null } };
}

function budget(amount: number): VersionedFactEntry {
  return { fact_key: 'budget.total', fact_ref: `fact.budget.${String(amount)}`, value: { type: 'number', amount, unit: '元', currency: null } };
}

/** 另一条**同单位**的数值事实（用于"同一张图里多个数据点"）。 */
function plannedHeadcount(amount: number): VersionedFactEntry {
  return { fact_key: 'headcount.planned', fact_ref: `fact.planned.${String(amount)}`, value: { type: 'number', amount, unit: '人', currency: null } };
}

const V1 = versionedSnapshot(R1, [headcount(8), budget(20000), plannedHeadcount(10)]);
const V2 = versionedSnapshot(R2, [headcount(12), budget(30000), plannedHeadcount(12)]);

function textBox(id: number, factKey: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(0, 0, 4000000, 1000000),
    text: factTextBody(factKey),
  };
}

function tableWithCell(id: number, text: string): TableShape {
  const cell: TableCell = { text: literalText(text), col_span: 1, row_span: 1 };
  return {
    kind: 'table',
    shape_id: id,
    name: `Table ${String(id)}`,
    transform: transform(0, 2000000, 4000000, 1000000),
    rows: [{ cells: [cell] }],
    column_widths_emu: [4000000],
  };
}

function chartShape(id: number, chart: ChartModel): ChartShape {
  return {
    kind: 'chart',
    shape_id: id,
    name: `Chart ${String(id)}`,
    transform: transform(0, 3000000, 4000000, 2000000),
    chart,
  };
}

/** 一页：正文事实 run + 绑定事实的表格格 + 绑定事实的图表。 */
function deck(rows: {
  readonly table: string;
  readonly chart_values: readonly number[];
}): { presentation: Presentation; bindings: FactBindings } {
  let presentation = emptyPresentation('p1', '同版事实演示');
  const added = addSlide(presentation);
  presentation = added.presentation;
  const slideId = added.slide_id;
  presentation = addShape(presentation, slideId, textBox(2, 'headcount'));
  presentation = addShape(presentation, slideId, tableWithCell(3, rows.table));
  presentation = addShape(
    presentation,
    slideId,
    chartShape(4, {
      chart_type: 'bar',
      categories: ['人数'],
      series: [{ name: '人数', values: [...rows.chart_values] }],
      title: null,
    }),
  );
  return {
    presentation,
    bindings: {
      chart: [{ shape_id: 4, series: [{ name: '人数', fact_keys: ['headcount'] }] }],
      table: [{ shape_id: 3, cells: [{ row: 0, column: 0, fact_key: 'headcount' }] }],
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 生成：入口只有事实键
// ---------------------------------------------------------------------------

describe('PPT-16 生成：三处都只接事实键，数值来自同一条快照', () => {
  it('chartFromFacts 从事实键装配嵌入数据（值 = 事实值）', () => {
    const chart = chartFromFacts({
      chart_type: 'bar',
      title: null,
      categories: ['实际人数', '计划人数'],
      series: [{ name: '人数', fact_keys: ['headcount', 'headcount.planned'] }],
      snapshot: V2,
    });
    expect(chart.series[0]?.values).toEqual([12, 12]);
    expect(chart.categories).toEqual(['实际人数', '计划人数']);
  });

  it('factCell 的格内数字 = 事实值（用 renderFactValue 的同一口径）', () => {
    const cell = factCell('headcount', V2);
    expect(cell.text).not.toBeNull();
    if (cell.text === null) return;
    expect(bodyText(cell.text, asFactSnapshot(V2))).toBe('12 人');
  });

  it('缺失的事实 ⇒ 生成即抛（不当零）', () => {
    expect(() =>
      chartFromFacts({
        chart_type: 'bar',
        title: null,
        categories: ['x'],
        series: [{ name: 's', fact_keys: ['nope'] }],
        snapshot: V2,
      }),
    ).toThrowError(/找不到事实/);
    expect(() => factCell('nope', V2)).toThrowError(FactSyncError);
  });

  it('同一张图混装不同单位 ⇒ 抛（同一坐标轴解释不了两种量纲）', () => {
    expect(() =>
      chartFromFacts({
        chart_type: 'bar',
        title: null,
        categories: ['人数', '预算'],
        series: [{ name: 's', fact_keys: ['headcount', 'budget.total'] }],
        snapshot: V2,
      }),
    ).toThrowError(/量纲|单位/);
  });

  it('数据点个数多于类别数 ⇒ 抛（不当成"多出来的忽略"）', () => {
    expect(() =>
      chartFromFacts({
        chart_type: 'bar',
        title: null,
        categories: ['a'],
        series: [{ name: 's', fact_keys: ['headcount', 'budget.total'] }],
        snapshot: V2,
      }),
    ).toThrowError(/一一对应/);
  });
});

// ---------------------------------------------------------------------------
// 2. 正向：三处一致（同一事实版本）
// ---------------------------------------------------------------------------

describe('PPT-16 正向：文本 / 图表 / 表格来自同一版事实 ⇒ 一致', () => {
  it('r2 的三处同版 ⇒ ok，且三处数值逐条相等', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings, history: [V1] });

    expect(report.conflicts).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ text: 1, table: 1, chart: 1 });

    const headcountUsages = report.usages.filter((usage) => usage.fact_key === 'headcount');
    expect(headcountUsages).toHaveLength(3);
    expect(new Set(headcountUsages.map((usage) => usage.value))).toEqual(new Set([12]));
    expect(new Set(headcountUsages.map((usage) => describeFactVersion(usage.version)))).toEqual(new Set(['t1@r2']));
    expect(new Set(headcountUsages.map((usage) => usage.role))).toEqual(new Set(['text', 'table', 'chart']));
  });

  it('「修改人数 / 预算后」：applyFactVersion 把图表与表格刷成新版本，再同步 ⇒ ok 且三处都是新值', () => {
    // 先用 r1 生成一份三处一致的演示。
    const { presentation, bindings } = deck({ table: '8 人', chart_values: [8] });
    expect(syncPresentationFacts({ presentation, target: V1, bindings }).ok).toBe(true);

    // 人数 8 → 12：正文是事实引用（换快照即换数字），图表 / 表格是字面量，必须被改写。
    const updated = applyFactVersion({ presentation, target: V2, bindings });
    const report = syncPresentationFacts({ presentation: updated, target: V2, bindings, history: [V1] });

    expect(report.conflicts).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.usages.map((usage) => usage.value)).toEqual([12, 12, 12]);

    // 表格格内文本确实被刷成新值（不是"报 ok 但其实没改"）。
    const table = updated.slides[0]?.shapes.find((shape) => shape.kind === 'table');
    expect(table?.kind).toBe('table');
    if (table?.kind !== 'table') return;
    expect(bodyText(table.rows[0]?.cells[0]?.text ?? literalText(''), asFactSnapshot(V2))).toBe('12 人');
  });

  it('applyFactVersion 不可变：原模型仍是旧值', () => {
    const { presentation, bindings } = deck({ table: '8 人', chart_values: [8] });
    const updated = applyFactVersion({ presentation, target: V2, bindings });
    expect(updated).not.toBe(presentation);

    const before = presentation.slides[0]?.shapes.find((shape) => shape.kind === 'chart');
    expect(before?.kind).toBe('chart');
    if (before?.kind !== 'chart') return;
    expect(before.chart.series[0]?.values).toEqual([8]);
    expect(syncPresentationFacts({ presentation, target: V1, bindings }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 反向对照：不同版本必须报冲突
// ---------------------------------------------------------------------------

describe('PPT-16 反向：不同版本必须报冲突（不允许静默取一处）', () => {
  it('★ 图表用了旧版事实而正文用了新版 ⇒ stale_fact_version，并指出是哪一版', () => {
    // 正文在 r2（12），图表嵌入数据还是 r1 的 8。
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [8] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings, history: [V1] });

    expect(report.ok).toBe(false);
    expect(report.conflicts).toHaveLength(1);
    const conflict = report.conflicts[0];
    expect(conflict?.kind).toBe('stale_fact_version');
    expect(conflict?.fact_key).toBe('headcount');
    expect(conflict?.roles).toEqual(['chart']);
    expect(conflict?.values).toEqual([8, 12]);
    expect(conflict?.stale_version).toEqual(R1);
    expect(conflict?.message).toContain('t1@r1');
    expect(conflict?.message).toContain('旧版事实');
  });

  it('表格字面量用了旧版值而正文用了新版 ⇒ stale_fact_version（roles=[table]）', () => {
    const { presentation, bindings } = deck({ table: '8 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings, history: [V1] });

    expect(report.ok).toBe(false);
    expect(report.conflicts.map((conflict) => conflict.kind)).toEqual(['stale_fact_version']);
    expect(report.conflicts[0]?.roles).toEqual(['table']);
    expect(report.conflicts[0]?.stale_version).toEqual(R1);
  });

  it('数值对不上且不属于任何已知版本 ⇒ value_mismatch（不是 stale）', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [999] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings, history: [V1] });

    expect(report.conflicts[0]?.kind).toBe('value_mismatch');
    expect(report.conflicts[0]?.stale_version).toBeNull();
  });

  it('目标版本缺键 ⇒ missing_fact（不当零、也不改用旧版本的值）', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const partial = versionedSnapshot(R2, [budget(30000)]);
    const report = syncPresentationFacts({ presentation, target: partial, bindings, history: [V1] });

    expect(report.ok).toBe(false);
    const kinds = report.conflicts.map((conflict) => conflict.kind);
    expect(kinds.every((kind) => kind === 'missing_fact')).toBe(true);
    expect(report.conflicts[0]?.fact_key).toBe('headcount');
    expect(report.usages).toEqual([]);
  });

  it('文本事实进数值位 ⇒ non_numeric_fact', () => {
    const withText = versionedSnapshot(R2, [
      { fact_key: 'headcount', fact_ref: 'f1', value: { type: 'text', text: '十二人', source: '用户口述' } },
    ]);
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: withText, bindings });

    expect(report.conflicts.map((conflict) => conflict.kind)).toContain('non_numeric_fact');
  });

  it('单元格里的事实引用与绑定指的不是同一条事实 ⇒ value_mismatch', () => {
    let presentation = emptyPresentation('p1', '绑定错位');
    const added = addSlide(presentation);
    presentation = added.presentation;
    const cell: TableCell = { text: factTextBody('budget.total'), col_span: 1, row_span: 1 };
    presentation = addShape(presentation, added.slide_id, {
      kind: 'table',
      shape_id: 7,
      name: 'T',
      transform: transform(0, 0, 100, 100),
      rows: [{ cells: [cell] }],
      column_widths_emu: [100],
    });
    const report = syncPresentationFacts({
      presentation,
      target: V2,
      bindings: { table: [{ shape_id: 7, cells: [{ row: 0, column: 0, fact_key: 'headcount' }] }] },
    });
    expect(report.conflicts[0]?.kind).toBe('value_mismatch');
    expect(report.conflicts[0]?.message).toContain('必须指同一条事实');
  });
});

// ---------------------------------------------------------------------------
// 4. 反向对照：绑定自身的问题
// ---------------------------------------------------------------------------

describe('PPT-16 反向：绑定对不上时显式报冲突，不静默跳过', () => {
  it('绑定指向的形状不在任何页 ⇒ binding_target_missing', () => {
    const { presentation } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({
      presentation,
      target: V2,
      bindings: { chart: [{ shape_id: 404, series: [{ name: 'x', fact_keys: ['headcount'] }] }] },
    });
    expect(report.conflicts[0]?.kind).toBe('binding_target_missing');
    expect(report.conflicts[0]?.message).toContain('404');
  });

  it('图表绑定数据点个数与嵌入数据不符 ⇒ arity_mismatch', () => {
    const { presentation } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({
      presentation,
      target: V2,
      bindings: {
        chart: [{ shape_id: 4, series: [{ name: '人数', fact_keys: ['headcount', 'budget.total'] }] }],
      },
    });
    expect(report.conflicts[0]?.kind).toBe('arity_mismatch');
    expect(report.conflicts[0]?.message).toContain('一一对应');
  });

  it('系列名对不上 ⇒ arity_mismatch（防止"绑错了系列"）', () => {
    const { presentation } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({
      presentation,
      target: V2,
      bindings: { chart: [{ shape_id: 4, series: [{ name: '预算', fact_keys: ['headcount'] }] }] },
    });
    expect(report.conflicts[0]?.kind).toBe('arity_mismatch');
    expect(report.conflicts[0]?.message).toContain('对不上');
  });

  it('绑定的格子读不出数值 ⇒ unreadable_value（不得当零）', () => {
    const { presentation, bindings } = deck({ table: '暂无数据', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings });
    expect(report.conflicts[0]?.kind).toBe('unreadable_value');
    expect(parseNumericLiteral('暂无数据')).toBeNull();
  });

  it('空单元格 ⇒ unreadable_value', () => {
    let presentation = emptyPresentation('p1', '空表格');
    const added = addSlide(presentation);
    presentation = added.presentation;
    presentation = addShape(presentation, added.slide_id, {
      kind: 'table',
      shape_id: 7,
      name: 'T',
      transform: transform(0, 0, 100, 100),
      rows: [{ cells: [{ text: null, col_span: 1, row_span: 1 }] }],
      column_widths_emu: [100],
    });
    const report = syncPresentationFacts({
      presentation,
      target: V2,
      bindings: { table: [{ shape_id: 7, cells: [{ row: 0, column: 0, fact_key: 'headcount' }] }] },
    });
    expect(report.conflicts[0]?.kind).toBe('unreadable_value');
  });
});

// ---------------------------------------------------------------------------
// 5. 快照自身的构造即校验
// ---------------------------------------------------------------------------

describe('PPT-16：同一版本一个键只能有一条（构造即抛）', () => {
  it('同键两条 ⇒ FactSyncError(duplicate_fact_key)', () => {
    expect(() => versionedSnapshot(R1, [headcount(8), headcount(9)])).toThrowError(FactSyncError);
    try {
      versionedSnapshot(R1, [headcount(8), headcount(9)]);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(FactSyncError);
      expect((error as FactSyncError).reason).toBe('duplicate_fact_key');
    }
  });

  it('版本号非法 ⇒ 抛', () => {
    expect(() => versionedSnapshot({ task_id: 't1', task_revision: -1 }, [])).toThrowError(FactSyncError);
    expect(() => versionedSnapshot({ task_id: '', task_revision: 1 }, [])).toThrowError(FactSyncError);
  });
});

// ---------------------------------------------------------------------------
// 6. 未验证（无消费端）
// ---------------------------------------------------------------------------

describe('PPT-16：无消费端的两条如实标「未验证」', () => {
  it('报告原样带出未验证清单，且逐条 status=unverified 并写明需要什么', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings });

    // V-7：期望来自本文件独立写出的 `EXPECTED_UNVERIFIED`，不是源里那个常量本身。
    assertUnverifiedMatchesIndependentExpectation(report.unverified);
  });

  it('报告自带「同版一致」的判定口径（上游转述时结构上必须带上）', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings });
    expect(report.consistency_scope).toContain('不相等即报冲突');
    expect(report.consistency_scope).toContain('目标版本');
    expect(report.version).toEqual(R2);
  });

  it('如实边界：一致报告**不**声称"重开 / 打开无修复提示"', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings });
    expect(report.ok).toBe(true);
    // 一致 ≠ 已打开验证：未验证清单仍在报告里，且没有把这两条升级成通过。
    // V-7：逐条对照**独立写出**的期望（修复前这里是遍历源常量断言其字面量类型，恒真）。
    assertUnverifiedMatchesIndependentExpectation(report.unverified);
  });
});

// ---------------------------------------------------------------------------
// 7. 单一事实指纹：dc1-*（采用 P06 dataVersionOf，不另造哈希）
// ---------------------------------------------------------------------------

describe('PPT-16：事实快照携带 dc1-* 指纹（P06 dataVersionOf 的采用）', () => {
  it('data_version 形如 dc1-xxxxxxxx，且 = factDataVersionOf = dataVersionOf(规范投影)', () => {
    expect(V1.data_version).toMatch(/^dc1-[0-9a-f]{8}$/);
    expect(factDataVersionOf(V1)).toBe(V1.data_version);
    expect(dataVersionOf(factChartData(V1))).toBe(V1.data_version);
  });

  it('规范投影：类别 = 数值事实键（按字典序），唯一序列名 = FACT_DATA_SERIES_NAME', () => {
    const data = factChartData(V1);
    expect(data.categories).toEqual(['budget.total', 'headcount', 'headcount.planned']);
    expect(data.series).toHaveLength(1);
    expect(data.series[0]?.name).toBe(FACT_DATA_SERIES_NAME);
    expect(data.series[0]?.values).toEqual([20000, 8, 10]);
  });

  it('非数值事实不入投影（数值轴装不下文本），但仍由 entries 承载', () => {
    const withText = versionedSnapshot(R2, [
      headcount(8),
      { fact_key: 'note', fact_ref: 'f-note', value: { type: 'text', text: '草稿', source: '用户口述' } },
    ]);
    const data = factChartData(withText);
    expect(data.categories).toEqual(['headcount']);
    expect(withText.entries.map((entry) => entry.fact_key)).toContain('note');
    // 文本事实不进投影 ⇒ 与只含 headcount 的快照同指纹（指纹只覆盖数值事实）。
    expect(withText.data_version).toBe(versionedSnapshot(R2, [headcount(8)]).data_version);
  });

  it('换条目登记顺序不改指纹（按字典序规范化）', () => {
    const reordered = versionedSnapshot(R1, [plannedHeadcount(10), budget(20000), headcount(8)]);
    expect(reordered.data_version).toBe(V1.data_version);
  });

  it('同值不同键 ⇒ 不同指纹（键是类别名，参与哈希）', () => {
    const renamed = versionedSnapshot(R1, [
      headcount(8),
      budget(20000),
      { ...plannedHeadcount(10), fact_key: 'headcount.forecast' },
    ]);
    expect(renamed.data_version).not.toBe(V1.data_version);
  });

  it('setFactValue 改一条值 ⇒ 新版本号、新指纹；旧快照一字不动', () => {
    const next = setFactValue(V1, 'headcount', { type: 'number', amount: 12, unit: '人', currency: null });
    expect(next.version).toEqual(R2);
    expect(next.data_version).not.toBe(V1.data_version);
    expect(lookupVersionedFact(next, 'headcount')?.value).toEqual({ type: 'number', amount: 12, unit: '人', currency: null });
    // 原快照不变
    expect(V1.version).toEqual(R1);
    expect(lookupVersionedFact(V1, 'headcount')?.value).toEqual({ type: 'number', amount: 8, unit: '人', currency: null });
  });

  it('setFactValue 空键 ⇒ 具名抛', () => {
    expect(() => setFactValue(V1, '', { type: 'number', amount: 1, unit: '人', currency: null })).toThrowError(FactSyncError);
  });

  it('对账报告带出目标快照的 dc1-*（三处同版的坐标）', () => {
    const { presentation, bindings } = deck({ table: '12 人', chart_values: [12] });
    const report = syncPresentationFacts({ presentation, target: V2, bindings });
    expect(report.data_version).toBe(V2.data_version);
  });
});
