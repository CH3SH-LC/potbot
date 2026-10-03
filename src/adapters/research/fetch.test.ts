/**
 * RES-02 页面抓取 —— 定向套件。
 * 覆盖：跳转链、不可访问、超时、内容变化、获准链接白名单、未就绪。
 * 反向对照：无端口 ⇒ 永不产生 ok；未获准域名 ⇒ 端口**不被调用**；超时说成超时、不当空正文。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  contentHashOf,
  createPageReader,
  extractHtmlTitle,
  hostOf,
  htmlToText,
  NO_FETCH_PORT_REASON,
  type FetchOptions,
  type FetchResponse,
  type HttpFetchPort,
} from './fetch.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function resp(partial: Partial<FetchResponse> & { status: number; url: string }): FetchResponse {
  return {
    location: null,
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    body: new Uint8Array(),
    ...partial,
  };
}

function portOf(
  handler: (url: string, options: FetchOptions) => Promise<FetchResponse> | FetchResponse,
): HttpFetchPort {
  return { id: 'fake-fetch', get: vi.fn(async (url: string, options: FetchOptions) => handler(url, options)) };
}

describe('RES-02 纯函数：正文与标题抽取', () => {
  it('htmlToText 剥离脚本/样式/标签并保留可读正文', () => {
    const html =
      '<html><head><title>标题 A</title><style>.x{color:red}</style></head>' +
      '<body><h1>问候</h1><script>alert(1)</script><p>第一段&nbsp;文字</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('问候');
    expect(text).toContain('第一段 文字');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('extractHtmlTitle 取标题；无标题返回 null', () => {
    expect(extractHtmlTitle('<title> 真实 标题 </title>')).toBe('真实 标题');
    expect(extractHtmlTitle('<p>没有标题</p>')).toBeNull();
  });

  it('hostOf / contentHashOf 稳定且可辨', () => {
    expect(hostOf('https://EXAMPLE.com/x')).toBe('example.com');
    expect(hostOf('不是 url')).toBe('(unknown-host)');
    expect(contentHashOf(enc('a'))).toBe(contentHashOf(enc('a')));
    expect(contentHashOf(enc('a'))).not.toBe(contentHashOf(enc('b')));
  });
});

describe('RES-02：端口未装配 ⇒ 未就绪（不产生 ok）', () => {
  it('无端口：read 返回 not-ready 且带原因/解锁条件', async () => {
    const reader = createPageReader({ fetch: null, clock: { now: () => 1000 } });
    const outcome = await reader.read('https://example.com/');
    expect(outcome.status).toBe('not-ready');
    if (outcome.status === 'not-ready') {
      expect(outcome.reason).toBe(NO_FETCH_PORT_REASON);
      expect(outcome.unlock.length).toBeGreaterThan(0);
    }
    expect(reader.ready).toBe(false);
  });
});

describe('RES-02：跳转 / 不可访问 / 超时', () => {
  it('跟随跳转链并记录原地址与最终地址', async () => {
    const port = portOf((url) => {
      if (url.endsWith('/a')) return resp({ status: 302, url, location: '/b' });
      if (url.endsWith('/b')) return resp({ status: 301, url, location: 'https://example.com/c' });
      return resp({
        status: 200,
        url,
        body: enc('<html><title>最终页</title><body>你好 世界</body></html>'),
      });
    });
    const reader = createPageReader({ fetch: port, clock: { now: () => 42 } });
    const outcome = await reader.read('https://example.com/a');

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.source.originalUrl).toBe('https://example.com/a');
      expect(outcome.source.finalUrl).toBe('https://example.com/c');
      expect(outcome.source.sourceIdentity).toBe('example.com');
      expect(outcome.source.fetchedAt).toBe(42);
      expect(outcome.source.title).toBe('最终页');
      expect(outcome.text).toContain('你好 世界');
      expect(outcome.redirects).toEqual([
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
      ]);
      expect(outcome.changed).toBe(true);
    }
  });

  it('跳转超过上限 ⇒ too-many-redirects（不无限跟）', async () => {
    const port = portOf((url) => resp({ status: 302, url, location: `${url}x` }));
    const reader = createPageReader({ fetch: port, clock: { now: () => 0 }, maxRedirects: 2 });
    const outcome = await reader.read('https://example.com/');
    expect(outcome.status).toBe('too-many-redirects');
    if (outcome.status === 'too-many-redirects') {
      expect(outcome.chain.length).toBe(3);
    }
  });

  it('4xx/5xx ⇒ inaccessible，带 HTTP 状态（不当空正文）', async () => {
    const port = portOf((url) => resp({ status: 503, url, body: enc('down') }));
    const outcome = await createPageReader({ fetch: port, clock: { now: () => 0 } }).read(
      'https://example.com/',
    );
    expect(outcome.status).toBe('inaccessible');
    if (outcome.status === 'inaccessible') {
      expect(outcome.httpStatus).toBe(503);
      expect(outcome.reason).toContain('503');
    }
  });

  it('端口超时 ⇒ timeout（不重试到假成功）', async () => {
    const port = portOf(() => {
      const err = new Error('took too long');
      err.name = 'TimeoutError';
      throw err;
    });
    const outcome = await createPageReader({
      fetch: port,
      clock: { now: () => 0 },
      timeoutMs: 1234,
    }).read('https://example.com/');
    expect(outcome.status).toBe('timeout');
    if (outcome.status === 'timeout') {
      expect(outcome.timeoutMs).toBe(1234);
    }
  });

  it('端口普通异常 ⇒ unreachable', async () => {
    const port = portOf(() => {
      throw new Error('ENOTFOUND');
    });
    const outcome = await createPageReader({ fetch: port, clock: { now: () => 0 } }).read(
      'https://nope.example/',
    );
    expect(outcome.status).toBe('unreachable');
  });

  it('非文本内容类型 ⇒ unsupported-content（不把二进制当正文）', async () => {
    const port = portOf((url) => resp({ status: 200, url, contentType: 'image/png', body: enc('') }));
    const outcome = await createPageReader({ fetch: port, clock: { now: () => 0 } }).read(
      'https://example.com/p.png',
    );
    expect(outcome.status).toBe('unsupported-content');
  });
});

describe('RES-02：内容变化检测与 304', () => {
  it('两次抓取同内容 ⇒ changed=false；内容变 ⇒ changed=true；内容摘要可外部核对', async () => {
    let body = enc('<html><title>t</title><body>版本一</body></html>');
    const port = portOf((url) => resp({ status: 200, url, body }));
    const reader = createPageReader({ fetch: port, clock: { now: () => 7 } });

    const first = await reader.read('https://example.com/');
    expect(first.status === 'ok' && first.changed).toBe(true);

    const second = await reader.read('https://example.com/');
    expect(second.status === 'ok' && second.changed).toBe(false);
    if (second.status === 'ok') {
      expect(second.source.contentHash).toBe(contentHashOf(body));
      expect(reader.lastFingerprint('https://example.com/')?.contentHash).toBe(
        contentHashOf(body),
      );
    }

    body = enc('<html><title>t</title><body>版本二</body></html>');
    const third = await reader.read('https://example.com/');
    expect(third.status === 'ok' && third.changed).toBe(true);
  });

  it('304 Not Modified（有本地记录）⇒ notModified=true 且不丢来源', async () => {
    let calls = 0;
    const port = portOf((url) => {
      calls += 1;
      if (calls === 1) {
        return resp({ status: 200, url, body: enc('<title>t</title>正文'), etag: 'v1' });
      }
      return resp({ status: 304, url, etag: 'v1' });
    });
    const reader = createPageReader({ fetch: port, clock: { now: () => 99 } });
    await reader.read('https://example.com/');
    const outcome = await reader.read('https://example.com/');

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.notModified).toBe(true);
      expect(outcome.changed).toBe(false);
      expect(outcome.text).toBe('');
      expect(outcome.source.originalUrl).toBe('https://example.com/');
      expect(outcome.source.sourceIdentity).toBe('example.com');
    }
  });

  it('反向对照：304 但本地无记录 ⇒ inaccessible（不当成"没变化"放行）', async () => {
    const port = portOf((url) => resp({ status: 304, url }));
    const outcome = await createPageReader({ fetch: port, clock: { now: () => 0 } }).read(
      'https://example.com/',
    );
    expect(outcome.status).toBe('inaccessible');
  });
});

describe('RES-02：获准链接白名单', () => {
  it('未获准域名 ⇒ not-allowed，且端口**不被调用**', async () => {
    const port = portOf((url) => resp({ status: 200, url, body: enc('x') }));
    const reader = createPageReader({
      fetch: port,
      clock: { now: () => 0 },
      allowedHosts: ['example.com'],
    });
    const outcome = await reader.read('https://evil.test/secret');
    expect(outcome.status).toBe('not-allowed');
    if (outcome.status === 'not-allowed') {
      expect(outcome.host).toBe('evil.test');
    }
    expect(port.get).not.toHaveBeenCalled();
  });

  it('对照：获准域名 ⇒ 正常抓取', async () => {
    const port = portOf((url) => resp({ status: 200, url, body: enc('<title>ok</title>正文') }));
    const reader = createPageReader({
      fetch: port,
      clock: { now: () => 0 },
      allowedHosts: ['example.com'],
    });
    const outcome = await reader.read('https://example.com/');
    expect(outcome.status).toBe('ok');
    expect(port.get).toHaveBeenCalledTimes(1);
  });
});
