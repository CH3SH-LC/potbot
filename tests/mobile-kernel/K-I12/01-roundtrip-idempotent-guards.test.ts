/**
 * K-I12 用例 1 —— 未结清→结清往返 / 重复结清幂等 / 未知任务与无待结清意图的 fail-closed。
 *
 * 这三条是集成请求 #3 的验收核心：桥必须能把任务游标桥到提交账本，且**只**按账本事实结清。
 */

import { describe, expect, it } from 'vitest';

import {
  baseConfirm,
  confirmingOrderQuery,
  driveToConsumed,
  driveToSent,
  expectAsyncBridgeError,
  expectBridgeError,
  realConfirmedReceipt,
  registerTask,
  setupFixture,
} from './fixtures.js';

describe('K-I12 任务↔外部副作用桥：往返与守卫', () => {
  it('未结清 → 已结清往返：begin 写引用，settle 按 K07 真实终态结清', async () => {
    const fixture = setupFixture({ orderQuery: confirmingOrderQuery() });
    registerTask(fixture);
    const submission = await driveToSent(fixture); // accepted ⇒ state=submitted

    // begin：把 K07 submissionId 写进任务游标
    const begun = fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    expect(begun.externalIntentRef).toBe(submission.submissionId);
    expect(begun.externalObservedState).toBeNull();
    expect(fixture.bridge.refOf('task-1')).toBe(submission.submissionId);

    // 查原单返回受控真实回执：submitted → confirmed
    fixture.orderQuery.calls.length; // 记录起点
    const before = fixture.orderQuery.calls.length;
    const result = await fixture.bridge.settleExternal('task-1');
    expect(fixture.orderQuery.calls.length).toBe(before + 1);

    expect(result.settled).toBe(true);
    expect(result.outcome).toBe('settled');
    expect(result.queried).toBe(true);
    expect(result.submissionState).toBe('confirmed');
    expect(result.observedState).toBe('confirmed');
    // 写回任务的是 K07 的真实状态
    expect(result.task.externalObservedState).toBe('confirmed');
    expect(result.task.externalIntentRef).toBe(submission.submissionId);
    // 任务游标视图同步更新
    expect(fixture.tasks.getTask('task-1')?.externalObservedState).toBe('confirmed');
  });

  it('提交已是终态时无需查原单：settle 直接用账本状态', async () => {
    const fixture = setupFixture();
    registerTask(fixture);
    const submission = driveToConsumed(fixture);
    fixture.actions.observe(submission.submissionId, realConfirmedReceipt(submission));

    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    const before = fixture.orderQuery.calls.length;
    const result = await fixture.bridge.settleExternal('task-1');

    expect(result.settled).toBe(true);
    expect(result.queried).toBe(false);
    expect(result.observedState).toBe('confirmed');
    expect(fixture.orderQuery.calls.length).toBe(before); // 终态不查询
  });

  it('重复结清幂等：第二次不改写、不重查、不追加日志', async () => {
    const fixture = setupFixture({ orderQuery: confirmingOrderQuery() });
    registerTask(fixture);
    const submission = await driveToSent(fixture);
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);

    const first = await fixture.bridge.settleExternal('task-1');
    expect(first.settled).toBe(true);
    expect(first.observedState).toBe('confirmed');

    const journalAfterFirst = fixture.tasks.journal().length;
    const seqAfterFirst = fixture.tasks.getTask('task-1')?.lastSeq;
    const queriesAfterFirst = fixture.orderQuery.calls.length;

    const second = await fixture.bridge.settleExternal('task-1');
    expect(second.settled).toBe(true);
    expect(second.outcome).toBe('already-settled');
    expect(second.observedState).toBe('confirmed');
    expect(second.queried).toBe(false);
    expect(second.task.externalObservedState).toBe('confirmed');

    // 幂等：没有第二次结清写入，也没有第二次查原单
    expect(fixture.tasks.journal().length).toBe(journalAfterFirst);
    expect(fixture.tasks.getTask('task-1')?.lastSeq).toBe(seqAfterFirst);
    expect(fixture.orderQuery.calls.length).toBe(queriesAfterFirst);
  });

  it('结清一个不存在的任务：fail-closed 抛 unknown_task，不静默返回', async () => {
    const fixture = setupFixture();
    registerTask(fixture);
    await expectAsyncBridgeError(() => fixture.bridge.settleExternal('ghost'), 'unknown_task');
  });

  it('对不存在的任务发起外部意图：fail-closed 抛 unknown_task', () => {
    const fixture = setupFixture();
    registerTask(fixture);
    const submission = driveToConsumed(fixture);
    expectBridgeError(
      () => fixture.bridge.beginExternalIntent('ghost', submission.submissionId),
      'unknown_task',
    );
  });

  it('没有待结清外部意图的任务：settle 抛 no_pending_external_intent', async () => {
    const fixture = setupFixture();
    registerTask(fixture);
    await expectAsyncBridgeError(() => fixture.bridge.settleExternal('task-1'), 'no_pending_external_intent');
  });

  it('重复发起外部意图：由 K10 台账原样拒绝（illegal_transition），不重包', () => {
    const fixture = setupFixture();
    registerTask(fixture);
    const submission = driveToConsumed(fixture);
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    // 第二次 begin 走 K10 自己的非法迁移判据（LifecycleError，非桥错误）
    let code: string | null = null;
    try {
      fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe('illegal_transition');
  });

  it('baseConfirm 夹具自身绑定 taskId（证明夹具用当前九项绑定）', () => {
    const confirm = baseConfirm();
    expect(confirm.taskId).toBe('task-1');
  });
});
