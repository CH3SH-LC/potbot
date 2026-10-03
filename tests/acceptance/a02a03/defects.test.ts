/**
 * **受控缺陷注入**（合同 **R7**；验收规格 0.6 与各场景「受控缺陷注入」小节）。
 *
 * 目的只有一个：**证明关键断言真能失败**。「只写可注入、不给出预期变红的那条断言编号」
 * 视为未完成；本文件对每条注入都给出
 * ①注入内容 ②被击穿的断言编号 ③「缺陷下变红 / 移除后变绿」的双向证据。
 *
 * ## 四条注入的实现手段（如实声明，不碰 `src/**`）
 *
 * | 编号 | 注入内容 | 手段 |
 * |---|---|---|
 * | I-A02-2 | 目标实例已有活动轮次或排队标记 ⇒ 入口**静默丢弃**（仍谎报 `accepted`） | **可替换的假投递组件**（0.6 允许）——真实的"入口丢失请求"缺陷 |
 * | I-A02-1 | 事件流里补一条**并发的第二个 `run_started`** | 隔离事件流构造（同 D06 `reproducibility.test.ts` 的手法） |
 * | I-A03-3 | 轮次读过消息即把工作项写成 `completed`、**无结果引用** | 经公开存储接口**绕过状态机**（口径同 R25.2） |
 * | I-A03-2 | 三条后到各自补一条 `delegation_queue_enqueued` | 隔离事件流构造（合并保护活在 `markQueueFlagged()` 的单个事务里，去掉它必须改 `src/**`，冻结点纪律禁止） |
 *
 * 后两条构造的是「该缺陷**会产生的观测量**」而不是缺陷本身——这一点在证据里逐条标明，
 * 以免把"构造出来的病态观测"误读成"内核真的坏了"。
 */

import { describe, expect, it } from 'vitest';

import { PublicationError } from '../../../src/protocol/index.js';
import {
  ConservationViolationError,
  findCompletedWithoutResult,
  requestId,
} from '../../../src/fake/index.js';
import {
  SENDERS,
  ScenarioHarness,
  allProduceResultScript,
  asMessageIds,
  assertAllDeliveriesAccepted,
  assertCompletedHaveMatchingResults,
  assertInboxExactly,
  assertNoEnqueueWhileActive,
  publicationsFromScript,
  writeEvidence,
  type DeliverySpec,
} from './harness.js';

const REQ_MESSAGES = ['m-a02-01', 'm-a02-02', 'm-a02-03', 'm-a02-04'] as const;
const REQ_REQUESTS = ['r-a02-01', 'r-a02-02', 'r-a02-03', 'r-a02-04'] as const;
const TRIGGER_MESSAGE = 'm-a03-00';
const LATE_MESSAGES = ['m-a03-01', 'm-a03-02', 'm-a03-03'] as const;
const LATE_REQUEST_IDS = ['r-a03-01', 'r-a03-02', 'r-a03-03'] as const;

function a02Specs(): readonly DeliverySpec[] {
  return SENDERS.map((sender, i) => ({
    message_id: REQ_MESSAGES[i] as string,
    request_id: REQ_REQUESTS[i] as string,
    sender,
    content: `独立工作 j${i + 1}，期望产物 p${i + 1}`,
  }));
}

describe('R7 受控缺陷注入：证明关键断言真会失败', () => {
  it('I-A02-2「入口丢消息」→ 击穿 A02-04 / A02-05 / A02-06 / A02-07（守恒与归属类）', async () => {
    const h = new ScenarioHarness();

    // 缺陷投递组件：目标实例已有活动轮次或已有排队标记 ⇒ **静默丢弃**并谎报 accepted
    // （这条正好打中 A02-09「不得因已有排队标记而丢弃」与 A02-04 的守恒面）。
    for (const spec of a02Specs()) {
      const request = h.buildDelivery(spec);
      const instance = h.instance();
      if (instance.active_run_id !== null || instance.queued_flag) {
        h.recordDroppedDelivery(request, 'DEFECT I-A02-2: 已有排队标记 ⇒ 静默丢弃（谎报 accepted）');
      } else {
        h.submit(request);
      }
    }

    // ① 缺陷的伪装面：四次投递"都报 accepted"（所以**光看返回值**抓不住它）
    expect(h.delivery_steps.map((step) => step.result)).toEqual([
      'accepted',
      'accepted(dropped)',
      'accepted(dropped)',
      'accepted(dropped)',
    ]);

    // ② 守恒类断言**变红**（===> 这正是 A02-04 不可被轮次计数替代的原因）
    expect(h.uniqueInboxMessageIds().length).toBe(1); // 缺陷行为：只剩 1 条
    expect(() => assertInboxExactly(h.inboxEntries(), asMessageIds(REQ_MESSAGES))).toThrow(
      ConservationViolationError,
    );

    // ③ 跑完整个场景：**计数类断言在该缺陷下仍然是绿的** —— 因此单独看轮次数无法判"不丢请求"
    const first = await h.advance('R1');
    expect(first.startedRuns).toBe(1);
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动唯一一个轮次');
    expect(run1.frozen_input_message_ids.length).toBe(1); // A02-07 归属也红（快照只含 1 条）
    h.finishActiveRun(
      publicationsFromScript(allProduceResultScript(['r-a02-01']), run1.frozen_request_ids),
      '缺陷场景轮末',
    );
    await h.advanceTimes(4, 'R2..R5');

    const obs = h.observe();
    expect(obs.merged.run_count).toBe(1); // ← 缺陷下**依然通过**
    expect(obs.merged.peak_active_runs).toBe(1); // ← 缺陷下**依然通过**
    expect(h.workItems().length).toBe(1); // A02-05 红

    writeEvidence('defect-i-a02-2-drop-at-entry.json', {
      injection: 'I-A02-2',
      target_scenario: 'A02',
      how: '可替换的假投递组件：入口处"已有活动轮次或排队标记 ⇒ 丢弃"，仍返回 accepted',
      broken_assertions: ['A02-04', 'A02-05', 'A02-06', 'A02-07', 'A02-09'],
      falsified_proof: {
        'A02-04 收件箱唯一 message_id 数 = 4': '断言抛 ConservationViolationError（实际 1）',
        'A02-05 工作承诺表唯一 request_id 数 = 4': '断言失败（实际 1）',
        'A02-07 唯一一轮的冻结快照含全部 4 个 message_id': '断言失败（实际 1）',
      },
      teaching_point: '计数类断言（run_count/peak_active_runs）在该缺陷下仍为绿——守恒类断言不可省',
      ...h.evidence(),
    });
  });

  it('I-A02-2b「入口拒绝（诚实失败）」→ 击穿 A02-09（不得因已有运行机会丢弃请求）', async () => {
    const h = new ScenarioHarness();

    // 走 **D01 的官方故障接缝**（`MutableStoreFaultHooks.beforeCommit`，验收规格 0.3 第 6 条）：
    // 只在"消息入口事务 + 目标实例已有活动轮次或排队标记"时令其失败 ⇒ 内核诚实返回 failed。
    // 注意读的是**提交前**的状态（`snapshot()` 读 `this.state`，draft 尚未替换），
    // 因此这里判的正是附录 B 的「目标实例已有活动轮次或已有排队标记」。
    h.store.faults.beforeCommit = (summary) => {
      if (summary.message_ids.length === 0) return; // 只拦消息入口事务，不碰轮次事务
      const instance = h.instance();
      if (instance.active_run_id !== null || instance.queued_flag) {
        throw new Error('DEFECT I-A02-2b: 目标实例已有运行机会 ⇒ 拒绝本条投递');
      }
    };

    for (const spec of a02Specs()) h.deliver(spec);

    // ① 缺陷的行为：第 1 条之后的三条全部返回 failed（"已有排队标记就拒绝"）
    expect(h.delivery_steps.map((step) => step.result)).toEqual(['accepted', 'failed', 'failed', 'failed']);
    expect(h.log.snapshot().failed).toBe(3);

    // ② A02-09 断言**变红**（===> 证明该判据可证伪；仓库里其它断言也同时红）
    expect(() => assertAllDeliveriesAccepted(h.log.snapshot())).toThrow(ConservationViolationError);
    expect(() => assertInboxExactly(h.inboxEntries(), asMessageIds(REQ_MESSAGES))).toThrow(
      ConservationViolationError,
    );

    // ③ 对照：移除注入（同一序列、不武装接缝）→ 判据为真
    const control = new ScenarioHarness();
    for (const spec of a02Specs()) control.deliver(spec);
    expect(control.delivery_steps.map((step) => step.result)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(() => assertAllDeliveriesAccepted(control.log.snapshot())).not.toThrow();

    writeEvidence('defect-i-a02-2b-honest-rejection.json', {
      injection: 'I-A02-2b',
      target_scenario: 'A02',
      how: 'store.faults.beforeCommit（D01 官方故障接缝）：消息入口事务 + 目标实例已有运行机会 ⇒ 令其失败',
      broken_assertions: ['A02-09', 'A02-04'],
      falsified_proof: {
        'A02-09 四次投递全部返回 accepted': '断言抛 ConservationViolationError（实际 accepted=1 / failed=3）',
      },
      control: { delivery_results: ['accepted', 'accepted', 'accepted', 'accepted'] },
      ...h.evidence(),
    });
  });

  it('回归防护（R29.2，「提交后遭遇发布失败」路径）：投递**必须**登记进推进接缝', () => {
    const h = new ScenarioHarness();
    const original = h.store.faults.afterCommitBeforePublish;
    h.store.faults.afterCommitBeforePublish = () => {
      throw new Error('受控中断：事务已提交，但发布前中断');
    };

    const request = h.buildDelivery({
      message_id: 'm-x-01',
      request_id: 'r-x-01',
      sender: 'S1',
      content: '工作 jx',
    });
    let thrown: unknown = null;
    try {
      h.scheduler.onMessage(request.message);
    } catch (error) {
      thrown = error;
    }

    // 两类失败可区分（合同 §九-1）：accepted === true，但事件仍待投递
    expect(thrown).toBeInstanceOf(PublicationError);
    expect((thrown as PublicationError).accepted).toBe(true);
    expect((thrown as PublicationError).undelivered_event_ids.length).toBeGreaterThan(0);
    // 消息已可靠保存（这正是 P2 要防的"落盘但没排"窗口）
    expect(h.snapshot().inbox_entries.length).toBe(1);

    // **R29.2 的回归防护（本条曾经是"记录缺陷"的观察，缺陷已由 D03 修复）**：
    // "发布到执行队列"是**提交之后**的另一件事，因此只要 committed（`accepted === true`），
    // 这次投递就**必须**出现在接缝的登记里，与发布成败无关；且它发生在任何冻结之前（`advanceSeq === 0`），
    // 于是 `assertAllDeliveriesBefore(0)` 这类归属断言在这条路径上不再缺登记。
    // 若哪天登记又丢了（例如有人把登记挪回发布成功之后），本条会立刻变红。
    expect(h.seam.deliveries.length).toBe(1);
    expect(h.seam.deliveries[0]?.message_id).toBe('m-x-01');
    expect(h.seam.deliveries[0]?.advanceSeq).toBe(0);
    // 且登记的是**这次**投递（request_id 一并带上，供 D08 的 P2 归属使用）
    expect(h.seam.deliveries[0]?.request_id).toBe('r-x-01');

    // 恢复路径：补投成功（与登记互不干扰）
    const replayed = h.scheduler.publishPendingEvents();
    expect(replayed.length).toBe(1);
    expect(h.seam.deliveries.length).toBe(1); // 补投不重复登记

    // 按 R20 口径，这条"冻结前到达"的登记参与归属断言
    h.seam.assertAllDeliveriesBefore(0);

    h.store.faults.afterCommitBeforePublish = original;

    writeEvidence('regression-commit-then-publish-failure.json', {
      regression_guard: 'R29.2：committed（accepted === true）的投递必然登记进 SchedulerAdvanceSeam，与发布成败无关',
      formerly_observed_defect:
        'D07 首轮曾观测到「提交成功但发布中断 ⇒ 接缝丢失该次投递登记」（原 OBS-1）；已被采纳为合同 R29.2 并由 D03 修复',
      scope: 'A02/A03 本身未武装故障接缝；本条为回归防护，红即说明登记路径又被挪到发布成功之后',
      verified_by:
        '本用例真实执行：PublicationError.accepted === true、undelivered_event_ids 非空、收件箱 1 条、' +
        'seam.deliveries.length === 1（message_id m-x-01 / request_id r-x-01 / advanceSeq 0）、replay 补投 1 条且登记仍为 1、assertAllDeliveriesBefore(0) 通过',
      ...h.evidence(),
    });
  });

  it('I-A02-1「重复启动」→ 击穿 A02-01 / A02-02 / A02-03（R17 等号断言）', async () => {
    /** 同一序列跑两次：inject=true 时在首轮活动期间补一个并发的第二个 run_started。 */
    const runOnce = async (inject: boolean) => {
      const h = new ScenarioHarness();
      for (const spec of a02Specs()) h.deliver(spec);
      const first = await h.advance('R1');
      expect(first.startedRuns).toBe(1);
      if (inject) {
        h.injectDuplicateRunStarted('run-dup', 'DEFECT I-A02-1: 查-置之间被第二个决策点挤入');
      }
      return { h, obs: h.observe() };
    };

    const control = await runOnce(false);
    // 移除了注入 → 判据为真
    expect(control.obs.merged.run_count).toBe(1);
    expect(control.obs.merged.peak_active_runs).toBe(1);
    expect(control.obs.merged.run_count === 1 && control.obs.merged.peak_active_runs === 1).toBe(true);

    const defective = await runOnce(true);
    // 注入后 → 判据为假（===> 证明 A02 的 R17 等号断言可证伪）
    expect(defective.obs.merged.run_count).toBe(2);
    expect(defective.obs.merged.peak_active_runs).toBe(2);
    expect(defective.obs.merged.run_count === 1 && defective.obs.merged.peak_active_runs === 1).toBe(false);
    // 归属类断言（快照里的 runs）**抓不住**这条缺陷：存储里仍然只有 1 个 RunRecord。
    expect(defective.h.runs().length).toBe(1);

    writeEvidence('defect-i-a02-1-duplicate-run-start.json', {
      injection: 'I-A02-1',
      target_scenario: 'A02',
      how: '隔离事件流构造：首轮活动期间补一条并发 run_started（run-dup）',
      honesty_note:
        '真实内核的 start_run 把「认领排队项 + 冻结 + 置活动」放在同一事务（src/scheduler/runs.ts §九-3），' +
        '故"先查后置"的重复启动**无法经公开接口构造**——这本身是 P1 的结论。本注入构造该缺陷会产生的观测量。',
      broken_assertions: ['A02-01', 'A02-02', 'A02-03'],
      falsified_proof: {
        'A02-01 峰值活动轮次 = 1': '注入后 peak_active_runs = 2 ⇒ 等号断言为假',
        'A02-02 运行轮次数 = 1': '注入后 run_count = 2 ⇒ 等号断言为假',
        'A02-03 run_id 恰好 1 个 / 无第二次「轮次开始」': '注入后 run_started 出现两次',
      },
      control: control.obs.merged,
      defective: defective.obs.merged,
    });
  });

  it('I-A03-3「读即完成」→ 击穿 A03-10（已完成必须带匹配的结果引用）', async () => {
    const h = new ScenarioHarness();
    h.deliver(
      { message_id: TRIGGER_MESSAGE, request_id: 'r-a03-00', sender: 'S0', content: '独立工作 j0' },
      'trigger',
    );
    await h.advance('R1');
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动首轮');

    // 注入：轮次"读过"就把工作项写成 completed、无结果引用
    h.injectReadEqualsDone(requestId('r-a03-00'), 'DEFECT I-A03-3: 读取即完成');

    expect(findCompletedWithoutResult(h.workItems()).map((item) => String(item.request_id))).toEqual([
      'r-a03-00',
    ]);
    expect(() => assertCompletedHaveMatchingResults(h.workItems())).toThrow(ConservationViolationError);

    // 对照（正常路径）：D04 的转换入口**拒绝**"无结果引用的 completed"（R14-2），
    // 因此该病态结果**不可能经正常转换路径产出**——本断言防守的是"绕过状态机的实现回归"（口径同 R25.2）。
    const controlH = new ScenarioHarness();
    controlH.deliver(
      { message_id: TRIGGER_MESSAGE, request_id: 'r-a03-00', sender: 'S0', content: '独立工作 j0' },
      'trigger',
    );
    await controlH.advance('R1');
    const rejected = controlH.finishActiveRun([
      { kind: 'completed', request_id: requestId('r-a03-00'), result_refs: [] },
    ]);
    expect(rejected.accepted).toBe(true); // 轮次收尾本身被接受
    expect(rejected.rejected_publications.map((entry) => String(entry.request_id))).toEqual(['r-a03-00']);
    expect(rejected.applied_request_ids).toEqual([]);
    expect(controlH.workItems()[0]?.status).toBe('processing'); // 未被静默标成已完成
    expect(() => assertCompletedHaveMatchingResults(controlH.workItems())).not.toThrow();

    writeEvidence('defect-i-a03-3-read-equals-done.json', {
      injection: 'I-A03-3',
      target_scenario: 'A03',
      how: '经公开存储接口绕过状态机：把工作项改写成 completed 且 result_refs = []',
      broken_assertions: ['A03-10'],
      falsified_proof: {
        'A03-10 已完成项必须带与其 request_id 匹配的结果引用': '注入后断言抛 ConservationViolationError',
      },
      normal_path_cannot_produce_it: {
        rejected_request_ids: rejected.rejected_publications.map((entry) => String(entry.request_id)),
        remaining_status: controlH.workItems()[0]?.status,
      },
      ...h.evidence(),
    });
  });

  it('I-A03-1「丢消息」→ 击穿 A03-05 / A03-06 / A03-08（守恒类），且轮次数反而"更好看"', async () => {
    const h = new ScenarioHarness();
    h.deliver(
      { message_id: TRIGGER_MESSAGE, request_id: 'r-a03-00', sender: 'S0', content: '独立工作 j0' },
      'trigger',
    );
    const first = await h.advance('R1');
    expect(first.startedRuns).toBe(1);
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动首轮');

    // 缺陷投递组件：**已有活动轮次**时直接丢弃到达消息（不写收件箱），仍谎报 accepted
    const lateSenders = ['S1', 'S2', 'S3'] as const;
    const late = LATE_MESSAGES.map((message_id, i) => {
      const request = h.buildDelivery({
        message_id,
        request_id: LATE_REQUEST_IDS[i] as string,
        sender: lateSenders[i] as string,
        content: `独立工作 j${i + 1}`,
      });
      if (h.instance().active_run_id !== null) {
        return h.recordDroppedDelivery(request, 'DEFECT I-A03-1: 已有活动轮次 ⇒ 直接丢弃（谎报 accepted）');
      }
      return h.submit(request);
    });

    expect(late.map((receipt) => receipt.result)).toEqual(['accepted', 'accepted', 'accepted']);
    // ① 守恒类断言**变红**（===> A03-05 是区分"合并正确"与"丢消息"的主判据）
    expect(h.uniqueInboxMessageIds().length).toBe(1);
    expect(() =>
      assertInboxExactly(h.inboxEntries(), asMessageIds([TRIGGER_MESSAGE, ...LATE_MESSAGES])),
    ).toThrow(ConservationViolationError);

    // ② 跑完：轮次数在缺陷下**反而更"好看"**（1 < 2）——所以"A03-02 轮次 = 2"绝不能单独用
    h.finishActiveRun(
      publicationsFromScript(allProduceResultScript(['r-a03-00']), run1.frozen_request_ids),
      '缺陷场景轮末',
    );
    const obs = h.observe();
    expect(obs.merged.run_count).toBe(1);
    expect(obs.merged.peak_active_runs).toBe(1);
    expect(obs.merged.peak_queued_flags).toBe(1);
    expect(h.workItems().length).toBe(1); // A03-06 红

    writeEvidence('defect-i-a03-1-drop-message.json', {
      injection: 'I-A03-1',
      target_scenario: 'A03',
      how: '可替换的假投递组件：已有活动轮次 ⇒ 丢弃到达消息，仍返回 accepted',
      broken_assertions: ['A03-05', 'A03-06', 'A03-08'],
      teaching_point: '丢消息会让轮次数从 2 变成 1（"更好看"）——故守恒类断言是 A03 不可替代的主判据',
      falsified_proof: {
        'A03-05 收件箱唯一 message_id 数 = 4': '断言抛 ConservationViolationError（实际 1）',
        'A03-06 工作承诺表唯一 request_id 数 = 4': '断言失败（实际 1）',
      },
      counters_under_defect_still_green: {
        run_count: obs.merged.run_count,
        peak_active_runs: obs.merged.peak_active_runs,
        peak_queued_flags: obs.merged.peak_queued_flags,
      },
      ...h.evidence(),
    });
  });

  it('I-A03-2「无保护入队」→ 击穿 A03-03（首轮活动期间入队事件数）', async () => {
    const h = new ScenarioHarness();
    h.deliver(
      { message_id: TRIGGER_MESSAGE, request_id: 'r-a03-00', sender: 'S0', content: '独立工作 j0' },
      'trigger',
    );
    const first = await h.advance('R1');
    expect(first.startedRuns).toBe(1);
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动首轮');

    // 轮次活动期间投递 3 条；缺陷版为每一条**各补一次入队事件**
    const enqueuedBaseline = h.countEvents('delegation_queue_enqueued');
    const lateSenders = ['S1', 'S2', 'S3'] as const;
    LATE_MESSAGES.forEach((message_id, i) => {
      h.deliver(
        {
          message_id,
          request_id: LATE_REQUEST_IDS[i] as string,
          sender: lateSenders[i] as string,
          content: `独立工作 j${i + 1}`,
        },
        'late during run-1',
      );
      h.injectUnauthorizedQueueEnqueue(`DEFECT I-A03-2: 第 ${i + 1} 条各自入队`);
    });
    const enqueuedDuringRun = h.countEvents('delegation_queue_enqueued') - enqueuedBaseline;

    // ① A03-03 的入队计数断言**变红**（===> 主判据）
    expect(enqueuedDuringRun).toBe(3);
    expect(() => assertNoEnqueueWhileActive(enqueuedDuringRun)).toThrow(ConservationViolationError);

    // ② 如实记录一条**抓不住**该缺陷的断言：排队标记是布尔量，三条同一实例的入队
    //    **不会**抬高"同时为真的标记数"峰值。
    h.finishActiveRun(
      publicationsFromScript(allProduceResultScript(['r-a03-00']), run1.frozen_request_ids),
      '缺陷场景轮末',
    );
    const obs = h.observe();
    expect(obs.merged.peak_queued_flags).toBe(1); // 缺陷下**依然通过**（故 A03-03 不能只写 peak）

    writeEvidence('defect-i-a03-2-no-merge-protection.json', {
      injection: 'I-A03-2',
      target_scenario: 'A03',
      how: '隔离事件流构造：三条后到各自补一条 delegation_queue_enqueued',
      honesty_note:
        '合并保护活在 markQueueFlagged() 的单个事务里（src/scheduler/queue.ts），去掉它必须改 src/**（冻结点纪律禁止）。' +
        '本注入构造该缺陷会产生的观测量。',
      broken_assertions: ['A03-03'],
      falsified_proof: {
        'A03-03 首轮活动期间入队事件数 ≤ 1（本验收按等号 0 断言）': '注入后为 3 ⇒ 断言为假',
      },
      assertion_that_does_not_catch_it: {
        'peak_queued_flags = 1': '排队标记是布尔量，同实例重复入队不抬高峰值 ⇒ 缺陷下仍为 1',
      },
      enqueued_during_run: enqueuedDuringRun,
      ...h.evidence(),
    });
  });
});
