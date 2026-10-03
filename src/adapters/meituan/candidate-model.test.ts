/**
 * MT-02 用例：**不编造候选** + 查询条件 / 结果范围可见。
 *
 * 本文件是"平台未登录 ⇒ 结构化未就绪、候选**恒为空**、绝不返回模型臆造的店"
 * 这条硬约束的机器化证据。
 */

import { describe, expect, it } from 'vitest';

import type { AuthorizedMeituanSearchPort, RawCandidate, SearchQuery } from './candidates.js';
import {
  buildResultScope,
  describeQueryReadiness,
  queryCandidates,
  screenCandidates,
  type CandidateQueryOutcome,
} from './candidate-model.js';
import { normalizeCandidate } from './candidates.js';

const T = 1_780_000_000_000;
const QUERY: SearchQuery = { category: '火锅', location: '徐汇区', people: 4, budgetYuan: 200 };

const RAW: readonly RawCandidate[] = [
  { id: 'c1', title: '甲店', fields: { priceYuan: '120', distanceKm: '1.5', stock: '有' } },
  { id: 'c2', title: '乙店', fields: { priceYuan: '80', distanceKm: '3' } },
];

function portOk(sourceId: string, raw: readonly RawCandidate[]): AuthorizedMeituanSearchPort {
  return { sourceId, search: () => Promise.resolve({ ok: true, raw }) };
}

describe('MT-02：平台未登录 = 真前置未就绪，候选**恒为空**', () => {
  it('没有授权搜索端口 ⇒ 结构化 not_ready，候选集为空，永不返回臆造的店', async () => {
    const outcome = await queryCandidates(null, QUERY, T);
    expect(outcome.readiness).toBe('not_ready');
    expect(outcome.ready).toBe(false);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.model_fabricated).toBe(false);
    expect(outcome.reason).toMatch(/不得.*模型知识|未登录/);
    expect(describeQueryReadiness(outcome.readiness)).toMatch(/未就绪/);
  });

  it('查询条件与**结果范围**都可见（缺哪些条件要说明）', async () => {
    const outcome = await queryCandidates(null, { category: '火锅', location: '徐汇区' }, T);
    expect(outcome.visibility.missing).toEqual(['人数', '预算', '日期', '偏好']);
    expect(outcome.visibility.note).toMatch(/不.*宣称.*全平台最优/);
    expect(outcome.scope.limitedToReturned).toBe(true);
    expect(outcome.scope.candidateCount).toBe(0);
    expect(outcome.scope.sourceIds).toEqual([]);
  });

  it('**反向对照**：接口不可用 ⇒ unavailable，也不拿模型知识顶替（候选仍为空）', async () => {
    const failing: AuthorizedMeituanSearchPort = {
      sourceId: 'iface-1',
      search: () => Promise.resolve({ ok: false, reason: '配额用尽' }),
    };
    const outcome = await queryCandidates(failing, QUERY, T);
    expect(outcome.readiness).toBe('unavailable');
    expect(outcome.candidates).toEqual([]);
    expect(outcome.reason).toContain('配额用尽');
    expect(outcome.model_fabricated).toBe(false);
  });
});

describe('MT-02：来源白名单闸 —— "看起来有来源"的臆造也拦下', () => {
  it('已核实来源 ⇒ 正常放行，范围写明来源与条数', async () => {
    const outcome = await queryCandidates(portOk('iface-1', RAW), QUERY, T);
    expect(outcome.readiness).toBe('ok');
    expect(outcome.candidates.map((candidate) => candidate.id)).toEqual(['c1', 'c2']);
    expect(outcome.scope.sourceIds).toEqual(['iface-1']);
    expect(outcome.scope.candidateCount).toBe(2);
    expect(outcome.scope.note).toMatch(/不代表全平台|不.*代表全平台/);
    expect(outcome.rejected).toEqual([]);
  });

  it('**反向对照**：端口返回的条目来源不在已核实清单 ⇒ 整批拒绝、一条不放行', async () => {
    // 端口自称来源 iface-1，却返回一条 sourceRef 指向别处的条目（模拟被污染的响应 / 装配错端口）。
    const rogue: AuthorizedMeituanSearchPort = {
      sourceId: 'iface-1',
      // 直接伪造一条"归一后可辩称有来源"的候选：故意绕过 normalizeCandidate 的来源注入。
      search: () =>
        Promise.resolve({
          ok: true,
          raw: [
            { id: 'c1', title: '甲店', fields: { priceYuan: '120' } },
            { id: 'c2', title: '乙店', fields: { priceYuan: '80' } },
          ],
        }),
    };
    // 把白名单限定成另一个来源 id：端口自带的 iface-1 被显式排除。
    const outcome = await queryCandidates(rogue, QUERY, T, ['iface-verified']);
    expect(outcome.readiness).toBe('unavailable');
    expect(outcome.candidates).toEqual([]);
    expect(outcome.rejected.map((entry) => entry.candidateId)).toEqual(['c1', 'c2']);
    expect(outcome.rejected[0]?.reason).toMatch(/不在已核实来源清单/);
    expect(outcome.model_fabricated).toBe(false);
  });

  it('**反向对照**：screenCandidates 拒收缺来源的候选（宁可不给）', () => {
    const orphan = normalizeCandidate({ id: 'x', title: '来路不明', fields: {} }, '', T);
    const screened = screenCandidates(['iface-1'], [orphan]);
    expect(screened.accepted).toEqual([]);
    expect(screened.rejected[0]?.reason).toMatch(/没有任何来源/);
  });

  it('resolve：显式登记与端口自带来源合并去重', async () => {
    const outcome = await queryCandidates(portOk('iface-1', RAW), QUERY, T, ['iface-1', 'iface-extra', '  ']);
    expect([...outcome.scope.sourceIds].sort()).toEqual(['iface-1', 'iface-extra']);
    expect(outcome.rejected).toEqual([]);
  });

  it('buildResultScope 空结果时**不**以模型知识补位', () => {
    const scope = buildResultScope([], 0, { provided: [], missing: ['品类'], note: '' });
    expect(scope.candidateCount).toBe(0);
    expect(scope.note).toMatch(/不.*以模型知识补位/);
  });

  it('出口类型上不存在"模型臆造"的返回路径（字面量 false）', async () => {
    // 类型层断言：若 model_fabricated 不是字面量 false，下面这行**编译不过**。
    type MustBeFalse<T extends false> = T;
    const literalCheck: MustBeFalse<CandidateQueryOutcome['model_fabricated']> = false;
    expect(literalCheck).toBe(false);

    const outcome = await queryCandidates(null, QUERY, T);
    expect(outcome.model_fabricated).toBe(false);
  });
});
