/**
 * G03 修复批单测：**诊断次数的事前硬上限**（合同 v1.3 R44.1–R44.7）。
 *
 * 锁定的不可变量（R44.2 / R44.6）：
 * `diagnosis_performed` 事件数 = 台账 `diagnoses` 用量 ≤ `D_max`。
 *
 * | 组 | 覆盖 |
 * |---|---|
 * | 1 | `diagnosisPermit`：事前许可的边界与"未登记即抛错"纪律（R44.1 / R44.7） |
 * | 2 | `exhaustedDiagnosis`：耗尽报告不消费额度、不做真实诊断（R44.2） |
 * | 3 | 事件种类：耗尽 / 真实报告分别写不同 `kind`，且耗尽不计入 `diagnosis_count`（R44.3） |
 * | 4 | 对照：`permit.allowed === true` 时与旧行为逐位一致（R44.4） |
 */

import { describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createIdSource,
  createWorkItem,
  summarizeKernelEvents,
  type BlockerReason,
  type KernelEvent,
  type StorageTransaction,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import {
  diagnoseStagnation,
  diagnosisKernelEvent,
  diagnosisPermit,
  DiagnosisBudgetError,
  exhaustedDiagnosis,
  recordDiagnosis,
  shouldEmitDiagnosis,
  ZERO_BUDGET_USAGE,
  type BudgetUsage,
  type DiagnosisBudget,
  type StagnationDiagnosis,
} from './index.js';

const TASK = asTaskId('T1');
const TASK2 = asTaskId('T2');
const IA = asInstanceId('I-A');
const IB = asInstanceId('I-B');
const IC = asInstanceId('I-C');
const AT = asLogicalTime(0);
const IDS = createIdSource({ seed: 'g03' });

const waitDep = (on: string): BlockerReason => ({ kind: 'waiting_dependency', detail: `等待 ${on} 的结果` });

function wi(
  id: string,
  owner = IA,
  opts: {
    readonly status?: WorkItemStatus;
    readonly deps?: readonly string[];
    readonly task?: typeof TASK;
    readonly revision?: number;
  } = {},
): WorkItem {
  const status = opts.status ?? 'waiting_dependency';
  // `waiting_dependency` 必须登记至少一个依赖项（protocol 校验）；
  // 未显式给出依赖时补一个自足依赖占位，仅用于构造合法的工作项快照。
  const deps = opts.deps ?? (status === 'waiting_dependency' ? ['dep'] : []);
  return createWorkItem({
    request_id: asRequestId(id),
    task_id: opts.task ?? TASK,
    task_revision: asRevision(opts.revision ?? 1),
    owner_instance_id: owner,
    status,
    blocker_reason: status === 'completed' ? null : waitDep(deps.join(', ') || 'nothing'),
    dependency_refs: deps.map((dep) => ({ request_id: asRequestId(dep) })),
    created_at: AT,
    updated_at: AT,
  });
}

/** 自依赖（单项成环）——最省的"真实诊断"输入。 */
const selfCycle = (): readonly WorkItem[] => [wi('r-1', IA, { deps: ['r-1'] })];

const BUDGET = (diagnoses: number): DiagnosisBudget => ({ runs: 4, diagnoses, time: 10000 });

/** 记录器替身：只实现 `recordDiagnosis` 需要的那一个方法。 */
function collectingTx(): { tx: StorageTransaction; events: KernelEvent[] } {
  const events: KernelEvent[] = [];
  const tx = {
    appendKernelEvent: (event: KernelEvent) => {
      events.push(event);
    },
  } as unknown as StorageTransaction;
  return { tx, events };
}

// ---------------------------------------------------------------------------
// 1. diagnosisPermit（R44.1 / R44.7）
// ---------------------------------------------------------------------------

describe('diagnosisPermit：诊断次数的事前许可', () => {
  it('D = 0 / used = 0 ⇒ 拒绝（0 + 1 > 0）——D = 0 一次诊断都不许记', () => {
    expect(diagnosisPermit(BUDGET(0), ZERO_BUDGET_USAGE)).toEqual({
      allowed: false,
      used: 0,
      limit: 0,
    });
  });

  it('D = 1 / used = 0 ⇒ 放行；used = 1 ⇒ 拒绝（第 2 次即拒）', () => {
    expect(diagnosisPermit(BUDGET(1), ZERO_BUDGET_USAGE)).toEqual({
      allowed: true,
      used: 0,
      limit: 1,
    });
    expect(diagnosisPermit(BUDGET(1), { diagnoses: 1 })).toEqual({
      allowed: false,
      used: 1,
      limit: 1,
    });
  });

  it('D = 4 / used = 3 ⇒ 放行（用满第 4 次后即拒）', () => {
    expect(diagnosisPermit(BUDGET(4), { diagnoses: 3 }).allowed).toBe(true);
    expect(diagnosisPermit(BUDGET(4), { diagnoses: 4 }).allowed).toBe(false);
  });

  it('一般 D = N：used < N 放行、used ≥ N 拒绝（上界恰为 N，不是 N + 1）', () => {
    for (const n of [0, 1, 2, 5]) {
      for (let used = 0; used < n; used += 1) {
        expect(diagnosisPermit(BUDGET(n), { diagnoses: used }).allowed).toBe(true);
      }
      for (let used = n; used < n + 3; used += 1) {
        expect(diagnosisPermit(BUDGET(n), { diagnoses: used }).allowed).toBe(false);
      }
    }
  });

  it('其它维度不干扰诊断许可（runs / time 用超也不改 allowed）', () => {
    const permit = diagnosisPermit({ runs: 0, diagnoses: 2, time: 0 }, { runs: 99, time: 999 });
    expect(permit).toEqual({ allowed: true, used: 0, limit: 2 });
  });

  it('未登记预算 ⇒ 抛 DiagnosisBudgetError（与 wouldExceedNext 同纪律）', () => {
    expect(() => diagnosisPermit(undefined, ZERO_BUDGET_USAGE)).toThrow(DiagnosisBudgetError);
    expect(() => diagnosisPermit(null, ZERO_BUDGET_USAGE)).toThrow(
      /必须在场景执行前由调用方给出/,
    );
  });

  it('形状非法 ⇒ 抛 DiagnosisBudgetError', () => {
    expect(() =>
      diagnosisPermit({ runs: 1, diagnoses: -1, time: 1 }, ZERO_BUDGET_USAGE),
    ).toThrow(DiagnosisBudgetError);
    expect(() => diagnosisPermit(BUDGET(2), { diagnoses: Number.NaN })).toThrow(
      DiagnosisBudgetError,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. exhaustedDiagnosis（R44.2）
// ---------------------------------------------------------------------------

describe('exhaustedDiagnosis：不消费额度的耗尽报告', () => {
  it('不做任何真实诊断：count = 0、consumes = false、无指纹 / 环 / 阻塞 / 坏记录', () => {
    const diagnosis = exhaustedDiagnosis({
      items: selfCycle(),
      budget: BUDGET(1),
      usage: { runs: 1, diagnoses: 1, time: 0 },
      now: AT,
    });
    expect(diagnosis.verdict).toBe('budget_exhausted');
    expect(diagnosis.disposition).toBe('report');
    expect(diagnosis.consumes_diagnosis_budget).toBe(false);
    expect(diagnosis.diagnosis_count).toBe(0);
    expect(diagnosis.fingerprint).toBeNull();
    expect(diagnosis.task_revision).toBeNull();
    expect(diagnosis.cycles).toEqual([]);
    expect(diagnosis.cycle_descriptions).toEqual([]);
    expect(diagnosis.blocked_request_ids).toEqual([]);
    expect(diagnosis.malformed_request_ids).toEqual([]);
    expect(diagnosis.dependency_blocked_request_ids).toEqual([]);
    expect(diagnosis.normal_wait_request_ids).toEqual([]);
    expect(diagnosis.unsatisfiable_request_ids).toEqual([]);
    expect(diagnosis.resolvable_request_ids).toEqual([]);
    expect(diagnosis.wait_reasons).toEqual([]);
    expect(diagnosis.should_start_run).toBe(false);
    expect(diagnosis.produces_new_runnable_input).toBe(false);
  });

  it('如实给出各维度用量（budget 是报告，不参与许可判定）', () => {
    const diagnosis = exhaustedDiagnosis({
      items: selfCycle(),
      budget: BUDGET(1),
      usage: { runs: 2, diagnoses: 1, time: 5 },
      now: AT,
    });
    expect(diagnosis.budget?.usage).toEqual({ runs: 2, diagnoses: 1, time: 5 });
    expect(diagnosis.budget?.limits).toEqual({ runs: 4, diagnoses: 1, time: 10000 });
    // used === limit ⇒ 报告口径"未超限"（evaluateBudget 仍是报告判定，R34.2 不变）。
    expect(diagnosis.budget?.exceeded).toEqual([]);
    expect(diagnosis.budget?.exhausted).toEqual(['diagnoses']);
  });

  it('reason 写明"预算已用尽 + 停止放行"并给出 used / limit', () => {
    const diagnosis = exhaustedDiagnosis({
      items: selfCycle(),
      budget: BUDGET(2),
      usage: { runs: 0, diagnoses: 2, time: 0 },
      now: AT,
    });
    expect(diagnosis.reason).toContain('诊断预算已用尽');
    expect(diagnosis.reason).toContain('按预登记上限停止放行');
    expect(diagnosis.reason).toContain('2 >= 2');
  });

  it('releasable_instance_ids = 作用域内非终态项的负责人（A05-07：报告期间不得占槽）', () => {
    const items: readonly WorkItem[] = [
      wi('a', IA), // 参与
      wi('b', IB, { status: 'pending' }), // 参与
      wi('c', IC, { status: 'completed' }), // 终态 ⇒ 不参与
      wi('d', IC, { task: TASK2 }), // 作用域外 ⇒ 不参与
      wi('e', IC, { revision: 2 }), // 旧 / 新版本不符 ⇒ 不参与
    ];
    const diagnosis = exhaustedDiagnosis({
      items,
      scope: { task_id: TASK, task_revision: asRevision(1) },
      budget: BUDGET(0),
      usage: { runs: 0, diagnoses: 0, time: 0 },
      now: AT,
    });
    expect(diagnosis.releasable_instance_ids).toEqual([IA, IB]);
  });

  it('作用域收窄复用 scopeWorkItems：未给 scope 时不限定集合', () => {
    const items: readonly WorkItem[] = [
      wi('a', IA, { task: TASK2 }),
      wi('b', IB, { task: TASK }),
    ];
    const diagnosis = exhaustedDiagnosis({
      items,
      budget: BUDGET(0),
      usage: { runs: 0, diagnoses: 0, time: 0 },
      now: AT,
    });
    expect(diagnosis.releasable_instance_ids).toEqual([IA, IB]);
  });

  it('未登记预算 ⇒ 抛 DiagnosisBudgetError（不静默兜底）', () => {
    expect(() =>
      exhaustedDiagnosis({
        items: selfCycle(),
        budget: undefined as unknown as DiagnosisBudget,
        usage: { runs: 0, diagnoses: 0, time: 0 },
        now: AT,
      }),
    ).toThrow(DiagnosisBudgetError);
  });
});

// ---------------------------------------------------------------------------
// 3. 事件种类（R44.3 / R44.6）
// ---------------------------------------------------------------------------

describe('事件种类：耗尽报告不消费额度、不计入 diagnosis_count', () => {
  it('耗尽报告 ⇒ recordDiagnosis 写 diagnosis_budget_exhausted（data 带 verdict/used/limit/reason）', () => {
    const diagnosis = exhaustedDiagnosis({
      items: selfCycle(),
      budget: BUDGET(1),
      usage: { runs: 0, diagnoses: 1, time: 0 },
      now: AT,
    });
    const { tx, events } = collectingTx();
    const event = recordDiagnosis(tx, diagnosis, {
      at: AT,
      event_ids: IDS,
      task_id: TASK,
    });
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('diagnosis_budget_exhausted');
    expect(events).toEqual([event!]);
    expect(event!.data.verdict).toBe('budget_exhausted');
    expect(event!.data.used).toBe(1);
    expect(event!.data.limit).toBe(1);
    expect(String(event!.data.reason)).toContain('诊断预算已用尽');
  });

  it('真实报告 ⇒ recordDiagnosis 写 diagnosis_performed（对照）', () => {
    const diagnosis = diagnoseStagnation({ items: selfCycle(), budget: BUDGET(4), now: AT });
    expect(diagnosis.verdict).toBe('cycle_detected');
    const { tx, events } = collectingTx();
    const event = recordDiagnosis(tx, diagnosis, { at: AT, event_ids: IDS, task_id: TASK });
    expect(event!.kind).toBe('diagnosis_performed');
    expect(events).toHaveLength(1);
  });

  it('只有耗尽事件时 summarizeKernelEvents().diagnosis_count === 0', () => {
    const diagnosis = exhaustedDiagnosis({
      items: selfCycle(),
      budget: BUDGET(0),
      usage: { runs: 0, diagnoses: 0, time: 0 },
      now: AT,
    });
    const { tx, events } = collectingTx();
    recordDiagnosis(tx, diagnosis, { at: AT, event_ids: IDS, task_id: TASK });
    expect(events.map((event) => event.kind)).toEqual(['diagnosis_budget_exhausted']);
    expect(summarizeKernelEvents(events).diagnosis_count).toBe(0);
  });

  it('混合：1 条真实 + 2 条耗尽 ⇒ diagnosis_count 只数真实的那一条', () => {
    const real = diagnoseStagnation({ items: selfCycle(), budget: BUDGET(4), now: AT });
    const exhausted = exhaustedDiagnosis({
      items: selfCycle(),
      budget: BUDGET(1),
      usage: { runs: 0, diagnoses: 1, time: 0 },
      now: AT,
    });
    const { tx, events } = collectingTx();
    recordDiagnosis(tx, real, { at: AT, event_ids: IDS, task_id: TASK });
    recordDiagnosis(tx, exhausted, { at: AT, event_ids: IDS, task_id: TASK });
    recordDiagnosis(tx, exhausted, { at: AT, event_ids: IDS, task_id: TASK });
    expect(events).toHaveLength(3);
    expect(summarizeKernelEvents(events).diagnosis_count).toBe(1);
  });

  it('R44.2 不变量：逐次按 permit 放行 ⇒ diagnosis_performed 数 = diagnoses 用量 ≤ D_max', () => {
    const limits = BUDGET(2);
    let usage: BudgetUsage = Object.freeze({ runs: 0, diagnoses: 0, time: 0 });
    const { tx, events } = collectingTx();
    for (let round = 0; round < 5; round += 1) {
      const permit = diagnosisPermit(limits, usage);
      if (permit.allowed) {
        // 真实诊断：本轮记一次，用量 +1（模拟已提交投影后的台账）。
        const diagnosis = diagnoseStagnation({ items: selfCycle(), budget: limits, usage, now: AT });
        expect(diagnosis.consumes_diagnosis_budget).toBe(true);
        recordDiagnosis(tx, diagnosis, { at: AT, event_ids: IDS, task_id: TASK });
        usage = Object.freeze({ runs: 0, diagnoses: usage.diagnoses + 1, time: 0 });
      } else {
        // 耗尽报告：不消费额度，用量不变。
        const diagnosis = exhaustedDiagnosis({ items: selfCycle(), budget: limits, usage, now: AT });
        expect(diagnosis.consumes_diagnosis_budget).toBe(false);
        recordDiagnosis(tx, diagnosis, { at: AT, event_ids: IDS, task_id: TASK });
      }
    }
    const performed = events.filter((event) => event.kind === 'diagnosis_performed').length;
    expect(performed).toBe(2);
    expect(performed).toBe(usage.diagnoses);
    expect(performed).toBeLessThanOrEqual(limits.diagnoses);
    // 其余 3 次全部是耗尽报告（第 3…5 轮）。
    expect(events.filter((event) => event.kind === 'diagnosis_budget_exhausted')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. 对照：许可放行时与旧行为逐位一致（R44.4）
// ---------------------------------------------------------------------------

describe('对照：permit.allowed === true 的路径不改变既有语义', () => {
  it('环 ⇒ cycle_detected / report，consumes = true、diagnosis_count = 1（旧口径不变）', () => {
    const diagnosis = diagnoseStagnation({ items: selfCycle(), budget: BUDGET(4), now: AT });
    // 未超限时 verdict 仍是环；consumes_diagnosis_budget 恒等于 disposition === 'report'。
    expect(diagnosis.disposition).toBe('report');
    expect(diagnosis.consumes_diagnosis_budget).toBe(true);
    expect(diagnosis.diagnosis_count).toBe(1);
    expect(diagnosis.cycles).toHaveLength(1);
    expect(diagnosis.fingerprint).not.toBeNull();
  });

  it('正常等待 ⇒ pause，consumes = false 且**不写事件**（不消费额度 ≠ 耗尽报告）', () => {
    const diagnosis = diagnoseStagnation({
      items: [wi('a', IA, { status: 'pending' })],
      budget: BUDGET(4),
      now: AT,
    });
    expect(diagnosis.disposition).toBe('pause');
    expect(diagnosis.consumes_diagnosis_budget).toBe(false);
    expect(diagnosis.diagnosis_count).toBe(0);
    // 暂停不是报告 ⇒ 两类事件都不产生（A05-L-06：无环对照的诊断事件数为 0）。
    expect(shouldEmitDiagnosis(diagnosis)).toBe(false);
    expect(diagnosisKernelEvent(diagnosis, { at: AT, event_ids: IDS, task_id: TASK })).toBeNull();
    const { tx, events } = collectingTx();
    expect(recordDiagnosis(tx, diagnosis, { at: AT, event_ids: IDS, task_id: TASK })).toBeNull();
    expect(events).toEqual([]);
  });

  it('预算超限但**已获许可**（runs 维度触发）仍是一次真实诊断：consumes = true', () => {
    // runs 用超、diagnoses 未用满 ⇒ permit 会放行；此时 budget_exhausted 仍消费诊断额度（R44.4）。
    const usage = { runs: 9, diagnoses: 0, time: 0 };
    expect(diagnosisPermit(BUDGET(4), usage).allowed).toBe(true);
    const diagnosis = diagnoseStagnation({ items: selfCycle(), budget: BUDGET(4), usage, now: AT });
    expect(diagnosis.verdict).toBe('budget_exhausted');
    expect(diagnosis.consumes_diagnosis_budget).toBe(true);
    expect(diagnosis.diagnosis_count).toBe(1);
    const event = diagnosisKernelEvent(diagnosis, { at: AT, event_ids: IDS, task_id: TASK });
    expect(event!.kind).toBe('diagnosis_performed');
  });

  it('diagnoseStagnation 的返回值仍可整体读取（新增字段是唯一变化）', () => {
    const diagnosis: StagnationDiagnosis = diagnoseStagnation({
      items: selfCycle(),
      budget: BUDGET(4),
      now: AT,
    });
    const keys = Object.keys(diagnosis).sort();
    expect(keys).toEqual(
      [
        'blocked_request_ids',
        'budget',
        'consumes_diagnosis_budget',
        'cycle_descriptions',
        'cycles',
        'dependency_blocked_request_ids',
        'diagnosis_count',
        'disposition',
        'fingerprint',
        'malformed_request_ids',
        'normal_wait_request_ids',
        'produces_new_runnable_input',
        'reason',
        'releasable_instance_ids',
        'resolvable_request_ids',
        'should_start_run',
        'task_revision',
        'unsatisfiable_request_ids',
        'verdict',
        'wait_reasons',
      ].sort(),
    );
  });
});
