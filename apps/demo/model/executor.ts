/**
 * S4 —— **真实执行器**：多轮上下文 + 工具续接 + 取消信号 + 硬预算
 * （KRN-04；合同 R221–R226）。
 *
 * ## 这个模块负责什么、不负责什么
 *
 * 负责（R221/R222/R223）：
 * - 把**完整上下文**（system + 历史 + 本轮）连同**工具声明**发给真实模型；
 * - 把模型返回的**工具调用**解析成结构化对象——**模型输出绝不直接执行**（R222）；
 * - 把工具结果**由代码**续接进上下文（R223：机械转发不靠模型转述）；
 * - 把取消信号与硬预算贯穿到每一次请求之前（R221/R225）。
 *
 * 不负责：
 * - **不**执行任何工具（工具的真实动作由调用方注册的 `ToolHandler` 提供）；
 * - **不**决定重试与降级（那是宿主的策略）；
 * - **不**把失败写成成功（R226）。
 *
 * ## 假 Agent 的地位（R224）
 *
 * `createFakeExecutor()` 只是**可控测试替身**：它按脚本返回预设轮次。
 * 它**不得**被用于最终验收——验收必须走 `createRealExecutor()` + 真实端点。
 * 因此这里把它单独命名并注明，避免"测着测着就把它当成了真实执行器"。
 */

import { LIMITS } from '../contracts.js';
import { ModelCallError, isModelCallError } from './errors.js';
import {
  DEFAULT_EXECUTOR_BUDGET,
  type ExecutorBudget,
  type ExecutorMessage,
  type ExecutorRequest,
  type ExecutorToolCall,
  type ExecutorTurn,
  type RealExecutor,
  type ToolHandler,
  type ToolLoopResult,
} from './executor-types.js';
import { ModelBudget } from './ledger.js';
import { describeModelConfig } from './port.js';
import { converseOnce, type ApiShape, type TransportConfig } from './transport.js';

export type {
  ExecutorBudget,
  ExecutorMessage,
  ExecutorRequest,
  ExecutorRole,
  ExecutorToolCall,
  ExecutorToolDeclaration,
  ExecutorTurn,
  RealExecutor,
  ToolHandler,
  ToolLoopResult,
  ToolLoopStatus,
  ToolOutcome,
} from './executor-types.js';
export { DEFAULT_EXECUTOR_BUDGET } from './executor-types.js';

/* ------------------------------------------------------------------ *
 * 真实实现
 * ------------------------------------------------------------------ */

export interface RealExecutorOptions {
  readonly env: NodeJS.ProcessEnv;
  /**
   * 预算来源。省略时用与 `port.ts` **同一个账本文件**（`ModelBudget.fromEnv`）——
   * 该账本是 append-only 文件，`reserve()` 首次调用时会从文件恢复已用次数，
   * 因此**重启不产生新额度**（R225）。
   */
  readonly budget?: ModelBudget;
}

/**
 * 建立真实执行器。未配置模型时**抛错**（与 `createModelPort` 同口径），
 * 由宿主决定怎么向用户呈现，而不是返回一个"永远失败"的执行器。
 */
export function createRealExecutor(options: RealExecutorOptions): RealExecutor {
  const description = describeModelConfig(options.env);
  if (!description.configured) {
    throw new ModelCallError(
      'model_not_configured',
      `模型未配置，缺少：${description.missing.join('、')}`,
      false,
    );
  }

  const authToken = options.env.ANTHROPIC_AUTH_TOKEN?.trim() ?? '';
  const apiKey = options.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const transport: TransportConfig = {
    baseUrl: options.env.ANTHROPIC_BASE_URL?.trim() ?? '',
    model: description.model,
    apiShape: description.apiShape,
    authToken: authToken || undefined,
    apiKey: apiKey || undefined,
    timeoutMs: description.timeoutMs,
    maxTokens: description.maxTokens,
    thinkingDisabled: description.thinkingDisabled,
  };
  const secrets = [authToken, apiKey];
  const budget = options.budget ?? ModelBudget.fromEnv(options.env);

  return {
    provider: description.provider,
    model: description.model,

    async runTurn(request: ExecutorRequest): Promise<ExecutorTurn> {
      if (request.signal.aborted) {
        throw new ModelCallError('model_cancelled', '轮次开始前已被取消', false);
      }
      const instruction = request.systemPrompt.trim();
      if (instruction.length > LIMITS.maxInstructionChars) {
        throw new ModelCallError(
          'model_request_rejected',
          `系统指令 ${instruction.length} 字，超过合同上限 ${LIMITS.maxInstructionChars} 字`,
          false,
        );
      }

      // 每次请求按调用方给的输出上限走；`max_tokens` 是**硬上限**的一部分（R225）。
      const perCall: TransportConfig = { ...transport, maxTokens: request.budget.maxOutputTokens };

      const response = await converseOnce({
        config: perCall,
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
        secrets,
        signal: request.signal,
        beforePost: async (info) => {
          // 先登记、后发请求：额度不足时 `reserve` 抛错，异常直接冒泡，不发出请求。
          // 「代理拒绝 thinking 开关」的自动回退 POST 只记录、不占额度（与 port.ts 同口径）。
          const entry = {
            requestId: `${request.conversationId}#${String(Date.now())}`,
            taskId: request.taskId,
            provider: description.provider,
            model: description.model,
            attemptIndex: 1,
            startedAt: new Date().toISOString(),
            thinkingDisabled: info.thinkingDisabled,
          };
          if (info.fallback) await budget.noteFallback(entry);
          else await budget.reserve(entry);
        },
      });

      return {
        text: response.text,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
        usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 机械工具循环（R223）
 * ------------------------------------------------------------------ */

export interface ToolLoopRequest {
  readonly executor: RealExecutor;
  readonly conversationId: string;
  readonly taskId: string;
  readonly systemPrompt: string;
  /** 起始上下文（通常是用户这一句话）。循环会在末尾追加，不改初始数组。 */
  readonly messages: readonly ExecutorMessage[];
  readonly tools: readonly ToolHandler[];
  readonly signal: AbortSignal;
  readonly budget?: ExecutorBudget;
}

function toolDeclarationsOf(handlers: readonly ToolHandler[]): ExecutorRequest['tools'] {
  return handlers.map((handler) => ({
    name: handler.name,
    description: `工具 ${handler.name}`,
    // 这里**不编造** schema：声明与执行是两件事，真实 schema 由工具作者给出。
    // 本轮只要求"声明可得"，因此给一个开放对象；收紧 schema 属于各工具自己的事。
    inputSchema: Object.freeze({ type: 'object', additionalProperties: true }),
  }));
}

/**
 * 跑完整轮工具循环。
 *
 * 循环体（每一步都可判定）：
 * 1. **预算与取消前置检查** —— 到顶/取消 ⇒ 立刻停，并如实标结局；
 * 2. `executor.runTurn()` —— 真实模型请求（已完成额度登记）；
 * 3. 无工具调用 ⇒ `completed`，把模型文本作为收尾；
 * 4. 有工具调用 ⇒ **逐个**检查是否声明过（未声明 ⇒ `unavailable_tool`，**不假装调用过**）、
 *    是否超工具预算（超 ⇒ `budget_exhausted`），然后**由代码**执行并**由代码**把结果
 *    追加进上下文；模型只负责"提要求"，不负责"转述结果"（R223）。
 *
 * 任何一步失败都**不吞**：执行器抛出的 `ModelCallError` 直接冒泡给调用方，
 * 由调用方按 `retryable` 决定重试或收手。
 */
export async function runToolLoop(request: ToolLoopRequest): Promise<ToolLoopResult> {
  const budget = request.budget ?? DEFAULT_EXECUTOR_BUDGET;
  const messages: ExecutorMessage[] = [...request.messages];
  const turns: ExecutorTurn[] = [];
  const toolInvocations: { call: ExecutorToolCall; ok: boolean; detail: string }[] = [];
  const handlers = new Map(request.tools.map((handler) => [handler.name, handler]));
  const declarations = toolDeclarationsOf(request.tools);

  for (;;) {
    if (request.signal.aborted) {
      return {
        status: 'cancelled',
        messages: Object.freeze([...messages]),
        turns: Object.freeze([...turns]),
        toolInvocations: Object.freeze([...toolInvocations]),
        reason: '取消信号已触发，循环在发出下一次模型请求前停止',
      };
    }
    if (turns.length >= budget.maxTurns) {
      return {
        status: 'budget_exhausted',
        messages: Object.freeze([...messages]),
        turns: Object.freeze([...turns]),
        toolInvocations: Object.freeze([...toolInvocations]),
        reason: `已达到轮次上限 ${String(budget.maxTurns)} 轮；**这不是完成**，是本轮预算到顶`,
      };
    }

    const turn = await request.executor.runTurn({
      conversationId: request.conversationId,
      taskId: request.taskId,
      systemPrompt: request.systemPrompt,
      messages,
      tools: declarations,
      signal: request.signal,
      budget,
    });
    turns.push(turn);

    // 把这一轮助手输出原样记进上下文（文本 + 它提出的调用），下一轮才看得到自己说过什么。
    messages.push(
      Object.freeze({
        role: 'assistant' as const,
        text: turn.text,
        ...(turn.toolCalls.length === 0 ? {} : { toolCalls: turn.toolCalls }),
      }),
    );

    if (turn.toolCalls.length === 0) {
      return {
        status: 'completed',
        messages: Object.freeze([...messages]),
        turns: Object.freeze([...turns]),
        toolInvocations: Object.freeze([...toolInvocations]),
        reason: turn.text.trim(),
      };
    }

    for (const call of turn.toolCalls) {
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          messages: Object.freeze([...messages]),
          turns: Object.freeze([...turns]),
          toolInvocations: Object.freeze([...toolInvocations]),
          reason: '取消信号已触发，循环在工具调用之间停止',
        };
      }
      if (toolInvocations.length >= budget.maxToolCalls) {
        return {
          status: 'budget_exhausted',
          messages: Object.freeze([...messages]),
          turns: Object.freeze([...turns]),
          toolInvocations: Object.freeze([...toolInvocations]),
          reason: `已达到工具调用上限 ${String(budget.maxToolCalls)} 次；**这不是完成**，是本轮预算到顶`,
        };
      }

      const handler = handlers.get(call.name);
      if (handler === undefined) {
        // **不假装调用过**：没有处理器就是没有这个能力，如实终结并列出它要的是什么。
        return {
          status: 'unavailable_tool',
          messages: Object.freeze([...messages]),
          turns: Object.freeze([...turns]),
          toolInvocations: Object.freeze([...toolInvocations]),
          reason: `模型要求调用未声明的工具「${call.name}」：不假装执行，循环就此终止`,
        };
      }

      const outcome = await invokeHandler(handler, call, request.signal);
      toolInvocations.push({
        call,
        ok: outcome.ok,
        detail: outcome.content.slice(0, 500),
      });
      // 工具结果由**代码**写回上下文；失败也如实回给模型（R226：部分结果不写成完成）。
      messages.push(
        Object.freeze({
          role: 'tool' as const,
          text: outcome.content,
          toolCallId: call.id,
          ...(outcome.ok ? {} : { toolFailed: true }),
        }),
      );
    }
  }
}

/** 执行一次工具：处理器抛错也要收敛成"失败结果"，**不得**把异常当成成功。 */
async function invokeHandler(
  handler: ToolHandler,
  call: ExecutorToolCall,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly content: string }> {
  try {
    const outcome = await handler.invoke(call, signal);
    return { ok: outcome.ok, content: outcome.content };
  } catch (error) {
    if (isModelCallError(error)) throw error;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, content: `工具 ${handler.name} 执行失败：${detail}` };
  }
}

/* ------------------------------------------------------------------ *
 * 测试替身（R224：**不得替代真实执行器用于最终验收**）
 * ------------------------------------------------------------------ */

/**
 * 可控脚本执行器。**仅用于测试**。
 *
 * 命名里带 `Fake` 是刻意的：任何拿它跑出来的"通过"都只能证明**循环逻辑**对，
 * 不能证明真实链路对。真实验收必须用 `createRealExecutor()`。
 */
export function createFakeExecutor(
  script: readonly ExecutorTurn[],
  identity: { readonly provider?: string; readonly model?: string } = {},
): RealExecutor {
  let cursor = 0;
  return {
    provider: identity.provider ?? 'fake-scripted',
    model: identity.model ?? 'fake-scripted-v1',
    async runTurn(request: ExecutorRequest): Promise<ExecutorTurn> {
      if (request.signal.aborted) {
        throw new ModelCallError('model_cancelled', '假执行器：轮次开始前已被取消', false);
      }
      const turn = script[cursor];
      cursor += 1;
      if (turn === undefined) {
        throw new ModelCallError(
          'model_upstream_error',
          `假执行器脚本只有 ${String(script.length)} 轮，第 ${String(cursor)} 轮无脚本可播`,
          false,
        );
      }
      return turn;
    },
  };
}

/** 供测试构造一轮。 */
export function fakeTurn(
  text: string,
  toolCalls: readonly ExecutorToolCall[] = [],
  stopReason: string | null = null,
): ExecutorTurn {
  return {
    text,
    toolCalls,
    stopReason,
    usage: { inputTokens: null, outputTokens: null },
  };
}

export type { ApiShape };
