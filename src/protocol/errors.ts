/**
 * 错误类型（合同 §九-1 的强制要求）。
 *
 * **核心不变量**：调用方必须能从错误对象上区分
 *   ①「未接受」——事务未提交，什么都没落库，**不得报告消息已接受**；
 *   ②「已接受但事件未投递」——事务已提交，消息已可靠保存，但待投递事件仍在 outbox，
 *      可通过 `Store.replayUndelivered()` 重放，**不得重复建业务工作**。
 *
 * 三种错误各司其职，不要用 `instanceof Error` 的宽判据替代。
 */

import type { EventId } from './ids.js';

/** 参数 / 形状校验失败（属于调用方错误，非持久化失败）。 */
export class ValidationError extends Error {
  readonly accepted = false as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

/**
 * 事务提交前失败 → **未接受**。
 * 合同 §九-1：持久化失败时不能报告消息已接受。
 */
export class PersistenceError extends Error {
  /** 恒为 false：本次调用没有产生任何可见状态。 */
  readonly accepted = false as const;
  readonly phase = 'commit' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PersistenceError';
  }
}

/**
 * 事务已提交、但待投递事件发布失败 → **已接受**。
 *
 * 语义：消息与工作项已可靠落库（可以报告"已接受"），但调度事件仍在 outbox；
 * 恢复路径是重放未投递事件（合同 Q6-b）。恢复动作必须幂等，不得重复建业务工作。
 */
export class PublicationError extends Error {
  /** 恒为 true：状态已提交，消息已可靠保存。 */
  readonly accepted = true as const;
  readonly phase = 'publish' as const;
  /** 当前仍未投递的事件 id（**包含**本次发布失败的那一条）。 */
  readonly undelivered_event_ids: readonly EventId[];

  constructor(message: string, undeliveredEventIds: readonly EventId[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicationError';
    this.undelivered_event_ids = undeliveredEventIds;
  }
}

/**
 * 观测事件**算不出计数器**（合同 v1.1 R4：禁止静默零值）。
 *
 * 汇总器无法从给定事件流真实算出某个计数器时抛本错误，而**绝不返回 0 冒充观测值**——
 * 否则 `peak_active_runs ≤ 1` 这类核心判据会恒真通过（A02 的空跑陷阱）。
 */
export class EventCountingError extends Error {
  readonly accepted = false as const;
  /** 无法真实算出的计数器名（如 `peak_active_runs`）。 */
  readonly counter: string;
  /** 出错事件在事件流中的下标（-1 表示与单条事件无关的结构性问题）。 */
  readonly event_index: number;

  constructor(message: string, counter: string, eventIndex: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EventCountingError';
    this.counter = counter;
    this.event_index = eventIndex;
  }
}

/** 事务已提交但发布失败（调用方据此走上"重放"分支，而不是"重投消息"分支）。 */
export function isAcceptedFailure(error: unknown): error is PublicationError {
  return error instanceof PublicationError;
}

/**
 * 消息是否"已可靠保存"（合同 §九-1 的判定式）。
 *
 * 与 `isAcceptedFailure` 的区别是输入域：本函数面向**任意** catch 到的值，
 * 非错误对象一律返回 false（不能把 `undefined` 之类的值当成"已接受"的证据）。
 */
export function wasMessageAccepted(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return isAcceptedFailure(error);
}
