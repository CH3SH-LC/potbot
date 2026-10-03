/**
 * X-I18（池位 18）集成切片：**历史恢复语义 × 共享事实发布 / 消费回执**。
 *
 * 目的不是重测两个模块的单元行为（那在各自的 `*.test.ts` 里有），而是把两条链**接起来**
 * 看边界是否自洽：
 *
 * 1. **恢复语义喂给事实路径**：`restoreAt` 取回任意版本的工作簿后，`applyFactUpdates`
 *    必须只改绑定格、重算受影响闭包，且**不回头污染历史快照**（深拷贝隔离）。
 * 2. **发布 / 消费回执的诚实性**：无通道 ⇒ 结构化 `not-wired`、`claimed_published` 恒
 *    字面量 `false`；消费端只有**同版 + 非空 `receipt_ref`** 才算数，失败时**保留违规回执**。
 * 3. **版本对齐**：消费回执回带的 `revision` 必须与快照 `revision` 相等，把"同一版本"
 *    从一句口号变成可断言的事实。
 *
 * 独立夹具：本文件自带 helper，不复用 `src/spreadsheets/*.test.ts` 的夹具。
 * 结果不得编造：未接通道一律 `not-wired`；真实安卓 WPS / Excel 打开**未验证**（不在本套件层）。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../../src/protocol/index.js';
import {
  EMPTY_BINDING_TABLE,
  applyFactUpdates,
  bindCell,
  checkSameVersionConsumption,
  consumeSharedFactSnapshot,
  listUnwiredTargets,
  publishSharedFacts,
  type FactConsumptionReceipt,
  type SameVersionConsumePort,
  type SharedFactPublication,
  type SharedFactSnapshot,
  type TemplatePublicationResult,
} from '../../../../src/spreadsheets/facts-binding.js';
import {
  commit,
  createHistory,
  currentRevision,
  currentWorkbook,
  knownRevisions,
  redoDepth,
  restoreAt,
  versionTimeline,
  type HistoryState,
} from '../../../../src/spreadsheets/history.js';
import {
  createSheet,
  getCellValue,
  setCellValue,
  type SheetState,
} from '../../../../src/spreadsheets/sheet.js';
import {
  createWorkbook,
  getSheet,
  type WorkbookState,
} from '../../../../src/spreadsheets/workbook.js';
import {
  blank,
  formulaValue,
  numberValue,
  textValue,
  type CellValue,
} from '../../../../src/spreadsheets/value.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SHEET = '预算';

/** A1=标题、A2=人数(10)、B2=A2*2（公式）、C2=999（无关格）。 */
function baseWorkbook(): WorkbookState {
  let sheet = createSheet(SHEET, { row_count: 4, column_count: 3 });
  sheet = setCellValue(sheet, 'A1', textValue('人数'));
  sheet = setCellValue(sheet, 'A2', numberValue(10));
  sheet = setCellValue(sheet, 'B2', formulaValue('A2*2'));
  sheet = setCellValue(sheet, 'C2', numberValue(999));
  return createWorkbook([sheet]);
}

function sheetOf(workbook: WorkbookState): SheetState {
  const sheet = getSheet(workbook, SHEET);
  if (sheet === undefined) throw new Error(`夹具缺工作表 ${SHEET}`);
  return sheet;
}

function cell(workbook: WorkbookState, ref: string): CellValue {
  return getCellValue(sheetOf(workbook), ref);
}

/** 提交一次 headcount 事实更新（绑定版本 0 ⇒ 任意 version ≥ 1 都被接受），返回新历史。 */
function commitHeadcount(history: HistoryState, version: number, value: number, label: string): HistoryState {
  const table = bindCell(EMPTY_BINDING_TABLE, {
    sheet: SHEET,
    ref: 'A2',
    fact_key: 'headcount',
    version: 0,
  });
  const outcome = commit(history, label, (workbook) =>
    applyFactUpdates({
      workbook,
      table,
      updates: [
        {
          fact_key: 'headcount',
          version,
          value: numberValue(value),
          source: '用户对话确认',
          at: asLogicalTime(1000 + version),
        },
      ],
    }).workbook,
  );
  if (!outcome.ok) throw new Error(`夹具提交 ${label} 失败：${outcome.error.message}`);
  return outcome.history;
}

function makeSnapshot(revision: number): SharedFactSnapshot {
  return Object.freeze({
    snapshot_id: `snap-${revision}`,
    revision,
    source_refs: Object.freeze(['doc-1']),
    values: Object.freeze([
      Object.freeze({ fact_key: 'headcount', value: numberValue(10 * revision), unit: '人' }),
    ]),
    at: asLogicalTime(1000 + revision),
  });
}

function makeReceipt(
  snapshot: SharedFactSnapshot,
  overrides: Partial<FactConsumptionReceipt> = {},
): FactConsumptionReceipt {
  return Object.freeze({
    consumer: 'xlsx',
    snapshot_id: snapshot.snapshot_id,
    revision: snapshot.revision,
    consumed_fact_keys: Object.freeze(['headcount']),
    receipt_ref: 'rcpt-ok',
    consumed_at: snapshot.at,
    ...overrides,
  });
}

function receiptPort(receipt: FactConsumptionReceipt): SameVersionConsumePort {
  return { consumer: receipt.consumer, consume: () => Promise.resolve({ ok: true as const, receipt }) };
}

// ---------------------------------------------------------------------------
// ① 恢复语义 × 事实应用
// ---------------------------------------------------------------------------

describe('X-I18-①：restoreAt 取回的工作簿喂给事实路径', () => {
  it('三版历史：restoreAt 回到任意版本取回当时的单元格取值', () => {
    let history = createHistory(baseWorkbook(), 'v0');
    history = commitHeadcount(history, 1, 20, 'v1');
    history = commitHeadcount(history, 2, 30, 'v2'); // present=rev2
    expect(currentRevision(history)).toBe(2);
    expect(cell(currentWorkbook(history), 'A2')).toEqual(numberValue(30));

    const at0 = restoreAt(history, 0);
    expect(cell(currentWorkbook(at0), 'A2')).toEqual(numberValue(10));
    expect(cell(currentWorkbook(at0), 'B2')).toEqual(formulaValue('A2*2'));
    expect(cell(currentWorkbook(at0), 'C2')).toEqual(numberValue(999));

    const at1 = restoreAt(history, 1);
    expect(cell(currentWorkbook(at1), 'A2')).toEqual(numberValue(20));
    expect(at1.present).toBe(history.past[1]); // 只移动指针，快照共享
  });

  it('past<->future 双向跳转：从最旧跳回最新，快照一个不丢', () => {
    let history = createHistory(baseWorkbook(), 'v0');
    history = commitHeadcount(history, 1, 20, 'v1');
    history = commitHeadcount(history, 2, 30, 'v2');

    const at0 = restoreAt(history, 0);
    expect(currentRevision(at0)).toBe(0);
    expect(redoDepth(at0)).toBe(2);

    const backTo2 = restoreAt(at0, 2);
    expect(currentRevision(backTo2)).toBe(2);
    expect(cell(currentWorkbook(backTo2), 'A2')).toEqual(numberValue(30));
    expect(knownRevisions(backTo2)).toEqual([0, 1, 2]);
    expect(versionTimeline(backTo2).map((entry) => entry.position)).toEqual(['past', 'past', 'present']);
  });

  it('恢复后应用新事实：只改绑定格、重算闭包，且不回头污染历史快照', () => {
    let history = createHistory(baseWorkbook(), 'v0');
    history = commitHeadcount(history, 1, 20, 'v1');
    history = commitHeadcount(history, 2, 30, 'v2');
    const at1 = restoreAt(history, 1);
    expect(cell(currentWorkbook(at1), 'A2')).toEqual(numberValue(20));

    const table = bindCell(EMPTY_BINDING_TABLE, {
      sheet: SHEET,
      ref: 'A2',
      fact_key: 'headcount',
      version: 0,
    });
    const application = applyFactUpdates({
      workbook: currentWorkbook(at1),
      table,
      updates: [
        {
          fact_key: 'headcount',
          version: 3,
          value: numberValue(40),
          source: '用户对话确认',
          at: asLogicalTime(1003),
        },
      ],
    });

    expect(application.rewritten_cell_keys).toEqual([`${SHEET}!A2`]);
    expect(cell(application.workbook, 'A2')).toEqual(numberValue(40));
    expect(application.untouched_cell_keys).toContain(`${SHEET}!C2`);
    expect(application.recalculated_formula_keys).toEqual([`${SHEET}!B2`]);
    // 深拷贝隔离：事实应用不改写被恢复快照，也不改原始历史的 present
    expect(cell(currentWorkbook(at1), 'A2')).toEqual(numberValue(20));
    expect(cell(currentWorkbook(history), 'A2')).toEqual(numberValue(30));
  });

  it('反向对照：恢复不放松版本单调，迟到更新仍被拒', () => {
    let history = createHistory(baseWorkbook(), 'v0');
    history = commitHeadcount(history, 1, 20, 'v1');
    const at1 = restoreAt(history, 1);

    const staleTable = bindCell(EMPTY_BINDING_TABLE, {
      sheet: SHEET,
      ref: 'A2',
      fact_key: 'headcount',
      version: 2,
    });
    const stale = applyFactUpdates({
      workbook: currentWorkbook(at1),
      table: staleTable,
      updates: [
        {
          fact_key: 'headcount',
          version: 1,
          value: numberValue(5),
          source: '迟到',
          at: asLogicalTime(1),
        },
      ],
    });
    expect(stale.rejected[0]?.code).toBe('stale_version');
    expect(stale.rewritten_cell_keys).toEqual([]);
    expect(cell(stale.workbook, 'A2')).toEqual(numberValue(20)); // 值保持 v1
  });
});

// ---------------------------------------------------------------------------
// ② 发布 / 消费回执的诚实性
// ---------------------------------------------------------------------------

/** 类型层：`claimed_published` 必须是字面量 `false`。 */
type MustBeFalse<T extends false> = T;

describe('X-I18-②：发布 / 消费回执（未接线一律如实，不假称已同步）', () => {
  const PUBLICATIONS: readonly SharedFactPublication[] = Object.freeze([
    { fact_key: 'headcount', value: numberValue(30), version: 2, source: '用户对话确认', at: asLogicalTime(1002) },
  ]);

  it('发布：无通道 ⇒ docx / pptx 全 not-wired，claimed_published 恒 false', async () => {
    const results = await publishSharedFacts({ channels: [], publications: PUBLICATIONS });
    expect(results.map((entry) => entry.wire_state)).toEqual(['not-wired', 'not-wired']);
    expect(results.every((entry) => entry.claimed_published === false)).toBe(true);
    expect(listUnwiredTargets(results)).toEqual(['docx', 'pptx']);
  });

  it('发布：接了 docx 且带受理回执 ⇒ published，但 claimed_published 仍为 false（受理 ≠ 生效）', async () => {
    const results = await publishSharedFacts({
      channels: [
        { target: 'docx', publish: () => Promise.resolve({ ok: true as const, receipt_ref: 'doc-rcpt-1' }) },
      ],
      publications: PUBLICATIONS,
    });
    const docx = results.find((entry) => entry.target === 'docx');
    expect(docx).toMatchObject({
      wire_state: 'published',
      acknowledged: true,
      receipt_ref: 'doc-rcpt-1',
      claimed_published: false,
    });
    expect(listUnwiredTargets(results)).toEqual(['pptx']);
  });

  it('类型层：claimed_published 是字面量 false', () => {
    const literal: MustBeFalse<TemplatePublicationResult['claimed_published']> = false;
    expect(literal).toBe(false);
  });

  it('消费：未接线 ⇒ not-wired / consumed=false（接口点存在不等于能力可用）', async () => {
    const snapshot = makeSnapshot(2);
    const result = await consumeSharedFactSnapshot(undefined, snapshot);
    expect(result).toMatchObject({ wire_state: 'not-wired', consumed: false, receipt: null, version_matched: false });
    expect(checkSameVersionConsumption(snapshot, result)).toEqual([]);
  });

  it('消费：同版 + 非空回执 ⇒ consumed=true，无违规', async () => {
    const snapshot = makeSnapshot(2);
    const result = await consumeSharedFactSnapshot(receiptPort(makeReceipt(snapshot)), snapshot);
    expect(result).toMatchObject({ wire_state: 'consumed', consumed: true, version_matched: true, snapshot_revision: 2 });
    expect(checkSameVersionConsumption(snapshot, result)).toEqual([]);
  });

  it('消费：跨版本回执 ⇒ failed / version_matched=false，违规回执保留供机器判定', async () => {
    const snapshot = makeSnapshot(2);
    const result = await consumeSharedFactSnapshot(
      receiptPort(makeReceipt(snapshot, { revision: 3, receipt_ref: 'rcpt-late' })),
      snapshot,
    );
    expect(result.wire_state).toBe('failed');
    expect(result.consumed).toBe(false);
    expect(result.version_matched).toBe(false);
    expect(result.receipt?.revision).toBe(3);
    expect(result.receipt?.receipt_ref).toBe('rcpt-late');
    expect(checkSameVersionConsumption(snapshot, result).map((entry) => entry.code)).toContain('version_mismatch');
  });

  it('串联：事实应用推进到版本 2 后，同版 2 的快照被消费且回执版本 = 2', async () => {
    let history = createHistory(baseWorkbook(), 'v0');
    history = commitHeadcount(history, 1, 20, 'v1');
    history = commitHeadcount(history, 2, 30, 'v2');
    expect(currentRevision(history)).toBe(2);

    // 快照 revision 与事实版本对齐：消费端回执必须回带同一版本号
    const snapshot = makeSnapshot(2);
    const result = await consumeSharedFactSnapshot(receiptPort(makeReceipt(snapshot)), snapshot);
    expect(result.consumed).toBe(true);
    expect(result.snapshot_revision).toBe(2);
    expect(result.receipt?.revision).toBe(2);
  });

  it('消费：空 / 纯空白 receipt_ref ⇒ failed（没有引用号的回执不是证据）', async () => {
    const snapshot = makeSnapshot(2);
    for (const ref of ['', '  ']) {
      const result = await consumeSharedFactSnapshot(receiptPort(makeReceipt(snapshot, { receipt_ref: ref })), snapshot);
      expect(result.wire_state).toBe('failed');
      expect(checkSameVersionConsumption(snapshot, result).map((entry) => entry.code)).toContain(
        'claimed_without_receipt',
      );
    }
  });

  it('历史恢复到的旧版本取值与事实应用的输入保持同一份（恢复 = 事实路径的合法输入）', () => {
    let history = createHistory(baseWorkbook(), 'v0');
    history = commitHeadcount(history, 1, 20, 'v1');
    const at0 = restoreAt(history, 0);
    // rev0：A2 还是初始 10，B2 仍是公式 —— 恢复出的旧版可以直接再走事实/重算路径
    expect(cell(currentWorkbook(at0), 'A2')).toEqual(numberValue(10));
    expect(cell(currentWorkbook(at0), 'C2')).toEqual(numberValue(999));
    expect(cell(currentWorkbook(at0), 'A1')).toEqual(textValue('人数'));
    expect(blank.kind).toBe('blank');
  });
});
