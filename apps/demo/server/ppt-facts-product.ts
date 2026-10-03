/**
 * **PPT 同版事实交付的产品 HTTP 入口**（工作包 FA-PPT-FACTS-PRODUCT2；PPT-16 的**产品面**）。
 *
 * ## 这个文件解决什么
 *
 * `src/session/adapters/pptx-facts.ts` 已把"同版事实"的判定与改写落地，但它此前**只有单元测试
 * 消费者**：产品 HTTP 面上没有任何一条路径能让"给定事实快照 + 模板 ⇒ 产出 PPTX + 一致性报告"
 * 真正发生。本文件就是那条路径（`/api/ppt-facts/**`）。
 *
 * | 产品能力 | 复用（**只调用、不重造**） |
 * |---|---|
 * | 交付（可编辑 PPTX + 结构化一致性报告 + 真跑读回） | `deliverPptxFacts` / `deliveryInvariantProblems` / `reopenEditablePptx` |
 * | 同版判定（三处数值同一版） | `syncPresentationFacts`（经 `checkPptxFactConsistency`） |
 * | 改事实（8 → 10：只更新受影响处） | `applyFactVersion` + `auditFactVersionUpdate` |
 * | 由事实键装配模型（正文 / 表格 / 图表） | `factTextBody` / `factCell` / `chartFromFacts` |
 * | 导出不变式（**PDF 不得替代 PPTX**） | `EXPORT_INVARIANTS`（原样带出，不另造第二套） |
 *
 * ## 四条纪律（每条都配反向对照，见 `ppt-facts-product.test.ts`）
 *
 * 1. **同版约束**：正文 / 表格 / 图表三处数值必须来自同一事实版本。不同版 ⇒
 *    `POST /deliver` **在出字节之前**返回 409 `ppt_facts_conflict`，响应里**没有任何字节**
 *    （`editable_pptx` 字段不存在），**绝不**静默取其一。
 * 2. **只更新受影响处**：`POST /apply-facts` 走真实改写并**同时**返回
 *    `auditFactVersionUpdate` 的对账（该改的改了没、无关页动了没）。
 * 3. **模板不给形状就绑不上**：绑定（bindings）由模板**自派生**（表格列 / 图表系列声明了
 *    `fact_key` 就自动绑定到该 `shape_id`），调用方**无法**把绑定挂到"另一个形状"上；
 *    需要显式覆盖时才走 `bindings`（测试与高级用法）。
 * 4. **缺事实来源不得编数字**（R248）：`facts` 缺失 ⇒ 结构化未就绪，**不渲染、不产出字节**；
 *    写死的数字既非目标版本、也不属于任何已知历史版本 ⇒ `value_mismatch` 冲突 ⇒ 阻断。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **真机 / Office 打开未验证**：本路由只做模型层与字节层判定 + 一次真实的可编辑读回
 *   （`reopenEditablePptx`）。产物"在真机上打开无修复提示"一律标未验证，
 *   随每份交付结果原样带出（`PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS`）。
 * - **带图表的演示无法通过"可编辑读回"**：导入层不建模 `p:graphicFrame` 图表
 *   （见 `src/presentations/import.ts`），因此图表源的交付出结构化
 *   `invariant_violated`（422），本路由**不**把"导入层读不回的包"当成可交付。
 *   图表的一致性判定（模型层）仍然成立。
 * - **带图表 / 导入源的 PDF 交付结构化拒绝**（`pdf_requires_rebuildable_source` / 重建渲染通道），
 *   如实返回原因，不产出一份"看起来对"的 PDF。
 * - 本路由**零 IO、零墙钟、零随机数**：纯函数 + 请求体，不落盘、不起第二份账本。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { KnownFactValue } from '../../../src/protocol/index.js';
import {
  applyFactVersion,
  chartFromFacts,
  emptyPresentation,
  factCell,
  factTextBody,
  insertChart,
  literalText,
  addShape,
  addSlide,
  syncPresentationFacts,
  transform,
  versionedSnapshot,
  type ChartFactBinding,
  type FactBindings,
  type Presentation,
  type Shape,
  type TableCell,
  type TableFactBinding,
  type TextBody,
  type VersionedFactSnapshot,
} from '../../../src/presentations/index.js';
import {
  EXPORT_INVARIANTS,
  reopenEditablePptx,
  type ReopenResult,
} from '../../../src/presentations/export-handoff.js';
import {
  FACTS_UNBLOCKED_BY,
  PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
  auditFactVersionUpdate,
  checkPptxFactConsistency,
  deliverPptxFacts,
  describeFactConflicts,
  factPresentationSource,
  pptxFactSource,
  type FactUpdateAudit,
  type FactUpdateViolation,
  type PptxFactDelivery,
  type PptxFactDeliveryOptions,
} from '../../../src/session/adapters/pptx-facts.js';

// ---------------------------------------------------------------------------
// 路由根与常量
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` 只按这个前缀转交（与其它独立路由前缀互不重叠）。 */
export const PPT_FACTS_ROOT = '/api/ppt-facts';

/** 一次请求体的字节上限（模板 + 事实快照 + 绑定；远超即 413）。 */
export const MAX_PPT_FACTS_BODY_BYTES = 4 * 1024 * 1024;

/** 本路由暴露的四条路径（自证清单，供 `/status` 原样带出）。 */
export const PPT_FACTS_ROUTES: readonly string[] = Object.freeze([
  'GET  /api/ppt-facts/status',
  'POST /api/ppt-facts/deliver',
  'POST /api/ppt-facts/apply-facts',
  'POST /api/ppt-facts/audit',
]);

/** 单元格 / 正文文本框的形状 id 从 90 万起分配：模板自带的 shape_id 必须小于它。 */
const TITLE_SHAPE_BASE = 900_000;
/** 模板自带（表格 / 图表）shape_id 的上界。 */
const TEMPLATE_SHAPE_ID_MAX = 899_999;

const BOX = transform(457200, 274638, 8229600, 1143000);
const FRAME = transform(838200, 457200, 6096000, 4064000);
const COLUMN_WIDTH_EMU = 914400;

// ---------------------------------------------------------------------------
// 响应形状与 HTTP 工具（自足；不 import http.ts 的私有实现，避免耦合）
// ---------------------------------------------------------------------------

export interface PptxFactsWireResponse {
  readonly status: number;
  readonly body: unknown;
}

function ok(body: unknown): PptxFactsWireResponse {
  return Object.freeze({ status: 200, body });
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): PptxFactsWireResponse {
  return Object.freeze({
    status,
    body: Object.freeze({ code, message, retryable: false, ...(extra ?? {}) }),
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// 严格读取（读不出就结构化 400，不猜、不折中）
// ---------------------------------------------------------------------------

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(raw: unknown, what: string): Read<string> {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, detail: `${what} 必须是非空字符串` };
  return { ok: true, value: raw };
}

/** 读一个已知事实值（number / date / text）；读不出即失败（不把缺失折成 0 / 空串）。 */
function readKnownFactValue(raw: unknown): Read<KnownFactValue> {
  if (!isRecord(raw)) return { ok: false, detail: 'value 必须是对象' };
  switch (raw['type']) {
    case 'number': {
      const amount = raw['amount'];
      const unit = raw['unit'];
      const currency = raw['currency'];
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        return { ok: false, detail: 'number 事实的 amount 必须是有限数' };
      }
      if (typeof unit !== 'string' || unit.length === 0) {
        return { ok: false, detail: 'number 事实必须带非空 unit' };
      }
      if (currency !== undefined && currency !== null && (typeof currency !== 'string' || currency.length === 0)) {
        return { ok: false, detail: 'number 事实的 currency 必须是非空字符串或 null' };
      }
      return {
        ok: true,
        value: Object.freeze({
          type: 'number' as const,
          amount,
          unit,
          currency: currency === undefined ? null : (currency as string | null),
        }),
      };
    }
    case 'date': {
      const isoDate = raw['iso_date'];
      const timeZone = raw['time_zone'];
      if (typeof isoDate !== 'string' || isoDate.length === 0) return { ok: false, detail: 'date 事实缺少 iso_date' };
      if (typeof timeZone !== 'string' || timeZone.length === 0) return { ok: false, detail: 'date 事实缺少 time_zone' };
      return { ok: true, value: Object.freeze({ type: 'date' as const, iso_date: isoDate, time_zone: timeZone }) };
    }
    case 'text': {
      const text = raw['text'];
      const source = raw['source'];
      if (typeof text !== 'string' || text.length === 0) return { ok: false, detail: 'text 事实缺少 text' };
      if (typeof source !== 'string' || source.length === 0) return { ok: false, detail: 'text 事实缺少 source' };
      return { ok: true, value: Object.freeze({ type: 'text' as const, text, source }) };
    }
    default:
      return { ok: false, detail: 'value.type 必须是 number / date / text 之一' };
  }
}

/**
 * 读一份版本化事实快照。
 *
 * 形状问题一律**读失败**；"同一键两条"由 `versionedSnapshot` 抛 `duplicate_fact_key`，
 * 此处转成结构化原因——"同一键两条 ⇒ 用哪一条"正是本入口要消灭的隐式选择。
 */
export function readVersionedSnapshot(raw: unknown): Read<VersionedFactSnapshot> {
  if (!isRecord(raw)) return { ok: false, detail: '事实版本必须是一个对象' };
  const versionRaw = raw['version'];
  if (!isRecord(versionRaw)) return { ok: false, detail: '事实版本缺少 version { task_id, task_revision }' };
  const taskId = readNonEmptyString(versionRaw['task_id'], 'version.task_id');
  if (!taskId.ok) return { ok: false, detail: taskId.detail };
  const revision = versionRaw['task_revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return { ok: false, detail: 'version.task_revision 必须是非负整数' };
  }
  const entriesRaw = raw['entries'];
  if (!Array.isArray(entriesRaw)) return { ok: false, detail: '事实版本缺少 entries 数组' };

  const entries: { fact_key: string; fact_ref: string; value: KnownFactValue }[] = [];
  for (const itemRaw of entriesRaw) {
    if (!isRecord(itemRaw)) return { ok: false, detail: '事实条目必须是对象' };
    const factKey = readNonEmptyString(itemRaw['fact_key'], '事实条目的 fact_key');
    if (!factKey.ok) return { ok: false, detail: factKey.detail };
    const factRef = readNonEmptyString(itemRaw['fact_ref'], `事实 ${factKey.value} 的 fact_ref`);
    if (!factRef.ok) return { ok: false, detail: factRef.detail };
    const value = readKnownFactValue(itemRaw['value']);
    if (!value.ok) return { ok: false, detail: `事实 ${factKey.value} 的 ${value.detail}` };
    entries.push({ fact_key: factKey.value, fact_ref: factRef.value, value: value.value });
  }

  try {
    return { ok: true, value: versionedSnapshot({ task_id: taskId.value, task_revision: revision }, entries) };
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 模板（受约束的封闭枚举：页的种类就是这四种）
// ---------------------------------------------------------------------------

/** 表格列：`heading` 是表头字面量，`fact_key` 是该列的值要绑到的事实。 */
export interface PptxTableColumnSpec {
  readonly heading: string;
  readonly fact_key: string;
}

export interface PptxChartSeriesSpec {
  readonly name: string;
  readonly fact_keys: readonly string[];
}

/**
 * 一种页的规格（封闭枚举）。
 *
 * - `literal`：**无关页**——纯字面量，无事实引用、无绑定对象（重写它就是违规）；
 * - `fact_text`：正文带 `fact` 引用（换快照即换数字，模型不动）；
 * - `table`：两行表格（表头 + 事实值行），值由 `fact_key` 经 `factCell` 装配；
 * - `chart`：图表嵌入数据由 `fact_keys` 经 `chartFromFacts` 装配。
 */
export type PptxSlideSpec =
  | { readonly kind: 'literal'; readonly title: string; readonly text: string }
  | { readonly kind: 'fact_text'; readonly title: string; readonly fact_key: string }
  | {
      readonly kind: 'table';
      readonly title: string;
      readonly shape_id: number;
      readonly columns: readonly PptxTableColumnSpec[];
    }
  | {
      readonly kind: 'chart';
      readonly title: string;
      readonly shape_id: number;
      readonly chart_type: 'bar' | 'line' | 'pie';
      readonly categories: readonly string[];
      readonly series: readonly PptxChartSeriesSpec[];
    };

/** 一份演示模板（页数**由模板决定**，本入口不设固定页数）。 */
export interface PptxDeckTemplateSpec {
  readonly presentation_id: string;
  readonly title: string;
  readonly slides: readonly PptxSlideSpec[];
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

function readShapeId(raw: unknown, what: string): Read<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > TEMPLATE_SHAPE_ID_MAX) {
    return { ok: false, detail: `${what} 必须是 1..${String(TEMPLATE_SHAPE_ID_MAX)} 的整数（绑定按它定位，必须由模板自带）` };
  }
  return { ok: true, value: raw };
}

function readSlideSpec(raw: unknown, index: number): Read<PptxSlideSpec> {
  if (!isRecord(raw)) return { ok: false, detail: `第 ${String(index + 1)} 页规格必须是对象` };
  const kind = raw['kind'];
  const title = raw['title'];
  if (typeof title !== 'string') return { ok: false, detail: `第 ${String(index + 1)} 页缺少字符串 title` };
  switch (kind) {
    case 'literal': {
      const text = raw['text'];
      if (typeof text !== 'string') return { ok: false, detail: `第 ${String(index + 1)} 页（literal）缺少字符串 text` };
      return { ok: true, value: Object.freeze({ kind: 'literal' as const, title, text }) };
    }
    case 'fact_text': {
      const factKey = readNonEmptyString(raw['fact_key'], `第 ${String(index + 1)} 页（fact_text）的 fact_key`);
      if (!factKey.ok) return { ok: false, detail: factKey.detail };
      return { ok: true, value: Object.freeze({ kind: 'fact_text' as const, title, fact_key: factKey.value }) };
    }
    case 'table': {
      const shapeId = readShapeId(raw['shape_id'], `第 ${String(index + 1)} 页（table）的 shape_id`);
      if (!shapeId.ok) return { ok: false, detail: shapeId.detail };
      const columnsRaw = raw['columns'];
      if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
        return { ok: false, detail: `第 ${String(index + 1)} 页（table）的 columns 必须是非空数组` };
      }
      const columns: PptxTableColumnSpec[] = [];
      for (const columnRaw of columnsRaw) {
        if (!isRecord(columnRaw)) return { ok: false, detail: `第 ${String(index + 1)} 页的表格列必须是对象` };
        const heading = columnRaw['heading'];
        if (typeof heading !== 'string') return { ok: false, detail: `第 ${String(index + 1)} 页的表格列 heading 必须是字符串` };
        const factKey = readNonEmptyString(columnRaw['fact_key'], `第 ${String(index + 1)} 页的表格列 fact_key`);
        if (!factKey.ok) return { ok: false, detail: factKey.detail };
        columns.push(Object.freeze({ heading, fact_key: factKey.value }));
      }
      return { ok: true, value: Object.freeze({ kind: 'table' as const, title, shape_id: shapeId.value, columns: Object.freeze(columns) }) };
    }
    case 'chart': {
      const shapeId = readShapeId(raw['shape_id'], `第 ${String(index + 1)} 页（chart）的 shape_id`);
      if (!shapeId.ok) return { ok: false, detail: shapeId.detail };
      const chartType = raw['chart_type'];
      if (chartType !== 'bar' && chartType !== 'line' && chartType !== 'pie') {
        return { ok: false, detail: `第 ${String(index + 1)} 页（chart）的 chart_type 必须是 bar / line / pie` };
      }
      const categories = raw['categories'];
      if (!isNonEmptyStringArray(categories)) {
        return { ok: false, detail: `第 ${String(index + 1)} 页（chart）的 categories 必须是非空字符串数组` };
      }
      const seriesRaw = raw['series'];
      if (!Array.isArray(seriesRaw) || seriesRaw.length === 0) {
        return { ok: false, detail: `第 ${String(index + 1)} 页（chart）的 series 必须是非空数组` };
      }
      const series: PptxChartSeriesSpec[] = [];
      for (const seriesItemRaw of seriesRaw) {
        if (!isRecord(seriesItemRaw)) return { ok: false, detail: `第 ${String(index + 1)} 页的图表系列必须是对象` };
        const name = seriesItemRaw['name'];
        if (typeof name !== 'string' || name.length === 0) {
          return { ok: false, detail: `第 ${String(index + 1)} 页的图表系列缺少非空 name` };
        }
        const factKeys = seriesItemRaw['fact_keys'];
        if (!isNonEmptyStringArray(factKeys)) {
          return { ok: false, detail: `第 ${String(index + 1)} 页的图表系列 ${name} 的 fact_keys 必须是非空字符串数组` };
        }
        series.push(Object.freeze({ name, fact_keys: Object.freeze([...factKeys]) }));
      }
      return {
        ok: true,
        value: Object.freeze({
          kind: 'chart' as const,
          title,
          shape_id: shapeId.value,
          chart_type: chartType,
          categories: Object.freeze([...categories]),
          series: Object.freeze(series),
        }),
      };
    }
    default:
      return { ok: false, detail: `第 ${String(index + 1)} 页的 kind 必须是 literal / fact_text / table / chart` };
  }
}

/** 读一份模板；`presentation_id` / `title` 可缺省（给确定性默认，不猜内容）。 */
export function readDeckTemplate(raw: unknown): Read<PptxDeckTemplateSpec> {
  if (!isRecord(raw)) return { ok: false, detail: 'template 必须是一个对象' };
  const presentationIdRaw = raw['presentation_id'];
  const presentationId =
    presentationIdRaw === undefined ? 'ppt-facts-deck' : typeof presentationIdRaw === 'string' && presentationIdRaw.length > 0 ? presentationIdRaw : null;
  if (presentationId === null) return { ok: false, detail: 'template.presentation_id 必须是非空字符串' };
  const titleRaw = raw['title'];
  const title = titleRaw === undefined ? '同版事实演示' : typeof titleRaw === 'string' ? titleRaw : null;
  if (title === null) return { ok: false, detail: 'template.title 必须是字符串' };

  const slidesRaw = raw['slides'];
  if (!Array.isArray(slidesRaw) || slidesRaw.length === 0) {
    return { ok: false, detail: 'template.slides 必须是非空数组（页数由模板决定，本入口不设固定页数）' };
  }
  const slides: PptxSlideSpec[] = [];
  const seenShapeIds = new Set<number>();
  for (const [index, slideRaw] of slidesRaw.entries()) {
    const slide = readSlideSpec(slideRaw, index);
    if (!slide.ok) return { ok: false, detail: slide.detail };
    const shapeId = 'shape_id' in slide.value ? slide.value.shape_id : null;
    if (shapeId !== null) {
      if (seenShapeIds.has(shapeId)) {
        return { ok: false, detail: `shape_id=${String(shapeId)} 在模板里出现两次：绑定按它定位，重号会让"绑到哪个形状"变成隐式选择` };
      }
      seenShapeIds.add(shapeId);
    }
    slides.push(slide.value);
  }
  return {
    ok: true,
    value: Object.freeze({ presentation_id: presentationId, title, slides: Object.freeze(slides) }),
  };
}

/** 从模板**自派生**绑定：表格列 / 图表系列声明了 `fact_key` 就绑定到该 `shape_id`。 */
export function bindingsOfTemplate(template: PptxDeckTemplateSpec): FactBindings {
  const chart: ChartFactBinding[] = [];
  const table: TableFactBinding[] = [];
  for (const slide of template.slides) {
    if (slide.kind === 'table') {
      table.push(
        Object.freeze({
          shape_id: slide.shape_id,
          cells: Object.freeze(
            slide.columns.map((column, columnIndex) =>
              Object.freeze({ row: 1, column: columnIndex, fact_key: column.fact_key }),
            ),
          ),
        }),
      );
    }
    if (slide.kind === 'chart') {
      chart.push(
        Object.freeze({
          shape_id: slide.shape_id,
          series: Object.freeze(
            slide.series.map((series) =>
              Object.freeze({ name: series.name, fact_keys: Object.freeze([...series.fact_keys]) }),
            ),
          ),
        }),
      );
    }
  }
  return Object.freeze({
    ...(chart.length > 0 ? { chart: Object.freeze(chart) } : {}),
    ...(table.length > 0 ? { table: Object.freeze(table) } : {}),
  });
}

// ---------------------------------------------------------------------------
// 由模板装配演示模型（值一律来自给定的事实版本，调用方不给数字）
// ---------------------------------------------------------------------------

export interface BuiltDeck {
  readonly presentation: Presentation;
  readonly bindings: FactBindings;
}

/**
 * 按模板装配一份演示：表格值经 `factCell`、图表嵌入数据经 `chartFromFacts`，**全部**取自 `at`。
 *
 * 因此装配出来的模型与 `at` 这一版**必然**同版（调用方没有任何机会另编一个数）。
 * 缺事实键 / 数值常量纲冲突等 ⇒ 结构化失败（`factCell` / `chartFromFacts` 抛的领域错误）。
 */
export function buildDeck(template: PptxDeckTemplateSpec, at: VersionedFactSnapshot): Read<BuiltDeck> {
  try {
    let presentation = emptyPresentation(template.presentation_id, template.title);
    for (const [index, slide] of template.slides.entries()) {
      const added = addSlide(presentation);
      presentation = added.presentation;
      const slideId = added.slide_id;
      presentation = addShape(presentation, slideId, {
        kind: 'text_box',
        shape_id: TITLE_SHAPE_BASE + index,
        name: '标题',
        transform: BOX,
        text: literalText(slide.title),
      });
      switch (slide.kind) {
        case 'literal':
          presentation = addShape(presentation, slideId, {
            kind: 'text_box',
            shape_id: TITLE_SHAPE_BASE + 500_000 + index,
            name: '正文',
            transform: FRAME,
            text: literalText(slide.text),
          });
          break;
        case 'fact_text':
          presentation = addShape(presentation, slideId, {
            kind: 'text_box',
            shape_id: TITLE_SHAPE_BASE + 500_000 + index,
            name: '事实正文',
            transform: FRAME,
            text: factTextBody(slide.fact_key),
          });
          break;
        case 'table': {
          const heading: TableCell[] = slide.columns.map((column) =>
            Object.freeze({ text: literalText(column.heading), col_span: 1, row_span: 1 }),
          );
          const values: TableCell[] = slide.columns.map((column) => factCell(column.fact_key, at));
          const shape: Shape = {
            kind: 'table',
            shape_id: slide.shape_id,
            name: `表 ${String(slide.shape_id)}`,
            transform: FRAME,
            rows: [Object.freeze({ cells: Object.freeze(heading) }), Object.freeze({ cells: Object.freeze(values) })],
            column_widths_emu: slide.columns.map(() => COLUMN_WIDTH_EMU),
          };
          presentation = addShape(presentation, slideId, shape);
          break;
        }
        case 'chart': {
          const charted = insertChart(presentation, slideId, {
            shape_id: slide.shape_id,
            name: `图 ${String(slide.shape_id)}`,
            transform: FRAME,
            chart: chartFromFacts({
              chart_type: slide.chart_type,
              title: null,
              categories: slide.categories,
              series: slide.series.map((series) => ({ name: series.name, fact_keys: series.fact_keys })),
              snapshot: at,
            }),
          });
          presentation = charted.presentation;
          break;
        }
      }
    }
    return { ok: true, value: Object.freeze({ presentation, bindings: bindingsOfTemplate(template) }) };
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// 序列化（字节一律 base64；不把 Buffer 塞进 JSON）
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function serializeReport(report: ReturnType<typeof syncPresentationFacts>): Record<string, unknown> {
  return {
    ok: report.ok,
    version: report.version,
    conflicts: report.conflicts,
    counts: report.counts,
    consistency_scope: report.consistency_scope,
    unverified: report.unverified,
    usage_count: report.usages.length,
    usages: report.usages,
  };
}

function serializeAudit(audit: FactUpdateAudit): Record<string, unknown> {
  return {
    ok: audit.ok,
    text_affected_slide_ids: audit.text_affected_slide_ids,
    rewrite_expected_slide_ids: audit.rewrite_expected_slide_ids,
    rewritten_slide_ids: audit.rewritten_slide_ids,
    unchanged_slide_ids: audit.unchanged_slide_ids,
    unrelated_slide_ids: audit.unrelated_slide_ids,
    violations: audit.violations.map((violation: FactUpdateViolation) => ({
      code: violation.code,
      slide_id: violation.slide_id,
      detail: violation.detail,
    })),
  };
}

function serializeReadback(readback: ReopenResult): Record<string, unknown> {
  return {
    openable: readback.openable,
    editable: readback.editable,
    slide_count: readback.slide_count,
    problems: readback.problems,
  };
}

function slideIdsOf(presentation: Presentation): readonly number[] {
  return presentation.slides.map((slide) => slide.slide_id);
}

/** 交付结果的 JSON 形态（`delivered` 才带字节；其余分支**一个字节都没有**）。 */
function serializeDelivery(delivery: PptxFactDelivery, includeBytes: boolean): Record<string, unknown> {
  switch (delivery.status) {
    case 'delivered': {
      const readback = reopenEditablePptx(delivery.editable_pptx.bytes);
      return {
        status: 'delivered',
        editable_pptx: {
          slide_count: delivery.editable_pptx.slide_count,
          entry_count: delivery.editable_pptx.entry_count,
          content_digest: delivery.editable_pptx.content_digest,
          editable: delivery.editable_pptx.editable,
          byte_length: delivery.editable_pptx.bytes.byteLength,
          ...(includeBytes ? { base64: bytesToBase64(delivery.editable_pptx.bytes) } : {}),
        },
        pdf:
          delivery.pdf === null
            ? null
            : {
                page_count: delivery.pdf.page_count,
                byte_length: delivery.pdf.byte_length,
                fidelity: delivery.pdf.fidelity,
                font_embedding: delivery.pdf.font_embedding,
                visual_fidelity_verified: delivery.pdf.visual_fidelity_verified,
                note: delivery.pdf.note,
                ...(includeBytes ? { base64: bytesToBase64(delivery.pdf.bytes) } : {}),
              },
        report: serializeReport(delivery.report),
        preview: delivery.preview,
        invariants: delivery.invariants,
        readback: serializeReadback(readback),
        unverified: delivery.unverified,
      };
    }
    case 'blocked':
      return {
        status: 'blocked',
        kind: delivery.kind,
        detail: delivery.detail,
        report: serializeReport(delivery.report),
        bytes_emitted: 0,
        unverified: delivery.unverified,
      };
    default:
      return {
        status: 'not_ready',
        kind: delivery.kind,
        detail: delivery.detail,
        unblocked_by: delivery.unblocked_by,
        report: delivery.report === null ? null : serializeReport(delivery.report),
        bytes_emitted: 0,
        unverified: delivery.unverified,
      };
  }
}

// ---------------------------------------------------------------------------
// 各端点的实现
// ---------------------------------------------------------------------------

function readFactsBlock(raw: unknown): Read<{
  readonly target: VersionedFactSnapshot;
  readonly history: readonly VersionedFactSnapshot[];
  readonly bindings: FactBindings | null;
}> {
  if (!isRecord(raw)) return { ok: false, detail: 'facts 必须是一个对象' };
  const target = readVersionedSnapshot(raw['target']);
  if (!target.ok) return { ok: false, detail: `facts.target 非法：${target.detail}` };
  const historyRaw = raw['history'];
  const history: VersionedFactSnapshot[] = [];
  if (historyRaw !== undefined) {
    if (!Array.isArray(historyRaw)) return { ok: false, detail: 'facts.history 必须是事实版本数组' };
    for (const item of historyRaw) {
      const read = readVersionedSnapshot(item);
      if (!read.ok) return { ok: false, detail: `facts.history 里的版本非法：${read.detail}` };
      history.push(read.value);
    }
  }
  const bindingsRaw = raw['bindings'];
  let bindings: FactBindings | null = null;
  if (bindingsRaw !== undefined) {
    const read = readBindingsOverride(bindingsRaw);
    if (!read.ok) return { ok: false, detail: read.detail };
    bindings = read.value;
  }
  return { ok: true, value: { target: target.value, history: Object.freeze(history), bindings } };
}

/** 读显式绑定覆盖（形状与 `pptx-facts.ts` 的 `readBindings` 一致；缺省不用它）。 */
function readBindingsOverride(raw: unknown): Read<FactBindings> {
  if (!isRecord(raw)) return { ok: false, detail: 'bindings 必须是对象' };
  const chartRaw = raw['chart'];
  const tableRaw = raw['table'];
  const chart: ChartFactBinding[] = [];
  const table: TableFactBinding[] = [];
  if (chartRaw !== undefined) {
    if (!Array.isArray(chartRaw)) return { ok: false, detail: 'bindings.chart 必须是数组' };
    for (const bindingRaw of chartRaw) {
      if (!isRecord(bindingRaw)) return { ok: false, detail: 'bindings.chart 的元素必须是对象' };
      const shapeId = readShapeId(bindingRaw['shape_id'], 'bindings.chart[].shape_id');
      if (!shapeId.ok) return { ok: false, detail: shapeId.detail };
      const seriesRaw = bindingRaw['series'];
      if (!Array.isArray(seriesRaw)) return { ok: false, detail: 'bindings.chart[].series 必须是数组' };
      const series: { name: string; fact_keys: readonly string[] }[] = [];
      for (const seriesItemRaw of seriesRaw) {
        if (!isRecord(seriesItemRaw)) return { ok: false, detail: '图表系列绑定必须是对象' };
        const name = seriesItemRaw['name'];
        if (typeof name !== 'string') return { ok: false, detail: '图表系列绑定缺少字符串 name' };
        const factKeys = seriesItemRaw['fact_keys'];
        if (!Array.isArray(factKeys) || factKeys.some((item) => typeof item !== 'string')) {
          return { ok: false, detail: '图表系列绑定的 fact_keys 必须是字符串数组' };
        }
        series.push(Object.freeze({ name, fact_keys: Object.freeze(factKeys as string[]) }));
      }
      chart.push(Object.freeze({ shape_id: shapeId.value, series: Object.freeze(series) }));
    }
  }
  if (tableRaw !== undefined) {
    if (!Array.isArray(tableRaw)) return { ok: false, detail: 'bindings.table 必须是数组' };
    for (const bindingRaw of tableRaw) {
      if (!isRecord(bindingRaw)) return { ok: false, detail: 'bindings.table 的元素必须是对象' };
      const shapeId = readShapeId(bindingRaw['shape_id'], 'bindings.table[].shape_id');
      if (!shapeId.ok) return { ok: false, detail: shapeId.detail };
      const cellsRaw = bindingRaw['cells'];
      if (!Array.isArray(cellsRaw)) return { ok: false, detail: 'bindings.table[].cells 必须是数组' };
      const cells: { row: number; column: number; fact_key: string }[] = [];
      for (const cellRaw of cellsRaw) {
        if (!isRecord(cellRaw)) return { ok: false, detail: '表格单元格绑定必须是对象' };
        const row = cellRaw['row'];
        const column = cellRaw['column'];
        const factKey = readNonEmptyString(cellRaw['fact_key'], '表格单元格绑定的 fact_key');
        if (typeof row !== 'number' || !Number.isInteger(row) || row < 0) {
          return { ok: false, detail: '表格单元格绑定的 row 必须是 ≥0 的整数' };
        }
        if (typeof column !== 'number' || !Number.isInteger(column) || column < 0) {
          return { ok: false, detail: '表格单元格绑定的 column 必须是 ≥0 的整数' };
        }
        if (!factKey.ok) return { ok: false, detail: factKey.detail };
        cells.push(Object.freeze({ row, column, fact_key: factKey.value }));
      }
      table.push(Object.freeze({ shape_id: shapeId.value, cells: Object.freeze(cells) }));
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...(chartRaw === undefined ? {} : { chart: Object.freeze(chart) }),
      ...(tableRaw === undefined ? {} : { table: Object.freeze(table) }),
    }),
  };
}

function readBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/** `POST /api/ppt-facts/deliver`：给定事实快照 + 模板 ⇒ 可编辑 PPTX + 结构化一致性报告。 */
function routeDeliver(body: unknown): PptxFactsWireResponse {
  if (!isRecord(body)) return fail(400, 'invalid_request', '请求体必须是一个 JSON 对象');
  const template = readDeckTemplate(body['template']);
  if (!template.ok) return fail(400, 'invalid_template', `template 非法：${template.detail}`);

  const factsRaw = body['facts'];
  if (factsRaw === undefined || factsRaw === null) {
    // R248：缺事实来源 ⇒ 结构化未就绪，**不出字节**（绝不把缺失折成 0、也绝不凭模板编一个数）。
    return fail(422, 'ppt_facts_fact_source_missing', '事实来源缺失：本入口不渲染、不产出任何字节，也不编数字。', {
      http_status: 422,
      bytes_emitted: 0,
      unblocked_by: FACTS_UNBLOCKED_BY,
      unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
    });
  }
  const factsRead = readFactsBlock(factsRaw);
  if (!factsRead.ok) return fail(400, 'invalid_facts', factsRead.detail);

  const sourceVersionRaw = body['source_version'];
  const sourceVersion: Read<VersionedFactSnapshot> =
    sourceVersionRaw === undefined
      ? { ok: true, value: factsRead.value.target }
      : readVersionedSnapshot(sourceVersionRaw);
  if (!sourceVersion.ok) return fail(400, 'invalid_facts', `source_version 非法：${sourceVersion.detail}`);

  const built = buildDeck(template.value, sourceVersion.value);
  if (!built.ok) return fail(422, 'template_build_failed', `按模板装配演示失败（不编数字）：${built.detail}`);

  const bindings = factsRead.value.bindings ?? built.value.bindings;
  const options: PptxFactDeliveryOptions = { want_pdf: readBool(body['want_pdf'], false) };
  const includeBytes = readBool(body['include_bytes'], true);

  const delivery = deliverPptxFacts(
    factPresentationSource(built.value.presentation, pptxFactSource(factsRead.value.target, {
      history: factsRead.value.history,
      bindings,
    })),
    options,
  );
  const serialized = serializeDelivery(delivery, includeBytes);

  switch (delivery.status) {
    case 'delivered':
      return ok({
        ok: true,
        http_status: 200,
        slide_ids: slideIdsOf(built.value.presentation),
        bindings: {
          chart: (bindings.chart ?? []).map((binding) => binding.shape_id),
          table: (bindings.table ?? []).map((binding) => binding.shape_id),
          source: factsRead.value.bindings === null ? 'derived_from_template' : 'explicit_override',
        },
        delivery: serialized,
      });
    case 'blocked':
      return fail(409, 'ppt_facts_conflict', delivery.detail, {
        http_status: 409,
        slide_ids: slideIdsOf(built.value.presentation),
        delivery: serialized,
      });
    default:
      // `invariant_violated` / `export_failed` / PDF 通道不适用 ⇒ 422（请求本身成立，产物拿不到）；
      // `fact_source_missing` 之外的"未就绪"不再是 503，因为不存在"端口没装配"这回事。
      return fail(422, `ppt_facts_${delivery.kind}`, delivery.detail, {
        http_status: 422,
        slide_ids: slideIdsOf(built.value.presentation),
        delivery: serialized,
      });
  }
}

/** `POST /api/ppt-facts/apply-facts`：把演示改到目标版本，并对账"只更新了受影响处"。 */
function routeApplyFacts(body: unknown): PptxFactsWireResponse {
  if (!isRecord(body)) return fail(400, 'invalid_request', '请求体必须是一个 JSON 对象');
  const template = readDeckTemplate(body['template']);
  if (!template.ok) return fail(400, 'invalid_template', `template 非法：${template.detail}`);

  const from = readVersionedSnapshot(body['from']);
  if (!from.ok) return fail(400, 'invalid_facts', `from 非法：${from.detail}`);
  const to = readVersionedSnapshot(body['to']);
  if (!to.ok) return fail(400, 'invalid_facts', `to 非法：${to.detail}`);

  const built = buildDeck(template.value, from.value);
  if (!built.ok) return fail(422, 'template_build_failed', `按模板装配演示失败（不编数字）：${built.detail}`);

  let bindings = built.value.bindings;
  if (body['bindings'] !== undefined) {
    const read = readBindingsOverride(body['bindings']);
    if (!read.ok) return fail(400, 'invalid_bindings', read.detail);
    bindings = read.value;
  }

  const before = built.value.presentation;
  let after: Presentation;
  try {
    after = applyFactVersion({ presentation: before, target: to.value, bindings });
  } catch (error) {
    // 绑定指向的形状不存在 / 目标版本缺这条事实 ⇒ 结构化拒绝，**不是** 500，也不静默无操作。
    const reason = isRecord(error) && typeof (error as { reason?: unknown }).reason === 'string'
      ? ((error as { reason: string }).reason)
      : 'apply_failed';
    return fail(422, `apply_fact_version_failed:${reason}`, describeError(error));
  }

  const audit = auditFactVersionUpdate({
    before,
    after,
    previous: from.value,
    next: to.value,
    bindings,
  });

  const reportBefore = checkPptxFactConsistency(
    factPresentationSource(before, pptxFactSource(from.value, { history: [], bindings })),
  );
  const reportAfter = checkPptxFactConsistency(
    factPresentationSource(after, pptxFactSource(to.value, { history: [from.value], bindings })),
  );

  return ok({
    ok: audit.ok,
    http_status: 200,
    status: audit.ok ? 'applied' : 'violation',
    version_from: from.value.version,
    version_to: to.value.version,
    describe_before: `${String(before.slides.length)} 页；依据 ${from.value.version.task_id}@r${String(from.value.version.task_revision)}`,
    describe_after: `${String(after.slides.length)} 页；依据 ${to.value.version.task_id}@r${String(to.value.version.task_revision)}`,
    slide_ids_before: slideIdsOf(before),
    slide_ids_after: slideIdsOf(after),
    audit: serializeAudit(audit),
    report_before: reportBefore.status === 'checked' ? serializeReport(reportBefore.report) : { status: reportBefore.status },
    report_after: reportAfter.status === 'checked' ? serializeReport(reportAfter.report) : { status: reportAfter.status },
    unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
  });
}

/** `POST /api/ppt-facts/audit`：给定改前 / 改后模型与两版事实，判定"这次更新动的是不是该动的页"。 */
function routeAudit(body: unknown): PptxFactsWireResponse {
  if (!isRecord(body)) return fail(400, 'invalid_request', '请求体必须是一个 JSON 对象');

  const previous = readVersionedSnapshot(body['previous']);
  if (!previous.ok) return fail(400, 'invalid_facts', `previous 非法：${previous.detail}`);
  const next = readVersionedSnapshot(body['next']);
  if (!next.ok) return fail(400, 'invalid_facts', `next 非法：${next.detail}`);

  const beforeBlock = readAuditSide(body['before'], previous.value, 'before');
  if (!beforeBlock.ok) return fail(400, 'invalid_request', beforeBlock.detail);
  const afterBlock = readAuditSide(body['after'], next.value, 'after');
  if (!afterBlock.ok) return fail(400, 'invalid_request', afterBlock.detail);

  let bindings = beforeBlock.value.bindings;
  if (body['bindings'] !== undefined) {
    const read = readBindingsOverride(body['bindings']);
    if (!read.ok) return fail(400, 'invalid_bindings', read.detail);
    bindings = read.value;
  }

  const audit = auditFactVersionUpdate({
    before: beforeBlock.value.presentation,
    after: afterBlock.value.presentation,
    previous: previous.value,
    next: next.value,
    bindings,
  });

  return ok({
    ok: audit.ok,
    http_status: 200,
    status: audit.ok ? 'clean' : 'violation',
    version_previous: previous.value.version,
    version_next: next.value.version,
    slide_ids_before: slideIdsOf(beforeBlock.value.presentation),
    slide_ids_after: slideIdsOf(afterBlock.value.presentation),
    audit: serializeAudit(audit),
    codes: audit.violations.map((violation) => violation.code),
    unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
  });
}

/** 读审计一侧：`{ template, at? }`（`at` 缺省 = 该侧应当依据的版本）。 */
function readAuditSide(
  raw: unknown,
  fallbackVersion: VersionedFactSnapshot,
  what: string,
): Read<{ readonly presentation: Presentation; readonly bindings: FactBindings }> {
  if (!isRecord(raw)) return { ok: false, detail: `${what} 必须是 { template, at? } 对象` };
  const template = readDeckTemplate(raw['template']);
  if (!template.ok) return { ok: false, detail: `${what}.template 非法：${template.detail}` };
  const atRaw = raw['at'];
  const at = atRaw === undefined ? { ok: true as const, value: fallbackVersion } : readVersionedSnapshot(atRaw);
  if (!at.ok) return { ok: false, detail: `${what}.at 非法：${at.detail}` };
  const built = buildDeck(template.value, at.value);
  if (!built.ok) return { ok: false, detail: `${what} 装配失败（不编数字）：${built.detail}` };
  return { ok: true, value: { presentation: built.value.presentation, bindings: built.value.bindings } };
}

/** `GET /api/ppt-facts/status`：本入口能做什么、不能做什么（如实登记）。 */
function routeStatus(): PptxFactsWireResponse {
  return ok({
    ok: true,
    http_status: 200,
    root: PPT_FACTS_ROOT,
    routes: PPT_FACTS_ROUTES,
    ready: true,
    ready_note:
      '本入口是纯函数路由（无端口、无落盘、无第二份账本）：所有能力都在请求里自足，' +
      '因此不存在"端口未装配"这一未就绪形态。',
    requires: {
      deliver: ['template（页与绑定由它声明）', 'facts.target（目标事实版本）', 'facts.history?（用于把旧值认成 stale）'],
      apply_facts: ['template', 'from', 'to'],
      audit: ['previous', 'next', 'before{template,at?}', 'after{template,at?}'],
    },
    invariants: EXPORT_INVARIANTS,
    explicit_refusals: [
      '三处数值不同版 ⇒ 409，且在出字节之前阻断（响应里没有 editable_pptx）',
      '缺事实来源（facts 缺失/形状不合法，或模板缺某条事实键）⇒ 422 结构化失败，不编数字',
      '带图表的源 ⇒ 可编辑读回必然失败 ⇒ 422 invariant_violated（导入层未建模图表，不假装可交付）',
      '导入源 + want_pdf ⇒ 结构化拒绝（逐部件保留通道与整体重建渲染不是同一份）',
    ],
    byte_limits: { max_body_bytes: MAX_PPT_FACTS_BODY_BYTES },
    unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
  });
}

// ---------------------------------------------------------------------------
// 路由表（前缀匹配；命中即返回）
// ---------------------------------------------------------------------------

/** 在 `PPT_FACTS_ROOT` 下匹配一条路径；不是本命名空间则 `null`。 */
function matchPptxFactsRoute(pathname: string): string | null {
  if (pathname === PPT_FACTS_ROOT || pathname === `${PPT_FACTS_ROOT}/`) return 'index';
  if (!pathname.startsWith(`${PPT_FACTS_ROOT}/`)) return null;
  const relative = pathname.slice(PPT_FACTS_ROOT.length + 1);
  if (relative.length === 0 || relative.includes('/')) return null;
  return relative;
}

/** 路由一次的纯逻辑（不起 socket，便于用例直接调用）。 */
export function routePptxFactsRequest(input: {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}): PptxFactsWireResponse | null {
  const route = matchPptxFactsRoute(input.pathname);
  if (route === null) return null;
  const method = input.method.toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';

  if (route === 'status') {
    if (!isRead) return fail(405, 'method_not_allowed', 'status 只接受 GET');
    return routeStatus();
  }
  if (route === 'deliver') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'deliver 只接受 POST');
    return routeDeliver(input.body);
  }
  if (route === 'apply-facts') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'apply-facts 只接受 POST');
    return routeApplyFacts(input.body);
  }
  if (route === 'audit') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'audit 只接受 POST');
    return routeAudit(input.body);
  }
  return fail(404, 'unknown_ppt_facts_route', `未知的同版事实接口 ${method} ${input.pathname}；已知：${PPT_FACTS_ROUTES.join(' / ')}`);
}

// ---------------------------------------------------------------------------
// node:http 适配器（协调者挂载点）
// ---------------------------------------------------------------------------

export interface PptxFactsHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
}

async function readRawBody(req: IncomingMessage): Promise<{ readonly ok: true; readonly raw: string } | { readonly ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { readonly ok: true; readonly raw: string } | { readonly ok: false }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PPT_FACTS_BODY_BYTES) {
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * **挂载点**：处理一次 `/api/ppt-facts/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**一行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * if (await handlePptxFactsRequest({ req, res, url })) return;
 * ```
 *
 * 本模块**不需要装配任何宿主 / 端口**：能力全在请求体里自足（纯函数路由）。
 */
export async function handlePptxFactsRequest(input: PptxFactsHttpInput): Promise<boolean> {
  const pathname = input.url.pathname;
  if (matchPptxFactsRoute(pathname) === null) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(input.res, 413, {
        code: 'body_too_large',
        message: `请求体超过 ${String(MAX_PPT_FACTS_BODY_BYTES)} 字节上限`,
        retryable: false,
      });
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw) as unknown;
      } catch {
        sendJson(input.res, 400, { code: 'invalid_json', message: '请求体不是合法 JSON', retryable: false });
        return true;
      }
    }
  }

  const response = routePptxFactsRequest({ method, pathname, body });
  if (response === null) return false;
  sendJson(input.res, response.status, response.body);
  return true;
}

/** 供用例 / 上层核对"某条冲突被如实说明"（不重造判据，直接转发域内实现）。 */
export function describeDeliveryConflicts(delivery: PptxFactDelivery): string {
  if (delivery.status !== 'blocked') return '本次交付没有事实冲突';
  return describeFactConflicts(delivery.report);
}

/** 供其它产品面复用：正文事实体的构造（值与目标版本同源）。 */
export function factTextOf(factKey: string): TextBody {
  return factTextBody(factKey);
}
