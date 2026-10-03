/**
 * **X-R06 增量（X-I26）独立验收**：跨产物一致性对**真实车道声明**的核对。
 *
 * 判据不照抄实现：声明由既有的 `src/facts/multi-artifact-update.ts` 事务视图
 * （"一句话改多个关联产物"）产生——版本绑 `to_revision`，值取 `new_value`；
 * 缺失（`new_value === null` / `unknown`）**如实标缺失，绝不当零**（R248）。
 *
 * 分组：
 * 1. 生产点：表格线真实声明（`verification_mode: 'real'`）从事务产出；
 * 2. 版本绑定：默认 = 事务 `to_revision`；与权威错版 ⇒ `stale_version` / `ahead_version`；
 * 3. 缺失不当零：未登记 / 未知值不产出声明、不补 0，对齐权威后落 `missing_claim`（`claimed_display === null`）；
 * 4. 值种类：文本可映射；日期**不硬凑**（如实归入不支持）；
 * 5. 文档 / 幻灯片契约层：只有表格线真实，docx/pptx 保持 `contract-only`；
 * 6. 封闭判定词表：恰为 10 元、冻结；
 * 7. 确定性：同事务重放 ⇒ 声明与摘要逐字节一致；
 * 8. 定点无浮点：`number` 事实经最短往返十进制定点化，异常显式失败。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  ValidationError,
  type ArtifactRecord,
  type FactRef,
  type Revision,
  type SharedFactRecord,
  type TemplateKind,
} from '../../../../src/protocol/index.js';
import { formatQuantity, parseQuantity, type Quantity } from '../../../../src/spreadsheets/quantity.js';
import {
  buildMultiArtifactTransaction,
  type MultiArtifactInstruction,
  type MultiArtifactTransactionView,
} from '../../../../src/facts/multi-artifact-update.js';
import { type SharedFactUpdate } from '../../../../src/facts/dependency-invalidation.js';
import {
  CONSISTENCY_VERDICT_CODES,
  describeLaneContractStateViaReport,
  type ArtifactFactClaim,
  type ExpectedFact,
} from './cross-artifact-consistency.js';
import {
  DEFAULT_SPREADSHEET_ARTIFACT_ID,
  REAL_LANE_VERIFICATION_MODE,
  consistencyReportFromTransaction,
  quantityFromNumberFact,
  realLaneClaimsFromTransaction,
  sharedFactValueToClaimedValue,
  templateKindToConsistencyTarget,
} from './real-lane-claims.js';

// ---------------------------------------------------------------------------
// 夹具（沿用 multi-artifact-update 的既有形状，不重造）
// ---------------------------------------------------------------------------

const T1 = asTaskId('T1');
const R1 = asRevision(1);
const R2 = asRevision(2);
const AT = asLogicalTime(100);
const INSTANCE = asInstanceId('inst-A');

const F_BUDGET_OLD = asFactRef('fact-budget-19.98');
const F_BUDGET_NEW = asFactRef('fact-budget-19.99');
const F_NOTE_OLD = asFactRef('fact-note-1');
const F_NOTE_NEW = asFactRef('fact-note-2');
const F_DATE_OLD = asFactRef('fact-date-1');
const F_DATE_NEW = asFactRef('fact-date-2');

function cny(amount: string, scale = 2): Quantity {
  return parseQuantity(amount, scale, 'cny', 'CNY');
}

function amount(value: string): ExpectedFact['value'] {
  return { kind: 'amount', quantity: cny(value) };
}

function published(input: {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly facts: readonly FactRef[];
  readonly version?: number;
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: asArtifactRef(input.id),
    task_id: T1,
    task_revision: R1,
    artifact_version: input.version ?? 1,
    template_kind: input.kind,
    byte_length: 128,
    content_digest: `digest-${input.id}`,
    source_fact_refs: input.facts,
    created_by_instance_id: INSTANCE,
    status: 'published',
    verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '结构自检通过' }],
    receipt: { final_path: `/out/${input.id}`, readback_digest: `rb-${input.id}`, verifier: 'reader', at: AT },
    created_at: AT,
  });
}

function numberRecord(
  factId: FactRef,
  revision: Revision,
  amountValue: number,
  supersedes: FactRef | null = null,
): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: factId,
    task_id: T1,
    task_revision: revision,
    fact_key: 'budget.total',
    value: { kind: 'known', value: { type: 'number', amount: amountValue, unit: 'cny', currency: 'CNY' } },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmed_by: INSTANCE,
    confirmed_at: AT,
    supersedes_fact_id: supersedes,
  });
}

function textRecord(factId: FactRef, revision: Revision, text: string, supersedes: FactRef | null = null): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: factId,
    task_id: T1,
    task_revision: revision,
    fact_key: 'project.name',
    value: { kind: 'known', value: { type: 'text', text, source: 'user_confirmation' } },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmed_by: INSTANCE,
    confirmed_at: AT,
    supersedes_fact_id: supersedes,
  });
}

function dateRecord(factId: FactRef, revision: Revision, isoDate: string, supersedes: FactRef | null = null): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: factId,
    task_id: T1,
    task_revision: revision,
    fact_key: 'event.date',
    value: { kind: 'known', value: { type: 'date', iso_date: isoDate, time_zone: 'Asia/Shanghai' } },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmed_by: INSTANCE,
    confirmed_at: AT,
    supersedes_fact_id: supersedes,
  });
}

function instruction(overrides: Partial<MultiArtifactInstruction> = {}): MultiArtifactInstruction {
  return {
    instruction_id: 'instr-1',
    utterance: '把预算改成 19.99 元',
    task_id: T1,
    from_revision: R1,
    to_revision: R2,
    at: AT,
    ...overrides,
  };
}

interface BuildInput {
  readonly updates: readonly SharedFactUpdate[];
  readonly facts: readonly SharedFactRecord[];
  readonly artifacts?: readonly ArtifactRecord[];
  readonly to?: Revision;
}

function build(input: BuildInput): MultiArtifactTransactionView {
  return buildMultiArtifactTransaction({
    instruction: instruction(input.to === undefined ? {} : { to_revision: input.to }),
    updates: input.updates,
    artifacts: input.artifacts ?? [published({ id: 'sheetPrimary', kind: 'spreadsheet', facts: [] })],
    facts: input.facts,
  });
}

const BUDGET_UPDATE: SharedFactUpdate = {
  fact_key: 'budget.total',
  previous_fact_id: F_BUDGET_OLD,
  new_fact_id: F_BUDGET_NEW,
};

const NOTE_UPDATE: SharedFactUpdate = {
  fact_key: 'project.name',
  previous_fact_id: F_NOTE_OLD,
  new_fact_id: F_NOTE_NEW,
};

/** 一个直接引用预算事实的表格产物 + 一个不受用的文档产物。 */
function budgetArtifacts(): readonly ArtifactRecord[] {
  return [
    published({ id: 'sheetPrimary', kind: 'spreadsheet', facts: [F_BUDGET_OLD, F_NOTE_OLD, F_DATE_OLD] }),
    published({ id: 'docPrimary', kind: 'document', facts: [F_NOTE_OLD] }),
  ];
}

function budgetTransaction(overrides: Partial<BuildInput> = {}): MultiArtifactTransactionView {
  return build({
    updates: [BUDGET_UPDATE],
    facts: [numberRecord(F_BUDGET_OLD, R1, 19.98), numberRecord(F_BUDGET_NEW, R2, 19.99, F_BUDGET_OLD)],
    artifacts: budgetArtifacts(),
    ...overrides,
  });
}

function sheetEntry(view: MultiArtifactTransactionView): MultiArtifactTransactionView['artifact_entries'][number] {
  const entry = view.artifact_entries.find((candidate) => candidate.template_kind === 'spreadsheet');
  if (entry === undefined) throw new Error('夹具应有表格产物条目');
  return entry;
}

/** 权威快照：预算 19.99 元，版本 2。 */
function budgetAuthority(): readonly ExpectedFact[] {
  return [{ fact_key: 'budget.total', version: 2, value: amount('19.99') }];
}

/** bigint 安全的稳定文本（`Quantity` 含 `bigint`，原生 `JSON.stringify` 会抛）。 */
function stableText(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => (typeof raw === 'bigint' ? `${raw.toString()}n` : raw));
}

function fixtureClaim(target: 'docx' | 'pptx', value: ExpectedFact['value'], version = 2): ArtifactFactClaim {
  return {
    target,
    artifact_id: `${target}:primary`,
    fact_key: 'budget.total',
    fact_version: version,
    value,
    verification_mode: 'fixture',
  };
}

// ---------------------------------------------------------------------------
// 1. 生产点：表格线真实声明
// ---------------------------------------------------------------------------

describe('X-R06+ §1 生产点：事务 → 表格线真实声明', () => {
  it('声明是 real 且版本绑 to_revision、值取事务新值、产物 id 取事务表格产物新 id', () => {
    const view = budgetTransaction();
    const produced = realLaneClaimsFromTransaction(view);

    expect(produced.claims).toHaveLength(1);
    const claim = produced.claims[0];
    expect(claim?.target).toBe('spreadsheet');
    expect(claim?.verification_mode).toBe('real');
    expect(claim?.fact_key).toBe('budget.total');
    expect(claim?.fact_version).toBe(2);
    expect(claim?.fact_version).toBe(Number(view.to_revision));
    expect(claim?.value.kind).toBe('amount');
    expect(claim?.artifact_id).toBe(String(sheetEntry(view).new_artifact_id));

    expect(produced.expected).toEqual([
      { fact_key: 'budget.total', version: 2, value: { kind: 'amount', quantity: cny('19.99') } },
    ]);
    expect(produced.unregistered_fact_keys).toEqual([]);
    expect(produced.unsupported_fact_keys).toEqual([]);
  });

  it('只有直接引用被改事实的表格产物才重渲染它（不受用的文档产物不进声明）', () => {
    const view = budgetTransaction();
    // 文档产物引用的是 note，不是 budget：它不在受影响集合里。
    expect(view.artifact_entries.map((entry) => String(entry.artifact_id))).toEqual(['sheetPrimary']);
    expect(view.untouched_artifact_ids.map(String)).toEqual(['docPrimary']);
    expect(realLaneClaimsFromTransaction(view).claims).toHaveLength(1);
  });

  it('一致性报告：表格线真实声明对齐权威 ⇒ ok；docx/pptx 夹具声明也 ok', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, {
      other_claims: [fixtureClaim('docx', amount('19.99')), fixtureClaim('pptx', amount('19.99'))],
    });
    expect(report.consistent).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.findings.every((finding) => finding.verdict === 'ok')).toBe(true);
    expect(report.snapshot_id).toBe('T1@r2');
  });

  it('显式覆盖产物 id（生产端无法列举条目时）⇒ 按该 id 出声明', () => {
    const view = budgetTransaction();
    const produced = realLaneClaimsFromTransaction(view, { artifact_id: 'sheet:Z9' });
    expect(produced.artifact_id).toBe('sheet:Z9');
    expect(produced.claims[0]?.artifact_id).toBe('sheet:Z9');
  });

  it('无表格产物条目且未覆盖 ⇒ 不虚构声明（保持真空）', () => {
    const view = budgetTransaction({ artifacts: [published({ id: 'docOnly', kind: 'document', facts: [F_BUDGET_OLD] })] });
    const produced = realLaneClaimsFromTransaction(view);
    expect(produced.claims).toEqual([]);
    expect(produced.artifact_id).toBe(DEFAULT_SPREADSHEET_ARTIFACT_ID);
  });

  it('模板种类 → 目标车道映射是封闭且正确的', () => {
    expect(templateKindToConsistencyTarget('document')).toBe('docx');
    expect(templateKindToConsistencyTarget('spreadsheet')).toBe('spreadsheet');
    expect(templateKindToConsistencyTarget('presentation')).toBe('pptx');
    expect(REAL_LANE_VERIFICATION_MODE).toBe('real');
  });
});

// ---------------------------------------------------------------------------
// 2. 版本绑定
// ---------------------------------------------------------------------------

describe('X-R06+ §2 版本绑定（默认 to_revision）', () => {
  it('声明版本低于权威 ⇒ stale_version', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, { expected: budgetAuthority(), fact_version: 1 });
    const sheet = report.findings.find((finding) => finding.target === 'spreadsheet');
    expect(sheet?.verdict).toBe('stale_version');
    expect(sheet?.expected_version).toBe(2);
    expect(sheet?.claimed_version).toBe(1);
  });

  it('声明版本高于权威 ⇒ ahead_version', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, { expected: budgetAuthority(), fact_version: 3 });
    expect(report.findings.find((finding) => finding.target === 'spreadsheet')?.verdict).toBe('ahead_version');
  });

  it('声明版本由事务 from_revision 派生时（覆盖）⇒ 与权威旧版对齐（反面对照）', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, {
      expected: budgetAuthority(),
      fact_version: Number(view.from_revision),
    });
    expect(report.findings.find((finding) => finding.target === 'spreadsheet')?.verdict).toBe('stale_version');
  });
});

// ---------------------------------------------------------------------------
// 3. 缺失不当零
// ---------------------------------------------------------------------------

describe('X-R06+ §3 缺失不当零（与 multi-artifact-update 同口径）', () => {
  it('未提供事实记录 ⇒ new_value 为 null ⇒ 不产出声明、不补 0，如实归入未登记', () => {
    const view = budgetTransaction({ facts: [] });
    expect(view.fact_changes[0]?.new_value).toBeNull();
    const produced = realLaneClaimsFromTransaction(view, { expected: budgetAuthority() });
    expect(produced.claims).toEqual([]);
    expect(produced.unregistered_fact_keys).toEqual(['budget.total']);
    expect(produced.expected).toEqual(budgetAuthority());
  });

  it('对齐权威后落 missing_claim，claimed_display 为 null（不是 "0"）', () => {
    const view = budgetTransaction({ facts: [] });
    const { report } = consistencyReportFromTransaction(view, { expected: budgetAuthority() });
    const sheet = report.findings.find((finding) => finding.target === 'spreadsheet');
    expect(sheet?.verdict).toBe('missing_claim');
    expect(sheet?.claimed_version).toBeNull();
    expect(sheet?.claimed_display).toBeNull();
    expect(sheet?.claimed_display).not.toBe('0');
    // 本用例只有一条权威事实且三车道都没有声明：三条 missing_claim 都如实上报。
    expect(report.violation_counts.missing_claim).toBe(3);
  });

  it('事实值为 unknown ⇒ 同样视为未登记（不得当成 0 / 空）', () => {
    const unknownNew = createSharedFactRecord({
      fact_id: F_BUDGET_NEW,
      task_id: T1,
      task_revision: R2,
      fact_key: 'budget.total',
      value: { kind: 'unknown', reason: '用户尚未确认新预算' },
      source: { kind: 'user_confirmation', detail: '待确认' },
      confirmed_by: INSTANCE,
      confirmed_at: AT,
      supersedes_fact_id: F_BUDGET_OLD,
    });
    const view = budgetTransaction({ facts: [numberRecord(F_BUDGET_OLD, R1, 19.98), unknownNew] });
    const produced = realLaneClaimsFromTransaction(view, { expected: budgetAuthority() });
    expect(produced.claims).toEqual([]);
    expect(produced.unregistered_fact_keys).toEqual(['budget.total']);
    expect(sharedFactValueToClaimedValue({ kind: 'unknown', reason: 'x' }).ok).toBe(false);
  });

  it('缺失键绝不出现在任何金额（amount_minor 0n）里', () => {
    const view = budgetTransaction({ facts: [] });
    const produced = realLaneClaimsFromTransaction(view, { expected: budgetAuthority() });
    for (const claim of produced.claims) {
      if (claim.value.kind === 'amount') expect(claim.value.quantity.amount_minor).not.toBe(0n);
    }
    expect(produced.claims).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 值种类
// ---------------------------------------------------------------------------

describe('X-R06+ §4 值种类', () => {
  it('文本事实可映射（文本原样，不转字符串比较金额）', () => {
    const view = build({
      updates: [NOTE_UPDATE],
      facts: [textRecord(F_NOTE_OLD, R1, '海棠计划'), textRecord(F_NOTE_NEW, R2, '海棠计划二期', F_NOTE_OLD)],
      artifacts: [published({ id: 'sheetPrimary', kind: 'spreadsheet', facts: [F_NOTE_OLD] })],
    });
    const produced = realLaneClaimsFromTransaction(view);
    expect(produced.claims).toHaveLength(1);
    expect(produced.claims[0]?.value).toEqual({ kind: 'text', text: '海棠计划二期' });
    expect(produced.expected[0]?.value).toEqual({ kind: 'text', text: '海棠计划二期' });
  });

  it('日期事实不硬凑：归入不支持，不产出声明、不转文本', () => {
    const view = build({
      updates: [{ fact_key: 'event.date', previous_fact_id: F_DATE_OLD, new_fact_id: F_DATE_NEW }],
      facts: [
        dateRecord(F_DATE_OLD, R1, '2026-10-03'),
        dateRecord(F_DATE_NEW, R2, '2026-10-10', F_DATE_OLD),
      ],
      artifacts: [published({ id: 'sheetPrimary', kind: 'spreadsheet', facts: [F_DATE_OLD] })],
    });
    const produced = realLaneClaimsFromTransaction(view);
    expect(produced.claims).toEqual([]);
    expect(produced.unsupported_fact_keys).toEqual(['event.date']);
    expect(produced.unregistered_fact_keys).toEqual([]);
  });

  it('sharedFactValueToClaimedValue 对 null 明确返回 unregistered（≠ 0）', () => {
    const resolution = sharedFactValueToClaimedValue(null);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.code).toBe('unregistered');
      expect(resolution.detail).toContain('≠ 0');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 文档 / 幻灯片只关契约层
// ---------------------------------------------------------------------------

describe('X-R06+ §5 文档 / 幻灯片保持 contract-only', () => {
  it('默认接线状态：spreadsheet wired，docx/pptx contract-only', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, {
      other_claims: [fixtureClaim('docx', amount('19.99')), fixtureClaim('pptx', amount('19.99'))],
    });
    const laneState = describeLaneContractStateViaReport(report);
    expect(laneState.get('spreadsheet')).toBe('wired');
    expect(laneState.get('docx')).toBe('contract-only');
    expect(laneState.get('pptx')).toBe('contract-only');
  });

  it('只有表格线声明是 real；docx/pptx 声明仍是 fixture', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, {
      other_claims: [fixtureClaim('docx', amount('19.99')), fixtureClaim('pptx', amount('19.99'))],
    });
    const modes = report.findings.map((finding) => finding.target);
    expect(new Set(modes)).toEqual(new Set(['spreadsheet', 'docx', 'pptx']));
    // 真实声明只有表格线一条；文档/幻灯片是夹具契约层。
    expect(realLaneClaimsFromTransaction(view).claims.every((claim) => claim.verification_mode === 'real')).toBe(true);
  });

  it('不提供 docx/pptx 夹具声明 ⇒ 如实 missing_claim（不冒充已接线）', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view);
    expect(report.findings.find((finding) => finding.target === 'docx')?.verdict).toBe('missing_claim');
    expect(report.findings.find((finding) => finding.target === 'pptx')?.verdict).toBe('missing_claim');
    expect(report.consistent).toBe(false);
  });

  it('显式声明 docx 已接线 ⇒ 该车道 wired（本层不臆断）', () => {
    const view = budgetTransaction();
    const { report } = consistencyReportFromTransaction(view, {
      other_claims: [fixtureClaim('docx', amount('19.99')), fixtureClaim('pptx', amount('19.99'))],
      wired_targets: ['docx'],
    });
    const laneState = describeLaneContractStateViaReport(report);
    expect(laneState.get('docx')).toBe('wired');
    expect(laneState.get('pptx')).toBe('contract-only');
  });
});

// ---------------------------------------------------------------------------
// 6. 封闭判定词表
// ---------------------------------------------------------------------------

describe('X-R06+ §6 封闭判定词表', () => {
  it('恰为 10 元且封闭（本轮不扩张）', () => {
    expect(Array.isArray(CONSISTENCY_VERDICT_CODES)).toBe(true);
    expect([...CONSISTENCY_VERDICT_CODES]).toEqual([
      'ok',
      'stale_version',
      'ahead_version',
      'unit_mismatch',
      'currency_mismatch',
      'amount_mismatch',
      'value_kind_mismatch',
      'text_mismatch',
      'unknown_fact',
      'missing_claim',
    ]);
  });

  it('本层产出的判定都落在封闭词表内', () => {
    const view = budgetTransaction({ facts: [] });
    const { report } = consistencyReportFromTransaction(view, { expected: budgetAuthority() });
    for (const finding of report.findings) {
      expect(CONSISTENCY_VERDICT_CODES as readonly string[]).toContain(finding.verdict);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 确定性
// ---------------------------------------------------------------------------

describe('X-R06+ §7 确定性', () => {
  it('同一事务重放 ⇒ 声明与报告摘要逐字节一致', () => {
    const first = consistencyReportFromTransaction(budgetTransaction(), {
      other_claims: [fixtureClaim('docx', amount('19.99')), fixtureClaim('pptx', amount('19.99'))],
    });
    const second = consistencyReportFromTransaction(budgetTransaction(), {
      other_claims: [fixtureClaim('docx', amount('19.99')), fixtureClaim('pptx', amount('19.99'))],
    });
    expect(stableText(second.claims)).toBe(stableText(first.claims));
    expect(second.report.review_digest).toBe(first.report.review_digest);
  });

  it('多事实变更 ⇒ 声明按 fact_key 升序（输入顺序无关）', () => {
    const view = build({
      updates: [NOTE_UPDATE, BUDGET_UPDATE],
      facts: [
        numberRecord(F_BUDGET_OLD, R1, 19.98),
        numberRecord(F_BUDGET_NEW, R2, 19.99, F_BUDGET_OLD),
        textRecord(F_NOTE_OLD, R1, '海棠计划'),
        textRecord(F_NOTE_NEW, R2, '海棠计划二期', F_NOTE_OLD),
      ],
      artifacts: [published({ id: 'sheetPrimary', kind: 'spreadsheet', facts: [F_BUDGET_OLD, F_NOTE_OLD] })],
    });
    const produced = realLaneClaimsFromTransaction(view);
    expect(produced.claims.map((claim) => claim.fact_key)).toEqual(['budget.total', 'project.name']);
  });
});

// ---------------------------------------------------------------------------
// 8. 定点无浮点
// ---------------------------------------------------------------------------

describe('X-R06+ §8 定点化（最短往返十进制，异常显式）', () => {
  it('number 事实定点化并逐字节往返', () => {
    const quantity = quantityFromNumberFact({ type: 'number', amount: 19.99, unit: 'cny', currency: 'CNY' });
    expect(quantity.amount_minor).toBe(1999n);
    expect(quantity.scale).toBe(2);
    expect(quantity).toEqual(cny('19.99'));
    expect(formatQuantity(quantity)).toBe('19.99');
    expect(parseQuantity(formatQuantity(quantity), quantity.scale, quantity.unit, quantity.currency)).toEqual(quantity);
  });

  it('非有限金额 ⇒ 显式抛 ValidationError（不静默变 0）', () => {
    expect(() => quantityFromNumberFact({ type: 'number', amount: Number.NaN, unit: 'cny', currency: 'CNY' })).toThrow(
      ValidationError,
    );
    expect(() =>
      quantityFromNumberFact({ type: 'number', amount: Number.POSITIVE_INFINITY, unit: 'cny', currency: 'CNY' }),
    ).toThrow(ValidationError);
  });

  it('科学计数法金额 ⇒ 显式抛（不静默近似）', () => {
    expect(() => quantityFromNumberFact({ type: 'number', amount: 1e21, unit: 'cny', currency: 'CNY' })).toThrow(
      ValidationError,
    );
  });
});
