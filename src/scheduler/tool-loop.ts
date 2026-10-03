/**
 * **工具调用与回执循环**（KRN-04 下半；合同 R221–R226）。
 *
 * ## 这一件修的是什么
 *
 * 一个"能跑"的工具循环最容易缺的三样东西：
 *
 * 1. **请求-回执配对**。模型说"调用 `doc.write`"，代码执行完写了个日志就往下走——
 *    于是"这次工具到底有没有回执"根本无从核对。本模块把每一次工具调用记成一条
 *    **配对记录**（`ToolLoopExchange`：请求 + 回执 + `paired`）。
 * 2. **回执缺失仍推进**。执行器没返回值、抛了异常、或回执的 `call_id` 对不上，
 *    循环却拿着"没有回执"当"大概成功"，继续喂给模型下一轮。本模块对此**停止推进**：
 *    状态 `receipt_missing`，并把缺失原因写进配对记录。
 * 3. **工具报错被吞**。工具失败了，循环不告诉模型、也不改状态，最后给出一个"完成"。
 *    本模块让工具错误**参与状态**：每一次失败都作为观察结果回喂给模型（`ok: false`），
 *    并计入 `tool_errors`；只要出现过失败，结果就 `degraded: true`；致命失败
 *    （`error.fatal`）直接以 `tool_failed` 终止。
 *
 * ## 两条硬纪律
 *
 * - **无端口 ⇒ 未就绪**。模型端口或工具执行器缺失时，结果是 `not_ready` 并**指名**缺了哪一个，
 *   **不**用"内置假执行器"悄悄顶上——那正是"把桩当真实执行器"的入口。
 * - **假 Agent 保留作测试，但不得冒充真实执行器**。端口必须如实声明 `real_executor`；
 *   结果原样透出（`real_executor` / `evidence_grade` / `verified_with_real_executor`），
 *   任一端口是桩 ⇒ `verified_with_real_executor === false` 且 `note` 标注**未验证**。
 *   本模块自带的 `createStubModelPort` / `createStubToolExecutor` **恒为 `false`**。
 *
 * ## 依赖
 *
 * 解析一律经 `constrained-response.ts`（格式违约结构化拒绝，不猜测）；
 * 上限一律经 `loop-limits.ts`（三项上限必须显式给全，没有 `limits` 直接抛错——
 * "没有上限的循环"不是合法配置）。本模块**不**另造预算语义。
 */

import { ValidationError } from '../protocol/index.js';
import type { BudgetDimension } from './budgets.js';
import {
  parseConstrainedResponse,
  type ResponseRejectionCode,
  type ToolCatalog,
} from './constrained-response.js';
import type { LoopLimitGate, LoopLimitReport } from './loop-limits.js';

// ---------------------------------------------------------------------------
// 端口（可注入；无端口 ⇒ 未就绪）
// ---------------------------------------------------------------------------

/** 回喂给模型的一条工具观察结果（**成功与失败都要回喂**，失败不得被吞）。 */
export interface ToolObservation {
  readonly call_id: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly content: string;
  readonly error_code: string | null;
  readonly error_detail: string | null;
}

export interface ModelTurnInput {
  readonly step: number;
  readonly instructions: string;
  readonly observations: readonly ToolObservation[];
  readonly signal: AbortSignal | null;
}

export interface ModelTurnOutput {
  /** 模型的**原样**输出：解析交给 `constrained-response.ts`，端口不做任何猜测。 */
  readonly raw: unknown;
  readonly usage?:
    | { readonly input_tokens: number | null; readonly output_tokens: number | null }
    | undefined;
}

/** 模型端口。**必须**如实声明是不是真实执行器。 */
export interface ModelTurnPort {
  readonly provider: string;
  readonly model: string;
  /** 桩实现恒为 `false`（R224：假 Agent 不得替代真实执行器）。 */
  readonly real_executor: boolean;
  nextTurn(input: ModelTurnInput): Promise<ModelTurnOutput>;
}

/** 一次工具调用的身份与参数（模型"提出"，代码"执行"）。 */
export interface ToolCallRequest {
  readonly call_id: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolErrorInfo {
  readonly code: string;
  readonly detail: string;
  /** 致命失败：循环立即以 `tool_failed` 终止（不回喂、不再请求下一轮）。 */
  readonly fatal?: boolean | undefined;
}

/** 一条工具回执。`call_id` 是**配对键**：对不上 = 回执缺失。 */
export interface ToolReceipt {
  readonly call_id: string;
  readonly ok: boolean;
  readonly content: string;
  readonly error?: ToolErrorInfo | undefined;
}

/** 工具执行器端口。 */
export interface ToolExecutorPort {
  readonly name: string;
  /** 桩实现恒为 `false`。 */
  readonly real_executor: boolean;
  /**
   * 执行一次工具调用。
   *
   * **返回 `null` = 回执缺失**（未返回值 / 不可用）：调用方**不得**当作成功，
   * 循环据此停止推进。抛出的异常同样按回执缺失处理，不升级为"成功"。
   */
  invoke(call: ToolCallRequest, signal: AbortSignal | null): Promise<ToolReceipt | null>;
}

// ---------------------------------------------------------------------------
// 结局
// ---------------------------------------------------------------------------

export const TOOL_LOOP_STATUSES = [
  /** 模型给出了受约束的回答（唯一可称"完成"的结局）。 */
  'answered',
  /** 模型要调用的工具不在目录里（结构化拒绝，**未执行**）。 */
  'unavailable_tool',
  /** **回执缺失**：循环停止推进，不再请求下一轮。 */
  'receipt_missing',
  /** 工具致命失败。 */
  'tool_failed',
  /** 撞上 `loop-limits` 硬上限（部分结果 + 原因）。 */
  'budget_exhausted',
  /** 模型输出是格式违约（结构化拒绝，**未执行**，不得当成回答）。 */
  'malformed_response',
  /** 取消了。 */
  'cancelled',
  /** 端口缺失 ⇒ **未就绪**（不假装跑过）。 */
  'not_ready',
] as const;
export type ToolLoopStatus = (typeof TOOL_LOOP_STATUSES)[number];

export const TOOL_LOOP_STATUS_LABELS: Readonly<Record<ToolLoopStatus, string>> = Object.freeze({
  answered: '模型给出了受约束回答',
  unavailable_tool: '模型要调用的工具不在可用目录里',
  receipt_missing: '工具回执缺失：停止推进',
  tool_failed: '工具致命失败',
  budget_exhausted: '撞上循环硬上限（部分结果）',
  malformed_response: '模型输出格式违约（结构化拒绝）',
  cancelled: '已取消',
  not_ready: '端口缺失：未就绪',
});

/** 一次工具调用的**请求-回执配对**记录。 */
export interface ToolLoopExchange {
  readonly step: number;
  readonly call_id: string;
  readonly tool: string;
  readonly request: ToolCallRequest;
  /** `null` = 回执缺失（未返回 / 抛错 / 对不上）。 */
  readonly receipt: ToolReceipt | null;
  /** 请求与回执是否配对成功（`receipt.call_id === call_id`）。 */
  readonly paired: boolean;
  readonly detail: string;
}

/** 一步（一次模型往返）的记录。 */
export interface ToolLoopStep {
  readonly step: number;
  readonly response_kind: 'action' | 'answer' | 'rejected';
  readonly rejection_code: ResponseRejectionCode | null;
  readonly tool_call_ids: readonly string[];
}

export interface ToolLoopResult {
  readonly status: ToolLoopStatus;
  readonly reason: string;
  readonly answer: string | null;
  readonly steps: readonly ToolLoopStep[];
  readonly exchanges: readonly ToolLoopExchange[];
  readonly observations: readonly ToolObservation[];
  /** 工具失败清单（成功为空）。非空 ⇒ `degraded`。 */
  readonly tool_errors: readonly ToolObservation[];
  /** 出现过工具失败 / 走到非回答结局时为 `true`（**不得**被当成干净完成）。 */
  readonly degraded: boolean;
  /** `status !== 'answered'` ⇒ 部分结果，不得宣称完成。 */
  readonly partial: boolean;
  readonly model: { readonly provider: string; readonly model: string } | null;
  readonly executor: string | null;
  /** 两个端口**都**是真实执行器时才为 `true`。 */
  readonly real_executor: boolean;
  /** `live` = 真实执行器；`synthetic_port` = 至少一端是桩（**未验证**）。 */
  readonly evidence_grade: 'live' | 'synthetic_port';
  readonly verified_with_real_executor: boolean;
  readonly limits: LoopLimitReport | null;
  /** 人可读说明（含未验证标注）。 */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// 循环
// ---------------------------------------------------------------------------

export interface ToolLoopOptions {
  readonly catalog: ToolCatalog;
  /** 硬闸门（KRN-04：**没有上限的循环不是合法配置**；缺失即抛 `ValidationError`）。 */
  readonly limits: LoopLimitGate;
  readonly model?: ModelTurnPort | null | undefined;
  readonly executor?: ToolExecutorPort | null | undefined;
  /** 每步推进的逻辑时间量（默认 1）。 */
  readonly time_per_step?: number | undefined;
}

export interface ToolLoopRequest {
  readonly task_id: string;
  readonly instructions: string;
  readonly signal?: AbortSignal | null | undefined;
}

export interface ToolLoop {
  run(request: ToolLoopRequest): Promise<ToolLoopResult>;
}

export function createToolLoop(options: ToolLoopOptions): ToolLoop {
  if (options.limits === undefined || options.limits === null) {
    throw new ValidationError(
      '工具循环必须带 `limits`（loop-limits 的三项硬上限）：没有上限的循环正是 KRN-04 要修的病',
    );
  }
  const limits = options.limits;
  const model = options.model ?? null;
  const executor = options.executor ?? null;
  const timePerStep = options.time_per_step ?? 1;

  const grade = (): { readonly real: boolean; readonly grade: 'live' | 'synthetic_port' } => {
    const real = model !== null && executor !== null && model.real_executor && executor.real_executor;
    return { real, grade: real ? 'live' : 'synthetic_port' };
  };

  const finalize = (
    base: {
      readonly status: ToolLoopStatus;
      readonly reason: string;
      readonly answer?: string | null;
      readonly steps: readonly ToolLoopStep[];
      readonly exchanges: readonly ToolLoopExchange[];
      readonly observations: readonly ToolObservation[];
    },
  ): ToolLoopResult => {
    const { real, grade: evidenceGrade } = grade();
    const toolErrors = base.observations.filter((observation) => !observation.ok);
    const failed = base.observations.some((observation) => !observation.ok);
    const partial = base.status !== 'answered';
    const exhaustion = limits.report();
    const unverified = evidenceGrade === 'synthetic_port';
    return Object.freeze({
      status: base.status,
      reason: base.reason,
      answer: base.answer ?? null,
      steps: Object.freeze([...base.steps]),
      exchanges: Object.freeze([...base.exchanges]),
      observations: Object.freeze([...base.observations]),
      tool_errors: Object.freeze(toolErrors),
      degraded: failed || partial,
      partial,
      model: model === null ? null : Object.freeze({ provider: model.provider, model: model.model }),
      executor: executor === null ? null : executor.name,
      real_executor: real,
      evidence_grade: evidenceGrade,
      verified_with_real_executor: real,
      limits: Object.freeze(exhaustion),
      note: unverified
        ? '**未验证**：至少一个端口是桩（`real_executor: false`），本结果不得当作真实执行器证据。'
        : '两个端口均声明为真实执行器；实际端到端联网实测**未做**（本模块内无法证明端口真伪）。',
    });
  };

  const notReady = (detail: string): ToolLoopResult =>
    finalize({
      status: 'not_ready',
      reason: detail,
      steps: [],
      exchanges: [],
      observations: [],
    });

  return {
    async run(request: ToolLoopRequest): Promise<ToolLoopResult> {
      if (model === null || executor === null) {
        const missing = [model === null ? '模型端口（ModelTurnPort）' : null, executor === null ? '工具执行器（ToolExecutorPort）' : null]
          .filter((value): value is string => value !== null)
          .join('、');
        return notReady(`未就绪：缺少 ${missing}——不注入端口就不跑，也不用内置桩顶替`);
      }

      const signal = request.signal ?? null;
      const steps: ToolLoopStep[] = [];
      const exchanges: ToolLoopExchange[] = [];
      const observations: ToolObservation[] = [];
      let step = 0;

      for (;;) {
        if (signal !== null && signal.aborted) {
          return finalize({
            status: 'cancelled',
            reason: '收到取消信号：循环在发起下一轮之前停止',
            steps,
            exchanges,
            observations,
          });
        }

        const turnDecision = limits.beginTurn();
        if (!turnDecision.admitted) {
          return finalize({
            status: 'budget_exhausted',
            reason: turnDecision.detail,
            steps,
            exchanges,
            observations,
          });
        }

        step += 1;
        let turn: ModelTurnOutput;
        try {
          turn = await model.nextTurn({ step, instructions: request.instructions, observations: Object.freeze([...observations]), signal });
        } catch (error) {
          return finalize({
            status: 'malformed_response',
            reason: `模型端口抛错（不得当作回答）：${String(error)}`,
            steps,
            exchanges,
            observations,
          });
        }

        const parsed = parseConstrainedResponse(turn.raw, options.catalog);
        if (!parsed.ok) {
          steps.push(
            Object.freeze({
              step,
              response_kind: 'rejected' as const,
              rejection_code: parsed.code,
              tool_call_ids: Object.freeze([] as string[]),
            }),
          );
          const status: ToolLoopStatus =
            parsed.code === 'unknown_tool' ? 'unavailable_tool' : 'malformed_response';
          return finalize({
            status,
            reason: `模型输出被结构化拒绝（${parsed.code}）：${parsed.detail}；**未执行任何工具**`,
            steps,
            exchanges,
            observations,
          });
        }

        if (parsed.response.kind === 'answer') {
          steps.push(
            Object.freeze({
              step,
              response_kind: 'answer' as const,
              rejection_code: null,
              tool_call_ids: Object.freeze([] as string[]),
            }),
          );
          const failed = observations.some((observation) => !observation.ok);
          return finalize({
            status: 'answered',
            reason: failed
              ? '模型给出了回答，但过程中有工具失败（见 `tool_errors`）：回答是**降级**的'
              : '模型给出了受约束回答',
            answer: parsed.response.text,
            steps,
            exchanges,
            observations,
          });
        }

        const action = parsed.response;
        const callId = `call-${String(exchanges.length + 1)}`;
        steps.push(
          Object.freeze({
            step,
            response_kind: 'action' as const,
            rejection_code: null,
            tool_call_ids: Object.freeze([callId]),
          }),
        );
        const toolDecision = limits.beginToolCall();
        if (!toolDecision.admitted) {
          return finalize({
            status: 'budget_exhausted',
            reason: toolDecision.detail,
            steps,
            exchanges,
            observations,
          });
        }

        const callRequest: ToolCallRequest = Object.freeze({
          call_id: callId,
          tool: action.tool_id,
          arguments: action.arguments,
        });
        let receipt: ToolReceipt | null = null;
        let invokeNote = '';
        try {
          receipt = await executor.invoke(callRequest, signal);
        } catch (error) {
          receipt = null;
          invokeNote = `执行器抛错：${String(error)}`;
        }
        const paired = receipt !== null && receipt.call_id === callId;
        let pairingDetail: string;
        if (receipt === null) {
          pairingDetail = `回执缺失：${invokeNote || '执行器返回 null（未返回值）'}`;
        } else if (!paired) {
          pairingDetail = `回执缺失：回执 call_id=${JSON.stringify(receipt.call_id)} 与请求 ${JSON.stringify(callId)} 对不上`;
        } else {
          pairingDetail = receipt.ok ? '请求-回执配对成功（工具成功）' : '请求-回执配对成功（工具报错）';
        }
        exchanges.push(
          Object.freeze({
            step,
            call_id: callId,
            tool: action.tool_id,
            request: callRequest,
            receipt,
            paired,
            detail: pairingDetail,
          }),
        );

        if (!paired || receipt === null) {
          return finalize({
            status: 'receipt_missing',
            reason: `工具 ${action.tool_id} 的回执缺失：**停止推进**（不再请求下一轮），该步不得当作成功`,
            steps,
            exchanges,
            observations,
          });
        }

        const observation: ToolObservation = Object.freeze({
          call_id: callId,
          tool: action.tool_id,
          ok: receipt.ok,
          content: receipt.content,
          error_code: receipt.error?.code ?? null,
          error_detail: receipt.error?.detail ?? null,
        });
        observations.push(observation);

        if (!receipt.ok) {
          if (receipt.error?.fatal === true) {
            return finalize({
              status: 'tool_failed',
              reason: `工具 ${action.tool_id} 致命失败（${receipt.error.code}）：${receipt.error.detail}`,
              steps,
              exchanges,
              observations,
            });
          }
          // 非致命失败：**回喂给模型**（不吞），继续下一轮。
        } else {
          // 逻辑时间硬闸门（每步推进）。
          const timeDecision = limits.advanceTime(timePerStep);
          if (!timeDecision.admitted) {
            return finalize({
              status: 'budget_exhausted',
              reason: timeDecision.detail,
              steps,
              exchanges,
              observations,
            });
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 桩端口（**仅供测试**；恒 `real_executor: false`）
// ---------------------------------------------------------------------------

/**
 * 脚本化模型端口：按顺序吐出预设的**原样**响应；脚本用尽后返回 `null`
 * （经解析即 `not_an_object` 拒绝）——这会自然地让"多跑了一轮"的循环停下来。
 *
 * **恒 `real_executor: false`**：它是被测的假 Agent，不得冒充真实执行器。
 */
export function createStubModelPort(
  script: readonly unknown[],
  options: { readonly provider?: string; readonly model?: string } = {},
): ModelTurnPort {
  let index = 0;
  return {
    provider: options.provider ?? 'stub',
    model: options.model ?? 'stub-model',
    real_executor: false,
    async nextTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
      const raw = index < script.length ? script[index] : null;
      index += 1;
      return Object.freeze({
        raw,
        usage: Object.freeze({ input_tokens: null, output_tokens: null }),
      });
    },
  };
}

/** 桩执行器的处理器：返回 `null` = 无回执（模拟"执行器没返回值"）。 */
export type StubToolHandler = (call: ToolCallRequest) => ToolReceipt | null | Promise<ToolReceipt | null>;

/**
 * 桩工具执行器：按名字查处理器；**没有处理器 = 无回执**（返回 `null`，循环据此不推进）。
 * **恒 `real_executor: false`**。
 */
export function createStubToolExecutor(
  handlers: Readonly<Record<string, StubToolHandler>>,
  options: { readonly name?: string } = {},
): ToolExecutorPort {
  return {
    name: options.name ?? 'stub-executor',
    real_executor: false,
    async invoke(call: ToolCallRequest): Promise<ToolReceipt | null> {
      const handler = handlers[call.tool];
      if (handler === undefined) {
        return null;
      }
      return handler(call);
    },
  };
}

/** 证据可读性：一行摘要（结局 + 执行器等级 + 上限状态）。 */
export function describeToolLoopResult(result: ToolLoopResult): string {
  const parts = [
    `结局 ${result.status}（${TOOL_LOOP_STATUS_LABELS[result.status]}）`,
    `真实执行器 ${result.real_executor ? '是' : '否（未验证）'}`,
    `步数 ${String(result.steps.length)}`,
    `工具交换 ${String(result.exchanges.length)}`,
    `失败 ${String(result.tool_errors.length)}`,
  ];
  if (result.limits !== null && result.limits.partial) {
    parts.push(`上限命中：${result.limits.exhausted_dimensions.join('、')}`);
  }
  return parts.join('，');
}

/** 被拒时，命中的维度（供调用方如实上报"卡在哪一条上限"）。 */
export function exhaustedDimensionsOf(result: ToolLoopResult): readonly BudgetDimension[] {
  return result.limits === null ? Object.freeze([]) : result.limits.exhausted_dimensions;
}
