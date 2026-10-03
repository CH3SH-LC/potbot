/**
 * **F09 行为回归**：历史消息保存但不获得运行资格（合同 v1.2 R37.3；`design-01-P3`）。
 *
 * ## 修的是哪一条
 *
 * 修复前：`on_message` 先按 `message.requires_wakeup` 写收件箱条目，**之后**才判 stale 并返回。
 * 于是旧版本消息虽然被标为"仅入库留作历史"，条目上却仍带 `requires_wakeup = true`：
 * `wakingInboxEntries()` 把它算成运行机会，推进后照样起一个"零工作项"的空轮次
 * （实测 rev2 只收到 rev1 请求 → 仍启动 1 轮）。
 *
 * 修复后（R37.3 第 1 条）：陈旧消息一律**安静入库**（`requires_wakeup = false`），
 * 消息本身照常保留（历史不许丢），只是不作为起轮次的理由。
 * **读入 ≠ 运行资格**：它仍会被下一轮合法快照读入，但不为它自己起动一轮。
 *
 * ## 本文件只经公开入口
 *
 * 消息入口（`scheduler.onMessage`）+ 推进接缝（`advance`）+ `finishActiveRun`；
 * 夹具只做前置状态（注册任务版本），**不代做**任何内核步骤。
 */

import { describe, expect, it } from 'vitest';

import { asRevision, asLogicalTime } from '../../../src/protocol/index.js';
import { BudgetLedger } from '../../../src/clock/index.js';
import { messageId, requestId } from '../../../src/fake/index.js';
import {
  ScenarioHarness,
  allProduceResultScript,
  publicationsFromScript,
} from './harness.js';

const M_STALE = 'm-f09-stale';
const R_STALE = 'r-f09-stale';
const M_VALID = 'm-f09-valid';
const R_VALID = 'r-f09-valid';

/** 事件流里"陈旧版本消息被登记为历史"的条数（`message_rejected` + reason 判据）。 */
function staleMessageRejections(h: ScenarioHarness): number {
  return h
    .kernelEvents()
    .filter(
      (event) =>
        event.kind === 'message_rejected' &&
        (event.data as { readonly reason?: unknown }).reason === 'stale_task_revision',
    ).length;
}

describe('F09 历史消息保存但不获得运行资格（design-01-P3 / R37.3）', () => {
  it('仅投递旧版本消息：多次推进零轮次、零新增工作，消息仍保留在收件箱与消息表', async () => {
    const h = new ScenarioHarness();
    // 前置状态：当前任务版本 = 2（旧消息声明版本 1）。
    h.setTaskRevision(asRevision(2));

    const staleRequest = h.buildDelivery({
      message_id: M_STALE,
      request_id: R_STALE,
      sender: 'S1',
      content: '旧版本的工作请求',
      revision: asRevision(1),
    });
    const outcome = h.scheduler.onMessage(staleRequest.message);

    // 消息被接受并留作历史，但**不**构成运行机会。
    expect(outcome.result).toBe('accepted');
    expect(outcome.stale_revision).toBe(true);
    expect(outcome.queued).toBe(false);
    expect(outcome.work_item).toBeNull();
    expect(outcome.inbox_entry?.requires_wakeup).toBe(false);

    // 多次推进：零轮次、零新增工作。
    const advances = await h.advanceTimes(5, 'R1..R5-空推进');
    expect(advances.map((record) => record.startedRuns)).toEqual([0, 0, 0, 0, 0]);
    expect(h.runs().length).toBe(0);
    expect(h.workItems().length).toBe(0);

    // 历史不许丢：收件箱 1 条、消息表 1 条，且 id 就是那条旧消息。
    expect(h.uniqueInboxMessageIds()).toEqual([messageId(M_STALE)]);
    expect(h.snapshot().messages.map((message) => message.message_id)).toEqual([messageId(M_STALE)]);
    // 陈旧登记事件恰好 1 条（如实记录"这条被当作历史"）。
    expect(staleMessageRejections(h)).toBe(1);

    // 实例保持空闲、无排队标记（旧消息没有留下"待跑"的痕迹）。
    expect(h.instance().active_run_id).toBeNull();
    expect(h.instance().queued_flag).toBe(false);
    expect(h.instance().activity).toBe('idle');
  });

  it('活动轮次中收到旧消息 → finish 后不因它新增运行机会', async () => {
    const h = new ScenarioHarness();
    h.setTaskRevision(asRevision(2));

    // 合法新版本消息先启动一轮（对照：新版本仍能启动）。
    const validRequest = h.buildDelivery({
      message_id: M_VALID,
      request_id: R_VALID,
      sender: 'S1',
      content: '新版本的工作请求',
      revision: asRevision(2),
    });
    expect(h.scheduler.onMessage(validRequest.message).result).toBe('accepted');
    await h.advance('R1');
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动首轮');

    // 活动轮次**期间**投递旧消息。
    const staleRequest = h.buildDelivery({
      message_id: M_STALE,
      request_id: R_STALE,
      sender: 'S2',
      content: '活动轮次期间到达的旧版本请求',
      revision: asRevision(1),
    });
    const staleOutcome = h.scheduler.onMessage(staleRequest.message);
    expect(staleOutcome.result).toBe('accepted');
    expect(staleOutcome.stale_revision).toBe(true);
    expect(staleOutcome.queued).toBe(false);

    // 结束本轮：旧消息不得换来一次后续运行机会。
    const finish = h.finishActiveRun(
      publicationsFromScript(allProduceResultScript([R_VALID]), run1.frozen_request_ids),
      'R1 轮末',
    );
    expect(finish.queued_next_run).toBe(false);
    expect(finish.accepted).toBe(true);

    const empties = await h.advanceTimes(3, 'R2..R4-空推进');
    expect(empties.map((record) => record.startedRuns)).toEqual([0, 0, 0]);
    expect(h.runs().length).toBe(1);

    // 旧消息仍在收件箱里（从未被消费，因为从未为它起轮次）。
    expect(h.uniqueInboxMessageIds()).toContain(messageId(M_STALE));
    expect(h.workItems().length).toBe(1); // 只有新版本那一条建了工作项
  });

  it('读入 ≠ 运行资格：合法新版本起轮时，旧消息仍被读入快照却不建工作项', async () => {
    const h = new ScenarioHarness();
    h.setTaskRevision(asRevision(2));

    const staleRequest = h.buildDelivery({
      message_id: M_STALE,
      request_id: R_STALE,
      sender: 'S1',
      content: '旧版本的工作请求',
      revision: asRevision(1),
    });
    h.scheduler.onMessage(staleRequest.message);

    const validRequest = h.buildDelivery({
      message_id: M_VALID,
      request_id: R_VALID,
      sender: 'S2',
      content: '新版本的工作请求',
      revision: asRevision(2),
    });
    expect(h.scheduler.onMessage(validRequest.message).result).toBe('accepted');

    await h.advance('R1');
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('合法新版本消息应启动一轮');

    // 快照读入**全部**未读消息（含陈旧历史）——读入语义不变。
    expect([...run1.frozen_input_message_ids].sort()).toEqual(
      [messageId(M_STALE), messageId(M_VALID)].sort(),
    );
    // 但只有合法新版本那条进入请求集合 / 建立工作项（陈旧消息不得成为有效新工作）。
    expect([...run1.frozen_request_ids]).toEqual([requestId(R_VALID)]);
    expect(h.workItems().map((item) => String(item.request_id))).toEqual([R_VALID]);
  });

  it('预算不因旧消息减少：连续投递旧消息不消耗运行预算，合法新版本仍能启动（R34）', async () => {
    const budget = { runs: 1, diagnoses: 4, time: 10000 };
    const ledger = new BudgetLedger(budget, { registeredAt: asLogicalTime(0) });
    const h = new ScenarioHarness({ stagnation: { budget, ledger } });
    h.setTaskRevision(asRevision(2));

    // 连续投递三条旧消息。
    for (let index = 0; index < 3; index += 1) {
      const request = h.buildDelivery({
        message_id: `m-f09-stale-${String(index)}`,
        request_id: `r-f09-stale-${String(index)}`,
        sender: 'S1',
        content: `旧版本请求 ${String(index)}`,
        revision: asRevision(1),
      });
      expect(h.scheduler.onMessage(request.message).stale_revision).toBe(true);
    }
    await h.advanceTimes(5, 'R1..R5-空推进');

    // 旧消息没有启动任何轮次 ⇒ 预算用量为 0（未被历史消息"偷走"）。
    expect(h.runs().length).toBe(0);
    expect(ledger.used('runs')).toBe(0);

    // 合法新版本仍能启动，且此时才扣一次运行预算（证明预算额度仍在）。
    const validRequest = h.buildDelivery({
      message_id: M_VALID,
      request_id: R_VALID,
      sender: 'S2',
      content: '新版本的工作请求',
      revision: asRevision(2),
    });
    expect(h.scheduler.onMessage(validRequest.message).result).toBe('accepted');
    const step = await h.advance('R1-合法新版本');
    expect(step.startedRuns).toBe(1);
    expect(ledger.used('runs')).toBe(1);
  });
});
