/**
 * 停滞诊断与有限停止单测（D05；P5 / A05 / A05-L；合同 Q9-a/Q9-b/Q9-c）。
 *
 * 本文件按 A05 与 A05-L 两张断言表组织：
 *
 * | 断言 | 覆盖处 |
 * |---|---|
 * | A05-01 预算执行前登记 | 「预算未登记 ⇒ 抛错」 |
 * | A05-02/03/04 轮次/诊断/时间不超上限 | 「预算超限 ⇒ 报告」+ 受控缺陷 I-A05-1 |
 * | A05-05 预算内收敛、不再产生新输入 | 循环场景：`produces_new_runnable_input === false` |
 * | A05-06 等待原因可指认 | 循环场景的 `wait_reasons` |
 * | A05-07 执行槽释放 | `releasable_instance_ids` + 受控缺陷 I-A05-2 |
 * | A05-09/10 恢复最多一次、不重复动作 | 见 `recovery.test.ts` |
 * | A05-11 唤醒可追溯到新输入 | 见 `resolution.test.ts` 的通知断言 |
 * | A05-12 循环不得为已完成 | 见 `resolution.test.ts` 的 `planCycleStop` |
 * | A05-L-03/06 正常等待不得判为环/停滞 | 「A05-L 对照：无环 ⇒ 暂停，不产生诊断事件」 |
 *
 * R4：诊断次数**不自己数**——本文件用 D01 的 `summarizeKernelEvents()` 从事件流验证。
 */

import { describe, expect, it } from 'vitest';

import {
  createIdSource,
  summarizeKernelEvents,
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  type BlockerReason,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import {
  diagnoseStagnation,
  diagnosisKernelEvent,
  describeDiagnosis,
  cyclicRequestIdsOf,
  DiagnosisBudgetError,
  type DiagnosisBudget,
} from './index.js';

const TASK = asTaskId('T1');
const IA = 'I-A';
const IB = 'I-B';
const AT = asLogicalTime(0);

/** A05 §4.1 的预算示例（标"待定"，此处取规格里的示例值：R=8 / D=3 / T=20）。 */
const A05_BUDGET: DiagnosisBudget = { runs: 8, diagnoses: 3, time: 20 };

const waitDep = (on: string): BlockerReason => ({ kind: 'waiting_dependency', detail: `等待 ${on} 的结果` });

interface ItemSpec {
  readonly id: string;
  readonly owner?: string;
  readonly status?: WorkItemStatus;
  readonly revision?: number;
  readonly blocker?: BlockerReason;
  readonly deps?: readonly string[];
}

function wi(spec: ItemSpec): WorkItem {
  return createWorkItem({
    request_id: asRequestId(spec.id),
    task_id: TASK,
    task_revision: asRevision(spec.revision ?? 1),
    owner_instance_id: asInstanceId(spec.owner ?? IA),
    status: spec.status ?? 'waiting_dependency',
    blocker_reason: spec.blocker ?? waitDep(spec.deps?.[0] ?? 'X'),
    dependency_refs: (spec.deps ?? ['X']).map((dep) => ({ request_id: asRequestId(dep) })),
    created_at: AT,
    updated_at: AT,
  });
}

/** A05 主场景：I-A 等 I-B、I-B 等 I-A。 */
const a05Cycle = (revision = 1): readonly WorkItem[] => [
  wi({ id: 'req-a05-A', owner: IA, revision, deps: ['req-a05-B'] }),
  wi({ id: 'req-a05-B', owner: IB, revision, deps: ['req-a05-A'] }),
];

/** A05-L 对照：jLA 依赖 jLB 的结果；jLB 无依赖。 */
const a05lBefore = (): readonly WorkItem[] => [
  wi({ id: 'req-a05-LA', owner: IA, deps: ['req-a05-LB'] }),
  wi({ id: 'req-a05-LB', owner: IB, status: 'processing', blocker: { kind: 'other', detail: '首轮正在产出结果' }, deps: [] }),
];

/** jLB 产出结果之后的对照状态：jLB 完成、jLA 仍等待（依赖已可解除）。 */
const a05lAfter = (): readonly WorkItem[] => {
  const before = a05lBefore();
  const la = before[0];
  const lb = before[1];
  if (la === undefined || lb === undefined) {
    throw new Error('对照夹具构造失败');
  }
  return [
    la,
    createWorkItem({
      request_id: lb.request_id,
      task_id: lb.task_id,
      task_revision: lb.task_revision,
      owner_instance_id: lb.owner_instance_id,
      status: 'completed',
      result_refs: [asArtifactRef('art-req-a05-LB')],
      created_at: AT,
      updated_at: AT,
    }),
  ];
};

describe('A05 主场景：循环依赖 ⇒ 有限诊断内报告', () => {
  const diagnosis = diagnoseStagnation({ items: a05Cycle(), budget: A05_BUDGET, now: AT });

  it('判定为 cycle_detected / report（Q9-c：循环按报告处理）', () => {
    expect(diagnosis.verdict).toBe('cycle_detected');
    expect(diagnosis.disposition).toBe('report');
    expect(diagnosis.cycles).toHaveLength(1);
    expect(diagnosis.cycle_descriptions).toEqual(['req-a05-A → req-a05-B → req-a05-A']);
    expect(cyclicRequestIdsOf(diagnosis)).toEqual([asRequestId('req-a05-A'), asRequestId('req-a05-B')]);
  });

  it('A05-05：不再产生新的可运行输入，也不启动新轮次', () => {
    expect(diagnosis.produces_new_runnable_input).toBe(false);
    expect(diagnosis.should_start_run).toBe(false);
    expect(diagnosis.diagnosis_count).toBe(1);
  });

  it('A05-07：两实例的执行槽都被列为"必须空闲"', () => {
    expect(diagnosis.releasable_instance_ids).toEqual([asInstanceId(IA), asInstanceId(IB)]);
  });

  it('A05-06：等待原因可指认到具体请求标识', () => {
    expect(diagnosis.wait_reasons).toHaveLength(2);
    const byId = new Map(diagnosis.wait_reasons.map((w) => [String(w.request_id), w]));
    expect(byId.get('req-a05-A')?.blocker_detail).toContain('req-a05-B');
    expect(byId.get('req-a05-A')?.dependency_ids).toEqual(['req:req-a05-B']);
    expect(byId.get('req-a05-B')?.dependency_ids).toEqual(['req:req-a05-A']);
    expect(byId.get('req-a05-A')?.wait_class).toBe('dependency');
  });

  it('Q9-b：阻塞指纹四项与场景一致', () => {
    expect(diagnosis.fingerprint?.blocked_request_ids).toEqual([
      asRequestId('req-a05-A'),
      asRequestId('req-a05-B'),
    ]);
    expect(diagnosis.fingerprint?.blocker_kinds).toEqual(['waiting_dependency']);
    expect(diagnosis.fingerprint?.dependency_ids).toEqual(['req:req-a05-A', 'req:req-a05-B']);
    expect(diagnosis.task_revision).toBe(asRevision(1));
  });

  it('预算判定结果随诊断给出（未超限）', () => {
    expect(diagnosis.budget?.ok).toBe(true);
    expect(diagnosis.budget?.exceeded).toEqual([]);
    expect(diagnosis.reason).toContain('循环依赖');
    expect(describeDiagnosis(diagnosis)).toContain('cycle_detected/report');
  });

  it('R4：诊断次数由 D01 的 summarizeKernelEvents 统计（不另算一套）', () => {
    const ids = createIdSource({ seed: 'd05' });
    const event = diagnosisKernelEvent(diagnosis, { at: AT, event_ids: ids, task_id: TASK, group_id: null });
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('diagnosis_performed');

    const counters = summarizeKernelEvents([event!]);
    expect(counters.diagnosis_count).toBe(1);

    // 多轮诊断 ⇒ 计数随事件流真实增长（A05-03 的 D_max 口径）
    const second = diagnosisKernelEvent(diagnosis, { at: AT, event_ids: ids, task_id: TASK, group_id: null });
    expect(summarizeKernelEvents([event!, second!]).diagnosis_count).toBe(2);
  });
});

describe('A05 的对照：可正常解除的无环依赖（A05-L）', () => {
  it('A05-L-03 / A05-L-06：无环 ⇒ 暂停而非报告，且不产生停滞诊断事件', () => {
    const diagnosis = diagnoseStagnation({ items: a05lBefore(), budget: A05_BUDGET, now: AT });
    expect(diagnosis.verdict).toBe('waiting');
    expect(diagnosis.disposition).toBe('pause');
    expect(diagnosis.cycles).toEqual([]);
    expect(diagnosis.diagnosis_count).toBe(0);
    expect(diagnosis.produces_new_runnable_input).toBe(false);

    const ids = createIdSource({ seed: 'd05-l' });
    expect(diagnosisKernelEvent(diagnosis, { at: AT, event_ids: ids })).toBeNull();
    expect(summarizeKernelEvents([]).diagnosis_count).toBe(0);
  });

  it('A05-L-05：等待窗口内执行槽同样释放', () => {
    const diagnosis = diagnoseStagnation({ items: a05lBefore(), budget: A05_BUDGET, now: AT });
    expect(diagnosis.releasable_instance_ids).toEqual([asInstanceId(IA), asInstanceId(IB)]);
    expect(diagnosis.should_start_run).toBe(false);
  });

  it('jLB 的结果到达 ⇒ 依赖解除 ⇒ 可推进（不是停滞）', () => {
    const diagnosis = diagnoseStagnation({ items: a05lAfter(), budget: A05_BUDGET, now: AT });
    expect(diagnosis.verdict).toBe('progress_possible');
    expect(diagnosis.disposition).toBe('continue');
    expect(diagnosis.resolvable_request_ids).toEqual([asRequestId('req-a05-LA')]);
    expect(diagnosis.diagnosis_count).toBe(0);
    expect(diagnosis.produces_new_runnable_input).toBe(true);
  });

  it('调用方报有可运行输入的实例 ⇒ 可推进（不误判为停滞）', () => {
    const diagnosis = diagnoseStagnation({
      items: a05lBefore(),
      budget: A05_BUDGET,
      now: AT,
      runnable_instance_ids: [asInstanceId(IB)],
    });
    expect(diagnosis.verdict).toBe('progress_possible');
    expect(diagnosis.reason).toContain('可运行输入');
  });
});

describe('正常等待 ≠ 死锁（A05 的关键区分）', () => {
  it('等用户确认 ⇒ pause，且不产生诊断事件', () => {
    const diagnosis = diagnoseStagnation({
      items: [wi({ id: 'U', status: 'processing', blocker: { kind: 'waiting_user', detail: '等待用户确认' }, deps: [] })],
      budget: A05_BUDGET,
      now: AT,
    });
    expect(diagnosis.verdict).toBe('waiting');
    expect(diagnosis.disposition).toBe('pause');
    expect(diagnosis.cycles).toEqual([]);
    expect(diagnosis.normal_wait_request_ids).toEqual([asRequestId('U')]);
    expect(diagnosis.diagnosis_count).toBe(0);
  });

  it('等外部条件 ⇒ pause；与循环区分开', () => {
    const diagnosis = diagnoseStagnation({
      items: [wi({ id: 'E', status: 'processing', blocker: { kind: 'waiting_external', detail: '等待外部接口' }, deps: [] })],
      budget: A05_BUDGET,
      now: AT,
    });
    expect(diagnosis.verdict).toBe('waiting');
    expect(diagnosis.diagnosis_count).toBe(0);
  });

  it('同一集合里既有环又有正常等待 ⇒ 环优先（环是必须报告的）', () => {
    const diagnosis = diagnoseStagnation({
      items: [
        ...a05Cycle(),
        wi({ id: 'U', status: 'processing', blocker: { kind: 'waiting_user', detail: '等确认' }, deps: [] }),
      ],
      budget: A05_BUDGET,
      now: AT,
    });
    expect(diagnosis.verdict).toBe('cycle_detected');
    expect(diagnosis.normal_wait_request_ids).toEqual([asRequestId('U')]);
    expect(cyclicRequestIdsOf(diagnosis)).not.toContain(asRequestId('U'));
  });
});

describe('预算纪律（A05-01 / A05-02..04 / §九-8）', () => {
  it('未登记预算 ⇒ 抛 DiagnosisBudgetError（不静默取默认值）', () => {
    expect(() => diagnoseStagnation({ items: a05Cycle(), now: AT })).toThrow(DiagnosisBudgetError);
    expect(() => diagnoseStagnation({ items: a05Cycle(), budget: null, now: AT })).toThrow(
      DiagnosisBudgetError,
    );
  });

  it('超出预登记上限 ⇒ budget_exhausted / report（并如实列出超限维度）', () => {
    const diagnosis = diagnoseStagnation({
      items: a05Cycle(),
      budget: A05_BUDGET,
      usage: { diagnoses: 4, runs: 0, time: 0 },
      now: AT,
    });
    expect(diagnosis.verdict).toBe('budget_exhausted');
    expect(diagnosis.disposition).toBe('report');
    expect(diagnosis.budget?.exceeded).toEqual(['diagnoses']);
    expect(diagnosis.diagnosis_count).toBe(1);

    const ids = createIdSource({ seed: 'budget' });
    const event = diagnosisKernelEvent(diagnosis, { at: AT, event_ids: ids, task_id: TASK });
    expect(summarizeKernelEvents([event!]).diagnosis_count).toBe(1);
  });
});

describe('停滞与损坏输入必须被报告（不静默通过）', () => {
  it('非终态却无阻塞原因的损坏记录 ⇒ stalled / report', () => {
    const broken: WorkItem = { ...wi({ id: 'X', status: 'processing' }), blocker_reason: null };
    const diagnosis = diagnoseStagnation({ items: [broken], budget: A05_BUDGET, now: AT });
    expect(diagnosis.verdict).toBe('stalled');
    expect(diagnosis.disposition).toBe('report');
    expect(diagnosis.malformed_request_ids).toEqual([asRequestId('X')]);
    expect(diagnosis.diagnosis_count).toBe(1);
  });

  it('依赖以 failed 收场 ⇒ 等待永不可能满足 ⇒ stalled / report', () => {
    const items = [
      wi({ id: 'A', deps: ['B'] }),
      createWorkItem({
        request_id: asRequestId('B'),
        task_id: TASK,
        owner_instance_id: asInstanceId(IB),
        status: 'failed',
        failure_reason: '上游失败',
        created_at: AT,
        updated_at: AT,
      }),
    ];
    const diagnosis = diagnoseStagnation({ items, budget: A05_BUDGET, now: AT });
    expect(diagnosis.verdict).toBe('stalled');
    expect(diagnosis.unsatisfiable_request_ids).toEqual([asRequestId('A')]);
    expect(diagnosis.diagnosis_count).toBe(1);
  });

  it('无可推进也无阻塞 ⇒ waiting / pause（不是虚假的"报告"）', () => {
    const diagnosis = diagnoseStagnation({ items: [], budget: A05_BUDGET, now: AT });
    expect(diagnosis.verdict).toBe('waiting');
    expect(diagnosis.disposition).toBe('pause');
    expect(diagnosis.fingerprint).toBeNull();
    expect(diagnosis.diagnosis_count).toBe(0);
  });
});

describe('受控缺陷注入（R7）：证明关键断言真会失败', () => {
  it('I-A05-1「无限互唤」：关掉预算检查 ⇒ 超限不再被报告（且未登记预算也不再报错）', () => {
    const usage = { diagnoses: 99, runs: 99, time: 99 };
    const honest = diagnoseStagnation({ items: a05Cycle(), budget: A05_BUDGET, usage, now: AT });
    expect(honest.verdict).toBe('budget_exhausted');

    const defective = diagnoseStagnation({
      items: a05Cycle(),
      budget: A05_BUDGET,
      usage,
      now: AT,
      defects: { ignore_budget: true },
    });
    // 断言"超限必须被报告"在缺陷下失败：
    expect(defective.verdict).not.toBe('budget_exhausted');
    expect(defective.budget).toBeNull();
    // 连"预算必须登记"也一起失效：
    expect(() => diagnoseStagnation({ items: a05Cycle(), now: AT })).toThrow(DiagnosisBudgetError);
    expect(() =>
      diagnoseStagnation({ items: a05Cycle(), now: AT, defects: { ignore_budget: true } }),
    ).not.toThrow();
  });

  it('I-A05-1 变体：指纹忽略任务版本 ⇒ 不同版本得到同一指纹', () => {
    const atRev1 = diagnoseStagnation({ items: a05Cycle(1), budget: A05_BUDGET, now: AT });
    const atRev2 = diagnoseStagnation({ items: a05Cycle(2), budget: A05_BUDGET, now: AT });
    expect(atRev1.fingerprint?.key).not.toBe(atRev2.fingerprint?.key);

    const defect1 = diagnoseStagnation({
      items: a05Cycle(1),
      budget: A05_BUDGET,
      now: AT,
      defects: { ignore_task_revision_in_fingerprint: true },
    });
    const defect2 = diagnoseStagnation({
      items: a05Cycle(2),
      budget: A05_BUDGET,
      now: AT,
      defects: { ignore_task_revision_in_fingerprint: true },
    });
    expect(defect1.fingerprint?.key).toBe(defect2.fingerprint?.key);
  });

  it('I-A05-2「空转占槽」：缺陷下不再释放执行槽 ⇒ A05-07 断言失败', () => {
    const honest = diagnoseStagnation({ items: a05Cycle(), budget: A05_BUDGET, now: AT });
    expect(honest.releasable_instance_ids.length).toBe(2);

    const defective = diagnoseStagnation({
      items: a05Cycle(),
      budget: A05_BUDGET,
      now: AT,
      defects: { holds_slot_while_waiting: true },
    });
    expect(defective.disposition).toBe('report');
    expect(defective.releasable_instance_ids).toEqual([]);
  });
});
