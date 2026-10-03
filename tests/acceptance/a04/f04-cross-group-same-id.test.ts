/**
 * **F04 行为回归**：全链路使用群作用域消息查询（合同 v1.2 R37.1；`design-01-P1 / P2`）。
 *
 * ## 修的是哪一条
 *
 * `message_id` 只在**群内**唯一（Q1-d / R6）：两个群各自投递同一个 `message_id` 是合法的。
 * 修复前快照冻结（`computeFrozenInput`）与任务/版本推断仍走全局 `getMessage()`，
 * 遇到同 id 跨群会抛"查询歧义"，于是两群都起不了轮次（投递都 accepted，实际轮次数为 0）。
 *
 * 修复后全链路改用 `getMessageInGroup(groupId, messageId)`：群身份取自收件箱条目 / 实例。
 *
 * ## 本文件只经公开入口
 *
 * 消息入口（`scheduler.onMessage`）+ 推进（`scheduler.advanceOnce`）+ `scheduler.finishRun`。
 * 夹具只做前置状态（注册实例 / 任务 / 发送成员），不代做任何内核步骤。
 */

import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createTaskRecord,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createScheduler } from '../../../src/scheduler/index.js';
import { artifactRefFor, createDeliveryRequest } from '../../../src/fake/index.js';

const T1 = asTaskId('T1');
const G1 = asGroupId('G1');
const C1 = asInstanceId('C1');
const T2 = asTaskId('T2');
const G2 = asGroupId('G2');
const C2 = asInstanceId('C2');
const S1 = asInstanceId('S1');

/** 两个群**复用**的同一个 message_id（合法：message_id 只在群内唯一）。 */
const SHARED_MESSAGE_ID = asMessageId('m-f04-shared');
const R_G1 = asRequestId('r-f04-g1');
const R_G2 = asRequestId('r-f04-g2');

describe('F04 两群同 message_id 端到端（design-01-P1 / P2；R37.1）', () => {
  it('两群同一 message_id、不同 request_id：各自投递 / 冻结 / 执行 / 完成，无误去重、无跨群混入；同群重试只产生一项工作', () => {
    const clock = new LogicalClock();
    const store = createMemoryStore({ clock: () => clock.now() });
    const at = clock.now();

    store.transact((tx) => {
      tx.putInstance(createInstanceState({ instance_id: C1, group_id: G1, updated_at: at }));
      tx.putInstance(createInstanceState({ instance_id: C2, group_id: G2, updated_at: at }));
      tx.putTask(
        createTaskRecord({
          task_id: T1,
          goal: 'G1 的任务',
          current_group_id: G1,
          revision: asRevision(1),
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putTask(
        createTaskRecord({
          task_id: T2,
          goal: 'G2 的任务',
          current_group_id: G2,
          revision: asRevision(1),
          created_at: at,
          updated_at: at,
        }),
      );
      // R35.5：发送成员按群登记（S1 在两个群里都是合法成员）。
      tx.putGroupMember(createGroupMember({ group_id: G1, instance_id: S1, registered_at: at }));
      tx.putGroupMember(createGroupMember({ group_id: G2, instance_id: S1, registered_at: at }));
    });

    const scheduler = createScheduler(store, {
      idSource: createIdSource({ seed: 'f04-cross-group' }),
      clock: () => clock.now(),
      default_task_id: T1,
    });

    const build = (taskId: typeof T1, groupId: typeof G1, recipient: typeof C1, request: typeof R_G1, content: string) =>
      createDeliveryRequest({
        task_id: taskId,
        group_id: groupId,
        task_revision: asRevision(1),
        message_id: SHARED_MESSAGE_ID,
        sender_instance_id: S1,
        recipient_instance_id: recipient,
        type: 'work_request',
        content,
        request_id: request,
        at: asLogicalTime(0),
      });

    const requestG1 = build(T1, G1, C1, R_G1, 'G1 的工作请求');
    const requestG2 = build(T2, G2, C2, R_G2, 'G2 的工作请求');

    // ── ① 投递：两群都接受，各自建立工作项 ──
    const outcomeG1 = scheduler.onMessage(requestG1.message);
    const outcomeG2 = scheduler.onMessage(requestG2.message);
    expect(outcomeG1.result).toBe('accepted');
    expect(outcomeG2.result).toBe('accepted');

    const afterDelivery = scheduler.snapshot();
    // 同一 message_id 在**两个群**各有一条落库消息（这是合法前提，也是旧实现会歧义的原因）。
    expect(afterDelivery.messages.filter((m) => m.message_id === SHARED_MESSAGE_ID).length).toBe(2);
    expect(
      afterDelivery.work_items.map((item) => `${String(item.task_id)}:${String(item.request_id)}`).sort(),
    ).toEqual([`${String(T1)}:${String(R_G1)}`, `${String(T2)}:${String(R_G2)}`].sort());

    // ── ② 冻结 + 执行：两群各起一轮，快照各读各的群内消息 ──
    const stepG1 = scheduler.advanceOnce({ instance_id: C1 });
    const stepG2 = scheduler.advanceOnce({ instance_id: C2 });
    expect(stepG1.startedRuns).toBe(1);
    expect(stepG2.startedRuns).toBe(1);

    const runG1 = scheduler.snapshot().runs.find((run) => run.instance_id === C1);
    const runG2 = scheduler.snapshot().runs.find((run) => run.instance_id === C2);
    if (runG1 === undefined || runG2 === undefined) throw new Error('两群都应各有一轮（F04 的核心断言）');
    expect(runG1.task_id).toBe(T1);
    expect(runG1.group_id).toBe(G1);
    expect([...runG1.frozen_request_ids]).toEqual([R_G1]);
    expect(runG2.task_id).toBe(T2);
    expect(runG2.group_id).toBe(G2);
    expect([...runG2.frozen_request_ids]).toEqual([R_G2]);

    // ── ③ 完成：各自产出属于自己的结果 ──
    const finishG1 = scheduler.finishRun({
      run_id: runG1.run_id,
      publications: [{ kind: 'completed', request_id: R_G1, result_refs: [artifactRefFor(R_G1)] }],
    });
    const finishG2 = scheduler.finishRun({
      run_id: runG2.run_id,
      publications: [{ kind: 'completed', request_id: R_G2, result_refs: [artifactRefFor(R_G2)] }],
    });
    expect(finishG1.accepted).toBe(true);
    expect(finishG2.accepted).toBe(true);

    const final = scheduler.snapshot();
    expect(final.work_items.length).toBe(2);
    for (const item of final.work_items) {
      expect(item.status).toBe('completed');
      expect(item.result_refs.map(String)).toEqual([`${String(item.request_id)}#result`]);
    }

    // ── ④ 收件箱：两群各 1 条，message_id 相同但属于各自的实例（无跨群混入） ──
    const inboxC1 = final.inbox_entries.filter((entry) => entry.instance_id === C1);
    const inboxC2 = final.inbox_entries.filter((entry) => entry.instance_id === C2);
    expect(inboxC1.map((entry) => String(entry.message_id))).toEqual([String(SHARED_MESSAGE_ID)]);
    expect(inboxC2.map((entry) => String(entry.message_id))).toEqual([String(SHARED_MESSAGE_ID)]);
    expect(inboxC1[0]?.group_id).toBe(G1);
    expect(inboxC2[0]?.group_id).toBe(G2);

    // ── ⑤ 同群重试仍只产生一项工作（F04 通过标准的后半句） ──
    const retry = scheduler.onMessage(requestG1.message);
    expect(retry.result).toBe('duplicate_not_created');
    expect(scheduler.snapshot().work_items.length).toBe(2);
    expect(scheduler.snapshot().messages.length).toBe(2);
  });
});
