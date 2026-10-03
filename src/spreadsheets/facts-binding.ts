/**
 * XLS-18：共享事实 ↔ 表格**绑定 / 重算 / 跨模板发布**（任务包 FA-XLS-18-FACTS）。
 *
 * ## 这一层解决什么
 *
 * 用户一句话改的是**共享事实**（人数、单价、日期……）。表格里有一些格**就是**那条事实的落点，
 * 另一些公式格、图表则**间接**依赖它。XLS-18 要求把这四件事做成可核对的机器判据：
 *
 * 1. **单元格 ↔ 事实键绑定**（{@link CellFactBinding}）：一个格绑**一个**事实键 + 一个**版本**。
 *    改事实 ⇒ **只有绑定了受影响事实**的格被改写；**无关格一个字节都不动**（不是口号，
 *    见 {@link FactUpdateApplication.untouched_cell_keys} 与 {@link checkFactUpdateApplication}）。
 * 2. **重算**：改写后**复用** `recalc.ts` 的 `buildDependencyGraph` / `dependentClosure` /
 *    `recalcWorkbook` 求**受影响闭包**（本层不自造第二套重算）。**旧版本迟到不得覆盖新版本**
 *    （见 {@link mergeFactRecalcCache} 与"版本回退一律拒绝"）。
 * 3. **发布**：向文档 / PPT 发布 `{fact_key, value, version, source, at}`。**通道未接线 ⇒ 结构化
 *    `not-wired`**，`claimed_published` 恒为**字面量 `false`**——"接口点存在"与"能力已具备"必须能被区分。
 * 4. **保存重开**：写出的 .xlsx **真实字节往返**后绑定格的值仍在（见
 *    {@link checkBindingsSurviveRoundTrip}）；**绑定元数据本身不落进容器**（如实标注，不宣称）。
 *
 * ## 与既有模块的关系（**只读复用**，不改它们）
 *
 * - `recalc.ts`：依赖图 / 闭包 / 重算的**唯一实现**（本层只当调用方）；
 * - `workbook.ts` / `sheet.ts` / `value.ts` / `reference.ts` / `charts.ts`：表格模型；
 * - `xlsx-write.ts` / `xlsx-read.ts`：真实字节往返（测试里调用，本层不 import）；
 * - `src/facts/dependency-invalidation.ts`：产物级失效的**同族判据**（本层在文档里对齐其
 *   "只更新受影响 / 保留历史 / 拒绝迟到"口径，但**不**改也不重复实现它）。
 *
 * ## 纪律
 *
 * 纯函数、零 IO、无墙钟、无随机数：时间一律由调用方以 `LogicalTime` 传入。
 * **结果不得编造**：未接通道 ⇒ `not-wired`；未实测 ⇒ 标"未验证"。
 */

import { type LogicalTime, ValidationError } from '../protocol/index.js';
import { canonicalDigest } from '../dependency/digest.js';
import { compareStrings, uniqueSorted } from '../dependency/graph.js';
import {
  type CellAddress,
  type CellRange,
  formatCellAddress,
  parseCellAddress,
  parseRange,
  rangeContainsAddress,
} from './reference.js';
import { type ChartSet, type ChartState, chartReferences } from './charts.js';
import {
  type CellKey,
  type RecalcOptions,
  type RecalcReport,
  buildDependencyGraph,
  cellKey,
  dependentClosure,
  recalcWorkbook,
} from './recalc.js';
import { getCellValue, setCellValue, sheetEntries, type SheetState } from './sheet.js';
import { type CellValue, isFormula, valuesEqual } from './value.js';
import { createWorkbook, getSheet, setActiveSheet, type WorkbookState } from './workbook.js';
import type { EvalOutcome } from './evaluate.js';

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串（收到 ${JSON.stringify(value ?? null)}）`);
  }
  return value;
}

function requireVersion(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是 ≥ 0 的整数（版本号单调递增），收到 ${String(value)}`);
  }
  return value;
}

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间）`);
  }
  return value as LogicalTime;
}

// ---------------------------------------------------------------------------
// ① 单元格 ↔ 事实键绑定
// ---------------------------------------------------------------------------

/** 一个格绑定到一个事实键 + 一个版本。`ref` 是归一化 A1 文本。 */
export interface CellFactBinding {
  readonly sheet: string;
  readonly ref: string;
  /** 稳定事实键（如 `headcount` / `budget.total`）。 */
  readonly fact_key: string;
  /** 绑定格当前反映的事实版本。 */
  readonly version: number;
}

/** 绑定表（不可变；按 `"Sheet!A1"` 升序，与输入顺序无关）。 */
export interface FactBindingTable {
  readonly bindings: readonly CellFactBinding[];
}

/** 空绑定表。 */
export const EMPTY_BINDING_TABLE: FactBindingTable = Object.freeze({
  bindings: Object.freeze([] as CellFactBinding[]),
});

/** 绑定格的全局键：`"Sheet!A1"`（与 `recalc.ts` 的 `CellKey` 同一形状）。@throws {ValidationError} */
export function bindingKey(sheet: string, address: string | CellAddress): string {
  return cellKey(sheet, address);
}

function normalizeBinding(binding: CellFactBinding): CellFactBinding {
  const sheet = requireNonEmptyString(binding.sheet, 'CellFactBinding.sheet');
  const ref = formatCellAddress(parseCellAddress(binding.ref));
  const factKey = requireNonEmptyString(binding.fact_key, 'CellFactBinding.fact_key');
  const version = requireVersion(binding.version, 'CellFactBinding.version');
  return Object.freeze({ sheet, ref, fact_key: factKey, version });
}

/**
 * 绑定一个格到事实键。**同格重复绑定 ⇒ 后绑者胜**（一个格只允许一个事实键）。
 * @throws {ValidationError} 形状非法（空键 / 版本不是非负整数 / 地址非法）
 */
export function bindCell(table: FactBindingTable, binding: CellFactBinding): FactBindingTable {
  const normalized = normalizeBinding(binding);
  const key = bindingKey(normalized.sheet, normalized.ref);
  const kept = table.bindings.filter((entry) => bindingKey(entry.sheet, entry.ref) !== key);
  kept.push(normalized);
  kept.sort((left, right) => compareStrings(bindingKey(left.sheet, left.ref), bindingKey(right.sheet, right.ref)));
  return Object.freeze({ bindings: Object.freeze(kept) });
}

/** 解除一个格的绑定（无绑定时原样返回）。@throws {ValidationError} 地址非法 */
export function unbindCell(
  table: FactBindingTable,
  sheet: string,
  address: string | CellAddress,
): FactBindingTable {
  const key = bindingKey(sheet, address);
  return Object.freeze({
    bindings: Object.freeze(
      table.bindings.filter((entry) => bindingKey(entry.sheet, entry.ref) !== key),
    ),
  });
}

/** 查一个格的绑定。@throws {ValidationError} 地址非法 */
export function findBinding(
  table: FactBindingTable,
  sheet: string,
  address: string | CellAddress,
): CellFactBinding | undefined {
  const key = bindingKey(sheet, address);
  return table.bindings.find((entry) => bindingKey(entry.sheet, entry.ref) === key);
}

/** 一个事实键绑定的全部格（升序）。 */
export function bindingsForFact(table: FactBindingTable, factKey: string): readonly CellFactBinding[] {
  return Object.freeze(
    table.bindings
      .filter((entry) => entry.fact_key === factKey)
      .sort((left, right) => compareStrings(bindingKey(left.sheet, left.ref), bindingKey(right.sheet, right.ref))),
  );
}

// ---------------------------------------------------------------------------
// ② 应用事实更新 + 重算受影响闭包
// ---------------------------------------------------------------------------

/** 一次共享事实更新：新的版本 + 新的取值 + 来源 + 逻辑时间。 */
export interface FactCellUpdate {
  readonly fact_key: string;
  /** 新版本；必须**严格大于**当前绑定版本（否则按迟到 / 冲突拒绝）。 */
  readonly version: number;
  /** 要写进绑定格的取值（公式格除外——公式格不得被事实值覆盖）。 */
  readonly value: CellValue;
  /** 来源（发布载荷里同行携带；下游不必去猜）。 */
  readonly source: string;
  readonly at: LogicalTime;
}

/** 拒绝一条事实更新的封闭原因。 */
export const FACT_UPDATE_REJECTION_CODES = [
  'stale_version', // 迟到：incoming.version < 当前绑定版本
  'version_conflict', // 同版本不同值：最终值不确定，显式失败
  'unchanged_version', // 同版本同值：幂等重放，非错误但也不改写
] as const;
export type FactUpdateRejectionCode = (typeof FACT_UPDATE_REJECTION_CODES)[number];

/** 被拒绝的一条事实更新（**不写盘**，如实报告）。 */
export interface RejectedFactUpdate {
  readonly fact_key: string;
  readonly incoming_version: number;
  /** 该事实当前绑定的**最高**版本（用来解释为什么拒绝）。 */
  readonly bound_version: number;
  readonly code: FactUpdateRejectionCode;
  readonly detail: string;
}

/** 一个被改写的绑定格。 */
export interface RewrittenBoundCell {
  /** `"Sheet!A1"`。 */
  readonly key: string;
  readonly fact_key: string;
  readonly from_version: number;
  readonly to_version: number;
  readonly value: CellValue;
}

export interface FactUpdateRequest {
  readonly workbook: WorkbookState;
  readonly table: FactBindingTable;
  readonly updates: readonly FactCellUpdate[];
  /** 图表集合（可选）；受影响 = 其引用区域覆盖到被改写的绑定格。 */
  readonly charts?: readonly ChartSet[];
  /** 重算选项（如 `TODAY()` 的当前日期）。 */
  readonly recalc?: RecalcOptions;
}

/** 一次事实更新应用后的可核对产物。 */
export interface FactUpdateApplication {
  /** 新工作簿（只改写了受影响绑定格）。 */
  readonly workbook: WorkbookState;
  /** 版本推进后的绑定表。 */
  readonly table: FactBindingTable;
  /** 对新工作簿的重算报告（复用 `recalcWorkbook`）。 */
  readonly recalc: RecalcReport;
  /** 本批被接受、版本推进的事实键（升序）。 */
  readonly applied_fact_keys: readonly string[];
  /** 被拒绝的事实更新（升序）。 */
  readonly rejected: readonly RejectedFactUpdate[];
  /** 被改写的绑定格（升序）。 */
  readonly rewritten_cells: readonly RewrittenBoundCell[];
  /** 被改写的绑定格全局键（升序）。 */
  readonly rewritten_cell_keys: readonly string[];
  /** 绑定着但**本批未改**的格（升序）——"无关绑定格不改"的清单。 */
  readonly untouched_bound_cell_keys: readonly string[];
  /** 全部**未被改写**的非空格（含未绑定格，升序）——"无关信息不重写"的机器清单。 */
  readonly untouched_cell_keys: readonly string[];
  /** 受影响闭包里需要重算的公式格（升序；复用 `dependentClosure`）。 */
  readonly recalculated_formula_keys: readonly string[];
  /** 闭包内被阻塞（无值）的公式格（升序）。 */
  readonly blocked_formula_keys: readonly string[];
  /** 受影响的图表名（`"Sheet!chartName"`，升序）。 */
  readonly affected_charts: readonly string[];
  /** 未受影响的图表名（升序）。 */
  readonly untouched_charts: readonly string[];
  /** 计划摘要（确定性；含更新、改写格、拒绝项与受影响图表）。 */
  readonly digest: string;
}

function normalizeUpdates(
  updates: readonly FactCellUpdate[],
): ReadonlyMap<string, FactCellUpdate> {
  const byKey = new Map<string, FactCellUpdate>();
  for (const update of updates) {
    const key = requireNonEmptyString(update.fact_key, 'FactCellUpdate.fact_key');
    requireVersion(update.version, `FactCellUpdate(${key}).version`);
    requireNonEmptyString(update.source, `FactCellUpdate(${key}).source`);
    requireLogicalTime(update.at, `FactCellUpdate(${key}).at`);
    if (byKey.has(key)) {
      throw new ValidationError(
        `一次更新里事实键 ${key} 出现了两次：同一键的最终值不确定，必须显式失败而非任取一条`,
      );
    }
    byKey.set(key, update);
  }
  return byKey;
}

/** 用一张新工作表替换工作簿里同名表（保持活跃表身份）。 */
function withSheet(workbook: WorkbookState, next: SheetState): WorkbookState {
  const sheets = workbook.sheets.map((sheet) => (sheet.name === next.name ? next : sheet));
  const activeName = workbook.sheets[workbook.active_sheet]?.name;
  const rebuilt = createWorkbook(sheets);
  return activeName === undefined ? rebuilt : setActiveSheet(rebuilt, activeName);
}

/** 非空格的全局键集合（升序）。 */
function nonBlankCellKeys(workbook: WorkbookState): readonly string[] {
  const keys: string[] = [];
  for (const sheet of workbook.sheets) {
    for (const entry of sheetEntries(sheet)) {
      if (entry.value.kind !== 'blank') {
        keys.push(cellKey(sheet.name, entry.ref));
      }
    }
  }
  return uniqueSorted(keys);
}

/** 图表是否被"被改写的绑定格"覆盖。 */
function chartCovered(chart: ChartState, rewrittenBySheet: ReadonlyMap<string, readonly CellAddress[]>): boolean {
  for (const reference of chartReferences(chart)) {
    const addresses = rewrittenBySheet.get(reference.sheet);
    if (addresses === undefined) {
      continue;
    }
    let range: CellRange;
    try {
      range = parseRange(reference.range);
    } catch {
      continue; // 引用不是本仓可解析的区域：不构成覆盖证据（不猜）
    }
    for (const address of addresses) {
      if (rangeContainsAddress(range, address)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 应用一批共享事实更新：只改写绑定了受影响事实的格，复用 `recalc.ts` 求受影响闭包。
 *
 * @throws {ValidationError} 形状非法；绑定指向不存在的工作表；绑定格是**公式格**
 *   （公式的取值由公式决定，事实值不得覆盖它——这类误绑必须显式失败）。
 */
export function applyFactUpdates(request: FactUpdateRequest): FactUpdateApplication {
  const workbook = request.workbook;
  const table = request.table;
  const byKey = normalizeUpdates(request.updates ?? []);

  // 1. 逐格判定：哪些绑定格该改、哪些被拒。
  const accepted = new Map<string, FactCellUpdate>();
  const rejected: RejectedFactUpdate[] = [];

  const touchedFacts = uniqueSorted(
    table.bindings
      .map((binding) => binding.fact_key)
      .filter((factKey) => byKey.has(factKey)),
  );

  for (const factKey of touchedFacts) {
    const update = byKey.get(factKey);
    /* c8 ignore next -- touchedFacts 由 byKey.has 过滤而来 */
    if (update === undefined) continue;
    const cells = bindingsForFact(table, factKey);
    const highest = cells.reduce((max, entry) => Math.max(max, entry.version), 0);
    if (update.version < highest) {
      rejected.push(
        Object.freeze({
          fact_key: factKey,
          incoming_version: update.version,
          bound_version: highest,
          code: 'stale_version' as const,
          detail:
            `事实 ${factKey} 的更新版本 ${String(update.version)} 低于当前绑定版本 ${String(highest)}：` +
            '迟到的旧版本不得覆盖新版本，拒绝执行',
        }),
      );
      continue;
    }
    if (update.version === highest) {
      const alreadyEqual = cells.every((cell) => {
        const sheet = getSheet(workbook, cell.sheet);
        return sheet !== undefined && valuesEqual(getCellValue(sheet, cell.ref), update.value);
      });
      rejected.push(
        alreadyEqual
          ? Object.freeze({
              fact_key: factKey,
              incoming_version: update.version,
              bound_version: highest,
              code: 'unchanged_version' as const,
              detail: `事实 ${factKey} 的版本与绑定版本相同且取值一致：幂等重放，不改写`,
            })
          : Object.freeze({
              fact_key: factKey,
              incoming_version: update.version,
              bound_version: highest,
              code: 'version_conflict' as const,
              detail:
                `事实 ${factKey} 的版本 ${String(update.version)} 与当前绑定版本相同，但取值不同：` +
                '同一版本的最终值不确定，显式失败而非任取一条',
            }),
      );
      continue;
    }
    accepted.set(factKey, update);
  }

  // 2. 改写：只动被接受的绑定格。
  const rewritten: RewrittenBoundCell[] = [];
  const rewrittenBySheet = new Map<string, CellAddress[]>();
  let nextWorkbook = workbook;
  for (const factKey of uniqueSorted([...accepted.keys()])) {
    const update = accepted.get(factKey);
    /* c8 ignore next -- 键来自 accepted 自身 */
    if (update === undefined) continue;
    for (const cell of bindingsForFact(table, factKey)) {
      const sheet = getSheet(nextWorkbook, cell.sheet);
      if (sheet === undefined) {
        throw new ValidationError(
          `绑定格 ${bindingKey(cell.sheet, cell.ref)} 指向不存在的工作表 ${JSON.stringify(cell.sheet)}`,
        );
      }
      const current = getCellValue(sheet, cell.ref);
      if (isFormula(current)) {
        throw new ValidationError(
          `绑定格 ${bindingKey(cell.sheet, cell.ref)} 是公式格：公式的取值由公式决定，` +
            '事实值不得覆盖它（这是必须显式失败的误绑，不是可以就近套用的场景）',
        );
      }
      nextWorkbook = withSheet(nextWorkbook, setCellValue(sheet, cell.ref, update.value));
      rewritten.push(
        Object.freeze({
          key: bindingKey(cell.sheet, cell.ref),
          fact_key: factKey,
          from_version: cell.version,
          to_version: update.version,
          value: update.value,
        }),
      );
      const bucket = rewrittenBySheet.get(cell.sheet);
      if (bucket === undefined) {
        rewrittenBySheet.set(cell.sheet, [parseCellAddress(cell.ref)]);
      } else {
        bucket.push(parseCellAddress(cell.ref));
      }
    }
  }
  rewritten.sort((left, right) => compareStrings(left.key, right.key));
  const rewrittenKeys = rewritten.map((entry) => entry.key);

  // 3. 版本推进后的绑定表。
  let nextTable = table;
  for (const factKey of uniqueSorted([...accepted.keys()])) {
    const update = accepted.get(factKey);
    /* c8 ignore next -- 同上 */
    if (update === undefined) continue;
    for (const cell of bindingsForFact(nextTable, factKey)) {
      nextTable = bindCell(nextTable, { ...cell, version: update.version });
    }
  }

  // 4. 复用 recalc.ts 求受影响闭包（只算受影响者，无关公式不在闭包内）。
  const report = recalcWorkbook(nextWorkbook, request.recalc ?? {});
  const graph = buildDependencyGraph(nextWorkbook);
  const closure = dependentClosure(graph, rewrittenKeys as readonly CellKey[]);
  const closureSet = new Set<string>(closure);
  const blockedFormulaKeys = uniqueSorted(
    report.blocked.map((block) => block.key).filter((key) => closureSet.has(key)),
  );

  // 5. 图表受影响判定。
  const allCharts: { readonly key: string; readonly chart: ChartState }[] = [];
  for (const set of request.charts ?? []) {
    for (const chart of set.charts) {
      allCharts.push({ key: `${set.sheet}!${chart.name}`, chart });
    }
  }
  allCharts.sort((left, right) => compareStrings(left.key, right.key));
  const affectedCharts = allCharts
    .filter((entry) => chartCovered(entry.chart, rewrittenBySheet))
    .map((entry) => entry.key);
  const untouchedCharts = allCharts
    .filter((entry) => !chartCovered(entry.chart, rewrittenBySheet))
    .map((entry) => entry.key);

  // 6. 无关格清单：全部非空格 − 被改写格。
  const rewrittenSet = new Set(rewrittenKeys);
  const untouchedCellKeys = nonBlankCellKeys(workbook).filter((key) => !rewrittenSet.has(key));
  const boundKeys = new Set(table.bindings.map((entry) => bindingKey(entry.sheet, entry.ref)));
  const untouchedBoundCellKeys = untouchedCellKeys.filter((key) => boundKeys.has(key));

  const digest = canonicalDigest(
    JSON.stringify([
      rewritten.map((entry) => [entry.key, entry.fact_key, entry.from_version, entry.to_version]),
      rejected.map((entry) => [entry.fact_key, entry.incoming_version, entry.bound_version, entry.code]),
      closure,
      affectedCharts,
      untouchedCharts,
    ]),
  );

  return Object.freeze({
    workbook: nextWorkbook,
    table: nextTable,
    recalc: report,
    applied_fact_keys: Object.freeze(uniqueSorted([...accepted.keys()])),
    rejected: Object.freeze(rejected.sort((left, right) => compareStrings(left.fact_key, right.fact_key))),
    rewritten_cells: Object.freeze(rewritten),
    rewritten_cell_keys: Object.freeze(rewrittenKeys),
    untouched_bound_cell_keys: Object.freeze(untouchedBoundCellKeys),
    untouched_cell_keys: Object.freeze(untouchedCellKeys),
    recalculated_formula_keys: Object.freeze([...closure]),
    blocked_formula_keys: Object.freeze(blockedFormulaKeys),
    affected_charts: Object.freeze(affectedCharts),
    untouched_charts: Object.freeze(untouchedCharts),
    digest,
  });
}

// ---------------------------------------------------------------------------
// 版本化重算缓存：旧版本迟到不得覆盖新版本
// ---------------------------------------------------------------------------

/** 带版本号的重算缓存（`revision` 通常是任务版本 / 事实版本）。 */
export interface FactRecalcCache {
  readonly revision: number;
  readonly values: ReadonlyMap<CellKey, EvalOutcome>;
}

export interface FactRecalcCacheMerge {
  /** `true` = 采纳 incoming；`false` = 保留 current（incoming 迟到）。 */
  readonly accepted: boolean;
  readonly cache: FactRecalcCache;
  /** 被拒绝时的原因；被采纳时为 `null`。 */
  readonly reason: string | null;
}

/**
 * 合并版本化重算缓存：**旧版本迟到不得覆盖新版本**。
 *
 * `incoming.revision < current.revision` ⇒ 拒绝（保留 current）；
 * 相等 ⇒ 拒绝（同版本重放，无新信息）；更大 ⇒ 采纳。
 * `current` 缺省 ⇒ 直接采纳。
 */
export function mergeFactRecalcCache(
  current: FactRecalcCache | undefined,
  incoming: FactRecalcCache,
): FactRecalcCacheMerge {
  requireVersion(incoming.revision, 'FactRecalcCache.revision');
  if (current === undefined) {
    return Object.freeze({ accepted: true, cache: incoming, reason: null });
  }
  requireVersion(current.revision, 'FactRecalcCache.revision');
  if (incoming.revision < current.revision) {
    return Object.freeze({
      accepted: false,
      cache: current,
      reason:
        `重算缓存版本 ${String(incoming.revision)} 早于现有版本 ${String(current.revision)}：` +
        '迟到的旧缓存不得覆盖新版本，保留现有缓存',
    });
  }
  if (incoming.revision === current.revision) {
    return Object.freeze({
      accepted: false,
      cache: current,
      reason: `重算缓存版本 ${String(incoming.revision)} 与现有版本相同：无新信息，保留现有缓存`,
    });
  }
  return Object.freeze({ accepted: true, cache: incoming, reason: null });
}

// ---------------------------------------------------------------------------
// ③ 向文档 / PPT 发布同版事实（通道未接线 ⇒ 结构化 not-wired）
// ---------------------------------------------------------------------------

/** 发布载荷：`{fact_key, value, version, source, at}`（下游不必去猜来源与时间）。 */
export interface SharedFactPublication {
  readonly fact_key: string;
  readonly value: CellValue;
  readonly version: number;
  readonly source: string;
  readonly at: LogicalTime;
}

/** 跨模板发布的目标（文档 / PPT）。 */
export type PublicationTarget = 'docx' | 'pptx';

/** 全部目标（顺序固定，保证输出确定性）。 */
export const PUBLICATION_TARGETS: readonly PublicationTarget[] = Object.freeze(['docx', 'pptx']);

/** 一个目标的发布通道。未装配的目标 ⇒ 结果标 `not-wired`。 */
export interface CrossTemplatePublishPort {
  readonly target: PublicationTarget;
  publish(
    facts: readonly SharedFactPublication[],
  ): Promise<
    | { readonly ok: true; readonly receipt_ref: string }
    | { readonly ok: false; readonly reason: string }
  >;
}

/** 通道接线状态。 */
export type PublicationWireState = 'not-wired' | 'published' | 'failed';

/** 某目标的发布结果。 */
export interface TemplatePublicationResult {
  readonly target: PublicationTarget;
  readonly wire_state: PublicationWireState;
  /** 只有通道给出**带 `receipt_ref`** 的受理回执才为 `true`。 */
  readonly acknowledged: boolean;
  readonly receipt_ref: string | null;
  readonly reason: string | null;
  readonly fact_count: number;
  /**
   * **恒为字面量 `false`**：本模块**不**宣称"已在文档 / PPT 用户可见处生效"。
   * 未接线时是 `not-wired`；接线后也只有通道受理回执，谈不上"已发布到用户可见处"。
   */
  readonly claimed_published: false;
}

export interface SharedFactPublicationRequest {
  readonly channels: readonly CrossTemplatePublishPort[];
  readonly publications: readonly SharedFactPublication[];
}

const NOT_WIRED_REASON =
  '未接该模板的"同版事实"发布通道：文档 / PPT 池的接线不在本包写权内。' +
  '未接下游前不宣称已在其他模板生效（XLS-18）。';

/**
 * 向所有已装配的目标发布同版事实；未装配的目标逐个如实标 `not-wired`。
 *
 * **这是纯发布点**：不落盘、不改工作簿；即便通道回执 `ok: true`，也只把它记作**受理回执**，
 * `claimed_published` 仍恒为 `false`。
 */
export async function publishSharedFacts(
  request: SharedFactPublicationRequest,
): Promise<readonly TemplatePublicationResult[]> {
  const facts = request.publications ?? [];
  const results: TemplatePublicationResult[] = [];
  for (const target of PUBLICATION_TARGETS) {
    const channel = request.channels.find((item) => item.target === target);
    if (channel === undefined) {
      results.push(
        Object.freeze({
          target,
          wire_state: 'not-wired' as const,
          acknowledged: false,
          receipt_ref: null,
          reason: NOT_WIRED_REASON,
          fact_count: 0,
          claimed_published: false as const,
        }),
      );
      continue;
    }
    const response = await channel.publish(facts);
    if (!response.ok) {
      results.push(
        Object.freeze({
          target,
          wire_state: 'failed' as const,
          acknowledged: false,
          receipt_ref: null,
          reason: `通道发布失败：${response.reason}`,
          fact_count: facts.length,
          claimed_published: false as const,
        }),
      );
      continue;
    }
    const hasReceipt = response.receipt_ref.trim() !== '';
    results.push(
      Object.freeze({
        target,
        wire_state: 'published' as const,
        acknowledged: hasReceipt,
        receipt_ref: response.receipt_ref,
        reason: null,
        fact_count: facts.length,
        claimed_published: false as const,
      }),
    );
  }
  return Object.freeze(results);
}

/** 未接线的目标清单（供展示层显式提示"尚未生效"）。 */
export function listUnwiredTargets(
  results: readonly TemplatePublicationResult[],
): readonly PublicationTarget[] {
  return Object.freeze(
    results.filter((result) => result.wire_state === 'not-wired').map((result) => result.target),
  );
}

// ---------------------------------------------------------------------------
// ④ 保存重开的文件层往返
// ---------------------------------------------------------------------------

export interface BindingRoundTripMismatch {
  readonly key: string;
  readonly fact_key: string;
  readonly before: CellValue;
  readonly after: CellValue;
}

export interface BindingRoundTripCheck {
  /** 全部绑定格读回后与写前**逐类相等**（`valuesEqual`，类别不同即不等）⇒ `true`。 */
  readonly ok: boolean;
  readonly checked_cell_keys: readonly string[];
  readonly missing_cell_keys: readonly string[];
  readonly mismatches: readonly BindingRoundTripMismatch[];
  /**
   * **恒为 `false`**：绑定元数据（fact_key / version）**不落进 .xlsx 容器**——
   * 写权内没有容器槽位。因此本检查只断言**绑定格的值**经字节往返后仍在；
   * 绝不宣称"绑定表随文件保存"。
   */
  readonly binding_metadata_persisted: false;
}

/**
 * 核对绑定格的值是否**经真实字节往返**后仍在：逐格比对 `before`（写前）与 `after`（读回）。
 *
 * 本函数只做比对，不写盘——真实字节往返由调用方用 `writeWorkbookXlsx` / `readWorkbookXlsx` 完成。
 * @throws {ValidationError} 绑定指向不存在的工作表
 */
export function checkBindingsSurviveRoundTrip(
  table: FactBindingTable,
  before: WorkbookState,
  after: WorkbookState,
): BindingRoundTripCheck {
  const checked: string[] = [];
  const missing: string[] = [];
  const mismatches: BindingRoundTripMismatch[] = [];
  for (const binding of table.bindings) {
    const key = bindingKey(binding.sheet, binding.ref);
    checked.push(key);
    const beforeSheet = getSheet(before, binding.sheet);
    const afterSheet = getSheet(after, binding.sheet);
    if (beforeSheet === undefined || afterSheet === undefined) {
      throw new ValidationError(
        `绑定格 ${key} 的工作表 ${JSON.stringify(binding.sheet)} 在写前 / 读回工作簿里不存在`,
      );
    }
    const written = getCellValue(beforeSheet, binding.ref);
    const readBack = getCellValue(afterSheet, binding.ref);
    if (readBack.kind === 'blank') {
      missing.push(key);
      mismatches.push(
        Object.freeze({ key, fact_key: binding.fact_key, before: written, after: readBack }),
      );
      continue;
    }
    if (!valuesEqual(written, readBack)) {
      mismatches.push(
        Object.freeze({ key, fact_key: binding.fact_key, before: written, after: readBack }),
      );
    }
  }
  return Object.freeze({
    ok: missing.length === 0 && mismatches.length === 0,
    checked_cell_keys: Object.freeze([...checked].sort(compareStrings)),
    missing_cell_keys: Object.freeze([...missing].sort(compareStrings)),
    mismatches: Object.freeze(mismatches),
    binding_metadata_persisted: false as const,
  });
}

// ---------------------------------------------------------------------------
// 反向对照：应然 vs 实然（本层自带的"抓错器"）
// ---------------------------------------------------------------------------

export const FACT_BINDING_VIOLATION_CODES = [
  'unrelated_cell_rewritten', // 无关格（未绑定 / 未受影响）被改写
  'affected_cell_not_rewritten', // 受影响绑定格该改没改
  'stale_update_applied', // 被拒（迟到 / 冲突）的更新仍被应用
  'claimed_published_without_wire', // 无通道却宣称已发布
] as const;
export type FactBindingViolationCode = (typeof FACT_BINDING_VIOLATION_CODES)[number];

export interface FactBindingViolation {
  readonly code: FactBindingViolationCode;
  readonly subject_id: string;
  readonly detail: string;
}

/** "实然"观测：实现实际改了哪些格、哪些更新被应用、向哪些目标宣称了发布。 */
export interface FactUpdateObservation {
  /** 实际被改写的单元格全局键。 */
  readonly rewritten_cell_keys: readonly string[];
  /** 实际被应用（写进工作簿）的事实键（可选；给出时才判"迟到是否被应用"）。 */
  readonly applied_fact_keys?: readonly string[];
  /** 实际宣称的发布（可选；给出时才判"无通道是否宣称已发布"）。 */
  readonly publication_claims?: readonly {
    readonly target: PublicationTarget;
    readonly claimed_published: boolean;
    readonly wire_state: PublicationWireState;
  }[];
}

function violation(
  code: FactBindingViolationCode,
  subjectId: string,
  detail: string,
): FactBindingViolation {
  return Object.freeze({ code, subject_id: subjectId, detail });
}

/**
 * 用"计划的应然"核验"实现的实然"，返回全部违规（不抛错、一次收齐）。
 * 空数组 ⟺ 实现与计划一致。
 */
export function checkFactUpdateApplication(
  application: FactUpdateApplication,
  observation: FactUpdateObservation,
): readonly FactBindingViolation[] {
  const violations: FactBindingViolation[] = [];
  const expectedRewrites = new Set(application.rewritten_cell_keys);
  const untouched = new Set(application.untouched_cell_keys);

  const seen = new Set<string>();
  for (const key of observation.rewritten_cell_keys) {
    if (seen.has(key)) {
      violations.push(violation('unrelated_cell_rewritten', key, `格 ${key} 被写了不止一次：一次变更里同一格只允许改写一次`));
      continue;
    }
    seen.add(key);
    if (!expectedRewrites.has(key)) {
      violations.push(
        violation(
          'unrelated_cell_rewritten',
          key,
          untouched.has(key)
            ? `格 ${key} 未绑定受影响事实，却被改写：无关信息不得重写（XLS-18）`
            : `格 ${key} 不在受影响改写集合内，却被改写`,
        ),
      );
    }
  }

  for (const key of [...expectedRewrites].sort(compareStrings)) {
    if (!seen.has(key)) {
      violations.push(
        violation('affected_cell_not_rewritten', key, `绑定格 ${key} 绑定了被改事实，却没有被改写：受影响格必须同版更新`),
      );
    }
  }

  if (observation.applied_fact_keys !== undefined) {
    const rejected = new Set(application.rejected.map((entry) => entry.fact_key));
    for (const key of [...observation.applied_fact_keys].sort(compareStrings)) {
      if (rejected.has(key)) {
        violations.push(
          violation('stale_update_applied', key, `事实 ${key} 的更新已被判拒绝（迟到 / 冲突），却仍被应用：旧版本不得覆盖新版本`),
        );
      }
    }
  }

  for (const claim of observation.publication_claims ?? []) {
    if (claim.claimed_published && claim.wire_state !== 'published') {
      violations.push(
        violation(
          'claimed_published_without_wire',
          claim.target,
          `目标 ${claim.target} 的通道状态是 ${claim.wire_state}，却宣称已发布：无通道不得声称已发布（XLS-18）`,
        ),
      );
    }
  }

  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------
// 可读输出（证据 / 断言失败信息用）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⑤ 同版快照的**消费**回执（XLS-18："同版目标实际消费有回执，未接线不能宣称同步完成"）
//
// ④ 的发布只解决"表格 → 文档 / PPT"这一半。XLS-18 的另一半是**表格作为消费端**：
// 拿到的共享事实快照到底有没有**真的被消费**（写进绑定格 / 被下游读到），必须有一张
// 带 `receipt_ref` 的回执。没有回执就只能如实标 `not-wired` / `failed`，**不得**因为
// "端口对象存在"就宣称"已同步"。
// ---------------------------------------------------------------------------

/** 一条共享事实的取值 + 单位（FactsPort 契约里的 `values`/`units`）。 */
export interface SharedFactSnapshotValue {
  readonly fact_key: string;
  readonly value: CellValue;
  /** 单位 / 币种标识；无单位时 `null`（**不是空串**，免得与"名为空的单位"混淆）。 */
  readonly unit: string | null;
}

/**
 * **同版共享事实快照**（FactsPort v1：`snapshotId, revision, sourceRefs, values, units`）。
 *
 * `revision` 是**快照版本**：消费回执必须回带同一版本号，跨版本消费一律判为不同步。
 */
export interface SharedFactSnapshot {
  readonly snapshot_id: string;
  readonly revision: number;
  /** 快照的来源引用（哪份文档 / 表格 / 幻灯片产出，供审计）。 */
  readonly source_refs: readonly string[];
  readonly values: readonly SharedFactSnapshotValue[];
  readonly at: LogicalTime;
}

/** 消费回执：**实际消费**的证据（由消费端在真正写入 / 读到之后才签发）。 */
export interface FactConsumptionReceipt {
  /** 消费端标识（如 `'xlsx'`）。 */
  readonly consumer: string;
  /** 被消费的快照 id（必须与快照一致，防止"拿 A 的回执顶 B 的账"）。 */
  readonly snapshot_id: string;
  /** 回执回带的快照版本（必须与快照 `revision` 相等，这就是"同版"的判据）。 */
  readonly revision: number;
  /** 实际消费（写进绑定格 / 读到）的事实键（升序）。 */
  readonly consumed_fact_keys: readonly string[];
  /** 回执引用（非空字符串才被认作真实回执）。 */
  readonly receipt_ref: string;
  readonly consumed_at: LogicalTime;
}

/** 消费端口：同版快照 → 带 `receipt_ref` 的消费回执。未装配 ⇒ 结果标 `not-wired`。 */
export interface SameVersionConsumePort {
  readonly consumer: string;
  consume(
    snapshot: SharedFactSnapshot,
  ): Promise<{ readonly ok: true; readonly receipt: FactConsumptionReceipt } | { readonly ok: false; readonly reason: string }>;
}

/** 消费通道状态。 */
export type ConsumptionWireState = 'not-wired' | 'consumed' | 'failed';

/** 一次同版消费的结果（可核对产物）。 */
export interface SameVersionConsumptionResult {
  readonly consumer: string;
  readonly wire_state: ConsumptionWireState;
  /** 只有通道给出**同版**且带非空 `receipt_ref` 的回执才为 `true`。 */
  readonly consumed: boolean;
  readonly receipt: FactConsumptionReceipt | null;
  readonly reason: string | null;
  readonly snapshot_id: string;
  readonly snapshot_revision: number;
  /** 回执版本是否与快照版本一致（`consumed` 为真的必要条件）。 */
  readonly version_matched: boolean;
  readonly fact_count: number;
}

const NOT_WIRED_CONSUME_REASON =
  '未接"同版共享事实"消费通道：无法证明快照真的被本模板消费。' +
  '未接下游前不得宣称已同步（XLS-18）——只能如实标 not-wired。';

function emptyConsumptionResult(
  consumer: string,
  snapshot: SharedFactSnapshot,
  wireState: ConsumptionWireState,
  reason: string,
  versionMatched: boolean,
  offendingReceipt: FactConsumptionReceipt | null = null,
): SameVersionConsumptionResult {
  return Object.freeze({
    consumer,
    wire_state: wireState,
    consumed: false,
    // 失败时**保留**端口实际回带的回执（哪怕版本 / 来源不符）：它是"为什么拒绝"的证据，
    // 供 {@link checkSameVersionConsumption} 机器化判定，而不是丢掉后只剩一句人话原因。
    receipt: offendingReceipt,
    reason,
    snapshot_id: snapshot.snapshot_id,
    snapshot_revision: snapshot.revision,
    version_matched: versionMatched,
    fact_count: snapshot.values.length,
  });
}

/**
 * 消费一份**同版**共享事实快照，要求回带真实回执。
 *
 * - 端口未装配 ⇒ `not-wired`，`consumed: false`（**不因接口点存在而宣称已同步**）；
 * - 端口失败 ⇒ `failed`；
 * - 端口回执的 `snapshot_id` / `revision` 与快照不符 ⇒ `failed`（**同版**是硬条件，
 *   版本或来源对不上就不认这次消费，而不是"看起来有回执就算数"）；
 * - 回执 `receipt_ref` 为空 ⇒ `failed`（一张没有引用号的回执不是证据）。
 *
 * @throws {ValidationError} 快照形状非法（空 id / 版本不是非负整数）
 */
export async function consumeSharedFactSnapshot(
  port: SameVersionConsumePort | undefined,
  snapshot: SharedFactSnapshot,
): Promise<SameVersionConsumptionResult> {
  const snapshotId = requireNonEmptyString(snapshot.snapshot_id, 'SharedFactSnapshot.snapshot_id');
  requireVersion(snapshot.revision, 'SharedFactSnapshot.revision');
  if (port === undefined) {
    return emptyConsumptionResult('xlsx', snapshot, 'not-wired', NOT_WIRED_CONSUME_REASON, false);
  }
  const response = await port.consume(snapshot);
  if (!response.ok) {
    return emptyConsumptionResult(
      port.consumer,
      snapshot,
      'failed',
      `消费通道失败：${response.reason}`,
      false,
    );
  }
  const receipt = response.receipt;
  const receiptRef = receipt.receipt_ref.trim();
  if (receipt.snapshot_id !== snapshotId) {
    return emptyConsumptionResult(
      port.consumer,
      snapshot,
      'failed',
      `回执的 snapshot_id ${JSON.stringify(receipt.snapshot_id)} 与快照 ${JSON.stringify(snapshotId)} 不符：不认这次消费`,
      false,
      receipt,
    );
  }
  if (receipt.revision !== snapshot.revision) {
    return emptyConsumptionResult(
      port.consumer,
      snapshot,
      'failed',
      `回执版本 ${String(receipt.revision)} 与快照版本 ${String(snapshot.revision)} 不符：跨版本消费不得声称同版同步`,
      false,
      receipt,
    );
  }
  if (receiptRef === '') {
    return emptyConsumptionResult(
      port.consumer,
      snapshot,
      'failed',
      '回执缺少非空 receipt_ref：没有引用号的回执不是消费证据',
      false,
      receipt,
    );
  }
  return Object.freeze({
    consumer: port.consumer,
    wire_state: 'consumed' as const,
    consumed: true,
    receipt: Object.freeze({ ...receipt, consumed_fact_keys: Object.freeze([...receipt.consumed_fact_keys]) }),
    reason: null,
    snapshot_id: snapshotId,
    snapshot_revision: snapshot.revision,
    version_matched: true,
    fact_count: snapshot.values.length,
  });
}

// ---------------------------------------------------------------------------
// 消费回执的反向对照（应然 vs 实然）
// ---------------------------------------------------------------------------

export const CONSUMPTION_VIOLATION_CODES = [
  'claimed_without_receipt', // 宣称已消费却拿不出回执
  'version_mismatch', // 回执版本与快照版本不符（跨版本冒充同版）
  'snapshot_mismatch', // 回执来源快照与目标快照不符
  'unconsumed_fact_claim', // 回执里"已消费"的事实键不在快照内（凭空多出来）
] as const;
export type ConsumptionViolationCode = (typeof CONSUMPTION_VIOLATION_CODES)[number];

export interface ConsumptionViolation {
  readonly code: ConsumptionViolationCode;
  readonly subject_id: string;
  readonly detail: string;
}

function consumptionViolation(
  code: ConsumptionViolationCode,
  subjectId: string,
  detail: string,
): ConsumptionViolation {
  return Object.freeze({ code, subject_id: subjectId, detail });
}

/**
 * 用"快照 = 应然"核验"消费结果 = 实然"，返回全部违规（不抛错、一次收齐）。
 * 空数组 ⟺ 消费结果与快照一致且证据齐全。
 */
export function checkSameVersionConsumption(
  snapshot: SharedFactSnapshot,
  result: SameVersionConsumptionResult,
): readonly ConsumptionViolation[] {
  const violations: ConsumptionViolation[] = [];
  const { receipt } = result;

  if (receipt === null) {
    if (result.consumed) {
      violations.push(
        consumptionViolation(
          'claimed_without_receipt',
          snapshot.snapshot_id,
          `消费品声称已消费，却没有回执：无回执不得声称同版同步（XLS-18）`,
        ),
      );
    }
  } else if (receipt.receipt_ref.trim() === '') {
    violations.push(
      consumptionViolation(
        'claimed_without_receipt',
        snapshot.snapshot_id,
        `回执缺少非空 receipt_ref：没有引用号的回执不是消费证据`,
      ),
    );
  }

  if (receipt !== null) {
    if (receipt.revision !== snapshot.revision) {
      violations.push(
        consumptionViolation(
          'version_mismatch',
          snapshot.snapshot_id,
          `回执版本 ${String(receipt.revision)} 与快照版本 ${String(snapshot.revision)} 不符`,
        ),
      );
    }
    if (receipt.snapshot_id !== snapshot.snapshot_id) {
      violations.push(
        consumptionViolation(
          'snapshot_mismatch',
          snapshot.snapshot_id,
          `回执来源快照 ${JSON.stringify(receipt.snapshot_id)} 与目标快照 ${JSON.stringify(snapshot.snapshot_id)} 不符`,
        ),
      );
    }
    const known = new Set(snapshot.values.map((entry) => entry.fact_key));
    for (const key of receipt.consumed_fact_keys) {
      if (!known.has(key)) {
        violations.push(
          consumptionViolation('unconsumed_fact_claim', key, `回执声称消费了事实 ${key}，但它不在快照内`),
        );
      }
    }
  }

  return Object.freeze(violations);
}

/** 单行摘要：消费端、通道状态、快照版本与事实数。 */
export function describeConsumption(result: SameVersionConsumptionResult): string {
  const receipt = result.receipt === null ? '无回执' : `回执 ${result.receipt.receipt_ref}`;
  return (
    `消费端 ${result.consumer}：${result.wire_state}（${receipt}）；` +
    `快照 ${result.snapshot_id}@${String(result.snapshot_revision)}；` +
    `同版=${result.version_matched ? '是' : '否'}；事实 ${String(result.fact_count)} 条`
  );
}

// ---------------------------------------------------------------------------
// 可读输出（证据 / 断言失败信息用）
// ---------------------------------------------------------------------------

/** 单行摘要：改了哪些格、拒了哪些、图表与重算面。 */
export function describeFactUpdateApplication(application: FactUpdateApplication): string {
  return (
    `改写 ${String(application.rewritten_cell_keys.length)} 格` +
    `（${application.rewritten_cell_keys.join(', ') || '无'}）；` +
    `拒绝 ${String(application.rejected.length)} 条；` +
    `需重算公式 ${String(application.recalculated_formula_keys.length)} 个；` +
    `受影响图表 ${String(application.affected_charts.length)} 个；` +
    `无关非空格 ${String(application.untouched_cell_keys.length)} 个`
  );
}
