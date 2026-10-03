/**
 * 工具动作幂等账本（K-I26：由 K-R03 测试区提升为**产品模块**）——
 * **重试不得重复执行一次外部动作**。
 *
 * ## 为什么这是承重件
 *
 * K02 模型端口在 `model/port.ts` 里把"工具执行器抛错"定义为 `tool_execution_failed`，
 * 并写明"本次执行已记账：重试**不得**再执行一次——见 `tools.ts`"。
 * `model/tools.ts` 的 `ToolActionLedger` 以 `toolCallId` 为键回放，能挡住"同一个 ID 再来"，
 * **但挡不住供应商在重试后换一个 `toolCallId`** 的情形（真实供应商确实可能这样做）。
 * 而"重试"恰恰是最常见的失败恢复手段（429 / 断流都可重试）。一段朴素重试会这样：
 *
 * ```ts
 * for (let i = 0; i < 3; i++) { const r = await port.run(req, { onToolCall }); if (ok) return r; }
 * ```
 *
 * 第一次运行发起 `order.submit`（真实副作用！）后断流失败；重试让模型**又**产出同一个
 * 工具调用（可能换 ID），`onToolCall` 于是**第二次**执行 `order.submit`——用户被下两次单。
 * 本账本把"同一个逻辑动作只执行一次"做成**机器判据**，并作为**执行器侧护栏**接入
 * `model/tools.ts` 的 `runToolLoop`（见 `ToolLoopOptions.guard`）。
 *
 * ## 判据
 *
 * - 键 = `idempotencyKey`（调用方给）或 `scope#toolName#stableStringify(arguments)`（本地派生）。
 *   用**参数摘要**而不是仅 `toolCallId`：供应商重试后完全可能换 ID，只看 ID 会漏判。
 * - 已 `executed` ⇒ 复用记录值，**不再调用执行器**。
 * - `pending`（执行中/崩溃在执行中）⇒ **拒**，不重跑（副作用可能已发生一半）。
 * - `failed`（执行器抛错，可能已部分生效）⇒ 默认**拒**重跑（保守；允许显式 `allowRetryFailed` 放开）。
 *
 * 诚实标注：这是**进程内**账本。跨进程/崩溃后的持久化恢复不在本模块（持久化由 K09/K10 承接）。
 */

import type { ToolCall } from '../model/types.js';

/** 单个逻辑工具动作在账本里的状态。 */
export type ToolExecutionState = 'executed' | 'pending' | 'failed';

/** 一次工具执行的**可机读**记录。字段与 `schemas.ts` 的 `TOOL_EXECUTION_RECORD_SCHEMA` 对齐。 */
export interface ToolExecutionRecord {
  /** 幂等键（调用方给或本地派生）。 */
  readonly key: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly state: ToolExecutionState;
  /** `executed` 时的结果值；其余状态为 `null`。 */
  readonly value: unknown;
  /** 本次结果是否**复用**了账本里既有记录（true = 执行器**未**被调用）。 */
  readonly reused: boolean;
  /** `failed` 时的错误信息（其余为 `null`）。 */
  readonly error: string | null;
}

/** 账本拒绝重跑时的**专属**错误码。 */
export const TOOL_IDEMPOTENCY_ERROR_CODES = ['tool_in_flight', 'tool_already_failed'] as const;
export type ToolIdempotencyErrorCode = (typeof TOOL_IDEMPOTENCY_ERROR_CODES)[number];

export class ToolIdempotencyError extends Error {
  readonly code: ToolIdempotencyErrorCode;
  readonly key: string;

  constructor(code: ToolIdempotencyErrorCode, key: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = 'ToolIdempotencyError';
    this.code = code;
    this.key = key;
  }
}

/** 稳定序列化：对象键排序，保证同一逻辑参数得到同一字符串（跨重试比对用）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 由 `scope + toolName + 参数摘要` 派生幂等键。
 *
 * `scope`（如 taskId / conversationId）把不同任务里"同名同参"的两个动作区分开，
 * 避免一个任务里的调用误判成另一个任务的重试。
 */
export function deriveToolKey(scope: string | undefined, call: Pick<ToolCall, 'toolName' | 'arguments'>): string {
  const prefix = scope === undefined || scope.length === 0 ? 'default' : scope;
  return `${prefix}#${call.toolName}#${stableStringify(call.arguments)}`;
}

interface StoredEntry {
  readonly toolName: string;
  readonly toolCallId: string;
  state: ToolExecutionState;
  value: unknown;
  error: string | null;
}

export interface ToolIdempotencyLedgerOptions {
  /**
   * 允许对 `failed` 的执行再跑一次。**默认 false**：执行器已经抛错，副作用是否发生未知，
   * 保守地不重跑。真实系统要让失败动作可重试，必须先有"动作是否已生效"的查询（本模块不做）。
   */
  readonly allowRetryFailed?: boolean;
}

/**
 * 进程内幂等账本。所有方法同步返回已定型的记录；`execute()` 是唯一的执行入口。
 */
export class ToolIdempotencyLedger {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly allowRetryFailed: boolean;

  constructor(options: ToolIdempotencyLedgerOptions = {}) {
    this.allowRetryFailed = options.allowRetryFailed ?? false;
  }

  /** 账本里已登记的逻辑动作数。 */
  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): ToolExecutionRecord | null {
    const entry = this.entries.get(key);
    return entry === undefined ? null : toRecord(key, entry, entry.state === 'executed');
  }

  keys(): readonly string[] {
    return Object.freeze([...this.entries.keys()]);
  }

  /**
   * 执行（或复用）一个逻辑工具动作。
   *
   * - 命中 `executed` ⇒ 返回记录值，`reused: true`，**执行器不被调用**。
   * - 命中 `pending` ⇒ 抛 `tool_in_flight`，**不重跑**。
   * - 命中 `failed` 且未开 `allowRetryFailed` ⇒ 抛 `tool_already_failed`，**不重跑**。
   * - 未命中 ⇒ 置 `pending`，调用执行器；成功置 `executed`，抛错置 `failed` 并透传原错。
   */
  async execute(
    key: string,
    context: { readonly toolName: string; readonly toolCallId: string },
    executor: () => unknown | Promise<unknown>,
  ): Promise<ToolExecutionRecord> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('幂等键必须是非空字符串');
    }
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.state === 'executed') {
        return toRecord(key, existing, true);
      }
      if (existing.state === 'pending') {
        throw new ToolIdempotencyError(
          'tool_in_flight',
          key,
          `键 ${key} 的动作处于 pending（可能崩溃在执行中）：拒绝重跑，副作用可能已发生一半`,
        );
      }
      if (!this.allowRetryFailed) {
        throw new ToolIdempotencyError(
          'tool_already_failed',
          key,
          `键 ${key} 的动作此前已失败：默认拒绝重跑（副作用未知）`,
        );
      }
    }

    const entry: StoredEntry = {
      toolName: context.toolName,
      toolCallId: context.toolCallId,
      state: 'pending',
      value: null,
      error: null,
    };
    this.entries.set(key, entry);
    try {
      const value = await executor();
      entry.state = 'executed';
      entry.value = value;
      return toRecord(key, entry, false);
    } catch (error) {
      entry.state = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

function toRecord(key: string, entry: StoredEntry, reused: boolean): ToolExecutionRecord {
  return Object.freeze({
    key,
    toolName: entry.toolName,
    toolCallId: entry.toolCallId,
    state: entry.state,
    value: entry.value,
    reused,
    error: entry.error,
  });
}
