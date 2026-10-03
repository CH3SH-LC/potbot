/**
 * M-R06 —— **非官方 endpoint 拒绝**（零依赖、无 IO、无时钟、**不发起请求**）。
 *
 * ## 洞：请求被发到"看起来像官方"的地址
 *
 * 凭证（K03 keyRef 背后的真实 key）只在**官方 host** 才允许出站。仿冒形态很多：
 *
 * - 后缀仿冒：`https://developer.meituan.com.evil.com/...`
 * - 前缀仿冒：`https://evil-meituan.com/...` / `https://notmeituan.com/...`
 * - userinfo 欺骗：`https://developer.meituan.com@evil.com/...`（host 其实是 evil.com）
 * - 裸 IP：`https://203.0.113.9/...`
 * - 混淆/同形：punycode `xn--` 或非 ASCII host
 * - 降级：`http://` / `ws://` / `javascript:` / `data:` / `file:`
 * - 非默认端口：`https://developer.meituan.com:8443/...`
 * - 端点走私：`https://developer.meituan.com/redirect?url=https://evil.com/x`
 *
 * ## 对策：**先过 allowlist，再做任何网络调用**
 *
 * {@link assertOfficialEndpoint} 在传输层**之前**跑：不是 https、host 不在白名单、
 * 是 IP、含混淆字符、非 443 端口、或查询串里嵌套了非官方绝对 URL——一律抛错，
 * **一个字节都不出站**。
 *
 * ## 诚实边界
 *
 * MEITUAN.md：**消费者下单 API 的 host 尚未核实**（M01 阻塞）。因此默认白名单
 * {@link DEFAULT_MEITUAN_ALLOWLIST} **只**登记文档里确已出现的 `developer.meituan.com`。
 * 把 `api.meituan.com` 之类未经核实的 host 写进默认白名单，本身就是本包要拦的
 * "非官方 endpoint" 洞的变体。真实下单 host 必须由 M01 核实后**显式注入**
 * （{@link withHosts} / 自定义 allowlist 对象）。
 */

import { M06GuardError } from './errors.js';
import type { EndpointAllowlist, EndpointVerdict, OfficialEndpoint } from './types.js';

/**
 * 默认官方白名单：**只**含文档中确已出现的开发者门户 host。
 * 见文件头"诚实边界"——未经核实的下单 host 不得预置。
 */
export const DEFAULT_MEITUAN_ALLOWLIST: EndpointAllowlist = Object.freeze({
  hosts: Object.freeze(['developer.meituan.com']),
  wildcardHosts: Object.freeze([]),
});

/** 构造一份追加了精确 host 的白名单（不改动默认对象）。 */
export function withHosts(
  base: EndpointAllowlist,
  ...hosts: readonly string[]
): EndpointAllowlist {
  const merged = new Set(base.hosts.map((h) => h.toLowerCase()));
  for (const host of hosts) merged.add(host.toLowerCase());
  return Object.freeze({
    hosts: Object.freeze([...merged].sort()),
    wildcardHosts: Object.freeze([...base.wildcardHosts]),
  });
}

/** 精确/IP 判定辅助。 */
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpLiteralHost(host: string): boolean {
  if (IPV4_PATTERN.test(host)) return true;
  // IPv6 在 URL.hostname 里带方括号。
  return host.startsWith('[') || host.includes(':');
}

/**
 * host 是否命中 allowlist。
 * - 精确项：完全相等；
 * - 通配项 `*.suffix`：host 必须**严格**以 `.suffix` 结尾（`api.meituan.com` 命中
 *   `*.meituan.com`；`meituan.com` 本身、`evilmeituan.com`、`meituan.com.evil.com` 都不命中）。
 */
export function isHostAllowed(host: string, allowlist: EndpointAllowlist): boolean {
  const lower = host.toLowerCase();
  if (allowlist.hosts.some((h) => h.toLowerCase() === lower)) return true;
  return allowlist.wildcardHosts.some((entry) => {
    const suffix = entry.replace(/^\*\./, '').toLowerCase();
    return lower.length > suffix.length + 1 && lower.endsWith(`.${suffix}`);
  });
}

/**
 * 脱敏 endpoint：只保留 `scheme://host[:port]/path`，**丢弃** userinfo、查询串、片段。
 * 用于日志/证据——查询串里可能夹带 token。
 */
export function redactEndpoint(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname === '' ? '/' : parsed.pathname;
    return `${parsed.protocol}//${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}${path}`;
  } catch {
    return '(unparseable-url)';
  }
}

/** 校验 URL 是否为官方 https endpoint（**非抛出**，返回判定对象）。 */
export function validateEndpoint(
  rawUrl: unknown,
  allowlist: EndpointAllowlist = DEFAULT_MEITUAN_ALLOWLIST,
): EndpointVerdict {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return fail('invalid_endpoint_url', null, `endpoint 必须是非空字符串，收到 ${rawUrl === null ? 'null' : typeof rawUrl}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return fail('invalid_endpoint_url', null, `endpoint 不是合法 URL（已脱敏不记录原文）`);
  }

  // userinfo 欺骗：https://official@evil —— URL 会把 host 解析成 evil，但先显式拦。
  if (parsed.username !== '' || parsed.password !== '') {
    return fail('invalid_endpoint_url', parsed.hostname, 'endpoint 携带 userinfo，host 可被仿冒欺骗，一律拒绝');
  }

  // scheme：只认 https。
  if (parsed.protocol !== 'https:') {
    return fail('insecure_endpoint_scheme', parsed.hostname, `scheme 必须为 https，收到 ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // 非 ASCII / punycode 混淆。
  if (/[^\x20-\x7E]/.test(parsed.hostname) || parsed.hostname.toLowerCase().includes('xn--')) {
    return fail('non_ascii_host', host, 'host 含非 ASCII / punycode 混淆字符');
  }
  // 裸 IP。
  if (isIpLiteralHost(host)) {
    return fail('ip_literal_endpoint', host, '官方接口不使用裸 IP 字面量');
  }
  // 端口：仅默认 https 端口。
  if (parsed.port !== '' && parsed.port !== '443') {
    return fail('non_default_port', host, `端口必须是 443 或省略，收到 ${parsed.port}`);
  }
  // 白名单。
  if (!isHostAllowed(parsed.hostname.toLowerCase(), allowlist)) {
    return fail('non_official_endpoint', host, `host ${host} 不在官方 allowlist 内`);
  }
  // 端点走私：查询串里嵌套指向非官方 host 的绝对 URL。
  for (const [, value] of parsed.searchParams) {
    const nested = extractAbsoluteUrl(value);
    if (nested !== null && !isHostAllowed(nested.hostname.toLowerCase(), allowlist)) {
      return fail(
        'nested_non_official_endpoint',
        host,
        `查询串嵌套了非官方绝对 URL（host=${nested.hostname}），疑似开放重定向/端点走私`,
      );
    }
  }

  const endpoint: OfficialEndpoint = Object.freeze({
    scheme: 'https' as const,
    host: parsed.hostname.toLowerCase(),
    port: 443 as const,
    path: parsed.pathname === '' ? '/' : parsed.pathname,
    redacted: redactEndpoint(rawUrl),
  });
  return Object.freeze({ ok: true as const, endpoint });
}

/** 布尔便捷式。 */
export function isOfficialEndpoint(
  rawUrl: unknown,
  allowlist: EndpointAllowlist = DEFAULT_MEITUAN_ALLOWLIST,
): boolean {
  return validateEndpoint(rawUrl, allowlist).ok;
}

/**
 * 校验并**抛出**。传输层必须在发起请求前调用本函数——
 * 非官方 endpoint ⇒ `M06GuardError`，**零出站**。
 */
export function assertOfficialEndpoint(
  rawUrl: unknown,
  allowlist: EndpointAllowlist = DEFAULT_MEITUAN_ALLOWLIST,
): OfficialEndpoint {
  const verdict = validateEndpoint(rawUrl, allowlist);
  if (!verdict.ok) {
    throw new M06GuardError(verdict.code, verdict.detail, verdict.host);
  }
  return verdict.endpoint;
}

/** 从一段文本里抽出绝对 http(s) URL（用于端点走私检测）。返回 null 表示不是绝对 URL。 */
function extractAbsoluteUrl(value: string): URL | null {
  try {
    const candidate = new URL(value);
    if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

function fail(
  code: import('./errors.js').M06ErrorCode,
  host: string | null,
  detail: string,
): EndpointVerdict {
  return Object.freeze({ ok: false as const, code, host, detail });
}
