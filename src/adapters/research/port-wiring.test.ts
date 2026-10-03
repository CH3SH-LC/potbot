/**
 * RES-01 / RES-02 接线面 —— 定向套件。
 *
 * 反向对照（任务书要求，逐条）：
 * - **缺端口 ⇒ 只是"该段未就绪"，不是整体失败**：无端口 / 伪端口 / 只缺一个端口都不抛错、不 500；
 * - **某段失败必须能定位到那一段**：查询段失败 / 抓取段全败 / 解析段全败，`failedStage` 各指其段；
 * - **取消后不得继续抓取**：抓取桩在第一次返回前把信号置位 ⇒ 桩只被调用一次；
 * - **断网/超时/过期缓存走六态**：无查询端口 ⇒ `offline`；单页超时 ⇒ 记为不可读来源；
 *   宿主观测 `servingStaleCache` ⇒ `stale-cache`（口径来自 `failure-modes`，不另造）。
 *
 * 端口全部为**测试桩**：本机**无真实联网端口**，故"真实联网检索"在产品运行链上**未实测，
 * 标未验证**；本套件只证明接线与归因结构正确。
 *
 * 【模型身份】交付说明：本套件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FetchResponse, HttpFetchPort } from './fetch.js';
import { createFixedClock } from './ports.js';
import { createResearchFacade, type CancelSignal } from './port-wiring.js';
import type { QueryPort, RawResult } from './query-port.js';

const clock = createFixedClock(1_700_000_000_000);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const SAMPLE: RawResult = {
  url: 'https://example.com/budget',
  title: '预算页',
  snippet: '季度预算',
  site: 'example.com',
  publishedAt: '2026-01-01',
};

function queryPort(results: readonly RawResult[]): QueryPort {
  return { id: 'stub-query', kind: 'network', search: vi.fn(async () => results) };
}

function htmlResponse(url: string, title: string, body: string): FetchResponse {
  const html = `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
  return { status: 200, url, contentType: 'text/html', body: enc(html) };
}

function fetchPort(handler: (url: string) => Promise<FetchResponse>): HttpFetchPort {
  return { id: 'stub-fetch', get: vi.fn(handler) };
}

const BODY = '第一季度 预算 1200 元';

describe('缺端口 ⇒ 该段结构化未就绪（不是整体失败）', () => {
  it('无任何端口：查询段未就绪，不抛错、不 500，且没有任何编造命中', async () => {
    const facade = createResearchFacade({ clock });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.status).toBe('not-ready');
    expect(result.failedStage).toBe('query');
    expect(result.stages.find((s) => s.stage === 'query')?.status).toBe('not-ready');
    expect(result.stages.find((s) => s.stage === 'query')?.unlock.length).toBeGreaterThan(0);
    // 未就绪 ⇒ 没有任何查询结果，更不存在编造命中。
    expect(result.queryResults).toEqual([]);
    expect(result.composed).toBeNull();
    expect(facade.readiness().query.ready).toBe(false);
    expect(facade.readiness().chainReady).toBe(false);
  });

  it('反向对照：只缺抓取端口 ⇒ 只有抓取段未就绪，查询结果作为部分结果照常返回', async () => {
    const facade = createResearchFacade({ clock, queryPort: queryPort([SAMPLE]) });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.status).toBe('not-ready');
    expect(result.failedStage).toBe('fetch');
    expect(result.stages.find((s) => s.stage === 'query')?.status).toBe('ok');
    expect(result.stages.find((s) => s.stage === 'fetch')?.status).toBe('not-ready');
    expect(result.queryResults).toEqual([SAMPLE]);
    expect(result.pages).toEqual([]);
    expect(facade.readiness().fetch.ready).toBe(false);
    expect(facade.readiness().query.ready).toBe(true);
    expect(facade.readiness().chainReady).toBe(false);
  });

  it('缺 OCR 端口：只登记 OCR 子能力未就绪，不阻断纯文本链', async () => {
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort([SAMPLE]),
      fetchPort: fetchPort(async (url) => htmlResponse(url, '预算页', BODY)),
    });
    const readiness = facade.readiness();
    expect(readiness.ocr.installed).toBe(false);
    // 接口写好也不宣称已接通：未实测 ⇒ verified_supported 恒为 false。
    expect(readiness.ocr.verified_supported).toBe(false);
    expect(readiness.ocr.reason).toContain('OCR');
    expect(readiness.chainReady).toBe(true);

    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });
    expect(result.status).toBe('ok');
  });
});

describe('端到端链：查询 → 抓取 → 解析 → 建索引 → 检索 → 合成答案', () => {
  it('正向：六段全 ok，正文含索引内容，引用可回读，六态为 success', async () => {
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort([SAMPLE]),
      fetchPort: fetchPort(async (url) => htmlResponse(url, '预算页', BODY)),
    });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.status).toBe('ok');
    expect(result.failedStage).toBeNull();
    expect(result.partial).toBe(false);
    for (const stage of result.stages) {
      expect(stage.status).toBe('ok');
    }
    expect(result.classification.mode).toBe('success');
    expect(result.classification.ok).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.composed).not.toBeNull();
    expect(result.composed?.prose).toContain('预算');
    // 每句事实可回读到原始字节。
    expect(result.readback?.ok).toBe(true);
  });
});

describe('分段归因：某段失败必须能定位到那一段', () => {
  it('查询段失败（端口抛错）⇒ failedStage=query，不抛错', async () => {
    const boom: QueryPort = {
      id: 'boom',
      kind: 'network',
      search: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    const facade = createResearchFacade({ clock, queryPort: boom });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.status).toBe('failed');
    expect(result.failedStage).toBe('query');
    expect(result.stages.find((s) => s.stage === 'query')?.reason).toContain('connection reset');
    expect(result.classification.mode).toBe('offline');
  });

  it('抓取段全败 ⇒ failedStage=fetch（查询结果仍在），并在六态里记为不可读来源', async () => {
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort([SAMPLE]),
      fetchPort: fetchPort(async () => {
        throw new Error('DNS 解析失败');
      }),
    });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.failedStage).toBe('fetch');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.status).toBe('unreachable');
    expect(result.classification.mode).toBe('unreadable-file');
  });

  it('解析段全败（抓到的正文为空）⇒ failedStage=parse', async () => {
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort([SAMPLE]),
      // 返回一个**无正文**的文本页：解析段必须据此判失败，而不是拿文件名/标题充当内容。
      fetchPort: fetchPort(async (url) => ({
        status: 200,
        url,
        contentType: 'text/html',
        body: new Uint8Array(0),
      })),
    });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.failedStage).toBe('parse');
    expect(result.stages.find((s) => s.stage === 'parse')?.status).toBe('failed');
    // 链继续到合成段时只给"未找到"的 unknown，绝不拿标题/文件名冒充事实。
    expect(result.composed?.isEmpty).toBe(true);
    expect(result.composed?.sentences[0]?.kind).toBe('unknown');
    expect(result.composed?.sentences[0]?.citations).toEqual([]);
  });
});

describe('取消与限额：整链可取消、可限额，部分结果如实返回', () => {
  it('反向对照（取消后不得继续抓取）：抓取桩在首次返回前置位信号 ⇒ 桩只被调用一次', async () => {
    const signal: { aborted: boolean } = { aborted: false };
    const get = vi.fn(async (url: string) => {
      signal.aborted = true; // 第一次抓取尚未返回，用户已取消
      return htmlResponse(url, '预算页', BODY);
    });
    const targets: RawResult[] = [
      { ...SAMPLE, url: 'https://example.com/1' },
      { ...SAMPLE, url: 'https://example.com/2' },
      { ...SAMPLE, url: 'https://example.com/3' },
    ];
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort(targets),
      fetchPort: { id: 'stub-fetch', get },
    });

    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' }, {
      signal: signal as CancelSignal,
    });

    expect(get).toHaveBeenCalledTimes(1); // 绝不继续抓取
    expect(result.cancelled).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.partial).toBe(true);
    expect(result.pages).toHaveLength(1);
    expect(result.failedStage).toBe('fetch');
  });

  it('限额：maxResults 收缩抓取条数（不取消，只抓前 N 条）', async () => {
    const get = vi.fn(async (url: string) => htmlResponse(url, '预算页', BODY));
    const targets: RawResult[] = [
      { ...SAMPLE, url: 'https://example.com/1' },
      { ...SAMPLE, url: 'https://example.com/2' },
      { ...SAMPLE, url: 'https://example.com/3' },
    ];
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort(targets),
      fetchPort: { id: 'stub-fetch', get },
    });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' }, {
      limits: { maxResults: 1 },
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(false);
    expect(result.pages).toHaveLength(1);
    expect(result.status).toBe('ok');
  });
});

describe('断网 / 超时 / 过期缓存走 failure-modes 的六态口径', () => {
  it('无查询端口 ⇒ offline（端口未接通即"断网"同口径）', async () => {
    const facade = createResearchFacade({ clock, fetchPort: fetchPort(async (u) => htmlResponse(u, 't', BODY)) });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });
    expect(result.classification.mode).toBe('offline');
    expect(result.classification.ok).toBe(false);
  });

  it('单页抓取超时 ⇒ 记为不可读来源（六态 unreadable-file），超时原因保留', async () => {
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort([SAMPLE]),
      fetchPort: fetchPort(async () => {
        const err = new Error('deadline exceeded');
        err.name = 'TimeoutError';
        throw err;
      }),
    });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' });

    expect(result.pages[0]?.status).toBe('timeout');
    expect(result.pages[0]?.reason).toContain('超时');
    expect(result.classification.mode).toBe('unreadable-file');
  });

  it('宿主观测 servingStaleCache ⇒ stale-cache（口径取自 failure-modes）', async () => {
    const facade = createResearchFacade({
      clock,
      queryPort: queryPort([SAMPLE]),
      fetchPort: fetchPort(async (url) => htmlResponse(url, '预算页', BODY)),
    });
    const result = await facade.ask('task-1', { query: '预算', mode: 'keyword' }, {
      servingStaleCache: true,
    });
    expect(result.classification.mode).toBe('stale-cache');
    expect(result.classification.partial).toBe(true);
    expect(result.status).toBe('partial');
  });
});
