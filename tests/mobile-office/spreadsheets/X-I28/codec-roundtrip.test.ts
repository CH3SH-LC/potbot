/**
 * X-I28（池位 28）集成切片：**会话状态 ⇄ 字节的序列化器回环**。
 *
 * 把 X-I17 的会话持久状态（`session/durable.ts`）经本单元的 `codec.ts` 编成字节、再严格读回，
 * 断言回环不变量：**源摘要 / 版本 / 步骤数 / 会话 id** 四项都守恒。反向对照保证不是假绿：
 * 坏字节（非法 UTF-8）、错 schema、半截 JSON 都必须**显式失败**，不能被当成"能读"而放过。
 *
 * 独立夹具：本文件自建工作簿与会话，不复用其它 `*.test.ts` 的 helper。
 */

import { describe, expect, it } from 'vitest';

import {
  bytesToDurableState,
  bytesToSession,
  decodeUtf8Strict,
  durableStateToBytes,
  durableStateOf,
  encodeUtf8,
  journalToBytes,
  sessionToBytes,
} from '../../../../src/mobile-plugins/spreadsheets/bridge/index.js';
import {
  NO_RESIDUAL,
  SpreadsheetSession,
} from '../../../../src/mobile-plugins/spreadsheets/session/index.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SHEET = 'S1';

function baseWorkbook() {
  let sheet = createSheet(SHEET, { row_count: 4, column_count: 4 });
  sheet = setCellValue(sheet, 'A1', textValue('n'));
  sheet = setCellValue(sheet, 'A2', numberValue(1));
  return createWorkbook([sheet]);
}

/** 一个带两笔已提交编辑的会话（步骤日志长度 = 2）。 */
function sessionWithEdits(): SpreadsheetSession {
  const session = SpreadsheetSession.create({
    session_id: 'sess-bridge-1',
    source: { workbook: baseWorkbook(), residual: NO_RESIDUAL },
  });
  session.applyBatch([{ op: 'set_cell', sheet: SHEET, address: 'B2', value: numberValue(42) }], 'set-b2');
  session.applyBatch([{ op: 'set_cell', sheet: SHEET, address: 'C2', value: numberValue(7) }], 'set-c2');
  return session;
}

// ---------------------------------------------------------------------------
// UTF-8 纯函数
// ---------------------------------------------------------------------------

describe('X-I28 · UTF-8 严格编解码', () => {
  it('ASCII / 中文 / 基本平面外码点编解码互逆', () => {
    for (const text of ['', 'plain ascii', '预算表 A2=42', '𝄞 音乐符号 U+1D11E', 'emoji 🈚️']) {
      expect(decodeUtf8Strict(encodeUtf8(text))).toBe(text);
    }
  });

  it('非法 UTF-8 序列显式失败（不静默替换成 U+FFFD）', () => {
    // 0xff 不是任何合法 UTF-8 起始字节。
    expect(() => decodeUtf8Strict(Uint8Array.from([0xff, 0x41]))).toThrow(/非法 UTF-8 起始字节/);
    // 三字节起始后缺续字节。
    expect(() => decodeUtf8Strict(Uint8Array.from([0xe4, 0xb8]))).toThrow(/非法 UTF-8 三字节序列/);
    // 过度编码：0xc0 0x80 表示 U+0000 的非法两字节形式。
    expect(() => decodeUtf8Strict(Uint8Array.from([0xc0, 0x80]))).toThrow(/非法 UTF-8 起始字节/);
  });
});

// ---------------------------------------------------------------------------
// DurableState ⇄ 字节
// ---------------------------------------------------------------------------

describe('X-I28 · DurableState ⇄ 字节', () => {
  it('回环：版本 / 摘要 / 账本逐条守恒', () => {
    const session = sessionWithEdits();
    const state = durableStateOf(session);
    const bytes = durableStateToBytes(state);
    expect(bytes.length).toBeGreaterThan(0);

    const back = bytesToDurableState(bytes);
    expect(back.schema).toBe(state.schema);
    expect(back.session_id).toBe(state.session_id);
    expect(back.revision).toBe(state.revision);
    expect(back.digest).toBe(state.digest);
    expect(back.journal).toEqual(state.journal);
    expect(back.journal).toHaveLength(2);
    expect(back.journal.map((entry) => entry.label)).toEqual(['set-b2', 'set-c2']);
  });

  it('反向对照：错 schema 显式失败', () => {
    const wrong = encodeUtf8(JSON.stringify({ schema: 'potbot-other.v9', session_id: 'x' }));
    expect(() => bytesToDurableState(wrong)).toThrow();
  });

  it('反向对照：半截 JSON 显式失败', () => {
    const truncated = encodeUtf8('{"schema":"potbot-spreadsheet-durable.v1","session_id"');
    expect(() => bytesToDurableState(truncated)).toThrow();
  });

  it('日志数组独立编成字节（审计轨），可原样读回 JSON', () => {
    const session = sessionWithEdits();
    const state = durableStateOf(session);
    const journalBytes = journalToBytes(state.journal);
    const parsed = JSON.parse(decodeUtf8Strict(journalBytes)) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(state.journal)));
  });
});

// ---------------------------------------------------------------------------
// SpreadsheetSession ⇄ 字节（X-I17 会话状态回环）
// ---------------------------------------------------------------------------

describe('X-I28 · 会话 ⇄ 字节（X-I17 回环）', () => {
  it('回环：源摘要 / 版本 / 步骤数 / 会话 id 四项守恒', () => {
    const session = sessionWithEdits();
    const digest = session.sourceDigest();
    const revision = session.revision;
    const steps = session.steps.length;

    const restored = bytesToSession(sessionToBytes(session));

    expect(restored.sourceDigest()).toBe(digest);
    expect(restored.revision).toBe(revision);
    expect(restored.steps.length).toBe(steps);
    expect(restored.session_id).toBe(session.session_id);
    // 步骤日志逐条一致（seq / revision / label）。
    expect(restored.steps).toEqual(session.steps);
  });

  it('回环后的会话可继续编辑：版本单调推进', () => {
    const session = sessionWithEdits();
    const restored = bytesToSession(sessionToBytes(session));
    const before = restored.revision;
    const outcome = restored.applyBatch(
      [{ op: 'set_cell', sheet: SHEET, address: 'D2', value: numberValue(99) }],
      'set-d2',
    );
    expect(outcome.ok).toBe(true);
    expect(restored.revision).toBe(before + 1);
    // 再回环一次仍守恒。
    const again = bytesToSession(sessionToBytes(restored));
    expect(again.sourceDigest()).toBe(restored.sourceDigest());
    expect(again.revision).toBe(restored.revision);
  });

  it('反向对照：账本 / 快照不一致导致显式失败，不返回半可信会话', () => {
    const session = sessionWithEdits();
    const text = decodeUtf8Strict(sessionToBytes(session));

    // `journal` 与 `snapshot.log` 是同一笔状态的两处视图。只改其中一处（第一次出现即 journal），
    // 制造不一致 ⇒ 必须被 `assertJournalMatchesSnapshot` 拒绝。
    const broken = encodeUtf8(text.replace('"set-b2"', '"set-b2-XXXX"'));
    expect(() => bytesToSession(broken)).toThrow(/不一致/);

    // 反向对照的另一半：改会话 id（不进入 sourceDigest）应能读回，证明上面的 throw 确实来自
    // 一致性核对，而不是"随便改一处就抛"。
    const renamed = bytesToSession(encodeUtf8(text.replaceAll('sess-bridge-1', 'sess-bridge-9')));
    expect(renamed.session_id).toBe('sess-bridge-9');
    expect(session.session_id).toBe('sess-bridge-1'); // 原会话未被改动
  });
});
