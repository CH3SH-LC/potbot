/**
 * **X-R04 / 崩溃事务与撤销恢复**：把 `history.ts` 的内存事务 + `xls-io.ts` 的文件层
 * 接成一条**可恢复**的会话（手机被系统回收后还能说清"哪些提交落了盘、哪些没了"）。
 *
 * ## 为什么内存里的"失败保旧"还不够
 *
 * `history.ts` 的 `commit` 已经保证"改写函数抛错 ⇒ 规范状态逐字节未动"。但手机的现实是
 * **进程会在任意时刻被杀**：
 *
 * - 崩在 `commit` **之前**（草稿改动还没提交）⇒ 规范状态未动，但**账本里留了一条 open 记录**，
 *   恢复时必须能说出"这笔事务没成，按放弃处理"，而不是当它不存在；
 * - 崩在 `commit` **之后、写文件之前**（committed 但未持久化）⇒ 内存里的新状态**丢了**，
 *   恢复必须回到最后一次落盘的检查点，并**如实登记**"第 N 版提交被回退"；
 * - 崩在**写文件之后** ⇒ 检查点前进，恢复后**撤销仍能回到更早的落盘版本**。
 *
 * 本模块把这三件事做成三个可断言的判据：`crashed_open`（open 事务清单）、
 * `reverted_unpersisted_revisions`（被回退的未落盘提交）、`undo_depth`（恢复后的可撤销深度）。
 *
 * ## 与既有模块的关系（**只读复用**，一个字节都不改）
 *
 * - `history.ts`：撤销栈、失败保旧、版本比较的**唯一实现**（本层只当调用方）；
 * - `xls-io.ts`：`WorkbookDocument` / `saveWorkbookDocument` / `openWorkbookDocument`；
 * - `artifacts/templates/xlsx.ts`：`xlsxContentDigest`（字节身份）。
 *
 * ## 纪律
 *
 * 纯函数、零 IO、无墙钟、无随机：事务 ID 与逻辑版本都由调用方给出，同一串操作 ⇒ 同一串结论。
 * **查不到就说查不到**：检查点字节与账本对不上时显式失败（`inconsistent_store` / `stale_checkpoint`），
 * 绝不返回一个"猜出来的"工作簿。
 */

import { ValidationError } from '../../../../src/protocol/index.js';
import { xlsxContentDigest } from '../../../../src/artifacts/templates/xlsx.js';
import {
  currentRevision,
  createHistory,
  commit,
  redo,
  undo,
  type HistorySnapshot,
  type HistoryState,
  type WorkbookMutation,
} from '../../../../src/spreadsheets/history.js';
import {
  openWorkbookDocument,
  saveWorkbookDocument,
  withWorkbookEdits,
  type WorkbookDocument,
  type WorkbookSaveResult,
} from '../../../../src/spreadsheets/xls-io.js';
import { createWorkbook, getSheet, setSheetHidden, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { textValue, type CellValue } from '../../../../src/spreadsheets/value.js';
import { EMPTY_RESIDUAL } from '../../../../src/spreadsheets/xlsx-write.js';

// ---------------------------------------------------------------------------
// 账本（内存实现，形状对齐 StoragePort 的追加语义）
// ---------------------------------------------------------------------------

/** 一次事务在账本里的记录。 */
export interface TransactionRecord {
  readonly transaction_id: string;
  readonly label: string;
  readonly status: 'open' | 'aborted' | 'committed';
  /** 事务开始时工作簿所在的版本号（-1 = 事务先于任何版本，仅初始记录使用）。 */
  readonly base_revision: number;
  /** 提交后的版本号（未提交为 null）。 */
  readonly revision: number | null;
  /** 提交时的字节身份（未提交为 null）。 */
  readonly committed_digest: string | null;
  /** 该版本**已落盘**时的字节身份（未落盘为 null）。 */
  readonly saved_digest: string | null;
  /** 放弃 / 失败的原因（正常提交为 null）。 */
  readonly failure: string | null;
}

/** 一次会话的可持久状态：账本 + 每个已落盘版本的快照字节。 */
export interface DurableState {
  readonly journal: readonly TransactionRecord[];
  /** revision → 该版本落盘时的字节。 */
  readonly snapshots: ReadonlyMap<number, Uint8Array>;
}

/** 一次"打开的工作簿"会话：文档 + 撤销栈 + 账本 + 检查点。 */
export interface SpreadsheetSession {
  readonly file_name: string;
  readonly document: WorkbookDocument;
  readonly history: HistoryState;
  readonly journal: readonly TransactionRecord[];
  /** 已落盘版本的快照（revision → 字节）。 */
  readonly snapshots: ReadonlyMap<number, Uint8Array>;
  /** 最后一次落盘时的版本号（-1 = 从未落盘）。 */
  readonly checkpoint_revision: number;
}

/** 一次事务的句柄。 */
export interface TransactionHandle {
  readonly transaction_id: string;
  readonly base_revision: number;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串，收到 ${JSON.stringify(value ?? null)}`);
  }
  return value;
}

/** 一份工作簿模型的字节身份（确定性：同一模型 ⇒ 同一摘要）。 */
export function workbookDigest(document: WorkbookDocument, workbook: WorkbookState): string {
  return xlsxContentDigest(saveWorkbookDocument(withWorkbookEdits(document, workbook)).bytes);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

const INITIAL_RECORD_ID = 'initial';

/** 新建会话：撤销栈从版本 0 起，账本里先落一条 initial 记录（尚未落盘）。 */
export function createSession(document: WorkbookDocument): SpreadsheetSession {
  const initial: TransactionRecord = Object.freeze({
    transaction_id: INITIAL_RECORD_ID,
    label: 'import',
    status: 'committed' as const,
    base_revision: -1,
    revision: 0,
    committed_digest: null,
    saved_digest: null,
    failure: null,
  });
  return Object.freeze({
    file_name: document.file_name,
    document,
    history: createHistory(document.workbook, 'import'),
    journal: Object.freeze([initial]) as readonly TransactionRecord[],
    snapshots: new Map<number, Uint8Array>(),
    checkpoint_revision: -1,
  });
}

/** 开一笔事务（只登记 open 记录，**不动**工作簿）。 */
export function beginTransaction(
  session: SpreadsheetSession,
  transactionId: string,
  label: string,
): { readonly session: SpreadsheetSession; readonly handle: TransactionHandle } {
  const id = requireId(transactionId, 'transactionId');
  const name = requireId(label, 'label');
  if (session.journal.some((record) => record.transaction_id === id)) {
    throw new ValidationError(`事务 ID 已存在：${JSON.stringify(id)}`);
  }
  const base = currentRevision(session.history);
  const record: TransactionRecord = Object.freeze({
    transaction_id: id,
    label: name,
    status: 'open' as const,
    base_revision: base,
    revision: null,
    committed_digest: null,
    saved_digest: null,
    failure: null,
  });
  return Object.freeze({
    session: Object.freeze({ ...session, journal: Object.freeze([...session.journal, record]) }),
    handle: Object.freeze({ transaction_id: id, base_revision: base }),
  });
}

/** 提交结果。 */
export type CommitTransactionOutcome =
  | { readonly ok: true; readonly session: SpreadsheetSession; readonly revision: number; readonly digest: string }
  | { readonly ok: false; readonly session: SpreadsheetSession; readonly error: Error };

function replaceRecord(
  journal: readonly TransactionRecord[],
  transactionId: string,
  patch: Partial<TransactionRecord>,
): readonly TransactionRecord[] {
  let found = false;
  const next = journal.map((record) => {
    if (record.transaction_id !== transactionId) return record;
    found = true;
    return Object.freeze({ ...record, ...patch });
  });
  if (!found) {
    throw new ValidationError(`账本里没有事务 ${JSON.stringify(transactionId)}`);
  }
  return Object.freeze(next);
}

/**
 * 在 open 事务里跑一次改写并提交。
 *
 * - `base_revision` 与当前版本不一致 ⇒ `ok: false`（**不静默覆盖**，对齐 `detectStaleWrite`）；
 * - 改写抛错 / 返回半个工作簿 ⇒ `history.commit` 的失败保旧生效，账本记 `aborted`，
 *   会话的文档与历史**原样返回**（失败不留下半个工作簿，也不消耗版本号）。
 */
export function commitTransaction(
  session: SpreadsheetSession,
  handle: TransactionHandle,
  mutate: WorkbookMutation,
): CommitTransactionOutcome {
  const record = session.journal.find((item) => item.transaction_id === handle.transaction_id);
  if (record === undefined) {
    throw new ValidationError(`账本里没有事务 ${JSON.stringify(handle.transaction_id)}`);
  }
  if (record.status !== 'open') {
    throw new ValidationError(`事务 ${JSON.stringify(handle.transaction_id)} 不是 open 状态（${record.status}）`);
  }
  const current = currentRevision(session.history);
  if (handle.base_revision !== current) {
    return Object.freeze({
      ok: false as const,
      session,
      error: new ValidationError(
        `事务基于版本 ${String(handle.base_revision)}，但当前已是 ${String(current)}：并发写入，拒绝静默覆盖`,
      ),
    });
  }

  const outcome = commit(session.history, record.label, mutate);
  if (!outcome.ok) {
    return Object.freeze({
      ok: false as const,
      session: Object.freeze({
        ...session,
        journal: replaceRecord(session.journal, handle.transaction_id, {
          status: 'aborted',
          failure: outcome.error.message,
        }),
      }),
      error: outcome.error,
    });
  }

  const digest = workbookDigest(session.document, outcome.snapshot.workbook);
  return Object.freeze({
    ok: true as const,
    revision: outcome.snapshot.revision,
    digest,
    session: Object.freeze({
      ...session,
      document: withWorkbookEdits(session.document, outcome.snapshot.workbook),
      history: outcome.history,
      journal: replaceRecord(session.journal, handle.transaction_id, {
        status: 'committed',
        revision: outcome.snapshot.revision,
        committed_digest: digest,
      }),
    }),
  });
}

/** 放弃一笔 open 事务（不消耗版本号）。 */
export function abortTransaction(
  session: SpreadsheetSession,
  handle: TransactionHandle,
  reason = '用户放弃',
): SpreadsheetSession {
  const record = session.journal.find((item) => item.transaction_id === handle.transaction_id);
  if (record === undefined) {
    throw new ValidationError(`账本里没有事务 ${JSON.stringify(handle.transaction_id)}`);
  }
  if (record.status !== 'open') return session;
  return Object.freeze({
    ...session,
    journal: replaceRecord(session.journal, handle.transaction_id, { status: 'aborted', failure: reason }),
  });
}

/** 保存（落盘）：把当前版本写成字节并记进快照表，检查点前进。 */
export function saveSession(session: SpreadsheetSession): {
  readonly session: SpreadsheetSession;
  readonly save: WorkbookSaveResult;
} {
  const save = saveWorkbookDocument(session.document);
  const revision = currentRevision(session.history);
  const snapshots = new Map(session.snapshots);
  snapshots.set(revision, save.bytes);
  const journal = session.journal.map((record) =>
    record.revision === revision && record.saved_digest === null
      ? Object.freeze({ ...record, saved_digest: save.content_digest })
      : record,
  );
  return Object.freeze({
    session: Object.freeze({
      ...session,
      journal: Object.freeze([...journal]),
      snapshots,
      checkpoint_revision: revision,
    }),
    save,
  });
}

/** 撤销一步（撤销栈的 past 里已经是完整快照，直接换回文档）。 */
export function undoSession(session: SpreadsheetSession): SpreadsheetSession {
  const history = undo(session.history);
  return Object.freeze({
    ...session,
    history,
    document: withWorkbookEdits(session.document, history.present.workbook),
  });
}

/** 重做一步。 */
export function redoSession(session: SpreadsheetSession): SpreadsheetSession {
  const history = redo(session.history);
  return Object.freeze({
    ...session,
    history,
    document: withWorkbookEdits(session.document, history.present.workbook),
  });
}

/** 可持久状态（可交给 K09 的 StoragePort）。 */
export function durableState(session: SpreadsheetSession): DurableState {
  return Object.freeze({ journal: session.journal, snapshots: session.snapshots });
}

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

export type RecoveryFailureReason =
  /** 账本 / 快照自相矛盾（有 saved_digest 却没有对应快照，或快照摘要对不上）。 */
  | 'inconsistent_store'
  /** 账本里没有任何已落盘版本（没有可恢复的检查点）。 */
  | 'no_checkpoint'
  /** 传入的"当前文件字节"与账本里的检查点对不上（可能是别的文件 / 被篡改）。 */
  | 'stale_checkpoint';

export interface CrashRecoveryOk {
  readonly ok: true;
  readonly session: SpreadsheetSession;
  /** 恢复到的落盘版本号。 */
  readonly recovered_revision: number;
  /** 崩溃时仍是 open 的事务（按放弃处置，**不猜它是否成功**）。 */
  readonly crashed_open_transactions: readonly string[];
  /** 已提交但**未落盘**、恢复时被回退的版本号（如实登记，不静默采纳）。 */
  readonly reverted_unpersisted_revisions: readonly number[];
  /** 恢复后的可撤销深度（= 更早的落盘版本数）。 */
  readonly undo_depth: number;
  /** 恢复后的版本标签序列。 */
  readonly history_labels: readonly string[];
}

export interface CrashRecoveryFail {
  readonly ok: false;
  readonly reason: RecoveryFailureReason;
  readonly detail: string;
}

export type CrashRecoveryResult = CrashRecoveryOk | CrashRecoveryFail;

export interface CrashRecoveryInput {
  readonly file_name: string;
  readonly journal: readonly TransactionRecord[];
  readonly snapshots: ReadonlyMap<number, Uint8Array>;
  /** 崩溃后磁盘上剩下的那份字节（最后一次成功落盘的内容）。 */
  readonly current_bytes: Uint8Array;
}

function recoveryFail(reason: RecoveryFailureReason, detail: string): CrashRecoveryFail {
  return Object.freeze({ ok: false as const, reason, detail });
}

/**
 * 从账本 + 快照 + 磁盘字节恢复一次会话。
 *
 * 判据（全部显式，不猜）：
 * 1. 账本自洽：凡有 `saved_digest` 的记录，快照表里必须有对应版本，且快照字节摘要相符；
 * 2. 磁盘字节必须**就是**某个已落盘版本的字节（摘要比对）；
 * 3. 恢复版本 = 已落盘的最大版本；open 记录按放弃处置并列出；
 * 4. 已提交但版本号 > 恢复版本的记录 ⇒ **回退**并逐条登记；
 * 5. 撤销栈由更早的落盘快照重建 ⇒ 恢复后仍可 undo 回崩溃前的更早版本（撤销恢复）。
 *
 * 同一输入连跑两次 ⇒ 同一结论（含摘要）。查不到就说查不到，不返回猜的工作簿。
 */
export function recoverFromCrash(input: CrashRecoveryInput): CrashRecoveryResult {
  const fileName = requireId(input.file_name, 'file_name');
  const { journal, snapshots, current_bytes } = input;
  if (current_bytes.byteLength === 0) {
    return recoveryFail('no_checkpoint', '磁盘字节为空：没有任何可恢复的检查点');
  }

  // 判据 1：账本自洽。
  for (const record of journal) {
    if (record.saved_digest === null) continue;
    if (record.revision === null) {
      return recoveryFail(
        'inconsistent_store',
        `事务 ${JSON.stringify(record.transaction_id)} 有 saved_digest 却没有 revision`,
      );
    }
    const snapshot = snapshots.get(record.revision);
    if (snapshot === undefined) {
      return recoveryFail(
        'inconsistent_store',
        `版本 ${String(record.revision)} 记为已落盘，但快照表里没有它的字节`,
      );
    }
    if (xlsxContentDigest(snapshot) !== record.saved_digest) {
      return recoveryFail(
        'inconsistent_store',
        `版本 ${String(record.revision)} 的快照摘要与账本记录不符（快照被改过）`,
      );
    }
  }

  const persisted = journal
    .filter((record): record is TransactionRecord & { revision: number } =>
      record.saved_digest !== null && record.revision !== null,
    )
    .sort((a, b) => a.revision - b.revision);
  if (persisted.length === 0) {
    return recoveryFail('no_checkpoint', '账本里没有任何已落盘版本');
  }

  // 判据 2：磁盘字节必须匹配某个已落盘版本。
  const currentDigest = xlsxContentDigest(current_bytes);
  const currentRecord = persisted.find((record) => record.saved_digest === currentDigest);
  if (currentRecord === undefined) {
    return recoveryFail(
      'stale_checkpoint',
      '磁盘字节与账本里任何已落盘版本都对不上（可能不是本会话的文件）',
    );
  }
  const recoveredRevision = currentRecord.revision;

  // 判据 3 / 4：分类 open 与被回退的提交。
  const crashedOpen = journal
    .filter((record) => record.status === 'open')
    .map((record) => record.transaction_id);
  const reverted = journal
    .filter(
      (record): record is TransactionRecord & { revision: number } =>
        record.status === 'committed' && record.revision !== null && record.revision > recoveredRevision,
    )
    .map((record) => record.revision)
    .sort((a, b) => a - b);

  // 判据 5：撤销栈由更早的落盘快照重建。
  const earlier = persisted.filter((record) => record.revision < recoveredRevision);
  const past: HistorySnapshot[] = earlier.map((record) => {
    const snapshot = snapshots.get(record.revision);
    if (snapshot === undefined) throw new ValidationError('快照在自洽检查后消失，这是编程错误');
    return Object.freeze({
      revision: record.revision,
      label: record.label,
      workbook: openWorkbookDocument(fileName, snapshot).workbook,
    });
  });
  const recoveredDocument = openWorkbookDocument(fileName, current_bytes);
  const present: HistorySnapshot = Object.freeze({
    revision: recoveredRevision,
    label: currentRecord.label,
    workbook: recoveredDocument.workbook,
  });
  const history: HistoryState = Object.freeze({
    past: Object.freeze(past),
    present,
    future: Object.freeze([]) as readonly HistorySnapshot[],
  });

  const session: SpreadsheetSession = Object.freeze({
    file_name: recoveredDocument.file_name,
    document: recoveredDocument,
    history,
    // open 记录按放弃处置（恢复后不再有 open 记录，语义明确）。
    journal: Object.freeze(
      journal.map((record) =>
        record.status === 'open'
          ? Object.freeze({ ...record, status: 'aborted' as const, failure: '崩溃后恢复：事务未提交' })
          : record,
      ),
    ),
    snapshots,
    checkpoint_revision: recoveredRevision,
  });

  return Object.freeze({
    ok: true as const,
    session,
    recovered_revision: recoveredRevision,
    crashed_open_transactions: Object.freeze(crashedOpen),
    reverted_unpersisted_revisions: Object.freeze(reverted),
    undo_depth: past.length,
    history_labels: Object.freeze([...past.map((entry) => entry.label), present.label]),
  });
}

// ---------------------------------------------------------------------------
// 便捷构造：一份可编辑的工作簿文档（供用例搭场景）
// ---------------------------------------------------------------------------

/** 造一张单表工作簿文档（`rows` 行 A 列文本）。 */
export function documentWithRows(fileName: string, rows: readonly string[]): WorkbookDocument {
  let sheet = createSheet('S', { row_count: Math.max(rows.length, 1), column_count: 1 });
  rows.forEach((text, index) => {
    sheet = setCellValue(sheet, `A${String(index + 1)}`, textValue(text));
  });
  return openWorkbookDocumentFromModel(fileName, createWorkbook([sheet]));
}

/** 用一个模型造文档（`residual` 为空的干净包）。 */
export function openWorkbookDocumentFromModel(fileName: string, workbook: WorkbookState): WorkbookDocument {
  const bytes = saveWorkbookDocument({
    file_name: fileName,
    workbook,
    residual: EMPTY_RESIDUAL,
    source_digest: null,
  }).bytes;
  return openWorkbookDocument(fileName, bytes);
}

/** 取某表某格的值（用例断言用，避免直接摸 Map）。 */
export function cellText(workbook: WorkbookState, sheetName: string, ref: string): CellValue | undefined {
  const sheet = getSheet(workbook, sheetName);
  if (sheet === undefined) return undefined;
  return sheet.cells.get(ref);
}

/** 造一张带隐藏表的文档（供"表级结构在崩溃恢复后不变"的断言）。 */
export function documentWithHiddenSheet(fileName: string): WorkbookDocument {
  let sheet = createSheet('S', { row_count: 2, column_count: 2 });
  sheet = setCellValue(sheet, 'A1', textValue('x'));
  const hidden = createSheet('H', { row_count: 1, column_count: 1 });
  return openWorkbookDocumentFromModel(fileName, setSheetHidden(createWorkbook([sheet, hidden]), 'H', true));
}
