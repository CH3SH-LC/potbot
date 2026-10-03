/**
 * 码位工具单测（合同 R102）。
 *
 * 判据要求的两个样本都在这里：ZWJ emoji `👨‍👩‍👧` 与分解形 `é`（`e` + U+0301）。
 * 断言的重心不是"我算得对一个字符串"，而是**"用 UTF-16 下标算会算错，而这里算对"**——
 * 所以每个用例都同时给出 UTF-16 的对照值。样本常量的码点构成见 `testing.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  codePointIndexToUtf16Index,
  codePointLength,
  codePointSlice,
  isValidCodePointRange,
  toCodePoints,
  utf16IndexToCodePointIndex,
} from './codepoint.js';
import { E_ACUTE_DECOMPOSED, E_ACUTE_PRECOMPOSED, ZWJ, ZWJ_FAMILY } from './testing.js';

const FAMILY = ZWJ_FAMILY;

describe('codePointLength —— 数码位，不数 UTF-16 码元', () => {
  it('ZWJ emoji 是 5 个码位，而 .length 是 8（3 个增补码位各占 2 个 UTF-16 码元）', () => {
    expect(FAMILY.length).toBe(8);
    expect(FAMILY.length).not.toBe(codePointLength(FAMILY));
    expect(codePointLength(FAMILY)).toBe(5);
    expect(toCodePoints(FAMILY)).toEqual(['\u{1F468}', ZWJ, '\u{1F469}', ZWJ, '\u{1F467}']);
  });

  it('分解形 é 是 2 个码位，而预组合形是 1 个', () => {
    expect(codePointLength(E_ACUTE_DECOMPOSED)).toBe(2);
    expect(toCodePoints(E_ACUTE_DECOMPOSED)).toEqual(['e', '́']);
    expect(codePointLength(E_ACUTE_PRECOMPOSED)).toBe(1);
  });

  it('中文与 ASCII 一致，孤立代理项按 1 个码位计', () => {
    expect(codePointLength('今天天气很好')).toBe(6);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('\ud83d')).toBe(1);
  });
});

describe('codePointSlice —— 按码位切片，不切断代理对', () => {
  it('恰好取到整个 ZWJ emoji', () => {
    const text = `甲${FAMILY}乙`;
    expect(codePointLength(text)).toBe(7);
    expect(codePointSlice(text, 1, 6)).toBe(FAMILY);
  });

  it('切出来的片段本身仍是合法字符串（不是半个代理对）', () => {
    const text = `甲${FAMILY}乙`;
    const middle = codePointSlice(text, 2, 4);
    expect(middle).toBe(`${ZWJ}\u{1F469}`);
    expect(Array.from(middle)).toEqual([ZWJ, '\u{1F469}']);
    expect(middle).not.toContain('�');
  });

  it('分解形字符的起止正确：`café`（分解形）里 é 占 [3, 5)', () => {
    const text = `caf${E_ACUTE_DECOMPOSED}`;
    expect(codePointLength(text)).toBe(5);
    expect(codePointSlice(text, 3, 5)).toBe(E_ACUTE_DECOMPOSED);
    expect(codePointSlice(text, 0, 3)).toBe('caf');
  });

  it('越界按空处理，不倒置', () => {
    expect(codePointSlice('abc', 2, 99)).toBe('c');
    expect(codePointSlice('abc', 5, 6)).toBe('');
    expect(codePointSlice('abc', 2, 1)).toBe('');
  });
});

describe('码位下标 <-> UTF-16 下标换算（与宿主 API 对接用）', () => {
  it('ZWJ emoji 之后的下标换算', () => {
    const text = `甲${FAMILY}乙`;
    expect(codePointIndexToUtf16Index(text, 1)).toBe(1);
    expect(codePointIndexToUtf16Index(text, 6)).toBe(9);
    expect(utf16IndexToCodePointIndex(text, 9)).toBe(6);
    // 落在代理对内部的下标**向上**收敛到下一码位边界，绝不返回"码位内部"的位置。
    expect(utf16IndexToCodePointIndex(text, 5)).toBe(4);
  });

  it('往返一致（在所有码位边界上）', () => {
    const text = `a${FAMILY}b${E_ACUTE_PRECOMPOSED}`;
    const total = codePointLength(text);
    for (let index = 0; index <= total; index += 1) {
      expect(utf16IndexToCodePointIndex(text, codePointIndexToUtf16Index(text, index))).toBe(index);
    }
  });
});

describe('isValidCodePointRange', () => {
  it('接受合法区间、拒绝越界与非整数', () => {
    const text = `甲${FAMILY}乙`;
    expect(isValidCodePointRange(text, 0, 7)).toBe(true);
    expect(isValidCodePointRange(text, 1, 6)).toBe(true);
    expect(isValidCodePointRange(text, 0, 0)).toBe(true);
    expect(isValidCodePointRange(text, 0, 8)).toBe(false);
    expect(isValidCodePointRange(text, 3, 2)).toBe(false);
    expect(isValidCodePointRange(text, -1, 2)).toBe(false);
    expect(isValidCodePointRange(text, 0.5, 2)).toBe(false);
  });
});
