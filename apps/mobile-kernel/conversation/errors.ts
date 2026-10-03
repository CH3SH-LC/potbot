/**
 * K04 连续对话 —— **失败码词表与结果类型**（零依赖、纯数据）。
 *
 * 纪律（与仓库其余部分一致，见 `src/conversation/session-model.ts` 头）：
 *
 * - **失败不编造**：每个动作返回**结构化**结果，失败分支带机器可判的 `code`，
 *   **不携带半成品值**（`ContinuityResult<T>` 的两个分支互斥）。
 * - **读不回来不算空**：落盘形状不符时返回 `state_unreadable`，**不**静默按"一个会话都没有"起。
 * - **重试的语义边界**：只有 `failed` / `cancelled` 的消息可重试；别的状态重试是
 *   `not_retryable`（把一个"正在跑"的消息再跑一遍会造成重复副作用）。
 */

/**
 * 本模块的失败码（封闭枚举；每个码一个含义，**不接受自由字符串**）。
 *
 * | 码 | 含义 |
 * |---|---|
 * | `conversation_not_found` | 目标会话不在本 store 里（未创建 / 未从落盘恢复出来） |
 * | `message_not_found` | 目标消息不在该会话里 |
 * | `not_retryable` | 该消息当前阶段不允许重试（只有 `failed` / `cancelled` 可以） |
 * | `invalid_input` | 入参形状非法（空 id / 空文本 / 非法分页参数等） |
 * | `state_unreadable` | 落盘快照读不回来（schema / 字段形状不符，**整份拒绝**） |
 * | `fact_missing` | 恢复当前文档时，持久事实里没有本会话的锚点 |
 * | `artifact_not_found` | 事实指向的产物在产物登记处查不到（换运行目录就会命中这条） |
 * | `artifact_not_delivered` | 产物存在但**尚未交付**（无可信回执）⇒ 不认 |
 * | `artifact_task_mismatch` | 产物归属的任务与事实锚定的任务对不上 ⇒ 不认 |
 */
export type ConversationContinuityErrorCode =
  | 'conversation_not_found'
  | 'message_not_found'
  | 'not_retryable'
  | 'invalid_input'
  | 'state_unreadable'
  | 'fact_missing'
  | 'artifact_not_found'
  | 'artifact_not_delivered'
  | 'artifact_task_mismatch';

/** 结构化失败。`retryable` 是**该次调用的**可重试性（不是消息阶段）。 */
export interface ConversationContinuityError {
  readonly code: ConversationContinuityErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ContinuityOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ContinuityFailure {
  readonly ok: false;
  readonly error: ConversationContinuityError;
}

/** 本模块统一结果类型。**失败分支里没有任何 `value`**（不能误用半成品）。 */
export type ContinuityResult<T> = ContinuityOk<T> | ContinuityFailure;

export function continuityOk<T>(value: T): ContinuityOk<T> {
  return Object.freeze({ ok: true as const, value });
}

export function continuityFail(
  code: ConversationContinuityErrorCode,
  message: string,
  retryable = false,
): ContinuityFailure {
  return Object.freeze({ ok: false as const, error: Object.freeze({ code, message, retryable }) });
}

/** 运行时判别（供上层在 `unknown` 边界使用）。 */
export function isConversationContinuityError(value: unknown): value is ConversationContinuityError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['code'] === 'string' && typeof candidate['message'] === 'string';
}

/** 把任意抛错描述成一句可核查的话（不吞掉原始信息）。 */
export function describeContinuityError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
