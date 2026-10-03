/**
 * **W07 — 可编辑 OMML 公式 / 图表 / 嵌入数据表的独立验证**（`tests/mobile-office/word/W07/`）。
 *
 * 包行判据：`equations/`、`charts/`；WF-091/092 —— "可编辑 OMML 公式、图表和嵌入数据表；
 * **图形、数值与事实版本一致，非截图**"。
 *
 * ## 本文件独立取证什么（不重复 `charts.test.ts` / `equations.test.ts`）
 *
 * 既有测试覆盖了"结构可读""几何是数据的函数""部件清单"。本文件针对**判据尾句**里
 * 尚未被机器钉住的两条，以及新落地的两个模块：
 *
 * | 判据 | 既有覆盖 | 本文件新增的独立判据 |
 * |---|---|---|
 * | 公式**不是截图**（WF-091） | 结构里无图形字段 | 线性记法 → 结构 → OMML 形状**闭环**：分式仍读得出分子/分母，元素名是 `m:f` 而非绘图元素 |
 * | **嵌入数据表**与图形一致（WF-092） | 无（**本次新增模块** `datatable.ts`） | 表由图表纯函数算出；改数据 ⇒ 表变；被单独改过的表被拒；重名列/缺格被拒 |
 * | **数值与事实版本一致**（WF-092） | 仅"点带 fact_ref" | 版本比对（stale_revision / 未绑定）；**逐点回算 amount**；带 fact_ref 的抄改被拒 |
 * | 四者合一的报告 | 无（**本次新增** `version.ts`） | `verifyChartFactAgreement` 钉住版本 + 逐点数值 + 图形签名 + 表签名 |
 *
 * ## 反向对照（防"判据是空壳"）
 *
 * 每条"被拒"断言都配一条**同字段的合法对照**：正例通过 ⇒ 拒绝针对的是那处偏差，而非整类输入。
 * 例如抄改数值被拒的同时，把 `fact_ref` 一并改成另一点的事实 id（数值与新 ref 自洽）不作本文件断言，
 * 但"未抄改的图"必须通过 —— 见 §C 的首个用例。
 */

import { describe, expect, it } from 'vitest';

import { asFactRef, asInstanceId, asLogicalTime, asRevision, asTaskId, createSharedFactRecord } from '../../../../src/protocol/index.js';
import type { SharedFactRecord } from '../../../../src/protocol/index.js';
import { buildFactSnapshot, type FactSnapshot } from '../../../../src/facts/index.js';
import { buildChart, literalPoint } from '../../../../src/documents/charts/build.js';
import { bindChartFromFacts } from '../../../../src/documents/charts/facts.js';
import {
  DEFAULT_CATEGORY_HEADER,
  chartDataTableCellCount,
  chartDataTableMatrix,
  chartDataTableSignature,
  chartEmbeddedTable,
  describeChartDataTable,
  verifyChartDataTable,
} from '../../../../src/documents/charts/datatable.js';
import { describeChart } from '../../../../src/documents/charts/geometry.js';
import {
  assertChartFactVersion,
  chartFactVersionOf,
  verifyChartFactAgreement,
  verifyChartNumbersAgainstSnapshot,
} from '../../../../src/documents/charts/version.js';
import type { ChartDefinition } from '../../../../src/documents/charts/types.js';
import { parseMath } from '../../../../src/documents/equations/parse.js';
import { ommlElementNames, toOmmlShape } from '../../../../src/documents/equations/omml.js';
import { denominatorOf, numeratorOf } from '../../../../src/documents/equations/read.js';
import type { Result } from '../../../../src/documents/selection/types.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

const TASK = asTaskId('task-w07');
const REV1 = asRevision(1);
const REV2 = asRevision(2);
const CATEGORIES = ['一月', '二月', '三月'];

function numberFact(factKey: string, amount: number, revision = REV1, unit = '人'): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(`fact-${factKey}-r${String(revision)}`),
    task_id: TASK,
    task_revision: revision,
    fact_key: factKey,
    value: { kind: 'known', value: { type: 'number', amount, unit, currency: null } },
    source: { kind: 'user_confirmation', detail: '用户在前台确认' },
    confirmed_by: asInstanceId('inst-1'),
    confirmed_at: asLogicalTime(1),
  });
}

function textFact(factKey: string, text: string): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(`fact-${factKey}-t`),
    task_id: TASK,
    task_revision: REV1,
    fact_key: factKey,
    value: { kind: 'known', value: { type: 'text', text, source: '纪要' } },
    source: { kind: 'document', detail: '导入纪要' },
    confirmed_by: asInstanceId('inst-1'),
    confirmed_at: asLogicalTime(1),
  });
}

function snapshot(facts: readonly SharedFactRecord[], keys: readonly string[], revision = REV1): FactSnapshot {
  return buildFactSnapshot({ facts, task_id: TASK, task_revision: revision, fact_keys: keys });
}

const KEYS = ['headcount.jan', 'headcount.feb', 'headcount.mar'];

function factsV1(): readonly SharedFactRecord[] {
  return [numberFact('headcount.jan', 8), numberFact('headcount.feb', 4), numberFact('headcount.mar', 2)];
}

function boundChart(): ChartDefinition {
  return unwrap(
    bindChartFromFacts({
      chart_id: 'chart-w07',
      chart_type: 'column',
      title: '各月在岗人数',
      categories: CATEGORIES,
      series: [{ name: '在岗人数', fact_keys: KEYS }],
      snapshot: snapshot(factsV1(), KEYS),
    }),
  );
}

// ---------------------------------------------------------------------------
// §A 公式：线性记法 → 结构 → OMML 形状的闭环（WF-091 "非截图"）
// ---------------------------------------------------------------------------

describe('§A 公式闭环：可编辑结构映射到 OMML 语义形状（WF-091，非截图）', () => {
  it('\\frac{1}{2} 解析成分式，仍读得出分子 1 与分母 2；OMML 元素是 m:f 而非绘图元素', () => {
    const equation = unwrap(parseMath('\\frac{1}{2}'));

    // 结构层：分式的语义部件可读（截图读不出这些）。
    expect(numeratorOf(equation)).not.toBeNull();
    expect(denominatorOf(equation)).not.toBeNull();

    const shape = unwrap(toOmmlShape(equation));
    expect(shape.omml).toBe('m:f');
    const names = ommlElementNames(shape);
    expect(names[0]).toBe('m:f');
    // 形状里没有任何绘图/图片元素名——公式不是一张图。
    expect(names.some((name) => name.includes('drawing') || name.includes('blip') || name.includes('pic'))).toBe(false);

    // 反向对照：换一个分子，形状随之改变（不是缓存/常量）。
    const other = unwrap(toOmmlShape(unwrap(parseMath('\\frac{3}{2}'))));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(shape));
  });

  it('\\sqrt[3]{x} 是根式：次数与根号内的结构分别可读，映射为 m:rad', () => {
    const shape = unwrap(toOmmlShape(unwrap(parseMath('\\sqrt[3]{x}'))));
    expect(shape.omml).toBe('m:rad');
    expect(ommlElementNames(shape)).toContain('m:rad');
  });
});

// ---------------------------------------------------------------------------
// §B 嵌入数据表：由图表纯函数算出，与图形数值同源（WF-092）
// ---------------------------------------------------------------------------

describe('§B 嵌入数据表与图表数据一致（WF-092）', () => {
  it('表由图表算出：列头是系列名，行是类别 + 各系列取值，逐格等于数据点', () => {
    const chart = boundChart();
    const table = unwrap(chartEmbeddedTable(chart));

    expect(table.category_header).toBe(DEFAULT_CATEGORY_HEADER);
    expect(table.series_names).toEqual(['在岗人数']);
    expect(table.rows.map((row) => row.category)).toEqual(CATEGORIES);
    expect(table.rows.map((row) => row.values)).toEqual([[8], [4], [2]]);
    expect(chartDataTableCellCount(table)).toBe((1 + 1) * (1 + 3)); // 表头行 + 类别列
    expect(describeChartDataTable(table)).toContain('3 行 × 2 列');

    // 矩阵形态（嵌入工作簿写出器消费）：首行表头，首列类别。
    expect(chartDataTableMatrix(table)).toEqual([
      [DEFAULT_CATEGORY_HEADER, '在岗人数'],
      ['一月', '8'],
      ['二月', '4'],
      ['三月', '2'],
    ]);
  });

  it('改图表数据 ⇒ 表签名必变（表是数据的函数，不是缓存）', () => {
    const chart = boundChart();
    const before = chartDataTableSignature(unwrap(chartEmbeddedTable(chart)));

    const changed: ChartDefinition = {
      ...chart,
      series: [
        {
          name: chart.series[0]!.name,
          points: chart.series[0]!.points.map((point) =>
            point.category === '三月' ? { ...point, value: 6 } : point,
          ),
        },
      ],
    };
    const after = chartDataTableSignature(unwrap(chartEmbeddedTable(changed)));
    expect(after).not.toBe(before);
  });

  it('核对：与图表重算结果一致时通过；被单独改过的表被拒（表格与图形脱节）', () => {
    const chart = boundChart();
    const table = unwrap(chartEmbeddedTable(chart));
    expect(unwrap(verifyChartDataTable(chart, table))).toEqual(table);

    const tampered = { ...table, rows: table.rows.map((row, index) => (index === 2 ? { ...row, values: [99] } : row)) };
    const result = verifyChartDataTable(chart, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('precondition');
      expect(result.message).toContain('不一致');
    }
  });

  it('反例：重名系列无法唯一指认列 ⇒ 被拒', () => {
    const chart = unwrap(
      buildChart({
        chart_id: 'dup',
        chart_type: 'column',
        title: '重名',
        categories: ['A', 'B'],
        series: [
          { name: 'S', points: [literalPoint('A', 1), literalPoint('B', 2)] },
          { name: 'S', points: [literalPoint('A', 3), literalPoint('B', 4)] },
        ],
        source: 'imported',
      }),
    );
    const result = chartEmbeddedTable(chart);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('precondition');
      expect(result.message).toContain('重复');
    }
  });

  it('反例：系列缺某类别数据点 ⇒ 拒绝留空格（不得用 0 顶替）', () => {
    const chart = boundChart();
    const short: ChartDefinition = {
      ...chart,
      series: [{ name: chart.series[0]!.name, points: chart.series[0]!.points.slice(0, 2) }],
    };
    const result = chartEmbeddedTable(short);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('嵌入表不得留空格');
  });
});

// ---------------------------------------------------------------------------
// §C 数值与事实版本一致（WF-092 判据尾句）
// ---------------------------------------------------------------------------

describe('§C 数值与事实版本一致（WF-092）', () => {
  it('从事实装配的图记录事实版本；同版本核对通过，逐点回报单位', () => {
    const chart = boundChart();
    expect(chartFactVersionOf(chart)).toEqual({ task_id: TASK, task_revision: REV1 });
    expect(unwrap(assertChartFactVersion(chart, { task_id: TASK, task_revision: REV1 }))).toEqual({
      task_id: TASK,
      task_revision: REV1,
    });

    const agreements = unwrap(verifyChartNumbersAgainstSnapshot(chart, snapshot(factsV1(), KEYS)));
    expect(agreements.map((item) => item.value)).toEqual([8, 4, 2]);
    expect(agreements.map((item) => item.fact_key)).toEqual(KEYS);
    expect(agreements.every((item) => item.unit === '人')).toBe(true);
  });

  it('反例：任务版本升级 ⇒ stale_revision（旧图不得冒充当前版本）', () => {
    const chart = boundChart();
    const result = assertChartFactVersion(chart, { task_id: TASK, task_revision: REV2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_revision');
      expect(result.detail.requestedRevision).toBe(REV1);
      expect(result.detail.currentRevision).toBe(REV2);
    }
  });

  it('反例：字面量图未绑定事实版本 ⇒ precondition（不得默认通过）', () => {
    const literal = unwrap(
      buildChart({
        chart_id: 'lit',
        chart_type: 'column',
        title: '手写',
        categories: ['A'],
        series: [{ name: 'S', points: [literalPoint('A', 1)] }],
        source: 'imported',
      }),
    );
    expect(chartFactVersionOf(literal)).toBeNull();
    const result = assertChartFactVersion(literal, { task_id: TASK, task_revision: REV1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('反例：带 fact_ref 抄改数值（截图式谎言）⇒ precondition，被逐点回算抓住', () => {
    const chart = boundChart();
    const tampered: ChartDefinition = {
      ...chart,
      series: [
        {
          name: chart.series[0]!.name,
          points: chart.series[0]!.points.map((point) =>
            point.category === '一月' ? { ...point, value: 999 } : point,
          ),
        },
      ],
    };
    const result = verifyChartNumbersAgainstSnapshot(tampered, snapshot(factsV1(), KEYS));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('precondition');
      expect(result.message).toContain('不是同一条事实');
      expect(result.detail.extra?.['pointValue']).toBe(999);
      expect(result.detail.extra?.['factAmount']).toBe(8);
    }
  });

  it('反例：fact_ref 与快照条目对不上 ⇒ precondition（引用的不是这条事实）', () => {
    const chart = boundChart();
    const forged: ChartDefinition = {
      ...chart,
      series: [
        {
          name: chart.series[0]!.name,
          points: chart.series[0]!.points.map((point, index) =>
            index === 0 ? { ...point, fact_ref: asFactRef('fact-somewhere-else-r1') } : point,
          ),
        },
      ],
    };
    const result = verifyChartNumbersAgainstSnapshot(forged, snapshot(factsV1(), KEYS));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('反例：快照里没有该键 ⇒ not_found（缺失不得当零）', () => {
    const chart = boundChart();
    const result = verifyChartNumbersAgainstSnapshot(
      chart,
      snapshot([numberFact('headcount.jan', 8)], ['headcount.jan']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.detail.expression).toBe('headcount.feb');
    }
  });

  it('反例：点引用非数值事实 ⇒ unsupported', () => {
    const chart = boundChart();
    const withText: ChartDefinition = {
      ...chart,
      series: [
        {
          name: chart.series[0]!.name,
          points: chart.series[0]!.points.map((point, index) =>
            index === 0
              ? { ...point, fact_key: 'slogan', fact_ref: asFactRef('fact-slogan-t') }
              : point,
          ),
        },
      ],
    };
    const result = verifyChartNumbersAgainstSnapshot(
      withText,
      snapshot([textFact('slogan', '稳步增长'), ...factsV1()], ['slogan', ...KEYS]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported');
      expect(result.detail.extra?.['valueType']).toBe('text');
    }
  });
});

// ---------------------------------------------------------------------------
// §D 四者合一：图形 / 数值 / 事实版本一致报告
// ---------------------------------------------------------------------------

describe('§D verifyChartFactAgreement：图形、数值与事实版本一致', () => {
  it('正例：报告钉住版本、逐点数值、图形签名与嵌入表签名；图形签名确来自这组数', () => {
    const chart = boundChart();
    const snap = snapshot(factsV1(), KEYS);
    const report = unwrap(verifyChartFactAgreement(chart, snap));

    expect(report.fact_version).toEqual({ task_id: TASK, task_revision: REV1 });
    expect(report.geometry_kind).toBe('column');
    expect(report.points.map((point) => point.value)).toEqual([8, 4, 2]);
    // 图形签名必须等于从同一份数据重算的几何（图形是数值的函数）。
    expect(report.geometry_signature).toBe(JSON.stringify(describeChart(chart)));
    expect(report.table_signature).toBe(chartDataTableSignature(unwrap(chartEmbeddedTable(chart))));
  });

  it('反例：数值被抄改 ⇒ 整个一致性报告失败（图形高 8、来源却写着 999 这种谎言被抓住）', () => {
    const chart = boundChart();
    const tampered: ChartDefinition = {
      ...chart,
      series: [
        {
          name: chart.series[0]!.name,
          points: chart.series[0]!.points.map((point) =>
            point.category === '二月' ? { ...point, value: 4.0001 } : point,
          ),
        },
      ],
    };
    const result = verifyChartFactAgreement(tampered, snapshot(factsV1(), KEYS));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('反例：图绑定旧版本、快照是新版本 ⇒ 报告在版本闸门处失败', () => {
    const chart = boundChart(); // 版本 REV1
    const r2Facts = KEYS.map((key, index) => numberFact(key, [8, 4, 2][index]!, REV2));
    const result = verifyChartFactAgreement(chart, snapshot(r2Facts, KEYS, REV2));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('stale_revision');
  });
});
