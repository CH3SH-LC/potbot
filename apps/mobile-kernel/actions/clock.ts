/**
 * K07 注入时钟（零依赖）。
 *
 * ## 为什么不直接用 `Date.now()`
 *
 * "过期"和"撤权"是授权链路上唯二的**时间判据**，也是验收里最容易写出空壳判据的地方：
 * 只要模块自己读墙钟，测试就只能靠 `sleep` 去凑，而 sleep 既慢又不可靠，
 * 最后往往退化成"这条负例测不了"。
 *
 * 因此本模块**不持有任何时间源**：`Clock` 由调用方（真机是系统时钟，测试是手动时钟）注入；
 * 模块只在发行、占用、发出这三个**同步可枚举**的时点各读一次。
 *
 * 单位约定：`Clock.now()` 与 `expiresAt` **同单位、同原点**（真机取 epoch 毫秒的整数值）。
 * 本模块只做大小比较，不解释单位——单位换算属于前端/适配器，不属于授权判据。
 *
 * 注意：本文件**不 import 任何东西**，也不触碰 `Date` / `performance` / 定时器，
 * 因此同一串调用序列在任何机器上都得到同一结果（与仓库既有逻辑时钟同一纪律）。
 */

/** 只读时钟视图：授权判据只需要 `now()`。 */
export interface Clock {
  /** 当前时间（整数，与 `expiresAt` 同单位）。 */
  now(): number;
}

/** 手动时钟：夹具/测试用它把时间**显式推过** `expiresAt`，不需要 sleep。 */
export interface ManualClock extends Clock {
  /** 把时钟设为 `value`（必须是不小于当前值的有限整数）。 */
  set(value: number): void;
  /** 在当前值上前进 `delta`（必须为正的有限整数）。 */
  advance(delta: number): void;
}

/**
 * 造一个从 `start` 起步的手动时钟。
 *
 * 非法推进一律**抛错**而不是静默忽略——验收必须看得见"时间没推成"这件事，
 * 否则负例会在"其实没过期"的状态下通过，变成空壳判据。
 */
export function createManualClock(start: number): ManualClock {
  if (!Number.isSafeInteger(start)) {
    throw new TypeError(`手动时钟起始值必须是安全整数，收到 ${String(start)}`);
  }
  let current = start;
  return {
    now: () => current,
    set(value: number): void {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`时钟只能设为安全整数，收到 ${String(value)}`);
      }
      if (value < current) {
        throw new RangeError(`时钟不得回拨：当前 ${current}，请求 ${value}`);
      }
      current = value;
    },
    advance(delta: number): void {
      if (!Number.isSafeInteger(delta) || delta <= 0) {
        throw new RangeError(`时钟推进量必须是正的有限整数，收到 ${String(delta)}`);
      }
      current += delta;
    },
  };
}
