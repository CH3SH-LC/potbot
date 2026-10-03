/**
 * S4 —— 脱敏。
 *
 * 密钥不进 APK、不进仓库、不进日志、不进报告。端口可能把上游错误原文
 * 带到异常消息里，所以一切对外字符串都先过这里。
 */

const SECRET_REPLACERS: readonly ((input: string) => string)[] = [
  (s) => s.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***'),
  (s) => s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'),
  (s) =>
    s.replace(
      /("(?:api_?key|auth_?token|authorization|x-api-key)"\s*:\s*")[^"]{4,}(")/gi,
      '$1***$2',
    ),
];

/** 把已知密钥值本身也抹掉（比模式匹配更可靠）。 */
export function makeSanitizer(secrets: readonly (string | undefined)[]): (input: unknown) => string {
  const values = secrets.filter((v): v is string => typeof v === 'string' && v.length >= 8);
  return (input: unknown): string => {
    let s = typeof input === 'string' ? input : String(input ?? '');
    for (const secret of values) s = s.split(secret).join('***');
    for (const replace of SECRET_REPLACERS) s = replace(s);
    return s;
  };
}

/** 默认脱敏器：只做模式匹配（没有已知密钥值时使用）。 */
export const sanitize = makeSanitizer([]);
