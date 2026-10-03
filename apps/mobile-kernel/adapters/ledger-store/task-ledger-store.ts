/**
 * K-I08 账本持久化适配层 —— **K10 `TaskLedger` 的落盘/冷启动恢复**。
 *
 * 对应 K10 的集成请求："expose a read/write blob port so `TaskLedger.snapshot()`/`replay()`
 * persist across process death on the phone; treat a read failure as an error (invalid_snapshot …)"。
 *
 * ## 这一层为什么几乎不用自己造轮子
 *
 * K10 的 `TaskLedger` 已经把恢复判据钉死：`snapshot()` 产出**只追加日志**，
 * `TaskLedger.replay()` 由日志重建视图，并且对"空串 / 非 JSON / 版本不符 / 序号乱序 /
 * 引用了不存在的任务"**一律抛 `invalid_snapshot`**。因此本适配器**只**做两件事：
 *
 * 1. 把 `snapshot()` 的字符串**原样**封进信封写进 blob；
 * 2. 冷启动时读出 blob，交回 `TaskLedger.replay()`——**不自己解析日志、不自己宽松兜底**。
 *
 * 于是"坏快照不得当空账本"的保证由 K10 的判据 + 信封校验**两层**共同兜住：信封碰坏的、
 * 负载碰坏的，都抛 `invalid_snapshot`；只有 blob 真的**不存在**（`not_found`）才返回 `null`
 * （干净的首次运行）。
 */

import { TaskLedger, type TaskLedgerOptions } from '../../lifecycle/ledger.js';
import { isLedgerStoreError, invalidSnapshot, LedgerStoreError } from './errors.js';
import { LedgerBlobStore } from './blob-port.js';
import { decodeEnvelope, encodeEnvelope } from './snapshot-envelope.js';

/** 任务账本在持久化介质上的相对路径。 */
export const TASK_LEDGER_KEY = 'ledgers/task-ledger.v1.json';

export class TaskLedgerStore {
  readonly #blob: LedgerBlobStore;

  constructor(blob: LedgerBlobStore) {
    this.#blob = blob;
  }

  get key(): string {
    return this.#blob.key;
  }

  /** 把当前账本的只追加日志封进信封落盘。 */
  async save(ledger: TaskLedger): Promise<void> {
    const payload = ledger.snapshot();
    await this.#blob.save(encodeEnvelope('task', payload));
  }

  /**
   * 冷启动恢复。
   *
   * - blob 不存在 ⇒ `null`（干净起点，调用方自行 {@link newTaskLedger}）；
   * - blob 存在但信封/负载任何一处损坏 ⇒ 抛 `invalid_snapshot`，**绝不返回空账本**。
   */
  async load(options: TaskLedgerOptions): Promise<TaskLedger | null> {
    const text = await this.#blob.load();
    if (text === null) {
      return null;
    }
    const payload = decodeEnvelope(text, 'task');
    return replayTaskLedger(payload, options);
  }
}

/** 工厂：一个 K09 `StoragePort` 上的任务账本存储。 */
export function createTaskLedgerStore(
  /** 窄 blob 端口或已构造好的 {@link LedgerBlobStore}。 */
  blob: LedgerBlobStore,
): TaskLedgerStore {
  return new TaskLedgerStore(blob);
}

/**
 * 只把 `TaskLedger.replay()` 的错误**归一**成本层的 `invalid_snapshot`（保留原判据的
 * 文字），其余错误原样上抛。归一化的目的：调用方只需 catch 一种错误类型即可确保
 * "读到坏快照就停下"，不会因为忘了 catch `LifecycleError` 而把坏快照漏成空账本。
 */
export function replayTaskLedger(payload: unknown, options: TaskLedgerOptions): TaskLedger {
  try {
    return TaskLedger.replay(typeof payload === 'string' ? payload : JSON.stringify(payload), options);
  } catch (error) {
    if (isLifecycleInvalidSnapshot(error)) {
      throw invalidSnapshot('malformed', `任务账本快照重放失败：${error.message}`);
    }
    throw error;
  }
}

function isLifecycleInvalidSnapshot(error: unknown): error is { code: 'invalid_snapshot'; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'invalid_snapshot' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/** 便于测试：断言某个错误是本层 `invalid_snapshot`（或 K10 的同码错误）。 */
export function assertInvalidSnapshot(error: unknown): void {
  if (isLedgerStoreError(error)) {
    if (error.code !== 'invalid_snapshot') {
      throw new Error(`期望 invalid_snapshot，实际是 ${error.code}`);
    }
    return;
  }
  if (!isLifecycleInvalidSnapshot(error)) {
    throw new Error(`期望 invalid_snapshot，实际收到 ${String(error)}`);
  }
}

/** 空任务账本的便捷构造（与 K10 夹具同构，但不依赖测试目录）。 */
export function newTaskLedger(options: TaskLedgerOptions): TaskLedger {
  return new TaskLedger(options);
}

export { LedgerStoreError };
