/**
 * MT-05 用例：可解释筛选 / 比较 / 排序 / 硬条件冲突 / 缺资料处理，
 * 且**宣传话术不改变用户规则**、改条件可**重算**。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCandidate, type Candidate } from './candidates.js';
import {
  attachPromotionalNote,
  compareCandidates,
  recomputeComparison,
  sortKeysFor,
  unknownFieldsFor,
  withStructuredNoise,
  type ComparisonSnapshot,
  type ComparisonResult,
} from './compare.js';

const T = 1_780_000_000_000;

const A = normalizeCandidate({ id: 'a', title: '甲店', fields: { priceYuan: '100', distanceKm: '2' } }, 'iface-1', T);
const B = normalizeCandidate({ id: 'b', title: '乙店', fields: { priceYuan: '80', distanceKm: '5' } }, 'iface-1', T);

const SNAPSHOT: ComparisonSnapshot = {
  label: '徐汇区火锅',
  candidates: [A, B],
  capturedAtMs: T,
  promotionalNotes: [],
};

const CHEAP: readonly { kind: 'preferCheaper' }[] = [{ kind: 'preferCheaper' }];

describe('MT-05：可解释 —— 每条候选都能回答"凭什么这么排"', () => {
  it('排序解释逐项给出维度取值', () => {
    const result = compareCandidates(SNAPSHOT, { hard: [], soft: [...CHEAP] }, 1);
    expect(result.kept.map((candidate) => candidate.id)).toEqual(['b', 'a']);
    const explanation = result.explanations.find((entry) => entry.candidateId === 'b');
    expect(explanation?.sortKeys[0]?.rule.kind).toBe('preferCheaper');
    expect(explanation?.sortKeys[0]?.value).toBe(80);
    expect(explanation?.kept).toBe(true);
  });

  it('淘汰给出**具体理由**，不只是"被筛掉"', () => {
    const result = compareCandidates(SNAPSHOT, { hard: [{ kind: 'maxPriceYuan', value: 90 }], soft: [] }, 1);
    expect(result.kept.map((candidate) => candidate.id)).toEqual(['b']);
    expect(result.rejected[0]?.candidateId).toBe('a');
    expect(result.rejected[0]?.reason).toMatch(/超过上限/);
    const rejectedExplanation = result.explanations.find((entry) => entry.candidateId === 'a');
    expect(rejectedExplanation?.kept).toBe(false);
    expect(rejectedExplanation?.rejections.join()).toMatch(/超过上限/);
  });
});

describe('MT-05：硬条件冲突与缺资料处理', () => {
  it('硬条件把候选筛空 ⇒ 冲突可见', () => {
    const result = compareCandidates(SNAPSHOT, { hard: [{ kind: 'maxPriceYuan', value: 1 }], soft: [] }, 1);
    expect(result.kept).toEqual([]);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/硬条件把候选筛空/);
  });

  it('**缺资料不当零**：价格未知的候选不蒙混过关，且被列进 missingData', () => {
    const unknownCandidate: Candidate = {
      ...A,
      id: 'u',
      title: '未知价店',
      price: { known: false, reason: '接口未给出价格' },
      distanceKm: { known: false, reason: '接口未给出距离' },
    };
    const snapshot: ComparisonSnapshot = { ...SNAPSHOT, candidates: [unknownCandidate, B] };
    const result = compareCandidates(snapshot, { hard: [{ kind: 'maxPriceYuan', value: 999 }], soft: [...CHEAP] }, 1);

    expect(result.kept.map((candidate) => candidate.id)).toEqual(['b']);
    expect(result.rejected[0]?.candidateId).toBe('u');
    expect(result.rejected[0]?.reason).toMatch(/价格未知/);
    // 两条候选都缺资料：u 缺价格/距离，b 缺库存/营业/路线（分享或接口没给的都不当已知）。
    expect(result.missingDataCandidateIds).toEqual(['u', 'b']);
    expect(unknownFieldsFor(B)).toHaveLength(3);
    expect(unknownFieldsFor(unknownCandidate)).toHaveLength(5);

    const key = sortKeysFor(unknownCandidate, [...CHEAP])[0];
    expect(key?.value).toBeNull(); // **不是** 0
    expect(key?.note).toMatch(/不按 0 处理/);
  });
});

describe('MT-05：宣传话术**结构上无法**影响规则', () => {
  it('**反向对照**：注入"限时特惠！""全网最低价"后排序键与顺序逐项不变', () => {
    const baseline = compareCandidates(SNAPSHOT, { hard: [], soft: [...CHEAP] }, 1);

    const noisySnapshot: ComparisonSnapshot = {
      ...SNAPSHOT,
      candidates: [withStructuredNoise(A, '限时特惠！'), withStructuredNoise(B, '全市第一！排队三小时也值！')],
    };
    const noisy = compareCandidates(attachPromotionalNote(noisySnapshot, '限时特惠！'), { hard: [], soft: [...CHEAP] }, 1);

    expect(noisy.kept.map((candidate) => candidate.id)).toEqual(baseline.kept.map((candidate) => candidate.id));
    expect(comparisonSortKeyValues(noisy)).toEqual(comparisonSortKeyValues(baseline));
    expect(noisy.promotionalTextIgnored).toBe(true);

    // 话术只留在展示字段里，没有变成排序依据。
    expect(noisySnapshot.promotionalNotes).toEqual([]);
    expect(sortKeysFor(noisySnapshot.candidates[0] as Candidate, [...CHEAP])[0]?.value).toBe(100);
  });

  it('promotionalTextIgnored 是字面量 true（类型层）', () => {
    type MustBeTrue<T extends true> = T;
    const literalCheck: MustBeTrue<ComparisonResult['promotionalTextIgnored']> = true;
    expect(literalCheck).toBe(true);
  });
});

describe('MT-05：用户改条件可**重算**', () => {
  it('同一快照换规则 ⇒ 结果变、版本 +1', () => {
    const first = compareCandidates(SNAPSHOT, { hard: [], soft: [...CHEAP] }, 1);
    const second = recomputeComparison(SNAPSHOT, first.revision, { hard: [{ kind: 'maxPriceYuan', value: 90 }], soft: [] });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.kept).toHaveLength(2);
    expect(second.kept.map((candidate) => candidate.id)).toEqual(['b']);
    expect(second.rules.hard[0]).toEqual({ kind: 'maxPriceYuan', value: 90 });
  });

  it('同输入 ⇒ 同输出（可复算，无隐藏状态）', () => {
    const a = compareCandidates(SNAPSHOT, { hard: [], soft: [...CHEAP] }, 7);
    const b = compareCandidates(SNAPSHOT, { hard: [], soft: [...CHEAP] }, 7);
    expect(comparisonSortKeyValues(a)).toEqual(comparisonSortKeyValues(b));
    expect(a.kept.map((candidate) => candidate.id)).toEqual(b.kept.map((candidate) => candidate.id));
  });
});

function comparisonSortKeyValues(result: ComparisonResult): readonly string[] {
  return result.explanations.flatMap((entry) =>
    entry.sortKeys.map((key) => `${entry.candidateId}:${key.rule.kind}:${String(key.value)}`),
  );
}
