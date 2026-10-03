import { describe, expect, it } from 'vitest';

import { WallClockTripwire, WallClockViolationError } from './index.js';

describe('WallClockTripwire：临界区内禁止真实 sleep', () => {
  it('记录模式下，临界区内的 setTimeout / setInterval / setImmediate 都被记下', () => {
    const tripwire = new WallClockTripwire();
    const before = tripwire.mark();
    tripwire.run(
      () => {
        setTimeout(() => {}, 0);
        setImmediate(() => {});
      },
      { throwOnViolation: false },
    );
    const violations = tripwire.violationsFor(before);
    expect(violations.map((violation) => violation.api)).toEqual(['setTimeout', 'setImmediate']);
    expect(tripwire.armed).toBe(false);
  });

  it('抛错模式（默认）：命中即抛，且异常路径也会还原全局', () => {
    const tripwire = new WallClockTripwire();
    const original = globalThis.setTimeout;
    expect(() => tripwire.run(() => setTimeout(() => {}, 0))).toThrow(WallClockViolationError);
    expect(tripwire.armed).toBe(false);
    expect(globalThis.setTimeout).toBe(original);
  });

  it('disarm 后全局原样还原，后续调用不再被记录', () => {
    const tripwire = new WallClockTripwire();
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalSetImmediate = globalThis.setImmediate;

    tripwire.arm({ throwOnViolation: false });
    expect(globalThis.setTimeout).not.toBe(originalSetTimeout);
    tripwire.disarm();

    expect(globalThis.setTimeout).toBe(originalSetTimeout);
    expect(globalThis.setInterval).toBe(originalSetInterval);
    expect(globalThis.setImmediate).toBe(originalSetImmediate);

    const before = tripwire.mark();
    setTimeout(() => {}, 0); // 已 disarm，不应被记录
    expect(tripwire.violationsFor(before)).toEqual([]);
  });

  it('临界区外的墙钟调用不计入（mark 区间语义）', () => {
    const tripwire = new WallClockTripwire();
    const outside = tripwire.mark();
    setTimeout(() => {}, 0);
    tripwire.run(() => {}, { throwOnViolation: true });
    tripwire.run(() => setImmediate(() => {}), { throwOnViolation: false });
    expect(tripwire.violationsFor(outside)).toHaveLength(1);
  });

  it('runAsync 临界区内异步代码的墙钟调用同样被拦截并还原', async () => {
    const tripwire = new WallClockTripwire();
    const original = globalThis.setTimeout;
    const before = tripwire.mark();
    await expect(
      tripwire.runAsync(async () => {
        await Promise.resolve();
        setTimeout(() => {}, 0);
      }),
    ).rejects.toThrow(WallClockViolationError);
    expect(tripwire.violationsFor(before)).toHaveLength(1);
    expect(globalThis.setTimeout).toBe(original);
  });

  it('嵌套 arm 显式抛错（避免补丁还原不干净）', () => {
    const tripwire = new WallClockTripwire();
    tripwire.arm({ throwOnViolation: false });
    expect(() => tripwire.arm()).toThrow(/不支持嵌套/);
    tripwire.disarm();
    expect(tripwire.armed).toBe(false);
  });
});
