/**
 * K10 独立验证 ②：断网等待 / 退避 / 恢复从游标继续。
 *
 * 关键断言：离线时**不允许**续跑；恢复后从台账游标继续而不是从头；重试有硬上限。
 */

import { describe, expect, it } from 'vitest';

import { newNetwork, newLedger, errorCodeOf } from './fixtures.js';

describe('K10 ② 断网与恢复', () => {
  it('离线时不安排续跑；恢复后重置退避为立即', () => {
    const { clock, network } = newNetwork({ backoff: { baseMs: 1_000, factor: 2, maxMs: 8_000, maxAttempts: 4 } });
    expect(network.state).toBe('online');

    network.suspend('A');
    expect(network.dueResumes()).toEqual(['A']);

    const off = network.setConnectivity('offline');
    expect(off).toMatchObject({ changed: true, lost: true, restored: false, state: 'offline' });
    expect(network.dueResumes()).toEqual([]);

    // 退避推进到很远，仍然因为离线而不可续跑。
    clock.advance(60_000);
    expect(network.dueResumes()).toEqual([]);

    const on = network.setConnectivity('online');
    expect(on).toMatchObject({ changed: true, lost: false, restored: true });
    expect(network.onRestore()).toEqual(['A']);
    expect(network.nextAttemptAt('A')).toBe(clock.now());
    expect(network.dueResumes()).toEqual(['A']);
  });

  it('指数退避按次数增长，达到上限即 exhausted（不无限等待）', () => {
    const { clock, network } = newNetwork({ backoff: { baseMs: 1_000, factor: 2, maxMs: 8_000, maxAttempts: 4 } });
    network.suspend('A');

    const first = network.recordAttempt('A');
    expect(first).toMatchObject({ attempts: 1, exhausted: false });
    expect(first.nextAttemptAt).toBe(clock.now() + 1_000);

    clock.advance(1_000);
    const second = network.recordAttempt('A');
    expect(second.nextAttemptAt).toBe(clock.now() + 2_000);
    expect(network.dueResumes(clock.now())).toEqual([]);
    expect(network.dueResumes(clock.now() + 2_000)).toEqual(['A']);

    clock.advance(2_000);
    const third = network.recordAttempt('A');
    expect(third.nextAttemptAt).toBe(clock.now() + 4_000);

    clock.advance(4_000);
    const fourth = network.recordAttempt('A');
    expect(fourth).toMatchObject({ attempts: 4, exhausted: true });
    expect(network.exhausted('A')).toBe(true);
    // 耗尽后不再出现在可续跑集合里 —— 调用方必须置 failed(retry_exhausted)，不能静默挂起。
    expect(network.dueResumes(clock.now() + 10_000_000)).toEqual([]);
  });

  it('maxMs 封顶退避（不会无限拉长）', () => {
    const { clock, network } = newNetwork({ backoff: { baseMs: 1_000, factor: 10, maxMs: 5_000, maxAttempts: 5 } });
    network.suspend('A');
    network.recordAttempt('A');
    clock.advance(1_000);
    const second = network.recordAttempt('A');
    expect(second.nextAttemptAt - clock.now()).toBe(5_000);
  });

  it('未知任务的尝试记录被拒（不静默创建）', () => {
    const { network } = newNetwork();
    expect(errorCodeOf(() => network.recordAttempt('ghost'))).toBe('unknown_task');
  });

  it('恢复从台账游标继续，且不重跑已完成步骤', () => {
    const { clock, ledger } = newLedger();
    const { network } = newNetwork({ clock });
    ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
    ledger.startRun('t1');
    ledger.completeStep('t1', 's1');
    ledger.completeStep('t1', 's2');
    expect(ledger.cursor('t1')).toBe(2);

    // 断网：任务进入等待（游标在台账里，不丢）。
    network.setConnectivity('offline');
    network.suspend('t1');
    expect(network.dueResumes()).toEqual([]);
    expect(ledger.cursor('t1')).toBe(2);

    // 网络恢复：从游标 2 继续，只跑 s3。
    network.setConnectivity('online');
    network.onRestore();
    expect(network.dueResumes()).toEqual(['t1']);
    const resumeFrom = ledger.cursor('t1');
    expect(resumeFrom).toBe(2);
    ledger.completeStep('t1', 's3');

    const record = ledger.getTask('t1');
    expect(record?.completedSteps).toEqual(['s1', 's2', 's3']);
    expect(new Set(record?.completedSteps ?? []).size).toBe(3); // 无重复
    expect(ledger.cursor('t1')).toBe(3);
  });
});
