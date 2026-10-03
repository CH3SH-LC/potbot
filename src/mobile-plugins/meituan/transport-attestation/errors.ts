/**
 * `transport-attestation` 错误码表（可机读，供前端 / 验收逐条比对）。
 */

export const TRANSPORT_ATTESTATION_ERROR_CODES = [
  /** 传入对象形状非法（缺字段 / 非有限数 / 非对象）。 */
  'invalid_input',
  /** 能力矩阵没有一项 verified：M01 尚未核实任何真实能力（诚实默认）⇒ 不得签发。 */
  'capability_matrix_unverified',
  /** 传输结果未送达（delivered !== true || ok !== true）⇒ 不能证明真机传输。 */
  'transport_not_delivered',
  /** 传输证据未声明脱敏（redacted !== true 或 plaintextSecretFields !== 0）。 */
  'transport_evidence_not_redacted',
  /** 引用疑似含未脱敏敏感信息（手机号 / 密钥 / 令牌）。 */
  'secret_like_text_rejected',
  /** 消费端拿到形状相同但**未登记**的凭证（自造 / 拷贝）。 */
  'untrusted_real_transport_attestation',
] as const;

export type TransportAttestationErrorCode = (typeof TRANSPORT_ATTESTATION_ERROR_CODES)[number];

export class TransportAttestationError extends Error {
  readonly code: TransportAttestationErrorCode;
  constructor(code: TransportAttestationErrorCode, message: string) {
    super(message);
    this.name = 'TransportAttestationError';
    this.code = code;
  }
}
