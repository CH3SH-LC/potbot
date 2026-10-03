/**
 * G01 独立验收 —— 工作项发布的**统一任务 / 版本边界**。
 *
 * 依据：`docs/other/prep/接口合同-冻结v1.3（G01-G05修复批）.md` §1（R42.1–R42.5）、
 * `docs/other/review/DS进度复查与下一步方案-2026-10-02.md` 的 G01 小节。
 *
 * 本文件是 `docs/other/review/freeze4-recheck/ledger.test.ts` 前 3 个用例的**正向翻写**：
 * 那份历史记录刻意断言缺陷存在（"修复前可复现"），本文件断言缺陷**已被关闭**——
 * 同一套公开入口、同一批场景，判据反向。
 *
 * ## 纪律
 *
 * - 全部经**公开入口**：`scheduler.onMessage` / `startRun` / `finishRun` / `advanceOnce`。
 *   夹具只做初始状态登记（实例 / 任务 / 群成员）**与实际投递**，不 `putWorkItem`、
 *   不手改 `TaskRecord`、不伪造 `SenderBinding`。
 * - 计数与状态断言一律用**等号**（R17：禁止 `toBeLessThanOrEqual`）。
 * - 修复前会红的用例在各自 `it` 的注释里标注了 `freeze4-recheck/ledger.test.ts` 的对应行号。
 */

import { describe, expect, it } from 'vitest';
import {
  asRevision,
  asTaskId,
  type InstanceId,
  type RequestId,
  type Store,
  type TaskId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import {
  INSTANCE_C,
  TASK_ID,
  buildMessage,
  buildScheduler,
  buildStore,
  instanceId,
  messageId,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from '../../../src/scheduler/test-support.js';

const R_1: RequestId = requestId('r-1');
const R_2: RequestId = requestId('r-2');
/** 第二个任务（与 T1 同群、同负责人），跨任务越界的发布方。 */
const T_2: TaskId = asTaskId('T2');

const WAITING: { readonly kind: 'other'; readonly detail: string } = {
  kind: 'other',
  detail: '等待运行轮次处理',
};

function setup(): { readonly store: Store; readonly scheduler: ReturnType<typeof buildScheduler> } {
  const store = buildStore();
  registerInstance(store, INSTANCE_C);
  registerTask(store);
  return { store, scheduler: buildScheduler(store) };
}

/** 只读取工作项；不存在即抛错（不静默跳过，R22）。 */
function itemOf(store: Store, id: RequestId): WorkItem {
  const item = store.snapshot().work_items.find((row) => row.request_id === id);
  if (item === undefined) {
    throw new Error(`工作承诺表里没有 ${id}（夹具 / 场景构造错误）`);
  }
  return item;
}

function resultRefsOf(store: Store, id: RequestId): readonly string[] {
  return itemOf(store, id).result_refs;
}

describe('G01 工作项发布的统一任务/版本边界（R42.1–R42.5）', () => {
  it('G01-1 同负责人跨任务：T2 轮次发布 T1 工作项逐条被拒，applied 不含该条，状态与结果引用零变更', () => {
    // 修复前：`evaluateOrigin` 只核 `run.instance_id === item.owner_instance_id`，跨任务照写 —
    // freeze4-recheck/ledger.test.ts:15-23（"newer run can publish old revision work"）与
    // :43-53（"T2 run publishes into cancelled T1 work with same owner"）实测 applied=['r-1','r-1']。
    const { store, scheduler } = setup();

    // --- T1：r-1 在 T1 rev1 正常工作过一轮，收回 pending ---
    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const run1 = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run1).not.toBeNull();
    expect(run1?.task_id).toBe(TASK_ID);
    const finished1 = scheduler.finishRun({
      run_id: run1!.run_id,
      publications: [{ kind: 'pending', request_id: R_1, blocker_reason: WAITING }],
    });
    expect(finished1.accepted).toBe(true);
    expect(finished1.applied_request_ids).toEqual([R_1]);
    expect(itemOf(store, R_1).status).toBe('pending');

    // --- T2：同群（G1）、同负责人（C）的第二个任务，起一轮 ---
    registerTask(store, { task_id: T_2, revision: asRevision(1) });
    expect(scheduler.onMessage(workRequest(2, { task_id: T_2 })).result).toBe('accepted');
    const run2 = scheduler.startRun({ instance_id: INSTANCE_C, task_id: T_2 }).run;
    expect(run2).not.toBeNull();
    expect(run2?.task_id).toBe(T_2);

    const before = itemOf(store, R_1);
    expect(before.status).toBe('pending');
    expect(before.result_refs).toEqual([]);

    // --- T2 轮次发布 T1 的工作项：逐条被拒 ---
    const out = scheduler.finishRun({
      run_id: run2!.run_id,
      publications: [
        { kind: 'processing', request_id: R_1, blocker_reason: WAITING },
        { kind: 'completed', request_id: R_1, result_refs: [resultRef(R_1)] },
      ],
    });

    expect(out.applied_request_ids).toEqual([]);
    expect(out.rejected_publications.map((row) => row.request_id)).toEqual([R_1, R_1]);
    expect(out.rejected_publications.map((row) => row.ledger_reason)).toEqual([
      'task_scope_mismatch',
      'task_scope_mismatch',
    ]);
    // R42.2：跨任务是"范围不符"，不是"版本过时"；ownership_reason 为 null。
    expect(out.rejected_publications.map((row) => row.ownership_reason)).toEqual([null, null]);

    // 零变更：状态与结果引用都停在发布之前的值。
    const after = itemOf(store, R_1);
    expect(after.status).toBe(before.status);
    expect(after.status).toBe('pending');
    expect(after.result_refs).toEqual(before.result_refs);
    expect(resultRefsOf(store, R_1)).toEqual([]);
  });

  it('G01-2 已合法取消的 T1 工作项被同群同负责人 T2 轮次发布：同样被拒，cancelled 保持 true', () => {
    // 修复前：freeze4-recheck/ledger.test.ts:43-53 实测该发布 accepted，
    // T1 工作项变成 completed 而 T1 的 cancelled 仍为 true（越权写入已取消任务）。
    const { store, scheduler } = setup();

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const run1 = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run1).not.toBeNull();
    const finished1 = scheduler.finishRun({
      run_id: run1!.run_id,
      publications: [{ kind: 'pending', request_id: R_1, blocker_reason: WAITING }],
    });
    expect(finished1.accepted).toBe(true);

    // 合法取消 T1（任务级取消：不指认具体工作项）。
    const cancelled = scheduler.onMessage(
      buildMessage({
        message_id: messageId('cancel-T1'),
        type: 'cancel',
        content: '用户取消 T1',
      }),
    );
    expect(cancelled.result).toBe('accepted');
    expect(cancelled.task_control_state?.cancelled).toBe(true);

    // 另建同群同负责人 T2 轮次。
    registerTask(store, { task_id: T_2, revision: asRevision(1) });
    expect(scheduler.onMessage(workRequest(2, { task_id: T_2 })).result).toBe('accepted');
    const run2 = scheduler.startRun({ instance_id: INSTANCE_C, task_id: T_2 }).run;
    expect(run2?.task_id).toBe(T_2);

    const before = itemOf(store, R_1);
    const out = scheduler.finishRun({
      run_id: run2!.run_id,
      publications: [
        { kind: 'processing', request_id: R_1, blocker_reason: WAITING },
        { kind: 'completed', request_id: R_1, result_refs: [resultRef(R_1)] },
      ],
    });

    expect(out.applied_request_ids).toEqual([]);
    expect(out.rejected_publications.map((row) => row.ledger_reason)).toEqual([
      'task_scope_mismatch',
      'task_scope_mismatch',
    ]);

    const after = itemOf(store, R_1);
    expect(after.status).toBe(before.status);
    expect(after.status).toBe('pending');
    expect(resultRefsOf(store, R_1)).toEqual([]);

    // 权威取消事实保持为真（没有任何路径把它撤销）。
    const control = store
      .snapshot()
      .task_control_states.find((state) => state.task_id === TASK_ID);
    expect(control).toBeDefined();
    expect(control?.cancelled).toBe(true);
  });

  it('G01-3 同任务跨版本：rev2 轮次发布 rev1 工作项被拒（stale_task_revision），当前版本工作项仍可完成', () => {
    // 修复前：freeze4-recheck/ledger.test.ts:15-23 实测 rev2 轮次把 rev1 工作项写成 completed。
    const { store, scheduler } = setup();

    // rev1 下的旧工作项 r-1 先落地（任务此时仍是 rev1）。
    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(itemOf(store, R_1).task_revision).toBe(asRevision(1));

    // 任务升级到 rev2；新版本下再来一条工作请求。
    registerTask(store, { revision: asRevision(2) });
    expect(scheduler.onMessage(workRequest(2, { task_revision: asRevision(2) })).result).toBe(
      'accepted',
    );
    expect(itemOf(store, R_2).task_revision).toBe(asRevision(2));

    const run = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run).not.toBeNull();
    expect(run?.task_revision).toBe(asRevision(2));

    const beforeOld = itemOf(store, R_1);
    const out = scheduler.finishRun({
      run_id: run!.run_id,
      publications: [
        // 正例对照：当前任务当前版本的工作项仍可正常完成（防止"一律拒绝"式假通过）。
        { kind: 'completed', request_id: R_2, result_refs: [resultRef(R_2)] },
        // 越界条：rev1 的旧工作项不得被 rev2 轮次写入。
        { kind: 'completed', request_id: R_1, result_refs: [resultRef(R_1)] },
      ],
    });

    expect(out.applied_request_ids).toEqual([R_2]);
    expect(out.rejected_publications.map((row) => row.request_id)).toEqual([R_1]);
    expect(out.rejected_publications.map((row) => row.ledger_reason)).toEqual([
      'stale_task_revision',
    ]);

    // 正例确实生效（不是"什么都没写"的假通过）。
    expect(itemOf(store, R_2).status).toBe('completed');
    expect(resultRefsOf(store, R_2)).toEqual([resultRef(R_2)]);

    // 越界条零变更。
    const afterOld = itemOf(store, R_1);
    expect(afterOld.status).toBe(beforeOld.status);
    expect(afterOld.result_refs).toEqual(beforeOld.result_refs);
    expect(resultRefsOf(store, R_1)).toEqual([]);
  });

  it('G01-4 逐条粒度：同一请求内合法条 applied、越界条 rejected，被拒不阻断合法发布（R42.3）', () => {
    // 修复前：freeze4-recheck/ledger.test.ts:43-53 的 applied 同时含越界条；
    // 若修复方向误用"必须属于 frozen_request_ids"，本用例的合法条会被连带拒绝（假通过的反面）。
    const { store, scheduler } = setup();

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const run1 = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run1).not.toBeNull();
    expect(
      scheduler.finishRun({
        run_id: run1!.run_id,
        publications: [{ kind: 'pending', request_id: R_1, blocker_reason: WAITING }],
      }).accepted,
    ).toBe(true);

    registerTask(store, { task_id: T_2, revision: asRevision(1) });
    expect(scheduler.onMessage(workRequest(2, { task_id: T_2 })).result).toBe('accepted');
    const run2 = scheduler.startRun({ instance_id: INSTANCE_C, task_id: T_2 }).run;
    expect(run2?.task_id).toBe(T_2);

    const before = itemOf(store, R_1);
    const out = scheduler.finishRun({
      run_id: run2!.run_id,
      publications: [
        { kind: 'completed', request_id: R_2, result_refs: [resultRef(R_2)] }, // 合法：T2 自己本轮认领的项
        { kind: 'processing', request_id: R_1, blocker_reason: WAITING }, // 越界：T1 的项
        { kind: 'completed', request_id: R_1, result_refs: [resultRef(R_1)] }, // 越界：同上
      ],
    });

    expect(out.applied_request_ids).toEqual([R_2]);
    expect(out.rejected_publications.map((row) => row.request_id)).toEqual([R_1, R_1]);
    expect(out.rejected_publications.map((row) => row.ledger_reason)).toEqual([
      'task_scope_mismatch',
      'task_scope_mismatch',
    ]);

    // 合法条真的完成（不是"合法条也被拒"的假通过）。
    expect(itemOf(store, R_2).status).toBe('completed');
    expect(resultRefsOf(store, R_2)).toEqual([resultRef(R_2)]);

    // 越界条零变更。
    const after = itemOf(store, R_1);
    expect(after.status).toBe(before.status);
    expect(resultRefsOf(store, R_1)).toEqual([]);
  });

  it('G01-5 回归：正常依赖解除（F03）不被任务范围核对阻断，A 在 B 完成后自然进入可运行并完成', async () => {
    // 这是**回归护栏**（合同 R42.3/R42.5）：它在修复前后都应为绿 —— 不构造越界发布。
    // 但它必须证明新加的范围核对没有顺手把"依赖解除轮次只带可运行输入"也关掉：
    // A 等 B → B 完成（含提交前 / 提交后两次失败）→ 只有一条解除输入 → A 自然起一轮并完成。
    const store = createMemoryStore({
      faults: {
        beforeCommit() {
          if (failCommit) throw new Error('probe-before-commit');
        },
        beforePublishEvent() {
          if (failPublish) throw new Error('probe-before-publish');
        },
      },
    });
    let failCommit = false;
    let failPublish = false;

    const B: InstanceId = instanceId('B');
    registerInstance(store, INSTANCE_C);
    registerInstance(store, B);
    registerTask(store);
    const scheduler = buildScheduler(store);

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(scheduler.onMessage(workRequest(2, { recipient_instance_id: B })).result).toBe(
      'accepted',
    );

    const runA = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(runA).not.toBeNull();
    const waitedA = scheduler.finishRun({
      run_id: runA!.run_id,
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: R_1,
          dependency_refs: [{ request_id: R_2 }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 B 完成' },
        },
      ],
    });
    expect(waitedA.accepted).toBe(true);
    expect(itemOf(store, R_1).status).toBe('waiting_dependency');

    const runB = scheduler.startRun({ instance_id: B }).run;
    expect(runB).not.toBeNull();
    const finishB = {
      run_id: runB!.run_id,
      publications: [
        {
          kind: 'completed' as const,
          request_id: R_2,
          result_refs: [resultRef(R_2)],
        },
      ],
    };

    // 提交前失败：整个快照不变（原子性）。
    const beforeFailure = store.snapshot();
    failCommit = true;
    expect(() => scheduler.finishRun(finishB)).toThrow();
    failCommit = false;
    expect(store.snapshot()).toEqual(beforeFailure);

    // 提交后失败：结果已落、解除已落地，只有发布失败；重放不重复。
    failPublish = true;
    expect(() => scheduler.finishRun(finishB)).toThrow();
    failPublish = false;

    const committed = store.snapshot();
    expect(itemOf(store, R_1).status).toBe('processing');
    expect(itemOf(store, R_2).status).toBe('completed');
    expect(committed.actionable_inputs.length).toBe(1);

    scheduler.publishPendingEvents();
    scheduler.publishPendingEvents();
    expect(scheduler.pendingDeliveryEvents()).toEqual([]);
    expect(store.snapshot().actionable_inputs.length).toBe(1);

    // A 自然进入可运行：恰好启动一轮，并正常完成。
    const next = scheduler.advanceOnce({ instance_id: INSTANCE_C });
    expect(next.startedRuns).toBe(1);
    expect(next.run).not.toBeNull();
    const doneA = scheduler.finishRun({
      run_id: next.run!.run_id,
      publications: [{ kind: 'completed', request_id: R_1, result_refs: [resultRef(R_1)] }],
    });
    expect(doneA.accepted).toBe(true);
    expect(doneA.applied_request_ids).toEqual([R_1]);
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(0);
    expect(store.snapshot().work_items.every((row) => row.status === 'completed')).toBe(true);
  });
});
