/**
 * MT-06 用例：获准事实**保留来源与时间**；接口未接线 ⇒ 结构化 `not-wired`，
 * **不宣称**已发布。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCandidate, type Candidate, type ExportedCandidateFact } from './candidates.js';
import {
  describeFact,
  listUnwiredTemplates,
  publishCandidateFacts,
  screenPublishableFacts,
  type FactPublicationPort,
  type PublicationResult,
} from './fact-publication.js';

const T = 1_780_000_000_000;

const CANDIDATES: readonly Candidate[] = [
  normalizeCandidate({ id: 'c1', title: '甲店', fields: { priceYuan: '120' } }, 'iface-1', T),
  normalizeCandidate({ id: 'c2', title: '乙店', fields: { priceYuan: '80' } }, 'iface-1', T),
];

describe('MT-06：未接下游模板 ⇒ 结构化 not-wired，不宣称已发布', () => {
  it('没有任何通道 ⇒ 三个模板全标 not-wired、acknowledged=false', async () => {
    const results = await publishCandidateFacts([], CANDIDATES);
    expect(results.map((result) => result.template)).toEqual(['budget', 'document', 'presentation']);
    for (const result of results) {
      expect(result.wireState).toBe('not-wired');
      expect(result.acknowledged).toBe(false);
      expect(result.factCount).toBe(0);
      expect(result.reason).toMatch(/未接该模板/);
      expect(result.claimed_published).toBe(false);
    }
    expect(listUnwiredTemplates(results)).toEqual(['budget', 'document', 'presentation']);
  });

  it('只接了预算 ⇒ 只有预算 not-wired 之外的状态，其余仍 not-wired', async () => {
    const budget: FactPublicationPort = {
      template: 'budget',
      publish: () => Promise.resolve({ ok: true, receiptRef: 'rcpt-1' }),
    };
    const results = await publishCandidateFacts([budget], CANDIDATES);
    const byTemplate = new Map(results.map((result) => [result.template, result]));
    expect(byTemplate.get('budget')?.wireState).toBe('published');
    expect(byTemplate.get('budget')?.acknowledged).toBe(true);
    expect(byTemplate.get('document')?.wireState).toBe('not-wired');
    expect(byTemplate.get('presentation')?.wireState).toBe('not-wired');
  });

  it('claimed_published 恒为字面量 false（类型层）', () => {
    type MustBeFalse<T extends false> = T;
    const literalCheck: MustBeFalse<PublicationResult['claimed_published']> = false;
    expect(literalCheck).toBe(false);
  });
});

describe('MT-06：保留来源与时间，不让下游另猜价格', () => {
  it('发布给通道的事实逐条带 sourceRef 与 observedAtMs', async () => {
    let seen: readonly ExportedCandidateFact[] = [];
    const document: FactPublicationPort = {
      template: 'document',
      publish: (facts) => {
        seen = facts;
        return Promise.resolve({ ok: true, receiptRef: 'rcpt-doc' });
      },
    };
    await publishCandidateFacts([document], CANDIDATES);
    expect(seen.map((fact) => fact.key)).toEqual(['candidate:c1:priceYuan', 'candidate:c2:priceYuan']);
    for (const fact of seen) {
      expect(fact.sourceRef).toBe('iface-1');
      expect(fact.observedAtMs).toBe(T);
      expect(fact.kind).toBe('fact');
      expect(describeFact(fact)).toMatch(/来源：在线来源\/iface-1/);
      expect(describeFact(fact)).toMatch(/观测于/);
    }
  });

  it('未知价格不导出（不给下游一个可能被当成 0 的空价）', async () => {
    const noPriceCandidates: readonly Candidate[] = [
      { ...(CANDIDATES[0] as Candidate), id: 'x', price: { known: false, reason: '接口未给出价格' } },
    ];
    const document: FactPublicationPort = {
      template: 'document',
      publish: () => Promise.resolve({ ok: true, receiptRef: 'r' }),
    };
    const results = await publishCandidateFacts([document], noPriceCandidates);
    const doc = results.find((result) => result.template === 'document');
    expect(doc?.factCount).toBe(0);
  });
});

describe('MT-06：缺来源 / 缺时间的事实**拒绝发布**（反向对照）', () => {
  it('screenPublishableFacts 挡下不完整事实并给出理由', () => {
    const broken: readonly ExportedCandidateFact[] = [
      { key: 'k1', value: '1', sourceRef: '', sourceKind: 'authorized_interface', observedAtMs: T, kind: 'fact' },
      { key: 'k2', value: '2', sourceRef: 'iface-1', sourceKind: 'authorized_interface', observedAtMs: Number.NaN, kind: 'fact' },
    ];
    const verdict = screenPublishableFacts(broken);
    expect(verdict.publishable).toEqual([]);
    expect(verdict.notPublishable.map((entry) => entry.key)).toEqual(['k1', 'k2']);
    expect(verdict.notPublishable[0]?.reason).toMatch(/缺来源/);
    expect(verdict.notPublishable[1]?.reason).toMatch(/缺观测时间/);
  });

  it('批次里有一条不完整 ⇒ 已接通道也**拒绝整批**（不"补默认值"再发）', async () => {
    // 构造一条缺来源的候选：normalizeCandidate 会用 sourceRef 参数填来源，
    // 故此处直接伪造候选对象，模拟"上游塞进来一条不完整事实"。
    const orphan: Candidate = {
      ...(CANDIDATES[0] as Candidate),
      id: 'orphan',
      provenance: { sourceKind: 'authorized_interface', sourceRef: '', fetchedAtMs: T },
    };
    let publishCalled = false;
    const budget: FactPublicationPort = {
      template: 'budget',
      publish: () => {
        publishCalled = true;
        return Promise.resolve({ ok: true, receiptRef: 'r' });
      },
    };
    const results = await publishCandidateFacts([budget], [orphan]);
    const budgetResult = results.find((result) => result.template === 'budget');
    expect(budgetResult?.wireState).toBe('failed');
    expect(budgetResult?.acknowledged).toBe(false);
    expect(budgetResult?.reason).toMatch(/拒绝发布整批/);
    expect(publishCalled).toBe(false);
  });

  it('通道报错 ⇒ failed，不宣称已发布', async () => {
    const failing: FactPublicationPort = {
      template: 'presentation',
      publish: () => Promise.resolve({ ok: false, reason: '模板引擎未就绪' }),
    };
    const results = await publishCandidateFacts([failing], CANDIDATES);
    const presentation = results.find((result) => result.template === 'presentation');
    expect(presentation?.wireState).toBe('failed');
    expect(presentation?.acknowledged).toBe(false);
    expect(presentation?.reason).toContain('模板引擎未就绪');
    expect(presentation?.claimed_published).toBe(false);
  });

  it('通道返回**空回执** ⇒ 不算受理（acknowledged=false）', async () => {
    const hollow: FactPublicationPort = {
      template: 'budget',
      publish: () => Promise.resolve({ ok: true, receiptRef: '   ' }),
    };
    const results = await publishCandidateFacts([hollow], CANDIDATES);
    const budget = results.find((result) => result.template === 'budget');
    expect(budget?.wireState).toBe('published');
    expect(budget?.acknowledged).toBe(false);
  });
});
