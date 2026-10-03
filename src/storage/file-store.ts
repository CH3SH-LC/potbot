/**
 * 存储的具体实现之二：**可落盘、跨进程、跨重启**的事务化文件存储
 * （design-06-P5 / KRN-10；合同 R214–R220）。
 *
 * ## 为什么单开一份实现而不是"把 Map 存下来"
 *
 * R220 的原话是「**不把 Map 落库称为完整恢复**」。所以本实现的判据不是
 * "有个文件"，而是下面三条**可被负例打红**的性质：
 *
 * 1. **提交原子**：一次事务要么整体可见、要么整体不可见，绝无半截状态；
 * 2. **跨进程互斥**：两个工作进程并发写不会互相覆盖（R218 的"原子领取/续租/完成"）；
 * 3. **崩溃窗口有定义**：每个崩溃点丢什么、重启后看到什么，都能逐点说清（R215）。
 *
 * ## 崩溃窗口（R215，**逐点定义**）
 *
 * 提交一次事务的物理步骤与各自的崩溃后果：
 *
 * | 崩溃点 | 磁盘上有什么 | 重启后读到 | 调用方该报告什么 |
 * |---|---|---|---|
 * | ① 加锁前 / 事务体抛错 | 上一版 `store.json` | 上一版状态 | `PersistenceError`（**未接受**） |
 * | ② 写完 `store.json.tmp`（未 fsync） | 上一版 + 残留 tmp | **上一版** | 同上（tmp 是垃圾，永不采纳） |
 * | ③ fsync 完 tmp，rename 前 | 上一版 + 完整 tmp | **上一版** | 同上 |
 * | ④ rename 之后、`afterCommitBeforePublish` 抛错 | 新版 | **新版** | `PublicationError`（**已接受**，事件在 outbox，走 `replayUndelivered()`） |
 * | ⑤ rename 之后、进程硬退出 | 新版 | **新版** | 无从报告；重启后 `pendingDeliveryEvents()` 能取回未投递事件 |
 *
 * 关键不变式：**磁盘永远不落后于内存**——先落盘、再改内存。因此任何时刻崩溃，
 * 重启读到的都不会是"比已确认的更旧"的状态；而"比已确认的更新"只发生在
 * 调用方还没拿到返回值的窗口里（那一笔是否算数，由 outbox 的 `delivered` 标记收口）。
 *
 * **残留 `.tmp` 是设计的一部分**：②③ 崩溃会留下完整但**从未提交**的 tmp。
 * 加载时一律忽略它并如实记入 `LoadReport.orphanTemporary`——绝不"见到 tmp 就当已提交"。
 *
 * ## 跨进程互斥
 *
 * 写路径用 `<file>.lock` 目录项做**排他创建**（`openSync(..., 'wx')`）——
 * 这是文件系统级的原子操作，不是 `Map` / Promise 链那种进程内假锁（R215 明文禁止）。
 * 持锁期间：重读磁盘 → 应用事务体 → 原子落盘。于是并发写的语义是
 * **读已提交 + 后写者基于最新状态**，不会丢更新。
 *
 * 陈旧锁（持锁进程崩溃）按 mtime 超时打破，并在 `LoadReport`/返回值里如实标注。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  asLogicalTime,
  PersistenceError,
  PublicationError,
  type DeliveryHandler,
  type EventId,
  type LogicalTime,
  type MutableStoreFaultHooks,
  type PendingEvent,
  type RunId,
  type StorageTransaction,
  type Store,
  type StoreSnapshot,
} from '../protocol/index.js';

import {
  cloneState,
  decodeStoreState,
  emptyState,
  encodeStoreState,
  markDeliveredIn,
  pendingEventsOf,
  snapshotOf,
  TouchTracker,
  TransactionView,
  type StoreState,
} from './store-core.js';

/** 提交失败时的结构化原因（**如实区分**"没写成功"与"写了但没发布"）。 */
export type FileStoreFailureReason =
  | 'lock_timeout'
  | 'lock_io_error'
  | 'persist_failed'
  | 'transaction_aborted';

/** 一次加载的**如实**自检报告。启动方应当把它接进 boot 输出，而不是丢掉。 */
export interface LoadReport {
  /** 文件是否存在（不存在 = 全新运行目录，不是错误）。 */
  readonly filePresent: boolean;
  /** 是否真的把一份状态读进了内存。 */
  readonly loaded: boolean;
  /** 人可读原因；成功时也给出可复核的计数摘要。 */
  readonly reason: string;
  /** 发现了**从未提交**的残留 tmp（②③ 崩溃的痕迹）；已忽略，不影响结论。 */
  readonly orphanTemporary: boolean;
  /** 加载后发现被判定为陈旧而打破的锁（上一次持锁进程崩了）。 */
  readonly brokeStaleLock: boolean;
  /** 读进来的各集合条数（成功时用于逐项核对；失败时全 0）。 */
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * **落盘层**专属接缝，与 `src/protocol` 的 `MutableStoreFaultHooks` 分开：
 * 协议接缝表达"事务语义的三个点"，本接缝表达"物理写入的三个点"。
 * 分开的理由：协议由总协调独占，落盘细节不该改写协议文件的语义。
 * 与协议接缝一样，**默认全部未设置**，只在隔离测试里赋值。
 */
export interface FileStoreHooks {
  /** 临时文件写完、rename 之前。测试可在此硬退出以复现崩溃点 ③。 */
  readonly beforeRename?: (temporary: string, target: string) => void;
  /** rename 之后、内存状态替换之前。复现崩溃点 ④/⑤。 */
  readonly afterRename?: (target: string) => void;
}

export interface FileStoreOptions {
  /** 状态文件路径。父目录不存在会自动创建。 */
  readonly filePath: string;
  /**
   * **墙钟**读取口（毫秒，Unix epoch）——与 `clock` 是两回事，刻意分开：
   * `clock` 是内核的**逻辑**时间（确定性场景，`LogicalTime`）；
   * `now` 是 OS 层的**真实**时间，只用于跨进程锁的新鲜度与超时。
   *
   * **为什么是必填、且此处没有默认值**：合同 R50.4 禁止 `src/**` 调用墙钟
   * （`Date.now()` / `new Date()` / `process.pid` 都是禁用 token）。若本文件给个
   * "默认 `() => Date.now()`"，那默认值本身就会把整条纪律破掉。
   * 因此把选择权**上推给宿主**：生产默认实现在 `apps/demo/server/main.ts`
   * （`apps/**` 不在内核纪律的扫描范围内），测试各自注入自己的可控时钟。
   */
  readonly now: () => number;
  /**
   * 锁持有者标识（写进锁文件，用于"谁持锁 + 何时取的"）。
   * 同样必填：进程身份属于 OS 层概念（`process.pid` 是禁用 token），由宿主给出。
   */
  readonly lockOwner: string;
  /** 逻辑时钟读取口（Q8-a：存储不自行推进时间）。默认恒为 0。 */
  readonly clock?: () => LogicalTime;
  /** 协议级故障接缝（默认关闭）。 */
  readonly faults?: MutableStoreFaultHooks;
  /** 落盘级故障接缝（默认关闭）。 */
  readonly hooks?: FileStoreHooks;
  /** 取锁最长等待，毫秒。超时抛 `PersistenceError('lock_timeout')`。默认 10000。 */
  readonly lockTimeoutMs?: number;
  /** 陈旧锁判定阈值，毫秒。默认 30000。 */
  readonly lockStaleMs?: number;
  /**
   * 载入时的**不完整数据处理策略**。
   * - `'fail'`（默认）：文件存在但读不回来 ⇒ **抛错拒绝启动**。
   * - `'start-empty'`：明确表示"放弃这份状态重新开始"，同时在报告里记明丢弃了什么。
   *
   * 默认选 `fail` 的理由：静默按空台账启动会把"数据读丢了"伪装成"服务正常"，
   * 正是 R216/R240 那一类陷阱。
   */
  readonly onUnreadable?: 'fail' | 'start-empty';
}

export interface FileStore extends Store {
  readonly filePath: string;
  /** 最近一次加载/落盘后的如实报告（启动方应打印它）。 */
  loadReport(): LoadReport;
  /** 强制从磁盘重读（跨进程读新鲜度用；写路径本就会重读）。 */
  refresh(): LoadReport;
  /** 当前状态文件字节数（诊断用；文件不存在返回 0）。 */
  sizeBytes(): number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

/** 同步睡眠。`Atomics.wait` 在 Node 主线程可用，且不占 CPU。 */
function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function countsOf(state: StoreState): Readonly<Record<string, number>> {
  return Object.freeze({
    tasks: state.tasks.size,
    task_control_states: state.taskControlStates.size,
    messages: state.messages.size,
    inbox_entries: state.inboxEntries.length,
    read_receipts: state.readReceipts.length,
    actionable_inputs: state.actionableInputs.size,
    work_items: state.workItems.size,
    instances: state.instances.size,
    group_members: state.groupMembers.size,
    runs: state.runs.size,
    delivery_events: state.deliveryEvents.size,
    kernel_events: state.kernelEvents.length,
    artifacts: state.artifacts.size,
    shared_facts: state.sharedFacts.size,
  });
}

class FileStoreImpl implements FileStore {
  readonly filePath: string;
  readonly faults: MutableStoreFaultHooks;

  readonly #temporaryPath: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  readonly #lockOwner: string;
  readonly #clock: () => LogicalTime;
  readonly #hooks: FileStoreHooks;
  readonly #lockTimeoutMs: number;
  readonly #lockStaleMs: number;
  readonly #unreadablePolicy: 'fail' | 'start-empty';

  #state: StoreState = emptyState();
  #inTransaction = false;
  #report: LoadReport;
  /** 上次读写后的文件指纹，用于判断"别的进程是否改过"。 */
  #fingerprint: string | null = null;

  constructor(options: FileStoreOptions) {
    this.filePath = options.filePath;
    this.#temporaryPath = `${options.filePath}.tmp`;
    this.#lockPath = `${options.filePath}.lock`;
    this.#now = options.now;
    this.#lockOwner = options.lockOwner;
    this.#clock = options.clock ?? (() => asLogicalTime(0));
    this.faults = options.faults ?? {};
    this.#hooks = options.hooks ?? {};
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.#unreadablePolicy = options.onUnreadable ?? 'fail';
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.#report = this.#load(true);
  }

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  #load(initial: boolean): LoadReport {
    const orphanTemporary = existsSync(this.#temporaryPath);
    let brokeStaleLock = false;

    // 启动时若发现锁文件残留，说明上一个持锁进程没走到释放那一步。
    // **不盲删**：先按陈旧阈值判定，只有确实陈旧才打破并如实记录。
    if (existsSync(this.#lockPath) && initial) {
      brokeStaleLock = this.#breakStaleLockIfAny();
    }

    if (!existsSync(this.filePath)) {
      this.#state = emptyState();
      this.#fingerprint = null;
      return Object.freeze({
        filePresent: false,
        loaded: false,
        reason: '状态文件不存在：按全新运行目录处理（空状态，非错误）',
        orphanTemporary,
        brokeStaleLock,
        counts: countsOf(this.#state),
      });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    } catch (error) {
      return this.#handleUnreadable(`状态文件不是合法 JSON（${describeThrown(error)}）`, orphanTemporary, brokeStaleLock);
    }

    const decoded = decodeStoreState(raw);
    if (!decoded.ok) {
      return this.#handleUnreadable(decoded.reason, orphanTemporary, brokeStaleLock);
    }

    this.#state = decoded.state;
    this.#fingerprint = this.#fingerprintOf();
    return Object.freeze({
      filePresent: true,
      loaded: true,
      reason:
        `已从磁盘加载内核状态：任务 ${String(this.#state.tasks.size)}、消息 ${String(this.#state.messages.size)}、` +
        `轮次 ${String(this.#state.runs.size)}、待投递事件 ${String(pendingEventsOf(this.#state).length)}`,
      orphanTemporary,
      brokeStaleLock,
      counts: countsOf(this.#state),
    });
  }

  #handleUnreadable(reason: string, orphanTemporary: boolean, brokeStaleLock: boolean): LoadReport {
    if (this.#unreadablePolicy === 'fail') {
      // **拒绝启动**：把"读不回来"如实抛给启动方，而不是静默清空。
      this.#state = emptyState();
      throw new PersistenceError(
        `拒绝以空状态启动：${reason}。文件 ${this.filePath} 存在但无法还原；` +
          '若确认要放弃这份状态重新开始，请显式传 onUnreadable: "start-empty"（或在启动前移走该文件）。',
      );
    }
    this.#state = emptyState();
    this.#fingerprint = null;
    return Object.freeze({
      filePresent: true,
      loaded: false,
      reason: `按 onUnreadable:"start-empty" 显式放弃既有状态：${reason}`,
      orphanTemporary,
      brokeStaleLock,
      counts: countsOf(this.#state),
    });
  }

  loadReport(): LoadReport {
    return this.#report;
  }

  refresh(): LoadReport {
    this.#report = this.#load(false);
    return this.#report;
  }

  sizeBytes(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // 跨进程锁
  // -------------------------------------------------------------------------

  #fingerprintOf(): string | null {
    try {
      const info = statSync(this.filePath);
      return `${String(info.size)}:${String(info.mtimeMs)}`;
    } catch {
      return null;
    }
  }

  /** 磁盘被别人改过就重读（读侧新鲜度；写侧本来就会持锁重读）。 */
  #reloadIfChanged(): void {
    const current = this.#fingerprintOf();
    if (current !== this.#fingerprint) {
      this.refresh();
    }
  }

  #breakStaleLockIfAny(): boolean {
    try {
      const info = statSync(this.#lockPath);
      // `mtimeMs` 是**文件系统给的元数据**，不是墙钟调用（R50.4 的禁用 token 里没有它）；
      // 真正的"现在"来自注入的 `#now`。
      const age = this.#now() - info.mtimeMs;
      if (age > this.#lockStaleMs) {
        rmSync(this.#lockPath, { force: true });
        return true;
      }
    } catch {
      // 锁在判定过程中消失了：那就是已被释放，什么也不用做。
    }
    return false;
  }

  /** 取排他锁。返回释放函数；失败抛 `PersistenceError`。 */
  #acquireLock(): () => void {
    const deadline = this.#now() + this.#lockTimeoutMs;
    // 锁文件内容回答两个问题："谁持锁"（owner）与"何时取的"（at，注入墙钟的毫秒值）。
    // 不写进程 id / ISO 字符串：二者都要 OS 层信息，而本文件在纪律扫描范围内。
    const payload = JSON.stringify({ owner: this.#lockOwner, at: this.#now() });
    for (;;) {
      try {
        const fd = openSync(this.#lockPath, 'wx');
        try {
          writeSync(fd, payload);
        } finally {
          closeSync(fd);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          rmSync(this.#lockPath, { force: true });
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw new PersistenceError(
            `取写锁失败（${describeThrown(error)}）：本次事务未提交（未接受）`,
            { cause: error },
          );
        }
        // 锁被别人持有：先看是不是死锁，不是就等一会儿再试。
        if (this.#breakStaleLockIfAny()) {
          continue;
        }
        if (this.#now() >= deadline) {
          throw new PersistenceError(
            `等待写锁超时（${String(this.#lockTimeoutMs)}ms）：文件 ${this.filePath} 正被另一个进程写入。` +
              '本次事务未提交（未接受），调用方不得报告已接受。',
            { cause: error },
          );
        }
        sleepSync(5);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 物理落盘
  // -------------------------------------------------------------------------

  /**
   * 原子写：tmp → fsync → rename。**返回即表示已提交**。
   * 任何一步失败都抛 `PersistenceError`（未接受），且**不动内存状态**。
   */
  #persist(state: StoreState): void {
    try {
      writeFileSync(this.#temporaryPath, `${JSON.stringify(encodeStoreState(state))}\n`, 'utf8');
      // 先把 tmp 的内容刷到稳定介质，再 rename：否则 ④ 之后断电可能只剩名字没有内容。
      const fd = openSync(this.#temporaryPath, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.#hooks.beforeRename?.(this.#temporaryPath, this.filePath);
      renameSync(this.#temporaryPath, this.filePath);
      this.#hooks.afterRename?.(this.filePath);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        `落盘失败（${describeThrown(error)}）：事务未提交（未接受）。` +
          '内存状态保持不变，磁盘仍是上一版；残留的 .tmp 不会被采纳。',
        { cause: error },
      );
    }
    this.#fingerprint = this.#fingerprintOf();
  }

  // -------------------------------------------------------------------------
  // Store 接口
  // -------------------------------------------------------------------------

  transact<T>(work: (tx: StorageTransaction) => T): T {
    if (this.#inTransaction) {
      throw new PersistenceError('不支持嵌套事务：请把写入合并到同一个 transact() 调用内');
    }
    this.#inTransaction = true;
    // 取锁失败（超时/IO）也必须复位 inTransaction——否则 store 会永久卡在
    // "嵌套事务"状态，之后每一次写入都被误拒。这是本文件被跨进程用例抓出来的缺陷。
    let release: () => void;
    try {
      release = this.#acquireLock();
    } catch (error) {
      this.#inTransaction = false;
      throw error;
    }
    let result: T;
    let summary;
    try {
      // 持锁重读：并发写的正确性建立在"基于最新状态"之上（否则会丢更新）。
      this.refresh();
      const draft = cloneState(this.#state);
      const touched = new TouchTracker();
      const tx = new TransactionView(draft, touched);

      try {
        result = work(tx);
      } catch (error) {
        throw error instanceof PersistenceError
          ? error
          : new PersistenceError('事务回滚：未提交任何改动（未接受）', { cause: error });
      }

      summary = touched.summary();
      try {
        this.faults.beforeCommit?.(summary, tx);
      } catch (error) {
        throw new PersistenceError('提交前故障注入：事务未提交（未接受）', { cause: error });
      }

      // 关键顺序：**先落盘、再改内存**。这样任何时刻崩溃，磁盘都不落后于内存。
      this.#persist(draft);
      this.#state = draft;
    } finally {
      this.#inTransaction = false;
      release();
    }

    // 接缝 2 与内存实现同义：**提交已生效**（磁盘 + 内存），但事件仍待投递。
    // 锁已释放——恢复路径不应被锁超时再打断一次。
    try {
      this.faults.afterCommitBeforePublish?.(summary);
    } catch (error) {
      throw new PublicationError(
        '事务已提交（已落盘，消息已可靠保存），但发布前中断：待投递事件可由 replayUndelivered() 恢复',
        this.pendingIds(),
        { cause: error },
      );
    }

    return result;
  }

  snapshot(): StoreSnapshot {
    this.#reloadIfChanged();
    return snapshotOf(this.#state);
  }

  pendingDeliveryEvents(): readonly PendingEvent[] {
    this.#reloadIfChanged();
    return pendingEventsOf(this.#state);
  }

  markDelivered(eventIds: readonly EventId[], at?: LogicalTime): number {
    if (eventIds.length === 0) return 0;
    const stamp = at ?? this.#clock();
    const release = this.#acquireLock();
    try {
      this.refresh();
      const draft = cloneState(this.#state);
      const changed = markDeliveredIn(draft, eventIds, stamp);
      // 已投递标记**必须落盘**：否则重启后这批事件会被当成"未投递"重放。
      if (changed > 0) {
        this.#persist(draft);
        this.#state = draft;
      }
      return changed;
    } finally {
      release();
    }
  }

  publishPending(handler: DeliveryHandler): readonly PendingEvent[] {
    const pending = [...this.pendingDeliveryEvents()];
    const published: PendingEvent[] = [];
    for (const event of pending) {
      try {
        this.faults.beforePublishEvent?.(event);
        handler(event);
      } catch (error) {
        throw new PublicationError(
          `投递事件 ${event.event_id} 失败：事务已提交（已接受），事件仍待投递`,
          this.pendingIds(),
          { cause: error },
        );
      }
      this.markDelivered([event.event_id]);
      published.push(event);
    }
    return Object.freeze(published);
  }

  replayUndelivered(handler: DeliveryHandler): readonly PendingEvent[] {
    return this.publishPending(handler);
  }

  reset(): void {
    const release = this.#acquireLock();
    try {
      rmSync(this.filePath, { force: true });
      rmSync(this.#temporaryPath, { force: true });
      this.#state = emptyState();
      this.#fingerprint = null;
      this.#report = Object.freeze({
        filePresent: false,
        loaded: false,
        reason: '已显式 reset()：状态文件与内存状态一并清空',
        orphanTemporary: false,
        brokeStaleLock: false,
        counts: countsOf(this.#state),
      });
    } finally {
      release();
    }
  }

  private pendingIds(): readonly EventId[] {
    return Object.freeze(this.pendingDeliveryEvents().map((event) => event.event_id));
  }
}

/**
 * 构造可落盘的持久存储。
 *
 * 构造即加载：文件不存在按空状态起（并如实报告），文件存在但读不回来则**默认抛错**。
 */
export function createFileStore(options: FileStoreOptions): FileStore {
  return new FileStoreImpl(options);
}

/** 未使用但保留导出，便于调用方判断"这个错误是否属于落盘路径"。 */
export { PersistenceError as FileStorePersistenceError };

/** 供测试清理：**只在确认无其他进程持锁时**调用。 */
export function __deleteStoreFiles(filePath: string): void {
  for (const path of [filePath, `${filePath}.tmp`, `${filePath}.lock`]) {
    try {
      unlinkSync(path);
    } catch {
      // 不存在即目标状态。
    }
  }
}
