/**
 * MT-04 用例：用户分享补候选、与在线来源**分开标识**、**不宣称全平台最优**。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCandidate } from './candidates.js';
import {
  intakeSharedCandidates,
  splitShareFromOnline,
  type ShareExtractionPort,
  type ShareIntakeResult,
  type UserShareInput,
} from './share-intake.js';

const T = 1_780_000_000_000;

describe('MT-04：文本 / 链接直接成候选，来源标"用户分享"', () => {
  it('文本与链接都产出 user_shared 候选，内容为空则跳过', async () => {
    const shares: readonly UserShareInput[] = [
      { kind: 'text', label: '粘贴文本#1', content: '老王推荐：蜀九香，人均 130' },
      { kind: 'link', label: 'https://example.com/shop/1', content: '某点评链接：蜀九香' },
      { kind: 'text', label: '粘贴文本#2', content: '   ' },
    ];
    const result = await intakeSharedCandidates(shares, null, T);
    expect(result.accepted).toHaveLength(2);
    for (const candidate of result.accepted) {
      expect(candidate.provenance.sourceKind).toBe('user_shared');
      expect(candidate.provenance.sourceRef.trim()).not.toBe('');
    }
    expect(result.accepted[0]?.provenance.sourceRef).toBe('粘贴文本#1');
    expect(result.skipped.map((entry) => entry.label)).toEqual(['粘贴文本#2']);
    expect(result.skipped[0]?.reason).toMatch(/为空/);
  });

  it('分享候选的价格 / 库存 / 营业 / 路线一律未知（不核对就不能当已知）', async () => {
    const result = await intakeSharedCandidates(
      [{ kind: 'text', label: '朋友转述', content: '这家 88 元一位' }],
      null,
      T,
    );
    const candidate = result.accepted[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(candidate.price.known).toBe(false);
    expect(candidate.stock.known).toBe(false);
    expect(candidate.businessHours.known).toBe(false);
    expect(candidate.route.known).toBe(false);
  });
});

describe('MT-04：图片 / 文件缺抽取通道 ⇒ 结构化跳过，不"看图说话"', () => {
  it('没有 OCR / 文档解析端口 ⇒ 图片与文件都被跳过并给出原因', async () => {
    const shares: readonly UserShareInput[] = [
      { kind: 'image', label: '聊天截图.png', content: '' },
      { kind: 'file', label: '推荐清单.xlsx', content: '' },
    ];
    const result = await intakeSharedCandidates(shares, null, T);
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((entry) => entry.kind)).toEqual(['image', 'file']);
    expect(result.skipped[0]?.reason).toMatch(/OCR|抽取通道/);
    expect(result.skipped[1]?.reason).toMatch(/文档解析|抽取通道/);
  });

  it('装配了抽取端口 ⇒ 抽取成功才成候选；抽取失败照样跳过', async () => {
    const extraction: ShareExtractionPort = {
      sourceId: 'ocr-1',
      extract: (input) =>
        Promise.resolve(
          input.label === '坏图.png'
            ? { ok: false as const, reason: '分辨率过低' }
            : { ok: true as const, text: '识别结果：小龙坎，人均 120' },
        ),
    };
    const result = await intakeSharedCandidates(
      [
        { kind: 'image', label: '好图.png', content: '' },
        { kind: 'image', label: '坏图.png', content: '' },
      ],
      extraction,
      T,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.provenance.sourceRef).toBe('好图.png');
    expect(result.skipped[0]?.label).toBe('坏图.png');
    expect(result.skipped[0]?.reason).toContain('分辨率过低');
  });
});

describe('MT-04：只比较几条候选，**不得**宣称全平台最优', () => {
  it('optimized_over_all_platforms 恒为 false（有候选时亦然）', async () => {
    const result = await intakeSharedCandidates(
      [{ kind: 'text', label: 'l', content: '某店' }],
      null,
      T,
    );
    expect(result.optimized_over_all_platforms).toBe(false);
    expect(result.comparisonScope).toMatch(/不.*全平台最优/);

    // 类型层：该字段必须是字面量 false，否则这行编译不过。
    type MustBeFalse<T extends false> = T;
    const literalCheck: MustBeFalse<ShareIntakeResult['optimized_over_all_platforms']> = false;
    expect(literalCheck).toBe(false);
  });

  it('**反向对照**：分享原文写着"全网最低/限时特惠"也不翻转该字段', async () => {
    const result = await intakeSharedCandidates(
      [{ kind: 'text', label: '广告', content: '限时特惠！全网最低价！错过再等一年！' }],
      null,
      T,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.optimized_over_all_platforms).toBe(false);
    expect(result.comparisonScope).toMatch(/不.*全平台最优/);
    // 话术只是正文，不会变成结构化字段参与规则。
    const candidate = result.accepted[0];
    expect(candidate?.structured['promo']).toBeUndefined();
  });
});

describe('MT-04：与在线来源**分开标识**，不混排', () => {
  it('splitShareFromOnline 把两类分开', async () => {
    const online = normalizeCandidate({ id: 'c1', title: '甲店', fields: { priceYuan: '120' } }, 'iface-1', T);
    const shared = await intakeSharedCandidates([{ kind: 'text', label: 'l', content: '某店' }], null, T);
    const split = splitShareFromOnline([online, ...shared.accepted]);
    expect(split.online.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(split.userShared).toHaveLength(1);
    expect(split.userShared[0]?.provenance.sourceKind).toBe('user_shared');
  });
});
