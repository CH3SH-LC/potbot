/**
 * KRN-03 公平调度的正反例测试，含**真实并发交错**（Promise 微任务 + 宏任务）。
 *
 * 并发模型的诚实边界：本套件验证的是"交错发生在同步临界区**之间**"时的语义。
 * JS 单线程 ⇒ 临界区内部不可能被抢占；**这不是线程安全，也不是跨进程安全**
 * （真实多进程并发需要持久介质上的乐观并发控制，未在本套件范围内验证）。
 */

import { describe, expect, it } from 'vitest';
import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRunId,
  type InstanceId,
  type LogicalTime,
} from '../protocol/index.js';
import {
  FairScheduler,
  summarizeFairSchedule,
  type BeginRunDecision,
} from './fair-scheduler.js';

const L = (n: number): LogicalTime => asLogicalTime(n);
const GROUP = asGroupId('group-a');
const A = asInstanceId('inst-a');
const B = asInstanceId('inst-b');
const C = asInstanceId('inst-c');

/** 让出微任务（同一次事件循环的后续队列）。 */
const micro = (): Promise<void> => Promise.resolve();
/** 让出宏任务（下一次事件循环）。 */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

function schedulerWithEmptyInstance(id: InstanceId): FairScheduler {
  const scheduler = new FairScheduler();
  scheduler.registerInstance(id, L(0), GROUP);
  return scheduler;
}

describe('KRN-03 判据①：同一实例最多一个活动轮次', () => {
  it('第二个 beginRun 被拒（already_active），且 active_run_id 不被覆盖', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(1) });
    const first = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(2) });
    expect(first.started).toBe(true);

    const second = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-2'), at: L(3) });
    expect(second.started).toBe(false);
    expect(second.rejection).toBe('already_active');
    expect(second.run_id).toBeNull();
    expect(scheduler.get(A)?.active_run_id).toBe(asRunId('run-1'));
    expect(scheduler.invariantViolations()).toEqual([]);
  });

  it('反向对照：未注册实例上的唤醒 / 起轮抛错（不得静默新建实例）', () => {
    const scheduler = new FairScheduler();
    expect(() => scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-x'), at: L(1) })).toThrowError(
      /未注册/,
    );
    expect(() => scheduler.beginRun({ instance_id: A, run_id: asRunId('run-x'), at: L(1) })).toThrowError(/未注册/);
  });

  it('反向对照：没有可运行输入时不起轮（no_runnable_input，空推进不是错误）', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    const decision = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(1) });
    expect(decision.started).toBe(false);
    expect(decision.rejection).toBe('no_runnable_input');
    expect(scheduler.get(A)?.active_run_id).toBeNull();
  });

  it('反向对照：结束一个不存在的轮次抛错', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    expect(() => scheduler.finishRun({ run_id: asRunId('nope'), at: L(1) })).toThrowError(/未知或非活动/);
  });
});

describe('KRN-03 判据②：合并后续唤醒，但保留全部请求', () => {
  it('运行中到达三条唤醒：运行机会被合并，请求三条全留', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-0'), at: L(1) });
    const run = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(2) });
    expect(run.started).toBe(true);

    const decisions = [1, 2, 3].map((n) =>
      scheduler.requestWakeup({
        instance_id: A,
        request_id: asRequestId(`req-${n}`),
        message_ids: [asMessageId(`m-${n}`)],
        at: L(10 + n),
      }),
    );
    // 三条都是"合并"：运行中到达不新增运行机会
    expect(decisions.every((decision) => decision.merged)).toBe(true);
    expect(decisions.every((decision) => decision.queued === false)).toBe(true);
    expect(scheduler.get(A)?.queued).toBe(false);
    // 但请求一条都没丢
    expect(scheduler.allRequestsOf(A)).toHaveLength(4); // req-0 已被本轮认领 + 新到三条
    expect(scheduler.get(A)?.pending_request_ids).toEqual([
      asRequestId('req-1'),
      asRequestId('req-2'),
      asRequestId('req-3'),
    ]);

    // 轮次结束 ⇒ 至多一次新运行机会，且下一轮把三条一起认领
    const finish = scheduler.finishRun({ run_id: asRunId('run-1'), at: L(20) });
    expect(finish.requeued).toBe(true);
    expect(scheduler.get(A)?.queued).toBe(true);
    expect(scheduler.get(A)?.queued_since).toBe(L(20));

    const next = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-2'), at: L(21) });
    expect(next.frozen_request_ids).toEqual([
      asRequestId('req-1'),
      asRequestId('req-2'),
      asRequestId('req-3'),
    ]);
  });

  it('反向对照：空闲到达会置（至多一个）排队标记；重复置位不再入队', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    const first = scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(1) });
    expect(first.queued).toBe(true);
    expect(first.merged).toBe(false);
    const second = scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-2'), at: L(2) });
    expect(second.queued).toBe(false);
    expect(second.merged).toBe(true);
    // 排队标记只有一个：queued_since 保持首次置位时刻（§9.1 的"最多一个"）
    expect(scheduler.get(A)?.queued_since).toBe(L(1));
    expect(scheduler.get(A)?.pending_request_ids).toHaveLength(2);
  });

  it('反向对照：同一 request_id 重复到达不重复记账（幂等）', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(1) });
    const again = scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(2) });
    expect(again.duplicate).toBe(true);
    expect(scheduler.allRequestsOf(A)).toEqual([asRequestId('req-1')]);
  });
});

describe('KRN-03 判据③：快照边界（冻结后到达的不属于本轮）', () => {
  it('冻结之后到达的消息只可能进下一轮', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({
      instance_id: A,
      request_id: asRequestId('req-1'),
      message_ids: [asMessageId('m-before')],
      at: L(1),
    });
    const run1 = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(2) });
    expect(run1.frozen_message_ids).toEqual([asMessageId('m-before')]);

    // 冻结之后到达
    scheduler.requestWakeup({
      instance_id: A,
      request_id: asRequestId('req-2'),
      message_ids: [asMessageId('m-after')],
      at: L(3),
    });
    // 本轮快照**不含**后到消息（边界成立的直接证据）
    expect(scheduler.get(A)?.frozen_message_ids).toEqual([asMessageId('m-before')]);
    expect(scheduler.get(A)?.frozen_message_ids).not.toContain(asMessageId('m-after'));

    scheduler.finishRun({ run_id: asRunId('run-1'), at: L(4) });
    const run2 = scheduler.beginRun({ instance_id: A, run_id: asRunId('run-2'), at: L(5) });
    expect(run2.frozen_message_ids).toEqual([asMessageId('m-after')]);
    // 已被上一轮快照读入的消息不会重复进入后续快照
    expect(run2.frozen_message_ids).not.toContain(asMessageId('m-before'));
    expect(scheduler.get(A)?.snapshotted_message_ids).toEqual([
      asMessageId('m-before'),
      asMessageId('m-after'),
    ]);
  });

  it('反向对照：轮次结束后若再无输入，不再置排队标记（不是"永远排队"）', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(1) });
    scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(2) });
    const finish = scheduler.finishRun({ run_id: asRunId('run-1'), at: L(3) });
    expect(finish.requeued).toBe(false);
    expect(scheduler.get(A)?.queued).toBe(false);
    expect(scheduler.selectRunnableInstances()).toEqual([]);
  });
});

describe('KRN-03 判据④：公平调度（等待最久优先，不饿死）', () => {
  it('三个实例都在排队 ⇒ 按 queued_since 升序选出，每个都出现', () => {
    const scheduler = new FairScheduler();
    for (const id of [A, B, C]) scheduler.registerInstance(id, L(0), GROUP);
    scheduler.requestWakeup({ instance_id: C, request_id: asRequestId('req-c'), at: L(3) });
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-a'), at: L(1) });
    scheduler.requestWakeup({ instance_id: B, request_id: asRequestId('req-b'), at: L(2) });

    expect(scheduler.selectRunnableInstances()).toEqual([A, B, C]);
    expect(scheduler.nextRunCandidate()).toBe(A);

    // 依次服务 ⇒ 三轮之内三个实例都被服务到（无饿死）
    const served: InstanceId[] = [];
    for (let round = 0; round < 3; round += 1) {
      const candidate = scheduler.nextRunCandidate();
      if (candidate === null) break;
      served.push(candidate);
      scheduler.beginRun({ instance_id: candidate, run_id: asRunId(`run-${round}`), at: L(10 + round) });
      scheduler.finishRun({ run_id: asRunId(`run-${round}`), at: L(11 + round) });
    }
    expect(new Set(served)).toEqual(new Set([A, B, C]));
  });

  it('反向对照：等待更久的实例不会被后来的实例抢先', () => {
    const scheduler = new FairScheduler();
    for (const id of [A, B]) scheduler.registerInstance(id, L(0), GROUP);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-a'), at: L(5) });
    scheduler.requestWakeup({ instance_id: B, request_id: asRequestId('req-b'), at: L(1) });
    // B 等得更久 ⇒ 先选 B（"先进先出"而不是"按键名"或"按注册序"）
    expect(scheduler.nextRunCandidate()).toBe(B);
  });

  it('反向对照：有活动轮次的实例不参与公平选择（不重复调度）', () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(1) });
    scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(2) });
    expect(scheduler.selectRunnableInstances()).toEqual([]);
    expect(scheduler.nextRunCandidate()).toBeNull();
  });
});

describe('KRN-03 判据⑤：真实并发交错（Promise 驱动）', () => {
  it('两路并发 beginRun：只有一个启动成功，另一个 already_active', async () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-a'), at: L(1) });

    const results: BeginRunDecision[] = [];
    const producer1 = (async () => {
      await micro();
      results.push(scheduler.beginRun({ instance_id: A, run_id: asRunId('run-a'), at: L(2) }));
    })();
    const producer2 = (async () => {
      await tick();
      results.push(scheduler.beginRun({ instance_id: A, run_id: asRunId('run-b'), at: L(3) }));
    })();
    await Promise.all([producer1, producer2]);

    expect(results.filter((decision) => decision.started)).toHaveLength(1);
    expect(results.filter((decision) => decision.rejection === 'already_active')).toHaveLength(1);
    const started = results.find((decision) => decision.started);
    expect(scheduler.activeRuns()[A]).toBe(started?.run_id);
    expect(scheduler.invariantViolations()).toEqual([]);
  });

  it('五个生产者交错唤醒 + 起轮：请求一条不丢，且每个交错点自检均无违规', async () => {
    const scheduler = schedulerWithEmptyInstance(A);
    const violationsSeen: string[] = [];
    const observe = (): void => {
      for (const violation of scheduler.invariantViolations()) {
        violationsSeen.push(violation);
      }
    };

    const producers = [1, 2, 3, 4, 5].map(async (n) => {
      for (let k = 0; k < 3; k += 1) {
        // 轮流让出微任务 / 宏任务，制造多种交错次序
        await (k % 2 === 0 ? micro() : tick());
        const at = L(n * 10 + k);
        scheduler.requestWakeup({
          instance_id: A,
          request_id: asRequestId(`req-${n}-${k}`),
          message_ids: [asMessageId(`m-${n}-${k}`)],
          at,
        });
        observe();
        const runId = asRunId(`run-${n}-${k}`);
        const decision = scheduler.beginRun({ instance_id: A, run_id: runId, at: L(at + 1) });
        observe();
        if (decision.started) {
          scheduler.finishRun({ run_id: runId, at: L(at + 2) });
        }
        observe();
      }
    });
    await Promise.all(producers);

    // 交错过程中没有任何一次自检变红
    expect(violationsSeen).toEqual([]);
    // 15 条请求一条不丢、也没有重复
    const requests = scheduler.allRequestsOf(A);
    expect(requests).toHaveLength(15);
    expect(new Set(requests).size).toBe(15);
    // 结束时：没有活动轮次残留，且不变量自检干净
    expect(scheduler.activeRuns()[A]).toBeUndefined();
    expect(scheduler.invariantViolations()).toEqual([]);
    const summary = summarizeFairSchedule(scheduler);
    expect(summary.total_pending_requests + summary.total_handled_requests).toBe(15);
  });

  it('反向对照：同一个 run_id 被两路并发结束时只有先到者成功（后到者抛错）', async () => {
    const scheduler = schedulerWithEmptyInstance(A);
    scheduler.requestWakeup({ instance_id: A, request_id: asRequestId('req-1'), at: L(1) });
    scheduler.beginRun({ instance_id: A, run_id: asRunId('run-1'), at: L(2) });

    const outcomes: string[] = [];
    const finisher = async (delay: Promise<void>, label: string): Promise<void> => {
      await delay;
      try {
        scheduler.finishRun({ run_id: asRunId('run-1'), at: L(3) });
        outcomes.push(`${label}:ok`);
      } catch {
        outcomes.push(`${label}:threw`);
      }
    };
    await Promise.all([finisher(micro(), 'a'), finisher(tick(), 'b')]);

    expect(outcomes.filter((entry) => entry.endsWith(':ok'))).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.endsWith(':threw'))).toHaveLength(1);
    expect(scheduler.get(A)?.active_run_id).toBeNull();
  });
});
