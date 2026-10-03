import { describe, expect, it } from 'vitest';

import { DEFAULT_LEASE_TTL, asLogicalTime, isLeaseExpired } from '../protocol/index.js';
import { LogicalClock, leaseDeadline, leaseRemaining } from './index.js';

const t = (value: number) => asLogicalTime(value);

describe('租约时长算术（引用 protocol 的默认值，不另起常量）', () => {
  it('默认时长就是 protocol 的 DEFAULT_LEASE_TTL 与合同 Q7-a 的 1000', () => {
    expect(DEFAULT_LEASE_TTL).toBe(1000);
    expect(leaseDeadline(t(0))).toBe(1000);
  });

  it('截止时间 = 当前逻辑时间 + 时长；场景可配', () => {
    expect(leaseDeadline(t(250), 10)).toBe(260);
    expect(leaseRemaining(leaseDeadline(t(250), 10), t(255))).toBe(5);
  });

  it('与 protocol 的 isLeaseExpired 判定一致（到期在显式检查时判定）', () => {
    const clock = new LogicalClock();
    const lease = { lease_deadline: leaseDeadline(clock.now(), 5) };
    expect(isLeaseExpired(lease, clock.now())).toBe(false);
    clock.advance(5);
    expect(isLeaseExpired(lease, clock.now())).toBe(true);
    expect(leaseRemaining(lease.lease_deadline, clock.now())).toBe(0);
  });

  it('不自动续租：函数只做算术，不改动任何状态', () => {
    const clock = new LogicalClock();
    const deadline = leaseDeadline(clock.now(), 5);
    clock.advance(50, '远超租约');
    // 截止时间仍是原值；没有任何地方偷偷把它推后。
    expect(deadline).toBe(5);
    expect(isLeaseExpired({ lease_deadline: deadline }, clock.now())).toBe(true);
  });

  it('非法时长显式抛错', () => {
    expect(() => leaseDeadline(t(0), 0)).toThrow(RangeError);
    expect(() => leaseDeadline(t(0), -1)).toThrow(RangeError);
    expect(() => leaseDeadline(t(0), Number.NaN)).toThrow(RangeError);
  });
});
