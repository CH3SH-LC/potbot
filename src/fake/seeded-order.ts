/**
 * 固定种子与固定调度顺序（归属 D06，`src/fake/`）。
 *
 * 合同 Q8-c：**重现性是硬性前提：固定种子 + 固定调度顺序，种子集合在测试前登记**。
 *
 * 本模块只提供「可复现的随机性」这一件事：同一个种子必然产生同一串数、同一个置换。
 * 它**不是**调度器——调度顺序仍由夹具脚本逐条给出；当场景需要「并发到达的随机交错」时，
 * 用 `SeededOrder.permutation()/shuffle()` 把顺序固定下来并登记种子，而不是靠真实并发。
 *
 * 不引入新依赖：PRNG 是自带的 mulberry32（32 位状态，周期 2^32，够测试用）。
 */

import { SeededOrderError } from './errors.js';

/** 把任意种子（字符串或数字）折成 32 位无符号整数（FNV-1a）。 */
export function hashSeed(seed: string | number): number {
  const text = typeof seed === 'number' ? `n:${String(seed)}` : `s:${seed}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 生成确定性伪随机数发生器（mulberry32）。
 * 同一个种子 → 同一串 `[0, 1)` 浮点数，跨机器、跨运行一致。
 */
export function createSeededRandom(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 固定种子下的确定性顺序器。
 *
 * 用法（A04 变体乙「5 次投递在同一屏障后同时起跑」的顺序登记）：
 * ```ts
 * const order = new SeededOrder('a04-variant-b');
 * const sequence = order.permutation(5);   // 登记进证据的固定顺序
 * ```
 */
export class SeededOrder {
  readonly seed: string | number;
  readonly #random: () => number;

  constructor(seed: string | number) {
    if (typeof seed !== 'string' && typeof seed !== 'number') {
      throw new SeededOrderError(`种子必须是字符串或数字，收到 ${typeof seed}`);
    }
    if (typeof seed === 'number' && !Number.isFinite(seed)) {
      throw new SeededOrderError(`种子数字必须是有限数，收到 ${String(seed)}`);
    }
    this.seed = seed;
    this.#random = createSeededRandom(seed);
  }

  /** 下一个 `[0, 1)` 浮点数。 */
  next(): number {
    return this.#random();
  }

  /** 下一个 `[0, maxExclusive)` 整数。 */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new SeededOrderError(`nextInt 上界必须是 ≥ 1 的整数，收到 ${String(maxExclusive)}`);
    }
    return Math.floor(this.#random() * maxExclusive);
  }

  /** `0..size-1` 的确定性置换（Fisher–Yates，用种子驱动）。 */
  permutation(size: number): readonly number[] {
    if (!Number.isInteger(size) || size < 0) {
      throw new SeededOrderError(`置换长度必须是非负整数，收到 ${String(size)}`);
    }
    const items = Array.from({ length: size }, (_, i) => i);
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const a = items[i];
      const b = items[j];
      if (a === undefined || b === undefined) {
        throw new SeededOrderError('置换内部越界（不应发生）');
      }
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /** 确定性洗牌（不改动入参）。 */
  shuffle<T>(items: readonly T[]): readonly T[] {
    const order = this.permutation(items.length);
    return order.map((index) => {
      const item = items[index];
      if (item === undefined) throw new SeededOrderError('洗牌内部越界（不应发生）');
      return item;
    });
  }

  /** 确定性取一个元素；空集合是脚本错误，直接抛出。 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new SeededOrderError('pick 不能用于空集合');
    }
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new SeededOrderError('pick 内部越界（不应发生）');
    return item;
  }
}
