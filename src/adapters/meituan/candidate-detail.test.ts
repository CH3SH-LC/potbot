/**
 * MT-03 用例：未知项**分别标记**，标价**不是**最终价。
 */

import { describe, expect, it } from 'vitest';

import type { AuthorizedMeituanDetailPort, CandidateDetail, RawCandidateDetail } from './candidate-detail.js';
import {
  describePriceLabel,
  listUnknownFields,
  normalizeDetail,
  readCandidateDetail,
} from './candidate-detail.js';

const T = 1_780_000_000_000;

function portOk(sourceId: string, detail: RawCandidateDetail): AuthorizedMeituanDetailPort {
  return { sourceId, fetchDetail: () => Promise.resolve({ ok: true, detail }) };
}

describe('MT-03：未就绪时不伪造详情', () => {
  it('没有授权详情端口 ⇒ not_ready，detail 为 null', async () => {
    const result = await readCandidateDetail(null, 'c1', T);
    expect(result.status).toBe('not_ready');
    expect(result.detail).toBeNull();
    if (result.status === 'ok') return;
    expect(result.reason).toMatch(/不.*硬凑|未接通/);
  });

  it('接口失败 ⇒ unavailable，用接口给的原因，不编详情', async () => {
    const failing: AuthorizedMeituanDetailPort = {
      sourceId: 'iface-1',
      fetchDetail: () => Promise.resolve({ ok: false, reason: '无此候选' }),
    };
    const result = await readCandidateDetail(failing, 'c1', T);
    expect(result.status).toBe('unavailable');
    expect(result.detail).toBeNull();
    if (result.status === 'ok') return;
    expect(result.reason).toContain('无此候选');
  });
});

describe('MT-03：价格/库存/营业/路线未知**分别**标记', () => {
  it('缺字段 ⇒ 各自 unknown 且各带自己的原因', async () => {
    const result = await readCandidateDetail(
      portOk('iface-1', { candidateId: 'c1', fields: { priceYuan: '120' } }),
      'c1',
      T,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const detail = result.detail;
    expect(detail.stock.known).toBe(false);
    expect(detail.businessHours.known).toBe(false);
    expect(detail.route.known).toBe(false);
    expect(detail.packageConditions.known).toBe(false);
    expect(detail.validity.known).toBe(false);
    if (!detail.stock.known) expect(detail.stock.reason).toContain('库存');
    if (!detail.route.known) expect(detail.route.reason).toContain('路线');

    const unknowns = listUnknownFields(detail);
    expect(unknowns).toHaveLength(5);
    expect(unknowns.join()).toMatch(/库存/);
    expect(unknowns.join()).toMatch(/时效/);
  });

  it('字段齐全 ⇒ 各自 known，且时效保留起止时间', () => {
    const detail = normalizeDetail(
      {
        candidateId: 'c1',
        fields: {
          priceYuan: '120',
          priceCondition: '仅工作日',
          stock: '12',
          businessHours: '10:00-22:00',
          route: '地铁 1 号线徐家汇站',
          packageConditions: '4 人套餐含锅底，服务费另计',
          validFromMs: '1780000000000',
          validToMs: '1780000600000',
        },
      },
      'authorized_interface',
      'iface-1',
      T,
    );
    expect(detail.stock.known).toBe(true);
    expect(detail.packageConditions.known).toBe(true);
    if (detail.validity.known) {
      expect(detail.validity.value.fromMs).toBe(T);
      expect(detail.validity.value.toMs).toBe(T + 600_000);
    } else {
      throw new Error('时效应当已知');
    }
    expect(listUnknownFields(detail)).toEqual([]);
  });

  it('来源与观测时间随详情保留', () => {
    const detail = normalizeDetail({ candidateId: 'c9', fields: {} }, 'user_shared', '聊天截图.png', T);
    expect(detail.source.sourceRef).toBe('聊天截图.png');
    expect(detail.source.sourceKind).toBe('user_shared');
    expect(detail.source.observedAtMs).toBe(T);
  });
});

describe('MT-03：不得把标价当最终价', () => {
  it('price_is_final 与 isFinalPrice 均为字面量 false', async () => {
    const result = await readCandidateDetail(
      portOk('iface-1', { candidateId: 'c1', fields: { priceYuan: '120', priceCondition: '仅工作日' } }),
      'c1',
      T,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.detail.price_is_final).toBe(false);
    expect(result.detail.price.known).toBe(true);
    if (result.detail.price.known) expect(result.detail.price.value.isFinalPrice).toBe(false);
    expect(describePriceLabel(result.detail)).toMatch(/非最终价/);

    // 类型层：price_is_final 必须是字面量 false，否则这行编译不过。
    type MustBeFalse<T extends false> = T;
    const literalCheck: MustBeFalse<CandidateDetail['price_is_final']> = false;
    expect(literalCheck).toBe(false);
  });

  it('**反向对照**：接口自称"这是最终价" ⇒ 记录但**不采纳**，price_is_final 仍为 false', () => {
    const detail = normalizeDetail(
      { candidateId: 'c1', fields: { priceYuan: '199', finalPriceYuan: '188' }, claimsFinalPrice: true },
      'authorized_interface',
      'iface-1',
      T,
    );
    expect(detail.price_is_final).toBe(false);
    if (detail.price.known) {
      expect(detail.price.value.amountYuan).toBe(199); // 采纳的是**标价**
      expect(detail.price.value.isFinalPrice).toBe(false);
    }
    expect(detail.claims_not_adopted).toHaveLength(2);
    expect(detail.claims_not_adopted.join()).toMatch(/不采纳/);
    expect(describePriceLabel(detail)).toMatch(/非最终价/);
  });

  it('**反向对照**：价格无法解析 ⇒ unknown 并带原文，不静默当 0', () => {
    const detail = normalizeDetail(
      { candidateId: 'c1', fields: { priceYuan: '面议' } },
      'authorized_interface',
      'iface-1',
      T,
    );
    expect(detail.price.known).toBe(false);
    if (!detail.price.known) expect(detail.price.reason).toContain('面议');
    expect(describePriceLabel(detail)).toMatch(/价格未知/);
  });
});
