/**
 * K01 —— 手机内核引导层错误。
 *
 * 分层口径（本包最重要的约定，测试据此断言）：
 *
 * - **边界错误（throw）**：调用方 / 本地 origin 不合法、命令形状不合法、载荷夹带
 *   密钥/绝对路径/代码执行字段、运行时未启动。这些发生在**信任边界之外**，命令本身
 *   可能不完整（连 commandId 都没有），无法安全地包装成契约 `event`（event 要求
 *   `eventId/seq/commandId/revision/status` 齐备）。所以**抛出**结构化错误，由宿主
 *   （Android Service / WebView）决定如何拒绝。
 * - **执行结果（返回 event）**：命令合法但执行层给不出结果（缺执行器、处理器抛错、
 *   revision 冲突、被取消）。这些**一定**返回契约 `event`，状态取自词表
 *   `pending/running/succeeded/failed/conflict/cancelled`，绝不伪造成 succeeded。
 *
 * 零依赖纯 TS，不 import node 内建；可被 QuickJS / V8 / Node 任一旁加载。
 */

export const BOOTSTRAP_ERROR_CODES = [
  'ORIGIN_REJECTED',
  'CALLER_INVALID',
  'COMMAND_INVALID',
  'PAYLOAD_FORBIDDEN',
  'RUNTIME_NOT_RUNNING',
  'RUNTIME_ALREADY_RUNNING',
  'MODULE_CONFLICT',
] as const;

export type BootstrapErrorCode = (typeof BOOTSTRAP_ERROR_CODES)[number];

/** 单个字段级问题（命令校验 / 载荷扫描共用）。 */
export interface BootstrapIssue {
  /** JSON 风格路径，如 `payload.expectedRevision`。 */
  readonly path: string;
  /** 机器可读原因码，如 `MISSING` / `NOT_AN_INTEGER` / `FORBIDDEN_KEY`。 */
  readonly code: string;
  readonly message: string;
}

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;
  readonly issues: readonly BootstrapIssue[];

  constructor(code: BootstrapErrorCode, message: string, issues: readonly BootstrapIssue[] = []) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    this.issues = issues;
  }
}

export function isBootstrapError(value: unknown): value is BootstrapError {
  return value instanceof BootstrapError;
}

export function bootstrapError(
  code: BootstrapErrorCode,
  message: string,
  issues: readonly BootstrapIssue[] = [],
): BootstrapError {
  return new BootstrapError(code, message, issues);
}
