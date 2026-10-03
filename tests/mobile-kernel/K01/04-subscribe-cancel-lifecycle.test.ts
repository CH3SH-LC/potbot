/**
 * K01 独立验证 ④：事件订阅、取消、启停。
 *
 * - 事件 seq 严格单调、无空洞；
 * - unsubscribe 之后不再收到；
 * - 单个订阅者抛错不影响其他订阅者（隔离）；
 * - cancelInFlight 命中在飞命令：处理器观察到的 signal.aborted 为真，且**迟到的 succeeded
 *   不得覆盖取消**（事件终态必须是 cancelled）；
 * - stop() 会中止在飞命令，且之后 dispatch 抛 RUNTIME_NOT_RUNNING。
 */

import { describe, expect, it } from 'vitest';

import {
  createBootstrapRuntime,
  createManualClock,
  type BootstrapError,
  type Event,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import { deferred, flush, makeCommand, recordingModule } from './fixtures.js';

function startedRuntime() {
  const runtime = createBootstrapRuntime({ clock: createManualClock() });
  runtime.start();
  return runtime;
}

describe('K01 订阅：扇出与隔离', () => {
  it('seq 从 1 起严格递增，无空洞', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    const seqs: number[] = [];
    runtime.subscribe((e) => seqs.push(e.seq));
    await runtime.dispatch(makeCommand({ commandId: 'cmd-1', idempotencyKey: 'idem-1' }));
    await runtime.dispatch(makeCommand({ commandId: 'cmd-2', idempotencyKey: 'idem-2' }));
    await runtime.dispatch(makeCommand({ commandId: 'cmd-3', idempotencyKey: 'idem-3' }));
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('unsubscribe 之后不再收到事件', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    const received: Event[] = [];
    const sub = runtime.subscribe((e) => received.push(e));
    await runtime.dispatch(makeCommand({ commandId: 'cmd-1', idempotencyKey: 'idem-1' }));
    sub.unsubscribe();
    await runtime.dispatch(makeCommand({ commandId: 'cmd-2', idempotencyKey: 'idem-2' }));
    expect(received).toHaveLength(1);
  });

  it('单个订阅者抛错不影响其他订阅者', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    const good: Event[] = [];
    runtime.subscribe(() => {
      throw new Error('订阅者炸了');
    });
    runtime.subscribe((e) => good.push(e));
    const event = await runtime.dispatch(makeCommand());
    expect(event.status).toBe('succeeded');
    expect(good).toHaveLength(1);
  });
});

describe('K01 取消：中止在飞命令', () => {
  it('cancelInFlight 置 signal.aborted，迟到 succeeded 被强制为 cancelled', async () => {
    const runtime = startedRuntime();
    const gate = deferred<void>();
    const observed: boolean[] = [];
    runtime.registerModule(
      recordingModule('slow', ['create'], async (_command, ctx) => {
        await gate.promise;
        observed.push(ctx.signal.aborted);
        // 处理器"以为"还能成功——但引导层必须以取消为准。
        return { status: 'succeeded', resultRef: 'artifact:slow@1' };
      }).module,
    );

    const pending = runtime.dispatch(makeCommand({ commandId: 'cmd-slow', idempotencyKey: 'idem-slow' }));
    await flush();
    expect(runtime.inFlight()).toContain('cmd-slow');
    expect(runtime.cancelInFlight('cmd-slow')).toBe(true);
    gate.resolve();
    const event = await pending;

    expect(observed).toEqual([true]);
    expect(event.status).toBe('cancelled');
    expect(event.error?.code).toBe('CANCELLED_BY_USER');
    expect(event.resultRef).toBeUndefined();
    expect(runtime.inFlight()).toHaveLength(0);
  });

  it('cancelInFlight 未命中返回 false（不误报）', () => {
    const runtime = startedRuntime();
    expect(runtime.cancelInFlight('cmd-nope')).toBe(false);
  });

  it('operation=cancel 命令落到事件流（cancelled），不是静默丢弃', async () => {
    const runtime = startedRuntime();
    const events: Event[] = [];
    runtime.subscribe((e) => events.push(e));
    const event = await runtime.dispatch(
      makeCommand({ commandId: 'cmd-cancel', idempotencyKey: 'idem-cancel', operation: 'cancel', payload: { conversationId: 'conv-42' } }),
    );
    expect(event.status).toBe('cancelled');
    expect(event.error?.code).toBe('CANCELLED_BY_USER');
    expect(events.map((e) => e.status)).toEqual(['cancelled']);
  });

  it('处理器抛 AbortError ⇒ cancelled（不是 failed）', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(
      recordingModule('abortive', ['create'], () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }).module,
    );
    const event = await runtime.dispatch(makeCommand());
    expect(event.status).toBe('cancelled');
  });
});

describe('K01 启停：stop 中止在飞并拒绝后续', () => {
  it('stop 后 dispatch 抛 RUNTIME_NOT_RUNNING', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    runtime.stop();
    try {
      await runtime.dispatch(makeCommand());
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as BootstrapError).code).toBe('RUNTIME_NOT_RUNNING');
    }
  });

  it('stop 会 abort 在飞命令并清空 inFlight', async () => {
    const runtime = startedRuntime();
    const gate = deferred<void>();
    runtime.registerModule(
      recordingModule('slow', ['create'], async (_command, ctx) => {
        await gate.promise;
        if (ctx.signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return { status: 'succeeded', resultRef: 'artifact:slow@1' };
      }).module,
    );
    const pending = runtime.dispatch(makeCommand({ commandId: 'cmd-x', idempotencyKey: 'idem-x' }));
    await flush();
    expect(runtime.inFlight()).toContain('cmd-x');
    runtime.stop();
    expect(runtime.inFlight()).toHaveLength(0);
    gate.resolve();
    const event = await pending;
    expect(event.status).toBe('cancelled');
  });
});
