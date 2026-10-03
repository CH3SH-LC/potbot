/**
 * 可控逻辑时钟（`design-01-P6` / 接口合同 v1 第六节 Q8-a、Q8-c）。
 *
 * 冻结语义：
 * - 时间**只能**由驱动器（测试夹具）显式推进；内核侧只持有 `Clock`（只有 `now()`），
 *   结构上就无法推进时间。
 * - 对外的时间值一律是 `src/protocol` 的 `LogicalTime`（用 `asLogicalTime` 构造），
 *   **不引入第三套时间类型**。
 * - 本模块**不触碰任何墙钟 API**（不 import `Date` / `performance` / 定时器），
 *   因此同一串操作序列在任何机器、任何时刻都得到同一结果。合同 Q8-b 规定内核代码
 *   路径默认禁止真实 sleep，逻辑时钟是唯一时间源。
 * - 推进记录（`advances`）与读取计数（`reads`）是给验收用的可观测量：A05 的
 *   「实际推进的虚拟时间 ≤ T_max」由 `totalAdvanced` / `advances` 判定。
 * - 推进量不合法（非有限数、非正数、目标时间不晚于当前）一律**显式抛出**，
 *   不得静默忽略——验收必须看得见失败原因。
 */

import { LOGICAL_TIME_ORIGIN, asLogicalTime, type LogicalTime } from '../protocol/index.js';

/**
 * 只读时钟视图。内核代码只应依赖本接口。
 * 合同 Q8-a：「内核只读 `now()`，不得自行推进时间」——把本接口交给内核即可在类型层面保证。
 */
export interface Clock {
  /** 当前逻辑时间。单位与语义由 `LogicalTime` 定义（与真实时间无关）。 */
  now(): LogicalTime;
}

/** 一次显式推进的记录，按发生顺序累积。 */
export interface ClockAdvance {
  /** 第几次推进，从 1 开始。 */
  readonly index: number;
  /** 推进前的时间。 */
  readonly from: LogicalTime;
  /** 推进后的时间。 */
  readonly to: LogicalTime;
  /** 本次推进量（恒 > 0；推进量是持续时间，不是时间点）。 */
  readonly delta: number;
  /** 可选的场景标注，例如「T_max 封顶放行第 3 次」。 */
  readonly label?: string;
}

/** 时钟状态快照（用于证据汇总，不计入 `reads`）。 */
export interface ClockState {
  readonly time: LogicalTime;
  readonly reads: number;
  readonly advances: number;
}

/** 时钟自身的用法错误。所有非法推进都抛这个类型，便于验收断言失败原因。 */
export class LogicalClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogicalClockError';
  }
}

/** 把 `label` 塞进记录里的小工具：避免在对象字面量里写 `label: undefined`。 */
function advanceEntry(
  index: number,
  from: LogicalTime,
  to: LogicalTime,
  delta: number,
  label: string | undefined,
): ClockAdvance {
  if (label === undefined) return { index, from, to, delta };
  return { index, from, to, delta, label };
}

/**
 * 可控逻辑时钟。
 *
 * 使用纪律（见 `docs/other/prep/D07-D09-prep-验收场景规格.md` 0.5 时序纪律）：
 * 时间推进只能来自夹具的显式调用，绝不能来自「等一会儿」。
 */
export class LogicalClock implements Clock {
  #time: LogicalTime;
  #reads = 0;
  readonly #advances: ClockAdvance[] = [];

  constructor(initialTime: LogicalTime = asLogicalTime(LOGICAL_TIME_ORIGIN)) {
    // `asLogicalTime` 已保证有限；这里再挡一次负数初值。
    if (initialTime < 0) {
      throw new LogicalClockError(`逻辑时钟初值必须非负，收到 ${String(initialTime)}`);
    }
    this.#time = initialTime;
  }

  /**
   * 读取当前逻辑时间。**只读**：本方法永远不改变时间。
   * 每次调用计入 `reads`（可观测量）。
   */
  now(): LogicalTime {
    this.#reads += 1;
    return this.#time;
  }

  /** 当前时间，不计入 `reads`（供夹具内部/证据汇总使用）。 */
  get time(): LogicalTime {
    return this.#time;
  }

  /** `now()` 被调用的累计次数。 */
  get reads(): number {
    return this.#reads;
  }

  /** 已发生的推进次数。 */
  get advanceCount(): number {
    return this.#advances.length;
  }

  /** 按顺序的全部推进记录。 */
  get advances(): readonly ClockAdvance[] {
    return this.#advances;
  }

  /**
   * 显式推进 `delta` 个逻辑时间单位。仅驱动器/夹具可调用。
   * @throws {LogicalClockError} `delta` 非有限数或 ≤ 0 时。
   */
  advance(delta: number, label?: string): LogicalTime {
    if (!Number.isFinite(delta) || delta <= 0) {
      throw new LogicalClockError(
        `推进量必须是有限正数，收到 ${String(delta)}（时间为 0 步不动，时钟不自行推进）`,
      );
    }
    const from = this.#time;
    const to = asLogicalTime(from + delta);
    this.#time = to;
    this.#advances.push(advanceEntry(this.#advances.length + 1, from, to, delta, label));
    return to;
  }

  /**
   * 显式推进到某一绝对时间。
   * @throws {LogicalClockError} 目标不晚于当前时间时（时间不可倒流、不可原地踏步）。
   */
  advanceTo(target: LogicalTime, label?: string): LogicalTime {
    const delta = target - this.#time;
    if (!Number.isFinite(delta)) {
      throw new LogicalClockError(`advanceTo 目标必须是有限数，收到 ${String(target)}`);
    }
    if (delta <= 0) {
      throw new LogicalClockError(
        `advanceTo 目标 ${String(target)} 不晚于当前 ${String(this.#time)}（逻辑时间不可倒流）`,
      );
    }
    return this.advance(delta, label);
  }

  /** 累计推进量（所有 `advance` 的 delta 之和）——A05「实际推进的虚拟时间」的判据来源。 */
  get totalAdvanced(): number {
    let sum = 0;
    for (const entry of this.#advances) sum += entry.delta;
    return sum;
  }

  /** 状态快照：`{ time, reads, advances }`。 */
  state(): ClockState {
    return { time: this.#time, reads: this.#reads, advances: this.#advances.length };
  }

  /**
   * 只读视图：交给内核代码的对象。它只有 `now()`，
   * 类型层面即不可能推进时间（合同 Q8-a）。
   */
  readOnlyView(): Clock {
    return { now: () => this.now() };
  }
}
