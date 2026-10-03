/**
 * F09 settings / 脱敏诊断导出（I5）与连接失败文案清洗（I6）。
 *
 * design-07 §7：「诊断导出默认脱敏；凭证不进入普通页面、APK、分享文案或日志；
 * 连接失败文案不显示密钥或原始认证头。」
 *
 * 本模块是**唯一**把诊断数据带出设置页的通道，默认脱敏且**不可逆**：
 *   - 字段名命中敏感键（apiKey / secret / token / phone / address / email / path …）
 *     ⇒ 整个值替换为 `[redacted:<kind>]`；
 *   - 值形状命中（`sk-`、`AKIA…`、`Bearer …`、手机号、邮箱、盘符路径、UNC 路径、
 *     `/home|/Users` 路径、长令牌）⇒ 就地替换为 `[redacted:<kind>]`；
 *   - 脱敏后再自检一次：序列化结果若仍残留敏感形状 ⇒ 抛 `redaction-failed`（fail-closed）。
 *
 * 干净输入必须**原样保留**——`redactedFields === 0` 且内容不变，证明脱敏不是「整段抹除」。
 */

import type { VerificationMode } from '../../../../contracts/mobile-v1/types.js';

import { SettingsError, isIsoTimestamp } from './types.js';

// ---------------------------------------------------------------------------
// 脱敏规则
// ---------------------------------------------------------------------------

export type RedactionKind =
  | 'api-key'
  | 'token'
  | 'phone'
  | 'email'
  | 'address'
  | 'path'
  | 'auth-header';

const REDACTION_PLACEHOLDER = (kind: RedactionKind): string => `[redacted:${kind}]`;

/** 字段名（归一化后）→ 种类。注意：**不**匹配裸 `key`，避免误伤 `keyRef`。 */
const FIELD_NAME_RULES: readonly (readonly [RegExp, RedactionKind])[] = [
  [/^(api_?key|apikey|secret|password|passwd|rawkey|keymaterial|credential)$/, 'api-key'],
  [/^(authorization|auth_?header|bearer|proxy_?authorization)$/, 'auth-header'],
  [/token/, 'token'],
  [/^(phone|mobile|tel|telephone|contact_?number|contact)$/, 'phone'],
  [/^(address|addr|recipient_?address|receiver_?address|delivery_?address|location)$/, 'address'],
  [/^(email|mail|email_?address)$/, 'email'],
  [/^(path|filepath|file_?path|directory|dir|desktop_?path|local_?path)$/, 'path'],
];

/** 值形状规则；顺序即匹配优先级。 */
const VALUE_RULES: readonly (readonly [RegExp, RedactionKind])[] = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'api-key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'api-key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'api-key'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'auth-header'],
  [/\b1[3-9]\d{9}\b/g, 'phone'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email'],
  // Windows 盘符路径：反斜杠写法，或「冒号+单斜杠」（排除 `scheme://`）。
  [/[A-Za-z]:\\[^\s"';,)]+/g, 'path'],
  [/[A-Za-z]:\/(?!\/)[^\s"';,)]+/g, 'path'],
  [/\\\\[^\s"';,)]+/g, 'path'],
  [/\/(?:home|Users|root|sdcard)\/[^\s"';,)]+/g, 'path'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, 'token'],
];

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z_]/g, '');
}

function fieldKindFor(name: string): RedactionKind | null {
  const normalized = normalizeFieldName(name);
  for (const [pattern, kind] of FIELD_NAME_RULES) {
    if (pattern.test(normalized)) return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export interface RedactionReport {
  /** 被替换的次数（字段整替换 + 值内替换）。 */
  readonly redactedFields: number;
  /** 出现过的种类（去重、稳定排序）。 */
  readonly redactedKinds: readonly RedactionKind[];
  /** 是否干净（无任何替换）。 */
  readonly clean: boolean;
}

interface RedactionCounter {
  count: number;
  readonly kinds: Set<RedactionKind>;
}

// ---------------------------------------------------------------------------
// 文本脱敏
// ---------------------------------------------------------------------------

export interface RedactedText {
  readonly text: string;
  readonly count: number;
  readonly kinds: readonly RedactionKind[];
}

/** 就地脱敏字符串中的所有敏感**值**（不改字段名）。 */
export function redactText(text: string): RedactedText {
  let output = text;
  const kinds = new Set<RedactionKind>();
  let count = 0;
  for (const [pattern, kind] of VALUE_RULES) {
    output = output.replace(pattern, () => {
      count += 1;
      kinds.add(kind);
      return REDACTION_PLACEHOLDER(kind);
    });
  }
  return { text: output, count, kinds: [...kinds].sort() };
}

// ---------------------------------------------------------------------------
// 结构脱敏
// ---------------------------------------------------------------------------

function redactInto(value: unknown, name: string, counter: RedactionCounter): unknown {
  const fieldKind = fieldKindFor(name);
  if (fieldKind !== null) {
    counter.count += 1;
    counter.kinds.add(fieldKind);
    return REDACTION_PLACEHOLDER(fieldKind);
  }
  if (typeof value === 'string') {
    const result = redactText(value);
    counter.count += result.count;
    for (const kind of result.kinds) counter.kinds.add(kind);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInto(item, name, counter));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactInto(child, key, counter);
    }
    return out;
  }
  return value;
}

/** 对任意结构做脱敏，返回新结构 + 报告。不改入参。 */
export function redactObject(input: unknown): { readonly value: unknown; readonly report: RedactionReport } {
  const counter: RedactionCounter = { count: 0, kinds: new Set() };
  const value = redactInto(input, '', counter);
  const report: RedactionReport = {
    redactedFields: counter.count,
    redactedKinds: [...counter.kinds].sort(),
    clean: counter.count === 0,
  };
  return { value, report };
}

// ---------------------------------------------------------------------------
// 诊断导出（I5）
// ---------------------------------------------------------------------------

export interface DiagnosticExportInput {
  readonly generatedAt: string;
  readonly verificationMode: VerificationMode;
  readonly appVersion: string;
  readonly sections: Record<string, unknown>;
}

export interface DiagnosticExport {
  readonly schemaVersion: 'settings-diagnostics-v1';
  readonly generatedAt: string;
  readonly verificationMode: VerificationMode;
  readonly appVersion: string;
  /** 已脱敏的各分区。 */
  readonly sections: Record<string, unknown>;
  readonly redaction: RedactionReport;
}

/** 二次自检：序列化结果不得残留敏感形状。 */
function assertNoResidualSecret(serialized: string): void {
  for (const [pattern] of VALUE_RULES) {
    // 令牌规则会把长 base64 也命中；这里用**不含令牌兜底规则**的集合再查一遍敏感形状。
    if (pattern === VALUE_RULES[VALUE_RULES.length - 1]?.[0]) continue;
    if (pattern.test(serialized)) {
      throw new SettingsError('redaction-failed', '诊断导出仍残留敏感形状，已中止', {});
    }
  }
}

/**
 * 导出诊断：默认脱敏 + 自检。返回对象序列化后**不含**任一敏感原值。
 */
export function exportDiagnostics(input: DiagnosticExportInput): DiagnosticExport {
  if (!isIsoTimestamp(input.generatedAt)) {
    throw new SettingsError('invalid-timestamp', '诊断导出时间必须是 UTC ISO', {});
  }
  const { value, report } = redactObject(input.sections);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsError('redaction-failed', '诊断 sections 必须是对象', {});
  }
  const sections = value as Record<string, unknown>;
  const exportValue: DiagnosticExport = {
    schemaVersion: 'settings-diagnostics-v1',
    generatedAt: input.generatedAt,
    verificationMode: input.verificationMode,
    appVersion: input.appVersion,
    sections,
    redaction: report,
  };
  assertNoResidualSecret(JSON.stringify(exportValue));
  return exportValue;
}

// ---------------------------------------------------------------------------
// 连接失败清洗（I6）
// ---------------------------------------------------------------------------

export interface SanitizedFailure {
  readonly message: string;
  readonly redactedCount: number;
  readonly redactedKinds: readonly RedactionKind[];
}

/**
 * 清洗连接失败文案：密钥与原始认证头**不得**出现在展示/日志里。
 * `rawMessage` 可以是后端返回体片段；返回的 message 一定不含敏感形状。
 */
export function sanitizeFailure(rawMessage: string): SanitizedFailure {
  const result = redactText(rawMessage);
  return {
    message: result.text,
    redactedCount: result.count,
    redactedKinds: result.kinds,
  };
}
