/**
 * M-I03 / 恶意描述**不改变**任何结构化结论（决定性对照）。
 *
 * 两样东西只差描述字段：
 * - 菜品：SKU id / 价格 / 规格组必须逐项相同；
 * - 商家：营业 / 配送范围 / 起送结论必须逐项相同 —— 描述里就算写「24 小时营业、
 *   0 元起送、100 公里配送」也不作数。
 *
 * 另验证：目录字段里的 `UntrustedText` 经 `envelopeFromUntrustedText` 有唯一合规路径，
 * 且高风险描述会被复核闸门挡在提示词之外；来源引用（provenance）始终齐备。
 */

import { describe, expect, it } from 'vitest';

import {
  CatalogReviewRequiredError,
  analyzeDescription,
  asOpaqueId,
  asUntrustedText,
  buildDescriptionEnvelope,
  checkDeliveryRange,
  checkMinOrder,
  envelopeFromUntrustedText,
  evaluateOperatingHours,
  makeWeekTime,
  renderDescriptionForPrompt,
  type CatalogItem,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { BENIGN, HOSTILE, HOSTILE_FACTS, merchant, noodle } from './support.js';

describe('M-I03 描述不改结构：SKU id / 价格 / 规格组', () => {
  it('恶意与良性描述下，菜品结构化字段逐项相同', () => {
    const benign = noodle(BENIGN);
    const malicious = noodle(HOSTILE);

    expect(malicious.skus.map((sku) => sku.skuId)).toEqual(benign.skus.map((sku) => sku.skuId));
    expect(malicious.skus.map((sku) => sku.priceMinor)).toEqual(benign.skus.map((sku) => sku.priceMinor));
    expect(malicious.specGroups).toEqual(benign.specGroups);
    expect(malicious.itemId).toBe(benign.itemId);
    expect(malicious.merchantId).toBe(benign.merchantId);
    // 文本证据保留在 description，且被标记；但绝不外溢到任何键/id。
    expect(malicious.description?.raw).toBe(HOSTILE);
    expect(malicious.description?.executable).toBe(false);
  });

  it('注入文本无法冒充不透明 id', () => {
    expect(() => asOpaqueId(HOSTILE, 'itemId')).toThrow();
  });

  it('恶意描述里的链接/下单词不会成为新的规格组或选项', () => {
    const malicious = noodle(HOSTILE);
    const groupIds = malicious.specGroups.map((group) => group.groupId);
    const optionIds = malicious.specGroups.flatMap((group) => group.options.map((option) => option.optionId));
    expect(groupIds).toEqual(['spice']);
    expect(optionIds).toEqual(['mild', 'hot']);
  });

  it('来源引用（provenance）始终齐备', () => {
    const item: CatalogItem = noodle(HOSTILE);
    expect(item.sourceRef.provider.length).toBeGreaterThan(0);
    expect(item.sourceRef.endpoint.length).toBeGreaterThan(0);
    expect(typeof item.sourceRef.retrievedAt).toBe('number');
  });
});

describe('M-I03 描述不改结论：营业 / 配送 / 起送', () => {
  it('描述里的「24 小时营业」不改变营业判定', () => {
    const benign = merchant(BENIGN);
    const hostile = merchant(HOSTILE_FACTS);

    const openAt = makeWeekTime(0, 660); // 周一 11:00，落在 600–720 内
    const closedAt = makeWeekTime(0, 780); // 周一 13:00，营业时段外

    expect(evaluateOperatingHours(hostile.operatingHours, openAt)).toEqual(
      evaluateOperatingHours(benign.operatingHours, openAt),
    );
    expect(evaluateOperatingHours(hostile.operatingHours, openAt).state).toBe('open');
    // 文本声称 24 小时营业，但结构化时段之外仍是闭店。
    expect(evaluateOperatingHours(hostile.operatingHours, closedAt).state).toBe('closed');
  });

  it('描述里的「100 公里配送」不改变范围判定', () => {
    const benign = merchant(BENIGN);
    const hostile = merchant(HOSTILE_FACTS);
    const farPoint = { lat: 31.30, lng: 121.60 }; // 远离门店中心，超出 1000 米

    expect(checkDeliveryRange(hostile.deliveryRange, farPoint)).toEqual(
      checkDeliveryRange(benign.deliveryRange, farPoint),
    );
    expect(checkDeliveryRange(hostile.deliveryRange, farPoint).state).toBe('out_of_range');
  });

  it('描述里的「0 元起送」不改变起送判定', () => {
    const benign = merchant(BENIGN);
    const hostile = merchant(HOSTILE_FACTS);

    expect(checkMinOrder(hostile.deliveryRange, 1000)).toEqual(checkMinOrder(benign.deliveryRange, 1000));
    expect(checkMinOrder(hostile.deliveryRange, 1000).state).toBe('below');
    expect(checkMinOrder(hostile.deliveryRange, 5000).state).toBe('meets');
  });
});

describe('M-I03 唯一合规路径：UntrustedText → 信封 → 闸门', () => {
  it('envelopeFromUntrustedText 保留 data_only / executable:false', () => {
    const text = asUntrustedText(BENIGN, 'item.description');
    const envelope = envelopeFromUntrustedText(text, 'catalog.dish.description');
    expect(envelope.renderedAs).toBe('data_only');
    expect(envelope.executable).toBe(false);
    expect(envelope.data).toBe(text.raw);
    expect(analyzeDescription(text.raw).severity).toBe('none');
  });

  it('菜品的高风险描述经信封后仍被闸门挡在提示词之外', () => {
    const item = noodle(HOSTILE);
    const description = item.description;
    expect(description).not.toBeNull();
    if (description === null) return;

    const envelope = envelopeFromUntrustedText(description, 'catalog.dish.description');
    expect(envelope.analysis.severity).toBe('high');
    expect(() => renderDescriptionForPrompt(envelope)).toThrow(CatalogReviewRequiredError);
  });

  it('若强行按裸字符串构造严格信封，同样被复核闸门拒绝', () => {
    expect(() => buildDescriptionEnvelope(HOSTILE, { source: 'catalog.dish.description' })).toThrow(
      CatalogReviewRequiredError,
    );
  });
});
