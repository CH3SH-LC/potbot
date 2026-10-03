/**
 * G01 / 合同 v1.3 R42.1–R42.3：工作项发布的**任务与版本范围核对**。
 *
 * 位置：`evaluateOrigin()` 的第 3 步（在"轮次所有权判定"与"工作项负责人核对"之间）。
 * 反例出自 `docs/other/review/DS进度复查与下一步方案-2026-10-02.md` 的 G01 小节：
 *  ① 同负责人跨任务（T2 轮次发布 T1 工作）——修复前 `accepted = true`；
 *  ② 同任务跨版本（rev2 轮次发布停在 rev1 的工作）——修复前同样被放行。
 *
 * 本文件是**单元测试**，只覆盖 `src/workledger` 的范围判定；真实入口级的关闭标准
 * （`finishRun` 的 accepted / applied / 状态回读）由主协调者与验收子智能体在集成后验证。
 */

import { describe, expect, it } from 'vitest';

import {
  applyWorkItemTransition,
  evaluateOrigin,
  isOwnershipLost,
  isStaleOrigin,
  isWorkLedgerError,
  ORIGIN_REJECTION_REASONS,
  WORK_LEDGER_REJECTION_REASONS,
  type RunOrigin,
} from './index.js';
import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createInstanceState,
  createRunRecord,
  createWorkItem,
  evaluateRunOwnership,
  PUBLICATION_REJECTION_REASONS,
  type InstanceId,
  type InstanceState,
  type Revision,
  type RunRecord,
  type TaskId,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';

const T1 = asTaskId('T1');
const T2 = asTaskId('T2');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const RUN2 = asRunId('run-t2');
const REV1 = asRevision(1);
const REV2 = asRevision(2);
const AT = asLogicalTime(5);

interface ItemOver {
  readonly request_id?: string;
  readonly task_id?: TaskId;
  readonly task_revision?: Revision;
  readonly owner_instance_id?: InstanceId;
  readonly status?: WorkItemStatus;
}

/** T1 / rev1 / 负责人 C 的"处理中"工作项（范围一致的基准）。 */
function item(over: ItemOver = {}): WorkItem {
  return createWorkItem({
    request_id: asRequestId(over.request_id ?? 'req-1'),
    task_id: over.task_id ?? T1,
    task_revision: over.task_revision ?? REV1,
    owner_instance_id: over.owner_instance_id ?? C,
    created_at: asLogicalTime(0),
    status: over.status ?? 'processing',
    blocker_reason: { kind: 'other', detail: '本轮处理中' },
  });
}

function instance(activeRunId = RUN2): InstanceState {
  return createInstanceState({
    instance_id: C,
    group_id: GROUP,
    updated_at: asLogicalTime(0),
    activity: 'active',
    active_run_id: activeRunId,
    lease_deadline: asLogicalTime(1000),
  });
}

/** 由实例 C 发起、属于任务 `taskId`、冻结版本 `revision` 的轮次。 */
function run(taskId = T1, revision = REV1): RunRecord {
  return createRunRecord({
    run_id: RUN2,
    task_id: taskId,
    group_id: GROUP,
    instance_id: C,
    task_revision: revision,
    started_at: asLogicalTime(0),
    lease_deadline: asLogicalTime(1000),
  });
}

/**
 * `current_task_revision` 默认跟随轮次冻结版本——这样"版本已变"只由
 * `item` ↔ `run` 的差异触发，而不是被轮次级 stale 抢先命中。
 */
function origin(over: Partial<RunOrigin> = {}): RunOrigin {
  const resolvedRun = 'run' in over ? over.run : run();
  return {
    kind: 'run',
    run: resolvedRun,
    instance: 'instance' in over ? over.instance : instance(),
    current_task_revision: over.current_task_revision ?? resolvedRun?.task_revision ?? REV1,
    now: over.now ?? asLogicalTime(500),
  };
}

// ---------------------------------------------------------------------------
// 反例 1：同负责人跨任务
// ---------------------------------------------------------------------------

describe('G01 第 3 步：任务范围核对（R42.1 / R42.2）', () => {
  it('同负责人跨任务 → task_scope_mismatch（不是 stale），ownership_reason 为 null', () => {
    // 轮次属于 T2，工作项属于 T1；实例/负责人完全相同（反例 ② 的精确形状）。
    const verdict = evaluateOrigin(origin({ run: run(T2, REV1) }), item({ task_id: T1 }));

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('task_scope_mismatch');
    expect(verdict.ownership_reason).toBe(null);
    // detail 必须写明是哪一处不符：run 的 task/revision 与 item 的 task/revision 都要在。
    expect(verdict.detail).toContain('T2');
    expect(verdict.detail).toContain('T1');
    expect(verdict.detail).toContain('1');
    // 语义归类：跨任务是"失去所有权"，不是 stale（两个辅助判定不得与新拒因矛盾）。
    expect(isOwnershipLost(origin({ run: run(T2, REV1) }), item({ task_id: T1 }))).toBe(true);
    expect(isStaleOrigin(origin({ run: run(T2, REV1) }), item({ task_id: T1 }))).toBe(false);
  });

  it('跨任务 + 跨版本同时不符 → 仍报 task_scope_mismatch（先 task_id 后 task_revision）', () => {
    const verdict = evaluateOrigin(
      origin({ run: run(T2, REV2), current_task_revision: REV2 }),
      item({ task_id: T1, task_revision: REV1 }),
    );

    expect(verdict.reason).toBe('task_scope_mismatch');
    expect(verdict.ownership_reason).toBe(null);
  });

  // -------------------------------------------------------------------------
  // 反例 2：同任务跨版本
  // -------------------------------------------------------------------------

  it('同任务跨版本（run=r2 / item=r1，当前版本也是 r2）→ stale_task_revision', () => {
    const verdict = evaluateOrigin(
      origin({ run: run(T1, REV2), current_task_revision: REV2 }),
      item({ task_revision: REV1 }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('stale_task_revision');
    expect(verdict.ownership_reason).toBe(null);
    // detail 同样要能取证：run 的 task/revision 与 item 的 task/revision 都在。
    expect(verdict.detail).toContain('T1');
    expect(verdict.detail).toContain('2');
    expect(verdict.detail).toContain('1');
    expect(isStaleOrigin(origin({ run: run(T1, REV2), current_task_revision: REV2 }), item())).toBe(
      true,
    );
    expect(
      isOwnershipLost(origin({ run: run(T1, REV2), current_task_revision: REV2 }), item()),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 正例对照：防止"一律拒绝"
  // -------------------------------------------------------------------------

  it('范围一致 + 负责人一致 → 允许（正例对照，防止一律拒绝）', () => {
    const verdict = evaluateOrigin(origin(), item());

    expect(verdict).toEqual({
      allowed: true,
      reason: null,
      ownership_reason: null,
      detail: '允许写入',
    });
  });

  it('kernel 发起仍允许（不受范围核对影响；依赖解除走这条）', () => {
    // 故意用一个"跨任务"的工作项：内核入口是入口事务 / 取消 / 依赖解除，不做范围核对。
    expect(evaluateOrigin({ kind: 'kernel' }, item({ task_id: T2 })).allowed).toBe(true);
    expect(evaluateOrigin(undefined, item({ task_id: T2 })).allowed).toBe(true);

    const next = applyWorkItemTransition({
      item: item({ task_id: T2, status: 'pending' }),
      to: 'processing',
      at: AT,
      origin: { kind: 'kernel', note: '依赖解除：产生新的可运行输入（Q5-c）' },
      blocker_reason: { kind: 'other', detail: '依赖已解除，进入处理' },
    });
    expect(next.status).toBe('processing');
  });

  it('负责人不符仍在范围核对之后生效（order 不变：范围 → 负责人）', () => {
    // 同任务同版本，但负责人是 D：必须报 owner_mismatch，而不是 task_scope_mismatch 或 stale。
    const verdict = evaluateOrigin(origin(), item({ owner_instance_id: asInstanceId('D') }));
    expect(verdict.reason).toBe('owner_mismatch');
    expect(verdict.ownership_reason).toBe(null);
  });

  // -------------------------------------------------------------------------
  // 逐条发布粒度：一条被拒不阻断其它合法发布
  // -------------------------------------------------------------------------

  it('R42.3 逐条发布粒度：一条被拒不得阻断同一请求内其它合法发布', () => {
    // 同一个 T1/rev1 轮次里出现两条发布：一条在范围内，一条属于 T2（越界）。
    const inScope = item({ request_id: 'req-in-scope' });
    const outOfScope = item({ request_id: 'req-out-of-scope', task_id: T2 });
    const runOrigin = origin({ run: run(T1, REV1) });

    // 与 `finishRun` 相同的逐条 try/catch 语义（一条被拒不影响下一条）。
    const applied: string[] = [];
    const rejected: { request_id: string; reason: string }[] = [];

    for (const target of [inScope, outOfScope] as const) {
      try {
        const next = applyWorkItemTransition({
          item: target,
          to: 'completed',
          at: AT,
          origin: runOrigin,
          completion: {
            request_id: target.request_id,
            result_refs: [asArtifactRef('art-1')],
          },
        });
        applied.push(String(next.request_id));
      } catch (error) {
        expect(isWorkLedgerError(error)).toBe(true);
        if (isWorkLedgerError(error)) {
          rejected.push({ request_id: String(target.request_id), reason: error.reason });
        }
      }
    }

    // 范围内的那条照常完成；越界那条被拒，且拒因是新的 task_scope_mismatch。
    expect(applied).toEqual(['req-in-scope']);
    expect(rejected).toEqual([{ request_id: 'req-out-of-scope', reason: 'task_scope_mismatch' }]);
    // 被拒的那条原对象不变（无状态变更、无结果引用写入）。
    expect(outOfScope.status).toBe('processing');
    expect(outOfScope.result_refs).toEqual([]);
  });

  it('被拒的跨任务发布不写结果引用、不改工作项状态', () => {
    const processing = item({ status: 'processing' });
    const before = JSON.stringify(processing);

    let caught: unknown;
    try {
      applyWorkItemTransition({
        item: processing,
        to: 'completed',
        at: AT,
        origin: origin({ run: run(T2, REV1) }),
        completion: { request_id: processing.request_id, result_refs: [asArtifactRef('art-1')] },
      });
    } catch (error) {
      caught = error;
    }

    expect(isWorkLedgerError(caught)).toBe(true);
    expect((caught as { reason: string }).reason).toBe('task_scope_mismatch');
    expect((caught as { ownership_reason: unknown }).ownership_reason).toBe(null);
    expect((caught as { accepted: boolean }).accepted).toBe(false);
    // 原对象逐字节不变：没有结果引用被写入、状态没有变化。
    expect(JSON.stringify(processing)).toBe(before);
    expect(processing.result_refs).toEqual([]);
    expect(processing.status).toBe('processing');
  });

  // -------------------------------------------------------------------------
  // 拒因集合登记（跨模块一致性）
  // -------------------------------------------------------------------------

  it('task_scope_mismatch 登记进两个工作项级集合，且不进 protocol 的五因（protocol 不改）', () => {
    expect(ORIGIN_REJECTION_REASONS).toContain('task_scope_mismatch');
    expect(WORK_LEDGER_REJECTION_REASONS).toContain('task_scope_mismatch');
    // 范围的拒因是工作项级的；轮次级五因（R7 不改变）不得被扩充。
    expect([...(PUBLICATION_REJECTION_REASONS as readonly string[])]).not.toContain(
      'task_scope_mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// R7 式受控缺陷注入：证明"新校验被关掉时反例会变绿、正例仍通过"
// ---------------------------------------------------------------------------

/**
 * **仅存在于测试中**的修复前判定复刻：只有"轮次所有权 → 工作项负责人"两步，
 * 没有任何 task_id / task_revision 范围核对（即 G01 报告里 origin.ts:124 的旧行为）。
 *
 * 用途：把新校验"关掉"，证明第 3 步确实是让两条反例变红的那一处——
 * 关闭时反例被放行（allowed=true）、正例也通过；打开（真实实现）时反例被拒。
 */
function originWithoutScopeCheck(
  resolved: RunOrigin,
  target: WorkItem,
): { readonly allowed: boolean; readonly reason: string | null } {
  const runRecord = resolved.run;
  if (runRecord === undefined) {
    return { allowed: false, reason: 'ownership_rejected' };
  }
  const validity = evaluateRunOwnership({
    run: runRecord,
    instance: resolved.instance,
    now: resolved.now,
    current_task_revision: resolved.current_task_revision,
  });
  if (!validity.valid) {
    return {
      allowed: false,
      reason: validity.reason === 'stale_task_revision' ? 'stale_task_revision' : 'ownership_rejected',
    };
  }
  if (runRecord.instance_id !== target.owner_instance_id) {
    return { allowed: false, reason: 'owner_mismatch' };
  }
  return { allowed: true, reason: null };
}

describe('R7 受控缺陷注入：范围核对必须可证伪（开关只在测试内，生产实现始终开启）', () => {
  it('关闭新校验 → 两条反例被放行（allowed=true）；打开 → 被拒', () => {
    const crossTaskOrigin = origin({ run: run(T2, REV1) });
    const staleOrigin = origin({ run: run(T1, REV2), current_task_revision: REV2 });
    const T1Item = item({ task_id: T1, task_revision: REV1 });

    // 注入（等价于"关掉第 3 步"）：反例被放行 —— 这正是修复前的缺陷行为。
    expect(originWithoutScopeCheck(crossTaskOrigin, T1Item).allowed).toBe(true);
    expect(originWithoutScopeCheck(staleOrigin, T1Item).allowed).toBe(true);

    // 真实实现（第 3 步开启）：同一输入被拒 —— 证明上面的断言不是恒真。
    expect(evaluateOrigin(crossTaskOrigin, T1Item).reason).toBe('task_scope_mismatch');
    expect(evaluateOrigin(staleOrigin, T1Item).reason).toBe('stale_task_revision');

    // 关闭时正例仍通过：证明注入只摘掉"范围"这一点，而不是把整个判定弄坏。
    expect(originWithoutScopeCheck(origin(), T1Item).allowed).toBe(true);
    expect(evaluateOrigin(origin(), T1Item).allowed).toBe(true);
  });
});
