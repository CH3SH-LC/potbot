/**
 * M-R04 网络切换：掉线不发送、切网可观测、重试等待中掉线不再发出。
 *
 * 这些用例把"网络切换"从注释变成可回归的断言：`generation` 让"切过网"可机读，
 * 离线路径必须**不调用传输端口**（否则会把"没发出"误记成"发出后未知"）。
 */

import { describe, expect, it } from 'vitest';

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import { createNetworkMonitor } from './network-state.js';
import { okHttpOutcome, serverErrorOutcome } from './outcomes.js';
import { createSenderScenario, T0 } from './support.js';

describe('M-R04 网络监视器：切换可观测', () => {
  it('初始离线；切到 wifi 后在线，generation 与 changedAt 正确', () => {
    const clock = new FixtureClock(T0);
    const monitor = createNetworkMonitor({ clock });
    expect(monitor.kind).toBe('none');
    expect(monitor.isOnline()).toBe(false);
    expect(monitor.snapshot.generation).toBe(0);

    clock.advance(1000);
    const wifi = monitor.setKind('wifi');
    expect(wifi.online).toBe(true);
    expect(wifi.metered).toBe(false);
    expect(wifi.generation).toBe(1);
    expect(wifi.changedAt).toBe(T0 + 1000);
    expect(monitor.switchCount).toBe(1);
  });

  it('同类型重复设置是幂等的：不动 generation、不产生切换记录', () => {
    const clock = new FixtureClock(T0);
    const monitor = createNetworkMonitor({ clock, initial: 'wifi' });
    monitor.setKind('cellular');
    expect(monitor.snapshot.generation).toBe(1);

    monitor.setKind('cellular');
    monitor.setKind('cellular');
    expect(monitor.snapshot.generation).toBe(1);
    expect(monitor.transitions.length).toBe(1);
  });

  it('蜂窝计费 metered=true；切换明细 from/to/generation 完整', () => {
    const clock = new FixtureClock(T0);
    const monitor = createNetworkMonitor({ clock, initial: 'wifi' });
    const cellular = monitor.setKind('cellular');
    expect(cellular.metered).toBe(true);
    expect(cellular.online).toBe(true);

    expect(monitor.transitions).toEqual([
      { from: 'wifi', to: 'cellular', at: T0, generation: 1 },
    ]);
  });

  it('onChange 只在真实变更时触发；退订后不再触发', () => {
    const clock = new FixtureClock(T0);
    const monitor = createNetworkMonitor({ clock, initial: 'wifi' });
    const seen: string[] = [];
    const unsubscribe = monitor.onChange((snapshot) => seen.push(snapshot.kind));

    monitor.setKind('wifi'); // 幂等：不触发
    monitor.setKind('cellular'); // 触发
    expect(seen).toEqual(['cellular']);

    unsubscribe();
    monitor.setKind('none'); // 已退订：不再触发
    expect(seen).toEqual(['cellular']);
  });

  it('waitForOnline 在切到在线时 resolve（不使用定时器）', async () => {
    const clock = new FixtureClock(T0);
    const monitor = createNetworkMonitor({ clock }); // 初始离线
    const pending = monitor.waitForOnline();
    expect(monitor.isOnline()).toBe(false);
    clock.advance(500);
    monitor.setKind('wifi');
    const snapshot = await pending;
    expect(snapshot.online).toBe(true);
    expect(snapshot.kind).toBe('wifi');
  });
});

describe('M-R04 离线：请求不发出', () => {
  it('离线时只读发送不调用传输端口（attempts=0, transportCalls=0）', async () => {
    const scenario = createSenderScenario({ initialNetwork: 'none', script: [okHttpOutcome()] });
    const result = await scenario.sender.sendRead('read-ref-1');

    expect(result.attempts).toBe(0);
    expect(result.transportCalls).toBe(0);
    expect(scenario.transport.calls.length).toBe(0);
    expect(result.outcome?.transport).toBe('offline');
    expect(result.disposition?.kind).toBe('offline');
    expect(result.disposition?.mayHaveReachedPlatform).toBe(false);
    expect(result.disposition?.retry).toBe('wait_for_network');
  });

  it('离线时提交报 not_sent，且不调用传输端口（不会凭空制造"可能已下单"）', async () => {
    const scenario = createSenderScenario({ initialNetwork: 'cellular', script: [okHttpOutcome()] });
    scenario.monitor.setKind('none');
    const result = await scenario.sender.sendSubmit('submit-ref-1');

    expect(result.finalAction).toBe('not_sent');
    expect(result.attempts).toBe(0);
    expect(result.transportCalls).toBe(0);
    expect(scenario.transport.calls.length).toBe(0);
    expect(result.mayAutoResend).toBe(false);
  });
});

describe('M-R04 重试等待期间掉线：不再发出', () => {
  it('只读重试等待中掉线，第二次发送被拦下（transportCalls 停在 1）', async () => {
    const scenario = createSenderScenario({
      initialNetwork: 'wifi',
      script: [serverErrorOutcome(503), okHttpOutcome()],
      // 第一次等待后掉线：模拟"退避期间网络断开"。
      sleeperHook: (_ms, _index, monitor) => monitor.setKind('none'),
    });

    const result = await scenario.sender.sendRead('read-ref-2');

    expect(result.attempts).toBe(1);
    expect(result.transportCalls).toBe(1);
    expect(scenario.transport.calls.length).toBe(1);
    expect(result.outcome?.transport).toBe('offline');
    expect(result.disposition?.kind).toBe('offline');
    // 等待确实发生过（退避 250ms），且掉线后没有第二次调用。
    expect(scenario.sleeper.waits).toEqual([250]);
  });
});
