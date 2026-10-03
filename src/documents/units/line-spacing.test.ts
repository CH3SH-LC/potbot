/**
 * 行距判据测试（R128，WF-022–024）。
 *
 * 本文件的三个关键断言就是派发单里的判据原文：
 * - `1.5 倍` → `w:line=360 w:lineRule=auto`
 * - `固定 20pt` → `400 / exact`
 * - `最小 18pt` → `360 / atLeast`
 *
 * 注意第三与第一条**数值相同（360）、lineRule 不同**——这正是"自动倍数与固定/最小行距
 * 单位不同、不许混"的活证据。
 */

import { describe, expect, it } from 'vitest';
import type { LineSpacing } from '../model/types.js';
import { lineSpacingFromOoxml, lineSpacingToOoxml } from './line-spacing.js';

describe('六类行距 → OOXML 属性（R128）', () => {
  it('1.5 倍 → line=360 lineRule=auto（判据原文）', () => {
    expect(lineSpacingToOoxml({ kind: 'oneAndHalf' })).toEqual({ line: 360, lineRule: 'auto' });
  });

  it('固定 20pt → line=400 lineRule=exact（判据原文）', () => {
    expect(
      lineSpacingToOoxml({ kind: 'exact', value: { unit: 'pt', value: 20 } }),
    ).toEqual({ line: 400, lineRule: 'exact' });
  });

  it('最小 18pt → line=360 lineRule=atLeast（判据原文）', () => {
    expect(
      lineSpacingToOoxml({ kind: 'atLeast', value: { unit: 'pt', value: 18 } }),
    ).toEqual({ line: 360, lineRule: 'atLeast' });
  });

  it('单倍 → 240/auto；双倍 → 480/auto', () => {
    expect(lineSpacingToOoxml({ kind: 'single' })).toEqual({ line: 240, lineRule: 'auto' });
    expect(lineSpacingToOoxml({ kind: 'double' })).toEqual({ line: 480, lineRule: 'auto' });
  });

  it('自定义倍数 1.25 → 300/auto；1.75 → 420/auto（WF-023 规范取整）', () => {
    expect(lineSpacingToOoxml({ kind: 'multiple', value: 1.25 })).toEqual({ line: 300, lineRule: 'auto' });
    expect(lineSpacingToOoxml({ kind: 'multiple', value: 1.75 })).toEqual({ line: 420, lineRule: 'auto' });
  });

  it('倍数取整到整数（1.1 → 264）', () => {
    expect(lineSpacingToOoxml({ kind: 'multiple', value: 1.1 })).toEqual({ line: 264, lineRule: 'auto' });
  });
});

describe('自动倍数与固定/最小行距单位不同，不许混', () => {
  it('1.5 倍与最小 18pt 数值都是 360，但 lineRule 不同 ⇒ 不可互换', () => {
    const oneAndHalf = lineSpacingToOoxml({ kind: 'oneAndHalf' });
    const atLeast = lineSpacingToOoxml({ kind: 'atLeast', value: { unit: 'pt', value: 18 } });
    expect(oneAndHalf.line).toBe(atLeast.line);
    expect(oneAndHalf.lineRule).not.toBe(atLeast.lineRule);
    // 反解回去必须是两个不同的语义，不能因为数值相同就当成同类。
    expect(lineSpacingFromOoxml(oneAndHalf.line, oneAndHalf.lineRule)).toEqual({ kind: 'oneAndHalf' });
    expect(lineSpacingFromOoxml(atLeast.line, atLeast.lineRule)).toEqual({
      kind: 'atLeast',
      value: { unit: 'pt', value: 18 },
    });
  });

  it('同一 pt 值在 exact 与 atLeast 下产出的 line 相同但规则不同', () => {
    const exact = lineSpacingToOoxml({ kind: 'exact', value: { unit: 'pt', value: 20 } });
    const atLeast = lineSpacingToOoxml({ kind: 'atLeast', value: { unit: 'pt', value: 20 } });
    expect(exact.line).toBe(atLeast.line);
    expect(exact.lineRule).toBe('exact');
    expect(atLeast.lineRule).toBe('atLeast');
  });
});

describe('长度单位进入固定/最小行距', () => {
  it('固定 1 cm → 567 twips / exact', () => {
    expect(
      lineSpacingToOoxml({ kind: 'exact', value: { unit: 'cm', value: 1 } }),
    ).toEqual({ line: 567, lineRule: 'exact' });
  });
});

describe('往返（写入 → 读回）', () => {
  const cases: readonly LineSpacing[] = [
    { kind: 'single' },
    { kind: 'oneAndHalf' },
    { kind: 'double' },
    { kind: 'multiple', value: 1.25 },
    { kind: 'exact', value: { unit: 'pt', value: 20 } },
    { kind: 'atLeast', value: { unit: 'pt', value: 18 } },
  ];

  it('六类行距写入后读回形状一致', () => {
    for (const spacing of cases) {
      const ooxml = lineSpacingToOoxml(spacing);
      expect(lineSpacingFromOoxml(ooxml.line, ooxml.lineRule), JSON.stringify(spacing)).toEqual(spacing);
    }
  });

  it('固定行距回归的是 Length（pt），不是裸 twips（R127）', () => {
    const back = lineSpacingFromOoxml(400, 'exact');
    expect(back).toEqual({ kind: 'exact', value: { unit: 'pt', value: 20 } });
  });
});
