/**
 * F-R04 —— 长列表 / 长流式消息 / 大文件预览的**性能与资源泄漏测量台**。
 *
 * 定位：本包是**验证包**（FRONTEND.md 备用包 F-R04），不产出产品 UI。它只测量
 * `apps/mobile-ui/src/**` 现有纯函数视图模型在三类压力下的：
 *
 *   (a) **增长行为** —— 规模翻 4 倍，耗时是否仍近似线性（4 倍左右）；
 *       线性 = 4x，二次 = 16x，两者相差 4 倍，用 4 倍规模做区分比 2 倍规模稳得多。
 *   (b) **保留行为** —— 终态后不再膨胀、拒绝路径零分配、数组不被别名共享、
 *       对象图里没有意外的重复可达对象。这些断言是**确定性的**（与计时无关）。
 *
 * 设计约束（与 F02/F03/F06 同源）：
 *   - 零运行时依赖、纯 TS、框架无关；不引 Vue/React/DOM。
 *   - 不读真实文件字节、不发网络请求、不碰 `KernelClient`、不写时钟/随机数。
 *   - 派生规模数据用确定性 **LCG**（`lcg`），不用 `Math.random()`：
 *     同一 seed 在任何机器上得到同一规模，断言口径可复现。
 *
 * 诚实边界（详见同目录 RUNBOOK.md）：
 *   - 所有计时是**同机相对比较**，不是跨设备绝对性能承诺；结果受 CPU 频率/
 *     后台负载影响。本台用「中位数 + 4 倍规模 + 宽松上限」把噪声压到可接受，
 *     但仍不能替代真机测量。
 *   - 真机（Android WebView / QuickJS）性能、内存峰值、真实 GC 行为、列表/流式
 *     渲染的帧时间**未验证**；无 `--expose-gc` 时堆数字仅作指示，不作断言。
 *   - 无 `KernelClient` 事件流接入，故「订阅未取消导致监听器泄漏」这类
 *     **事件订阅型泄漏**不在本台可测范围内（本仓当前模块无订阅 API）。
 */

// ---------------------------------------------------------------------------
// 时钟与统计
// ---------------------------------------------------------------------------

/** 计时分辨率兜底：0.1 µs，避免 base 极小时比值溢出。 */
const EPS_MS = 0.0001;

/**
 * 单调毫秒时钟。手机内核可能跑在受限运行时，故按可用性回退：
 * `performance.now()` → `process.hrtime.bigint()` → `Date.now()`。
 */
export function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  const proc = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } }).process;
  if (proc?.hrtime?.bigint !== undefined) return Number(proc.hrtime.bigint()) / 1e6;
  return Date.now();
}

/** 中位数（输入需已排序）。空数组返回 0。 */
export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

export interface MeasureOptions {
  /** 测量轮数，取中位数；默认 5。 */
  readonly reps?: number;
  /** 预热轮数（不计入样本）；默认 1。 */
  readonly warmup?: number;
  readonly label?: string;
  /** 本测量对应的规模参数 n（用于证据记录，不参与断言）。 */
  readonly n?: number;
}

export interface TimingResult {
  readonly label: string;
  readonly n: number;
  readonly reps: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/**
 * 计时 `fn`：先预热 `warmup` 轮（JIT 去优化/内联稳定），再跑 `reps` 轮取中位数。
 * 中位数比均值抗单个噪声尖峰；同时保留全部样本与 min/max 供证据核对。
 */
export function measure(fn: () => void, options: MeasureOptions = {}): TimingResult {
  const reps = options.reps ?? 5;
  const warmup = options.warmup ?? 1;
  if (!Number.isInteger(reps) || reps < 1) throw new RangeError('reps 必须是 >= 1 的整数');
  if (!Number.isInteger(warmup) || warmup < 0) throw new RangeError('warmup 必须是 >= 0 的整数');

  for (let i = 0; i < warmup; i += 1) fn();

  const samples: number[] = [];
  for (let i = 0; i < reps; i += 1) {
    const t0 = nowMs();
    fn();
    samples.push(nowMs() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label: options.label ?? 'anon',
    n: options.n ?? 0,
    reps,
    samplesMs: Object.freeze(samples),
    medianMs: median(sorted),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

export interface PairedTiming {
  readonly base: TimingResult;
  readonly scaled: TimingResult;
}

/**
 * **交错配对测量**：把 base 与 scaled 两档交替跑（每轮互换先后，抵消顺序偏差），
 * 取各自中位数。共享机器上后台负载会单调漂移，分别成批测会把漂移误判成增长；
 * 交错后两档共享同一段负载，比值更可靠。
 */
export function measurePaired(
  baseFn: () => void,
  scaledFn: () => void,
  options: MeasureOptions & { readonly baseLabel?: string; readonly scaledLabel?: string } = {},
): PairedTiming {
  const reps = options.reps ?? 5;
  const warmup = options.warmup ?? 1;
  if (!Number.isInteger(reps) || reps < 1) throw new RangeError('reps 必须是 >= 1 的整数');

  for (let i = 0; i < warmup; i += 1) {
    baseFn();
    scaledFn();
  }

  const baseSamples: number[] = [];
  const scaledSamples: number[] = [];
  const timeOne = (fn: () => void, sink: number[]): void => {
    const t0 = nowMs();
    fn();
    sink.push(nowMs() - t0);
  };

  for (let i = 0; i < reps; i += 1) {
    if (i % 2 === 0) {
      timeOne(baseFn, baseSamples);
      timeOne(scaledFn, scaledSamples);
    } else {
      timeOne(scaledFn, scaledSamples);
      timeOne(baseFn, baseSamples);
    }
  }

  const mk = (samples: number[], label: string, n: number): TimingResult => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      label,
      n,
      reps,
      samplesMs: Object.freeze(samples),
      medianMs: median(sorted),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
    };
  };

  return {
    base: mk(baseSamples, options.baseLabel ?? 'base', options.n ?? 0),
    scaled: mk(scaledSamples, options.scaledLabel ?? 'scaled', options.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// 规模比值判定
// ---------------------------------------------------------------------------

export interface ScalingVerdict {
  readonly label: string;
  /** scaled.median / base.median。 */
  readonly ratio: number;
  /** 规模放大的倍数（例如 4 表示从 n 测到 4n）。 */
  readonly sizeFactor: number;
  /** 线性期望比值 = sizeFactor。 */
  readonly linearExpectation: number;
  /** 允许的最大比值；超过即判不通过（缺陷）。 */
  readonly ceiling: number;
  readonly baseMedianMs: number;
  readonly scaledMedianMs: number;
  readonly pass: boolean;
}

/** 取值估计器：中位数（抗单点尖峰）或最小值（抗持续后台负载）。 */
export type Estimator = 'median' | 'min';

/** 按估计器取时序样本的代表值。 */
export function estimate(result: TimingResult, estimator: Estimator): number {
  return estimator === 'min' ? result.minMs : result.medianMs;
}

/**
 * 判定「规模放大 `sizeFactor` 倍后，耗时的代表值比值是否在 `ceiling` 以内」。
 *
 * 线性算法 ≈ `sizeFactor`；二次算法 ≈ `sizeFactor²`。取 `sizeFactor = 4` 时
 * 线性=4、二次=16，`ceiling = 8` 位于两者正中（各留 2 倍余量）。
 *
 * `estimator` 默认 `'min'`：本机为**六线共用的共享机器**，后台负载持续存在；
 * 最小值是「最接近无干扰」的一次样本，比中位数更稳定（中位数会被后台抢占整体抬高）。
 */
export function verifyScaling(
  base: TimingResult,
  scaled: TimingResult,
  sizeFactor: number,
  ceiling: number,
  estimator: Estimator = 'min',
): ScalingVerdict {
  const baseValue = estimate(base, estimator);
  const scaledValue = estimate(scaled, estimator);
  const ratio = scaledValue / Math.max(baseValue, EPS_MS);
  return {
    label: `${base.label} → ${scaled.label}`,
    ratio,
    sizeFactor,
    linearExpectation: sizeFactor,
    ceiling,
    baseMedianMs: baseValue,
    scaledMedianMs: scaledValue,
    pass: ratio <= ceiling,
  };
}

// ---------------------------------------------------------------------------
// 保留 / 对象图
// ---------------------------------------------------------------------------

/**
 * 统计以 `root` 为根的可达对象里，满足 `predicate` 的节点数。
 *
 * 用途：「资源泄漏」在纯数据状态里等价于「无界保留」——某个本该释放/不该重复的
 * 对象仍能被状态图到达。带 visited 集合，能正确处理共享引用与环。
 */
export function countReachable(root: unknown, predicate: (value: unknown) => boolean): number {
  const seen = new WeakSet<object>();
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    const obj = value as object;
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (predicate(value)) count += 1;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return count;
}

/** 统计字符串键的数量（`Record` 的键数），用于索引表的保留计数。 */
export function keyCount(record: Readonly<Record<string, unknown>>): number {
  return Object.keys(record).length;
}

/** 当前堆使用字节（指示性，非断言；受限运行时可能不可用返回 -1）。 */
export function heapUsedBytes(): number {
  const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  if (proc?.memoryUsage === undefined) return -1;
  try {
    return proc.memoryUsage().heapUsed;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// 确定性伪随机（仅用于派生规模，不参与断言口径）
// ---------------------------------------------------------------------------

/**
 * 线性同余发生器（Numerical Recipes 参数）。返回 [0,1) 序列。
 * 用确定性序列取代 `Math.random()`：同一 seed ⇒ 同一规模的夹具。
 */
export function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// 探测项登记（operation schemas / types）
// ---------------------------------------------------------------------------

export type PerfArea = 'long-list' | 'long-stream' | 'large-file' | 'resource-retention';

export type PerfMetric =
  /** 规模比值：放大 sizeFactor 倍后耗时的中位数比值。 */
  | 'scaling-ratio'
  /** 保留计数：对象图里某类对象应保留的个数。 */
  | 'retention-count'
  /** 引用同一性：拒绝路径必须返回同一状态对象（零分配）。 */
  | 'reference-identity'
  /** 绝对预算：整段工作必须在给定毫秒内跑完。 */
  | 'absolute-budget';

/** 一个探测项的静态定义：id、区域、度量口径、单位与说明。 */
export interface PerfProbe {
  readonly id: string;
  readonly area: PerfArea;
  readonly metric: PerfMetric;
  readonly unit: string;
  readonly description: string;
}

/**
 * 本包实际实现的探测项登记表（唯一真源）。
 * 测试按 `PROBE_IDS` 断言每个探测项都有结果，防止「登记了却没跑」。
 */
export const PERF_PROBES: readonly PerfProbe[] = Object.freeze([
  // --- 增长（计时；min 估计器用于「必须通过」的守卫，median 用于标记缺陷）---
  {
    id: 'FR04-LIST-01',
    area: 'long-list',
    metric: 'scaling-ratio',
    unit: 'ratio(4k→16k)',
    description: 'listConversations 过滤+排序：4 倍会话数的增长比值（另加绝对预算硬门）',
  },
  {
    id: 'FR04-LIST-02',
    area: 'long-list',
    metric: 'scaling-ratio',
    unit: 'ratio(4k→16k)',
    description: 'pageConversations 取一页：每页重排 ⇒ 成本随总条数增长（另加绝对预算硬门）',
  },
  {
    id: 'FR04-LIST-03',
    area: 'long-list',
    metric: 'scaling-ratio',
    unit: 'ratio(1k→5k)',
    description: 'bindTask 连续绑定 k 个任务：归属唯一检查 O(总任务数) ⇒ 整体二次（已知缺陷）',
  },
  {
    id: 'FR04-STREAM-01',
    area: 'long-stream',
    metric: 'scaling-ratio',
    unit: 'ratio(20k→80k)',
    description: '单条长流式消息分片数 4 倍：正文累积应近线性（必须通过）',
  },
  {
    id: 'FR04-STREAM-02',
    area: 'long-stream',
    metric: 'scaling-ratio',
    unit: 'ratio(1k→4k)',
    description: '每片成本随会话消息数 4 倍增长（每片 slice 消息数组）应近线性（必须通过）',
  },
  {
    id: 'FR04-FILE-01',
    area: 'large-file',
    metric: 'scaling-ratio',
    unit: 'ratio(1k→5k)',
    description: 'appendRevision 连续追加 k 版：版本数组每版整拷 ⇒ 二次（已知缺陷）',
  },
  {
    id: 'FR04-FILE-02',
    area: 'large-file',
    metric: 'scaling-ratio',
    unit: 'ratio(1k→5k)',
    description: 'revisionAt 在 k 版链上做 k 次取版：线性 find ⇒ 整体二次（已知缺陷）',
  },
  {
    id: 'FR04-FILE-03',
    area: 'large-file',
    metric: 'scaling-ratio',
    unit: 'ratio(4k→16k)',
    description: 'listFiles 对 n 个文件排序+去重校验的增长比值（另加绝对预算硬门）',
  },
  // --- 绝对预算（计时；噪声不敏感，作为硬门）---
  {
    id: 'FR04-LIST-10',
    area: 'long-list',
    metric: 'absolute-budget',
    unit: 'ms@16k',
    description: 'listConversations 在 16000 条会话上的绝对预算',
  },
  {
    id: 'FR04-LIST-11',
    area: 'long-list',
    metric: 'absolute-budget',
    unit: 'ms@16k',
    description: 'pageConversations 在 16000 条会话上取一页的绝对预算',
  },
  {
    id: 'FR04-FILE-10',
    area: 'large-file',
    metric: 'absolute-budget',
    unit: 'ms@16k',
    description: 'listFiles 在 16000 个文件上的绝对预算',
  },
  {
    id: 'FR04-STREAM-10',
    area: 'long-stream',
    metric: 'absolute-budget',
    unit: 'ms@80k',
    description: '单条消息累积 80000 个流式分片的绝对预算',
  },
  // --- 保留（确定性）---
  {
    id: 'FR04-RET-01',
    area: 'resource-retention',
    metric: 'reference-identity',
    unit: 'boolean',
    description: '终态后迟到/重复/串台/未知分片的拒绝路径返回同一 state 引用（零分配）',
  },
  {
    id: 'FR04-RET-02',
    area: 'resource-retention',
    metric: 'retention-count',
    unit: 'count',
    description: 'indexById 键数恒等于消息数（长会话无孤儿索引）',
  },
  {
    id: 'FR04-RET-03',
    area: 'resource-retention',
    metric: 'reference-identity',
    unit: 'boolean',
    description: 'appendRevision 不原地改写旧 entry 的 revisions 数组（无别名泄漏）',
  },
  {
    id: 'FR04-RET-04',
    area: 'resource-retention',
    metric: 'retention-count',
    unit: 'count',
    description: '版本链上每个版本恰好保留一次（对象图无重复可达）',
  },
]);

export const PROBE_IDS: readonly string[] = Object.freeze(PERF_PROBES.map((p) => p.id));

/** 按 id 取登记项；不存在返回 null（不猜）。 */
export function probeById(id: string): PerfProbe | null {
  return PERF_PROBES.find((p) => p.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 结果登记（供证据文件与 runbook 使用）
// ---------------------------------------------------------------------------

export interface ProbeResult {
  readonly probeId: string;
  readonly metric: PerfMetric;
  readonly value: number;
  readonly threshold: number;
  readonly unit: string;
  /** value ≤ threshold。 */
  readonly pass: boolean;
  /**
   * 是否作为**硬门**（enforced=true 的失败即测试失败）。
   * enforced=false 表示「仅记录」：共享机器上该操作方差大，无法用固定阈值稳定判定，
   * 故只把实测值写进证据，不据此断言。
   */
  readonly enforced: boolean;
  readonly note: string;
}

/** 由登记项与实测值构造一条结果（id 未登记即抛错，杜绝野结果）。 */
export function evaluateProbe(
  probeId: string,
  value: number,
  threshold: number,
  note: string,
  enforced = true,
): ProbeResult {
  const probe = probeById(probeId);
  if (probe === null) throw new Error(`未登记的探测项 id：${probeId}`);
  return {
    probeId,
    metric: probe.metric,
    value,
    threshold,
    unit: probe.unit,
    pass: value <= threshold,
    enforced,
    note,
  };
}

/** 由 ScalingVerdict 构造结果（ratio ≤ ceiling 为通过）。 */
export function resultFromVerdict(
  probeId: string,
  verdict: ScalingVerdict,
  note: string,
  enforced = true,
): ProbeResult {
  return evaluateProbe(probeId, verdict.ratio, verdict.ceiling, note, enforced);
}

/** 一行摘要，便于在测试输出与证据文件里人工核对。 */
export function formatProbeResult(result: ProbeResult): string {
  const status = !result.enforced ? 'INFO' : result.pass ? 'OK  ' : 'FAIL';
  const gate = result.enforced ? `上限 ${result.threshold}` : '仅记录';
  return `${status} ${result.probeId} ${result.value.toFixed(3)} ${result.unit} (${gate}) ${result.note}`;
}
