/**
 * K10 独立验证夹具 —— 手动时钟 + 各构件的便捷构造。
 *
 * 手动时钟不导出为"被测模块的一部分"，而是测试自持：K10 的三条判据（常驻预算、退避、
 * 回收时刻）都靠推时钟复现，若时钟来自被测代码，就等于"被测代码自己证明自己过了"。
 */

import { DiagnosticsLog } from '../../../apps/mobile-kernel/observability/diagnostics.js';
import { ForegroundTaskCoordinator } from '../../../apps/mobile-kernel/lifecycle/foreground-service.js';
import { MemoryNotificationPort } from '../../../apps/mobile-kernel/lifecycle/notifications.js';
import { NetworkResumeController } from '../../../apps/mobile-kernel/lifecycle/network.js';
import { TaskLedger } from '../../../apps/mobile-kernel/lifecycle/ledger.js';

export const T0 = 1_700_000_000_000;

export interface ManualClock {
  now(): number;
  advance(deltaMs: number): void;
  set(value: number): void;
}

export function createManualClock(start: number = T0): ManualClock {
  if (!Number.isSafeInteger(start)) {
    throw new TypeError(`手动时钟起始值必须是安全整数，收到 ${String(start)}`);
  }
  let current = start;
  return {
    now: () => current,
    advance(deltaMs: number): void {
      if (!Number.isSafeInteger(deltaMs) || deltaMs <= 0) {
        throw new RangeError(`时钟推进量必须是正的安全整数，收到 ${String(deltaMs)}`);
      }
      current += deltaMs;
    },
    set(value: number): void {
      if (!Number.isSafeInteger(value) || value < current) {
        throw new RangeError(`时钟只能设为不小于当前值的安全整数，收到 ${String(value)}`);
      }
      current = value;
    },
  };
}

export interface CoordinatorHarness {
  readonly clock: ManualClock;
  readonly notifications: MemoryNotificationPort;
  readonly diagnostics: DiagnosticsLog;
  readonly coordinator: ForegroundTaskCoordinator;
}

/** 常驻预算 30_000ms、长任务门槛 10_000ms —— 测试用具体值钉住语义。 */
export function newCoordinator(options?: {
  readonly budgetMs?: number;
  readonly thresholdMs?: number;
  readonly permission?: 'granted' | 'denied' | 'not-determined';
  readonly clock?: ManualClock;
}): CoordinatorHarness {
  const clock = options?.clock ?? createManualClock();
  const notifications = new MemoryNotificationPort({ permission: options?.permission ?? 'granted' });
  const diagnostics = new DiagnosticsLog({ clock });
  const coordinator = new ForegroundTaskCoordinator({
    clock,
    notifications,
    residentBudgetMs: options?.budgetMs ?? 30_000,
    foregroundThresholdMs: options?.thresholdMs ?? 10_000,
    diagnostics,
  });
  return { clock, notifications, diagnostics, coordinator };
}

export interface LedgerHarness {
  readonly clock: ManualClock;
  readonly diagnostics: DiagnosticsLog;
  readonly ledger: TaskLedger;
}

export function newLedger(options?: { readonly clock?: ManualClock }): LedgerHarness {
  const clock = options?.clock ?? createManualClock();
  const diagnostics = new DiagnosticsLog({ clock });
  const ledger = new TaskLedger({ clock, diagnostics });
  return { clock, diagnostics, ledger };
}

/** 模拟"冷启动"：从快照重放出新的账本（真机上是新进程读持久账本）。 */
export function replayLedger(snapshot: string, clock?: ManualClock): TaskLedger {
  return TaskLedger.replay(snapshot, { clock: clock ?? createManualClock() });
}

export function newNetwork(options?: {
  readonly clock?: ManualClock;
  readonly backoff?: { baseMs: number; factor: number; maxMs: number; maxAttempts: number };
}): { readonly clock: ManualClock; readonly network: NetworkResumeController } {
  const clock = options?.clock ?? createManualClock();
  const network = new NetworkResumeController({ clock, backoff: options?.backoff });
  return { clock, network };
}

/** 从抛错里取机读错误码（失败即为 `null`，测试据此断言"是预期的那个拒因"）。 */
export function errorCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export async function asyncErrorCodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
