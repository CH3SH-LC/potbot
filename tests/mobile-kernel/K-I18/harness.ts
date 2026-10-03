/**
 * K-I18 夹具 —— **自己持有时钟与构造器**，驱动真实的 apps/mobile-kernel/lifecycle
 * 与 observability 模块产生**真实产物**，再把产物交给 K-I18 的 schema 校验。
 *
 * 为什么不复用 K10 的 tests/mobile-kernel/K10/fixtures.ts：本单元是**独立校验**，
 * 若夹具来自被校验方，就有"被校验代码自己证明自己过了"的味道。这里只 import 生产模块
 * 本身，时钟与端口构造由本目录自持（与 K10 的判据解耦）。
 */

import { fileURLToPath } from 'node:url';

import { TaskLedger } from '../../../apps/mobile-kernel/lifecycle/ledger.js';
import { ForegroundTaskCoordinator } from '../../../apps/mobile-kernel/lifecycle/foreground-service.js';
import { MemoryNotificationPort } from '../../../apps/mobile-kernel/lifecycle/notifications.js';
import { NetworkResumeController } from '../../../apps/mobile-kernel/lifecycle/network.js';
import { DiagnosticsLog } from '../../../apps/mobile-kernel/observability/diagnostics.js';
import { loadSchemaDocument, resolveRef, type JsonSchema } from './validator.js';

export const T0 = 1_700_000_000_000;

export interface ManualClock {
  now(): number;
  advance(deltaMs: number): void;
}

export function manualClock(start: number = T0): ManualClock {
  if (!Number.isSafeInteger(start)) throw new TypeError(`手动时钟起始值必须是安全整数，收到 ${String(start)}`);
  let current = start;
  return {
    now: () => current,
    advance(deltaMs: number): void {
      if (!Number.isSafeInteger(deltaMs) || deltaMs <= 0) {
        throw new RangeError(`时钟推进量必须是正的安全整数，收到 ${String(deltaMs)}`);
      }
      current += deltaMs;
    },
  };
}

/** 被校验 schema 文档的绝对路径（本目录 lifecycle.schema.json）。 */
export function lifecycleSchemaPath(): string {
  return fileURLToPath(new URL('./lifecycle.schema.json', import.meta.url));
}

/** 已注册的 wire 契约 schema（只读引用，断言词表漂移用）。 */
export function contractSchemaPath(): string {
  return fileURLToPath(new URL('../../../contracts/mobile-v1/schemas/lifecycle-plan.schema.json', import.meta.url));
}

export function loadLifecycleSchema(): JsonSchema {
  return loadSchemaDocument(lifecycleSchemaPath());
}

export function loadContractSchema(): JsonSchema {
  return loadSchemaDocument(contractSchemaPath());
}

/** 取出某个 `$defs` 词表的 enum 数组（缺 enum 即抛，避免"读不到却当空"）。 */
export function enumOf(doc: JsonSchema, ref: string): readonly unknown[] {
  const node = resolveRef(ref, doc);
  if (typeof node === 'boolean') throw new Error(`${ref} 指向布尔 schema，不含 enum`);
  const value = node['enum'];
  if (!Array.isArray(value)) throw new Error(`${ref} 没有 enum 数组`);
  return value;
}

// ---------------------------------------------------------------------------
// 真实模块构造
// ---------------------------------------------------------------------------

export interface LedgerHarness {
  readonly clock: ManualClock;
  readonly diagnostics: DiagnosticsLog;
  readonly ledger: TaskLedger;
}

export function newLedger(clock: ManualClock = manualClock()): LedgerHarness {
  const diagnostics = new DiagnosticsLog({ clock });
  const ledger = new TaskLedger({ clock, diagnostics });
  return { clock, diagnostics, ledger };
}

export interface CoordinatorHarness {
  readonly clock: ManualClock;
  readonly notifications: MemoryNotificationPort;
  readonly diagnostics: DiagnosticsLog;
  readonly coordinator: ForegroundTaskCoordinator;
}

export function newCoordinator(options?: {
  readonly budgetMs?: number;
  readonly thresholdMs?: number;
  readonly permission?: 'granted' | 'denied' | 'not-determined';
  readonly clock?: ManualClock;
}): CoordinatorHarness {
  const clock = options?.clock ?? manualClock();
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

export function newNetwork(options?: {
  readonly clock?: ManualClock;
  readonly backoff?: { readonly baseMs: number; readonly factor: number; readonly maxMs: number; readonly maxAttempts: number };
}): { readonly clock: ManualClock; readonly network: NetworkResumeController } {
  const clock = options?.clock ?? manualClock();
  const network = new NetworkResumeController({ clock, backoff: options?.backoff });
  return { clock, network };
}
