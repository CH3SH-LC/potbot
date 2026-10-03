/**
 * XLS-18（FA-XLS-18-FACTS）定向套件：共享事实绑定 / 重算 / 跨模板发布 / 保存重开往返。
 *
 * 每条能力都配**反向对照**（不绑定事实的格不得被改、版本回退必须被拒、无通道不得声称已发布）。
 * 结果不得编造：未接通道一律 `not-wired`，消费端（安卓 WPS / Excel）打开**未验证**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import {
  EMPTY_BINDING_TABLE,
  type CrossTemplatePublishPort,
  type FactBindingTable,
  type FactConsumptionReceipt,
  type SameVersionConsumePort,
  type SharedFactPublication,
  type SharedFactSnapshot,
  type TemplatePublicationResult,
  applyFactUpdates,
  bindCell,
  bindingKey,
  bindingsForFact,
  checkBindingsSurviveRoundTrip,
  checkFactUpdateApplication,
  checkSameVersionConsumption,
  consumeSharedFactSnapshot,
  describeConsumption,
  findBinding,
  listUnwiredTargets,
  mergeFactRecalcCache,
  publishSharedFacts,
  unbindCell,
} from './facts-binding.js';
import { addChart, createChart, createChartSet, type ChartSet } from './charts.js';
import { getCellValue, createSheet, setCellValue, type SheetState } from './sheet.js';
import { createWorkbook, getSheet, type WorkbookState } from './workbook.js';
import { formulaValue, numberValue, textValue } from './value.js';
import { writeWorkbookXlsx } from './xlsx-write.js';
import { readWorkbookXlsx } from './xlsx-read.js';

const SHEET = '预算';

/** 取夹具工作表（缺表即夹具损坏，显式失败）。 */
function sheetOf(workbook: WorkbookState): SheetState {
  const sheet = getSheet(workbook, SHEET);
  if (sheet === undefined) {
    throw new Error(`夹具缺工作表 ${SHEET}`);
  }
  return sheet;
}

/** 夹具：一个绑定格（A2=headcount）、一个无关格（C2）、两个公式（B2 受影响 / D2 无关）。 */
function fixtureWorkbook() {
  let sheet = createSheet(SHEET);
  sheet = setCellValue(sheet, 'A1', textValue('人数'));
  sheet = setCellValue(sheet, 'A2', numberValue(10));
  sheet = setCellValue(sheet, 'B2', formulaValue('A2*2'));
  sheet = setCellValue(sheet, 'C2', numberValue(999));
  sheet = setCellValue(sheet, 'D2', formulaValue('C2+1'));
  sheet = setCellValue(sheet, 'A3', numberValue(5));
  sheet = setCellValue(sheet, 'B3', formulaValue('A3*10'));
  return createWorkbook([sheet]);
}

function fixtureTable(): FactBindingTable {
  let table = bindCell(EMPTY_BINDING_TABLE, {
    sheet: SHEET,
    ref: 'A2',
    fact_key: 'headcount',
    version: 1,
  });
  table = bindCell(table, { sheet: SHEET, ref: 'A3', fact_key: 'budget.total', version: 3 });
  return table;
}

function fixtureCharts(workbook: ReturnType<typeof fixtureWorkbook>): readonly ChartSet[] {
  const affected = createChart(workbook, {
    name: '人数图',
    kind: 'column',
    series: [{ values: { sheet: SHEET, range: 'A2:A2' } }],
  });
  const untouched = createChart(workbook, {
    name: '无关图',
    kind: 'column',
    series: [{ values: { sheet: SHEET, range: 'C2:C2' } }],
  });
  let set = createChartSet(workbook, SHEET);
  set = addChart(set, affected);
  set = addChart(set, untouched);
  return [set];
}

function headcountUpdate(version: number, value: number) {
  return {
    fact_key: 'headcount',
    version,
    value: numberValue(value),
    source: '用户对话确认',
    at: asLogicalTime(1000 + version),
  };
}

// ---------------------------------------------------------------------------
// ① 单元格 ↔ 事实键绑定
// ---------------------------------------------------------------------------

describe('XLS-18-①：单元格 ↔ 事实键绑定', () => {
  it('一个格绑一个事实键 + 版本；可查、可解绑、可按事实反查', () => {
    const table = fixtureTable();
    expect(findBinding(table, SHEET, 'A2')).toMatchObject({ fact_key: 'headcount', version: 1 });
    expect(bindingsForFact(table, 'budget.total').map((entry) => entry.ref)).toEqual(['A3']);

    const afterUnbind = unbindCell(table, SHEET, 'A2');
    expect(findBinding(afterUnbind, SHEET, 'A2')).toBeUndefined();
    expect(afterUnbind.bindings).toHaveLength(1);
  });

  it('同一个格重复绑定 ⇒ 后绑者胜（一个格只能有一个事实键）', () => {
    let table = bindCell(EMPTY_BINDING_TABLE, { sheet: SHEET, ref: 'A2', fact_key: 'headcount', version: 1 });
    table = bindCell(table, { sheet: SHEET, ref: 'A2', fact_key: 'budget.total', version: 2 });
    expect(table.bindings).toHaveLength(1);
    expect(findBinding(table, SHEET, 'A2')?.fact_key).toBe('budget.total');
  });

  it('绑定键形状与 recalc 的 CellKey 一致（"表名!A1"）', () => {
    expect(bindingKey(SHEET, 'a2')).toBe(`${SHEET}!A2`);
  });

  it('版本不是非负整数 ⇒ 显式失败（不静默就近取整）', () => {
    expect(() =>
      bindCell(EMPTY_BINDING_TABLE, { sheet: SHEET, ref: 'A2', fact_key: 'headcount', version: 1.5 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ② 只更新受影响格 + 重算（复用 recalc.ts）
// ---------------------------------------------------------------------------

describe('XLS-18-②：改事实 ⇒ 只更新受影响格 / 公式，无关格不重写', () => {
  const workbook = fixtureWorkbook();
  const application = applyFactUpdates({
    workbook,
    table: fixtureTable(),
    updates: [headcountUpdate(2, 20)],
    charts: fixtureCharts(workbook),
  });

  it('只有绑定了被改事实的格被改写', () => {
    expect(application.rewritten_cell_keys).toEqual([`${SHEET}!A2`]);
    expect(application.applied_fact_keys).toEqual(['headcount']);
    expect(application.rejected).toEqual([]);
  });

  it('无关格（未绑定 C2 / 未改绑定格 A3）**没有被重写**，取值原样', () => {
    expect(application.untouched_cell_keys).toContain(`${SHEET}!C2`);
    expect(application.untouched_cell_keys).toContain(`${SHEET}!A3`);
    expect(application.untouched_bound_cell_keys).toEqual([`${SHEET}!A3`]);
    expect(getCellValue(sheetOf(application.workbook), 'C2')).toEqual(numberValue(999));
  });

  it('复用 recalc.ts：受影响公式闭包 = {B2}，无关公式 D2 / B3 不在闭包内', () => {
    expect(application.recalculated_formula_keys).toEqual([`${SHEET}!B2`]);
    const b2 = application.recalc.values.get(`${SHEET}!B2`);
    expect(b2).toMatchObject({ ok: true, value: { kind: 'number', value: 40 } });
  });

  it('图表：引用被改绑定格的图受影响，引用无关格的图不受影响', () => {
    expect(application.affected_charts).toEqual([`${SHEET}!人数图`]);
    expect(application.untouched_charts).toEqual([`${SHEET}!无关图`]);
  });

  it('反向对照：实然若改了无关格 ⇒ unrelated_cell_rewritten', () => {
    const violations = checkFactUpdateApplication(application, {
      rewritten_cell_keys: [`${SHEET}!A2`, `${SHEET}!C2`],
    });
    expect(violations.map((entry) => entry.code)).toEqual(['unrelated_cell_rewritten']);
    expect(violations[0]?.subject_id).toBe(`${SHEET}!C2`);
  });

  it('反向对照：应然与实然一致 ⇒ 无违规', () => {
    expect(
      checkFactUpdateApplication(application, { rewritten_cell_keys: application.rewritten_cell_keys }),
    ).toEqual([]);
  });

  it('绑定格是公式格 ⇒ 显式失败（事实值不得覆盖公式）', () => {
    const table = bindCell(EMPTY_BINDING_TABLE, { sheet: SHEET, ref: 'B2', fact_key: 'headcount', version: 1 });
    expect(() =>
      applyFactUpdates({ workbook, table, updates: [headcountUpdate(2, 20)] }),
    ).toThrow();
  });

  it('绑定指向不存在的工作表 ⇒ 显式失败', () => {
    const table = bindCell(EMPTY_BINDING_TABLE, { sheet: '不存在', ref: 'A1', fact_key: 'headcount', version: 1 });
    expect(() => applyFactUpdates({ workbook, table, updates: [headcountUpdate(2, 20)] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ③ 版本回退必须被拒 + 旧版本迟到不得覆盖新版本
// ---------------------------------------------------------------------------

describe('XLS-18-③：版本单调，旧版本迟到不得覆盖新版本', () => {
  it('先应用 v2，再迟到 v1 ⇒ 拒绝，格保持 v2 的值', () => {
    const workbook = fixtureWorkbook();
    const table = fixtureTable();
    const first = applyFactUpdates({ workbook, table, updates: [headcountUpdate(2, 20)] });
    const second = applyFactUpdates({
      workbook: first.workbook,
      table: first.table,
      updates: [headcountUpdate(1, 5)],
    });

    expect(second.applied_fact_keys).toEqual([]);
    expect(second.rewritten_cell_keys).toEqual([]);
    expect(second.rejected[0]).toMatchObject({
      fact_key: 'headcount',
      code: 'stale_version',
      incoming_version: 1,
      bound_version: 2,
    });
    expect(getCellValue(sheetOf(second.workbook), 'A2')).toEqual(numberValue(20));
  });

  it('同版本不同值 ⇒ version_conflict（不任取一条）；同版本同值 ⇒ 幂等 no-op', () => {
    const workbook = fixtureWorkbook();
    const table = fixtureTable();
    const first = applyFactUpdates({ workbook, table, updates: [headcountUpdate(2, 20)] });

    const conflict = applyFactUpdates({
      workbook: first.workbook,
      table: first.table,
      updates: [headcountUpdate(2, 21)],
    });
    expect(conflict.rejected[0]?.code).toBe('version_conflict');

    const idempotent = applyFactUpdates({
      workbook: first.workbook,
      table: first.table,
      updates: [headcountUpdate(2, 20)],
    });
    expect(idempotent.rejected[0]?.code).toBe('unchanged_version');
    expect(idempotent.rewritten_cell_keys).toEqual([]);
  });

  it('反向对照：实然若应用了被拒的更新 ⇒ stale_update_applied', () => {
    const workbook = fixtureWorkbook();
    const first = applyFactUpdates({ workbook, table: fixtureTable(), updates: [headcountUpdate(2, 20)] });
    const stale = applyFactUpdates({
      workbook: first.workbook,
      table: first.table,
      updates: [headcountUpdate(1, 5)],
    });
    const violations = checkFactUpdateApplication(stale, {
      rewritten_cell_keys: [],
      applied_fact_keys: ['headcount'],
    });
    expect(violations.map((entry) => entry.code)).toEqual(['stale_update_applied']);
  });

  it('重算缓存合并：迟到 / 同版本被拒，保留现有；更高版本才采纳', () => {
    const current = { revision: 5, values: new Map() };
    const late = mergeFactRecalcCache(current, { revision: 3, values: new Map() });
    expect(late.accepted).toBe(false);
    expect(late.cache.revision).toBe(5);
    expect(late.reason).not.toBeNull();

    const same = mergeFactRecalcCache(current, { revision: 5, values: new Map() });
    expect(same.accepted).toBe(false);

    const fresh = mergeFactRecalcCache(current, { revision: 6, values: new Map() });
    expect(fresh.accepted).toBe(true);
    expect(fresh.cache.revision).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// ④ 跨模板发布：通道未接线 ⇒ 结构化 not-wired，绝不假称已发布
// ---------------------------------------------------------------------------

/** 类型层：`claimed_published` 必须是字面量 `false`。 */
type MustBeFalse<T extends false> = T;

const PUBLICATIONS: readonly SharedFactPublication[] = Object.freeze([
  { fact_key: 'headcount', value: numberValue(20), version: 2, source: '用户对话确认', at: asLogicalTime(2000) },
]);

function channel(
  target: 'docx' | 'pptx',
  response: Awaited<ReturnType<CrossTemplatePublishPort['publish']>>,
): CrossTemplatePublishPort {
  return {
    target,
    publish: () => Promise.resolve(response),
  };
}

describe('XLS-18-④：向文档 / PPT 发布同版事实', () => {
  it('claimed_published 恒为字面量 false（类型层）', () => {
    const literalCheck: MustBeFalse<TemplatePublicationResult['claimed_published']> = false;
    expect(literalCheck).toBe(false);
  });

  it('没有任何通道 ⇒ docx / pptx 全标 not-wired，acknowledged=false', async () => {
    const results = await publishSharedFacts({ channels: [], publications: PUBLICATIONS });
    expect(results.map((entry) => entry.wire_state)).toEqual(['not-wired', 'not-wired']);
    expect(results.every((entry) => entry.claimed_published === false)).toBe(true);
    expect(results.every((entry) => entry.acknowledged === false)).toBe(true);
    expect(listUnwiredTargets(results)).toEqual(['docx', 'pptx']);
  });

  it('只接了文档 ⇒ 只有文档 published（带受理回执），PPT 仍 not-wired', async () => {
    const results = await publishSharedFacts({
      channels: [channel('docx', { ok: true, receipt_ref: 'receipt-docx-1' })],
      publications: PUBLICATIONS,
    });
    const byTarget = new Map(results.map((entry) => [entry.target, entry]));
    expect(byTarget.get('docx')).toMatchObject({
      wire_state: 'published',
      acknowledged: true,
      receipt_ref: 'receipt-docx-1',
      fact_count: 1,
      claimed_published: false,
    });
    expect(byTarget.get('pptx')).toMatchObject({ wire_state: 'not-wired', acknowledged: false });
    expect(listUnwiredTargets(results)).toEqual(['pptx']);
  });

  it('通道拒绝 ⇒ failed（不宣称已发布）', async () => {
    const results = await publishSharedFacts({
      channels: [channel('pptx', { ok: false, reason: '下游未就绪' })],
      publications: PUBLICATIONS,
    });
    const pptx = results.find((entry) => entry.target === 'pptx');
    expect(pptx).toMatchObject({ wire_state: 'failed', acknowledged: false, claimed_published: false });
  });

  it('反向对照：无通道却宣称已发布 ⇒ claimed_published_without_wire', () => {
    const workbook = fixtureWorkbook();
    const application = applyFactUpdates({ workbook, table: fixtureTable(), updates: [headcountUpdate(2, 20)] });
    const violations = checkFactUpdateApplication(application, {
      rewritten_cell_keys: application.rewritten_cell_keys,
      publication_claims: [{ target: 'docx', claimed_published: true, wire_state: 'not-wired' }],
    });
    expect(violations.map((entry) => entry.code)).toEqual(['claimed_published_without_wire']);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 保存重开的文件层往返（真实 XLSX 字节）
// ---------------------------------------------------------------------------

describe('XLS-18-⑤：写出的 .xlsx 读回后绑定与值仍在（真实字节往返）', () => {
  it('更新事实 → 写真实字节 → 读回：绑定格的值逐类相等；绑定元数据如实标不落盘', () => {
    const workbook = fixtureWorkbook();
    const application = applyFactUpdates({
      workbook,
      table: fixtureTable(),
      updates: [headcountUpdate(2, 20)],
    });

    const written = writeWorkbookXlsx(application.workbook);
    const replayed = readWorkbookXlsx(written.bytes);

    const check = checkBindingsSurviveRoundTrip(application.table, application.workbook, replayed.workbook);
    expect(check.ok).toBe(true);
    expect(check.mismatches).toEqual([]);
    expect(check.missing_cell_keys).toEqual([]);
    expect(check.checked_cell_keys).toEqual([`${SHEET}!A2`, `${SHEET}!A3`]);
    // 诚实披露：绑定元数据（fact_key / version）**不**随容器保存。
    expect(check.binding_metadata_persisted).toBe(false);
  });

  it('读回后的绑定格取值正确（headcount=20 与未改的 budget.total=5）', () => {
    const workbook = fixtureWorkbook();
    const application = applyFactUpdates({
      workbook,
      table: fixtureTable(),
      updates: [headcountUpdate(2, 20)],
    });
    const replayed = readWorkbookXlsx(writeWorkbookXlsx(application.workbook).bytes);
    const sheet = sheetOf(replayed.workbook);
    expect(getCellValue(sheet, 'A2')).toEqual(numberValue(20));
    expect(getCellValue(sheet, 'A3')).toEqual(numberValue(5));
  });
});

// ---------------------------------------------------------------------------
// ⑥ 同版消费回执：同版 + 非空引用才算数；失败保留违规回执供机器判定
// ---------------------------------------------------------------------------

const SNAPSHOT: SharedFactSnapshot = Object.freeze({
  snapshot_id: 'snap-42',
  revision: 7,
  source_refs: Object.freeze(['doc-A']),
  values: Object.freeze([Object.freeze({ fact_key: 'headcount', value: numberValue(20), unit: '人' })]),
  at: asLogicalTime(7007),
});

function consumableReceipt(overrides: Partial<FactConsumptionReceipt> = {}): FactConsumptionReceipt {
  return {
    consumer: 'xlsx',
    snapshot_id: SNAPSHOT.snapshot_id,
    revision: SNAPSHOT.revision,
    consumed_fact_keys: ['headcount'],
    receipt_ref: 'rcpt-honest',
    consumed_at: SNAPSHOT.at,
    ...overrides,
  };
}

/** 端口原样回带一张回执（用于逐字段构造"该被拒"的回执）。 */
function receiptPort(receipt: FactConsumptionReceipt): SameVersionConsumePort {
  return { consumer: receipt.consumer, consume: () => Promise.resolve({ ok: true as const, receipt }) };
}

describe('XLS-18-⑥：同版消费回执（快照 id / 版本 / 非空引用三者缺一不可）', () => {
  it('未装配端口 ⇒ not-wired / consumed=false（不因接口点存在而宣称同步）', async () => {
    const result = await consumeSharedFactSnapshot(undefined, SNAPSHOT);
    expect(result).toMatchObject({
      wire_state: 'not-wired',
      consumed: false,
      receipt: null,
      version_matched: false,
      snapshot_id: 'snap-42',
      snapshot_revision: 7,
      fact_count: 1,
    });
    expect(checkSameVersionConsumption(SNAPSHOT, result)).toEqual([]);
  });

  it('同版且非空回执 ⇒ consumed=true / version_matched=true / 无违规', async () => {
    const result = await consumeSharedFactSnapshot(receiptPort(consumableReceipt()), SNAPSHOT);
    expect(result).toMatchObject({ wire_state: 'consumed', consumed: true, version_matched: true });
    expect(result.receipt?.receipt_ref).toBe('rcpt-honest');
    expect(result.reason).toBeNull();
    expect(checkSameVersionConsumption(SNAPSHOT, result)).toEqual([]);
  });

  it('快照 id 不符 ⇒ failed，且**保留违规回执**（offending receipt preserved）', async () => {
    const offending = consumableReceipt({ snapshot_id: 'snap-OTHER', receipt_ref: 'rcpt-wrong-snap' });
    const result = await consumeSharedFactSnapshot(receiptPort(offending), SNAPSHOT);
    expect(result.wire_state).toBe('failed');
    expect(result.consumed).toBe(false);
    expect(result.snapshot_id).toBe('snap-42'); // 目标快照 id 如实回带
    // 失败时不是丢掉回执只留一句人话 —— 违规回执原样保留供机器判定
    expect(result.receipt).not.toBeNull();
    expect(result.receipt?.snapshot_id).toBe('snap-OTHER');
    expect(result.receipt?.receipt_ref).toBe('rcpt-wrong-snap');
    expect(checkSameVersionConsumption(SNAPSHOT, result).map((entry) => entry.code)).toContain('snapshot_mismatch');
  });

  it('版本不符（跨版本冒充同版）⇒ failed / version_matched=false，保留回执并报 version_mismatch', async () => {
    const offending = consumableReceipt({ revision: SNAPSHOT.revision + 1, receipt_ref: 'rcpt-skew' });
    const result = await consumeSharedFactSnapshot(receiptPort(offending), SNAPSHOT);
    expect(result.wire_state).toBe('failed');
    expect(result.consumed).toBe(false);
    expect(result.version_matched).toBe(false);
    expect(result.receipt?.revision).toBe(SNAPSHOT.revision + 1);
    expect(checkSameVersionConsumption(SNAPSHOT, result).map((entry) => entry.code)).toContain('version_mismatch');
  });

  it('空 / 纯空白 receipt_ref ⇒ failed（没有引用号的回执不是证据），回执保留', async () => {
    for (const ref of ['', '   ']) {
      const result = await consumeSharedFactSnapshot(receiptPort(consumableReceipt({ receipt_ref: ref })), SNAPSHOT);
      expect(result.wire_state).toBe('failed');
      expect(result.consumed).toBe(false);
      expect(result.receipt?.receipt_ref).toBe(ref);
      expect(checkSameVersionConsumption(SNAPSHOT, result).map((entry) => entry.code)).toContain(
        'claimed_without_receipt',
      );
    }
  });

  it('端口失败 ⇒ failed / 无回执；不因端口挂了就宣称同步', async () => {
    const port: SameVersionConsumePort = {
      consumer: 'xlsx',
      consume: () => Promise.resolve({ ok: false as const, reason: '下游未就绪' }),
    };
    const result = await consumeSharedFactSnapshot(port, SNAPSHOT);
    expect(result).toMatchObject({ wire_state: 'failed', consumed: false, receipt: null });
    expect(result.reason).toContain('下游未就绪');
    expect(checkSameVersionConsumption(SNAPSHOT, result)).toEqual([]);
  });

  it('反向对照：同版同源但多报快照外的事实键 ⇒ unconsumed_fact_claim', async () => {
    const result = await consumeSharedFactSnapshot(
      receiptPort(consumableReceipt({ consumed_fact_keys: ['headcount', 'ghost.fact'] })),
      SNAPSHOT,
    );
    // 消费端口本身只核同版 / 来源 / 引用；"多报"由反向对照抓出，不放进 consumed 判定
    expect(result.consumed).toBe(true);
    const violations = checkSameVersionConsumption(SNAPSHOT, result);
    expect(violations.map((entry) => entry.code)).toEqual(['unconsumed_fact_claim']);
    expect(violations[0]?.subject_id).toBe('ghost.fact');
  });

  it('快照形状非法 ⇒ 显式失败（空 id / 负数版本）', async () => {
    await expect(consumeSharedFactSnapshot(undefined, { ...SNAPSHOT, snapshot_id: '' })).rejects.toThrow();
    await expect(consumeSharedFactSnapshot(undefined, { ...SNAPSHOT, revision: -1 })).rejects.toThrow();
    await expect(consumeSharedFactSnapshot(undefined, { ...SNAPSHOT, revision: 2.5 })).rejects.toThrow();
  });

  it('describeConsumption 单行摘要含通道状态、快照版本与同版判定', async () => {
    const ok = await consumeSharedFactSnapshot(receiptPort(consumableReceipt()), SNAPSHOT);
    expect(describeConsumption(ok)).toContain('consumed');
    expect(describeConsumption(ok)).toContain('snap-42@7');
    expect(describeConsumption(ok)).toContain('同版=是');
    const none = await consumeSharedFactSnapshot(undefined, SNAPSHOT);
    expect(describeConsumption(none)).toContain('not-wired');
    expect(describeConsumption(none)).toContain('同版=否');
  });
});
