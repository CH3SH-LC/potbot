import { describe, expect, it } from 'vitest';

import { PersistenceError, type InstanceId } from '../protocol/index.js';
import { BudgetLedger } from '../clock/index.js';
import { assertWithinBudget, type DiagnosisBudgetKind } from '../dependency/index.js';
import {
  INSTANCE_C,
  SENDER_S2,
  buildScheduler,
  buildStore,
  countEvents,
  factsOf,
  instanceId,
  registerInstance,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';
import { RunBudgetConfigError } from './errors.js';

/**
 * 停滞检查点（R25.3：**记账归 D03**；R25.4：用 D05 的 `DiagnosisBudget`；
 * R25.1：循环报告的落点是 `failed` + `failure_reason`）。
 *
 * 三条被验证的纪律：
 * 1. 未登记预算 ⇒ 不做有界停止判定（不启动检查点、绝不静默套默认值）；
 * 2. 正常等待（等用户 / 等尚未产出的依赖）⇒ `pause` ⇒ **不写诊断事件、不记台账**
 *    （A05-L-03 / A05-L-06 的反向约束）；
 * 3. 循环 ⇒ `report` ⇒ 写 `diagnosis_performed` 事件 + 记台账 + 环上项落 `failed`。
 */

const LIMITS = Object.freeze({ runs: 6, diagnoses: 4, time: 10_000 });

/** 取异常的**最内层**说明（`Store.transact` 会把事务内异常包成 `PersistenceError`）。 */
function causeMessageOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    const cause = error instanceof PersistenceError ? error.cause : error;
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error('期望抛错，但没有抛');
}

/** 一个最小的台账替身：只统计各维度用量，用于证明 D03 真的记了账。 */
function fakeLedger(): { charge: (k: DiagnosisBudgetKind, a?: number) => number; used: (k: DiagnosisBudgetKind) => number } {
  const usage: Record<DiagnosisBudgetKind, number> = { runs: 0, diagnoses: 0, time: 0 };
  return {
    charge(kind, amount = 1) {
      usage[kind] += amount;
      return usage[kind];
    },
    used(kind) {
      return usage[kind];
    },
  };
}

describe('停滞检查点：未登记预算时不做有界停止判定（A05-01 的前置纪律）', () => {
  it('默认配置：finish_run 返回 stagnation = null，不写任何诊断事件', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store);

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();
    const finish = scheduler.finishRun({
      run_id: 'run-1' as never,
      publications: [
        { kind: 'completed', request_id: requestId('r-1'), result_refs: [resultRef(requestId('r-1'))] },
      ],
    });

    expect(finish.stagnation).toBeNull();
    expect(countEvents(scheduler, 'diagnosis_performed')).toBe(0);
    expect(scheduler.eventCounters().diagnosis_count).toBe(0);
  });
});

describe('停滞检查点：正常等待不是停滞（R8 的反向约束）', () => {
  it('等用户 ⇒ pause：不写诊断事件、不记台账、工作项保持原状', () => {
    const store = buildStore();
    registerInstance(store);
    const ledger = fakeLedger();
    const scheduler = buildScheduler(store, { stagnation: { budget: LIMITS, ledger } });

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();
    const finish = scheduler.finishRun({
      run_id: 'run-1' as never,
      publications: [
        {
          kind: 'processing',
          request_id: requestId('r-1'),
          blocker_reason: { kind: 'waiting_user', detail: '等用户确认人数' },
        },
      ],
    });

    expect(finish.stagnation?.diagnosis.verdict).toBe('waiting');
    expect(finish.stagnation?.diagnosis.disposition).toBe('pause');
    expect(finish.stagnation?.diagnosis_event).toBeNull();
    expect(finish.stagnation?.charged_diagnoses).toBe(0);
    // A05-07：暂停时该实例必须空闲（不得占着执行槽）
    expect(finish.stagnation?.releasable_instance_ids).toEqual([INSTANCE_C]);
    expect(factsOf(scheduler).active_run_ids).toEqual([null]);
    // 诊断次数：事件流与台账都必须是 0（不是"算不出所以记 0"）
    expect(scheduler.eventCounters().diagnosis_count).toBe(0);
    expect(ledger.used('diagnoses')).toBe(0);
    // 正常工作项没被改写
    expect(factsOf(scheduler).work_items[0]?.status).toBe('processing');
  });

  it('受控缺陷接缝被透传：holds_slot_while_waiting ⇒ 不再释放执行槽（A05-07 可被击穿）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store, {
      stagnation: { budget: LIMITS, ledger: fakeLedger(), defects: { holds_slot_while_waiting: true } },
    });

    scheduler.onMessage(workRequest(1));
    scheduler.advanceOnce();
    const finish = scheduler.finishRun({
      run_id: 'run-1' as never,
      publications: [
        {
          kind: 'processing',
          request_id: requestId('r-1'),
          blocker_reason: { kind: 'waiting_user', detail: '等用户确认人数' },
        },
      ],
    });

    expect(finish.stagnation?.diagnosis.disposition).toBe('pause');
    expect(finish.stagnation?.releasable_instance_ids).toEqual([]);
  });
});

describe('停滞检查点：循环依赖 ⇒ 报告（R25.1 的落点 + A05-12）', () => {
  it('互相等待的两项被判环 → 写诊断事件 + 记台账 + 两项落 failed（不得标成已完成）', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerInstance(store, instanceId('B'));
    const ledger = fakeLedger();
    const scheduler = buildScheduler(store, { stagnation: { budget: LIMITS, ledger } });

    const B = instanceId('B');
    const deliver = (message: ReturnType<typeof workRequest>): void => {
      scheduler.onMessage(message);
    };
    deliver(workRequest(1, { recipient_instance_id: INSTANCE_C, sender_instance_id: SENDER_S2 }));
    deliver(workRequest(2, { recipient_instance_id: B, sender_instance_id: SENDER_S2 }));

    // C 的轮次：报告"需要 r-2 的结果"
    const firstC = scheduler.startRun({ instance_id: INSTANCE_C });
    scheduler.finishRun({
      run_id: firstC.run?.run_id ?? ('run-1' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-1'),
          dependency_refs: [{ request_id: requestId('r-2') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-2 的结果' },
        },
      ],
    });

    // B 的轮次：报告"需要 r-1 的结果" → 此时两项互相等待，构成环
    const firstB = scheduler.startRun({ instance_id: B });
    const finishB = scheduler.finishRun({
      run_id: firstB.run?.run_id ?? ('run-2' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-2'),
          dependency_refs: [{ request_id: requestId('r-1') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-1 的结果' },
        },
      ],
    });

    expect(finishB.stagnation?.diagnosis.verdict).toBe('cycle_detected');
    expect(finishB.stagnation?.diagnosis.disposition).toBe('report');
    expect(finishB.stagnation?.diagnosis.cycle_descriptions.length).toBeGreaterThan(0);
    // 记账：事件 1 条、台账 diagnoses +1（R25.3：漏记会让 A05-03 恒真通过）
    expect(finishB.stagnation?.diagnosis_event?.kind).toBe('diagnosis_performed');
    expect(finishB.stagnation?.charged_diagnoses).toBe(1);
    expect(countEvents(scheduler, 'diagnosis_performed')).toBe(1);
    expect(scheduler.eventCounters().diagnosis_count).toBe(1);
    expect(ledger.used('diagnoses')).toBe(1);

    // R25.1 的落点：环上项 → failed + failure_reason（A05-12：不得是"已完成"）
    const items = factsOf(scheduler).work_items;
    expect(items.map((item) => item.status)).toEqual(['failed', 'failed']);
    const raw = store.snapshot().work_items;
    expect(raw.every((item) => item.failure_reason !== null && item.failure_reason.length > 0)).toBe(true);
    expect(raw.every((item) => item.blocker_reason?.kind === 'cycle_detected')).toBe(true);
    expect(items.every((item) => item.result_refs.length === 0)).toBe(true);
    // 停止后不再产生新的可运行输入
    expect([1, 2, 3].map(() => scheduler.advanceOnce()).every((step) => step.startedRuns === 0)).toBe(true);
  });

  it('预算超限优先于环判定 ⇒ budget_exhausted/report，且在收敛点会被断言拦下', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerInstance(store, instanceId('B'));
    const ledger = new BudgetLedger({ runs: 6, diagnoses: 0, time: 10_000 });
    ledger.charge('diagnoses', 1, { label: '预置：已经用掉一次诊断额度' });
    const scheduler = buildScheduler(store, { stagnation: { budget: ledger.limits, ledger } });

    const B = instanceId('B');
    scheduler.onMessage(workRequest(1, { recipient_instance_id: INSTANCE_C }));
    scheduler.onMessage(workRequest(2, { recipient_instance_id: B }));
    const firstC = scheduler.startRun({ instance_id: INSTANCE_C });
    scheduler.finishRun({
      run_id: firstC.run?.run_id ?? ('run-1' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-1'),
          dependency_refs: [{ request_id: requestId('r-2') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-2' },
        },
      ],
    });
    const firstB = scheduler.startRun({ instance_id: B as InstanceId });
    const finishB = scheduler.finishRun({
      run_id: firstB.run?.run_id ?? ('run-2' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-2'),
          dependency_refs: [{ request_id: requestId('r-1') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-1' },
        },
      ],
    });

    expect(finishB.stagnation?.diagnosis.verdict).toBe('budget_exhausted');
    expect(finishB.stagnation?.diagnosis.disposition).toBe('report');
    expect(finishB.stagnation?.diagnosis.budget?.exceeded).toEqual(['diagnoses']);
    // 超限时**不**顺手改工作项（真正的失败原因是超限，不该被环落点掩盖）
    expect(finishB.stagnation?.cycle_stop).toBeNull();
    expect(factsOf(scheduler).work_items.map((item) => item.status)).toEqual([
      'waiting_dependency',
      'waiting_dependency',
    ]);
    // 夹具在收敛判定点会看到超限（A05 的失败判据）
    expect(() => assertWithinBudget(ledger.limits, { diagnoses: ledger.used('diagnoses') })).toThrow(
      /预算超限/,
    );
  });
});

describe('停滞检查点：台账口径', () => {
  it('两次报告 ⇒ 事件 2 条、台账 diagnoses = 2（判定输入的用量来自台账）', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerInstance(store, instanceId('B'));
    const ledger = fakeLedger();
    const scheduler = buildScheduler(store, { stagnation: { budget: LIMITS, ledger } });
    const B = instanceId('B');

    scheduler.onMessage(workRequest(1, { recipient_instance_id: INSTANCE_C }));
    scheduler.onMessage(workRequest(2, { recipient_instance_id: B }));
    const c1 = scheduler.startRun({ instance_id: INSTANCE_C });
    const f1 = scheduler.finishRun({
      run_id: c1.run?.run_id ?? ('run-1' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-1'),
          dependency_refs: [{ request_id: requestId('r-2') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-2' },
        },
      ],
    });
    const b1 = scheduler.startRun({ instance_id: B as InstanceId });
    const f2 = scheduler.finishRun({
      run_id: b1.run?.run_id ?? ('run-2' as never),
      publications: [
        {
          kind: 'waiting_dependency',
          request_id: requestId('r-2'),
          dependency_refs: [{ request_id: requestId('r-1') }],
          blocker_reason: { kind: 'waiting_dependency', detail: '等 r-1' },
        },
      ],
    });

    // 第一次收尾时 B 还有可运行输入 → progress_possible（continue），不记账
    expect(f1.stagnation?.diagnosis.verdict).toBe('progress_possible');
    expect(f1.stagnation?.diagnosis_event).toBeNull();
    expect(f1.stagnation?.usage.diagnoses).toBe(0);
    // 第二次收尾：环 ⇒ 报告 ⇒ 用量由台账读出（0），记完变 1
    expect(f2.stagnation?.diagnosis_event).not.toBeNull();
    expect(f2.stagnation?.usage.diagnoses).toBe(0);
    expect(ledger.used('diagnoses')).toBe(1);
    expect(scheduler.eventCounters().diagnosis_count).toBe(1);
    // 台账与 D05 的预算判定维度一致（R25.4：不另造预算类型）
    // R27.1：`runs` 由**内核在轮次启动处**记账（本场景 C 与 B 各跑一轮 ⇒ 2）
    expect(ledger.used('runs')).toBe(2);
    expect(ledger.used('time')).toBe(0);
  });
});

/**
 * **R34.1（合同 v1.2）**：`R_max` 是**启动前闸门**，不是事后断言。
 *
 * 判据：`used + 1 > limit` ⇒ 拒绝放行（等价 `used >= limit`）。
 * 于是 `R = 0` 启动 0 轮、`R = 1` 只启动 1 轮、一般 `R = N` 不超过 N。
 *
 * **与 v1.1 R30.1 的区别（修复 F08 的核心）**：旧口径用 `used > limit` 判断"能否启动"，
 * 上界因此是 `R_max + 1`——配置 `runs = 1` 时**实际跑 2 轮**，A05-B 还把这当成通过。
 * 诊断侧的"已超限"（`usage > limit`）仍然存在，但**只用于报告**（R34.2），不得复用为启动许可。
 */
describe('轮次预算的内核闸断（R27.1：R_max 由内核强制）', () => {
  /** 造一个"两轮之后还有可运行输入"的场景；返回计时用的句柄。 */
  function twoRunsThenPending(limits: { runs: number; diagnoses: number; time: number }, defects?: { ignore_budget?: boolean }) {
    const store = buildStore();
    registerInstance(store);
    const ledger = new BudgetLedger(limits);
    const scheduler = buildScheduler(store, {
      stagnation: { budget: limits, ledger, ...(defects === undefined ? {} : { defects }) },
    });

    const runOnce = (): string | null => {
      const step = scheduler.advanceOnce();
      const runId = step.run?.run_id ?? null;
      if (runId !== null) {
        scheduler.finishRun({
          run_id: runId as never,
          publications: [
            {
              kind: 'processing',
              request_id: step.claimed_request_ids[0] ?? requestId('r-none'),
              blocker_reason: { kind: 'waiting_external', detail: '本轮未出结局，等待外部条件' },
            },
          ],
        });
      }
      return runId;
    };

    return { store, ledger, scheduler, runOnce };
  }

  it('**启动前闸门**：runs = 1 ⇒ 只启动 1 轮，第 2 次推进即被拒绝（不再有 R_max + 1 的越界轮）', () => {
    // 该断言描述的是 F08 修复**之前**的行为：旧口径用 `used > limit` 判"能否启动"，
    // 于是 runs=1 实际跑 2 轮，A05-B 还把超额轮当成通过。现已翻转为"启动前闸门"。
    const { scheduler, ledger } = twoRunsThenPending({ runs: 1, diagnoses: 4, time: 10_000 });

    scheduler.onMessage(workRequest(1));
    const first = scheduler.advanceOnce();
    expect(first.startedRuns).toBe(1);
    // 记账 = 已提交事件（`run_started`）的幂等投影，在**提交之后**补齐（F06 / R34.3）
    expect(ledger.used('runs')).toBe(1);

    // 第 1 轮结束：usage(1) 未超 limit(1) ⇒ 不报告；仍有可运行输入 ⇒ 至多一次续排
    const finish1 = scheduler.finishRun({
      run_id: first.run?.run_id ?? ('run-1' as never),
      publications: [
        {
          kind: 'processing',
          request_id: requestId('r-1'),
          blocker_reason: { kind: 'waiting_external', detail: '等外部条件' },
        },
      ],
    });
    expect(finish1.stagnation?.diagnosis.verdict).toBe('waiting');
    expect(finish1.stagnation?.diagnosis_event).toBeNull();

    // 第 2 条到达：有可运行输入，但"再启动一轮"会超过 limit=1 ⇒ 内核**不放行**
    scheduler.onMessage(workRequest(2));
    const second = scheduler.advanceOnce();
    expect(second.startedRuns).toBe(0);
    expect(ledger.used('runs')).toBe(1);
    expect(scheduler.eventCounters().run_count).toBe(1);

    const refused = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(refused.started).toBe(false);
    expect(refused.reason).toBe('budget_exhausted');
    expect(refused.run).toBeNull();
  });

  it('R = 0 ⇒ 一轮都不启动（预算为 0 是硬上限，不是"允许一轮"）', () => {
    const { scheduler, ledger } = twoRunsThenPending({ runs: 0, diagnoses: 4, time: 10_000 });
    scheduler.onMessage(workRequest(1));

    expect(scheduler.advanceOnce().startedRuns).toBe(0);
    const refused = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(refused.started).toBe(false);
    expect(refused.reason).toBe('budget_exhausted');
    expect(ledger.used('runs')).toBe(0);
    expect(scheduler.eventCounters().run_count).toBe(0);
    // 输入没被吞掉：消息仍在收件箱，工作项照建
    expect(factsOf(scheduler).unique_inbox_message_ids).toEqual(['m-1']);
    expect(factsOf(scheduler).work_items).toHaveLength(1);
  });

  it('持续投递也不能超限：第 3 条到达，推进仍只返回空（run_count 不再增长）', () => {
    const { scheduler, ledger, runOnce } = twoRunsThenPending({ runs: 1, diagnoses: 4, time: 10_000 });

    scheduler.onMessage(workRequest(1));
    expect(runOnce()).toBe('run-1');
    // 第 2 条：预算已用满 ⇒ 不再放行
    scheduler.onMessage(workRequest(2));
    expect(runOnce()).toBeNull();
    expect(ledger.used('runs')).toBe(1);

    // 第 3 条：仍然拒绝放行；已提交的唯一一轮保留
    scheduler.onMessage(workRequest(3));
    const refused = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(refused.started).toBe(false);
    expect(refused.reason).toBe('budget_exhausted');
    expect(refused.run).toBeNull();
    expect(scheduler.advanceOnce().startedRuns).toBe(0);
    expect(scheduler.eventCounters().run_count).toBe(1);
    expect(ledger.used('runs')).toBe(1);
    // 输入没被吞掉：消息仍在收件箱，工作项照建（"已有成果和未完成原因保留"）
    expect(factsOf(scheduler).unique_inbox_message_ids).toEqual(['m-1', 'm-2', 'm-3']);
    expect(factsOf(scheduler).work_items).toHaveLength(3);
  });

  it('受控缺陷 ignore_budget 同时关闭内核闸断（证明闸断真的在起作用）', () => {
    const { scheduler, ledger, runOnce } = twoRunsThenPending(
      { runs: 1, diagnoses: 4, time: 10_000 },
      { ignore_budget: true },
    );

    scheduler.onMessage(workRequest(1));
    expect(runOnce()).toBe('run-1');
    scheduler.onMessage(workRequest(2));
    expect(runOnce()).toBe('run-2');
    // 缺陷打开：闸断关闭 ⇒ 第 3 轮仍会被放行（这正是缺陷要暴露的"预算永不耗尽"）
    scheduler.onMessage(workRequest(3));
    expect(runOnce()).toBe('run-3');
    expect(scheduler.eventCounters().run_count).toBe(3);
    expect(ledger.used('runs')).toBe(3);
  });

  it('**配了预算却不给台账** ⇒ 抛明确的配置错误，不静默放行（R30.3）', () => {
    const store = buildStore();
    registerInstance(store);
    const limits = { runs: 0, diagnoses: 4, time: 10_000 };
    const scheduler = buildScheduler(store, { stagnation: { budget: limits } }); // 缺 ledger

    scheduler.onMessage(workRequest(1));

    let caught: unknown = null;
    try {
      scheduler.startRun({ instance_id: INSTANCE_C });
    } catch (error) {
      caught = error;
    }
    // 门面在事务内抛错 → 回滚为 PersistenceError（accepted === false），成因可指认
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).accepted).toBe(false);
    const cause = (caught as PersistenceError).cause;
    expect(cause).toBeInstanceOf(RunBudgetConfigError);
    const text = (cause as Error).message;
    expect(text).toMatch(/未注入预算台账/);
    expect(text).toMatch(/BudgetLedger/);
    expect(text).toMatch(/不要\*\*登记 budget|不打算做轮次预算闸断/);

    // 没有"悄悄跑了一轮"，也没有留下任何记录
    expect(scheduler.eventCounters().run_count).toBe(0);
    expect(scheduler.snapshot().runs).toEqual([]);
    expect(scheduler.snapshot().read_receipts).toEqual([]);
    expect(factsOf(scheduler).active_run_ids).toEqual([null]);
    // 推进同样抛错（配置错误必须被看见，不得被吞成空推进）
    expect(causeMessageOf(() => scheduler.advanceOnce())).toMatch(/未注入预算台账/);
  });

  it('完全不配预算 ⇒ 不闸断、不抛错（有意的"无预算运行"边界，保持现状）', () => {
    const store = buildStore();
    registerInstance(store);
    const scheduler = buildScheduler(store); // 完全没有 stagnation 配置

    scheduler.onMessage(workRequest(1));
    const step = scheduler.advanceOnce();

    expect(step.startedRuns).toBe(1);
    expect(step.run).not.toBeNull();
    expect(scheduler.eventCounters().run_count).toBe(1);
  });
});
