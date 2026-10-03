/**
 * K02 模型端口 —— **错误类型与拒因词表**（零依赖、纯类型 + 纯函数）。
 *
 * ## 为什么拒因必须是显式错误码
 *
 * 模型端口最容易写成"拿不到结果就返回一个空成功"：401 变成 `{text: ''}`、断流变成
 * 提前结束的迭代、超时变成"没有更多内容"。上层看到的是**没有 error 的结果**，
 * 于是把它当成成功，把失败写进了用户的文档。K02 的对策是：
 *
 * 1. **每一条失败路径都有专属错误码**，且必须出现在 `MODEL_PORT_ERROR_CODES` 里
 *    （测试逐条对照，杜绝"悄悄 fail-open"）。
 * 2. `ModelRunOutcome.status` 只有见到上游 `done` 且 `error === null` 才是 `succeeded`；
 *    `401 / 429 / 断流 / 超时 / 预算超支` 一律 `failed`，取消是 `cancelled`。
 * 3. 流式通道上，任何失败都**先落一条 `type: 'error'` 的片段**再收束，
 *    所以即便是"只看片段流"的消费者也不会把断流读成正常结束。
 *
 * ## 与契约的关系
 *
 * 契约 `contracts/mobile-v1/schemas/model-port.schema.json` 的 `$defs.streamError`
 * 只要求 `{code, message}` 两个非空字符串。本模块的错误码在流上以**大写**形式出现
 * （`streamCodeFor()`），在内核内部以小写下划线形式出现；两者一一对应，不引入第三套词表。
 */

/** 模型端口链路上**全部**可机读拒因。新增拒因必须同时在此登记。 */
export const MODEL_PORT_ERROR_CODES = [
  // --- 请求构造（buildRequest 同步抛出） ---
  /** 请求形状不合法（缺 messages / 空数组 / role 非法 / 多余字段 / 未知键）。 */
  'invalid_request',
  /** `keyRef` 不是 `keyref:` 引用（例如直接塞了明文密钥）。 */
  'invalid_key_ref',
  /** `keyRef` 形状像引用，但内容里带明文密钥特征（`keyref:sk-...` 这类）。 */
  'key_ref_contains_secret',
  /** `model` 不符合契约 `#/$defs/modelName` 的 pattern。 */
  'invalid_model',
  /** 工具声明不合法（name 空 / parameters 不是对象 / 多余键）。 */
  'invalid_tool_schema',
  /** `role: 'tool'` 的消息没有 `toolCallId` —— 工具结果无法与调用对应。 */
  'tool_message_missing_call_id',
  /** 预算字段本身不合法（非整数 / 负数 / 多余键）。 */
  'invalid_budget',
  /** 预算三项全缺（契约 `budget` 的 `anyOf` 要求至少一项）。 */
  'budget_missing',
  /** 预算**不足以**开始本次调用（`maxTokens`/`maxCostMicros`/`timeoutMs` 为 0，或小于估算下界）。 */
  'budget_insufficient',
  /** 实际用量**超出**预算：中止并如实报失败，**不得**成功。 */
  'budget_exceeded',

  // --- 流式过程 ---
  /** 取消令牌被置位（发出前或流中途）。 */
  'cancelled',
  /** `cancellation.deadlineMs` 相对期限已到。 */
  'deadline_exceeded',
  /** 等待上游超过 `budget.timeoutMs`。 */
  'timeout',
  /** HTTP 401：密钥无效或过期。**不得**产出成功。 */
  'unauthorized',
  /** HTTP 429：限流。**不得**产出成功。 */
  'rate_limited',
  /** 其它非 2xx（含 5xx）。 */
  'upstream_error',
  /** **断流**：上游迭代结束但从未发出 `done` —— 内容不完整，**不得**当成功。 */
  'stream_truncated',
  /** 上游迭代抛错。 */
  'stream_failed',
  /** `tool-call` 片段缺 `toolCallId`（或为空）—— 结果无处对应，拒。 */
  'tool_call_missing_id',
  /** `tool-call` 片段非法（`toolCallId` 不匹配 pattern / `toolName` 空 / `arguments` 不是对象）。 */
  'invalid_tool_call',
  /** 同一 `toolCallId` 被用于**不同**的工具或参数。 */
  'tool_call_conflict',
  /** 工具结果找不到对应调用 —— 契约要求"结果必须与调用 ID 对应"。 */
  'tool_result_unknown_call',
  /** 同一 `toolCallId` 收到两个**不同**的结果。 */
  'tool_result_duplicate',
  /** 工具执行器抛错（本次执行已记账：重试**不得**再执行一次）。 */
  'tool_execution_failed',

  // --- 记账与循环 ---
  /** `usage.totalTokens` 与 `promptTokens + completionTokens` 不一致。 */
  'usage_inconsistent',
  /** 工具循环轮数超过上限。 */
  'step_limit_exceeded',
  /** 没有装配 transport。 */
  'missing_transport',
] as const;

export type ModelPortErrorCode = (typeof MODEL_PORT_ERROR_CODES)[number];

/**
 * **可重试**的拒因集合。401 / 预算 / 请求形状**不在**其中：
 * 重试一个拿错密钥的请求只会再拿一次 401，而"重试"在本项目里意味着可能重复外部副作用，
 * 必须是保守的。断流与超时是典型可重试（上游抖动），限流可重试。
 */
export const RETRYABLE_ERROR_CODES = [
  'rate_limited',
  'timeout',
  'stream_truncated',
  'stream_failed',
  'upstream_error',
] as const;

export type RetryableModelPortErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];

/**
 * 内核拒因 → 流上错误码。**大写**是有意为之：`streamError.code` 是给消费者看的，
 * 与内核内部词表同源即可追溯，不需要第三种命名。
 */
export function streamCodeFor(code: ModelPortErrorCode): string {
  return code.toUpperCase();
}

export function isRetryableCode(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code.toLowerCase());
}

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isModelPortError(value: unknown): value is ModelPortError {
  return (
    value instanceof ModelPortError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (MODEL_PORT_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

/** K02 链路唯一的错误类型。所有同步拒绝都抛它，验收按 `code` 断言。 */
export class ModelPortError extends Error {
  readonly code: ModelPortErrorCode;
  /** 该拒因是否值得重试（同步拒绝一律 false）。 */
  readonly retryable: boolean;

  constructor(code: ModelPortErrorCode, detail: string, options: { readonly retryable?: boolean } = {}) {
    super(`[${code}] ${detail}`);
    this.name = 'ModelPortError';
    this.code = code;
    this.retryable = options.retryable ?? isRetryableCode(code);
  }
}
