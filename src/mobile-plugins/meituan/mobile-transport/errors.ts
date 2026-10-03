/**
 * M02 —— 错误类型。
 *
 * 全部消息**只含引用 / 字段名 / 主机名**，绝不含密钥明文、令牌、请求体原文。
 * 这是让「APK/日志无明文」成为可回归断言的前提：错误本身没有可泄漏的落点。
 */

/** M02 传输层错误基类。 */
export class MobileTransportError extends Error {
  readonly code: string;
  readonly host: string | null;
  constructor(code: string, message: string, host: string | null = null) {
    super(message);
    this.name = 'MobileTransportError';
    this.code = code;
    this.host = host;
  }
}

/**
 * 目标主机不在官方授权列表内。
 *
 * 这是**在发出任何网络调用之前**抛出的（见 `policy.ts` / `client.ts`）：凭证绝不
 * 会被送到非官方 host。`host` 只用于指出被拒的目标，非密钥。
 */
export class EndpointNotAllowedError extends MobileTransportError {
  constructor(host: string, allowedHosts: readonly string[]) {
    super(
      'endpoint_not_allowed',
      `目标主机 "${host}" 不在官方授权列表内（允许：${allowedHosts.join(', ') || '（空）'}）；已在发出请求前拒绝`,
      host,
    );
    this.name = 'EndpointNotAllowedError';
  }
}

/** 会话已撤销 / 已过期，或尚未建立：不能发出业务请求。 */
export class SessionUnavailableError extends MobileTransportError {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super('session_unavailable', message);
    this.name = 'SessionUnavailableError';
    this.reason = reason;
  }
}
