/**
 * RES-06 时效缓存 —— 定向套件。
 * 反向对照：外部内容**缺来源** ⇒ 拒绝入缓存（不静默写入）；新鲜条目 ⇒ **不触发**刷新；
 * 刷新失败 ⇒ 保留旧值、不丢缓存。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkAttribution,
  expiresAtOf,
  FreshnessCache,
  type CacheEntry,
  type SourceRef,
} from './cache.js';

function clockAt(start: number): { now: () => number; set: (t: number) => void } {
  let current = start;
  return { now: () => current, set: (t: number) => { current = t; } };
}

const source: SourceRef = {
  sourceId: 'src-1',
  url: 'https://example.com/a',
  title: '页面 A',
  fetchedAt: 100,
};

describe('checkAttribution：缓存不丢来源', () => {
  it('外部内容缺来源 ⇒ 给原因；私密内容可无来源', () => {
    expect(checkAttribution({ key: 'k', kind: 'external', value: 'v' })).toContain('来源');
    expect(checkAttribution({ key: 'k', kind: 'private', value: 'v' })).toBeNull();
    expect(checkAttribution({ key: 'k', kind: 'external', value: 'v', source })).toBeNull();
  });

  it('来源缺 sourceId / 获取时间 ⇒ 拒绝；摘要指向不一致 ⇒ 拒绝', () => {
    expect(
      checkAttribution({ key: 'k', kind: 'external', value: 'v', source: { ...source, sourceId: '' } }),
    ).toContain('sourceId');
    expect(
      checkAttribution({ key: 'k', kind: 'external', value: 'v', source: { ...source, fetchedAt: 0 } }),
    ).toContain('获取时间');
    expect(
      checkAttribution({
        key: 'k',
        kind: 'external',
        value: 'v',
        source,
        summaryOfSourceId: 'other',
      }),
    ).toContain('不一致');
  });
});

describe('FreshnessCache：时效与来源', () => {
  it('外部内容缺来源 ⇒ put 被拒且**不写入**（反向对照）', () => {
    const cache = new FreshnessCache<string>({ now: () => 0 });
    const result = cache.put({ key: 'k', kind: 'external', value: 'v' });
    expect(result.ok).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.get('k').status).toBe('missing');
  });

  it('对照（正向）：带来源写入 ⇒ fresh，且来源可审计', () => {
    const clk = clockAt(1000);
    const cache = new FreshnessCache<string>({ now: clk.now });
    const put = cache.put({ key: 'k', kind: 'external', value: '正文', rule: { ttlMs: 1000 }, source });
    expect(put.ok).toBe(true);

    const view = cache.get('k');
    expect(view.status).toBe('fresh');
    if (view.status === 'fresh') {
      expect(view.entry.source).toEqual(source);
      expect(view.expiresAt).toBe(2000);
      expect(view.needsRefresh).toBe(false);
    }
    expect(cache.list()[0]?.source?.url).toBe('https://example.com/a');
  });

  it('过时 ⇒ stale；getOrRefresh 主动刷新并**保留来源**', async () => {
    const clk = clockAt(1000);
    const cache = new FreshnessCache<string>({ now: clk.now });
    cache.put({ key: 'k', kind: 'external', value: '旧', rule: { ttlMs: 100 }, source });

    clk.set(1200);
    expect(cache.get('k').status).toBe('stale');

    const refresher = vi.fn(async (previous: CacheEntry<string> | null) => ({
      value: `新-${previous?.value ?? ''}`,
      source,
    }));
    const outcome = await cache.getOrRefresh('k', refresher);

    expect(outcome.status).toBe('refreshed');
    expect(refresher).toHaveBeenCalledTimes(1);
    if (outcome.status === 'refreshed') {
      expect(outcome.entry.value).toBe('新-旧');
      expect(outcome.entry.source).toEqual(source);
    }
  });

  it('反向对照：**新鲜**条目 getOrRefresh 不调用刷新器', async () => {
    const cache = new FreshnessCache<string>({ now: () => 1000 });
    cache.put({ key: 'k', kind: 'external', value: 'v', rule: { ttlMs: 10_000 }, source });
    const refresher = vi.fn(async () => ({ value: 'x', source }));
    const outcome = await cache.getOrRefresh('k', refresher);
    expect(outcome.status).toBe('fresh');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('临期窗口（refreshBeforeMs）内 ⇒ fresh 但 needsRefresh=true', () => {
    const clk = clockAt(1000);
    const cache = new FreshnessCache<string>({ now: clk.now });
    cache.put({ key: 'k', kind: 'private', value: 'v', rule: { ttlMs: 1000, refreshBeforeMs: 300 } });

    clk.set(1000 + 750); // 距失效 250ms < 300ms
    const view = cache.get('k');
    expect(view.status).toBe('fresh');
    if (view.status === 'fresh') {
      expect(view.needsRefresh).toBe(true);
    }
  });

  it('反向对照：刷新失败 ⇒ refresh-failed，旧值保留、缓存不丢', async () => {
    const clk = clockAt(0);
    const cache = new FreshnessCache<string>({ now: clk.now });
    cache.put({ key: 'k', kind: 'external', value: '旧', rule: { ttlMs: 10 }, source });
    clk.set(100);

    const outcome = await cache.getOrRefresh('k', async () => {
      throw new Error('网络不可达');
    });
    expect(outcome.status).toBe('refresh-failed');
    if (outcome.status === 'refresh-failed') {
      expect(outcome.previous?.value).toBe('旧');
      expect(outcome.reason).toContain('网络不可达');
    }
    expect(cache.raw('k')?.value).toBe('旧');
  });

  it('对照：刷新不带来源时**沿用**旧来源（外部内容不丢来源）', async () => {
    const clk = clockAt(0);
    const cache2 = new FreshnessCache<string>({ now: clk.now });
    // 关键：先有一条带来源的外部条目，过期后刷新却不给来源 —— 应沿用旧来源（不丢来源）。
    cache2.put({ key: 'k', kind: 'external', value: '旧', rule: { ttlMs: 10 }, source });
    clk.set(100);
    const outcome = await cache2.getOrRefresh('k', async () => ({ value: '新' }));
    expect(outcome.status).toBe('refreshed');
    if (outcome.status === 'refreshed') {
      expect(outcome.entry.source).toEqual(source); // 来源沿用，未丢失
    }
  });

  it('失效联动：invalidateBySource 移除该来源的下载内容与摘要', () => {
    const cache = new FreshnessCache<string>({ now: () => 0 });
    cache.put({ key: 'download', kind: 'external', value: 'd', source });
    cache.put({
      key: 'summary',
      kind: 'external',
      value: 's',
      source: { ...source, sourceId: 'src-sum' },
      summaryOfSourceId: 'src-sum',
    });
    cache.put({ key: 'other', kind: 'private', value: 'p' });

    const removed = cache.invalidateBySource('src-1');
    expect(removed).toEqual(['download']);
    expect(cache.get('download').status).toBe('missing');
    expect(cache.get('summary').status).toBe('fresh');
    expect(cache.get('other').status).toBe('fresh');
  });

  it('expiresAtOf：ttl 与绝对失效取更早者', () => {
    const clk = clockAt(500);
    const cache = new FreshnessCache<string>({ now: clk.now });
    cache.put({ key: 'k', kind: 'private', value: 'v', rule: { ttlMs: 10_000, expiresAt: 800 } });
    const entry = cache.raw('k');
    expect(entry).not.toBeNull();
    if (entry !== null) {
      expect(expiresAtOf(entry)).toBe(800);
    }
  });
});
