/**
 * **W07-I01 — 图表导出：图形缓存 / 嵌入数据表 / 事实版本三处一致（WF-092）的独立验证**。
 *
 * ## 本文件独立取证什么
 *
 * 姊妹文件 `w07-equations-charts-agreement.test.ts` 证的是**模型层**（`datatable.ts` /
 * `version.ts` 的纯函数）。本文件证的是**导出接线**——W07 的原始诉求：
 *
 * > `export.ts` 只检查嵌入 `.xlsx` 是非空字节，从不对照它的数字与图表 `c:numLit` 缓存，
 * > 也从不调用 `verifyChartFactAgreement`。
 *
 * | 判据 | 落点 | 本文件的独立断言 |
 * |---|---|---|
 * | **图形缓存 ≡ 嵌入数据表**（逐点） | `export.ts` 在 `chartPartXml` 拿出字节后调 `compareChartNumLitToTable` | 从**导出产物字节**里把 `c:numLit` 读回来，与 `chartEmbeddedTable` 逐点相等（单系列 + 多系列） |
 * | 不一致 **fail closed** | 导出拒绝 `unsupported_chart_data` | ① 篡改后的 XML 被比较器抓住（不是空壳）；② 算不出表的图（重名系列）被导出拒绝 |
 * | **数值与事实版本一致** | `verifyChartFactAgreement` 接线 | 带快照的图导出通过并回报版本；**抄改数值** / **版本过期**的图导出被拒；无快照时不谎报"已核对" |
 * | 审计记录 `{fact_version, geometry_signature, table_signature}` | `on_chart_artifact` 回调 | 三个签名与模型层重算值逐字相等；导出被拒时**一条记录都不放出** |
 *
 * ## 反向对照（防"判据是空壳"）
 *
 * 每条"被拒"断言都配一条**同输入的合法对照**：抄改数值的图**不带快照**时照样导出成功，
 * 只有带上真实快照才被拒 —— 证明抓住它的是**事实核对**，而不是整类输入。
 *
 * ## 未做消费端验证（如实标注）
 *
 * 本文件证明的是**导出期包内自洽**（缓存 / 表 / 事实三处一致），**不是**"Word 打开能看到这张图"。
 * 无设备、无 Word/WPS，未做 consumer-reopen。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createSharedFactRecord,
  type SharedFactRecord,
} from '../../../../src/protocol/index.js';
import { buildFactSnapshot, type FactSnapshot } from '../../../../src/facts/index.js';
import { buildChart } from '../../../../src/documents/charts/build.js';
import { bindChartFromFacts } from '../../../../src/documents/charts/facts.js';
import {
  chartDataTableSignature,
  chartEmbeddedTable,
} from '../../../../src/documents/charts/datatable.js';
import { describeChart } from '../../../../src/documents/charts/geometry.js';
import { chartFactVersionOf } from '../../../../src/documents/charts/version.js';
import type { ChartDefinition } from '../../../../src/documents/charts/types.js';
import {
  chartNumLitValues,
  compareChartNumLitToTable,
} from '../../../../src/documents/docx/chart-render.js';
import { DocxError } from '../../../../src/documents/docx/docx-error.js';
import { exportDocx, type ChartArtifactAudit } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';
import { createDocumentModel } from '../../../../src/documents/model/document.js';
import { drawingNode, paragraphNode, runNode } from '../../../../src/documents/model/nodes.js';
import type { DocumentModel, Length } from '../../../../src/documents/model/types.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const CHART_PART = 'word/charts/chart1.xml';
const CHART_RID = 'rId900';
const TASK = asTaskId('task-w07-export');
const REV1 = asRevision(1);
const REV2 = asRevision(2);
const CATEGORIES = ['一月', '二月', '三月'];
const KEYS = ['headcount.jan', 'headcount.feb', 'headcount.mar'];
const BUDGET_KEYS = ['budget.jan', 'budget.feb', 'budget.mar'];

const PT = (value: number): Length => ({ unit: 'pt', value });

function numberFact(factKey: string, amount: number, revision = REV1): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(`fact-${factKey}-r${String(revision)}`),
    task_id: TASK,
    task_revision: revision,
    fact_key: factKey,
    value: { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail: '用户在前台确认' },
    confirmed_by: asInstanceId('inst-1'),
    confirmed_at: asLogicalTime(1),
  });
}

function snapshotFor(
  facts: readonly SharedFactRecord[],
  keys: readonly string[],
  revision = REV1,
): FactSnapshot {
  return buildFactSnapshot({ facts, task_id: TASK, task_revision: revision, fact_keys: keys });
}

function factsOf(values: readonly number[], revision = REV1): readonly SharedFactRecord[] {
  return KEYS.map((key, index) => numberFact(key, values[index] as number, revision));
}

function snapshotOf(values: readonly number[], revision = REV1): FactSnapshot {
  return snapshotFor(factsOf(values, revision), KEYS, revision);
}

/** 从事实快照装配的单系列图（导出用的合法输入）。 */
function boundChart(values: readonly number[], chartId = 'chart-w07-export'): ChartDefinition {
  const built = bindChartFromFacts({
    chart_id: chartId,
    chart_type: 'column',
    title: '各月在岗人数',
    categories: CATEGORIES,
    series: [{ name: '在岗人数', fact_keys: KEYS }],
    snapshot: snapshotOf(values),
  });
  if (!built.ok) throw new Error(built.message);
  return built.value;
}

/** 两系列图：用来证明"系列次序转置"在多系列下也对得上（不是只对一条系列成立）。 */
function boundChartTwoSeries(): ChartDefinition {
  const facts = [...factsOf([8, 4, 2]), numberFact('budget.jan', 10), numberFact('budget.feb', 20), numberFact('budget.mar', 30)];
  const built = bindChartFromFacts({
    chart_id: 'chart-w07-two',
    chart_type: 'column',
    title: '人数与预算',
    categories: CATEGORIES,
    series: [
      { name: '在岗人数', fact_keys: KEYS },
      { name: '预算', fact_keys: BUDGET_KEYS },
    ],
    snapshot: snapshotFor(facts, [...KEYS, ...BUDGET_KEYS]),
  });
  if (!built.ok) throw new Error(built.message);
  return built.value;
}

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 一个含"图表图形节点"的文档（该节点引用 `relationshipId`）。 */
function chartModel(relationshipId: string = CHART_RID): DocumentModel {
  const draft = paragraphNode({
    source: 'user_request',
    inlines: [
      runNode({ text: '前', source: 'user_request' }),
      drawingNode({
        drawing_type: 'chart',
        source: 'model_generated',
        relationship_id: relationshipId,
        extent: { width: PT(120), height: PT(90) },
        alt_text: '人数图',
      }),
      runNode({ text: '后', source: 'user_request' }),
    ],
  });
  const blocks = createDocumentModel({ document_id: 'chart-w07-export-doc', blocks: [draft] }).blocks;
  return { ...corpusModel(), blocks, sections: [] };
}

interface ExportRun {
  readonly bytes: Uint8Array;
  readonly audits: readonly ChartArtifactAudit[];
  readonly chartXml: string;
}

function runExport(
  chart: ChartDefinition,
  extra: {
    readonly relationshipId?: string;
    readonly snapshot?: FactSnapshot;
    readonly model?: DocumentModel;
  } = {},
): ExportRun {
  const audits: ChartArtifactAudit[] = [];
  const relationshipId = extra.relationshipId ?? CHART_RID;
  const snapshots =
    extra.snapshot === undefined ? undefined : new Map([[chart.chart_id, extra.snapshot]]);
  const bytes = exportDocx(extra.model ?? chartModel(relationshipId), {
    charts: [{ part_index: 1, definition: chart, relationship_id: relationshipId }],
    ...(snapshots === undefined ? {} : { chart_fact_snapshots: snapshots }),
    on_chart_artifact: (record) => audits.push(record),
  });
  const entry = readZip(bytes).by_path.get(CHART_PART);
  if (entry === undefined) throw new Error('导出产物里没有 chart1.xml');
  return { bytes, audits, chartXml: new TextDecoder().decode(entry.data) };
}

function expectDocxError(fn: () => unknown, reason: string): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DocxError);
  expect((thrown as DocxError).reason).toBe(reason);
}

/** 一张表逐系列摊平成的取值数组（与 `c:numLit` 的系列次序对齐）。 */
function tableSeriesValues(chart: ChartDefinition): readonly (readonly number[])[] {
  const table = chartEmbeddedTable(chart);
  if (!table.ok) throw new Error(table.message);
  return table.value.series_names.map((_, seriesIndex) =>
    table.value.rows.map((row) => row.values[seriesIndex] as number),
  );
}

// ---------------------------------------------------------------------------
// §A 图形缓存（c:numLit）≡ 嵌入数据表（导出期核对，从产物字节读回）
// ---------------------------------------------------------------------------

describe('§A 导出期：c:numLit 缓存与嵌入数据表逐点一致（从产物字节读回）', () => {
  it('单系列：读回的 c:numLit == 表取值；审计记录签名与模型层重算值逐字相等', () => {
    const chart = boundChart([8, 4, 2]);
    const { chartXml, audits } = runExport(chart);

    // 独立读回产物里的 c:numLit（不经导出器的比较器）：一条系列、三个点。
    expect(chartNumLitValues(chartXml)).toEqual([[8, 4, 2]]);
    expect(chartNumLitValues(chartXml)).toEqual(tableSeriesValues(chart));

    const table = chartEmbeddedTable(chart);
    if (!table.ok) throw new Error(table.message);
    expect(compareChartNumLitToTable(table.value, chartXml)).toEqual({
      ok: true,
      series_count: 1,
      point_count: 3,
    });

    expect(audits).toHaveLength(1);
    const audit = audits[0] as ChartArtifactAudit;
    expect(audit.numlit_matches_table).toBe(true);
    expect(audit.chart_part).toBe(CHART_PART);
    expect(audit.relationship_id).toBe(CHART_RID);
    expect(audit.table_signature).toBe(chartDataTableSignature(table.value));
    expect(audit.geometry_signature).toBe(JSON.stringify(describeChart(chart)));
  });

  it('多系列：系列次序转置对得上（缓存第二条系列 == 表的第二列）', () => {
    const chart = boundChartTwoSeries();
    const { chartXml, audits } = runExport(chart);

    expect(chartNumLitValues(chartXml)).toEqual([
      [8, 4, 2],
      [10, 20, 30],
    ]);
    expect(chartNumLitValues(chartXml)).toEqual(tableSeriesValues(chart));
    expect((audits[0] as ChartArtifactAudit).numlit_matches_table).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §B 不一致 fail closed：比较器不是空壳，且确被导出器接线
// ---------------------------------------------------------------------------

describe('§B 图形缓存 ≠ 表 ⇒ 拒绝写出（fail closed）', () => {
  it('反向对照：篡改 c:numLit 的值后，比较器立刻报出偏差（带系列/点/两侧取值）', () => {
    const chart = boundChart([8, 4, 2]);
    const { chartXml } = runExport(chart);
    const table = chartEmbeddedTable(chart);
    if (!table.ok) throw new Error(table.message);

    // 未篡改时必须通过（防止下方断言是"恒定失败"）。
    expect(compareChartNumLitToTable(table.value, chartXml).ok).toBe(true);

    // 只动 c:numLit 里的那个 8（该串在整份 XML 里唯一）——模拟"图形缓存被单独改过"。
    expect(chartXml.split('>8<').length - 1).toBe(1);
    const tampered = chartXml.replace('>8<', '>999<');

    const comparison = compareChartNumLitToTable(table.value, tampered);
    expect(comparison.ok).toBe(false);
    if (!comparison.ok) {
      expect(comparison.mismatches[0]).toEqual({
        series_index: 0,
        point_index: 0,
        cached: 999,
        table: 8,
      });
      expect(comparison.reason).toContain('c:numLit');
    }
    // 读回侧也如实看到被改过的值。
    expect(chartNumLitValues(tampered)).toEqual([[999, 4, 2]]);
  });

  it('导出器已接线：算不出嵌入数据表的图（重名系列）被导出拒绝，异名对照则导出成功', () => {
    const seriesPair = (names: readonly [string, string]): ChartDefinition => {
      const built = buildChart({
        chart_id: 'chart-w07-dup',
        chart_type: 'column',
        title: '重名与异名系列',
        categories: CATEGORIES,
        series: [
          {
            name: names[0],
            points: CATEGORIES.map((category, index) => ({
              category,
              value: index + 1,
              fact_ref: asFactRef(`fact-a-${String(index)}`),
              fact_key: KEYS[index] as string,
            })),
          },
          {
            name: names[1],
            points: CATEGORIES.map((category, index) => ({
              category,
              value: index + 10,
              fact_ref: asFactRef(`fact-b-${String(index)}`),
              fact_key: KEYS[index] as string,
            })),
          },
        ],
        source: 'user_request',
      });
      if (!built.ok) throw new Error(built.message);
      return built.value;
    };

    // 重名系列 ⇒ 嵌入数据表算不出（两列无法唯一指认）⇒ 导出 fail closed。
    expectDocxError(() => runExport(seriesPair(['S', 'S'])), 'unsupported_chart_data');
    // 反向对照：只把第二个系列名改掉 ⇒ 导出成功（抓住的是"表算不出"，不是整类图表）。
    expect(runExport(seriesPair(['S', 'T'])).audits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §C 数值与事实版本一致：verifyChartFactAgreement 真被导出器调用
// ---------------------------------------------------------------------------

describe('§C 事实一致性（verifyChartFactAgreement）在导出期生效', () => {
  it('带正确快照 ⇒ 导出通过，审计回报事实版本与逐点核对通过的数据点数', () => {
    const chart = boundChart([8, 4, 2]);
    const { audits } = runExport(chart, { snapshot: snapshotOf([8, 4, 2]) });

    const audit = audits[0] as ChartArtifactAudit;
    expect(audit.fact_version).toEqual({ task_id: TASK, task_revision: REV1 });
    expect(chartFactVersionOf(chart)).toEqual({ task_id: TASK, task_revision: REV1 });
    expect(audit.fact_agreement).toEqual({
      verified: true,
      task_id: TASK,
      task_revision: REV1,
      point_count: 3,
    });
  });

  it('抄改数值（fact_ref 仍在）⇒ 带真实快照被拒；不带快照则导出成功（反向对照）', () => {
    const chart = boundChart([8, 4, 2]);
    const point = chart.series[0]!.points[0]!;
    const tampered: ChartDefinition = {
      ...chart,
      series: [
        {
          name: chart.series[0]!.name,
          points: chart.series[0]!.points.map((item, index) =>
            index === 0 ? { ...item, value: 999 } : item,
          ),
        },
      ],
    };
    expect(tampered.series[0]!.points[0]!.fact_ref).toBe(point.fact_ref); // fact_ref 原样保留

    // 反向对照：不带快照时，缓存与表同源（都来自被抄改的图）⇒ 这一层检查放行。
    expect(runExport(tampered).audits[0]!.numlit_matches_table).toBe(true);
    // 带上真实快照 ⇒ 逐点回算到事实，抓到"图形 999 / 来源写 8"的谎言。
    expectDocxError(
      () => runExport(tampered, { snapshot: snapshotOf([8, 4, 2]) }),
      'unsupported_chart_data',
    );
  });

  it('图绑 REV1、快照是 REV2 ⇒ 导出被拒（版本过期）；不带快照则放行', () => {
    const chart = boundChart([8, 4, 2]);
    expect(runExport(chart).audits).toHaveLength(1);
    expectDocxError(
      () => runExport(chart, { snapshot: snapshotOf([8, 4, 2], REV2) }),
      'unsupported_chart_data',
    );
  });

  it('无快照 ⇒ 事实一致性如实写 null（不谎报"已核对"），事实版本仍记录在案', () => {
    const chart = boundChart([8, 4, 2]);
    const audit = runExport(chart).audits[0] as ChartArtifactAudit;
    expect(audit.fact_agreement).toBeNull();
    expect(audit.fact_version).toEqual({ task_id: TASK, task_revision: REV1 });
  });

  it('未绑定事实版本的图（无快照）：fact_version 为 null，缓存/表核对仍执行', () => {
    const literal = buildChart({
      chart_id: 'chart-w07-literal',
      chart_type: 'column',
      title: '字面量图',
      categories: CATEGORIES,
      series: [
        {
          name: '系列',
          points: CATEGORIES.map((category, index) => ({
            category,
            value: index + 1,
            fact_ref: asFactRef(`fact-${String(index)}`),
            fact_key: KEYS[index] as string,
          })),
        },
      ],
      source: 'imported',
    });
    if (!literal.ok) throw new Error(literal.message);
    const audit = runExport(literal.value).audits[0] as ChartArtifactAudit;
    expect(audit.fact_version).toBeNull();
    expect(audit.fact_agreement).toBeNull();
    expect(audit.numlit_matches_table).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §D 审计记录只在成功产出后放出（不记录"没写成的图"）
// ---------------------------------------------------------------------------

describe('§D 审计记录的边界', () => {
  it('导出被拒（图形指向的关系与所给图表 id 不符）⇒ 一条审计记录都不放出', () => {
    // 段落里的图形引用 `rId900`，但本批图表挂在 `rId901` 上：rId900 没有落点，
    // 主部件渲染在图表已materialize之后才失败 —— 审计回调在 writeZip 之后才触发，因此一条都不该放出。
    const audits: ChartArtifactAudit[] = [];
    let thrown: unknown = null;
    try {
      exportDocx(chartModel('rId900'), {
        charts: [{ part_index: 1, definition: boundChart([8, 4, 2]), relationship_id: 'rId901' }],
        on_chart_artifact: (record) => audits.push(record),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_chart_part');
    expect(audits).toEqual([]);
  });

  it('不传 charts ⇒ 回调不触发，包里没有 word/charts（R151 不回归）', () => {
    const audits: ChartArtifactAudit[] = [];
    const plain = createDocumentModel({
      document_id: 'chart-w07-noop',
      blocks: [
        paragraphNode({ source: 'user_request', inlines: [runNode({ text: '正文', source: 'user_request' })] }),
      ],
    });
    const model: DocumentModel = { ...corpusModel(), blocks: plain.blocks, sections: [] };
    const without = exportDocx(model, { on_chart_artifact: (record) => audits.push(record) });
    expect(audits).toEqual([]);
    expect(readZip(without).entries.some((entry) => entry.path.startsWith('word/charts/'))).toBe(false);
    // 不传 charts 与传空数组：逐字节相同（新默认路径没有副作用）。
    expect(Array.from(exportDocx(model, { charts: [] }))).toEqual(Array.from(without));
  });
});
