import { describe, expect, it } from 'vitest';

import { LogicalClock } from '../clock/index.js';
import {
  FaultInjectionMisuseError,
  FaultInjector,
  Gate,
  INJECTION_POINTS,
  InjectedFailure,
  InjectedInterrupt,
} from './index.js';

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const W1 = INJECTION_POINTS.schedulingEventPersist;
const W2 = INJECTION_POINTS.messagePersist;
const W3 = INJECTION_POINTS.executionEnqueue;

describe('故障注入：默认关闭', () => {
  it('未配置时 trip() 是空操作，不抛错、不记账', async () => {
    const injector = new FaultInjector();
    expect(injector.enabled).toBe(false);
    await expect(injector.trip(W1)).resolves.toBeUndefined();
    await expect(injector.trip('随便什么点')).resolves.toBeUndefined();
    expect(injector.firedCount).toBe(0);
  });

  it('未配置就登记规则 → 显式抛错（避免「以为注入了其实没注入」的假绿）', () => {
    const injector = new FaultInjector();
    expect(() => injector.register({ point: W1, behavior: 'interrupt' })).toThrow(
      FaultInjectionMisuseError,
    );
    expect(() => injector.register({ point: W1, behavior: 'interrupt' })).toThrow(/默认关闭/);
  });

  it('没有 isolated: true 就启用 → 显式抛错', () => {
    expect(() => new FaultInjector({ isolated: false })).toThrow(FaultInjectionMisuseError);
    const injector = new FaultInjector();
    expect(() => injector.configure({ isolated: false })).toThrow(/隔离测试配置/);
    expect(injector.enabled).toBe(false);
  });
});

describe('故障注入：仅在隔离配置启用后可注入', () => {
  it('fail（P2 的 W2：持久化失败）抛出 InjectedFailure 并记录点号', async () => {
    const clock = new LogicalClock();
    const injector = new FaultInjector({ isolated: true, scenario: 'P2-W2' }, clock);
    injector.register({ point: W2, behavior: 'fail', detail: '写入被令为失败' });

    await expect(injector.trip(W2, { messageId: 'm-p2-04' })).rejects.toThrow(InjectedFailure);
    expect(injector.firedCount).toBe(1);
    expect(injector.fired[0]).toMatchObject({
      index: 1,
      point: W2,
      behavior: 'fail',
      step: 0,
      context: { messageId: 'm-p2-04' },
      detail: '写入被令为失败',
    });
  });

  it('interrupt（P2 的 W1：已提交但未入队）携带已提交 / 未提交清单', async () => {
    const injector = new FaultInjector({ isolated: true, scenario: 'P2-W1' });
    injector.register({
      point: W1,
      behavior: 'interrupt',
      committed: ['message.persisted'],
      pending: ['queue.marked', 'scheduling.event.persisted'],
    });

    const error = await injector.trip(W1).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(InjectedInterrupt);
    const interrupt = error as InjectedInterrupt;
    expect(interrupt.point).toBe(W1);
    expect(interrupt.committed).toEqual(['message.persisted']);
    expect(interrupt.pending).toEqual(['queue.marked', 'scheduling.event.persisted']);
    expect(interrupt.message).toMatch(/已提交 \[message\.persisted\]/);
  });

  it('times 默认只打一枪；打完后 trip 恢复为空操作', async () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: W3, behavior: 'fail' });
    await expect(injector.trip(W3)).rejects.toThrow(InjectedFailure);
    await expect(injector.trip(W3)).resolves.toBeUndefined();
    expect(injector.isArmed(W3)).toBe(false);
    expect(injector.firedCount).toBe(1);
  });

  it('times 可显式放大，逐次消耗', async () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: W3, behavior: 'fail', times: 3 });
    for (let i = 1; i <= 3; i += 1) {
      await expect(injector.trip(W3)).rejects.toThrow(InjectedFailure);
      expect(injector.firedCount).toBe(i);
    }
    await expect(injector.trip(W3)).resolves.toBeUndefined();
  });

  it('pause：停住直到夹具开闸（不用 sleep）', async () => {
    const gate = new Gate();
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: W1, behavior: 'pause', gate });

    let resumed = false;
    const paused = injector.trip(W1).then(() => {
      resumed = true;
    });
    await flush();
    expect(resumed).toBe(false);
    expect(gate.waiting).toBe(1);
    expect(injector.firedCount).toBe(1);

    gate.release();
    await paused;
    expect(resumed).toBe(true);
  });

  it('未登记的点不触发任何注入（只按点名打击）', async () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: W1, behavior: 'fail' });
    await expect(injector.trip(W2)).resolves.toBeUndefined();
    expect(injector.firedCount).toBe(0);
  });
});

describe('故障注入：同步接缝 tripSync（对接返回 void 的同步钩子）', () => {
  it('fail 同步抛出：可被同步接缝（如事务提交钩子）直接抛出', () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: W2, behavior: 'fail', detail: '写入被令为失败' });
    // 形状等价于 `beforeCommit: () => void` 的同步钩子。
    const hook = (): void => injector.tripSync(W2);
    expect(() => hook()).toThrow(InjectedFailure);
    expect(injector.firedCount).toBe(1);
  });

  it('interrupt 同步抛出并携带已提交 / 未提交清单', () => {
    const injector = new FaultInjector({ isolated: true });
    injector.register({
      point: W1,
      behavior: 'interrupt',
      committed: ['message.persisted'],
      pending: ['scheduling.event.persisted'],
    });
    let caught: unknown;
    try {
      injector.tripSync(W1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InjectedInterrupt);
    expect((caught as InjectedInterrupt).pending).toEqual(['scheduling.event.persisted']);
  });

  it('未启用时 tripSync 是空操作', () => {
    const injector = new FaultInjector();
    expect(() => injector.tripSync(W2)).not.toThrow();
    expect(injector.firedCount).toBe(0);
  });

  it('pause 不能用同步接缝：显式抛用法错误（异步抛错无法同步传播）', () => {
    const gate = new Gate();
    const injector = new FaultInjector({ isolated: true });
    injector.register({ point: W1, behavior: 'pause', gate });
    expect(() => injector.tripSync(W1)).toThrow(FaultInjectionMisuseError);
    expect(() => injector.tripSync(W1)).toThrow(/trip\(\)/);
  });
});

describe('故障注入：白名单与复位', () => {
  it('登记白名单外的注入点 → 抛错', () => {
    const injector = new FaultInjector({ isolated: true, points: [W1] });
    injector.register({ point: W1, behavior: 'fail' });
    expect(() => injector.register({ point: W2, behavior: 'fail' })).toThrow(/白名单/);
  });

  it('pause 缺闸门 / 次数非法 → 显式抛错', () => {
    const injector = new FaultInjector({ isolated: true });
    expect(() => injector.register({ point: W1, behavior: 'pause' })).toThrow(/闸门/);
    expect(() => injector.register({ point: W1, behavior: 'fail', times: 0 })).toThrow(
      FaultInjectionMisuseError,
    );
  });

  it('disable 清规则但保留已发生的注入；reset 全部复位', async () => {
    const injector = new FaultInjector({ isolated: true, scenario: 'S' });
    injector.register({ point: W2, behavior: 'fail' });
    await expect(injector.trip(W2)).rejects.toThrow(InjectedFailure);

    injector.disable();
    expect(injector.enabled).toBe(false);
    expect(injector.firedCount).toBe(1);
    await expect(injector.trip(W2)).resolves.toBeUndefined();

    injector.reset();
    expect(injector.firedCount).toBe(0);
    expect(injector.snapshot()).toMatchObject({ enabled: false, scenario: null, fired: [] });
  });

  it('snapshot 给出启用状态与剩余规则（证据用）', () => {
    const injector = new FaultInjector({ isolated: true, scenario: 'P2' });
    injector.register({ point: W1, behavior: 'interrupt', times: 2 });
    expect(injector.snapshot()).toMatchObject({
      enabled: true,
      scenario: 'P2',
      armed: { [W1]: 2 },
    });
  });
});
