/**
 * S4 —— **真实执行器**的中立接口（KRN-04；合同 R221–R224）。
 *
 * ## 为什么要把 `generateDraft` 换掉
 *
 * `port.ts` 的 `ModelPort.generateDraft()` 是**一次性**的：给一句要求、拿一份草稿 JSON。
 * 它表达不了 R221 列出的任何一样东西——多轮上下文、工具定义与工具结果、取消信号、
 * 预算、轮次结局。用它去跑"多轮工具调用"只能靠调用方在外部拼字符串，
 * 那不叫执行器，叫一次性生成接口（合同 H2 明文："仅把新页面接旧一次性生成接口**不通过**"）。
 *
 * 本文件只放**类型与判定**，不含 I/O；真实实现见 `executor.ts`，测试用假执行器
 * 也实现同一接口（R224：假 Agent **保留作可控测试**，但不得替代真实执行器用于验收）。
 *
 * ## 与 `src/protocol` 的边界
 *
 * 这里的时间/预算**不**复用内核的逻辑时钟语义：模型调用是真实墙钟 I/O，
 * 与内核确定性场景无关。二者不互相冒充：本模块的 `usage` 是"这次调用花了多少"，
 * 内核的 `LogicalTime` 是"场景推进到第几步"。
 */

/** 会话消息角色。`tool` 是**代码**回填的工具结果，不是模型说的。 */
export type ExecutorRole = 'user' | 'assistant' | 'tool';

/** 一次工具调用的身份与参数（模型"提出"，代码"执行"）。 */
export interface ExecutorToolCall {
  /** 本轮内唯一；工具结果靠它续接（R223：机械转发由代码处理）。 */
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * 一条会话消息。
 *
 * `assistant` 轮可以**同时**带文本与工具调用；只有工具调用、没有文本是正常的
 * （模型只说要调什么），不得被当成"空响应"丢掉。
 */
export interface ExecutorMessage {
  readonly role: ExecutorRole;
  readonly text: string;
  /** 仅 `assistant`：本轮提出的工具调用。 */
  readonly toolCalls?: readonly ExecutorToolCall[];
  /** 仅 `tool`：本条结果回应的是哪一次调用。 */
  readonly toolCallId?: string;
  /** 仅 `tool`：这次工具执行是否失败（失败也要如实回给模型，不得吞掉）。 */
  readonly toolFailed?: boolean;
}

/** 工具声明。输入 schema 用 JSON Schema 子集，原样透传给模型。 */
export interface ExecutorToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * **硬限制**（R225）。到顶即停，且停下时必须如实说明是"到顶了"而不是"做完了"。
 * 数量类是"最多多少次"，token 类是"最多多少 token"。
 */
export interface ExecutorBudget {
  /** 最多允许几轮模型往返（一轮 = 一次模型请求）。 */
  readonly maxTurns: number;
  /** 最多允许几次工具调用。 */
  readonly maxToolCalls: number;
  /** 输出 token 上限（每次请求透传给上游的 `max_tokens`）。 */
  readonly maxOutputTokens: number;
}

export const DEFAULT_EXECUTOR_BUDGET: ExecutorBudget = Object.freeze({
  maxTurns: 8,
  maxToolCalls: 16,
  maxOutputTokens: 1600,
});

/** 一轮模型的结局。 */
export interface ExecutorTurn {
  /** 本轮文本（可为空串：只调工具时本来就没有文本）。 */
  readonly text: string;
  readonly toolCalls: readonly ExecutorToolCall[];
  /** 上游给的停止原因，原样保留（不翻译、不美化）。 */
  readonly stopReason: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
}

/** 一次 `runTurn` 的全部输入。 */
export interface ExecutorRequest {
  /** 会话身份（用于日志与幂等键，不参与模型语义）。 */
  readonly conversationId: string;
  readonly taskId: string;
  readonly systemPrompt: string;
  /** **完整**上下文：调用方负责把历史与本轮新增一起给进来。 */
  readonly messages: readonly ExecutorMessage[];
  readonly tools: readonly ExecutorToolDeclaration[];
  /** 取消信号。abort 后执行器必须尽快停止，**不得**继续发请求。 */
  readonly signal: AbortSignal;
  readonly budget: ExecutorBudget;
}

/** 真实执行器：**只有这一个方法**——把整段上下文发出去，返回模型这一轮要什么。 */
export interface RealExecutor {
  readonly provider: string;
  readonly model: string;
  runTurn(request: ExecutorRequest): Promise<ExecutorTurn>;
}

/** 一次工具执行的结果（成功或失败都要如实带上内容）。 */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly content: string;
}

/** 工具处理器：名字 → 真实动作。**没有处理器就是不可用**，不得假装调用过。 */
export interface ToolHandler {
  readonly name: string;
  invoke(call: ExecutorToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

/**
 * 工具循环的结局。**五种结局互相区分**（R226：不把"部分完成"写成"完成"）。
 */
export type ToolLoopStatus =
  | 'completed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'unavailable_tool'
  | 'failed';

export interface ToolLoopResult {
  readonly status: ToolLoopStatus;
  /** 循环结束时的**完整**上下文（含每一轮助手输出与每一条工具结果）。 */
  readonly messages: readonly ExecutorMessage[];
  readonly turns: readonly ExecutorTurn[];
  /** 实际发生的工具调用流水（含成功/失败），供证据核对。 */
  readonly toolInvocations: readonly {
    readonly call: ExecutorToolCall;
    readonly ok: boolean;
    readonly detail: string;
  }[];
  /** 结局原因；`completed` 时为模型给出的收尾文本摘要。 */
  readonly reason: string;
}
