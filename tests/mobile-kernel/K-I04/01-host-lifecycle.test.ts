/**
 * K-I04 集成验证 ①：宿主装配与启停生命周期。
 *
 * 断言：
 *   - `createKernelHost` 把**五个真实模块**注册进 K01 引导层，且各自认领的 operation
 *     **两两不相交**（否则 registerModule 会抛 MODULE_CONFLICT，装配就失败）；
 *   - 宿主**不自动启动**：未启动时经桥 submit 抛 `RUNTIME_NOT_RUNNING`；
 *   - `start()` 后可提交；重复 `start()` 抛 `RUNTIME_ALREADY_RUNNING`；
 *   - `stop()` 后回到 stopped，再 submit 抛 `RUNTIME_NOT_RUNNING`；
 *   - 桥的本地 origin 门对**每个**入口生效（非白名单 origin 被拒）。
 */

import { describe, expect, it } from 'vitest';

import { isBootstrapError, type BootstrapError } from '../../../apps/mobile-kernel/bootstrap/index.js';
import type { CommandOperation } from '../../../apps/mobile-kernel/bootstrap/index.js';
import { CALLER, createTestHost, makeCommand } from './fixtures.js';

async function expectBootstrapError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`应当抛 ${code}，但没有抛错（判据是空壳）`);
  } catch (error) {
    expect(isBootstrapError(error), (error as Error).message).toBe(true);
    expect((error as BootstrapError).code, (error as Error).message).toBe(code);
  }
}

describe('K-I04 宿主：模块注册', () => {
  it('注册五个真实模块，operation 认领两两不相交', async () => {
    const host = await createTestHost();
    const ids = host.modules.map((module) => module.id).sort();
    expect(ids).toEqual(['actions', 'conversation', 'dispatch', 'memory', 'templates']);

    const claimed = new Map<CommandOperation, string>();
    for (const module of host.modules) {
      expect(module.operations.length).toBeGreaterThan(0);
      for (const operation of module.operations) {
        expect(claimed.has(operation), `operation ${operation} 被多个模块认领`).toBe(false);
        claimed.set(operation, module.id);
      }
    }
  });

  it('未启动时空库不受影响；start 后才可 dispatch', async () => {
    const host = await createTestHost({ start: false });
    expect(host.runtime.state).toBe('stopped');
    await expectBootstrapError(
      host.submit(CALLER, makeCommand({ operation: 'create', payload: { conversationId: 'c1' }, commandId: 'c1', idempotencyKey: 'k1' })),
      'RUNTIME_NOT_RUNNING',
    );
  });
});

describe('K-I04 宿主：启停生命周期', () => {
  it('start → running；重复 start 抛 RUNTIME_ALREADY_RUNNING；stop → stopped', async () => {
    const host = await createTestHost();
    expect(host.runtime.state).toBe('running');
    expect(() => host.start()).toThrowError();
    try {
      host.start();
    } catch (error) {
      expect((error as BootstrapError).code).toBe('RUNTIME_ALREADY_RUNNING');
    }

    host.stop();
    expect(host.runtime.state).toBe('stopped');
    await expectBootstrapError(
      host.submit(CALLER, makeCommand({ operation: 'create', payload: { conversationId: 'c1' }, commandId: 'c1', idempotencyKey: 'k1' })),
      'RUNTIME_NOT_RUNNING',
    );
  });
});

describe('K-I04 桥：本地 origin 门', () => {
  it('非白名单 origin 的 submit / subscribe / cancel 都被拒', async () => {
    const host = await createTestHost();
    const intruder = { origin: 'https://evil.example', kind: 'ui-webview' as const };

    await expect(host.submit(intruder, makeCommand({ payload: {} }))).rejects.toThrow();
    expect(() => host.subscribe(intruder, () => undefined)).toThrow();
    expect(() => host.cancel(intruder, 'cmd-x')).toThrow();
  });
});
