/**
 * F-I01 验收：`KernelClient` 对**真实** K01 `LocalUiBridge` 的端到端往返。
 *
 * 这些用例不 mock 桥：它们用真实 `createBootstrapRuntime` + 真实 `createLocalUiBridge`
 * （调用方 `kind:'ui-webview'`，origin 在白名单内），经 `createKernelClientFromBridge`
 * 装配出客户端，跑真命令、真事件、真取消。
 *
 * 覆盖：
 *   R1 端到端成功：进度事件 + 终局事件按序到达，回执带 resultRef；
 *   R2 真实 K07 `AuthorizationLedger` 原样注入为原生信任端口；
 *   R3 origin 闸门仍生效：远程 origin 的调用方被桥拒（submit-rejected，因 ORIGIN_REJECTED）；
 *   R4 运行时停止 ⇒ 在飞命令 onBreak=progressUnknown，永不成功；
 *   R5 取消：在飞命令被中止 ⇒ 终局 cancelled（既不是 succeeded，也不是 progressUnknown）。
 */

import { describe, expect, it } from 'vitest';

import {
  createBootstrapRuntime,
  createLocalUiBridge,
  createManualClock,
  type BootstrapRuntime,
  type CallerIdentity,
  type Command,
  type Event,
  type EventStatus,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import {
  createKernelClient,
  createKernelClientFromBridge,
  createLocalBridgeAdapter,
  isKernelClientError,
  type KernelStreamBreak,
  type NativeTrustPortShape,
} from '../../../apps/mobile-ui/src/platform/index.js';
import {
  createAuthorizationLedger,
  createManualClock as createK7Clock,
} from '../../../apps/mobile-kernel/actions/index.js';

const UI_CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };
const ALLOWED_ORIGINS = ['app://local', 'file:///android_asset', 'https://localhost'] as const;

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-1',
    operation: 'create',
    idempotencyKey: 'idem-1',
    payload: { goal: '把这份周报改成一页' },
    ...overrides,
  };
}

function startRuntime(handle: (command: Command) => Promise<{ status: EventStatus; resultRef?: string }>): BootstrapRuntime {
  const runtime = createBootstrapRuntime({ clock: createManualClock() });
  runtime.registerModule({
    id: 'test-module',
    operations: ['create'],
    handle: async (command, ctx) => {
      const outcome = await handle(command);
      void ctx;
      return outcome;
    },
  });
  runtime.start();
  return runtime;
}

describe('KernelClient ↔ 真实 LocalUiBridge：端到端往返', () => {
  it('R1 真实命令 → 进度 + 终局按序到达；回执带 resultRef', async () => {
    const runtime = createBootstrapRuntime({ clock: createManualClock() });
    runtime.registerModule({
      id: 'echo',
      operations: ['create'],
      handle: async (_command, ctx) => {
        ctx.emit({ status: 'running' });
        return { status: 'succeeded', resultRef: 'artifact:echo@1' };
      },
    });
    const bundle = createKernelClientFromBridge({
      runtime,
      caller: UI_CALLER,
      allowedOrigins: ALLOWED_ORIGINS,
      allowedKinds: ['ui-webview'],
    });
    bundle.start();

    // 真实桥确实在（不是 mock）。
    expect(typeof bundle.bridge.submit).toBe('function');
    expect(typeof bundle.bridge.subscribe).toBe('function');
    expect(typeof bundle.bridge.cancel).toBe('function');

    const command = makeCommand({ commandId: 'cmd-rt', idempotencyKey: 'idem-rt' });
    const statuses: EventStatus[] = [];
    const seen: Event[] = [];
    bundle.client.subscribe(
      command.commandId,
      (event) => {
        seen.push(event);
        statuses.push(event.status);
      },
      () => {},
    );

    const receipt = await bundle.client.sendCommand(command);
    expect(receipt.status).toBe('succeeded');
    expect(receipt.resultRef).toBe('artifact:echo@1');
    expect(receipt.error).toBeNull();
    expect(statuses).toEqual(['running', 'succeeded']);
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('R2 真实 K07 AuthorizationLedger 原样注入为原生信任端口', () => {
    const runtime = startRuntime(async () => ({ status: 'succeeded', resultRef: 'artifact:x@1' }));
    const ledger = createAuthorizationLedger({ clock: createK7Clock(Date.parse('2026-10-03T00:00:00.000Z')) });

    const bundle = createKernelClientFromBridge({
      runtime,
      caller: UI_CALLER,
      allowedOrigins: ALLOWED_ORIGINS,
      allowedKinds: ['ui-webview'],
      nativeTrust: ledger,
    });

    // 同一对象：注入即原样承载，未被包装 / 未被替换。
    expect(bundle.client.nativeTrust).toBe(ledger);
    // 真实账本具备信任端口五方法（结构化）。
    const port: NativeTrustPortShape = ledger;
    expect(typeof port.recordConfirmAction).toBe('function');
    expect(typeof port.consume).toBe('function');
    bundle.stop();
  });

  it('R3 origin 闸门仍生效：远程 origin 调用方连订阅都进不去（桥同步拒）', () => {
    const runtime = createBootstrapRuntime({ clock: createManualClock() });
    runtime.registerModule({
      id: 'noop',
      operations: ['create'],
      handle: async () => ({ status: 'succeeded', resultRef: 'artifact:noop@1' }),
    });
    runtime.start();
    const bridge = createLocalUiBridge(runtime, { allowedOrigins: ALLOWED_ORIGINS, allowedKinds: ['ui-webview'] });

    // 适配器钉一个**不在**白名单的调用方：桥的 assertCaller 在 subscribe 处即同步拦下，
    // 因此客户端在装配阶段（eager subscribe）就拒绝这个 caller —— fail-closed。
    const remoteCaller: CallerIdentity = { origin: 'https://evil.example', kind: 'ui-webview' };
    const adaptive = createLocalBridgeAdapter({ bridge, caller: remoteCaller });
    expect(() => createKernelClient({ transport: adaptive, caller: remoteCaller })).toThrow(/origin/);
  });

  it('R3b 真实桥拒绝非法命令 ⇒ sendCommand reject(submit-rejected) 且 onBreak=progressUnknown', async () => {
    const runtime = startRuntime(async () => ({ status: 'succeeded', resultRef: 'artifact:x@1' }));
    const bundle = createKernelClientFromBridge({
      runtime,
      caller: UI_CALLER,
      allowedOrigins: ALLOWED_ORIGINS,
      allowedKinds: ['ui-webview'],
    });
    bundle.start();

    const breaks: KernelStreamBreak[] = [];
    bundle.client.subscribe('cmd-bad', () => {}, (b) => breaks.push(b));

    // operation 不在契约词表 ⇒ validateCommand 拒 ⇒ COMMAND_INVALID。
    const badCommand = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-bad',
      operation: 'bogus',
      idempotencyKey: 'idem-bad',
      payload: {},
    } as unknown as Command;

    await expect(bundle.client.sendCommand(badCommand)).rejects.toSatisfy(
      (error: unknown) => isKernelClientError(error) && error.code === 'submit-rejected',
    );
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.reason).toBe('submit-rejected');
    expect(breaks[0]?.status).toBe('progressUnknown');
  });

  it('R4 运行时停止 ⇒ 在飞命令 onBreak=progressUnknown，绝不成功', () => {
    const runtime = startRuntime(() => new Promise(() => {})); // 永不 settle
    const bundle = createKernelClientFromBridge({
      runtime,
      caller: UI_CALLER,
      allowedOrigins: ALLOWED_ORIGINS,
      allowedKinds: ['ui-webview'],
    });
    bundle.start();

    const command = makeCommand({ commandId: 'cmd-slow', idempotencyKey: 'idem-slow' });
    const statuses: EventStatus[] = [];
    const breaks: KernelStreamBreak[] = [];
    bundle.client.subscribe(command.commandId, (e) => statuses.push(e.status), (b) => breaks.push(b));

    // 不 await：处理器永不 settle，命令一直"在飞"。
    void bundle.client.sendCommand(command);
    expect(runtime.inFlight()).toContain('cmd-slow');

    bundle.stop(); // runtime.stop() → 桥不发终局事件 ⇒ 真实断流场景

    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.status).toBe('progressUnknown');
    expect(breaks[0]?.reason).toBe('runtime-stopped');
    expect(statuses).not.toContain('succeeded');
    expect(bundle.client.state).toBe('closed');
  });

  it('R5 取消在飞命令 ⇒ 终局 cancelled（既非成功也非未知）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = startRuntime(async () => {
      await gate;
      return { status: 'succeeded', resultRef: 'artifact:late@9' };
    });
    const bundle = createKernelClientFromBridge({
      runtime,
      caller: UI_CALLER,
      allowedOrigins: ALLOWED_ORIGINS,
      allowedKinds: ['ui-webview'],
    });
    bundle.start();

    const command = makeCommand({ commandId: 'cmd-cancel', idempotencyKey: 'idem-cancel' });
    const statuses: EventStatus[] = [];
    bundle.client.subscribe(command.commandId, (e) => statuses.push(e.status), () => {});

    const pending = bundle.client.sendCommand(command);
    expect(runtime.inFlight()).toContain('cmd-cancel');
    expect(bundle.client.cancel(command.commandId)).toBe(true);

    release();
    const receipt = await pending;
    expect(receipt.status).toBe('cancelled');
    expect(receipt.resultRef).toBeNull();
    expect(statuses).toContain('cancelled');
    expect(statuses).not.toContain('succeeded');
  });
});
