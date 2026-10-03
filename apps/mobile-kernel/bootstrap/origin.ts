/**
 * K01 —— 调用方 / 本地 origin 校验。
 *
 * 桥的信任边界：APK 内页面随包本地加载（README §3 "UI WebView 可以保留，但页面必须随
 * APK 本地加载，不能以加载远程页面代替内核迁移"）。因此**只有本地 origin** 允许提交命令。
 *
 * 默认白名单是**本地**三态：
 *   - `app://local`             —— 自定义 scheme（assets 域名隔离）；
 *   - `file:///android_asset`   —— `file://` 指向 APK 资源；
 *   - `https://localhost`       —— 本地 WebView 回环（系统 localhost 映射）。
 *
 * 远程 origin（`https://evil.example`、`http://10.0.2.2` 等）一律拒绝。这是**唯一**的
 * 远程/本地判定点；其余层不得各自再造一套。
 */

import { bootstrapError, type BootstrapIssue } from './errors.js';
import type { CallerIdentity, CallerKind } from './types.js';

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'app://local',
  'file:///android_asset',
  'https://localhost',
];

const VALID_KINDS: readonly CallerKind[] = ['ui-webview', 'native', 'test'];

/** 归一化 origin：去空白；scheme/host 小写（path 保持原样）。 */
export function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  // 只小写 scheme + authority 段，避免把大小写敏感的 path 改坏。
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*)(.*)$/.exec(trimmed);
  if (match === null) return trimmed.toLowerCase();
  return `${(match[1] ?? '').toLowerCase()}${match[2] ?? ''}`;
}

export function isAllowedOrigin(origin: string, allowed: readonly string[] = DEFAULT_ALLOWED_ORIGINS): boolean {
  const normalized = normalizeOrigin(origin);
  return allowed.some((candidate) => normalizeOrigin(candidate) === normalized);
}

/**
 * 校验调用方身份。合法返回归一化后的身份；不合法**抛** `ORIGIN_REJECTED` / `CALLER_INVALID`。
 */
export function assertCaller(
  caller: unknown,
  allowedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS,
  allowedKinds?: readonly CallerKind[],
): CallerIdentity {
  if (typeof caller !== 'object' || caller === null || Array.isArray(caller)) {
    throw bootstrapError('CALLER_INVALID', '调用方身份必须是对象');
  }
  const record = caller as Record<string, unknown>;
  const origin = record.origin;
  if (typeof origin !== 'string' || origin.trim().length === 0) {
    throw bootstrapError('CALLER_INVALID', '调用方缺少 origin');
  }
  const kind = record.kind;
  if (kind !== undefined && (typeof kind !== 'string' || !VALID_KINDS.includes(kind as CallerKind))) {
    const issues: BootstrapIssue[] = [{ path: 'kind', code: 'UNKNOWN_KIND', message: `kind 必须是 ${VALID_KINDS.join(' | ')}` }];
    throw bootstrapError('CALLER_INVALID', '调用方 kind 非法', issues);
  }
  const normalized = normalizeOrigin(origin);
  if (!isAllowedOrigin(normalized, allowedOrigins)) {
    const issues: BootstrapIssue[] = [{ path: 'origin', code: 'ORIGIN_NOT_ALLOWED', message: `origin ${origin} 不在本地白名单内` }];
    throw bootstrapError('ORIGIN_REJECTED', `拒绝非本地 origin：${origin}`, issues);
  }
  if (allowedKinds !== undefined && kind !== undefined && !allowedKinds.includes(kind as CallerKind)) {
    const issues: BootstrapIssue[] = [{ path: 'kind', code: 'KIND_NOT_ALLOWED', message: `kind ${kind} 不在允许集合内` }];
    throw bootstrapError('ORIGIN_REJECTED', `拒绝调用方种类：${kind}`, issues);
  }
  const packageName = record.packageName;
  return {
    origin: normalized,
    ...(kind === undefined ? {} : { kind: kind as CallerKind }),
    ...(typeof packageName === 'string' ? { packageName } : {}),
  };
}
