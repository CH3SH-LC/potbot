/**
 * **PPTX 同版事实同步交付适配器**的定向用例（工作包 FA-PPT-FACTS-PRODUCT）。
 *
 * 每条产品纪律都配一条**反向对照**（"看起来通过"的两种可能里，另一种必须被抓出来）：
 *
 * | 正向 | 反向对照 |
 * |---|---|
 * | 三处同版事实 ⇒ 一致性报告 `ok` | **图表用了旧版事实 ⇒ `stale_fact_version` 冲突、交付被阻断** |
 * | 值不属于任何历史版本 ⇒ `value_mismatch` | **不得被误认成"某版旧值"** |
 * | 改事实（8→10）只重写表格 / 图表页 | **无关页被重写 ⇒ `unrelated_slide_rewritten`** |
 * | 改事实后受影响页确实被重写 | **受影响页没被重写 ⇒ `affected_slide_not_rewritten`** |
 * | 有事实来源 ⇒ 产出可编辑 PPTX（+ PDF） | **无事实来源 ⇒ 结构化未就绪，不编数字、不出字节** |
 * | 交付的 PPTX 读得回才算数 | **图表包导入层读不回 ⇒ 结构化 `invariant_violated`（不假装可交付）** |
 *
 * **真机 / Office 打开未验证**：本文件全部是内存内的模型层与字节层用例，未在任何真机或
 * Office 消费端打开过产物；相关断言按"未验证"如实标注（见
 * `PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS`）。
 *
 * **子智能体模型身份未确认为 DS**。
 */

import { describe, expect, it } from 'vitest';

import {
  EXPORT_INVARIANTS,
  addShape,
  addSlide,
  chartFromFacts,
  emptyPresentation,
  factCell,
  factTextBody,
  insertChart,
  literalText,
  reopenEditablePptx,
  setShapeText,
  transform,
  versionedSnapshot,
  type FactBindings,
  type Presentation,
  type Shape,
  type TableCell,
  type VersionedFactSnapshot,
} from '../../presentations/index.js';

import {
  FACTS_UNBLOCKED_BY,
  auditFactVersionUpdate,
  boundShapeIdList,
  checkPptxFactConsistency,
  deliverPptxFacts,
  factPresentationSource,
  pptxFactDeliverableAdapter,
  pptxFactSource,
} from './pptx-facts.js';

// ---------------------------------------------------------------------------
// 固定装置（确定性：无墙钟、无随机、无 IO）
// ---------------------------------------------------------------------------

const TASK = 'task-quarterly';
const HEADCOUNT = 'headcount';
const BUDGET = 'budget.total';

const TEXT_SHAPE_ID = 10;
const TABLE_SHAPE_ID = 20;
const CHART_SHAPE_ID = 30;
const THANKS_SHAPE_ID = 40;

const BOX = transform(457200, 274638, 8229600, 1143000);
const FRAME = transform(838200, 457200, 6096000, 4064000);

function snapshot(revision: number, headcount: number, budget: number): VersionedFactSnapshot {
  return versionedSnapshot(
    { task_id: TASK, task_revision: revision },
    [
      {
        fact_key: HEADCOUNT,
        fact_ref: `${TASK}-headcount-r${String(revision)}`,
        value: { type: 'number', amount: headcount, unit: '人', currency: null },
      },
      {
        fact_key: BUDGET,
        fact_ref: `${TASK}-budget-r${String(revision)}`,
        value: { type: 'number', amount: budget, unit: '元', currency: null },
      },
    ],
  );
}

/** r1：人数 8；r2：人数 10（预算不变）。 */
const R1 = snapshot(1, 8, 50000);
const R2 = snapshot(2, 10, 50000);

/** 图表（shape 30）系列 "人数" 第 1 点 = headcount；表格（shape 20）r0c1 = headcount。 */
const CHART_BINDING = { shape_id: CHART_SHAPE_ID, series: [{ name: '人数', fact_keys: [HEADCOUNT] }] } as const;

const TABLE_CELLS: FactBindings['table'] = [
  { shape_id: TABLE_SHAPE_ID, cells: [{ row: 0, column: 1, fact_key: HEADCOUNT }] },
];

/** 绑定（图表 + 表格）：模型层一致性 / 审计用例。 */
const BINDINGS: FactBindings = { chart: [CHART_BINDING], table: TABLE_CELLS };

/** 绑定（只表格）：交付 / 导入用例（图表包导入层读不回，见文末边界用例）。 */
const TABLE_ONLY_BINDINGS: FactBindings = { table: TABLE_CELLS };

/** 生成侧绑定：表格两格都真绑事实（供"三处同版"的生成用例）。 */
const GENERATED_BINDINGS: FactBindings = {
  chart: [CHART_BINDING],
  table: [
    {
      shape_id: TABLE_SHAPE_ID,
      cells: [
        { row: 0, column: 1, fact_key: HEADCOUNT },
        { row: 0, column: 2, fact_key: BUDGET },
      ],
    },
  ],
};

/** 原始 JSON 形态的绑定（模拟从模型层翻译来、尚未校验的编辑载荷）。 */
const RAW_TABLE_ONLY_BINDINGS = {
  table: [{ shape_id: TABLE_SHAPE_ID, cells: [{ row: 0, column: 1, fact_key: HEADCOUNT }] }],
};

interface Deck {
  readonly presentation: Presentation;
  readonly textSlideId: number;
  readonly tableSlideId: number;
  /** `-1` = 本次没建图表页。 */
  readonly chartSlideId: number;
  readonly unrelatedSlideId: number;
}

function textBox(shapeId: number, text: ReturnType<typeof factTextBody>): Shape {
  return { kind: 'text_box', shape_id: shapeId, name: `Box ${String(shapeId)}`, transform: BOX, text };
}

/**
 * 造一份演示：
 * 1 正文（`fact` 引用）／2 表格（绑定单元格，值由参数给）／[3 图表（嵌入数据，值由参数给）]／
 * 最后一页**无关页**（纯字面量：无事实引用、无绑定对象）。
 *
 * `shape_id` 全局唯一：绑定按 `shape_id` 定位，跨页重号会撞车（模型里 `shape_id` 只在页内唯一）。
 */
function buildDeck(headcountLiteral: number, options?: { readonly withChart?: boolean }): Deck {
  const withChart = options?.withChart ?? true;
  let presentation = emptyPresentation('deck-ppt-facts', '季度汇报');

  const textSlide = addSlide(presentation);
  presentation = textSlide.presentation;
  presentation = addShape(presentation, textSlide.slide_id, textBox(TEXT_SHAPE_ID, factTextBody(HEADCOUNT)));

  const tableSlide = addSlide(presentation);
  presentation = tableSlide.presentation;
  presentation = addShape(presentation, tableSlide.slide_id, {
    kind: 'table',
    shape_id: TABLE_SHAPE_ID,
    name: '人数表',
    transform: FRAME,
    rows: [
      {
        cells: [
          { text: literalText('人数'), col_span: 1, row_span: 1 },
          { text: literalText(String(headcountLiteral)), col_span: 1, row_span: 1 },
          { text: literalText('50000'), col_span: 1, row_span: 1 },
        ],
      },
    ],
    column_widths_emu: [914400, 914400, 914400],
  });

  let chartSlideId = -1;
  if (withChart) {
    const chartSlide = addSlide(presentation);
    presentation = chartSlide.presentation;
    const charted = insertChart(presentation, chartSlide.slide_id, {
      shape_id: CHART_SHAPE_ID,
      name: '人数图',
      transform: FRAME,
      chart: {
        chart_type: 'bar',
        categories: ['人数'],
        series: [{ name: '人数', values: [headcountLiteral] }],
        title: null,
      },
    });
    presentation = charted.presentation;
    chartSlideId = chartSlide.slide_id;
  }

  const unrelatedSlide = addSlide(presentation);
  presentation = unrelatedSlide.presentation;
  presentation = addShape(
    presentation,
    unrelatedSlide.slide_id,
    textBox(THANKS_SHAPE_ID, literalText('谢谢观看')),
  );

  return {
    presentation,
    textSlideId: textSlide.slide_id,
    tableSlideId: tableSlide.slide_id,
    chartSlideId,
    unrelatedSlideId: unrelatedSlide.slide_id,
  };
}

/**
 * 造一份**只由事实键装配**的三页演示（正文 / 表格 / 图表都只接事实键）：
 * 调用方**没有机会**另编一个数——这正是"三处同版"在生成侧的形态。
 */
function buildGeneratedDeck(facts: VersionedFactSnapshot): Deck {
  let presentation = emptyPresentation('deck-generated', '同版事实生成');

  const textSlide = addSlide(presentation);
  presentation = textSlide.presentation;
  presentation = addShape(presentation, textSlide.slide_id, textBox(TEXT_SHAPE_ID, factTextBody(HEADCOUNT)));

  const tableSlide = addSlide(presentation);
  presentation = tableSlide.presentation;
  const header: TableCell = { text: literalText('人数'), col_span: 1, row_span: 1 };
  presentation = addShape(presentation, tableSlide.slide_id, {
    kind: 'table',
    shape_id: TABLE_SHAPE_ID,
    name: '事实表',
    transform: FRAME,
    rows: [{ cells: [header, factCell(HEADCOUNT, facts), factCell(BUDGET, facts)] }],
    column_widths_emu: [914400, 914400, 914400],
  });

  const chartSlide = addSlide(presentation);
  presentation = chartSlide.presentation;
  const charted = insertChart(presentation, chartSlide.slide_id, {
    shape_id: CHART_SHAPE_ID,
    name: '事实图',
    transform: FRAME,
    chart: chartFromFacts({
      chart_type: 'bar',
      title: null,
      categories: ['人数'],
      series: [{ name: '人数', fact_keys: [HEADCOUNT] }],
      snapshot: facts,
    }),
  });
  presentation = charted.presentation;

  return {
    presentation,
    textSlideId: textSlide.slide_id,
    tableSlideId: tableSlide.slide_id,
    chartSlideId: chartSlide.slide_id,
    unrelatedSlideId: -1,
  };
}

/** 从字节导入成源（适配器的 `importBytes` 在接口上是可选的，这里显式要求它存在）。 */
function importViaAdapter(bytes: Uint8Array): ReturnType<typeof factPresentationSource> {
  const read = pptxFactDeliverableAdapter.importBytes;
  if (read === undefined) throw new Error('本适配器应当提供 importBytes');
  const imported = read(bytes);
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(imported.detail);
  return imported.source;
}

/** 把图表的嵌入数据改成指定值（模拟"图表没跟着事实更新"）。 */
function withChartValues(deck: Deck, values: readonly number[]): Presentation {
  return {
    ...deck.presentation,
    slides: deck.presentation.slides.map((slide) =>
      slide.slide_id === deck.chartSlideId
        ? {
            ...slide,
            shapes: slide.shapes.map((shape) =>
              shape.shape_id === CHART_SHAPE_ID && shape.kind === 'chart'
                ? { ...shape, chart: { ...shape.chart, series: [{ name: '人数', values }] } }
                : shape,
            ),
          }
        : slide,
    ),
  };
}

// ---------------------------------------------------------------------------
// 一、同版事实（正向：三处同版 ⇒ ok；反向：混版 ⇒ 冲突且阻断交付）
// ---------------------------------------------------------------------------

describe('同版事实：三处数值必须来自同一事实版本', () => {
  it('由事实键装配的正文 / 表格 / 图表 ⇒ 一致性报告 ok，三处都被计入', () => {
    const deck = buildGeneratedDeck(R2);
    const source = factPresentationSource(
      deck.presentation,
      pptxFactSource(R2, { history: [R1], bindings: GENERATED_BINDINGS }),
    );

    const check = checkPptxFactConsistency(source);
    expect(check.status).toBe('checked');
    if (check.status !== 'checked') return;

    expect(check.report.ok).toBe(true);
    expect(check.report.conflicts).toEqual([]);
    // 三处（正文 / 表格两格 / 图表）都被计入，且都指回同一条事实。
    expect(check.report.counts.text).toBe(1);
    expect(check.report.counts.table).toBe(2);
    expect(check.report.counts.chart).toBe(1);
    expect(new Set(check.report.usages.map((usage) => usage.fact_key))).toEqual(new Set([HEADCOUNT, BUDGET]));
    expect(check.report.usages.every((usage) => usage.version.task_revision === 2)).toBe(true);
  });

  it('反向对照①：图表仍嵌着旧版事实（8）而正文 / 表格用新版（10）⇒ stale_fact_version，且交付被阻断', () => {
    const deck = buildDeck(10); // 表格已是 10，仅把图表改回旧版的 8
    const source = factPresentationSource(
      withChartValues(deck, [8]),
      pptxFactSource(R2, { history: [R1], bindings: BINDINGS }),
    );

    const check = checkPptxFactConsistency(source);
    expect(check.status).toBe('checked');
    if (check.status !== 'checked') return;

    const stale = check.report.conflicts.filter((conflict) => conflict.kind === 'stale_fact_version');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.fact_key).toBe(HEADCOUNT);
    expect(stale[0]?.values).toEqual([8, 10]);
    expect(stale[0]?.stale_version?.task_revision).toBe(1);
    expect(check.report.ok).toBe(false);

    // **不得静默取其一**：冲突时交付直接被阻断，不产出任何字节。
    const delivery = deliverPptxFacts(source);
    expect(delivery.status).toBe('blocked');
    if (delivery.status !== 'blocked') return;
    expect(delivery.kind).toBe('fact_conflict');
    expect(delivery.report.ok).toBe(false);
    expect(delivery.detail).toContain('stale_fact_version');
  });

  it('反向对照①（补）：值不属于任何历史版本 ⇒ value_mismatch（同样是冲突，同样阻断）', () => {
    const deck = buildDeck(10);
    // 历史里只有 r1=8 与 r2=10，99 无处可认 ⇒ value_mismatch，**不得**当成"某版旧值"。
    const source = factPresentationSource(
      withChartValues(deck, [99]),
      pptxFactSource(R2, { history: [R1], bindings: BINDINGS }),
    );

    const check = checkPptxFactConsistency(source);
    expect(check.status).toBe('checked');
    if (check.status !== 'checked') return;

    const kinds = check.report.conflicts.map((conflict) => conflict.kind);
    expect(kinds).toContain('value_mismatch');
    expect(kinds).not.toContain('stale_fact_version');
    expect(deliverPptxFacts(source).status).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// 二、改事实后：只更新受影响处，无关页不重写
// ---------------------------------------------------------------------------

describe('改事实（人数 8 → 10）：只更新受影响处', () => {
  /** 从 r1 的源应用 apply_fact_version 到 r2。 */
  function applyToR2(): { deck: Deck; after: Presentation } {
    const deck = buildDeck(8);
    const source = factPresentationSource(deck.presentation, pptxFactSource(R1, { bindings: BINDINGS }));
    const edit = pptxFactDeliverableAdapter.applyEdit(source, { op: 'apply_fact_version', target: R2 });
    expect(edit.ok).toBe(true);
    if (!edit.ok) throw new Error(edit.detail);
    return { deck, after: edit.source.presentation };
  }

  it('正向：表格页与图表页被重写，正文页只换求值（模型不动），无关页逐字节不动', () => {
    const { deck, after } = applyToR2();
    const audit = auditFactVersionUpdate({
      before: deck.presentation,
      after,
      previous: R1,
      next: R2,
      bindings: BINDINGS,
    });

    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    // 表格 / 图表：字面量与嵌入数据被重写。
    expect([...audit.rewrite_expected_slide_ids].sort()).toEqual([deck.tableSlideId, deck.chartSlideId].sort());
    expect([...audit.rewritten_slide_ids].sort()).toEqual([deck.tableSlideId, deck.chartSlideId].sort());
    // 正文：`fact` 引用随快照求值 ⇒ 交付文字变了，但模型没动（不是"被重写"）。
    expect(audit.text_affected_slide_ids).toEqual([deck.textSlideId]);
    expect(audit.rewritten_slide_ids).not.toContain(deck.textSlideId);
    // 无关页：明确不动。
    expect(audit.unrelated_slide_ids).toEqual([deck.unrelatedSlideId]);
    expect(audit.unchanged_slide_ids).toContain(deck.unrelatedSlideId);

    // 重写后三处确实同版：再对账一次应当无冲突。
    const check = checkPptxFactConsistency(
      factPresentationSource(after, pptxFactSource(R2, { history: [R1], bindings: BINDINGS })),
    );
    expect(check.status).toBe('checked');
    if (check.status !== 'checked') return;
    expect(check.report.ok).toBe(true);
  });

  it('反向对照③：无关页被重写 ⇒ unrelated_slide_rewritten', () => {
    const { deck, after } = applyToR2();
    // 实现"多改了一页"：把无关页（致谢页）的文本也改了。
    const doctored = setShapeText(after, deck.unrelatedSlideId, THANKS_SHAPE_ID, literalText('谢谢观看，下次见'));

    const audit = auditFactVersionUpdate({
      before: deck.presentation,
      after: doctored,
      previous: R1,
      next: R2,
      bindings: BINDINGS,
    });
    expect(audit.ok).toBe(false);
    const violation = audit.violations.find((candidate) => candidate.code === 'unrelated_slide_rewritten');
    expect(violation).toBeDefined();
    expect(violation?.slide_id).toBe(deck.unrelatedSlideId);
    expect(audit.rewritten_slide_ids).toContain(deck.unrelatedSlideId);
  });

  it('反向对照②：受影响页没被重写 ⇒ affected_slide_not_rewritten', () => {
    const deck = buildDeck(8);
    const audit = auditFactVersionUpdate({
      before: deck.presentation,
      after: deck.presentation, // 实现"一步没动"
      previous: R1,
      next: R2,
      bindings: BINDINGS,
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.filter((violation) => violation.code === 'affected_slide_not_rewritten')).toHaveLength(2);
    expect(audit.violations.map((violation) => violation.slide_id).sort()).toEqual(
      [deck.tableSlideId, deck.chartSlideId].sort(),
    );
  });

  it('同一版本重放 ⇒ 幂等空转（changed: false，不再产生新版本）', () => {
    const deck = buildDeck(10, { withChart: false });
    const source = factPresentationSource(deck.presentation, pptxFactSource(R2, { bindings: TABLE_ONLY_BINDINGS }));

    const first = pptxFactDeliverableAdapter.applyEdit(source, { op: 'apply_fact_version', target: R2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 首次会把非规范字面量（"10"）改写成规范渲染（"10 人"）⇒ 确实动过。
    expect(first.changed).toBe(true);

    const second = pptxFactDeliverableAdapter.applyEdit(first.source, { op: 'apply_fact_version', target: R2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(false);
    expect(second.source.presentation).toEqual(first.source.presentation);
  });
});

// ---------------------------------------------------------------------------
// 三、交付：可编辑 PPTX + 一致性报告；PDF 不替代 PPTX
// ---------------------------------------------------------------------------

describe('交付：可编辑 PPTX 与结构化一致性报告同时产出', () => {
  /** 可交付的源：正文 + 表格 + 无关页（3 页；不含图表，见文末边界用例）。 */
  function deliverableSource(): { deck: Deck; source: ReturnType<typeof factPresentationSource> } {
    const deck = buildDeck(10, { withChart: false });
    return {
      deck,
      source: factPresentationSource(
        deck.presentation,
        pptxFactSource(R2, { history: [R1], bindings: TABLE_ONLY_BINDINGS }),
      ),
    };
  }

  it('正向：want_pdf ⇒ PDF 与可编辑 PPTX 同时在，页数一致，PPTX 读得回', () => {
    const { source } = deliverableSource();
    const delivery = deliverPptxFacts(source, { want_pdf: true });
    expect(delivery.status).toBe('delivered');
    if (delivery.status !== 'delivered') return;

    expect(delivery.report.ok).toBe(true);
    expect(delivery.editable_pptx.editable).toBe(true);
    expect(delivery.editable_pptx.bytes.length).toBeGreaterThan(0);
    expect(delivery.editable_pptx.slide_count).toBe(3);
    expect(delivery.pdf).not.toBeNull();
    expect(delivery.pdf?.page_count).toBe(delivery.editable_pptx.slide_count);
    // 不变式是从 export-handoff 原样带出的那一份（不另造）。
    expect(delivery.invariants).toEqual(EXPORT_INVARIANTS);
    // 未验证清单如实随结果带出。
    expect(delivery.unverified.length).toBeGreaterThan(0);
    expect(delivery.unverified.every((claim) => claim.status === 'unverified')).toBe(true);

    // "还能改"的可判定形式：把交付的 PPTX 读回成模型。
    const reopened = reopenEditablePptx(delivery.editable_pptx.bytes);
    expect(reopened.openable).toBe(true);
    expect(reopened.editable).toBe(true);
    expect(reopened.slide_count).toBe(3);
  });

  it('正向（无 PDF）：可编辑 PPTX 与预览照常产出，pdf 为 null', () => {
    const { source } = deliverableSource();
    const delivery = deliverPptxFacts(source);
    expect(delivery.status).toBe('delivered');
    if (delivery.status !== 'delivered') return;
    expect(delivery.pdf).toBeNull();
    expect(delivery.preview.slide_count).toBe(3);
    expect(reopenEditablePptx(delivery.editable_pptx.bytes).openable).toBe(true);
  });

  it('适配器的 exportBytes / importBytes 与交付一致（导入的源事实来源未知 ⇒ null）', () => {
    const { source } = deliverableSource();
    const exported = pptxFactDeliverableAdapter.exportBytes(source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const importedSource = importViaAdapter(exported.bytes);
    expect(importedSource.imported).not.toBeNull();
    // 导入只拿到模型与整包：事实来源**未知**（null），不是"空快照"。
    expect(importedSource.facts).toBeNull();
    expect(checkPptxFactConsistency(importedSource).status).toBe('not_ready');
  });

  it('导入的既有演示：装配事实来源后可交付 PPTX（逐部件保留通道），但要 PDF 被结构化拒绝', () => {
    const { source } = deliverableSource();
    const exported = pptxFactDeliverableAdapter.exportBytes(source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const importedSource = importViaAdapter(exported.bytes);

    const attached = pptxFactDeliverableAdapter.applyEdit(importedSource, {
      op: 'attach_facts',
      target: R2,
      history: [R1],
      bindings: RAW_TABLE_ONLY_BINDINGS,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const delivery = deliverPptxFacts(attached.source);
    expect(delivery.status).toBe('delivered');
    if (delivery.status !== 'delivered') return;
    expect(delivery.editable_pptx.slide_count).toBe(3);
    expect(reopenEditablePptx(delivery.editable_pptx.bytes).openable).toBe(true);

    // PDF 走"整模型重建"渲染，与逐部件保留是两次渲染 ⇒ 结构化拒绝，不产出一份不匹配的 PDF。
    const withPdf = deliverPptxFacts(attached.source, { want_pdf: true });
    expect(withPdf.status).toBe('not_ready');
    if (withPdf.status !== 'not_ready') return;
    expect(withPdf.kind).toBe('pdf_requires_rebuildable_source');
    expect(withPdf.report?.ok).toBe(true);
  });

  it('边界（如实登记）：带图表的演示一致性成立，但"可编辑交付"链未打通 ⇒ invariant_violated', () => {
    // 图表在渲染层能写出，但导入层不建模 p:graphicFrame 的图表 ⇒ 读不回 ⇒ 不算可交付。
    const deck = buildDeck(10);
    const source = factPresentationSource(deck.presentation, pptxFactSource(R2, { bindings: BINDINGS }));
    expect(checkPptxFactConsistency(source)).toMatchObject({ status: 'checked' });

    const delivery = deliverPptxFacts(source);
    expect(delivery.status).toBe('not_ready');
    if (delivery.status !== 'not_ready') return;
    expect(delivery.kind).toBe('invariant_violated');
    expect(delivery.detail).toContain('读不回');
    expect(delivery.detail).toContain('图表');
    // 阻断的是**交付**，不是一致性判定：报告仍然在，且是干净的。
    expect(delivery.report?.ok).toBe(true);
  });

  it('describe 是纯读法：页数、来源与事实版本各归各的', () => {
    const deck = buildDeck(10);
    const withFacts = pptxFactDeliverableAdapter.describe(
      factPresentationSource(deck.presentation, pptxFactSource(R2, { bindings: BINDINGS })),
    );
    expect(withFacts).toContain('4 页');
    expect(withFacts).toContain('新建');
    expect(withFacts).toContain(`${TASK}@r2`);

    const withoutFacts = pptxFactDeliverableAdapter.describe(factPresentationSource(deck.presentation, null));
    expect(withoutFacts).toContain('事实来源缺失');
  });
});

// ---------------------------------------------------------------------------
// 四、未就绪：缺事实来源 ⇒ 结构化未就绪，不编数字（R248）
// ---------------------------------------------------------------------------

describe('未就绪：缺事实来源一律结构化未就绪，不编数字', () => {
  it('反向对照④：无事实来源 ⇒ 检查 / 交付 / 导出 / 改版本四条路都结构化未就绪，且不产出字节', () => {
    const deck = buildDeck(8, { withChart: false });
    const source = factPresentationSource(deck.presentation, null);

    const check = checkPptxFactConsistency(source);
    expect(check.status).toBe('not_ready');
    if (check.status !== 'not_ready') return;
    expect(check.kind).toBe('fact_source_missing');
    expect(check.unblocked_by).toBe(FACTS_UNBLOCKED_BY);

    const delivery = deliverPptxFacts(source, { want_pdf: true });
    expect(delivery.status).toBe('not_ready');
    if (delivery.status !== 'not_ready') return;
    expect(delivery.kind).toBe('fact_source_missing');
    // 没有报告可报（不编一份"看起来干净"的空报告）。
    expect(delivery.report).toBeNull();

    const exported = pptxFactDeliverableAdapter.exportBytes(source);
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.kind).toBe('not_ready');
    expect(exported.detail).toContain('事实来源缺失');

    const edit = pptxFactDeliverableAdapter.applyEdit(source, { op: 'apply_fact_version', target: R2 });
    expect(edit.ok).toBe(false);
    if (edit.ok) return;
    expect(edit.kind).toBe('fact_source_missing');
  });

  it('正向：attach_facts 装配后同一条链立刻可用（可用是显式的，不是凭空生效）', () => {
    const deck = buildDeck(10, { withChart: false });
    const source = factPresentationSource(deck.presentation, null);
    const attached = pptxFactDeliverableAdapter.applyEdit(source, {
      op: 'attach_facts',
      target: R2,
      history: [R1],
      bindings: RAW_TABLE_ONLY_BINDINGS,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.changed).toBe(true);
    expect(checkPptxFactConsistency(attached.source).status).toBe('checked');
    expect(deliverPptxFacts(attached.source).status).toBe('delivered');
  });

  it('装配载荷形状非法 ⇒ 结构化失败（不猜、不兜底）', () => {
    const deck = buildDeck(10, { withChart: false });
    const source = factPresentationSource(deck.presentation, null);

    const missingVersion = pptxFactDeliverableAdapter.applyEdit(source, {
      op: 'attach_facts',
      target: { entries: [] },
    });
    expect(missingVersion.ok).toBe(false);

    const duplicateKey = pptxFactDeliverableAdapter.applyEdit(source, {
      op: 'attach_facts',
      target: {
        version: { task_id: TASK, task_revision: 3 },
        entries: [
          { fact_key: HEADCOUNT, fact_ref: 'a', value: { type: 'number', amount: 8, unit: '人', currency: null } },
          { fact_key: HEADCOUNT, fact_ref: 'b', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        ],
      },
    });
    expect(duplicateKey.ok).toBe(false);
    if (duplicateKey.ok) return;
    expect(duplicateKey.kind).toBe('invalid_value');

    const badOp = pptxFactDeliverableAdapter.applyEdit(source, { op: 'delete_all_facts' });
    expect(badOp.ok).toBe(false);
    if (badOp.ok) return;
    expect(badOp.kind).toBe('unsupported_op');
  });
});

// ---------------------------------------------------------------------------
// 五、辅助面（供上层核对，不参与判定）
// ---------------------------------------------------------------------------

describe('辅助面', () => {
  it('boundShapeIdList 列出全部被绑定的形状 id（升序、去重）', () => {
    expect(boundShapeIdList(BINDINGS)).toEqual([TABLE_SHAPE_ID, CHART_SHAPE_ID].sort((a, b) => a - b));
  });

  it('交付结果同时带出上游不变式与未验证清单（本批无消费端 / 真机 ⇒ 未验证）', () => {
    const deck = buildDeck(10, { withChart: false });
    const delivery = deliverPptxFacts(
      factPresentationSource(deck.presentation, pptxFactSource(R2, { bindings: TABLE_ONLY_BINDINGS })),
    );
    expect(delivery.status).toBe('delivered');
    if (delivery.status !== 'delivered') return;
    expect(delivery.invariants.some((line) => line.includes('不以 PDF 替代 PPTX'))).toBe(true);
    expect(delivery.unverified.some((claim) => claim.claim.includes('真机'))).toBe(true);
    // 一致性判据的口径原文随报告带出（供上游如实转述）。
    expect(delivery.report.consistency_scope.length).toBeGreaterThan(0);
  });
});
