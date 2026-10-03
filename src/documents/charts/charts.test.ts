/**
 * 图表单测（WF-092）。
 *
 * 三条判据的对应用例：
 * 1. **数据可追溯**——从事实快照装配的图，每个点都能指认到 `fact_ref`/`fact_key`；
 *    缺事实、单位不一致、无来源字面量分别被拒。
 * 2. **数据与图形一致**——`describeChart` 是数据的函数：改数据 ⇒ 描述变；
 *    `verifyChartGeometry` 能抓住被改过的图形描述。
 * 3. **部件清单完整**——缺图表部件/关系被拒；图形节点必须有关系 id。
 */

import { describe, expect, it } from 'vitest';

import type { KnownFactSnapshotEntry } from '../../artifacts/ports.js';
import { buildFactSnapshot, type FactSnapshot } from '../../facts/index.js';
import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createSharedFactRecord,
  type SharedFactRecord,
} from '../../protocol/index.js';
import type { Result } from '../selection/types.js';
import {
  assertChartTraceable,
  buildChart,
  chartDataProvenance,
  defaultChartStyle,
  literalPoint,
  mergeChartStyle,
} from './build.js';
import { bindChartFromFacts } from './facts.js';
import { describeChart, describeChartGeometry, verifyChartGeometry, type ChartGeometry } from './geometry.js';
import { CHART_RELATIONSHIP_TYPE, chartDrawingBinding, chartPartsManifest, checkChartParts } from './parts.js';
import { assertStyleOnlyChange, describeChartStyle, setChartStyle } from './style.js';
import type { ChartDefinition } from './types.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

const TASK = asTaskId('task-1');
/** 任务/事实版本是**品牌化**的 Revision，必须经 `asRevision` 收窄（不能用裸 number）。 */
const REV = asRevision(1);

function numberFact(factKey: string, amount: number, unit = '人'): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(`fact-${factKey}`),
    task_id: TASK,
    task_revision: REV,
    fact_key: factKey,
    value: { kind: 'known', value: { type: 'number', amount, unit, currency: null } },
    source: { kind: 'user_confirmation', detail: '用户在前台确认' },
    confirmed_by: asInstanceId('inst-1'),
    confirmed_at: asLogicalTime(1),
  });
}

function textFact(factKey: string, text: string): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(`fact-${factKey}`),
    task_id: TASK,
    task_revision: REV,
    fact_key: factKey,
    value: { kind: 'known', value: { type: 'text', text, source: '会议纪要' } },
    source: { kind: 'document', detail: '导入的会议纪要' },
    confirmed_by: asInstanceId('inst-1'),
    confirmed_at: asLogicalTime(1),
  });
}

function snapshot(facts: readonly SharedFactRecord[], keys: readonly string[]): FactSnapshot {
  return buildFactSnapshot({ facts, task_id: TASK, task_revision: REV, fact_keys: keys });
}

const CATEGORIES = ['一月', '二月', '三月'];

function boundChart(): ChartDefinition {
  const facts = [numberFact('headcount.jan', 8), numberFact('headcount.feb', 4), numberFact('headcount.mar', 2)];
  return unwrap(
    bindChartFromFacts({
      chart_id: 'chart-1',
      chart_type: 'column',
      title: '各月在岗人数',
      categories: CATEGORIES,
      series: [{ name: '在岗人数', fact_keys: ['headcount.jan', 'headcount.feb', 'headcount.mar'] }],
      snapshot: snapshot(facts, ['headcount.jan', 'headcount.feb', 'headcount.mar']),
    }),
  );
}

describe('数据来源可追溯（WF-092 判据一）', () => {
  it('从事实快照装配的图：每个点都带 fact_ref 与 fact_key，可通过追溯闸门', () => {
    const chart = boundChart();
    const provenance = unwrap(chartDataProvenance(chart));

    expect(provenance.map((item) => item.value)).toEqual([8, 4, 2]);
    expect(provenance.map((item) => item.fact_key)).toEqual(['headcount.jan', 'headcount.feb', 'headcount.mar']);
    expect(provenance.every((item) => item.traceable)).toBe(true);
    expect(provenance[0]!.fact_ref).toBe('fact-headcount.jan');
    expect(unwrap(assertChartTraceable(chart))).toBe(chart);
  });

  it('反例：事实缺失 ⇒ not_found（且原因如实带出，不当零）', () => {
    const facts = [numberFact('headcount.jan', 8)]; // 二月、三月没有登记
    const result = bindChartFromFacts({
      chart_id: 'chart-1',
      chart_type: 'column',
      title: '各月在岗人数',
      categories: CATEGORIES,
      series: [{ name: '在岗人数', fact_keys: ['headcount.jan', 'headcount.feb', 'headcount.mar'] }],
      snapshot: snapshot(facts, ['headcount.jan', 'headcount.feb', 'headcount.mar']),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.detail.expression).toBe('headcount.feb');
      expect(result.detail.extra?.['unusableKind']).toBe('missing');
      expect(result.message).toContain('缺失不得当零');
    }
  });

  it('反例：非数值事实不能进数值轴（text 事实 ⇒ unsupported）', () => {
    const facts = [textFact('slogan', '稳步增长'), numberFact('headcount.feb', 4), numberFact('headcount.mar', 2)];
    const result = bindChartFromFacts({
      chart_id: 'chart-1',
      chart_type: 'column',
      title: '各月在岗人数',
      categories: CATEGORIES,
      series: [{ name: '在岗人数', fact_keys: ['slogan', 'headcount.feb', 'headcount.mar'] }],
      snapshot: snapshot(facts, ['slogan', 'headcount.feb', 'headcount.mar']),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported');
      expect(result.detail.extra?.['valueType']).toBe('text');
    }
  });

  it('反例：同一张图里量纲不一致（人 + 元）被拒', () => {
    const facts = [numberFact('headcount.jan', 8, '人'), numberFact('headcount.feb', 4, '人'), numberFact('cost.mar', 300, '元')];
    const result = bindChartFromFacts({
      chart_id: 'chart-1',
      chart_type: 'column',
      title: '混合量纲',
      categories: CATEGORIES,
      series: [{ name: '混合', fact_keys: ['headcount.jan', 'headcount.feb', 'cost.mar'] }],
      snapshot: snapshot(facts, ['headcount.jan', 'headcount.feb', 'cost.mar']),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('precondition');
      expect(result.detail.extra?.['units']).toContain('人');
      expect(result.detail.extra?.['units']).toContain('元');
    }
  });

  it('反例：无来源字面量能"表示"但不能"通过"追溯闸门', () => {
    const chart = unwrap(
      buildChart({
        chart_id: 'chart-literal',
        chart_type: 'column',
        title: '手写数字',
        categories: ['A', 'B'],
        series: [{ name: 'S', points: [literalPoint('A', 1), literalPoint('B', 2)] }],
        source: 'imported',
      }),
    );
    const gate = assertChartTraceable(chart);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('precondition');
      expect(gate.detail.extra?.['category']).toBe('A');
      expect(gate.message).toContain('单一来源');
    }
  });

  it('快照里的可用条目可直接查询（供上层复用）', () => {
    const facts = [numberFact('headcount.jan', 8)];
    const snap = snapshot(facts, ['headcount.jan']);
    const entry: KnownFactSnapshotEntry | null = snap.usable[0] ?? null;
    expect(entry?.fact_key).toBe('headcount.jan');
    expect(snap.unusable).toEqual([]);
  });
});

describe('数据与图形一致（WF-092 判据二）', () => {
  it('柱形：轴上限取最大值，柱高比例 = 值/轴上限', () => {
    const geometry = describeChart(boundChart());
    expect(geometry.kind).toBe('column');
    if (geometry.kind !== 'column') throw new Error('类型收窄');
    expect(geometry.axis).toEqual({ min: 0, max: 8 });
    expect(geometry.groups.map((group) => group.category)).toEqual(CATEGORIES);
    expect(geometry.groups.map((group) => group.bars[0]!.height_ratio)).toEqual([1, 0.5, 0.25]);
  });

  it('改数据 ⇒ 图形描述必然改变（图形是数据的函数）', () => {
    const chart = boundChart();
    const before = describeChart(chart);

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
    const after = describeChart(changed);

    expect(after).not.toEqual(before);
    if (after.kind === 'column' && before.kind === 'column') {
      expect(before.groups[2]!.bars[0]!.height_ratio).toBe(0.25);
      expect(after.groups[2]!.bars[0]!.height_ratio).toBe(0.75);
      expect(after.axis.max).toBe(8); // 最大值仍是一月的 8
    }
  });

  it('核对：与数据重算结果一致时通过；被改过的图形描述被抓住', () => {
    const chart = boundChart();
    const geometry = describeChart(chart);
    expect(unwrap(verifyChartGeometry(chart, geometry))).toEqual(geometry);

    if (geometry.kind !== 'column') throw new Error('类型收窄');
    const tampered: ChartGeometry = {
      ...geometry,
      groups: geometry.groups.map((group, index) =>
        index === 2 ? { ...group, bars: group.bars.map((bar) => ({ ...bar, height_ratio: 0.99 })) } : group,
      ),
    };
    const result = verifyChartGeometry(chart, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('不一致');
  });

  it('饼图：扇区角度按份额切分，最后一个扇区终止角恰好 360（无累积误差）', () => {
    const chart = unwrap(
      buildChart({
        chart_id: 'pie-1',
        chart_type: 'pie',
        title: '构成',
        categories: ['甲', '乙', '丙'],
        series: [
          {
            name: '占比',
            points: [
              { category: '甲', value: 1, fact_ref: asFactRef('f1'), fact_key: 'k1' },
              { category: '乙', value: 1, fact_ref: asFactRef('f2'), fact_key: 'k2' },
              { category: '丙', value: 2, fact_ref: asFactRef('f3'), fact_key: 'k3' },
            ],
          },
        ],
        source: 'user_request',
      }),
    );

    const geometry = describeChart(chart);
    if (geometry.kind !== 'pie') throw new Error('类型收窄');
    expect(geometry.total).toBe(4);
    expect(geometry.slices.map((slice) => slice.share)).toEqual([0.25, 0.25, 0.5]);
    expect(geometry.slices.map((slice) => [slice.start_angle_deg, slice.end_angle_deg])).toEqual([
      [0, 90],
      [90, 180],
      [180, 360],
    ]);
    expect(describeChartGeometry(geometry)).toContain('角度合计 360');
  });

  it('折线：单条系列多点时 x_ratio 均分；单点退化为 0', () => {
    const chart = unwrap(
      buildChart({
        chart_id: 'line-1',
        chart_type: 'line',
        title: '趋势',
        categories: CATEGORIES,
        series: [
          {
            name: 'S',
            points: CATEGORIES.map((category, index) => ({ category, value: index + 1, fact_ref: null, fact_key: null })),
          },
        ],
        source: 'imported',
      }),
    );
    const geometry = describeChart(chart);
    if (geometry.kind !== 'line') throw new Error('类型收窄');
    expect(geometry.series[0]!.points.map((point) => point.x_ratio)).toEqual([0, 0.5, 1]);
    expect(geometry.series[0]!.points.map((point) => point.y_ratio)).toEqual([1 / 3, 2 / 3, 1].map((n) => Math.round(n * 1e6) / 1e6));
  });
});

describe('构造期校验：类别轴与系列必须一一对应', () => {
  it('反例：类别重复 / 点数不匹配 / 类别顺序错位，都被拒', () => {
    const duplicate = buildChart({
      chart_id: 'c',
      chart_type: 'column',
      title: 't',
      categories: ['A', 'A'],
      series: [{ name: 's', points: [literalPoint('A', 1), literalPoint('A', 2)] }],
      source: 'imported',
    });
    expect(duplicate.ok).toBe(false);

    const mismatch = buildChart({
      chart_id: 'c',
      chart_type: 'column',
      title: 't',
      categories: ['A', 'B'],
      series: [{ name: 's', points: [literalPoint('A', 1)] }],
      source: 'imported',
    });
    expect(mismatch.ok).toBe(false);

    const misordered = buildChart({
      chart_id: 'c',
      chart_type: 'column',
      title: 't',
      categories: ['A', 'B'],
      series: [{ name: 's', points: [literalPoint('B', 1), literalPoint('A', 2)] }],
      source: 'imported',
    });
    expect(misordered.ok).toBe(false);
    if (!misordered.ok) expect(misordered.detail.extra?.['expected']).toBe('A');
  });

  it('反例：饼图多系列 / 负值 / 全零，都被拒', () => {
    const multi = buildChart({
      chart_id: 'c',
      chart_type: 'pie',
      title: 't',
      categories: ['A', 'B'],
      series: [
        { name: 's1', points: [literalPoint('A', 1), literalPoint('B', 2)] },
        { name: 's2', points: [literalPoint('A', 3), literalPoint('B', 4)] },
      ],
      source: 'imported',
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.code).toBe('unsupported');

    const negative = buildChart({
      chart_id: 'c',
      chart_type: 'pie',
      title: 't',
      categories: ['A', 'B'],
      series: [{ name: 's', points: [literalPoint('A', -1), literalPoint('B', 2)] }],
      source: 'imported',
    });
    expect(negative.ok).toBe(false);

    const zero = buildChart({
      chart_id: 'c',
      chart_type: 'pie',
      title: 't',
      categories: ['A', 'B'],
      series: [{ name: 's', points: [literalPoint('A', 0), literalPoint('B', 0)] }],
      source: 'imported',
    });
    expect(zero.ok).toBe(false);
  });

  it('反例：NaN / Infinity 不是有限数，被拒', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildChart({
        chart_id: 'c',
        chart_type: 'column',
        title: 't',
        categories: ['A'],
        series: [{ name: 's', points: [literalPoint('A', bad)] }],
        source: 'imported',
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('部件清单完整性与图形节点桥（WF-092 判据三）', () => {
  it('清单给出图表部件/内容类型/关系类型；齐件通过，缺件被列出', () => {
    const chart = boundChart();
    const manifest = unwrap(chartPartsManifest(chart, 1));

    expect(manifest.chart_part).toBe('word/charts/chart1.xml');
    expect(manifest.relationship_type).toBe(CHART_RELATIONSHIP_TYPE);
    expect(manifest.embedded_workbook_part).toBe('word/embeddings/Microsoft_Excel_Worksheet1.xlsx');

    const complete = checkChartParts(manifest, [
      manifest.chart_part,
      CHART_RELATIONSHIP_TYPE,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
    ]);
    expect(complete.ok).toBe(true);

    const incomplete = checkChartParts(manifest, [CHART_RELATIONSHIP_TYPE]);
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.code).toBe('not_found');
      expect(incomplete.detail.extra?.['missing']).toContain('word/charts/chart1.xml');
    }
  });

  it('反例：部件序号非法被拒；不写嵌入工作簿时清单相应收缩', () => {
    const chart = boundChart();
    expect(chartPartsManifest(chart, 0).ok).toBe(false);
    const lean = unwrap(chartPartsManifest(chart, 2, { embedded_workbook: false }));
    expect(lean.chart_part).toBe('word/charts/chart2.xml');
    expect(lean.embedded_workbook_part).toBeNull();
    expect(lean.required_relationship_types).toEqual([CHART_RELATIONSHIP_TYPE]);
  });

  it('图形节点桥：必须有关系 id（否则悬空引用，R106）', () => {
    const chart = boundChart();
    const manifest = unwrap(chartPartsManifest(chart, 1));

    const dangling = chartDrawingBinding(chart, manifest, { relationship_id: '', source: 'user_request' });
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) expect(dangling.code).toBe('precondition');

    const bound = unwrap(chartDrawingBinding(chart, manifest, { relationship_id: 'rId9', source: 'user_request' }));
    expect(bound.kind).toBe('drawing');
    expect(bound.drawing_type).toBe('chart');
    expect(bound.relationship_id).toBe('rId9');
    expect(bound.alt_text).toBe('各月在岗人数');
  });
});

describe('样式修改（WF-092 基本样式）', () => {
  it('改样式不动数据，图形描述保持不变', () => {
    const chart = boundChart();
    const before = describeChart(chart);

    const styled = unwrap(setChartStyle(chart, { legend: 'bottom', palette: ['123456'], data_labels: true }));
    expect(styled.style.legend).toBe('bottom');
    expect(styled.style.palette).toEqual(['123456']);
    expect(styled.series).toEqual(chart.series);
    expect(describeChart(styled)).toEqual(before);
    expect(unwrap(assertStyleOnlyChange(chart, styled))).toBe(styled);
    expect(describeChartStyle(styled.style)).toContain('图例=bottom');
  });

  it('幂等：空补丁返回同一个图表对象（R137）', () => {
    const chart = boundChart();
    expect(unwrap(setChartStyle(chart, {}))).toBe(chart);
  });

  it('反例：非法样式（未知图例位置 / 非 6 位色值 / 非正字号）被拒，原图表不变', () => {
    const chart = boundChart();
    const base = defaultChartStyle();

    expect(mergeChartStyle(base, { legend: 'middle' as never }).ok).toBe(false);
    expect(mergeChartStyle(base, { palette: ['#fff'] }).ok).toBe(false);
    expect(mergeChartStyle(base, { title_font_size_pt: 0 }).ok).toBe(false);
    expect(mergeChartStyle(base, { palette: [] }).ok).toBe(false);

    const result = setChartStyle(chart, { palette: ['zzzzzz'] });
    expect(result.ok).toBe(false);
    expect(chart.style).toEqual(defaultChartStyle()); // 原对象未被改（不可变）
  });

  it('反例：样式守卫挡住"顺手改了数据"', () => {
    const chart = boundChart();
    const tampered: ChartDefinition = {
      ...chart,
      series: [
        { name: '在岗人数', points: chart.series[0]!.points.map((point) => ({ ...point, value: 999 })) },
      ],
    };
    const gate = assertStyleOnlyChange(chart, tampered);
    expect(gate.ok).toBe(false);
  });
});
