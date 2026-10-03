/**
 * D02A-V2 —— design-02 P3「关键共享数据单一来源、缺失不得当零」**独立验收**。
 *
 * 判据来源：合同 v1.4 R48 全节（§2）+ design-02 需求 3 / 验收标准 / 不达标情形 +
 * 任务书 §7.2、§13。被测对象：`src/protocol/facts.ts`、`src/facts/{snapshot,proposal}.ts`。
 *
 * 本文件由**独立验收子智能体**从外部证伪，不复述实现者结论。每条判据都写成
 * 「能失败」的断言：如果被测对象退回成"随便取一条 / 把缺失补成 0 / 静默通过提案"，
 * 对应用例会变红。**只新增本文件**；不改 `src/**` 与既有测试。
 *
 * 纪律：不调用 `openWithOffice`；不跑别处的测试；纯内存、纯逻辑、无 IO。
 */

import { describe, expect, it } from 'vitest';

import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createSharedFactRecord,
  currentFactByKey,
  factsByKey,
  ValidationError,
  type FactSource,
  type SharedFactRecord,
  type SharedFactValue,
  type TaskId,
} from '../../../src/protocol/index.js';
import {
  buildFactSnapshot,
  describeUnusableFacts,
  isFactSnapshotUsable,
  validateFactProposal,
  type FactProposalPolicy,
  type FactProposalRejection,
  type FactProposalRejectionCode,
  type FactSnapshot,
  type FactSnapshotInput,
  type UnusableFactEntry,
} from '../../../src/facts/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const TASK: TaskId = asTaskId('task-v2-facts');
const REV = asRevision(4);
const PREV_REV = asRevision(3);
const NEXT_REV = asRevision(5);
const CONFIRMER = asInstanceId('inst-v2-confirmer');

const USER_SOURCE: FactSource = { kind: 'user_confirmation', detail: '用户在前台确认' };

function knownNumber(amount: number, unit = '人', currency: string | null = null): SharedFactValue {
  return { kind: 'known', value: { type: 'number', amount, unit, currency } };
}

interface FactSpec {
  readonly id: string;
  readonly key: string;
  readonly value: SharedFactValue;
  readonly revision?: ReturnType<typeof asRevision>;
  readonly supersedes?: string | null;
  readonly confirmedAt?: number;
  readonly task?: TaskId;
  readonly source?: FactSource;
}

function makeFact(spec: FactSpec): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(spec.id),
    task_id: spec.task ?? TASK,
    task_revision: spec.revision ?? REV,
    fact_key: spec.key,
    value: spec.value,
    source: spec.source ?? USER_SOURCE,
    confirmed_by: CONFIRMER,
    confirmed_at: asLogicalTime(spec.confirmedAt ?? 1),
    supersedes_fact_id: spec.supersedes === undefined || spec.supersedes === null
      ? null
      : asFactRef(spec.supersedes),
  });
}

function snapshotOf(
  facts: readonly SharedFactRecord[],
  factKeys: readonly string[],
  revision = REV,
): FactSnapshot {
  const input: FactSnapshotInput = { facts, task_id: TASK, task_revision: revision, fact_keys: factKeys };
  return buildFactSnapshot(input);
}

function singleUsable(snapshot: FactSnapshot): FactSnapshot['usable'][number] {
  expect(snapshot.usable).toHaveLength(1);
  const entry = snapshot.usable[0];
  if (entry === undefined) throw new Error('unreachable: usable[0] 已断言存在');
  return entry;
}

function unusableFor(snapshot: FactSnapshot, key: string): UnusableFactEntry {
  const entry = snapshot.unusable.find((candidate) => candidate.fact_key === key);
  if (entry === undefined) throw new Error(`快照的不可用表里没有键 ${key}`);
  return entry;
}

/** 扫描"可用快照里的零值条目"。用于证明缺失没有被补成 0（判据 2）。 */
function zeroValuedKeys(snapshot: FactSnapshot): readonly string[] {
  return snapshot.usable
    .filter((entry) => entry.value.type === 'number' && entry.value.amount === 0)
    .map((entry) => entry.fact_key);
}

// ---------------------------------------------------------------------------
// 判据 1：单一来源（R48.3）
// ---------------------------------------------------------------------------

describe('判据1 单一来源：同键只能指向同一条事实记录', () => {
  it('1(a) 同键出现两条"当前"事实 ⇒ 判据层显式拒绝，不静默任取一条', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-hc-a', key: 'headcount', value: knownNumber(8), confirmedAt: 1 }),
      makeFact({ id: 'fact-hc-b', key: 'headcount', value: knownNumber(10), confirmedAt: 2 }),
    ];
    const key = { task_id: TASK, task_revision: REV, fact_key: 'headcount' };

    // 唯一判据口：currentFactByKey 必须抛（而不是返回 undefined / 取第一条）。
    expect(() => currentFactByKey(facts, key)).toThrow(ValidationError);

    // 快照装配层必须把同一个错误**透传**出去，不得吞掉、不得自己挑一条。
    let threw: unknown = null;
    try {
      snapshotOf(facts, ['headcount']);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(ValidationError);
    expect((threw as Error).message).toMatch(/当前/);
  });

  it('1(b) 快照装配只走那一套判据：没有任何"第二套去重"（用取代集而非时间最近）', () => {
    // 关键区分用例：取代关系与 confirmed_at 顺序**相反**。
    //   - 旧事实 confirmed_at=200，未被取代；
    //   - 新事实 confirmed_at=100，取代旧事实。
    // 正确的"单一判据"（取代集）⇒ 当前 = 新事实（值 10）。
    // 若快照自造"按时间取最近"的第二套去重 ⇒ 会得到旧事实（值 8），本用例变红。
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-hc-old', key: 'headcount', value: knownNumber(8), confirmedAt: 200 }),
      makeFact({
        id: 'fact-hc-new',
        key: 'headcount',
        value: knownNumber(10),
        supersedes: 'fact-hc-old',
        confirmedAt: 100,
      }),
    ];

    const direct = currentFactByKey(facts, { task_id: TASK, task_revision: REV, fact_key: 'headcount' });
    expect(direct?.fact_id).toBe('fact-hc-new');
    expect(direct?.value).toEqual(knownNumber(10));

    const entry = singleUsable(snapshotOf(facts, ['headcount']));
    expect(entry.fact_ref).toBe(asFactRef('fact-hc-new'));
    expect(entry.value).toEqual({ type: 'number', amount: 10, unit: '人', currency: null });
  });

  it('1(c) 快照条目的 fact_ref = 事实记录的 id；同输入重复装配得到同一 id（可判定、稳定）', () => {
    const record = makeFact({ id: 'fact-hc-single', key: 'headcount', value: knownNumber(8), confirmedAt: 5 });
    const first = singleUsable(snapshotOf([record], ['headcount']));
    const second = singleUsable(snapshotOf([record], ['headcount']));
    expect(first.fact_ref).toBe(asFactRef('fact-hc-single'));
    expect(first.fact_ref).toBe(record.fact_id);
    expect(second.fact_ref).toBe(first.fact_ref);

    // 不同键各指向自己那一条记录（键 → 记录的映射唯一，不是"随便一条"）。
    const budget = makeFact({ id: 'fact-budget-single', key: 'budget.total', value: knownNumber(3, '元', 'CNY') });
    const twoKeys = snapshotOf([record, budget], ['headcount', 'budget.total']);
    const refs = new Map(twoKeys.usable.map((entry) => [entry.fact_key, entry.fact_ref]));
    expect(refs.get('headcount')).toBe(asFactRef('fact-hc-single'));
    expect(refs.get('budget.total')).toBe(asFactRef('fact-budget-single'));
  });

  it('1(e) 字面重复（同一 id 在数组里出现两次）也被判为"单一来源被破坏"⇒ 失败关闭，不静默去重', () => {
    // 独立观察（非期待行为，如实记录）：判据按**数组条目数**计"当前事实"，
    // 因此哪怕两条记录 id 完全相同，也会抛错而不是悄悄合并。
    // 这是**失败关闭**（fail-closed）：宁可拒绝，不静默任取 / 静默去重。
    const record = makeFact({ id: 'fact-dup', key: 'headcount', value: knownNumber(8), confirmedAt: 5 });
    let threw: unknown = null;
    try {
      snapshotOf([record, record], ['headcount']);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(ValidationError);
  });

  it('1(f) 单一来源按任务隔离：跨任务的同名键互不串扰（各取自己任务当前值）', () => {
    const otherTask = asTaskId('task-v2-other');
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-hc-here', key: 'headcount', value: knownNumber(8) }),
      makeFact({ id: 'fact-hc-there', key: 'headcount', value: knownNumber(10), task: otherTask }),
    ];
    const here = singleUsable(snapshotOf(facts, ['headcount']));
    expect(here.fact_ref).toBe(asFactRef('fact-hc-here'));
    expect(here.value).toEqual({ type: 'number', amount: 8, unit: '人', currency: null });

    const there = buildFactSnapshot({
      facts,
      task_id: otherTask,
      task_revision: REV,
      fact_keys: ['headcount'],
    });
    expect(singleUsable(there).fact_ref).toBe(asFactRef('fact-hc-there'));
  });

  it('1(d) 判据唯一性：抛出的是同一个 ValidationError（逐字同因），证明快照未另造判据', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-x-1', key: 'x', value: knownNumber(1), confirmedAt: 1 }),
      makeFact({ id: 'fact-x-2', key: 'x', value: knownNumber(2), confirmedAt: 2 }),
    ];
    const key = { task_id: TASK, task_revision: REV, fact_key: 'x' };

    let directMessage = '';
    try {
      currentFactByKey(facts, key);
    } catch (error) {
      directMessage = (error as Error).message;
    }
    let snapshotMessage = '';
    try {
      snapshotOf(facts, ['x']);
    } catch (error) {
      snapshotMessage = (error as Error).message;
    }
    expect(directMessage.length).toBeGreaterThan(0);
    expect(snapshotMessage).toBe(directMessage);
  });
});

// ---------------------------------------------------------------------------
// 判据 2：缺失不可退化成零（R48.2 / R48.4）—— 穷举四情形
// ---------------------------------------------------------------------------

describe('判据2 缺失不可退化成零：穷举四种情形', () => {
  it('四种情形逐一进不可用表、带原因，且可用表里没有任何零值条目', () => {
    const facts: readonly SharedFactRecord[] = [
      // (1) unknown：已登记，但显式未知
      makeFact({ id: 'fact-u', key: 'k.unknown', value: { kind: 'unknown', reason: '人数尚未确认' } }),
      // (2) not_applicable：已登记，但显式不适用
      makeFact({
        id: 'fact-na',
        key: 'k.not_applicable',
        value: { kind: 'not_applicable', reason: '本任务不涉及预算' },
      }),
      // (3) 未登记键：完全没有记录（不放进 facts）
      // (4) 只登记了别的版本：记录在上一版（r3），查询 r4
      makeFact({ id: 'fact-other-rev', key: 'k.other_revision', value: knownNumber(7), revision: PREV_REV }),
      // 对照：一个真实已知值，保证可用表非空（否则"没有零"是空洞结论）
      makeFact({ id: 'fact-present', key: 'k.present', value: knownNumber(5) }),
    ];
    const keys = ['k.unknown', 'k.not_applicable', 'k.unregistered', 'k.other_revision', 'k.present'];

    const snapshot = snapshotOf(facts, keys);

    // 可用表：只有对照键，且值非 0。
    expect(snapshot.usable.map((entry) => entry.fact_key)).toEqual(['k.present']);
    const present = singleUsable({ ...snapshot, usable: snapshot.usable.filter((e) => e.fact_key === 'k.present') });
    expect(present.value).toEqual({ type: 'number', amount: 5, unit: '人', currency: null });

    // 不可用表：四种情形**各有**一条，带原因。
    expect(snapshot.unusable).toHaveLength(4);

    const unknown = unusableFor(snapshot, 'k.unknown');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.fact_ref).toBe(asFactRef('fact-u'));
    expect(unknown.reason).toBe('人数尚未确认');

    const notApplicable = unusableFor(snapshot, 'k.not_applicable');
    expect(notApplicable.kind).toBe('not_applicable');
    expect(notApplicable.fact_ref).toBe(asFactRef('fact-na'));
    expect(notApplicable.reason).toBe('本任务不涉及预算');

    const unregistered = unusableFor(snapshot, 'k.unregistered');
    expect(unregistered.kind).toBe('missing');
    expect(unregistered.fact_ref).toBeNull(); // 绝不为缺失伪造 id
    expect(unregistered.reason.length).toBeGreaterThan(0);

    const otherRevision = unusableFor(snapshot, 'k.other_revision');
    expect(otherRevision.kind).toBe('missing');
    expect(otherRevision.fact_ref).toBeNull();
    expect(otherRevision.reason).toMatch(/r4/);

    // 每条不可用项都带非空原因（缺原因 = 不可追溯）。
    for (const entry of snapshot.unusable) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // 整张可用快照不存在任何值为 0 的条目（本次未登记任何 known 且为 0 的事实）。
    expect(zeroValuedKeys(snapshot)).toEqual([]);

    // 快照整体不可用 ⇒ 调用方必须阻塞，而不是拿着"看起来完整"的表产出零值产物。
    expect(isFactSnapshotUsable(snapshot)).toBe(false);
    const detail = describeUnusableFacts(snapshot);
    for (const key of ['k.unknown', 'k.not_applicable', 'k.unregistered', 'k.other_revision']) {
      expect(detail).toContain(key);
    }
  });

  it('no-early-effect：高于所查版本的事实不算当前（不属于"可用"）', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-future', key: 'k.future', value: knownNumber(12), revision: NEXT_REV }),
    ];
    const snapshot = snapshotOf(facts, ['k.future']);
    expect(snapshot.usable).toHaveLength(0);
    expect(unusableFor(snapshot, 'k.future').kind).toBe('missing');
    expect(zeroValuedKeys(snapshot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 3：对照 —— known 且值为 0 必须出现且为 0（判"缺失 vs 零"，不是"禁零"）
// ---------------------------------------------------------------------------

describe('判据3 对照：已知的零是合法的"零"，必须进可用快照且值为 0', () => {
  it('登记一条 known 且 amount === 0 ⇒ 出现在可用表、值为 0、非 missing', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-zero', key: 'headcount.extras', value: knownNumber(0), confirmedAt: 3 }),
      // 同一张快照里再放一个真正的缺失，证明零与缺失被分别对待。
      makeFact({ id: 'fact-u2', key: 'k.absent', value: { kind: 'unknown', reason: '未确认' } }),
    ];
    const snapshot = snapshotOf(facts, ['headcount.extras', 'k.absent']);

    const zero = singleUsable({ ...snapshot, usable: snapshot.usable.filter((e) => e.fact_key === 'headcount.extras') });
    expect(zero.value).toEqual({ type: 'number', amount: 0, unit: '人', currency: null });
    expect(snapshot.unusable.map((entry) => entry.fact_key)).toEqual(['k.absent']);

    // 零值条目**可见**（正是它证明了上面判据 2 的"无零"是有意义的对照）。
    expect(zeroValuedKeys(snapshot)).toEqual(['headcount.extras']);
    // 缺失项与零值项分属两张表，绝不互换。
    expect(unusableFor(snapshot, 'k.absent').kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 判据 4：取代链
// ---------------------------------------------------------------------------

describe('判据4 取代链：取新值、旧值可查、旧值不得进可用快照', () => {
  it('新事实取代旧事实 ⇒ 快照取新值；旧事实仍可查；旧值不在可用表', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-chain-old', key: 'headcount', value: knownNumber(8), confirmedAt: 10 }),
      makeFact({
        id: 'fact-chain-new',
        key: 'headcount',
        value: knownNumber(10),
        supersedes: 'fact-chain-old',
        confirmedAt: 20,
      }),
    ];

    // 快照取新值。
    const entry = singleUsable(snapshotOf(facts, ['headcount']));
    expect(entry.fact_ref).toBe(asFactRef('fact-chain-new'));
    expect(entry.value).toEqual({ type: 'number', amount: 10, unit: '人', currency: null });

    // 旧值不得进可用快照。
    expect(snapshotOf(facts, ['headcount']).usable.some((e) => e.fact_ref === asFactRef('fact-chain-old'))).toBe(false);

    // 旧事实仍可查到（历史可追，但不冒充当前）。
    const history = factsByKey(facts, { task_id: TASK, task_revision: REV, fact_key: 'headcount' });
    expect(history.map((fact) => fact.fact_id)).toEqual(['fact-chain-old', 'fact-chain-new']);
    expect(history[0]?.value).toEqual(knownNumber(8));

    // 历史存在 ≠ 当前：currentFactByKey 只给新值。
    const current = currentFactByKey(facts, { task_id: TASK, task_revision: REV, fact_key: 'headcount' });
    expect(current?.fact_id).toBe(asFactRef('fact-chain-new'));
  });

  it('取代链不受确认时刻排序影响（旧值更晚确认也不得胜出）', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-late-old', key: 'headcount', value: knownNumber(8), confirmedAt: 999 }),
      makeFact({
        id: 'fact-early-new',
        key: 'headcount',
        value: knownNumber(10),
        supersedes: 'fact-late-old',
        confirmedAt: 1,
      }),
    ];
    const entry = singleUsable(snapshotOf(facts, ['headcount']));
    expect(entry.fact_ref).toBe(asFactRef('fact-early-new'));
    expect(entry.value).toEqual({ type: 'number', amount: 10, unit: '人', currency: null });
  });
});

// ---------------------------------------------------------------------------
// 判据 5：版本
// ---------------------------------------------------------------------------

describe('判据5 版本：高于所查版本不提前生效；低于按取代规则处理', () => {
  it('task_revision 高于所查版本 ⇒ 不算当前，且不产生任何可用/零值条目', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-r5', key: 'headcount', value: knownNumber(99), revision: NEXT_REV }),
    ];
    const atR4 = snapshotOf(facts, ['headcount'], REV);
    expect(atR4.usable).toHaveLength(0);
    expect(unusableFor(atR4, 'headcount').kind).toBe('missing');
    expect(zeroValuedKeys(atR4)).toEqual([]);

    // 到它自己的版本才生效（证明"不提前"而非"永不生效"）。
    const atR5 = snapshotOf(facts, ['headcount'], NEXT_REV);
    expect(singleUsable(atR5).value).toEqual({ type: 'number', amount: 99, unit: '人', currency: null });
  });

  it('task_revision 低于所查版本 ⇒ 在所查版本里是缺失；在其本版本里按取代规则取新值', () => {
    const facts: readonly SharedFactRecord[] = [
      makeFact({ id: 'fact-r3-old', key: 'headcount', value: knownNumber(8), revision: PREV_REV, confirmedAt: 1 }),
      makeFact({
        id: 'fact-r3-new',
        key: 'headcount',
        value: knownNumber(10),
        revision: PREV_REV,
        supersedes: 'fact-r3-old',
        confirmedAt: 2,
      }),
    ];

    // 查 r4：低版本事实不算当前 ⇒ 缺失（不得"顺延"成当前）。
    const atR4 = snapshotOf(facts, ['headcount'], REV);
    expect(atR4.usable).toHaveLength(0);
    expect(unusableFor(atR4, 'headcount').kind).toBe('missing');

    // 查 r3：按取代规则取新值。
    const atR3 = snapshotOf(facts, ['headcount'], PREV_REV);
    const entry = singleUsable(atR3);
    expect(entry.fact_ref).toBe(asFactRef('fact-r3-new'));
    expect(entry.value).toEqual({ type: 'number', amount: 10, unit: '人', currency: null });
  });
});

// ---------------------------------------------------------------------------
// 判据 6：提案校验真的会拒（每条规则一个自造反例）
// ---------------------------------------------------------------------------

const PERMISSIVE: FactProposalPolicy = { isAuthorizedSource: () => true };

function baseProposal(value: unknown, source: unknown = USER_SOURCE): Record<string, unknown> {
  return { fact_key: 'headcount', value, source };
}

/** 断言"结构化拒绝、不抛错、不静默通过"，并返回拒因。 */
function expectRejected(
  raw: unknown,
  expectedCode: FactProposalRejectionCode,
  policy: FactProposalPolicy = PERMISSIVE,
): readonly FactProposalRejection[] {
  let threw: unknown = null;
  let result: ReturnType<typeof validateFactProposal> | undefined;
  try {
    result = validateFactProposal(raw, policy);
  } catch (error) {
    threw = error;
  }
  expect(threw).toBeNull(); // 必须结构化拒绝，不是抛错
  expect(result).toBeDefined();
  const settled = result;
  if (settled === undefined) throw new Error('unreachable');
  expect(settled.ok).toBe(false); // 不静默通过
  if (settled.ok) throw new Error('unreachable: 已断言 ok === false');
  const codes = settled.rejections.map((rejection) => rejection.code);
  expect(codes).toContain(expectedCode);
  for (const rejection of settled.rejections) {
    expect(rejection.detail.length).toBeGreaterThan(0);
    expect(rejection.field.length).toBeGreaterThan(0);
  }
  return settled.rejections;
}

describe('判据6 提案校验：自造反例，逐条结构化拒绝', () => {
  it('数值缺单位 ⇒ missing_unit', () => {
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'number', amount: 8, currency: null } }),
      'missing_unit',
    );
  });

  it('金额缺币种（undefined）⇒ missing_currency', () => {
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'number', amount: 8, unit: '元' } }),
      'missing_currency',
    );
  });

  it('币种写成空串 ⇒ missing_currency（"没写"不等于"不是金额"）', () => {
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'number', amount: 8, unit: '元', currency: '' } }),
      'missing_currency',
    );
  });

  it('日期缺时区 ⇒ missing_time_zone', () => {
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'date', iso_date: '2026-10-02' } }),
      'missing_time_zone',
    );
  });

  it('日期不可还原（缺 iso_date）⇒ missing_date', () => {
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'date', time_zone: 'Asia/Shanghai' } }),
      'missing_date',
    );
  });

  it('文本缺来源 ⇒ missing_source_reference', () => {
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'text', text: '十人活动' } }),
      'missing_source_reference',
    );
  });

  it('用 0 冒充未知（unknown 携带数值载荷）⇒ unknown_carries_payload', () => {
    expectRejected(
      baseProposal({ kind: 'unknown', value: { type: 'number', amount: 0, unit: '人', currency: null }, reason: '人数未知' }),
      'unknown_carries_payload',
    );
  });

  it('用裸 0 冒充未知 ⇒ missing_value（裸值不是合法编码）', () => {
    expectRejected(baseProposal(0), 'missing_value');
  });

  it('用空串冒充未知 ⇒ missing_value', () => {
    expectRejected(baseProposal(''), 'missing_value');
  });

  it('用 undefined 冒充未知 ⇒ missing_value', () => {
    expectRejected(baseProposal(undefined), 'missing_value');
  });

  it('unknown 缺原因（空 reason）⇒ missing_unknown_reason', () => {
    expectRejected(baseProposal({ kind: 'unknown', reason: '' }), 'missing_unknown_reason');
  });

  it('not_applicable 缺原因 ⇒ missing_unknown_reason', () => {
    expectRejected(baseProposal({ kind: 'not_applicable' }), 'missing_unknown_reason');
  });

  it('来源不在授权范围 ⇒ source_not_authorized（授权口可注入，拒因结构化）', () => {
    const denyAll: FactProposalPolicy = { isAuthorizedSource: () => false };
    expectRejected(
      baseProposal({ kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } }),
      'source_not_authorized',
      denyAll,
    );
  });

  it('正对照：合法提案（含显式 currency:null 与 known 0）必须通过，证明用例非空洞', () => {
    const ok = validateFactProposal(
      baseProposal({ kind: 'known', value: { type: 'number', amount: 0, unit: '人', currency: null } }),
      PERMISSIVE,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.proposal.value).toEqual({ kind: 'known', value: { type: 'number', amount: 0, unit: '人', currency: null } });

    const unknownOk = validateFactProposal(baseProposal({ kind: 'unknown', reason: '未确认' }), PERMISSIVE);
    expect(unknownOk.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 判据 7：反作弊 —— 校验不过的提案不留下任何已登记事实（无部分写入）
// ---------------------------------------------------------------------------

const REJECTED_CASES: readonly { readonly label: string; readonly raw: unknown; readonly code: FactProposalRejectionCode }[] = [
  { label: '数值缺单位', raw: baseProposal({ kind: 'known', value: { type: 'number', amount: 8, currency: null } }), code: 'missing_unit' },
  { label: '金额缺币种', raw: baseProposal({ kind: 'known', value: { type: 'number', amount: 8, unit: '元' } }), code: 'missing_currency' },
  { label: '日期缺时区', raw: baseProposal({ kind: 'known', value: { type: 'date', iso_date: '2026-10-02' } }), code: 'missing_time_zone' },
  { label: '文本缺来源', raw: baseProposal({ kind: 'known', value: { type: 'text', text: '十人' } }), code: 'missing_source_reference' },
  { label: '0 冒充未知', raw: baseProposal({ kind: 'unknown', value: { type: 'number', amount: 0, unit: '人', currency: null }, reason: '未知' }), code: 'unknown_carries_payload' },
  { label: '裸 0', raw: baseProposal(0), code: 'missing_value' },
  { label: '空 reason', raw: baseProposal({ kind: 'unknown', reason: '' }), code: 'missing_unknown_reason' },
];

describe('判据7 反作弊：被拒提案零登记、零写入、零副作用', () => {
  it('先校验再登记的完整路径下，任一被拒提案都不会留下已登记事实', () => {
    const registry: SharedFactRecord[] = [];

    const tryRegister = (raw: unknown): boolean => {
      const result = validateFactProposal(raw, PERMISSIVE);
      if (!result.ok) return false;
      // 只有校验通过才会走到这里；身份字段由落库方补齐。
      registry.push(
        createSharedFactRecord({
          fact_id: asFactRef(`fact-reg-${String(registry.length)}`),
          task_id: TASK,
          task_revision: REV,
          fact_key: result.proposal.fact_key,
          value: result.proposal.value,
          source: result.proposal.source,
          confirmed_by: CONFIRMER,
          confirmed_at: asLogicalTime(1),
        }),
      );
      return true;
    };

    for (const testCase of REJECTED_CASES) {
      expectRejected(testCase.raw, testCase.code);
      expect(tryRegister(testCase.raw)).toBe(false);
      expect(registry).toHaveLength(0); // 无部分写入：一条都没登记
    }

    // 反向对照：合法提案**确实**会登记（证明上面的 0 不是"路径根本没接线"）。
    const accepted = tryRegister(
      baseProposal({ kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } }),
    );
    expect(accepted).toBe(true);
    expect(registry).toHaveLength(1);
  });

  it('纵深防御：绕过提案校验直接造记录，也造不出"用 0 冒充未知"的事实', () => {
    expect(() =>
      createSharedFactRecord({
        fact_id: asFactRef('fact-bypass-1'),
        task_id: TASK,
        task_revision: REV,
        fact_key: 'headcount',
        value: { kind: 'unknown', value: { type: 'number', amount: 0, unit: '人', currency: null }, reason: '未知' } as unknown as SharedFactValue,
        source: USER_SOURCE,
        confirmed_by: CONFIRMER,
        confirmed_at: asLogicalTime(1),
      }),
    ).toThrow(ValidationError);

    expect(() =>
      createSharedFactRecord({
        fact_id: asFactRef('fact-bypass-2'),
        task_id: TASK,
        task_revision: REV,
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, currency: null } } as unknown as SharedFactValue,
        source: USER_SOURCE,
        confirmed_by: CONFIRMER,
        confirmed_at: asLogicalTime(1),
      }),
    ).toThrow(ValidationError);
  });

  it('校验是纯函数：被拒提案不会被就地改写（无副作用）', () => {
    for (const testCase of REJECTED_CASES) {
      const before = JSON.stringify(testCase.raw) ?? 'undefined';
      validateFactProposal(testCase.raw, PERMISSIVE);
      const after = JSON.stringify(testCase.raw) ?? 'undefined';
      expect(after).toBe(before);
    }
  });

  it('未写出任何已登记事实时，快照只能给出 missing（不会凭空出现零值条目）', () => {
    // 登记表为空 ⇒ 任何键都是 missing，可用表为空。
    const snapshot = snapshotOf([], ['headcount', 'budget.total', 'event.date']);
    expect(snapshot.usable).toHaveLength(0);
    expect(snapshot.unusable).toHaveLength(3);
    for (const entry of snapshot.unusable) {
      expect(entry.kind).toBe('missing');
      expect(entry.fact_ref).toBeNull();
    }
    expect(zeroValuedKeys(snapshot)).toEqual([]);
  });
});
