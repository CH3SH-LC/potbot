/**
 * RES-01 查询端口 —— 定向套件。
 * 每条正向能力都有**反向对照**（未装配 ⇒ 未就绪且**没有结果字段**；伪端口 ⇒ 拒绝且不被调用）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createQueryGateway,
  isRealNetworkPort,
  NO_PORT_REASON,
  PSEUDO_PORT_REASON,
  type QueryPort,
  type RawResult,
} from './query-port.js';

function realPort(results: readonly RawResult[]): QueryPort {
  return {
    id: 'test-port',
    kind: 'network',
    search: vi.fn(async () => results),
  };
}

const sample: RawResult = {
  url: 'https://example.com/a',
  title: '示例',
  snippet: '示例片段',
  site: 'example.com',
  publishedAt: '2026-01-01',
};

describe('RES-01 查询网关：端口未装配 ⇒ 结构化未就绪', () => {
  it('无端口：返回 not-ready，带原因与解锁条件，且**不含** results 字段', async () => {
    const gateway = createQueryGateway(undefined);
    const outcome = await gateway.search({ query: '安卓 任务式智能体', mode: 'natural-language' });

    expect(outcome.status).toBe('not-ready');
    // 未就绪状态下**不存在** results —— 从结构上杜绝"编造命中"。
    expect('results' in outcome).toBe(false);
    if (outcome.status === 'not-ready') {
      expect(outcome.reason).toBe(NO_PORT_REASON);
      expect(outcome.unlock.length).toBeGreaterThan(0);
      expect(outcome.fromModelKnowledge).toBe(false);
    }
    expect(gateway.ready).toBe(false);
    expect(gateway.readiness().ready).toBe(false);
  });

  it('反向对照：伪端口（kind !== network，疑似模型已有知识冒充）被视为未就绪，且 search **绝不被调用**', async () => {
    const spy = vi.fn(async () => [sample]);
    const pseudo = { id: 'model-router-8008', kind: 'model-memory', search: spy } as unknown as QueryPort;

    expect(isRealNetworkPort(pseudo)).toBe(false);

    const gateway = createQueryGateway(pseudo);
    const outcome = await gateway.search({ query: 'anything', mode: 'keyword' });

    expect(outcome.status).toBe('not-ready');
    expect('results' in outcome).toBe(false);
    if (outcome.status === 'not-ready') {
      expect(outcome.reason).toBe(PSEUDO_PORT_REASON);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(gateway.readiness().reason).toBe(PSEUDO_PORT_REASON);
  });

  it('对照（防假绿）：真实网络端口 ⇒ 命中原样透传，且标记 fromModelKnowledge=false', async () => {
    const gateway = createQueryGateway(realPort([sample]));
    const outcome = await gateway.search({ query: '示例', mode: 'keyword' });

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.portId).toBe('test-port');
      expect(outcome.results).toEqual([sample]);
      expect(outcome.fromModelKnowledge).toBe(false);
    }
    expect(gateway.readiness()).toEqual({ ready: true, portId: 'test-port', reason: null, unlock: [] });
  });

  it('端口返回空数组 ⇒ ok（真实检索"查无结果"不是未就绪）', async () => {
    const gateway = createQueryGateway(realPort([]));
    const outcome = await gateway.search({ query: 'x', mode: 'keyword' });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results).toEqual([]);
    }
  });
});

describe('RES-01 查询网关：失败一律结构化，绝不抛错 / 绝不 500', () => {
  it('端口抛错 ⇒ failed（不是 throw）', async () => {
    const port: QueryPort = {
      id: 'boom',
      kind: 'network',
      search: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    const outcome = await createQueryGateway(port).search({ query: 'x', mode: 'keyword' });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('connection reset');
      expect(outcome.portId).toBe('boom');
    }
  });

  it('端口返回违约结果（无地址）⇒ failed，不把违约结果当作命中', async () => {
    const bad = [{ url: '', title: 't', snippet: 's', site: null, publishedAt: null }] as RawResult[];
    const outcome = await createQueryGateway(realPort(bad)).search({ query: 'x', mode: 'keyword' });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('无地址');
    }
  });

  it('空查询 ⇒ failed（且不调用端口）', async () => {
    const port = realPort([sample]);
    const outcome = await createQueryGateway(port).search({ query: '   ', mode: 'keyword' });
    expect(outcome.status).toBe('failed');
    expect(port.search).not.toHaveBeenCalled();
  });

  it('范围约束：limit 生效，站点/时效约束原样随请求下传', async () => {
    const port = realPort([sample, { ...sample, url: 'https://example.com/b' }]);
    const gateway = createQueryGateway(port);
    const outcome = await gateway.search({
      query: '示例',
      mode: 'natural-language',
      constraints: {
        limit: 1,
        sites: ['example.com'],
        timeframe: { freshnessDays: 7 },
        scope: 'web',
        language: 'zh',
      },
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results).toHaveLength(1);
    }
    expect(port.search).toHaveBeenCalledWith({
      query: '示例',
      mode: 'natural-language',
      constraints: {
        limit: 1,
        sites: ['example.com'],
        timeframe: { freshnessDays: 7 },
        scope: 'web',
        language: 'zh',
      },
    });
  });
});
