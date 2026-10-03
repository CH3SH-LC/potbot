import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRunId,
  createInstanceState,
  type InstanceId,
  type InstanceState,
} from '../protocol/index.js';
import { ActivitySnapshotSampler, SamplerError, windowDelta } from './index.js';

const G1 = asGroupId('G1');
const C = asInstanceId('C');
const D = asInstanceId('D');
const T = (n: number) => asLogicalTime(n);

function state(id: InstanceId, activeRun: string | null, queued: boolean): InstanceState {
  return createInstanceState({
    instance_id: id,
    group_id: G1,
    updated_at: T(0),
    activity: activeRun === null ? 'idle' : 'active',
    active_run_id: activeRun === null ? null : asRunId(activeRun),
    queued_flag: queued,
  });
}

describe('ActivitySnapshotSampler：只读快照的瞬时采样（不做峰值计算）', () => {
  it('从 InstanceState 快照读出该时刻的活动轮次与排队标记', () => {
    const sampler = new ActivitySnapshotSampler();
    const sample = sampler.sampleStates([state(C, 'run-1', true), state(D, null, false)], T(7));
    expect(sample).toEqual({
      index: 1,
      at: 7,
      active_runs: 1,
      queued_flags: 1,
      per_instance: {
        C: { active_runs: 1, queued_flag: true },
        D: { active_runs: 0, queued_flag: false },
      },
    });
    expect(sampler.latest()).toEqual(sample);
    expect(sampler.sampleCount).toBe(1);
  });

  it('逐实例键升序（证据稳定）', () => {
    const sampler = new ActivitySnapshotSampler();
    const sample = sampler.sampleStates([state(D, null, false), state(C, null, false)], T(0));
    expect(Object.keys(sample.per_instance)).toEqual(['C', 'D']);
  });

  it('采样器只读快照：不修改传入的状态', () => {
    const sampler = new ActivitySnapshotSampler();
    const original = [state(C, 'run-1', false)];
    const before = JSON.stringify(original);
    sampler.sampleStates(original, T(0));
    expect(JSON.stringify(original)).toBe(before);
  });

  it('同一实例在快照里出现两次 → 显式抛错（不静默取其一）', () => {
    const sampler = new ActivitySnapshotSampler();
    expect(() => sampler.sampleStates([state(C, 'run-1', false), state(C, null, false)], T(0))).toThrow(
      SamplerError,
    );
    expect(sampler.sampleCount).toBe(0);
  });

  it('byIndex 越界显式抛错', () => {
    const sampler = new ActivitySnapshotSampler();
    sampler.sampleStates([state(C, null, false)], T(0));
    expect(() => sampler.byIndex(2)).toThrow(/没有第 2 次采样/);
  });

  it('reset 清空采样序列', () => {
    const sampler = new ActivitySnapshotSampler();
    sampler.sampleStates([state(C, null, false)], T(0));
    sampler.reset();
    expect(sampler.sampleCount).toBe(0);
    expect(sampler.latest()).toBeNull();
  });
});

describe('等待窗口判据（A05-07 / A05-08：窗口内不增长）', () => {
  it('窗口内两项计数都不增长 → flat 为真（执行槽确实释放了）', () => {
    const sampler = new ActivitySnapshotSampler();
    const opened = sampler.sampleStates([state(C, null, false), state(D, null, false)], T(0));
    sampler.sampleStates([state(C, null, false), state(D, null, false)], T(10));
    const closed = sampler.sampleStates([state(C, null, false), state(D, null, false)], T(20));
    expect(sampler.isFlatBetween(opened.index, closed.index)).toBe(true);
    expect(windowDelta(sampler, opened.index, closed.index)).toEqual({
      from_index: 1,
      to_index: 3,
      active_runs_delta: 0,
      queued_flags_delta: 0,
      flat: true,
    });
  });

  it('窗口内中间采样长出了活动轮次 → flat 为假（空转占槽会被抓住）', () => {
    const sampler = new ActivitySnapshotSampler();
    const opened = sampler.sampleStates([state(C, null, false)], T(0));
    sampler.sampleStates([state(C, 'run-9', false)], T(5));
    const closed = sampler.sampleStates([state(C, null, false)], T(10));
    expect(sampler.isFlatBetween(opened.index, closed.index)).toBe(false);
    expect(windowDelta(sampler, opened.index, closed.index).flat).toBe(false);
  });

  it('窗口内计数下降不算增长（释放执行槽是允许的）', () => {
    const sampler = new ActivitySnapshotSampler();
    const busy = sampler.sampleStates([state(C, 'run-1', true)], T(0));
    const idle = sampler.sampleStates([state(C, null, false)], T(1));
    expect(sampler.isFlatBetween(busy.index, idle.index)).toBe(true);
    expect(windowDelta(sampler, busy.index, idle.index)).toEqual({
      from_index: 1,
      to_index: 2,
      active_runs_delta: -1,
      queued_flags_delta: -1,
      flat: true,
    });
  });

  it('窗口内计数上升判为增长（端点更高）', () => {
    const sampler = new ActivitySnapshotSampler();
    const idle = sampler.sampleStates([state(C, null, false)], T(0));
    const busy = sampler.sampleStates([state(C, 'run-1', false)], T(1));
    expect(sampler.isFlatBetween(idle.index, busy.index)).toBe(false);
    expect(windowDelta(sampler, idle.index, busy.index).active_runs_delta).toBe(1);
  });

  it('区间反了 / 越界 → 显式抛错', () => {
    const sampler = new ActivitySnapshotSampler();
    sampler.sampleStates([state(C, null, false)], T(0));
    expect(() => sampler.isFlatBetween(2, 1)).toThrow(SamplerError);
    expect(() => windowDelta(sampler, 1, 5)).toThrow(SamplerError);
  });
});
