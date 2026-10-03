/**
 * G02 独立验收 —— 取消收尾与所有权判定解耦。
 *
 * 依据：`docs/other/prep/接口合同-冻结v1.3（G01-G05修复批）.md` §2（R43.1–R43.4）、
 * `docs/other/review/DS进度复查与下一步方案-2026-10-02.md` 的 G02 小节。
 *
 * 本文件是 `docs/other/review/freeze4-recheck/ledger.test.ts:24-31`
 * （"BUG observed: revision update plus cancellation cannot settle active run"）的**正向翻写**。
 * 那一版记录的是"修复前"：`rejection_reason='stale_task_revision'`、`run.status='running'`、
 * `active_run_id` 仍指旧轮次（执行槽泄漏，而租约**没有**过期）。本文件断言这些观测都不再成立。
 *
 * ## 纪律
 *
 * - 全部经**公开入口**：`harness.deliver`（=`scheduler.onMessage`）、`scheduler.startRun` /
 *   `finishRun`。夹具只登记任务 / 实例 / 成员，不写工作项、不置排队标记、不改 `TaskRecord`
 *   的版本以外的字段（`setTaskRevision` 是"任务升级"的**真实**构造，P7 既有口径）。
 * - 计数断言一律等号（R17）；事件侧计数取 `summarizeKernelEvents`（R4 的唯一权威实现）。
 * - **不推进逻辑时间**：租约过期的完整回收不在本批范围内，G02 必须靠"取消收尾"而非"等租约过期"关闭。
 */

import { describe, expect, it } from 'vitest';
import {
  asArtifactRef,
  asLogicalTime,
  asRequestId,
  asRevision,
  mergeSchedulingCounters,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  type ArtifactRef,
  type RequestId,
  type RunId,
} from '../../../src/protocol/index.js';
import { INSTANCE_C, P7P8Harness } from './support.js';

const R_1: RequestId = asRequestId('r-1');
const R_2: RequestId = asRequestId('r-2');
const REF_1: ArtifactRef = asArtifactRef('r-1#result');
const REF_2: ArtifactRef = asArtifactRef('r-2#result');

/**
 * 构造 G02 的交叉场景：**rev1 起轮次 → 登记 rev2 → 合法 rev2 取消 → 原轮次仍活着**。
 *
 * 全部经公开入口完成；逻辑时间从不推进（租约始终未过期）。
 */
function cancelAfterRevisionBump(): { readonly h: P7P8Harness; readonly runId: RunId } {
  const h = new P7P8Harness();
  h.registerTask(asRevision(1));
  h.registerInstance(INSTANCE_C);

  const request = h.deliver({ message_id: 'm-1', request_id: 'r-1', requires_wakeup: true });
  expect(request.outcome.result).toBe('accepted');

  const run = h.scheduler.startRun({ instance_id: INSTANCE_C }).run;
  expect(run).not.toBeNull();
  expect(run?.task_revision).toBe(asRevision(1));

  // 任务升级到 rev2（真实改写已注册任务，而不是只传参覆盖）。
  h.setTaskRevision(asRevision(2));

  // 合法取消：消息声明 rev2，与当前任务版本一致。
  const cancel = h.deliver({
    message_id: 'm-cancel-rev2',
    type: 'cancel',
    revision: asRevision(2),
    content: '用户在 rev2 上取消任务',
  });
  expect(cancel.outcome.result).toBe('accepted');
  expect(cancel.outcome.task_control_state?.cancelled).toBe(true);

  return { h, runId: run!.run_id };
}

describe('G02 取消收尾与所有权判定解耦（R43.1–R43.4）', () => {
  it('G02-7 rev1 启动 → rev2 取消 → 原轮次 finish：零结果写入、轮次收尾、本人槽位释放、无后续排队（租约未过期）', () => {
    // 修复前：freeze4-recheck/ledger.test.ts:24-31 —— `evaluateRunOwnership` 以
    // stale_task_revision 早退，取消收尾整段被跳过：run.status 停在 running、
    // instance.activity 停在 active、active_run_id 仍指旧轮次（槽位泄漏，且租约根本没到期）。
    const { h, runId } = cancelAfterRevisionBump();

    const before = h.requireWorkItem(R_1);
    expect(before.status).toBe('processing');
    expect(before.result_refs).toEqual([]);

    const runFinishedBefore = h.countEvents('run_finished');
    const out = h.scheduler.finishRun({
      run_id: runId,
      publications: [{ kind: 'completed', request_id: R_1, result_refs: [REF_1] }],
    });

    expect(out.accepted).toBe(false);
    expect(out.rejection_reason).toBe('task_cancelled');
    expect(out.applied_request_ids).toEqual([]);
    expect(out.queued_next_run).toBe(false);

    // 零结果写入。
    const after = h.requireWorkItem(R_1);
    expect(after.status).toBe(before.status);
    expect(after.status).toBe('processing');
    expect(after.result_refs).toEqual([]);

    // 轮次收尾 + 本人槽位释放 + 不排下一次运行机会。
    const runRow = h.snapshot().runs.find((row) => row.run_id === runId);
    expect(runRow).toBeDefined();
    expect(runRow?.status).toBe('finished');
    expect(h.countEvents('run_finished')).toBe(runFinishedBefore + 1);

    const instance = h.instance();
    expect(instance.activity).toBe('idle');
    expect(instance.active_run_id).toBeNull();
    expect(instance.queued_flag).toBe(false);

    // 租约**没有**过期：本次收尾不是"等租约到点"的结果（逻辑时间一动未动）。
    expect(h.clock.time).toBe(asLogicalTime(0));
    expect(runRow!.lease_deadline).toBeGreaterThan(h.clock.now());
  });

  it('G02-8 历史轮次重复 finish：不重复收尾、不产生第二条 run_finished（事件计数，非返回值）', () => {
    // 修复前：同一场景下第一次 finish 就以 stale 早退（轮次从未收尾）。
    // 修复后第一次收尾；第二次必须只记账一次——`run_finished` 计数**等号**断言。
    const { h, runId } = cancelAfterRevisionBump();

    const first = h.scheduler.finishRun({
      run_id: runId,
      publications: [{ kind: 'completed', request_id: R_1, result_refs: [REF_1] }],
    });
    expect(first.rejection_reason).toBe('task_cancelled');
    expect(h.countEvents('run_finished')).toBe(1);

    const second = h.scheduler.finishRun({
      run_id: runId,
      publications: [{ kind: 'completed', request_id: R_1, result_refs: [REF_1] }],
    });
    expect(second.accepted).toBe(false);
    expect(second.rejection_reason).toBe('task_cancelled');
    expect(second.applied_request_ids).toEqual([]);

    // 收尾事件只有一条；被拒发布各记一次（两次 finish → 两条）。
    expect(h.countEvents('run_finished')).toBe(1);
    expect(h.countEvents('publication_rejected')).toBe(2);

    // 事件流自洽（`summarizeKernelEvents` 对同一 run 的两次 run_finished 会直接抛错）。
    const counters = summarizeKernelEvents(h.kernelEvents());
    expect(counters.run_count).toBe(1);
    expect(counters.rejected_publication_count).toBe(2);

    // 状态依旧是"已收尾 + 零写入"。
    expect(h.requireWorkItem(R_1).status).toBe('processing');
    expect(h.requireWorkItem(R_1).result_refs).toEqual([]);
    expect(h.instance().active_run_id).toBeNull();
    expect(h.instance().activity).toBe('idle');
  });

  it('G02-9 槽位已属于新轮次时，迟到轮次的 finish 绝不清除该槽（R43.3）', () => {
    // 修复前：取消收尾排在所有权早退之后，迟到轮次的 finish 甚至走不到清槽分支；
    // 修复后清槽必须以 `active_run_id === run.run_id` 复核——迟到轮次不得碰新轮次的槽。
    const h = new P7P8Harness();
    h.registerTask(asRevision(1));
    h.registerInstance(INSTANCE_C);

    expect(h.deliver({ message_id: 'm-1', request_id: 'r-1', requires_wakeup: true }).outcome.result).toBe(
      'accepted',
    );
    const run1 = h.scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run1).not.toBeNull();
    expect(h.scheduler.finishRun({ run_id: run1!.run_id }).accepted).toBe(true);
    expect(h.instance().active_run_id).toBeNull();
    expect(h.instance().activity).toBe('idle');

    // 新轮次占用同一个执行槽。
    expect(h.deliver({ message_id: 'm-2', request_id: 'r-2', requires_wakeup: true }).outcome.result).toBe(
      'accepted',
    );
    const run2 = h.scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run2).not.toBeNull();
    expect(run2!.run_id).not.toBe(run1!.run_id);
    expect(h.instance().active_run_id).toBe(run2!.run_id);
    expect(h.instance().activity).toBe('active');

    // 此刻取消任务：迟到轮次（run1，已收尾）的 finish 会走取消分支，但不得清槽。
    const cancel = h.deliver({ message_id: 'm-cancel', type: 'cancel', content: '取消 T1' });
    expect(cancel.outcome.task_control_state?.cancelled).toBe(true);

    const runFinishedBefore = h.countEvents('run_finished');
    const late = h.scheduler.finishRun({
      run_id: run1!.run_id,
      publications: [{ kind: 'completed', request_id: R_1, result_refs: [REF_1] }],
    });
    expect(late.accepted).toBe(false);
    expect(late.rejection_reason).toBe('task_cancelled');
    expect(late.applied_request_ids).toEqual([]);

    // 新轮次的槽位与活动态**原样保留**。
    expect(h.instance().active_run_id).toBe(run2!.run_id);
    expect(h.instance().activity).toBe('active');
    const run2Row = h.snapshot().runs.find((row) => row.run_id === run2!.run_id);
    expect(run2Row?.status).toBe('running');
    // 迟到轮次没有产生新的一次收尾。
    expect(h.countEvents('run_finished')).toBe(runFinishedBefore);

    // 拒因事件**如实记录**"本次没有释放执行槽"（R43.3 的观测落点：
    // 槽位释放以 `active_run_id === run.run_id` 为条件，而不是以"发布被拒"为条件）。
    const rejections = h.kernelEvents().filter((event) => event.kind === 'publication_rejected');
    const lastRejection = rejections[rejections.length - 1];
    expect(lastRejection).toBeDefined();
    expect(lastRejection?.run_id).toBe(run1!.run_id);
    expect(lastRejection?.rejection_reason).toBe('task_cancelled');
    expect(lastRejection?.data['owns_execution_slot']).toBe(false);
  });

  it('G02-10 拒因计数口径：rejected_publication_count 单列且不计入 run_count（等号）', () => {
    // 合同 §7：`evaluateRunOwnership()` 拒因语义与 `rejected_publication_count` 口径不变；
    // R43.4 要求取消收尾的拒因同样落在这条单一通道上，不额外抬高轮次计数。
    const h = new P7P8Harness();
    h.registerTask(asRevision(1));
    h.registerInstance(INSTANCE_C);

    expect(h.deliver({ message_id: 'm-1', request_id: 'r-1', requires_wakeup: true }).outcome.result).toBe(
      'accepted',
    );
    const run1 = h.scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run1).not.toBeNull();
    expect(h.scheduler.finishRun({ run_id: run1!.run_id }).accepted).toBe(true);

    expect(h.deliver({ message_id: 'm-2', request_id: 'r-2', requires_wakeup: true }).outcome.result).toBe(
      'accepted',
    );
    const run2 = h.scheduler.startRun({ instance_id: INSTANCE_C }).run;
    expect(run2).not.toBeNull();

    const cancel = h.deliver({ message_id: 'm-cancel', type: 'cancel', content: '取消 T1' });
    expect(cancel.outcome.task_control_state?.cancelled).toBe(true);

    const out = h.scheduler.finishRun({
      run_id: run2!.run_id,
      publications: [{ kind: 'completed', request_id: R_2, result_refs: [REF_2] }],
    });
    expect(out.accepted).toBe(false);
    expect(out.rejection_reason).toBe('task_cancelled');

    const eventCounters = summarizeKernelEvents(h.kernelEvents());
    const merged = mergeSchedulingCounters(eventCounters, summarizeSnapshotCounters(h.snapshot()));

    // 两次轮次启动 = run_count 2；一次被拒发布 = rejected_publication_count 1（单列）。
    expect(eventCounters.run_count).toBe(2);
    expect(eventCounters.rejected_publication_count).toBe(1);
    expect(merged.run_count).toBe(2);
    expect(merged.rejected_publication_count).toBe(1);
  });
});
