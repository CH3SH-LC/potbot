/**
 * K10 网络恢复控制器 —— **断网不丢游标，恢复从游标续；重试有上限，不无限挂起**。
 *
 * ## 关掉的那个洞
 *
 * 旧后台是"轮询电脑"：手机断网时轮询失败被当成"暂无进度"，电脑恢复后照常推进——
 * 断网因此**从不需要被处理**。手机独立内核之后，断网必须显式建模，否则任务会：
 * 要么静默挂死（"看起来在跑"），要么恢复时**从头重跑**（重复外部副作用）。
 *
 * 本模块只负责**调度语义**（等待状态、退避、可续跑时机），游标本身在 `ledger.ts`。
 * 两者一起用即"恢复从游标继续"，见 `tests/mobile-kernel/K10/02-network-recovery.test.ts`。
 *
 * ## 不退化成"无限重试"
 *
 * `BackoffPolicy.maxAttempts` 是硬上限：达到即 `exhausted`，由调用方把任务置 `failed`
 * （`retry_exhausted`）。本模块**没有**"永久等待网络"的状态——那正是"无限常驻"的另一种写法。
 *
 * ## 不读墙钟
 *
 * 退避时刻由注入 `clock` 计算；测试推进时钟即可验证退避曲线，无需真的 sleep。
 */

import { LifecycleError } from './errors.js';
import { DEFAULT_BACKOFF } from './types.js';
import type { BackoffPolicy, Clock, NetworkState } from './types.js';

export interface PendingResume {
  readonly taskId: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly suspendedAt: number;
}

export interface ConnectivityChange {
  readonly changed: boolean;
  readonly lost: boolean;
  readonly restored: boolean;
  readonly state: NetworkState;
}

export interface AttemptRecord {
  readonly taskId: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly exhausted: boolean;
}

export interface NetworkResumeControllerOptions {
  readonly clock: Clock;
  readonly backoff?: BackoffPolicy;
}

export class NetworkResumeController {
  readonly #clock: Clock;
  readonly #policy: BackoffPolicy;
  #state: NetworkState = 'online';
  readonly #pending = new Map<string, PendingResume>();

  constructor(options: NetworkResumeControllerOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new LifecycleError('network_unreachable', '构造网络恢复控制器必须注入 clock');
    }
    const policy = options.backoff ?? DEFAULT_BACKOFF;
    validatePolicy(policy);
    this.#clock = options.clock;
    this.#policy = policy;
  }

  get state(): NetworkState {
    return this.#state;
  }

  get policy(): BackoffPolicy {
    return this.#policy;
  }

  /** 上报连通性变化。`restored` 为 true 时，所有等待任务的退避被**重置为立即**。 */
  setConnectivity(next: NetworkState, at?: number): ConnectivityChange {
    if (next !== 'online' && next !== 'offline') {
      throw new LifecycleError('network_unreachable', `连通性必须是 online / offline，收到 ${JSON.stringify(next)}`);
    }
    const previous = this.#state;
    this.#state = next;
    const changed = previous !== next;
    if (changed && next === 'online') {
      this.#resetBackoff(at ?? this.#clock.now());
    }
    return Object.freeze({
      changed,
      lost: changed && next === 'offline',
      restored: changed && next === 'online',
      state: next,
    });
  }

  /** 任务遇到网络错误 / 断网：进入等待。**游标由账本保存**，这里不动游标。 */
  suspend(taskId: string, at?: number): PendingResume {
    const id = requireText(taskId, 'taskId');
    const now = at ?? this.#clock.now();
    const existing = this.#pending.get(id);
    const record: PendingResume = Object.freeze({
      taskId: id,
      attempts: existing?.attempts ?? 0,
      nextAttemptAt: now,
      suspendedAt: existing?.suspendedAt ?? now,
    });
    this.#pending.set(id, record);
    return record;
  }

  /** 网络恢复：把所有等待任务的退避重置为立即，返回可续跑的任务 id（字典序）。 */
  onRestore(at?: number): readonly string[] {
    const now = at ?? this.#clock.now();
    this.#resetBackoff(now);
    return Object.freeze([...this.#pending.keys()].sort());
  }

  /**
   * 记一次续跑尝试：次数 +1，按指数退避算下次时机。达到上限即 `exhausted`。
   */
  recordAttempt(taskId: string, at?: number): AttemptRecord {
    const record = this.#pending.get(String(taskId));
    if (record === undefined) {
      throw new LifecycleError('unknown_task', `任务 ${String(taskId)} 不在网络等待队列中`);
    }
    const now = at ?? this.#clock.now();
    const attempts = record.attempts + 1;
    const delay = Math.min(this.#policy.baseMs * this.#policy.factor ** (attempts - 1), this.#policy.maxMs);
    const nextAttemptAt = now + delay;
    this.#pending.set(
      record.taskId,
      Object.freeze({ ...record, attempts, nextAttemptAt }),
    );
    return Object.freeze({ taskId: record.taskId, attempts, nextAttemptAt, exhausted: attempts >= this.#policy.maxAttempts });
  }

  /** 已经达到尝试上限（调用方据此置 `failed` 并带 `retry_exhausted`）。 */
  exhausted(taskId: string): boolean {
    const record = this.#pending.get(String(taskId));
    return record !== undefined && record.attempts >= this.#policy.maxAttempts;
  }

  attempts(taskId: string): number {
    return this.#pending.get(String(taskId))?.attempts ?? 0;
  }

  nextAttemptAt(taskId: string): number | null {
    return this.#pending.get(String(taskId))?.nextAttemptAt ?? null;
  }

  /** 任务结清 / 取消后移出等待队列。 */
  clear(taskId: string): void {
    this.#pending.delete(String(taskId));
  }

  /**
   * 此刻可以续跑的任务（在线、已到退避时刻、未耗尽；按时机再 taskId 排序）。
   * 离线时**恒为空**——断网下不允许"续跑"，只能等待（游标已由账本保存）。
   */
  dueResumes(now?: number): readonly string[] {
    if (this.#state === 'offline') {
      return Object.freeze([]);
    }
    const at = now ?? this.#clock.now();
    const due: PendingResume[] = [];
    for (const record of this.#pending.values()) {
      if (record.attempts >= this.#policy.maxAttempts) {
        continue;
      }
      if (record.nextAttemptAt <= at) {
        due.push(record);
      }
    }
    due.sort((a, b) => (a.nextAttemptAt - b.nextAttemptAt) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    return Object.freeze(due.map((r) => r.taskId));
  }

  pending(): readonly PendingResume[] {
    return Object.freeze([...this.#pending.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)));
  }

  #resetBackoff(at: number): void {
    for (const [id, record] of this.#pending) {
      this.#pending.set(id, Object.freeze({ ...record, nextAttemptAt: at }));
    }
  }
}

function validatePolicy(policy: BackoffPolicy): void {
  const ok =
    policy !== null &&
    typeof policy === 'object' &&
    Number.isSafeInteger(policy.baseMs) &&
    policy.baseMs >= 1 &&
    typeof policy.factor === 'number' &&
    Number.isFinite(policy.factor) &&
    policy.factor >= 1 &&
    Number.isSafeInteger(policy.maxMs) &&
    policy.maxMs >= policy.baseMs &&
    Number.isSafeInteger(policy.maxAttempts) &&
    policy.maxAttempts >= 1;
  if (!ok) {
    throw new LifecycleError('network_unreachable', `退避策略非法：${JSON.stringify(policy)}`);
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LifecycleError('unknown_task', `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}
