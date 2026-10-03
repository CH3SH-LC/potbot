/**
 * **作用域限定 + 输入身份 + 启动前闸门**单测（合同 v1.2 R37.2 / R37.3 / R37.4 / R34.1；修复批 F03 / F05 / F08）。
 *
 * 覆盖四件事：
 * 1. `scope` 语义（任务 / 版本收窄；历史项保留；未给时逐位向后兼容）；
 * 2. **F05**：两任务不同版本并存时不再误抛 `FingerprintError`，而**同一 scope 内**的
 *    跨版本阻塞仍如实抛错（scope 不是绕过指纹校验的开关）；
 * 3. **F03 / R37.3**：`planDependencyResolution` 的 `scope` 与 **`input_ref_id` 构造规则**
 *    ——规则原文在此文件里被固定，任何改动都会变红；
 * 4. **F08 / R34.1**：`wouldExceedNext` 的启动前判据 `used + 1 > limit`，
 *    与 `evaluateBudget` 的"已超限"报告判据 `used > limit` **不同**且不得互相替代。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  type BlockerReason,
  type InstanceId,
  type Revision,
  type TaskId,
  type WorkItem,
} from '../protocol/index.js';
import {
  describeScope,
  diagnoseStagnation,
  DiagnosisBudgetError,
  FingerprintError,
  isDependencyError,
  isScopeRestricted,
  itemInScope,
  normalizeScope,
  planDependencyResolution,
  resolutionInputRefId,
  scopeWorkItems,
  scopedOwnerInstanceIds,
  selectScopedRunnableInstanceIds,
  evaluateBudget,
  wouldExceedNext,
  type DependencyScope,
} from './index.js';

const T1 = asTaskId('T1');
const T2 = asTaskId('T2');
const GROUP = asGroupId('G1');
const IA = asInstanceId('I-A');
const IB = asInstanceId('I-B');
const AT = asLogicalTime(10);
const BUDGET = { runs: 8, diagnoses: 3, time: 20 };
const ZERO = { runs: 0, diagnoses: 0, time: 0 } as const;

const waitDep = (on: string): BlockerReason => ({
  kind: 'waiting_dependency',
  detail: `等待 ${on} 的结果`,
});

interface Spec {
  readonly id: string;
  readonly task?: TaskId;
  readonly revision?: number;
  readonly owner?: InstanceId;
  readonly status?: 'processing' | 'waiting_dependency' | 'completed' | 'failed';
  readonly deps?: readonly string[];
}

function wi(spec: Spec): WorkItem {
  const status = spec.status ?? 'waiting_dependency';
  const deps = spec.deps ?? [];
  return createWorkItem({
    request_id: asRequestId(spec.id),
    task_id: spec.task ?? T1,
    task_revision: asRevision(spec.revision ?? 1),
    owner_instance_id: spec.owner ?? IA,
    status,
    blocker_reason:
      status === 'completed'
        ? null
        : status === 'failed'
          ? { kind: 'other', detail: '上游失败' }
          : status === 'processing'
            ? { kind: 'other', detail: '正在处理' }
            : waitDep(deps.join(',')),
    dependency_refs: deps.map((dep) => ({ request_id: asRequestId(dep) })),
    result_refs: status === 'completed' ? [asArtifactRef(`art-${spec.id}`)] : [],
    created_at: AT,
    updated_at: AT,
  });
}

/** T1 rev1：A 等 B，B 无依赖（无环，正常等待）。 */
const t1Rev1 = (): readonly WorkItem[] => [
  wi({ id: 'req-t1-A', task: T1, revision: 1, owner: IA, deps: ['req-t1-B'] }),
  wi({ id: 'req-t1-B', task: T1, revision: 1, owner: IB, status: 'processing', deps: [] }),
];

/** T2 rev2：C 等 D，D 无依赖。 */
const t2Rev2 = (): readonly WorkItem[] => [
  wi({ id: 'req-t2-C', task: T2, revision: 2, owner: IA, deps: ['req-t2-D'] }),
  wi({ id: 'req-t2-D', task: T2, revision: 2, owner: IB, status: 'processing', deps: [] }),
];

const scopeOf = (task_id: TaskId | null, task_revision: Revision | number | null): DependencyScope => ({
  task_id,
  task_revision: task_revision === null ? null : asRevision(task_revision),
});

// ---------------------------------------------------------------------------
// 1. scope 语义
// ---------------------------------------------------------------------------

describe('scope：任务 / 版本收窄的语义', () => {
  it('未给 task_id ⇒ 视为"不限定"（task_id 是闸门维度）', () => {
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope(null)).toBeNull();
    expect(normalizeScope({})).toBeNull();
    expect(normalizeScope({ task_id: null, task_revision: null })).toBeNull();
    // 只给 revision 是**空操作**：revision 是任务内编号，单独按它过滤会把不同任务混在一起
    expect(normalizeScope({ task_revision: asRevision(2) })).toBeNull();
    expect(isScopeRestricted({})).toBe(false);
    expect(isScopeRestricted({ task_revision: asRevision(2) })).toBe(false);
    expect(isScopeRestricted({ task_id: T1 })).toBe(true);
    expect(normalizeScope({ task_id: T1 })).toEqual({ task_id: T1, task_revision: null });
  });

  it('不限定 ⇒ 原样返回入参（引用不变，既有调用方语义不变）', () => {
    const items = t1Rev1();
    expect(scopeWorkItems(items, null)).toBe(items);
    expect(scopeWorkItems(items, {})).toBe(items);
  });

  it('只给 task_id ⇒ 只保留该任务；再给 revision ⇒ 再收窄版本', () => {
    const mixed = [...t1Rev1(), ...t2Rev2(), wi({ id: 'req-t1-old', revision: 0, status: 'processing', deps: [] })];
    expect(scopeWorkItems(mixed, { task_id: T1 }).map((i) => String(i.request_id))).toEqual([
      'req-t1-A',
      'req-t1-B',
      'req-t1-old',
    ]);
    expect(
      scopeWorkItems(mixed, scopeOf(T1, 1)).map((i) => String(i.request_id)),
    ).toEqual(['req-t1-A', 'req-t1-B']);
    // 只给版本 ⇒ 空操作（未给 task_id，返回入参本身）
    expect(scopeWorkItems(mixed, { task_revision: asRevision(2) })).toBe(mixed);
    // 同一任务的不同版本可以共存，各自只看到自己那批
    const mixedSameTask = [
      ...t1Rev1(),
      wi({ id: 'req-t1-r0', task: T1, revision: 0, status: 'processing', deps: [] }),
    ];
    expect(scopeWorkItems(mixedSameTask, scopeOf(T1, 1)).map((i) => String(i.request_id))).toEqual([
      'req-t1-A',
      'req-t1-B',
    ]);
    expect(scopeWorkItems(mixedSameTask, scopeOf(T1, 0)).map((i) => String(i.request_id))).toEqual(['req-t1-r0']);
  });

  it('itemInScope / describeScope 与收窄一致', () => {
    const a = t1Rev1()[0]!;
    expect(itemInScope(a, scopeOf(T1, 1))).toBe(true);
    expect(itemInScope(a, scopeOf(T2, 1))).toBe(false);
    expect(itemInScope(a, scopeOf(T1, 2))).toBe(false);
    expect(itemInScope(a, null)).toBe(true);
    expect(describeScope(null)).toContain('未限定');
    expect(describeScope(scopeOf(T1, 3))).toBe('task=T1 r3');
  });

  it('scopedOwnerInstanceIds：scope 内的负责人实例（升序去重）', () => {
    const mixed = [...t1Rev1(), ...t2Rev2()];
    expect(scopedOwnerInstanceIds(mixed, scopeOf(T1, 1))).toEqual([IA, IB]);
    expect(scopedOwnerInstanceIds(mixed, scopeOf(T2, 2))).toEqual([IA, IB]);
    expect(scopedOwnerInstanceIds([wi({ id: 'req-only', owner: IB, status: 'processing', deps: [] })], scopeOf(T1, 1))).toEqual([IB]);
  });
});

// ---------------------------------------------------------------------------
// 2. 诊断的作用域隔离（F05 / R37.2）
// ---------------------------------------------------------------------------

describe('F05：诊断按 task 与 revision 隔离', () => {
  const mixed = (): readonly WorkItem[] => [...t1Rev1(), ...t2Rev2()];

  it('未给 scope：跨任务版本并存 ⇒ 如实抛 FingerprintError（旧行为，未被削弱）', () => {
    expect(() => diagnoseStagnation({ items: mixed(), budget: BUDGET, now: AT })).toThrow(FingerprintError);
  });

  it('给出 scope ⇒ T1 正常判定，T2 的项不参与（不再被无关任务拖垮）', () => {
    const diagnosis = diagnoseStagnation({
      items: mixed(),
      budget: BUDGET,
      now: AT,
      scope: scopeOf(T1, 1),
    });
    expect(diagnosis.verdict).toBe('waiting');
    expect(diagnosis.blocked_request_ids).toEqual([asRequestId('req-t1-A'), asRequestId('req-t1-B')]);
    expect(diagnosis.task_revision).toBe(asRevision(1));
    // T2 的项完全没进入这次诊断
    expect(diagnosis.wait_reasons.map((w) => String(w.request_id))).not.toContain('req-t2-C');
    // 执行槽只释放 T1 相关实例（同一责任人多实例场景下不会误放无关实例）
    expect(diagnosis.releasable_instance_ids).toEqual([IA, IB]);
  });

  it('只给 task_id（不给 revision）时，若 scope 内仍跨版本 ⇒ 仍抛 FingerprintError（真实损坏不放过）', () => {
    const broken = [
      wi({ id: 'req-t1-r1', task: T1, revision: 1, deps: ['req-t1-r1-target'] }),
      wi({ id: 'req-t1-r1-target', task: T1, revision: 1, status: 'processing', deps: [] }),
      wi({ id: 'req-t1-r2', task: T1, revision: 2, deps: ['req-t1-r2-target'] }),
      wi({ id: 'req-t1-r2-target', task: T1, revision: 2, status: 'processing', deps: [] }),
    ];
    // 加版本收窄后不再跨版本 ⇒ 不抛
    expect(() =>
      diagnoseStagnation({ items: broken, budget: BUDGET, now: AT, scope: scopeOf(T1, 1) }),
    ).not.toThrow();
    // 只收窄任务 ⇒ 同一 scope 内仍跨版本 ⇒ 如实抛
    expect(() => diagnoseStagnation({ items: broken, budget: BUDGET, now: AT, scope: { task_id: T1 } })).toThrow(
      FingerprintError,
    );
  });

  it('另一任务 / 旧版本的 completed 不会误满足当前依赖（R37.2）', () => {
    // A(T1 rev2) 等 req-t1-B；req-t1-B 是 T1 **rev1** 的已完成项
    const items = [
      wi({ id: 'req-t1-A', task: T1, revision: 2, owner: IA, deps: ['req-t1-B'] }),
      wi({ id: 'req-t1-B', task: T1, revision: 1, owner: IB, status: 'completed', deps: [] }),
    ];
    const scoped = diagnoseStagnation({ items, budget: BUDGET, now: AT, scope: scopeOf(T1, 2) });
    expect(scoped.resolvable_request_ids).toEqual([]);
    expect(scoped.verdict).toBe('waiting');
    // 不给 scope 时旧行为：集合内的 completed 会满足 ⇒ 可解除（对照，说明 scope 真的改变了判定范围）
    const unscoped = diagnoseStagnation({ items, budget: BUDGET, now: AT });
    expect(unscoped.resolvable_request_ids).toEqual([asRequestId('req-t1-A')]);
  });

  it('向后兼容：未给 scope / scope=null / 空 scope 三种写法的结果逐位相同', () => {
    const items = t1Rev1();
    const plain = diagnoseStagnation({ items, budget: BUDGET, now: AT });
    const explicitNull = diagnoseStagnation({ items, budget: BUDGET, now: AT, scope: null });
    const empty = diagnoseStagnation({ items, budget: BUDGET, now: AT, scope: {} });
    expect(JSON.stringify(explicitNull)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(empty)).toBe(JSON.stringify(plain));
  });
});

// ---------------------------------------------------------------------------
// 3. 来源范围：可运行实例（F05 / R37.2，"可运行输入使用同一范围"）
// ---------------------------------------------------------------------------

describe('selectScopedRunnableInstanceIds：按同一 scope 选可运行实例', () => {
  const items = (): readonly WorkItem[] => [
    wi({ id: 'req-t1-A', task: T1, revision: 1, owner: IA, deps: ['req-t1-B'] }),
    wi({ id: 'req-t1-B', task: T1, revision: 1, owner: IB, status: 'processing', deps: [] }),
    wi({ id: 'req-t2-C', task: T2, revision: 2, owner: asInstanceId('I-C'), deps: ['req-t2-D'] }),
    wi({ id: 'req-t2-D', task: T2, revision: 2, owner: asInstanceId('I-D'), status: 'processing', deps: [] }),
  ];
  const candidates = [asInstanceId('I-A'), asInstanceId('I-B'), asInstanceId('I-C'), asInstanceId('I-D')];

  it('scope 收窄 + 注入判定回调：只留 scope 内且真有可运行输入的实例', () => {
    const runnable = new Set(['I-A', 'I-C']);
    const selected = selectScopedRunnableInstanceIds(items(), candidates, {
      scope: scopeOf(T1, 1),
      hasRunnableInput: (id) => runnable.has(String(id)),
    });
    // I-A 在 T1 rev1 内且有输入；I-C 有输入但属于 T2 ⇒ 被 scope 排除；I-B 在范围内但无输入
    expect(selected).toEqual([IA]);
  });

  it('省略回调 ⇒ 视为候选全部有输入，只按 scope 收窄', () => {
    expect(selectScopedRunnableInstanceIds(items(), candidates, { scope: scopeOf(T1, 1) })).toEqual([IA, IB]);
  });

  it('scope 不限定 ⇒ 退化为"拥有至少一个工作项的候选"（去重、升序）', () => {
    const selected = selectScopedRunnableInstanceIds([...items(), ...items()], candidates, { scope: null });
    expect(selected).toEqual([asInstanceId('I-A'), asInstanceId('I-B'), asInstanceId('I-C'), asInstanceId('I-D')]);
  });

  it('候选里没有负责人的实例不被凭空选入', () => {
    expect(selectScopedRunnableInstanceIds(items(), [asInstanceId('I-Z')], { scope: scopeOf(T1, 1) })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 依赖解除计划的作用域 + 输入身份（F03 / R37.3 / R37.4）
// ---------------------------------------------------------------------------

describe('F03 / R37.3：解除计划的作用域与 input_ref_id', () => {
  const resolvable = (): readonly WorkItem[] => [
    wi({ id: 'req-LA', task: T1, revision: 1, owner: IA, deps: ['req-LB'] }),
    wi({ id: 'req-LB', task: T1, revision: 1, owner: IB, status: 'completed', deps: [] }),
  ];

  it('scope 内的解除照常产生通知与 → processing 转换', () => {
    const plan = planDependencyResolution(resolvable(), { at: AT, group_id: GROUP, scope: scopeOf(T1, 1) });
    expect(plan.resolvable_request_ids).toEqual([asRequestId('req-LA')]);
    expect(plan.notices).toHaveLength(1);
    expect(plan.transitions[0]?.next?.status).toBe('processing');
  });

  it('旧版本 / 其它任务的 completed 不误满足当前依赖（scope 收窄后不解除）', () => {
    const items = [
      wi({ id: 'req-LA', task: T1, revision: 2, owner: IA, deps: ['req-LB'] }),
      wi({ id: 'req-LB', task: T1, revision: 1, owner: IB, status: 'completed', deps: [] }),
    ];
    const scoped = planDependencyResolution(items, { at: AT, scope: scopeOf(T1, 2) });
    expect(scoped.notices).toEqual([]);
    expect(scoped.resolvable_request_ids).toEqual([]);
    expect(scoped.still_waiting_request_ids).toEqual([asRequestId('req-LA')]);

    // 对照：不给 scope 时旧实现会把 req-LB 当作满足
    const unscoped = planDependencyResolution(items, { at: AT });
    expect(unscoped.resolvable_request_ids).toEqual([asRequestId('req-LA')]);
  });

  it('**input_ref_id 构造规则**（规则原文，改动即变红）', () => {
    const plan = planDependencyResolution(resolvable(), { at: AT, scope: scopeOf(T1, 1) });
    const notice = plan.notices[0]!;
    // 规则：'dep-resolved:' + JSON.stringify([task_id, revision, request_id, 升序去重的解除对象])
    expect(notice.input_ref_id).toBe('dep-resolved:["T1",1,"req-LA",["req:req-LB"]]');
    // 与被直接调用的构造器一致（唯一构造处）
    expect(
      resolutionInputRefId({
        task_id: T1,
        task_revision: asRevision(1),
        request_id: asRequestId('req-LA'),
        resolved_dependency_ids: ['req:req-LB'],
      }),
    ).toBe(notice.input_ref_id);
  });

  it('input_ref_id 是确定性的：同一输入重放得到同一身份（"旧通知重试"可幂等去重）', () => {
    const first = planDependencyResolution(resolvable(), { at: AT, scope: scopeOf(T1, 1) }).notices[0]!;
    const replay = planDependencyResolution(resolvable(), { at: AT, scope: scopeOf(T1, 1) }).notices[0]!;
    expect(replay.input_ref_id).toBe(first.input_ref_id);
  });

  it('**不是**"永久禁止同请求的未来解除"：版本不同 / 解除对象不同 ⇒ 身份不同', () => {
    const atRev1 = resolutionInputRefId({
      task_id: T1,
      task_revision: asRevision(1),
      request_id: asRequestId('req-LA'),
      resolved_dependency_ids: ['req:req-LB'],
    });
    const atRev2 = resolutionInputRefId({
      task_id: T1,
      task_revision: asRevision(2),
      request_id: asRequestId('req-LA'),
      resolved_dependency_ids: ['req:req-LB'],
    });
    const otherDep = resolutionInputRefId({
      task_id: T1,
      task_revision: asRevision(1),
      request_id: asRequestId('req-LA'),
      resolved_dependency_ids: ['req:req-LC'],
    });
    const otherTask = resolutionInputRefId({
      task_id: T2,
      task_revision: asRevision(1),
      request_id: asRequestId('req-LA'),
      resolved_dependency_ids: ['req:req-LB'],
    });
    const otherRequest = resolutionInputRefId({
      task_id: T1,
      task_revision: asRevision(1),
      request_id: asRequestId('req-LB'),
      resolved_dependency_ids: ['req:req-LB'],
    });
    const all = [atRev1, atRev2, otherDep, otherTask, otherRequest];
    expect(new Set(all).size).toBe(all.length);
    // 解除对象的顺序不影响身份（升序去重后编码）
    expect(
      resolutionInputRefId({
        task_id: T1,
        task_revision: asRevision(1),
        request_id: asRequestId('req-LA'),
        resolved_dependency_ids: ['req:req-LC', 'req:req-LB', 'req:req-LB'],
      }),
    ).toBe(
      resolutionInputRefId({
        task_id: T1,
        task_revision: asRevision(1),
        request_id: asRequestId('req-LA'),
        resolved_dependency_ids: ['req:req-LB', 'req:req-LC'],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 启动前闸门（F08 / R34.1–R34.2）
// ---------------------------------------------------------------------------

describe('F08 / R34.1：wouldExceedNext 是启动前许可判定', () => {
  const limits = { runs: 1, diagnoses: 2, time: 100 };

  it('R = 0 启动 0 轮：used = 0 即拒绝（0 + 1 > 0）', () => {
    expect(wouldExceedNext({ runs: 0, diagnoses: 2, time: 100 }, ZERO, 'runs')).toBe(true);
  });

  it('R = 1 只启动 1 轮：used = 0 放行、第 2 次（used = 1）即拒', () => {
    expect(wouldExceedNext(limits, ZERO, 'runs')).toBe(false); // used=0, 0+1>1 不成立
    expect(wouldExceedNext(limits, { runs: 0 }, 'runs')).toBe(false);
    expect(wouldExceedNext(limits, { runs: 1 }, 'runs')).toBe(true);
    expect(wouldExceedNext(limits, { runs: 2 }, 'runs')).toBe(true);
  });

  it('一般 R = N 不超过 N：used < N 放行，used ≥ N 拒绝', () => {
    const n = { runs: 5, diagnoses: 2, time: 100 };
    for (let used = 0; used < 5; used += 1) {
      expect(wouldExceedNext(n, { runs: used }, 'runs')).toBe(false);
    }
    for (let used = 5; used < 8; used += 1) {
      expect(wouldExceedNext(n, { runs: used }, 'runs')).toBe(true);
    }
  });

  it('三个维度各自判定（诊断 / 时间同口径）', () => {
    expect(wouldExceedNext(limits, { diagnoses: 1 }, 'diagnoses')).toBe(false);
    expect(wouldExceedNext(limits, { diagnoses: 2 }, 'diagnoses')).toBe(true);
    expect(wouldExceedNext(limits, { time: 99 }, 'time')).toBe(false);
    expect(wouldExceedNext(limits, { time: 100 }, 'time')).toBe(true);
  });

  it('**与 evaluateBudget 的区别**（R34.2）：used === limit 时前者拒绝、后者不报超限', () => {
    const atLimit = { runs: 1, diagnoses: 2, time: 100 };
    // 报告口径：尚未超出 ⇒ 不报 budget_exhausted
    const evaluation = evaluateBudget(limits, atLimit);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.exceeded).toEqual([]);
    expect(evaluation.exhausted).toEqual(['runs', 'diagnoses', 'time']);
    // 许可口径：不能再来一次
    expect(wouldExceedNext(limits, atLimit, 'runs')).toBe(true);

    // 真正超出后（used > limit）：报告口径也变红，但两者的判据仍然不同
    const over = evaluateBudget(limits, { runs: 2 });
    expect(over.exceeded).toEqual(['runs']);
    expect(wouldExceedNext(limits, { runs: 2 }, 'runs')).toBe(true);
  });

  it('上限未登记 ⇒ 抛 DiagnosisBudgetError（闸门不得在未知上限下静默放行）', () => {
    expect(() => wouldExceedNext(undefined, ZERO, 'runs')).toThrow(DiagnosisBudgetError);
    expect(() => wouldExceedNext(null, ZERO, 'runs')).toThrow(/必须在场景执行前由调用方给出/);
    expect(() => wouldExceedNext(limits, ZERO, 'unknown' as never)).toThrow(DiagnosisBudgetError);
  });
});

describe('模块错误类型仍可识别（scope 未引入新的错误家族）', () => {
  it('FingerprintError / DiagnosisBudgetError 都属于 DependencyError', () => {
    expect(isDependencyError(new FingerprintError('x'))).toBe(true);
    expect(isDependencyError(new DiagnosisBudgetError('x'))).toBe(true);
  });
});
