/**
 * K01 —— 载荷安全扫描：桥**不**暴露任意文件 / 密钥 / 代码执行。
 *
 * K01 的桥是 UI 与手机内核之间的封闭边界。UI 只能提交**业务命令**，不能借 payload
 * 把密钥塞进内核（会进日志/事件/账本）、不能递进电脑绝对路径（正式路径禁止回退到电脑，
 * 见 README §3）、不能递进"一段代码"让内核执行。
 *
 * 这是**纵深防御**的一层，不是唯一防线（真正的密钥由 K03 Keystore 持有，明文永不下行）。
 * 命中即抛 `PAYLOAD_FORBIDDEN`（边界错误，非执行结果）。
 *
 * 已知局限：这是**启发式**（键名 + 值模式），不做语义分析；合法业务字段名若恰好撞上
 * 保留字（如某个 patch 里真有 `token` 键）会被拒——需要时由业务改成引用（`*Ref`）。
 */

import type { BootstrapIssue } from './errors.js';

/** 保留键名（小写比较）：任何层级出现即拒。 */
export const FORBIDDEN_KEYS: readonly string[] = [
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
  'password',
  'passwd',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'credential',
  'credentials',
];

/** 保留的代码执行键名：桥不承载"把代码传进来跑"。 */
export const FORBIDDEN_CODE_KEYS: readonly string[] = ['eval', 'exec', 'executescript', 'sourcecode', 'source_code', 'javascript', 'shellcommand', 'shell_command'];

/** 值模式：电脑绝对路径 / 私钥块 / 常见密钥字面量。 */
const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{ readonly code: string; readonly re: RegExp; readonly why: string }> = [
  { code: 'ABSOLUTE_WINDOWS_PATH', re: /^[A-Za-z]:[\\/]/, why: '禁止电脑盘符路径' },
  { code: 'ABSOLUTE_POSIX_PATH', re: /^\//, why: '禁止 POSIX 绝对路径' },
  { code: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '禁止私钥块' },
  { code: 'SECRET_LITERAL', re: /\bsk-[A-Za-z0-9_-]{12,}/, why: '禁止密钥字面量' },
];

const MAX_DEPTH = 12;

/** 扫描一个 payload（或任意子结构），返回发现的问题。 */
export function scanPayload(payload: unknown): readonly BootstrapIssue[] {
  const findings: BootstrapIssue[] = [];
  walk(payload, 'payload', 0, findings);
  return findings;
}

function walk(value: unknown, path: string, depth: number, out: BootstrapIssue[]): void {
  if (depth > MAX_DEPTH) {
    out.push({ path, code: 'TOO_DEEP', message: `嵌套超过 ${MAX_DEPTH} 层` });
    return;
  }
  if (typeof value === 'string') {
    for (const { code, re, why } of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(value)) out.push({ path, code, message: why });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, out));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEYS.includes(lower)) {
        out.push({ path: childPath, code: 'FORBIDDEN_KEY', message: `禁止密钥类字段 ${key}` });
      }
      if (FORBIDDEN_CODE_KEYS.includes(lower)) {
        out.push({ path: childPath, code: 'FORBIDDEN_CODE_KEY', message: `桥不承载代码执行字段 ${key}` });
      }
      walk(child, childPath, depth + 1, out);
    }
  }
}
