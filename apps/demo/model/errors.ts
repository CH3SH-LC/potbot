/**
 * S4 —— 模型调用错误。
 *
 * 纪律：模型错误、空响应或解析失败**不得**替换为固定成功稿。
 * 所有失败都必须冒泡为 `ModelCallError`，由宿主决定如何呈现。
 *
 * `code` 是稳定机器可判标识；`retryable` 决定宿主/端口是否允许再试一次。
 */

/** 稳定错误码。不可重试的码不许被当成可重试处理。 */
export type ModelErrorCode =
  // —— 配置层：不可重试 ——
  | 'model_not_configured'
  // —— 预算层：不可重试 ——
  | 'model_budget_exhausted'
  // —— 传输层 ——
  | 'model_timeout'
  | 'model_network_error'
  | 'model_auth_error'
  | 'model_endpoint_not_found'
  | 'model_request_rejected'
  | 'model_rate_limited'
  | 'model_upstream_error'
  // —— 响应层 ——
  | 'model_empty_response'
  | 'model_response_truncated'
  | 'model_response_not_json'
  | 'model_response_schema'
  | 'model_response_too_long'
  // —— 执行器层（KRN-04，**追加**）——
  // 为什么单列一个码而不用 `model_timeout`：把"调用方主动取消"写成"超时"
  // 是在编造失败原因，宿主的处置（重试 vs 就此收手）也完全不同。
  | 'model_cancelled';

export class ModelCallError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;

  constructor(code: ModelErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'ModelCallError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 便于宿主把任意异常收敛成结构化错误。 */
export function isModelCallError(value: unknown): value is ModelCallError {
  return value instanceof ModelCallError;
}
