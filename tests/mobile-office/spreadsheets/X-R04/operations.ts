/**
 * **X-R04 / 操作合同**：把会话操作收进 v1「命令与事件」信封（README §5 的第一张表）。
 *
 * 为什么不直接调 `beginTransaction` / `commitTransaction`：合同要求
 * **公共输入 `schemaVersion, commandId, operation, idempotencyKey, payload`**，
 * 事件 **`eventId, seq, commandId, revision, status, resultRef/error`**，并且
 * **「重复命令返回原结果，旧修订明确冲突」**。这三条是崩溃恢复之外、X-R04 也要咬住的：
 *
 * - **幂等**：同一个 `idempotencyKey` 再来一次，返回**原来那条事件**（含相同 `seq` / `eventId`），
 *   会话一个字节不动——重试不会把已经落盘的提交做第二遍；
 * - **旧修订冲突**：`expected_revision` 与当前版本不一致 ⇒ `status: 'conflict'`，
 *   带上 `expected` / `current`，**不静默覆盖**（与 `detectStaleWrite` 同口径）；
 * - **payload 可序列化**：改写以「一格一条 `CellEdit`」表达，不塞函数进命令——
 *   否则命令无法进账本、无法跨进程重放，崩溃恢复就无从谈起。
 *
 * 本模块是 `crash-safety.ts` 之上的薄壳（会话状态的唯一实现仍在那一层）。
 */

import { ValidationError } from '../../../../src/protocol/index.js';
import { currentRevision, updateSheet } from '../../../../src/spreadsheets/history.js';
import { clearCell, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';
import type { WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import {
  abortTransaction,
  beginTransaction,
  commitTransaction,
  redoSession,
  saveSession,
  undoSession,
  type SpreadsheetSession,
  type TransactionHandle,
} from './crash-safety.js';

/** v1 合同的 schema 版本（与 README §5 一致）。 */
export const MOBILE_CONTRACT_SCHEMA_VERSION = 'mobile-v1';

/** 表格会话支持的操作。 */
export type XlsxOperation = 'begin' | 'commit' | 'abort' | 'save' | 'undo' | 'redo' | 'close';

/** 一条可序列化的单元格编辑。 */
export interface CellEdit {
  readonly sheet: string;
  readonly ref: string;
  /** 目标取值；`kind === 'blank'` 表示**清空该格**（不是写 0、不是写空串）。 */
  readonly value: CellValue;
}

/** 命令载荷（各操作按需取字段；缺必需字段 ⇒ `rejected`）。 */
export interface XlsxCommandPayload {
  readonly transaction_id?: string;
  readonly label?: string;
  /** 乐观并发：调用方基于的版本；不一致 ⇒ `conflict`。 */
  readonly expected_revision?: number;
  readonly edits?: readonly CellEdit[];
}

/** v1 命令信封。 */
export interface XlsxCommand {
  readonly schemaVersion: string;
  readonly commandId: string;
  readonly operation: XlsxOperation;
  readonly idempotencyKey: string;
  readonly payload: XlsxCommandPayload;
}

/** 事件里的结构化错误。 */
export interface XlsxEventError {
  readonly code: 'stale_revision' | 'invalid_command' | 'operation_failed';
  readonly message: string;
  readonly expected?: number;
  readonly current?: number;
}

/** v1 事件信封。 */
export interface XlsxEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly commandId: string;
  readonly revision: number;
  readonly status: 'ok' | 'conflict' | 'rejected';
  readonly resultRef: string | null;
  readonly error: XlsxEventError | null;
}

/** 带命令幂等台账的会话壳。 */
export interface CommandSession {
  readonly state: SpreadsheetSession;
  /** idempotencyKey → 首次执行产生的事件。 */
  readonly applied: ReadonlyMap<string, XlsxEvent>;
  /** 已发事件数（下一个 `seq`）。 */
  readonly seq: number;
}

export function createCommandSession(state: SpreadsheetSession): CommandSession {
  return Object.freeze({ state, applied: new Map<string, XlsxEvent>(), seq: 0 });
}

/** 一次命令的执行结果。 */
export interface AppliedCommand {
  readonly command: CommandSession;
  readonly event: XlsxEvent;
  /** true = 命中幂等台账，**原样**返回首次事件（会话未再动手）。 */
  readonly replay: boolean;
}

function requireEnvelope(command: XlsxCommand): XlsxEventError | null {
  if (command.schemaVersion !== MOBILE_CONTRACT_SCHEMA_VERSION) {
    return {
      code: 'invalid_command',
      message: `schemaVersion 必须是 ${MOBILE_CONTRACT_SCHEMA_VERSION}，收到 ${JSON.stringify(command.schemaVersion)}`,
    };
  }
  for (const field of ['commandId', 'idempotencyKey'] as const) {
    const value = command[field];
    if (typeof value !== 'string' || value.length === 0) {
      return { code: 'invalid_command', message: `${field} 必须是非空字符串` };
    }
  }
  return null;
}

/** 会话当前版本号（history.ts 的 currentRevision 只吃 HistoryState）。 */
function rev(session: SpreadsheetSession): number {
  return currentRevision(session.history);
}

function requireField(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`命令缺少 ${field}`);
  }
  return value;
}

/** 把一串 `CellEdit` 折成一个 `WorkbookMutation`（表不存在 ⇒ 抛错 ⇒ 事务失败保旧）。 */
function editsToMutation(edits: readonly CellEdit[]): (workbook: WorkbookState) => WorkbookState {
  return (workbook) => {
    let next = workbook;
    for (const edit of edits) {
      next = updateSheet(next, edit.sheet, (sheet) =>
        edit.value.kind === 'blank' ? clearCell(sheet, edit.ref) : setCellValue(sheet, edit.ref, edit.value),
      );
    }
    return next;
  };
}

function makeEvent(
  command: XlsxCommand,
  seq: number,
  revision: number,
  status: XlsxEvent['status'],
  resultRef: string | null,
  error: XlsxEventError | null,
): XlsxEvent {
  return Object.freeze({
    eventId: `${command.commandId}#${String(seq)}`,
    seq,
    commandId: command.commandId,
    revision,
    status,
    resultRef,
    error,
  });
}

/** 组装"会话状态 + 幂等台账 + 事件"的结果。 */
function settle(
  state: SpreadsheetSession,
  applied: ReadonlyMap<string, XlsxEvent>,
  event: XlsxEvent,
): AppliedCommand {
  return Object.freeze({
    command: Object.freeze({ state, applied, seq: event.seq }),
    event,
    replay: false,
  });
}

/** 记账 + settle 的合并助手。 */
function recordAndSettle(
  session: CommandSession,
  command: XlsxCommand,
  state: SpreadsheetSession,
  event: XlsxEvent,
): AppliedCommand {
  const applied = new Map(session.applied);
  applied.set(command.idempotencyKey, event);
  return settle(state, applied, event);
}

/**
 * 执行一条命令。
 *
 * 顺序：**信封校验 → 幂等命中 → 旧修订冲突 → 分派**。
 * 前三步都可能在**不改会话**的情况下返回事件（`rejected` / `conflict` / `replay`）。
 */
export function applyCommand(session: CommandSession, command: XlsxCommand): AppliedCommand {
  const seq = session.seq + 1;

  const envelopeError = requireEnvelope(command);
  if (envelopeError !== null) {
    const event = makeEvent(command, seq, rev(session.state), 'rejected', null, envelopeError);
    return recordAndSettle(session, command, session.state, event);
  }

  // 幂等：同一 key 再来一次 ⇒ 原样返回首次事件（含相同 seq / eventId）。
  const first = session.applied.get(command.idempotencyKey);
  if (first !== undefined) {
    return Object.freeze({ command: session, event: first, replay: true });
  }

  const expected = command.payload.expected_revision;
  const current = rev(session.state);
  if (expected !== undefined && expected !== current) {
    const error: XlsxEventError = Object.freeze({
      code: 'stale_revision' as const,
      message: `命令基于版本 ${String(expected)}，但当前已是 ${String(current)}：拒绝静默覆盖`,
      expected,
      current,
    });
    const event = makeEvent(command, seq, current, 'conflict', null, error);
    return recordAndSettle(session, command, session.state, event);
  }

  return dispatch(session, command, seq);
}

function dispatch(session: CommandSession, command: XlsxCommand, seq: number): AppliedCommand {
  try {
    switch (command.operation) {
      case 'begin': {
        const transactionId = requireField(command.payload.transaction_id, 'payload.transaction_id');
        const label = requireField(command.payload.label, 'payload.label');
        const { session: next } = beginTransaction(session.state, transactionId, label);
        return recordAndSettle(
          session,
          command,
          next,
          makeEvent(command, seq, rev(next), 'ok', transactionId, null),
        );
      }
      case 'commit': {
        const transactionId = requireField(command.payload.transaction_id, 'payload.transaction_id');
        const handle: TransactionHandle = {
          transaction_id: transactionId,
          base_revision: rev(session.state),
        };
        const outcome = commitTransaction(session.state, handle, editsToMutation(command.payload.edits ?? []));
        if (!outcome.ok) {
          const error: XlsxEventError = Object.freeze({
            code: 'operation_failed' as const,
            message: outcome.error.message,
          });
          return recordAndSettle(
            session,
            command,
            outcome.session,
            makeEvent(command, seq, rev(outcome.session), 'rejected', null, error),
          );
        }
        return recordAndSettle(
          session,
          command,
          outcome.session,
          makeEvent(command, seq, outcome.revision, 'ok', outcome.digest, null),
        );
      }
      case 'abort': {
        const transactionId = requireField(command.payload.transaction_id, 'payload.transaction_id');
        const handle: TransactionHandle = {
          transaction_id: transactionId,
          base_revision: rev(session.state),
        };
        const next = abortTransaction(session.state, handle);
        return recordAndSettle(
          session,
          command,
          next,
          makeEvent(command, seq, rev(next), 'ok', transactionId, null),
        );
      }
      case 'save': {
        const { session: next, save } = saveSession(session.state);
        return recordAndSettle(
          session,
          command,
          next,
          makeEvent(command, seq, rev(next), 'ok', save.content_digest, null),
        );
      }
      case 'undo': {
        const next = undoSession(session.state);
        return recordAndSettle(session, command, next, makeEvent(command, seq, rev(next), 'ok', null, null));
      }
      case 'redo': {
        const next = redoSession(session.state);
        return recordAndSettle(session, command, next, makeEvent(command, seq, rev(next), 'ok', null, null));
      }
      case 'close': {
        return recordAndSettle(
          session,
          command,
          session.state,
          makeEvent(command, seq, rev(session.state), 'ok', null, null),
        );
      }
      default: {
        const never: never = command.operation;
        const error: XlsxEventError = Object.freeze({
          code: 'invalid_command' as const,
          message: `未知操作 ${JSON.stringify(never)}`,
        });
        return recordAndSettle(
          session,
          command,
          session.state,
          makeEvent(command, seq, rev(session.state), 'rejected', null, error),
        );
      }
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const failure: XlsxEventError = Object.freeze({
      code: 'operation_failed' as const,
      message: error.message,
    });
    return recordAndSettle(
      session,
      command,
      session.state,
      makeEvent(command, seq, rev(session.state), 'rejected', null, failure),
    );
  }
}
