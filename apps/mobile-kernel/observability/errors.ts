/** K10 诊断/观测错误词表（零依赖）。 */

export const OBSERVABILITY_ERROR_CODES = [
  /** 诊断事件里发现明文密钥：**拒绝写入**，不脱敏后照写。 */
  'diagnostic_secret_detected',
  /** 诊断事件形状非法（字段类型错 / 缺字段 / 未知 kind）。 */
  'invalid_diagnostic_event',
  /** 环形缓冲容量非法。 */
  'invalid_capacity',
] as const;
export type ObservabilityErrorCode = (typeof OBSERVABILITY_ERROR_CODES)[number];

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;

  constructor(code: ObservabilityErrorCode, message: string) {
    super(message);
    this.name = 'ObservabilityError';
    this.code = code;
  }
}
