/**
 * K-I14 验证 ②：宿主加载冒烟 —— 加载**打包产物**后驱动 start -> submit -> event -> stop。
 *
 * 这条链走的是真实产物（dist/bootstrap.mjs）而非源码，证明"单文件 ESM 打包后仍可被
 * 宿主 JS 运行时加载并驱动完整生命周期"。同时记录产物体积与运行时能力（Uint8Array /
 * TextEncoder / AbortController），作为 arm64 运行时选型所需的**宿主侧**基线数据。
 *
 * 诚实边界：这是**宿主 Node** 加载，**不是** arm64 真机 spike（真机无 JS 运行时/设备）。
 * 因此本文件不宣称任何 on-device 结论，只记录宿主事实。
 */

import { describe, expect, it } from 'vitest';

import {
  BUNDLE_PATH,
  bundleSize,
  loadBundle,
  makeCommand,
  probeCapabilities,
  recordingModule,
  type RuntimeEvent,
} from './fixtures.js';

describe('K-I14 宿主加载冒烟：生命周期 start -> submit -> event -> stop', () => {
  it('产物加载后可走完 start/submit/event/stop，并返回契约形状事件', async () => {
    const bundle = await loadBundle();

    const runtime = bundle.createBootstrapRuntime({ clock: bundle.createManualClock() });
    expect(runtime.state).toBe('stopped');

    const { module, calls } = recordingModule('ki14-echo', ['create']);
    runtime.registerModule(module);
    runtime.start();
    expect(runtime.state).toBe('running');

    // 订阅必须能收到派发事件（借用 bridge 的 origin 门一起测）。
    const bridge = bundle.createLocalUiBridge(runtime);
    const received: RuntimeEvent[] = [];
    const sub = bridge.subscribe({ origin: 'app://local', kind: 'ui-webview' }, (event) => {
      received.push(event);
    });

    const command = makeCommand();
    const event = await bridge.submit({ origin: 'app://local', kind: 'ui-webview' }, command);

    // 事件是契约形状：有 eventId/seq/commandId/status。
    expect(event.eventId).toBe('evt-1');
    expect(event.seq).toBe(1);
    expect(event.commandId).toBe(command.commandId);
    expect(event.status).toBe('succeeded');
    expect(event.resultRef).toBe('artifact:ki14-echo@1');
    expect(event.idempotentReplay).toBe(false);

    // 处理器确实被调用一次，且拿到注入时钟的时间戳与取消信号。
    expect(calls).toHaveLength(1);
    const ctx = calls[0] as { aborted: boolean; now: string };
    expect(ctx.aborted).toBe(false);
    expect(typeof ctx.now).toBe('string');

    // 事件已扇出给订阅者。
    expect(received.map((e) => e.seq)).toEqual([1]);

    sub.unsubscribe();
    runtime.stop();
    expect(runtime.state).toBe('stopped');
  });

  it('stop 之后 dispatch 被拒绝（未运行边界，反向对照生命周期真的关了）', async () => {
    const bundle = await loadBundle();
    const runtime = bundle.createBootstrapRuntime({ clock: bundle.createManualClock() });
    const { module } = recordingModule('ki14-echo2', ['create']);
    runtime.registerModule(module);
    runtime.start();
    runtime.stop();

    await expect(runtime.dispatch(makeCommand())).rejects.toMatchObject({
      code: 'RUNTIME_NOT_RUNNING',
    });
  });

  it('bridge 的 origin 门在打包产物里仍然生效（远程 origin 被拒）', async () => {
    const bundle = await loadBundle();
    const runtime = bundle.createBootstrapRuntime({ clock: bundle.createManualClock() });
    const { module } = recordingModule('ki14-echo3', ['create']);
    runtime.registerModule(module);
    runtime.start();
    const bridge = bundle.createLocalUiBridge(runtime);

    await expect(
      bridge.submit({ origin: 'https://evil.example' }, makeCommand({ commandId: 'cmd-evil', idempotencyKey: 'idem-evil' })),
    ).rejects.toMatchObject({ code: 'ORIGIN_REJECTED' });
    runtime.stop();
  });

  it('AbortController 路径在产物内可用：cancelInFlight 中止在飞命令', async () => {
    const bundle = await loadBundle();
    const runtime = bundle.createBootstrapRuntime({ clock: bundle.createManualClock() });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawAbort = false;
    runtime.registerModule({
      id: 'ki14-slow',
      operations: ['create'],
      handle: async (_command, ctx) => {
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        await gate;
        return { status: 'succeeded', resultRef: 'artifact:slow@1' };
      },
    });
    runtime.start();

    const pending = runtime.dispatch(makeCommand({ commandId: 'cmd-slow', idempotencyKey: 'idem-slow' }));
    expect(runtime.inFlight()).toContain('cmd-slow');
    expect(runtime.cancelInFlight('cmd-slow')).toBe(true);
    release();

    const event = await pending;
    expect(sawAbort).toBe(true);
    // 迟到结果不得覆盖取消：状态以 signal 为准。
    expect(event.status).toBe('cancelled');
    runtime.stop();
  });
});

describe('K-I14 运行时能力与体积记录（宿主侧基线）', () => {
  it('记录产物体积与宿主能力，且核心能力可得', async () => {
    const size = await bundleSize();
    const caps = probeCapabilities();

    // 打包占位符（无论 esbuild 还是 tsc 回退，都是几 KB 级单文件）。
    expect(size).toBeGreaterThan(1000);
    expect(size).toBeLessThan(200_000);
    expect(BUNDLE_PATH.endsWith('bootstrap.mjs')).toBe(true);

    // 三件运行时选型判据必须可得，否则手机内核无法在这类运行时里跑。
    expect(caps.uint8Array).toBe(true);
    expect(caps.textEncoder).toBe(true);
    expect(caps.abortController).toBe(true);

    // 把宿主事实打进测试输出，便于取证（不是真机结论）。
    process.stdout.write(
      `[K-I14] host-load smoke: bundle=${size}B host=${caps.host} node=${caps.nodeVersion} ` +
        `abi=${caps.nodeAbi} Uint8Array=${caps.uint8Array} TextEncoder=${caps.textEncoder} ` +
        `TextDecoder=${caps.textDecoder} AbortController=${caps.abortController} atob=${caps.atob}\n`,
    );
  });
});
