/**
 * **表格编辑事务会话**（XLS-01 / XLS-17 / XLS-18；X10 独占包）。
 *
 * ## 这个文件把三件之前分散的能力接成一条链
 *
 * | 能力 | 之前 | 本文件 |
 * |---|---|---|
 * | 事务性编辑 | `history.commit` 只会"改一次、失败保旧"，没有"一批操作要么全成要么全不做"的入口 | {@link SpreadsheetSession.applyBatch}：先把整批操作跑在**私有草稿**上，任一失败 ⇒ 丢弃草稿、源逐字节未动 |
 * | 完整操作面 | 适配器只有 6 个 op | 走 {@link ./operations.js} 的 18 个 op 注册表 |
 * | 版本与恢复 | `undo` / `redo` 只走一步；无落盘快照 | {@link SpreadsheetSession.undo} / `redo` / `restore` 走任意版本；{@link SpreadsheetSession.snapshot} / `SpreadsheetSession.restore` 给 JSON 安全快照与重建 |
 *
 * ## 事务的判据是**字节**，不是"看着没变"
 *
 * 失败路径里，本会话**从不**把草稿写回历史；{@link SpreadsheetSession.sourceDigest} 在失败前后
 * 相等，是这台机器可核对的"源零改动"。草稿由 `history.cloneWorkbook` 造出（cells `Map`
 * 也深拷贝），因此"改到一半抛错"污染不了规范状态。
 *
 * ## 恢复：落盘 → 读回
 *
 * {@link SpreadsheetSession.snapshot} 产出**纯 JSON 值**（`Map` / `Uint8Array` 经
 * `src/session/persistence.ts` 的 `$map` / `$bytes` 标记），{@link SpreadsheetSession.restore}
 * 读回并**结构校验**每张快照的工作簿；schema 不符或工作簿非法 ⇒ 抛错（**不猜**、不"尽量恢复"）。
 *
 * ## 纪律
 *
 * 纯函数 + 纯数据；零 IO、零墙钟、零随机数（落盘由调用方把 snapshot 交给 StoragePort）。
 */

import { ValidationError, type LogicalTime } from '../../../protocol/index.js';
import { canonicalDigest } from '../../../dependency/digest.js';
import {
  assertWorkbookShape,
  cloneWorkbook,
  commit,
  createHistory,
  currentRevision,
  knownRevisions,
  redo,
  restoreAt,
  undo,
  versionTimeline,
  type HistorySnapshot,
  type HistoryState,
  type VersionEntry,
} from '../../../spreadsheets/history.js';
import type { WorkbookState } from '../../../spreadsheets/workbook.js';
import { EMPTY_RESIDUAL, type XlsxResidual } from '../../../spreadsheets/xlsx-write.js';
import {
  applyFactUpdates,
  EMPTY_BINDING_TABLE,
  type CellFactBinding,
  type FactBindingTable,
  type FactCellUpdate,
  type FactUpdateApplication,
  type RejectedFactUpdate,
} from '../../../spreadsheets/facts-binding.js';
import { decodeSessionState, encodeSessionState } from '../../../session/persistence.js';
import type { XlsxDeliverableSource } from '../../../session/adapters/xlsx.js';
import { applySpreadsheetOperation } from './operations.js';

/** 快照 schema 标识（落盘写入、读回核对）。 */
export const SPREADSHEET_SESSION_SCHEMA = 'potbot-spreadsheet-session.v1';

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

/** 一次应用（编辑 / 批量 / 事实更新）的结构化失败。 */
export interface SessionApplyFailure {
  readonly kind: string;
  readonly detail: string;
}

/** 一条步骤日志（可持久化，供审计与恢复）。 */
export interface SpreadsheetStep {
  readonly seq: number;
  /** 本条提交后的版本（被拒时为提交前的版本）。 */
  readonly revision: number;
  readonly label: string;
  readonly op_names: readonly string[];
  readonly changed: boolean;
  /** 成功为 `null`；失败带结构化原因。 */
  readonly failure: SessionApplyFailure | null;
}

/** 一次编辑应用的结果。 */
export interface SessionEditOutcome {
  readonly ok: boolean;
  readonly revision: number;
  readonly changed: boolean;
  readonly failure: SessionApplyFailure | null;
  /** 失败时：`true` = 整批回滚，源零改动（事务的机器判据）。 */
  readonly rolled_back: boolean;
  readonly notes: readonly string[];
}

/** 一次事实更新的结果（在编辑结果上补事实面）。 */
export interface SessionFactOutcome extends SessionEditOutcome {
  readonly applied_fact_keys: readonly string[];
  readonly rejected: readonly RejectedFactUpdate[];
  readonly rewritten_cell_keys: readonly string[];
  readonly recalculated_formula_keys: readonly string[];
}

/** 版本跳转结果（撤销 / 重做 / 恢复到某版本）。 */
export type SessionVersionOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: string };

/** 可 JSON 落盘的会话快照（`Map` / `Uint8Array` 已编码）。 */
export interface SpreadsheetSessionSnapshot {
  readonly schema: typeof SPREADSHEET_SESSION_SCHEMA;
  readonly session_id: string;
  readonly revision: number;
  /** 编码后的 {@link HistoryState}（past / present / future 各一份快照）。 */
  readonly history: unknown;
  /** 编码后的 {@link XlsxResidual}。 */
  readonly residual: unknown;
  readonly bindings: readonly CellFactBinding[];
  readonly log: readonly SpreadsheetStep[];
}

export interface SpreadsheetSessionOptions {
  readonly session_id?: string;
  readonly source: XlsxDeliverableSource;
  readonly bindings?: FactBindingTable;
  /** 初始快照的标签（默认 `initial`）。 */
  readonly initial_label?: string;
}

// ---------------------------------------------------------------------------
// 恢复路径的形状核对
// ---------------------------------------------------------------------------

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${where} 不是对象（收到 ${JSON.stringify(value ?? null)}）`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${where} 不是数组`);
  }
  return value;
}

function reviveSnapshot(raw: unknown, where: string): HistorySnapshot {
  const record = asRecord(raw, where);
  const revision = record['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new ValidationError(`${where}.revision 不是非负整数`);
  }
  const label = record['label'];
  if (typeof label !== 'string' || label.length === 0) {
    throw new ValidationError(`${where}.label 不是非空字符串`);
  }
  const workbook = record['workbook'];
  assertWorkbookShape(workbook, where);
  return Object.freeze({ revision, label, workbook });
}

function reviveHistory(raw: unknown): HistoryState {
  const record = asRecord(raw, 'history');
  const past = readArray(record['past'], 'history.past').map((entry, index) =>
    reviveSnapshot(entry, `history.past[${String(index)}]`),
  );
  const present = reviveSnapshot(record['present'], 'history.present');
  const future = readArray(record['future'], 'history.future').map((entry, index) =>
    reviveSnapshot(entry, `history.future[${String(index)}]`),
  );
  return Object.freeze({
    past: Object.freeze(past),
    present,
    future: Object.freeze(future),
  });
}

function reviveBindings(raw: unknown): FactBindingTable {
  const bindings = readArray(raw, 'bindings').map((entry, index): CellFactBinding => {
    const record = asRecord(entry, `bindings[${String(index)}]`);
    const sheet = record['sheet'];
    const ref = record['ref'];
    const factKey = record['fact_key'];
    const version = record['version'];
    if (typeof sheet !== 'string' || sheet.length === 0) throw new ValidationError(`bindings[${String(index)}].sheet 非法`);
    if (typeof ref !== 'string' || ref.length === 0) throw new ValidationError(`bindings[${String(index)}].ref 非法`);
    if (typeof factKey !== 'string' || factKey.length === 0) throw new ValidationError(`bindings[${String(index)}].fact_key 非法`);
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      throw new ValidationError(`bindings[${String(index)}].version 非法`);
    }
    return Object.freeze({ sheet, ref, fact_key: factKey, version });
  });
  return Object.freeze({ bindings: Object.freeze(bindings) });
}

function reviveLog(raw: unknown): readonly SpreadsheetStep[] {
  return Object.freeze(
    readArray(raw, 'log').map((entry, index): SpreadsheetStep => {
      const record = asRecord(entry, `log[${String(index)}]`);
      const seq = record['seq'];
      const revision = record['revision'];
      const label = record['label'];
      const opNames = record['op_names'];
      const changed = record['changed'];
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) throw new ValidationError(`log[${String(index)}].seq 非法`);
      if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
        throw new ValidationError(`log[${String(index)}].revision 非法`);
      }
      if (typeof label !== 'string' || label.length === 0) throw new ValidationError(`log[${String(index)}].label 非法`);
      if (!Array.isArray(opNames)) throw new ValidationError(`log[${String(index)}].op_names 非法`);
      if (typeof changed !== 'boolean') throw new ValidationError(`log[${String(index)}].changed 非法`);
      const failureRaw = record['failure'];
      let failure: SessionApplyFailure | null = null;
      if (failureRaw !== null && failureRaw !== undefined) {
        const failureRecord = asRecord(failureRaw, `log[${String(index)}].failure`);
        failure = Object.freeze({
          kind: String(failureRecord['kind'] ?? ''),
          detail: String(failureRecord['detail'] ?? ''),
        });
      }
      return Object.freeze({
        seq,
        revision,
        label,
        op_names: Object.freeze(opNames.map((name) => String(name))),
        changed,
        failure,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

function opNameOf(operation: unknown): string {
  if (typeof operation === 'object' && operation !== null) {
    const op = (operation as Record<string, unknown>)['op'];
    if (typeof op === 'string' && op.length > 0) return op;
  }
  return 'unknown';
}

/**
 * 一次编辑事务会话：源 + 历史 + 绑定表 + 步骤日志。
 *
 * 不可变约束由 `history.commit` 提供（草稿深拷贝、失败保旧）；本类只负责
 * "一批 op 全成或全不做"与"版本 / 快照 / 恢复"。
 */
export class SpreadsheetSession {
  readonly #session_id: string;
  #history: HistoryState;
  #residual: XlsxResidual;
  #bindings: FactBindingTable;
  readonly #log: SpreadsheetStep[];
  #seq = 0;

  private constructor(
    sessionId: string,
    history: HistoryState,
    residual: XlsxResidual,
    bindings: FactBindingTable,
    log: readonly SpreadsheetStep[],
  ) {
    this.#session_id = sessionId;
    this.#history = history;
    this.#residual = residual;
    this.#bindings = bindings;
    this.#log = [...log];
    this.#seq = this.#log.reduce((max, step) => Math.max(max, step.seq), 0);
  }

  /** 从零建会话。 */
  static create(options: SpreadsheetSessionOptions): SpreadsheetSession {
    const sessionId = options.session_id ?? 'spreadsheet-session';
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ValidationError('SpreadsheetSession.create：session_id 必须是非空字符串');
    }
    const label = options.initial_label ?? 'initial';
    const history = createHistory(options.source.workbook, label);
    return new SpreadsheetSession(
      sessionId,
      history,
      options.source.residual,
      options.bindings ?? EMPTY_BINDING_TABLE,
      [],
    );
  }

  /** 从落盘快照恢复（schema 不符 / 工作簿非法 ⇒ 抛错，不猜）。 */
  static restore(snapshot: SpreadsheetSessionSnapshot): SpreadsheetSession {
    const record = asRecord(snapshot, 'spreadsheet session snapshot');
    if (record['schema'] !== SPREADSHEET_SESSION_SCHEMA) {
      throw new ValidationError(
        `SpreadsheetSession.restore：schema 不符（期望 ${SPREADSHEET_SESSION_SCHEMA}，收到 ${JSON.stringify(record['schema'] ?? null)}）`,
      );
    }
    const sessionId = record['session_id'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ValidationError('SpreadsheetSession.restore：session_id 非法');
    }
    const history = reviveHistory(decodeSessionState(record['history']));
    const residual = decodeSessionState(record['residual']) as XlsxResidual;
    const bindings = reviveBindings(decodeSessionState(record['bindings']));
    const log = reviveLog(decodeSessionState(record['log']));
    return new SpreadsheetSession(sessionId, history, residual, bindings, log);
  }

  get session_id(): string {
    return this.#session_id;
  }

  /** 当前编辑版本（逻辑递增整数）。 */
  get revision(): number {
    return currentRevision(this.#history);
  }

  /** 当前工作簿（历史持有深拷贝，改它不影响历史）。 */
  get workbook(): WorkbookState {
    return this.#history.present.workbook;
  }

  get residual(): XlsxResidual {
    return this.#residual;
  }

  get bindings(): FactBindingTable {
    return this.#bindings;
  }

  /** 步骤日志（只读视图）。 */
  get steps(): readonly SpreadsheetStep[] {
    return this.#log;
  }

  /** 当前源（工作簿 + 残留），交给适配器导出。 */
  currentSource(): XlsxDeliverableSource {
    return Object.freeze({ workbook: this.workbook, residual: this.#residual });
  }

  /** 当前源的确定性摘要（失败前后相等 = 源零改动的机器判据）。 */
  sourceDigest(): string {
    return canonicalDigest(JSON.stringify(encodeSessionState(this.currentSource())));
  }

  /** 版本时间线（含被撤销的"未来"版本）。 */
  versions(): readonly VersionEntry[] {
    return versionTimeline(this.#history);
  }

  /** 全部已知版本号（升序）。 */
  knownRevisions(): readonly number[] {
    return knownRevisions(this.#history);
  }

  // ---- 事务编辑 ---------------------------------------------------------

  /** 应用**一个**操作（等价于长度为 1 的批量）。 */
  apply(operation: unknown): SessionEditOutcome {
    return this.applyBatch([operation], opNameOf(operation));
  }

  /**
   * **事务性**应用一批操作：任一失败 ⇒ 整批回滚，源与版本**逐字节不变**。
   *
   * 空操作列表 / 全部空转（`changed` 全 false）⇒ 不产生新版本。
   * @throws {ValidationError} 列表为空（调用方错误，不是操作失败）
   */
  applyBatch(operations: readonly unknown[], label?: string): SessionEditOutcome {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ValidationError('applyBatch 至少需要一个操作');
    }
    const names = operations.map(opNameOf);
    const stepLabel = label ?? names.join('+');
    if (typeof stepLabel !== 'string' || stepLabel.length === 0) {
      throw new ValidationError('applyBatch 的 label 必须是非空字符串');
    }

    // 1) 在**私有草稿**上顺序应用；任一失败即丢弃草稿（源零改动）。
    let working = cloneWorkbook(this.#history.present.workbook);
    const notes: string[] = [];
    let changed = false;
    for (const operation of operations) {
      const result = applySpreadsheetOperation({ workbook: working, residual: this.#residual }, operation);
      if (!result.ok) {
        return this.#fail(stepLabel, names, { kind: result.kind, detail: result.detail }, notes);
      }
      working = result.source.workbook;
      changed = changed || result.changed;
      for (const note of result.notes) notes.push(note);
    }

    if (!changed) {
      return this.#succeed(stepLabel, names, false, notes);
    }

    // 2) 提交（commit 只认已验证的工作簿；失败保旧）。
    const outcome = commit(this.#history, stepLabel, () => working);
    if (!outcome.ok) {
      return this.#fail(stepLabel, names, { kind: 'commit_failed', detail: outcome.error.message }, notes);
    }
    this.#history = outcome.history;
    return this.#succeed(stepLabel, names, true, notes);
  }

  /**
   * **事务性**应用一批共享事实更新。
   *
   * 复用 `facts-binding.applyFactUpdates`：只改写绑定格、拒绝迟到 / 冲突版本、复用 recalc。
   * 无任何事实被接受（全部幂等重放或全部被拒）⇒ 不产生新版本。
   */
  applyFactUpdates(updates: readonly FactCellUpdate[], label = 'facts'): SessionFactOutcome {
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new ValidationError('applyFactUpdates 至少需要一条更新');
    }
    let application: FactUpdateApplication;
    try {
      application = applyFactUpdates({
        workbook: this.#history.present.workbook,
        table: this.#bindings,
        updates,
      });
    } catch (error) {
      return {
        ...this.#fail(label, ['fact_update'], { kind: 'invalid_fact_update', detail: describe(error) }, []),
        applied_fact_keys: Object.freeze([]),
        rejected: Object.freeze([]),
        rewritten_cell_keys: Object.freeze([]),
        recalculated_formula_keys: Object.freeze([]),
      };
    }

    if (application.applied_fact_keys.length === 0) {
      const outcome = this.#succeed(label, ["fact_update"], false, []);
      return {
        ...outcome,
        applied_fact_keys: Object.freeze([]),
        rejected: application.rejected,
        rewritten_cell_keys: Object.freeze([]),
        recalculated_formula_keys: Object.freeze([]),
      };
    }

    const committed = commit(this.#history, label, () => application.workbook);
    if (!committed.ok) {
      return {
        ...this.#fail(label, ['fact_update'], { kind: 'commit_failed', detail: committed.error.message }, []),
        applied_fact_keys: Object.freeze([]),
        rejected: application.rejected,
        rewritten_cell_keys: Object.freeze([]),
        recalculated_formula_keys: Object.freeze([]),
      };
    }
    this.#history = committed.history;
    this.#bindings = application.table;
    const outcome = this.#succeed(label, ["fact_update"], true, []);
    return {
      ...outcome,
      applied_fact_keys: application.applied_fact_keys,
      rejected: application.rejected,
      rewritten_cell_keys: application.rewritten_cell_keys,
      recalculated_formula_keys: application.recalculated_formula_keys,
    };
  }

  // ---- 版本与恢复 -------------------------------------------------------

  /** 撤销一步（无可撤销 ⇒ `ok: false`，不抛）。 */
  undo(): SessionVersionOutcome {
    if (this.#history.past.length === 0) {
      return { ok: false, reason: '没有可撤销的版本' };
    }
    this.#history = undo(this.#history);
    return { ok: true, revision: this.revision };
  }

  /** 重做一步（无可重做 ⇒ `ok: false`）。 */
  redo(): SessionVersionOutcome {
    if (this.#history.future.length === 0) {
      return { ok: false, reason: '没有可重做的版本' };
    }
    this.#history = redo(this.#history);
    return { ok: true, revision: this.revision };
  }

  /** **恢复到任意已知版本**（撤销 / 重做的推广；未知版本 ⇒ `ok: false`）。 */
  restore(revision: number): SessionVersionOutcome {
    if (!this.knownRevisions().includes(revision)) {
      return {
        ok: false,
        reason: `版本 ${String(revision)} 不在本会话时间线内（已知：${this.knownRevisions().join(', ')}）`,
      };
    }
    this.#history = restoreAt(this.#history, revision);
    return { ok: true, revision: this.revision };
  }

  // ---- 快照 -------------------------------------------------------------

  /** 产出**纯 JSON 值**快照（`Map` / `Uint8Array` 已编码）。 */
  snapshot(): SpreadsheetSessionSnapshot {
    return Object.freeze({
      schema: SPREADSHEET_SESSION_SCHEMA,
      session_id: this.#session_id,
      revision: this.revision,
      history: encodeSessionState(this.#history),
      residual: encodeSessionState(this.#residual),
      bindings: Object.freeze([...this.#bindings.bindings]),
      log: Object.freeze([...this.#log]),
    });
  }

  // ---- 私有 -------------------------------------------------------------

  #succeed(label: string, opNames: readonly string[], changed: boolean, notes: readonly string[]): SessionEditOutcome {
    this.#log.push(
      Object.freeze({
        seq: (this.#seq += 1),
        revision: this.revision,
        label,
        op_names: Object.freeze([...opNames]),
        changed,
        failure: null,
      }),
    );
    return {
      ok: true,
      revision: this.revision,
      changed,
      failure: null,
      rolled_back: false,
      notes: Object.freeze([...notes]),
    };
  }

  #fail(
    label: string,
    opNames: readonly string[],
    failure: SessionApplyFailure,
    notes: readonly string[],
  ): SessionEditOutcome {
    this.#log.push(
      Object.freeze({
        seq: (this.#seq += 1),
        revision: this.revision,
        label,
        op_names: Object.freeze([...opNames]),
        changed: false,
        failure: Object.freeze({ kind: failure.kind, detail: failure.detail }),
      }),
    );
    return {
      ok: false,
      revision: this.revision,
      changed: false,
      failure: Object.freeze({ kind: failure.kind, detail: failure.detail }),
      rolled_back: true,
      notes: Object.freeze([...notes]),
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 便捷入口。 */
export function createSpreadsheetSession(options: SpreadsheetSessionOptions): SpreadsheetSession {
  return SpreadsheetSession.create(options);
}

/** 空残留（从零新建用）。 */
export const NO_RESIDUAL: XlsxResidual = EMPTY_RESIDUAL;

/** 逻辑时间构造（供调用方给事实更新打时间戳；本层不读墙钟）。 */
export function logicalTime(value: number): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('logicalTime 必须是有限数');
  }
  return value as LogicalTime;
}
