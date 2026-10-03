/**
 * **修复批回归**（合同 v1.2；对应 `docs/other/ds-repair-guide-2026-10-02.md` 的 F01 / F02 / F06）。
 *
 * 为什么单独一个文件：这三项的判据**跨模块**（入口事务 + 轮次事务 + 记账投影），
 * 塞进任一既有模块的单测都会让那个文件的主题失焦。本文件的每个用例都标注它验的 F 编号，
 * 并写清"修复前的行为是什么"——回归的价值在于它**在修复前会红**。
 *
 * 这些是**单元级**回归；A05/P4 侧的端到端行为回归由 `tests/acceptance/**` 承载。
 */

import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asRevision,
  asTaskId,
  asLogicalTime,
  createIdSource,
  createTaskRecord,
  type InstanceId,
  type RequestId,
  type TaskId,
} from '../protocol/index.js';
import { BudgetLedger } from '../clock/budget.js';
import { createMemoryStore } from '../storage/index.js';
import { createScheduler } from './scheduler.js';
import {
  GROUP_ID,
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
} from './test-support.js';

const TASK_T2: TaskId = asTaskId('T2');
/** 同群的第二个实例（"接收者不是负责人"负向用例）。 */
const INSTANCE_D: InstanceId = asInstanceId('D');

/** 只读：某工作项的当前状态（断言只经快照读，不窥探内部内存）。 */
function workItemOf(
  store: ReturnType<typeof buildStore>,
  request: RequestId,
): { readonly status: string; readonly result_refs: readonly string[] } | undefined {
  const item = store.snapshot().work_items.find((candidate) => candidate.request_id === request);
  return item === undefined ? undefined : { status: item.status, result_refs: item.result_refs };
}

// ---------------------------------------------------------------------------
// F01 —— 取消操作只作用于**合法范围内**的目标
// ---------------------------------------------------------------------------

describe('F01 取消目标的范围校验（修复前：可越权取消另一任务的工作项）', () => {
  it('跨任务目标 ⇒ 整个入口失败，且零业务变更', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(1) });
    registerTask(store, { task_id: TASK_T2, group_id: GROUP_ID, revision: asRevision(1) });
    const scheduler = buildScheduler(store, { default_task_id: TASK_ID });

    // 先造出 T2 的一项工作（属于另一个任务）。
    const seeded = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-t2'),
        task_id: TASK_T2,
        request_id: requestId('r-t2'),
        recipient_instance_id: INSTANCE_C,
      }),
    );
    expect(seeded.result).toBe('accepted');
    expect(workItemOf(store, requestId('r-t2'))?.status).toBe('pending');

    // T1 的取消消息指定 T2 的请求 id —— 修复前这里返回 accepted 并**真的取消了 T2 的工作项**。
    const outcome = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-cancel'),
        task_id: TASK_ID,
        type: 'cancel',
        reply_to: requestId('r-t2'),
        recipient_instance_id: INSTANCE_C,
      }),
    );

    expect(outcome.result).toBe('failed');
    expect(outcome.failure_reason).toMatch(/取消不得跨任务/);
    // 零业务变更：目标工作项照旧、无控制状态被写入、取消消息未入有效收件箱。
    expect(workItemOf(store, requestId('r-t2'))?.status).toBe('pending');
    expect(store.snapshot().task_control_states).toEqual([]);
    expect(store.snapshot().inbox_entries.map((entry) => entry.message_id)).toEqual(['m-t2']);
  });

  it('同任务但接收者不是目标负责人 ⇒ 拒绝（不得用 sender == owner 代替授权与路由）', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1)); // r-1 归 INSTANCE_C
    // 同群的另一个实例 D 收到这条取消：它是本群合法实例，但不是 r-1 的负责人。
    registerInstance(store, INSTANCE_D, GROUP_ID, asLogicalTime(0), { withSenders: false });

    const outcome = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-cancel-wrong-recipient'),
        task_id: TASK_ID,
        type: 'cancel',
        reply_to: requestId('r-1'),
        recipient_instance_id: INSTANCE_D,
      }),
    );

    expect(outcome.result).toBe('failed');
    expect(outcome.failure_reason).toMatch(/路由不符/);
    expect(workItemOf(store, requestId('r-1'))?.status).toBe('pending');
    expect(store.snapshot().task_control_states).toEqual([]);
  });

  it('合法取消：同一事务内取消工作项 + 写控制状态；重复同一 message_id 不重复写控制意图', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const cancelMessage = buildMessage({
      message_id: messageId('m-cancel-ok'),
      task_id: TASK_ID,
      type: 'cancel',
      reply_to: requestId('r-1'),
      recipient_instance_id: INSTANCE_C,
    });

    const outcome = scheduler.onMessage(cancelMessage);
    expect(outcome.result).toBe('accepted');
    expect(outcome.task_control_state?.cancelled).toBe(true);
    expect(workItemOf(store, requestId('r-1'))?.status).toBe('cancelled');
    const epoch = outcome.task_control_state?.control_epoch ?? -1;
    expect(epoch).toBeGreaterThan(0);

    // 重试同一 message_id（去重是三值里的 duplicate_not_created）：控制意图**不**再写一次。
    const again = scheduler.onMessage(cancelMessage);
    expect(again.result).toBe('duplicate_not_created');
    expect(store.snapshot().task_control_states[0]?.control_epoch).toBe(epoch);
  });
});

// ---------------------------------------------------------------------------
// F02 —— 取消阻止在途发布，也阻止未开始的轮次
// ---------------------------------------------------------------------------

describe('F02 取消状态阻止发布与启动（修复前：取消后仍可提交 completed）', () => {
  it('在途轮次遇任务取消 ⇒ 发布被拒（task_cancelled）、结果引用不写入、取消状态不回退、轮次仍收尾', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    const started = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    const runId = started.run?.run_id ?? ('run-1' as never);

    // 任务级取消（不带 reply_to）：不取消具体某一项，但取消是**任务级**事实。
    const cancel = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-cancel-task'),
        task_id: TASK_ID,
        type: 'cancel',
        recipient_instance_id: INSTANCE_C,
      }),
    );
    expect(cancel.result).toBe('accepted');
    expect(cancel.task_control_state?.cancelled).toBe(true);

    const finish = scheduler.finishRun({
      run_id: runId,
      publications: [
        {
          kind: 'completed',
          request_id: requestId('r-1'),
          result_refs: [resultRef(requestId('r-1'))],
        },
      ],
    });

    expect(finish.accepted).toBe(false);
    expect(finish.rejection_reason).toBe('task_cancelled');
    expect(finish.applied_request_ids).toEqual([]);
    // 结果引用**不写入**；工作项停在启动时认领到的 `processing`，**不得**变成 `completed`。
    expect(workItemOf(store, requestId('r-1'))?.result_refs).toEqual([]);
    expect(workItemOf(store, requestId('r-1'))?.status).toBe('processing');
    // 取消状态不回退。
    expect(store.snapshot().task_control_states[0]?.cancelled).toBe(true);
    // 轮次仍收尾（否则执行槽永久泄漏），但不再续排下一次运行机会。
    expect(store.snapshot().runs.find((run) => run.run_id === runId)?.status).toBe('finished');
    expect(finish.queued_next_run).toBe(false);
    expect(store.snapshot().instances[0]?.active_run_id).toBeNull();
    // 观测事件明确：拒因可查。
    expect(
      scheduler.kernelEvents().filter((event) => event.rejection_reason === 'task_cancelled').length,
    ).toBe(1);
  });

  it('未开始的取消任务不产生有效业务执行：推进被拒为 task_cancelled，残留排队标记被清除', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    // 先取消（此时还没有任何工作项）。
    const cancel = scheduler.onMessage(
      buildMessage({
        message_id: messageId('m-cancel-first'),
        task_id: TASK_ID,
        type: 'cancel',
        recipient_instance_id: INSTANCE_C,
      }),
    );
    expect(cancel.result).toBe('accepted');
    expect(store.snapshot().instances[0]?.queued_flag).toBe(false);

    // 取消之后到达的工作请求：消息照收（守恒），但**不产生**有效业务执行。
    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();
    expect(step.startedRuns).toBe(0);

    const refused = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(refused.started).toBe(false);
    expect(refused.reason).toBe('task_cancelled');
    // 不写已读、不认领工作项。
    expect(store.snapshot().read_receipts).toEqual([]);
    expect(scheduler.eventCounters().run_count).toBe(0);
    // 排队状态被正确收尾 —— 不留残留标记。
    expect(store.snapshot().instances[0]?.queued_flag).toBe(false);
    expect(store.snapshot().instances[0]?.active_run_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F03 —— 正常完成链路里由内核自动解除依赖
// ---------------------------------------------------------------------------

describe('F03 依赖解除接入完成链路（修复前：A 等 B，B 完成后 A 永远停在等待）', () => {
  it('仅经消息入口 + start/finish + 正常推进：B 完成后 A 自然进入可运行状态并完成', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    const B = instanceId('B');
    registerInstance(store, B);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(1) });
    // **刻意不登记 `stagnation`**（R37.4：正常解除不依赖停滞诊断预算）。
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1)); // r-1 归 C
    scheduler.onMessage(workRequest(2, { recipient_instance_id: B })); // r-2 归 B

    // C 领到 r-1：发现要先拿到 r-2 的结果 ⇒ 转等待依赖。
    const runC1 = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(runC1.started).toBe(true);
    const waitC = scheduler.finishRun({
      run_id: runC1.run?.run_id ?? ('run-1' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-1'),
          dependency_refs: [{ request_id: requestId('r-2') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-2 的结果' },
        },
      ],
    });
    expect(waitC.accepted).toBe(true);
    expect(workItemOf(store, requestId('r-1'))?.status).toBe('waiting_dependency');
    // 修复前：C 在这之后再怎么推进都启动 0 轮（解除要由夹具自己算计划、写库、唤醒）。
    // 这里只看 C 自己（B 还有未读的唤醒类消息，会先被推进挑走）。
    expect(scheduler.advanceOnce({ instance_id: INSTANCE_C }).startedRuns).toBe(0);

    // B 完成 r-2：**同一个结束事务内**内核应自动解除 r-1 的依赖并唤醒 C。
    const runB = scheduler.startRun({ instance_id: B });
    expect(runB.started).toBe(true);
    const finishB = scheduler.finishRun({
      run_id: runB.run?.run_id ?? ('run-2' as never),
      publications: [
        {
          kind: 'completed',
          request_id: requestId('r-2'),
          result_refs: [resultRef(requestId('r-2'))],
        },
      ],
    });
    expect(finishB.accepted).toBe(true);
    expect(workItemOf(store, requestId('r-2'))?.status).toBe('completed');

    // A 已被内核解除等待（waiting_dependency → processing，R14 #3），并且拿到了运行机会。
    expect(workItemOf(store, requestId('r-1'))?.status).toBe('processing');
    expect(store.snapshot().instances.find((state) => state.instance_id === INSTANCE_C)?.queued_flag).toBe(true);

    // 下一轮推进读到解除输入 ⇒ C 起一轮，并可以给出终态。
    const step = scheduler.advanceOnce();
    expect(step.startedRuns).toBe(1);
    const finishC2 = scheduler.finishRun({
      run_id: step.run?.run_id ?? ('run-3' as never),
      publications: [
        {
          kind: 'completed',
          request_id: requestId('r-1'),
          result_refs: [resultRef(requestId('r-1'))],
        },
      ],
    });
    expect(finishC2.accepted).toBe(true);
    expect(workItemOf(store, requestId('r-1'))?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// F04 —— 全链路使用群作用域消息查询
// ---------------------------------------------------------------------------

describe('F04 跨群同 message_id（修复前：两群都起不了轮次，查询歧义）', () => {
  it('两群各投递同一 message_id、不同 request_id ⇒ 都能冻结、执行、完成各自工作', () => {
    const GROUP_A = asGroupId('GA');
    const GROUP_B = asGroupId('GB');
    const TASK_A = asTaskId('TA');
    const TASK_B = asTaskId('TB');
    const SHARED = messageId('m-shared');

    const store = buildStore();
    registerInstance(store, INSTANCE_C, GROUP_A);
    registerInstance(store, INSTANCE_D, GROUP_B);
    registerTask(store, { task_id: TASK_A, group_id: GROUP_A, revision: asRevision(1) });
    registerTask(store, { task_id: TASK_B, group_id: GROUP_B, revision: asRevision(1) });
    const scheduler = buildScheduler(store);

    const first = scheduler.onMessage(
      buildMessage({
        message_id: SHARED,
        group_id: GROUP_A,
        task_id: TASK_A,
        request_id: requestId('r-a'),
        recipient_instance_id: INSTANCE_C,
      }),
    );
    const second = scheduler.onMessage(
      buildMessage({
        message_id: SHARED,
        group_id: GROUP_B,
        task_id: TASK_B,
        request_id: requestId('r-b'),
        recipient_instance_id: INSTANCE_D,
      }),
    );

    expect(first.result).toBe('accepted');
    expect(second.result).toBe('accepted');
    expect(store.snapshot().messages).toHaveLength(2);
    expect(store.snapshot().work_items).toHaveLength(2);

    for (const [instance, request] of [
      [INSTANCE_C, requestId('r-a')],
      [INSTANCE_D, requestId('r-b')],
    ] as const) {
      const step = scheduler.advanceOnce({ instance_id: instance });
      expect(step.startedRuns).toBe(1);
      const finish = scheduler.finishRun({
        run_id: step.run?.run_id ?? ('run-x' as never),
        publications: [
          { kind: 'completed', request_id: request, result_refs: [resultRef(request)] },
        ],
      });
      expect(finish.accepted).toBe(true);
      expect(workItemOf(store, request)?.status).toBe('completed');
    }

    // 无误去重、无跨群数据混入。
    expect(scheduler.eventCounters().inbox_message_count).toBe(2);
    expect(scheduler.eventCounters().run_count).toBe(2);
    expect(store.snapshot().work_items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// F06 —— 预算记账参与提交与回滚
// ---------------------------------------------------------------------------

describe('F06 预算记账 = 已提交事件的幂等投影（修复前：提交前失败仍扣预算）', () => {
  function buildGuarded() {
    let injected = false;
    const store = createMemoryStore({
      faults: {
        beforeCommit: (): void => {
          if (injected) {
            throw new Error('提交前故障注入（本次事务未提交）');
          }
        },
      },
    });
    const limits = { runs: 1, diagnoses: 4, time: 10_000 };
    const ledger = new BudgetLedger(limits);
    const scheduler = createScheduler(store, {
      idSource: createIdSource(),
      stagnation: { budget: limits, ledger },
    });
    return {
      store,
      ledger,
      scheduler,
      inject: (value: boolean): void => {
        injected = value;
      },
    };
  }

  it('提交前失败 ⇒ run / 事件 / 账目均无新增；移除故障后可正常运行（不再 budget_exhausted）', () => {
    const { store, ledger, scheduler, inject } = buildGuarded();
    registerInstance(store, INSTANCE_C);
    store.transact((tx) =>
      tx.putTask(
        createTaskRecord({
          task_id: TASK_ID,
          goal: 'F06 回归',
          current_group_id: GROUP_ID,
          revision: asRevision(1),
          created_at: asLogicalTime(0),
          updated_at: asLogicalTime(0),
        }),
      ),
    );
    scheduler.onMessage(workRequest(1));

    inject(true);
    expect(() => scheduler.startRun({ instance_id: INSTANCE_C })).toThrow();
    inject(false);

    // 三项都无新增：存储里没有 run、没有 run_started 事件、台账 runs 仍为 0。
    expect(store.snapshot().runs).toHaveLength(0);
    expect(scheduler.kernelEvents().filter((event) => event.kind === 'run_started')).toHaveLength(0);
    expect(ledger.used('runs')).toBe(0);

    // 移除故障后**能正常运行**（修复前：台账已记 1，此处会立刻 budget_exhausted）。
    const retry = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(retry.started).toBe(true);
    expect(ledger.used('runs')).toBe(1);
  });

  it('投影幂等：outbox 多次重放 / 重复补齐不重复扣费', () => {
    const { store, ledger, scheduler } = buildGuarded();
    registerInstance(store as ReturnType<typeof buildStore>, INSTANCE_C);
    scheduler.onMessage(workRequest(1));

    const started = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    expect(ledger.used('runs')).toBe(1);

    // 重放未投递事件（P2 的恢复路径）不应重复扣费。
    scheduler.publishPendingEvents();
    scheduler.publishPendingEvents();
    expect(ledger.used('runs')).toBe(1);

    // 再跑一次记账同步（提交点幂等）：仍然只有 1。
    scheduler.finishRun({ run_id: started.run?.run_id ?? ('run-1' as never) });
    expect(ledger.used('runs')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G02 —— 取消收尾**独立于**所有权 / 版本判定（合同 v1.3 R43）
//
// 修复前的行为（可复现，见 `docs/other/review/freeze4-recheck/ledger.test.ts` 第 3 个用例）：
// rev1 启动 → 登记 rev2 → 合法取消 → 原轮次 finish ⇒ `stale_task_revision` 早退，
// 取消收尾整段被跳过：`run.status` 停在 `running`、实例 `active`、`active_run_id` 仍指旧轮次。
// 本题的两个用例在修复前都会红。
// ---------------------------------------------------------------------------

describe('G02 取消收尾独立于版本判定（修复前：升级版本后取消，活动轮次与执行槽残留）', () => {
  it('版本升级后取消 ⇒ 零结果写入 + 轮次收尾 + 本人槽位释放 + 无后续排队', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store);
    const scheduler = buildScheduler(store);

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const run = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run).not.toBeNull();
    const runId = run?.run_id ?? ('run-missing' as never);

    // 版本升级**之后**才合法取消（任务级取消，权威控制状态置位）。
    registerTask(store, { revision: asRevision(2) });
    const cancelled = scheduler.onMessage(
      buildMessage({ message_id: messageId('cancel-rev2'), type: 'cancel', task_revision: asRevision(2) }),
    );
    expect(cancelled.result).toBe('accepted');

    const out = scheduler.finishRun({
      run_id: runId,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    // 拒因是**取消**，不是 stale——取消是任务级事实，不因版本过时而失效。
    expect(out.accepted).toBe(false);
    expect(out.rejection_reason).toBe('task_cancelled');
    expect(out.applied_request_ids).toEqual([]);

    // 零结果写入。
    expect(workItemOf(store, requestId('r-1'))?.result_refs).toEqual([]);

    const snap = store.snapshot();
    // 轮次完成收尾（不得停在 running）。
    expect(snap.runs.find((candidate) => candidate.run_id === runId)?.status).toBe('finished');
    // 本人槽位释放，且不残留排队标记（取消任务不继续执行）。
    const instance = snap.instances.find((candidate) => candidate.instance_id === INSTANCE_C);
    expect(instance?.active_run_id).toBeNull();
    expect(instance?.activity).toBe('idle');
    expect(instance?.queued_flag).toBe(false);
  });

  it('历史轮次重复 finish / 槽位已属于别的轮次 ⇒ 绝不清除该槽位', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store);
    const scheduler = buildScheduler(store);

    // 第一次轮次：正常收尾，自己的槽已释放。
    scheduler.onMessage(workRequest(1));
    const first = scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(first).not.toBeNull();
    const firstId = first?.run_id ?? ('run-missing' as never);
    scheduler.finishRun({ run_id: firstId });
    expect(store.snapshot().runs.find((c) => c.run_id === firstId)?.status).toBe('finished');

    // 另一个任务的新轮次占住了执行槽。
    registerTask(store, { task_id: TASK_T2 });
    expect(scheduler.onMessage(workRequest(2, { task_id: TASK_T2 })).result).toBe('accepted');
    const second = scheduler.startRun({ instance_id: INSTANCE_C, task_id: TASK_T2 }).run;
    expect(second).not.toBeNull();
    const secondId = second?.run_id ?? ('run-missing' as never);
    expect(store.snapshot().instances[0]?.active_run_id).toBe(secondId);

    // 现在取消第一个任务，再对**历史轮次**重复 finish。
    registerTask(store, { revision: asRevision(2) });
    expect(
      scheduler.onMessage(
        buildMessage({ message_id: messageId('cancel-t1'), type: 'cancel', task_revision: asRevision(2) }),
      ).result,
    ).toBe('accepted');
    const replay = scheduler.finishRun({ run_id: firstId });

    // 历史轮次不得重复收尾：不改动**别的轮次**的执行槽，也不重新排队。
    expect(replay.accepted).toBe(false);
    const instance = store.snapshot().instances[0];
    expect(instance?.active_run_id).toBe(secondId);
    expect(instance?.activity).toBe('active');
  });
});
