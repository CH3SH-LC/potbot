/**
 * **X-R04 / 崩溃事务与撤销恢复**独立验收。
 *
 * 判据分六组（每组都带**反向对照**，否则绿灯没有信息量）：
 *
 * 1. **失败保旧跨崩溃**：改写函数**直接往草稿的 `Map` 里塞值**再抛错 ⇒ 规范状态逐字节未动、
 *    版本号不消耗、账本记为 `aborted`（反面对照：不做深拷贝的 `cloneWorkbook` 会污染规范状态）；
 * 2. **崩在提交后、落盘前**：恢复回最后一个落盘版本，并把"被回退的版本"**如实列出**；
 * 3. **崩在 open 事务中**：该事务被列为 `crashed_open`，恢复后账本里不再有 `open`（语义明确）；
 * 4. **撤销恢复**：恢复后仍能 undo 回崩溃前的更早落盘版本，且**字节摘要逐版相同**；
 * 5. **恢复拒绝**：账本与磁盘对不上时 `stale_checkpoint` / `inconsistent_store` / `no_checkpoint`，
 *    **不返回一个猜出来的工作簿**；恢复本身幂等（跑两次同一结论）；
 * 6. **操作合同**：v1 信封的幂等（重复 key 返回原事件）、旧修订冲突、坏命令拒绝。
 */

import { describe, expect, it } from 'vitest';

import { xlsxContentDigest } from '../../../../src/artifacts/templates/xlsx.js';
import { compareWorkbooks, currentRevision, updateSheet } from '../../../../src/spreadsheets/history.js';
import { openWorkbookDocument } from '../../../../src/spreadsheets/xls-io.js';
import { setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { textValue, type CellValue } from '../../../../src/spreadsheets/value.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import {
  abortTransaction,
  beginTransaction,
  cellText,
  commitTransaction,
  createSession,
  documentWithRows,
  durableState,
  recoverFromCrash,
  redoSession,
  saveSession,
  undoSession,
  workbookDigest,
  type TransactionRecord,
} from './crash-safety.js';
import { MOBILE_CONTRACT_SCHEMA_VERSION, applyCommand, createCommandSession } from './operations.js';

/** 一个会话：导入三行、落盘为版本 0。 */
function savedSession(): ReturnType<typeof createSession> {
  return saveSession(createSession(documentWithRows('预算.xlsx', ['a', 'b']))).session;
}

// ---------------------------------------------------------------------------
// §1 失败保旧（跨"崩溃"仍成立）
// ---------------------------------------------------------------------------

describe('X-R04 §1 失败保旧（失败不得留下半个工作簿）', () => {
  it('改写函数往草稿 Map 塞值后抛错 ⇒ 规范状态未动、版本不消耗、账本记 aborted', () => {
    const session = savedSession();
    const before = workbookDigest(session.document, session.history.present.workbook);

    const begun = beginTransaction(session, 't1', '改到一半');
    const outcome = commitTransaction(begun.session, begun.handle, (workbook) => {
      const sheet = getSheet(workbook, 'S');
      expect(sheet).toBeDefined();
      // **故意**直接往草稿的 Map 里写（对象冻结拦不住 Map.set）——这正是要挡的污染路径。
      // 类型上 `cells` 是 `ReadonlyMap`（对外只读），这里显式越过它来模拟"有 bug 的改写函数"；
      // 运行时 `cloneWorkbook` 给的是真 `Map`，所以这一句**真的**会写进去。
      const writableCells = sheet?.cells as unknown as Map<string, CellValue>;
      writableCells.set('Z99', textValue('污染'));
      throw new Error('boom：改到一半就崩');
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(currentRevision(outcome.session.history)).toBe(0);
    expect(cellText(outcome.session.history.present.workbook, 'S', 'Z99')).toBeUndefined();
    // 反面对照：规范状态的字节身份与失败前**逐字节相同**。
    expect(workbookDigest(outcome.session.document, outcome.session.history.present.workbook)).toBe(before);
    expect(outcome.session.journal.find((record) => record.transaction_id === 't1')?.status).toBe('aborted');
  });

  it('失败不消耗版本号：失败后再提交，版本从 0 递增到 1', () => {
    const session = savedSession();
    const badBegin = beginTransaction(session, 'bad', '坏的');
    const failed = commitTransaction(badBegin.session, badBegin.handle, () => {
      throw new Error('nope');
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;

    const goodBegin = beginTransaction(failed.session, 'good', '好的');
    const good = commitTransaction(goodBegin.session, goodBegin.handle, (workbook) =>
      updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A2', textValue('B'))),
    );
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.revision).toBe(1);
    expect(good.session.journal.filter((record) => record.status === 'aborted').length).toBe(1);
  });

  it('重复的事务 ID 显式报错（不会把两笔事务混成一条账）', () => {
    const begun = beginTransaction(savedSession(), 'dup', '第一笔');
    expect(() => beginTransaction(begun.session, 'dup', '第二笔')).toThrow();
  });

  it('放弃（abort）不消耗版本号，也不改工作簿', () => {
    const session = savedSession();
    const begun = beginTransaction(session, 't9', '写一半不写了');
    const after = abortTransaction(begun.session, begun.handle);
    expect(currentRevision(after.history)).toBe(0);
    expect(after.journal.find((record) => record.transaction_id === 't9')?.status).toBe('aborted');
    expect(workbookDigest(after.document, after.history.present.workbook)).toBe(
      workbookDigest(session.document, session.history.present.workbook),
    );
  });
});

// ---------------------------------------------------------------------------
// §2 崩在提交后、落盘前
// ---------------------------------------------------------------------------

describe('X-R04 §2 崩溃事务：已提交未落盘 ⇒ 回退并如实登记', () => {
  it('恢复回最后一版落盘，被回退的版本号列出，未落盘改动**不**被采纳', () => {
    let session = savedSession(); // rev0 已落盘
    const t1 = beginTransaction(session, 't1', '写 A2');
    const r1 = commitTransaction(t1.session, t1.handle, (workbook) =>
      updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A2', textValue('B'))),
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    session = saveSession(r1.session).session; // rev1 已落盘

    const t2 = beginTransaction(session, 't2', '写 A3');
    const r2 = commitTransaction(t2.session, t2.handle, (workbook) =>
      updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A3', textValue('C'))),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    session = r2.session; // rev2 **没有**落盘 —— 此刻进程被系统回收

    const store = durableState(session);
    const checkpoint = store.snapshots.get(1);
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) return;

    const recovered = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: checkpoint,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.recovered_revision).toBe(1);
    expect(recovered.reverted_unpersisted_revisions).toEqual([2]);
    expect(currentRevision(recovered.session.history)).toBe(1);
    expect(cellText(recovered.session.history.present.workbook, 'S', 'A2')).toMatchObject({
      kind: 'text',
      value: 'B',
    });
    // 未落盘的 A3='C' **不在**恢复后的工作簿里（不静默采纳）。
    expect(cellText(recovered.session.history.present.workbook, 'S', 'A3')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §3 崩在 open 事务中
// ---------------------------------------------------------------------------

describe('X-R04 §3 崩溃事务：open 记录按放弃处置并列出', () => {
  it('open 事务进 crashed_open，恢复后账本里不再有 open', () => {
    const saved = savedSession();
    const begun = beginTransaction(saved, 't-open', '开始但没提交');
    const store = durableState(begun.session);
    const checkpoint = store.snapshots.get(0);
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) return;

    const recovered = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: checkpoint,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.crashed_open_transactions).toEqual(['t-open']);
    expect(recovered.recovered_revision).toBe(0);
    expect(recovered.reverted_unpersisted_revisions).toEqual([]);
    expect(recovered.session.journal.some((record) => record.status === 'open')).toBe(false);
    expect(recovered.session.journal.find((record) => record.transaction_id === 't-open')?.status).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// §4 撤销恢复
// ---------------------------------------------------------------------------

describe('X-R04 §4 撤销恢复：崩溃后仍能 undo 回更早的落盘版本', () => {
  function threeSavedVersions() {
    let session = savedSession();
    const t1 = beginTransaction(session, 't1', '写 A2');
    const r1 = commitTransaction(t1.session, t1.handle, (workbook) =>
      updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A2', textValue('B'))),
    );
    if (!r1.ok) throw r1.error;
    session = saveSession(r1.session).session;

    const t2 = beginTransaction(session, 't2', '写 A3');
    const r2 = commitTransaction(t2.session, t2.handle, (workbook) =>
      updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A3', textValue('C'))),
    );
    if (!r2.ok) throw r2.error;
    session = saveSession(r2.session).session;
    return session;
  }

  it('恢复后 undo 逐版回到崩溃前的落盘内容（逐版摘要相同）', () => {
    const session = threeSavedVersions();
    const store = durableState(session);
    const checkpoint = store.snapshots.get(2);
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) return;

    const recovered = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: checkpoint,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.recovered_revision).toBe(2);
    expect(recovered.undo_depth).toBe(2);
    expect(recovered.history_labels).toEqual(['import', '写 A2', '写 A3']);

    // 恢复到的版本 = 落盘的第 2 版（逐格一致）。
    const snap2 = store.snapshots.get(2);
    expect(snap2).toBeDefined();
    if (snap2 !== undefined) {
      expect(
        compareWorkbooks(openWorkbookDocument('预算.xlsx', snap2).workbook, recovered.session.history.present.workbook)
          .identical,
      ).toBe(true);
    }

    // 真的走撤销：2 → 1 → 0，每一版都与当时的落盘字节逐格一致。
    const atOne = undoSession(recovered.session);
    expect(currentRevision(atOne.history)).toBe(1);
    const snap1 = store.snapshots.get(1);
    expect(snap1).toBeDefined();
    if (snap1 !== undefined) {
      expect(
        compareWorkbooks(openWorkbookDocument('预算.xlsx', snap1).workbook, atOne.history.present.workbook)
          .identical,
      ).toBe(true);
    }

    const atZero = undoSession(atOne);
    expect(currentRevision(atZero.history)).toBe(0);
    const snap0 = store.snapshots.get(0);
    expect(snap0).toBeDefined();
    if (snap0 !== undefined) {
      expect(
        compareWorkbooks(openWorkbookDocument('预算.xlsx', snap0).workbook, atZero.history.present.workbook)
          .identical,
      ).toBe(true);
    }

    const redoBack = redoSession(atZero);
    expect(currentRevision(redoBack.history)).toBe(1);
    const snap1Again = store.snapshots.get(1);
    if (snap1Again !== undefined) {
      expect(
        compareWorkbooks(openWorkbookDocument('预算.xlsx', snap1Again).workbook, redoBack.history.present.workbook)
          .identical,
      ).toBe(true);
    }
  });

  it('可撤销深度随落盘版本增长；恢复后落盘版本的字节摘要与账本记录一致', () => {
    const session = threeSavedVersions();
    const store = durableState(session);
    for (const record of store.journal) {
      if (record.saved_digest === null || record.revision === null) continue;
      const snapshot = store.snapshots.get(record.revision);
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) continue;
      expect(xlsxContentDigest(snapshot)).toBe(record.saved_digest);
    }
    const checkpoint = store.snapshots.get(2);
    if (checkpoint === undefined) return;
    const recovered = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: checkpoint,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    // 恢复后会话的 checkpoint 与落盘版本对齐（继续编辑可从这里往前走）。
    expect(recovered.session.checkpoint_revision).toBe(2);
    expect(recovered.session.history.present.revision).toBe(2);
    expect(recovered.session.history.present.label).toBe('写 A3');
    expect(recovered.session.document.source_digest).toBe(xlsxContentDigest(checkpoint));
  });
});

// ---------------------------------------------------------------------------
// §5 恢复拒绝 + 幂等
// ---------------------------------------------------------------------------

describe('X-R04 §5 恢复拒绝：查不到就说查不到', () => {
  function storeWithTwoVersions(): {
    readonly journal: readonly TransactionRecord[];
    readonly snapshots: ReadonlyMap<number, Uint8Array>;
  } {
    let session = savedSession();
    const t1 = beginTransaction(session, 't1', '写 A2');
    const r1 = commitTransaction(t1.session, t1.handle, (workbook) =>
      updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A2', textValue('B'))),
    );
    if (!r1.ok) throw r1.error;
    session = saveSession(r1.session).session;
    return durableState(session);
  }

  it('磁盘字节与账本任何落盘版本都对不上 ⇒ stale_checkpoint', () => {
    const store = storeWithTwoVersions();
    const other = storeWithTwoVersions();
    const wrongBytes = other.snapshots.get(1);
    if (wrongBytes === undefined) return;
    // 用另一份"内容不同"的工作簿字节冒充本会话的文件。
    const tampered = (() => {
      const t = beginTransaction(savedSession(), 'tx', '写 A2');
      const r = commitTransaction(t.session, t.handle, (workbook) =>
        updateSheet(workbook, 'S', (sheet) => setCellValue(sheet, 'A2', textValue('完全是别的内容'))),
      );
      if (!r.ok) throw r.error;
      return saveSession(r.session).save.bytes;
    })();
    const result = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: tampered,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_checkpoint');
  });

  it('快照与账本记录对不上 ⇒ inconsistent_store（抓得住被改过的快照）', () => {
    const store = storeWithTwoVersions();
    const snapshots = new Map(store.snapshots);
    snapshots.set(1, new Uint8Array([1, 2, 3]));
    const checkpoint = store.snapshots.get(1);
    if (checkpoint === undefined) return;
    const result = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots,
      current_bytes: checkpoint,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('inconsistent_store');
  });

  it('从未落盘 ⇒ no_checkpoint，不返回一个猜出来的工作簿', () => {
    const session = createSession(documentWithRows('预算.xlsx', ['a'])); // 一次 save 都没做
    const store = durableState(session);
    const result = recoverFromCrash({
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: saveSession(session).save.bytes,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_checkpoint');
  });

  it('恢复是幂等的：同一输入连跑两次 ⇒ 同一版本、同一标签序列', () => {
    const store = storeWithTwoVersions();
    const checkpoint = store.snapshots.get(1);
    if (checkpoint === undefined) return;
    const input = {
      file_name: '预算.xlsx',
      journal: store.journal,
      snapshots: store.snapshots,
      current_bytes: checkpoint,
    };
    const first = recoverFromCrash(input);
    const second = recoverFromCrash(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.recovered_revision).toBe(second.recovered_revision);
    expect(first.history_labels).toEqual(second.history_labels);
    expect(first.reverted_unpersisted_revisions).toEqual(second.reverted_unpersisted_revisions);
    expect(first.crashed_open_transactions).toEqual(second.crashed_open_transactions);
  });
});

// ---------------------------------------------------------------------------
// §6 操作合同（v1 命令 / 事件信封）
// ---------------------------------------------------------------------------

describe('X-R04 §6 操作合同：幂等 / 冲突 / 拒绝', () => {
  it('重复 idempotencyKey 返回**原来那条事件**，会话不再动手', () => {
    const session = savedSession();
    let commands = createCommandSession(session);
    const saveCommand = {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-save-1',
      operation: 'save' as const,
      idempotencyKey: 'k-save-1',
      payload: {},
    };
    const first = applyCommand(commands, saveCommand);
    expect(first.event.status).toBe('ok');
    expect(first.replay).toBe(false);
    expect(first.event.resultRef).not.toBeNull();
    commands = first.command;

    const retry = applyCommand(commands, { ...saveCommand, commandId: 'c-save-1-retry' });
    expect(retry.replay).toBe(true);
    expect(retry.event).toEqual(first.event); // 事件逐字段相同（同 seq / eventId / resultRef）
    expect(retry.command.seq).toBe(commands.seq); // 没有新事件
  });

  it('旧修订 ⇒ conflict（带 expected / current），会话状态不动', () => {
    let commands = createCommandSession(savedSession());
    const beginResult = applyCommand(commands, {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-begin',
      operation: 'begin',
      idempotencyKey: 'k-begin',
      payload: { transaction_id: 'x1', label: '写 A2' },
    });
    expect(beginResult.event.status).toBe('ok');
    commands = beginResult.command;

    const committed = applyCommand(commands, {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-commit',
      operation: 'commit',
      idempotencyKey: 'k-commit',
      payload: { transaction_id: 'x1', edits: [{ sheet: 'S', ref: 'A2', value: textValue('B') }] },
    });
    expect(committed.event.status).toBe('ok');
    expect(committed.event.revision).toBe(1);
    commands = committed.command;

    const before = workbookDigest(commands.state.document, commands.state.history.present.workbook);
    const stale = applyCommand(commands, {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-stale',
      operation: 'save',
      idempotencyKey: 'k-stale',
      payload: { expected_revision: 99 },
    });
    expect(stale.event.status).toBe('conflict');
    expect(stale.event.error?.code).toBe('stale_revision');
    expect(stale.event.error?.expected).toBe(99);
    expect(stale.event.error?.current).toBe(1);
    expect(workbookDigest(stale.command.state.document, stale.command.state.history.present.workbook)).toBe(before);
  });

  it('坏命令（工作表不存在 / schemaVersion 不符）⇒ rejected，工作簿不变', () => {
    let commands = createCommandSession(savedSession());
    const before = workbookDigest(commands.state.document, commands.state.history.present.workbook);

    const badSheet = applyCommand(commands, {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-badsheet',
      operation: 'begin',
      idempotencyKey: 'k-badsheet',
      payload: { transaction_id: 'xb', label: '写不存在的表' },
    });
    expect(badSheet.event.status).toBe('ok');
    commands = badSheet.command;
    const rejected = applyCommand(commands, {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-badsheet-commit',
      operation: 'commit',
      idempotencyKey: 'k-badsheet-commit',
      payload: { transaction_id: 'xb', edits: [{ sheet: '不存在的表', ref: 'A1', value: textValue('x') }] },
    });
    expect(rejected.event.status).toBe('rejected');
    expect(rejected.event.error?.code).toBe('operation_failed');
    expect(currentRevision(rejected.command.state.history)).toBe(0);
    expect(workbookDigest(rejected.command.state.document, rejected.command.state.history.present.workbook)).toBe(before);

    const badVersion = applyCommand(rejected.command, {
      schemaVersion: 'mobile-v2',
      commandId: 'c-badversion',
      operation: 'save',
      idempotencyKey: 'k-badversion',
      payload: {},
    });
    expect(badVersion.event.status).toBe('rejected');
    expect(badVersion.event.error?.code).toBe('invalid_command');

    const missingField = applyCommand(badVersion.command, {
      schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
      commandId: 'c-missing',
      operation: 'begin',
      idempotencyKey: 'k-missing',
      payload: {},
    });
    expect(missingField.event.status).toBe('rejected');
  });

  it('事件序号单调递增、eventId 由 commandId + seq 组成；撤销在栈空时明确 rejected', () => {
    let commands = createCommandSession(savedSession());
    const seen: number[] = [];
    const run = (index: number, operation: 'begin' | 'commit' | 'save' | 'undo' | 'redo' | 'close', payload = {}) => {
      const result = applyCommand(commands, {
        schemaVersion: MOBILE_CONTRACT_SCHEMA_VERSION,
        commandId: `c-${String(index)}`,
        operation,
        idempotencyKey: `k-${String(index)}`,
        payload,
      });
      seen.push(result.event.seq);
      expect(result.event.eventId).toBe(`c-${String(index)}#${String(result.event.seq)}`);
      commands = result.command;
      return result.event;
    };

    expect(run(0, 'save').status).toBe('ok');
    // 版本 0 上撤销：栈空 ⇒ 明确 rejected（不是静默 ok）。
    expect(run(1, 'undo').status).toBe('rejected');
    expect(run(2, 'begin', { transaction_id: 'x1', label: '写 A2' }).status).toBe('ok');
    expect(
      run(3, 'commit', { transaction_id: 'x1', edits: [{ sheet: 'S', ref: 'A2', value: textValue('B') }] }).status,
    ).toBe('ok');
    expect(run(4, 'save').status).toBe('ok');
    expect(run(5, 'undo').status).toBe('ok');
    expect(run(6, 'redo').status).toBe('ok');
    expect(run(7, 'redo').status).toBe('rejected'); // 未来栈已空
    expect(run(8, 'close').status).toBe('ok');

    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThan(seen[index - 1] as number);
    }
  });
});
