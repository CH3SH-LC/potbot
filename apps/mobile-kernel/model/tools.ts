/**
 * K02 模型端口 —— **工具循环、幂等执行账本、结果配对**（零依赖）。
 *
 * ## 为什么这三件事必须凑在一个文件里，而不是散着"以后再说"
 *
 * `port.ts` 已经能把上游流翻译成契约片段，并给了 `onToolCall` 回调。但回调只解决
 * "这一条片段到了之后叫一声"，不解决模型端口最危险的两件事：
 *
 * 1. **重试会重复外部动作**。一次 `run()` 里模型可能连发几个 tool-call，中途断流或超时后
 *    上层若"再跑一遍"，已执行过的写文件/下单动作会被**再执行一次**。K02 的对策是
 *    `ToolActionLedger`：以 `toolCallId` 为键**记账**，同一个 ID 再来只**回放已记结果**，
 *    绝不第二次调用执行器。
 * 2. **工具结果没有与调用对应**。契约 `$defs.toolResult` 的说明是"工具结果必须带与调用 ID
 *    对应的 toolCallId"。`pairToolResults()` 把这条说明做成**机器判据**：结果指向不存在的
 *    调用要拒、同一 ID 收到**两个不同**的结果要拒。
 *
 * `runToolLoop()` 把上面两件事和 `ModelPort` 串成一条**有界**多轮循环：模型请求工具 →
 * 幂等执行 → 结果回灌成 `role: 'tool'` 消息 → 再请模型，直到模型不再要工具或到达步数上限。
 *
 * ## 执行器侧幂等护栏（K-I26 接线）
 *
 * `ToolActionLedger` 以 `toolCallId` 为键回放，挡住"同一个 ID 再来"；但**供应商重试后可能换
 * 一个 `toolCallId`**，此时仅按 ID 去重会漏判。`runToolLoop` 因此接受可选
 * `guard: ToolIdempotencyLedger`（来自 `apps/mobile-kernel/toolguard/`），把执行器调用包一层
 * **参数摘要**幂等：键 = `guardScope#toolName#stableStringify(arguments)`，命中已执行动作即回放。
 * 复用同一个 `guard` 跨运行重试，同一个 `order.submit` 无论换不换 ID 都只执行一次。
 *
 * ## 未做（如实标注）
 *
 * - **真实工具执行器不在此文件**：本模块只调用注入的 `executor`。文件读写、下单等真实端口
 *   属于 K07/K09 与业务线；本包用确定性假执行器做验收。
 * - **步数上限不是预算**：`maxSteps` 只限制工具轮数；token/成本仍由 `port.ts` 的 `Budget` 管。
 * - **执行器抛错**默认被记成一条 `isError: true` 的工具结果回灌给模型（让模型有机会改道），
 *   而不是直接判整次运行失败；这一策略是**显式**的，测试逐条覆盖。
 */

import { ModelPortError, streamCodeFor } from './errors.js';
import { redactCallRecord } from './redact.js';
import {
  mayClaimModelSuccess,
  type ModelPort,
  type ModelRunOutcome,
  type ModelStreamOptions,
} from './port.js';
import type { CancellationSource } from './cancellation.js';
import {
  TOOL_CALL_ID_PATTERN,
  type ChatMessage,
  type ModelCallRecord,
  type ModelPortRequest,
  type StreamChunk,
  type StreamError,
  type ToolCall,
  type ToolResult,
  type Usage,
} from './types.js';
import type { ModelPortErrorCode } from './errors.js';
import { deriveToolKey, ToolIdempotencyLedger } from '../toolguard/idempotency.js';

// ---------------------------------------------------------------------------
// 幂等执行账本
// ---------------------------------------------------------------------------

/** 一条**已记账**的工具执行。`replayed` 为真表示这是重试命中缓存，执行器**没有**再跑。 */
export interface ToolExecutionRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  /** 冲突判据用的调用参数快照（同一 ID 的参数变了就会被拒）。 */
  readonly callArguments: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly isError: boolean;
  /** 执行器是否抛错（抛错时 `isError` 一定为真，`result` 是错误说明对象）。 */
  readonly threw: boolean;
  /** 第几次**请求**执行这个 ID：1 = 首次真实执行，>1 = 回放。 */
  readonly requests: number;
}

export interface ToolExecutionOutcome {
  readonly record: ToolExecutionRecord;
  /** true ⇒ 命中账本，执行器未被调用（重试不重复工具动作）。 */
  readonly replayed: boolean;
}

/** 工具执行器：收到一次调用，返回（或异步返回）结果。**抛错由账本捕获并记账**。 */
export type ToolExecutor = (call: ToolCall) => unknown | Promise<unknown>;

function stableArguments(args: Readonly<Record<string, unknown>>): string {
  // 只用于"同一 ID 的参数是否变过"的判据；契约里 arguments 是 JSON 对象，序列化顺序稳定即可。
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return String(args);
  }
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 以 `toolCallId` 为键的工具执行账本。
 *
 * 语义（每一条都有独立测试）：
 * - 同一 ID **首次**执行 → 调执行器，记账，`replayed:false`；
 * - 同一 ID **再来**且工具名/参数**完全相同** → **不调执行器**，回放已记结果，`replayed:true`；
 * - 同一 ID 再来但工具名或参数**不同** → 抛 `tool_call_conflict`（一个 ID 只能是同一次调用）；
 * - 执行器抛错 → 记一条 `isError:true, threw:true` 的结果（**仍已记账**，重试不得再执行）。
 */
export class ToolActionLedger {
  private readonly records = new Map<string, ToolExecutionRecord>();

  /** 该 ID 是否已执行过（含失败）。 */
  has(toolCallId: string): boolean {
    return this.records.has(toolCallId);
  }

  /** 读取已记结果（没有则 undefined）。 */
  get(toolCallId: string): ToolExecutionRecord | undefined {
    return this.records.get(toolCallId);
  }

  /** 已记账条数。 */
  get size(): number {
    return this.records.size;
  }

  /** 全部记录的**快照**（按执行顺序）。 */
  entries(): readonly ToolExecutionRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * 幂等执行一次工具调用。返回的 `record` 是**最终权威结果**（首次或回放）。
   */
  async execute(call: ToolCall, executor: ToolExecutor): Promise<ToolExecutionOutcome> {
    const existing = this.records.get(call.toolCallId);
    if (existing !== undefined) {
      if (
        existing.toolName !== call.toolName ||
        stableArguments(existing.callArguments) !== stableArguments(call.arguments)
      ) {
        throw new ModelPortError(
          'tool_call_conflict',
          `toolCallId=${call.toolCallId} 先后用于不同工具或不同参数：一个 ID 只能对应同一次调用`,
        );
      }
      const replayed: ToolExecutionRecord = Object.freeze({ ...existing, requests: existing.requests + 1 });
      this.records.set(call.toolCallId, replayed);
      return { record: replayed, replayed: true };
    }

    let result: unknown;
    let isError = false;
    let threw = false;
    try {
      result = await executor(call);
    } catch (error) {
      threw = true;
      isError = true;
      result = Object.freeze({ message: describeThrown(error) });
    }
    const record: ToolExecutionRecord = Object.freeze({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      callArguments: call.arguments,
      result,
      isError,
      threw,
      requests: 1,
    });
    this.records.set(call.toolCallId, record);
    return { record, replayed: false };
  }
}

// ---------------------------------------------------------------------------
// 结果配对
// ---------------------------------------------------------------------------

export interface ToolPairIssue {
  readonly code: ModelPortErrorCode;
  readonly message: string;
}

export interface ToolPairResult {
  /** `toolCallId` → 该调用的结果。 */
  readonly paired: ReadonlyMap<string, ToolResult>;
  /** 所有配对问题；空数组 = 全部对应。 */
  readonly issues: readonly ToolPairIssue[];
}

function resultSignature(result: ToolResult): string {
  try {
    return JSON.stringify({ result: result.result ?? null, isError: result.isError === true });
  } catch {
    return String(result.result);
  }
}

/**
 * 把工具结果与调用**一一配对**。契约要求"结果必须与调用 ID 对应"，这里做成判据：
 *
 * - 结果的 `toolCallId` 找不到对应调用 ⇒ `tool_result_unknown_call`；
 * - 同一 `toolCallId` 收到**两个内容不同**的结果 ⇒ `tool_result_duplicate`
 *   （内容完全相同的重复是允许的——那是幂等回放，不是矛盾）。
 *
 * **不**要求每个调用都有结果：模型可以只发调用、结果稍后再回灌。
 */
export function pairToolResults(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
): ToolPairResult {
  const known = new Set(calls.map((call) => call.toolCallId));
  const paired = new Map<string, ToolResult>();
  const issues: ToolPairIssue[] = [];

  for (const result of results) {
    if (!known.has(result.toolCallId)) {
      issues.push({
        code: 'tool_result_unknown_call',
        message: `工具结果的 toolCallId=${result.toolCallId} 找不到对应调用（契约：结果必须与调用 ID 对应）`,
      });
      continue;
    }
    const previous = paired.get(result.toolCallId);
    if (previous !== undefined && resultSignature(previous) !== resultSignature(result)) {
      issues.push({
        code: 'tool_result_duplicate',
        message: `toolCallId=${result.toolCallId} 收到两个不同的结果：一次调用只有一个权威结果`,
      });
      continue;
    }
    paired.set(result.toolCallId, previous ?? result);
  }

  return Object.freeze({ paired, issues: Object.freeze(issues) });
}

/** 配对有问题就抛（用第一个问题的码）。 */
export function assertToolResultsPaired(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
): ReadonlyMap<string, ToolResult> {
  const { paired, issues } = pairToolResults(calls, results);
  const first = issues[0];
  if (first !== undefined) {
    throw new ModelPortError(first.code, first.message);
  }
  return paired;
}

// ---------------------------------------------------------------------------
// 工具调用形状校验（账本入口，独立于 port.ts 的流映射）
// ---------------------------------------------------------------------------

/** 校验一次 `ToolCall` 的形状；非法即抛对应拒因。 */
export function assertToolCall(call: ToolCall): ToolCall {
  if (typeof call.toolCallId !== 'string' || call.toolCallId.length === 0) {
    throw new ModelPortError('tool_call_missing_id', 'toolCallId 为空：结果无处对应');
  }
  if (!TOOL_CALL_ID_PATTERN.test(call.toolCallId)) {
    throw new ModelPortError(
      'invalid_tool_call',
      `toolCallId 不符合契约 pattern：${JSON.stringify(call.toolCallId)}`,
    );
  }
  if (typeof call.toolName !== 'string' || call.toolName.length === 0) {
    throw new ModelPortError('invalid_tool_call', 'toolName 为空');
  }
  if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) {
    throw new ModelPortError('invalid_tool_call', 'arguments 必须是对象');
  }
  return call;
}

// ---------------------------------------------------------------------------
// 有界工具循环
// ---------------------------------------------------------------------------

/** 默认工具轮数上限。 */
export const DEFAULT_MAX_TOOL_STEPS = 8;

export interface ToolLoopOptions {
  /** 工具执行器（**必需**：没有执行器就没有循环）。 */
  readonly executor: ToolExecutor;
  /** 跨轮复用的账本；缺省新建一个（同一批重试要复用同一个才能幂等，见 README）。 */
  readonly ledger?: ToolActionLedger;
  /**
   * **执行器侧幂等护栏**（K-I26，推荐跨运行/跨重试复用同一个）。传入后，每次执行器调用
   * 先过 `ToolIdempotencyLedger`（键 = `scope#toolName#参数摘要`），命中已执行的动作**回放**，
   * 执行器**不再被调用**。这挡住了 `ToolActionLedger` 挡不住的一种重试：供应商重试后换了
   * 新的 `toolCallId`，仅按 ID 去重会漏判、把同一外部动作执行两次。
   */
  readonly guard?: ToolIdempotencyLedger;
  /** 护栏的幂等作用域（如 taskId）：隔离不同任务里的同名同参动作；缺省 `'default'`。 */
  readonly guardScope?: string;
  /** 工具轮数上限，缺省 `DEFAULT_MAX_TOOL_STEPS`。 */
  readonly maxSteps?: number;
  /** 取消来源（透传给每次都 `port.run`）。 */
  readonly cancellation?: CancellationSource;
  /** 每执行（或回放）一次工具后回调；可用于审计，不改变结果。 */
  readonly onToolExecution?: (call: ToolCall, outcome: ToolExecutionOutcome) => void;
}

export interface ToolLoopOutcome extends ModelRunOutcome {
  /** 实际发生的模型轮数（≥1）。 */
  readonly steps: number;
  /** 按执行顺序的全部工具记账（含回放）。 */
  readonly toolExecutions: readonly ToolExecutionRecord[];
  /** 本轮复用的账本（便于上层跨批查询/复用）。 */
  readonly ledger: ToolActionLedger;
  /** 本轮使用的执行器侧幂等护栏（未传则 undefined）；便于上层跨批查询/复用。 */
  readonly guard?: ToolIdempotencyLedger;
}

/**
 * 把执行器包进幂等护栏：调用前先按 `scope#toolName#参数摘要` 查账本，命中已执行动作
 * 直接回放（执行器不再被调用）。`deriveToolKey` 保证参数键顺序不同也认作同一动作。
 */
function guardExecutor(
  executor: ToolExecutor,
  guard: ToolIdempotencyLedger,
  scope: string | undefined,
): ToolExecutor {
  return async (call: ToolCall): Promise<unknown> => {
    const key = deriveToolKey(scope, call);
    const record = await guard.execute(
      key,
      { toolName: call.toolName, toolCallId: call.toolCallId },
      () => executor(call),
    );
    return record.value;
  };
}

function toolMessage(call: ToolCall, record: ToolExecutionRecord): ChatMessage {
  let content: string;
  try {
    content = JSON.stringify(record.isError ? { error: record.result } : { result: record.result });
  } catch {
    content = String(record.result);
  }
  return Object.freeze({ role: 'tool', toolCallId: call.toolCallId, content });
}

/** 由一次 `ModelRunOutcome` 派生一个带 `steps/ledger/guard` 的循环结果。 */
function withLoop(
  outcome: ModelRunOutcome,
  steps: number,
  ledger: ToolActionLedger,
  guard: ToolIdempotencyLedger | undefined,
): ToolLoopOutcome {
  return Object.freeze({
    ...outcome,
    steps,
    toolExecutions: ledger.entries(),
    ledger,
    ...(guard === undefined ? {} : { guard }),
  });
}

function stepLimitOutcome(
  last: ModelRunOutcome,
  steps: number,
  ledger: ToolActionLedger,
  guard: ToolIdempotencyLedger | undefined,
  maxSteps: number,
): ToolLoopOutcome {
  const error: StreamError = Object.freeze({
    code: streamCodeFor('step_limit_exceeded'),
    message: `工具循环达到步数上限 maxSteps=${maxSteps}：不把未收束的循环当成功`,
  });
  const record: ModelCallRecord = redactCallRecord({
    model: last.model,
    host: last.host,
    usage: last.usage,
    error,
  });
  return Object.freeze({
    ...last,
    status: 'failed' as const,
    error,
    completed: false,
    record,
    steps,
    toolExecutions: ledger.entries(),
    ledger,
    ...(guard === undefined ? {} : { guard }),
  });
}

/**
 * 驱动一次**有界**工具循环。
 *
 * 每轮：`port.run(当前消息)` → 若失败/取消**立即如实返回**（不重试、不吞错）→ 若没有
 * tool-call 则返回成功 → 否则对每个调用**幂等执行**，把结果以 `role:'tool'` 消息回灌 →
 * 下一轮。到达 `maxSteps` 仍未收束 ⇒ `step_limit_exceeded` 失败。
 *
 * **不自己重试**：断流/超时/限流的重试策略在上层，且**必须复用同一个 `ledger`/`guard`**，
 * 否则重试会重复工具动作（这正是本模块存在的理由）。跨运行/跨重试的重试，推荐复用同一个
 * `guard`（`ToolIdempotencyLedger`）：它以参数摘要为键，连"重试后换了 toolCallId"也能挡住。
 */
export async function runToolLoop(
  port: ModelPort,
  request: ModelPortRequest,
  options: ToolLoopOptions,
): Promise<ToolLoopOutcome> {
  if (options.executor === undefined || options.executor === null) {
    throw new ModelPortError('invalid_request', 'runToolLoop 需要 executor：没有执行器的工具循环是空转');
  }
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_TOOL_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new ModelPortError('invalid_request', `maxSteps 必须是 ≥1 的整数，收到 ${JSON.stringify(maxSteps)}`);
  }
  const ledger = options.ledger ?? new ToolActionLedger();
  const guard = options.guard;
  // 护栏在执行器**外层**：即使本轮的 ToolActionLedger 是新的（跨运行重试），只要复用同一个 guard，
  // 同一逻辑动作仍然只执行一次（挡住"重试换了 toolCallId"的重复副作用）。
  const effectiveExecutor: ToolExecutor =
    guard === undefined ? options.executor : guardExecutor(options.executor, guard, options.guardScope);
  const streamOptions: ModelStreamOptions =
    options.cancellation === undefined ? {} : { cancellation: options.cancellation };

  const messages: ChatMessage[] = [...request.messages];
  let text = '';
  let usage: Usage | null = null;
  let last: ModelRunOutcome | null = null;

  for (let step = 1; step <= maxSteps; step += 1) {
    // 传**冻结的副本**：冻结的是快照，不是 `messages` 本身（否则下一轮 push 会撞上"不可扩展"）。
    const outcome = await port.run(
      { ...request, messages: Object.freeze([...messages]) },
      streamOptions,
    );
    last = outcome;
    text += outcome.text;
    if (outcome.usage !== null) {
      usage = outcome.usage;
    }
    if (!mayClaimModelSuccess(outcome)) {
      // 失败/取消立即如实返回（账本随结果带出，便于上层复用重试）。
      return withLoop({ ...outcome, text, usage }, step, ledger, guard);
    }
    if (outcome.toolCalls.length === 0) {
      return withLoop({ ...outcome, text, usage }, step, ledger, guard);
    }

    for (const call of outcome.toolCalls) {
      assertToolCall(call);
      const execOutcome = await ledger.execute(call, effectiveExecutor);
      if (options.onToolExecution !== undefined) {
        options.onToolExecution(call, execOutcome);
      }
      messages.push(toolMessage(call, execOutcome.record));
    }
  }

  const base = last ?? (await port.run(request, streamOptions));
  return stepLimitOutcome({ ...base, text, usage }, maxSteps, ledger, guard, maxSteps);
}

/** 由循环结果派生一个便于断言/审计的摘要。 */
export function summarizeToolLoop(outcome: ToolLoopOutcome): {
  readonly ok: boolean;
  readonly text: string;
  readonly toolExecutions: readonly ToolExecutionRecord[];
  readonly steps: number;
  readonly chunkTypes: readonly StreamChunk['type'][];
} {
  return Object.freeze({
    ok: mayClaimModelSuccess(outcome),
    text: outcome.text,
    toolExecutions: outcome.toolExecutions,
    steps: outcome.steps,
    chunkTypes: outcome.chunks.map((chunk) => chunk.type),
  });
}
