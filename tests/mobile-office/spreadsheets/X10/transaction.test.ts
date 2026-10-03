/**
 * X10 / XLS-17：事务撤销、版本与恢复 —— 定向套件。
 *
 * 关键断言：失败批次后**源摘要逐字节未动**（不是"看着没变"）；快照经 JSON 往返可重建。
 */
import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../../src/protocol/index.js';
import { emptyWorkbook } from '../../../../src/session/adapters/xlsx.js';
import {
  createSpreadsheetSession,
  SpreadsheetSession,
  SPREADSHEET_SESSION_SCHEMA,
} from '../../../../src/mobile-plugins/spreadsheets/session/transaction.js';
import { bindCell, EMPTY_BINDING_TABLE } from '../../../../src/spreadsheets/facts-binding.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const text = (value: string): CellValue => ({ kind: 'text', value });
const num = (value: number): CellValue => ({ kind: 'number', value });

function read(session: SpreadsheetSession, sheetName: string, ref: string): CellValue {
  const sheet = getSheet(session.workbook, sheetName);
  if (sheet === undefined) throw new Error(`没有工作表 ${sheetName}`);
  return getCellValue(sheet, ref);
}

describe('事务：一批全成或全不做', () => {
  it('批次里任一 op 失败 ⇒ 整批回滚，源摘要逐字节不变、版本不推进', () => {
    const session = createSpreadsheetSession({ session_id: 'tx-1', source: emptyWorkbook('S') });
    const before = session.sourceDigest();

    const outcome = session.applyBatch(
      [
        { op: 'set_cell', sheet: 'S', address: 'A1', value: text('会回滚') },
        { op: 'set_cell', sheet: 'S', address: 'A2', value: text('也不该写入') },
        { op: 'totally_unknown' },
      ],
      'half-way',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.rolled_back).toBe(true);
    expect(outcome.revision).toBe(0);
    expect(outcome.failure?.kind).toBe('unsupported_op');
    // 前两个 op 的写入**一个都没落地**。
    expect(read(session, 'S', 'A1')).toEqual({ kind: 'blank' });
    expect(read(session, 'S', 'A2')).toEqual({ kind: 'blank' });
    expect(session.sourceDigest()).toBe(before);
    expect(session.revision).toBe(0);
  });

  it('批次全部成功 ⇒ 推进一个版本，两处改动都在', () => {
    const session = createSpreadsheetSession({ session_id: 'tx-2', source: emptyWorkbook('S') });
    const outcome = session.applyBatch(
      [
        { op: 'set_cell', sheet: 'S', address: 'A1', value: text('其一') },
        { op: 'add_sheet', name: '明细' },
      ],
      'two-ops',
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(outcome.revision).toBe(1);
    expect(read(session, 'S', 'A1')).toEqual(text('其一'));
    expect(getSheet(session.workbook, '明细')).toBeDefined();
  });

  it('空转批次（同值重设）不推进版本', () => {
    const session = createSpreadsheetSession({ session_id: 'tx-3', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    const revision = session.revision;
    const idle = session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    expect(idle.ok).toBe(true);
    expect(idle.changed).toBe(false);
    expect(session.revision).toBe(revision);
  });

  it('步骤日志记录成功与失败，失败条目标注结构化原因', () => {
    const session = createSpreadsheetSession({ session_id: 'tx-4', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    session.applyBatch([{ op: 'nope' }], 'bad');
    const steps = session.steps;
    expect(steps.length).toBe(2);
    expect(steps[0]?.changed).toBe(true);
    expect(steps[1]?.failure?.kind).toBe('unsupported_op');
    expect(steps[1]?.revision).toBe(1);
  });
});

describe('版本：撤销 / 重做 / 恢复到任意版本', () => {
  it('undo 回退、redo 前进，内容对应', () => {
    const session = createSpreadsheetSession({ session_id: 'v-1', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('第一') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A2', value: text('第二') });
    expect(session.revision).toBe(2);

    expect(session.undo()).toEqual({ ok: true, revision: 1 });
    expect(read(session, 'S', 'A2')).toEqual({ kind: 'blank' });
    expect(session.redo()).toEqual({ ok: true, revision: 2 });
    expect(read(session, 'S', 'A2')).toEqual(text('第二'));
  });

  it('restore 可回溯到旧版并再次跳到被跳过的版本', () => {
    const session = createSpreadsheetSession({ session_id: 'v-2', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('v1') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A2', value: text('v2') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A3', value: text('v3') });

    expect(session.restore(0)).toEqual({ ok: true, revision: 0 });
    expect(read(session, 'S', 'A1')).toEqual({ kind: 'blank' });
    // 跳到被跳过的 v2（现在它在"未来"里）。
    expect(session.restore(2)).toEqual({ ok: true, revision: 2 });
    expect(read(session, 'S', 'A1')).toEqual(text('v1'));
    expect(read(session, 'S', 'A2')).toEqual(text('v2'));
    expect(read(session, 'S', 'A3')).toEqual({ kind: 'blank' });
    // 未知版本如实拒绝。
    const missing = session.restore(99);
    expect(missing.ok).toBe(false);
  });

  it('无版本可撤销时 undo 返回结构化失败（不抛）', () => {
    const session = createSpreadsheetSession({ session_id: 'v-3', source: emptyWorkbook('S') });
    const outcome = session.undo();
    expect(outcome.ok).toBe(false);
  });
});

describe('恢复：快照 → JSON → 读回', () => {
  it('快照经 JSON 往返后重建，版本、内容、摘要一致', () => {
    const session = createSpreadsheetSession({ session_id: 'snap-1', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('甲') });
    session.apply({ op: 'insert_rows', sheet: 'S', at: 1, count: 1 });
    session.undo();

    const snapshot = session.snapshot();
    expect(snapshot.schema).toBe(SPREADSHEET_SESSION_SCHEMA);
    const wire = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const restored = SpreadsheetSession.restore(wire);

    expect(restored.revision).toBe(session.revision);
    expect(restored.workbook.sheets.map((sheet) => sheet.name)).toEqual(['S']);
    expect(restored.sourceDigest()).toBe(session.sourceDigest());
    // 恢复后仍能 undo / redo（历史被完整重建）。
    expect(restored.redo()).toEqual({ ok: true, revision: session.revision + 1 });
  });

  it('schema 不符 ⇒ 抛错（不猜、不尽量恢复）', () => {
    const session = createSpreadsheetSession({ session_id: 'snap-2', source: emptyWorkbook('S') });
    const broken = { ...session.snapshot(), schema: 'something-else' };
    expect(() => SpreadsheetSession.restore(broken as never)).toThrow();
  });
});

describe('事实更新的事务与版本守卫', () => {
  it('版本推进 ⇒ 只改写绑定格并重算闭包；迟到 / 同版冲突被拒且不改源', () => {
    const bindings = bindCell(EMPTY_BINDING_TABLE, { sheet: 'S', ref: 'B1', fact_key: 'headcount', version: 0 });
    const session = createSpreadsheetSession({
      session_id: 'f-1',
      source: emptyWorkbook('S'),
      bindings,
    });
    // 无关格：绑定无关的证据。
    session.apply({ op: 'set_cell', sheet: 'S', address: 'Z9', value: text('无关') });

    const applied = session.applyFactUpdates([
      { fact_key: 'headcount', version: 1, value: num(12), source: 'doc-1', at: asLogicalTime(1) },
    ]);
    expect(applied.ok).toBe(true);
    expect(applied.changed).toBe(true);
    expect(applied.applied_fact_keys).toEqual(['headcount']);
    expect(applied.rewritten_cell_keys).toContain('S!B1');
    expect(read(session, 'S', 'B1')).toEqual(num(12));
    expect(applied.rewritten_cell_keys).not.toContain('S!Z9');

    const revisionAfter = session.revision;
    const stale = session.applyFactUpdates([
      { fact_key: 'headcount', version: 1, value: num(99), source: 'doc-1', at: asLogicalTime(2) },
    ]);
    expect(stale.changed).toBe(false);
    expect(stale.applied_fact_keys).toEqual([]);
    expect(stale.rejected.map((entry) => entry.code)).toContain('version_conflict');
    expect(read(session, 'S', 'B1')).toEqual(num(12));
    expect(session.revision).toBe(revisionAfter);
  });
});
