/**
 * K01 独立验证 ②：调用方 / 本地 origin 校验。
 *
 * 判据：只有本地 origin（`app://local` / `file:///android_asset` / `https://localhost`）
 * 能通过；远程 origin 一律被拒。三个桥入口（submit / subscribe / cancel）都必须先过这道门，
 * 且**被拒时处理器绝不能被执行**（用记录型模块反证）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWED_ORIGINS,
  assertCaller,
  createBootstrapRuntime,
  createLocalUiBridge,
  createManualClock,
  isAllowedOrigin,
  normalizeOrigin,
  type BootstrapError,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import { CALLER_APP, makeCaller, makeCommand, recordingModule } from './fixtures.js';

function expectBootstrapError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('应当抛错但没有');
  } catch (error) {
    expect((error as BootstrapError).code, (error as Error).message).toBe(code);
  }
}

describe('K01 origin：白名单判定', () => {
  it('默认白名单只含本地三态', () => {
    expect([...DEFAULT_ALLOWED_ORIGINS]).toEqual(['app://local', 'file:///android_asset', 'https://localhost']);
    for (const origin of DEFAULT_ALLOWED_ORIGINS) expect(isAllowedOrigin(origin)).toBe(true);
  });

  it('远程 origin 被拒', () => {
    for (const origin of ['https://evil.example', 'http://10.0.2.2', 'https://api.deepseek.com', 'http://example.com']) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it('归一化：scheme/host 大小写不敏感，path 保持原样', () => {
    expect(normalizeOrigin('APP://LOCAL')).toBe('app://local');
    expect(normalizeOrigin('  https://LocalHost  ')).toBe('https://localhost');
    expect(isAllowedOrigin('APP://LOCAL')).toBe(true);
  });
});

describe('K01 origin：assertCaller', () => {
  it('合法本地调用方被归一化返回', () => {
    const caller = assertCaller({ origin: 'APP://LOCAL', kind: 'ui-webview' });
    expect(caller.origin).toBe('app://local');
    expect(caller.kind).toBe('ui-webview');
  });

  it('缺 origin / 非对象 / 未知 kind ⇒ CALLER_INVALID', () => {
    expectBootstrapError(() => assertCaller({}), 'CALLER_INVALID');
    expectBootstrapError(() => assertCaller('app://local'), 'CALLER_INVALID');
    expectBootstrapError(() => assertCaller({ origin: '   ' }), 'CALLER_INVALID');
    expectBootstrapError(() => assertCaller({ origin: 'app://local', kind: 'robot' }), 'CALLER_INVALID');
  });

  it('远程 origin ⇒ ORIGIN_REJECTED', () => {
    expectBootstrapError(() => assertCaller({ origin: 'https://evil.example' }), 'ORIGIN_REJECTED');
  });

  it('kind 白名单（allowedKinds）生效', () => {
    expectBootstrapError(
      () => assertCaller({ origin: 'app://local', kind: 'native' }, DEFAULT_ALLOWED_ORIGINS, ['ui-webview']),
      'ORIGIN_REJECTED',
    );
  });
});

describe('K01 origin：桥的每个入口都过门', () => {
  function harness() {
    const runtime = createBootstrapRuntime({ clock: createManualClock() });
    runtime.start();
    const { module, recording } = recordingModule('echo', ['create']);
    runtime.registerModule(module);
    const bridge = createLocalUiBridge(runtime);
    return { runtime, bridge, recording };
  }

  it('远程调用方 submit 被拒，且处理器未被调用', async () => {
    const { bridge, recording } = harness();
    await expect(bridge.submit(makeCaller({ origin: 'https://evil.example' }), makeCommand())).rejects.toMatchObject({
      code: 'ORIGIN_REJECTED',
    });
    expect(recording.calls).toHaveLength(0);
  });

  it('远程调用方 subscribe 被拒', () => {
    const { bridge } = harness();
    expectBootstrapError(() => bridge.subscribe(makeCaller({ origin: 'http://10.0.2.2' }), () => {}), 'ORIGIN_REJECTED');
  });

  it('远程调用方 cancel 被拒', () => {
    const { bridge } = harness();
    expectBootstrapError(() => bridge.cancel(makeCaller({ origin: 'file:///etc/passwd' }), 'cmd-0001'), 'ORIGIN_REJECTED');
  });

  it('本地调用方三个入口都放行', async () => {
    const { bridge } = harness();
    const sub = bridge.subscribe(CALLER_APP, () => {});
    expect(sub.id).toMatch(/^sub-/);
    sub.unsubscribe();
    const event = await bridge.submit(CALLER_APP, makeCommand());
    expect(event.status).toBe('succeeded');
    expect(bridge.cancel(CALLER_APP, 'cmd-does-not-exist')).toBe(false);
  });

  it('cancel 遇到空 commandId 抛 TypeError（边界入参）', () => {
    const { bridge } = harness();
    expect(() => bridge.cancel(CALLER_APP, '')).toThrow(TypeError);
  });
});
