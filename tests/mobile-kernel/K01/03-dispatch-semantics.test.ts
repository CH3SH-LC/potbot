/**
 * K01 独立验证 ③：dispatch 的硬口径（fail-closed / 幂等 / revision 守卫 / 边界拒绝）。
 *
 * 每条都带**反向对照**：证明实现不是恒真（例如"缺执行器"必须落到 failed 而不是 succeeded；
 * 幂等重放必须命中处理器**一次**；旧修订必须 conflict 且**不**调用处理器）。
 */

import { describe, expect, it } from 'vitest';

import {
  createBootstrapRuntime,
  createManualClock,
  type BootstrapError,
  type Command,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import { makeCommand, recordingModule } from './fixtures.js';

function startedRuntime() {
  const runtime = createBootstrapRuntime({ clock: createManualClock() });
  runtime.start();
  return runtime;
}

async function expectBootstrapError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('应当抛错但没有');
  } catch (error) {
    expect((error as BootstrapError).code, (error as Error).message).toBe(code);
  }
}

describe('K01 dispatch：生命周期门禁', () => {
  it('未启动时 dispatch 抛 RUNTIME_NOT_RUNNING', async () => {
    const runtime = createBootstrapRuntime({ clock: createManualClock() });
    await expectBootstrapError(runtime.dispatch(makeCommand()), 'RUNTIME_NOT_RUNNING');
  });

  it('重复 start 抛 RUNTIME_ALREADY_RUNNING；stop 后回到 stopped', () => {
    const runtime = startedRuntime();
    expect(runtime.state).toBe('running');
    try {
      runtime.start();
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as BootstrapError).code).toBe('RUNTIME_ALREADY_RUNNING');
    }
    runtime.stop();
    expect(runtime.state).toBe('stopped');
  });

  it('重复 registerModule 认领同一 operation 抛 MODULE_CONFLICT', () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('a', ['create']).module);
    const dup = recordingModule('b', ['create']).module;
    try {
      runtime.registerModule(dup);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as BootstrapError).code).toBe('MODULE_CONFLICT');
    }
  });
});

describe('K01 dispatch：fail-closed', () => {
  it('缺执行器 ⇒ failed + EXECUTOR_UNAVAILABLE，绝不是 succeeded', async () => {
    const runtime = startedRuntime();
    // 注册 create 模块，但不认领 inspect ⇒ inspect 无执行器。
    runtime.registerModule(recordingModule('echo', ['create']).module);
    const event = await runtime.dispatch(makeCommand({ operation: 'inspect', idempotencyKey: 'idem-inspect', commandId: 'cmd-i1', payload: { taskId: 'task-9' } }));
    expect(event.status).toBe('failed');
    expect(event.resultRef).toBeUndefined();
    expect(event.error?.code).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('处理器声称 succeeded 但不给 resultRef ⇒ 降级为 failed', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(
      recordingModule('bad', ['create'], () => ({ status: 'succeeded' })).module,
    );
    const event = await runtime.dispatch(makeCommand());
    expect(event.status).toBe('failed');
    expect(event.error?.code).toBe('RESULT_REF_REQUIRED');
  });

  it('处理器抛错 ⇒ failed + HANDLER_ERROR（不吞掉）', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(
      recordingModule('boom', ['create'], () => {
        throw new Error('磁盘满了');
      }).module,
    );
    const event = await runtime.dispatch(makeCommand());
    expect(event.status).toBe('failed');
    expect(event.error?.code).toBe('HANDLER_ERROR');
    expect(event.error?.message).toContain('磁盘满了');
  });

  it('正常成功：succeeded 携带 resultRef，revision 递增', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    const event = await runtime.dispatch(makeCommand());
    expect(event.status).toBe('succeeded');
    expect(event.resultRef).toBe('artifact:echo@1');
    expect(event.revision).toBe(1);
    expect(event.verificationMode).toBe('fixture');
  });
});

describe('K01 dispatch：幂等', () => {
  it('同一 idempotencyKey 重放：同 eventId/seq，idempotentReplay=true，处理器只跑一次', async () => {
    const runtime = startedRuntime();
    const { module, recording } = recordingModule('echo', ['create']);
    runtime.registerModule(module);
    const seen: string[] = [];
    runtime.subscribe((e) => seen.push(e.eventId));

    const first = await runtime.dispatch(makeCommand());
    const second = await runtime.dispatch(makeCommand());

    expect(second.eventId).toBe(first.eventId);
    expect(second.seq).toBe(first.seq);
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.resultRef).toBe(first.resultRef);
    expect(recording.calls).toHaveLength(1);
    // 重放不重复扇出给订阅者。
    expect(seen).toEqual([first.eventId]);
  });

  it('不同 idempotencyKey 不互相幂等', async () => {
    const runtime = startedRuntime();
    const { module, recording } = recordingModule('echo', ['create']);
    runtime.registerModule(module);
    await runtime.dispatch(makeCommand({ commandId: 'cmd-a', idempotencyKey: 'idem-a' }));
    await runtime.dispatch(makeCommand({ commandId: 'cmd-b', idempotencyKey: 'idem-b' }));
    expect(recording.calls).toHaveLength(2);
  });
});

describe('K01 dispatch：revision 守卫', () => {
  async function seedDoc() {
    const runtime = startedRuntime();
    const { module, recording } = recordingModule('doc', ['create', 'mutate']);
    runtime.registerModule(module);
    // create 到 doc-7：revision 1。
    const created = await runtime.dispatch(
      makeCommand({ commandId: 'cmd-c', idempotencyKey: 'idem-c', payload: { targetId: 'doc-7', goal: '新建' } }),
    );
    expect(created.revision).toBe(1);
    return { runtime, recording };
  }

  it('旧 expectedRevision ⇒ conflict，处理器不被调用', async () => {
    const { runtime, recording } = await seedDoc();
    const before = recording.calls.length;
    const event = await runtime.dispatch(
      makeCommand({
        commandId: 'cmd-m',
        idempotencyKey: 'idem-m',
        operation: 'mutate',
        payload: { conversationId: 'conv-42', targetId: 'doc-7', expectedRevision: 0, patch: { op: 'replace' } },
      }),
    );
    expect(event.status).toBe('conflict');
    expect(event.revision).toBe(1);
    expect(event.error?.code).toBe('REVISION_CONFLICT');
    expect(recording.calls.length).toBe(before); // 处理器未被调用
  });

  it('正确 expectedRevision ⇒ succeeded 并推进 revision', async () => {
    const { runtime } = await seedDoc();
    const event = await runtime.dispatch(
      makeCommand({
        commandId: 'cmd-m2',
        idempotencyKey: 'idem-m2',
        operation: 'mutate',
        payload: { conversationId: 'conv-42', targetId: 'doc-7', expectedRevision: 1, patch: { op: 'replace' } },
      }),
    );
    expect(event.status).toBe('succeeded');
    expect(event.revision).toBe(2);
  });
});

describe('K01 dispatch：载荷安全（桥不暴露密钥/路径/代码）', () => {
  it('夹带密钥字段 ⇒ PAYLOAD_FORBIDDEN', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    // 密钥字段塞进合法容器（args）里——否则会先撞上 COMMAND_INVALID。
    await expectBootstrapError(
      runtime.dispatch(makeCommand({ payload: { goal: 'x', args: { apiKey: 'anything' } } as Command['payload'] })),
      'PAYLOAD_FORBIDDEN',
    );
  });

  it('夹带电脑绝对路径 ⇒ PAYLOAD_FORBIDDEN', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    await expectBootstrapError(
      runtime.dispatch(makeCommand({ payload: { goal: 'x', args: { path: 'C:\\Users\\<user>\\Desktop\\a.txt' } } as Command['payload'] })),
      'PAYLOAD_FORBIDDEN',
    );
    await expectBootstrapError(
      runtime.dispatch(
        makeCommand({ idempotencyKey: 'idem-2', commandId: 'cmd-2', payload: { goal: 'y', args: { path: '/etc/passwd' } } as Command['payload'] }),
      ),
      'PAYLOAD_FORBIDDEN',
    );
  });

  it('夹带代码执行字段 ⇒ PAYLOAD_FORBIDDEN', async () => {
    const runtime = startedRuntime();
    runtime.registerModule(recordingModule('echo', ['create']).module);
    await expectBootstrapError(
      runtime.dispatch(makeCommand({ payload: { goal: 'x', args: { eval: 'while(true){}' } } as Command['payload'] })),
      'PAYLOAD_FORBIDDEN',
    );
  });

  it('形状非法 ⇒ COMMAND_INVALID（不是 PAYLOAD_FORBIDDEN 混淆）', async () => {
    const runtime = startedRuntime();
    await expectBootstrapError(runtime.dispatch({ schemaVersion: 'mobile-v1' }), 'COMMAND_INVALID');
  });
});
