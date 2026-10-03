/**
 * K02 脱敏 —— **调用记录只留四格，明文密钥有机器判据**（零依赖、纯函数）。
 *
 * ## 口径
 *
 * 模型链路上唯一允许落盘的记录是 `ModelCallRecord`：
 * `model` / `host` / `usage` / `failureReason`。
 * **没有** messages、**没有**请求体、**没有**响应体、**没有** keyRef。
 * 这不是"记得别写"，而是结构上就没有第二个字段可以塞——`redactCallRecord()` 逐字段构造，
 * 不做"展开原对象再删几个键"（那种写法一加字段就漏）。
 *
 * ## 为什么还要一个明文密钥扫描器
 *
 * `keyRef` 的 schema pattern 是 `^keyref:[A-Za-z0-9._:-]+$`。它能挡住 `sk-live-xxxx`，
 * 但挡不住 `keyref:sk-live-xxxx` —— 形状是引用，内容是明文。所以引用形式之外还要做一次
 * **内容**判据。扫描器的模式刻意**高精度低召回**（只认各家密钥的显著字面特征），
 * 宁可漏掉自造形状，也不要把它变成"凡长字符串皆密钥"从而频繁误报、最终被无视。
 */

import type { ModelCallRecord, StreamError, Usage } from './types.js';

/** 记录允许出现的字段名（测试逐字段断言，多一个都不行）。 */
export const CALL_RECORD_FIELDS = ['model', 'host', 'usage', 'failureReason'] as const;
export type CallRecordField = (typeof CALL_RECORD_FIELDS)[number];

/**
 * 明文密钥的显著特征（高精度、低召回）。
 *
 * `sk-` 一条带**左边界**（见下），避免命中 `task-registered` 这类普通单词内部子串。
 *
 * 刻意**不**包含：
 * - 泛化的 `token: ...` —— 契约里的 `cancellation.token`（如 `cancel-42`）会被误报；
 * - 泛化的长十六进制串 —— 本仓库摘要就是 `sha256:<64 hex>`，会误报；
 * - 泛化的 `password` 字样 —— 用户文档正文里可能有。
 */
export const PLAINTEXT_SECRET_PATTERNS: readonly RegExp[] = [
  // 左边界 `(?<![A-Za-z0-9_])` 是**必需**的：没有它，`sk-` 会命中普通单词内部——
  // 本仓库的字面量 `task-registered` 里就藏着一段 `sk-` 开头的子串，会被误报成明文密钥。
  // （注释里刻意不写出该子串的完整形态，免得本审计器把自己的文档也扫成一条命中。）
  // 误报会让「命中即拒」退化成「频繁拒绝正常事件」，判据最终被绕过（K10 同款修复）。
  // 边界只挡「前一个字符是词字符」，`:` 不是词字符，故伪装引用 `keyref:sk-live-...`
  // （形状是引用、内容是明文）**仍会被抓住**——专项测试反向钉住这一点。
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * 返回值里**第一处**命中的明文密钥特征（没有则为 `null`）。
 *
 * 先 `JSON.stringify` 再扫：这样嵌套对象、数组、字符串都会被覆盖，且不会因为
 * 对象是循环引用而抛错以外的行为（循环引用会让 `JSON.stringify` 抛 `TypeError`，
 * 那是调用方的输入问题，不吞掉）。
 */
export function findPlaintextSecret(value: unknown): string | null {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value) ?? '';
  }
  for (const pattern of PLAINTEXT_SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return match[0];
    }
  }
  return null;
}

/** 命中即抛（`ModelPortError` 的 `key_ref_contains_secret` 由调用方决定，这里只报证据）。 */
export function assertNoPlaintextSecret(value: unknown, what: string): void {
  const hit = findPlaintextSecret(value);
  if (hit !== null) {
    // 报错信息里**不回显**命中的明文——否则日志本身成了泄漏点。
    throw new Error(`${what} 命中明文密钥特征（已隐去原文，不落盘）`);
  }
}

export interface CallRecordInput {
  readonly model: string;
  readonly host: string;
  readonly usage: Usage | null;
  readonly error: StreamError | null;
}

/**
 * 构造脱敏调用记录：**逐字段拷贝**，不做对象展开。
 *
 * `failureReason` 是 `` `${code}: ${message}` `` —— 错误码来自本模块词表，message 由
 * 上游错误或本模块生成；两者都不含密钥（上游错误信息在 `streamModel` 里只被转述，
 * 不会被塞进记录的其他字段）。
 */
export function redactCallRecord(input: CallRecordInput): ModelCallRecord {
  return Object.freeze({
    model: input.model,
    host: input.host,
    usage: input.usage === null ? null : Object.freeze({ ...input.usage }),
    failureReason: input.error === null ? null : `${input.error.code}: ${input.error.message}`,
  });
}
