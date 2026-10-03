/**
 * 中文字号全表（R129）与半点值（R128）的判据测试。
 *
 * 这两张表是"唯一权威"——本测试**逐条**钉死十六个字号与关键半点值，
 * 因为它们的错误不会崩、只会悄悄把用户的"四号"变成 15pt。
 */

import { describe, expect, it } from 'vitest';
import type { ChineseFontSize } from '../model/types.js';
import {
  CHINESE_FONT_SIZE_NAMES,
  CHINESE_FONT_SIZE_PT,
  chineseFontSizeToPt,
  fontSizeToHalfPoints,
  fontSizeToPt,
  halfPointsToFontSize,
  ptsToChineseFontSize,
} from './font-size.js';

describe('中文字号全表（R129）', () => {
  // R129 原文逐条抄录，**不经任何换算**——这就是判据本身。
  const EXPECTED: readonly (readonly [ChineseFontSize, number])[] = [
    ['初号', 42],
    ['小初', 36],
    ['一号', 26],
    ['小一', 24],
    ['二号', 22],
    ['小二', 18],
    ['三号', 16],
    ['小三', 15],
    ['四号', 14],
    ['小四', 12],
    ['五号', 10.5],
    ['小五', 9],
    ['六号', 7.5],
    ['小六', 6.5],
    ['七号', 5.5],
    ['八号', 5],
  ];

  it('十六项逐条断言（pt）', () => {
    for (const [name, pt] of EXPECTED) {
      expect(chineseFontSizeToPt(name), `字号 ${name}`).toBe(pt);
      expect(CHINESE_FONT_SIZE_PT[name], `字号表 ${name}`).toBe(pt);
    }
  });

  it('表恰好十六项，无多无少', () => {
    expect(CHINESE_FONT_SIZE_NAMES).toHaveLength(16);
    expect(Object.keys(CHINESE_FONT_SIZE_PT)).toHaveLength(16);
  });

  it('名序列与表一一对应', () => {
    for (const name of CHINESE_FONT_SIZE_NAMES) {
      expect(CHINESE_FONT_SIZE_PT[name]).toBeTypeOf('number');
    }
    expect([...CHINESE_FONT_SIZE_NAMES].sort()).toEqual(
      EXPECTED.map(([name]) => name).sort(),
    );
  });
});

describe('字号 → 半点值（R128）', () => {
  it('12pt → 24（判据原文）', () => {
    expect(fontSizeToHalfPoints({ kind: 'pt', value: 12 })).toBe(24);
  });

  it('小四（12pt）→ 24；四号（14pt）→ 28', () => {
    expect(fontSizeToHalfPoints({ kind: 'chinese', name: '小四' })).toBe(24);
    expect(fontSizeToHalfPoints({ kind: 'chinese', name: '四号' })).toBe(28);
  });

  it('五号（10.5pt）→ 21（半点仍为整数）', () => {
    expect(fontSizeToHalfPoints({ kind: 'chinese', name: '五号' })).toBe(21);
  });

  it('十六个中文字号的半点值是 2×pt，全部为整数', () => {
    for (const name of CHINESE_FONT_SIZE_NAMES) {
      const half = fontSizeToHalfPoints({ kind: 'chinese', name });
      expect(Number.isInteger(half), `${name} 的半点值应为整数`).toBe(true);
      expect(half, `${name}`).toBe(CHINESE_FONT_SIZE_PT[name] * 2);
    }
  });

  it('fontSizeToPt 对两种形态都正确', () => {
    expect(fontSizeToPt({ kind: 'pt', value: 12 })).toBe(12);
    expect(fontSizeToPt({ kind: 'chinese', name: '二号' })).toBe(22);
  });
});

describe('反查与往返', () => {
  it('半点值反解回 pt 形式（不猜中文字号名）', () => {
    expect(halfPointsToFontSize(24)).toEqual({ kind: 'pt', value: 12 });
    expect(halfPointsToFontSize(21)).toEqual({ kind: 'pt', value: 10.5 });
  });

  it('pt 反查中文字号名：命中返回名字，未命中返回 null', () => {
    expect(ptsToChineseFontSize(12)).toBe('小四');
    expect(ptsToChineseFontSize(5)).toBe('八号');
    expect(ptsToChineseFontSize(13)).toBeNull();
  });

  it('十六项 pt 值反查都命中且唯一', () => {
    const seen = new Set<ChineseFontSize>();
    for (const name of CHINESE_FONT_SIZE_NAMES) {
      const back = ptsToChineseFontSize(CHINESE_FONT_SIZE_PT[name]);
      expect(back, `${name} 应能反查`).toBe(name);
      seen.add(name);
    }
    expect(seen.size).toBe(16);
  });
});
