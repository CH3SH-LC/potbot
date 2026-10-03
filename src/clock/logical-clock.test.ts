import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import { LogicalClock, LogicalClockError } from './index.js';

/** 时间字面量的便捷包装（`LogicalTime` 是品牌化数字）。 */
const t = (value: number) => asLogicalTime(value);

/** 推进微任务队列若干次——不使用任何定时器（本模块全程禁止墙钟）。 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('逻辑时钟：内核只读 now()', () => {
  it('初值为 0，反复读取不改变时间（时钟不自行推进）', () => {
    const clock = new LogicalClock();
    for (let i = 0; i < 10000; i += 1) clock.now();
    expect(clock.now()).toBe(0);
    expect(clock.time).toBe(0);
    expect(clock.reads).toBe(10001);
  });

  it('不依赖墙钟：等待微任务队列不推进逻辑时间', async () => {
    const clock = new LogicalClock();
    await flush(64);
    expect(clock.now()).toBe(0);
    expect(clock.advanceCount).toBe(0);
  });

  it('now() 是纯读：不影响 advanceCount 与 state().time', () => {
    const clock = new LogicalClock(t(5));
    clock.now();
    clock.now();
    expect(clock.state()).toEqual({ time: 5, reads: 2, advances: 0 });
  });

  it('只读视图只暴露 now()，结构上无法推进时间', () => {
    const clock = new LogicalClock(t(3));
    const view = clock.readOnlyView();
    expect(Object.keys(view)).toEqual(['now']);
    expect(view.now()).toBe(3);
    expect(clock.advanceCount).toBe(0);
  });

  it('时间值就是协议层的 LogicalTime（不引入第三套时间类型）', () => {
    const clock = new LogicalClock();
    const now = clock.now();
    // 品牌化类型在运行时即数字：可直接参与算术，也可原样交给内核。
    expect(typeof now).toBe('number');
    expect(now + 1).toBe(1);
  });
});

describe('逻辑时钟：由驱动器显式推进', () => {
  it('advance 累加时间并留下可追踪记录', () => {
    const clock = new LogicalClock();
    clock.advance(10, 'R1');
    clock.advance(5, 'R2');
    expect(clock.now()).toBe(15);
    expect(clock.totalAdvanced).toBe(15);
    expect(clock.advanceCount).toBe(2);
    expect(clock.advances).toEqual([
      { index: 1, from: t(0), to: t(10), delta: 10, label: 'R1' },
      { index: 2, from: t(10), to: t(15), delta: 5, label: 'R2' },
    ]);
  });

  it('advanceTo 推进到绝对时间（不可倒流、不可原地踏步）', () => {
    const clock = new LogicalClock(t(100));
    clock.advanceTo(t(150), 'T_max');
    expect(clock.now()).toBe(150);
    expect(() => clock.advanceTo(t(150))).toThrow(LogicalClockError);
    expect(() => clock.advanceTo(t(120))).toThrow(LogicalClockError);
    expect(clock.now()).toBe(150);
  });

  it('非法推进量显式抛错，且不改变时间', () => {
    const clock = new LogicalClock(t(7));
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
      expect(() => clock.advance(bad)).toThrow(LogicalClockError);
    }
    expect(clock.now()).toBe(7);
    expect(clock.advanceCount).toBe(0);
  });

  it('非法初值显式抛错（负数）', () => {
    expect(() => new LogicalClock(t(-1))).toThrow(LogicalClockError);
  });

  it('错误消息带上下文（验收要能看到失败原因）', () => {
    const clock = new LogicalClock();
    expect(() => clock.advance(-3)).toThrow(/收到 -3/);
    expect(() => clock.advanceTo(t(0))).toThrow(/不可倒流/);
  });
});

describe('逻辑时钟：可复现性', () => {
  it('同一串操作序列 → 完全相同的状态与推进记录', () => {
    const script = (clock: LogicalClock): void => {
      clock.advance(4, 'a');
      clock.now();
      clock.advance(6, 'b');
      clock.advanceTo(t(100), 'c');
      clock.now();
    };
    const a = new LogicalClock(t(1));
    const b = new LogicalClock(t(1));
    script(a);
    script(b);
    expect(a.state()).toEqual(b.state());
    expect(a.advances).toEqual(b.advances);
    expect(a.totalAdvanced).toBe(b.totalAdvanced);
  });
});
