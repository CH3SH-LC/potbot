import { describe, expect, it } from 'vitest';

import { LogicalClock, leaseDeadline } from '../clock/index.js';
import { asLogicalTime, DEFAULT_LEASE_TTL } from '../protocol/index.js';
import { applyVirtualDelay } from './index.js';

const t = (n: number) => asLogicalTime(n);

describe('模拟延迟 = 推进 N 个逻辑时间单位（不用墙钟 sleep）', () => {
  it('延迟按步数推进时钟，并如实记录前后时间', () => {
    const clock = new LogicalClock();
    const applied = applyVirtualDelay(clock, 2, { label: 'run-1 轮内延迟' });
    expect(applied).toEqual({
      steps: 2,
      from: 0,
      to: 2,
      lease_deadline: null,
      lease_expired_before: false,
      lease_expired_after: false,
      crossed_lease_deadline: false,
    });
    expect(clock.now()).toBe(2);
    expect(clock.advances).toHaveLength(1);
  });

  it('0 步是合法的「本轮无延迟」（不推进时钟、不记推进）', () => {
    const clock = new LogicalClock();
    const applied = applyVirtualDelay(clock, 0);
    expect(applied.from).toBe(0);
    expect(applied.to).toBe(0);
    expect(clock.advanceCount).toBe(0);
  });

  it('非法步数显式抛错（不得静默当成 0）', () => {
    const clock = new LogicalClock();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => applyVirtualDelay(clock, bad)).toThrow(RangeError);
    }
    expect(clock.advanceCount).toBe(0);
  });
});

describe('延迟与租约耦合（Q7-a：逻辑时间度量、不自动续租）', () => {
  it('延迟跨过租约截止 → crossed_lease_deadline 为真（P7 迟到发布的构造点）', () => {
    const clock = new LogicalClock();
    const lease = { lease_deadline: leaseDeadline(clock.now(), 5) };
    const applied = applyVirtualDelay(clock, 5, { lease });
    expect(applied.lease_deadline).toBe(5);
    expect(applied.lease_expired_before).toBe(false);
    expect(applied.lease_expired_after).toBe(true);
    expect(applied.crossed_lease_deadline).toBe(true);
    clock.advance(1);
    expect(() => applyVirtualDelay(clock, 1, { lease })).not.toThrow();
    expect(applyVirtualDelay(clock, 1, { lease }).crossed_lease_deadline).toBe(false);
    expect(applyVirtualDelay(clock, 1, { lease }).lease_expired_before).toBe(true);
  });

  it('租约已在推进前过期 → 不算「跨过」，但如实报告已过期', () => {
    const clock = new LogicalClock();
    const lease = { lease_deadline: t(1) };
    clock.advance(10);
    const applied = applyVirtualDelay(clock, 1, { lease });
    expect(applied.lease_expired_before).toBe(true);
    expect(applied.lease_expired_after).toBe(true);
    expect(applied.crossed_lease_deadline).toBe(false);
  });

  it('不自动续租：延迟前后 lease_deadline 恒为原值', () => {
    const clock = new LogicalClock();
    const deadline = leaseDeadline(clock.now(), DEFAULT_LEASE_TTL);
    const lease = { lease_deadline: deadline };
    applyVirtualDelay(clock, 500, { lease });
    applyVirtualDelay(clock, 600, { lease });
    expect(lease.lease_deadline).toBe(deadline);
    expect(clock.now()).toBe(1100);
  });
});
