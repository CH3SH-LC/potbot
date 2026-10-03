/**
 * X10 / XLS-17-18 集成：会话可持久状态的**纯序列化器**（无 node 依赖）——定向套件。
 *
 * 关键断言：序列化 / 反序列化不改变回滚的**字节等价**（`sourceDigest()` 前后相等）
 * 与**版本不变量**（`revision` 守恒、账本状态如实）；损坏 / 篡改显式失败。
 */
import { describe, expect, it } from 'vitest';

import { emptyWorkbook } from '../../../../src/session/adapters/xlsx.js';
import {
  createSpreadsheetSession,
  SPREADSHEET_SESSION_SCHEMA,
  type SpreadsheetSession,
} from '../../../../src/mobile-plugins/spreadsheets/session/transaction.js';
import {
  deserializeDurableState,
  parseDurableState,
  serializeDurableState,
  serializeSession,
  sessionFromDurableState,
  SPREADSHEET_DURABLE_SCHEMA,
  toDurableState,
  type DurableState,
} from '../../../../src/mobile-plugins/spreadsheets/session/durable.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const text = (value: string): CellValue => ({ kind: 'text', value });

function read(session: SpreadsheetSession, sheetName: string, ref: string): CellValue {
  const sheet = getSheet(session.workbook, sheetName);
  if (sheet === undefined) throw new Error(`没有工作表 ${sheetName}`);
  return getCellValue(sheet, ref);
}

describe('序列化：会话 → 字符串 → 会话', () => {
  it('JSON 往返后版本、源摘要、内容、可继续编辑一致', () => {
    const session = createSpreadsheetSession({ session_id: 'durable-1', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('甲') });
    session.apply({ op: 'insert_rows', sheet: 'S', at: 1, count: 1 });
    session.undo();

    const wire = serializeSession(session);
    expect(typeof wire).toBe('string');

    const restored = sessionFromDurableState(wire);
    expect(restored.session_id).toBe('durable-1');
    expect(restored.revision).toBe(session.revision);
    expect(restored.sourceDigest()).toBe(session.sourceDigest());
    expect(read(restored, 'S', 'A1')).toEqual(text('甲'));
    // 历史被完整重建：redo 还能前进。
    expect(restored.redo()).toEqual({ ok: true, revision: session.revision + 1 });
  });

  it('序列化是确定性的（同一会话两次输出逐字节相同），且不改动会话', () => {
    const session = createSpreadsheetSession({ session_id: 'durable-2', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    const digestBefore = session.sourceDigest();
    const first = serializeSession(session);
    const second = serializeSession(session);
    expect(first).toBe(second);
    expect(session.sourceDigest()).toBe(digestBefore);
  });

  it('DurableState 是纯 JSON 值：可直接 JSON.parse，schema 标识正确', () => {
    const session = createSpreadsheetSession({ session_id: 'durable-3', source: emptyWorkbook('S') });
    const state = toDurableState(session);
    expect(state.schema).toBe(SPREADSHEET_DURABLE_SCHEMA);
    expect(state.snapshot.schema).toBe(SPREADSHEET_SESSION_SCHEMA);
    const parsed = JSON.parse(serializeDurableState(state)) as DurableState;
    expect(parsed.schema).toBe(SPREADSHEET_DURABLE_SCHEMA);
    expect(deserializeDurableState(JSON.stringify(parsed)).session_id).toBe('durable-3');
  });
});

describe('账本：提交 / 空转 / 回滚如实登记', () => {
  it('成功推进版本的步 base_revision = revision - 1；空转步 status=noop 且版本不变', () => {
    const session = createSpreadsheetSession({ session_id: 'journal-1', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });

    const journal = toDurableState(session).journal;
    expect(journal.length).toBe(2);
    expect(journal[0]).toMatchObject({ status: 'committed', base_revision: 0, revision: 1 });
    expect(journal[1]).toMatchObject({ status: 'noop', base_revision: 1, revision: 1 });
  });

  it('失败批次：整批回滚，账本记 aborted，源摘要逐字节不变（经落盘往返仍不变）', () => {
    const session = createSpreadsheetSession({ session_id: 'journal-2', source: emptyWorkbook('S') });
    const before = session.sourceDigest();
    session.applyBatch(
      [
        { op: 'set_cell', sheet: 'S', address: 'A1', value: text('会回滚') },
        { op: 'totally_unknown' },
      ],
      'bad',
    );

    const state = toDurableState(session);
    expect(state.revision).toBe(0);
    expect(state.digest).toBe(before);
    expect(state.journal.length).toBe(1);
    expect(state.journal[0]?.status).toBe('aborted');
    expect(state.journal[0]?.revision).toBe(state.journal[0]?.base_revision);
    expect(state.journal[0]?.failure?.kind).toBe('unsupported_op');

    const restored = sessionFromDurableState(serializeDurableState(state));
    expect(restored.revision).toBe(0);
    expect(restored.sourceDigest()).toBe(before);
    expect(read(restored, 'S', 'A1')).toEqual({ kind: 'blank' });
  });
});

describe('载入核对：损坏 / 篡改显式失败（不猜）', () => {
  it('digest 被篡改 ⇒ sessionFromDurableState 抛错', () => {
    const session = createSpreadsheetSession({ session_id: 'guard-1', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    const state = JSON.parse(serializeSession(session)) as DurableState;
    const tampered = { ...state, digest: 'deadbeef' };
    expect(() => sessionFromDurableState(tampered as never)).toThrow();
  });

  it('schema 不符 / JSON 非法 / 非对象 ⇒ 抛错', () => {
    const session = createSpreadsheetSession({ session_id: 'guard-2', source: emptyWorkbook('S') });
    const state = JSON.parse(serializeSession(session)) as DurableState;
    expect(() => parseDurableState({ ...state, schema: 'something-else' } as never)).toThrow();
    expect(() => deserializeDurableState('{ not json')).toThrow();
    expect(() => parseDurableState([1, 2, 3] as never)).toThrow();
    expect(() => parseDurableState(42 as never)).toThrow();
  });

  it('账本与快照步骤对不上 ⇒ 抛错', () => {
    const session = createSpreadsheetSession({ session_id: 'guard-3', source: emptyWorkbook('S') });
    session.apply({ op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    const state = JSON.parse(serializeSession(session)) as DurableState;
    const truncated = { ...state, journal: [] };
    expect(() => parseDurableState(truncated as never)).toThrow();
  });

  it('snapshot.schema 被改 ⇒ 抛错', () => {
    const session = createSpreadsheetSession({ session_id: 'guard-4', source: emptyWorkbook('S') });
    const state = JSON.parse(serializeSession(session)) as DurableState;
    const broken = { ...state, snapshot: { ...state.snapshot, schema: 'x' } };
    expect(() => parseDurableState(broken as never)).toThrow();
  });
});
