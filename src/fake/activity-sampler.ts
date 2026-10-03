/**
 * 活动态**只读快照采样器**（归属 D06，`src/fake/`）。
 *
 * ## 与 D01 的职责边界（合同冻结 v1.1 的 R4，必须遵守）
 *
 * `src/protocol/events.ts` 的 `summarizeKernelEvents(events)` 是**峰值计数口径的唯一权威实现**
 * ——包括「峰值活动轮次」「峰值排队标记」「运行轮次数」「被拒绝发布次数」「诊断次数」等。
 * **D06 不得另写一套 peak 计算**（`EventRecorder.counters()` 已经委托给它）。
 *
 * 因此本模块**不做任何 peak 计算**，只补两件 D01 不该管、且夹具必需的事：
 *
 * 1. **只读快照的瞬时采样**（验收规格 0.3 第 5 条：断言只能经只读快照读，不得窥探内核内存）：
 *    在夹具的放行点上读 `StoreSnapshot.instances`，记下**该时刻**的活动轮次数与排队标记数。
 * 2. **「窗口内是否增长」的判据**（A05-07 / A05-08「等待窗口内活动轮次 = 0、
 *    假 Agent 调用计数不增长」）：它是**两个采样点之间的比较**，不是一个峰值。
 *
 * ## 缺口已闭合（D01 第二轮修完）
 *
 * 第一轮时 D01 的 `summarizeKernelEvents` 曾把 5/8 个计数器**静默留在零值**
 * （含 `peak_active_runs` / `peak_queued_flags`）。D01 第二轮**已修完**：
 * `src/protocol/counters.ts` 真实计算事件侧 6 项，**算不出即抛 `EventCountingError`**
 * （绝不用 0 冒充观测值）。因此 `A02-01 峰值活动轮次 ≤ 1` 已有可证伪的判据来源。
 * **本模块仍不做任何 peak 计算**——峰值口径的权威实现只有
 * `summarizeKernelEvents`（R4），D06 不另写一份（那正是「同一概念两套实现」的错误）。
 */

import type { InstanceId, InstanceState, LogicalTime } from '../protocol/index.js';
import { SamplerError } from './errors.js';

/** 一个实例在采样时刻的活动态。 */
export interface InstanceActivitySample {
  readonly active_runs: number;
  readonly queued_flag: boolean;
}

/** 一次只读快照采样（瞬时值，不是峰值）。 */
export interface SnapshotSample {
  /** 第几次采样，从 1 开始。 */
  readonly index: number;
  /** 采样时刻（夹具显式给出的逻辑时间）。 */
  readonly at: LogicalTime;
  /** 该时刻的活动轮次总数。 */
  readonly active_runs: number;
  /** 该时刻为真的排队标记数。 */
  readonly queued_flags: number;
  /** 逐实例取值（键升序）。 */
  readonly per_instance: Readonly<Record<string, InstanceActivitySample>>;
}

/**
 * 只读快照采样器。
 *
 * ```ts
 * const sampler = new ActivitySnapshotSampler();
 * const opened = sampler.sampleStates(store.snapshot().instances, clock.now());
 * // ……等待窗口内不做任何放行……
 * const closed = sampler.sampleStates(store.snapshot().instances, clock.now());
 * expect(sampler.isFlatBetween(opened.index, closed.index)).toBe(true);  // A05-07 / A05-08
 * ```
 */
export class ActivitySnapshotSampler {
  readonly #samples: SnapshotSample[] = [];

  get samples(): readonly SnapshotSample[] {
    return this.#samples;
  }

  get sampleCount(): number {
    return this.#samples.length;
  }

  /** 最近一次采样（无则 null）。 */
  latest(): SnapshotSample | null {
    return this.#samples[this.#samples.length - 1] ?? null;
  }

  /**
   * 用只读快照做一次瞬时采样。
   *
   * @param states `StoreSnapshot.instances`（只读；本方法不修改任何东西）。
   * @param at 采样时刻（逻辑时间）。
   * @throws {SamplerError} 同一实例在快照里出现两次时（快照自相矛盾，不静默取其一）。
   */
  sampleStates(states: readonly InstanceState[], at: LogicalTime): SnapshotSample {
    const perInstance: Record<string, InstanceActivitySample> = {};
    const seen = new Set<InstanceId>();
    let activeRuns = 0;
    let queuedFlags = 0;

    for (const state of states) {
      if (seen.has(state.instance_id)) {
        throw new SamplerError(`快照中实例 ${state.instance_id} 出现两次，活动态无法判定`);
      }
      seen.add(state.instance_id);
      const active = state.active_run_id === null ? 0 : 1;
      activeRuns += active;
      if (state.queued_flag) queuedFlags += 1;
      perInstance[state.instance_id] = { active_runs: active, queued_flag: state.queued_flag };
    }

    const sorted: Record<string, InstanceActivitySample> = {};
    for (const key of Object.keys(perInstance).sort()) {
      const value = perInstance[key];
      if (value !== undefined) sorted[key] = value;
    }

    const sample: SnapshotSample = {
      index: this.#samples.length + 1,
      at,
      active_runs: activeRuns,
      queued_flags: queuedFlags,
      per_instance: sorted,
    };
    this.#samples.push(sample);
    return sample;
  }

  /** 取第 `index` 次采样（1 起）。 */
  byIndex(index: number): SnapshotSample {
    const sample = this.#samples[index - 1];
    if (sample === undefined) {
      throw new SamplerError(`没有第 ${index} 次采样（已采样 ${this.#samples.length} 次）`);
    }
    return sample;
  }

  /**
   * 两次采样之间「活动轮次与排队标记都没有增长」——A05-07 / A05-08 的等待窗口判据。
   *
   * 只比较区间**端点与全部中间采样**：任何一次采样变大即视为增长。
   */
  isFlatBetween(fromIndex: number, toIndex: number): boolean {
    if (fromIndex > toIndex) {
      throw new SamplerError(`采样区间非法：${fromIndex} > ${toIndex}`);
    }
    const from = this.byIndex(fromIndex);
    const to = this.byIndex(toIndex);
    if (to.active_runs > from.active_runs) return false;
    if (to.queued_flags > from.queued_flags) return false;
    for (let i = fromIndex + 1; i < toIndex; i += 1) {
      const middle = this.byIndex(i);
      if (middle.active_runs > from.active_runs) return false;
      if (middle.queued_flags > from.queued_flags) return false;
    }
    return true;
  }

  /** 复位（同一进程内跑多个隔离场景）。 */
  reset(): void {
    this.#samples.length = 0;
  }
}

/** 两次采样之间某个观测量的变化（证据）。 */
export interface WindowDelta {
  readonly from_index: number;
  readonly to_index: number;
  readonly active_runs_delta: number;
  readonly queued_flags_delta: number;
  readonly flat: boolean;
}

/**
 * 取一个窗口的增量证据（「等待窗口内计数不增长」的直接输出）。
 * 与 `isFlatBetween` 同一口径，但留下可落盘的数值。
 */
export function windowDelta(
  sampler: ActivitySnapshotSampler,
  fromIndex: number,
  toIndex: number,
): WindowDelta {
  const from = sampler.byIndex(fromIndex);
  const to = sampler.byIndex(toIndex);
  return {
    from_index: fromIndex,
    to_index: toIndex,
    active_runs_delta: to.active_runs - from.active_runs,
    queued_flags_delta: to.queued_flags - from.queued_flags,
    flat: sampler.isFlatBetween(fromIndex, toIndex),
  };
}
