/**
 * 观测事件的记录、订阅与汇总（归属 D06，`src/fake/`）。
 *
 * 合同第七节 Q10-b：**内核原生发出结构化事件，测试侧订阅采集**；假 Agent 不得直接改内核状态。
 * 因此本模块是 `src/protocol` 的 `KernelEvent` 的**唯一落点**：
 * 事件由内核经 `record(KernelEventInput)` 送入，用 `createKernelEvent()` 构造（不另造事件类型），
 * 由 `summarizeKernelEvents()` 汇总为 `EventCounters`（合同 Q10-a 的计数口径）。
 *
 * 合同 Q10-c / 指导文件：证据必须是可追踪的 JSON / JSONL，不能只有终端最后一句 PASS。
 * 本模块输出**规范化 JSON**（键序稳定），保证「固定种子 + 固定调度顺序」下逐字节可复现；
 * 记录里**不含墙钟时间戳**（含墙钟就必然不可逐字节复现），执行时间由夹具显式登记在元信息层。
 */

import {
  createIdSource,
  createKernelEvent,
  summarizeKernelEvents,
  type EventIdSource,
  type KernelEvent,
  type KernelEventInput,
  type KernelEventKind,
  type LogicalTime,
  type EventCounters,
} from '../protocol/index.js';
import { canonicalJson, contentDigest } from './digest.js';
import { EventRecorderError } from './errors.js';

/** 记录器元信息：场景标识、种子/固定顺序标识。合同 Q8-c 要求种子集合在测试前登记。 */
export interface RecorderMeta {
  readonly scenario?: string;
  /** 种子值或「固定顺序集」标识（确定性场景可以写 `'fixed-order'`）。 */
  readonly seed?: string | number;
  /** 固定调度顺序的登记（逐步列出放行了什么）。 */
  readonly schedule?: readonly string[];
  /** 工作区差异 / 版本标识（合同要求证据含「代码提交或工作区差异标识」）。 */
  readonly revision?: string;
}

/** 汇总：给「观测字段表」直接取用的计数量。 */
export interface EventSummary {
  readonly total: number;
  /** 按事件种类计数，键升序，保证输出稳定。 */
  readonly byKind: Readonly<Record<string, number>>;
  readonly firstAt: LogicalTime | null;
  readonly lastAt: LogicalTime | null;
  /** 合同 Q10-a 的**事件侧**计数口径（来自 `summarizeKernelEvents`；R19 后不含快照侧字段）。 */
  readonly counters: EventCounters;
  /** 事件序列（JSONL）的内容摘要，用于「逐字节一致」的判据。 */
  readonly digest: string;
}

/** 事件订阅者（采样器、实时断言等）。 */
export type EventListener = (event: KernelEvent) => void;

/** 待落事件：不含 `event_id`——事件 id 由记录器统一分配，保证确定性序。 */
export type KernelEventDraft = Omit<KernelEventInput, 'event_id'>;

/**
 * 观测事件记录器：`KernelEvent` 的落点 + 汇总 + 可追踪证据输出。
 *
 * 事件的**生产**在内核（Q10-b）；本记录器只负责落、看、导出。
 */
export class EventRecorder {
  readonly #events: KernelEvent[] = [];
  readonly #meta: RecorderMeta;
  readonly #idSource: EventIdSource;
  readonly #listeners: EventListener[] = [];

  /**
   * @param meta 证据元信息。
   * @param options.idSource 事件 id 生成器；默认按 `meta.seed` 造一个确定性生成器
   *   （同种子 → 同事件 id 序列，支撑 Q8-c 的可复现性）。
   */
  constructor(meta: RecorderMeta = {}, options: { readonly idSource?: EventIdSource } = {}) {
    this.#meta = { ...meta };
    this.#idSource =
      options.idSource ??
      createIdSource(meta.seed === undefined ? {} : { seed: String(meta.seed) });
  }

  get meta(): RecorderMeta {
    return this.#meta;
  }

  /** 已落的事件条数。 */
  get size(): number {
    return this.#events.length;
  }

  /** 全部事件（按发生顺序）。 */
  get events(): readonly KernelEvent[] {
    return this.#events;
  }

  /**
   * 订阅事件流（返回退订函数）。
   * 用于「由生产路径发出的同类事件同时驱动采样器 / 实时断言」——
   * 采样器因此看到的是**内核原生事件**，而不是夹具自报的数字（Q10-b）。
   */
  subscribe(listener: EventListener): () => void {
    if (typeof listener !== 'function') {
      throw new EventRecorderError('事件订阅者必须是函数');
    }
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index >= 0) this.#listeners.splice(index, 1);
    };
  }

  /**
   * 落一条内核事件（用 `createKernelEvent()` 构造，事件 id 由记录器统一分配）。
   *
   * 数据不可序列化时**在发生点**抛错，而不是等到导出证据时才炸。
   * @throws {EventRecorderError} 事件形状非法时（`createKernelEvent` 的 `ValidationError` 会原样冒泡）。
   */
  record(input: KernelEventDraft): KernelEvent {
    if (!Number.isFinite(input.at)) {
      throw new EventRecorderError(
        `事件 ${input.kind} 的逻辑时间必须是有限数，收到 ${String(input.at)}`,
      );
    }
    // 立即规范化一次：`data` 里出现 NaN / bigint / 函数时当场失败。
    canonicalJson(input.data ?? {});

    const event = createKernelEvent(input, this.#idSource);
    this.#events.push(event);
    for (const listener of [...this.#listeners]) listener(event);
    return event;
  }

  /** 按种类取事件（保持发生顺序）。 */
  byKind(kind: KernelEventKind): readonly KernelEvent[] {
    return this.#events.filter((event) => event.kind === kind);
  }

  /** 某种类的事件条数（计数类断言的直接来源）。 */
  countOf(kind: KernelEventKind): number {
    let count = 0;
    for (const event of this.#events) if (event.kind === kind) count += 1;
    return count;
  }

  /**
   * 合同 Q10-a 的**事件侧**计数口径（运行轮次数、峰值、被拒发布、诊断次数……）。
   *
   * R19 后 `KernelEvent` 不再承载工作项分布 / 阻塞原因；那两项由快照侧的
   * `summarizeSnapshotCounters(snapshot)` 产出，合并用 `mergeSchedulingCounters()`。
   */
  counters(): EventCounters {
    return summarizeKernelEvents(this.#events);
  }

  /** 汇总：总条数、按种类计数、首末时间、计数口径、内容摘要。 */
  summary(): EventSummary {
    const byKind: Record<string, number> = {};
    for (const event of this.#events) {
      byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    }
    const sorted: Record<string, number> = {};
    for (const kind of Object.keys(byKind).sort()) {
      const value = byKind[kind];
      if (value !== undefined) sorted[kind] = value;
    }
    const first = this.#events[0];
    const last = this.#events[this.#events.length - 1];
    return {
      total: this.#events.length,
      byKind: sorted,
      firstAt: first === undefined ? null : first.at,
      lastAt: last === undefined ? null : last.at,
      counters: this.counters(),
      digest: contentDigest(this.toJSONL()),
    };
  }

  /** JSONL：一行一个事件，行内键序规范化。空记录器输出空字符串。 */
  toJSONL(): string {
    if (this.#events.length === 0) return '';
    return `${this.#events.map((event) => canonicalJson(event)).join('\n')}\n`;
  }

  /** 汇总 JSON：元信息 + 汇总 + 全部事件，整体键序规范化。 */
  toJSON(): string {
    return canonicalJson({
      meta: this.#meta,
      summary: this.summary(),
      events: this.#events,
    });
  }

  /** 事件序列内容摘要（`sha256:...`），用于可复现性逐字节比对。 */
  digest(): string {
    return contentDigest(this.toJSONL());
  }

  /** 清空事件（保留元信息与订阅）。受控缺陷注入的「注入前 / 注入后」对照可用。 */
  reset(): void {
    this.#events.length = 0;
  }
}
