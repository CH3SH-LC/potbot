/**
 * X-I28（池位 28）集成切片：**会话存取桥**（`SpreadsheetSessionStore`）。
 *
 * 把"保存会话 → 两条记录（快照 + 日志）→ 载入重建会话"整条链在**内存端口**上跑通，
 * 并逐条断言诚实边界：
 *
 * - 保存：快照记录与日志记录都落、都带同一逻辑版本；
 * - 载入：源摘要 / 版本 / 步骤数守恒（回环不变量）；
 * - 干净起点：从未保存过 ⇒ `clean-start`，不是"空会话"；
 * - 记录不全：只有日志无快照 ⇒ `incomplete`（保存中途断，不用日志拼会话）；
 * - 介质失败：注入读失败 ⇒ 抛 `read_failed`（坏介质 ≠ 空库）；
 * - 二进制损坏：快照字节被篡改 ⇒ 显式抛错（严格核对，不返回半可信会话）；
 * - 多版本：按 revision 载入更旧的快照仍守恒。
 */

import { describe, expect, it } from 'vitest';

import {
  bytesToDurableState,
  createInMemoryHostStorage,
  createSpreadsheetSessionStore,
  encodeUtf8,
  loadSession,
  saveSession,
  sessionToBytes,
} from '../../../../src/mobile-plugins/spreadsheets/bridge/index.js';
import {
  NO_RESIDUAL,
  SpreadsheetSession,
} from '../../../../src/mobile-plugins/spreadsheets/session/index.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';

const SHEET = 'S1';

function newSession(sessionId = 'sess-store-1'): SpreadsheetSession {
  let sheet = createSheet(SHEET, { row_count: 4, column_count: 4 });
  sheet = setCellValue(sheet, 'A1', textValue('n'));
  sheet = setCellValue(sheet, 'A2', numberValue(1));
  return SpreadsheetSession.create({
    session_id: sessionId,
    source: { workbook: createWorkbook([sheet]), residual: NO_RESIDUAL },
  });
}

function edit(session: SpreadsheetSession, address: string, value: number, label: string): void {
  const outcome = session.applyBatch([{ op: 'set_cell', sheet: SHEET, address, value: numberValue(value) }], label);
  if (!outcome.ok) throw new Error(`夹具编辑 ${label} 失败`);
}

describe('X-I28 · 会话存取桥：保存 / 载入回环', () => {
  it('保存落快照 + 日志两条记录，同版本；载入四项守恒', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    const session = newSession();
    edit(session, 'B2', 42, 'set-b2');
    edit(session, 'C2', 7, 'set-c2');

    const digest = session.sourceDigest();
    const revision = session.revision;
    const receipt = await store.save(session);

    expect(receipt.session_id).toBe('sess-store-1');
    expect(receipt.revision).toBe(revision);
    expect(receipt.digest).toBe(digest);
    expect(receipt.snapshot.byteLength).toBeGreaterThan(0);
    expect(receipt.journal.byteLength).toBeGreaterThan(0);
    // 两条记录都真的落到端口上（不是只算了个回执）。
    expect(port.peekRecord({ session_id: 'sess-store-1', kind: 'snapshot', revision })).toBeDefined();
    expect(port.peekRecord({ session_id: 'sess-store-1', kind: 'journal', revision })).toBeDefined();

    const loaded = await store.load('sess-store-1');
    expect(loaded.outcome).toBe('loaded');
    if (loaded.outcome !== 'loaded') return;
    expect(loaded.revision).toBe(revision);
    expect(loaded.durable.digest).toBe(digest);
    expect(loaded.session.sourceDigest()).toBe(digest);
    expect(loaded.session.revision).toBe(revision);
    expect(loaded.session.steps.length).toBe(2);
    expect(loaded.session.session_id).toBe('sess-store-1');
  });

  it('日志记录是独立审计轨：读回步骤与快照的 steps 对齐', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    const session = newSession('sess-audit');
    edit(session, 'B2', 1, 'l1');
    edit(session, 'C2', 2, 'l2');
    await store.save(session);

    const journal = (await store.readJournal('sess-audit')) as readonly { seq: number; label: string }[];
    expect(journal).toHaveLength(2);
    expect(journal.map((entry) => entry.label)).toEqual(['l1', 'l2']);
    expect(journal.map((entry) => entry.seq)).toEqual([1, 2]);
    // 与快照里承载的会话步骤一致。
    const loaded = await store.load('sess-audit');
    if (loaded.outcome !== 'loaded') throw new Error('应载入');
    expect(journal.map((entry) => entry.label)).toEqual(loaded.session.steps.map((step) => step.label));
  });

  it('从未保存过 ⇒ clean-start（不是空会话）', async () => {
    const port = createInMemoryHostStorage();
    const loaded = await loadSession(port, 'never-saved');
    expect(loaded.outcome).toBe('clean-start');
  });

  it('只有日志无快照 ⇒ incomplete，拒绝用日志拼会话', async () => {
    const port = createInMemoryHostStorage();
    // 只写日志记录（模拟保存写到一半断）。
    await port.writeRecord({ session_id: 'half', kind: 'journal', revision: 1 }, encodeUtf8('[]'));
    const loaded = await loadSession(port, 'half');
    expect(loaded.outcome).toBe('incomplete');
  });

  it('loadOrThrow：无记录时抛 incomplete_persistence', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    await expect(store.loadOrThrow('absent')).rejects.toMatchObject({ code: 'incomplete_persistence' });
  });
});

describe('X-I28 · 会话存取桥：失败与损坏路径', () => {
  it('注入读失败 ⇒ 抛 read_failed（坏介质 ≠ 空库）', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    const session = newSession('sess-fail');
    edit(session, 'B2', 5, 'l1');
    await store.save(session);

    port.setFaults({ failRead: { detail: '介质不可达' } });
    await expect(store.load('sess-fail')).rejects.toMatchObject({ code: 'read_failed' });
  });

  it('快照字节被篡改 ⇒ 显式抛错（严格核对，不返回半可信会话）', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    const session = newSession('sess-tamper');
    edit(session, 'B2', 5, 'l1');
    const receipt = await store.save(session);

    // 覆盖同引用快照记录为一段"schema 合法但内容非法"的字节。
    await port.writeRecord(
      { session_id: 'sess-tamper', kind: 'snapshot', revision: receipt.revision },
      encodeUtf8(JSON.stringify({ schema: 'potbot-spreadsheet-durable.v1', session_id: 'sess-tamper' })),
    );
    await expect(store.load('sess-tamper')).rejects.toThrow();
  });

  it('指向不存在的版本 ⇒ incomplete（not_found 不当成功）', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    const session = newSession('sess-miss');
    edit(session, 'B2', 5, 'l1');
    const receipt = await store.save(session);

    const missing = await store.loadRevision('sess-miss', receipt.revision + 100);
    expect(missing.outcome).toBe('incomplete');
  });

  it('多版本：按 revision 载入更旧的快照仍守恒', async () => {
    const port = createInMemoryHostStorage();
    const store = createSpreadsheetSessionStore(port);
    const session = newSession('sess-ver');
    edit(session, 'B2', 10, 'v2');
    const digestAt2 = session.sourceDigest();
    const revisionAt2 = session.revision;
    await store.save(session);

    edit(session, 'C2', 20, 'v3');
    const digestAt3 = session.sourceDigest();
    await store.save(session);

    expect(await store.snapshotRevisions('sess-ver')).toEqual([revisionAt2, revisionAt2 + 1]);

    const older = await store.loadRevision('sess-ver', revisionAt2);
    expect(older.outcome).toBe('loaded');
    if (older.outcome !== 'loaded') return;
    expect(older.revision).toBe(revisionAt2);
    expect(older.session.sourceDigest()).toBe(digestAt2);
    expect(older.session.steps.length).toBe(1);

    const latest = await store.load('sess-ver');
    if (latest.outcome !== 'loaded') throw new Error('应载入最新');
    expect(latest.session.sourceDigest()).toBe(digestAt3);
  });

  it('bytesToDurableState 直通：与 sessionToBytes 同源（同一份字节两种读法）', async () => {
    const session = newSession('sess-direct');
    edit(session, 'B2', 3, 'l1');
    const bytes = sessionToBytes(session);
    const viaDurable = bytesToDurableState(bytes);
    const receipt = await saveSession(createInMemoryHostStorage(), session);
    expect(viaDurable.revision).toBe(receipt.revision);
    expect(viaDurable.journal).toHaveLength(1);
  });
});
