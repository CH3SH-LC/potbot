/**
 * **演示（PPTX）同版事实同步交付适配器**（工作包 FA-PPT-FACTS-PRODUCT；PPT-16 的**产品面**）。
 *
 * 本文件与 `./xlsx.ts` **同形**：一个格式适配器（`format` / `template_kind` / `describe` /
 * `exportBytes` / `applyEdit` / `importBytes`）+ 一批结构化结果类型 + 一个冻结的单例。
 * 它**只新增文件**、**不改** `src/presentations/**` 的既有实现——同版事实的判定与改写全部
 * 复用 `src/presentations/fact-sync.ts`（{@link syncPresentationFacts} / {@link applyFactVersion}），
 * 导出与"PDF 不替代 PPTX"的不变式全部复用 `src/presentations/export-handoff.ts`。
 *
 * ## 一、同版事实：三处数值必须来自**同一版**
 *
 * 硬要求是"一次交付里正文 / 表格 / 图表三处数值来自同一事实版本"。这条在**结构上**被
 * `fact-sync.ts` 钉死：`fact_key` 的全部出现处，其呈现数值必须等于目标版本这条事实的值。
 * 本适配器把"目标版本 + 历史版本 + 绑定"收进源，并**只**通过
 * {@link checkPptxFactConsistency} 暴露判定结果：
 *
 * - 三处同版 ⇒ `status: 'checked'` 且 `report.ok === true`；
 * - 某处用的是**旧版**（图表嵌入数据 / 表格字面量没跟着更新）⇒ `stale_fact_version` 冲突；
 * - **冲突 ⇒ 拒绝交付**（{@link deliverPptxFacts} 返回 `blocked`），**绝不**静默取其一。
 *
 * ## 二、改事实后只更新受影响处
 *
 * {@link applyFactVersion} 是域里的改写入口：正文的 `fact` 引用**天然**跟着快照走（模型不动），
 * 图表嵌入数据与表格字面量被重写成目标版本的值。本适配器在此之上给出
 * {@link auditFactVersionUpdate}：把"**应当**改哪些页"（独立算出来的期望）与"**实际**改了哪些页"
 * （逐页模型指纹比对）对账，抓两类毛病——
 *
 * - `unrelated_slide_rewritten`：**无关页**（既无事实引用、也无绑定对象）被重写；
 * - `affected_slide_not_rewritten`：**受影响页**却纹丝不动（该更新的没更新）。
 *
 * ## 三、交付：可编辑 PPTX 与结构化一致性报告**同时**产出
 *
 * {@link deliverPptxFacts} 复用 `export-handoff.ts`：`want_pdf` 时走
 * `deliverPresentation`（其内部 `exportPresentationPdf` 产出 PDF **并**把可编辑 PPTX 读回一次），
 * 再用 `deliveryInvariantProblems` 复核"PDF 不替代 PPTX、页数对得上"。
 * **不另造**一套不变式：`invariants` 直接原样带出 `EXPORT_INVARIANTS`。
 *
 * ## 四、未就绪：缺事实来源 ⇒ 结构化未就绪，**不编数字**（R248）
 *
 * 源的 `facts` 为 `null`（导入的既有演示、或尚未 `attach_facts`）时：
 * `exportBytes` / `apply_fact_version` / 一致性检查 / 交付**一律**返回结构化的 `not_ready`
 * 并附**解锁条件**；此时**不**渲染、**不**产出任何字节，也**不**把缺失折成 0 或空串。
 * 要交付无事实的普通演示，用 `./pptx.ts` 的 `pptxDeliverableAdapter`（那是另一条通道）。
 *
 * ## 如实登记的边界（不得编造）
 *
 * - **导入的既有演示**（`imported !== null`）走 `exportImportedPresentation` 的**逐部件保留**通道，
 *   该通道**不接受图表形状**（`roundtrip.ts` 未提供图表关系 ⇒ `unsupported_shape_kind`），
 *   也**不能**在此通道上产出 PDF（PDF 走的是"整模型重建"的渲染，与逐部件保留是两次渲染，
 *   混用会破坏"PDF 与 PPTX 是同一份"）。因此 `want_pdf` 在导入源上**结构化拒绝**。
 * - **带图表的演示无法通过"可编辑"读回**：渲染层能写出图表部件，但**导入层不建模
 *   `p:graphicFrame` 的图表**（`import.ts` 明确报"图表 / SmartArt / 内容部件本域未建模，
 *   不静默丢弃"）。因此 {@link deliverPptxFacts} 的"交付的 PPTX 必须读得回"这一步对
 *   带图表的演示**必然失败**，结果是结构化 `invariant_violated`——本适配器**不**把
 *   "写出了一个导入层读不回的包"当成可交付。图表的一致性判定仍成立（模型层），
 *   但它与"可编辑交付"这条链**未打通**，如实登记于此。
 * - **真机 / Office 打开未验证**：本适配器只做模型层与字节层判定；"产物在真机上打开无修复提示"
 *   需要消费端与真机，一律标未验证，并随每份交付结果原样带出（见
 *   {@link PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS}）。
 *
 * 本模块零 IO、零墙钟、零随机数，纯函数（与 `src/session/adapters/xlsx.ts` 同纪律）。
 */

import type { KnownFactValue, TemplateKind } from '../../protocol/index.js';
import {
  EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
  EXPORT_INVARIANTS,
  FACT_SYNC_UNVERIFIED_CLAIMS,
  applyFactVersion,
  asFactSnapshot,
  buildPresentationPreview,
  deliverPresentation,
  deliveryInvariantProblems,
  describeFactVersion,
  emptyPresentation,
  exportImportedPresentation,
  importPresentation,
  lookupVersionedFact,
  observeTableCell,
  reopenEditablePptx,
  renderPresentation,
  resolveRunText,
  sameFactVersion,
  syncPresentationFacts,
  versionedSnapshot,
  type ChartFactBinding,
  type ChartSeriesFactBinding,
  type EditablePptxArtifact,
  type ExportHandoffUnverifiedClaim,
  type FactBindings,
  type FactSnapshot,
  type FactSyncReport,
  type FactSyncUnverifiedClaim,
  type FactVersion,
  type ImportedPresentation,
  type PdfArtifact,
  type Presentation,
  type PresentationPreview,
  type Shape,
  type Slide,
  type TableFactBinding,
  type TextBody,
  type VersionedFactEntry,
  type VersionedFactSnapshot,
} from '../../presentations/index.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterImportResult,
  DeliverableAdapter,
} from '../adapter.js';
import type { FileFormat } from '../formats.js';

// ---------------------------------------------------------------------------
// 源
// ---------------------------------------------------------------------------

/**
 * 一次交付**应当依据**的事实来源：目标版本 + 已知历史版本 + 绑定。
 *
 * `history` 不是"备选答案"——它只用来把"某处呈现的数值"**认成**某个旧版本的值
 * （于是冲突从含糊的 `value_mismatch` 升级为可定位的 `stale_fact_version`）。
 * 历史里**没有**某个值 ⇒ 那处就是凭空错值（`value_mismatch`），同样报冲突。
 */
export interface PptxFactSource {
  readonly target: VersionedFactSnapshot;
  readonly history: readonly VersionedFactSnapshot[];
  readonly bindings: FactBindings;
}

/**
 * 演示交付的源。
 *
 * - `imported` 非空 ⇒ 导出走"只换被改页"的逐部件保留通道（R249）；
 * - `facts` 为 `null` ⇒ 事实来源缺失：一切与事实有关的操作**结构化未就绪**，**不编数字**。
 */
export interface PptxFactDeliverableSource {
  readonly presentation: Presentation;
  readonly imported: ImportedPresentation | null;
  readonly facts: PptxFactSource | null;
}

/** 装配一份事实来源（`history` / `bindings` 可缺省）。 */
export function pptxFactSource(
  target: VersionedFactSnapshot,
  options?: { readonly history?: readonly VersionedFactSnapshot[]; readonly bindings?: FactBindings },
): PptxFactSource {
  return Object.freeze({
    target,
    history: Object.freeze([...(options?.history ?? [])]),
    bindings: options?.bindings ?? Object.freeze({}),
  });
}

/** 把一份演示模型包成交付源（`imported` 缺省 = 从零新建）。 */
export function factPresentationSource(
  presentation: Presentation,
  facts: PptxFactSource | null,
  imported: ImportedPresentation | null = null,
): PptxFactDeliverableSource {
  return Object.freeze({ presentation, imported, facts });
}

/** 从零建一份**带事实来源**的空演示（0 页；页数与内容由调用方按任务决定）。 */
export function emptyFactPresentationSource(
  presentationId: string,
  title: string,
  facts: PptxFactSource,
): PptxFactDeliverableSource {
  return factPresentationSource(emptyPresentation(presentationId, title), facts);
}

/** 缺事实来源时的解锁条件（结构化未就绪一律带上它；R233）。 */
export const FACTS_UNBLOCKED_BY =
  '为源装配事实来源后即可：`attach_facts`（任务版本 + 事实条目 + 绑定），或直接导入一份已带事实版本的源';

// ---------------------------------------------------------------------------
// 读取（把 unknown 编辑读成形状正确的结构；读不出就结构化失败，不猜）
// ---------------------------------------------------------------------------

type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function readKnownFactValue(raw: unknown): KnownFactValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  switch (record['type']) {
    case 'number': {
      const amount = record['amount'];
      const unit = record['unit'];
      const currency = record['currency'];
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
      if (typeof unit !== 'string' || unit.length === 0) return null;
      if (currency !== undefined && currency !== null && (typeof currency !== 'string' || currency.length === 0)) {
        return null;
      }
      return Object.freeze({ type: 'number' as const, amount, unit, currency: currency === undefined ? null : (currency as string | null) });
    }
    case 'date': {
      const isoDate = record['iso_date'];
      const timeZone = record['time_zone'];
      if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return null;
      if (typeof timeZone !== 'string' || timeZone.length === 0) return null;
      return Object.freeze({ type: 'date' as const, iso_date: isoDate, time_zone: timeZone });
    }
    case 'text': {
      const text = record['text'];
      const source = record['source'];
      if (typeof text !== 'string' || text.length === 0) return null;
      if (typeof source !== 'string' || source.length === 0) return null;
      return Object.freeze({ type: 'text' as const, text, source });
    }
    default:
      return null;
  }
}

/**
 * 读一份版本化事实快照。
 *
 * 形状问题（缺 version / entries 非法 / 同一键两条）一律**读失败**——最后一种由
 * {@link versionedSnapshot} 抛 `duplicate_fact_key`，此处转成结构化原因，
 * 因为"同一键两条 ⇒ 用哪一条"正是本适配器要消灭的隐式选择。
 */
function readVersionedSnapshot(raw: unknown): ReadResult<VersionedFactSnapshot> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, detail: '事实版本必须是一个对象' };
  const record = raw as Record<string, unknown>;
  const versionRaw = record['version'];
  if (typeof versionRaw !== 'object' || versionRaw === null) {
    return { ok: false, detail: '事实版本缺少 version { task_id, task_revision }' };
  }
  const versionRecord = versionRaw as Record<string, unknown>;
  const taskId = versionRecord['task_id'];
  const revision = versionRecord['task_revision'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return { ok: false, detail: 'version.task_id 必须是非空字符串' };
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return { ok: false, detail: 'version.task_revision 必须是非负整数' };
  }
  const entriesRaw = record['entries'];
  if (!Array.isArray(entriesRaw)) return { ok: false, detail: '事实版本缺少 entries 数组' };

  const entries: VersionedFactEntry[] = [];
  for (const itemRaw of entriesRaw) {
    if (typeof itemRaw !== 'object' || itemRaw === null) return { ok: false, detail: '事实条目必须是对象' };
    const item = itemRaw as Record<string, unknown>;
    const factKey = item['fact_key'];
    const factRef = item['fact_ref'];
    if (typeof factKey !== 'string' || factKey.length === 0) {
      return { ok: false, detail: '事实条目的 fact_key 必须是非空字符串' };
    }
    if (typeof factRef !== 'string' || factRef.length === 0) {
      return { ok: false, detail: `事实 ${factKey} 的 fact_ref 必须是非空字符串` };
    }
    const value = readKnownFactValue(item['value']);
    if (value === null) {
      return { ok: false, detail: `事实 ${factKey} 的 value 不是已知事实值（number / date / text）` };
    }
    entries.push({ fact_key: factKey, fact_ref: factRef, value });
  }

  try {
    return { ok: true, value: versionedSnapshot({ task_id: taskId, task_revision: revision }, entries) };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
}

function readStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return null;
  return raw as string[];
}

/** 读绑定结构；`undefined` ⇒ 空绑定（不是"随便绑"）。 */
function readBindings(raw: unknown): FactBindings | null {
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const chartRaw = record['chart'];
  const tableRaw = record['table'];
  const chart: ChartFactBinding[] = [];
  const table: TableFactBinding[] = [];

  if (chartRaw !== undefined) {
    if (!Array.isArray(chartRaw)) return null;
    for (const bindingRaw of chartRaw) {
      if (typeof bindingRaw !== 'object' || bindingRaw === null) return null;
      const binding = bindingRaw as Record<string, unknown>;
      const shapeId = binding['shape_id'];
      if (typeof shapeId !== 'number' || !Number.isInteger(shapeId)) return null;
      const seriesRaw = binding['series'];
      if (!Array.isArray(seriesRaw)) return null;
      const series: ChartSeriesFactBinding[] = [];
      for (const seriesItemRaw of seriesRaw) {
        if (typeof seriesItemRaw !== 'object' || seriesItemRaw === null) return null;
        const seriesItem = seriesItemRaw as Record<string, unknown>;
        const name = seriesItem['name'];
        if (typeof name !== 'string') return null;
        const factKeys = readStringArray(seriesItem['fact_keys']);
        if (factKeys === null) return null;
        series.push(Object.freeze({ name, fact_keys: Object.freeze(factKeys) }));
      }
      chart.push(Object.freeze({ shape_id: shapeId, series: Object.freeze(series) }));
    }
  }

  if (tableRaw !== undefined) {
    if (!Array.isArray(tableRaw)) return null;
    for (const bindingRaw of tableRaw) {
      if (typeof bindingRaw !== 'object' || bindingRaw === null) return null;
      const binding = bindingRaw as Record<string, unknown>;
      const shapeId = binding['shape_id'];
      if (typeof shapeId !== 'number' || !Number.isInteger(shapeId)) return null;
      const cellsRaw = binding['cells'];
      if (!Array.isArray(cellsRaw)) return null;
      const cells: TableFactBinding['cells'][number][] = [];
      for (const cellRaw of cellsRaw) {
        if (typeof cellRaw !== 'object' || cellRaw === null) return null;
        const cell = cellRaw as Record<string, unknown>;
        const row = cell['row'];
        const column = cell['column'];
        const factKey = cell['fact_key'];
        if (typeof row !== 'number' || !Number.isInteger(row) || row < 0) return null;
        if (typeof column !== 'number' || !Number.isInteger(column) || column < 0) return null;
        if (typeof factKey !== 'string' || factKey.length === 0) return null;
        cells.push(Object.freeze({ row, column, fact_key: factKey }));
      }
      table.push(Object.freeze({ shape_id: shapeId, cells: Object.freeze(cells) }));
    }
  }

  const bindings: { chart?: readonly ChartFactBinding[]; table?: readonly TableFactBinding[] } = {};
  if (chartRaw !== undefined) bindings.chart = Object.freeze(chart);
  if (tableRaw !== undefined) bindings.table = Object.freeze(table);
  return Object.freeze(bindings);
}

function readHistory(raw: unknown): ReadResult<readonly VersionedFactSnapshot[]> | null {
  if (raw === undefined) return { ok: true, value: Object.freeze([]) };
  if (!Array.isArray(raw)) return null;
  const snapshots: VersionedFactSnapshot[] = [];
  for (const item of raw) {
    const read = readVersionedSnapshot(item);
    if (!read.ok) return { ok: false, detail: `history 里的版本非法：${read.detail}` };
    snapshots.push(read.value);
  }
  return { ok: true, value: Object.freeze(snapshots) };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 取领域错误的具名 reason（`FactSyncError` 等都有 `reason`；否则退回错误名）。 */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return error instanceof Error ? error.name : 'unknown_error';
}

// ---------------------------------------------------------------------------
// 编辑（封闭枚举）
// ---------------------------------------------------------------------------

/**
 * **产品入口上的同版事实编辑**（封闭枚举）。
 *
 * 刻意**不做**"自然语言 → 事实操作"：本文件只定义**受约束的结构化意图**，
 * 自然语言到它的翻译是模型层的事（R134）。两个操作都不可变、都只改事实坐标这一处。
 */
export type PptxFactEdit =
  | {
      /** 装配 / 更换事实来源（目标版本 + 历史 + 绑定）。导入的源靠它获得事实坐标。 */
      readonly op: 'attach_facts';
      readonly target: VersionedFactSnapshot;
      readonly history?: readonly VersionedFactSnapshot[];
      readonly bindings?: FactBindings;
    }
  | {
      /**
       * 把演示**改到目标事实版本**（"人数 8 → 10"就走这条）：
       * 正文的 `fact` 引用换快照即换数字；图表嵌入数据与表格绑定单元格被重写成目标值。
       */
      readonly op: 'apply_fact_version';
      readonly target: VersionedFactSnapshot;
    };

type EditOk = { readonly ok: true; readonly source: PptxFactDeliverableSource; readonly changed: boolean; readonly notes: readonly string[] };
type EditFail = { readonly ok: false; readonly kind: string; readonly detail: string };

function editFail(kind: string, detail: string): EditFail {
  return { ok: false, kind, detail };
}

/** 快照指纹：版本坐标 + 全部条目（用于"这次编辑到底有没有变"的判定，不做任何语义解释）。 */
function snapshotFingerprint(snapshot: VersionedFactSnapshot): string {
  return JSON.stringify([
    snapshot.version.task_id,
    snapshot.version.task_revision,
    snapshot.entries.map((entry) => [entry.fact_key, entry.fact_ref, entry.value]),
  ]);
}

/** 逐页模型指纹（页序 + 页内容）。用于"哪些页被重写"的可判定比对。 */
function slideFingerprint(slide: Slide): string {
  return JSON.stringify(slide);
}

function rewrittenSlideIds(before: Presentation, after: Presentation): readonly number[] {
  const beforeById = new Map(before.slides.map((slide) => [slide.slide_id, slideFingerprint(slide)]));
  const ids: number[] = [];
  for (const slide of after.slides) {
    const previous = beforeById.get(slide.slide_id);
    if (previous === undefined || previous !== slideFingerprint(slide)) ids.push(slide.slide_id);
  }
  return Object.freeze(ids);
}

function factSourceOf(
  target: VersionedFactSnapshot,
  history: readonly VersionedFactSnapshot[],
  bindings: FactBindings,
): PptxFactSource {
  return Object.freeze({ target, history, bindings });
}

function applyPptxFactEdit(source: PptxFactDeliverableSource, edit: unknown): EditOk | EditFail {
  if (typeof edit !== 'object' || edit === null) {
    return editFail('invalid_edit', '编辑必须是一个对象');
  }
  const record = edit as Record<string, unknown>;
  const op = record['op'];

  switch (op) {
    case 'attach_facts': {
      const read = readVersionedSnapshot(record['target']);
      if (!read.ok) return editFail('invalid_value', `target 不是合法的版本化事实快照：${read.detail}`);
      const historyRead = readHistory(record['history']);
      if (historyRead === null) return editFail('invalid_value', 'history 必须是版本化快照的数组');
      if (!historyRead.ok) return editFail('invalid_value', historyRead.detail);
      const bindings = readBindings(record['bindings']);
      if (bindings === null) return editFail('invalid_value', 'bindings 形状非法（chart / table 绑定的字段缺失或类型不对）');

      const next = factSourceOf(read.value, historyRead.value, bindings);
      const changed = source.facts === null || snapshotFingerprint(source.facts.target) !== snapshotFingerprint(next.target);
      return {
        ok: true,
        source: { ...source, facts: next },
        changed,
        notes: Object.freeze([
          `事实来源已装配：版本 ${describeFactVersion(next.target.version)}，` +
            `历史 ${String(next.history.length)} 版，图表绑定 ${String(next.bindings.chart?.length ?? 0)} 处 / 表格绑定 ${String(next.bindings.table?.length ?? 0)} 处`,
        ]),
      };
    }

    case 'apply_fact_version': {
      if (source.facts === null) {
        return editFail('fact_source_missing', `没有事实来源，无法改事实版本。${FACTS_UNBLOCKED_BY}`);
      }
      const read = readVersionedSnapshot(record['target']);
      if (!read.ok) return editFail('invalid_value', `target 不是合法的版本化事实快照：${read.detail}`);
      const target = read.value;
      const previous = source.facts.target;
      try {
        const nextPresentation = applyFactVersion({
          presentation: source.presentation,
          target,
          bindings: source.facts.bindings,
        });
        const targetChanged = snapshotFingerprint(previous) !== snapshotFingerprint(target);
        const rewritten = rewrittenSlideIds(source.presentation, nextPresentation);
        const history = targetChanged
          ? Object.freeze([previous, ...source.facts.history])
          : source.facts.history;
        return {
          ok: true,
          source: {
            ...source,
            presentation: nextPresentation,
            facts: factSourceOf(target, history, source.facts.bindings),
          },
          changed: targetChanged || rewritten.length > 0,
          notes: Object.freeze([
            `事实版本 ${describeFactVersion(previous.version)} → ${describeFactVersion(target.version)}；` +
              `被重写页 ${rewritten.length === 0 ? '（无）' : rewritten.join('、')}` +
              '（正文事实引用随快照求值，模型不动；图表嵌入数据与表格绑定单元格被重写）',
          ]),
        };
      } catch (error) {
        // 绑定指向的形状不存在 / 数据点个数对不上 / 目标版本缺这条事实：**结构化成编辑失败**，
        // 而不是让异常穿出会话层（那会绕过"源零改动"的承诺）。
        return editFail(reasonOf(error), describe(error));
      }
    }

    default:
      return editFail(
        'unsupported_op',
        `不支持的演示事实操作 ${JSON.stringify(String(op))}（封闭枚举：attach_facts / apply_fact_version）`,
      );
  }
}

// ---------------------------------------------------------------------------
// 一致性检查（同版事实）
// ---------------------------------------------------------------------------

/** 一致性检查结果（缺事实来源 ⇒ 结构化未就绪，不猜、不渲染）。 */
export type PptxFactConsistencyCheck =
  | {
      readonly status: 'not_ready';
      readonly kind: 'fact_source_missing';
      readonly detail: string;
      readonly unblocked_by: string;
      readonly unverified: readonly (FactSyncUnverifiedClaim | ExportHandoffUnverifiedClaim)[];
    }
  | { readonly status: 'checked'; readonly report: FactSyncReport };

/**
 * 对账：演示 × 目标版本 × 绑定 ⇒ 结构化一致性报告。
 *
 * 报告是 `fact-sync.ts` 的**原样输出**（`usages` / `conflicts` / `counts` /
 * `consistency_scope` / `unverified`），本适配器**不**另造第二套判据。
 */
export function checkPptxFactConsistency(source: PptxFactDeliverableSource): PptxFactConsistencyCheck {
  if (source.facts === null) {
    return Object.freeze({
      status: 'not_ready' as const,
      kind: 'fact_source_missing' as const,
      detail: '演示的事实来源缺失：无法判定正文 / 表格 / 图表是否同版（R248：缺失不当零，也不得凭空编数字）。',
      unblocked_by: FACTS_UNBLOCKED_BY,
      unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
    });
  }
  const report = syncPresentationFacts({
    presentation: source.presentation,
    target: source.facts.target,
    bindings: source.facts.bindings,
    history: source.facts.history,
  });
  return Object.freeze({ status: 'checked' as const, report });
}

/** 把冲突摊成一行人可读说明（进结构化失败详情，便于前台回显"冲突在哪"）。 */
export function describeFactConflicts(report: FactSyncReport): string {
  if (report.conflicts.length === 0) return '无冲突';
  return report.conflicts
    .map((conflict) => `[${conflict.kind}] ${conflict.message}`)
    .join('；');
}

// ---------------------------------------------------------------------------
// 更新审计（"只更新受影响处，无关页不重写"的可判定形式）
// ---------------------------------------------------------------------------

export const FACT_UPDATE_VIOLATION_CODES = [
  /** 反向对照①：无关页（无事实引用、无绑定对象）被重写。 */
  'unrelated_slide_rewritten',
  /** 反向对照②：受影响页却没被重写（该更新的没更新）。 */
  'affected_slide_not_rewritten',
  /** 页集合被改动：不是"改事实"该发生的事。 */
  'slide_set_changed',
] as const;
export type FactUpdateViolationCode = (typeof FACT_UPDATE_VIOLATION_CODES)[number];

export interface FactUpdateViolation {
  readonly code: FactUpdateViolationCode;
  readonly slide_id: number;
  readonly detail: string;
}

/** 一次事实版本更新的审计报告。 */
export interface FactUpdateAudit {
  /** 无违规即 `true`。 */
  readonly ok: boolean;
  /** 正文事实引用**求值结果**变了的页（模型不动，交付出来的文字变了）。 */
  readonly text_affected_slide_ids: readonly number[];
  /** **应当**被重写的页（图表嵌入数据 / 表格绑定单元格与目标版本对不上）。 */
  readonly rewrite_expected_slide_ids: readonly number[];
  /** **实际**模型变了的页（逐页指纹比对）。 */
  readonly rewritten_slide_ids: readonly number[];
  /** 模型没变的页。 */
  readonly unchanged_slide_ids: readonly number[];
  /** 既无事实引用、也无绑定对象的页（**无关页**：重写它就是违规）。 */
  readonly unrelated_slide_ids: readonly number[];
  readonly violations: readonly FactUpdateViolation[];
}

export interface FactVersionUpdateAuditInput {
  readonly before: Presentation;
  readonly after: Presentation;
  /** 更新前依据的版本。 */
  readonly previous: VersionedFactSnapshot;
  /** 更新后依据的版本。 */
  readonly next: VersionedFactSnapshot;
  readonly bindings: FactBindings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function allShapes(shapes: readonly Shape[], out: Shape[] = []): readonly Shape[] {
  for (const shape of shapes) {
    out.push(shape);
    if (shape.kind === 'group') allShapes(shape.children, out);
  }
  return out;
}

function allBodies(slide: Slide): readonly TextBody[] {
  const bodies: TextBody[] = [];
  if (slide.notes !== null) bodies.push(slide.notes);
  for (const shape of allShapes(slide.shapes)) {
    if (shape.kind === 'text_box') bodies.push(shape.text);
    else if (shape.kind === 'auto_shape' && shape.text !== null) bodies.push(shape.text);
    else if (shape.kind === 'table') {
      for (const row of shape.rows) {
        for (const cell of row.cells) {
          if (cell.text !== null) bodies.push(cell.text);
        }
      }
    }
  }
  return bodies;
}

function slideHasFactRun(slide: Slide): boolean {
  for (const body of allBodies(slide)) {
    for (const paragraph of body.paragraphs) {
      for (const run of paragraph.runs) {
        if (run.source.kind === 'fact') return true;
      }
    }
  }
  return false;
}

function boundShapeIds(bindings: FactBindings): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const binding of bindings.chart ?? []) ids.add(binding.shape_id);
  for (const binding of bindings.table ?? []) ids.add(binding.shape_id);
  return ids;
}

function slideHasBoundShape(slide: Slide, boundIds: ReadonlySet<number>): boolean {
  return allShapes(slide.shapes).some((shape) => boundIds.has(shape.shape_id));
}

/** 页的**求值文字**变了吗（正文事实引用对同一 run 在新旧快照下求值不同 ⇒ 变了）。 */
function slideTextChanged(slide: Slide, previous: FactSnapshot, next: FactSnapshot): boolean {
  for (const body of allBodies(slide)) {
    for (const paragraph of body.paragraphs) {
      for (const run of paragraph.runs) {
        if (run.source.kind !== 'fact') continue;
        if (resolveRunText(run.source, previous) !== resolveRunText(run.source, next)) return true;
      }
    }
  }
  return false;
}

/** 取目标版本里某事实的数值；缺失 / 非数值 ⇒ `null`（不折成 0）。 */
function targetAmount(snapshot: VersionedFactSnapshot, factKey: string): number | null {
  const entry = lookupVersionedFact(snapshot, factKey);
  if (entry === null || entry.value.type !== 'number') return null;
  return entry.value.amount;
}

/**
 * 这一页的模型**是否必须**因为改事实而改。
 *
 * 独立于 {@link applyFactVersion} 的实际行为来算（否则就是自我复述）：
 * 逐绑定对象比对"当前模型里写死的数"与"目标版本应当呈现的数"。
 */
function slideNeedsModelChange(
  slide: Slide,
  bindings: FactBindings,
  next: VersionedFactSnapshot,
): boolean {
  const chartBindings = new Map((bindings.chart ?? []).map((binding) => [binding.shape_id, binding]));
  const tableBindings = new Map((bindings.table ?? []).map((binding) => [binding.shape_id, binding]));

  for (const shape of allShapes(slide.shapes)) {
    if (shape.kind === 'chart') {
      const binding = chartBindings.get(shape.shape_id);
      if (binding === undefined) continue;
      for (const [seriesIndex, seriesBinding] of binding.series.entries()) {
        const series = shape.chart.series[seriesIndex];
        if (series === undefined) return true;
        for (const [pointIndex, factKey] of seriesBinding.fact_keys.entries()) {
          const expected = targetAmount(next, factKey);
          if (expected === null) return true;
          if (series.values[pointIndex] !== expected) return true;
        }
      }
    }
    if (shape.kind === 'table') {
      const binding = tableBindings.get(shape.shape_id);
      if (binding === undefined) continue;
      for (const cellBinding of binding.cells) {
        const cell = shape.rows[cellBinding.row]?.cells[cellBinding.column];
        if (cell === undefined) return true;
        const observation = observeTableCell(cell);
        // 事实引用单元格：改写会把引用换成字面量 ⇒ 模型一定变。
        if (observation.origin === 'fact') return true;
        // 读不出数：改写会把目标值写进去 ⇒ 模型一定变（细节：这是"缺失被补上"，不是补零）。
        if (observation.origin === 'unreadable') return true;
        const expected = targetAmount(next, cellBinding.fact_key);
        if (expected === null) return true;
        if (observation.value !== expected) return true;
      }
    }
  }
  return false;
}

/**
 * 审计一次"改事实版本"：期望改哪些页 × 实际改了哪些页 ⇒ 违规清单。
 *
 * 判据全部在**模型层**（可完整判定）；渲染后的观感需要消费端，不在本函数判据内。
 */
export function auditFactVersionUpdate(input: FactVersionUpdateAuditInput): FactUpdateAudit {
  const boundIds = boundShapeIds(input.bindings);
  const previousSnapshot = asFactSnapshot(input.previous);
  const nextSnapshot = asFactSnapshot(input.next);
  const beforeSlides = new Map(input.before.slides.map((slide) => [slide.slide_id, slide]));
  const afterSlides = new Map(input.after.slides.map((slide) => [slide.slide_id, slide]));

  const textAffected: number[] = [];
  const rewriteExpected: number[] = [];
  const rewritten: number[] = [];
  const unchanged: number[] = [];
  const unrelated: number[] = [];
  const violations: FactUpdateViolation[] = [];

  const slideIdSetsDiffer =
    beforeSlides.size !== afterSlides.size ||
    [...beforeSlides.keys()].some((slideId) => !afterSlides.has(slideId));
  if (slideIdSetsDiffer) {
    violations.push(Object.freeze({
      code: 'slide_set_changed' as const,
      slide_id: -1,
      detail: `改事实版本不应增删页：改前 ${String(beforeSlides.size)} 页，改后 ${String(afterSlides.size)} 页`,
    }));
  }

  for (const slide of input.before.slides) {
    const slideId = slide.slide_id;
    const after = afterSlides.get(slideId);
    const hasFactUsage = slideHasFactRun(slide) || slideHasBoundShape(slide, boundIds);
    const needsChange = slideNeedsModelChange(slide, input.bindings, input.next);

    if (slideTextChanged(slide, previousSnapshot, nextSnapshot)) textAffected.push(slideId);
    if (needsChange) rewriteExpected.push(slideId);
    if (!hasFactUsage) unrelated.push(slideId);

    const modelChanged = after === undefined || slideFingerprint(slide) !== slideFingerprint(after);
    if (modelChanged) rewritten.push(slideId);
    else unchanged.push(slideId);

    if (modelChanged && !hasFactUsage) {
      violations.push(Object.freeze({
        code: 'unrelated_slide_rewritten' as const,
        slide_id: slideId,
        detail:
          `第 ${String(slideId)} 页既无事实引用、也无绑定对象（与本次事实更新无关），` +
          '实现却重写了它：无关页不得重写（只更新受影响处）',
      }));
    }
    if (needsChange && !modelChanged) {
      violations.push(Object.freeze({
        code: 'affected_slide_not_rewritten' as const,
        slide_id: slideId,
        detail:
          `第 ${String(slideId)} 页有与目标版本对不上的图表嵌入数据 / 表格绑定单元格，` +
          '实现却没有重写它：受影响页必须被更新',
      }));
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    text_affected_slide_ids: Object.freeze(textAffected),
    rewrite_expected_slide_ids: Object.freeze(rewriteExpected),
    rewritten_slide_ids: Object.freeze(rewritten),
    unchanged_slide_ids: Object.freeze(unchanged),
    unrelated_slide_ids: Object.freeze(unrelated),
    violations: Object.freeze(violations),
  });
}

// ---------------------------------------------------------------------------
// 交付（可编辑 PPTX + 结构化一致性报告；PDF 不替代 PPTX）
// ---------------------------------------------------------------------------

export type PptxFactDeliveryProblem =
  | 'fact_source_missing'
  | 'pdf_requires_rebuildable_source'
  | 'export_failed'
  | 'invariant_violated';

/** 交付结果（三分支：未就绪 / 冲突阻断 / 已交付）。 */
export type PptxFactDelivery =
  | {
      readonly status: 'not_ready';
      readonly kind: PptxFactDeliveryProblem;
      readonly detail: string;
      readonly unblocked_by: string;
      readonly report: FactSyncReport | null;
      readonly unverified: readonly (FactSyncUnverifiedClaim | ExportHandoffUnverifiedClaim)[];
    }
  | {
      /** 三处数值不同版（`stale_fact_version` 等）⇒ **拒绝交付**，不得静默取其一。 */
      readonly status: 'blocked';
      readonly kind: 'fact_conflict';
      readonly detail: string;
      readonly report: FactSyncReport;
      readonly unverified: readonly (FactSyncUnverifiedClaim | ExportHandoffUnverifiedClaim)[];
    }
  | {
      readonly status: 'delivered';
      /** **必填**：任何交付都带可编辑 PPTX（PPT-15 的"不以 PDF 替代"）。 */
      readonly editable_pptx: EditablePptxArtifact;
      readonly pdf: PdfArtifact | null;
      /** 结构化一致性报告（`fact-sync.ts` 原样输出，`ok === true` 才会走到这里）。 */
      readonly report: FactSyncReport;
      readonly preview: PresentationPreview;
      /** 从 `export-handoff.ts` 原样带出的不变式（**不另造**）。 */
      readonly invariants: readonly string[];
      readonly unverified: readonly (FactSyncUnverifiedClaim | ExportHandoffUnverifiedClaim)[];
    };

export interface PptxFactDeliveryOptions {
  /** 是否**额外**导出 PDF（不影响可编辑 PPTX 是否交付）。 */
  readonly want_pdf?: boolean;
}

function deliveryNotReady(
  kind: PptxFactDeliveryProblem,
  detail: string,
  unblockedBy: string,
  report: FactSyncReport | null,
): PptxFactDelivery {
  return Object.freeze({
    status: 'not_ready' as const,
    kind,
    detail,
    unblocked_by: unblockedBy,
    report,
    unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
  });
}

/**
 * 交付：**先对账，再出字节**。
 *
 * 顺序本身就是判据——三处数值不同版（或任一其他冲突）时**在出字节之前**被阻断，
 * 因此不存在"先产出一份漂亮 PPTX、冲突事后再说"的可能。
 *
 * @returns 未就绪（缺事实来源 / 导入源要 PDF / 导出失败 / 不变式不成立）、被冲突阻断、或已交付。
 */
export function deliverPptxFacts(
  source: PptxFactDeliverableSource,
  options?: PptxFactDeliveryOptions,
): PptxFactDelivery {
  const wantPdf = options?.want_pdf ?? false;

  if (source.facts === null) {
    return deliveryNotReady(
      'fact_source_missing',
      '事实来源缺失：不渲染、不产出字节，也不把缺失折成 0 或空串（R248）。',
      FACTS_UNBLOCKED_BY,
      null,
    );
  }

  const report = syncPresentationFacts({
    presentation: source.presentation,
    target: source.facts.target,
    bindings: source.facts.bindings,
    history: source.facts.history,
  });
  if (!report.ok) {
    return Object.freeze({
      status: 'blocked' as const,
      kind: 'fact_conflict' as const,
      detail:
        `拒绝交付：正文 / 表格 / 图表并非同一版事实（${String(report.conflicts.length)} 条冲突）。` +
        `三处数值必须来自同一事实版本，不得静默取其一。${describeFactConflicts(report)}`,
      report,
      unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
    });
  }

  if (wantPdf && source.imported !== null) {
    return deliveryNotReady(
      'pdf_requires_rebuildable_source',
      '导入的既有演示走的是"只换被改页"的逐部件保留通道，而 PDF 走的是整模型重建渲染：' +
        '两者是两次渲染，混用会让 PDF 与交付的 PPTX 不是同一份。本通道因此不产出 PDF；' +
        '要 PDF 请从不含图表的新建源交付，或先不要求 PDF。',
      '改为 want_pdf: false（仍交付可编辑 PPTX），或改用不含图表的源走重建渲染',
      report,
    );
  }

  const snapshot: FactSnapshot = asFactSnapshot(source.facts.target);
  try {
    if (source.imported === null) {
      const delivery = deliverPresentation({ presentation: source.presentation, fact_snapshot: snapshot, want_pdf: wantPdf });
      const problems = [...deliveryInvariantProblems(delivery)];
      // "还能改"的可判定形式：把交付的字节读回成模型（图表形状本域导入侧未建模 ⇒ 会在此暴露）。
      const reopened = reopenEditablePptx(delivery.editable_pptx.bytes);
      if (!reopened.openable || reopened.slide_count !== delivery.editable_pptx.slide_count) {
        problems.push(
          `交付的可编辑 PPTX 读不回或页数对不上：${reopened.problems.join('；') || '无更多信息'}`,
        );
      }
      if (problems.length > 0) {
        return deliveryNotReady('invariant_violated', problems.join('；'), '修复交付不变式后重试', report);
      }
      return Object.freeze({
        status: 'delivered' as const,
        editable_pptx: delivery.editable_pptx,
        pdf: delivery.pdf,
        report,
        preview: delivery.preview,
        invariants: delivery.invariants,
        unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
      });
    }

    const saved = exportImportedPresentation(source.imported, source.presentation, { fact_snapshot: snapshot });
    const editablePptx: EditablePptxArtifact = Object.freeze({
      bytes: saved.bytes,
      slide_count: source.presentation.slides.length,
      entry_count: saved.entry_count,
      content_digest: saved.content_digest,
      editable: true as const,
    });
    const reopened = reopenEditablePptx(editablePptx.bytes);
    if (!reopened.openable || reopened.slide_count !== editablePptx.slide_count) {
      return deliveryNotReady(
        'invariant_violated',
        `可编辑 PPTX 读回失败或页数对不上（期望 ${String(editablePptx.slide_count)} 页）：` +
          `${reopened.problems.join('；') || '无更多信息'}`,
        '修复导出通道后重试',
        report,
      );
    }
    return Object.freeze({
      status: 'delivered' as const,
      editable_pptx: editablePptx,
      pdf: null,
      report,
      preview: buildPresentationPreview(source.presentation, { fact_snapshot: snapshot }),
      invariants: EXPORT_INVARIANTS,
      unverified: PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS,
    });
  } catch (error) {
    return deliveryNotReady('export_failed', describe(error), '修复导出通道后重试', report);
  }
}

// ---------------------------------------------------------------------------
// 未验证清单（原样带出上游两份，再补本产品面的一条）
// ---------------------------------------------------------------------------

/**
 * 本适配器**本批无法验证**的断言。
 *
 * 上游两份未验证清单（`fact-sync.ts` / `export-handoff.ts`）**原样并进来**，
 * 不合并、不删改——它们各自带了"需要什么才能验证"（`requires`）。
 */
export const PPTX_FACT_PRODUCT_UNVERIFIED_CLAIMS: readonly (FactSyncUnverifiedClaim | ExportHandoffUnverifiedClaim)[] =
  Object.freeze([
    ...FACT_SYNC_UNVERIFIED_CLAIMS,
    ...EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
    Object.freeze({
      claim: '交付的 PPTX / PDF 在 Android 真机与 Office 中打开无修复提示',
      status: 'unverified' as const,
      requires: '已连接的 Android 真机 + 目标 Office 消费端',
      detail:
        '本轮未在真机 / 目标软件上实开本适配器产出的产物；本适配器只做模型层与字节层判定，' +
        '其产物"打开无修复提示"一律标未验证。',
    }),
  ]);

// ---------------------------------------------------------------------------
// 适配器（唯一实例，纯函数集合）
// ---------------------------------------------------------------------------

const FORMAT: FileFormat = 'pptx';
const TEMPLATE_KIND: TemplateKind = 'presentation';

/** 演示事实交付适配器（与 `xlsxDeliverableAdapter` 同形）。 */
export const pptxFactDeliverableAdapter: DeliverableAdapter<PptxFactDeliverableSource> = Object.freeze({
  format: FORMAT,
  template_kind: TEMPLATE_KIND,
  describe(source: PptxFactDeliverableSource): string {
    const pages = source.presentation.slides.length;
    const origin = source.imported === null ? '新建' : '导入的既有演示';
    const facts =
      source.facts === null
        ? '事实来源缺失（不得编数字）'
        : `事实版本 ${describeFactVersion(source.facts.target.version)}`;
    return `${String(pages)} 页（${origin}）；${facts}`;
  },
  exportBytes(source: PptxFactDeliverableSource): AdapterExportResult {
    if (source.facts === null) {
      return {
        ok: false,
        kind: 'not_ready',
        detail: `事实来源缺失，不产出字节（R248：缺失不当零）。${FACTS_UNBLOCKED_BY}`,
      };
    }
    const snapshot: FactSnapshot = asFactSnapshot(source.facts.target);
    try {
      if (source.imported === null) {
        const rendered = renderPresentation(source.presentation, { fact_snapshot: snapshot });
        return {
          ok: true,
          bytes: rendered.bytes,
          entry_count: rendered.entry_count,
          digest: rendered.content_digest,
        };
      }
      const saved = exportImportedPresentation(source.imported, source.presentation, { fact_snapshot: snapshot });
      return {
        ok: true,
        bytes: saved.bytes,
        entry_count: saved.entry_count,
        digest: saved.content_digest,
      };
    } catch (error) {
      return { ok: false, kind: reasonOf(error), detail: describe(error) };
    }
  },
  applyEdit: applyPptxFactEdit,
  importBytes(bytes: Uint8Array): AdapterImportResult<PptxFactDeliverableSource> {
    try {
      const imported = importPresentation(bytes);
      // 导入只拿到模型与整包：事实来源**未知** ⇒ 置 null（不是"空快照"）。
      return {
        ok: true,
        source: Object.freeze({ presentation: imported.presentation, imported, facts: null }),
      };
    } catch (error) {
      return { ok: false, kind: reasonOf(error), detail: describe(error) };
    }
  },
});

/** 版本坐标相等（供调用方判断"这次改的是不是同一版"）。 */
export function samePptxFactVersion(left: FactVersion, right: FactVersion): boolean {
  return sameFactVersion(left, right);
}

/** 事实绑定里被引用的形状 id（供调用方核对"绑定落在哪些对象上"）。 */
export function boundShapeIdList(bindings: FactBindings): readonly number[] {
  return Object.freeze([...boundShapeIds(bindings)].sort((a, b) => a - b));
}

/** 供测试 / 上层复用的类型守卫（避免调用方直接碰内部实现）。 */
export function isPptxFactDeliverableSource(value: unknown): value is PptxFactDeliverableSource {
  if (!isRecord(value)) return false;
  return isRecord(value['presentation']) && 'facts' in value && 'imported' in value;
}
