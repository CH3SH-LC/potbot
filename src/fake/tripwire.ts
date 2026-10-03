/**
 * 墙钟报警线（归属 D06，`src/fake/`）。
 *
 * 合同 Q8-b 是硬约束：**内核代码路径默认禁止真实 sleep**（测试框架自身超时除外），
 * 逻辑时钟是唯一时间源。指导文件也禁止「只靠增加真实 sleep 猜测竞态」。
 *
 * 光靠代码评审守不住这条纪律，所以这里给出一个可执行的报警线：
 * 在隔离场景的临界区内 `arm()`，任何对 `setTimeout / setInterval / setImmediate`
 * 的调用都会被记下（或直接抛错），`disarm()` 后原样还原全局。
 *
 * 用法（D07–D09 场景脚本）：
 * ```ts
 * const tripwire = new WallClockTripwire();
 * const raw = await tripwire.runAsync(() => scenario.step(), { throwOnViolation: true });
 * expect(tripwire.violationsFor(raw)).toEqual([]);
 * ```
 *
 * 注意：报警线只在**临界区内**生效，且必须 `disarm()` 还原——
 * 全局补丁是危险的，`run()/runAsync()` 保证异常路径也会还原。
 */

/** 一次墙钟调用记录。 */
export interface TripwireViolation {
  /** 被调用的 API 名。 */
  readonly api: 'setTimeout' | 'setInterval' | 'setImmediate';
  /** 该 API 的累计调用序号（含 arm 之前的噪声，用 `mark()` 取区间）。 */
  readonly ordinal: number;
}

/** 报警线被触发且要求抛错时抛出的错误。 */
export class WallClockViolationError extends Error {
  readonly violation: TripwireViolation;

  constructor(violation: TripwireViolation) {
    super(
      `临界区内出现真实墙钟调用 ${violation.api}：逻辑时钟是唯一时间源（合同 Q8-b），不得用 sleep 制造时序`,
    );
    this.name = 'WallClockViolationError';
    this.violation = violation;
  }
}

/** `arm()` 选项。 */
export interface TripwireOptions {
  /** 命中即抛错（默认 true）。设为 false 只记录，用于「计数但不打断」的采样。 */
  readonly throwOnViolation?: boolean;
}

interface ArmedState {
  readonly originals: Map<string, unknown>;
  readonly counts: Map<string, number>;
}

type TimerTarget = Record<string, unknown>;

/**
 * 墙钟报警线。可重复 arm / disarm；嵌套不支持的（重复 arm 抛错）。
 */
export class WallClockTripwire {
  #armed: ArmedState | null = null;
  #throw = true;
  readonly #violations: TripwireViolation[] = [];

  get armed(): boolean {
    return this.#armed !== null;
  }

  get violations(): readonly TripwireViolation[] {
    return this.#violations;
  }

  /** 取一个观察起点：与 `violationsFor(mark)` 配合可只看临界区内的命中。 */
  mark(): number {
    return this.#violations.length;
  }

  /** 取「自 `mark` 之后」的命中列表。 */
  violationsFor(mark: number): readonly TripwireViolation[] {
    return this.#violations.slice(mark);
  }

  /** 装上报警线。重复 arm 抛错（避免嵌套补丁后还原不干净）。 */
  arm(options: TripwireOptions = {}): void {
    if (this.#armed !== null) {
      throw new Error('墙钟报警线已装上：不支持嵌套 arm，请先 disarm()');
    }
    this.#throw = options.throwOnViolation ?? true;

    const target = globalThis as unknown as TimerTarget;
    const state: ArmedState = { originals: new Map(), counts: new Map() };

    for (const api of ['setTimeout', 'setInterval', 'setImmediate'] as const) {
      const original = target[api];
      state.originals.set(api, original);
      state.counts.set(api, 0);
      target[api] = (...args: unknown[]) => {
        const count = (state.counts.get(api) ?? 0) + 1;
        state.counts.set(api, count);
        const violation: TripwireViolation = { api, ordinal: count };
        this.#violations.push(violation);
        if (this.#throw) throw new WallClockViolationError(violation);
        if (typeof original !== 'function') {
          throw new Error(`墙钟报警线内部错误：${api} 不是函数（不应发生）`);
        }
        // 用 apply 保持宿主函数的接收者，避免 detach 后行为变化。
        return Reflect.apply(original as (...inner: unknown[]) => unknown, globalThis, args);
      };
    }

    this.#armed = state;
  }

  /** 还原全局。未装上时是空操作。 */
  disarm(): void {
    const state = this.#armed;
    if (state === null) return;
    const target = globalThis as unknown as TimerTarget;
    for (const [api, original] of state.originals) {
      target[api] = original;
    }
    // 还原后清空计数，避免误报后续 arm 的序号基准。
    state.counts.clear();
    this.#armed = null;
  }

  /** 同步临界区：装上 → 执行 → 无论如何都还原。 */
  run<T>(fn: () => T, options: TripwireOptions = {}): T {
    this.arm(options);
    try {
      return fn();
    } finally {
      this.disarm();
    }
  }

  /** 异步临界区：装上 → await 执行 → 无论如何都还原。 */
  async runAsync<T>(fn: () => Promise<T>, options: TripwireOptions = {}): Promise<T> {
    this.arm(options);
    try {
      return await fn();
    } finally {
      this.disarm();
    }
  }
}
