/**
 * M02 —— 脱敏与"证据无明文"自证。
 *
 * 工作书要求「APK/日志无明文」。本模块提供两件事：
 *
 * 1. {@link buildEvidence} 构造**结构上无秘密落点**的证据条目：只有 host / path /
 *    method / keyRef / tokenRef / status / 时间 / 结果。它**没有** Authorization、
 *    没有请求体、没有响应体、没有令牌。
 * 2. {@link containsLikelySecret} 扫描任意值（证据、日志、字符串）里是否出现形似
 *    密钥的片段；测试用它把"证据里混进明文"变成可回归断言。
 *
 * 注意：`tokenRef`（`sessref:...`）与 `keyRef`（`keyref:...`）是**引用**，允许出现；
 * 本模块只对**值**做密钥形状扫描，不对键名（键名里出现 `token` 是正常的）。
 */

import type { HttpMethod, TransportEvidence } from './types.js';

/** 形态：疑似 API key / Bearer 令牌 / JWT。用于扫描证据是否混入明文。 */
const LIKELY_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}\b/, // OpenAI/DeepSeek 风格
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, // Authorization: Bearer <token>
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./, // JWT
  /\b[A-Fa-f0-9]{32,}\b/, // 长十六进制（疑似密钥/hash 明文）
]);

/** 任意字符串值里是否出现形似密钥的片段。 */
export function containsLikelySecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return LIKELY_SECRET_PATTERNS.some((re) => re.test(value));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsLikelySecret(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => containsLikelySecret(item));
  }
  return false;
}

/** 构造证据条目的入参。 */
export interface EvidenceInput {
  readonly host: string;
  readonly path: string;
  readonly method: HttpMethod;
  readonly keyRef: string;
  readonly tokenRef: string | null;
  readonly status: number | null;
  readonly outcome: string;
  readonly at: number;
}

/** 构造脱敏证据条目（结构上无秘密字段）。 */
export function buildEvidence(input: EvidenceInput): TransportEvidence {
  return Object.freeze({
    host: input.host,
    path: input.path,
    method: input.method,
    keyRef: input.keyRef,
    tokenRef: input.tokenRef,
    status: input.status,
    outcome: input.outcome,
    at: input.at,
    redacted: true as const,
    plaintextSecretFields: 0 as const,
  });
}

/**
 * 断言一段证据（或任意对象）不含形似密钥的明文。**只对值扫描**，跳过引用形状
 * （`keyref:` / `sessref:` / `acct:`）——它们本就是引用，不是秘密。
 */
export function assertEvidenceClean(evidence: unknown): void {
  const refPattern = /^(keyref:|sessref:|acct:|install:)/;
  const walk = (value: unknown): boolean => {
    if (typeof value === 'string') {
      if (refPattern.test(value)) {
        return false;
      }
      return LIKELY_SECRET_PATTERNS.some((re) => re.test(value));
    }
    if (Array.isArray(value)) {
      return value.some((item) => walk(item));
    }
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some((item) => walk(item));
    }
    return false;
  };
  if (walk(evidence)) {
    throw new Error('证据中含疑似密钥明文：脱敏失败（不得写入日志 / 证据 / 状态）');
  }
}
