import { describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asTaskId,
  assertInstanceStateInvariants,
} from '../protocol/index.js';
import {
  BASELINE_GROUP_ID,
  BASELINE_INSTANCE_C,
  BASELINE_SENDER_IDS,
  BASELINE_TASK_ID,
  buildWorkItemSeed,
  createScenarioBaseline,
} from './index.js';

describe('场景基线（验收规格 0.2）', () => {
  it('任务 T1 / 版本 r1 / 群组 G1；实例 C 空闲、无活动轮次、无排队标记、收件箱空', () => {
    const baseline = createScenarioBaseline();
    expect(baseline.task_id).toBe('T1');
    expect(baseline.group_id).toBe('G1');
    expect(baseline.task_revision).toBe(1);
    expect(baseline.task_id).toBe(BASELINE_TASK_ID);
    expect(baseline.group_id).toBe(BASELINE_GROUP_ID);
    expect(baseline.instance_c.instance_id).toBe(BASELINE_INSTANCE_C);
    expect(baseline.instance_c.activity).toBe('idle');
    expect(baseline.instance_c.active_run_id).toBeNull();
    expect(baseline.instance_c.queued_flag).toBe(false);
    expect(baseline.instance_c.inbox_message_ids).toEqual([]);
    expect(baseline.instance_c.pending_request_ids).toEqual([]);
    // 建好即自检（D01 的实例不变量）
    expect(() => assertInstanceStateInvariants(baseline.instance_c)).not.toThrow();
  });

  it('默认 4 个发送者 S1…S4（A02 用满 4 个）', () => {
    expect(createScenarioBaseline().sender_ids).toEqual(BASELINE_SENDER_IDS);
    expect(createScenarioBaseline().sender_ids).toEqual(['S1', 'S2', 'S3', 'S4']);
  });

  it('各场景可覆盖任务 / 群组 / 实例 / 发送者（隔离要求：独占任务 ID）', () => {
    const baseline = createScenarioBaseline({
      task_id: asTaskId('TA05'),
      sender_ids: [asInstanceId('S0'), asInstanceId('S1')],
      at: asLogicalTime(3),
    });
    expect(baseline.task_id).toBe('TA05');
    expect(baseline.sender_ids).toEqual(['S0', 'S1']);
    expect(baseline.instance_c.updated_at).toBe(3);
  });
});

describe('前置工作项 fixture（A03 / A05 的「先有 1 项工作」）', () => {
  it('非终态自动补齐等待原因，并通过 D01 的形状自检', () => {
    const item = buildWorkItemSeed({
      request_id: asRequestId('r-a03-00'),
      owner_instance_id: BASELINE_INSTANCE_C,
      task_id: BASELINE_TASK_ID,
      at: asLogicalTime(0),
    });
    expect(item.status).toBe('pending');
    expect(item.blocker_reason).toEqual({
      kind: 'waiting_external',
      detail: '场景前置：尚未轮到本项',
    });
    expect(item.owner_instance_id).toBe('C');
  });

  it('可指定等待依赖并登记等待对象（P4-02 的前置）', () => {
    const item = buildWorkItemSeed({
      request_id: asRequestId('r-p4-01'),
      owner_instance_id: BASELINE_INSTANCE_C,
      task_id: BASELINE_TASK_ID,
      at: asLogicalTime(0),
      status: 'waiting_dependency',
      blocker_reason: { kind: 'waiting_dependency', detail: '等 jx 的结果' },
      dependency_refs: [{ request_id: asRequestId('r-p4-x') }],
    });
    expect(item.status).toBe('waiting_dependency');
    expect(item.dependency_refs).toEqual([{ request_id: 'r-p4-x' }]);
  });

  it('failed 必须带失败原因（由 D01 的 createWorkItem 强制）', () => {
    expect(() =>
      buildWorkItemSeed({
        request_id: asRequestId('r-bad'),
        owner_instance_id: BASELINE_INSTANCE_C,
        task_id: BASELINE_TASK_ID,
        at: asLogicalTime(0),
        status: 'failed',
      }),
    ).toThrow(/failure_reason/);
  });

  it('waiting_dependency 但无依赖项 → 自检拒绝（D01 的 assertWorkItemInvariants）', () => {
    expect(() =>
      buildWorkItemSeed({
        request_id: asRequestId('r-bad-2'),
        owner_instance_id: BASELINE_INSTANCE_C,
        task_id: BASELINE_TASK_ID,
        at: asLogicalTime(0),
        status: 'waiting_dependency',
        blocker_reason: { kind: 'waiting_dependency', detail: '等' },
      }),
    ).toThrow(/必须登记至少一个依赖项/);
  });
});
