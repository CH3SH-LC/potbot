/**
 * K10 脱敏诊断日志 —— **字段白名单 + 明文拒写 + 有界环形缓冲**。
 *
 * ## 三条不可越过的线
 *
 * 1. **白名单字段**：一条诊断事件只有 `seq / at / kind / severity / taskId / code / detail`
 *    七个字段（`DIAGNOSTIC_FIELDS`）。`record()` **逐字段构造**，不做"展开原对象再删键"——
 *    那种写法一旦上游加了字段就静默泄漏。测试逐字段断言，多一个都不行。
 * 2. **明文拒写**：`code` / `taskId` / `detail` 过一遍密钥扫描，命中即抛
 *    `diagnostic_secret_detected`，**该条不落盘、不脱敏、不回显**。宁可丢一条诊断，
 *    也不把日志变成泄漏点。
 * 3. **有界**：环形缓冲容量固定。溢出时丢**最旧**的一条并累加 `dropped()`。
 *    `seq` 在整个生命周期内单调递增（不在溢出时回退），因此"丢了 n 条"可从
 *    `events()[0].seq > 0` 与 `dropped()` 复原——不掩盖丢失。
 *
 * ## 时钟
 *
 * 与仓库纪律一致：**不持有墙钟**，`now()` 由调用方注入，测试可确定性推进。
 */

import { ObservabilityError } from './errors.js';
import { findPlaintextSecret } from './redact.js';

/** 诊断种类词表（未知 kind 一律拒，不自由发挥）。 */
export const DIAGNOSTIC_KINDS = ['lifecycle', 'network', 'recovery', 'notification', 'task'] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

export const DIAGNOSTIC_SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** **允许出现的字段名**（测试逐字段断言，多一个都不行）。 */
export const DIAGNOSTIC_FIELDS = ['seq', 'at', 'kind', 'severity', 'taskId', 'code', 'detail'] as const;
export type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

export interface DiagnosticEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: DiagnosticKind;
  readonly severity: DiagnosticSeverity;
  readonly taskId: string;
  readonly code: string;
  /** 人类可读补充说明；已过密钥扫描。可为空串，但**永不**是原始对象。 */
  readonly detail: string;
}

export interface DiagnosticsRecordInput {
  readonly kind: DiagnosticKind;
  readonly severity: DiagnosticSeverity;
  readonly taskId: string;
  readonly code: string;
  readonly detail?: string;
}

/** 只读时钟视图（与 K07 的 `Clock` 结构兼容，此处自持类型避免跨包耦合）。 */
export interface DiagnosticsClock {
  now(): number;
}

export interface DiagnosticsLogOptions {
  readonly clock: DiagnosticsClock;
  /** 环形缓冲容量，默认 256。必须是不小于 1 的安全整数。 */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 256;

export class DiagnosticsLog {
  readonly #clock: DiagnosticsClock;
  readonly #capacity: number;
  readonly #events: DiagnosticEvent[] = [];
  #seq = 0;
  #dropped = 0;

  constructor(options: DiagnosticsLogOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new ObservabilityError('invalid_diagnostic_event', '构造诊断日志必须注入 clock');
    }
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new ObservabilityError(
        'invalid_capacity',
        `诊断环形缓冲容量必须是不小于 1 的安全整数，收到 ${String(capacity)}`,
      );
    }
    this.#clock = options.clock;
    this.#capacity = capacity;
  }

  /**
   * 记一条诊断。命中明文密钥 ⇒ 抛 `diagnostic_secret_detected`，**该条不入库**。
   */
  record(input: DiagnosticsRecordInput): DiagnosticEvent {
    if (input === null || typeof input !== 'object') {
      throw new ObservabilityError('invalid_diagnostic_event', '诊断输入必须是对象');
    }
    const kind = requireEnum(input.kind, DIAGNOSTIC_KINDS, 'kind');
    const severity = requireEnum(input.severity, DIAGNOSTIC_SEVERITIES, 'severity');
    const taskId = requireText(input.taskId, 'taskId');
    const code = requireText(input.code, 'code');
    const detail = input.detail === undefined ? '' : requireTextAllowEmpty(input.detail, 'detail');

    // 明文密钥判据：code / taskId / detail 都在列（taskId 也可能被模型污染）。
    for (const [field, value] of [
      ['taskId', taskId],
      ['code', code],
      ['detail', detail],
    ] as const) {
      if (findPlaintextSecret(value) !== null) {
        throw new ObservabilityError(
          'diagnostic_secret_detected',
          `诊断事件字段 ${field} 命中明文密钥特征：拒绝写入（原文已隐去，不落盘）`,
        );
      }
    }

    const event: DiagnosticEvent = Object.freeze({
      seq: this.#seq,
      at: this.#clock.now(),
      kind,
      severity,
      taskId,
      code,
      detail,
    });
    this.#seq += 1;

    if (this.#events.length >= this.#capacity) {
      this.#events.shift();
      this.#dropped += 1;
    }
    this.#events.push(event);
    return event;
  }

  /** 当前留存的事件（副本数组；元素冻结）。 */
  events(): readonly DiagnosticEvent[] {
    return Object.freeze([...this.#events]);
  }

  /** 溢出丢弃的条数（不掩盖丢失）。 */
  dropped(): number {
    return this.#dropped;
  }

  /** 已分配过的最大 seq + 1（等于写入尝试次数，含被拒的？否——被拒的在分配前抛出）。 */
  nextSeq(): number {
    return this.#seq;
  }

  /**
   * 导出为可落盘/可分享的文本快照。逐条重建为**白名单字段**对象，
   * 因此即使内部结构将来变化，导出内容也不会多带字段。
   */
  snapshot(): readonly DiagnosticEvent[] {
    return Object.freeze(
      this.#events.map((e) =>
        Object.freeze({
          seq: e.seq,
          at: e.at,
          kind: e.kind,
          severity: e.severity,
          taskId: e.taskId,
          code: e.code,
          detail: e.detail,
        }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 内部校验
// ---------------------------------------------------------------------------

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ObservabilityError(
      'invalid_diagnostic_event',
      `字段 ${field} 必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function requireTextAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ObservabilityError(
      'invalid_diagnostic_event',
      `字段 ${field} 必须是字符串，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObservabilityError(
      'invalid_diagnostic_event',
      `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}
