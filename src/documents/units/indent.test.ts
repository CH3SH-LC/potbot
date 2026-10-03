/**
 * 缩进判据测试（R128/R130，WF-027–029）。
 *
 * 核心判据：**"首行缩进 2 字" 与 "2 cm" 产出不同属性**（`firstLineChars` vs `firstLine`），
 * 不可互换。本文件把两条路径的属性名、数值全部钉死，并断言**对方的属性必须是 null**
 * （即"不写"，不是"写了 0"）。
 */

import { describe, expect, it } from 'vitest';
import type { IndentProperties, ValuedState } from '../model/types.js';
import {
  EMPTY_INDENT_ATTRIBUTES,
  indentAmountToOoxml,
  indentToOoxml,
} from './indent.js';
import type { IndentAmount } from '../model/types.js';

const CHARS_2: IndentAmount = { unit: 'chars', value: 2 };
const CM_2: IndentAmount = { unit: 'cm', value: 2 };

function indentWith(partial: Partial<IndentProperties>): IndentProperties {
  const unspecified: ValuedState<IndentAmount> = { state: 'unspecified' };
  return {
    left: unspecified,
    right: unspecified,
    firstLine: unspecified,
    hanging: unspecified,
    ...partial,
  };
}

describe('"首行缩进 2 字" ≠ "2 cm"（R130）', () => {
  it('2 字 → firstLineChars=200，且 firstLine 必须为 null', () => {
    const attrs = indentAmountToOoxml('firstLine', CHARS_2);
    expect(attrs.firstLineChars).toBe(200);
    expect(attrs.firstLine).toBeNull();
  });

  it('2 cm → firstLine=1134 twips，且 firstLineChars 必须为 null', () => {
    const attrs = indentAmountToOoxml('firstLine', CM_2);
    expect(attrs.firstLine).toBe(1134);
    expect(attrs.firstLineChars).toBeNull();
  });

  it('两者产出的属性集**结构不同**，不可互换', () => {
    const chars = indentAmountToOoxml('firstLine', CHARS_2);
    const length = indentAmountToOoxml('firstLine', CM_2);
    expect(chars).not.toEqual(length);
    // 各自只有一个非 null 属性，且不是同一个。
    const nonNull = (a: typeof chars): readonly string[] =>
      Object.entries(a).filter(([, v]) => v !== null).map(([k]) => k);
    expect(nonNull(chars)).toEqual(['firstLineChars']);
    expect(nonNull(length)).toEqual(['firstLine']);
  });

  it('字符域与长度域的数值刻度不同：1 字 = 100，1 cm = 567', () => {
    expect(indentAmountToOoxml('left', { unit: 'chars', value: 1 }).leftChars).toBe(100);
    expect(indentAmountToOoxml('left', { unit: 'cm', value: 1 }).left).toBe(567);
  });

  it('未指定任何缩进时八属性全为 null', () => {
    expect(indentToOoxml(indentWith({}))).toEqual(EMPTY_INDENT_ATTRIBUTES);
  });
});

describe('悬挂缩进与左右缩进（WF-028/029）', () => {
  it('悬挂 2 字 → hangingChars=200', () => {
    const attrs = indentAmountToOoxml('hanging', CHARS_2);
    expect(attrs.hangingChars).toBe(200);
    expect(attrs.hanging).toBeNull();
  });

  it('左 1.5 cm → left=851（1.5×567=850.5 四舍五入）', () => {
    expect(indentAmountToOoxml('left', { unit: 'cm', value: 1.5 }).left).toBe(851);
  });

  it('右 3 字 → rightChars=300', () => {
    expect(indentAmountToOoxml('right', { unit: 'chars', value: 3 }).rightChars).toBe(300);
  });

  it('左右可以同时设置，互不影响', () => {
    const attrs = indentToOoxml(
      indentWith({
        left: { state: 'set', value: CHARS_2 },
        right: { state: 'set', value: CM_2 },
      }),
    );
    expect(attrs.leftChars).toBe(200);
    expect(attrs.left).toBeNull();
    expect(attrs.right).toBe(1134);
    expect(attrs.rightChars).toBeNull();
  });
});

describe('首行与悬挂互斥（R128/WF-028）', () => {
  it('两者同时为 set（脏数据）时确定性取舍：悬挂优先，首行两属性归 null', () => {
    const attrs = indentToOoxml(
      indentWith({
        firstLine: { state: 'set', value: CHARS_2 },
        hanging: { state: 'set', value: CHARS_2 },
      }),
    );
    expect(attrs.hangingChars).toBe(200);
    expect(attrs.firstLineChars).toBeNull();
    expect(attrs.firstLine).toBeNull();
  });

  it('inherit / unspecified 都不贡献属性', () => {
    const attrs = indentToOoxml(
      indentWith({
        firstLine: { state: 'inherit' },
        hanging: { state: 'unspecified' },
      }),
    );
    expect(attrs).toEqual(EMPTY_INDENT_ATTRIBUTES);
  });
});
