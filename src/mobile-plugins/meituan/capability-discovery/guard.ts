/**
 * M01 —— 发现阶段的**纪律护栏**（可静态断言，不靠约定）。
 *
 * 三条护栏，分别对应工作书里的三句硬约束：
 *   1. 「不凭 key 长度或非官方包名称推断权限」→ {@link findForbiddenInferenceSignals}
 *      扫出矩阵里任何形如 `keyLength` / `packageName` 的字段——出现即视为违规信号。
 *   2. 「发现阶段只读，不发送凭证」→ {@link assertReadOnlyDiscovery} 把允许/禁止动作
 *      写成词表，越界动作当场抛错。
 *   3. 「脱敏」→ {@link findSecretLikeStrings} / {@link assertNoSecretsInMatrix}
 *      扫矩阵序列化结果里的 token 形状与手机号。**只报种类与位置，绝不回显命中的串**。
 */

import type { CapabilityMatrix } from './types.js';
import { unverifiedTargets } from './matrix.js';

// ---------------------------------------------------------------------------
// 护栏 1：禁止"由凭证外形/包名推断权限"
// ---------------------------------------------------------------------------

/** 一旦出现在发现产物里就说明"在用非证据特征推断"的字段名。 */
export const FORBIDDEN_INFERENCE_SIGNALS: readonly string[] = Object.freeze([
  'keyLength',
  'key_length',
  'keySize',
  'key_size',
  'tokenLength',
  'token_length',
  'credentialSize',
  'credential_size',
  'packageName',
  'package_name',
  'keyType',
  'key_type',
  // 文件大小同样不能作为"权限已开"的推断依据（工作书：不凭文件特征推断权限）。
  'fileSize',
  'file_size',
  'fileBytes',
  'file_bytes',
  'fileLength',
  'file_length',
]);

const SIGNAL_SET = new Set(FORBIDDEN_INFERENCE_SIGNALS.map((name) => name.toLowerCase()));

/**
 * 递归扫描任意值，返回命中违规字段名的**路径**（如 `a.b.packageName`）。
 * 只返回字段路径，不返回值——避免把可能的敏感内容带出来。
 */
export function findForbiddenInferenceSignals(value: unknown, path = ''): readonly string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, i) => {
      hits.push(...findForbiddenInferenceSignals(entry, `${path}[${i}]`));
    });
    return Object.freeze(hits);
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const next = path.length > 0 ? `${path}.${key}` : key;
      if (SIGNAL_SET.has(key.toLowerCase())) {
        hits.push(next);
      }
      hits.push(...findForbiddenInferenceSignals(entry, next));
    }
  }
  return Object.freeze(hits);
}

/** 矩阵里出现违规推断字段 ⇒ 抛错。 */
export function assertNoPermissionInference(matrix: CapabilityMatrix): void {
  const hits = findForbiddenInferenceSignals(matrix);
  if (hits.length > 0) {
    throw new Error(
      `能力矩阵含"由凭证外形/包名推断权限"的字段：${hits.join(', ')}。` +
        `M01 口径禁止凭 key 长度或包名推断任何权限。`,
    );
  }
}

// ---------------------------------------------------------------------------
// 护栏 2：发现阶段只读
// ---------------------------------------------------------------------------

/** 发现阶段**允许**的动作。 */
export const DISCOVERY_ALLOWED_ACTIONS = Object.freeze([
  'read-official-doc',
  'record-evidence',
  'build-matrix',
  'report-blocked',
] as const);

/** 发现阶段**禁止**的动作（认证、发凭证、下单、支付、取消一律越界）。 */
export const DISCOVERY_FORBIDDEN_ACTIONS = Object.freeze([
  'login',
  'transmit-credential',
  'send-token',
  'authenticated-request',
  'submit-order',
  'pay',
  'cancel-order',
] as const);

/** 发现阶段动作的联合类型。 */
export type DiscoveryAction =
  | (typeof DISCOVERY_ALLOWED_ACTIONS)[number]
  | (typeof DISCOVERY_FORBIDDEN_ACTIONS)[number];

/** 越界动作 ⇒ 抛错。未知动作同样拒绝（失败关闭）。 */
export function assertReadOnlyDiscovery(action: string): void {
  if (!(DISCOVERY_ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(
      `发现阶段只读：动作 "${action}" 不在允许清单 ${DISCOVERY_ALLOWED_ACTIONS.join('/')} 内。` +
        `未登录前不发送凭证、不认证、不下单、不支付。`,
    );
  }
}

// ---------------------------------------------------------------------------
// 护栏 3：脱敏扫描（绝不回显命中串）
// ---------------------------------------------------------------------------

/** 命中种类。 */
export type SecretKind = 'hex-token' | 'base64-token' | 'phone-number';

/** 一条命中：**只有种类与位置**，不含命中内容本身。 */
export interface SecretFinding {
  readonly kind: SecretKind;
  /** 在文本中的起始下标。 */
  readonly index: number;
  /** 命中长度。 */
  readonly length: number;
}

const SECRET_PATTERNS: readonly { readonly kind: SecretKind; readonly pattern: RegExp }[] = Object.freeze([
  // 32 位以上连续十六进制：典型 api key / secret（本包的 uuid 片段被 '-' 分隔，不会误报 32 连）。
  { kind: 'hex-token', pattern: /[0-9a-fA-F]{32,}/g },
  // 40 位以上 base64 片段。
  { kind: 'base64-token', pattern: /[A-Za-z0-9+/]{40,}={0,2}/g },
  // 中国大陆手机号（前后不接数字）。
  { kind: 'phone-number', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
]);

/** 扫出疑似密钥/手机号。**只回种类与位置**（`index`/`length`），不回命中串。 */
export function findSecretLikeStrings(text: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    // 每次调用用新正则实例，避免 lastIndex 在全局正则间串味。
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      // 纯十六进制串同时落在 base64 字符集里，会与 hex-token 重复上报；
      // 交给 hex-token 认领即可（任何 >=40 的纯 hex 串必然也 >=32，hex 检测覆盖）。
      if (kind === 'base64-token' && /^[0-9a-fA-F]+=*$/.test(match[0])) {
        if (match[0].length === 0) {
          re.lastIndex += 1;
        }
        continue;
      }
      findings.push({ kind, index: match.index, length: match[0].length });
      if (match[0].length === 0) {
        re.lastIndex += 1;
      }
    }
  }
  return Object.freeze(findings);
}

/** 矩阵序列化里出现疑似密钥/手机号 ⇒ 抛错（不回显命中串）。 */
export function assertNoSecretsInMatrix(matrix: CapabilityMatrix): void {
  const serialized = JSON.stringify(matrix);
  const findings = findSecretLikeStrings(serialized);
  if (findings.length > 0) {
    const summary = findings.map((f) => `${f.kind}@${f.index}(len=${f.length})`).join(', ');
    throw new Error(`能力矩阵命中疑似敏感串（种类/位置：${summary}）；已阻断，且不回显命中内容。`);
  }
}

// ---------------------------------------------------------------------------
// 一致性：只读不变量 + allUnverified 必须与逐项结论一致
// ---------------------------------------------------------------------------

/** 校验矩阵自身不变量；任何一条不成立即抛错。 */
export function assertMatrixIntegrity(matrix: CapabilityMatrix): void {
  if (matrix.credentialTransmitted || matrix.authenticatedRequestMade || matrix.orderOrPaymentSubmitted) {
    throw new Error('发现阶段只读不变量被破坏：出现了发送凭证/认证请求/下单支付。');
  }
  const remaining = unverifiedTargets(matrix).length;
  const expectedAllUnverified = remaining > 0;
  if (matrix.allUnverified !== expectedAllUnverified) {
    throw new Error(
      `allUnverified=${matrix.allUnverified} 与逐项结论不一致（仍 unverified 的目标数=${remaining}）。`,
    );
  }
  assertNoPermissionInference(matrix);
  assertNoSecretsInMatrix(matrix);
}
