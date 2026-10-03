/**
 * P-I16 · **单一 `dc1-*` 事实指纹**（把 P06 的 `dataVersionOf` 接到 `fact-sync` 的版本快照上）。
 *
 * ## 这一批钉死什么
 *
 * P06 交付了 `dataVersionOf()`（`dc1-*` FNV-1a 指纹）作为"图 / 内嵌工作簿 / 表字面量同版"的
 * 现成指纹；P10 要求会话**消费**它、不要另造哈希。本批把 `fact-sync` 的
 * `VersionedFactSnapshot` 接上它：{@link factDataVersionOf} = 数值事实的规范图表投影的
 * `dataVersionOf`。于是判"三处是不是同一版"只比**一枚** `dc1-*`：
 *
 * - **正文** = 事实引用 run（`fact` 键）——它的值由快照求值，坐标即快照指纹；
 * - **表格** = 绑定的单元格字面量——与 `tableMirrorFromChartData` 的表镜同指纹；
 * - **图表 / 内嵌工作簿** = 嵌入数据 / 工作簿格——与 `dataVersionOf` / `workbookVersionOf` 同指纹。
 *
 * 判据走**独立来源**：
 * - `dc1-*` 在**本文件里**用 `dataVersionOf`（P06 的公开入口）从投影重算，不读待测字段自证；
 * - 表侧用 `tableFactVersionOf` 从**表字面量反解**（P-I08 的独立读数）复算；
 * - 工作簿侧用 `workbookVersionOf` 从 `WorkbookCell[]` 反解复算；
 * - 三处数值直接读**模型字段**（文本框文本、单元格文本、图表 `series.values`），不经 `verify`。
 *
 * ## 一次改动只移动一枚指纹
 *
 * `set_fact_value`（本层 {@link setFactValue}）发一个新版本：正文 / 表格 / 图表都刷到新值，
 * 且三处复算出的 `dc1-*` **只有一枚**、与原版不同；`undo` / `redo` 把坐标**逐字**带回原处
 * （坐标随历史快照保存，见 `undo-history.currentPresentationDataVersion`）。
 *
 * ## 未验证边界（如实登记）
 *
 * 手机关闭重开 / 目标软件打开是否弹修复提示、渲染后的观感是否一致——需**消费端**（真机 /
 * Office），本文件**不**验证，只到模型层 + 指纹层。
 */

import { describe, expect, it } from 'vitest';

import {
  FACT_DATA_SERIES_NAME,
  applyFactVersion,
  asFactSnapshot,
  bodyText,
  chartFromFacts,
  factCell,
  factChartData,
  factDataVersionOf,
  factTextBody,
  parseNumericLiteral,
  setFactValue,
  syncPresentationFacts,
  versionedSnapshot,
  type FactBindings,
  type VersionedFactEntry,
  type VersionedFactSnapshot,
} from '../../../../src/presentations/fact-sync.js';
import type { Presentation, Shape } from '../../../../src/presentations/model.js';
import { transform } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import {
  dataVersionOf,
  tableFactVersionOf,
  tableMirrorFromChartData,
  workbookCellsFromChartData,
  workbookVersionOf,
  type ExpectedChartData,
} from '../../../../src/presentations/table-chart-parts/index.js';
import {
  commitPresentationEdit,
  createPresentationHistory,
  currentPresentation,
  currentPresentationDataVersion,
  redoPresentationHistory,
  undoPresentationHistory,
} from '../../../../src/presentations/undo-history.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const TASK = 'quarterly-deck';
const R1 = { task_id: TASK, task_revision: 1 } as const;
const R2 = { task_id: TASK, task_revision: 2 } as const;

function numericEntry(factKey: string, amount: number, revision: number): VersionedFactEntry {
  return {
    fact_key: factKey,
    fact_ref: `fact.${factKey}.r${String(revision)}`,
    value: { type: 'number', amount, unit: '人', currency: null },
  };
}

const V1: VersionedFactSnapshot = versionedSnapshot(R1, [numericEntry('headcount', 8, 1), numericEntry('headcount.planned', 10, 1)]);
/** 改一条事实（人数 8 → 12）：`set_fact_value` 的纯函数底座，版本号 +1。 */
const V2: VersionedFactSnapshot = setFactValue(V1, 'headcount', { type: 'number', amount: 12, unit: '人', currency: null });

/** 从模型里读图表嵌入数据（与 `ExpectedChartData` 同形）。 */
function chartDataOf(presentation: Presentation): ExpectedChartData {
  for (const slide of presentation.slides) {
    for (const shape of slide.shapes) {
      if (shape.kind === 'chart') {
        return {
          categories: [...shape.chart.categories],
          series: shape.chart.series.map((series) => ({ name: series.name, values: [...series.values] })),
        };
      }
    }
  }
  throw new Error('夹具里没有图表形状');
}

function shapeOfKind(presentation: Presentation, kind: Shape['kind']): Shape {
  for (const slide of presentation.slides) {
    for (const shape of slide.shapes) {
      if (shape.kind === kind) return shape;
    }
  }
  throw new Error(`夹具里没有 ${kind} 形状`);
}

/** 正文事实引用求值（渲染口径）。 */
function textFactText(presentation: Presentation, snapshot: VersionedFactSnapshot): string {
  const shape = shapeOfKind(presentation, 'text_box');
  if (shape.kind !== 'text_box') throw new Error('不是文本框');
  return bodyText(shape.text, asFactSnapshot(snapshot));
}

/** 表格绑定格的数值（读字面量，不经 verify）。 */
function tableLiteralValue(presentation: Presentation): number | null {
  const shape = shapeOfKind(presentation, 'table');
  if (shape.kind !== 'table') throw new Error('不是表格');
  const cell = shape.rows[0]?.cells[0];
  if (cell === undefined || cell.text === null) return null;
  return parseNumericLiteral(bodyText(cell.text, []));
}

/** 图表第一个系列的第一个点（headcount 在字典序里排第一）。 */
function chartFirstPoint(presentation: Presentation): number | undefined {
  return chartDataOf(presentation).series[0]?.values[0];
}

/**
 * 由**一份事实快照**生成一页演示：正文事实引用 + 绑定事实的表格字面量 + 由事实装配的图表。
 * 三处都只接事实键 / 同一份快照，调用方没有机会"另编一个数"。
 */
function deckFromFacts(snapshot: VersionedFactSnapshot): { presentation: Presentation; bindings: FactBindings } {
  const projection = factChartData(snapshot);
  const factKeys = [...projection.categories];

  let presentation = emptyPresentation('p1', '同版事实演示');
  const added = addSlide(presentation);
  presentation = added.presentation;
  const slideId = added.slide_id;

  presentation = addShape(presentation, slideId, {
    kind: 'text_box',
    shape_id: 2,
    name: '正文',
    transform: transform(0, 0, 4000000, 1000000),
    text: factTextBody('headcount'),
  });
  presentation = addShape(presentation, slideId, {
    kind: 'table',
    shape_id: 3,
    name: '表格',
    transform: transform(0, 2000000, 4000000, 1000000),
    rows: [{ cells: [factCell('headcount', snapshot)] }],
    column_widths_emu: [4000000],
  });
  presentation = addShape(presentation, slideId, {
    kind: 'chart',
    shape_id: 4,
    name: '图表',
    transform: transform(0, 3000000, 4000000, 2000000),
    chart: chartFromFacts({
      chart_type: 'bar',
      title: null,
      categories: factKeys,
      series: [{ name: FACT_DATA_SERIES_NAME, fact_keys: factKeys }],
      snapshot,
    }),
  });

  return {
    presentation,
    bindings: {
      chart: [{ shape_id: 4, series: [{ name: FACT_DATA_SERIES_NAME, fact_keys: factKeys }] }],
      table: [{ shape_id: 3, cells: [{ row: 0, column: 0, fact_key: 'headcount' }] }],
    },
  };
}

// ---------------------------------------------------------------------------
// A. dc1-* 就是那一枚单一事实指纹
// ---------------------------------------------------------------------------

describe('A. 快照的 dc1-* = 规范图表投影的 dataVersionOf（不另造哈希）', () => {
  it('data_version 形如 dc1-xxxxxxxx，且 = factDataVersionOf = dataVersionOf(投影)', () => {
    expect(V1.data_version).toMatch(/^dc1-[0-9a-f]{8}$/);
    expect(factDataVersionOf(V1)).toBe(V1.data_version);
    expect(dataVersionOf(factChartData(V1))).toBe(V1.data_version);
  });

  it('正文 / 表格 / 图表 / 内嵌工作簿 四处复算出的 dc1-* 只有一枚', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    // 图：从模型嵌入数据重算。
    const chartDc1 = dataVersionOf(chartDataOf(presentation));
    // 表：从表字面量反解重算（P-I08 的独立读数）。
    const tableDc1 = tableFactVersionOf(tableMirrorFromChartData(factChartData(V1)));
    // 内嵌工作簿：从 WorkbookCell[] 反解重算。
    const workbookDc1 = workbookVersionOf(workbookCellsFromChartData(factChartData(V1)));

    expect(new Set([chartDc1, tableDc1, workbookDc1, V1.data_version]).size).toBe(1);

    const report = syncPresentationFacts({ presentation, target: V1, bindings });
    expect(report.ok).toBe(true);
    expect(report.data_version).toBe(V1.data_version);
  });

  it('换条目登记顺序不改指纹（按字典序规范化）；改一个值必改指纹', () => {
    const reordered = versionedSnapshot(R1, [numericEntry('headcount.planned', 10, 1), numericEntry('headcount', 8, 1)]);
    expect(reordered.data_version).toBe(V1.data_version);

    expect(V2.data_version).not.toBe(V1.data_version);
    expect(V2.version.task_revision).toBe(R2.task_revision);
  });
});

// ---------------------------------------------------------------------------
// B. 一次 set_fact_value 移动三处，且三处只移动一枚 dc1
// ---------------------------------------------------------------------------

describe('B. set_fact_value 把正文 / 表格 / 图表刷到新值，三处同版（一枚不变更外的 dc1）', () => {
  it('人数 8 → 12：三处数值都=12，三处复算指纹都=新快照的 dc1', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    expect(syncPresentationFacts({ presentation, target: V1, bindings }).ok).toBe(true);

    const updated = applyFactVersion({ presentation, target: V2, bindings });

    // 三处数值（直接读模型字段）。
    expect(textFactText(updated, V2)).toContain('12');
    expect(tableLiteralValue(updated)).toBe(12);
    expect(chartFirstPoint(updated)).toBe(12);

    // 三处复算出的 dc1 只有一枚，且 = 新快照指纹（图直接重算；表 / 工作簿从新投影反解）。
    const chartDc1 = dataVersionOf(chartDataOf(updated));
    const tableDc1 = tableFactVersionOf(tableMirrorFromChartData(factChartData(V2)));
    const workbookDc1 = workbookVersionOf(workbookCellsFromChartData(factChartData(V2)));
    expect(new Set([chartDc1, tableDc1, workbookDc1, V2.data_version]).size).toBe(1);
    expect(chartDc1).not.toBe(V1.data_version);

    // 目标快照对账：ok、无冲突、坐标是 V2 的那一枚。
    const report = syncPresentationFacts({ presentation: updated, target: V2, bindings, history: [V1] });
    expect(report.conflicts).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.data_version).toBe(V2.data_version);
    const headcountUsages = report.usages.filter((usage) => usage.fact_key === 'headcount');
    expect(headcountUsages).toHaveLength(3);
    expect(new Set(headcountUsages.map((usage) => usage.value))).toEqual(new Set([12]));
    expect(new Set(headcountUsages.map((usage) => usage.role))).toEqual(new Set(['text', 'table', 'chart']));
  });

  it('反向：图 / 表没跟上（还是旧值）⇒ 具名冲突，且报告坐标仍是目标的 dc1', () => {
    const { presentation, bindings } = deckFromFacts(V1); // 三处都是 8 / 10
    const report = syncPresentationFacts({ presentation, target: V2, bindings, history: [V1] });

    expect(report.ok).toBe(false);
    expect(report.data_version).toBe(V2.data_version);
    expect(report.conflicts.map((conflict) => conflict.kind)).toContain('stale_fact_version');
    expect(report.conflicts.every((conflict) => conflict.stale_version?.task_revision === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. undo / redo 逐字还原事实坐标
// ---------------------------------------------------------------------------

describe('C. undo / redo 把三处同版坐标逐字带回原处', () => {
  it('提交 set_fact_value（带 V2 坐标）→ undo 回 V1 坐标与旧值 → redo 回 V2 坐标与新值', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    const history0 = createPresentationHistory(presentation, 'init', V1.data_version);
    expect(currentPresentationDataVersion(history0)).toBe(V1.data_version);

    const outcome = commitPresentationEdit(
      history0,
      'set_fact_value(headcount)',
      (draft) => applyFactVersion({ presentation: draft, target: V2, bindings }),
      { data_version: V2.data_version },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const history1 = outcome.history;

    // 提交后：坐标 = V2，三处 = 12。
    expect(currentPresentationDataVersion(history1)).toBe(V2.data_version);
    const after = currentPresentation(history1);
    expect(textFactText(after, V2)).toContain('12');
    expect(tableLiteralValue(after)).toBe(12);
    expect(chartFirstPoint(after)).toBe(12);

    // 撤销：坐标逐字回到 V1，三处回 8。
    const undone = undoPresentationHistory(history1);
    expect(currentPresentationDataVersion(undone)).toBe(V1.data_version);
    const before = currentPresentation(undone);
    expect(textFactText(before, V1)).toContain('8');
    expect(tableLiteralValue(before)).toBe(8);
    expect(chartFirstPoint(before)).toBe(8);

    // 重做：坐标再回 V2，三处再回 12。
    const redone = redoPresentationHistory(undone);
    expect(currentPresentationDataVersion(redone)).toBe(V2.data_version);
    const again = currentPresentation(redone);
    expect(tableLiteralValue(again)).toBe(12);
    expect(chartFirstPoint(again)).toBe(12);
  });

  it('失败保旧：改写抛错时历史与事实坐标一字不动（引用相等）', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    const history0 = createPresentationHistory(presentation, 'init', V1.data_version);
    const failed = commitPresentationEdit(
      history0,
      'set_fact_value(boom)',
      () => {
        throw new Error('改写失败');
      },
      { data_version: V2.data_version },
    );
    expect(failed.ok).toBe(false);
    expect(failed.history).toBe(history0);
    expect(currentPresentationDataVersion(failed.history)).toBe(V1.data_version);
    // 未接入事实的历史：坐标为 null。
    expect(currentPresentationDataVersion(createPresentationHistory(presentation))).toBeNull();
    void bindings;
  });
});

// ---------------------------------------------------------------------------
// D. 未验证边界如实登记
// ---------------------------------------------------------------------------

describe('D. 如实边界：本层只到模型层 + 指纹层', () => {
  it('dc1-* 只宣称"模型层同版"，未验证清单仍随报告带出（不因指纹就绪而升级为通过）', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    const report = syncPresentationFacts({ presentation, target: V1, bindings });
    expect(report.ok).toBe(true);
    expect(report.unverified.length).toBeGreaterThan(0);
    for (const claim of report.unverified) {
      expect(claim.status).toBe('unverified');
      expect(claim.detail.length).toBeGreaterThan(0);
    }
  });
});
