/**
 * KRN-11：无进展检测、依赖循环与有限分身诊断；有实际等待就让出资源；
 * 同阻塞无新证据不无限唤醒或重新规划。
 *
 * ## 这个文件要钉死的判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 正常等待（等用户 / 等外部）⇒ 让出资源、不唤醒 | 正例 |
 * | 2 | 有可推进的工作 ⇒ **不**让出资源、可以唤醒 | **对照** |
 * | 3 | 依赖环 ⇒ report + 列出环；普通依赖链 ⇒ **不是**环 | **对照** |
 * | 4 | 阻塞指纹不变且无新证据 ⇒ 判为无进展 | 反例 |
 * | 5 | 同阻塞第二次唤醒 / 重规划 ⇒ 拒；**有**新证据 ⇒ 允 | 反例 + 对照 |
 * | 6 | 有实际等待时请求唤醒 ⇒ 拒（`real_wait`） | 反例 |
 * | 7 | 分身超上限 ⇒ 拒；上限之内 ⇒ 允；同目的不重复 | 反例 + 对照 |
 *
 * 第 2 / 3(后半) / 5(后半) / 7(后半) 条是对照：没有它们，"拒绝"可能只是
 * "什么都不做也拒绝"，判别力无从谈起。
 */

import { describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  type InstanceId,
  type LogicalTime,
  type RequestId,
  type TaskId,
  type WorkItem,
} from '../protocol/index.js';
import { DEFAULT_SCENARIO_LIMITS } from '../dependency/index.js';
import { BudgetLedger } from '../clock/index.js';
import { ProgressMonitor, createProgressMonitor, describeProgress } from './progress-monitor.js';

const TASK = asTaskId('T-1');
const REV = asRevision(1);
const OWNER = asInstanceId('I-1');

function rid(value: string): RequestId {
  return asRequestId(value);
}

interface ItemSpec {
  readonly id: string;
  readonly status?: WorkItem['status'];
  readonly blocker?: WorkItem['blocker_reason'];
  readonly deps?: readonly string[];
}

function item(spec: ItemSpec): WorkItem {
  return createWorkItem({
    request_id: rid(spec.id),
    owner_instance_id: OWNER,
    task_id: TASK,
    task_revision: REV,
    description: spec.id,
    expected_output: '',
    status: spec.status ?? 'pending',
    blocker_reason: spec.blocker ?? { kind: 'other', detail: '默认阻塞' },
    dependency_refs: (spec.deps ?? []).map((dep) => ({ request_id: rid(dep) })),
    created_at: asLogicalTime(0),
  });
}

/**
 * 等外部条件的项（**正常等待**）。
 *
 * 状态用 `pending` 而不是 `waiting_dependency`：后者按 A5 必须登记"在等哪一项依赖"，
 * 而"等外部条件"等的不是一个工作项（那是 `blocker_reason.kind = waiting_external` 的语义）。
 */
function waitingExternal(id: string): WorkItem {
  return item({ id, status: 'pending', blocker: { kind: 'waiting_external', detail: '等外部' } });
}

function monitor(maxForks = 4): ProgressMonitor {
  return createProgressMonitor({
    budget: DEFAULT_SCENARIO_LIMITS,
    ledger: new BudgetLedger(DEFAULT_SCENARIO_LIMITS),
    max_forks: maxForks,
  });
}

// ---------------------------------------------------------------------------
// 1 / 2：让出资源与对照
// ---------------------------------------------------------------------------

describe('KRN-11 有实际等待就让出资源', () => {
  it('正例：等用户 / 等外部 ⇒ release_resources、不唤醒', () => {
    const m = monitor();
    const report = m.observe({
      items: [waitingExternal('ext-1'), waitingExternal('ext-2')],
      now: asLogicalTime(10),
      task_id: TASK,
      task_revision: REV,
    });
    expect(report.verdict).toBe('waiting');
    expect(report.disposition).toBe('pause');
    expect(report.release_resources).toBe(true);
    expect(report.should_wake).toBe(false);
    expect(report.cycles).toHaveLength(0);
    // 让出的实例由 D05 原样给出（不另算一套）。
    expect(report.releasable_instance_ids.length).toBeGreaterThan(0);
  });

  it('对照：有依赖已满足、可推进 ⇒ **不**让出资源、可以唤醒', () => {
    const m = monitor();
    const report = m.observe({
      items: [
        item({ id: 'dep', status: 'completed', blocker: null }),
        item({ id: 'waiter', status: 'waiting_dependency', blocker: { kind: 'waiting_dependency', detail: '等 dep' }, deps: ['dep'] }),
      ],
      now: asLogicalTime(10),
      task_id: TASK,
      task_revision: REV,
    });
    expect(report.verdict).toBe('progress_possible');
    expect(report.disposition).toBe('continue');
    expect(report.release_resources).toBe(false);
    expect(report.should_wake).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3：环与正常依赖链的对照
// ---------------------------------------------------------------------------

describe('KRN-11 依赖循环诊断', () => {
  it('反例：A 等 B、B 等 A ⇒ cycle_detected + report + 环被列出', () => {
    const m = monitor();
    const report = m.observe({
      items: [
        item({ id: 'a', status: 'waiting_dependency', blocker: { kind: 'waiting_dependency', detail: '等 b' }, deps: ['b'] }),
        item({ id: 'b', status: 'waiting_dependency', blocker: { kind: 'waiting_dependency', detail: '等 a' }, deps: ['a'] }),
      ],
      now: asLogicalTime(10),
      task_id: TASK,
      task_revision: REV,
    });
    expect(report.verdict).toBe('cycle_detected');
    expect(report.disposition).toBe('report');
    expect(report.cycles).toHaveLength(1);
    expect(report.cycle_descriptions[0]).toContain('a');
    expect(report.release_resources).toBe(true);
    expect(report.should_wake).toBe(false);
  });

  it('对照：A 等 B、B 正常推进（无环）⇒ 只是正常等待，**不得**报成环', () => {
    const m = monitor();
    const report = m.observe({
      items: [
        item({ id: 'a', status: 'waiting_dependency', blocker: { kind: 'waiting_dependency', detail: '等 b' }, deps: ['b'] }),
        item({ id: 'b', status: 'pending', blocker: { kind: 'other', detail: '还在做' } }),
      ],
      now: asLogicalTime(10),
      task_id: TASK,
      task_revision: REV,
    });
    expect(report.verdict).toBe('waiting');
    expect(report.disposition).toBe('pause');
    expect(report.cycles).toHaveLength(0);
    expect(report.cycle_descriptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4：无进展检测
// ---------------------------------------------------------------------------

describe('KRN-11 无进展检测', () => {
  it('反例：阻塞指纹一字不变且无新证据 ⇒ 判为无进展', () => {
    const m = monitor();
    const items = [waitingExternal('ext-1')];
    const first = m.observe({ items, now: asLogicalTime(10), task_id: TASK, task_revision: REV });
    const second = m.observe({ items, now: asLogicalTime(20), task_id: TASK, task_revision: REV });
    expect(first.fingerprint_key).not.toBeNull();
    expect(second.fingerprint_key).toBe(first.fingerprint_key);
    expect(second.progressed).toBe(false);
    expect(second.repeated_block_without_evidence).toBe(true);
  });

  it('对照：阻塞集合变了 ⇒ 判为有进展（不是"永远说无进展"）', () => {
    const m = monitor();
    const first = m.observe({
      items: [waitingExternal('ext-1')],
      now: asLogicalTime(10),
      task_id: TASK,
      task_revision: REV,
    });
    const second = m.observe({
      items: [waitingExternal('ext-1'), waitingExternal('ext-2')],
      now: asLogicalTime(20),
      task_id: TASK,
      task_revision: REV,
    });
    expect(second.fingerprint_key).not.toBe(first.fingerprint_key);
    expect(second.progressed).toBe(true);
    expect(second.repeated_block_without_evidence).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 / 6：有限唤醒与重规划
// ---------------------------------------------------------------------------

describe('KRN-11 同阻塞无新证据不无限唤醒 / 不无限重新规划', () => {
  it('反例：同一指纹第二次唤醒被拒；有**新证据**后放行一次（对照）', () => {
    const m = monitor();
    const items = [waitingExternal('ext-1')];
    const observation = m.observe({ items, now: asLogicalTime(10), task_id: TASK, task_revision: REV });
    const fingerprint = observation.diagnosis.fingerprint;
    expect(fingerprint).not.toBeNull();

    // 第一次：允许。
    expect(m.requestWake(fingerprint, { at: asLogicalTime(11) }).allowed).toBe(true);
    // 第二次：同指纹无新证据 ⇒ 拒（不无限唤醒）。
    // 拒的理由可能落在两条守卫的任一条上（都在证明"这个动作已经做过了"）：
    // 动作去重（同一动作摘要）或额度已用尽（同周期只给一次）。
    const second = m.requestWake(fingerprint, { at: asLogicalTime(12) });
    expect(second.allowed).toBe(false);
    expect(['duplicate_action', 'already_recovered']).toContain(second.reason);
    // 第三次：仍然拒（不是只拦一次）。
    expect(m.requestWake(fingerprint, { at: asLogicalTime(13) }).allowed).toBe(false);

    // 对照：登记**新证据** ⇒ 开一个新的计费周期，放行一次。
    m.observe({
      items,
      now: asLogicalTime(20),
      task_id: TASK,
      task_revision: REV,
      evidence_ref: 'evidence://new-1',
    });
    expect(m.requestWake(fingerprint, { at: asLogicalTime(21) }).allowed).toBe(true);
    // 新一轮里第二次仍拒。
    expect(m.requestWake(fingerprint, { at: asLogicalTime(22) }).allowed).toBe(false);
  });

  it('重规划与唤醒**共用**同一额度（§九-7 的"一次"是全类一次，不是每类一次）', () => {
    const m = monitor();
    const items = [waitingExternal('ext-1')];
    const observation = m.observe({ items, now: asLogicalTime(10), task_id: TASK, task_revision: REV });
    const fingerprint = observation.diagnosis.fingerprint;

    // 唤醒用掉这一周期唯一的额度 ⇒ 紧随其后的重规划被拒（不是"各算各的"）。
    expect(m.requestWake(fingerprint, { at: asLogicalTime(11) }).allowed).toBe(true);
    const replan = m.requestReplan(fingerprint, { at: asLogicalTime(12) });
    expect(replan.allowed).toBe(false);
    expect(replan.reason).toBe('already_recovered');

    // 对照：新证据开一个新周期 ⇒ 重规划这一次可以来（证明上面拒的是"额度用尽"而非"永远不许重规划"）。
    m.observe({
      items,
      now: asLogicalTime(20),
      task_id: TASK,
      task_revision: REV,
      evidence_ref: 'evidence://new-2',
    });
    expect(m.requestReplan(fingerprint, { at: asLogicalTime(21) }).allowed).toBe(true);
    // 新周期的额度同样只有一个：这一次换唤醒就被拒。
    expect(m.requestWake(fingerprint, { at: asLogicalTime(22) }).allowed).toBe(false);
  });

  it('反例：有实际等待时请求唤醒 / 重规划 ⇒ 拒（real_wait）', () => {
    const m = monitor();
    const observation = m.observe({
      items: [waitingExternal('ext-1')],
      now: asLogicalTime(10),
      task_id: TASK,
      task_revision: REV,
    });
    const fingerprint = observation.diagnosis.fingerprint;
    const wake = m.requestWake(fingerprint, { at: asLogicalTime(11), has_real_wait: true });
    expect(wake.allowed).toBe(false);
    expect(wake.reason).toBe('real_wait');
    expect(m.requestReplan(fingerprint, { at: asLogicalTime(12), has_real_wait: true }).reason).toBe('real_wait');
  });

  it('反例：没有阻塞指纹时不得唤醒（no_blocking）', () => {
    const m = monitor();
    const wake = m.requestWake(null, { at: asLogicalTime(1) });
    expect(wake.allowed).toBe(false);
    expect(wake.reason).toBe('no_blocking');
  });
});

// ---------------------------------------------------------------------------
// 7：有限分身
// ---------------------------------------------------------------------------

describe('KRN-11 有限分身', () => {
  it('反例：超出上限 / 同目的重复 / 目的为空 ⇒ 拒', () => {
    const m = monitor(2);
    expect(m.spawnFork({ purpose: '查资料', at: asLogicalTime(1) }).allowed).toBe(true);
    const duplicate = m.spawnFork({ purpose: '查资料', at: asLogicalTime(2) });
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reason).toBe('duplicate_purpose');
    expect(m.spawnFork({ purpose: '写初稿', at: asLogicalTime(3) }).allowed).toBe(true);

    const overCap = m.spawnFork({ purpose: '复核数字', at: asLogicalTime(4) });
    expect(overCap.allowed).toBe(false);
    expect(overCap.reason).toBe('fork_cap_reached');
    expect(overCap.active_forks).toBe(2);
    expect(overCap.max_forks).toBe(2);

    const empty = m.spawnFork({ purpose: '   ', at: asLogicalTime(5) });
    expect(empty.allowed).toBe(false);
    expect(empty.reason).toBe('purpose_required');
    void empty;
  });

  it('对照：上限之内可开；释放名额后可再开（证明"拒"来自上限而非一律拒）', () => {
    const roomy = monitor(3);
    expect(roomy.spawnFork({ purpose: '甲', at: asLogicalTime(1) }).allowed).toBe(true);
    expect(roomy.spawnFork({ purpose: '乙', at: asLogicalTime(2) }).allowed).toBe(true);
    // 同一目的在上限 3 下仍拒（重复判据独立于上限）。
    expect(roomy.spawnFork({ purpose: '甲', at: asLogicalTime(3) }).reason).toBe('duplicate_purpose');
    const third = roomy.spawnFork({ purpose: '丙', at: asLogicalTime(4) });
    expect(third.allowed).toBe(true);
    // 序号只在实际开分身时递增（被拒的尝试不占号）。
    expect(third.fork?.fork_id).toBe('fork-3');

    const capped = monitor(1);
    const first = capped.spawnFork({ purpose: '甲', at: asLogicalTime(1) });
    const second = capped.spawnFork({ purpose: '乙', at: asLogicalTime(2) });
    expect(first.allowed).toBe(true);
    expect(second.reason).toBe('fork_cap_reached');
    // 释放后名额回来。
    expect(capped.releaseFork(first.fork!.fork_id)).toBe(true);
    expect(capped.spawnFork({ purpose: '乙', at: asLogicalTime(3) }).allowed).toBe(true);
  });

  it('快照如实回报观测次数、活着的分身与上限', () => {
    const m = monitor(3);
    m.observe({ items: [waitingExternal('ext-1')], now: asLogicalTime(1), task_id: TASK, task_revision: REV });
    m.spawnFork({ purpose: '甲', at: asLogicalTime(2) });
    const snapshot = m.snapshot();
    expect(snapshot.observations).toBe(1);
    expect(snapshot.active_forks).toHaveLength(1);
    expect(snapshot.max_forks).toBe(3);
    expect(snapshot.last_fingerprint_key).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 证据可读性
// ---------------------------------------------------------------------------

describe('KRN-11 证据', () => {
  it('describeProgress 输出判决与让出资源事实', () => {
    const m = monitor();
    const report = m.observe({
      items: [waitingExternal('ext-1')],
      now: asLogicalTime(1),
      task_id: TASK,
      task_revision: REV,
    });
    const line = describeProgress(report);
    expect(line).toContain('waiting/pause');
    expect(line).toContain('让出资源=true');
    void (asInstanceId as unknown as InstanceId);
    void (asLogicalTime as unknown as LogicalTime);
    void (asTaskId as unknown as TaskId);
  });
});
