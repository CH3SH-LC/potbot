/**
 * 依赖解除与有限诊断的错误类型（D05；`src/dependency/`）。
 *
 * 约定（与 `src/protocol/errors.ts` 同构）：错误对象上带 `accepted` 判别位，
 * 调用方**不得**用 `instanceof Error` 的宽判据替代。
 *
 * 本模块的错误一律表示"**算不出 / 不允许**"，而不是"悄悄返回一个空结果"：
 * - `DiagnosisBudgetError` / `DiagnosisBudgetExceededError`：预算未登记或已超限（Q9-a）。
 * - `FingerprintError`：阻塞指纹算不出（Q9-b：阻塞项跨任务版本等）。
 * - `RecoveryRefusedError`：同版同指纹的自动恢复被拒绝（§九-7）。
 * - `DependencyResolutionError`：依赖解除计划无法构造（例如传入损坏记录）。
 */

export class DependencyError extends Error {
  /** 恒为 false：本错误不代表任何状态已被接受或写入。 */
  readonly accepted = false as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DependencyError';
  }
}

/** 是否是本模块的错误（跨 realm 时退化为按 name 判定）。 */
export function isDependencyError(value: unknown): value is DependencyError {
  return value instanceof DependencyError;
}
