/**
 * K-I04 集成验证 ④：lane 组装 barrel + 失败路径。
 *
 *   - `apps/mobile-kernel/index.ts` 能作为 lane 组装出口被加载，暴露 host / bootstrap /
 *     五个模块命名空间；
 *   - 未知子操作 ⇒ `failed`（`HOST_OP_UNKNOWN`），不静默吞掉；
 *   - 域错误（如对不存在的会话查询）以 `failed` + 域错误码经桥回传；
 *   - K08 红线：记忆库**读失败不得退化成空库** —— 打开失败时宿主构建直接 reject。
 */

import { describe, expect, it } from 'vitest';

import * as kernel from '../../../apps/mobile-kernel/index.js';
import { MemoryPersistenceBackend } from '../../../apps/mobile-kernel/memory/index.js';
import { CALLER, createTestHost, makeCommand, makeSession } from './fixtures.js';

describe('K-I04 lane 组装 barrel', () => {
  it('index.ts 暴露 host / bootstrap 与五个模块命名空间', () => {
    expect(typeof kernel.createKernelHost).toBe('function');
    expect(typeof kernel.createBootstrapRuntime).toBe('function');
    expect(typeof kernel.createLocalUiBridge).toBe('function');
    expect(typeof kernel.host.createKernelHost).toBe('function');
    expect(typeof kernel.bootstrap.createBootstrapRuntime).toBe('function');
    expect(typeof kernel.conversation.MobileConversationStore).toBe('function');
    expect(typeof kernel.memory.openPhoneMemory).toBe('function');
    expect(typeof kernel.dispatch.planDispatch).toBe('function');
    expect(typeof kernel.templates.createTemplateLifecycle).toBe('function');
    expect(typeof kernel.actions.createAuthorizationLedger).toBe('function');
  });
});

describe('K-I04 失败路径', () => {
  it('未知子操作 ⇒ failed(HOST_OP_UNKNOWN)，不静默吞掉', async () => {
    const host = await createTestHost();
    const session = makeSession(host);
    const event = await session.submit(
      makeCommand({
        commandId: 'cmd-bad',
        idempotencyKey: 'idem-bad',
        operation: 'query',
        payload: { conversationId: 'conv-1', filters: { op: 'nope' } },
      }),
    );
    expect(event.status).toBe('failed');
    expect(event.error?.code).toBe('HOST_OP_UNKNOWN');
  });

  it('域错误经桥回传：查询不存在的会话 ⇒ failed(conversation_not_found)', async () => {
    const host = await createTestHost();
    const session = makeSession(host);
    const event = await session.submit(
      makeCommand({
        commandId: 'cmd-miss',
        idempotencyKey: 'idem-miss',
        operation: 'query',
        payload: { conversationId: 'conv-missing', filters: { op: 'list' } },
      }),
    );
    expect(event.status).toBe('failed');
    expect(event.error?.code).toBe('conversation_not_found');
  });

  it('K08 红线：记忆库读失败 ⇒ 宿主构建 reject（不退化成空库）', async () => {
    const failingPort = new MemoryPersistenceBackend(undefined, { failRead: true });
    await expect(
      kernel.createKernelHost({
        clock: kernel.bootstrap.createManualClock('2026-10-03T00:00:00.000Z'),
        memoryPort: failingPort,
        capabilityDiscovery: kernel.dispatch.createStaticDiscovery([]),
        templateProbe: {
          identity: 'fixture.probe',
          probeInstalled: () => ({ ok: true }),
          probeEnabled: () => ({ ok: true }),
          probeAuthorized: () => ({ ok: true }),
          probePorts: () => ({ ok: true }),
        },
        hostPlatform: {
          os: 'android',
          apiLevel: 34,
          runtimes: ['node'],
          abis: ['arm64-v8a'],
          capabilities: [],
        },
      }),
    ).rejects.toThrow();
  });

  it('白名单 origin 的 cancel 需要非空 commandId（TypeError，不静默）', async () => {
    const host = await createTestHost();
    expect(() => host.cancel(CALLER, '')).toThrow(TypeError);
  });
});
