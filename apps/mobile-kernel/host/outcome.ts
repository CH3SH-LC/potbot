/**
 * K-I04 宿主装配 —— 处理器结果构造与错误归一。
 *
 * K01 的 `OperationOutcome` 是处理器的**终局**返回值（不是 event；运行时据此造 event）。
 * 两条硬口径在这里被各适配器统一遵守：
 *   - 成功必须带 `resultRef`（否则运行时 fail-closed 降为 failed）；
 *   - 失败带**可机读 `code`**：域模块抛的错误码原样透出，宿主自身错误用 `HostError.code`。
 */

import type { OperationOutcome } from '../bootstrap/index.js';
import { isHostError } from './errors.js';

export function succeeded(resultRef: string, revision?: number): OperationOutcome {
  return revision === undefined
    ? { status: 'succeeded', resultRef }
    : { status: 'succeeded', resultRef, revision };
}

export function failed(code: string, message: string, retryable = false): OperationOutcome {
  return { status: 'failed', error: { code, message, retryable } };
}

/**
 * 把处理器体内抛出的异常转成结构化 `failed`。
 *
 * - `HostError` ⇒ 用其 `code`；
 * - 域错误（带字符串 `code`，如 `DispatchError` / `TemplateError` / `AuthorizationError` /
 *   `ValidationError`）⇒ 用域错误码，`retryable` 透传；
 * - 其它 ⇒ `HANDLER_ERROR`（与运行时兜底同名，便于机读区分）。
 */
export function toFailed(error: unknown): OperationOutcome {
  if (isHostError(error)) {
    return failed(error.code, error.message);
  }
  if (error instanceof Error) {
    const tagged = error as unknown as { code?: unknown; retryable?: unknown };
    const code = typeof tagged.code === 'string' ? tagged.code : 'HANDLER_ERROR';
    const retryable = tagged.retryable === true;
    return failed(code, error.message, retryable);
  }
  return failed('HANDLER_ERROR', String(error));
}
