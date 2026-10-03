/**
 * ROLE-02 群内分身单测（design-06 P3；能力目录 §3）。
 *
 * 核心断言：**只得本任务必要信息**（个人历史一律不可见）、**有限停滞恢复**（额度用尽即上报）、
 * **不是所有业务的串行转发点**（直连拓扑下分身非必经，且可被旁路）。
 */

import { describe, expect, it } from 'vitest';

import { asGroupId, asInstanceId, asLogicalTime, asTaskId } from '../protocol/index.js';
import {
  aggregateQuestions,
  buildForkContext,
  deliverWithoutFork,
  forkIsMandatory,
  makeForkSignal,
  recoverStagnation,
  routeForkMessage,
  type DeliveryEdge,
  type DeliveryTopology,
  type ScopedInfoItem,
} from './index.js';

const T1 = asTaskId('task-1');
const G1 = asGroupId('group-1');
const FORK = asInstanceId('inst-fork');
const A = asInstanceId('inst-a');
const B = asInstanceId('inst-b');
const C = asInstanceId('inst-c');
const AT = asLogicalTime(5);

describe('ROLE-02：只得本任务必要信息', () => {
  const items: ScopedInfoItem[] = [
    { ref: 'fact.budget', scope: 'task', text: '预算 5000' },
    { ref: 'fact.date', scope: 'task', text: '2026-10-05' },
    { ref: 'private.chat-history', scope: 'personal_history', text: '跨任务的全部聊天记录' },
    { ref: 'private.other-task', scope: 'personal_history', text: '别的任务的偏好' },
  ];

  it('白名单内的任务信息保留，范围外的与个人历史被剔除', () => {
    const context = buildForkContext(items, {
      task_id: T1,
      group_id: G1,
      visible_refs: ['fact.budget'], // 只放行一条
    });
    expect(context.items.map((item) => item.ref)).toEqual(['fact.budget']);
    expect(context.excluded_refs).toEqual(['fact.date', 'private.chat-history', 'private.other-task']);
  });

  it('【反向对照】即便把个人历史 ref 写进白名单，也进不来（范围优先于白名单）', () => {
    const context = buildForkContext(items, {
      task_id: T1,
      group_id: G1,
      visible_refs: ['fact.budget', 'private.chat-history', 'private.other-task'],
    });
    expect(context.items.map((item) => item.ref)).toEqual(['fact.budget']);
    for (const item of context.items) {
      expect(item.scope).toBe('task');
    }
  });

  it('剔除是**如实记录**的，不是静默丢弃', () => {
    const context = buildForkContext(items, { task_id: T1, group_id: G1, visible_refs: [] });
    expect(context.items).toEqual([]);
    expect(context.excluded_refs).toHaveLength(items.length);
  });
});

describe('ROLE-02：问题汇总', () => {
  it('同一 question_key 被多个成员提出 ⇒ 汇总成一条，记录提出者与合并次数', () => {
    const questions = aggregateQuestions([
      makeForkSignal({ channel: 'uplink', kind: 'question', from_instance_id: A, task_id: T1, at: asLogicalTime(1), question_key: 'q.budget', text: '预算多少' }),
      makeForkSignal({ channel: 'uplink', kind: 'question', from_instance_id: B, task_id: T1, at: asLogicalTime(2), question_key: 'q.budget', text: '预算金额是多少？' }),
      makeForkSignal({ channel: 'uplink', kind: 'question', from_instance_id: C, task_id: T1, at: asLogicalTime(3), question_key: 'q.date', text: '日期' }),
    ]);
    expect(questions.map((q) => q.question_key)).toEqual(['q.budget', 'q.date']);
    const budget = questions[0];
    if (budget === undefined) throw new Error('unreachable');
    expect([...budget.asked_by]).toEqual([A, B]);
    expect(budget.latest_text).toBe('预算金额是多少？');
    expect(budget.merged_count).toBe(1);
    expect(questions[1]?.merged_count).toBe(0);
  });

  it('【反向对照】非问题类信号不参与汇总', () => {
    const questions = aggregateQuestions([
      makeForkSignal({ channel: 'downlink', kind: 'status', from_instance_id: A, task_id: T1, at: AT, text: '进行中' }),
      makeForkSignal({ channel: 'uplink', kind: 'blocked', from_instance_id: B, task_id: T1, at: AT, text: '缺输入' }),
      makeForkSignal({ channel: 'uplink', kind: 'recovered', from_instance_id: B, task_id: T1, at: AT, text: '已恢复' }),
    ]);
    expect(questions).toEqual([]);
  });

  it('【反向对照】问题缺少 question_key ⇒ 抛错（不得汇总无名问题）', () => {
    expect(() =>
      makeForkSignal({ channel: 'uplink', kind: 'question', from_instance_id: A, task_id: T1, at: AT, text: '?' }),
    ).toThrow();
  });
});

describe('ROLE-02：有限停滞恢复', () => {
  it('无停滞信号 ⇒ no_signal，不消耗额度、不上报', () => {
    const outcome = recoverStagnation({ budget: { max_attempts: 2 }, attempts_used: 0, stagnant: false, action: 'x' });
    expect(outcome.outcome).toBe('no_signal');
    expect(outcome.attempts).toBe(0);
    expect(outcome.escalated).toBe(false);
  });

  it('有信号且额度未用尽 ⇒ recovered，次数 +1、不上报', () => {
    const outcome = recoverStagnation({ budget: { max_attempts: 2 }, attempts_used: 0, stagnant: true, action: '重发缺失输入请求' });
    expect(outcome.outcome).toBe('recovered');
    expect(outcome.attempts).toBe(1);
    expect(outcome.escalated).toBe(false);
  });

  it('额度用尽 ⇒ gave_up 且**必须上报**（有限 ≠ 无限重试）', () => {
    const outcome = recoverStagnation({ budget: { max_attempts: 2 }, attempts_used: 2, stagnant: true, action: 'x' });
    expect(outcome.outcome).toBe('gave_up');
    expect(outcome.escalated).toBe(true);
    expect(outcome.attempts).toBe(2);
  });

  it('【反向对照】"无上限"的预算被拒（不存在无限恢复这条路径）', () => {
    expect(() =>
      recoverStagnation({ budget: { max_attempts: 0 }, attempts_used: 0, stagnant: true, action: 'x' }),
    ).toThrow();
  });
});

describe('ROLE-02：不是所有业务的串行转发点', () => {
  /** 成员之间能直连的拓扑： A ↔ B ↔ C 直连，分身独立存在。 */
  const directTopology: DeliveryTopology = {
    fork_instance_id: FORK,
    edges: [
      { from: A, to: B, via: 'direct' },
      { from: B, to: C, via: 'direct' },
      { from: A, to: FORK, via: 'fork' },
      { from: FORK, to: C, via: 'fork' },
    ],
  };

  /** 星形拓扑：所有投递都必须穿分身（真实缺陷形态）。 */
  const starTopology: DeliveryTopology = {
    fork_instance_id: FORK,
    edges: [
      { from: A, to: FORK, via: 'fork' },
      { from: FORK, to: B, via: 'fork' },
      { from: B, to: FORK, via: 'fork' },
      { from: FORK, to: C, via: 'fork' },
    ],
  };

  it('直连拓扑下：A→C 可**不经分身**送达', () => {
    expect(deliverWithoutFork(directTopology, A, C)).toBe(true);
  });

  it('直连拓扑下：分身**不是**必经单点（所有必需投递都有旁路）', () => {
    const required = [{ from: A, to: B }, { from: B, to: C }, { from: A, to: C }];
    expect(forkIsMandatory(directTopology, required)).toBe(false);
  });

  it('选路**优先直连**：A→C 走 direct，且 fork_required=false', () => {
    const decision = routeForkMessage(directTopology, A, C);
    expect(decision.route).toBe('direct');
    expect(decision.fork_required).toBe(false);
  });

  it('【反向对照】星形拓扑下分身**确实是**必经单点——判据不是恒假', () => {
    const required = [{ from: A, to: B }, { from: A, to: C }];
    expect(forkIsMandatory(starTopology, required)).toBe(true);
    const decision = routeForkMessage(starTopology, A, C);
    expect(decision.route).toBe('via_fork');
    expect(decision.fork_required).toBe(true);
  });

  it('【反向对照】无路可走的投递 ⇒ unreachable（不假装送达）', () => {
    const isolated: DeliveryTopology = { fork_instance_id: FORK, edges: [] as DeliveryEdge[] };
    const decision = routeForkMessage(isolated, A, B);
    expect(decision.route).toBe('unreachable');
    expect(decision.fork_required).toBe(false);
  });
});
