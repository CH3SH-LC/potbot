/**
 * M-R04 网络状态模型 —— **手机网络切换**（零依赖、注入时钟）。
 *
 * ## 为什么需要它（MEITUAN.md M-R04：网络切换）
 *
 * "掉线 → 换网 → 回网"是手机最常见的外部扰动，却没有任何模块建模它。两条纪律：
 *
 * 1. **离线时不得发出**：掉线时"发送"必须变成"没发出"（可安全续发），
 *    绝不能变成一个"发出后未知"——那会凭空制造一次"可能已下单"。
 * 2. **回网不等于重发**：`generation` 让"切过网"成为可机读事实；重连后的
 *    正确动作由 {@link ../recovery.js planSubmitRecovery} 决定，通常先查原单。
 *
 * ## 可观测量
 *
 * - `generation`：切换代数（每次变更 +1）；
 * - `transitions`：切换明细（from / to / at / generation）——证据。
 *
 * ## 确定性
 *
 * 监听回调与 `waitForOnline` 都由**显式 `setKind` 调用**驱动，不使用任何定时器。
 */

import type { NetworkKind, NetworkSnapshot, ResilienceClock } from './types.js';

/** 网络类型 → 是否按流量计费。 */
function meteredOf(kind: NetworkKind): boolean {
  return kind === 'cellular';
}

/** 网络类型 → 是否在线。 */
export function isOnlineKind(kind: NetworkKind): boolean {
  return kind !== 'none';
}

export interface NetworkTransition {
  readonly from: NetworkKind;
  readonly to: NetworkKind;
  readonly at: number;
  readonly generation: number;
}

export interface NetworkMonitorOptions {
  /** **必须注入**：本模块不读系统时间。 */
  readonly clock: ResilienceClock;
  readonly initial?: NetworkKind;
}

export class NetworkMonitor {
  readonly #clock: ResilienceClock;
  #kind: NetworkKind;
  #generation: number;
  #changedAt: number;
  #transitions: NetworkTransition[] = [];
  #listeners = new Set<(snapshot: NetworkSnapshot) => void>();

  constructor(options: NetworkMonitorOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new Error('NetworkMonitor 必须注入 clock');
    }
    this.#clock = options.clock;
    this.#kind = options.initial ?? 'none';
    this.#generation = 0;
    this.#changedAt = this.#clock.now();
  }

  /** 当前快照。 */
  get snapshot(): NetworkSnapshot {
    return Object.freeze({
      kind: this.#kind,
      online: isOnlineKind(this.#kind),
      metered: meteredOf(this.#kind),
      generation: this.#generation,
      changedAt: this.#changedAt,
    });
  }

  isOnline(): boolean {
    return isOnlineKind(this.#kind);
  }

  get kind(): NetworkKind {
    return this.#kind;
  }

  /** 切换明细（证据）。 */
  get transitions(): readonly NetworkTransition[] {
    return Object.freeze([...this.#transitions]);
  }

  /** 切换次数（每次类型变更 +1）。 */
  get switchCount(): number {
    return this.#generation;
  }

  /**
   * 切换到某网络类型。**同类型重复设置是幂等的**：不动 `generation`、不产生切换记录、
   * 不触发监听——只有真实变更才 +1。
   */
  setKind(kind: NetworkKind): NetworkSnapshot {
    if (kind === this.#kind) {
      return this.snapshot;
    }
    const from = this.#kind;
    this.#kind = kind;
    this.#generation += 1;
    this.#changedAt = this.#clock.now();
    const transition: NetworkTransition = Object.freeze({
      from,
      to: kind,
      at: this.#changedAt,
      generation: this.#generation,
    });
    this.#transitions.push(transition);
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
    return snapshot;
  }

  /** 订阅变更，返回退订函数。 */
  onChange(listener: (snapshot: NetworkSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 等到在线（若已在线立即返回）。**不使用定时器**：只有当外部 `setKind` 切到在线时才推进。
   */
  waitForOnline(): Promise<NetworkSnapshot> {
    if (this.isOnline()) {
      return Promise.resolve(this.snapshot);
    }
    return new Promise((resolve) => {
      const unsubscribe = this.onChange((snapshot) => {
        if (snapshot.online) {
          unsubscribe();
          resolve(snapshot);
        }
      });
    });
  }
}

export function createNetworkMonitor(options: NetworkMonitorOptions): NetworkMonitor {
  return new NetworkMonitor(options);
}
