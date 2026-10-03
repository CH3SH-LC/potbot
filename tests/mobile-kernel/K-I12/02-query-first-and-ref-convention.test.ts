/**
 * K-I12 用例 2 —— 结清**查询优先、绝不假定成功**；`externalIntentRef` 引用约定在写入口钉住。
 *
 * 反例是这里的重点：一个"总是把任务标成 confirmed"的实现必须在这批用例下变红。
 */

import { describe, expect, it } from 'vitest';

import { createTrustedReceipt } from '../../../apps/mobile-kernel/actions/ledger.js';
import {
  acceptingExecutor,
  baseConfirm,
  driveToConsumed,
  driveToSent,
  emptyOrderQuery,
  expectAsyncAuthorizationError,
  expectBridgeError,
  recordingOrderQuery,
  registerTask,
  setupFixture,
  unknownExecutor,
} from './fixtures.js';

describe('K-I12 结清：查询优先，绝不假定成功', () => {
  it('结果未知 + 原单查不到 → 不结清（不得假定成功）', async () => {
    const fixture = setupFixture({ executor: unknownExecutor() }); // send ⇒ state=unknown
    registerTask(fixture);
    const submission = await driveToSent(fixture);
    expect(submission.state).toBe('unknown');

    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    const result = await fixture.bridge.settleExternal('task-1');

    expect(result.queried).toBe(true); // 确实查了原单
    expect(result.settled).toBe(false);
    expect(result.outcome).toBe('still-unknown');
    expect(result.observedState).toBeNull();
    expect(result.submissionState).toBe('unknown');
    // 任务仍处于"外部意图未结清"
    const task = fixture.tasks.getTask('task-1');
    expect(task?.externalObservedState).toBeNull();
    expect(task?.externalIntentRef).toBe(submission.submissionId);
  });

  it('结果未知 + 原单查回 confirmed 真实回执 → 才结清为 confirmed（证据优先于猜测）', async () => {
    // 只有查原单端口给出受控真实回执，桥才可能结清为 confirmed。
    const withReceipt = recordingOrderQuery((request) =>
      createTrustedReceipt({
        actionId: request.actionId,
        provider: 'meituan',
        requestRef: request.requestRef,
        externalId: 'ext-1',
        observedState: 'confirmed',
        observedAt: 1_700_000_001_000,
        evidenceRef: 'evid:fixture-1',
        verificationMode: 'real',
        detail: 'fixture 原单已存在的真实回执',
      }),
    );
    const fixture = setupFixture({ executor: unknownExecutor(), orderQuery: withReceipt });
    registerTask(fixture);
    const submission = await driveToSent(fixture);
    expect(submission.state).toBe('unknown');
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    const countsBefore = fixture.actions.counts();

    const result = await fixture.bridge.settleExternal('task-1');

    expect(result.queried).toBe(true);
    expect(result.settled).toBe(true);
    expect(result.outcome).toBe('settled');
    expect(result.submissionState).toBe('confirmed');
    expect(result.observedState).toBe('confirmed');
    // 结清不新建授权、不新建提交
    expect(fixture.actions.counts()).toEqual(countsBefore);
  });

  it('已占用未发出 → 不代发、不结清（awaiting-send），执行器零调用', async () => {
    const fixture = setupFixture();
    registerTask(fixture);
    const submission = driveToConsumed(fixture); // submitting + sendIntentAt=null
    expect(submission.sendIntentAt).toBeNull();

    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    const result = await fixture.bridge.settleExternal('task-1');

    expect(result.outcome).toBe('awaiting-send');
    expect(result.settled).toBe(false);
    expect(result.queried).toBe(false);
    expect(result.observedState).toBeNull();
    // 关键：桥没有替调用方发出对外动作
    expect(fixture.executor.calls.length).toBe(0);
  });

  it('已发出待回执（submitted）→ 查询但不假定成功；settle 期间不重发', async () => {
    const fixture = setupFixture({ executor: acceptingExecutor() });
    registerTask(fixture);
    const submission = await driveToSent(fixture);
    expect(submission.state).toBe('submitted');
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);

    const sendsBefore = fixture.executor.calls.length;
    const result = await fixture.bridge.settleExternal('task-1');

    expect(result.queried).toBe(true);
    expect(result.settled).toBe(false);
    expect(result.outcome).toBe('still-unknown');
    expect(fixture.executor.calls.length).toBe(sendsBefore); // 重发不可表达
  });

  it('缺原单查询端口：K07 域内拒因原样上抛，不降级成"已结清"', async () => {
    const fixture = setupFixture({ orderQuery: null });
    registerTask(fixture);
    const submission = await driveToSent(fixture); // submitted
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);

    await expectAsyncAuthorizationError(
      () => fixture.bridge.settleExternal('task-1'),
      'missing_order_query_port',
    );
    // 上抛之后任务仍未被结清
    expect(fixture.tasks.getTask('task-1')?.externalObservedState).toBeNull();
  });

  it('桥的写回值永远等于 K07 提交状态（unknown 不得写成 confirmed）', async () => {
    const fixture = setupFixture({ executor: unknownExecutor() });
    registerTask(fixture);
    const submission = await driveToSent(fixture);
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    await fixture.bridge.settleExternal('task-1');

    const task = fixture.tasks.getTask('task-1');
    // 未结清 ⇒ 不能有任何观测状态，尤其不能是 confirmed
    expect(task?.externalObservedState).not.toBe('confirmed');
    expect(task?.externalObservedState).toBeNull();
  });
});

describe('K-I12 externalIntentRef 引用约定（= K07 submissionId）', () => {
  it('begin 引用一条不存在的提交 → unknown_submission（引用解析不出即拒）', () => {
    const fixture = setupFixture();
    registerTask(fixture);
    expectBridgeError(
      () => fixture.bridge.beginExternalIntent('task-1', 'sub:task-1:no-such-action'),
      'unknown_submission',
    );
  });

  it('begin 引用另一个任务的提交 → submission_task_mismatch（跨任务引用被拒）', () => {
    const fixture = setupFixture();
    registerTask(fixture, 'task-a');
    registerTask(fixture, 'task-b');
    // 为 task-b 生成一条提交
    const submissionB = driveToConsumed(fixture, baseConfirm({ taskId: 'task-b', actionId: 'act-b' }));

    expectBridgeError(
      () => fixture.bridge.beginExternalIntent('task-a', submissionB.submissionId),
      'submission_task_mismatch',
    );
    // 被拒之后 task-a 未写入任何引用
    expect(fixture.tasks.getTask('task-a')?.externalIntentRef).toBeNull();
  });

  it('beginFromAction 按 (taskId, actionId) 解析提交并登记引用', () => {
    const fixture = setupFixture();
    registerTask(fixture);
    const submission = driveToConsumed(fixture);

    const begun = fixture.bridge.beginFromAction('task-1', 'act-1');
    expect(begun.externalIntentRef).toBe(submission.submissionId);
  });

  it('beginFromAction 对没有提交的动作 → unknown_submission', () => {
    const fixture = setupFixture();
    registerTask(fixture);
    expectBridgeError(() => fixture.bridge.beginFromAction('task-1', 'act-none'), 'unknown_submission');
  });

  it('begin 对空串引用 → unknown_submission（不得写进任务台账）', () => {
    const fixture = setupFixture();
    registerTask(fixture);
    expectBridgeError(() => fixture.bridge.beginExternalIntent('task-1', '   '), 'unknown_submission');
  });

  it('空原单查询端口（emptyOrderQuery）在 submitted 下保持未结清', async () => {
    const fixture = setupFixture({ orderQuery: emptyOrderQuery() });
    registerTask(fixture);
    const submission = await driveToSent(fixture);
    fixture.bridge.beginExternalIntent('task-1', submission.submissionId);
    const result = await fixture.bridge.settleExternal('task-1');
    expect(result.settled).toBe(false);
    expect(result.outcome).toBe('still-unknown');
  });
});
