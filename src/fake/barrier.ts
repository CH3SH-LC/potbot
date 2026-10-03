/**
 * 屏障 / 闸门 / 阻塞点（归属 D06，`src/fake/`）。
 *
 * 这三个器件是「夹具持有推进权」的物理基础，也是
 * `docs/other/ds-development-guide.md`「独立验收场景」一节要求的
 * 「使用屏障、可控时钟或明确事件序列固定时机，**不能只靠增加真实 sleep 猜测竞态**」的落地手段。
 *
 * 全部实现只用 Promise 微任务，**不使用任何定时器**：
 * - 并发组的起跑屏障（B-deliver）；
 * - 投递全部返回的等待屏障（B-alldone）；
 * - 假 Agent 的轮内阻塞点（P-block-1 / P-block-2），夹具可确定性地「等它到达」再放行，
 *   不需要 sleep 去猜它到没到。
 *
 * 阻塞点与**轮次身份耦合**（P7 / A03-07 需要）：每次到达都必须携带 `run_id` / `instance_id` /
 * 逻辑时间，夹具因此能证明「停住的是 run-2，不是 run-1」。
 */

import type { InstanceId, LogicalTime, RunId } from '../protocol/index.js';

/** 器件自身的用法错误：一律显式抛出，不得静默吞掉。 */
export class BarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarrierError';
  }
}

/**
 * 可等待的承诺盒：不依赖定时器，纯微任务。
 * 重复 resolve / reject 只生效第一次（幂等），避免并发路径下重复放行引发歧义。
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (reason: unknown) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get settled(): boolean {
    return this.#settled;
  }

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  reject(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(reason);
  }
}

/**
 * N 方集合屏障（A02 的 B-deliver / B-alldone）。
 *
 * 语义：前 `parties` 个 `arrive()` 调用者互相等待，第 `parties` 个到达时整组放行，进入下一轮。
 * 到达数在放行后归零，可复用（B-deliver 与 B-alldone 各用一次）。
 */
export class Barrier {
  readonly parties: number;
  #arrived = 0;
  #cycles = 0;
  readonly #waiters: Deferred<void>[] = [];
  readonly #observers: Deferred<void>[] = [];

  constructor(parties: number) {
    if (!Number.isInteger(parties) || parties < 1) {
      throw new BarrierError(`屏障方数必须是 ≥ 1 的整数，收到 ${String(parties)}`);
    }
    this.parties = parties;
  }

  /** 当前轮已到达但仍在等待的方数。 */
  get arrived(): number {
    return this.#arrived;
  }

  /** 已完成的轮次数。 */
  get cycles(): number {
    return this.#cycles;
  }

  /** 正在等待的调用者数（= arrived）。 */
  get waiting(): number {
    return this.#waiters.length;
  }

  /**
   * 到达屏障并等待其余各方。第 `parties` 个到达者触发整组放行。
   * 返回的 Promise 在整组放行后兑现。
   */
  arrive(): Promise<void> {
    const waiter = new Deferred<void>();
    this.#waiters.push(waiter);
    this.#arrived += 1;
    if (this.#waiters.length >= this.parties) this.#release();
    return waiter.promise;
  }

  /** 夹具侧只读观察：等待下一次「整组放行」发生（不参与计数，不消耗名额）。 */
  awaitNextCycle(): Promise<void> {
    const observer = new Deferred<void>();
    this.#observers.push(observer);
    return observer.promise;
  }

  #release(): void {
    const group = this.#waiters.splice(0, this.parties);
    this.#cycles += 1;
    this.#arrived = 0;
    const observers = this.#observers.splice(0);
    for (const waiter of group) waiter.resolve();
    for (const observer of observers) observer.resolve();
  }
}

/**
 * 闸门（单次放行）：夹具开闸 `n` 次，最前面的 `n` 个 `pass()` 依次通过；
 * 多余的放行额度被记住，供后续 `pass()` 直接消耗（`pendingGrants`）。
 *
 * 与 `Barrier` 的区别：`Barrier` 是「凑齐 N 方一起走」，`Gate` 是「等夹具开闸」。
 * A02「投递完成后不启动轮次，直到测试显式放行」用的就是 `Gate` 语义。
 */
export class Gate {
  #grants = 0;
  #passes = 0;
  readonly #waiters: Deferred<void>[] = [];

  /** 是否还有未消耗的放行额度。 */
  get isOpen(): boolean {
    return this.#grants > 0;
  }

  /** 未消耗的放行额度数。 */
  get pendingGrants(): number {
    return this.#grants;
  }

  /** 正在等待放行的调用者数。 */
  get waiting(): number {
    return this.#waiters.length;
  }

  /** 累计通过次数。 */
  get passes(): number {
    return this.#passes;
  }

  /** 夹具侧：开闸 `count` 次。 */
  release(count = 1): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new BarrierError(`开闸次数必须是 ≥ 1 的整数，收到 ${String(count)}`);
    }
    this.#grants += count;
    this.#flush();
  }

  /** 夹具侧：关闸并丢弃未消耗的额度（等待者不受影响，继续等待）。 */
  close(): void {
    this.#grants = 0;
  }

  /** 内核/假 Agent 侧：通过闸门；无额度则挂起，直到被放行。 */
  pass(): Promise<void> {
    if (this.#grants > 0) {
      this.#grants -= 1;
      this.#passes += 1;
      return Promise.resolve();
    }
    const waiter = new Deferred<void>();
    this.#waiters.push(waiter);
    return waiter.promise;
  }

  #flush(): void {
    while (this.#grants > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      this.#grants -= 1;
      this.#passes += 1;
      waiter.resolve();
    }
  }
}

/** 到达阻塞点时必须携带的**轮次身份**上下文（耦合 `run_id` / `instance_id` / 逻辑时间）。 */
export interface BlockContext {
  readonly run_id: RunId;
  readonly instance_id: InstanceId;
  readonly at: LogicalTime;
  readonly label?: string;
}

/** 一条到达记录（证据）。 */
export interface BlockArrival extends BlockContext {
  /** 该阻塞点上的第几次到达，从 1 开始。 */
  readonly seq: number;
}

/**
 * 命名阻塞点（A03 的 P-block-1 / P-block-2）。
 *
 * 假 Agent 在轮内固定位置调用 `wait(context)` 停住；夹具可以：
 * - `await point.arrived()`：**确定性地**等到假 Agent 真的停在该点（不用 sleep 猜），
 *   并拿到带 `run_id` 的到达记录——A03-07 的「run-2 的快照含这 3 条」由此可证；
 * - `point.release()`：放行，轮次继续。
 *
 * 「先放行后到达」也被支持：放行额度会被记住（`pendingReleases`），
 * 使夹具脚本可以写成线性顺序而不必担心挂起顺序。
 */
export class BlockPoint {
  readonly name: string;
  #arrivalCount = 0;
  #releases = 0;
  #pendingReleases = 0;
  readonly #all: BlockArrival[] = [];
  readonly #unobserved: BlockArrival[] = [];
  readonly #waiters: Deferred<void>[] = [];
  readonly #arrivalObservers: Deferred<BlockArrival>[] = [];

  constructor(name: string) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new BarrierError('阻塞点必须有名（非空字符串）');
    }
    this.name = name;
  }

  /** 累计到达次数。 */
  get arrivalCount(): number {
    return this.#arrivalCount;
  }

  /** 累计放行次数（不含尚未消耗的放行额度）。 */
  get releaseCount(): number {
    return this.#releases;
  }

  /** 已记住但尚未被到达消耗的放行额度。 */
  get pendingReleases(): number {
    return this.#pendingReleases;
  }

  /** 当前停在该点的调用者数。 */
  get waiting(): number {
    return this.#waiters.length;
  }

  /** 全部到达记录（按发生顺序）。 */
  get arrivals(): readonly BlockArrival[] {
    return this.#all;
  }

  /** 最近一次到达（无则为 null）。 */
  get lastArrival(): BlockArrival | null {
    return this.#all[this.#all.length - 1] ?? null;
  }

  /** 在该点停住过的全部 `run_id`（去重、保持首次出现顺序）——归属类断言用。 */
  runIds(): readonly RunId[] {
    const seen: RunId[] = [];
    for (const arrival of this.#all) {
      if (!seen.includes(arrival.run_id)) seen.push(arrival.run_id);
    }
    return seen;
  }

  /** 假 Agent 侧：到达阻塞点并等待放行。**必须**给出轮次身份（耦合 run_id）。 */
  wait(context: BlockContext): Promise<void> {
    if (typeof context.run_id !== 'string' || context.run_id.length === 0) {
      throw new BarrierError(`阻塞点「${this.name}」的到达缺少 run_id（轮次身份不可缺省）`);
    }
    if (typeof context.instance_id !== 'string' || context.instance_id.length === 0) {
      throw new BarrierError(`阻塞点「${this.name}」的到达缺少 instance_id`);
    }
    this.#arrivalCount += 1;
    const arrival: BlockArrival = { seq: this.#arrivalCount, ...context };
    this.#all.push(arrival);

    const observer = this.#arrivalObservers.shift();
    if (observer !== undefined) {
      observer.resolve(arrival);
    } else {
      this.#unobserved.push(arrival);
    }

    if (this.#pendingReleases > 0) {
      this.#pendingReleases -= 1;
      this.#releases += 1;
      return Promise.resolve();
    }

    const waiter = new Deferred<void>();
    this.#waiters.push(waiter);
    return waiter.promise;
  }

  /**
   * 夹具侧：等待「下一次到达」，兑现为带 `run_id` 的到达记录。
   * 若已有未被观察的到达，立即兑现。这是「不用 sleep 也知道假 Agent 到点了」的关键。
   */
  arrived(): Promise<BlockArrival> {
    const ready = this.#unobserved.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    const observer = new Deferred<BlockArrival>();
    this.#arrivalObservers.push(observer);
    return observer.promise;
  }

  /** 夹具侧：放行 `count` 次；无人等待时的放行额度被记住。 */
  release(count = 1): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new BarrierError(`放行次数必须是 ≥ 1 的整数，收到 ${String(count)}`);
    }
    for (let i = 0; i < count; i += 1) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#pendingReleases += 1;
      } else {
        this.#releases += 1;
        waiter.resolve();
      }
    }
  }

  /** 夹具侧：放行当前所有等待者（收尾用；不产生放行额度）。 */
  releaseAll(): void {
    this.release(this.#waiters.length);
  }

  /** 证据快照。 */
  snapshot(): BlockPointSnapshot {
    return {
      name: this.name,
      arrivals: this.#arrivalCount,
      releases: this.#releases,
      waiting: this.#waiters.length,
      pending_releases: this.#pendingReleases,
      run_ids: [...this.runIds()],
      last_arrival: this.lastArrival === null ? null : { ...this.lastArrival },
    };
  }
}

/** 阻塞点证据快照。 */
export interface BlockPointSnapshot {
  readonly name: string;
  readonly arrivals: number;
  readonly releases: number;
  readonly waiting: number;
  readonly pending_releases: number;
  readonly run_ids: readonly RunId[];
  readonly last_arrival: BlockArrival | null;
}

/**
 * 命名阻塞点集合。夹具脚本按名字取用；
 * 放行一个未登记的阻塞点名字是**夹具脚本错误**，直接抛出（避免脚本写错名却悄悄通过）。
 */
export class BlockPointSet {
  readonly #points = new Map<string, BlockPoint>();

  /** 取（必要时创建）一个命名阻塞点。 */
  point(name: string): BlockPoint {
    const existing = this.#points.get(name);
    if (existing !== undefined) return existing;
    const created = new BlockPoint(name);
    this.#points.set(name, created);
    return created;
  }

  has(name: string): boolean {
    return this.#points.has(name);
  }

  names(): readonly string[] {
    return [...this.#points.keys()];
  }

  /** 夹具侧：放行指定阻塞点；名字不存在则抛错。 */
  release(name: string, count = 1): void {
    this.#require(name).release(count);
  }

  /** 夹具侧：等待指定阻塞点被到达；名字不存在则抛错。 */
  arrived(name: string): Promise<BlockArrival> {
    return this.#require(name).arrived();
  }

  /** 观测快照：每个阻塞点的到达 / 放行计数与 run_id 归属，供证据汇总。 */
  snapshot(): Readonly<Record<string, BlockPointSnapshot>> {
    const out: Record<string, BlockPointSnapshot> = {};
    for (const name of [...this.#points.keys()].sort()) {
      const point = this.#points.get(name);
      if (point === undefined) continue;
      out[name] = point.snapshot();
    }
    return out;
  }

  #require(name: string): BlockPoint {
    const target = this.#points.get(name);
    if (target === undefined) {
      throw new BarrierError(
        `引用了未登记的阻塞点「${name}」；已登记：${this.names().join(', ') || '（无）'}`,
      );
    }
    return target;
  }
}
