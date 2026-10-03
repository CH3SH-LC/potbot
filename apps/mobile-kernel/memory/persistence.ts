/**
 * K08 手机记忆线 —— **持久化端口**：把「读失败」与「空库」在类型上分开。
 *
 * ## 端口职责与 K09 的边界
 *
 * 本包**不**拥有通用字节/文件端口（那是 K09 的 StoragePort，见
 * `apps/mobile-kernel/storage/`）。记忆线只需要一个**窄**的键值持久化口：
 * 按 key 读一段字符串、写一段字符串、删一个 key。真实实现由集成人接到 K09
 * 存储 / SAF / 原生目录；本包提供内存后端与故障注入，用于独立验证。
 *
 * ## 核心：`read()` 的**三值**返回
 *
 * ```
 * read(key) -> { kind:'ok', bytes }         // 读到了
 *            | { kind:'not_found' }         // 这个 key 从来没写过 —— 这才是"空库"
 *            | { kind:'failed', reason, detail } // 读不动（IO 错、介质坏、权限…）—— 不是空库
 * ```
 *
 * **`not_found` 与 `failed` 是两件事**：前者是"确实没有记忆"，后者是"我们不知道有没有记忆"。
 * 把后者当成前者，正是 K08 明令禁止的「读失败当空库」。端口把这条区分**上推到类型层**，
 * 于是上层（`store.ts`）不可能在 `failed` 分支上顺手 `?? new Map()` 造一个空库。
 *
 * 纯内存后端 + 可注入故障：零 IO、不含墙钟、不含随机数。
 */

import { MemoryPersistenceError } from './errors.js';
import type { MemoryLoadFailure } from './types.js';

/** 记忆库在持久化介质上的默认 key（真实实现可换；测试用固定 key 断言）。 */
export const DEFAULT_MEMORY_KEY = 'memory/phone-store.v1.json';

// ---------------------------------------------------------------------------
// 读 / 写结果
// ---------------------------------------------------------------------------

/** 读操作的三值结果（**这是全包最关键的一个类型**）。 */
export type PersistenceReadOutcome =
  | { readonly kind: 'ok'; readonly bytes: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failed'; readonly reason: MemoryLoadFailure; readonly detail: string };

/** 写 / 删的结果。 */
export type PersistenceWriteOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly detail: string };

/** 窄持久化端口：真实实现由集成人接到 K09 / SAF / 原生目录。 */
export interface MemoryPersistencePort {
  read(key: string): Promise<PersistenceReadOutcome>;
  write(key: string, bytes: string): Promise<PersistenceWriteOutcome>;
  remove(key: string): Promise<PersistenceWriteOutcome>;
}

// ---------------------------------------------------------------------------
// 内存后端（独立验证用）
// ---------------------------------------------------------------------------

/** 可注入的故障（默认全部关闭）。 */
export interface MemoryPersistenceFaults {
  /** 下一次 `read` 报读失败（`kind:'failed'`）。抛错也会被归一成读失败。 */
  failRead?: { readonly reason?: MemoryLoadFailure; readonly detail?: string } | boolean;
  /** 下一次 `write` 报写失败。 */
  failWrite?: { readonly detail?: string } | boolean;
  /** 读成功但内容被损坏（如截断的 JSON）——用"present but corrupt"验证**空库与损坏可区分**。 */
  corruptBytes?: string;
  /** 模拟"介质上根本没有这个 key"（默认行为，无需注入）。 */
  keyAbsent?: boolean;
}

/** 内存持久化后端：注入故障，供独立测试驱动各条分支。 */
export class MemoryPersistenceBackend implements MemoryPersistencePort {
  private readonly store = new Map<string, string>();
  private faults: MemoryPersistenceFaults;
  /** 诊断计数（只读；测试可断言"确实读了一次"）。 */
  readonly calls = { read: 0, write: 0, remove: 0 };

  constructor(initial?: { readonly key: string; readonly bytes: string }, faults: MemoryPersistenceFaults = {}) {
    if (initial !== undefined) {
      this.store.set(initial.key, initial.bytes);
    }
    this.faults = faults;
  }

  /** 运行中更新注入故障（每个用例可复用同一个后端驱动多条分支）。 */
  setFaults(faults: MemoryPersistenceFaults): void {
    this.faults = faults;
  }

  async read(key: string): Promise<PersistenceReadOutcome> {
    this.calls.read += 1;
    const fault = this.faults.failRead;
    if (fault !== undefined && fault !== false) {
      return {
        kind: 'failed',
        reason: (typeof fault === 'object' ? fault.reason : undefined) ?? 'read_failed',
        detail: (typeof fault === 'object' ? fault.detail : undefined) ?? '注入的读失败（介质不可达）',
      };
    }
    if (this.faults.corruptBytes !== undefined) {
      return { kind: 'ok', bytes: this.faults.corruptBytes };
    }
    const found = this.store.get(key);
    if (found === undefined) {
      return { kind: 'not_found' };
    }
    return { kind: 'ok', bytes: found };
  }

  async write(key: string, bytes: string): Promise<PersistenceWriteOutcome> {
    this.calls.write += 1;
    const fault = this.faults.failWrite;
    if (fault !== undefined && fault !== false) {
      return {
        kind: 'failed',
        detail: (typeof fault === 'object' ? fault.detail : undefined) ?? '注入的写失败（介质满）',
      };
    }
    this.store.set(key, bytes);
    return { kind: 'ok' };
  }

  async remove(key: string): Promise<PersistenceWriteOutcome> {
    this.calls.remove += 1;
    this.store.delete(key);
    return { kind: 'ok' };
  }

  /** 直读当前落盘字节（测试用；不经过故障注入）。 */
  peek(key: string): string | undefined {
    return this.store.get(key);
  }
}

/**
 * 端口常量断言：端口实现若把 `read` 的返回收窄成 `string | undefined`（丢掉三值区分），
 * 本函数会在类型层报错。运行时它只是把端口原样返回，供 `store.ts` 复用。
 */
export function assertThreeValuedRead(port: MemoryPersistencePort): MemoryPersistencePort {
  return port;
}

/** 抛一个稳定的"端口不可用"错误（不给空库）。 */
export function unavailable(port: MemoryPersistencePort): never {
  throw new MemoryPersistenceError(
    'store_unavailable',
    '记忆持久化端口不可用：拒绝以空库继续（读失败 ≠ 空库，K08 红线）',
  );
}
