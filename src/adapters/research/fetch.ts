/**
 * RES-02 —— 读取**获准链接**与页面正文。
 *
 * 需要处理的四类现实情况（任务书原文）：
 * - **跳转**：3xx 逐跳跟随，记录完整跳转链，跟满 `maxRedirects` 即停（不无限跟）；
 * - **不可访问**：4xx/5xx 如实报 HTTP 状态，不当"空正文"；
 * - **超时**：端口抛超时 ⇒ 结构化 timeout，不重试到假成功；
 * - **内容变化**：与上次抓取的指纹（内容摘要 / ETag / Last-Modified）比对，标记 `changed`；
 *   304 Not Modified 与"无变化"都不丢来源。
 *
 * 每条成功结果**必须**记录：标题、原地址、最终地址、获取时间（注入时钟）、来源身份（主机名）。
 *
 * 出站由宿主实现 `HttpFetchPort` 注入；**没有端口即未就绪**——本模块不自行联网。
 * 本文件不含 `node:fs` / 墙钟 / 随机（时间来自注入的 `ClockPort`）。
 */
import type { ClockPort } from './ports.js';

/** 单次 HTTP 抓取的选项。 */
export interface FetchOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

/**
 * 真实抓取端口 —— 由宿主实现（安卓可基于平台 HTTP 栈）。
 * 端口**必须**在超时后 reject（带 `name: 'TimeoutError'` 更佳），本模块据此结构化上报。
 */
export interface HttpFetchPort {
  readonly id: string;
  get(url: string, options: FetchOptions): Promise<FetchResponse>;
}

/** 端口的原始响应；跳转以 `location` 表达，由本模块跟随。 */
export interface FetchResponse {
  readonly status: number;
  /** 产生该响应的 URL（跟随跳转后即当前 URL）。 */
  readonly url: string;
  /** 3xx 的 Location（跟随目标）。 */
  readonly location?: string | null;
  readonly contentType?: string | null;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly body: Uint8Array;
}

/** 来源身份与来源出处（RES-02「记录标题、原地址、获取时间、来源身份」）。 */
export interface PageSource {
  readonly title: string;
  readonly originalUrl: string;
  readonly finalUrl: string;
  /** 获取时间（毫秒，来自注入时钟）。 */
  readonly fetchedAt: number;
  /** 来源身份：主机名（域名），用于区分"来自哪个站点"。 */
  readonly sourceIdentity: string;
  readonly contentType: string;
  readonly byteLength: number;
  /** 正文字节的内容摘要（sha 由端口/调用方无关地计算，这里用长度无关的稳定哈希）。 */
  readonly contentHash: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/** 供跨次比对的内容指纹。 */
export interface PageFingerprint {
  readonly url: string;
  readonly contentHash: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly fetchedAt: number;
}

export type PageFetchOutcome =
  | {
      readonly status: 'ok';
      readonly source: PageSource;
      /** 页面可见正文（HTML 已剥离标签）。 */
      readonly text: string;
      /** 相对上次抓取是否有变化（首次抓取视为 true）。 */
      readonly changed: boolean;
      /** 304 命中缓存：正文为空，应复用本地上次内容。 */
      readonly notModified: boolean;
      /** 跳转链：[起始 URL, 中间…, 最终 URL]；无跳转时长度为 1。 */
      readonly redirects: readonly string[];
    }
  | { readonly status: 'not-ready'; readonly reason: string; readonly unlock: readonly string[] }
  | { readonly status: 'not-allowed'; readonly url: string; readonly host: string; readonly reason: string }
  | { readonly status: 'timeout'; readonly url: string; readonly timeoutMs: number; readonly reason: string }
  | { readonly status: 'unreachable'; readonly url: string; readonly reason: string }
  | {
      readonly status: 'inaccessible';
      readonly url: string;
      readonly httpStatus: number;
      readonly reason: string;
    }
  | { readonly status: 'too-many-redirects'; readonly chain: readonly string[]; readonly reason: string }
  | {
      readonly status: 'unsupported-content';
      readonly url: string;
      readonly contentType: string;
      readonly reason: string;
    };

export const NO_FETCH_PORT_REASON =
  '未装配真实抓取端口（HttpFetchPort）：产品运行链上不能自行发起 HTTP 出站，故无法读取任何链接。';

export const NO_FETCH_PORT_UNLOCK: readonly string[] = Object.freeze([
  '由宿主实现 HttpFetchPort 并注入 createPageReader',
  '在宿主配置获准链接域名（allowedHosts），避免任意 URL 出站',
  '对一次真实抓取做端到端实测（含跳转与超时路径）后标记"已验证"',
]);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

/** 提取主机名；解析失败返回 '(unknown-host)'（不抛错）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '(unknown-host)';
  }
}

/**
 * 稳定内容摘要 —— FNV-1a 32 位（十六进制）。
 * 选它而非 sha256：本模块**不引入 node:crypto**（保持零内建依赖倾向），
 * 且这里只需"是否变化"的稳定判据，不做安全用途。
 */
export function contentHashOf(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const TEXTUAL_TYPES: readonly string[] = Object.freeze([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
]);

function baseType(contentType: string | null): string {
  if (contentType === null) {
    return 'text/html'; // 缺省按 HTML 处理（抓取的典型场景）
  }
  return contentType.split(';')[0]?.trim().toLowerCase() ?? 'text/html';
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** 剥离 HTML 标签与不可见区，得到正文文本（确定性、无依赖）。 */
export function htmlToText(html: string): string {
  let out = html;
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  out = decodeEntities(out);
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** 从 HTML 抽取 `<title>`；无则返回 null。 */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) {
    return null;
  }
  const raw = match[1];
  if (raw === undefined) {
    return null;
  }
  const title = decodeEntities(raw.replace(/\s+/g, ' ').trim());
  return title.length > 0 ? title : null;
}

/** 从 URL 末段推断后备标题。 */
function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter((s) => s.length > 0).pop();
    return last !== undefined && last.length > 0 ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

export interface PageReaderOptions {
  /** 真实抓取端口；null/undefined ⇒ 读取一律返回 not-ready。 */
  readonly fetch: HttpFetchPort | null | undefined;
  readonly clock: ClockPort;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** 获准链接的域名白名单；提供则非白名单域名返回 not-allowed（不发起抓取）。 */
  readonly allowedHosts?: readonly string[];
}

export interface PageReader {
  readonly ready: boolean;
  read(url: string): Promise<PageFetchOutcome>;
  /** 上次成功抓取的指纹（用于外部核对"变化"）。 */
  lastFingerprint(url: string): PageFingerprint | null;
}

/** 绝对化跳转目标（相对 Location 按当前 URL 解析）。 */
function resolveLocation(currentUrl: string, location: string): string {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return location;
  }
}

export function createPageReader(options: PageReaderOptions): PageReader {
  const port = options.fetch ?? null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowedHosts = options.allowedHosts?.map((h) => h.toLowerCase());
  const fingerprints = new Map<string, PageFingerprint>();

  const notReady = (): PageFetchOutcome => ({
    status: 'not-ready',
    reason: NO_FETCH_PORT_REASON,
    unlock: NO_FETCH_PORT_UNLOCK,
  });

  return {
    ready: port !== null,

    lastFingerprint(url: string): PageFingerprint | null {
      return fingerprints.get(url) ?? null;
    },

    async read(url: string): Promise<PageFetchOutcome> {
      if (port === null) {
        return notReady();
      }

      const host = hostOf(url);
      if (allowedHosts !== undefined && !allowedHosts.includes(host)) {
        return {
          status: 'not-allowed',
          url,
          host,
          reason: `域名 ${host} 不在获准链接白名单内，拒绝抓取`,
        };
      }

      const chain: string[] = [url];
      let current = url;
      let response: FetchResponse | undefined;

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        try {
          response = await port.get(current, { timeoutMs, maxRedirects });
        } catch (error) {
          const err = error as Error;
          if (err.name === 'TimeoutError') {
            return {
              status: 'timeout',
              url: current,
              timeoutMs,
              reason: `抓取超时（${timeoutMs} ms）：${err.message}`,
            };
          }
          return { status: 'unreachable', url: current, reason: `无法访问：${err.message}` };
        }

        // 304 Not Modified 是 3xx 但**不是跳转**：必须走缓存判定，不能被当成缺 Location 的跳转。
        const isRedirect = response.status >= 300 && response.status < 400 && response.status !== 304;
        if (!isRedirect) {
          break;
        }
        const location = response.location ?? null;
        if (location === null || location.length === 0) {
          return {
            status: 'inaccessible',
            url: current,
            httpStatus: response.status,
            reason: `收到 ${response.status} 跳转但缺少 Location`,
          };
        }
        if (hop === maxRedirects) {
          return {
            status: 'too-many-redirects',
            chain,
            reason: `跳转超过上限 ${maxRedirects} 次`,
          };
        }
        current = resolveLocation(current, location);
        chain.push(current);
      }

      if (response === undefined) {
        // 结构上不可达（循环至少执行一次），但保持类型与运行期一致。
        return { status: 'unreachable', url, reason: '抓取未产生任何响应' };
      }

      if (response.status >= 400) {
        return {
          status: 'inaccessible',
          url: response.url,
          httpStatus: response.status,
          reason: `HTTP ${response.status}：页面不可访问`,
        };
      }

      if (response.status === 304) {
        const previous = fingerprints.get(url) ?? null;
        if (previous === null) {
          return {
            status: 'inaccessible',
            url: response.url,
            httpStatus: 304,
            reason: '收到 304 Not Modified，但本地没有该 URL 的抓取记录',
          };
        }
        return {
          status: 'ok',
          source: {
            title: '', // 304 无正文；标题沿用本地上次记录（由调用方从缓存取）
            originalUrl: url,
            finalUrl: response.url,
            fetchedAt: options.clock.now(),
            sourceIdentity: hostOf(response.url),
            contentType: baseType(response.contentType ?? null),
            byteLength: 0,
            contentHash: previous.contentHash,
            etag: response.etag ?? previous.etag,
            lastModified: response.lastModified ?? previous.lastModified,
          },
          text: '',
          changed: false,
          notModified: true,
          redirects: chain,
        };
      }

      const contentType = baseType(response.contentType ?? null);
      if (!TEXTUAL_TYPES.includes(contentType)) {
        return {
          status: 'unsupported-content',
          url: response.url,
          contentType,
          reason: `内容类型 ${contentType} 非文本页面，本模块不解析（图片/二进制等）`,
        };
      }

      const body = response.body;
      const rawText = decodeUtf8(body);
      const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
      const text = isHtml ? htmlToText(rawText) : rawText.trim();
      const title = (isHtml ? extractHtmlTitle(rawText) : null) ?? titleFromUrl(response.url);
      const contentHash = contentHashOf(body);
      const fetchedAt = options.clock.now();
      const etag = response.etag ?? null;
      const lastModified = response.lastModified ?? null;

      const previous = fingerprints.get(url) ?? null;
      const changed =
        previous === null ||
        previous.contentHash !== contentHash ||
        (etag !== null && previous.etag !== null && etag !== previous.etag) ||
        (lastModified !== null &&
          previous.lastModified !== null &&
          lastModified !== previous.lastModified);

      const source: PageSource = {
        title,
        originalUrl: url,
        finalUrl: response.url,
        fetchedAt,
        sourceIdentity: hostOf(response.url),
        contentType,
        byteLength: body.byteLength,
        contentHash,
        etag,
        lastModified,
      };

      fingerprints.set(url, {
        url,
        contentHash,
        etag,
        lastModified,
        fetchedAt,
      });

      return { status: 'ok', source, text, changed, notModified: false, redirects: chain };
    },
  };
}
